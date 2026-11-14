import { backtestWindow, validDailyDate } from './dataQuality.js'
import { validateIndicators, boundedNumber } from './indicatorValidation.js'
import { calculateConditionEvaluator, normalizeRiskSettings, strategyReadiness, validateEntryConditions } from './entryConditions.js'
export { validateIndicators } from './indicatorValidation.js'

// Historical identifiers are retained solely for explicit v1 strategy migration.
export const RULES = [
  { id: 'ma-up', indicator: 'ma', label: 'MA 단기선 > 장기선' }, { id: 'ma-down', indicator: 'ma', label: 'MA 단기선 < 장기선' },
  { id: 'ma-cross-up', indicator: 'ma', label: 'MA 골든크로스' }, { id: 'ma-cross-down', indicator: 'ma', label: 'MA 데드크로스' },
  { id: 'bb-low', indicator: 'bollinger', label: '종가 ≤ 볼린저 하단' }, { id: 'bb-high', indicator: 'bollinger', label: '종가 ≥ 볼린저 상단' },
  { id: 'volume-high', indicator: 'volume-ma', label: '거래량 > 거래량 평균' }, { id: 'volume-low', indicator: 'volume-ma', label: '거래량 < 거래량 평균' },
  { id: 'rsi-low', indicator: 'rsi', label: 'RSI ≤ 설정 하단값' }, { id: 'rsi-high', indicator: 'rsi', label: 'RSI ≥ 설정 상단값' },
  { id: 'macd-up', indicator: 'macd', label: 'MACD > 시그널선' }, { id: 'macd-down', indicator: 'macd', label: 'MACD < 시그널선' },
  { id: 'macd-cross-up', indicator: 'macd', label: 'MACD 상향 교차' }, { id: 'macd-cross-down', indicator: 'macd', label: 'MACD 하향 교차' },
]
export const DEFAULT_BACKTEST = { start: '', end: '', initialQuantity: '', quantityMode: 'fixed', entryMode: 'all', entryConditions: [], takeProfitPct: '', stopLossPct: '' }
export const BACKTEST_ASSUMPTIONS = [
  '수수료·매도세·슬리피지는 반영하지 않은 모의 계산 결과입니다. 실제 거래 결과와 차이가 있을 수 있습니다.',
  '확정 일봉 진입 조건을 다음 거래일 시가에 체결한 것으로 가정합니다. 호가단위와 체결 유동성을 복원하지 않습니다.',
  '일봉 고가·저가가 익절가와 손절가에 모두 도달하면 일봉 내 순서 불명확 · 손절 우선 가정을 적용합니다.',
  '갭으로 기준가를 넘은 청산은 실제 제공된 시가를 사용하며 종료일에 강제 매도하지 않습니다.',
]

export function validateExecutionSettings(settings, candles) {
  const initialQuantity = boundedNumber(settings?.initialQuantity, 1, Number.MAX_SAFE_INTEGER, '최초 진입 수량', true)
  if (!['fixed', 'reinvest'].includes(settings.quantityMode)) throw new Error('수량 운용 방식을 선택하세요.')
  const start = settings.start || candles?.[0]?.time || '', end = settings.end || candles?.at(-1)?.time || ''
  if (!validDailyDate(start) || !validDailyDate(end) || start > end) throw new Error('시작일과 종료일을 올바르게 선택하세요.')
  return { initialQuantity, quantityMode: settings.quantityMode, start, end }
}

export function backtestReadiness(candles, indicators, settings) {
  const errors = strategyReadiness(indicators, settings)
  try { validateExecutionSettings(settings, candles) } catch (error) { errors.push(error.message) }
  try { backtestWindow(candles, indicators, settings) } catch (error) { errors.push(error.message) }
  return [...new Set(errors)]
}

// Decimal inputs are exact rational numbers for cash, threshold comparisons and
// integer share sizing. No epsilon or display rounding changes a fill decision.
const gcd = (a, b) => { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a || 1n }
const ratio = (n, d = 1n) => { const g = gcd(n, d); return { n: n / g, d: d / g } }
function decimal(value) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e')
  const [whole, tail = ''] = mantissa.split('.')
  const scale = tail.length - Number(exponent), n = BigInt(whole + tail)
  return scale >= 0 ? ratio(n, 10n ** BigInt(scale)) : ratio(n * 10n ** BigInt(-scale))
}
const add = (a, b) => ratio(a.n * b.d + b.n * a.d, a.d * b.d)
const subtract = (a, b) => ratio(a.n * b.d - b.n * a.d, a.d * b.d)
const multiply = (a, b) => ratio(a.n * b.n, a.d * b.d)
const compare = (a, b) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0
const amount = r => { const value = Number(r.n) / Number(r.d); if (!Number.isFinite(value)) throw new Error('계산 금액이 지원 범위를 초과했습니다. 수량과 가격을 확인하세요.'); return value }
const zero = () => ratio(0n)
const tradable = bar => bar.tradable !== 0 && bar.open > 0 && bar.volume > 0

function validateBars(candles) {
  for (const c of candles) {
    if (!['open', 'high', 'low', 'close', 'volume'].every(k => Number.isFinite(c[k]) && c[k] >= 0) || c.close <= 0
      || (tradable(c) && !(c.low > 0 && c.low <= Math.min(c.open, c.close) && Math.max(c.open, c.close) <= c.high))) throw new Error('일봉 데이터의 가격 또는 거래량이 올바르지 않습니다.')
  }
}

export function runBacktest(inputCandles, indicators, settings) {
  validateIndicators(indicators)
  const conditions = validateEntryConditions(indicators, settings, { requireEntry: true }).filter(c => c.enabled)
  const risk = normalizeRiskSettings(settings, { allowIncomplete: false })
  const execution = validateExecutionSettings(settings, inputCandles)
  const window = backtestWindow(inputCandles, indicators, settings)
  const candles = window.candles
  validateBars(candles)
  const activeIds = new Set(conditions.flatMap(c => [c.indicatorId, c.right.indicatorId || c.indicatorId]))
  const evaluate = calculateConditionEvaluator(candles, indicators.filter(c => activeIds.has(c.id)))
  const first = candles.findIndex(c => c.time >= execution.start), last = candles.findLastIndex(c => c.time <= execution.end)
  const quantityRatio = q => ratio(BigInt(q))
  const tpFactor = add(ratio(1n), multiply(decimal(risk.takeProfitPct), ratio(1n, 100n)))
  const slFactor = subtract(ratio(1n), multiply(decimal(risk.stopLossPct), ratio(1n, 100n)))
  let cash = zero(), initial = null, position = null, pending = null, readyBars = 0, firstSignalDate = null, tradeId = 0
  let realized = zero(), peak = null, maxDrawdownPct = null
  const trades = [], equity = [], events = [], skippedSignals = []

  const closePosition = (bar, price, type, ambiguous = false, gap = false) => {
    const sale = multiply(price, quantityRatio(position.quantity)), pnl = subtract(sale, position.basisExact)
    cash = add(cash, sale); realized = add(realized, pnl)
    const reason = ambiguous ? '일봉 내 순서 불명확 · 손절 우선 가정' : `${gap ? '시가 갭 · ' : ''}${type === 'take-profit' ? '익절' : '손절'}`
    const { basisExact, takeProfitExact, stopLossExact, ...entry } = position
    const trade = { ...entry, exitDate: bar.time, exitPrice: amount(price), exitCost: 0, pnl: amount(pnl), returnPct: amount(pnl) / position.basis * 100, exitReason: type, exitType: type, reason, ambiguous, gap }
    trades.push(trade)
    events.push({ id: `trade-${tradeId}-exit`, tradeId, date: bar.time, time: bar.time, type, price: trade.exitPrice, quantity: position.quantity, reason, ambiguous })
    position = null
  }

  for (let i = first; i <= last; i++) {
    const bar = candles[i]
    if (pending) {
      if (!tradable(bar)) skippedSignals.push({ date: bar.time, signalDate: pending.date, reason: '다음 일봉은 거래정지 또는 거래량·시가가 없어 진입하지 않았습니다.', code: 'not_tradable' })
      else if (!position) {
        const price = decimal(bar.open)
        let quantity = execution.initialQuantity
        if (initial === null) { initial = multiply(price, quantityRatio(quantity)); cash = initial; peak = amount(initial); maxDrawdownPct = 0 }
        else if (execution.quantityMode === 'reinvest') {
          const shares = (cash.n * price.d) / (cash.d * price.n)
          if (shares > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('재투자 수량이 지원 범위를 초과했습니다.')
          quantity = Number(shares)
        }
        const basis = multiply(price, quantityRatio(quantity))
        if (quantity < 1 || compare(cash, basis) < 0) skippedSignals.push({ date: bar.time, signalDate: pending.date, reason: execution.quantityMode === 'fixed' ? '고정 수량을 매수할 현금이 부족합니다.' : '1주를 매수할 현금이 부족합니다.', code: 'insufficient_cash', availableCash: amount(cash), entryPrice: bar.open, requestedQuantity: execution.quantityMode === 'fixed' ? execution.initialQuantity : 1 })
        else {
          cash = subtract(cash, basis); tradeId++
          const tp = multiply(price, tpFactor), sl = multiply(price, slFactor)
          position = { tradeId, entryDate: bar.time, entrySignal: pending.date, entryPrice: bar.open, quantity, entryCost: 0, basis: amount(basis), takeProfitPrice: amount(tp), stopLossPrice: amount(sl), basisExact: basis, takeProfitExact: tp, stopLossExact: sl }
          events.push({ id: `trade-${tradeId}-entry`, tradeId, date: bar.time, time: bar.time, type: 'entry', price: bar.open, quantity, reason: '전일 확정 일봉 진입 조건 · 다음 거래일 시가', ambiguous: false })
        }
      }
    }
    pending = null
    if (position && tradable(bar)) {
      const open = decimal(bar.open), high = decimal(bar.high), low = decimal(bar.low)
      // Existing positions observe the gap first. New entries use that day's
      // range, without inventing an intraday ordering.
      if (position.entryDate !== bar.time && compare(open, position.stopLossExact) <= 0) closePosition(bar, open, 'stop-loss', false, true)
      else if (position.entryDate !== bar.time && compare(open, position.takeProfitExact) >= 0) closePosition(bar, open, 'take-profit', false, true)
      else {
        const stop = compare(low, position.stopLossExact) <= 0, take = compare(high, position.takeProfitExact) >= 0
        if (stop) closePosition(bar, position.stopLossExact, 'stop-loss', take)
        else if (take) closePosition(bar, position.takeProfitExact, 'take-profit')
      }
    }
    const valueExact = initial === null ? null : add(cash, position ? multiply(quantityRatio(position.quantity), decimal(bar.close)) : zero())
    const value = valueExact === null ? null : amount(valueExact)
    if (value !== null) { peak = Math.max(peak, value); maxDrawdownPct = Math.max(maxDrawdownPct, (peak - value) / peak * 100) }
    equity.push({ time: bar.time, value })
    if (!position && tradable(bar)) {
      const results = conditions.map(c => evaluate(c, i))
      if (results.every(r => r !== null)) {
        readyBars++; firstSignalDate ||= bar.time
        if ((settings.entryMode === 'any' ? results.some(Boolean) : results.every(Boolean))) pending = { side: 'buy', date: bar.time }
      }
    } else if (tradable(bar) && conditions.every(c => evaluate(c, i) !== null)) { readyBars++; firstSignalDate ||= bar.time }
  }
  if (!readyBars) throw new Error('지표 준비 기간이 부족합니다. 기간을 늘리거나 지표 기간을 줄이세요.')
  const finalEquity = equity.at(-1).value
  const lastBar = candles[last]
  let openPosition = null
  if (position) {
    const { basisExact, takeProfitExact, stopLossExact, ...entry } = position
    const pnl = subtract(multiply(quantityRatio(position.quantity), decimal(lastBar.close)), basisExact)
    openPosition = { ...entry, markDate: lastBar.time, markPrice: lastBar.close, unrealizedPnl: amount(pnl), returnPct: amount(pnl) / position.basis * 100 }
  }
  return {
    version: 2, requestedStart: execution.start, requestedEnd: execution.end, start: candles[first].time, end: lastBar.time, valuationDate: lastBar.time,
    initialCapital: initial === null ? null : amount(initial), initialQuantity: execution.initialQuantity, quantityMode: execution.quantityMode,
    finalEquity, cash: initial === null ? null : amount(cash), realizedPnl: initial === null ? null : amount(realized), unrealizedPnl: initial === null ? null : openPosition?.unrealizedPnl || 0,
    returnPct: initial === null ? null : (finalEquity - amount(initial)) / amount(initial) * 100, maxDrawdownPct,
    closedTrades: trades.length, winRate: trades.length ? trades.filter(t => t.pnl > 0).length / trades.length * 100 : null,
    entryCount: events.filter(e => e.type === 'entry').length, takeProfitCount: trades.filter(t => t.exitReason === 'take-profit').length,
    stopLossCount: trades.filter(t => t.exitReason === 'stop-loss').length, ambiguousCount: trades.filter(t => t.ambiguous).length,
    costs: 0, fees: 0, sellTax: 0, slippage: 0, trades, equity, events, skippedSignals: skippedSignals.map(s => ({ ...s, message: s.reason, reasonCode: s.code })), insufficientCashCount: skippedSignals.filter(s => s.code === 'insufficient_cash').length, readyBars, firstSignalDate, openPosition, unfilledSignal: pending,
    quality: { correctedBarsUsed: candles.filter(c => c.quality === 'corrected').length, calculationStart: candles[0].time },
    assumptions: BACKTEST_ASSUMPTIONS, coverage: window.coverage, coverageWarnings: window.coverage?.warning ? [window.coverage.warning] : [],
  }
}
