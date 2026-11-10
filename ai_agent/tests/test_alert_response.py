import json
import sqlite3
from dataclasses import replace

import pytest

from ai_agent.config import Settings
from ai_agent.runner import Runner, validate_final
from ai_agent.schemas import Final
from ai_agent.tools import ResearchTools
from .fixtures import NOW, ScriptedProvider, answer, call, final, make_lab


QUESTION = '삼성전기 100만원일때 알림받고싶어'
APPROVAL_TEXT = '삼성전기 1,000,000원 알림을 위해 관심종목에 추가할까요?'


@pytest.fixture
def tools(tmp_path):
    settings = Settings(lab_path=make_lab(tmp_path / 'lab.sqlite'))
    with sqlite3.connect(settings.lab_path) as db:
        db.execute("INSERT INTO symbols(code,name,market,source) VALUES('009150','삼성전기','KOSPI','fixture')")
    return ResearchTools(settings, now=NOW, alert_context={'watchlist': []})


class AlertProviderFixture:
    """Select the proposal only after seeing real tool output and, when needed, the repair instruction."""

    def __init__(self, premature=None):
        self.premature = premature
        self.inputs = []

    async def respond(self, items, _instructions, _tools, _limit):
        self.inputs.append(items[:])
        outputs = [json.loads(item['output']) for item in items if item.get('type') == 'function_call_output']
        if not outputs:
            return call('get_alert_editor', {})
        if len(outputs) == 1:
            assert not outputs[0]['items'] and 'propose_alert' in outputs[0]['next_step']
            return call('resolve_symbol', {'query': '삼성전기'})
        assert 'propose_alert' in outputs[-1]['next_step']
        if self.premature:
            expected, bad = self.premature
            last_message = items[-1]
            if last_message.get('role') != 'developer':
                return answer(bad)
            assert expected in last_message['content'] and 'propose_alert' in last_message['content']
            assert not any(item.get('type') == 'message' and item.get('role') == 'assistant' for item in items)
        return call('propose_alert', {'action': 'create', 'symbol': outputs[-1]['items'][0]['code'], 'rule_id': None,
                                     'basis': 'price', 'kind': 'price_touch', 'threshold': 1000000,
                                     'frequency': None, 'expires_on': None})


@pytest.mark.asyncio
@pytest.mark.parametrize('premature', [None,
    ('alert_proposal_required', final('clarification', APPROVAL_TEXT)),
    ('alert_proposal_required', final('clarification', '삼성전기가 관심종목에 없습니다. 이 종목을 추가해 드릴까요?')),
    ('unsupported_claims', {**final('clarification', '종목을 확인했습니다. 계속할까요?'), 'sentiment': '중립'}),
])
async def test_alert_proposal_follows_symbol_lookup_and_recovers_from_premature_final(tools, premature):
    provider = AlertProviderFixture(premature)
    result = await Runner(tools.settings, provider, tools).run(QUESTION, [])
    assert result['status'] == 'completed'
    assert result['usage']['model_calls'] == (4 if premature else 3)
    assert result['alert_action']['kind'] == 'watchlist_confirmation'
    assert result['alert_action']['stock']['code'] == '009150'
    assert result['alert_action']['rule']['threshold'] == 1000000
    assert result['alert_action']['rule']['kind'] == 'price_touch'
    assert [s['name'] for s in result['steps'] if s['kind'] == 'tool' and s['status'] == 'success'] == [
        'get_alert_editor', 'resolve_symbol', 'propose_alert',
    ]
    assert [s['result'] for s in result['steps'] if s['kind'] == 'validation'] == (
        [{'code': premature[0]}] if premature else []
    )
    assert not tools.alerts.watchlist


@pytest.mark.parametrize('summary', [APPROVAL_TEXT,
    '삼성전기 1,000,000원 도달 조건의 알림은 언제까지 받을까요?',
    '현재가가 100만원에 도달하면 받는 알림의 만료일은 언제로 할까요?',
    '목표 가격은 1,000,000원으로 하고 만료일은 언제로 할까요?',
    '지정하신 가격이 1,000,000원이 맞나요?',
])
def test_clarification_can_restate_the_members_target_as_a_condition(tools, summary):
    validate_final(Final(**final('clarification', summary)), tools, QUESTION)


def test_clarification_can_restate_the_verified_editor_draft(tools):
    tools.alerts.draft = {'kind': 'price_touch', 'threshold': '1000000'}
    response = Final(**final('clarification', '100만원 도달 조건의 만료일을 언제로 바꿀까요?'))
    validate_final(response, tools, '이 초안의 만료일을 바꾸고 싶어', alert_editor_read=True)
    with pytest.raises(ValueError, match='unsupported_current_facts'):
        validate_final(response, tools, '이 초안의 만료일을 바꾸고 싶어')


@pytest.mark.parametrize('summary', [
    '삼성전기 현재가는 1,000,000원입니다.',
    '현재가가 100만원인데 알림을 설정할까요?',
    '삼성전기가 100만원에서 거래 중인데 알림을 설정할까요?',
    '현재가가 1,000,000원 알림을 설정할까요?',
    '삼성전기 2,000,000원 도달 조건으로 알림을 설정할까요?',
    '삼성전기 100만원 알림을 설정할까요? 현재가는 101만원입니다.',
    '삼성전기 100만원 알림을 설정할까요? RSI 75입니다.',
])
def test_clarification_rejects_unverified_quotes_and_invented_targets(tools, summary):
    with pytest.raises(ValueError, match='unsupported_current_facts'):
        validate_final(Final(**final('clarification', summary)), tools, QUESTION)


@pytest.mark.parametrize('quote', ['삼성전기의 현재가는 1,000,000원입니다.', '삼성전기 현재가 1,000,000원입니다.'])
def test_concept_cannot_disguise_a_live_quote_and_uncertainty_cannot_add_one(tools, quote):
    with pytest.raises(ValueError, match='unsupported_current_facts'):
        validate_final(Final(**final('concept', quote)), tools, QUESTION)
    response = {**final('clarification', '알림 만료일은 언제로 할까요?'), 'uncertainty': [quote]}
    with pytest.raises(ValueError, match='unsupported_current_facts'):
        validate_final(Final(**response), tools, QUESTION)


@pytest.mark.asyncio
@pytest.mark.parametrize('is_alert', [True, False])
async def test_missing_detail_or_plain_symbol_lookup_can_finish_without_a_card(tools, is_alert):
    if is_alert:
        question = '삼성전기 100만원에 알림 받고 싶어. 만료일은 직접 정할게'
        summary = '삼성전기 1,000,000원 도달 조건의 알림은 언제까지 받을까요?'
    else:
        question = '삼성전기 종목 코드 찾아줘'
        summary = '조회한 삼성전기(009150)가 찾으시는 종목인가요?'
    provider = ScriptedProvider([call('get_alert_editor', {}), call('resolve_symbol', {'query': '삼성전기'}),
                                 answer(final('clarification', summary))])
    result = await Runner(tools.settings, provider, tools).run(question, [])
    assert result['status'] == 'completed'
    assert result['answer']['kind'] == 'clarification'
    assert 'alert_action' not in result
    assert not any(s['name'] == 'propose_alert' or s['kind'] == 'validation' for s in result['steps'])


@pytest.mark.asyncio
async def test_repeated_bad_final_stops_at_repair_limit_and_persists_only_safe_codes(tools):
    settings = replace(tools.settings, corrections=1)
    bad = answer(final('clarification', APPROVAL_TEXT))
    provider = ScriptedProvider([call('get_alert_editor', {}), call('resolve_symbol', {'query': '삼성전기'}), bad, bad])
    recorded = []

    async def on_step(step):
        if step['kind'] == 'validation':
            recorded.append((step['arguments'], step['result']))

    result = await Runner(settings, provider, tools, on_step=on_step).run(QUESTION, [])
    assert result['error_code'] == 'answer_validation_failed'
    assert len(provider.inputs) == 4
    assert recorded == [({}, {'code': 'alert_proposal_required'})] * 2
    assert not any(APPROVAL_TEXT in json.dumps(item, ensure_ascii=False) for item in provider.inputs[-1])
