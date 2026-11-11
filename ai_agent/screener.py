"""Bounded read-only RSI scan with batched queries and commit-aware public caching."""
from bisect import bisect_left, bisect_right
from collections import Counter, OrderedDict
from datetime import datetime
import hashlib
from itertools import groupby
from math import isfinite
from pathlib import Path
import sqlite3
from threading import Lock
import time
from .krx_closures import VERSION
from .market import KST, calendar, expected_sessions, wilder_rsi
from .snapshot_fingerprint import fingerprint, FingerprintUnavailable

MAX_BARS = 2000
BATCH_SIZE = 64
COMPLETE_CACHE_TTL = 60
PROGRESS_CACHE_TTL = 300
MAX_FLOAT = '1.7976931348623157e308'
# Keep finite/tradable checks in SQLite before indicator calculations.
VALID_OHLCV = ' AND '.join(
    [f"(typeof(c.{x}) IN ('integer','real') AND c.{x}>0 AND c.{x}<={MAX_FLOAT})" for x in ('open', 'high', 'low', 'close')] +
    ['c.low<=min(c.open,c.close)', 'c.high>=max(c.open,c.close)',
     f"(typeof(c.volume) IN ('integer','real') AND c.volume>=0 AND c.volume<={MAX_FLOAT})"]
)


class ScanBusy(Exception):
    pass


class ScanChanged(Exception):
    pass


class RsiScreener:
    def __init__(self, ttl=COMPLETE_CACHE_TTL, clock=time.monotonic, evaluator=None, required_bars=15, allow_zero_volume=False,
                 progress_ttl=PROGRESS_CACHE_TTL):
        self.ttl, self.clock = ttl, clock
        self.progress_ttl = progress_ttl
        self.evaluator, self.required_bars = evaluator, required_bars
        self.valid_bar = ('(c.tradable != 0 OR c.volume = 0)' if allow_zero_volume else 'c.tradable != 0') + ' AND ' + VALID_OHLCV
        self.lock, self.entries = Lock(), OrderedDict()

    def close(self):
        with self.lock:
            for entry in self.entries.values():
                entry['reader'].close()
            self.entries.clear()

    def _connect(self, path):
        db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2, check_same_thread=False)
        try:
            db.execute('PRAGMA query_only=ON')
            # Read-only mapped pages avoid copying each quality/raw B-tree page through
            # SQLite's tiny default page cache. This is an OS-backed virtual mapping,
            # not a 1 GiB private allocation; unsupported SQLite builds safely return 0.
            db.execute('PRAGMA mmap_size=1073741824')
            db.execute('PRAGMA temp_store=MEMORY')
            # Complete one initial pager/WAL-index lifecycle before taking the
            # baseline fingerprint. No data/cache is reused from this warmup.
            db.execute('SELECT rootpage FROM sqlite_master LIMIT 1').fetchone()
        except BaseException:
            db.close()
            raise
        return db

    def scan(self, settings, market, cutoff, symbol=None):
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
            # data_version is not used: the deployed reader changes it across read
            # snapshot lifecycles. Attest actual DB/WAL commit state independently.
            db = entry['reader']
            now = self.clock()
            version = fingerprint(path)
            db.execute('BEGIN')
            try:
                # BEGIN is deferred. Pin a real snapshot (and initialize the pager)
                # before choosing partial progress. A commit between the independent
                # fingerprint and this snapshot must never reuse older progress.
                db.execute('SELECT rootpage FROM sqlite_master LIMIT 1').fetchone()
                if fingerprint(path) != version:
                    entry['results'].clear()
                    raise ScanChanged()
                cache_key = (version, market, cutoff, settings.screen_symbols, VERSION, symbol)
                for k, (at, data) in list(entry['results'].items()):
                    lifetime = self.ttl if data['scanned'] == data['universe'] else self.progress_ttl
                    if now - at >= lifetime or k[0] != version:
                        del entry['results'][k]
                existing = entry['results'].get(cache_key)
                hit = bool(existing and existing[1]['scanned'] == existing[1]['universe'])
                previous = existing[1] if existing else None
                result = ({**previous, 'cache_hit': True, 'resumed': 0} if hit else
                          self._scan(db, market, cutoff, settings.screen_symbols,
                                     now + max(0.001, settings.tool_seconds - 1), previous,
                                     **({'symbol': symbol} if symbol is not None else {})))
            finally:
                # Release every snapshot, including cache hits, SQL interrupts and
                # failures. A persistent read transaction would conceal WAL commits
                # and retain the collector's WAL indefinitely.
                db.set_progress_handler(None, 0)
                db.rollback()
            final_version = fingerprint(path, timeout=0.65)
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
            # only against an unchanged, independently verified commit fingerprint.
            # Partial work has its own absolute lifetime, never renewed by retries.
            # Every call still attests the current DB/WAL fingerprint. A completed
            # result starts the normal short cache lifetime at completion instead.
            if result['scanned']:
                if len(entry['results']) >= 8:
                    entry['results'].popitem(last=False)
                completed = result['scanned'] == result['universe']
                entry['results'][cache_key] = (self.clock() if completed else existing[0] if existing else now, result)
            return result
        finally:
            self.lock.release()

    def _scan(self, db, market, cutoff, max_symbols, deadline, previous=None, symbol=None):
        values = list(previous['items']) if previous else []
        excluded = Counter(previous['excluded']) if previous else Counter()
        scanned = previous['scanned'] if previous else 0
        all_sessions = tuple(expected_sessions(str(calendar().first_session.date()), cutoff))
        db.set_progress_handler(lambda: int(self.clock() >= deadline), 10000)
        if symbol is not None:
            where, params = 'active=1 AND code=?', (symbol,)
        else:
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
                SELECT c.code,c.date,c.close,CASE WHEN {self.valid_bar} THEN 1 ELSE 0 END usable,
                       c.open,c.high,c.low,c.volume
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
                if len(rows) < self.required_bars:
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
                    elif any(not isinstance(row[7], (int, float)) or not isfinite(row[7]) or row[7] < 0 for row in rows):
                        reason = 'invalid_volume'
                    elif any(not row[3] for row in rows):
                        reason = 'invalid_ohlc'
                if reason:
                    excluded[reason] += 1
                else:
                    try:
                        calculated = self.evaluator(rows) if self.evaluator else {'rsi': wilder_rsi([r[2] for r in rows])}
                    except (ValueError, ArithmeticError):
                        excluded['indicator_unavailable'] += 1
                        continue
                    values.append({'code': code, 'name': name, 'market': symbol_market, **calculated, 'bars': len(rows)})
            if self.clock() >= deadline:
                break
        values.sort(key=lambda row: (row.get('rsi', 0), row['code']))
        result = {'items': values, 'universe': total, 'scanned': scanned, 'valid': len(values), 'excluded': dict(excluded)}
        if symbol is not None and symbols:
            result['subject'] = dict(zip(('code', 'name', 'market'), symbols[0]))
        return result


SCREENER = RsiScreener()
