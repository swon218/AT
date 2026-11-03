import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { createExchangeRateService, registerExchangeRateRoutes } from './exchangeRate.js'

const MINUTE = 60_000
const START = Date.parse('2026-11-04T09:00:00+09:00')
const payload = (now, fields = {}) => ({
  result: {
    baseCurrency: 'USD', quoteCurrency: 'KRW', rate: '1380.5', midRate: '1375.25', basisPoint: '38',
    validFrom: new Date(now).toISOString(), validUntil: new Date(now + MINUTE).toISOString(),
    ...fields,
  },
})

test('public route shares one pending request and caches midRate for 60 seconds', async t => {
  let clock = START, calls = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const getRate = createExchangeRateService({
    now: () => clock,
    configured: () => true,
    request: async options => {
      calls++
      assert.equal(options.path, '/api/v1/exchange-rate')
      assert.deepEqual(options.query, { baseCurrency: 'USD', quoteCurrency: 'KRW' })
      assert.equal(options.retry, false)
      assert.ok(options.signal instanceof AbortSignal)
      await gate
      return payload(clock - 1_000)
    },
  })
  const app = Fastify()
  t.after(() => app.close())
  registerExchangeRateRoutes(app, getRate)
  const pending = [getRate(), getRate(), getRate()]
  assert.equal(calls, 1)
  release()
  const [first, second, third] = await Promise.all(pending)
  assert.deepEqual(first, second)
  assert.deepEqual(first, third)
  assert.equal(first.midRate, 1375.25)
  assert.notEqual(first.validFrom, first.receivedAt)
  const url = '/api/public/market/toss/exchange-rate'
  const guest = await app.inject(url)
  const signedIn = await app.inject({ url, headers: { authorization: 'Bearer test-user' } })
  assert.equal(guest.statusCode, 200)
  assert.equal(guest.headers['cache-control'], 'no-store')
  assert.deepEqual(guest.json(), signedIn.json())
  clock += MINUTE - 1
  assert.equal((await getRate()).stale, true)
  assert.equal(calls, 1)
  clock++
  const renewed = await getRate()
  assert.equal(calls, 2)
  assert.equal(renewed.midRate, first.midRate)
  assert.equal(renewed.stale, false)
  assert.notEqual(renewed.receivedAt, first.receivedAt)
})

test('invalid rate, direction and validity windows return 503 without a fabricated value', async t => {
  for (const fields of [
    { midRate: undefined }, { midRate: 'Infinity' }, { midRate: '0' }, { midRate: '-1' },
    { baseCurrency: 'KRW', quoteCurrency: 'USD' }, { validFrom: 'bad-time' },
    { validFrom: '2026-02-30T09:00:00+09:00' },
    { validUntil: new Date(START).toISOString() }, { validUntil: '2026-11-04T09:01:00' },
    { validFrom: new Date(START + 1).toISOString() },
  ]) {
    const getRate = createExchangeRateService({
      now: () => START, configured: () => true, request: async () => payload(START, fields),
    })
    assert.equal((await getRate()).midRate, null, JSON.stringify(fields))
  }
  const app = Fastify()
  t.after(() => app.close())
  registerExchangeRateRoutes(app, createExchangeRateService({ configured: () => false }))
  const response = await app.inject('/api/public/market/toss/exchange-rate')
  assert.equal(response.statusCode, 503)
  assert.equal(response.json().midRate, null)
  assert.equal(response.json().stale, true)
})

test('refresh failure preserves the last good value and respects 429 Retry-After', async () => {
  let clock = START, calls = 0
  const logs = []
  const getRate = createExchangeRateService({
    now: () => clock, configured: () => true, logger: { warn: data => logs.push(data) },
    request: async () => {
      calls++
      if (calls === 2) throw Object.assign(new Error('upstream sensitive body'), { statusCode: 429, retryAfter: '180' })
      return payload(clock)
    },
  })
  const good = await getRate()
  clock += MINUTE
  assert.deepEqual(await getRate(), { ...good, stale: true })
  clock += 179_999
  assert.deepEqual(await getRate(), { ...good, stale: true })
  assert.equal(calls, 2)
  assert.deepEqual(logs, [{ status: 429, stage: 'exchange-rate', reason: 'upstream-http' }])
  clock++
  assert.equal((await getRate()).stale, false)
  assert.equal(calls, 3)
})

test('token rejection backs off without leaking upstream content or repeating authentication', async () => {
  let clock = START, attempts = 0
  const logs = []
  const getRate = createExchangeRateService({
    now: () => clock, configured: () => true, logger: { warn: data => logs.push(data) },
    request: async () => {
      attempts++
      throw Object.assign(new Error('key and token in upstream text'), { statusCode: 403, tossStage: 'token' })
    },
  })
  const initial = await getRate()
  assert.equal(initial.midRate, null)
  clock += 299_999
  assert.deepEqual(await getRate(), initial)
  assert.equal(attempts, 1)
  assert.deepEqual(logs, [{ status: 403, stage: 'token', reason: 'upstream-http' }])
  clock++
  await getRate()
  assert.equal(attempts, 2)
})
