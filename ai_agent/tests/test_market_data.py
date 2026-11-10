import asyncio
from dataclasses import replace
import json
import pytest
import httpx
from ai_agent.config import Settings
from ai_agent.data_source import DataError, NodeResearchData
from ai_agent.evaluation.data_fixtures import FixedResearchData
from ai_agent.evaluation.engine import evaluate
from ai_agent.evaluation.catalog import all_cases
from ai_agent.graph import ResearchGraph
from ai_agent.market_tools import session_context
from ai_agent.tools import Budget, ResearchTools
from .fixtures import NOW, answer, call, delegation, final, make_lab, news_transport
from .test_graph import RoleProvider, news_script, specialist_final, synthesize, technical_script
from ai_agent.tools import NewsSource


@pytest.fixture
def tools(tmp_path):
    s=Settings(lab_path=make_lab(tmp_path/'lab.sqlite'))
    return ResearchTools(s,now=NOW,data=FixedResearchData('market_quote',NOW),
                         news=NewsSource(replace(s,naver_id='fixture',naver_secret='fixture'),news_transport()))


@pytest.mark.asyncio
async def test_actual_graph_market_delegation_quote_and_unknown_time_are_preserved(tools):
    provider=RoleProvider(orchestrator=[delegation('market'),synthesize],market=[
        call('resolve_market_symbol',{'query':'삼성전자'}),call('get_market_quote',{'code':'005930','market':'KRX'}),specialist_final])
    result=await ResearchGraph(tools.settings,provider,tools).run('삼성전자 지금 얼마야?',[])
    assert result['status']=='completed',result
    source=result['answer']['sources'][0]
    assert source['id'].startswith('q_') and source['provider_at'] is None
    assert '실시간·지연 여부 확인 불가' in result['answer']['content']
    assert result['usage']['model_calls']==5 and result['usage']['external_requests']==2
    assert set(provider.calls[1]['tools'])=={'resolve_market_symbol','get_market_quote','get_intraday_bars'}


@pytest.mark.asyncio
@pytest.mark.parametrize('peer',['news','technical'])
async def test_market_combined_research_retains_distinct_sources_and_daily_scope(tools,peer):
    plan=delegation('market')
    first=json.loads(plan.output[0]['arguments'])['tasks'][0]
    second=json.loads(delegation(peer).output[0]['arguments'])['tasks'][0]
    plan.output[0]['arguments']=json.dumps({'tasks':[first,second]})
    provider=RoleProvider(orchestrator=[plan,synthesize],market=[call('get_market_quote',{'code':'005930','market':'KRX'}),specialist_final],
                          **{peer:news_script() if peer=='news' else technical_script()})
    result=await ResearchGraph(tools.settings,provider,tools).run('삼성전자 최신 시세와 '+('뉴스' if peer=='news' else '확정 일봉 RSI'),[])
    assert result['status']=='completed',result
    assert {source['id'][:2] for source in result['answer']['sources']}=={'q_','n_' if peer=='news' else 'r_'}
    assert result['usage']['model_calls']<=tools.settings.rounds


@pytest.mark.asyncio
async def test_market_identification_code_preferred_share_and_failure_do_not_fake_zero(tools):
    for query,code in [('삼성전자','005930'),('삼성전자우','005935'),('035420','035420'),('네이버','035420')]:
        result=await tools.execute('resolve_market_symbol',json.dumps({'query':query}))
        assert result['items'][0]['code']==code
    choices=await tools.execute('resolve_market_symbol',json.dumps({'query':'삼성'}))
    assert choices['ambiguous'] and len(choices['items'])==2
    invalid=await tools.execute('get_market_quote',json.dumps({'code':'bad','market':'KRX'}))
    assert invalid['code']=='invalid_arguments'
    unsupported=await tools.execute('get_market_quote',json.dumps({'code':'005930','market':'NXT'}))
    assert unsupported['code']=='unsupported_market'
    assert not any(source.get('price')==0 for source in tools.evidence.values())


@pytest.mark.asyncio
async def test_bars_partial_scope_unknown_completion_and_deterministic_summary(tools):
    args={'code':'005930','market':'KRX','kind':'minute','interval':1,'start_date':'2026-10-27','end_date':'2026-10-27','limit':30}
    value=await tools.execute('get_intraday_bars',json.dumps(args))
    assert value['status']=='partial' and value['summary']['bars']==5
    assert value['summary']['volume']==500 and value['summary']['high']==1014
    assert value['items'][0]['scope']=='intraday' and value['bars'][-1]['completed']=='unknown'
    assert value['coverage']['provider_at']!=value['coverage']['queried_at']
    assert value['coverage']['more_available'] is True


@pytest.mark.parametrize('at,state',[('2026-10-28T10:00:00+09:00','regular'),('2026-10-28T16:00:00+09:00','after_regular'),('2026-10-31T10:00:00+09:00','holiday')])
def test_regular_closed_and_holiday_are_calendar_context_not_live_price_evidence(tools,at,state):
    from datetime import datetime
    tools.now=datetime.fromisoformat(at)
    value=session_context(tools,'2026-10-20T15:00:00+09:00')
    assert value['current_session']==state and value['data_stale'] is True


@pytest.mark.asyncio
async def test_node_boundary_is_fixed_authenticated_bounded_and_accounts_shared_reservations():
    settings=Settings(internal_secret='fixture-only',external_requests=3)
    budget=Budget(settings)
    def respond(request):
        assert str(request.url)=='http://127.0.0.1:3000/api/internal/agent/data'
        assert request.headers['X-Atlas-Internal']=='fixture-only'
        body=json.loads(request.content)
        assert body['request_id']=='server-owned-id' and body['max_calls']==2
        assert budget.external==2
        budget.spend_external()
        return httpx.Response(200,json={'status':'success','items':[],'external_requests':0})
    source=NodeResearchData(settings,'server-owned-id',httpx.MockTransport(respond))
    await source.read('resolve_market_symbol',{'query':'삼성전자'},budget,2)
    assert budget.external==1
    with pytest.raises(ValueError):
        NodeResearchData(replace(settings,callback_url='https://outside.invalid/api/internal/agent/events'),'id')
    source=NodeResearchData(settings,'id',httpx.MockTransport(lambda _:httpx.Response(401)))
    with pytest.raises(DataError,match='internal_data_auth_error'):
        await source.read('get_market_quote',{},budget)


@pytest.mark.asyncio
async def test_new_admin_cases_use_same_graph_with_fixed_data_and_old_cases_are_preserved():
    cases=all_cases()
    assert len(cases)==36 and len({row['id'] for row in cases})==36
    for specimen in cases[-6:-3]:
        result=await evaluate({'mode':'code','specimen':specimen},Settings())
        assert result['grade']=='review',result
        assert result['usage']['paid_model_calls']==0 and result['usage']['budget_usd']==0
        assert any(step.get('agent')=='market' for step in result['steps'])
