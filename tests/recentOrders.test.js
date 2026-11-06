import assert from 'node:assert/strict'
import test from 'node:test'
import { createOrderRequestGuard, recentOrderScope, orderStatusLabels, recentOrdersEmptyMessage } from '../src/utils/recentOrders.js'

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

test('missing brokers do not hide a confirmed empty history, but failure or required account never means no trades', () => {
  const result = statuses => ({ items: [], brokers: statuses.map(status => ({ status })) })
  for (const statuses of [['ready'], ['ready', 'ready'], ['ready', 'unconfigured'], ['unconfigured', 'ready', 'ready', 'ready']]) {
    assert.equal(recentOrdersEmptyMessage(result(statuses)), '최근 거래 내역이 없습니다')
  }
  for (const statuses of [['error'], ['ready', 'error'], ['unconfigured', 'error']]) {
    assert.equal(recentOrdersEmptyMessage(result(statuses)), '거래 내역을 불러오지 못했습니다.')
  }
  assert.equal(recentOrdersEmptyMessage(result(['ready', 'accountRequired'])), '조회 계좌를 선택해주세요.')
  assert.equal(recentOrdersEmptyMessage(result(['unconfigured', 'unconfigured'])), '조회 가능한 증권사가 없습니다.')
})
