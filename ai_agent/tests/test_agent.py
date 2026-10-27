import asyncio
from dataclasses import replace
from datetime import datetime
import json
from types import SimpleNamespace
from uuid import uuid4
import httpx
import pytest
from ai_agent.app import create_app
from ai_agent.config import Settings
from ai_agent.market import market_context, wilder_rsi
from ai_agent.provider import OpenAIProvider, ProviderError, Turn
from ai_agent.runner import Runner, validate_final
from ai_agent.schemas import Final
from ai_agent.tools import NewsSource, ResearchTools
from .fixtures import NOW, USAGE, make_lab, news_transport, AdaptiveProvider, ScriptedProvider, call, answer, final

@pytest.fixture
def settings(tmp_path):
    return Settings(lab_path=make_lab(tmp_path / 'lab.sqlite'), internal_secret='test-only-' * 5)

def toolkit(s, transport=None):
    return ResearchTools(s, news=NewsSource(replace(s, naver_id='fixture', naver_secret='fixture'), transport or news_transport()), now=NOW)

@pytest.mark.asyncio
@pytest.mark.parametrize('mode,question,minimum', [('concept', 'RSI란?', 1), ('news', '삼성전자 밤사이 뉴스', 3),
    ('rsi', '오늘 RSI 30 이하 종목', 2), ('composite', 'RSI 30 이하 종목 중 밤사이 부정적 뉴스', 4)])
async def test_real_loop_and_real_readonly_tools(settings, mode, question, minimum):
    provider = AdaptiveProvider(mode)
    tools = toolkit(settings)
    result = await Runner(settings, provider, tools).run(question, [])
    assert result['status'] == 'completed', result
    assert len(provider.inputs) >= minimum
    assert result['usage']['input_tokens'] == len(provider.inputs) * 25
    assert result['usage']['reasoning_tokens'] == len(provider.inputs) * 4
    if mode == 'composite':
        calls = [c for items in provider.inputs for c in items if c.get('name') == 'get_stock_news']
        screened = {i['code'] for r in provider.results if r.get('coverage', {}).get('kind') == 'rsi' for i in r['items']}
        assert {json.loads(c['arguments'])['code'] for c in calls} == screened
        assert '뉴스 미조사 0개' in result['answer']['content']
    if mode == 'concept':
        assert not any(x['kind'] == 'tool' for x in result['steps'])

@pytest.mark.asyncio
async def test_result_changes_next_path_page_and_final_content(settings):
    first, second = AdaptiveProvider('news'), AdaptiveProvider('news')
    a = await Runner(settings, first, toolkit(settings)).run('삼성전자 뉴스', [])
    b = await Runner(settings, second, toolkit(settings, news_transport(empty_first=True, positive=True))).run('삼성전자 뉴스', [])
    assert len(second.inputs) == len(first.inputs) + 1
    assert '감소' in a['answer']['content'] and '증가' in b['answer']['content']
    calls = [c for c in second.inputs[-1] if c.get('name') == 'get_stock_news']
    assert json.loads(calls[-1]['arguments'])['page'] == 2

@pytest.mark.asyncio
async def test_errors_are_sent_back_before_model_terminates(settings):
    p = AdaptiveProvider('news')
    result = await Runner(settings, p, toolkit(settings, news_transport(error=True))).run('삼성전자 뉴스', [])
    assert result['status'] == 'failed'
    assert result['error_code'] == 'news_provider_error'
    assert any(r.get('code') == 'news_provider_error' for r in p.results)
    assert result['answer']['kind'] == 'insufficient'

@pytest.mark.asyncio
async def test_ambiguous_symbol_asks_without_news(settings):
    import sqlite3
    with sqlite3.connect(settings.lab_path) as db:
        db.execute("INSERT INTO symbols(code,name,market,source) VALUES('000001','삼성물산','KOSPI','fixture')")
    p = AdaptiveProvider('ambiguous')
    result = await Runner(settings, p, toolkit(settings)).run('삼성 뉴스', [])
    assert result['answer']['kind'] == 'clarification'
    assert len(p.inputs) == 2

@pytest.mark.asyncio
@pytest.mark.parametrize('name,args,code', [('place_order', {}, 'forbidden_tool'),
    ('screen_rsi', {'threshold': 30, 'market': 'ALL', 'page': 1, 'page_size': 20, 'user_id': 'other'}, 'invalid_arguments'),
    ('get_stock_news', {'code': '005930', 'period': 'overnight', 'page': 1, 'keyword': ''}, 'symbol_not_resolved'),
    ('get_news_details', {'article_ids': ['n_forged']}, 'unknown_article_id')])
async def test_untrusted_tools_and_arguments(settings, name, args, code):
    tools = toolkit(settings)
    assert (await tools.execute(name, json.dumps(args)))['code'] == code

@pytest.mark.asyncio
async def test_repeat_and_recovery_limits(settings):
    turn = call('resolve_symbol', {'query': '삼성전자'})
    provider = ScriptedProvider([turn] * 6)
    result = await Runner(settings, provider, toolkit(settings)).run('뉴스', [])
    assert result['error_code'] == 'tool_recovery_limit'
    assert any(json.loads(x['output']).get('code') == 'repeated_tool_call' for x in provider.inputs[-1] if x.get('type') == 'function_call_output')

@pytest.mark.asyncio
async def test_budget_timeout_unknown_and_provider_errors(settings):
    s = replace(settings, tokens=50)
    p = ScriptedProvider([])
    assert (await Runner(s, p, toolkit(s)).run('오늘 뉴스', []))['error_code'] == 'token_or_cost_limit'
    assert not p.inputs
    s = replace(settings, max_usd=0.000001)
    assert (await Runner(s, ScriptedProvider([]), toolkit(s)).run('뉴스', []))['error_code'] == 'token_or_cost_limit'
    for code in ('connection_failed', 'billing_error', 'permission_error'):
        p = ScriptedProvider([ProviderError(code)])
        result = await Runner(settings, p, toolkit(settings)).run('RSI란?', [])
        assert result['usage']['status'] == 'unknown' and len(p.inputs) == 1
    p = ScriptedProvider([Turn([], '', None)])
    assert (await Runner(settings, p, toolkit(settings)).run('RSI란?', []))['usage']['status'] == 'unknown'
    class Slow:
        async def respond(self, *args): await asyncio.sleep(1)
    result = await Runner(replace(settings, seconds=0.01), Slow(), toolkit(settings)).run('RSI란?', [])
    assert result['error_code'] == 'execution_timeout' and result['usage']['status'] == 'unknown'

@pytest.mark.asyncio
async def test_final_validation_repairs_and_invalid_sources(settings):
    bad = final('research', '최신 자료입니다.', [{'text': '없는 자료', 'evidence_id': 'n_forged', 'excerpt': '없는 자료', 'stance': 'negative', 'relation': 'direct'}])
    p = ScriptedProvider([answer(bad)] * 3)
    result = await Runner(settings, p, toolkit(settings)).run('뉴스', [])
    assert result['error_code'] == 'answer_validation_failed'
    p = ScriptedProvider([answer(final())] * 3)
    result = await Runner(settings, p, toolkit(settings)).run('오늘 뉴스', [])
    assert result['error_code'] == 'answer_validation_failed'
    t = toolkit(settings)
    t.evidence['n_test'] = {'title': '삼성전자 이익 감소', 'snippet': '수익성 악화', 'relevance': 'direct_candidate'}
    t.fresh_ids.add('n_test')
    for text, excerpt in [('기상청 주말 강수 발표', '삼성전자 이익 감소'), ('삼성전자 이익 증가', '삼성전자 이익 감소'), ('삼성전자 이익 999 증가', '삼성전자 이익 감소'), ('삼성전자 이익 감소', '없는 원문입니다')]:
        with pytest.raises(ValueError): validate_final(Final(**final('research', '확보 자료', [{'text': text, 'evidence_id': 'n_test', 'excerpt': excerpt, 'stance': 'negative', 'relation': 'direct'}])), t, '뉴스')

def test_rsi_known_wilder_values_calendar_holidays():
    values = [44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28]
    assert wilder_rsi(values) == pytest.approx(70.464135, abs=0.00001)
    assert wilder_rsi([100] * 30) == 50
    assert wilder_rsi(list(range(30, 0, -1))) == 0
    ctx = market_context(NOW, '2026-12-31')
    assert ctx['latest_completed'] == '2026-10-27'
    assert datetime.fromisoformat(ctx['overnight']['start']).astimezone(NOW.tzinfo).hour == 15
    weekend = market_context(datetime.fromisoformat('2026-10-31T08:00:00+09:00'), '2026-12-31')
    assert weekend['session'] == '2026-11-02' and not weekend['is_trading_day']
    holiday = market_context(datetime.fromisoformat('2026-10-09T08:00:00+09:00'), '2026-12-31')
    assert holiday['session'] == '2026-10-12'
    with pytest.raises(ValueError): market_context(NOW, '2025-12-31')

@pytest.mark.asyncio
async def test_sqlite_quality_stale_partial_and_readonly(settings):
    import sqlite3
    with sqlite3.connect(settings.lab_path) as db:
        db.execute("DELETE FROM candles WHERE code='000660' AND date='2026-10-27'")
        db.execute("DELETE FROM candles WHERE code='005930' AND date='2026-09-07'")
    t = toolkit(settings)
    r = await t.execute('screen_rsi', json.dumps({'threshold': 100, 'market': 'ALL', 'page': 1, 'page_size': 20}))
    assert r['status'] == 'partial'
    assert r['coverage']['excluded'] == {'missing_sessions': 1, 'stale_data': 1}
    with t.connect() as db:
        with pytest.raises(sqlite3.OperationalError): db.execute('DELETE FROM candles')
    s = replace(settings, lab_path='missing-fixture.sqlite')
    assert (await toolkit(s).execute('resolve_symbol', '{"query":"삼성전자"}'))['code'] == 'lab_data_not_ready'

@pytest.mark.asyncio
async def test_news_cache_singleflight_and_bounds(settings):
    t = toolkit(settings)
    await t.execute('resolve_symbol', '{"query":"삼성전자"}')
    args = json.dumps({'code': '005930', 'period': 'overnight', 'page': 1, 'keyword': ''})
    a, b = await asyncio.gather(t.execute('get_stock_news', args), t.execute('get_stock_news', args))
    assert len(a['items']) == 1 and a['items'] == b['items']
    assert t.budget.external == 1
    assert 'snippet' in a['items'][0] and 'full_text' not in a['items'][0]
    assert a['coverage']['fetched'] == 2
    details = await t.execute('get_news_details', json.dumps({'article_ids': [a['items'][0]['id']]}))
    assert details['items'][0]['scope'] == 'title_and_snippet'
    t.budget.articles = settings.articles
    assert (await t.execute('get_stock_news', args))['code'] == 'article_limit'

@pytest.mark.asyncio
async def test_no_key_boot_auth_and_production_fixture_block(settings, monkeypatch):
    app = create_app(settings)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        assert (await client.get('/health')).status_code == 401
        headers = {'X-Atlas-Internal': settings.internal_secret}
        health = (await client.get('/health', headers=headers)).json()
        assert health['provider']['state'] == 'api_key_missing'
        result = await client.post('/run', headers=headers, json={'request_id': str(uuid4()), 'question': 'RSI란?', 'context': []})
        assert result.status_code == 503
    monkeypatch.setenv('NODE_ENV', 'production')
    with pytest.raises(ValueError): create_app(settings, provider=AdaptiveProvider())
    monkeypatch.setenv('AI_PROVIDER', 'fixture')
    with pytest.raises(ValueError): Settings.from_env()

@pytest.mark.asyncio
async def test_followup_keeps_exact_prior_sources_but_not_fresh(settings):
    first = await Runner(settings, AdaptiveProvider('news'), toolkit(settings)).run('삼성전자 뉴스', [])
    old = first['answer']['sources'][0]
    context = [{'role': 'assistant', 'answer': first['answer']}]
    tools = ResearchTools(settings, now=NOW, context=context)
    p = ScriptedProvider([call('get_news_details', {'article_ids': [old['id']]}), answer(final('research', '앞서 확보한 부정 요인을 설명합니다.', [
        {'text': old['title'], 'evidence_id': old['id'], 'excerpt': old['title'], 'stance': 'negative', 'relation': 'direct'}]))])
    result = await Runner(settings, p, tools).run('그중 부정적인 뉴스만 자세히 설명해줘', context)
    assert result['status'] == 'completed'
    assert result['answer']['sources'][0]['historical'] is True
    assert not tools.fresh_ids

@pytest.mark.asyncio
async def test_partial_coverage_cannot_disappear_and_hard_call_limits(settings):
    s = replace(settings, symbols=1)
    result = await Runner(s, AdaptiveProvider('composite'), toolkit(s)).run('RSI 30 이하 종목 뉴스', [])
    assert '미조사' in result['answer']['content']
    s = replace(settings, rounds=1)
    result = await Runner(s, AdaptiveProvider('news'), toolkit(s)).run('삼성전자 뉴스', [])
    assert result['error_code'] == 'model_round_limit'
    s = replace(settings, tool_calls=1)
    result = await Runner(s, AdaptiveProvider('news'), toolkit(s)).run('삼성전자 뉴스', [])
    assert result['error_code'] == 'tool_call_limit'
    t = toolkit(settings)
    t.budget.external = settings.external_requests
    await t.execute('resolve_symbol', '{"query":"삼성전자"}')
    result = await t.execute('get_stock_news', '{"code":"005930","period":"overnight","page":1,"keyword":""}')
    assert result['code'] == 'external_request_limit'

def test_env_provision_preserves_existing_and_separates_credentials(tmp_path, monkeypatch):
    from deploy.ai_prepare import main
    node = tmp_path / 'node.env'; ai = tmp_path / 'ai.env'
    node.write_text('KIWOOM_APP_KEY=fixture-do-not-copy\nEXISTING=value\n')
    args = ['ai_prepare', '--node-env', str(node), '--ai-env', str(ai), '--origin', 'https://example.com', '--lab-db', '/var/lib/atlas/lab.sqlite']
    monkeypatch.setattr('sys.argv', args); main()
    original = (node.read_bytes(), ai.read_bytes())
    main()
    assert original == (node.read_bytes(), ai.read_bytes())
    assert 'fixture-do-not-copy' not in ai.read_text()
    assert 'OPENAI_MODEL=gpt-6-luna' in ai.read_text()
    monkeypatch.setenv('NODE_ENV', 'production'); monkeypatch.setenv('KIWOOM_APP_KEY', 'fixture')
    with pytest.raises(ValueError, match='Broker secrets'): Settings.from_env()

@pytest.mark.asyncio
async def test_sdk_parameters_real_official_sdk_and_reasoning_call_continuity(settings):
    from openai import AsyncOpenAI
    requests = []
    def handler(request):
        payload = json.loads(request.content); requests.append(payload)
        if len(requests) == 1:
            output = [{'id': 'rs_1', 'type': 'reasoning', 'summary': [], 'encrypted_content': 'opaque-not-chain-of-thought'},
                      {'id': 'fc_1', 'type': 'function_call', 'call_id': 'call_1', 'name': 'resolve_symbol', 'arguments': '{"query":"삼성전자"}'}]
        else:
            output = [{'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': json.dumps(final('clarification', '어떤 기간의 뉴스를 확인할까요?')), 'annotations': []}]}]
        return httpx.Response(200, json={'id': 'resp_' + str(len(requests)), 'object': 'response', 'created_at': 1, 'status': 'completed', 'model': 'gpt-6-luna', 'output': output,
              'usage': {'input_tokens': 20, 'output_tokens': 10, 'total_tokens': 30, 'output_tokens_details': {'reasoning_tokens': 3}, 'input_tokens_details': {'cached_tokens': 0}}})
    client = AsyncOpenAI(api_key='fixture-never-network', http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), max_retries=0)
    result = await Runner(settings, OpenAIProvider(settings, client), toolkit(settings)).run('삼성전자 뉴스', [])
    assert result['status'] == 'completed'
    assert requests[0]['model'] == 'gpt-6-luna' and requests[0]['store'] is False
    assert requests[0]['text']['format']['type'] == 'json_schema'
    inputs = requests[1]['input']
    assert any(i.get('encrypted_content') == 'opaque-not-chain-of-thought' for i in inputs)
    assert any(i.get('call_id') == 'call_1' and i['type'] == 'function_call_output' for i in inputs)
    assert 'opaque-not-chain-of-thought' not in json.dumps(result)
    await client.close()
