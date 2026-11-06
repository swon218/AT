"""Run manually for bootstrap, or from the nightly systemd timer.

Each provider request runs in a bounded subprocess. Failed symbols keep their
previous data; there is deliberately no silent fallback to a different market.
"""
import argparse
from datetime import date, datetime, timedelta
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from store import KST, SOURCE, connect, now_iso, save_rows, prepare_rows, quality_counts
from contextlib import contextmanager


@contextmanager
def collection_lock(db_path):
    lock_path = Path(str(db_path) + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle:
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            if lock_path.stat().st_size == 0:
                handle.write(b"0"); handle.flush(); handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def provider_worker(args):
    import requests
    original = requests.sessions.Session.request
    def bounded_request(self, *a, **kw):
        kw.setdefault("timeout", (10, 25))
        return original(self, *a, **kw)
    requests.sessions.Session.request = bounded_request
    import FinanceDataReader as fdr
    if args.worker == "listing":
        frame = fdr.StockListing("KRX")
        rows = [{"code": str(row.Code).zfill(6), "name": str(row.Name), "market": str(row.Market)}
                for row in frame.itertuples() if row.Market in ("KOSPI", "KOSDAQ")]
        if not rows:
            raise ValueError("Empty KRX listing")
        return rows
    frame = fdr.DataReader(f"{args.source}:{args.symbol}", args.start, args.end)
    return [{"date": index.strftime("%Y-%m-%d"),
             **{key.lower(): float(row[key]) for key in ("Open", "High", "Low", "Close", "Volume")}}
            for index, row in frame.iterrows()]


def fetch(kind, code=None, start=None, end=None, source="NAVER"):
    command = [sys.executable, str(Path(__file__).resolve()), "--worker", kind, "--source", source]
    if code:
        command += ["--symbol", code, "--start", start, "--end", end]
    for attempt in range(2):
        try:
            result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=120)
            if result.returncode:
                detail = result.stderr.strip().splitlines()[-1][:160] if result.stderr.strip() else "No provider response"
                raise RuntimeError(f"FDR {source} 조회 실패: {detail}")
            return json.loads(result.stdout)
        except (subprocess.TimeoutExpired, RuntimeError, json.JSONDecodeError):
            if attempt:
                raise
            time.sleep(3)


def window_start(end):
    return end.replace(year=end.year - 5, day=min(end.day, 28) if end.month == 2 else end.day)


def collect(args):
    now = datetime.now(KST)
    # Do not save a partial daily candle before the overnight collection window.
    end = date.fromisoformat(args.end) if args.end else (now.date() if now.hour >= 20 else now.date() - timedelta(days=1))
    latest_closed = now.date() if now.hour >= 20 else now.date() - timedelta(days=1)
    if end > latest_closed:
        raise ValueError("Only completed trading dates may be collected")
    start = window_start(end)
    db = connect(args.db)
    with db:
        run = db.execute("INSERT INTO runs(started_at) VALUES(?)", (now_iso(),)).lastrowid
    succeeded = failed = 0
    message = None
    deadline = time.monotonic() + args.max_minutes * 60
    try:
        if args.retry_invalid_ohlc:
            symbols = [{"code": r[0], "name": r[1], "market": r[2]} for r in db.execute("""
              SELECT code,name,market FROM symbols WHERE active=1 AND
              (error='Invalid OHLC range' OR code IN
               (SELECT code FROM current_candle_quality WHERE status='quarantined'))
              ORDER BY code""")]
        elif args.symbols:
            import re
            codes = list(dict.fromkeys(args.symbols.split(",")))
            if any(not re.fullmatch(r"[0-9][0-9A-Z]{5}", c) for c in codes):
                raise ValueError("--symbols must be comma-separated 6-character KRX codes")
            old = {r[0]: {"code": r[0], "name": r[1], "market": r[2]} for r in db.execute("SELECT code,name,market FROM symbols")}
            symbols = [old.get(c, {"code": c, "name": {"005930": "삼성전자", "000660": "SK하이닉스"}.get(c, c), "market": "KRX"}) for c in codes]
        else:
            symbols = fetch("listing")
            with db:
                db.execute("UPDATE symbols SET active=0")
                for stock in symbols:
                    db.execute("""INSERT INTO symbols(code,name,market,source) VALUES(?,?,?,?)
                      ON CONFLICT(code) DO UPDATE SET name=excluded.name,market=excluded.market,active=1""",
                               (stock["code"], stock["name"], stock["market"], f"FDR:{args.source}"))
        # Older / failed symbols first, so a timed-out batch can make progress next run.
        stamps = dict(db.execute("SELECT code,coalesce(updated_at,'') FROM symbols"))
        symbols.sort(key=lambda stock: stamps.get(stock["code"], ""))
        for stock in symbols:
            if time.monotonic() >= deadline:
                failed += len(symbols) - succeeded - failed
                message = "수집 시간 제한: 다음 실행에서 미완료 종목부터 재시도합니다."
                break
            code = stock["code"]
            try:
                latest = db.execute("SELECT max(date) FROM candles WHERE code=?", (code,)).fetchone()[0]
                source = db.execute("SELECT source FROM symbols WHERE code=?", (code,)).fetchone()
                full = args.full or now.weekday() == 6 or latest is None or (source and source[0] != f"FDR:{args.source}")
                begin = start if full else max(start, date.fromisoformat(latest) - timedelta(days=60))
                rows = fetch("prices", code, begin.isoformat(), end.isoformat(), args.source)
                clean = [p["row"] for p in prepare_rows(rows, f"FDR:{args.source}")]
                # A split/adjustment revises history, so refetch the entire 5y window.
                previous = {r[0]: r[1:] for r in db.execute("SELECT date,open,high,low,close FROM candles WHERE code=? AND date>=?", (code, begin.isoformat()))}
                revised = any(r[0] in previous and any(abs(a - b) > 0.01 for a, b in zip(r[1:5], previous[r[0]])) for r in clean)
                if revised and not full:
                    full, begin = True, start
                    rows = fetch("prices", code, start.isoformat(), end.isoformat(), args.source)
                count = save_rows(db, code, stock["name"], stock["market"], rows, begin.isoformat(), end.isoformat(), full, f"FDR:{args.source}")
                with db:
                    db.execute("DELETE FROM candles WHERE code=? AND date<?", (code, start.isoformat()))
                    db.execute("DELETE FROM candle_quality WHERE code=? AND date<?", (code, start.isoformat()))
                quality = quality_counts(db, code)
                unresolved = quality.get("quarantined", 0)
                failed += int(bool(unresolved))
                succeeded += int(not unresolved)
                print(json.dumps({"code": code, "rows": count, "ok": not unresolved,
                                  "corrected": quality.get("corrected", 0), "quarantined": unresolved,
                                  "error": "OHLC quarantine" if unresolved else None}), flush=True)
            except Exception as exc:
                failed += 1
                with db:
                    db.execute("""INSERT INTO symbols(code,name,market,source,last_attempt,error) VALUES(?,?,?,?,?,?)
                      ON CONFLICT(code) DO UPDATE SET last_attempt=excluded.last_attempt,error=excluded.error""",
                               (code, stock["name"], stock["market"], f"FDR:{args.source}", now_iso(), str(exc)[:240]))
                print(json.dumps({"code": code, "ok": False, "error": str(exc)[:240]}), flush=True)
            time.sleep(args.delay)
    except Exception as exc:
        failed += 1
        message = str(exc)[:240]
    finally:
        with db:
            db.execute("UPDATE runs SET finished_at=?,succeeded=?,failed=?,message=? WHERE id=?",
                       (now_iso(), succeeded, failed, message, run))
        db.close()
    print(json.dumps({"succeeded": succeeded, "failed": failed, "message": message}), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.environ.get("LAB_DB_PATH", "data/lab.sqlite"))
    parser.add_argument("--symbols", help="Omit to collect currently listed KOSPI/KOSDAQ stocks")
    parser.add_argument("--retry-invalid-ohlc", action="store_true", help="Only retry active symbols with OHLC validation/quarantine errors")
    parser.add_argument("--migrate-only", action="store_true", help="Add quality tables without fetching or changing existing candles")
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--max-minutes", type=int, default=600)
    parser.add_argument("--delay", type=float, default=0.4)
    parser.add_argument("--end")
    parser.add_argument("--worker", choices=("listing", "prices"))
    parser.add_argument("--symbol")
    parser.add_argument("--source", choices=("NAVER", "KRX"), default=os.environ.get("LAB_SOURCE", "NAVER"))
    parser.add_argument("--start")
    args = parser.parse_args()
    if args.symbols and args.retry_invalid_ohlc:
        parser.error("--symbols and --retry-invalid-ohlc cannot be combined")
    if args.worker:
        # Keep stdout exclusively JSON (FDR may print progress notices).
        import contextlib
        with contextlib.redirect_stdout(sys.stderr):
            result = provider_worker(args)
        print(json.dumps(result, ensure_ascii=True, allow_nan=False))
    else:
        try:
            with collection_lock(args.db):
                if args.migrate_only:
                    connect(args.db).close()
                    print("Quality schema ready; existing candles preserved.")
                else:
                    sys.exit(collect(args))
        except OSError as exc:
            print(f"Collector lock/storage unavailable: {exc}", file=sys.stderr)
            sys.exit(1)
