import json
from pathlib import Path
import sqlite3
import subprocess

import pytest

from ai_agent.config import Settings
from ai_agent.indicators import key, series
from .fixtures import fixture_graph
from ai_agent.screen_models import AdvancedMetric, IndicatorLookup, StockScreen
from ai_agent.screen_engine import ScreenEngine
from ai_agent.tools import ResearchTools
from .fixtures import NOW, ScriptedProvider, answer, call, final, make_lab


ROOT = Path(__file__).parents[2]
FIXTURE = json.loads((ROOT / 'tests/advancedIndicators.fixture.json').read_text(encoding='utf-8'))


def metric(name, **settings):
    return dict(name=name, **{**dict(period=None, adx_period=None, k_smoothing=None, d_smoothing=None,
                                    average_type=None, source=None, atr_multiplier=None), **settings})


def from_chart(name, cfg):
    params = {k: cfg[k] for k in ('period', 'source') if k in cfg}
    if name == 'adx': params['adx_period'] = cfg['adxPeriod']
    if name.startswith('stoch_'): params['k_smoothing'] = cfg['kPeriod']
    if name == 'stoch_d': params['d_smoothing'] = cfg['dPeriod']
    if name == 'obv_ma': params.update(period=cfg['maPeriod'], average_type=cfg['maType'])
    if name.startswith('supertrend'): params['atr_multiplier'] = cfg['multiplier']
    return AdvancedMetric.model_validate(metric(name, **params))


def assert_series(actual, expected):
    assert [x is None for x in actual] == [x is None for x in expected]
    assert [x for x in actual if x is not None] == pytest.approx([x for x in expected if x is not None], abs=1e-9)


def test_hand_checked_and_cross_runtime_parity():
    bars, cases = FIXTURE['bars'], FIXTURE['cases']
    inputs = [bars, [dict(bar, volume=None) if i == 2 else dict(bar, quality='quarantined') if i == 4 else bar
                     for i, bar in enumerate(bars)], [dict(bar, high=10, low=10, close=10, volume=0) for bar in bars]]
    script = """import {advancedSeries} from './src/utils/advancedIndicators.js';
const [inputs, cases] = JSON.parse(process.argv[1]);
console.log(JSON.stringify(inputs.map(bars => cases.map(({config}) => advancedSeries(bars,config)))));"""
    js = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script, json.dumps([inputs, cases])], cwd=ROOT))
    for i, candles in enumerate(inputs):
        for j, case in enumerate(cases):
            for name in js[i][j]:
                calculated = series(candles, from_chart(name, case['config']))
                assert_series(calculated, js[i][j][name])
                if i == 0 and name in case['expected']:
                    expected = case['expected'][name]
                    assert_series(calculated[:len(expected)], expected)


def test_independent_talib_reference():
    talib = pytest.importorskip('talib')
    import numpy as np
    # A deterministic, non-flat series separate from the hand-computed fixture.
    x = np.arange(100, dtype=float)
    close = 100 + x / 7 + 4 * np.sin(x / 2)
    high, low, volume = close + 2 + x % 3, close - 1 - x % 5, 30 + (x % 11) * 5
    bars = [dict(high=h, low=l, close=c, volume=v) for h, l, c, v in zip(high, low, close, volume)]
    # A preceding close equal to close[0] makes TA-Lib's first eligible TR = high[0]-low[0].
    atr = talib.ATR(np.r_[close[0], high], np.r_[close[0], low], np.r_[close[0], close], 14)[1:]
    k, d = talib.STOCH(high, low, close, 14, 3, 0, 3, 0)
    references = {'atr': atr, 'stoch_k': k, 'stoch_d': d, 'obv': talib.OBV(close, volume) - volume[0],
                  'mfi': talib.MFI(high, low, close, volume, 14), 'cci': talib.CCI(high, low, close, 20)}
    for name, values in references.items():
        actual = series(bars, AdvancedMetric.model_validate(metric(name)))
        valid = np.isfinite(values)
        assert np.array(actual, dtype=float)[valid] == pytest.approx(values[valid], abs=1e-9)


@pytest.fixture
def data(tmp_path):
    settings = Settings(lab_path=make_lab(tmp_path / 'indicators.sqlite'))
    engine = ScreenEngine()
    yield settings, engine
    engine.close()


def test_single_lookup_queries_only_target_and_distinguishes_unavailable(data):
    settings, engine = data
    with sqlite3.connect(settings.lab_path) as db:
        db.execute("DELETE FROM candles WHERE code='035420' AND date='2026-10-27'")
    query = IndicatorLookup(code='005930', metrics=[metric('adx'), metric('atr_percent'), metric('mfi', period=500)])
    result = engine.lookup(settings, query, NOW)
    assert result['status'] == 'partial'
    assert result['as_of'] == '2026-10-27'
    assert [x['code'] for x in result['items']] == ['005930', '005930']
    assert result['coverage']['excluded'] == {}
    assert result['coverage']['unavailable'][0]['code'] == 'insufficient_warmup'
    assert result['coverage']['seed_date'] < result['as_of']
    assert result['items'][0]['value'] == pytest.approx(100)
    assert result['items'][1]['unit'] == '%'
    assert engine.lookup(settings, query.model_copy(update={'code': '035420'}), NOW)['coverage']['excluded'] == {'stale_data': 1}
    assert engine.lookup(settings, query.model_copy(update={'code': '999999'}), NOW)['coverage']['excluded'] == {'symbol_not_found': 1}


def test_advanced_multi_metric_screen_checks_full_precision_and_legacy_compatibility(data):
    settings, engine = data
    conditions = [
        {'left': metric('adx'), 'operator': 'gte', 'right': {'kind': 'constant', 'value': 25, 'metric': None, 'factor': 1}},
        {'left': metric('plus_di'), 'operator': 'gt', 'right': {'kind': 'metric', 'value': None, 'metric': metric('minus_di'), 'factor': 1}},
        {'left': metric('atr_percent'), 'operator': 'gt', 'right': {'kind': 'constant', 'value': 0, 'metric': None, 'factor': 1}},
    ]
    query = StockScreen.model_validate(dict(market='ALL', match='all', conditions=conditions, page=1, page_size=20,
                                            sort='code_asc', snapshot_id=None))
    result = engine.execute(settings, query, NOW)
    assert result['coverage']['valid'] == 3 and [r['code'] for r in result['items']] == ['035420']
    item = result['items'][0]
    assert all(check['matched'] for check in item['checks'])
    value = item['values'][key(query.conditions[-1].left)]
    conditions[-1]['right']['value'] = value + 1e-9
    next_query = StockScreen.model_validate({**query.model_dump(), 'conditions': conditions})
    assert not engine.execute(settings, next_query, NOW)['items']


@pytest.mark.asyncio
async def test_agent_cites_real_calculation_and_explanation_without_tools(data):
    settings, engine = data
    query = {'code': '005930', 'metrics': [metric('atr')]}
    tools = ResearchTools(settings, now=NOW, screen_engine=engine)
    value = (await tools.execute('get_stock_indicators', json.dumps(query)))['items'][0]
    claim = {'text': value['excerpt'], 'evidence_id': value['id'], 'excerpt': value['excerpt'], 'stance': 'neutral', 'relation': 'direct'}
    result = await fixture_graph(settings, ScriptedProvider([call('resolve_symbol', {'query': '삼성전자'}),
        call('get_stock_indicators', query), answer(final('research', '확정 일봉 지표를 확인했습니다.', [claim]))]),
        ResearchTools(settings, now=NOW, screen_engine=engine)).run('삼성전자 ATR 알려줘', [])
    assert result['status'] == 'completed'
    assert value['excerpt'] in result['answer']['content']
    assert result['answer']['result_sets'][0]['items'][0]['value'] == value['value']
    concept = await fixture_graph(settings, ScriptedProvider([answer(final('concept', 'ADX는 추세 강도를 측정합니다.'))]),
        ResearchTools(settings, now=NOW, screen_engine=engine)).run('ADX가 뭐야?', [])
    assert concept['status'] == 'completed' and not any(s['kind'] == 'tool' for s in concept['steps'])
    rejected = await tools.execute('get_stock_indicators', json.dumps({'code': '005930', 'metrics': [metric('vwap')]}))
    assert rejected['code'] == 'invalid_arguments'
