import assert from 'node:assert/strict'
import test from 'node:test'
import { createOrderRequestGuard, recentOrderScope, orderStatusLabels } from '../src/utils/recentOrders.js'

test('user, credentials, account and broker selections invalidate rows before an effect starts', () => {
  const original = recentOrderScope('alice', {}, 1, {}, ['kiwoom'])
  for (const scope of [recentOrderScope('bob', {}, 1, {}, ['kiwoom']), recentOrderScope(null, {}, 1, {}, ['kiwoom']), recentOrderScope('alice', {}, 2, {}, ['kiwoom']), recentOrderScope('alice', {}, 1, { nh: 'different' }, ['kiwoom']), recentOrderScope('alice', {}, 1, {}, []), recentOrderScope('alice', {}, 1, {}, ['kiwoom', 'toss']), recentOrderScope('alice', { kbConfigured: true }, 1, {}, ['kiwoom'])]) assert.notEqual(scope, original)
})

test('late result during user switch, logout, key deletion or account change cannot take ownership', async () => {
  const guard = createOrderRequestGuard(), old = guard.next()
  let resolve
  const late = new Promise(done => { resolve = done }).then(() => guard.isCurrent(old))
  guard.cancel(); const next = guard.next(); resolve()
  assert.equal(await late, false); assert.equal(guard.isCurrent(next), true)
  assert.equal(orderStatusLabels.residualCancelled, '잔량취소')
})
