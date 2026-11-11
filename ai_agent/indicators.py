"""Canonical daily indicator calculations, matching src/utils/indicators.js.

All inputs are validated, completed lab OHLCV. Never model arithmetic or live data.
"""
import math
from . import advanced_indicators
from .screen_models import AdvancedMetric
from .screen_semantics import metric_spec, ratio_comparison, percent

VERSION = 'daily-indicators-v2'
NAMES = {'open': '시가', 'high': '고가', 'low': '저가', 'close': '종가', 'volume': '거래량',
         'sma': 'SMA', 'ema': 'EMA', 'rsi': 'RSI', 'volume_sma': '거래량 SMA',
         'bb_lower': '볼린저 하단', 'bb_middle': '볼린저 중심', 'bb_upper': '볼린저 상단',
         'macd': 'MACD', 'macd_signal': 'MACD 시그널', 'macd_histogram': 'MACD 히스토그램',
         'atr': 'ATR', 'atr_percent': 'ATR%', 'adx': 'ADX', 'plus_di': '+DI', 'minus_di': '−DI',
         'stoch_k': '스토캐스틱 K', 'stoch_d': '스토캐스틱 D', 'obv': 'OBV', 'obv_ma': 'OBV 평균',
         'mfi': 'MFI', 'cci': 'CCI', 'supertrend': '슈퍼트렌드', 'supertrend_direction': '슈퍼트렌드 방향',
         'supertrend_flip': '슈퍼트렌드 전환'}
NAMES.update({name: metric_spec(name)['title'] for name in NAMES})
OPERATORS = {'lt': '미만 (<)', 'lte': '이하 (≤)', 'gt': '초과 (>)', 'gte': '이상 (≥)', 'crosses_above': '상향 돌파', 'crosses_below': '하향 돌파', 'eq': '상태 일치'}


def key(m):
    if isinstance(m, AdvancedMetric):
        return ':'.join(str(v) for v in m.model_dump(exclude_none=True).values())
    if m.name in ('open', 'high', 'low', 'close', 'volume'): return m.name
    if m.name.startswith('macd'): return f'{m.name}:{m.period}:{m.slow}:{m.signal}'
    if m.name.startswith('bb_'): return f'{m.name}:{m.period}:{m.multiplier:g}'
    return f'{m.name}:{m.period}'


def label(m):
    if isinstance(m, AdvancedMetric):
        settings = [f'기간 {m.period}봉'] if m.period is not None else []
        if m.adx_period is not None: settings.append(f'ADX 평활 {m.adx_period}봉')
        if m.k_smoothing is not None: settings.append(f'K 평활 {m.k_smoothing}봉')
        if m.d_smoothing is not None: settings.append(f'D 평활 {m.d_smoothing}봉')
        if m.average_type is not None: settings.append(f'OBV 평균 종류 {m.average_type}')
        if m.source is not None: settings.append(f'가격 소스 {m.source}')
        if m.atr_multiplier is not None: settings.append(f'ATR 배수 {m.atr_multiplier:g}배')
        return NAMES[m.name] + (f'({", ".join(settings)})' if settings else '')
    if m.name in ('open', 'high', 'low', 'close', 'volume'): return NAMES[m.name]
    if m.name in ('sma', 'ema', 'volume_sma'): return f'{m.period}봉 {NAMES[m.name]}'
    if m.name.startswith('macd'): return f'{NAMES[m.name]}({m.period}, {m.slow}, {m.signal}봉)'
    if m.name.startswith('bb_'): return f'{NAMES[m.name]}({m.period}봉, {m.multiplier:g}배)'
    return f'{NAMES[m.name]}({m.period}봉)'


def condition_label(c):
    spec = metric_spec(c.left.name)
    if 'states' in spec:
        right = spec['states'][str(int(c.right.value))]
    elif c.right.kind == 'constant':
        right = f'{c.right.value:g} {spec["unit"]}'
    elif ratio_comparison(c.left.name, c.right.metric.name):
        right = f'{label(c.right.metric)}의 {percent(c.right.factor):g}%'
    else:
        right = label(c.right.metric)
        if c.right.factor != 1:
            right += f' × {c.right.factor:g} (고급 배수)'
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
    if isinstance(m, AdvancedMetric): return advanced_indicators.series(candles, m)
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
    if isinstance(m, AdvancedMetric):
        if m.name == 'obv': return 1
        if m.name in ('plus_di', 'minus_di', 'mfi'): return m.period + 1
        if m.name == 'adx': return m.period + m.adx_period
        if m.name.startswith('stoch_'): return m.period + m.k_smoothing - 1 + ((m.d_smoothing or 1) - 1)
        return m.period
    if m.name in ('open', 'high', 'low', 'close', 'volume'): return 1
    if m.name == 'rsi': return m.period + 1
    if m.name.startswith('macd'): return m.slow + (m.signal-1 if m.name != 'macd' else 0)
    return m.period


def latest_pair(candles, m):
    if not candles: return None, None
    if isinstance(m, AdvancedMetric) and m.name == 'cci':
        candles = candles[-(m.period+1):]
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


def metric_unit(name):
    return metric_spec(name)['unit']


def compare(operator, left, right, previous_left, previous_right):
    if operator == 'eq': return left == right
    if operator == 'lt': return left < right
    if operator == 'lte': return left <= right
    if operator == 'gt': return left > right
    if operator == 'gte': return left >= right
    if previous_left is None or previous_right is None: return False
    if operator == 'crosses_above': return left > right and previous_left <= previous_right
    return left < right and previous_left >= previous_right
