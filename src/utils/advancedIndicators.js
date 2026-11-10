// Aligned series: each index is a candle, null means unavailable. Invalid bars
// reset recursive state and rolling windows instead of bridging a data gap.
const valid = Number.isFinite
const priceBar = c => c.quality !== 'quarantined' && [c.high, c.low, c.close].every(x => valid(x) && x > 0)
  && c.low <= c.close && c.close <= c.high
const volumeBar = c => priceBar(c) && valid(c.volume) && c.volume >= 0
const safe = x => valid(x) ? x : null
const windowValue = (values, period, reduce) => values.map((_, i) => {
  if (i + 1 < period) return null
  const window = values.slice(i + 1 - period, i + 1)
  return window.every(valid) ? safe(reduce(window)) : null
})
const sum = values => values.reduce((total, x) => total + x, 0)
const mean = values => sum(values) / values.length
function smooth(values, period, alpha) {
  let total = 0, count = 0, previous = null
  return values.map(value => {
    if (!valid(value)) { total = 0; count = 0; previous = null; return null }
    if (count < period) {
      total += value
      if (++count === period) previous = safe(total / period)
    } else if (previous !== null) previous = safe(previous + alpha * (value - previous))
    return previous
  })
}
const rma = (values, period) => smooth(values, period, 1 / period)
function movingSum(values, period) {
  let total = 0, count = 0, nonzero = 0
  return values.map((value, i) => {
    if (!valid(value)) { total = 0; count = 0; nonzero = 0; return null }
    total += value
    nonzero += Number(value !== 0)
    if (++count > period) {
      total -= values[i - period]
      nonzero -= Number(values[i - period] !== 0)
    }
    if (!nonzero) total = 0
    return count >= period ? safe(total) : null
  })
}
const sma = (values, period) => movingSum(values, period).map(value => value === null ? null : value / period)
const tr = (c, prev) => Math.max(c.high - c.low, prev ? Math.abs(c.high - prev.close) : 0, prev ? Math.abs(c.low - prev.close) : 0)
const prior = (bars, i, predicate) => i > 0 && predicate(bars[i - 1]) ? bars[i - 1] : null

function atr(bars, period) {
  return rma(bars.map((c, i) => priceBar(c) ? tr(c, prior(bars, i, priceBar)) : null), period)
}

function dmi(bars, period, adxPeriod) {
  const moves = bars.map((c, i) => {
    const prev = prior(bars, i, priceBar)
    if (!prev || !priceBar(c)) return [null, null, null]
    const up = c.high - prev.high, down = prev.low - c.low
    return [tr(c, prev), up > 0 && up > down ? up : 0, down > 0 && down > up ? down : 0]
  })
  const [ranges, up, down] = [0, 1, 2].map(j => rma(moves.map(row => row[j]), period))
  const di = values => values.map((x, i) => !valid(x) || !valid(ranges[i]) ? null : ranges[i] === 0 ? 0 : safe(100 * (x / ranges[i])))
  const plus = di(up), minus = di(down)
  const dx = plus.map((x, i) => {
    const y = minus[i]
    return !valid(x) || !valid(y) ? null : x + y === 0 ? 0 : 100 * (Math.abs(x - y) / (x + y))
  })
  return { adx: rma(dx, adxPeriod), plus_di: plus, minus_di: minus }
}

function stochastic(bars, period, kPeriod, dPeriod) {
  const raw = bars.map((c, i) => {
    if (i + 1 < period) return null
    const window = bars.slice(i + 1 - period, i + 1)
    if (!window.every(priceBar)) return null
    const high = Math.max(...window.map(b => b.high)), low = Math.min(...window.map(b => b.low))
    return high === low ? null : 100 * ((c.close - low) / (high - low))
  })
  const k = sma(raw, kPeriod)
  return { stoch_k: k, stoch_d: sma(k, dPeriod) }
}

function obv(bars, period, type) {
  let value = null
  const points = bars.map((c, i) => {
    const prev = prior(bars, i, volumeBar)
    if (!volumeBar(c)) value = null
    else if (!prev) value = 0
    else if (value !== null) value = safe(value + Math.sign(c.close - prev.close) * c.volume)
    return value
  })
  return { obv: points, obv_ma: type === 'EMA' ? smooth(points, period, 2 / (period + 1)) : sma(points, period) }
}

const hlc3 = c => c.high / 3 + c.low / 3 + c.close / 3
function mfi(bars, period) {
  const flows = bars.map((c, i) => {
    const prev = prior(bars, i, volumeBar)
    if (!prev || !volumeBar(c)) return null
    return safe(Math.sign(hlc3(c) - hlc3(prev)) * hlc3(c) * c.volume)
  })
  const positive = movingSum(flows.map(v => v === null ? null : Math.max(0, v)), period)
  const negative = movingSum(flows.map(v => v === null ? null : Math.max(0, -v)), period)
  return positive.map((p, i) => {
    const n = negative[i]
    return p === null || n === null || !valid(p + n) || p + n <= 0 ? null : 100 * (p / (p + n))
  })
}

function supertrend(bars, period, multiplier) {
  const directions = [], flips = []
  let upper = null, lower = null, direction = null
  const values = atr(bars, period).map((range, i) => {
    const c = bars[i], prev = bars[i - 1], previousDirection = direction
    const center = c.high / 2 + c.low / 2
    const high = center + multiplier * range, low = center - multiplier * range
    if (!valid(range) || !valid(high) || !valid(low)) {
      upper = lower = direction = null; directions.push(null); flips.push(null); return null
    }
    upper = upper === null || high < upper || prev.close > upper ? high : upper
    lower = lower === null || low > lower || prev.close < lower ? low : lower
    direction = previousDirection === null ? -1 : previousDirection === -1 ? (c.close > upper ? 1 : -1) : (c.close < lower ? -1 : 1)
    directions.push(direction)
    flips.push(previousDirection !== null && direction !== previousDirection ? direction : 0)
    return direction === 1 ? lower : upper
  })
  return { supertrend: values, supertrend_direction: directions, supertrend_flip: flips }
}

export function advancedSeries(bars, config) {
  const { id, period } = config
  switch (id) {
    case 'atr': {
      const values = atr(bars, period)
      return { atr: values, atr_percent: values.map((v, i) => valid(v) ? safe(100 * (v / bars[i].close)) : null) }
    }
    case 'dmi': return dmi(bars, period, config.adxPeriod)
    case 'stochastic': return stochastic(bars, period, config.kPeriod, config.dPeriod)
    case 'obv': return obv(bars, config.maPeriod, config.maType)
    case 'mfi': return { mfi: mfi(bars, period) }
    case 'cci': return { cci: windowValue(bars.map(c => priceBar(c) ? (config.source === 'close' ? c.close : hlc3(c)) : null), period, window => {
      const average = mean(window), deviation = mean(window.map(x => Math.abs(x - average)))
      return deviation === 0 ? null : (window.at(-1) - average) / (0.015 * deviation)
    }) }
    case 'supertrend': return supertrend(bars, period, config.multiplier)
    default: throw new Error('지원하지 않는 지표입니다.')
  }
}
