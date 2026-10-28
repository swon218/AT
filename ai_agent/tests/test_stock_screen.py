from dataclasses import replace
import json
from pathlib import Path
import sqlite3
import subprocess
import httpx
import pytest
from pydantic import ValidationError
from ai_agent.app import create_app
from ai_agent.config import Settings
from ai_agent.indicators import series, compare, latest_pair
from ai_agent.screen_models import StockScreen, Metric
from ai_agent.screen_engine import ScreenEngine, ScreenSnapshotChanged
from ai_agent.schemas import tools_schema
from ai_agent.tools import ResearchTools
from ai_agent.runner import Runner, materialize
from ai_agent.schemas import Final
from .fixtures import NOW, make_lab, call, answer, final


def metric(name='rsi', **kw):
    return {'name': name, 'period': 1 if name in ('close', 'low', 'volume') else 14 if name == 'rsi' else 12 if name.startswith('macd') else 20,
            'slow': 26 if name.startswith('macd') else 1, 'signal': 9 if name.startswith('macd') else 1,
            'multiplier': 2.0 if name.startswith('bb_') else 1.0, **kw}


def cond(name='rsi', op='lte', value=30, other=None, factor=1):
    return {'left': metric(name), 'operator': op, 'right': {'kind': 'metric' if other else 'constant', 'value': None if other else value,
            'metric': metric(other) if other else None, 'factor': float(factor)}}


def query(*conditions, **kw):
    return StockScreen.model_validate({'market': 'ALL', 'match': 'all', 'conditions': list(conditions) or [cond()],
                                      'sort': 'code_asc', 'page': 1, 'page_size': 20, 'snapshot_id': None, **kw})


@pytest.fixture
def engine():
    value = ScreenEngine()
    yield value
    value.close()


@pytest.fixture
def settings(tmp_path):
    return Settings(lab_path=make_lab(tmp_path / 'screen.sqlite'), internal_secret='test-only-' * 5)


def test_shared_schema_and_recursive_strict_function_contract():
    contract = json.loads((Path(__file__).parents[2] / 'shared/screener-schema.json').read_text(encoding='utf-8'))
    assert contract == StockScreen.model_json_schema()
    tool = next(t for t in tools_schema() if t['name'] == 'screen_stocks')
    assert tool['strict']
    def walk(value):
        if isinstance(value, dict):
            if value.get('type') == 'object':
                assert value.get('additionalProperties') is False
                assert set(value['required']) == set(value['properties'])
            for child in value.values(): walk(child)
        elif isinstance(value, list):
            for child in value: walk(child)
    walk(tool['parameters'])
    for patch in ({'conditions': []}, {'conditions': [cond()] * 9}, {'market': 'US'}, {'page_size': 21}, {'sql': 'select 1'}, {'snapshot_id': 'anything'}):
        with pytest.raises(ValidationError): query(**patch)
    for bad in (metric('rsi', period=0), metric('rsi', multiplier=2.0), metric('macd', period=30), metric('close', period=2)):
        with pytest.raises(ValidationError): Metric.model_validate(bad)
    bad = cond(value=float('nan'))
    with pytest.raises(ValidationError): query(bad)


def test_all_numeric_series_match_existing_lab_chart():
    # Independent JS chart implementation is the reference, using oscillating
    # prices, fractional closes, varying volume and a nonstandard band multiple.
    candles = [{'time': str(i), 'close': 120 + (i % 13 - 6) * 1.31 + i * .1, 'volume': 100 + (i % 7) * 17} for i in range(150)]
    script = """import {calculateSma,calculateEma,calculateRsi,calculateBollinger,calculateMacd} from './src/utils/indicators.js';
const c=JSON.parse(process.argv[1]);const b=calculateBollinger(c,20,2.5),m=calculateMacd(c,12,26,9);
console.log(JSON.stringify({sma:calculateSma(c,20),ema:calculateEma(c,20),rsi:calculateRsi(c,14),volume_sma:calculateSma(c,20,'volume'),bb_lower:b.lower,bb_middle:b.middle,bb_upper:b.upper,macd:m.macd,macd_signal:m.signal,macd_histogram:m.histogram}));"""
    expected = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script, json.dumps(candles)], cwd=Path(__file__).parents[2], text=True))
    for name, points in expected.items():
        m = Metric.model_validate(metric(name, **({'multiplier': 2.5} if name.startswith('bb_') else {})))
        actual = series(candles, m)
        assert [x for x in actual if x is not None] == pytest.approx([p['value'] for p in points], abs=1e-10)
        assert sum(x is None for x in actual) == len(candles) - len(points)
        assert latest_pair(candles, m) == pytest.approx((actual[-1], actual[-2]), abs=1e-10)
    flat = [{'close': 100.0} for _ in range(20)]
    assert series(flat, Metric.model_validate(metric()))[-1] == 50.0
    assert compare('crosses_above', 11, 10, 10, 10)
    assert not compare('crosses_above', 11, 10, 10.1, 10)
    assert compare('crosses_below', 9, 10, 10, 10)
    assert not compare('crosses_below', 10, 10, 11, 10)


def test_manual_conditions_combination_paging_precision_and_public_cache(settings, engine):
    first = engine.execute(settings, query(), NOW)
    assert [r['code'] for r in first['items']] == ['000660', '005930']
    assert first['coverage']['valid'] == 3 and first['coverage']['not_scanned'] == 0
    assert all(r['values']['rsi:14'] == 0 for r in first['items'])
    # A changed threshold reuses public calculated metrics, not another query's
    # matching-stock results. Names/codes/order and comparison precision survive.
    changed = engine.execute(settings, query(cond(value=100), page_size=1, snapshot_id=first['snapshot_id']), NOW)
    assert changed['coverage']['cache_hit'] and changed['coverage']['matches'] == 3
    page = engine.execute(settings, query(cond(value=100), page=2, page_size=1, snapshot_id=first['snapshot_id']), NOW)
    assert page['query_id'] == changed['query_id']
    assert page['items'][0]['code'] == '005930'
    assert engine.execute(settings, query(cond('close', 'gt', 300), cond(), match='all'), NOW)['items'] == []
    assert len(engine.execute(settings, query(cond('close', 'gt', 300), cond(), match='any'), NOW)['items']) == 3
    assert len(engine.execute(settings, query(cond('close', 'lt', other='sma')), NOW)['items']) == 2
    assert engine.execute(settings, query(cond('low', 'lte', other='bb_lower')), NOW)['coverage']['valid'] == 3
    assert not engine.execute(settings, query(cond('volume', 'gte', other='volume_sma', factor=2)), NOW)['items']
    assert not engine.execute(settings, query(cond('close', 'crosses_above', other='sma')), NOW)['items']
    assert engine.execute(settings, query(cond('close', 'gt', 0), market='KOSDAQ'), NOW)['coverage']['universe'] == 0
    item = engine.execute(settings, query(cond('sma', 'gt', 0)), NOW)['items'][0]
    value = item['values']['sma:20']
    assert not any(r['code'] == item['code'] for r in engine.execute(settings, query(cond('sma', 'gt', value + .000001)), NOW)['items'])
    assert any(r['code'] == item['code'] for r in engine.execute(settings, query(cond('sma', 'gt', value - .000001)), NOW)['items'])


def test_source_guards_and_snapshot_changes_are_retained(settings, engine):
    first = engine.execute(settings, query(), NOW)
    with sqlite3.connect(settings.lab_path) as db:
        db.execute("UPDATE candle_quality_versions SET status='quarantined' WHERE code='005930' AND date='2026-10-27'")
    with pytest.raises(ScreenSnapshotChanged): engine.execute(settings, query(snapshot_id=first['snapshot_id']), NOW)
    second = engine.execute(settings, query(), NOW)
    assert second['coverage']['excluded'] == {'quarantined_ohlc': 1}
    assert [r['code'] for r in second['items']] == ['000660']
    with sqlite3.connect(settings.lab_path) as db:
        db.execute("DELETE FROM candles WHERE code='000660' AND date='2026-10-20'")
    assert engine.execute(settings, query(), NOW)['coverage']['excluded']['missing_sessions'] == 1
    assert engine.execute(settings, query(), NOW.replace(day=29))['coverage']['valid'] == 0


def test_complex_screen_excerpts_fit_claims_and_saved_answers_are_bounded(settings, engine):
    conditions = [cond('macd_signal', 'lte', 100000 + i) for i in range(8)]
    result = engine.execute(settings, query(*conditions), NOW)
    assert result['items']
    assert all(len(r['excerpt']) <= 300 for r in result['items'])
    assert all(len(r['checks']) == 8 for r in result['items'])
    tools = ResearchTools(settings, now=NOW, screen_engine=engine)
    tools.result_sets = [{'id': str(i), 'query': result['query'], 'coverage': result['coverage'], 'items': [{'name': '가' * 2000}] * 20} for i in range(3)]
    saved = materialize(Final.model_validate(final()), tools, NOW)
    assert len(json.dumps(saved, ensure_ascii=False).encode()) < 100000
    assert saved['result_sets'][0]['query'] == result['query']
    assert '크기 제한' in saved['content']


def test_deployment_readonly_gate_completes_on_real_fixture(settings, monkeypatch, capsys):
    import sys
    from deploy import screener_gate
    class FixedClock:
        @classmethod
        def now(cls, tz): return NOW
    monkeypatch.setattr(screener_gate, 'datetime', FixedClock)
    monkeypatch.setattr(sys, 'argv', ['gate', '--db', settings.lab_path])
    screener_gate.main()
    output = capsys.readouterr().out
    assert 'SCREENER_READONLY_GATE_PASS' in output
    assert 'bb20_2_low_touch' in output and '"phase": "cache"' in output


def test_bounded_helper_shutdown_closes_pipes_when_windows_termination_is_delayed():
    from io import BytesIO
    from ai_agent.snapshot_fingerprint import FingerprintReader
    class DelayedProcess:
        stdin, stdout = BytesIO(), BytesIO()
        killed = False
        def poll(self): return None
        def kill(self): self.killed = True
        def wait(self, timeout): raise subprocess.TimeoutExpired('fixture-helper', timeout)
    reader, process = FingerprintReader(), DelayedProcess()
    reader.process = process
    reader.close()
    assert process.killed and process.stdin.closed and process.stdout.closed
    assert reader.process is None


@pytest.mark.asyncio
async def test_internal_api_needs_no_model_key_and_matches_ai_engine(settings, engine):
    assert not settings.api_key
    app = create_app(settings, screen_engine=engine, clock=lambda: NOW)
    tools = ResearchTools(settings, now=NOW, screen_engine=engine)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture') as client:
        assert (await client.post('/screen', json=query().model_dump())).status_code == 401
        headers = {'X-Atlas-Internal': settings.internal_secret}
        meta = await client.get('/screen/meta', headers=headers)
        assert meta.status_code == 200 and meta.json()['quality_ready']
        assert meta.json()['universe'] == 3 and meta.json()['cutoff'] == '2026-10-27'
        bad = query().model_dump(); bad['user_id'] = 'other'
        assert (await client.post('/screen', headers=headers, json=bad)).status_code == 422
        manual = await client.post('/screen', headers=headers, json=query().model_dump())
        assert manual.status_code == 200
        ai = await tools.execute('screen_stocks', query().model_dump_json())
        assert manual.json()['items'] == ai['items'] and manual.json()['query_id'] == ai['query_id']
        # Tool paging keeps one analysis snapshot after a collector commit;
        # manual resume explicitly rejects that old snapshot instead of mixing.
        with sqlite3.connect(settings.lab_path) as db: db.execute("UPDATE symbols SET name='갱신 이름' WHERE code='005930'")
        old = query(snapshot_id=ai['snapshot_id'])
        again = await tools.screen_stocks(old)
        assert again['items'] == ai['items']
        rejected = await client.post('/screen', headers=headers, json=old.model_dump())
        assert rejected.status_code == 409 and rejected.json()['detail'] == 'snapshot_changed'


@pytest.mark.asyncio
async def test_adaptive_model_uses_actual_shared_engine_evidence(settings, engine):
    class Model:
        async def respond(self, items, *args):
            outputs = [json.loads(x['output']) for x in items if x.get('type') == 'function_call_output']
            if not outputs: return call('screen_stocks', query(cond('close', 'lt', other='sma')).model_dump())
            result = outputs[-1]
            assert result['coverage']['matches'] == 2
            return answer(final('research', '공통 일봉에서 조건을 충족하는 종목을 확인했습니다.',
                [{'text': r['excerpt'], 'excerpt': r['excerpt'], 'evidence_id': r['id'], 'stance': 'neutral', 'relation': 'direct'} for r in result['items']]))
    result = await Runner(settings, Model(), ResearchTools(settings, now=NOW, screen_engine=engine)).run('20일선 아래 종목 찾아줘', [])
    assert result['status'] == 'completed', result
    assert result['answer']['result_sets'][0]['query']['conditions'][0]['right']['metric']['name'] == 'sma'
    assert len(result['answer']['sources']) == 2
    assert '조건검색 범위' in result['answer']['content']
    assert '뉴스 흐름' not in result['answer']['content']
