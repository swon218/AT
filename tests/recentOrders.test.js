import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeOrderWindow, orderWindowItems, recentOrderScope, recentOrdersEmptyMessage } from '../src/utils/recentOrders.js'
import { orderPeriodError, orderPeriodWindow, recentOrderPeriod } from '../src/utils/orderPeriod.js'

test('user, credentials, account and broker selections invalidate rows before an effect starts', () => {
  const original = recentOrderScope('alice', {}, 1, {}, ['kiwoom'])
  for (const scope of [recentOrderScope('bob', {}, 1, {}, ['kiwoom']), recentOrderScope(null, {}, 1, {}, ['kiwoom']), recentOrderScope('alice', {}, 2, {}, ['kiwoom']), recentOrderScope('alice', {}, 1, { nh: 'different' }, ['kiwoom']), recentOrderScope('alice', {}, 1, {}, []), recentOrderScope('alice', {}, 1, {}, ['kiwoom', 'toss']), recentOrderScope('alice', { kbConfigured: true }, 1, {}, ['kiwoom'])]) assert.notEqual(scope, original)
})

test('KST recent week crosses midnight, year and month boundaries and includes holidays/weekends', () => {
  assert.deepEqual(recentOrderPeriod(Date.parse('2026-01-01T14:59:59Z')), { start: '2025-12-26', end: '2026-01-01' })
  assert.deepEqual(recentOrderPeriod(Date.parse('2026-01-01T15:00:00Z')), { start: '2025-12-27', end: '2026-01-02' })
  assert.deepEqual(recentOrderPeriod(Date.parse('2025-03-01T15:00:00Z')), { start: '2025-02-24', end: '2025-03-02' })
  const { days } = orderPeriodWindow({ start: '2025-12-25', end: '2025-12-31' })
  assert.deepEqual(days, ['2025-12-31', '2025-12-30', '2025-12-29', '2025-12-28', '2025-12-27', '2025-12-26', '2025-12-25'])
})

test('dates include both endpoints, reject nonexistent/future/reversed dates, and page a 31-day past range', () => {
  const now = Date.parse('2026-01-02T00:00:00+09:00')
  const query = (start, end) => orderPeriodError({ start, end }, now)
  assert.equal(query('2024-02-29', '2024-02-29'), '')
  assert.equal(query('2020-01-01', '2020-01-31'), '')
  for (const [start, end] of [['2023-02-29', '2023-03-01'], ['2025-04-31', '2025-05-01'], ['', '2026-01-01'], ['2026-01-02', '2026-01-03'], ['2025-01-03', '2025-01-01'], ['2020-01-01', '2020-02-01']]) assert.ok(query(start, end))
  const period = { start: '2020-01-01', end: '2020-01-31' }
  const all = []
  let before
  do {
    const page = orderPeriodWindow(period, before)
    all.push(...page.days)
    before = page.nextBefore
  } while (before)
  assert.deepEqual(all, Array.from({ length: 31 }, (_, index) => `2020-01-${String(31 - index).padStart(2, '0')}`))
  const scope = period => recentOrderScope('alice', {}, 1, {}, ['kiwoom'], period)
  assert.notEqual(scope(period), scope({ ...period, end: '2020-01-30' }))
})

test('retry merges only the failed broker and keeps previously verified dates and stable ordering', () => {
  const older = { id: 'older', broker: 'nh', date: '2025-01-01' }
  const other = { id: 'other', broker: 'kb', date: '2025-01-02' }
  const recent = { id: 'recent', broker: 'nh', date: '2025-01-03' }
  const previous = { items: [other, recent], brokers: [{ broker: 'kb', status: 'ready' }, { broker: 'nh', status: 'partial' }] }
  const retry = { items: [older], brokers: [{ broker: 'nh', status: 'partial', completedDays: [older.date] }] }
  const next = mergeOrderWindow(previous, retry, ['nh'])
  assert.deepEqual(next.items, [older, other, recent])
  assert.deepEqual(next.brokers.map(result => result.status), ['ready', 'partial'])
  assert.deepEqual(orderWindowItems([next, { items: [older] }]), [older, other, recent])
})

test('missing brokers do not hide a confirmed empty history, but failure or required account never means no trades', () => {
  const result = statuses => ({ items: [], brokers: statuses.map(status => ({ status })) })
  for (const statuses of [['ready'], ['ready', 'ready'], ['ready', 'unconfigured'], ['unconfigured', 'ready', 'ready', 'ready']]) {
    assert.equal(recentOrdersEmptyMessage(result(statuses)), '조회 기간에 거래 내역이 없습니다.')
  }
  for (const statuses of [['error'], ['ready', 'error'], ['unconfigured', 'partial']]) {
    assert.equal(recentOrdersEmptyMessage(result(statuses)), '거래 내역을 모두 확인하지 못했습니다.')
  }
  assert.equal(recentOrdersEmptyMessage(result(['ready', 'accountRequired'])), '조회 계좌를 선택해주세요.')
  assert.equal(recentOrdersEmptyMessage(result(['unconfigured', 'unconfigured'])), '조회 가능한 증권사가 없습니다.')
})
