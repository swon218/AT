import assert from 'node:assert/strict'
import test from 'node:test'
import { createOrderRequestGuard, missingOrderBrokers, recentOrderScope, orderStatusLabels } from '../src/utils/recentOrders.js'

test('0–3 registered brokers remain blocked; only all four enable the card', () => {
  for (let count = 0; count <= 4; count++) {
    const status = Object.fromEntries(['kiwoom', 'toss', 'nh', 'kb'].map((b, i) => [`${b}Configured`, i < count]))
    assert.equal(missingOrderBrokers(status).length, 4 - count)
  }
})

test('user, credentials, account and refresh changes invalidate rows before an effect starts', () => {
  const original = recentOrderScope('alice', {}, 1, {}, 0)
  for (const scope of [recentOrderScope('bob', {}, 1, {}, 0), recentOrderScope(null, {}, 1, {}, 0), recentOrderScope('alice', {}, 2, {}, 0), recentOrderScope('alice', {}, 1, { nh: 'different' }, 0), recentOrderScope('alice', {}, 1, {}, 1), recentOrderScope('alice', { kbConfigured: true }, 1, {}, 0)]) assert.notEqual(scope, original)
})

test('late result during user switch, logout, key deletion or account change cannot take ownership', async () => {
  const guard = createOrderRequestGuard(), old = guard.next()
  let resolve
  const late = new Promise(done => { resolve = done }).then(() => guard.isCurrent(old))
  guard.cancel(); const next = guard.next(); resolve()
  assert.equal(await late, false); assert.equal(guard.isCurrent(next), true)
  assert.equal(orderStatusLabels.residualCancelled, '잔량취소')
})
