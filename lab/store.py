"""SQLite storage and read-only JSON bridge. No brokerage credentials required."""
import argparse
import hashlib
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
import sqlite3

KST = timezone(timedelta(hours=9))
SOURCE = "FDR:NAVER"
QUALITY_POLICY = "naver-close-envelope-1krw-v1"


def now_iso():
    return datetime.now(KST).isoformat(timespec="seconds")


def connect(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
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
    return db


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


def prepare_rows(rows, source=SOURCE):
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
            if source == SOURCE and close_only and delta == 1:
                status, high, low = "corrected", max(h, c), min(lo, c)
            else:
                status = "quarantined"
        elif not check_range and not (o == h == lo == 0 and v == 0):
            status, reason = "quarantined", "incomplete_ohlc_range"
        row = (day, o, high, low, c, v, int(tradable))
        if status != "quarantined":
            validate_rows([{**raw, "high": high, "low": low}])
        prepared.append({"row": row, "payload": payload,
                         "hash": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
                         "status": status, "reason": reason, "delta": delta})
    if not prepared:
        raise ValueError("Provider returned no candles")
    return sorted(prepared, key=lambda p: p["row"][0])


def quality_counts(db, code):
    return dict(db.execute("""SELECT v.status,count(*) FROM candle_quality q
      JOIN candle_quality_versions v USING(code,date,source,raw_hash,policy)
      WHERE q.code=? GROUP BY v.status""", (code,)))


def save_rows(db, code, name, market, rows, start, end, full=False, source=SOURCE):
    if not re.fullmatch(r"[0-9][0-9A-Z]{5}", code):
        raise ValueError("Invalid symbol")
    prepared = prepare_rows(rows, source)
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
        if known - {p["row"][0] for p in prepared}:
            raise ValueError("Provider history has missing known dates; existing data preserved")
    with db:
        stamp = now_iso()
        # Previously stored values are not claimed as newly fetched raw data.
        # Snapshot them once before the first quality-aware update/prune.
        db.execute("""INSERT OR IGNORE INTO legacy_candle_snapshots
          SELECT c.code,c.date,s.source,c.open,c.high,c.low,c.close,c.volume,c.tradable,?
          FROM candles c JOIN symbols s USING(code) WHERE c.code=? AND NOT EXISTS
          (SELECT 1 FROM candle_quality q WHERE q.code=c.code AND q.date=c.date)""", (stamp, code))
        for p in prepared:
            day, _, high, low, *_ = p["row"]
            identity = (code, day, source, p["hash"])
            db.execute("""INSERT INTO raw_candles VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(code,date,source,raw_hash) DO UPDATE SET last_seen=excluded.last_seen""",
                       (*identity, p["payload"], stamp, stamp))
            db.execute("INSERT OR IGNORE INTO candle_quality_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                       (*identity, QUALITY_POLICY, p["status"], p["reason"], p["delta"],
                        high if p["status"] != "quarantined" else None,
                        low if p["status"] != "quarantined" else None, stamp))
        # Replacing the current quality map never removes raw/decision history.
        if full:
            db.execute("DELETE FROM candle_quality WHERE code=? AND date BETWEEN ? AND ?", (code, start, end))
        db.executemany("INSERT OR REPLACE INTO candle_quality VALUES(?,?,?,?,?)",
                       [(code, p["row"][0], source, p["hash"], QUALITY_POLICY) for p in prepared])
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
        quality_ready = bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='view' AND name='current_candle_quality'").fetchone())
        if code:
            if not re.fullmatch(r"[0-9][0-9A-Z]{5}", code):
                raise ValueError("Invalid symbol")
            symbol = db.execute("SELECT * FROM symbols WHERE code=?", (code,)).fetchone()
            items = db.execute("""SELECT date AS time,open,high,low,close,volume,tradable
              FROM (SELECT * FROM candles WHERE code=? ORDER BY date DESC LIMIT 2000) ORDER BY date""", (code,))
            candles = {row["time"]: dict(row) for row in items}
            quality = {"policy": QUALITY_POLICY if quality_ready else None, "corrected": 0, "quarantined": 0, "issues": []}
            if quality_ready:
                for row in db.execute("SELECT * FROM current_candle_quality WHERE code=? ORDER BY date", (code,)):
                    status, day = row["status"], row["date"]
                    if status in ("corrected", "quarantined"):
                        quality[status] += 1
                        quality["issues"].append({"time": day, "status": status, "reason": row["reason"], "delta": row["delta"],
                                                  "raw": json.loads(row["raw_json"]), "rawHash": row["raw_hash"],
                                                  "processedHigh": row["processed_high"], "processedLow": row["processed_low"]})
                    if status == "quarantined":
                        candles[day] = {"time": day, "open": None, "high": None, "low": None,
                                        "close": None, "volume": None, "tradable": 0, "quality": status}
                    elif day in candles:
                        candles[day]["quality"] = status
            ordered = sorted(candles.values(), key=lambda row: row["time"])[-2000:]
            return {"ready": bool(symbol), "symbol": dict(symbol) if symbol else None,
                    "items": ordered, "quality": quality}
        items = db.execute("""SELECT s.*,min(c.date) AS first_date,max(c.date) AS last_date,
          count(c.date) AS bars FROM symbols s LEFT JOIN candles c USING(code)
          GROUP BY s.code ORDER BY s.name""")
        run = db.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
        rows = [dict(row) for row in items]
        if quality_ready:
            counts = {r["code"]: dict(r) for r in db.execute("""SELECT q.code,
              sum(v.status='corrected') AS corrected, sum(v.status='quarantined') AS quarantined,
              sum(v.status='quarantined' AND c.date IS NOT NULL) AS hidden
              FROM candle_quality_versions v JOIN candle_quality q USING(code,date,source,raw_hash,policy)
              LEFT JOIN candles c USING(code,date) WHERE v.status!='original' GROUP BY q.code""")}
            for row in rows:
                q = counts.get(row["code"], {})
                row.update(corrected=q.get("corrected", 0), quarantined=q.get("quarantined", 0))
                row["bars"] -= q.get("hidden", 0)
        return {"ready": any(row["bars"] for row in rows), "items": rows,
                "run": dict(run) if run else None, "interval": "1d"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--symbol")
    args = parser.parse_args()
    print(json.dumps(query(args.db, args.symbol), ensure_ascii=True, allow_nan=False))
