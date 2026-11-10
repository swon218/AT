import json
from dataclasses import replace
import pytest
from ai_agent.answers import validate_final
from ai_agent.config import Settings
from ai_agent.evaluation.catalog import all_cases
from ai_agent.evaluation.data_fixtures import FixedResearchData
from ai_agent.evaluation.engine import evaluate
from ai_agent.graph import ResearchGraph
from ai_agent.roles import SPECIALISTS
from ai_agent.schemas import Final
from ai_agent.tools import ResearchTools,NewsSource
from .fixtures import NOW,answer,call,delegation,final,make_lab,news_transport
from .test_graph import RoleProvider,specialist_final,synthesize,news_script,technical_script

FINANCE={'code':'005930','scope':'CFS','period_type':'annual','basis':'single_period','year':2025,'quarter':None,'compare_to_year':None,'metrics':['sales','operating']}
FILINGS={'code':'005930','start_date':'2026-01-01','end_date':'2026-10-27','type':'all','page':1}

@pytest.fixture
def tools(tmp_path):
    settings=Settings(lab_path=make_lab(tmp_path/'lab.sqlite'))
    return ResearchTools(settings,now=NOW,data=FixedResearchData('fundamental_profile',NOW),
        news=NewsSource(replace(settings,naver_id='fixture',naver_secret='fixture'),news_transport()))


@pytest.mark.asyncio
async def test_production_graph_maps_name_reads_profile_and_finance_with_scoped_tools(tools):
    provider=RoleProvider(orchestrator=[delegation('fundamental'),synthesize],fundamental=[
        call('resolve_market_symbol',{'query':'삼성전자'}),call('get_company_profile',{'code':'005930'}),
        call('get_company_financials',FINANCE),specialist_final])
    result=await ResearchGraph(tools.settings,provider,tools).run('삼성전자 연결 연간 실적과 기업 정보',[])
    assert result['status']=='completed',result
    assert set(provider.calls[1]['tools'])==set(SPECIALISTS['fundamental'].tools)
    assert all(source['id'].startswith('d_') for source in result['answer']['sources'])
    amounts=[source for source in result['answer']['sources'] if source.get('metric')]
    assert amounts[0]['financial_scope']=='CFS' and amounts[0]['currency']=='KRW'
    assert amounts[1]['amount']=='0' and amounts[1]['url'].startswith('https://dart.fss.or.kr/')
    assert result['usage']['model_calls']==6 and result['usage']['external_requests']==3
    assert '저장 갱신' in result['answer']['content']


@pytest.mark.asyncio
@pytest.mark.parametrize('peer',['news','technical'])
async def test_composite_official_vs_news_or_daily_keeps_distinct_sources(tools,peer):
    plan=delegation('fundamental')
    tasks=json.loads(plan.output[0]['arguments'])['tasks']+json.loads(delegation(peer).output[0]['arguments'])['tasks']
    plan.output[0]['arguments']=json.dumps({'tasks':tasks})
    provider=RoleProvider(orchestrator=[plan,synthesize],fundamental=[call('get_company_disclosures',FILINGS),specialist_final],
        **{peer:news_script() if peer=='news' else technical_script()})
    result=await ResearchGraph(tools.settings,provider,tools).run('삼성전자 공식 공시와 '+('뉴스' if peer=='news' else '확정 일봉 분석'),[])
    assert result['status']=='completed',result
    assert {source['id'][:2] for source in result['answer']['sources']}=={'d_','n_' if peer=='news' else 'r_'}
    assert result['usage']['model_calls']<=tools.settings.rounds
    assert next(source for source in result['answer']['sources'] if source['id'].startswith('d_'))['body_available'] is False


@pytest.mark.asyncio
async def test_failure_in_one_role_preserves_news_and_shared_limits(tools):
    tools.data=FixedResearchData('fundamental_error',NOW)
    plan=delegation('fundamental')
    tasks=json.loads(plan.output[0]['arguments'])['tasks']+json.loads(delegation('news').output[0]['arguments'])['tasks']
    plan.output[0]['arguments']=json.dumps({'tasks':tasks})
    provider=RoleProvider(orchestrator=[plan,synthesize],news=news_script(),fundamental=[call('get_company_profile',{'code':'005930'}),answer(final('insufficient','기업 자료 조회 제한으로 확인하지 못했습니다.'))])
    result=await ResearchGraph(tools.settings,provider,tools).run('삼성전자 뉴스와 기업 정보',[])
    assert result['status']=='partial',result
    assert all(source['id'].startswith('n_') for source in result['answer']['sources'])
    assert any(step['result'].get('code')=='dart_rate_limit' for step in result['steps'])
    assert result['usage']['external_requests']<=tools.settings.external_requests


@pytest.mark.asyncio
async def test_quarter_scope_missing_cells_and_business_excerpt_scope(tools):
    value=await tools.execute('get_company_financials',json.dumps({**FINANCE,'period_type':'quarterly','quarter':3,'scope':'OFS','metrics':['sales','borrowings']}))
    assert value['data_rows'][0]['values']['borrowings'] is None
    assert value['items'][0]['financial_scope']=='OFS' and '단일분기' in value['items'][0]['excerpt']
    body=await tools.execute('get_company_business',json.dumps({'code':'005930'}))
    assert body['items'][0]['body_available'] is True
    assert body['items'][0]['text_scope']=='사업보고서 일부 추출 문단'
    assert len(body['items'][0]['excerpt'])<=300
    unsupported=await tools.execute('get_company_financials',json.dumps({**FINANCE,'basis':'cumulative'}))
    assert unsupported['code']=='unsupported_financial_basis'


@pytest.mark.asyncio
async def test_title_only_cannot_claim_body_or_change_numbers_or_use_unverified_dart(tools):
    value=await tools.execute('get_company_disclosures',json.dumps(FILINGS))
    source=value['items'][0]
    claim={'text':'공시 본문을 읽었습니다.','evidence_id':source['id'],'excerpt':source['excerpt'],'stance':'neutral','relation':'direct'}
    with pytest.raises(ValueError,match='unavailable_source_claim'):
        validate_final(Final.model_validate(final('research','확보된 근거입니다.',[claim])),tools,'공시 본문 분석')
    valid_claim={**claim,'text':source['excerpt']}
    with pytest.raises(ValueError,match='unavailable_source_claim'):
        validate_final(Final.model_validate(final('research','공시 본문을 조회했습니다.',[valid_claim])),tools,'공시 본문 분석')
    claim['text']='매출액 999999999원입니다.'
    with pytest.raises(ValueError,match='unsupported_number'):
        validate_final(Final.model_validate(final('research','확보된 근거입니다.',[claim])),tools,'공시 조회')
    with pytest.raises(ValueError,match='unavailable_source_claim'):
        validate_final(Final.model_validate(final('insufficient','DART를 조회했습니다.')),tools,'공시 조회')


@pytest.mark.asyncio
async def test_fundamental_tools_cannot_escape_role_or_perform_writes(tools):
    provider=RoleProvider(orchestrator=[delegation('news'),synthesize],news=[call('get_company_profile',{'code':'005930'}),answer(final('insufficient','허용된 자료를 확보하지 못했습니다.'))])
    result=await ResearchGraph(tools.settings,provider,tools).run('삼성전자 뉴스',[])
    assert not any(source['id'].startswith('d_') for source in result.get('answer',{}).get('sources',[]))
    assert not set(SPECIALISTS['fundamental'].tools)&{'propose_alert','save_alert','place_order'}


@pytest.mark.asyncio
async def test_all_new_fixed_scenarios_are_repeatable_without_real_model_or_members():
    cases=all_cases()
    assert len(cases)==45 and len({case['id'] for case in cases})==45
    for specimen in cases[36:]:
        result=await evaluate({'mode':'code','specimen':specimen},Settings())
        assert result['grade']=='review',result
        assert result['usage']['paid_model_calls']==0
        assert any(step.get('agent')=='fundamental' for step in result['steps'])
