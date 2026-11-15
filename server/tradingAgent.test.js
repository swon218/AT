import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { createTradingController, registerTradingRoutes, tradingDisplay } from './tradingAgent.js'
import { createTradingWorker } from './tradingWorker.js'
import { accountRef } from './personalBroker.js'
import { tradingCredentialVersion } from './tradingBrokerGateway.js'
import { proxyTarget } from '../api/agent-proxy.js'

const origin = 'https://atlas.example'
function controllerFixture() {
  const owner = randomUUID(), outsider = randomUUID(), strategyId = randomUUID(), configId = randomUUID(), previewId = randomUUID(), sessionId = randomUUID()
  const account = { user: { id: owner }, credentials: { kiwoomAppKey: 'fixture-personal-key', kiwoomSecretKey: 'fixture-personal-secret' }, status: { kiwoomConfigured: true } }
  const auth = { appKey: account.credentials.kiwoomAppKey, secretKey: account.credentials.kiwoomSecretKey }
  const ref = accountRef(account, 'kiwoom', auth, 'linked'), version = tradingCredentialVersion(account, 'kiwoom', auth)
  const strategy = { id: strategyId, name: '테스트 익절·손절', revision: 1, schema_version: 2, indicators: [], backtest_settings: { takeProfitPct: 5, stopLossPct: 2, entryMode: 'all', entryConditions: [] } }
  const spec = { code: '005930', broker: 'kiwoom', accountRef: ref, strategyId, strategyRevision: 1, quantity: 1, quantityMode: 'fixed', entryAction: 'once' }
  const ctx = { watchlist: [{ code: '005930', name: '삼성전자' }], strategies: [strategy], configs: [{ id: configId, revision: 1, code: '005930', spec }],
    sessions: [{ id: sessionId, owner_id: owner, broker: 'kiwoom', account_ref: ref, code: '005930', status: 'waiting_signal', snapshot: { spec, strategy, credentialVersion: version }, state: {} }], intents: [], events: [] }
  const preview = { id: previewId, spec, mode: 'LIVE', credentialVersion: version, initialState: { unmanagedQuantity: 0, position: null } }
  const calls = [], inspections = [], chartCalls = [], loaded = []
  const controls = { account, inspected: { complete: true, eligible: true, accountRef: ref, credentialVersion: version, cashAvailable: 1_000_000, holdingQuantity: 0, sellableQuantity: 0, averagePrice: null, openOrders: [] },
    flags: { workerEnabled: true, liveEnabled: true, paperEnabled: false }, loadAccount: null, startReplay: null, ordersEnabled: true,
    chartResult: { candles: [{ time: '2026-11-13', open: 100, high: 110, low: 90, close: 105, volume: 10 }], metadata: { source: 'kiwoom', sourceBroker: 'kiwoom', market: 'KRX', fallback: false } } }
  const store = { call: async (action, actor, payload) => {
    calls.push({ action, actor, payload })
    assert.equal(actor, owner)
    if (action === 'context') return ctx
    if (action === 'preview_start') return { id: previewId, expiresAt: '2026-11-16T01:00:00Z', credentialVersion: 'PRIVATE_INTERNAL_VERSION', providerRaw: 'PRIVATE_PROVIDER_RAW' }
    if (action === 'preview_read') return preview
    if (action === 'start_read') return controls.startReplay
    if (['save_config', 'start', 'stop'].includes(action)) return {}
    throw new Error(`unexpected_fixture_action_${action}`)
  } }
  const gateway = {
    capabilities: broker => ({ broker, supported: broker === 'kiwoom', ordersEnabled: controls.ordersEnabled }),
    inspect: async input => { inspections.push(input); return controls.inspected },
    candles: async input => { chartCalls.push(input); return controls.chartResult },
    submit: async () => assert.fail('controller must not submit an order'),
    cancel: async () => assert.fail('controller must not cancel an order'),
  }
  const controller = createTradingController({ store, gateway, flags: () => controls.flags,
    loadAccount: async actor => { loaded.push(actor); assert.equal(actor, owner); return controls.loadAccount ? controls.loadAccount(loaded.length) : controls.account },
    connection: async () => ({ connected: true, expiresAt: 1000000 }), now: () => Date.parse('2026-11-16T00:00:00Z') })
  return { owner, outsider, ref, version, account, ctx, controls, preview, strategy, spec, configId, previewId, sessionId, calls, inspections, loaded, chartCalls, controller }
}

test('all browser routes authenticate the session owner and reject unrelated origins before invoking controller', async () => {
  const app = Fastify(), calls = [], owner = randomUUID()
  const controller = Object.fromEntries(['context', 'connections', 'save', 'preview', 'start', 'stop', 'chart'].map(action => [action, async (actor, input) => { calls.push({ action, actor, input }); return { ok: true } }]))
  registerTradingRoutes(app, { controller, origin, engine: { tick: async () => assert.fail('browser route reached worker') }, authenticate: async request => {
    if (request.headers.authorization !== 'Bearer fixture') throw Object.assign(new Error('PRIVATE auth original'), { statusCode: 401 })
    return { id: owner }
  } })
  try {
    const routes = [['GET', ''], ['GET', '/connections'], ['POST', '/config'], ['POST', '/preview'], ['POST', '/start'], ['POST', '/stop'], ['GET', '/chart']]
    for (const [method, path] of routes) {
      const request = { method, url: '/api/agent/trading' + path, ...(method === 'POST' ? { payload: { ownerId: 'forged-user' } } : {}) }
      assert.equal((await app.inject({ ...request, headers: { origin } })).statusCode, 401)
      assert.equal((await app.inject({ ...request, headers: { origin: 'https://unrelated.example', authorization: 'Bearer fixture' } })).statusCode, 403)
      assert.equal((await app.inject({ ...request, headers: { origin, authorization: 'Bearer fixture', 'sec-fetch-site': 'cross-site' } })).statusCode, 403)
      const response = await app.inject({ ...request, headers: { origin, authorization: 'Bearer fixture' } })
      assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'private, no-store')
      assert.ok(!response.body.includes('PRIVATE'))
    }
    assert.equal(calls.length, routes.length)
    assert.ok(calls.every(call => call.actor === owner))
  } finally { await app.close() }
})

test('internal ticks require loopback plus a dedicated secret and are not exposed by the Vercel proxy', async () => {
  const app = Fastify(), secret = 'fixture-internal-'.repeat(3); let ticks = 0
  registerTradingRoutes(app, { controller: {}, origin, secret, engine: { tick: async () => { ticks++; return { status: 'disabled', processed: 0 } } }, authenticate: async () => assert.fail('internal tick used browser authentication') })
  try {
    const request = { method: 'POST', url: '/api/internal/trading/tick', payload: {} }
    assert.equal((await app.inject(request)).statusCode, 401)
    assert.equal((await app.inject({ ...request, headers: { 'x-atlas-trading': 'wrong' } })).statusCode, 401)
    assert.equal((await app.inject({ ...request, remoteAddress: '203.0.113.10', headers: { 'x-atlas-trading': secret } })).statusCode, 401)
    assert.equal((await app.inject({ ...request, headers: { origin, 'x-atlas-trading': secret } })).statusCode, 401)
    const result = await app.inject({ ...request, remoteAddress: '127.0.0.1', headers: { 'x-atlas-trading': secret } })
    assert.equal(result.statusCode, 200); assert.equal(ticks, 1)
    assert.equal(proxyTarget('/api/agent/trading/../../internal/trading/tick'), null)
    assert.equal(proxyTarget('/api/agent/trading/tick'), null)
    assert.equal(proxyTarget('/api/agent/trading/chart?sessionId=' + randomUUID() + '&interval=일')?.startsWith('/api/agent/trading/chart?'), true)
  } finally { await app.close() }
})

test('saving validated configuration is owner-scoped and does not start or submit orders', async () => {
  const f = controllerFixture()
  await f.controller.save(f.owner, { id: f.configId, expectedRevision: 1, ownerId: f.outsider, spec: { ...f.spec, unexpected: 'do not persist' } })
  const saved = f.calls.find(call => call.action === 'save_config')
  assert.equal(saved.actor, f.owner); assert.equal(saved.payload.spec.code, '005930')
  assert.ok(!Object.hasOwn(saved.payload.spec, 'unexpected'))
  assert.equal(f.calls.filter(call => ['preview_start', 'start'].includes(call.action)).length, 0)
  assert.equal(f.inspections[0].account.user.id, f.owner)
})

test('watchlist/strategy revision and disabled modes block previews before start persistence', async () => {
  const f = controllerFixture()
  f.controls.flags.liveEnabled = false
  await assert.rejects(f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' }), { code: 'trading_disabled' })
  assert.equal(f.inspections.length, 0)
  f.controls.flags.liveEnabled = true
  f.controls.ordersEnabled = false
  await assert.rejects(f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' }), { code: 'trading_broker_orders_disabled' })
  assert.equal(f.inspections.length, 0)
  f.controls.ordersEnabled = true
  f.ctx.watchlist = []
  await assert.rejects(f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' }), { code: 'trading_watchlist_required' })
  f.ctx.watchlist = [{ code: '005930' }]; f.ctx.strategies[0].revision = 2
  await assert.rejects(f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' }), { code: 'trading_strategy_changed' })
  assert.ok(!f.calls.some(call => call.action === 'preview_start'))
})

test('credentials changing during an account read invalidate configuration and preview', async () => {
  const f = controllerFixture()
  const changed = { ...f.account, credentials: { ...f.account.credentials, kiwoomSecretKey: 'different-fixture-secret' } }
  f.controls.loadAccount = count => count === 1 ? f.account : changed
  await assert.rejects(f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' }), { code: 'trading_credentials_changed' })
  assert.ok(!f.calls.some(call => call.action === 'preview_start'))
})

test('preview is read-only, masks internal account metadata and requires explicit adoption of existing holdings', async () => {
  const f = controllerFixture()
  let result = await f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' })
  assert.equal(result.id, f.previewId)
  assert.ok(!JSON.stringify(result).includes('PRIVATE_')); assert.ok(!JSON.stringify(result).includes(f.account.credentials.kiwoomSecretKey))
  assert.equal(f.calls.filter(call => call.action === 'start').length, 0)
  f.controls.inspected.holdingQuantity = 5; f.controls.inspected.sellableQuantity = 5; f.controls.inspected.averagePrice = 200000
  await assert.rejects(f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' }), { code: 'trading_external_holding_conflict' })
  f.ctx.configs[0].spec = { ...f.spec, entryAction: 'manage', manageQuantity: 2 }
  result = await f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' })
  const adopted = f.calls.filter(call => call.action === 'preview_start').at(-1).payload.initialState
  assert.equal(adopted.position.quantity, 2); assert.equal(adopted.position.costMicros, '400000000000'); assert.equal(adopted.unmanagedQuantity, 3)
  assert.deepEqual(result.summary.holding, { quantity: 2, averagePrice: 200000 })
})

test('start revalidates preview credentials/account and a replay returns current state without duplicate start', async () => {
  const f = controllerFixture(), requestId = randomUUID()
  await assert.rejects(f.controller.start(f.owner, { previewId: f.previewId, requestId, confirmed: false }), { code: 'trading_confirmation_required' })
  f.preview.credentialVersion = 'old-version'
  await assert.rejects(f.controller.start(f.owner, { previewId: f.previewId, requestId, confirmed: true }), { code: 'trading_preview_changed' })
  assert.ok(!f.calls.some(call => call.action === 'start'))
  f.preview.credentialVersion = f.version
  await f.controller.start(f.owner, { previewId: f.previewId, requestId, confirmed: true, ownerId: f.outsider })
  assert.equal(f.calls.filter(call => call.action === 'start').length, 1)
  f.controls.startReplay = { id: f.sessionId }
  const priorReads = f.inspections.length
  await f.controller.start(f.owner, { previewId: f.previewId, requestId, confirmed: true })
  assert.equal(f.calls.filter(call => call.action === 'start').length, 1); assert.equal(f.inspections.length, priorReads)
})

test('private chart lookup is constrained to owner context and personal source without operator fallback', async () => {
  const f = controllerFixture()
  await assert.rejects(f.controller.chart(f.owner, { sessionId: randomUUID(), interval: '일' }), { code: 'trading_not_found' })
  assert.equal(f.chartCalls.length, 0)
  const result = await f.controller.chart(f.owner, { sessionId: f.sessionId, interval: '15분' })
  assert.equal(result.metadata.sourceBroker, 'kiwoom'); assert.equal(f.chartCalls[0].interval, '15분'); assert.equal(f.chartCalls[0].accountRef, f.ref)
  f.controls.chartResult.metadata = { sourceBroker: 'toss', fallback: true }
  await assert.rejects(f.controller.chart(f.owner, { sessionId: f.sessionId, interval: '일' }), { code: 'trading_personal_chart_required' })
})

test('connection results cannot assign an old success to a newly rotated credential/account scope', async () => {
  const f = controllerFixture()
  const changed = { ...f.account, credentials: { ...f.account.credentials, kiwoomSecretKey: 'rotated-fixture-secret' } }
  f.controls.loadAccount = count => count === 1 ? f.account : changed
  const result = await f.controller.connections(f.owner)
  assert.equal(result.kiwoom.connected, false)
  assert.deepEqual(result.kiwoom.accounts, [])
})

test('browser DTO removes broker order ids, credentials, leases, raw positions and intent metadata', () => {
  const f = controllerFixture()
  f.ctx.sessions[0].lease = { token: 'PRIVATE_LEASE' }; f.ctx.sessions[0].credentials = 'PRIVATE_CREDENTIALS'
  f.ctx.sessions[0].snapshot.credentialVersion = 'PRIVATE_VERSION'
  f.ctx.sessions[0].state = { position: { quantity: 2, averagePrice: 100, accountNumber: 'PRIVATE_ACCOUNT', providerRaw: 'PRIVATE_RAW' }, lease: 'PRIVATE_LEASE', closedTrades: [{ quantity: 2, pnl: 5, secret: 'PRIVATE_SECRET' }] }
  f.ctx.intents = [{ id: randomUUID(), broker_order_id: 'PRIVATE_ORDER', metadata: { raw: 'PRIVATE_METADATA' }, quantity: 2, side: 'buy', status: 'accepted' }]
  const dto = tradingDisplay(f.ctx, f.controls.flags, {})
  assert.ok(!JSON.stringify(dto).includes('PRIVATE_'))
  assert.equal(dto.sessions[0].state.position.quantity, 2); assert.equal(dto.sessions[0].state.closedTrades[0].pnl, 5)
})

test('stop is an owner-scoped state request, never a liquidation/cancel API call', async () => {
  const f = controllerFixture()
  await f.controller.stop(f.owner, { sessionId: f.sessionId, expectedRevision: 1, abandon: false, ownerId: f.outsider })
  const action = f.calls.find(call => call.action === 'stop')
  assert.equal(action.actor, f.owner); assert.equal(action.payload.abandon, false); assert.equal(f.inspections.length, 0)
})

test('worker is loopback-only and sends only a fenced empty tick, never broker credentials or order bodies', async () => {
  for (const url of ['https://127.0.0.1:3000', 'http://remote.example', 'http://127.0.0.1:3000/private', 'http://user:password@127.0.0.1:3000']) assert.throws(() => createTradingWorker({ origin: url }), /trading_loopback_required/)
  let calls = 0
  const disabled = createTradingWorker({ secret: '', fetcher: async () => assert.fail('disabled worker called network') })
  assert.equal((await disabled()).status, 'disabled')
  const secret = 'fixture-worker-secret-'.repeat(2)
  const tick = createTradingWorker({ secret, fetcher: async (url, options) => {
    calls++; assert.equal(url.href, 'http://127.0.0.1:3000/api/internal/trading/tick'); assert.equal(options.method, 'POST'); assert.equal(options.body, '{}'); assert.equal(options.redirect, 'error')
    assert.deepEqual(Object.keys(options.headers).sort(), ['Content-Type', 'X-Atlas-Trading'])
    return { ok: true, json: async () => ({ status: 'ok', processed: 2, credentials: 'PRIVATE_SECRET', owner_id: 'PRIVATE_OWNER', brokerRaw: 'PRIVATE_PROVIDER' }) }
  } })
  const report = await tick()
  assert.deepEqual(report, { status: 'ok', processed: 2 }); assert.equal(calls, 1); assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
})
