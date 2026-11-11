"""Read-only operational gate. No provider, keys, SQL migration or DB writes.

Run from the target worktree: python -m deploy.screener_gate --db /var/lib/atlas/lab.sqlite
"""
import argparse
from datetime import datetime
import json
from pathlib import Path
import platform
import os
import sqlite3
import time
from ai_agent.config import Settings
from ai_agent.market import KST, market_context
from ai_agent.screen_engine import ScreenEngine
from ai_agent.screen_models import StockScreen
from ai_agent.screener import RsiScreener
from ai_agent.snapshot_fingerprint import fingerprint, FORMAT

CASE_MAX_CALLS = 64
CASE_MAX_SECONDS = 180


def snapshots_released(engine):
    return all(not e['reader'].in_transaction for s in engine.scanners.values() for e in s.entries.values())


def run_case(engine, settings, query, now, label, *, clock=time.monotonic,
             emit=lambda record: print(json.dumps(record, ensure_ascii=False), flush=True),
             max_calls=CASE_MAX_CALLS, max_seconds=CASE_MAX_SECONDS):
    """Bounded deployment check, independent of the UI's four-call auto batch.

    Completion is still mandatory. Same snapshot, increasing progress, released
    transactions, per-call and overall deadlines are checked on every response.
    No throughput claim is inferred from a fixed universe or fixture machine.
    """
    started = clock()
    first = None
    previous = 0
    for attempt in range(max_calls):
        assert clock() - started + settings.tool_seconds <= max_seconds, 'gate_total_time_limit'
        call_start = clock()
        result = engine.execute(settings, query, now)
        elapsed = clock() - call_start
        coverage = result['coverage']
        released = snapshots_released(engine)
        emit(dict(case=label, phase='cold' if attempt == 0 else 'resume', call=attempt+1,
                  seconds=round(elapsed,4), total_seconds=round(clock()-started,4),
                  snapshot_released=released, **coverage))
        assert released and elapsed <= settings.tool_seconds, 'gate_call_time_or_snapshot_limit'
        assert clock()-started <= max_seconds, 'gate_total_time_limit'
        identity = (result['snapshot_id'], coverage['data_version'], coverage['data_read_at'])
        if first is None: first = identity
        assert identity == first, 'gate_snapshot_or_progress_expired'
        assert 0 <= coverage['scanned'] <= coverage['universe'], 'gate_invalid_coverage'
        assert coverage['not_scanned'] == coverage['universe']-coverage['scanned'], 'gate_invalid_coverage'
        assert coverage['valid'] + sum(coverage['excluded'].values()) == coverage['scanned'], 'gate_invalid_coverage'
        query = query.model_copy(update={'snapshot_id': result['snapshot_id']})
        if not coverage['not_scanned']:
            assert coverage['valid'] > 0, 'No usable current daily data: inspect cutoff/quality, do not bypass'
            break
        assert coverage['scanned'] > previous, 'gate_no_progress'
        assert not coverage['cache_hit'], 'gate_partial_cache_hit'
        previous = coverage['scanned']
    else:
        raise AssertionError('gate_call_limit_incomplete')
    assert clock()-started + settings.tool_seconds <= max_seconds, 'gate_total_time_limit'
    call_start = clock()
    cached = engine.execute(settings, query, now)
    released = snapshots_released(engine)
    emit(dict(case=label, phase='cache', seconds=round(clock()-call_start,4), snapshot_released=released, **cached['coverage']))
    assert released and clock()-call_start <= settings.tool_seconds, 'gate_call_time_or_snapshot_limit'
    assert clock()-started <= max_seconds, 'gate_total_time_limit'
    assert (cached['snapshot_id'],cached['coverage']['data_version'],cached['coverage']['data_read_at']) == first, 'gate_cache_snapshot_changed'
    assert cached['coverage']['cache_hit'] and not cached['coverage']['not_scanned'] and cached['items'] == result['items'], 'gate_cache_mismatch'
    return result


def metric(name, period=1, multiplier=1.0):
    return dict(name=name, period=period, slow=1, signal=1, multiplier=multiplier)


def condition(left, right, value=None):
    return dict(left=left, operator='lte', right=dict(kind='metric' if right else 'constant',
                value=None if right else value, metric=right, factor=1.0))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', required=True)
    args = parser.parse_args()
    settings = Settings(lab_path=str(Path(args.db).resolve()), tool_seconds=12)
    now = datetime.now(KST)
    context = market_context(now, settings.calendar_through)
    print(json.dumps(dict(module_path=__file__, python=platform.python_version(), sqlite=sqlite3.sqlite_version,
                          os=platform.platform(), as_of=now.isoformat(), cutoff=context['latest_completed'],
                          calendar_source=context['calendar_source']), ensure_ascii=False), flush=True)
    scanner, engine = RsiScreener(), ScreenEngine()
    path = Path(settings.lab_path)
    print(json.dumps(dict(sidecars={suffix: dict(exists=Path(str(path)+suffix).exists(),
                        readable=os.access(str(path)+suffix, os.R_OK)) for suffix in ('-wal', '-shm')})), flush=True)
    reader = None
    try:
        reader = scanner._connect(path)
        reader.execute('SELECT rootpage FROM sqlite_master LIMIT 1').fetchone()
    except sqlite3.OperationalError:
        if reader is not None: reader.close()
        print('SCREENER_READER_INFRASTRUCTURE_UNAVAILABLE: prepare owner-side WAL guard; do not grant reader write access', flush=True)
        raise SystemExit(1) from None
    try:
        before = fingerprint(Path(settings.lab_path))
        versions = [reader.execute('PRAGMA data_version').fetchone()[0]]
        reader.execute('BEGIN'); reader.execute('SELECT rootpage FROM sqlite_master LIMIT 1').fetchone()
        versions.append(reader.execute('PRAGMA data_version').fetchone()[0])
        inside = fingerprint(Path(settings.lab_path)); reader.rollback()
        versions.append(reader.execute('PRAGMA data_version').fetchone()[0])
        after = fingerprint(Path(settings.lab_path))
        print(json.dumps(dict(format=FORMAT, diagnostic_data_version=versions,
                              readonly_fingerprint_stable=before == inside == after)), flush=True)
        assert before == inside == after, 'Read-only fingerprint changed: inspect collector/writer or runtime before deployment'
        groups = {
            'rsi14': [condition(metric('rsi', 14), None, 30.0)],
            'bb20_2_low_touch': [condition(metric('low'), metric('bb_lower', 20, 2.0))],
            'rsi_and_sma20': [condition(metric('rsi', 14), None, 30.0), condition(metric('close'), metric('sma', 20))],
        }
        for label, conditions in groups.items():
            q = StockScreen(market='ALL', match='all', conditions=conditions, sort='code_asc', page=1, page_size=20, snapshot_id=None)
            run_case(engine, settings, q, now, label)
        print('SCREENER_READONLY_GATE_PASS', flush=True)
    finally:
        reader.rollback(); reader.close(); scanner.close(); engine.close()


if __name__ == '__main__':
    main()
