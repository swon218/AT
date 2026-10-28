import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness } from './support/agentHarness.js'
import { defaultQuery, presets } from '../src/utils/screener.js'
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'

test('manual HTTP search crosses Node -> FastAPI -> real fixture SQLite without conversation, provider, usage or broker access', async () => {
  const h = await startHarness({ port: 13002, pythonPort: 18012 })
  try {
    const meta = await (await fetch(h.base + '/api/screener')).json()
    assert.equal(meta.universe, 3); assert.equal(meta.quality_ready, true)
    const send = body => fetch(h.base + '/api/screener', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'http://127.0.0.1:15173' }, body: JSON.stringify(body) })
    const response = await send(defaultQuery()); assert.equal(response.status, 200)
    const result = await response.json(); assert.equal(result.coverage.matches, 2)
    assert.deepEqual(result.items.map(r => r.code), ['000660', '005930'])
    const bb = await send({ ...defaultQuery(), conditions: [presets[1].condition()] })
    assert.equal(bb.status, 200); assert.equal((await bb.json()).coverage.valid, 3)
    assert.equal((await send({ ...defaultQuery(), sql: 'select *' })).status, 400)
    assert.equal((await h.db.query('SELECT count(*)::int n FROM atlas_ai.requests')).rows[0].n, 0)
    assert.equal((await h.db.query('SELECT count(*)::int n FROM atlas_ai.rooms')).rows[0].n, 0)
    const cookie = (await fetch(h.base + '/api/agent/status')).headers.get('set-cookie').split(';')[0]
    const headers = { 'Content-Type': 'application/json', cookie }
    const room = await (await fetch(h.base + '/api/agent/rooms', { method: 'POST', headers, body: '{}' })).json()
    const request_id = randomUUID()
    assert.equal((await fetch(`${h.base}/api/agent/rooms/${room.id}/requests`, { method: 'POST', headers, body: JSON.stringify({ request_id, question: 'RSI 30 이하 그리고 종가가 SMA(20) 아래인 종목 찾아줘' }) })).status, 202)
    let reply
    for (let i = 0; i < 100; i++) {
      reply = await (await fetch(`${h.base}/api/agent/requests/${request_id}`, { headers })).json()
      if (reply.status !== 'running') break
      await pause(100)
    }
    assert.equal(reply.status, 'completed', JSON.stringify(reply))
    assert.ok(reply.steps.some(s => s.name === 'screen_stocks'))
    const saved = await (await fetch(`${h.base}/api/agent/rooms/${room.id}/messages`, { headers })).json()
    const set = saved.messages[1].answer.result_sets[0]
    assert.equal(set.query.conditions[1].right.metric.name, 'sma')
    assert.deepEqual(set.items.map(r => r.code), result.items.map(r => r.code))
    assert.equal(saved.messages[1].answer.sources[0].id.startsWith('f_'), true)
  } finally { await h.close() }
})
