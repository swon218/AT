from datetime import datetime

from ai_agent.alert_tools import AlertTools
from ai_agent.market import KST, alert_session
from ai_agent.schemas import AlertProposal


def proposal(**patch):
    return AlertProposal.model_validate({
        'action': 'create', 'symbol': '브이엠', 'basis': 'previous_close',
        'kind': 'fall_lte', 'threshold': 5, 'expires_on': None, **patch,
    })


def test_draft_only_exact_watchlist_and_explicit_basis():
    now = datetime(2026, 11, 10, 10, tzinfo=KST)
    tools = AlertTools({'watchlist': [{'name': '브이엠', 'code': '089970'}]}, now)
    result = tools.propose(proposal(), '브이엠 5% 하락하면 알려줘')
    assert result == {'kind': 'draft', 'edit': False, 'rule': {
        'code': '089970', 'kind': 'fall_lte', 'threshold': 5, 'expires_on': '2026-11-17',
    }}
    assert tools.propose(proposal(), '브이엠 매입가 대비 5% 하락하면 알려줘')['kind'] == 'unsupported'
    assert tools.propose(proposal(symbol='브이'), '')['kind'] == 'watchlist_required'
    assert AlertTools(None, now).propose(proposal(), '')['kind'] == 'unavailable'
    tools.draft = {**result['rule'], 'threshold': 6}
    assert tools.editor()['draft']['threshold'] == 6
    edit = proposal(action='edit', basis='same', symbol=None, threshold=7, kind=None)
    assert tools.propose(edit, '7%로 바꿔줘')['rule']['threshold'] == 7


def test_monitoring_calendar_uses_reviewed_sessions_and_previous_day():
    now = datetime(2026, 11, 9, 9, tzinfo=KST)
    session = alert_session(now, '2026-12-31')
    assert session['previous'] == '2026-11-06'
    assert session['open'].startswith('2026-11-09T00:00:00')
    assert alert_session(datetime(2026, 11, 8, tzinfo=KST), '2026-12-31')['closed']
