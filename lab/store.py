"""SQLite storage and read-only JSON bridge. No brokerage credentials required."""
import argparse
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
import sqlite3

KST = timezone(timedelta(hours=9))
SOURCE = "FDR:NAVER"


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


def save_rows(db, code, name, market, rows, start, end, full=False, source=SOURCE):
    if not re.fullmatch(r"[0-9][0-9A-Z]{5}", code):
        raise ValueError("Invalid symbol")
    clean = validate_rows(rows)
    existing = db.execute("SELECT source FROM symbols WHERE code=?", (code,)).fetchone()
    if existing and existing[0] != source and db.execute("SELECT 1 FROM candles WHERE code=? LIMIT 1", (code,)).fetchone() and not full:
        raise ValueError("Changing data source requires --full")
    if any(r[0] < start or r[0] > end for r in clean):
        raise ValueError("Provider returned dates outside requested range")
    old_count = db.execute("SELECT count(*) FROM candles WHERE code=? AND date BETWEEN ? AND ?", (code, start, end)).fetchone()[0]
    if full and old_count > 20 and len(clean) < old_count * 0.9:
        raise ValueError("Provider history unexpectedly shortened; existing data preserved")
    with db:
        db.execute("""INSERT INTO symbols(code,name,market,source,updated_at,last_attempt,error)
          VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(code) DO UPDATE SET
          name=excluded.name, market=excluded.market, source=excluded.source,
          updated_at=excluded.updated_at,last_attempt=excluded.last_attempt,error=NULL""",
                   (code, name, market, source, now_iso(), now_iso()))
        # Replacing a validated full window also removes provider-retracted rows.
        if full:
            db.execute("DELETE FROM candles WHERE code=? AND date BETWEEN ? AND ?", (code, start, end))
        db.executemany("INSERT OR REPLACE INTO candles VALUES(?,?,?,?,?,?,?,?)",
                       [(code, *row) for row in clean])
        db.execute("DELETE FROM candles WHERE code=? AND date<?", (code, start if full else "0000"))
    return len(clean)


def query(path, code=None):
    if not Path(path).is_file():
        return {"ready": False, "items": [], "message": "일봉 데이터가 아직 수집되지 않았습니다. VPS에서 초기 수집을 실행하세요."}
    uri = Path(path).resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True, timeout=5)) as db:
        db.row_factory = sqlite3.Row
        if code:
            if not re.fullmatch(r"[0-9][0-9A-Z]{5}", code):
                raise ValueError("Invalid symbol")
            symbol = db.execute("SELECT * FROM symbols WHERE code=?", (code,)).fetchone()
            items = db.execute("""SELECT date AS time,open,high,low,close,volume,tradable
              FROM (SELECT * FROM candles WHERE code=? ORDER BY date DESC LIMIT 2000) ORDER BY date""", (code,))
            return {"ready": bool(symbol), "symbol": dict(symbol) if symbol else None,
                    "items": [dict(row) for row in items]}
        items = db.execute("""SELECT s.*,min(c.date) AS first_date,max(c.date) AS last_date,
          count(c.date) AS bars FROM symbols s LEFT JOIN candles c USING(code)
          GROUP BY s.code ORDER BY s.name""")
        run = db.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
        rows = [dict(row) for row in items]
        return {"ready": any(row["bars"] for row in rows), "items": rows,
                "run": dict(run) if run else None, "interval": "1d"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--symbol")
    args = parser.parse_args()
    print(json.dumps(query(args.db, args.symbol), ensure_ascii=True, allow_nan=False))
