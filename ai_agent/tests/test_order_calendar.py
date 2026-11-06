import httpx
import pytest
from ai_agent.market import recent_order_days
from ai_agent.app import create_app
from ai_agent.config import Settings


@pytest.mark.parametrize('day,last', [('2026-11-06', '2026-11-06'), ('2026-11-07', '2026-11-06'),
                                    ('2026-06-03', '2026-06-02'), ('2026-07-17', '2026-07-16')])
def test_last_five_sessions_include_today_and_skip_reviewed_closures(day, last):
    result = recent_order_days(day, '2026-12-31')
    assert result['days'][0] == last
    assert len(set(result['days'])) == 5
    assert result['days'] == sorted(result['days'], reverse=True)
    assert not {'2026-06-03', '2026-07-17'}.intersection(result['days'])


def test_calendar_fails_outside_verified_horizon():
    with pytest.raises(ValueError):
        recent_order_days('2027-01-01', '2026-12-31')


@pytest.mark.asyncio
async def test_internal_calendar_requires_secret_but_no_model_key_or_order_switch():
    app = create_app(Settings(internal_secret='test-' * 8, api_key=''))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        assert (await client.get('/calendar/order-days?date=2026-11-07')).status_code == 401
        response = await client.get('/calendar/order-days?date=2026-11-07', headers={'X-Atlas-Internal': 'test-' * 8})
        assert response.status_code == 200
        assert response.json()['days'][0] == '2026-11-06'
