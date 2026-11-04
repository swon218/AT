"""SQLite storage and read-only JSON bridge. No brokerage credentials required."""
import argparse
import hashlib
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
import sqlite3

KST = timezone(timedelta(hours=9))
SOURCE = "FDR:NAVER"
KIWOOM_SOURCES = ("KIWOOM:KA10081:ADJUSTED:KRX", "KIWOOM:KA10081:ADJUSTED:SOR")
LAB_SOURCES = (SOURCE, "FDR:KRX", *KIWOOM_SOURCES)
QUALITY_POLICY = "naver-close-envelope-1krw-v1"
STRICT_POLICY = "strict-envelope-v2"
FIELDS = ("open", "high", "low", "close", "volume")


def now_iso():
    return datetime.now(KST).isoformat(timespec="seconds")


def connect(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript("""
      CREATE TABLE IF NOT EXISTS symbols (
        code TEXT PRIMARY KEY, name TEXT NOT NULL, market TEXT NOT NULL,
        source TEXT NOT NULL, updated_at TEXT, last_attempt TEXT, error TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS candles (
        code TEXT NOT NULL REFERENCES symbols(code), date TEXT NOT NULL,
        open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL,
        close REAL NOT NULL, volume REAL NOT NULL, tradable INTEGER NOT NULL,
        PRIMARY KEY(code,date)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
        succeeded INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
        message TEXT
      );
      CREATE TABLE IF NOT EXISTS legacy_candle_snapshots (
        code TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL,
        open REAL, high REAL, low REAL, close REAL, volume REAL, tradable INTEGER,
        archived_at TEXT NOT NULL, PRIMARY KEY(code,date)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS raw_candles (
        code TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL,
        raw_hash TEXT NOT NULL, payload TEXT NOT NULL,
        first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        PRIMARY KEY(code,date,source,raw_hash)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS candle_quality_versions (
        code TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL,
        raw_hash TEXT NOT NULL, policy TEXT NOT NULL,
        status TEXT NOT NULL, reason TEXT NOT NULL, delta REAL NOT NULL,
        processed_high REAL, processed_low REAL, recorded_at TEXT NOT NULL,
        PRIMARY KEY(code,date,source,raw_hash,policy)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS candle_quality (
        code TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL,
        raw_hash TEXT NOT NULL, policy TEXT NOT NULL,
        PRIMARY KEY(code,date)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS quality_issues_idx ON candle_quality_versions
        (code,date,source,raw_hash,policy) WHERE status!='original';
      CREATE VIEW IF NOT EXISTS current_candle_quality AS
        SELECT q.*,v.status,v.reason,v.delta,v.processed_high,v.processed_low,
               r.payload AS raw_json
        FROM candle_quality q JOIN candle_quality_versions v
          USING(code,date,source,raw_hash,policy)
        JOIN raw_candles r USING(code,date,source,raw_hash);
    """)
    db.executescript(Path(__file__).with_name("nightly.sql").read_text(encoding="utf-8"))
    return db


@contextmanager
def savepoint(db, name):
    db.execute(f"SAVEPOINT {name}")
    try:
        yield
    except BaseException:
        db.execute(f"ROLLBACK TO {name}")
        raise
    finally:
        db.execute(f"RELEASE {name}")


def validate_rows(rows):
    result = []
    seen = set()
    for row in rows:
        day = str(row["date"])
        datetime.strptime(day, "%Y-%m-%d")
        values = [float(row[key]) for key in ("open", "high", "low", "close", "volume")]
        o, h, lo, c, v = values
        if not all(math.isfinite(n) and n >= 0 for n in values) or c <= 0:
            raise ValueError("Invalid OHLCV values")
        tradable = o > 0 and h > 0 and lo > 0 and v > 0
        if tradable and not (lo <= min(o, c) <= max(o, c) <= h):
            raise ValueError("Invalid OHLC range")
        if day in seen:
            raise ValueError("Duplicate candle date")
        seen.add(day)
        result.append((day, o, h, lo, c, v, int(tradable)))
    if not result:
        raise ValueError("Provider returned no candles")
    return sorted(result)


def prepare_rows(rows, source=SOURCE, strict=False):
    """Keep strict validation for usable candles; classify only OHLC range errors.

    The policy repairs a close outside an otherwise valid positive range by
    exactly one KRW. It never repairs an open, inverted range or larger error.
    """
    prepared, seen = [], set()
    for raw in rows:
        day = str(raw["date"])
        datetime.strptime(day, "%Y-%m-%d")
        if day in seen:
            raise ValueError("Duplicate candle date")
        seen.add(day)
        payload = json.dumps(raw, sort_keys=True, ensure_ascii=False, allow_nan=False)
        o, h, lo, c, v = [float(raw[key]) for key in ("open", "high", "low", "close", "volume")]
        if not all(math.isfinite(n) and n >= 0 for n in (o, h, lo, c, v)) or c <= 0:
            raise ValueError("Invalid OHLCV values")
        tradable = o > 0 and h > 0 and lo > 0 and v > 0
        status, reason, delta = "original", "", 0.0
        high, low = h, lo
        # A fully reported positive-price bar must have a valid envelope even
        # when volume is zero; all-zero suspension OHLC retains legacy semantics.
        check_range = o > 0 and h > 0 and lo > 0
        if check_range and not (lo <= min(o, c) <= max(o, c) <= h):
            delta = max(lo - o, lo - c, o - h, c - h, 0)
            close_only = lo <= o <= h and (c > h or c < lo)
            reason = "close>high" if close_only and c > h else "close<low" if close_only else "invalid_ohlc_range"
            if source == SOURCE and close_only and delta == 1 and not strict:
                status, high, low = "corrected", max(h, c), min(lo, c)
            else:
                status = "quarantined"
        elif not check_range and not (o == h == lo == 0 and v == 0):
            status, reason = "quarantined", "incomplete_ohlc_range"
        row = (day, o, high, low, c, v, int(tradable))
        if status != "quarantined":
            validate_rows([{**raw, "high": high, "low": low}])
        policy = STRICT_POLICY if strict and source == SOURCE and delta == 1 and status == "quarantined" else QUALITY_POLICY
        prepared.append({"row": row, "payload": payload, "policy": policy,
                         "hash": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
                         "status": status, "reason": reason, "delta": delta})
    if not prepared:
        raise ValueError("Provider returned no candles")
    return sorted(prepared, key=lambda p: p["row"][0])


def quality_counts(db, code):
    return dict(db.execute("SELECT status,count(*) FROM effective_candle_quality WHERE code=? GROUP BY status", (code,)))


def archive_rows(db, code, source, prepared, stamp):
    db.executemany("""INSERT INTO raw_candles VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(code,date,source,raw_hash) DO UPDATE SET last_seen=excluded.last_seen""",
                   [(code, p["row"][0], source, p["hash"], p["payload"], stamp, stamp) for p in prepared])
    db.executemany("INSERT OR IGNORE INTO candle_quality_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                   [(code, p["row"][0], source, p["hash"], p["policy"], p["status"], p["reason"], p["delta"],
                     p["row"][2] if p["status"] != "quarantined" else None,
                     p["row"][3] if p["status"] != "quarantined" else None, stamp) for p in prepared])


def active_recoveries(db, code):
    return db.execute("""SELECT r.id,r.date,r.base_source,r.base_hash,r.base_policy,r.payload,v.evidence
      FROM lab_resolution_current a JOIN lab_resolution_events e ON e.id=a.event
      JOIN lab_recovery_candidates r ON r.id=e.candidate
      JOIN lab_recovery_validations v ON v.id=e.validation WHERE a.code=?""", (code,)).fetchall()


def recovery_context(db, code, evidence, source):
    for row in evidence["context"]:
        current = db.execute("""SELECT c.open,c.high,c.low,c.close,c.volume FROM candles c
          JOIN current_candle_quality q USING(code,date)
          WHERE c.code=? AND c.date=? AND q.source=? AND q.status='original' AND c.tradable=1""",
                             (code, row["date"], source)).fetchone()
        if current != tuple(row[k] for k in FIELDS):
            return False
    return True


def withdraw(db, code, day, candidate, reason, action="withdraw"):
    db.execute("INSERT INTO lab_resolution_events(candidate,at,action,reason) VALUES(?,?,?,?)",
               (candidate, now_iso(), action, reason))
    db.execute("DELETE FROM lab_resolution_current WHERE code=? AND date=?", (code, day))


def reconcile_recoveries(db, code, recoveries, revised, rebase):
    for candidate, day, source, raw_hash, policy, payload, evidence in recoveries:
        raw = db.execute("SELECT source,raw_hash,policy,status,raw_json FROM current_candle_quality WHERE code=? AND date=?",
                         (code, day)).fetchone()
        row = json.loads(payload)
        if not raw:
            withdraw(db, code, day, candidate, "outside_retention")
        elif not revised and raw[:4] == (source, raw_hash, policy, "quarantined") and recovery_context(db, code, json.loads(evidence), source):
            db.execute("INSERT OR REPLACE INTO candles VALUES(?,?,?,?,?,?,?,?)", (code, *validate_rows([row])[0]))
        elif not revised and raw[0] == source and raw[3] == "original" and recovery_context(db, code, json.loads(evidence), source) and all(
                json.loads(raw[4])[k] == row[k] for k in FIELDS):
            withdraw(db, code, day, candidate, "provider_matches_validated_recovery", "supersede")
        else:
            withdraw(db, code, day, candidate, "raw_or_basis_changed")
            if raw[3] == "original" and not rebase:
                conflict = "recovery-basis-conflict-v1"
                db.execute("INSERT OR IGNORE INTO candle_quality_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                           (code, day, *raw[:2], conflict, "quarantined", "unverified_recovery_replacement", 0, None, None, now_iso()))
                db.execute("UPDATE candle_quality SET policy=? WHERE code=? AND date=?", (conflict, code, day))


def save_rows(db, code, name, market, rows, start, end, full=False, source=SOURCE, *, strict=False, rebase=False):
    if not re.fullmatch(r"[0-9][0-9A-Z]{5}", code):
        raise ValueError("Invalid symbol")
    pinned = db.execute("SELECT source FROM lab_symbol_basis WHERE code=?", (code,)).fetchone()
    if pinned and pinned[0] != source and not rebase:
        raise ValueError("Source conflicts with approved basis")
    prepared = prepare_rows(rows, source, strict)
    clean = [p["row"] for p in prepared if p["status"] != "quarantined"]
    existing = db.execute("SELECT source FROM symbols WHERE code=?", (code,)).fetchone()
    if existing and existing[0] != source and db.execute("SELECT 1 FROM candles WHERE code=? LIMIT 1", (code,)).fetchone() and not full:
        raise ValueError("Changing data source requires --full")
    if any(p["row"][0] < start or p["row"][0] > end for p in prepared):
        raise ValueError("Provider returned dates outside requested range")
    old_count = db.execute("""SELECT count(*) FROM (
      SELECT date FROM candles WHERE code=? AND date BETWEEN ? AND ?
      UNION SELECT date FROM candle_quality WHERE code=? AND date BETWEEN ? AND ?)
    """, (code, start, end, code, start, end)).fetchone()[0]
    if full and old_count > 20 and len(prepared) < old_count * 0.9:
        raise ValueError("Provider history unexpectedly shortened; existing data preserved")
    if full:
        known = {r[0] for r in db.execute("""SELECT date FROM candles WHERE code=? AND date BETWEEN ? AND ?
          UNION SELECT date FROM candle_quality WHERE code=? AND date BETWEEN ? AND ?""", (code, start, end, code, start, end))}
        if strict:
            known -= {r[0] for r in db.execute("""SELECT n.date FROM lab_nontrade n LEFT JOIN candles c USING(code,date)
                WHERE n.code=? AND n.source=? AND n.date BETWEEN ? AND ? AND coalesce(c.tradable,0)=0""",
                                               (code, source, start, end))}
        if known - {p["row"][0] for p in prepared}:
            raise ValueError("Provider history has missing known dates; existing data preserved")
    recoveries = active_recoveries(db, code)
    revised = rebase
    if recoveries and not revised:
        dates = {r[1] for r in recoveries}
        old = dict(db.execute("SELECT date,raw_hash FROM candle_quality WHERE code=? AND date BETWEEN ? AND ?",
                              (code, start, end)))
        revised = any(p["row"][0] in old and p["row"][0] not in dates and old[p["row"][0]] != p["hash"] for p in prepared)
    with savepoint(db, "save_candles"):
        stamp = now_iso()
        # Previously stored values are not claimed as newly fetched raw data.
        # Snapshot them once before the first quality-aware update/prune.
        db.execute("""INSERT OR IGNORE INTO legacy_candle_snapshots
          SELECT c.code,c.date,s.source,c.open,c.high,c.low,c.close,c.volume,c.tradable,?
          FROM candles c JOIN symbols s USING(code) WHERE c.code=? AND NOT EXISTS
          (SELECT 1 FROM candle_quality q WHERE q.code=c.code AND q.date=c.date)""", (stamp, code))
        archive_rows(db, code, source, prepared, stamp)
        # Replacing the current quality map never removes raw/decision history.
        if full:
            db.execute("DELETE FROM candle_quality WHERE code=? AND date BETWEEN ? AND ?", (code, start, end))
        db.executemany("INSERT OR REPLACE INTO candle_quality VALUES(?,?,?,?,?)",
                       [(code, p["row"][0], source, p["hash"], p["policy"]) for p in prepared])
        db.execute("""INSERT INTO symbols(code,name,market,source,updated_at,last_attempt,error)
          VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(code) DO UPDATE SET
          name=excluded.name, market=excluded.market, source=excluded.source,
          updated_at=excluded.updated_at,last_attempt=excluded.last_attempt,error=NULL""",
                   (code, name, market, source, now_iso(), now_iso()))
        # Preserve prior usable rows on quarantined dates in storage, but the
        # quality overlay hides them from the API/backtest until resolved.
        if full:
            db.execute("""DELETE FROM candles WHERE code=? AND date BETWEEN ? AND ?
              AND date NOT IN (SELECT date FROM current_candle_quality WHERE code=? AND status='quarantined')""",
                       (code, start, end, code))
        db.executemany("INSERT OR REPLACE INTO candles VALUES(?,?,?,?,?,?,?,?)",
                       [(code, *row) for row in clean])
        db.execute("DELETE FROM candles WHERE code=? AND date<?", (code, start if full else "0000"))
        if full:
            db.execute("DELETE FROM candle_quality WHERE code=? AND date<?", (code, start))
        reconcile_recoveries(db, code, recoveries, revised, rebase)
        quarantined = quality_counts(db, code).get("quarantined", 0)
        if quarantined:
            db.execute("UPDATE symbols SET error=? WHERE code=?", (f"OHLC quarantine: {quarantined} day(s)", code))
    return len(clean)


def query(path, code=None):
    if not Path(path).is_file():
        return {"ready": False, "items": [], "message": "일봉 데이터가 아직 수집되지 않았습니다. VPS에서 초기 수집을 실행하세요."}
    uri = Path(path).resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True, timeout=5)) as db:
        db.row_factory = sqlite3.Row
        # Prices and their quality overlay must come from one SQLite snapshot,
        # even if the nightly writer commits between the SELECT statements.
        db.execute("BEGIN")
        managed = bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='lab_publication'").fetchone())
        publication = None
        if managed:
            row = db.execute("SELECT * FROM lab_publication WHERE id=1").fetchone()
            if row:
                publication = dict(row)
                publication["summary"] = json.loads(publication["summary"])
            primary = db.execute("SELECT * FROM lab_batches WHERE phase='primary' ORDER BY day DESC LIMIT 1").fetchone()
            if primary and not code:
                publication = publication or {}
                publication["primary"] = {**dict(primary), "counts": dict(db.execute(
                    "SELECT status,count(*) FROM lab_batch_items WHERE day=? AND phase='primary' GROUP BY status", (primary["day"],)))}
            if not code:
                confirmation = db.execute("SELECT * FROM lab_batches WHERE phase='confirm' ORDER BY day DESC LIMIT 1").fetchone()
                if confirmation:
                    publication = publication or {}
                    publication["confirmation"] = dict(confirmation)
        if code:
            quality_ready = bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='view' AND name='current_candle_quality'").fetchone())
            quality_view = "effective_candle_quality" if managed and quality_ready else "current_candle_quality"
            if not re.fullmatch(r"[0-9][0-9A-Z]{5}", code):
                raise ValueError("Invalid symbol")
            symbol = db.execute("SELECT * FROM symbols WHERE code=?", (code,)).fetchone()
            items = db.execute("""SELECT date AS time,open,high,low,close,volume,tradable
              FROM (SELECT * FROM candles WHERE code=? ORDER BY date DESC LIMIT 2000) ORDER BY date""", (code,))
            candles = {row["time"]: dict(row) for row in items}
            quality = {"policy": (STRICT_POLICY if publication and publication["target"] else QUALITY_POLICY) if quality_ready else None,
                       "corrected": 0, "quarantined": 0, "issues": []}
            if quality_ready:
                for row in db.execute(f"SELECT * FROM {quality_view} WHERE code=? ORDER BY date", (code,)):
                    status, day = row["status"], row["date"]
                    if publication and publication["target"] and status == "corrected":
                        status = "quarantined"
                    if status in ("corrected", "quarantined", "recovered"):
                        quality[status] = quality.get(status, 0) + 1
                        issue = {"time": day, "status": status, "reason": row["reason"], "delta": row["delta"],
                                                  "raw": json.loads(row["raw_json"]), "rawHash": row["raw_hash"], "source": row["source"], "policy": row["policy"],
                                                  "processedHigh": row["processed_high"], "processedLow": row["processed_low"]}
                        if status == "recovered":
                            issue["recovery"] = {k.removeprefix("recovery_"): row[k] for k in
                                                 ("candidate", "recovery_source", "recovery_basis", "recovery_event", "recovery_validation")}
                        quality["issues"].append(issue)
                    if status == "quarantined":
                        candles[day] = {"time": day, "open": None, "high": None, "low": None,
                                        "close": None, "volume": None, "tradable": 0, "quality": status}
                    elif day in candles:
                        candles[day]["quality"] = status
            ordered = sorted(candles.values(), key=lambda row: row["time"])[-2000:]
            result = {"ready": bool(symbol), "symbol": dict(symbol) if symbol else None, "items": ordered, "quality": quality}
            if publication:
                state = db.execute("SELECT target,status,detail FROM lab_public_symbols WHERE code=?", (code,)).fetchone()
                basis = db.execute("SELECT source,version,listed FROM lab_symbol_basis WHERE code=?", (code,)).fetchone()
                default_basis = {"source": symbol["source"], "version": "provider-default-v1", "listed": None} if symbol else None
                result.update(publication=publication, collection=dict(state) if state else None, basis=dict(basis) if basis else default_basis)
            return result
        # Search needs identities only. Never scan historical prices or quality
        # versions here; selected-symbol requests above own those reads.
        items = db.execute("SELECT code,name,market FROM symbols WHERE active=1 ORDER BY name")
        run = db.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
        rows = [dict(row) for row in items]
        return {"ready": bool(rows), "items": rows, "run": dict(run) if run else None, "interval": "1d",
                **({"publication": publication} if publication else {})}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--symbol")
    args = parser.parse_args()
    print(json.dumps(query(args.db, args.symbol), ensure_ascii=True, allow_nan=False))
