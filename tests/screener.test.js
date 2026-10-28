import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultQuery, importQuery, metric, presets, relative, describeQuery } from '../src/utils/screener.js'
import proxy from '../api/screener.js'

test('manual query import and presets retain actual periods, low-touch and scales', () => {
  assert.deepEqual(importQuery(defaultQuery()), defaultQuery())
  assert.equal(importQuery({ ...defaultQuery(), sql: 'select 1' }), null)
  assert.equal(importQuery({ ...defaultQuery(), snapshot_id: 'forged' }), null)
  assert.equal(importQuery({ ...defaultQuery(), conditions: [] }), null)
  assert.equal(presets[1].condition().left.name, 'low')
  assert.equal(presets[3].condition().right.factor, 2)
  assert.equal(metric('macd').slow, 26)
  assert.equal(metric('close').period, 1)
  const q = defaultQuery(); q.conditions[0].right = relative('volume_sma', 2)
  assert.match(describeQuery(q), /2배의 평균 거래량\(20\)/)
})

test('Vercel screen proxy uses one fixed target and never forwards broker/auth cookies', async () => {
  const oldOrigin = process.env.ATLAS_API_ORIGIN, oldFetch = global.fetch
  process.env.ATLAS_API_ORIGIN = 'https://fixture.example'
  let seen
  global.fetch = async (url, options) => { seen = [url.href, options]; return new Response('{"items":[]}', { status: 200 }) }
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, status(s) { this.code = s; return this }, json(v) { this.body = v; return this }, send(v) { this.body = v; return this } }
  try {
    await proxy({ method: 'POST', query: { target: 'https://evil.example' }, headers: { origin: 'https://atlas.example', authorization: 'private', cookie: 'private', 'sec-fetch-site': 'same-origin' }, body: defaultQuery() }, res)
    assert.equal(res.code, 200)
    assert.equal(seen[0], 'https://fixture.example/api/screener')
    assert.deepEqual(Object.keys(seen[1].headers).sort(), ['Content-Type', 'origin', 'sec-fetch-site'])
    assert.equal(res.headers['Cache-Control'], 'no-store')
    global.fetch = async () => new Response('old VPS route missing', { status: 404 })
    await proxy({ method: 'GET', headers: {} }, res)
    assert.equal(res.code, 503)
    assert.deepEqual(res.body, { error: 'screen_unavailable' })
  } finally { global.fetch = oldFetch; if (oldOrigin === undefined) delete process.env.ATLAS_API_ORIGIN; else process.env.ATLAS_API_ORIGIN = oldOrigin }
})
