import { validateIndicators } from '../src/utils/indicatorValidation.js'
import { calculateConditionEvaluator, normalizeRiskSettings, validateEntryConditions } from '../src/utils/entryConditions.js'
import { backtestWindow, validDailyDate } from '../src/utils/dataQuality.js'

export const TRADING_POLICY = Object.freeze({ version: 'krx-cash-v1', openingWindowSeconds: 60, entryTimeoutSeconds: 60, quoteMaxAgeSeconds: 30, cashBufferBps: 150, costs: 'unconfirmed', entryOrder: 'KRX 현금 지정가 · 60초 후 잔량 취소 확인', exitOrder: 'KRX 현금 시장가', priority: '실행 시작 시 관심종목 순서 · 실행 시각 · 실행 ID' })
export const TRADING_STATES = Object.freeze({ waiting_signal: '신호 대기', waiting_funds: '자금 부족 대기', buying: '매수 접수·미체결', holding: '보유 중', selling: '매도 접수·미체결', closed: '청산 완료', stopping: '정지 처리 중 · 보유분 관리 중', stopped: '정지', completed: '실행 완료', unknown: '접수 결과 불명확', connection_required: '연결 확인 필요 · 자동 보호 불가', reconciliation_required: '계좌 정합성 확인 필요', paused: '서버 실행 비활성' })
export const tradingTerminal = status => ['stopped', 'completed'].includes(status)
export const tradingReason = Object.freeze({ disabled: '서버 실행이 비활성 상태입니다.', calendar_unavailable: '검증된 KRX 거래시간을 확인할 수 없습니다.', market_closed: 'KRX 정규장 시작을 기다립니다.', missed_open: '지난 개장 진입 기회를 따라 매수하지 않고 다음 신호를 기다립니다.', signal_unmet: '확정 일봉의 진입 조건이 충족되지 않았습니다.', daily_unavailable: '확정 일봉 또는 지표 준비 데이터를 확인할 수 없습니다.', cash_insufficient: '저장한 수량을 매수할 주문가능 현금이 부족합니다.', quote_unavailable: '실행 정책에 맞는 최신 시세를 확인할 수 없습니다.', external_conflict: '외부 보유·주문과 실행 기록의 정합성을 확인해 주세요.', credentials_changed: '개인 API가 삭제·변경되어 자동 보호를 계속할 수 없습니다.', watchlist_removed: '관심종목에서 삭제되어 신규 진입이 중단됐습니다.', order_unknown: '주문 접수 결과를 확정할 수 없어 재전송하지 않습니다.', protection_stopped: '자동 보호가 중단됐습니다. 남은 주식은 계좌에 있습니다.', waiting_fill: '증권사 체결·취소 결과를 확인 중입니다.', lease_lost: '다른 실행자의 소유권 확인 전에는 주문을 보내지 않습니다.', execution_policy_mismatch:'저장된 실행 정책을 확인할 수 없어 주문을 중단했습니다.', trading_toss_order_id_missing:'토스 주문 접수 번호를 확인할 수 없어 재전송하지 않습니다. 증권사 주문 내역 대조가 필요합니다.', trading_toss_cancel_rejected:'토스가 취소 요청을 거부했습니다. 원주문과 체결 상태를 확인해야 합니다.', trading_reconciliation_incomplete:'증권사의 주문·체결 상태를 모두 확인하지 못했습니다.' })

export function tradingReadiness(strategy, entryAction) {
  const issues = [], indicators = strategy?.indicators, settings = strategy?.backtest_settings
  let conditions = []
  try { if (Number(strategy?.schema_version ?? strategy?.definition_version) !== 2) throw new Error('전략 V2로 저장한 전략을 선택해 주세요.'); validateIndicators(indicators) } catch (error) { issues.push(error.message) }
  try { conditions = validateEntryConditions(indicators || [], settings, { requireEntry: false }) } catch (error) { issues.push(error.message) }
  try {
    const risk = normalizeRiskSettings(settings, { allowIncomplete: false })
    try { Object.values(risk).forEach(moneyMicros) } catch { throw new Error('자동매매 익절·손절 비율은 소수점 6자리 이내로 입력해 주세요.') }
  } catch (error) { issues.push(error.message) }
  const hasEntry = conditions.some(c => c.enabled)
  if (hasEntry && entryAction !== 'signal') issues.push('지표 진입 전략은 확정 일봉 신호 방식으로 실행해 주세요.')
  if (!hasEntry && !['once', 'manage'].includes(entryAction)) issues.push('익절·손절 전용 전략의 최초 동작을 선택해 주세요.')
  return { ready: issues.length === 0, issues, hasEntry, riskOnly: !hasEntry }
}

export function validateTradingSpec(input, strategy) {
  const code = String(input?.code || '')
  if (!/^[0-9][0-9A-Z]{5}$/.test(code) || !['kiwoom', 'toss', 'nh', 'kb'].includes(input?.broker)) throw new Error('종목과 증권사를 확인해 주세요.')
  if (typeof input.accountRef !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(input.accountRef)) throw new Error('검증된 본인 계좌를 선택해 주세요.')
  if (input.strategyId !== strategy?.id || Number(input.strategyRevision) !== Number(strategy?.revision)) throw new Error('저장 전략이 변경됐습니다. 다시 선택해 주세요.')
  if (!['fixed', 'all_cash'].includes(input.quantityMode)) throw new Error('수량 운용 방식을 선택해 주세요.')
  const quantity = input.quantityMode === 'all_cash' ? 1 : Number(input.quantity)
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) throw new Error('주문수량은 1~1000000주의 정수로 입력해 주세요.')
  const ready = tradingReadiness(strategy, input.entryAction)
  if (!ready.ready) throw new Error(ready.issues.join(' '))
  const manageQuantity = input.entryAction === 'manage' ? Number(input.manageQuantity) : null
  if (input.entryAction === 'manage' && (!Number.isSafeInteger(manageQuantity) || manageQuantity < 1 || manageQuantity > 1_000_000)) throw new Error('관리할 보유수량을 확인해 주세요.')
  const risk = normalizeRiskSettings(strategy.backtest_settings, { allowIncomplete: false })
  return { spec: { code, broker: input.broker, accountRef: input.accountRef, strategyId: strategy.id, strategyRevision: Number(strategy.revision), quantity, quantityMode: input.quantityMode, entryAction: input.entryAction, ...(manageQuantity !== null ? { manageQuantity } : {}) }, strategy: { id: strategy.id, name: strategy.name, revision: Number(strategy.revision), schema_version: 2, indicators: structuredClone(strategy.indicators), backtest_settings: { ...structuredClone(strategy.backtest_settings), ...risk, entryConditions: validateEntryConditions(strategy.indicators, strategy.backtest_settings), entryMode: strategy.backtest_settings.entryMode || 'all' } } }
}

// Exact six-decimal KRW storage for broker fractional average prices. Values
// outside this explicit precision are rejected rather than silently rounded.
export function moneyMicros(value) {
  const text = String(value)
  if (!/^\d{1,16}(?:\.\d{1,6})?$/.test(text)) throw new Error('invalid_money')
  const [whole, fraction = ''] = text.split('.')
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
}
export const microsMoney = value => Number(BigInt(value)) / 1_000_000
const integer = (value, name) => { if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error(name); return BigInt(value) }
export function sizeTradingOrder({ quantityMode, quantity, cashAvailable, reservedCash = 0, price, bufferBps = TRADING_POLICY.cashBufferBps }) {
  if (!Number.isSafeInteger(price) || price < 1 || price > 1_000_000_000 || !Number.isSafeInteger(bufferBps) || bufferBps < 50 || bufferBps > 1000) throw new Error('invalid_order_price')
  const cash = moneyMicros(cashAvailable), reserved = moneyMicros(reservedCash), available = cash > reserved ? cash - reserved : 0n
  const perShare = (BigInt(price) * 1_000_000n * BigInt(10_000 + bufferBps) + 9999n) / 10_000n
  const qty = quantityMode === 'all_cash' ? available / perShare : integer(quantity, 'invalid_quantity')
  if (!['fixed', 'all_cash'].includes(quantityMode) || qty < 1n || qty > 1_000_000n || qty * perShare > available) return { quantity: 0, reserveCash: 0, reason: 'cash_insufficient' }
  // Round the reservation upward to a whole won; never spend the fee buffer.
  const reserveCash = Number((qty * perShare + 999999n) / 1_000_000n)
  return { quantity: Number(qty), reserveCash, reason: null }
}

export function krxTick(price) { return price < 2000 ? 1 : price < 5000 ? 5 : price < 20000 ? 10 : price < 50000 ? 50 : price < 200000 ? 100 : price < 500000 ? 500 : 1000 }
export function tradingLimitPrice(price, cap) {
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error('invalid_order_price')
  // An observable price + two legal ticks, bounded by the verified daily limit.
  const first = price + 2 * krxTick(price), tick = krxTick(first)
  const result = Math.ceil(first / tick) * tick
  if (cap != null && (!Number.isSafeInteger(cap) || cap <= 0)) throw new Error('invalid_price_limit')
  return cap == null ? result : Math.min(result, cap)
}

export function evaluateTradingSignal({ candles, strategy, previousDay, tradingDays, calendarThrough }) {
  if (!validDailyDate(previousDay)) throw new Error('daily_unavailable')
  const confirmed = candles.filter(c => c.time <= previousDay)
  if (confirmed.at(-1)?.time !== previousDay) throw new Error('daily_unavailable')
  const settings = { ...strategy.backtest_settings, start: previousDay, end: previousDay, ...(tradingDays ? { tradingDays, calendarThrough } : {}) }
  const window = backtestWindow(confirmed, strategy.indicators, settings)
  for (const bar of window.candles) if (!['open', 'high', 'low', 'close', 'volume'].every(key => Number.isFinite(bar[key]) && bar[key] >= 0) || bar.close <= 0 || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)) throw new Error('daily_unavailable')
  const conditions = validateEntryConditions(strategy.indicators, settings, { requireEntry: true }).filter(c => c.enabled)
  const ids = new Set(conditions.flatMap(c => [c.indicatorId, c.right.indicatorId || c.indicatorId]))
  const evaluate = calculateConditionEvaluator(window.candles, strategy.indicators.filter(c => ids.has(c.id)))
  const results = conditions.map(c => evaluate(c, window.candles.length - 1))
  if (results.some(r => r === null)) throw new Error('daily_unavailable')
  const last = window.candles.at(-1), tradable = last.tradable !== 0 && last.open > 0 && last.volume > 0
  return { signalDay: previousDay, matched: tradable && (settings.entryMode === 'any' ? results.some(Boolean) : results.every(Boolean)), results }
}

export function tradingThresholds(position, risk) {
  if (!position?.quantity) return null
  const cost = BigInt(position.costMicros), quantity = BigInt(position.quantity)
  const tp = moneyMicros(risk.takeProfitPct), sl = moneyMicros(risk.stopLossPct), scale = 100_000_000n
  return { averagePrice: microsMoney(cost) / Number(quantity), takeProfitPrice: Number(cost * (scale + tp)) / Number(quantity * scale * 1_000_000n), stopLossPrice: Number(cost * (scale - sl)) / Number(quantity * scale * 1_000_000n) }
}
export function tradingExitReason(position, risk, price) {
  if (!position?.quantity) return null
  const value = moneyMicros(price) * BigInt(position.quantity), cost = BigInt(position.costMicros), scale = 100_000_000n
  if (value * scale >= cost * (scale + moneyMicros(risk.takeProfitPct))) return 'take_profit'
  if (value * scale <= cost * (scale - moneyMicros(risk.stopLossPct))) return 'stop_loss'
  return null
}
export function tradingPerformance(state, markPrice) {
  const trades = state?.closedTrades || [], position = state?.position
  return { entries: Number(state?.entryCount || 0), closedTrades: trades.length, takeProfits: trades.filter(t => t.reason === 'take_profit').length, stopLosses: trades.filter(t => t.reason === 'stop_loss').length, realizedPnl: trades.reduce((sum, t) => sum + Number(t.pnl || 0), 0), unrealizedPnl: position?.quantity && Number.isFinite(markPrice) ? microsMoney(moneyMicros(markPrice) * BigInt(position.quantity) - BigInt(position.costMicros)) : null, costs: '미확정 · 수수료·세금 미반영', gross: true }
}
