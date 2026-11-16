// Actual V2 engine + actual router/Toss adapter, with raw HTTP-shaped broker
// fixtures and a persistent, fenced store double. No live broker/model calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createTradingEngine, initialTradingState } from './tradingEngine.js'
import { createTradingBrokerGateway } from './tradingBrokerGateway.js'
import { createTradingTossGateway } from './tradingTossGateway.js'
import { tradingCredentialVersion } from './tradingBrokerCommon.js'
import { accountRef } from './personalBroker.js'
import { tradingExecutionPolicy } from '../shared/tradingPolicies.js'

const clockStart = Date.parse('2026-11-16T09:00:10+09:00')
const calendar = { date: '2026-11-16', previous: '2026-11-13', open: '2026-11-16T09:00:00+09:00', close: '2026-11-16T15:30:00+09:00' }
const active = status => !['filled', 'cancelled', 'rejected'].includes(status)

function integrationFixture() {
  const owner = randomUUID(), runId = randomUUID()
  let clock = clockStart, epoch = 0, busy = false
  const account = { user: { id: owner }, status: { tossConfigured: true }, credentials: { tossApiKey: `fixture-${owner}`, tossSecretKey: 'fixture-only-secret' }, tradingCredentialEpochs: { toss: randomUUID() } }
  const auth = { apiKey: account.credentials.tossApiKey, secretKey: account.credentials.tossSecretKey }
  const ref = accountRef(account, 'toss', auth, 123456789), credential = tradingCredentialVersion(account, 'toss', auth)
  const spec = { code: '005930', broker: 'toss', accountRef: ref, strategyId: randomUUID(), strategyRevision: 1, quantityMode: 'fixed', quantity: 5, entryAction: 'once' }
  const strategy = { id: spec.strategyId, name: '격리 익절·손절', revision: 1, schema_version: 2, indicators: [], backtest_settings: { takeProfitPct: 10, stopLossPct: 5, entryMode: 'all', entryConditions: [] } }
  const session = { id: runId, owner_id: owner, broker: 'toss', account_ref: ref, code: spec.code, mode: 'LIVE', revision: 1, status: 'waiting_signal', watchlisted: true,
    stop_requested: false, abandon_requested: false, state: initialTradingState(), created_at: new Date(clock - 60_000).toISOString(),
    snapshot: { spec, strategy, credentialVersion: credential, executionPolicy: tradingExecutionPolicy('toss') } }
  const intents = [], storeCalls = [], fillsWritten = [], events = [], requests = [], orders = new Map(), posts = []
  const controls = { quotePrice: 100000, cash: 2_000_000, quantity: 0, averagePrice: null, beforeTransport: null, loseResponse: false, crashAfterSettle: false, flags: { liveEnabled: true, workerEnabled: true } }
  const error = code => Object.assign(new Error(code), { code })
  const reserved = () => intents.filter(row => active(row.status)).reduce((sum, row) => sum + Number(row.cash_reservation || 0), 0)
  const store = { async call(action, actor, payload) {
    assert.equal(actor, null)
    storeCalls.push({ action, payload: structuredClone(payload) })
    if (action === 'claim') {
      if (busy) return null
      busy = true
      return { lease: { accountKey: 'fixture-scope', ownerId: owner, broker: 'toss', accountRef: ref, mode: 'LIVE', token: randomUUID(), epoch: ++epoch, reservedCash: reserved() }, sessions: [structuredClone(session)], intents: structuredClone(intents) }
    }
    if (action === 'release') { if (payload.lease.epoch === epoch) busy = false; return true }
    if (payload.lease.epoch !== epoch) throw error('trading_lease_lost')
    if (action === 'renew') return { reservedCash: reserved() }
    if (action === 'prepare_intent') {
      const existing = intents.find(row => row.action_key === payload.actionKey)
      if (existing) return { created: false, intent: structuredClone(existing) }
      assert.ok(payload.cashReservation + reserved() <= payload.cashAvailable || payload.kind !== 'entry')
      const row = { id: randomUUID(), session_id: runId, action_key: payload.actionKey, side: payload.side, quantity: payload.quantity, price: payload.price, kind: payload.kind,
        metadata: structuredClone(payload.metadata), cash_reservation: payload.cashReservation, cumulative_quantity: 0, cumulative_notional: 0, status: 'prepared', created_at: new Date(clock).toISOString() }
      intents.push(row); return { created: true, intent: structuredClone(row) }
    }
    if (action === 'dispatch_intent') {
      const row = intents.find(item => item.id === payload.intentId)
      if (row.status !== 'prepared') return { dispatch: false, intent: structuredClone(row) }
      row.status = 'sending'; return { dispatch: true, intent: structuredClone(row) }
    }
    if (action === 'write_gate') {
      const row = intents.find(item => item.id === payload.intentId)
      if (row.granted || row.status !== 'sending') return { allowed: false, unknown: true }
      if (row.kind === 'entry' && (session.stop_requested || !session.watchlisted) || row.kind !== 'cancel' && session.abandon_requested) {
        row.status = 'rejected'; row.cash_reservation = 0; row.metadata.notTransmitted = true
        return { allowed: false, unknown: false }
      }
      row.granted = true; return { allowed: true }
    }
    if (action === 'settle_intent') {
      const row = intents.find(item => item.id === payload.intentId)
      assert.ok(payload.cumulativeQuantity >= row.cumulative_quantity)
      if (row.broker_order_id && payload.brokerOrderId) assert.equal(payload.brokerOrderId, row.broker_order_id)
      row.status = payload.status; row.broker_order_id ||= payload.brokerOrderId
      row.cumulative_quantity = payload.cumulativeQuantity; row.cumulative_notional = payload.cumulativeNotional
      row.metadata = { ...row.metadata, ...structuredClone(payload.metadata) }
      if (!active(row.status)) row.cash_reservation = 0
      fillsWritten.push(...payload.fills)
      return structuredClone(row)
    }
    if (action === 'commit') {
      if (controls.crashAfterSettle && intents.some(row => row.cumulative_quantity > 0)) { controls.crashAfterSettle = false; throw error('trading_lease_lost') }
      assert.equal(payload.expectedRevision, session.revision)
      session.state = structuredClone(payload.state); session.status = payload.status; session.revision++; events.push(...payload.events)
      return structuredClone(session)
    }
    throw new Error('unexpected fixture action ' + action)
  } }
  const shape = (body, id) => ({ orderId: id, symbol: body.symbol, side: body.side, quantity: body.quantity, price: body.price || null,
    orderType: body.orderType, timeInForce: body.timeInForce, status: 'PENDING', currency: 'KRW', orderedAt: new Date(clock).toISOString(),
    execution: { filledQuantity: '0', filledAmount: null, averageFilledPrice: null, filledAt: null } })
  const request = async definition => {
    if (definition.method === 'POST') {
      if (controls.beforeTransport) await controls.beforeTransport(definition)
      assert.equal(await definition.beforeWrite(), true)
      posts.push(definition)
      if (definition.path.endsWith('/cancel')) {
        const parentId = decodeURIComponent(definition.path.split('/')[4]), parent = orders.get(parentId)
        assert.ok(parent, 'cancel references a real owned parent')
        const operationId = `operation-${posts.length}`
        parent.status = 'PENDING_CANCEL'
        orders.set(operationId, { ...structuredClone(parent), orderId: operationId, status: 'PENDING_CANCEL' })
        return { result: { orderId: operationId } }
      }
      const id = `toss-order-${posts.length}`
      orders.set(id, shape(definition.body, id))
      if (controls.loseResponse) throw new Error('fixture response lost after broker acceptance')
      return { result: { orderId: id, clientOrderId: definition.body.clientOrderId } }
    }
    requests.push(definition)
    if (definition.path.startsWith('/api/v1/orders/')) {
      const row = orders.get(decodeURIComponent(definition.path.slice('/api/v1/orders/'.length)))
      if (!row) throw Object.assign(new Error('fixture missing order'), { statusCode: 404 })
      return { result: structuredClone(row) }
    }
    const results = {
      '/api/v1/accounts': [{ accountSeq: 123456789, accountType: 'BROKERAGE' }],
      '/api/v1/stocks': [{ symbol: spec.code, securityType: 'STOCK', market: 'KOSPI', status: 'ACTIVE', currency: 'KRW', koreanMarketDetail: { liquidationTrading: false, krxTradingSuspended: false, nxtSupported: true, nxtTradingSuspended: false } }],
      '/api/v1/holdings': { items: controls.quantity ? [{ symbol: spec.code, marketCountry: 'KR', currency: 'KRW', quantity: String(controls.quantity), averagePurchasePrice: String(controls.averagePrice) }] : [] },
      '/api/v1/sellable-quantity': { sellableQuantity: String(controls.quantity) },
      '/api/v1/buying-power': { currency: 'KRW', cashBuyingPower: String(controls.cash) },
      '/api/v1/prices': [{ symbol: spec.code, currency: 'KRW', lastPrice: String(controls.quotePrice), timestamp: new Date(clock).toISOString() }],
      '/api/v1/trades': [{ price: String(controls.quotePrice), volume: '1', currency: 'KRW', timestamp: new Date(clock).toISOString() }],
      '/api/v1/price-limits': { currency: 'KRW', timestamp: new Date(clock).toISOString(), upperLimitPrice: '130000', lowerLimitPrice: '70000' },
      '/api/v1/orders': { orders: [...orders.values()].filter(row => ['PENDING', 'PARTIAL_FILLED', 'PENDING_CANCEL'].includes(row.status) && !row.orderId.startsWith('operation-')), hasNext: false, nextCursor: null },
    }
    assert.ok(Object.hasOwn(results, definition.path), 'unexpected broker path ' + definition.path)
    return { result: structuredClone(results[definition.path]) }
  }
  const loadAccount = async id => { assert.equal(id, owner); return account }
  const makeGateway = () => createTradingBrokerGateway({ tossAdapter: createTradingTossGateway({ request, spacingMs: 0, now: () => clock, loadAccount,
    settings: { liveEnabled: () => controls.flags.liveEnabled, workerEnabled: () => controls.flags.workerEnabled, tossOrdersEnabled: true } }),
    kiwoomAdapter: { inspect: async () => assert.fail('Toss run used Kiwoom'), quote: async () => assert.fail('Toss run used Kiwoom') } })
  const options = () => ({ store, gateway: makeGateway(), calendar: async () => calendar, readDaily: async () => assert.fail('risk-only run requested signal candles'), loadAccount,
    now: () => clock, flags: () => controls.flags })
  const fill = (id, qty, notional, status = 'PARTIAL_FILLED') => {
    const row = orders.get(id), oldQty = Number(row.execution.filledQuantity), oldNotional = Number(row.execution.filledAmount || 0), delta = qty - oldQty
    assert.ok(delta >= 0)
    row.execution = { filledQuantity: String(qty), filledAmount: String(notional), averageFilledPrice: String(notional / qty), filledAt: new Date(clock).toISOString() }; row.status = status
    if (row.side === 'BUY') { const oldCost = (controls.averagePrice || 0) * controls.quantity; controls.quantity += delta; controls.averagePrice = (oldCost + notional - oldNotional) / controls.quantity }
    else { controls.quantity -= delta; if (!controls.quantity) controls.averagePrice = null }
  }
  return { owner, ref, account, spec, session, controls, intents, storeCalls, fillsWritten, events, requests, posts, orders,
    engine: () => createTradingEngine(options()), tick: () => createTradingEngine(options()).tick(), fill,
    advance: ms => { clock += ms }, loseLease: () => { epoch++; busy = false } }
}

test('actual V2 engine routes Toss provider quotes and persists exact client/parent ids; a restarted engine never duplicates the POST', async () => {
  const f = integrationFixture()
  const first = await f.tick()
  assert.equal(first.submitted, 1); assert.equal(f.session.status, 'buying'); assert.equal(f.posts.length, 1)
  const entry = f.intents[0]
  assert.equal(entry.metadata.references.toss.orderId, entry.broker_order_id)
  assert.equal(entry.metadata.references.toss.clientOrderId, f.posts[0].body.clientOrderId)
  assert.equal(f.posts[0].body.timeInForce, 'DAY'); assert.ok(!Object.hasOwn(f.posts[0].body, 'exchange'))
  assert.ok(f.requests.some(row => row.path === '/api/v1/trades')); assert.ok(!f.requests.some(row => row.apiId || row.path?.includes('kiwoom')))
  assert.equal(f.session.snapshot.executionPolicy.quoteMarket, 'PROVIDER'); assert.equal(f.session.snapshot.executionPolicy.route, 'SOR')
  await f.tick(); await f.tick()
  assert.equal(f.posts.length, 1); assert.equal(f.intents.length, 1); assert.equal(f.session.status, 'buying')
})

test('weighted cumulative fills survive a crash after durable settlement and produce real owned PnL without fictitious execution rows', async () => {
  const f = integrationFixture(); await f.tick(); const entry = f.intents[0]
  f.advance(1000); f.fill(entry.broker_order_id, 2, 200100)
  f.controls.crashAfterSettle = true
  await assert.rejects(f.tick(), { code: 'trading_lease_lost' })
  assert.equal(entry.cumulative_quantity, 2); assert.equal(f.session.state.position, null)
  await f.tick()
  assert.equal(f.session.state.position.quantity, 2); assert.equal(f.session.state.position.averagePrice, 100050)
  f.advance(1000); f.fill(entry.broker_order_id, 5, 501000, 'FILLED')
  await f.tick(); await f.tick()
  assert.equal(f.session.state.position.quantity, 5); assert.equal(f.session.state.position.averagePrice, 100200); assert.equal(f.posts.length, 1)
  assert.deepEqual(f.fillsWritten, [], 'Toss cumulative summaries must not become fabricated individual executions')
  f.controls.quotePrice = 111000; f.advance(1000)
  await f.tick()
  const exit = f.intents.find(row => row.side === 'sell')
  assert.ok(exit); assert.equal(f.posts.length, 2); assert.equal(f.posts[1].body.orderType, 'MARKET'); assert.equal(exit.quantity, 5)
  f.advance(1000); f.fill(exit.broker_order_id, 5, 550000, 'FILLED')
  await f.tick()
  assert.equal(f.session.state.position, null); assert.equal(f.session.state.closedTrades[0].pnl, 49000)
  assert.equal(f.session.state.closedTrades[0].entryPrice, 100200); assert.equal(f.session.state.closedTrades[0].exitPrice, 110000)
  assert.equal(f.session.state.closedTrades[0].exitAt, f.orders.get(exit.broker_order_id).execution.filledAt)
  await f.tick(); assert.equal(f.posts.length, 2)
})

test('partial stop cancels the owned remainder, preserves the new cancel id, and incorporates a fill racing the cancellation', async () => {
  const f = integrationFixture(); await f.tick(); const entry = f.intents[0], originalNumber = entry.broker_order_id
  f.advance(1000); f.fill(originalNumber, 2, 200100); f.session.stop_requested = true
  f.controls.beforeTransport = async definition => {
    if (definition.path.endsWith('/cancel')) { f.advance(1000); f.fill(originalNumber, 3, 300300); f.controls.beforeTransport = null }
  }
  await f.tick()
  const cancellation = f.intents.find(row => row.kind === 'cancel')
  assert.ok(cancellation); assert.equal(cancellation.status, 'accepted'); assert.equal(f.posts.length, 2)
  assert.equal(cancellation.metadata.references.toss.orderId, originalNumber)
  assert.equal(cancellation.metadata.references.toss.cancelOperationOrderId, cancellation.broker_order_id)
  assert.notEqual(cancellation.broker_order_id, originalNumber); assert.equal(entry.broker_order_id, originalNumber)
  assert.equal(f.session.state.position.quantity, 2, 'cancel acknowledgement is not a fill snapshot')
  await f.tick()
  assert.equal(f.session.state.position.quantity, 3); assert.equal(f.posts.length, 2)
  f.orders.get(originalNumber).status = 'CANCELED'
  await f.tick(); await f.tick()
  assert.equal(entry.status, 'cancelled'); assert.equal(cancellation.status, 'cancelled')
  assert.equal(f.session.state.position.quantity, 3); assert.equal(f.session.state.position.averagePrice, 100100)
  assert.equal(f.session.status, 'stopping'); assert.equal(f.posts.length, 2, 'stop keeps protection and does not liquidate or repeat cancellation')
})

test('asynchronous Toss cancellation rejection persists the operation failure and leaves the real parent open', async () => {
  const f = integrationFixture(); await f.tick(); const entry = f.intents[0]
  f.advance(1000); f.fill(entry.broker_order_id, 2, 200000); f.session.stop_requested = true
  await f.tick()
  const cancellation = f.intents.find(row => row.kind === 'cancel')
  f.orders.get(entry.broker_order_id).status = 'PARTIAL_FILLED'
  f.orders.get(cancellation.broker_order_id).status = 'CANCEL_REJECTED'
  await f.tick()
  assert.equal(cancellation.status, 'rejected'); assert.equal(entry.status, 'partial')
  assert.equal(f.session.status, 'reconciliation_required'); assert.equal(f.session.state.reason, 'trading_toss_cancel_rejected')
  assert.equal(f.session.state.position.quantity, 2); assert.equal(f.posts.length, 2)
})

test('accepted but totally lost response remains unknown across restart and is not guessed from the matching symbol or client id', async () => {
  const f = integrationFixture(); f.controls.loseResponse = true
  await f.tick()
  assert.equal(f.posts.length, 1); assert.equal(f.orders.size, 1); assert.equal(f.intents[0].status, 'unknown'); assert.ok(f.intents[0].cash_reservation > 0)
  assert.ok(f.intents[0].metadata.references.toss.clientOrderId); assert.equal(f.intents[0].broker_order_id, undefined)
  await f.tick(); await f.tick()
  assert.equal(f.posts.length, 1); assert.equal(f.session.status, 'reconciliation_required'); assert.equal(f.session.state.reason, 'trading_toss_order_id_missing')
  assert.ok(f.intents[0].cash_reservation > 0); assert.ok(!f.requests.some(row => row.query?.clientOrderId))
})

test('stop or lease loss after slow preflight but before transport prevents actual Toss writes', async () => {
  const stopped = integrationFixture()
  stopped.controls.beforeTransport = async () => { stopped.session.stop_requested = true }
  await stopped.tick()
  assert.equal(stopped.posts.length, 0); assert.equal(stopped.intents[0].status, 'rejected'); assert.equal(stopped.intents[0].metadata.notTransmitted, true)
  assert.equal(stopped.intents[0].cash_reservation, 0)
  await stopped.tick(); assert.equal(stopped.session.status, 'stopped'); assert.equal(stopped.posts.length, 0)
  const stale = integrationFixture()
  stale.controls.beforeTransport = async () => { stale.loseLease(); stale.controls.beforeTransport = null }
  await assert.rejects(stale.tick(), { code: 'trading_lease_lost' })
  assert.equal(stale.posts.length, 0)
  await stale.tick(); assert.equal(stale.posts.length, 0); assert.ok(stale.intents[0].cash_reservation > 0)
})

test('competing restarted engines cannot reserve or submit twice for the same Toss account', async () => {
  const f = integrationFixture()
  const reports = await Promise.all([f.engine().tick(), f.engine().tick()])
  assert.equal(f.posts.length, 1); assert.equal(f.intents.length, 1)
  assert.equal(reports.filter(report => report.status === 'idle').length, 1)
  assert.ok(f.intents[0].cash_reservation > Number(f.posts[0].body.price) * Number(f.posts[0].body.quantity))
  assert.equal(f.storeCalls.filter(call => call.action === 'write_gate').length, 1)
})
