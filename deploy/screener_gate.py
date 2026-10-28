"""Read-only operational gate. No provider, keys, SQL migration or DB writes.

Run from the target worktree: python -m deploy.screener_gate --db /var/lib/atlas/lab.sqlite
"""
import argparse
from datetime import datetime
import json
from pathlib import Path
import platform
import sqlite3
import time
from ai_agent.config import Settings
from ai_agent.market import KST, market_context
from ai_agent.screen_engine import ScreenEngine
from ai_agent.screen_models import StockScreen
from ai_agent.screener import RsiScreener
from ai_agent.snapshot_fingerprint import fingerprint, FORMAT


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
    reader = scanner._connect(Path(settings.lab_path))
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
            result = None
            for attempt in range(4):
                start = time.monotonic()
                result = engine.execute(settings, q, now)
                elapsed = time.monotonic()-start
                released = all(not e['reader'].in_transaction for s in engine.scanners.values() for e in s.entries.values())
                print(json.dumps(dict(case=label, phase='cold' if attempt == 0 else 'resume', seconds=round(elapsed, 4),
                                      snapshot_released=released, **result['coverage']), ensure_ascii=False), flush=True)
                assert released and elapsed <= 12, 'Snapshot retained or default tool time limit exceeded'
                q = q.model_copy(update={'snapshot_id': result['snapshot_id']})
                if not result['coverage']['not_scanned']: break
            assert result['coverage']['not_scanned'] == 0, 'Four bounded calls did not complete the universe'
            assert result['coverage']['valid'] > 0, 'No usable current daily data: inspect cutoff/quality, do not bypass'
            start = time.monotonic(); cached = engine.execute(settings, q, now)
            print(json.dumps(dict(case=label, phase='cache', seconds=round(time.monotonic()-start, 4), **cached['coverage']), ensure_ascii=False), flush=True)
            assert cached['coverage']['cache_hit'] and cached['items'] == result['items']
        print('SCREENER_READONLY_GATE_PASS', flush=True)
    finally:
        reader.rollback(); reader.close(); scanner.close(); engine.close()


if __name__ == '__main__':
    main()
