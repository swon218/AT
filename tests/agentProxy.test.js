import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import handler, { proxyTarget } from '../api/agent-proxy.js'
import { registerAgentRoutes } from '../server/agent.js'
import { testDatabase } from './support/agentDatabase.js'

const ID = '00000000-0000-4000-8000-000000000001'
const rewritten = path => `/api/agent-proxy?__atlas_route=${path}`
function responseCollector() {
  return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    status(n) { this.statusCode = n; return this }, json(value) { this.body = JSON.stringify(value); return this },
    send(value) { this.body = value; return this }, end() { return this } }
}

test('Vercel wildcard rewrite and static function preserve all supported nesting levels and queries', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'))
  assert.deepEqual(config.rewrites, [{ source: '/api/agent/:atlas_route*', destination: '/api/agent-proxy?__atlas_route=:atlas_route*' }])
  for (const route of ['status', 'rooms', `rooms/${ID}`, `rooms/${ID}/messages`, `rooms/${ID}/requests`, `requests/${ID}`]) {
    assert.equal(proxyTarget(`/api/agent/${route}`), `/api/agent/${route}`)
    assert.equal(proxyTarget(rewritten(route)), `/api/agent/${route}`)
    assert.equal(proxyTarget(rewritten(encodeURIComponent(route))), `/api/agent/${route}`)
  }
  assert.equal(proxyTarget(rewritten(`rooms/${ID}/messages`) + '&before=123'), `/api/agent/rooms/${ID}/messages?before=123`)
  assert.equal(proxyTarget(rewritten('rooms') + '&search=test'), '/api/agent/rooms?search=test')
  for (const path of [rewritten('orders'), rewritten('../internal/agent/events'), rewritten('https://evil.example/'),
    rewritten('rooms') + '&__atlas_route=status', '/api/agent/rooms?__atlas_route=status',
    rewritten('rooms') + '&user_id=other', rewritten('rooms') + '&search=x&search=y',
    rewritten(`rooms/${ID}/messages`) + '&target=https://evil.example', '/api/internal/agent/events']) assert.equal(proxyTarget(path), null, path)
})

test('rewritten proxy -> actual Node/SQL supports create, rename, message restore, no-key request and delete', async t => {
  const { db, store } = await testDatabase()
  const app = Fastify()
  registerAgentRoutes(app, { store, cookieSecret: 'test-only-'.repeat(5), internalSecret: 'test-only-'.repeat(5),
    publicOrigin: 'https://app.example', bridge: { async call() { return { key_configured: false, provider: { state: 'api_key_missing' } } } } })
  const previous = process.env.ATLAS_API_ORIGIN
  process.env.ATLAS_API_ORIGIN = 'https://upstream.example'
  const targets = []
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    targets.push(target.href)
    assert.equal(target.origin, 'https://upstream.example')
    assert.equal(options.headers.origin, 'https://app.example')
    assert.equal(options.redirect, 'error')
    const result = await app.inject({ method: options.method, url: target.pathname + target.search, headers: options.headers, ...(options.body ? { payload: options.body } : {}) })
    return new Response(result.body, { status: result.statusCode, headers: result.headers })
  })
  let cookie
  const call = async (route, method = 'GET', body) => {
    const res = responseCollector()
    await handler({ url: rewritten(route), method, headers: { origin: 'https://app.example', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) }, body }, res)
    if (res.headers['set-cookie']) cookie = res.headers['set-cookie'].split(';')[0]
    return { ...res, json: () => JSON.parse(res.body) }
  }
  try {
    assert.equal((await call('status')).statusCode, 200)
    assert.ok(cookie)
    const created = await call('rooms', 'POST', {})
    assert.equal(created.statusCode, 200)
    const id = created.json().id
    const renamed = await call(`rooms/${id}`, 'PUT', { title: 'Nested routing fixture' })
    assert.equal(renamed.statusCode, 200); assert.equal(renamed.json().title, 'Nested routing fixture')
    const messages = await call(`rooms/${id}/messages`)
    assert.equal(messages.statusCode, 200); assert.deepEqual(messages.json().messages, [])
    assert.equal((await call(`rooms/${id}/requests`, 'POST', { request_id: ID, question: 'RSI란?' })).json().error, 'api_key_missing')
    assert.equal((await call(`requests/${ID}`)).statusCode, 404)
    assert.equal((await call(`rooms/${id}`, 'DELETE')).statusCode, 200)
    assert.deepEqual((await call('rooms')).json().rooms, [])
    assert.ok(targets.every(url => !url.includes('__atlas_route')))
    assert.equal((await db.query('SELECT count(*)::int n FROM atlas_ai.requests')).rows[0].n, 0)
    const count = targets.length
    assert.equal((await call('orders')).statusCode, 404)
    assert.equal(targets.length, count)
  } finally {
    if (previous === undefined) delete process.env.ATLAS_API_ORIGIN; else process.env.ATLAS_API_ORIGIN = previous
    t.mock.restoreAll(); await app.close(); await db.close()
  }
})
