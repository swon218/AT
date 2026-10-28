"""Canonical daily indicator calculations, matching src/utils/indicators.js.

All inputs are validated, completed lab OHLCV. Never model arithmetic or live data.
"""
import math

VERSION = 'daily-indicators-v1'
NAMES = {'open': '시가', 'high': '고가', 'low': '저가', 'close': '종가', 'volume': '거래량',
         'sma': 'SMA', 'ema': 'EMA', 'rsi': 'RSI', 'volume_sma': '거래량 SMA',
         'bb_lower': '볼린저 하단', 'bb_middle': '볼린저 중심', 'bb_upper': '볼린저 상단',
         'macd': 'MACD', 'macd_signal': 'MACD 시그널', 'macd_histogram': 'MACD 히스토그램'}
OPERATORS = {'lt': '<', 'lte': '≤', 'gt': '>', 'gte': '≥', 'crosses_above': '상향 교차', 'crosses_below': '하향 교차'}


def key(m):
    if m.name in ('open', 'high', 'low', 'close', 'volume'): return m.name
    if m.name.startswith('macd'): return f'{m.name}:{m.period}:{m.slow}:{m.signal}'
    if m.name.startswith('bb_'): return f'{m.name}:{m.period}:{m.multiplier:g}'
    return f'{m.name}:{m.period}'


def label(m):
    if m.name in ('open', 'high', 'low', 'close', 'volume'): return NAMES[m.name]
    if m.name.startswith('macd'): return f'{NAMES[m.name]}({m.period}, {m.slow}, {m.signal})'
    if m.name.startswith('bb_'): return f'{NAMES[m.name]}({m.period}, {m.multiplier:g})'
    return f'{NAMES[m.name]}({m.period})'


def condition_label(c):
    right = f'{c.right.value:g}' if c.right.kind == 'constant' else label(c.right.metric)
    if c.right.factor != 1: right = f'{c.right.factor:g} × {right}'
    return f'{label(c.left)} {OPERATORS[c.operator]} {right}'


def ema(values, period):
    out = [None] * len(values)
    indices = [i for i, x in enumerate(values) if x is not None]
    if len(indices) < period: return out
    first = indices[period - 1]
    value = sum(values[i] for i in indices[:period]) / period
    out[first] = value
    for i in indices[period:]:
        value = (values[i] - value) * (2 / (period + 1)) + value
        out[i] = value
    return out


def series(candles, m):
    name, period = m.name, m.period
    if name in ('open', 'high', 'low', 'close', 'volume'): return [c[name] for c in candles]
    values = [c['volume' if name == 'volume_sma' else 'close'] for c in candles]
    out = [None] * len(values)
    if name == 'ema': return ema(values, period)
    if name.startswith('macd'):
        fast, slow = ema(values, period), ema(values, m.slow)
        macd = [a-b if a is not None and b is not None else None for a, b in zip(fast, slow)]
        signal = ema(macd, m.signal)
        if name == 'macd': return macd
        if name == 'macd_signal': return signal
        return [a-b if a is not None and b is not None else None for a, b in zip(macd, signal)]
    if name == 'rsi':
        if len(values) <= period: return out
        changes = [b-a for a, b in zip(values, values[1:])]
        gain = sum(max(0, x) for x in changes[:period]) / period
        loss = sum(max(0, -x) for x in changes[:period]) / period
        for i in range(period, len(values)):
            if i > period:
                delta = changes[i-1]
                gain = (gain * (period-1) + max(0, delta)) / period
                loss = (loss * (period-1) + max(0, -delta)) / period
            out[i] = 50.0 if gain == loss == 0 else 100.0 if loss == 0 else 100 - 100 / (1 + gain/loss)
        return out
    total = 0.0
    for i, value in enumerate(values):
        total += value
        if i >= period: total -= values[i-period]
        if i < period-1: continue
        mean = total / period
        if name in ('sma', 'volume_sma'): out[i] = mean
        elif name.startswith('bb_'):
            # Match the chart's population variance, including its nonnegative lower band.
            window = values[i-period+1:i+1]
            mean = sum(window) / period
            deviation = math.sqrt(sum((v-mean)**2 for v in window) / period) * m.multiplier
            out[i] = max(0, mean-deviation) if name == 'bb_lower' else mean+deviation if name == 'bb_upper' else mean
    return out


def warmup(m):
    if m.name in ('open', 'high', 'low', 'close', 'volume'): return 1
    if m.name == 'rsi': return m.period + 1
    if m.name.startswith('macd'): return m.slow + (m.signal-1 if m.name != 'macd' else 0)
    return m.period


def latest_pair(candles, m):
    if m.name.startswith('bb_'):
        # Screening needs two points, whereas the chart needs the whole series.
        # Use the exact same window arithmetic without O(bars * period) work.
        points = []
        for end in (len(candles)-1, len(candles)):
            window = candles[max(0, end-m.period):end]
            if len(window) < m.period:
                points.append(None); continue
            mean = sum(c['close'] for c in window) / m.period
            deviation = math.sqrt(sum((c['close']-mean)**2 for c in window) / m.period) * m.multiplier
            points.append(max(0, mean-deviation) if m.name == 'bb_lower' else mean+deviation if m.name == 'bb_upper' else mean)
        return points[1], points[0]
    points = series(candles, m)
    return points[-1], points[-2] if len(points) > 1 else None


def compare(operator, left, right, previous_left, previous_right):
    if operator == 'lt': return left < right
    if operator == 'lte': return left <= right
    if operator == 'gt': return left > right
    if operator == 'gte': return left >= right
    if previous_left is None or previous_right is None: return False
    if operator == 'crosses_above': return left > right and previous_left <= previous_right
    return left < right and previous_left >= previous_right
