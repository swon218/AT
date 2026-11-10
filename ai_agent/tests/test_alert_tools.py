from datetime import datetime

from ai_agent.alert_tools import AlertTools
from ai_agent.market import KST, alert_session
from ai_agent.schemas import AlertProposal


def proposal(**patch):
    return AlertProposal.model_validate({
        'action': 'create', 'symbol': '브이엠', 'basis': 'previous_close',
        'kind': 'fall_lte', 'threshold': 5, 'expires_on': None, 'rule_id': None, 'frequency': None, **patch,
    })


def test_draft_only_exact_watchlist_and_explicit_basis():
    now = datetime(2026, 11, 10, 10, tzinfo=KST)
    tools = AlertTools({'watchlist': [{'name': '브이엠', 'code': '089970'}]}, now)
    result = tools.propose(proposal(), '브이엠 5% 하락하면 알려줘')
    assert result == {'kind': 'draft', 'edit': False, 'rule': {
        'code': '089970', 'kind': 'fall_lte', 'threshold': 5, 'expires_on': '2026-11-17', 'frequency': 'once',
    }}
    assert tools.propose(proposal(), '브이엠 매입가 대비 5% 하락하면 알려줘')['kind'] == 'unsupported'
    assert tools.propose(proposal(symbol='브이'), '')['kind'] == 'watchlist_required'
    assert AlertTools(None, now).propose(proposal(), '')['kind'] == 'unavailable'
    tools.draft = {**result['rule'], 'threshold': 6}
    assert tools.editor()['draft']['threshold'] == 6
    edit = proposal(action='edit', basis='same', symbol=None, threshold=7, kind=None)
    assert tools.propose(edit, '7%로 바꿔줘')['rule']['threshold'] == 7
    repeat = proposal(kind='price_touch', basis='price', threshold=210000, frequency='repeat')
    assert tools.propose(repeat, '브이엠 210000원 도달마다 반복')['rule']['frequency'] == 'repeat'


def test_saved_edit_requires_exact_rule_and_new_draft_stays_independent():
    now = datetime(2026, 11, 10, 10, tzinfo=KST)
    first = '11111111-1111-4111-8111-111111111111'
    second = '22222222-2222-4222-8222-222222222222'
    common = {'code': '089970', 'version': second, 'expires_on': '2026-11-17', 'status': 'active'}
    tools = AlertTools({'watchlist': [{'name': '브이엠', 'code': '089970'}], 'rules': [
        {**common, 'rule_id': first, 'kind': 'price_gte', 'threshold': 197500},
        {**common, 'rule_id': second, 'kind': 'fall_lte', 'threshold': 5},
    ]}, now)
    edit = dict(action='edit_saved', basis='same', threshold=197600, kind=None)
    assert len(tools.editor()['saved']) == 2
    assert tools.propose(proposal(**edit), '브이엠 조건 수정')['kind'] == 'ambiguous_rule'
    assert tools.propose(proposal(rule_id=first, **edit), '브이엠 기존 가격 변경')['kind'] == 'legacy_conversion_required'
    drafted = tools.propose(proposal(rule_id=first, **{**edit, 'kind': 'price_touch', 'basis': 'price'}), '브이엠 목표가 양방향 도달로 변경')
    assert drafted['rule_id'] == first and drafted['version'] == second
    assert drafted['rule']['threshold'] == 197600 and drafted['rule']['kind'] == 'price_touch'
    assert 'rule_id' not in tools.propose(proposal(), '브이엠 5% 하락 조건 추가')


def test_monitoring_calendar_uses_reviewed_sessions_and_previous_day():
    now = datetime(2026, 11, 9, 9, tzinfo=KST)
    session = alert_session(now, '2026-12-31')
    assert session['previous'] == '2026-11-06'
    assert session['open'].startswith('2026-11-09T00:00:00')
    assert alert_session(datetime(2026, 11, 8, tzinfo=KST), '2026-12-31')['closed']
