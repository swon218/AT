import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { createTradingController, registerTradingRoutes, tradingDisplay } from './tradingAgent.js'
import { tradingCredentialVersion } from './tradingBrokerCommon.js'
import { accountRef } from './personalBroker.js'
import { tradingExecutionPolicy } from '../shared/tradingPolicies.js'
import { proxyTarget } from '../api/agent-proxy.js'

const origin = 'https://atlas-v2.example'
function fixture(broker = 'toss') {
  const owner = randomUUID(), other = randomUUID(), sessionId = randomUUID(), configId = randomUUID(), previewId = randomUUID(), strategyId = randomUUID()
  const credentials = broker === 'toss' ? { tossApiKey: 'fixture-toss-key', tossSecretKey: 'fixture-toss-secret' } : { kiwoomAppKey: 'fixture-kiwoom-key', kiwoomSecretKey: 'fixture-kiwoom-secret' }
  const auth = broker === 'toss' ? { apiKey: credentials.tossApiKey, secretKey: credentials.tossSecretKey } : { appKey: credentials.kiwoomAppKey, secretKey: credentials.kiwoomSecretKey }
  const account = { user: { id: owner }, credentials, status: { [`${broker}Configured`]: true }, tradingCredentialEpochs: { [broker]: randomUUID() } }
  const ref = accountRef(account, broker, auth, broker === 'toss' ? 12345 : 'linked'), version = tradingCredentialVersion(account, broker)
  const strategy = { id: strategyId, name: '저장 전략', revision: 1, schema_version: 2, indicators: [], backtest_settings: { takeProfitPct: 5, stopLossPct: 2, entryConditions: [], entryMode: 'all' } }
  const spec = { code: '005930', broker, accountRef: ref, strategyId, strategyRevision: 1, quantity: 2, quantityMode: 'fixed', entryAction: 'once' }
  const session = { id: sessionId, owner_id: owner, broker, account_ref: ref, code: spec.code, mode: 'LIVE', status: 'waiting_signal', revision: 1,
    snapshot: { spec, strategy, credentialVersion: version, executionPolicy: tradingExecutionPolicy(broker), accountLabel: '선택 본인 계좌' }, state: {}, created_at: '2026-11-16T00:00:00Z' }
  const ctx = { watchlist: [{ code: spec.code, name: '삼성전자' }], strategies: [strategy], configs: [{ id: configId, code: spec.code, revision: 1, spec, account_label: '선택 본인 계좌', strategy_snapshot: structuredClone(strategy) }], sessions: [session], intents: [], events: [] }
  const preview = { id: previewId, spec, mode: 'LIVE', credentialVersion: version, executionPolicy: tradingExecutionPolicy(broker), initialState: { unmanagedQuantity: 0, position: null } }
  const calls = [], inspections = [], accountLists = [], loaded = []
  const controls = { account, marker: 'atlas-trading-v2', markerError: false, detailError: false, ordersEnabled: true, connected: true, onAccounts: null,
    flags: { liveEnabled: true, workerEnabled: true, workerReady: true, paperEnabled: false } }
  const store = { call: async (action, actor, payload) => {
    calls.push({ action, actor, payload })
    if (action === 'marker') { assert.equal(actor, null); if (controls.markerError) throw Error('PRIVATE marker transport'); return { version: controls.marker } }
    if (action === 'session') {
      if (controls.detailError) throw Error('PRIVATE DB account/token detail')
      return actor === owner && payload.sessionId === sessionId ? { session, intents: ctx.intents, events: ctx.events } : null
    }
    assert.equal(actor, owner)
    if (action === 'context') return ctx
    if (action === 'preview_start') return { id: previewId, expiresAt: '2026-11-16T00:02:00Z', credentialVersion: 'PRIVATE_VERSION', internal: 'PRIVATE_DB' }
    if (action === 'start_read') return null
    if (action === 'preview_read') return preview
    if (['save_config', 'start', 'stop'].includes(action)) return {}
    throw Error('unexpected fixture action')
  } }
  const gateway = {
    capabilities: value => ({ broker: value, supported: value === broker, ordersEnabled: controls.ordersEnabled, executionPolicy: tradingExecutionPolicy(value) }),
    inspect: async input => { inspections.push(input); return { eligible: true, complete: true, accountRef: ref, accountLabel: '선택 본인 계좌', credentialVersion: version, openOrders: [], holdingQuantity: 0, sellableQuantity: 0, cashAvailable: 1000000 } },
    accounts: async input => { accountLists.push(input); if (controls.onAccounts) await controls.onAccounts(input); return { accounts: [{ ref, label: '선택 본인 계좌' }], credentialVersion: version } },
    submit: async () => assert.fail('controller must not execute a broker order'), cancel: async () => assert.fail('controller must not cancel a broker order'),
  }
  const controller = createTradingController({ store, gateway, flags: () => controls.flags, loadAccount: async actor => { assert.equal(actor, owner); loaded.push(actor); return controls.account },
    connection: async () => ({ connected: controls.connected, expiresAt: 100000 }), now: () => Date.parse('2026-11-16T00:00:00Z') })
  return { owner, other, broker, sessionId, configId, previewId, account, ref, version, spec, strategy, session, ctx, preview, controls, calls, inspections, accountLists, loaded, controller }
}

test('V2 session detail route uses the authenticated owner, hides other owners and rejects invalid or cross-origin requests', async () => {
  const f = fixture(), app = Fastify()
  registerTradingRoutes(app, { controller: f.controller, origin, engine: { tick: async () => assert.fail('detail route reached worker') }, authenticate: async request => {
    const id = request.headers.authorization === 'Bearer owner' ? f.owner : request.headers.authorization === 'Bearer other' ? f.other : null
    if (!id) throw Object.assign(Error('PRIVATE authentication'), { statusCode: 401 })
    return { id }
  } })
  try {
    const url = `/api/agent/trading/session?sessionId=${f.sessionId}`
    assert.equal((await app.inject({ url, headers: { origin } })).statusCode, 401)
    assert.equal((await app.inject({ url, headers: { origin, authorization: 'Bearer other' } })).statusCode, 404)
    assert.equal((await app.inject({ url, headers: { origin: 'https://foreign.example', authorization: 'Bearer owner' } })).statusCode, 403)
    assert.equal((await app.inject({ url: '/api/agent/trading/session?sessionId=bad', headers: { origin, authorization: 'Bearer owner' } })).statusCode, 400)
    const result = await app.inject({ url: url + '&ownerId=' + f.other, headers: { origin, authorization: 'Bearer owner' } })
    assert.equal(result.statusCode, 200); assert.equal(result.json().sessions[0].id, f.sessionId)
    assert.equal(result.headers['cache-control'], 'private, no-store')
    assert.equal(f.calls.filter(call => call.action === 'session').at(-1).actor, f.owner)
    assert.deepEqual(f.calls.filter(call => call.action === 'session').at(-1).payload, { sessionId: f.sessionId })
    f.controls.detailError = true
    const failed = await app.inject({ url, headers: { origin, authorization: 'Bearer owner' } })
    assert.equal(failed.statusCode, 503); assert.ok(!failed.body.includes('PRIVATE'))
    assert.ok(proxyTarget(url)?.startsWith('/api/agent/trading/session?'))
    assert.equal(proxyTarget(url + '&ownerId=' + f.other), null)
  } finally { await app.close() }
})

test('V2 session DTO returns only safe execution detail and the frozen policy, not credentials or order references', async () => {
  const f = fixture()
  f.session.snapshot.strategy = { ...f.strategy, providerRaw: 'PRIVATE_PROVIDER' }
  f.session.snapshot.credentialVersion = 'PRIVATE_VERSION'; f.session.credentials = 'PRIVATE_CREDENTIALS'
  f.session.state = { position: { quantity: 2, costMicros: '200000000000', averagePrice: 100000, accountNumber: 'PRIVATE_ACCOUNT' }, secret: 'PRIVATE_SECRET' }
  f.ctx.intents = [{ id: randomUUID(), session_id: f.sessionId, broker_order_id: 'PRIVATE_ORDER', metadata: { references: { toss: { orderId: 'PRIVATE_ORDER' } } }, quantity: 2, side: 'buy', status: 'accepted' }]
  const detail = await f.controller.session(f.owner, { sessionId: f.sessionId })
  assert.ok(!JSON.stringify(detail).includes('PRIVATE_'))
  assert.equal(detail.sessions[0].state.position.quantity, 2)
  assert.equal(detail.sessions[0].snapshot.executionPolicy.route, 'SOR')
  assert.equal(detail.sessions[0].snapshot.executionPolicy.quoteMarket, 'PROVIDER')
  assert.equal(detail.sessions[0].snapshot.strategy.name, '저장 전략')
})

test('account-list proof is followed by an epoch check so old success cannot be assigned to a newly registered key', async () => {
  const f = fixture()
  f.controls.onAccounts = async () => { f.controls.account = { ...f.account, tradingCredentialEpochs: { toss: randomUUID() } } }
  const result = await f.controller.connections(f.owner)
  assert.equal(f.accountLists.length, 1); assert.equal(f.accountLists[0].broker, 'toss')
  assert.equal(result.toss.connected, false); assert.deepEqual(result.toss.accounts, [])
  assert.equal(result.kiwoom.status, 'unconfigured')
  const independent = fixture()
  independent.controls.onAccounts = async () => { independent.controls.account = { ...independent.account, tradingCredentialEpochs: { ...independent.account.tradingCredentialEpochs, kiwoom: randomUUID() } } }
  const unchanged = await independent.controller.connections(independent.owner)
  assert.equal(unchanged.toss.connected, true); assert.equal(unchanged.toss.accounts[0].ref, independent.ref)
})

test('a failed connection never queries or exposes selectable account options', async () => {
  const f = fixture(); f.controls.connected = false
  const result = await f.controller.connections(f.owner)
  assert.equal(f.accountLists.length, 0); assert.equal(result.toss.status, 'failed'); assert.deepEqual(result.toss.accounts, [])
})

test('Toss preview and start require the V2 storage marker, including marker transport failures', async () => {
  const f = fixture()
  for (const marker of ['atlas-trading-v1', null]) {
    f.controls.marker = marker
    await assert.rejects(f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' }), { code: 'trading_schema_upgrade_required' })
    await assert.rejects(f.controller.start(f.owner, { previewId: f.previewId, requestId: randomUUID(), confirmed: true }), { code: 'trading_schema_upgrade_required' })
  }
  f.controls.markerError = true
  await assert.rejects(f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' }), { code: 'trading_schema_upgrade_required' })
  assert.equal(f.inspections.length, 0)
  assert.ok(!f.calls.some(call => ['preview_start', 'start'].includes(call.action)))
})

test('Toss confirmation persists the official SOR/provider policy while legacy Kiwoom confirmation retains KRX compatibility', async () => {
  const f = fixture()
  const result = await f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' })
  const saved = f.calls.find(call => call.action === 'preview_start').payload
  assert.equal(saved.executionPolicy.route, 'SOR'); assert.equal(saved.executionPolicy.quoteMarket, 'PROVIDER'); assert.equal(saved.accountLabel, '선택 본인 계좌')
  assert.deepEqual(result.summary.executionPolicy, saved.executionPolicy)
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'))
  f.preview.executionPolicy.route = 'KRX'
  await assert.rejects(f.controller.start(f.owner, { previewId: f.previewId, requestId: randomUUID(), confirmed: true }), { code: 'trading_policy_mismatch' })
  assert.ok(!f.calls.some(call => call.action === 'start'))
  const kiwoom = fixture('kiwoom'); kiwoom.controls.marker = 'atlas-trading-v1'; delete kiwoom.preview.executionPolicy
  await kiwoom.controller.start(kiwoom.owner, { previewId: kiwoom.previewId, requestId: randomUUID(), confirmed: true })
  assert.equal(kiwoom.calls.filter(call => call.action === 'start').length, 1)
  const legacy = tradingDisplay({ sessions: [{ ...kiwoom.session, snapshot: { ...kiwoom.session.snapshot, executionPolicy: undefined } }, { ...f.session, snapshot: { ...f.session.snapshot, executionPolicy: undefined } }] }, {}, {})
  assert.equal(legacy.sessions[0].snapshot.executionPolicy.route, 'KRX'); assert.equal(legacy.sessions[1].snapshot.executionPolicy, null)
})

test('saving a connected broker remains separate from disabled broker orders and worker readiness', async () => {
  const f = fixture(); f.controls.ordersEnabled = false
  await f.controller.save(f.owner, { id: f.configId, expectedRevision: 1, spec: f.spec })
  assert.equal(f.calls.filter(call => call.action === 'save_config').length, 1)
  const inspectionCount = f.inspections.length
  await assert.rejects(f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' }), { code: 'trading_broker_orders_disabled' })
  assert.equal(f.inspections.length, inspectionCount)
  f.controls.ordersEnabled = true; f.controls.flags.workerReady = false
  await assert.rejects(f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' }), { code: 'trading_worker_unavailable' })
  f.controls.flags.workerReady = true; f.controls.flags.workerEnabled = false
  await assert.rejects(f.controller.preview(f.owner, { configId: f.configId, configRevision: 1, mode: 'LIVE' }), { code: 'trading_disabled' })
  assert.ok(!f.calls.some(call => ['preview_start', 'start'].includes(call.action)))
})
