"""Scripted role decisions exercise the actual graph. No paid model or operational mutations."""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from ai_agent.app import create_app
from ai_agent.config import Settings
from ai_agent.execution import Execution, RunLimit
from ai_agent.graph import ResearchGraph
from ai_agent.provider import ProviderError
from ai_agent.roles import ARCHITECTURE, DELEGATE, SPECIALISTS
from ai_agent.tools import Budget, ResearchTools, NewsSource
from .fixtures import NOW, USAGE, answer, call, delegation, final, make_lab, news_transport


def role_name(tools):
    names = {tool['name'] for tool in tools}
    return 'orchestrator' if 'delegate_research' in names else 'fundamental' if 'get_company_financials' in names else 'market' if 'get_market_quote' in names else 'alert' if 'propose_alert' in names else 'technical' if 'screen_rsi' in names else 'news'


class RoleProvider:
    def __init__(self, **scripts):
        self.scripts, self.calls = scripts, []

    async def respond(self, items, instructions, tools, limit):
        agent = role_name(tools)
        self.calls.append({'agent': agent, 'items': items[:], 'tools': [tool['name'] for tool in tools], 'instructions': instructions})
        value = self.scripts[agent].pop(0)
        if isinstance(value, Exception):
            raise value
        if callable(value):
            return await value(items)
        return value


@pytest.fixture
def tools(tmp_path):
    settings = Settings(lab_path=make_lab(tmp_path / 'lab.sqlite'), internal_secret='test-secret-' * 4)
    return ResearchTools(settings, now=NOW, news=NewsSource(replace(settings, naver_id='fixture', naver_secret='fixture'), news_transport()),
                         alert_context={'watchlist': [], 'draft': {'code': '035420', 'threshold': '200000', 'private_marker': 'member-only-fixture'}})


def research_from(outputs, prefix=None):
    rows = [row for item in outputs if item.get('type') == 'function_call_output'
            for row in json.loads(item['output']).get('items', []) if row.get('id')]
    if prefix:
        rows = [row for row in rows if row['id'].startswith(prefix)]
    claims = [{'text': row.get('excerpt') or row['title'], 'evidence_id': row['id'],
               'excerpt': row.get('excerpt') or row['title'], 'stance': 'neutral', 'relation': 'direct'} for row in rows]
    return answer(final('research', '확보한 근거를 정리했습니다.', claims))


async def specialist_final(items):
    return research_from(items)


async def synthesize(items):
    claims = [claim for item in items if item.get('type') == 'function_call_output'
              for report in json.loads(item['output'])['reports'] for claim in (report['findings'] or {}).get('claims', [])]
    return answer(final('research' if claims else 'insufficient', '확보한 근거와 누락 범위를 정리했습니다.', claims))


def news_script():
    return [call('resolve_symbol', {'query': '삼성전자'}), call('get_stock_news', {'code': '005930', 'period': 'overnight', 'page': 1, 'keyword': ''}), specialist_final]


def technical_script():
    return [call('screen_rsi', {'threshold': 30., 'market': 'ALL', 'page': 1, 'page_size': 20}), specialist_final]


@pytest.mark.asyncio
async def test_direct_concept_and_unavailable_features_never_create_fake_workers(tools):
    for question, result in [('RSI 개념 설명', final()), ('기관 수급', final('insufficient', '기관 수급 자료는 분석 도구에 연결되지 않았습니다.'))]:
        provider = RoleProvider(orchestrator=[answer(result)])
        response = await ResearchGraph(tools.settings, provider, tools).run(question, [])
        assert response['status'] == 'completed'
        assert [item['agent'] for item in provider.calls] == ['orchestrator']
        assert 'market' in SPECIALISTS and 'fundamental' in SPECIALISTS


@pytest.mark.asyncio
@pytest.mark.parametrize('agent', ['news', 'technical'])
async def test_model_selected_single_specialist_has_scoped_context_and_tools(tools, agent):
    scripts = news_script() if agent == 'news' else technical_script()
    provider = RoleProvider(orchestrator=[delegation(agent), synthesize], **{agent: scripts})
    response = await ResearchGraph(tools.settings, provider, tools).run('삼성전자 최근 뉴스' if agent == 'news' else '일봉 RSI 30 이하 종목', [])
    assert response['status'] == 'completed', response
    assert set(item['agent'] for item in provider.calls) == {'orchestrator', agent}
    assert response['answer']['sources']
    for item in provider.calls:
        assert item['tools'] == ['delegate_research'] if item['agent'] == 'orchestrator' else set(item['tools']) == set(SPECIALISTS[agent].tools)
        assert 'member-only-fixture' not in json.dumps(item, ensure_ascii=False)


@pytest.mark.asyncio
async def test_parallel_research_merges_evidence_without_state_or_trace_overwrites(tools):
    plan = delegation('news')
    plan.output[0]['arguments'] = json.dumps({'tasks': [json.loads(plan.output[0]['arguments'])['tasks'][0], json.loads(delegation('technical').output[0]['arguments'])['tasks'][0]]})
    arrived, both = set(), asyncio.Event()

    async def barrier(agent, result):
        async def execute(items):
            arrived.add(agent)
            if len(arrived) == 2:
                both.set()
            await asyncio.wait_for(both.wait(), 1)
            return result
        return execute
    news, technical = news_script(), technical_script()
    news[0] = await barrier('news', news[0])
    technical[0] = await barrier('technical', technical[0])
    recorded = []

    async def record(step):
        await asyncio.sleep(.001)
        recorded.append(step)
    provider = RoleProvider(orchestrator=[plan, synthesize], news=news, technical=technical)
    response = await ResearchGraph(tools.settings, provider, tools, record).run('삼성전자 뉴스와 RSI 조건검색', [])
    assert response['status'] == 'completed', response
    assert arrived == {'news', 'technical'}
    assert {source['id'][:2] for source in response['answer']['sources']} == {'n_', 'r_'}
    assert len({source['id'] for source in response['answer']['sources']}) == len(response['answer']['sources'])
    assert [step['seq'] for step in recorded] == list(range(1, len(recorded) + 1))
    assert response['usage']['model_calls'] == 7
    assert response['usage']['input_tokens'] == 7 * USAGE['input_tokens']
    assert sum(value['model_calls'] for value in response['agent_usage'].values()) == response['usage']['model_calls']
    assert response['answer']['execution']['architecture'] == ARCHITECTURE


@pytest.mark.asyncio
async def test_specialist_forbidden_tool_is_rejected_before_execution_and_can_recover(tools):
    provider = RoleProvider(orchestrator=[delegation('news'), answer(final('clarification', '조사할 종목을 알려 주세요.'))],
                            news=[call('propose_alert', {}), answer(final('clarification', '종목을 알려 주세요.'))])
    response = await ResearchGraph(tools.settings, provider, tools).run('뉴스를 조사해줘', [])
    assert any(step['name'] == 'forbidden' and step['result']['code'] == 'forbidden_tool' for step in response['steps'])
    assert not tools.alert_action
    assert 'alert_action' not in response


@pytest.mark.asyncio
async def test_invalid_delegation_and_structured_final_recover_within_shared_budget(tools):
    invalid = call('delegate_research', {'tasks': [{'agent': 'fundamental'}]})
    provider = RoleProvider(orchestrator=[invalid, answer(final())])
    response = await ResearchGraph(tools.settings, provider, tools).run('개념 설명', [])
    assert response['status'] == 'completed' and response['usage']['model_calls'] == 2
    assert response['steps'][2]['result']['code'] == 'invalid_delegation'
    provider = RoleProvider(orchestrator=[answer({'made_up': True})] * 3)
    response = await ResearchGraph(tools.settings, provider, tools).run('개념 설명', [])
    assert response['error_code'] == 'answer_validation_failed'


@pytest.mark.asyncio
async def test_partial_failure_keeps_peer_evidence_and_unsupported_claims_do_not_pass(tools):
    plan = delegation('news')
    plan.output[0]['arguments'] = json.dumps({'tasks': [json.loads(plan.output[0]['arguments'])['tasks'][0], json.loads(delegation('technical').output[0]['arguments'])['tasks'][0]]})
    provider = RoleProvider(orchestrator=[plan, synthesize], news=news_script(),
                            technical=[call('place_order', {})] * 3)
    response = await ResearchGraph(tools.settings, provider, tools).run('삼성전자 뉴스와 일봉 조건검색', [])
    assert response['status'] == 'partial' and response['answer']['sources']
    assert 'technical' in response['answer']['content'] and next(report for report in response['agent_results'] if report['agent'] == 'technical')['status'] == 'failed'


@pytest.mark.asyncio
async def test_shared_budget_reservations_are_atomic_and_not_per_agent(tools):
    execution = Execution(replace(tools.settings, rounds=1), object(), None)
    ticket, _ = execution.reserve([], 'test', [])
    with pytest.raises(RunLimit, match='model_round_limit'):
        execution.reserve([], 'another agent', [])
    execution.reserved.pop(ticket)
    provider = RoleProvider(orchestrator=[delegation('technical')], technical=technical_script())
    response = await ResearchGraph(replace(tools.settings, rounds=2), provider, tools).run('RSI 조건검색', [])
    assert response['usage']['model_calls'] == 2
    assert response['error_code'] == 'model_round_limit'


@pytest.mark.asyncio
async def test_timeout_and_unknown_billing_never_replay_paid_calls(tools):
    async def wait(_):
        await asyncio.sleep(3)
    provider = RoleProvider(orchestrator=[delegation('technical')], technical=[wait])
    response = await ResearchGraph(replace(tools.settings, seconds=.2), provider, tools).run('RSI 조건검색', [])
    assert response['usage']['status'] == 'unknown'
    assert len([item for item in provider.calls if item['agent'] == 'technical']) == 1
    assert response['error_code'] in ('specialist_timeout', 'execution_timeout')
    provider = RoleProvider(orchestrator=[delegation('technical')], technical=[ProviderError('connection_failed')])
    response = await ResearchGraph(tools.settings, provider, tools).run('RSI 조건검색', [])
    assert response['error_code'] == 'connection_failed' and response['usage']['status'] == 'unknown'
    assert len(provider.calls) == 2


@pytest.mark.asyncio
async def test_node_cancellation_stops_all_branches_without_next_paid_turn(tools):
    provider = RoleProvider(orchestrator=[delegation('news')], news=news_script())

    async def cancelled(step):
        if step['name'] == 'resolve_symbol':
            raise RuntimeError('room deleted')
    result = await ResearchGraph(tools.settings, provider, tools, cancelled).run('삼성전자 뉴스', [])
    assert result['error_code'] == 'execution_cancelled'
    assert len(provider.calls) == 2
    assert result['usage']['model_calls'] == 2


@pytest.mark.asyncio
async def test_internal_endpoint_rejects_forged_identity_and_deduplicates_finished_run(tools):
    provider = RoleProvider(orchestrator=[answer(final())])
    app = create_app(tools.settings, provider=provider, tools_factory=lambda: tools, callback=lambda *_: asyncio.sleep(0))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        payload = {'request_id': str(uuid4()), 'question': 'RSI란?', 'context': []}
        assert (await client.post('/run', json=payload)).status_code == 401
        headers = {'X-Atlas-Internal': tools.settings.internal_secret}
        assert (await client.post('/run', json={**payload, 'user_id': 'forged'}, headers=headers)).status_code == 422
        first = await client.post('/run', json=payload, headers=headers)
        second = await client.post('/run', json=payload, headers=headers)
        assert first.json() == second.json()
        assert len(provider.calls) == 1


@pytest.mark.asyncio
async def test_concurrent_members_keep_alert_conditions_separate_and_saved_edits_remain_drafts(tools):
    stock = {'code': '035420', 'name': 'NAVER', 'market': 'KOSPI'}
    rule_id, version = str(uuid4()), str(uuid4())
    saved = {'rule_id': rule_id, 'version': version, 'code': stock['code'], 'kind': 'price_touch',
             'threshold': 200000, 'expires_on': '2026-11-04', 'frequency': 'once'}
    results = []
    graphs = []
    for watched, threshold in [(False, 1000000), (True, 210000)]:
        context = {'watchlist': [stock] if watched else [], 'rules': [saved] if watched else []}
        branch = ResearchTools(tools.settings, now=NOW, alert_context=context)
        proposal = {'action': 'edit_saved' if watched else 'create', 'symbol': stock['code'],
                    'rule_id': rule_id if watched else None, 'basis': 'same' if watched else 'price',
                    'kind': None if watched else 'price_touch', 'threshold': threshold,
                    'expires_on': None, 'frequency': None}
        provider = RoleProvider(orchestrator=[delegation('alert')], alert=[call('get_alert_editor', {}), call('propose_alert', proposal)])
        graphs.append(ResearchGraph(tools.settings, provider, branch))
        results.append(context)
    first, second = await asyncio.gather(*(graph.run('지정한 목표가 알림 초안을 만들어줘', []) for graph in graphs))
    assert first['alert_action']['kind'] == 'watchlist_confirmation'
    assert second['alert_action']['kind'] == 'draft'
    assert first['alert_action']['rule']['threshold'] == 1000000
    assert second['alert_action']['rule']['threshold'] == 210000
    assert second['alert_action']['rule_id'] == rule_id and second['alert_action']['version'] == version
    assert not results[0]['watchlist'] and results[1]['rules'][0]['threshold'] == 200000
    assert all(result['status'] == 'completed' for result in (first, second))


@pytest.mark.asyncio
async def test_missing_condition_returns_a_question_without_automatic_approval(tools):
    provider = RoleProvider(orchestrator=[delegation('alert'), answer(final('clarification', '어떤 목표 가격을 원하시나요?'))],
                            alert=[call('get_alert_editor', {}), answer(final('clarification', '어떤 목표 가격을 원하시나요?'))])
    result = await ResearchGraph(tools.settings, provider, tools).run('네이버 알림을 받고 싶어', [])
    assert result['answer']['kind'] == 'clarification' and 'alert_action' not in result
    assert result['agent_results'][0]['status'] == 'clarification'
    assert not any(step['name'] == 'propose_alert' for step in result['steps'])


def test_admin_manifest_exactly_matches_executable_permissions():
    manifest = json.loads((Path(__file__).parents[2] / 'shared/agentArchitecture.json').read_text(encoding='utf-8'))
    assert manifest['version'] == ARCHITECTURE
    assert set(manifest['agents'][0]['tools']) == {DELEGATE['name']}
    assert {row['id']: set(row['tools']) for row in manifest['agents'][1:]} == {name: set(role.tools) for name, role in SPECIALISTS.items()}


@pytest.mark.asyncio
async def test_cancelled_public_news_consumer_cannot_cancel_another_members_lookup(tools):
    entered, release = asyncio.Event(), asyncio.Event()
    async def transport(_request):
        entered.set()
        await release.wait()
        return httpx.Response(200, json={'total': 0, 'items': []})
    settings = replace(tools.settings, naver_id='fixture', naver_secret='fixture')
    source = NewsSource(settings, httpx.MockTransport(transport))
    first_budget, second_budget = Budget(settings), Budget(settings)
    first = asyncio.create_task(source.page('공개 뉴스', 1, first_budget))
    await entered.wait()
    second = asyncio.create_task(source.page('공개 뉴스', 1, second_budget))
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    release.set()
    assert (await second)['items'] == []
    assert first_budget.external == 1 and second_budget.external == 0
    assert not source.pending


@pytest.mark.asyncio
async def test_global_timeout_preserves_completed_peer_before_join(tools):
    plan = delegation('news')
    plan.output[0]['arguments'] = json.dumps({'tasks': [json.loads(plan.output[0]['arguments'])['tasks'][0], json.loads(delegation('technical').output[0]['arguments'])['tasks'][0]]})
    async def delayed_plan(_items):
        await asyncio.sleep(.3)
        return plan
    async def slow_peer(_items):
        await asyncio.sleep(2)
    provider = RoleProvider(orchestrator=[delayed_plan], news=news_script(), technical=[slow_peer])
    result = await ResearchGraph(replace(tools.settings, seconds=.5), provider, tools).run('삼성전자 뉴스와 일봉 조건검색', [])
    assert result['error_code'] == 'execution_timeout'
    assert result['status'] == 'partial'
    assert result['answer']['sources'] and all(source['id'].startswith('n_') for source in result['answer']['sources'])
    assert 'technical' in result['answer']['content']
    assert result['usage']['status'] == 'unknown'
