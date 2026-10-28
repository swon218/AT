"""Disposable synthetic benchmark; never accepts or opens an operational DB.

Run: python -m ai_agent.tests.benchmark_rsi --symbols 2715 --bars 1250
Uses the real lab schema, quality/raw joins, default 12-second tool budget.
"""
import argparse
from pathlib import Path
import tempfile
import time
import json
import sqlite3
from lab.store import connect, SOURCE, QUALITY_POLICY
from ai_agent.config import Settings
from ai_agent.market import expected_sessions
from ai_agent.screener import RsiScreener
from ai_agent.snapshot_fingerprint import FORMAT


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--symbols', type=int, default=2715)
    args.add_argument('--bars', type=int, default=1250)
    args.add_argument('--profile-queries', action='store_true')
    args.add_argument('--raw-padding', type=int, default=0, help='Synthetic raw JSON padding to exercise large files')
    args.add_argument('--max-scans', type=int, default=2, help='Bounded scans before checking the completed cache')
    options = args.parse_args()
    if not 51 <= options.symbols <= 3000 or not 15 <= options.bars <= 2000:
        args.error('symbols must be 51..3000; bars must be 15..2000')
    if not 0 <= options.raw_padding <= 1024 or not 1 <= options.max_scans <= 4:
        args.error('raw-padding must be 0..1024; max-scans must be 1..4')
    parent = Path(tempfile.gettempdir()).resolve()
    temp = tempfile.TemporaryDirectory(prefix='atlas-rsi-benchmark-', dir=parent)
    root = Path(temp.name).resolve()
    if root.parent != parent or not root.name.startswith('atlas-rsi-benchmark-'):
        raise RuntimeError('Unexpected temporary benchmark location')
    timings = {}
    class MeasuredCursor(sqlite3.Cursor):
        def execute(self, sql, parameters=()):
            self.label = 'quality' if 'group_concat' in sql else 'candles' if 'usable' in sql else 'other'
            started = time.perf_counter()
            try: return super().execute(sql, parameters)
            finally: timings[self.label] = timings.get(self.label, 0) + time.perf_counter() - started
        def fetchall(self):
            started = time.perf_counter()
            try: return super().fetchall()
            finally: timings[self.label] = timings.get(self.label, 0) + time.perf_counter() - started
    class MeasuredConnection(sqlite3.Connection):
        def execute(self, sql, parameters=()):
            return self.cursor(factory=MeasuredCursor).execute(sql, parameters)
    class BenchScreener(RsiScreener):
        def _connect(self, path):
            db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2, check_same_thread=False, factory=MeasuredConnection)
            db.execute('PRAGMA query_only=ON')
            db.execute('PRAGMA mmap_size=1073741824')
            db.execute('PRAGMA temp_store=MEMORY')
            return db
    scanner = BenchScreener() if options.profile_queries else RsiScreener()
    try:
        path = root / 'synthetic.sqlite'
        started = time.perf_counter()
        dates = expected_sessions('2010-01-01', '2026-10-27')[-options.bars:]
        db = connect(path)
        try:
            db.execute('CREATE TEMP TABLE days(day TEXT, i INTEGER)')
            db.executemany('INSERT INTO days VALUES(?,?)', [(day, i) for i, day in enumerate(dates)])
            db.executemany('INSERT INTO symbols(code,name,market,source) VALUES(?,?,?,?)',
                           [(f'{i:06}', f'Fixture {i}', 'KOSPI' if i % 2 else 'KOSDAQ', SOURCE) for i in range(options.symbols)])
            db.execute('''INSERT INTO candles SELECT s.code,d.day,1000+d.i,1010+d.i,
                       990+d.i,1000+d.i,100,1 FROM symbols s CROSS JOIN days d
                       WHERE CAST(s.code AS INTEGER)<? OR d.i>=?''',
                       (options.symbols - 5, options.bars - 10))
            payload = json.dumps({'synthetic_padding': 'x' * options.raw_padding}) if options.raw_padding else '{}'
            db.execute('''INSERT INTO raw_candles SELECT code,date,?,'fixture',?,date,date FROM candles''', (SOURCE, payload))
            db.execute('''INSERT INTO candle_quality_versions
                       SELECT code,date,?,'fixture',?,
                       CASE WHEN CAST(code AS INTEGER)<45 AND date=? THEN 'quarantined' ELSE 'original' END,
                       '',0,high,low,date FROM candles''', (SOURCE, QUALITY_POLICY, dates[-1]))
            db.execute('INSERT INTO candle_quality SELECT code,date,source,raw_hash,policy FROM candle_quality_versions')
            db.commit()
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        finally:
            db.close()
        fixture_seconds = time.perf_counter() - started
        settings = Settings(lab_path=str(path))
        # Diagnostic old topology, on this disposable DB only. Native behavior can
        # differ by VFS/DB state; the regression suite separately injects the VPS symptom.
        watch = scanner._connect(path)
        try:
            before = watch.execute('PRAGMA data_version').fetchone()[0]
            temporary = scanner._connect(path)
            try:
                temporary.execute('SELECT count(*) FROM symbols').fetchone()
            finally:
                temporary.close()
            after = watch.execute('PRAGMA data_version').fetchone()[0]
        finally:
            watch.close()
        reader_probe = {'before': before, 'after': after, 'changed_without_writer': before != after}
        results = []
        for _ in range(options.max_scans + 1):
            started = time.perf_counter()
            result = scanner.scan(settings, 'ALL', dates[-1])
            results.append({k: v for k, v in result.items() if k != 'items'} | {'seconds': round(time.perf_counter() - started, 4)})
            assert not next(iter(scanner.entries.values()))['reader'].in_transaction
        print(json.dumps({'synthetic': True, 'sqlite_version': sqlite3.sqlite_version, 'fingerprint_format': FORMAT,
                          'reader_probe': reader_probe, 'symbols': options.symbols, 'bars': options.bars,
                          'raw_padding': options.raw_padding,
                          'fixture_seconds': round(fixture_seconds, 2), 'db_mb': round(path.stat().st_size / 1024**2, 1),
                          'tool_seconds': settings.tool_seconds, 'query_seconds': timings, 'results': results}, ensure_ascii=False), flush=True)
        complete = results[options.max_scans - 1]
        assert complete['scanned'] == options.symbols, 'Bounded cold/resumed scans did not complete'
        assert complete['valid'] == options.symbols - 50
        assert complete['excluded'] == {'quarantined_ohlc': 45, 'insufficient_warmup': 5}
        assert results[-1]['cache_hit']
    finally:
        scanner.close()
        # Only the verified, freshly created benchmark directory is removed.
        temp.cleanup()


if __name__ == '__main__':
    main()
