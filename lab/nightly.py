"""Stage provider updates and publish a verified snapshot after confirmation."""
import argparse
from collections import Counter
from contextlib import ExitStack, closing
from datetime import date, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import zlib

from collect import collection_lock, window_start
from store import (KST, KIWOOM_SOURCES as KIWOOM, SOURCE, active_recoveries, archive_rows, connect, now_iso, prepare_rows,
                   save_rows, savepoint, withdraw)

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ai_agent.market import expected_sessions, market_context

PASS = ("complete", "nontrade")


class ProviderError(Exception):
    pass


def completed_day(now, phase, through):
    now = now.astimezone(KST)
    if phase == "confirm" or now.hour < 21:
        # A delayed 03:00 run still belongs to the previous evening.
        now = datetime.combine(now.date() - timedelta(days=1), datetime.min.time(), KST) + timedelta(hours=21)
    return market_context(now, through)["latest_completed"]


def provider(kind, code=None, start=None, end=None, source=SOURCE, *, deadline):
    env = None
    if source in KIWOOM:
        cmd = ["node", str(ROOT / "server/labKiwoom.js"), code, start, end, source]
        env = {**os.environ, "DOTENV_CONFIG_PATH": os.devnull}
    else:
        if source not in (SOURCE, "FDR:KRX"):
            raise ProviderError("unsupported_source")
        cmd = [sys.executable, str(ROOT / "lab/collect.py"), "--worker", kind, "--source", source.split(":")[1]]
        if code:
            cmd += ["--symbol", code, "--start", start, "--end", end]
    for attempt in range(2):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("batch_deadline")
        try:
            result = subprocess.run(cmd, capture_output=True, encoding="utf-8", timeout=min(90, remaining), check=True, env=env)
            return json.loads(result.stdout)
        except (OSError, subprocess.SubprocessError, ValueError):
            if time.monotonic() >= deadline:
                raise TimeoutError("batch_deadline") from None
            if attempt:
                raise ProviderError("provider_request_failed") from None
            time.sleep(min(3, max(0, deadline - time.monotonic())))


def pack(value):
    return zlib.compress(json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode())


def unpack(value):
    return json.loads(zlib.decompress(value)) if value else {}


def target_universe(db, deadline):
    rows = provider("listing", deadline=deadline)
    if not isinstance(rows, list) or not rows:
        raise ProviderError("empty_listing")
    seen = set()
    markets = Counter()
    for row in rows:
        code, name, market = row["code"], row["name"], row["market"]
        if not re.fullmatch(r"[0-9][0-9A-Z]{5}", code) or code in seen or not name or market not in ("KOSPI", "KOSDAQ"):
            raise ProviderError("invalid_listing")
        if row.get("listed"):
            date.fromisoformat(row["listed"])
        seen.add(code)
        markets[market] += 1
    previous = dict(db.execute("SELECT market,count(*) FROM symbols WHERE active=1 GROUP BY market"))
    if any(markets[market] == 0 or markets[market] < previous.get(market, 0) * 0.90 for market in ("KOSPI", "KOSDAQ")):
        raise ProviderError("abnormally_short_listing")
    return [(r["code"], r["name"], r["market"], r.get("listed")) for r in rows]


def ensure_batch(db, day, phase, deadline):
    if db.execute("SELECT 1 FROM lab_batches WHERE day=? AND phase=?", (day, phase)).fetchone():
        return
    primary = phase == "confirm" and db.execute(
        "SELECT 1 FROM lab_batches WHERE day=? AND phase='primary'", (day,)).fetchone()
    rows = None if primary else target_universe(db, deadline)
    with db:
        published = db.execute("SELECT target,summary FROM lab_publication WHERE id=1").fetchone()
        if not published or (not published[0] and not json.loads(published[1]).get("data_day")):
            baseline = db.execute("""SELECT max((SELECT max(date) FROM candles c WHERE c.code=s.code AND c.date<=?))
                FROM symbols s WHERE s.active=1""", (day,)).fetchone()[0]
            summary = json.loads(published[1]) if published else {}
            summary["data_day"] = baseline
            db.execute("""INSERT INTO lab_publication VALUES(1,1,NULL,?,?)
                ON CONFLICT(id) DO UPDATE SET version=version+1,summary=excluded.summary""", (now_iso(), json.dumps(summary)))
        db.execute("INSERT INTO lab_batches VALUES(?,?,?,NULL,NULL)", (day, phase, now_iso()))
        if primary:
            db.execute("""INSERT INTO lab_batch_items(day,phase,code,name,market,listed,status,detail,staged)
                SELECT day,'confirm',code,name,market,listed,
                CASE WHEN status IN ('complete','nontrade') THEN 'verify' ELSE 'pending' END,detail,staged
                FROM lab_batch_items WHERE day=? AND phase='primary'""", (day,))
        else:
            db.executemany("""INSERT INTO lab_batch_items(day,phase,code,name,market,listed) VALUES(?,?,?,?,?,?)""",
                           [(day, phase, *r) for r in rows])


def scope(db, code, listed, day):
    pinned = db.execute("SELECT source,listed,version FROM lab_symbol_basis WHERE code=?", (code,)).fetchone()
    existing = db.execute("SELECT source FROM symbols WHERE code=?", (code,)).fetchone()
    source = pinned[0] if pinned else existing[0] if existing else SOURCE
    verified_listing = db.execute("SELECT listed FROM lab_listing_evidence WHERE code=?", (code,)).fetchone()
    listed = (pinned[1] if pinned else None) or (verified_listing[0] if verified_listing else None) or listed
    start = max(window_start(date.fromisoformat(day)).isoformat(), listed or "")
    return source, start, pinned[2] if pinned else None


def history(db, code, source, start, day):
    dates = set(expected_sessions(start, day)) if start <= day else set()
    nontrade = {r[0] for r in db.execute("SELECT date FROM lab_nontrade WHERE code=? AND source=? AND date BETWEEN ? AND ?",
                                        (code, source, start, day))}
    return dates, nontrade


def coverage(db, code, source, start, day):
    expected, nontrade = history(db, code, source, start, day)
    rows = dict(db.execute("SELECT date,tradable FROM candles WHERE code=? AND date BETWEEN ? AND ?", (code, start, day)))
    quality = dict(db.execute("SELECT date,status FROM effective_candle_quality WHERE code=? AND date BETWEEN ? AND ?",
                              (code, start, day)))
    if day not in expected:
        return "nontrade", "not_yet_listed"
    if day not in rows and day not in quality and day not in nontrade:
        return "not_reflected", "target_session_missing"
    if any(status in ("quarantined", "corrected") for status in quality.values()):
        return "quality_failed", "unresolved_price_quality"
    if expected - (rows.keys() & quality.keys()) - nontrade or rows.keys() - expected:
        return "quality_failed", "missing_or_unexpected_sessions"
    if not rows.get(day) and day not in nontrade:
        return "quality_failed", "unverified_zero_volume"
    return ("nontrade", "verified_nontrade") if day in nontrade and not rows.get(day) else ("complete", None)


class PreviewDone(Exception):
    pass


def check_update(db, code, name, market, source, start, day, change):
    old = active_recoveries(db, code)
    removed = []
    try:
        with savepoint(db, "preview"):
            apply_update(db, code, name, market, source, start, day, change)
            status, detail = coverage(db, code, source, start, day)
            if old:
                current = {r[0] for r in active_recoveries(db, code)}
                removed = [r[:2] for r in old if r[0] not in current and db.execute(
                    """SELECT 1 FROM lab_resolution_events WHERE candidate=? AND action='withdraw'
                       AND reason='raw_or_basis_changed' ORDER BY id DESC LIMIT 1""", (r[0],)).fetchone()]
                if removed:
                    status, detail = "quality_failed", "recovery_basis_changed"
            raise PreviewDone()
    except PreviewDone:
        return status, detail, removed


def apply_update(db, code, name, market, source, start, day, change):
    if change.get("rows"):
        save_rows(db, code, name, market, change["rows"], change["begin"], day, change["full"], source, strict=True)
    prune(db, code, start)


def prune(db, code, start):
    db.execute("""INSERT OR IGNORE INTO legacy_candle_snapshots
        SELECT c.code,c.date,s.source,c.open,c.high,c.low,c.close,c.volume,c.tradable,?
        FROM candles c JOIN symbols s USING(code) WHERE c.code=? AND c.date<? AND NOT EXISTS
          (SELECT 1 FROM candle_quality q WHERE q.code=c.code AND q.date=c.date)""", (now_iso(), code, start))
    db.execute("DELETE FROM candles WHERE code=? AND date<?", (code, start))
    db.execute("DELETE FROM candle_quality WHERE code=? AND date<?", (code, start))
    for candidate, old_day, *_ in active_recoveries(db, code):
        if old_day < start:
            withdraw(db, code, old_day, candidate, "outside_retention")


def fetch_update(db, code, source, start, day, deadline, short=False, revoke=None):
    lookback = (date.fromisoformat(day) - timedelta(days=7 if short else 60)).isoformat()
    expected, nontrade = history(db, code, source, start, day)
    prior = dict(db.execute("SELECT date,raw_hash FROM candle_quality WHERE code=? AND date BETWEEN ? AND ?", (code, start, day)))
    begin = max(start, lookback)
    full = bool({d for d in expected if d < begin} - prior.keys() - nontrade)
    if full:
        begin = start
    recoveries = {r[1]: r for r in active_recoveries(db, code)}

    def request(begin):
        rows = provider("prices", code, begin, day, source, deadline=deadline)
        prepared = prepare_input(db, code, source, rows)
        received = {p["row"][0]: p for p in prepared}
        revised = any(d in prior and d not in recoveries and prior[d] != p["hash"] for d, p in received.items())
        if revoke is not None:
            for d, r in recoveries.items():
                if revised or (d in received and (source, received[d]["hash"], received[d]["policy"]) != r[2:5]):
                    revoke.append(r[:2])
        return rows, revised

    rows, revised = request(begin)
    if not full and revised:
        begin, full = start, True
        rows, _ = request(begin)
    if any(r["date"] < begin or r["date"] > day for r in rows):
        raise ValueError("outside_requested_range")
    return {"begin": begin, "full": full, "rows": rows}


def prepare_input(db, code, source, rows):
    try:
        if not isinstance(rows, list):
            raise ValueError("invalid_provider_payload")
        prepared = prepare_rows(rows, source, strict=True) if rows else []
    except (TypeError, ValueError, KeyError, OverflowError):
        payload = json.dumps(rows, ensure_ascii=True, allow_nan=True)
        with db:
            db.execute("INSERT OR IGNORE INTO lab_rejected_payloads VALUES(?,?,?,?,?)",
                       (code, source, hashlib.sha256(payload.encode()).hexdigest(), payload, now_iso()))
        raise ValueError("invalid_provider_payload") from None
    with db:
        archive_rows(db, code, source, prepared, now_iso())
    return prepared


def record(db, day, phase, code, status, detail, change):
    with db:
        db.execute("UPDATE lab_batch_items SET status=?,detail=?,staged=? WHERE day=? AND phase=? AND code=?",
                   (status, detail, pack(change) if change else None, day, phase, code))
        db.execute("INSERT INTO lab_attempts(day,phase,code,at,status,detail) VALUES(?,?,?,?,?,?)",
                   (day, phase, code, now_iso(), status, detail))


def process_item(db, day, phase, item, deadline, check_short):
    code, name, market, listed, previous, staged = item
    change = unpack(staged)
    revoke = change.get("withdraw", [])
    try:
        source, start, basis = scope(db, code, listed, day)
        identity = [source, start, basis]
        if start > day:
            status, detail = "nontrade", "not_yet_listed"
            change = {}
        else:
            if previous != "verify" or change.get("scope") != identity:
                change = fetch_update(db, code, source, start, day, deadline, revoke=revoke)
            status, detail, removed = check_update(db, code, name, market, source, start, day, change)
            if previous == "verify" and status not in PASS:
                revoke.extend(removed)
                change = fetch_update(db, code, source, start, day, deadline, revoke=revoke)
                status, detail, removed = check_update(db, code, name, market, source, start, day, change)
            if check_short and previous == "verify" and not change.get("full") and status in PASS:
                recent = fetch_update(db, code, source, start, day, deadline, short=True, revoke=revoke)
                if not recent["full"]:
                    rows = {r["date"]: r for r in change.get("rows", [])}
                    for d in [d for d in rows if d >= recent["begin"]]:
                        del rows[d]
                    rows.update((r["date"], r) for r in recent["rows"])
                    recent["rows"] = list(rows.values())
                    recent["begin"] = min(recent["begin"], change.get("begin", recent["begin"]))
                change = recent
                status, detail, removed = check_update(db, code, name, market, source, start, day, change)
            revoke = removed if status in PASS else list({tuple(r) for r in [*revoke, *removed]})
            change["scope"] = identity
    except TimeoutError:
        status, detail = "pending", "batch_deadline"
    except ProviderError:
        status, detail = "fetch_failed", "provider_request_failed"
    except (ValueError, TypeError, KeyError):
        status, detail = "quality_failed", "invalid_history"
    except sqlite3.Error:
        status, detail = "save_failed", "sqlite_write_failed"
    record(db, day, phase, code, status, detail, change if status in PASS else {"withdraw": revoke} if revoke else None)


def counts(db, day, phase):
    return dict(db.execute("SELECT status,count(*) FROM lab_batch_items WHERE day=? AND phase=? GROUP BY status", (day, phase)))


def quality_summary(db):
    return {"unresolved": db.execute("""SELECT count(*) FROM candle_quality_versions v INDEXED BY quality_issues_idx
        JOIN candle_quality q USING(code,date,source,raw_hash,policy) JOIN symbols s USING(code)
        LEFT JOIN lab_resolution_current a USING(code,date)
        WHERE v.status!='original' AND s.active=1 AND (v.status='corrected' OR a.event IS NULL)""").fetchone()[0],
        "recovered": db.execute("SELECT count(*) FROM lab_resolution_current a JOIN symbols s USING(code) WHERE s.active=1").fetchone()[0]}


def public_version(db, target=None, summary=None):
    if target is None:
        current = db.execute("SELECT summary FROM lab_publication WHERE id=1").fetchone()
        summary = json.loads(current[0]) if current else {}
        summary.update(quality_summary(db))
        db.execute("""INSERT INTO lab_publication VALUES(1,1,NULL,?,?)
                    ON CONFLICT(id) DO UPDATE SET version=version+1,summary=excluded.summary""", (now_iso(), json.dumps(summary)))
    else:
        db.execute("""INSERT INTO lab_publication VALUES(1,1,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET version=version+1,target=excluded.target,
                    published_at=excluded.published_at,summary=excluded.summary""",
                   (target, now_iso(), json.dumps(summary)))


def publish(db, day):
    with savepoint(db, "publish_nightly"):
        old = db.execute("SELECT target,summary FROM lab_publication WHERE id=1").fetchone()
        if old and old[0] and old[0] > day:
            raise ValueError("cannot_publish_older_target")
        db.execute("UPDATE symbols SET active=0 WHERE active=1 AND code NOT IN (SELECT code FROM lab_batch_items WHERE day=? AND phase='confirm')", (day,))
        for code, name, market, listed, status, detail, staged in db.execute(
                "SELECT code,name,market,listed,status,detail,staged FROM lab_batch_items WHERE day=? AND phase='confirm' ORDER BY code", (day,)).fetchall():
            source, start, basis = scope(db, code, listed, day)
            db.execute("""INSERT INTO symbols(code,name,market,source,active) VALUES(?,?,?,?,1)
                          ON CONFLICT(code) DO UPDATE SET name=excluded.name,market=excluded.market,active=1""",
                       (code, name, market, source))
            change = unpack(staged)
            if status in (*PASS, "verify"):
                was_pending = status == "verify"
                try:
                    with savepoint(db, "publish_symbol"):
                        if staged:
                            if change.get("scope") != [source, start, basis]:
                                raise ValueError("staged_basis_changed")
                            apply_update(db, code, name, market, source, start, day, change)
                        final_status, final_detail = coverage(db, code, source, start, day)
                        if final_status not in PASS:
                            raise ValueError("staged_state_changed")
                        status, detail = final_status, final_detail
                        if was_pending:
                            db.execute("UPDATE lab_batch_items SET status=?,detail=? WHERE day=? AND phase='confirm' AND code=?",
                                       (status, detail, day, code))
                            db.execute("INSERT INTO lab_attempts(day,phase,code,at,status,detail) VALUES(?,'confirm',?,?,?,?)",
                                       (day, code, now_iso(), status, detail))
                except (ValueError, sqlite3.Error) as error:
                    status = "save_failed" if isinstance(error, sqlite3.Error) else "quality_failed"
                    detail = "publish_revalidation_failed"
                    db.execute("UPDATE lab_batch_items SET status=?,detail=? WHERE day=? AND phase='confirm' AND code=?",
                               (status, detail, day, code))
                    db.execute("INSERT INTO lab_attempts(day,phase,code,at,status,detail) VALUES(?,'confirm',?,?,?,?)",
                               (day, code, now_iso(), status, detail))
            if status not in PASS:
                for candidate, session in change.get("withdraw", []):
                    if any(r[:2] == (candidate, session) for r in active_recoveries(db, code)):
                        withdraw(db, code, session, candidate, "pending_basis_revalidation")
                prune(db, code, window_start(date.fromisoformat(day)).isoformat())
            db.execute("UPDATE symbols SET last_attempt=?,error=? WHERE code=?", (now_iso(), None if status in PASS else status, code))
            db.execute("INSERT OR REPLACE INTO lab_public_symbols VALUES(?,?,?,?)", (code, day, status, detail))
        db.execute("UPDATE lab_batch_items SET staged=NULL WHERE day<=?", (day,))
        result = counts(db, day, "confirm")
        published = result.get("complete", 0)
        previous_day = json.loads(old[1]).get("data_day") if old else None
        if not previous_day and not published:
            previous_day = db.execute("""SELECT max((SELECT max(date) FROM candles c WHERE c.code=s.code AND c.date<?))
                FROM symbols s WHERE s.active=1""", (day,)).fetchone()[0]
        summary = {"counts": result, "data_day": day if published else previous_day,
                   "primary": counts(db, day, "primary"), **quality_summary(db)}
        stamp = now_iso()
        db.execute("UPDATE lab_batches SET finished_at=?,published_at=? WHERE day=? AND phase='confirm'", (stamp, stamp, day))
        public_version(db, day, summary)


def run(db, phase, day, deadline, delay, check_short=False):
    current = db.execute("SELECT target FROM lab_publication WHERE id=1").fetchone()
    if current and current[0] and current[0] > day:
        raise ValueError("cannot_process_older_target")
    if phase == "primary" and db.execute("SELECT published_at FROM lab_batches WHERE day=? AND phase='confirm' AND published_at IS NOT NULL", (day,)).fetchone():
        print(json.dumps({"target": day, "phase": phase, "status": "already_confirmed"}))
        return 0
    try:
        ensure_batch(db, day, phase, deadline)
    except (ProviderError, TimeoutError, ValueError, KeyError, TypeError):
        with db:
            db.execute("INSERT INTO lab_attempts(day,phase,code,at,status,detail) VALUES(?,?,?,?,'fetch_failed','listing_unavailable')",
                       (day, phase, "", now_iso()))
        raise ProviderError("listing_unavailable") from None
    items = db.execute("""SELECT code,name,market,listed,status,staged FROM lab_batch_items
        WHERE day=? AND phase=? AND status NOT IN ('complete','nontrade')
        ORDER BY CASE WHEN status='verify' THEN 1 ELSE 0 END,code""", (day, phase)).fetchall()
    if items:
        with db:
            db.execute("UPDATE lab_batches SET finished_at=NULL WHERE day=? AND phase=?", (day, phase))
    for item in items:
        if time.monotonic() >= deadline:
            break
        process_item(db, day, phase, item, deadline, check_short)
        time.sleep(min(delay, max(0, deadline - time.monotonic())))
    with db:
        if items and phase == "primary":
            db.execute("UPDATE lab_batches SET finished_at=? WHERE day=? AND phase=?", (now_iso(), day, phase))
    already = db.execute("SELECT published_at FROM lab_batches WHERE day=? AND phase=?", (day, phase)).fetchone()[0]
    if phase == "confirm" and (items or not already):
        publish(db, day)
    result = counts(db, day, phase)
    print(json.dumps({"target": day, "phase": phase, "counts": result}))
    passed = sum(result.get(key, 0) for key in PASS)
    return 1 if not passed else 2 if passed != sum(result.values()) else 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("primary", "confirm"))
    parser.add_argument("--db", default=os.getenv("LAB_DB_PATH", "data/lab.sqlite"))
    parser.add_argument("--calendar-through", default=os.getenv("LAB_CALENDAR_THROUGH", "2026-12-31"))
    parser.add_argument("--max-minutes", type=int, default=240)
    parser.add_argument("--delay", type=float, default=0.4)
    parser.add_argument("--check-short", action="store_true")
    parser.add_argument("--target", help="Resume an existing batch for a completed session")
    args = parser.parse_args()
    if not 1 <= args.max_minutes <= 300 or not 0.3 <= args.delay <= 30:
        parser.error("Unsafe time limit or request pacing")
    try:
        day = completed_day(datetime.now(KST), args.phase, args.calendar_through)
        with ExitStack() as stack:
            lock_deadline = time.monotonic() + (120 if args.phase == "confirm" else 0)
            while True:
                try:
                    stack.enter_context(collection_lock(args.db))
                    break
                except OSError:
                    if time.monotonic() >= lock_deadline:
                        raise
                    time.sleep(min(5, lock_deadline - time.monotonic()))
            db = stack.enter_context(closing(connect(args.db)))
            if args.target and args.target != day:
                if (args.target > day or not expected_sessions(args.target, args.target)
                        or not db.execute("SELECT 1 FROM lab_batches WHERE day=?", (args.target,)).fetchone()):
                    raise ValueError("Target must be an existing completed batch")
                day = args.target
            return run(db, args.phase, day, time.monotonic() + args.max_minutes * 60, args.delay, args.check_short)
    except (OSError, ProviderError, TimeoutError, ValueError, sqlite3.Error) as error:
        print(f"Nightly collection aborted: {type(error).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
