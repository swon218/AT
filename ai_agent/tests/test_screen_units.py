"""Unit contracts and arithmetic evidence; no model/provider/production writes."""
import json
from decimal import Decimal
import subprocess
from pathlib import Path
import httpx
import pytest
from pydantic import ValidationError
from ai_agent.app import create_app
from ai_agent.indicators import compare, series, label
from ai_agent.screen_models import Condition, Metric, AdvancedMetric
from ai_agent.screen_semantics import CATALOG, metric_spec, validation_code
from ai_agent.tools import ResearchTools
from .fixtures import NOW, call, answer, final, fixture_graph
from .test_stock_screen import settings, engine, query, cond, metric


def models_from_ui():
    script = "import {metricNames,metric} from './src/utils/screener.js';console.log(JSON.stringify(Object.keys(metricNames).map(metric)))"
    return json.loads(subprocess.check_output(['node','--input-type=module','-e',script],cwd=Path(__file__).parents[2],text=True))


def test_all_metric_families_js_python_validation_and_labels_agree():
    metrics = models_from_ui()
    assert len(metrics) == len(CATALOG['metrics']) == 29
    for left in metrics:
        model = (Metric if 'slow' in left else AdvancedMetric).model_validate(left)
        assert metric_spec(model.name)['unit']
        for right in metrics:
            c = {'left':left,'operator':'gte','right':{'kind':'metric','metric':right,'value':None,'factor':1.0}}
            expected = CATALOG['metrics'][left['name']]['group'] == CATALOG['metrics'][right['name']]['group'] and 'states' not in metric_spec(left['name'])
            try:
                Condition.model_validate(c)
                assert expected, (left['name'],right['name'])
            except ValidationError as exc:
                assert not expected
                assert validation_code(exc.errors()) in ('screen_unit_mismatch','screen_state_comparison')
    script = "import {metricLabel} from './src/utils/screener.js';console.log(JSON.stringify(JSON.parse(process.argv[1]).map(metricLabel)))"
    labels = json.loads(subprocess.check_output(['node','--input-type=module','-e',script,json.dumps(metrics)],cwd=Path(__file__).parents[2],text=True,encoding='utf-8'))
    assert labels == [label((Metric if 'slow' in m else AdvancedMetric).model_validate(m)) for m in metrics]


@pytest.mark.parametrize('factor',[1.0,1.1,1.2,.9,2.0])
def test_volume_ratio_uses_current_completed_bar_and_original_cross_boundaries(factor):
    candles = [{'volume':100.0} for _ in range(20)] + [{'volume':120.0}]
    average = series(candles,Metric.model_validate(metric('volume_sma')))
    assert average[-2:] == [100.0,101.0]  # current 120 included, not previous 20 only
    threshold,previous_threshold = average[-1]*factor,average[-2]*factor
    assert compare('gte',120,threshold,100,previous_threshold) == (120 >= 101*factor)
    assert compare('crosses_above',120,threshold,100,previous_threshold) == (120 > 101*factor and 100 <= 100*factor)
    assert compare('crosses_below',99,100,100,100)
    assert not compare('crosses_below',100,100,101,100)
    assert compare('crosses_above',101,100,100,100)
    assert not compare('crosses_above',100,100,99,100)


def test_ranges_signed_values_states_and_calculation_multipliers():
    metrics = {m['name']:m for m in models_from_ui()}
    for name in ['rsi','mfi','adx','plus_di','minus_di','stoch_k','stoch_d']:
        for value in [-1,0,100,101]:
            c={'left':metrics[name],'operator':'gte','right':{'kind':'constant','value':value,'metric':None,'factor':1.0}}
            if 0 <= value <= 100: Condition.model_validate(c)
            else:
                with pytest.raises(ValidationError) as exc: Condition.model_validate(c)
                assert validation_code(exc.value.errors()) == 'screen_threshold_range'
    for name in ['macd','cci','obv']:
        for value in [-100,0,100]:
            Condition.model_validate({'left':metrics[name],'operator':'gte','right':{'kind':'constant','value':value,'metric':None,'factor':1.0}})
    for name in ['supertrend_direction','supertrend_flip']:
        for value in [-1,0,1,2]:
            c={'left':metrics[name],'operator':'eq','right':{'kind':'constant','value':value,'metric':None,'factor':1.0}}
            if str(value) in metric_spec(name)['states']:
                parsed=Condition.model_validate(c)
                assert compare(parsed.operator,value,value,None,None)
            else:
                with pytest.raises(ValidationError): Condition.model_validate(c)
    assert metrics['bb_lower']['multiplier']==2 and metrics['supertrend']['atr_multiplier']==3
    candles=[{'time':str(i),'open':100+i,'high':105+i,'low':95+i,'close':100+i,'volume':100} for i in range(40)]
    atr=series(candles,AdvancedMetric.model_validate(metrics['atr']))
    atr_percent=series(candles,AdvancedMetric.model_validate(metrics['atr_percent']))
    assert atr_percent[-1] == pytest.approx(atr[-1]/candles[-1]['close']*100)
    direction=series(candles,AdvancedMetric.model_validate(metrics['supertrend_direction']))
    flip=series(candles,AdvancedMetric.model_validate(metrics['supertrend_flip']))
    first=next(i for i,v in enumerate(direction) if v is not None)
    assert flip[first]==0
    for i in range(first+1,len(direction)):
        assert flip[i] == (direction[i] if direction[i] != direction[i-1] else 0)


def test_result_exposes_unrounded_base_factor_and_both_cross_thresholds(settings,engine):
    for factor in [1.0,1.1,1.2,.9,2.0]:
        result=engine.execute(settings,query(cond('volume','gte',other='volume_sma',factor=factor),cond('close','gte',0),match='any'),NOW)
        assert len(result['items'])==3
        for item in result['items']:
            check=item['checks'][0]
            assert check['right_base']==item['values']['volume_sma:20']
            assert check['right']==check['right_base']*factor
            assert check['previous_right']==check['previous_right_base']*factor
            assert check['ratio_percent']==float(Decimal(str(factor))*100)
            assert check['matched']==(check['left']>=check['right'])
            assert check['unit']=='주'
    signed=engine.execute(settings,query(cond('macd','gte',other='macd_signal',factor=1.2),cond('close','gte',0),match='any'),NOW)
    assert all(i['checks'][0]['ratio_percent'] is None for i in signed['items'])
    assert signed['query']['conditions'][0]['right']['factor']==1.2


@pytest.mark.asyncio
async def test_api_and_ai_share_safe_semantic_errors_and_actual_graph_can_recover(settings,engine):
    bad=cond('volume','gte',other='sma',factor=1.2)
    body=query().model_dump();body['conditions']=[bad]
    app=create_app(settings,screen_engine=engine,clock=lambda:NOW)
    tools=ResearchTools(settings,now=NOW,screen_engine=engine)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as client:
        response=await client.post('/screen',headers={'X-Atlas-Internal':settings.internal_secret},json=body)
        assert response.status_code==422 and response.json()=={'detail':'screen_unit_mismatch'}
        assert (await tools.execute('screen_stocks',json.dumps(body)))['code']=='screen_unit_mismatch'
    good=query(cond('volume','gte',other='volume_sma',factor=.2)).model_dump()
    class Model:
        async def respond(self,items,*args):
            outputs=[json.loads(i['output']) for i in items if i.get('type')=='function_call_output']
            if not outputs:return call('screen_stocks',body)
            if outputs[-1].get('code')=='screen_unit_mismatch':return call('screen_stocks',good)
            assert outputs[-1]['items']
            return answer(final('research','확정 일봉의 같은 거래량 단위로 조건을 확인했습니다.',[{'text':r['excerpt'],'excerpt':r['excerpt'],'evidence_id':r['id'],'stance':'neutral','relation':'direct'} for r in outputs[-1]['items']]))
    result=await fixture_graph(settings,Model(),tools).run('평균 거래량의 20% 이상인 종목을 찾아줘',[])
    # Existing graph marks recovered tool errors as partial rather than hiding them.
    assert result['status']=='partial',result
    assert result['answer']['result_sets'][0]['query']['conditions'][0]['right']['factor']==.2
