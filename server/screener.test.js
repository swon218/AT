import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createScreenBridge, registerScreenRoutes } from './screener.js'

const origin = 'https://atlas.example'
test('public screen route checks origin, preserves strict arguments, bounds admission, exposes no raw errors', async () => {
  const received = []
  const app = Fastify()
  registerScreenRoutes(app, { publicOrigin: origin, maxRequests: 3, bridge: { call: async (path, body) => { received.push([path, body]); if (body?.fail) throw new Error('database_secret'); return { ok: true } } } })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/screener', payload: {} })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: '/api/screener', headers: { origin: 'https://other.example' }, payload: {} })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: '/api/screener', headers: { origin }, payload: { extra: 'must reach strict validator' } })).statusCode, 200)
    assert.equal(received[0][1].extra, 'must reach strict validator')
    const failed = await app.inject({ method: 'POST', url: '/api/screener', headers: { origin }, payload: { fail: true } })
    assert.equal(failed.statusCode, 503); assert.deepEqual(failed.json(), { error: 'screen_unavailable' })
    assert.equal((await app.inject('/api/screener')).statusCode, 200)
    assert.equal((await app.inject('/api/screener')).statusCode, 429)
    const tooBig = await app.inject({ method: 'POST', url: '/api/screener', headers: { origin }, payload: { text: 'x'.repeat(17000) } })
    assert.equal(tooBig.statusCode, 413)
  } finally { await app.close() }
})

test('loopback bridge has fixed paths, internal auth only and bounded failure codes', async () => {
  assert.throws(() => createScreenBridge({ base: 'https://external.example' }))
  assert.throws(() => createScreenBridge({ base: 'http://localhost/run' }))
  const seen = []
  const bridge = createScreenBridge({ secret: 's'.repeat(32), fetcher: async (url, options) => { seen.push([url.href, options]); return new Response(JSON.stringify({ detail: 'validation body contains arbitrary input' }), { status: 422 }) } })
  await assert.rejects(bridge.call('/run', {}), /screen_unavailable/)
  await assert.rejects(bridge.call('/screen', { market: 'BAD' }), { message: 'invalid_screen_query', statusCode: 400 })
  assert.equal(seen[0][0], 'http://127.0.0.1:8010/screen')
  assert.deepEqual(Object.keys(seen[0][1].headers).sort(), ['Content-Type', 'X-Atlas-Internal'])
})
