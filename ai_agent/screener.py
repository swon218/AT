"""Bounded read-only RSI scan with batched queries and commit-aware public caching."""
from bisect import bisect_left, bisect_right
from collections import Counter, OrderedDict
from datetime import datetime
import hashlib
from itertools import groupby
from pathlib import Path
import sqlite3
from threading import Lock
import time
from .krx_closures import VERSION
from .market import KST, calendar, expected_sessions, wilder_rsi

MAX_BARS = 2000
BATCH_SIZE = 64
MAX_FLOAT = '1.7976931348623157e308'
# Do the same OHLC/finite/tradable checks while reading only date/close into Python.
VALID_BAR = ' AND '.join(
    ["c.tradable != 0"] +
    [f"(typeof(c.{x}) IN ('integer','real') AND c.{x}>0 AND c.{x}<={MAX_FLOAT})" for x in ('open', 'high', 'low', 'close')] +
    ['c.low<=min(c.open,c.close)', 'c.high>=max(c.open,c.close)']
)


class ScanBusy(Exception):
    pass


class ScanChanged(Exception):
    pass


class RsiScreener:
    def __init__(self, ttl=60, clock=time.monotonic):
        self.ttl, self.clock = ttl, clock
        self.lock, self.entries = Lock(), OrderedDict()

    def close(self):
        with self.lock:
            for entry in self.entries.values():
                entry['reader'].close()
            self.entries.clear()

    def _connect(self, path):
        db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2, check_same_thread=False)
        db.execute('PRAGMA query_only=ON')
        # Read-only mapped pages avoid copying each quality/raw B-tree page through
        # SQLite's tiny default page cache. This is an OS-backed virtual mapping,
        # not a 1 GiB private allocation; unsupported SQLite builds safely return 0.
        db.execute('PRAGMA mmap_size=1073741824')
        db.execute('PRAGMA temp_store=MEMORY')
        return db

    def scan(self, settings, market, cutoff):
        path = Path(settings.lab_path).resolve()
        if not settings.lab_path or not path.is_file():
            raise FileNotFoundError('lab_data_not_ready')
        if not self.lock.acquire(timeout=0.05):
            raise ScanBusy()
        try:
            stamp = path.stat()
            identity = (stamp.st_dev, stamp.st_ino)
            key = str(path)
            old = self.entries.get(key)
            if old and old['identity'] != identity:
                old['reader'].close(); del self.entries[key]
            if key not in self.entries:
                if len(self.entries) >= 4:
                    _, removed = self.entries.popitem(last=False)
                    removed['reader'].close()
                self.entries[key] = {'identity': identity, 'reader': self._connect(path), 'results': OrderedDict()}
            self.entries.move_to_end(key)
            entry = self.entries[key]
            # One persistent reader owns BOTH version checks and all scan queries.
            # Opening/closing a second reader can invalidate the first reader's pager
            # on the reported SQLite 3.37.2 deployment, even without a writer commit.
            db = entry['reader']
            now = self.clock()
            db.execute('BEGIN')
            try:
                # BEGIN is deferred. Pin a real snapshot (and initialize the pager)
                # before reading its version or choosing partial progress to resume.
                db.execute('SELECT rootpage FROM sqlite_master LIMIT 1').fetchone()
                version = db.execute('PRAGMA data_version').fetchone()[0]
                cache_key = (version, market, cutoff, settings.screen_symbols, VERSION)
                for k, (at, _) in list(entry['results'].items()):
                    if now - at >= self.ttl or k[0] != version:
                        del entry['results'][k]
                existing = entry['results'].get(cache_key)
                hit = bool(existing and existing[1]['scanned'] == existing[1]['universe'])
                previous = existing[1] if existing else None
                result = ({**previous, 'cache_hit': True, 'resumed': 0} if hit else
                          self._scan(db, market, cutoff, settings.screen_symbols,
                                     now + max(0.001, settings.tool_seconds - 1), previous))
            finally:
                # Release every snapshot, including cache hits, SQL interrupts and
                # failures. A persistent read transaction would conceal WAL commits
                # and retain the collector's WAL indefinitely.
                db.set_progress_handler(None, 0)
                db.rollback()
            final_version = db.execute('PRAGMA data_version').fetchone()[0]
            final_stamp = path.stat()
            if version != final_version or identity != (final_stamp.st_dev, final_stamp.st_ino):
                entry['results'].clear()
                # In particular, never merge older progress with a new DB snapshot
                # if the writer committed between the version check and BEGIN.
                raise ScanChanged()
            if hit:
                return result
            result['data_read_at'] = previous['data_read_at'] if previous else datetime.now(KST).isoformat()
            result['data_version'] = hashlib.sha256(repr((identity, version, cutoff, VERSION)).encode()).hexdigest()[:24]
            result['cache_hit'] = False
            result['resumed'] = previous['scanned'] if previous else 0
            # Retain bounded partial progress, never label it complete/cache_hit. Resume
            # only against the same persistent connection's unchanged commit version.
            # Keep the first read's TTL so repeated calls cannot prolong stale progress.
            if result['scanned']:
                if len(entry['results']) >= 8:
                    entry['results'].popitem(last=False)
                entry['results'][cache_key] = (existing[0] if existing else now, result)
            return result
        finally:
            self.lock.release()

    def _scan(self, db, market, cutoff, max_symbols, deadline, previous=None):
        values = list(previous['items']) if previous else []
        excluded = Counter(previous['excluded']) if previous else Counter()
        scanned = previous['scanned'] if previous else 0
        all_sessions = tuple(expected_sessions(str(calendar().first_session.date()), cutoff))
        db.set_progress_handler(lambda: int(self.clock() >= deadline), 10000)
        where, params = ('active=1', ()) if market == 'ALL' else ('active=1 AND market=?', (market,))
        total = db.execute('SELECT count(*) FROM symbols WHERE ' + where, params).fetchone()[0]
        symbols = db.execute('SELECT code,name,market FROM symbols WHERE ' + where + ' ORDER BY code LIMIT ? OFFSET ?', (*params, max(0, max_symbols - scanned), scanned)).fetchall()
        quality_ready = bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='current_candle_quality' AND type='view'").fetchone())
        for start in range(0, len(symbols), BATCH_SIZE):
            if self.clock() >= deadline:
                break
            batch = symbols[start:start + BATCH_SIZE]
            placeholders = ','.join('(?)' for _ in batch)
            codes = tuple(s[0] for s in batch)
            try:
                # Seek the last 2,000-bar boundary once per code, then read contiguous
                # primary-key ranges. No per-bar correlated quality lookups/window sort.
                starts = db.execute(f'''WITH selected(code) AS (VALUES {placeholders})
                    SELECT s.code,coalesce((SELECT date FROM candles c WHERE c.code=s.code AND c.date<=?
                    ORDER BY date DESC LIMIT 1 OFFSET ?),'') FROM selected s''', (*codes, cutoff, MAX_BARS - 1)).fetchall()
                ranges = ','.join('(?,?)' for _ in starts)
                parameters = tuple(value for row in starts for value in row)
                bars = db.execute(f'''WITH selected(code,start) AS (VALUES {ranges})
                    SELECT c.code,c.date,c.close,CASE WHEN {VALID_BAR} THEN 1 ELSE 0 END usable
                    FROM selected s CROSS JOIN candles c
                    ON c.code=s.code AND c.date>=s.start AND c.date<=? ORDER BY c.code,c.date''', (*parameters, cutoff)).fetchall()
                by_code = {code: list(rows) for code, rows in groupby(bars, key=lambda row: row[0])}
                quality_ranges = [(code, rows[0][1]) for code, rows in by_code.items()]
                qualities = []
                if quality_ready and quality_ranges:
                    quality_parameters = tuple(value for row in quality_ranges for value in row)
                    # Force the current map as the outer index range, joining the exact
                    # version and raw identity. Historical versions cannot replace a missing
                    # current record; missing raw data remains excluded.
                    qualities = db.execute(f'''WITH selected(code,start) AS (VALUES {','.join('(?,?)' for _ in quality_ranges)})
                        SELECT code,sum(status='quarantined'),group_concat(date,',') FROM (
                        SELECT q.code,q.date,v.status FROM selected s CROSS JOIN candle_quality q
                        ON q.code=s.code AND q.date>=s.start AND q.date<=?
                        CROSS JOIN candle_quality_versions v USING(code,date,source,raw_hash,policy)
                        CROSS JOIN raw_candles r USING(code,date,source,raw_hash)
                        ORDER BY q.code,q.date) GROUP BY code''', (*quality_parameters, cutoff)).fetchall()
            except sqlite3.OperationalError as exc:
                if self.clock() >= deadline:
                    break
                raise exc
            quality_map = {code: (bad, dates) for code, bad, dates in qualities}
            for code, name, symbol_market in batch:
                if self.clock() >= deadline:
                    break
                scanned += 1
                rows = by_code.get(code, [])
                reason = None
                if len(rows) < 15:
                    reason = 'insufficient_warmup'
                elif rows[-1][1] != cutoff:
                    reason = 'stale_data'
                elif not quality_ready:
                    reason = 'quality_records_missing'
                elif quality_map.get(code, (0, ''))[0]:
                    reason = 'quarantined_ohlc'
                else:
                    dates = tuple(r[1] for r in rows)
                    quality_dates = quality_map.get(code, (0, ''))[1]
                    # Equal ordered date strings are the common fast path. Extra quality
                    # dates are allowed, just as before; every stored candle must be covered.
                    if ','.join(dates) != quality_dates and not set(dates).issubset(set(quality_dates.split(','))):
                        reason = 'quality_records_missing'
                    elif dates != all_sessions[bisect_left(all_sessions, rows[0][1]):bisect_right(all_sessions, cutoff)]:
                        reason = 'missing_sessions'
                    elif any(not row[3] for row in rows):
                        reason = 'invalid_ohlc'
                if reason:
                    excluded[reason] += 1
                else:
                    values.append({'code': code, 'name': name, 'market': symbol_market,
                                   'rsi': wilder_rsi([r[2] for r in rows]), 'bars': len(rows)})
            if self.clock() >= deadline:
                break
        values.sort(key=lambda row: (row['rsi'], row['code']))
        return {'items': values, 'universe': total, 'scanned': scanned, 'valid': len(values), 'excluded': dict(excluded)}


SCREENER = RsiScreener()
