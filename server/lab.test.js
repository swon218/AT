import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerLabRoutes } from './lab.js'

test('historical endpoints work without login and validate symbol before database access', async () => {
  const app = Fastify()
  let reads = 0
  registerLabRoutes(app, async code => { reads++; return code ? { items: [{ time: '2025-01-02', close: 100 }] } : { ready: true, items: [{ code: '005930' }] } })
  try {
    assert.equal((await app.inject('/api/public/lab/symbols')).statusCode, 200)
    assert.equal((await app.inject('/api/public/lab/candles?symbol=005930')).statusCode, 200)
    assert.equal((await app.inject('/api/public/lab/candles?symbol=00680K')).statusCode, 200)
    assert.equal((await app.inject('/api/public/lab/candles?symbol=../../env')).statusCode, 400)
    assert.equal(reads, 3)
  } finally { await app.close() }
})

test('empty data and reader failures are explicit without private error leakage', async () => {
  const app = Fastify()
  registerLabRoutes(app, async code => { if (!code) throw new Error('/private/db/path'); return { items: [] } })
  try {
    const response = await app.inject('/api/public/lab/symbols')
    assert.equal(response.statusCode, 503)
    assert.ok(!response.body.includes('/private'))
    assert.equal((await app.inject('/api/public/lab/candles?symbol=005930')).statusCode, 404)
  } finally { await app.close() }
})
