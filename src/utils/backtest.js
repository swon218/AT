import { calculateBollinger, calculateEma, calculateMacd, calculateRsi, calculateSma } from './indicators.js'

export const RULES = [
  { id: 'ma-up', indicator: 'ma', label: 'MA 단기선 > 장기선' },
  { id: 'ma-down', indicator: 'ma', label: 'MA 단기선 < 장기선' },
  { id: 'ma-cross-up', indicator: 'ma', label: 'MA 골든크로스' },
  { id: 'ma-cross-down', indicator: 'ma', label: 'MA 데드크로스' },
  { id: 'bb-low', indicator: 'bollinger', label: '종가 ≤ 볼린저 하단' },
  { id: 'bb-high', indicator: 'bollinger', label: '종가 ≥ 볼린저 상단' },
  { id: 'volume-high', indicator: 'volume-ma', label: '거래량 > 거래량 평균' },
  { id: 'volume-low', indicator: 'volume-ma', label: '거래량 < 거래량 평균' },
  { id: 'rsi-low', indicator: 'rsi', label: 'RSI ≤ 설정 하단값' },
  { id: 'rsi-high', indicator: 'rsi', label: 'RSI ≥ 설정 상단값' },
  { id: 'macd-up', indicator: 'macd', label: 'MACD > 시그널선' },
  { id: 'macd-down', indicator: 'macd', label: 'MACD < 시그널선' },
  { id: 'macd-cross-up', indicator: 'macd', label: 'MACD 상향 교차' },
  { id: 'macd-cross-down', indicator: 'macd', label: 'MACD 하향 교차' },
]
export const DEFAULT_BACKTEST = { initialCapital: 10_000_000, feePct: 0.015, taxPct: 0.2, slippagePct: 0.05, entryMode: 'all', exitMode: 'any', entry: [], exit: [], start: '', end: '' }

function number(value, min, max, name, integer = false) {
  if (value === '' || value == null || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max || (integer && !Number.isInteger(Number(value)))) throw new Error(`${name}: ${min}~${max}${integer ? ' 정수' : ''} 값을 입력하세요.`)
  return Number(value)
}

export function validateIndicators(indicators) {
  if (!Array.isArray(indicators) || indicators.length > 5 || new Set(indicators.map(i => i.id)).size !== indicators.length) throw new Error('지표 조합을 확인하세요.')
  const period = (v, name) => number(v, 1, 500, name, true)
  for (const c of indicators) {
    if (c.id === 'ma') {
      period(c.shortPeriod, 'MA 단기 기간'); period(c.longPeriod, 'MA 장기 기간')
      if (c.shortPeriod >= c.longPeriod || !['SMA', 'EMA'].includes(c.type)) throw new Error('MA 단기 기간은 장기 기간보다 작아야 합니다.')
    } else if (c.id === 'bollinger') { period(c.period, '볼린저 기간'); number(c.multiplier, 0.1, 10, '표준편차 배수') }
    else if (c.id === 'volume-ma') period(c.period, '거래량 평균 기간')
    else if (c.id === 'rsi') {
      period(c.period, 'RSI 기간'); number(c.lower, 0, 100, 'RSI 하단'); number(c.upper, 0, 100, 'RSI 상단')
      if (c.lower >= c.upper) throw new Error('RSI 하단은 상단보다 작아야 합니다.')
    } else if (c.id === 'macd') {
      period(c.fast, 'MACD 단기'); period(c.slow, 'MACD 장기'); period(c.signal, 'MACD 시그널')
      if (c.fast >= c.slow) throw new Error('MACD 단기 기간은 장기 기간보다 작아야 합니다.')
    } else throw new Error('지원하지 않는 지표입니다.')
  }
}

const pointMap = points => new Map(points.map(p => [p.time, p.value]))
function signals(candles, indicators) {
  const byId = Object.fromEntries(indicators.map(c => [c.id, c]))
  const values = {}
  for (const c of indicators) {
    if (c.id === 'ma') {
      const fn = c.type === 'EMA' ? calculateEma : calculateSma
      values.maShort = pointMap(fn(candles, Number(c.shortPeriod)))
      values.maLong = pointMap(fn(candles, Number(c.longPeriod)))
    }
    if (c.id === 'bollinger') {
      const bands = calculateBollinger(candles, Number(c.period), Number(c.multiplier))
      values.bbLow = pointMap(bands.lower); values.bbHigh = pointMap(bands.upper)
    }
    if (c.id === 'volume-ma') values.volume = pointMap(calculateSma(candles, Number(c.period), 'volume'))
    if (c.id === 'rsi') values.rsi = pointMap(calculateRsi(candles, Number(c.period)))
    if (c.id === 'macd') {
      const m = calculateMacd(candles, Number(c.fast), Number(c.slow), Number(c.signal))
      values.macd = pointMap(m.macd); values.signal = pointMap(m.signal)
    }
  }
  return (id, index) => {
    const bar = candles[index]
    const at = (name, offset = 0) => values[name]?.get(candles[index + offset]?.time)
    const compare = (left, right, above, cross) => {
      const a = at(left), b = at(right)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null
      if (!cross) return above ? a > b : a < b
      const pa = at(left, -1), pb = at(right, -1)
      if (!Number.isFinite(pa) || !Number.isFinite(pb)) return null
      return above ? a > b && pa <= pb : a < b && pa >= pb
    }
    if (id.startsWith('ma-')) return compare('maShort', 'maLong', id.endsWith('up'), id.includes('cross'))
    if (id.startsWith('macd-')) return compare('macd', 'signal', id.endsWith('up'), id.includes('cross'))
    const [value, outcome] = id === 'bb-low' ? [at('bbLow'), bar.close <= at('bbLow')]
      : id === 'bb-high' ? [at('bbHigh'), bar.close >= at('bbHigh')]
        : id === 'volume-high' ? [at('volume'), bar.volume > at('volume')]
          : id === 'volume-low' ? [at('volume'), bar.volume < at('volume')]
            : id === 'rsi-low' ? [at('rsi'), at('rsi') <= byId.rsi?.lower]
              : [at('rsi'), at('rsi') >= byId.rsi?.upper]
    return Number.isFinite(value) ? outcome : null
  }
}

export function runBacktest(candles, indicators, settings) {
  validateIndicators(indicators)
  if (!Array.isArray(candles) || candles.length < 2 || candles.length > 2000) throw new Error('백테스트에 필요한 일봉이 부족합니다.')
  candles.forEach((c, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.time) || (i && candles[i - 1].time >= c.time)
      || !['open', 'high', 'low', 'close', 'volume'].every(k => Number.isFinite(c[k]) && c[k] >= 0) || c.close <= 0
      || (c.tradable !== 0 && c.volume > 0 && c.open > 0 && !(c.low <= Math.min(c.open, c.close) && Math.max(c.open, c.close) <= c.high))) throw new Error('일봉 데이터의 날짜 또는 가격이 올바르지 않습니다.')
  })
  const initial = number(settings.initialCapital, 1_000, 10_000_000_000, '초기 자금')
  const fee = number(settings.feePct, 0, 5, '수수료') / 100
  const tax = number(settings.taxPct, 0, 5, '매도세') / 100
  const slip = number(settings.slippagePct, 0, 5, '슬리피지') / 100
  for (const side of ['entry', 'exit']) {
    if (!Array.isArray(settings[side]) || !settings[side].length || settings[side].length > RULES.length) throw new Error('매수·매도 조건을 각각 한 개 이상 선택하세요.')
    if (!['all', 'any'].includes(settings[`${side}Mode`])) throw new Error('조건 조합 방식을 확인하세요.')
    for (const id of settings[side]) {
      const rule = RULES.find(r => r.id === id)
      if (!rule || !indicators.some(c => c.id === rule.indicator)) throw new Error('조건에 필요한 지표를 오른쪽에서 추가하세요.')
    }
  }
  const start = settings.start || candles[0].time, end = settings.end || candles.at(-1).time
  if (start > end || start < candles[0].time || end > candles.at(-1).time) throw new Error('수집된 기간 안에서 시작일과 종료일을 선택하세요.')
  const evaluate = signals(candles, indicators)
  const used = [...new Set([...settings.entry, ...settings.exit])]
  const first = candles.findIndex(c => c.time >= start)
  const last = candles.findLastIndex(c => c.time <= end)
  if (last - first < 1) throw new Error('선택한 기간에 최소 두 개의 일봉이 필요합니다.')
  let cash = initial, position = null, pending = null, peak = initial, drawdown = 0, costs = 0, readyBars = 0, firstSignalDate = null
  const trades = [], equity = []
  const tradeable = c => c.tradable !== 0 && c.open > 0 && c.volume > 0
  for (let i = first; i <= last; i += 1) {
    const bar = candles[i]
    // The previous close's signal executes at the next bar's open. Suspensions
    // cancel pending orders rather than filling at invented prices.
    if (pending && tradeable(bar)) {
      if (pending.side === 'buy' && !position) {
        const price = bar.open * (1 + slip)
        const quantity = Math.floor(cash / (price * (1 + fee)))
        if (quantity > 0) {
          const cost = quantity * price * fee
          position = { entryDate: bar.time, entrySignal: pending.date, entryPrice: price, quantity, entryCost: cost, basis: quantity * price + cost }
          cash -= position.basis; costs += cost
        }
      } else if (pending.side === 'sell' && position) {
        const price = bar.open * (1 - slip), gross = position.quantity * price, cost = gross * (fee + tax)
        const pnl = gross - cost - position.basis
        cash += gross - cost; costs += cost
        trades.push({ ...position, exitDate: bar.time, exitSignal: pending.date, exitPrice: price, exitCost: cost, pnl, returnPct: pnl / position.basis * 100 })
        position = null
      }
    }
    pending = null
    const value = cash + (position ? position.quantity * bar.close : 0)
    peak = Math.max(peak, value); drawdown = Math.max(drawdown, (peak - value) / peak * 100)
    equity.push({ time: bar.time, value })
    const ready = used.every(id => evaluate(id, i) !== null)
    if (ready && tradeable(bar)) {
      readyBars += 1; firstSignalDate ||= bar.time
      const side = position ? 'exit' : 'entry'
      const results = settings[side].map(id => evaluate(id, i))
      if (settings[`${side}Mode`] === 'all' ? results.every(Boolean) : results.some(Boolean)) pending = { side: position ? 'sell' : 'buy', date: bar.time }
    }
  }
  if (!readyBars) throw new Error('지표 준비 기간이 부족합니다. 기간을 늘리거나 지표 기간을 줄이세요.')
  const finalEquity = equity.at(-1).value
  return { start: candles[first].time, end: candles[last].time, initialCapital: initial, finalEquity,
    returnPct: (finalEquity / initial - 1) * 100, maxDrawdownPct: drawdown,
    closedTrades: trades.length, winRate: trades.length ? trades.filter(t => t.pnl > 0).length / trades.length * 100 : null,
    costs, trades, equity, readyBars, firstSignalDate,
    openPosition: position ? { ...position, markPrice: candles[last].close, unrealizedPnl: position.quantity * candles[last].close - position.basis } : null,
    unfilledSignal: pending,
  }
}
