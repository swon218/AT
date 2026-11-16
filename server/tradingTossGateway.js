import { requestTossWithCredentials } from './tossClient.js'
import { createTossChartService } from './tossCharts.js'
import { accountRef, personalAuth, digest } from './personalBroker.js'
import { tradingCredentialVersion } from './tradingBrokerCommon.js'
import { tradingExecutionPolicy } from '../shared/tradingPolicies.js'
import { koreanOrderDay } from '../src/utils/orderPeriod.js'
import { utcSeconds } from '../src/utils/chartTime.js'

export const TOSS_TRADING_SOURCE = 'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json'
const policy = () => tradingExecutionPolicy('toss')
const fail = (code, message = '토스 개인 계좌 응답을 확인할 수 없습니다.', statusCode = 409) => Object.assign(new Error(message), { code, statusCode })
const int = (value, positive = false) => {
  // Decimal-encoded whole KRW/shares remain exact; nonzero fractional Korean
  // shares are never rounded or silently accepted.
  if (!/^\d+(?:\.0{1,6})?$/.test(String(value ?? ''))) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= (positive ? 1 : 0) ? number : null
}
const decimal = value => /^\d{1,12}(?:\.\d{1,6})?$/.test(String(value ?? '')) && Number(value) > 0 && Number.isFinite(Number(value)) ? Number(value) : null
const symbolValid = value => /^[0-9][0-9A-Z]{5}$/.test(String(value || ''))
const idValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && utcSeconds(value) !== null ? Date.parse(value) : null
const enabled = value => typeof value === 'function' ? value() === true : value === true
const operationSignal = (signal, ms = 25_000) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
const safe = async work => { try { return await work() } catch (error) { if (String(error?.code || '').startsWith('trading_')) throw error; throw fail('trading_toss_read_unavailable', '토스 개인 API 조회를 완료하지 못했습니다.', 502) } }
const openStates = new Set(['PENDING', 'PARTIAL_FILLED', 'PENDING_CANCEL', 'PENDING_REPLACE'])
const knownRejects = new Set(['invalid-request', 'confirm-high-value-required', 'insufficient-buying-power', 'order-hours-closed', 'stock-restricted', 'price-out-of-range', 'order-type-not-allowed', 'prerequisite-required', 'market-not-supported-for-stock', 'investor-exchange-not-integrated', 'account-restricted', 'max-order-amount-exceeded', 'cancel-restricted', 'already-filled', 'already-canceled', 'already-modified', 'already-rejected'])
const rateStates = new Map()

// The official REST Order response provides cumulative quantity/amount and the
// last actual fill time, not individual fill ids. Never fabricate executions.
export function parseTossTradingOrder(row, expected = {}) {
  const quantity = int(row?.quantity, true), filledQuantity = int(row?.execution?.filledQuantity)
  const ordered = instant(row?.orderedAt)
  if (!idValid(row?.orderId) || !symbolValid(row?.symbol) || !['BUY', 'SELL'].includes(row.side) || row.currency !== 'KRW'
    || !['LIMIT', 'MARKET'].includes(row.orderType) || row.timeInForce !== 'DAY' || quantity === null || filledQuantity === null || filledQuantity > quantity || ordered === null) throw fail('trading_toss_order_invalid')
  if (expected.orderNumber && row.orderId !== expected.orderNumber || expected.symbol && row.symbol !== expected.symbol || expected.side && row.side.toLowerCase() !== expected.side
    || expected.quantity != null && quantity !== Number(expected.quantity) || expected.date && koreanOrderDay(ordered) !== expected.date) throw fail('trading_toss_order_mismatch')
  const filledNotional = filledQuantity === 0 ? 0 : int(row.execution.filledAmount, true)
  const lastFilledAt = filledQuantity ? instant(row.execution.filledAt) : null
  const averagePrice = filledQuantity ? decimal(row.execution.averageFilledPrice) : null
  if (filledQuantity && (filledNotional === null || lastFilledAt === null || lastFilledAt < ordered || !averagePrice)) throw fail('trading_toss_fill_unconfirmed')
  const orderPrice = row.orderType === 'LIMIT' ? int(row.price, true) : null
  if (row.orderType === 'LIMIT' && !orderPrice) throw fail('trading_toss_order_invalid')
  let status = { PENDING: 'open', PARTIAL_FILLED: 'partial', PENDING_CANCEL: 'open', PENDING_REPLACE: 'unknown', FILLED: 'filled', CANCELED: 'cancelled', REJECTED: 'rejected' }[row.status] || 'unknown'
  if (status === 'filled' && filledQuantity !== quantity || status === 'partial' && !(filledQuantity > 0 && filledQuantity < quantity)) status = 'unknown'
  return { orderNumber: row.orderId, symbol: row.symbol, side: row.side.toLowerCase(), quantity, filledQuantity, filledNotional,
    averagePrice, orderedAt: new Date(ordered).toISOString(), date: koreanOrderDay(ordered),
    lastFilledAt: lastFilledAt === null ? null : new Date(lastFilledAt).toISOString(), orderPrice,
    remainingQuantity: openStates.has(row.status) ? quantity - filledQuantity : 0,
    status, providerStatus: row.status, exchange: 'PROVIDER', route: 'SOR', executions: [], fillEvidence: 'cumulative',
    canCancel: ['PENDING', 'PARTIAL_FILLED'].includes(row.status) && filledQuantity < quantity }
}

export function createTradingTossGateway({ settings = {}, request = requestTossWithCredentials, loadAccount, now = Date.now,
  delay = (ms, signal) => new Promise((resolve, reject) => {
    signal?.throwIfAborted(); const stop = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, ms)
    signal?.addEventListener('abort', stop, { once: true })
  }), spacingMs = 350, charts = createTossChartService({ request, now }),
} = {}) {
  function authScope(input) {
    if (input.broker !== 'toss') throw fail('trading_broker_unsupported')
    let auth
    try { auth = personalAuth(input.account, 'toss') } catch (error) { throw fail(error.statusCode === 401 ? 'trading_auth_required' : 'trading_credentials_missing', '토스 개인 API 등록과 로그인을 확인해 주세요.', error.statusCode || 403) }
    if (input.symbol !== undefined && !symbolValid(input.symbol)) throw fail('trading_symbol_invalid')
    const version = tradingCredentialVersion(input.account, 'toss', auth)
    if (input.expectedCredentialVersion && input.expectedCredentialVersion !== version) throw fail('trading_credentials_changed')
    return { auth, version }
  }
  async function paced(auth, signal) {
    const key = digest(auth)
    if (!rateStates.has(key)) {
      if (rateStates.size >= 300) { const old = [...rateStates].find(([, value]) => !value.pending && value.nextAt <= now()); if (old) rateStates.delete(old[0]); else throw fail('trading_toss_queue_busy') }
      rateStates.set(key, { tail: Promise.resolve(), nextAt: 0, pending: 0 })
    }
    const state = rateStates.get(key), previous = state.tail
    let release; state.tail = new Promise(resolve => { release = resolve }); state.pending++
    try {
      await previous; signal?.throwIfAborted()
      if (state.nextAt > now()) await delay(state.nextAt - now(), signal)
      signal?.throwIfAborted(); state.nextAt = now() + Math.max(0, spacingMs)
    } finally { state.pending--; release() }
  }
  async function call(auth, path, signal, options = {}) {
    await paced(auth, signal)
    let payload
    try { payload = await request({ ...auth, path, signal, ...options }) }
    catch (error) {
      if (error.statusCode === 429) { const state = rateStates.get(digest(auth)); if (state) state.nextAt = Math.max(state.nextAt, now() + Math.min(30, Math.max(1, Number(error.retryAfter) || 1)) * 1000) }
      throw error
    }
    if (!payload || payload.error != null || payload.success === false || !Object.hasOwn(payload, 'result')) throw fail('trading_toss_business_error')
    return payload.result
  }
  async function owned(input) {
    const context = authScope(input), signal = operationSignal(input.signal)
    const list = await call(context.auth, '/api/v1/accounts', signal)
    if (!Array.isArray(list)) throw fail('trading_toss_accounts_invalid')
    const owned = list.filter(row => row?.accountType === 'BROKERAGE').map((row, index) => {
      if (!/^\d+$/.test(String(row.accountSeq ?? '')) || !int(row.accountSeq, true)) throw fail('trading_toss_accounts_invalid')
      return { raw: row.accountSeq, ref: accountRef(input.account, 'toss', context.auth, row.accountSeq), label: `종합매매 계좌 ${index + 1}` }
    })
    if (new Set(owned.map(row => row.ref)).size !== owned.length) throw fail('trading_toss_accounts_invalid')
    const selected = input.accountRef ? owned.find(row => row.ref === input.accountRef) : owned.length === 1 ? owned[0] : null
    if (input.accountRef && !selected) throw fail('trading_account_scope_changed')
    return { ...context, selected, accounts: owned.map(({ ref, label }) => ({ ref, label })), signal }
  }
  const needAccount = context => {
    if (!context.selected) throw fail('trading_account_required', '본인 토스 계좌를 선택해 주세요.')
    return context.selected
  }
  async function accounts(input) { return safe(async () => { const context = await owned(input); return { accounts: context.accounts, accountRequired: !context.selected, credentialVersion: context.version } }) }
  async function security(context, symbol) {
    const rows = await call(context.auth, '/api/v1/stocks', context.signal, { query: { symbols: symbol } })
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null, kr = row?.koreanMarketDetail
    if (!row || row.symbol !== symbol || !['KOSPI', 'KOSDAQ'].includes(row.market) || row.securityType !== 'STOCK' || row.status !== 'ACTIVE' || row.currency !== 'KRW'
      || kr?.liquidationTrading !== false || kr?.krxTradingSuspended !== false || typeof kr?.nxtSupported !== 'boolean' || kr.nxtSupported && kr.nxtTradingSuspended !== false) throw fail('trading_security_restricted', '토스 기본 라우팅으로 거래 가능한 국내 현금 주식인지 확인할 수 없습니다.')
  }
  async function prices(context, symbol) {
    const rows = await call(context.auth, '/api/v1/prices', context.signal, { query: { symbols: symbol } })
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].symbol !== symbol || rows[0].currency !== 'KRW' || !int(rows[0].lastPrice, true)) throw fail('trading_toss_quote_invalid')
    return rows[0]
  }
  async function quote(input) { return safe(async () => {
    const context = await owned(input); needAccount(context); await security(context, input.symbol)
    const limits = await call(context.auth, '/api/v1/price-limits', context.signal, { query: { symbol: input.symbol } })
    // PriceResponse.timestamp is a data timestamp. Trade.timestamp is explicitly
    // the actual execution time; use the latter for the execution freshness gate.
    const ticks = await call(context.auth, '/api/v1/trades', context.signal, { query: { symbol: input.symbol, count: 1 } })
    const row = Array.isArray(ticks) && ticks.length === 1 ? ticks[0] : null
    if (!row || row.currency !== 'KRW' || !int(row.price, true) || !int(row.volume, true)) throw fail('trading_toss_quote_invalid')
    const observed = instant(row.timestamp), current = now(), session = input.session
    if (observed === null || observed > current || current - observed > 15_000 || koreanOrderDay(observed) !== koreanOrderDay(current)
      || session && (session.market !== 'KRX' || session.date !== koreanOrderDay(observed) || !Number.isFinite(Date.parse(session.open)) || !Number.isFinite(Date.parse(session.close)) || observed < Date.parse(session.open) || observed >= Date.parse(session.close))) throw fail('trading_quote_stale', '토스 시세의 실제 최신 시각을 확인할 수 없습니다.')
    const price = int(row.price, true), up = int(limits?.upperLimitPrice, true), down = int(limits?.lowerLimitPrice, true)
    if (limits?.currency !== 'KRW' || instant(limits?.timestamp) === null || koreanOrderDay(Date.parse(limits.timestamp)) !== koreanOrderDay(current) || !up || !down || down > price || up < price) throw fail('trading_price_limits_unknown')
    return { price, priceLimitUp: up, priceLimitDown: down, symbol: input.symbol, sourceBroker: 'toss', exchange: 'PROVIDER', fresh: true, halted: false,
      observedAt: new Date(observed).toISOString(), receivedAt: new Date(current).toISOString(), timestampMeaning: 'trade', executionPolicy: policy() }
  }) }
  async function open(context, symbol) {
    const selected = needAccount(context), data = await call(context.auth, '/api/v1/orders', context.signal, { accountSeq: selected.raw, query: { status: 'OPEN', symbol } })
    if (!Array.isArray(data?.orders) || data.hasNext !== false || data.nextCursor != null) throw fail('trading_open_orders_incomplete')
    const result = new Map()
    for (const row of data.orders) {
      if (row?.currency !== 'KRW' || row?.symbol !== symbol) continue
      const parsed = parseTossTradingOrder(row)
      if (!openStates.has(parsed.providerStatus) || result.has(parsed.orderNumber)) throw fail('trading_open_orders_incomplete')
      result.set(parsed.orderNumber, { ...parsed, accountRef: selected.ref })
    }
    return [...result.values()]
  }
  async function inspect(input) { return safe(async () => {
    const context = await owned(input)
    if (!context.selected) return { accountRef: '', accounts: context.accounts, complete: false, eligible: false, reason: 'trading_account_required' }
    const selected = context.selected
    if (!input.reconciliationOnly) await security(context, input.symbol)
    const holdings = await call(context.auth, '/api/v1/holdings', context.signal, { accountSeq: selected.raw, query: { symbol: input.symbol } })
    if (!Array.isArray(holdings?.items)) throw fail('trading_toss_holdings_invalid')
    const rows = holdings.items.filter(row => row?.symbol === input.symbol)
    if (rows.length > 1 || rows.some(row => row.marketCountry !== 'KR' || row.currency !== 'KRW' || int(row.quantity) === null)) throw fail('trading_holding_ambiguous')
    const holdingQuantity = rows.length ? int(rows[0].quantity) : 0
    const sellable = await call(context.auth, '/api/v1/sellable-quantity', context.signal, { accountSeq: selected.raw, query: { symbol: input.symbol } })
    const sellableQuantity = int(sellable?.sellableQuantity)
    if (sellableQuantity === null || sellableQuantity > holdingQuantity) throw fail('trading_holding_quantity_unknown')
    const openOrders = await open(context, input.symbol)
    const funds = await call(context.auth, '/api/v1/buying-power', context.signal, { accountSeq: selected.raw, query: { currency: 'KRW' } })
    const cashAvailable = int(funds?.cashBuyingPower)
    if (funds?.currency !== 'KRW' || cashAvailable === null) throw fail('trading_cash_unconfirmed')
    const price = int(input.price, true) || int((await prices(context, input.symbol)).lastPrice, true)
    return { broker: 'toss', accountRef: selected.ref, accountLabel: selected.label, accounts: context.accounts,
      accountScope: digest([input.account.user.id, 'toss', selected.raw]), credentialVersion: context.version,
      // The official Order Info API exposes cashBuyingPower, not a KR buyable
      // quantity endpoint. This is a conservative arithmetic cap, not a claim
      // that the broker returned an exact pre-authorized quantity.
      cashAvailable, buyableQuantity: Math.min(1_000_000, Math.floor(Math.min(cashAvailable, 3_000_000_000) / price)),
      buyableQuantitySource: 'cash_calculation', brokerBuyableQuantity: null, maximumOrderAmount: 3_000_000_000, referencePrice: price,
      holdingQuantity, sellableQuantity, averagePrice: rows.length && holdingQuantity > 0 ? decimal(rows[0].averagePurchasePrice) : null,
      openOrders, complete: true, eligible: true, reason: null, fetchedAt: new Date(now()).toISOString(), executionPolicy: policy() }
  }) }
  async function candles(input) { return safe(async () => {
    const context = await owned(input), selected = needAccount(context)
    const result = await charts.getTossCandleResponse(input.symbol, input.interval || '일', input.limit || 200,
      { ...context.auth, cacheScope: `trading:${input.account.user.id}:${context.version}:${selected.ref}` }, { signal: context.signal })
    if (!Array.isArray(result?.items) || !result.meta || result.meta.invalidRowCount > 0) throw fail('trading_candles_incomplete')
    return { candles: result.items, metadata: { ...result.meta, sourceBroker: 'toss', source: 'toss', market: 'PROVIDER', fallback: false, executionPolicy: policy() } }
  }) }
  function writeLocal(input, intent, entry = false) {
    if (!enabled(settings.liveEnabled) || !enabled(settings.workerEnabled) || !enabled(settings.tossOrdersEnabled)) throw fail('trading_live_disabled', '토스 자동매매 실행이 비활성화되어 있습니다.', 503)
    const { version } = authScope(input), session = input.session, current = now()
    const selectedPolicy = input.executionPolicy, currentPolicy = policy()
    if (selectedPolicy && !['version', 'route', 'quoteMarket', 'chartMarket', 'tradingWindow'].every(key => selectedPolicy[key] === currentPolicy[key])) throw fail('trading_policy_changed')
    if (!intent || !idValid(intent.id) || !intent.executionId || intent.status !== 'sending' || intent.accountRef !== input.accountRef || intent.symbol !== input.symbol || intent.credentialVersion !== version) throw fail('trading_intent_invalid')
    if (!session || session.market !== 'KRX' || session.date !== koreanOrderDay(current) || !Number.isFinite(Date.parse(session.open)) || !Number.isFinite(Date.parse(session.close))
      || current < Date.parse(session.open) || current >= Date.parse(session.close)) throw fail('trading_market_closed')
    if (entry && intent.side === 'buy' && intent.metadata?.signalDay !== 'once'
      && (intent.metadata?.signalDay !== session.previous || current >= Date.parse(session.open) + 60_000)) throw fail('trading_opening_window_expired')
  }
  const gateError = unknown => Object.assign(fail(unknown ? 'trading_write_gate_unknown' : 'trading_write_gate_rejected'), { notTransmitted: !unknown, writeGateUnknown: unknown })
  const guard = (input, intent, entry, observedAt) => async () => {
    if (typeof loadAccount === 'function') {
      const latest = await loadAccount(input.account.user.id)
      if (latest?.user?.id !== input.account.user.id || tradingCredentialVersion(latest, 'toss') !== intent.credentialVersion) throw gateError(true)
    }
    writeLocal(input, intent, entry)
    let permitted
    try { permitted = await input.beforeWrite() } catch { throw gateError(true) }
    if (permitted !== true && permitted?.allowed !== true) throw gateError(permitted !== false && permitted?.unknown !== false)
    try { writeLocal(input, intent, entry); if (observedAt && now() - Date.parse(observedAt) > 15_000) throw new Error() } catch { throw gateError(false) }
    return true
  }
  const writeError = error => error?.notTransmitted ? { status: 'rejected', code: 'trading_write_gate_rejected', notTransmitted: true }
    : knownRejects.has(error?.code) && [400, 401, 403, 404, 409, 422].includes(error?.statusCode) ? { status: 'rejected', code: 'trading_broker_rejected' }
      : { status: 'unknown', code: error?.writeGateUnknown ? 'trading_write_gate_unknown' : 'trading_submission_unknown' }
  const refs = (intent, orderNumber, extra = {}) => ({ ...(intent?.metadata?.references || {}), toss: { ...(intent?.metadata?.references?.toss || {}),
    ...(orderNumber ? { orderId: orderNumber } : {}), route: 'SOR', policyVersion: policy().version, ...extra } })
  async function submit(input) {
    const intent = input.intent; writeLocal(input, intent, true)
    if (typeof input.beforeWrite !== 'function') return { status: 'rejected', code: 'trading_write_gate_rejected', notTransmitted: true }
    const quantity = int(intent.quantity, true), price = intent.side === 'buy' ? int(intent.limitPrice, true) : null
    if (!quantity || quantity > 1_000_000 || !['buy', 'sell'].includes(intent.side)) throw fail('trading_order_invalid')
    if (intent.side === 'buy' && (!price || price > int(intent.maxPrice, true) || !Number.isSafeInteger(price * quantity) || price * quantity > int(intent.reservedCash))) throw fail('trading_price_bound_invalid')
    if (intent.side === 'sell' && quantity > int(intent.ownedQuantity)) throw fail('trading_owned_quantity_invalid')
    const context = await owned(input), selected = needAccount(context), latest = await quote(input), inspected = await inspect({ ...input, price: price || latest.price })
    if (selected.ref !== input.accountRef || inspected.credentialVersion !== intent.credentialVersion || inspected.openOrders.length) throw fail('trading_external_order_conflict')
    if (intent.side === 'buy' && (price < latest.priceLimitDown || price > latest.priceLimitUp || price * quantity > inspected.cashAvailable || quantity > inspected.buyableQuantity)) throw fail('trading_cash_insufficient')
    if (intent.side === 'sell' && (quantity > inspected.holdingQuantity || quantity > inspected.sellableQuantity)) throw fail('trading_sellable_insufficient')
    if (quantity * (price || latest.price) > 3_000_000_000) throw fail('trading_order_amount_limit')
    const clientOrderId = `at-${digest([input.account.user.id, intent.executionId, intent.id]).slice(0, 32)}`
    const references = refs(intent, null, { clientOrderId })
    let result
    try { result = await call(context.auth, '/api/v1/orders', operationSignal(input.signal, 15_000), { method: 'POST', retry: false, accountSeq: selected.raw,
      body: { clientOrderId, symbol: input.symbol, side: intent.side.toUpperCase(), orderType: intent.side === 'buy' ? 'LIMIT' : 'MARKET', timeInForce: 'DAY', quantity: String(quantity),
        ...(price ? { price: String(price) } : {}), confirmHighValueOrder: quantity * (price || latest.price) >= 100_000_000 },
      beforeWrite: guard(input, intent, true, latest.observedAt) }) }
    catch (error) { return { ...writeError(error), references } }
    if (!idValid(result?.orderId) || result.clientOrderId != null && result.clientOrderId !== clientOrderId) return { status: 'unknown', code: 'trading_acceptance_unconfirmed', references }
    if (result.clientOrderId == null) return { status: 'unknown', code: 'trading_acceptance_unconfirmed', orderNumber: result.orderId, references: refs(intent, result.orderId, { clientOrderId }) }
    return { status: 'accepted', orderNumber: result.orderId, references: refs(intent, result.orderId, { clientOrderId }) }
  }
  async function detail(context, orderNumber, expected) {
    if (!idValid(orderNumber)) throw fail('trading_toss_order_identity_missing')
    const row = await call(context.auth, `/api/v1/orders/${encodeURIComponent(orderNumber)}`, context.signal, { accountSeq: needAccount(context).raw })
    return parseTossTradingOrder(row, { ...expected, orderNumber })
  }
  async function cancel(input) {
    const intent = input.intent, cancellation = input.cancelIntent; writeLocal(input, cancellation)
    if (typeof input.beforeWrite !== 'function') return { status: 'rejected', code: 'trading_write_gate_rejected', notTransmitted: true }
    if (!intent || intent.executionId !== cancellation.executionId || intent.accountRef !== input.accountRef || intent.symbol !== input.symbol || intent.credentialVersion !== cancellation.credentialVersion || !idValid(intent.orderNumber)) throw fail('trading_cancel_scope_invalid')
    const context = await owned(input); needAccount(context)
    const row = await detail(context, intent.orderNumber, { symbol: input.symbol, side: intent.side, quantity: intent.quantity })
    if (!row.canCancel || row.remainingQuantity <= 0) throw fail('trading_cancel_ownership_unconfirmed')
    let result
    try { result = await call(context.auth, `/api/v1/orders/${encodeURIComponent(intent.orderNumber)}/cancel`, operationSignal(input.signal, 15_000),
      { method: 'POST', retry: false, accountSeq: context.selected.raw, body: {}, beforeWrite: guard(input, cancellation, false) }) }
    catch (error) { return { ...writeError(error), references: refs(intent, intent.orderNumber) } }
    if (!idValid(result?.orderId) || result.orderId === intent.orderNumber) return { status: 'unknown', code: 'trading_cancel_response_unconfirmed', references: refs(intent, intent.orderNumber) }
    return { status: 'pendingCancel', orderNumber: result.orderId, references: refs(intent, intent.orderNumber, { cancelOperationOrderId: result.orderId }) }
  }
  async function reconcile(input) { return safe(async () => {
    const context = await owned(input); needAccount(context)
    const inspected = await inspect({ ...input, reconciliationOnly: true })
    const intents = Array.isArray(input.intents) ? input.intents : []
    if (intents.length > 100) throw fail('trading_reconcile_limit')
    let complete = true, reason = null; const orders = [], operations = []
    for (const intent of intents) {
      const unresolved = { intentId: intent.id, orderNumber: intent.orderNumber || null, status: 'unknown', filledQuantity: null, filledNotional: null, executions: [], references: refs(intent, null) }
      if (intent.accountRef !== inspected.accountRef || intent.symbol !== input.symbol || intent.credentialVersion !== context.version || !idValid(intent.orderNumber)) { complete = false; orders.push(unresolved); continue }
      try {
        const row = await detail(context, intent.orderNumber, { symbol: input.symbol, side: intent.side, quantity: intent.quantity, date: intent.date })
        const openOrder = inspected.openOrders.find(item => item.orderNumber === row.orderNumber)
        if (row.status === 'unknown' || row.lastFilledAt && Date.parse(row.lastFilledAt) > now() || ['open', 'partial'].includes(row.status) && (!openOrder || openOrder.filledQuantity !== row.filledQuantity || openOrder.remainingQuantity + row.filledQuantity !== row.quantity)
          || ['filled', 'cancelled', 'rejected'].includes(row.status) && openOrder) throw fail('trading_reconciliation_incomplete')
        orders.push({ intentId: intent.id, orderNumber: row.orderNumber, status: row.status, filledQuantity: row.filledQuantity, filledNotional: row.filledNotional,
          executions: [], lastFilledAt: row.lastFilledAt, remainingQuantity: row.remainingQuantity, cashReflected: false, fillEvidence: 'cumulative',
          references: refs(intent, row.orderNumber, { fillEvidence: 'cumulative', lastFilledAt: row.lastFilledAt }) })
      } catch { complete = false; orders.push(unresolved) }
    }
    for (const operation of (input.operations || []).slice(0, 100)) {
      const parent = intents.find(intent => intent.id === operation.metadata?.parentIntentId)
      const parentFact = parent && orders.find(row => row.intentId === parent.id)
      if (!parent || ['filled', 'cancelled', 'rejected'].includes(parentFact?.status)) continue
      const number = operation.orderNumber || operation.metadata?.references?.toss?.cancelOperationOrderId
      if (!idValid(number)) continue
      try {
        const row = await call(context.auth, `/api/v1/orders/${encodeURIComponent(number)}`, context.signal, { accountSeq: context.selected.raw })
        if (row?.orderId !== number || row.symbol !== input.symbol || row.currency !== 'KRW') throw new Error()
        if (row.status === 'CANCEL_REJECTED') {
          complete = false; reason = 'trading_toss_cancel_rejected'
          operations.push({ intentId: operation.id, parentIntentId: parent.id, orderNumber: number, status: 'rejected', references: refs(parent, parent.orderNumber, { cancelOperationOrderId: number }) })
        }
      } catch { complete = false; reason ||= 'trading_reconciliation_incomplete' }
    }
    return { complete, holdingQuantity: inspected.holdingQuantity, averagePrice: inspected.averagePrice, openOrders: inspected.openOrders, orders, operations,
      reason: complete ? null : reason || (intents.some(intent => !idValid(intent.orderNumber)) ? 'trading_toss_order_id_missing' : 'trading_reconciliation_incomplete') }
  }) }
  return { capabilities: () => ({ broker: 'toss', supported: true, ordersEnabled: enabled(settings.tossOrdersEnabled), entryType: 'limit', exitType: 'market', timeInForce: 'DAY', exchange: 'PROVIDER', executionPolicy: policy(), source: TOSS_TRADING_SOURCE,
    ...(!enabled(settings.tossOrdersEnabled) ? { code: 'broker_orders_disabled', reason: 'VPS에서 토스 자동매매 주문 기능이 활성화되지 않았습니다.' } : {}) }),
    accounts, inspect, quote, candles, submit, cancel, reconcile }
}
