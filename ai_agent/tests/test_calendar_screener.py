from dataclasses import replace
from datetime import datetime
import sqlite3
import pytest
from lab.store import connect, save_rows
from ai_agent.config import Settings
from ai_agent.krx_closures import VERSION
from ai_agent.market import calendar, market_context, expected_sessions, wilder_rsi
from ai_agent.screener import RsiScreener, SCREENER, ScanChanged
from .fixtures import make_lab, NOW
from ai_agent.tools import ResearchTools
from ai_agent.schemas import Screen


@pytest.fixture(autouse=True)
def close_public_scan_cache():
    SCREENER.close()
    yield
    SCREENER.close()


@pytest.mark.parametrize('day,target,previous', [('2026-06-03', '2026-06-04', '2026-06-02'), ('2026-07-17', '2026-07-20', '2026-07-16')])
def test_reviewed_closures_apply_to_navigation_and_gap_checks(day, target, previous):
    assert not calendar().is_session(day)
    context = market_context(datetime.fromisoformat(day + 'T08:00:00+09:00'), '2026-12-31')
    assert context['session'] == target and context['latest_completed'] == previous
    assert VERSION in context['calendar_source']
    assert day not in expected_sessions(previous, target)
    assert calendar().is_session(previous) and calendar().is_session(target)


def test_holiday_gaps_are_valid_but_real_missing_day_stays_excluded(tmp_path):
    path = tmp_path / 'calendar.sqlite'
    dates = expected_sessions('2026-05-01', '2026-07-20')
    assert '2026-06-03' not in dates and '2026-07-17' not in dates
    rows = [{'date': day, 'open': 100+i, 'high': 110+i, 'low': 90+i, 'close': 100+i, 'volume': 100} for i, day in enumerate(dates)]
    db = connect(path)
    save_rows(db, '005930', '삼성전자', 'KOSPI', rows, dates[0], dates[-1], full=True); db.close()
    scanner = RsiScreener()
    settings = Settings(lab_path=str(path))
    try:
        result = scanner.scan(settings, 'ALL', dates[-1])
        assert result['valid'] == 1 and result['excluded'] == {}
        assert result['items'][0]['rsi'] == round(wilder_rsi([r['close'] for r in rows]), 4)
        with sqlite3.connect(path) as writer: writer.execute("DELETE FROM candles WHERE date='2026-06-02'")
        result = scanner.scan(settings, 'ALL', dates[-1])
        assert not result['cache_hit'] and result['excluded'] == {'missing_sessions': 1}
    finally: scanner.close()


def test_wal_commit_invalidates_cache_and_keeps_quality_guards(tmp_path):
    path = tmp_path / 'wal.sqlite'; make_lab(path)
    scanner = RsiScreener()
    settings = Settings(lab_path=str(path))
    try:
        first = scanner.scan(settings, 'ALL', '2026-10-27')
        second = scanner.scan(settings, 'ALL', '2026-10-27')
        assert first['valid'] == 3 and not first['cache_hit'] and second['cache_hit']
        with sqlite3.connect(path) as writer:
            assert writer.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
            writer.execute("UPDATE candles SET close=close+2 WHERE code='005930' AND date='2026-10-27'")
        changed = scanner.scan(settings, 'ALL', '2026-10-27')
        assert not changed['cache_hit'] and changed['data_version'] != first['data_version']
        assert next(r['rsi'] for r in changed['items'] if r['code'] == '005930') > 0
        with sqlite3.connect(path) as writer:
            writer.execute("UPDATE candle_quality_versions SET status='quarantined' WHERE code='005930' AND date='2026-10-27'")
        guarded = scanner.scan(settings, 'ALL', '2026-10-27')
        assert not guarded['cache_hit'] and guarded['excluded'] == {'quarantined_ohlc': 1}
        with sqlite3.connect(path) as writer:
            writer.execute("DELETE FROM raw_candles WHERE code='000660' AND date='2026-10-27'")
        guarded = scanner.scan(settings, 'ALL', '2026-10-27')
        assert guarded['excluded'] == {'quarantined_ohlc': 1, 'quality_records_missing': 1}
    finally: scanner.close()


def test_partial_universe_is_never_a_full_cache_hit_and_expired_cache_rebuilds(tmp_path):
    path = tmp_path / 'partial.sqlite'; make_lab(path)
    settings = Settings(lab_path=str(path), screen_symbols=2)
    scanner = RsiScreener()
    try:
        for _ in range(2):
            result = scanner.scan(settings, 'ALL', '2026-10-27')
            assert result['scanned'] == 2 and result['universe'] == 3 and not result['cache_hit']
    finally: scanner.close()
    scanner = RsiScreener(ttl=0)
    try:
        for _ in range(2): assert not scanner.scan(replace(settings, screen_symbols=3), 'ALL', '2026-10-27')['cache_hit']
    finally: scanner.close()


def test_partial_progress_resumes_only_same_version_and_never_claims_complete(tmp_path):
    path = tmp_path / 'resume.sqlite'; make_lab(path)
    class OneAtATime(RsiScreener):
        def _scan(self, path, market, cutoff, max_symbols, deadline, previous=None):
            before = previous['scanned'] if previous else 0
            return super()._scan(path, market, cutoff, min(max_symbols, before + 1), deadline, previous)
    scanner = OneAtATime()
    settings = Settings(lab_path=str(path))
    try:
        for count in (1, 2, 3):
            result = scanner.scan(settings, 'ALL', '2026-10-27')
            assert result['scanned'] == count and result['resumed'] == count - 1
            assert not result['cache_hit']
        assert scanner.scan(settings, 'ALL', '2026-10-27')['cache_hit']
        with sqlite3.connect(path) as writer: writer.execute("UPDATE symbols SET active=0 WHERE code='000660'")
        changed = scanner.scan(settings, 'ALL', '2026-10-27')
        assert changed['universe'] == 2 and changed['scanned'] == 1 and changed['resumed'] == 0
        assert not changed['cache_hit'] and changed['data_version'] != result['data_version']
    finally: scanner.close()


def test_commit_during_scan_discards_results_instead_of_mixing_versions(tmp_path):
    path = tmp_path / 'concurrent.sqlite'; make_lab(path)
    class ChangingScanner(RsiScreener):
        change = True
        def _scan(self, *args):
            if self.change:
                reader = args[0]
                old_name = reader.execute("SELECT name FROM symbols WHERE code='005930'").fetchone()[0]
                with sqlite3.connect(path) as writer: writer.execute("UPDATE symbols SET name='Changed' WHERE code='005930'")
                # The writer commits while the scan's real read transaction is pinned.
                assert reader.execute("SELECT name FROM symbols WHERE code='005930'").fetchone()[0] == old_name
                self.change = False
            return super()._scan(*args)
    scanner = ChangingScanner()
    try:
        with pytest.raises(ScanChanged): scanner.scan(Settings(lab_path=str(path)), 'ALL', '2026-10-27')
        assert not next(iter(scanner.entries.values()))['results']
        assert not next(iter(scanner.entries.values()))['reader'].in_transaction
        result = scanner.scan(Settings(lab_path=str(path)), 'ALL', '2026-10-27')
        assert result['valid'] == 3 and not result['cache_hit']
        assert next(r['name'] for r in result['items'] if r['code'] == '005930') == 'Changed'
    finally: scanner.close()


def test_reader_close_pager_invalidation_does_not_break_own_scan(tmp_path):
    """Model the reported production runtime, not a claim all 3.37.2 builds do this.

    A second read-only connection's close changes the persistent reader's version
    without a writer. The old watch+temporary-scan topology fails this condition.
    Actual SQLite WAL versions are still included, so real writes stay detectable.
    """
    path = tmp_path / 'reader-lifecycle.sqlite'; make_lab(path)
    runtime = {'open': set(), 'opened': 0, 'close_bumps': 0}

    class VersionRow:
        def __init__(self, value): self.value = value
        def fetchone(self): return (self.value,)

    class Reader:
        def __init__(self, db):
            self.db = db
            runtime['open'].add(self)
            runtime['opened'] += 1
        def __getattr__(self, name): return getattr(self.db, name)
        def __enter__(self): self.db.__enter__(); return self
        def __exit__(self, *args): return self.db.__exit__(*args)
        def execute(self, sql, *args):
            row = self.db.execute(sql, *args)
            if sql == 'PRAGMA data_version':
                return VersionRow(row.fetchone()[0] + runtime['close_bumps'])
            return row
        def close(self):
            self.db.close()
            runtime['open'].remove(self)
            if runtime['open']: runtime['close_bumps'] += 1

    class LegacyRuntimeScanner(RsiScreener):
        def _connect(self, path): return Reader(super()._connect(path))

    scanner = LegacyRuntimeScanner()
    settings = Settings(lab_path=str(path))
    try:
        # Reproduce the operator's minimal sequence in the injected lifecycle model.
        watch = scanner._connect(path.resolve())
        before = watch.execute('PRAGMA data_version').fetchone()[0]
        temporary = scanner._connect(path.resolve())
        temporary.execute('SELECT count(*) FROM candles').fetchone(); temporary.close()
        assert watch.execute('PRAGMA data_version').fetchone()[0] != before
        watch.close()
        opened_before = runtime['opened']
        cold = scanner.scan(settings, 'ALL', '2026-10-27')
        cached = scanner.scan(settings, 'ALL', '2026-10-27')
        assert cold['valid'] == 3 and not cold['cache_hit'] and cached['cache_hit']
        assert runtime['opened'] - opened_before == 1  # No second scan reader, even on cache hit.
        reader = next(iter(scanner.entries.values()))['reader']
        assert not reader.in_transaction
        with sqlite3.connect(path) as writer:
            writer.execute("UPDATE candles SET close=close+2 WHERE code='005930' AND date='2026-10-27'")
        changed = scanner.scan(settings, 'ALL', '2026-10-27')
        assert not changed['cache_hit'] and changed['data_version'] != cold['data_version']
    finally: scanner.close()
    assert not runtime['open']


def test_snapshot_lifecycle_version_2_4_5_is_not_a_commit(tmp_path):
    """Reproduce the second VPS report's observable counter behavior by injection."""
    path = tmp_path / 'lifecycle-2-4-5.sqlite'; make_lab(path)

    class VersionRow:
        def __init__(self, value): self.value = value
        def fetchone(self): return (self.value,)

    class Reader:
        def __init__(self, db): self.db, self.version, self.pinned = db, 2, False
        def __getattr__(self, name): return getattr(self.db, name)
        def execute(self, sql, *args):
            if sql == 'PRAGMA data_version': return VersionRow(self.version)
            result = self.db.execute(sql, *args)
            if sql == 'BEGIN': self.pinned = False
            if sql.startswith('SELECT rootpage') and not self.pinned:
                self.version += 2; self.pinned = True
            return result
        def rollback(self):
            if self.db.in_transaction: self.version += 1
            self.db.rollback()

    class Runtime(RsiScreener):
        def _connect(self, path): return Reader(super()._connect(path))

    scanner = Runtime()
    try:
        # Establish the reported failure condition before testing the new algorithm.
        reader = scanner._connect(path.resolve())
        before = reader.execute('PRAGMA data_version').fetchone()[0]
        reader.execute('BEGIN'); reader.execute('SELECT rootpage FROM sqlite_master LIMIT 1').fetchone()
        inside = reader.execute('PRAGMA data_version').fetchone()[0]
        reader.rollback()
        after = reader.execute('PRAGMA data_version').fetchone()[0]
        assert (before, inside, after) == (2, 4, 5)
        reader.close()
        settings = Settings(lab_path=str(path))
        cold = scanner.scan(settings, 'ALL', '2026-10-27')
        cached = scanner.scan(settings, 'ALL', '2026-10-27')
        assert cold['valid'] == 3 and cached['cache_hit'] and cold['data_version'] == cached['data_version']
        with sqlite3.connect(path) as writer:
            writer.execute("UPDATE symbols SET name='Actual writer' WHERE code='005930'")
        changed = scanner.scan(settings, 'ALL', '2026-10-27')
        assert not changed['cache_hit'] and changed['data_version'] != cold['data_version']
        assert next(r['name'] for r in changed['items'] if r['code'] == '005930') == 'Actual writer'
    finally: scanner.close()


def test_commit_between_stamp_and_snapshot_pin_is_rejected(tmp_path, monkeypatch):
    import ai_agent.screener as module
    path = tmp_path / 'pin-race.sqlite'; make_lab(path)
    scanner = RsiScreener()
    original = module.fingerprint
    calls = 0
    def commit_after_probe(path, **kwargs):
        nonlocal calls
        token = original(path, **kwargs)
        calls += 1
        if calls == 1:
            with sqlite3.connect(path) as writer:
                writer.execute("UPDATE symbols SET name='New snapshot' WHERE code='005930'")
        return token
    monkeypatch.setattr(module, 'fingerprint', commit_after_probe)
    try:
        with pytest.raises(ScanChanged): scanner.scan(Settings(lab_path=str(path)), 'ALL', '2026-10-27')
        entry = next(iter(scanner.entries.values()))
        assert not entry['results'] and not entry['reader'].in_transaction
    finally: scanner.close()


def test_real_readers_are_stable_and_same_size_wal_commit_invalidates(tmp_path):
    import os
    from ai_agent.snapshot_fingerprint import fingerprint
    path = tmp_path / 'same-size.sqlite'; make_lab(path)
    writer = sqlite3.connect(path)
    scanner = RsiScreener()
    try:
        writer.execute('PRAGMA wal_autocheckpoint=0')
        writer.execute('CREATE TABLE padding(payload BLOB)')
        writer.execute('INSERT INTO padding VALUES(zeroblob(1048576))'); writer.commit()
        assert writer.execute('PRAGMA wal_checkpoint(RESTART)').fetchone()[0] == 0
        writer.execute("UPDATE symbols SET name='Baseline' WHERE code='005930'"); writer.commit()
        before = fingerprint(path)
        with scanner._connect(path.resolve()) as reader:
            reader.execute('BEGIN')
            reader.execute('SELECT count(*) FROM candles').fetchone()
            reader.rollback()
        reader.close()
        assert fingerprint(path) == before  # Reader marks/lifetimes are not commits.
        settings = Settings(lab_path=str(path))
        cold = scanner.scan(settings, 'ALL', '2026-10-27')
        assert scanner.scan(settings, 'ALL', '2026-10-27')['cache_hit']
        wal = path.with_name(path.name + '-wal')
        stamp = wal.stat()
        writer.execute("UPDATE candles SET close=close+2 WHERE code='005930' AND date='2026-10-27'"); writer.commit()
        assert wal.stat().st_size == stamp.st_size
        os.utime(wal, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        assert wal.stat().st_mtime_ns == stamp.st_mtime_ns
        assert fingerprint(path) != before
        changed = scanner.scan(settings, 'ALL', '2026-10-27')
        assert not changed['cache_hit'] and changed['data_version'] != cold['data_version']
        assert next(r['rsi'] for r in changed['items'] if r['code'] == '005930') > 0
    finally:
        scanner.close(); writer.close()


def test_unverified_fingerprint_never_serves_old_cache(tmp_path, monkeypatch):
    import ai_agent.screener as module
    from ai_agent.snapshot_fingerprint import FingerprintUnavailable
    path = tmp_path / 'unverified.sqlite'; make_lab(path)
    scanner = RsiScreener()
    try:
        scanner.scan(Settings(lab_path=str(path)), 'ALL', '2026-10-27')
        def unavailable(*args, **kwargs): raise FingerprintUnavailable('test_unverified')
        monkeypatch.setattr(module, 'fingerprint', unavailable)
        with pytest.raises(FingerprintUnavailable): scanner.scan(Settings(lab_path=str(path)), 'ALL', '2026-10-27')
        assert not next(iter(scanner.entries.values()))['reader'].in_transaction
    finally: scanner.close()


def test_scan_is_readonly_preserves_invalid_bar_and_deadline_exclusions(tmp_path):
    path = tmp_path / 'readonly.sqlite'; make_lab(path)
    scanner = RsiScreener(); settings = Settings(lab_path=str(path))
    try:
        with sqlite3.connect(path) as writer:
            writer.execute("UPDATE candles SET high=1 WHERE code='005930' AND date='2026-10-27'")
        before = path.read_bytes()
        result = scanner.scan(settings, 'ALL', '2026-10-27')
        assert result['excluded'] == {'invalid_ohlc': 1}
        assert path.read_bytes() == before
        with scanner._connect(path) as reader:
            with pytest.raises(sqlite3.OperationalError): reader.execute('DELETE FROM candles')
        # The execution deadline still truncates work; no setting or guard is relaxed.
        slow_clock = iter([0, 100, 100, 100, 100, 100, 100, 100])
        bounded = RsiScreener(clock=lambda: next(slow_clock, 100))
        try:
            result = bounded.scan(settings, 'ALL', '2026-10-27')
            assert result['scanned'] == 0 and result['universe'] == 3
        finally: bounded.close()
    finally: scanner.close()


def test_last_2000_bars_and_quarantine_without_a_stored_candle(tmp_path):
    path = tmp_path / 'history.sqlite'
    dates = expected_sessions('2010-01-01', '2026-10-27')[-2010:]
    closes = [1000 + i * 0.1 + (i % 3) for i in range(len(dates))]
    rows = [{'date': day, 'open': close, 'high': close+10, 'low': close-10, 'close': close, 'volume': 100}
            for day, close in zip(dates, closes)]
    db = connect(path)
    save_rows(db, '005930', '삼성전자', 'KOSPI', rows, dates[0], dates[-1], full=True); db.close()
    scanner = RsiScreener()
    try:
        with sqlite3.connect(path) as writer:
            writer.execute('UPDATE candle_quality_versions SET status=? WHERE date=?', ('quarantined', dates[0]))
        result = scanner.scan(Settings(lab_path=str(path)), 'ALL', dates[-1])
        assert result['valid'] == 1 and result['items'][0]['bars'] == 2000
        assert result['items'][0]['rsi'] == wilder_rsi(closes[-2000:])
        with sqlite3.connect(path) as writer:
            writer.execute('UPDATE candle_quality_versions SET status=? WHERE date=?', ('quarantined', dates[-2]))
            writer.execute('DELETE FROM candles WHERE date=?', (dates[-2],))
        result = scanner.scan(Settings(lab_path=str(path)), 'ALL', dates[-1])
        assert result['excluded'] == {'quarantined_ohlc': 1}
    finally: scanner.close()


@pytest.mark.asyncio
async def test_threshold_uses_unrounded_rsi_before_display_rounding():
    class PublicFixture:
        calls = 0
        def scan(self, *args):
            self.calls += 1
            return {'items': [{'code': '000001', 'name': 'Below', 'market': 'KOSPI', 'rsi': 29.99996, 'bars': 20},
                              {'code': '000002', 'name': 'Above', 'market': 'KOSPI', 'rsi': 30.00004, 'bars': 20}],
                    'universe': 2, 'scanned': 2, 'valid': 2, 'excluded': {},
                    'data_read_at': NOW.isoformat(), 'data_version': 'fixture', 'cache_hit': True}
    fixture = PublicFixture()
    tools = ResearchTools(Settings(), now=NOW, screener=fixture)
    result = await tools.screen_rsi(Screen(threshold=30.0, market='ALL', page=1, page_size=20))
    assert [r['code'] for r in result['items']] == ['000001']
    assert result['items'][0]['rsi'] == 30.0 and result['coverage']['cache_hit']
    await tools.screen_rsi(Screen(threshold=100.0, market='ALL', page=2, page_size=1))
    assert fixture.calls == 1  # One analysis's pages use the same coverage and ranking.


@pytest.mark.asyncio
async def test_unverified_snapshot_is_a_structured_tool_error():
    import json
    from ai_agent.snapshot_fingerprint import FingerprintUnavailable
    class Unverified:
        def scan(self, *args): raise FingerprintUnavailable('private diagnostics must not be returned')
    tools = ResearchTools(Settings(), now=NOW, screener=Unverified())
    result = await tools.execute('screen_rsi', json.dumps({'threshold': 30, 'market': 'ALL', 'page': 1, 'page_size': 20}))
    assert result['status'] == 'error' and result['code'] == 'screen_snapshot_unverified'
    assert result['retryable'] and 'private diagnostics' not in json.dumps(result)
