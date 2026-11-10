"""Aligned ATR, DMI, stochastic, OBV, MFI, CCI and Supertrend calculations."""
from collections import deque
import math


def finite(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def safe(x):
    return x if finite(x) else None


def price_bar(c):
    return (c.get('quality') != 'quarantined' and all(finite(c.get(k)) and c[k] > 0 for k in ('high', 'low', 'close'))
            and c['low'] <= c['close'] <= c['high'])


def volume_bar(c):
    return price_bar(c) and finite(c.get('volume')) and c['volume'] >= 0


def smooth(values, period, alpha):
    total, count, previous = 0.0, 0, None
    out = []
    for value in values:
        if value is None:
            total, count, previous = 0.0, 0, None
        elif count < period:
            total += value
            count += 1
            if count == period:
                previous = safe(total / period)
        elif previous is not None:
            previous = safe(previous + alpha * (value - previous))
        out.append(previous)
    return out


def rma(values, period):
    return smooth(values, period, 1 / period)


def moving_sum(values, period):
    total, count, nonzero = 0.0, 0, 0
    for i, value in enumerate(values):
        if value is None:
            total, count, nonzero = 0.0, 0, 0
        else:
            total += value
            count += 1
            nonzero += value != 0
            if count > period:
                total -= values[i-period]
                nonzero -= values[i-period] != 0
            if not nonzero: total = 0.0
        yield safe(total) if count >= period else None


def sma(values, period):
    return [None if x is None else x / period for x in moving_sum(values, period)]


def true_range(c, prev):
    span = c['high'] - c['low']
    return max(span, abs(c['high']-prev['close']), abs(c['low']-prev['close'])) if prev else span


def atr(bars, period):
    values, prev = [], None
    for c in bars:
        valid = price_bar(c)
        values.append(true_range(c, prev) if valid else None)
        prev = c if valid else None
    return rma(values, period)


def dmi(bars, period, adx_period):
    ranges, ups, downs, prev = [], [], [], None
    for c in bars:
        valid = price_bar(c)
        if valid and prev:
            up, down = c['high'] - prev['high'], prev['low'] - c['low']
            ranges.append(true_range(c, prev))
            ups.append(up if up > 0 and up > down else 0)
            downs.append(down if down > 0 and down > up else 0)
        else:
            ranges.append(None); ups.append(None); downs.append(None)
        prev = c if valid else None
    ranges = rma(ranges, period)
    def di(values):
        return [None if x is None or y is None else 0 if y == 0 else safe(100 * (x/y))
                for x, y in zip(rma(values, period), ranges)]
    plus, minus = di(ups), di(downs)
    dx = [None if x is None or y is None else 0 if x+y == 0 else 100 * (abs(x-y)/(x+y))
          for x, y in zip(plus, minus)]
    return {'adx': rma(dx, adx_period), 'plus_di': plus, 'minus_di': minus}


def stochastic(bars, period, k_period, d_period):
    highs, lows = deque(), deque()
    raw, count = [], 0
    for i, c in enumerate(bars):
        if not price_bar(c):
            highs.clear(); lows.clear(); count = 0; raw.append(None)
            continue
        count += 1
        while highs and (highs[-1][1] <= c['high']): highs.pop()
        while lows and (lows[-1][1] >= c['low']): lows.pop()
        highs.append((i, c['high'])); lows.append((i, c['low']))
        if highs[0][0] <= i-period: highs.popleft()
        if lows[0][0] <= i-period: lows.popleft()
        high, low = highs[0][1], lows[0][1]
        raw.append(None if count < period or high == low else 100 * ((c['close']-low)/(high-low)))
    k = sma(raw, k_period)
    return {'stoch_k': k, 'stoch_d': sma(k, d_period)}


def obv(bars, period, average_type):
    value, prev, out = None, None, []
    for c in bars:
        valid = volume_bar(c)
        if not valid:
            value = None
        elif prev is None:
            value = 0
        elif value is not None:
            direction = 1 if c['close'] > prev['close'] else -1 if c['close'] < prev['close'] else 0
            value = safe(value + direction * c['volume'])
        out.append(value)
        prev = c if valid else None
    average = smooth(out, period, 2 / (period + 1)) if average_type == 'EMA' else sma(out, period)
    return {'obv': out, 'obv_ma': average}


def hlc3(c):
    return c['high']/3 + c['low']/3 + c['close']/3


def mfi(bars, period):
    prev, positive, negative = None, [], []
    for c in bars:
        price = hlc3(c) if volume_bar(c) else None
        direction = 0 if price is None or prev is None else 1 if price > prev else -1 if price < prev else 0
        flow = None if price is None or prev is None else safe(direction * price * c['volume'])
        positive.append(None if flow is None else max(0, flow))
        negative.append(None if flow is None else max(0, -flow))
        prev = price
    return [None if p is None or n is None or p+n <= 0 or not finite(p+n) else 100 * (p/(p+n))
            for p, n in zip(moving_sum(positive, period), moving_sum(negative, period))]


def cci(bars, period, source):
    values = [None if not price_bar(c) else c['close'] if source == 'close' else hlc3(c) for c in bars]
    out = [None] * len(bars)
    for i in range(period-1, len(bars)):
        window = values[i+1-period:i+1]
        if None in window: continue
        avg = sum(window)/period
        dev = sum(abs(x-avg) for x in window)/period
        denominator = 0.015*dev
        if denominator > 0 and finite(denominator): out[i] = safe((values[i]-avg)/denominator)
    return out


def supertrend(bars, period, multiplier):
    upper = lower = direction = None
    values, directions, flips = [], [], []
    for i, value in enumerate(atr(bars, period)):
        c, old = bars[i], direction
        if value is not None:
            center = c['high']/2 + c['low']/2
            high, low = safe(center + multiplier*value), safe(center - multiplier*value)
        if value is None or high is None or low is None:
            upper = lower = direction = None
            values.append(None); directions.append(None); flips.append(None)
            continue
        upper = high if upper is None or high < upper or bars[i-1]['close'] > upper else upper
        lower = low if lower is None or low > lower or bars[i-1]['close'] < lower else lower
        if old is None: direction = -1
        elif old == -1: direction = 1 if c['close'] > upper else -1
        else: direction = -1 if c['close'] < lower else 1
        values.append(lower if direction == 1 else upper)
        directions.append(direction)
        flips.append(direction if old is not None and direction != old else 0)
    return {'supertrend': values, 'supertrend_direction': directions, 'supertrend_flip': flips}


def series(bars, metric):
    name, period = metric.name, metric.period
    if name in ('atr', 'atr_percent'):
        out = atr(bars, period)
        return out if name == 'atr' else [None if v is None else safe(100 * (v / c['close'])) for v, c in zip(out, bars)]
    if name in ('adx', 'plus_di', 'minus_di'):
        return dmi(bars, period, metric.adx_period or 14)[name]
    if name in ('stoch_k', 'stoch_d'):
        return stochastic(bars, period, metric.k_smoothing, metric.d_smoothing or 3)[name]
    if name in ('obv', 'obv_ma'):
        return obv(bars, period or 1, metric.average_type)[name]
    if name == 'mfi': return mfi(bars, period)
    if name == 'cci': return cci(bars, period, metric.source)
    return supertrend(bars, period, metric.atr_multiplier)[name]
