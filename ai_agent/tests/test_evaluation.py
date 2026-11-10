import json
from dataclasses import replace
import pytest
from ai_agent.config import Settings
from ai_agent.evaluation.engine import evaluate, grade, make_data, NOW, state_for, transport_for, RecordedTools
from ai_agent.evaluation.catalog import cases
from ai_agent.tools import NewsSource
from ai_agent.screen_engine import ScreenEngine
from ai_agent.screener import RsiScreener
from .fixtures import ScriptedProvider, call, answer, final, OrchestratedFixture


@pytest.mark.asyncio
async def test_contract_is_labeled_not_real_model_quality():
    result=await evaluate({'mode':'code','specimen':cases()[0]},Settings())
    assert result['grade']=='review'
    assert result['usage']['budget_usd']==0
    assert any(c['status']=='na' for c in result['checks'])


@pytest.mark.asyncio
async def test_production_graph_chooses_confirmation_with_fixture_provider_and_does_not_save():
    args={'action':'create','symbol':'네이버','rule_id':None,'basis':'price','kind':'price_touch','threshold':200000,'expires_on':None,'frequency':None}
    p=ScriptedProvider([call('propose_alert',args)])
    result=await evaluate({'mode':'live','specimen':cases()[17]},Settings(),provider=OrchestratedFixture(p, 'alert'))
    assert result['alert_action']['kind']=='watchlist_confirmation'
    assert result['eval_state']['watchlist']==[]
    assert result['web_verification']=='not_run'
    assert len(p.inputs)==1
    assert 'success' not in p.inputs[0][0]['content']


@pytest.mark.asyncio
async def test_fixed_data_independent_atr_rsi_and_faults(tmp_path):
    path=tmp_path/'lab.sqlite';make_data(path)
    s=Settings(lab_path=str(path));engine=ScreenEngine();screener=RsiScreener()
    tools=RecordedTools(s,now=NOW,screen_engine=engine,screener=screener);tools.outputs=[]
    try:
        atr={'name':'atr','period':14,'adx_period':None,'k_smoothing':None,'d_smoothing':None,'average_type':None,'source':None,'atr_multiplier':None}
        rsi={'name':'rsi','period':14,'slow':1,'signal':1,'multiplier':1}
        r=await tools.execute('get_stock_indicators',json.dumps({'code':'005930','metrics':[atr,rsi]}))
        assert r['status']=='success',r
        assert [i['value'] for i in r['items']]==[10,0]
        assert r['as_of']=='2026-10-27'
    finally: engine.close();screener.close()
    for scenario,code in [('news_error','news_provider_error'),('news_empty',None)]:
        tools=RecordedTools(s,now=NOW,news=NewsSource(replace(s,naver_id='x',naver_secret='x'),transport_for(scenario)));tools.outputs=[]
        await tools.execute('resolve_symbol',json.dumps({'query':'삼성전자'}))
        r=await tools.execute('get_stock_news',json.dumps({'code':'005930','period':'today','page':1,'keyword':''}))
        assert r.get('code')==code
        assert not r['items']


def test_seeds_and_immutable_initial_states():
    rows=cases();assert len(rows)==30
    assert sum(c['spec']['split']=='holdout' for c in rows)==6
    state=state_for('watched');state['watchlist'].clear()
    assert len(state_for('watched')['watchlist'])==1
    assert len(state_for('full')['watchlist'])==20
    assert state_for('guest') is None


def test_grading_never_passes_unsupported_semantics_from_mock_output():
    checks,verdict=grade(cases()[0]['spec'],{'status':'completed','answer':{'content':'임의 답변'}},[],'live')
    assert verdict=='review'
    assert any(c['status']=='review' for c in checks)
