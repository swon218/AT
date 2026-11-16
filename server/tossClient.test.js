import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { requestTossWithCredentials } from './tossClient.js'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const credentials = () => ({ apiKey: `fixture-client-${randomUUID()}`, secretKey: 'fixture-secret-not-live' })

test('Toss automatic write fence runs once after token acquisition and immediately before the HTTP order', async t => {
  const previous = globalThis.fetch, events = []
  t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/oauth2/token')) { events.push('token'); return json({ access_token: 'fixture-access-token', expires_in: 86400 }) }
    events.push('order-http')
    assert.equal(options.method, 'POST'); assert.equal(options.headers['X-Tossinvest-Account'], '1234')
    return json({ result: { orderId: 'fixture-order' } })
  }
  const result = await requestTossWithCredentials({ ...credentials(), path: '/api/v1/orders', method: 'POST', accountSeq: 1234, body: {}, retry: false,
    beforeWrite: async () => { events.push('fenced-permit'); return true } })
  assert.equal(result.result.orderId, 'fixture-order')
  assert.deepEqual(events, ['token', 'fenced-permit', 'order-http'])
})

test('denied or uncertain fence never reaches order/cancel HTTP, and sensitive failure text is removed', async t => {
  const previous = globalThis.fetch; let orders = 0, guards = 0
  t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async url => {
    if (String(url).endsWith('/oauth2/token')) return json({ access_token: 'fixture-access-token', expires_in: 86400 })
    orders++; assert.fail('blocked Toss fence reached broker HTTP')
  }
  for (const [index, callback] of [async () => false, async () => { throw Object.assign(new Error('PRIVATE SQL and account raw'), { writeGateUnknown: true }) }].entries()) {
    await assert.rejects(requestTossWithCredentials({ ...credentials(), path: '/api/v1/orders/owned-order/cancel', method: 'POST', accountSeq: 1234, body: {},
      beforeWrite: async () => { guards++; return callback() } }), error => {
      assert.ok(!error.message.includes('PRIVATE')); assert.equal(error.notTransmitted, index === 0); assert.equal(error.writeGateUnknown, index === 1); return true
    })
  }
  assert.equal(orders, 0); assert.equal(guards, 2)
})

test('existing manual writes without the optional fence still execute once and POST is never retried on auth failure', async t => {
  const previous = globalThis.fetch; let orderCalls = 0, tokenCalls = 0
  t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async url => {
    if (String(url).endsWith('/oauth2/token')) { tokenCalls++; return json({ access_token: 'fixture-manual-token', expires_in: 86400 }) }
    orderCalls++; return json({ error: { code: 'unauthorized', message: 'fixture rejection' } }, 401)
  }
  await assert.rejects(requestTossWithCredentials({ ...credentials(), path: '/api/v1/orders', method: 'POST', accountSeq: 1234, body: {}, retry: true }), { statusCode: 401 })
  assert.equal(orderCalls, 1); assert.equal(tokenCalls, 1)
})

test('read-only 401 token refresh is preserved and does not invoke a write fence', async t => {
  const previous = globalThis.fetch; let reads = 0, tokens = 0
  t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async url => {
    if (String(url).endsWith('/oauth2/token')) { tokens++; return json({ access_token: `fixture-read-token-${tokens}`, expires_in: 86400 }) }
    if (++reads === 1) return json({ error: { code: 'unauthorized' } }, 401)
    return json({ result: [] })
  }
  const result = await requestTossWithCredentials({ ...credentials(), path: '/api/v1/accounts', beforeWrite: async () => assert.fail('read invoked order fence') })
  assert.deepEqual(result.result, []); assert.equal(reads, 2); assert.equal(tokens, 2)
})
