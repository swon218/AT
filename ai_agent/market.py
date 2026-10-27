from datetime import datetime, timedelta, timezone
from functools import lru_cache
from exchange_calendars.exchange_calendar_xkrx import XKRXExchangeCalendar
import pandas as pd
from .krx_closures import CLOSURES, VERSION

KST = timezone(timedelta(hours=9))


class ReviewedXKRX(XKRXExchangeCalendar):
    @property
    def adhoc_holidays(self):
        return list(pd.DatetimeIndex(super().adhoc_holidays).union(pd.DatetimeIndex(list(CLOSURES))))


@lru_cache(maxsize=1)
def calendar():
    return ReviewedXKRX(start='2000-01-01', end='2027-12-31')


def market_context(now, through):
    day = now.astimezone(KST).date().isoformat()
    if day > through or day < '2001-01-01':
        raise ValueError('calendar_unverified')
    cal = calendar()
    target = cal.date_to_session(day, direction='next')
    previous = cal.previous_session(target)
    opening = cal.session_open(target).to_pydatetime()
    prev_close = cal.session_close(previous).to_pydatetime()
    # On a holiday/weekend the target is the next session; only material already published is available.
    latest = target if now >= cal.session_close(target).to_pydatetime() else previous
    if now < prev_close:
        latest = cal.previous_session(previous)
    return {'now': now.isoformat(), 'timezone': 'Asia/Seoul', 'session': str(target.date()),
            'is_trading_day': cal.is_session(day), 'latest_completed': str(latest.date()),
            'overnight': {'start': prev_close.astimezone(KST).isoformat(), 'end': min(now, opening).astimezone(KST).isoformat()},
            'today': {'start': now.astimezone(KST).replace(hour=0, minute=0, second=0, microsecond=0).isoformat(), 'end': now.isoformat()},
            'market_open': opening.astimezone(KST).isoformat(), 'calendar_source': 'exchange_calendars:XKRX:4.13.2+' + VERSION,
            'calendar_verified_through': through,
            'warning': '정규장 달력 기준. 임시 휴장/일정 변경은 운영자가 확인해야 합니다.'}


@lru_cache(maxsize=128)
def expected_sessions(start, end):
    return [str(s.date()) for s in calendar().sessions_in_range(pd.Timestamp(start), pd.Timestamp(end))]


def wilder_rsi(closes, period=14):
    if len(closes) <= period:
        raise ValueError('insufficient_warmup')
    changes = [b - a for a, b in zip(closes, closes[1:])]
    gain = sum(max(0, x) for x in changes[:period]) / period
    loss = sum(max(0, -x) for x in changes[:period]) / period
    for value in changes[period:]:
        gain = (gain * (period - 1) + max(0, value)) / period
        loss = (loss * (period - 1) + max(0, -value)) / period
    return 50.0 if gain == loss == 0 else 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)
