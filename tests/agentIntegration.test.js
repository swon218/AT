import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { startHarness } from './support/agentHarness.js'

test('real HTTP Node -> FastAPI -> adaptive fixture -> read-only tools -> SQL -> restored messages', async () => {
  const h = await startHarness({ port: 13001, pythonPort: 18011 })
  try {
    const response = await fetch(h.base + '/api/agent/status')
    const cookie = response.headers.get('set-cookie').split(';')[0]
    const headers = { 'Content-Type': 'application/json', cookie }
    const room = await (await fetch(h.base + '/api/agent/rooms', { method: 'POST', headers, body: '{}' })).json()
    const request_id = randomUUID(), question = 'RSI 30 이하 종목 중 밤사이 부정적 뉴스 찾아줘'
    const send = () => fetch(`${h.base}/api/agent/rooms/${room.id}/requests`, { method: 'POST', headers, body: JSON.stringify({ request_id, question }) })
    assert.equal((await send()).status, 202)
    const duplicate = await send(); assert.ok([200, 202].includes(duplicate.status))
    let result
    for (let i = 0; i < 120; i++) {
      result = await (await fetch(`${h.base}/api/agent/requests/${request_id}`, { headers })).json()
      if (result.status !== 'running') break
      await pause(100)
    }
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(result.usage.model_calls, 4)
    assert.equal(result.usage.input_tokens, 100)
    assert.equal(result.answer.sources.length, 2)
    assert.equal(result.answer.result_sets[0].items.length, 2)
    assert.ok(result.steps.some(s => s.name === 'screen_rsi'))
    assert.equal(result.steps.filter(s => s.name === 'get_stock_news' && s.status === 'success').length, 2)
    assert.equal((await h.db.query('SELECT count(*)::int n FROM atlas_ai.requests')).rows[0].n, 1)
    const restored = await (await fetch(`${h.base}/api/agent/rooms/${room.id}/messages`, { headers })).json()
    assert.equal(restored.messages.length, 2)
    assert.equal(restored.messages[1].answer.sources.length, 2)
    const other = await fetch(`${h.base}/api/agent/rooms/${room.id}/messages`, { headers: { Authorization: 'Bearer fixture-user-b' } })
    assert.equal(other.status, 404)
  } finally { await h.close() }
})
