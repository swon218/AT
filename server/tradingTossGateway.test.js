import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createTradingTossGateway, parseTossTradingOrder } from './tradingTossGateway.js'
import { tradingCredentialVersion } from './tradingBrokerCommon.js'
import { accountRef } from './personalBroker.js'

const time = Date.parse('2026-11-16T00:00:10Z')
const session = { market: 'KRX', date: '2026-11-16', previous: '2026-11-13', open: '2026-11-16T09:00:00+09:00', close: '2026-11-16T15:30:00+09:00' }
const order = (patch = {}) => ({ orderId: 'original-toss-order', symbol: '005930', side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', quantity: '5', price: '100000', currency: 'KRW',
  orderedAt: '2026-11-16T09:00:00+09:00', status: 'PENDING', execution: { filledQuantity: '0', averageFilledPrice: null, filledAmount: null, filledAt: null }, ...patch })
function fixture() {
  const owner = randomUUID(), account = { user: { id: owner }, credentials: { tossApiKey: `fixture-toss-${owner}`, tossSecretKey: 'fixture-private-secret' }, status: { tossConfigured: true }, tradingCredentialEpoch: randomUUID() }
  const auth = { apiKey: account.credentials.tossApiKey, secretKey: account.credentials.tossSecretKey }
  const ref = accountRef(account, 'toss', auth, 123456789), version = tradingCredentialVersion(account, 'toss', auth)
  const settings = { liveEnabled: true, workerEnabled: true, tossOrdersEnabled: true }
  const rows = new Map(), calls = [], chartCalls = [], controls = { now: time, account, error: null, beforeResponse: null }
  const data = {
    accounts: [{ accountSeq: 123456789, accountNo: 'PRIVATE_RAW_ACCOUNT', accountType: 'BROKERAGE' }],
    stocks: [{ symbol: '005930', securityType: 'STOCK', market: 'KOSPI', status: 'ACTIVE', currency: 'KRW', koreanMarketDetail: { liquidationTrading: false, krxTradingSuspended: false, nxtSupported: true, nxtTradingSuspended: false } }],
    prices: [{ symbol: '005930', currency: 'KRW', lastPrice: '100000', timestamp: '2026-11-16T09:00:10+09:00' }],
    trades: [{ price: '100000', volume: '3', currency: 'KRW', timestamp: '2026-11-16T09:00:10+09:00' }],
    limits: { currency: 'KRW', timestamp: '2026-11-16T09:00:00+09:00', upperLimitPrice: '130000', lowerLimitPrice: '70000' },
    holdings: { items: [] }, sellable: { sellableQuantity: '0' }, funds: { currency: 'KRW', cashBuyingPower: '1000000' },
    open: { orders: [], hasNext: false, nextCursor: null },
  }
  const request = async definition => {
    if (definition.method === 'POST' && definition.beforeWrite) await definition.beforeWrite()
    calls.push(definition)
    if (controls.error) throw controls.error
    if (definition.method === 'POST') {
      if (controls.beforeResponse) return controls.beforeResponse(definition)
      return { result: definition.path.endsWith('/cancel') ? { orderId: 'cancel-operation-id' } : { orderId: 'original-toss-order', clientOrderId: definition.body.clientOrderId } }
    }
    if (definition.path.startsWith('/api/v1/orders/')) {
      const id = decodeURIComponent(definition.path.slice('/api/v1/orders/'.length))
      if (!rows.has(id)) throw Object.assign(new Error('PRIVATE provider detail'), { statusCode: 404 })
      return { result: structuredClone(rows.get(id)) }
    }
    const key = { '/api/v1/accounts': 'accounts', '/api/v1/stocks': 'stocks', '/api/v1/prices': 'prices', '/api/v1/trades': 'trades', '/api/v1/price-limits': 'limits', '/api/v1/holdings': 'holdings', '/api/v1/sellable-quantity': 'sellable', '/api/v1/buying-power': 'funds', '/api/v1/orders': 'open' }[definition.path]
    if (!key) throw new Error('unexpected fixture request')
    return { result: structuredClone(data[key]) }
  }
  const gateway = createTradingTossGateway({ settings, request, now: () => controls.now, loadAccount: async () => controls.account, spacingMs: 0,
    charts: { getTossCandleResponse: async (...args) => { chartCalls.push(args); return { items: [{ time: '2026-11-13', open: 100, high: 110, low: 90, close: 105, volume: 2 }], meta: { market: 'PROVIDER', invalidRowCount: 0, partial: false } } } } })
  const input = { account, broker: 'toss', accountRef: ref, symbol: '005930', session, beforeWrite: async () => ({ allowed: true }) }
  const intent = { id: randomUUID(), executionId: randomUUID(), accountRef: ref, credentialVersion: version, symbol: '005930', date: session.date,
    status: 'sending', side: 'buy', quantity: 5, limitPrice: 100000, maxPrice: 100500, reservedCash: 510000, metadata: { signalDay: 'once' } }
  return { owner, account, ref, version, settings, rows, calls, chartCalls, controls, data, request, gateway, input, intent }
}

test('Toss supports its actual default SOR policy without inventing a KRX routing request field', async () => {
  const f = fixture(), capability = f.gateway.capabilities('toss')
  assert.equal(capability.supported, true); assert.equal(capability.executionPolicy.route, 'SOR'); assert.equal(capability.executionPolicy.tradingWindow, 'KRX_REGULAR')
  assert.equal(capability.executionPolicy.quoteMarket, 'PROVIDER')
  const result = await f.gateway.submit({ ...f.input, intent: f.intent })
  assert.equal(result.status, 'accepted')
  const writes = f.calls.filter(row => row.method === 'POST')
  assert.equal(writes.length, 1); assert.equal(writes[0].retry, false); assert.equal(writes[0].accountSeq, 123456789)
  assert.deepEqual(Object.keys(writes[0].body).sort(), ['clientOrderId', 'confirmHighValueOrder', 'orderType', 'price', 'quantity', 'side', 'symbol', 'timeInForce'].sort())
  assert.equal(writes[0].body.timeInForce, 'DAY'); assert.equal(writes[0].body.orderType, 'LIMIT')
  assert.equal(result.references.toss.orderId, 'original-toss-order'); assert.ok(result.references.toss.clientOrderId.length <= 36)
})

test('personal account selection is exact and returns only opaque references; multiple accounts require selection', async () => {
  const f = fixture()
  f.data.accounts.push({ accountSeq: 55555555, accountType: 'BROKERAGE' })
  const accounts = await f.gateway.accounts({ ...f.input, accountRef: '' })
  assert.equal(accounts.accounts.length, 2); assert.equal(accounts.accountRequired, true)
  assert.ok(!JSON.stringify(accounts).includes('PRIVATE_RAW_ACCOUNT')); assert.ok(!JSON.stringify(accounts).includes('accountSeq'))
  const missing = await f.gateway.inspect({ ...f.input, accountRef: '' })
  assert.equal(missing.eligible, false); assert.equal(missing.reason, 'trading_account_required')
  await assert.rejects(f.gateway.inspect({ ...f.input, accountRef: 'foreign-owner-ref' }), { code: 'trading_account_scope_changed' })
  const own = await f.gateway.inspect(f.input)
  assert.equal(own.accountRef, f.ref); assert.equal(own.cashAvailable, 1000000); assert.equal(own.holdingQuantity, 0)
  assert.equal(own.buyableQuantity, 10); assert.equal(own.buyableQuantitySource, 'cash_calculation'); assert.equal(own.brokerBuyableQuantity, null)
  assert.ok(f.calls.filter(row => ['/api/v1/holdings', '/api/v1/buying-power'].includes(row.path)).every(row => row.accountSeq === 123456789))
})

test('missing/invalid credentials and missing cash/quantity fields fail closed rather than becoming zero', async () => {
  const f = fixture()
  await assert.rejects(f.gateway.inspect({ ...f.input, account: { ...f.account, status: { tossConfigured: false } } }), { code: 'trading_credentials_missing' })
  f.data.funds.cashBuyingPower = undefined
  await assert.rejects(f.gateway.inspect(f.input), { code: 'trading_cash_unconfirmed' })
  f.data.funds.cashBuyingPower = '1000000'; f.data.sellable.sellableQuantity = undefined
  await assert.rejects(f.gateway.inspect(f.input), { code: 'trading_holding_quantity_unknown' })
  f.data.sellable.sellableQuantity = '0'; f.data.holdings.items = [{ symbol: '005930', marketCountry: 'KR', currency: 'KRW', quantity: '', averagePurchasePrice: '200000' }]
  await assert.rejects(f.gateway.inspect(f.input), { code: 'trading_holding_ambiguous' })
})

test('owned quantities and average purchase price remain separate from sellable and current price', async () => {
  const f = fixture()
  f.data.holdings.items = [{ symbol: '005930', marketCountry: 'KR', currency: 'KRW', quantity: '7', averagePurchasePrice: '200000' }]
  f.data.sellable.sellableQuantity = '3'
  const result = await f.gateway.inspect(f.input)
  assert.equal(result.holdingQuantity, 7); assert.equal(result.sellableQuantity, 3); assert.equal(result.averagePrice, 200000)
  const sell = { ...f.intent, side: 'sell', quantity: 3, ownedQuantity: 3 }
  assert.equal((await f.gateway.submit({ ...f.input, intent: sell })).status, 'accepted')
  const write = f.calls.filter(row => row.method === 'POST').at(-1)
  assert.equal(write.body.orderType, 'MARKET'); assert.ok(!Object.hasOwn(write.body, 'price')); assert.equal(write.body.side, 'SELL')
  await assert.rejects(f.gateway.submit({ ...f.input, intent: { ...sell, quantity: 4 } }), { code: 'trading_owned_quantity_invalid' })
})

test('quotes use timestamped personal provider prices with explicit unknown venue and reject stale/missing/future timestamps', async () => {
  const f = fixture(), quote = await f.gateway.quote(f.input)
  assert.equal(quote.sourceBroker, 'toss'); assert.equal(quote.exchange, 'PROVIDER'); assert.equal(quote.observedAt, '2026-11-16T00:00:10.000Z'); assert.equal(quote.price, 100000)
  for (const timestamp of [null, '2026-11-16T09:00:00', '2026-11-16T08:59:00+09:00', '2026-11-16T09:00:11+09:00']) {
    f.data.trades[0].timestamp = timestamp
    await assert.rejects(f.gateway.quote(f.input), { code: 'trading_quote_stale' })
  }
})

test('halted, liquidating and unsupported stock types cannot become execution quotes', async () => {
  for (const change of [row => { row.koreanMarketDetail.krxTradingSuspended = true }, row => { row.koreanMarketDetail.nxtTradingSuspended = true }, row => { row.koreanMarketDetail.liquidationTrading = true }, row => { row.securityType = 'ETF' }]) {
    const f = fixture(); change(f.data.stocks[0])
    await assert.rejects(f.gateway.quote(f.input), { code: 'trading_security_restricted' })
    assert.ok(!f.calls.some(row => row.method === 'POST'))
  }
})

test('personal chart requests preserve requested interval and expose actual provider market without fallback', async () => {
  const f = fixture(), result = await f.gateway.candles({ ...f.input, interval: '15분' })
  assert.equal(f.chartCalls[0][1], '15분'); assert.equal(f.chartCalls[0][3].apiKey, f.account.credentials.tossApiKey)
  assert.ok(f.chartCalls[0][3].cacheScope.includes(f.version)); assert.ok(f.chartCalls[0][3].cacheScope.includes(f.ref))
  assert.equal(result.metadata.sourceBroker, 'toss'); assert.equal(result.metadata.market, 'PROVIDER'); assert.equal(result.metadata.fallback, false)
})

test('mandatory flags, current credential epoch and final fenced permit prevent every unapproved HTTP write', async () => {
  for (const flags of ['liveEnabled', 'workerEnabled', 'tossOrdersEnabled']) {
    const f = fixture(); f.settings[flags] = false
    await assert.rejects(f.gateway.submit({ ...f.input, intent: f.intent }), { code: 'trading_live_disabled' })
    assert.equal(f.calls.length, 0)
  }
  for (const permit of [false, { allowed: false, unknown: false }, { allowed: false, unknown: true }]) {
    const f = fixture(); let calls = 0
    const result = await f.gateway.submit({ ...f.input, intent: f.intent, beforeWrite: async () => { calls++; return permit } })
    assert.equal(result.status, permit?.unknown === true ? 'unknown' : 'rejected'); assert.equal(calls, 1)
    assert.ok(!f.calls.some(row => row.method === 'POST'))
  }
  const f = fixture(); f.controls.account = { ...f.account, tradingCredentialEpoch: randomUUID() }
  const result = await f.gateway.submit({ ...f.input, intent: f.intent })
  assert.equal(result.status, 'unknown'); assert.ok(!f.calls.some(row => row.method === 'POST'))
})

test('unknown submission is not retried; deterministic client id is retained but is never a fictitious recovery lookup', async () => {
  const f = fixture(); f.controls.beforeResponse = async () => { throw new Error('PRIVATE broker response lost') }
  const result = await f.gateway.submit({ ...f.input, intent: f.intent })
  assert.equal(result.status, 'unknown'); assert.equal(f.calls.filter(row => row.method === 'POST').length, 1)
  assert.ok(result.references.toss.clientOrderId); assert.ok(!JSON.stringify(result).includes('PRIVATE'))
  const recovered = await f.gateway.reconcile({ ...f.input, intents: [{ ...f.intent, orderNumber: null, metadata: { references: result.references } }] })
  assert.equal(recovered.complete, false); assert.equal(recovered.reason, 'trading_toss_order_id_missing'); assert.equal(recovered.orders[0].status, 'unknown')
  assert.ok(!f.calls.some(row => row.path.includes('clientOrderId'))); assert.equal(f.calls.filter(row => row.method === 'POST').length, 1)
})

test('a received order id with an omitted client echo can be confirmed by exact read-only detail, without a second submit', async () => {
  const f = fixture(); f.controls.beforeResponse = async () => ({ result: { orderId: 'original-toss-order' } })
  const submitted = await f.gateway.submit({ ...f.input, intent: f.intent })
  assert.equal(submitted.status, 'unknown'); assert.equal(submitted.orderNumber, 'original-toss-order')
  const row = order(); f.rows.set(row.orderId, row); f.data.open.orders = [row]
  const freshInstance = createTradingTossGateway({ settings: f.settings, request: f.request, now: () => time, loadAccount: async () => f.account, spacingMs: 0 })
  const result = await freshInstance.reconcile({ ...f.input, intents: [{ ...f.intent, orderNumber: submitted.orderNumber, metadata: { references: submitted.references } }] })
  assert.equal(result.complete, true); assert.equal(result.orders[0].status, 'open'); assert.equal(f.calls.filter(row => row.method === 'POST').length, 1)
})

test('partial fill cancellation tracks the new operation id without replacing the original owned order identity', async () => {
  const f = fixture(), partial = order({ status: 'PARTIAL_FILLED', execution: { filledQuantity: '2', averageFilledPrice: '100000', filledAmount: '200000', filledAt: '2026-11-16T09:00:01+09:00' } })
  f.rows.set(partial.orderId, partial); f.data.open.orders = [partial]
  const original = { ...f.intent, status: 'accepted', orderNumber: partial.orderId }, cancelIntent = { ...f.intent, id: randomUUID() }
  const result = await f.gateway.cancel({ ...f.input, intent: original, cancelIntent })
  assert.equal(result.status, 'pendingCancel'); assert.equal(result.orderNumber, 'cancel-operation-id')
  assert.equal(result.references.toss.orderId, partial.orderId); assert.equal(result.references.toss.cancelOperationOrderId, result.orderNumber)
  const write = f.calls.find(row => row.method === 'POST')
  assert.equal(write.path, '/api/v1/orders/original-toss-order/cancel'); assert.deepEqual(write.body, {}); assert.equal(write.retry, false)
  await assert.rejects(f.gateway.cancel({ ...f.input, intent: { ...original, symbol: '000660' }, cancelIntent }), { code: 'trading_cancel_scope_invalid' })
  assert.equal(f.calls.filter(row => row.method === 'POST').length, 1)
})

test('cumulative actual fill amount and last fill time reconcile across partial/cancelled states without fabricated fill rows', async () => {
  const f = fixture(), row = order({ status: 'PARTIAL_FILLED', execution: { filledQuantity: '2', averageFilledPrice: '100050', filledAmount: '200100', filledAt: '2026-11-16T09:00:02+09:00' } })
  f.rows.set(row.orderId, row); f.data.open.orders = [row]
  f.data.holdings.items = [{ symbol: '005930', marketCountry: 'KR', currency: 'KRW', quantity: '2', averagePurchasePrice: '100050' }]; f.data.sellable.sellableQuantity = '2'
  const intents = [{ ...f.intent, orderNumber: row.orderId }]
  let result = await f.gateway.reconcile({ ...f.input, intents })
  assert.equal(result.complete, true); assert.equal(result.orders[0].filledNotional, 200100); assert.equal(result.orders[0].filledQuantity, 2)
  assert.equal(result.orders[0].lastFilledAt, '2026-11-16T00:00:02.000Z'); assert.deepEqual(result.orders[0].executions, []); assert.equal(result.orders[0].fillEvidence, 'cumulative')
  row.status = 'CANCELED'; f.data.open.orders = []
  result = await f.gateway.reconcile({ ...f.input, intents })
  assert.equal(result.complete, true); assert.equal(result.orders[0].status, 'cancelled'); assert.equal(result.orders[0].filledQuantity, 2)
  f.rows.get(row.orderId).symbol = '000660'
  result = await f.gateway.reconcile({ ...f.input, intents })
  assert.equal(result.complete, false); assert.equal(result.orders[0].status, 'unknown')
})

test('malformed OPEN paging is rejected and asynchronous cancel rejection is explicit rather than terminal parent cancellation', async () => {
  const f = fixture(); f.data.open.hasNext = true
  await assert.rejects(f.gateway.inspect(f.input), { code: 'trading_open_orders_incomplete' })
  f.data.open.hasNext = false
  const parent = order(); f.rows.set(parent.orderId, parent); f.data.open.orders = [parent]
  const original = { ...f.intent, orderNumber: parent.orderId }
  f.rows.set('cancel-operation-id', { ...parent, orderId: 'cancel-operation-id', status: 'CANCEL_REJECTED' })
  const result = await f.gateway.reconcile({ ...f.input, intents: [original], operations: [{ id: randomUUID(), orderNumber: 'cancel-operation-id', metadata: { parentIntentId: original.id } }] })
  assert.equal(result.complete, false); assert.equal(result.reason, 'trading_toss_cancel_rejected'); assert.equal(result.orders[0].status, 'open'); assert.equal(result.operations[0].status, 'rejected')
})

test('unknown statuses, false full-fill claims and missing actual fill time never become confirmed fills', () => {
  for (const row of [order({ status: 'FUTURE_STATUS' }), order({ status: 'FILLED' }), order({ status: 'PENDING_REPLACE' })]) assert.equal(parseTossTradingOrder(row).status, 'unknown')
  assert.throws(() => parseTossTradingOrder(order({ status: 'PARTIAL_FILLED', execution: { filledQuantity: '2', filledAmount: '200000', averageFilledPrice: '100000', filledAt: null } })), { code: 'trading_toss_fill_unconfirmed' })
  assert.equal(parseTossTradingOrder(order({ quantity: '5.000', execution: { filledQuantity: '0.000' } })).quantity, 5)
  assert.throws(() => parseTossTradingOrder(order({ quantity: '5.5' })), { code: 'trading_toss_order_invalid' })
})

test('final transport guard rechecks opening time and runtime flags even after a SQL permit', async () => {
  const f = fixture(), signalIntent = { ...f.intent, metadata: { signalDay: session.previous } }
  const result = await f.gateway.submit({ ...f.input, intent: signalIntent, beforeWrite: async () => { f.controls.now += 60_000; return { allowed: true } } })
  assert.equal(result.status, 'rejected'); assert.equal(result.notTransmitted, true); assert.ok(!f.calls.some(row => row.method === 'POST'))
  const other = fixture()
  const disabled = await other.gateway.submit({ ...other.input, intent: other.intent, beforeWrite: async () => { other.settings.liveEnabled = false; return { allowed: true } } })
  assert.equal(disabled.status, 'rejected'); assert.equal(disabled.notTransmitted, true); assert.ok(!other.calls.some(row => row.method === 'POST'))
})

test('a stale or falsely KRX-specific execution policy cannot reach Toss writes', async () => {
  const f = fixture()
  await assert.rejects(f.gateway.submit({ ...f.input, intent: f.intent, executionPolicy: { ...f.gateway.capabilities().executionPolicy, route: 'KRX' } }), { code: 'trading_policy_changed' })
  assert.equal(f.calls.length, 0)
})
