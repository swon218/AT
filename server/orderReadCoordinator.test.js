import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { createOrderReadCoordinator, safeOrderFailure } from './orderReadCoordinator.js'
import { createRecentOrderHandlers, registerRecentOrderRoutes } from './recentOrders.js'
import { createBrokerHistory } from './brokerOrderHistory.js'
import { createNhClient } from './nhClient.js'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const owner = (id = 'alice', key = 'fixture-key') => ({ user: { id }, status: { kiwoomConfigured: true }, credentials: { kiwoomAppKey: key, kiwoomSecretKey: 'fixture-secret', tossApiKey: 'fixture-toss', tossSecretKey: 'fixture-secret' } })
const days = ['2026-11-06']
const request = (user = 'alice', query = {}) => ({ headers: { authorization: `Bearer ${user}` }, query })
const ready = { status: 'ready', accounts: [], items: [] }

test('overlapping list/detail/selection requests share only the same authenticated user, key, broker, account and range', async () => {
  const gate = deferred(); let calls = 0, authCalls = 0
  const handlers = createRecentOrderHandlers({ authenticate: async req => { authCalls++; return owner(req.headers.authorization.slice(7)) },
    calendar: async () => ({ days }), readBroker: async () => { calls++; await gate.promise; return ready } })
  const a = handlers.list(request('alice', { brokers: 'kiwoom' }))
  const b = handlers.list(request('alice', { brokers: 'kiwoom,toss' }))
  const detail = handlers.detail({ ...request(), params: { broker: 'kiwoom', id: 'a'.repeat(64) } }).catch(error => error.statusCode)
  await tick(); assert.equal(calls, 1); assert.equal(authCalls, 3)
  gate.resolve(); await Promise.all([a, b]); assert.equal(await detail, 404)
  await handlers.list(request('alice', { brokers: 'kiwoom' })); assert.equal(calls, 2) // no settled response cache

  const hold = deferred(); calls = 0
  const read = createOrderReadCoordinator({ readBroker: async () => { calls++; await hold.promise; return ready } })
  const variants = [read('kiwoom', owner(), days, ''), read('kiwoom', owner(), days, ''),
    read('kiwoom', owner('bob'), days, ''), read('kiwoom', owner('alice', 'changed-key'), days, ''),
    read('kiwoom', owner(), days, 'a'.repeat(32)), read('kiwoom', owner(), ['2026-11-05'], ''),
    read('nh', owner(), days, '')]
  await tick(); assert.equal(calls, 6)
  hold.resolve(); await Promise.all(variants)
})

test('unauthorized and newly removed keys cannot join existing personal work', async () => {
  const gate = deferred(); let calls = 0, removed = false
  const handlers = createRecentOrderHandlers({ authenticate: async req => {
    if (req.headers.authorization === 'Bearer expired') throw Object.assign(new Error(), { statusCode: 401 })
    const value = owner(); if (removed) delete value.credentials.kiwoomSecretKey; return value
  }, calendar: async () => ({ days }), readBroker: async () => { calls++; await gate.promise; return ready } })
  const first = handlers.list(request('alice', { brokers: 'kiwoom' }))
  await tick(); removed = true
  assert.equal((await handlers.list(request('alice', { brokers: 'kiwoom' }))).brokers[0].status, 'unconfigured')
  await assert.rejects(handlers.list(request('expired')), { statusCode: 401 })
  assert.equal(calls, 1); gate.resolve(); await first
})

test('one cancelled waiter cannot abort another; last waiter aborts upstream and a rapid replacement can rejoin', async () => {
  const gate = deferred(), a = new AbortController(), b = new AbortController(); let upstream, calls = 0
  const read = createOrderReadCoordinator({ cancelGraceMs: 20, readBroker: async (_, __, ___, ____, signal) => { calls++; upstream = signal; return gate.promise } })
  const first = read('kiwoom', owner(), days, '', a.signal)
  const second = read('kiwoom', owner(), days, '', b.signal)
  await tick(); const firstRejected = assert.rejects(first, { name: 'AbortError' }); a.abort(); await firstRejected
  assert.equal(upstream.aborted, false)
  const secondRejected = assert.rejects(second, { name: 'AbortError' }); b.abort(); await secondRejected
  const replacement = read('kiwoom', owner(), days, '')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls, 1); assert.equal(upstream.aborted, false)
  gate.resolve(ready); assert.deepEqual(await replacement, ready)

  const cancelled = new AbortController(), stopped = deferred(), started = deferred(), logs = []
  const cancellable = createOrderReadCoordinator({ cancelGraceMs: 0, onBrokerError: info => logs.push(info), readBroker: async (_, __, ___, ____, signal) => {
    signal.addEventListener('abort', () => stopped.resolve()); started.resolve(); return new Promise(() => {})
  } })
  const pending = cancellable('kiwoom', owner(), days, '', cancelled.signal)
  await started.promise; const rejected = assert.rejects(pending, { name: 'AbortError' }); cancelled.abort(); await rejected
  await stopped.promise; await tick(); assert.deepEqual(logs, [])
})

test('429 cooldown blocks repeat list/detail calls without caching responses or sharing users/keys', async () => {
  let calls = 0, at = 1000; const logs = []
  const read = createOrderReadCoordinator({ now: () => at, onBrokerError: info => logs.push(info), readBroker: async () => {
    calls++; throw Object.assign(new Error('token=secret 12345678901'), { statusCode: 429, retryAfter: '2', orderStage: 'orders_closed' })
  } })
  await assert.rejects(read('toss', owner(), days, ''), { statusCode: 429, retryAfterSeconds: 2 })
  await assert.rejects(read('toss', owner(), days, 'different-account'), { statusCode: 429 })
  assert.equal(calls, 1); assert.equal(logs.length, 1)
  await assert.rejects(read('toss', owner('bob'), days, ''))
  assert.equal(calls, 2)
  const different = owner(); different.credentials.tossApiKey = 'changed'
  await assert.rejects(read('toss', different, days, '')); assert.equal(calls, 3)
  at += 2001; await assert.rejects(read('toss', owner(), days, '')); assert.equal(calls, 4)
  assert.ok(!JSON.stringify(logs).includes('secret'))
})

test('deadline and safe diagnostics retain only bounded metadata; settled errors are not reused', async () => {
  const logs = []; let calls = 0
  const read = createOrderReadCoordinator({ timeoutMs: 10, onBrokerError: info => logs.push(info), readBroker: async () => { calls++; return new Promise(() => {}) } })
  for (let i = 0; i < 2; i++) await assert.rejects(read('kiwoom', owner(), days, ''), { statusCode: 504 })
  assert.equal(calls, 2); assert.equal(logs.length, 2); assert.equal(logs[0].category, 'timeout')
  assert.deepEqual(safeOrderFailure('kiwoom', { statusCode: 200, returnCode: 1234, orderStage: 'kt00007', message: 'secret' }),
    { broker: 'kiwoom', stage: 'kt00007', category: 'broker_unavailable', timeout: false, upstreamStatus: 200, brokerCode: '1234' })
  assert.deepEqual(safeOrderFailure('toss', { statusCode: 'token=secret', brokerCode: '12345678901', orderStage: 'https://secret', code: 'secret' }),
    { broker: 'toss', stage: 'lookup', category: 'broker_unavailable', timeout: false })
})

test('real adapter errors identify the failed TR/stage and preserve NH HTTP 429 through its client', async () => {
  const kiwoom = createBrokerHistory({ pause: async () => {}, kiwoom: async () => { throw Object.assign(new Error('private raw response'), { statusCode: 200, returnCode: 1234 }) } })
  await assert.rejects(kiwoom('kiwoom', owner(), days), { orderStage: 'kt00007', returnCode: 1234 })
  const toss = createBrokerHistory({ tossAccount: async () => ({ accountSeq: 1 }), toss: async def => {
    if (def.query.status === 'CLOSED') throw Object.assign(new Error('secret'), { statusCode: 429 })
    return { result: { orders: [], hasNext: false } }
  } })
  await assert.rejects(toss('toss', owner(), days), { orderStage: 'orders_closed', statusCode: 429 })
  const nh = createNhClient({ throttle: async () => {}, fetcher: async url => String(url).includes('/oauth2/')
    ? new Response(JSON.stringify({ access_token: 'fixture', expires_in: 86400 }))
    : new Response('{}', { status: 429, headers: { 'Retry-After': '3' } }) })
  await assert.rejects(nh.request({ appKey: 'fixture', secretKey: 'fixture' }, '/krstock/inquiry/v1/dailyOrderExecution'), { upstreamStatus: 429, retryAfter: '3' })
})

test('route disconnect actually releases the last upstream waiter', { timeout: 5000 }, async t => {
  const started = deferred(), stopped = deferred()
  const app = Fastify(); t.after(() => app.close())
  registerRecentOrderRoutes(app, createRecentOrderHandlers({ authenticate: async () => owner(), calendar: async () => ({ days }), cancelGraceMs: 0,
    readBroker: async (_, __, ___, ____, signal) => { started.resolve(); signal.addEventListener('abort', () => stopped.resolve()); return new Promise(() => {}) } }))
  await app.listen({ host: '127.0.0.1', port: 0 })
  const controller = new AbortController()
  const pending = fetch(`http://127.0.0.1:${app.server.address().port}/api/account/orders/recent?brokers=kiwoom`, { signal: controller.signal, headers: { authorization: 'Bearer fixture' } })
  await started.promise; const rejected = assert.rejects(pending, { name: 'AbortError' }); controller.abort(); await rejected
  await stopped.promise
})

test('rate-limit results are distinguishable and detail cooldown returns 429 without another upstream call', async t => {
  let calls = 0; const logs = []
  const app = Fastify(); t.after(() => app.close())
  registerRecentOrderRoutes(app, createRecentOrderHandlers({ authenticate: async () => owner(), calendar: async () => ({ days }),
    onBrokerError: info => logs.push(info), readBroker: async () => {
      calls++; throw Object.assign(new Error('token=private account=12345678901'), { statusCode: 502, upstreamStatus: 429, retryAfter: '10', orderStage: 'kt00007' })
    } }))
  const headers = { authorization: 'Bearer fixture' }
  const first = await app.inject({ url: '/api/account/orders/recent?brokers=kiwoom', headers })
  assert.equal(first.statusCode, 200)
  assert.equal(first.json().brokers[0].error, 'rate_limited')
  const detail = await app.inject({ url: `/api/account/orders/recent/kiwoom/${'a'.repeat(64)}`, headers })
  assert.equal(detail.statusCode, 429); assert.ok(Number(detail.headers['retry-after']) > 0)
  assert.equal(calls, 1); assert.equal(logs.length, 1)
  assert.ok(!JSON.stringify([first.json(), detail.json(), logs]).includes('private'))
})
