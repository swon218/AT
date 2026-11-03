import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { calculateMarketStatus, createMarketCalendar, koreanDate, readCalendar, registerMarketCalendarRoutes } from './marketCalendar.js'

const date = '2026-11-04'
const nextDate = '2026-11-06'
const stamp = (time, day = date) => `${day}T${time}+09:00`
const at = (time, day = date) => Date.parse(stamp(time, day))
const window = (start, end, day) => ({ startTime: stamp(start, day), endTime: stamp(end, day) })
const regular = window('09:00:00', '15:30:00')
const integrated = {
  preMarket: window('08:00:00', '08:50:00'),
  regularMarket: { ...regular, singlePriceAuctionStartTime: stamp('15:20:00') },
  afterMarket: window('15:40:00', '20:00:00'),
}
const nextBusinessDay = {
  date: nextDate,
  integrated: { preMarket: null, regularMarket: null, afterMarket: window('17:30:00', '19:00:00', nextDate) },
}
const payload = (today = { date, integrated }, next = nextBusinessDay) => ({
  result: { today, previousBusinessDay: { date: '2026-11-03' }, nextBusinessDay: next },
})

test('all session boundaries are start inclusive and end exclusive, including auction and gaps', () => {
  const calendar = readCalendar(payload(), date)
  for (const [time, phase, next] of [
    ['07:59:59', 'waiting', 'preMarket'],
    ['08:00:00', 'preMarket', 'regularMarket'],
    ['08:49:59', 'preMarket', 'regularMarket'],
    ['08:50:00', 'waiting', 'regularMarket'],
    ['09:00:00', 'regularMarket', 'afterMarket'],
    ['15:20:00', 'regularMarket', 'afterMarket'],
    ['15:29:59', 'regularMarket', 'afterMarket'],
    ['15:30:00', 'waiting', 'afterMarket'],
    ['15:40:00', 'afterMarket', 'afterMarket'],
    ['19:59:59', 'afterMarket', 'afterMarket'],
    ['20:00:00', 'closed', 'afterMarket'],
    ['22:15:00', 'closed', 'afterMarket'],
  ]) {
    const result = calculateMarketStatus(calendar, at(time))
    assert.equal(result.phase, phase, time)
    assert.equal(result.nextSession.phase, next, time)
  }
  assert.equal(calculateMarketStatus(calendar, at('08:00:00')).transitionAt, new Date(at('08:50:00')).toISOString())
  assert.equal(calculateMarketStatus(calendar, at('20:00:00')).nextSession.startAt, new Date(at('17:30:00', nextDate)).toISOString())
  const adjacent = readCalendar(payload({ date, integrated: { ...integrated, afterMarket: window('15:30:00', '20:00:00') } }), date)
  assert.equal(calculateMarketStatus(adjacent, at('15:30:00')).phase, 'afterMarket')
})

test('holiday uses the exact requested KST date with explicit integrated null, including weekdays', () => {
  for (const day of ['2026-05-05', '2026-11-07']) {
    const calendar = readCalendar(payload({ date: day, integrated: null }, null), day)
    assert.equal(calculateMarketStatus(calendar, at('09:00:00', day)).phase, 'holiday')
  }
  const holiday = readCalendar(payload({ date, integrated: null }), date)
  assert.equal(calculateMarketStatus(holiday, at('10:00:00')).nextSession.label, '애프터마켓')
})

test('partial closures and special hours use only valid sessions; unknown next day stays unknown', () => {
  const calendar = readCalendar(payload({ date, integrated: { preMarket: null, regularMarket: window('10:00:00', '16:30:00'), afterMarket: null } }, null), date)
  assert.equal(calculateMarketStatus(calendar, at('09:59:59')).phase, 'waiting')
  assert.equal(calculateMarketStatus(calendar, at('10:00:00')).phase, 'regularMarket')
  const closed = calculateMarketStatus(calendar, at('16:30:00'))
  assert.equal(closed.phase, 'closed')
  assert.equal(closed.nextSession, null)
})

test('missing fields, invalid times, overlap, and mismatched dates are unavailable', () => {
  for (const today of [
    null, { date }, { date: nextDate, integrated: null },
    { date, integrated: { regularMarket: regular } },
    { date, integrated: { preMarket: null, regularMarket: null, afterMarket: null } },
    { date, integrated: { ...integrated, preMarket: window('08:00:00', '09:30:00') } },
    { date, integrated: { ...integrated, regularMarket: window('11:00:00', '10:00:00') } },
    { date, integrated: { ...integrated, regularMarket: { ...regular, startTime: '2026-11-04T09:00:00' } } },
    { date, integrated: { ...integrated, regularMarket: { ...regular, endTime: stamp('15:30:00', nextDate) } } },
  ]) {
    assert.equal(readCalendar(payload(today), date), null)
    assert.equal(calculateMarketStatus(readCalendar(payload(today), date), at('12:00:00')).label, '장 상태 확인 불가')
  }
})

test('KST midnight uses the new date even if a shared request began the day before', async () => {
  let now = at('23:59:59'), release
  const calls = []
  const gate = new Promise(resolve => { release = resolve })
  const getStatus = createMarketCalendar({ configured: () => true, now: () => now, request: async ({ query }) => {
    calls.push(query.date)
    if (calls.length === 1) await gate
    return payload({ date: query.date, integrated: null })
  } })
  assert.equal(koreanDate(now), date)
  const previous = getStatus()
  now += 1000
  const today = getStatus()
  assert.equal(koreanDate(now), '2026-11-05')
  release()
  for (const result of await Promise.all([previous, today])) assert.equal(result.date, '2026-11-05')
  assert.deepEqual(calls, [date, '2026-11-05'])
})

test('shared calendar cache recalculates transitions during refresh failure and honors Retry-After', async () => {
  let now = at('08:46:00'), calls = 0
  const logs = []
  const getStatus = createMarketCalendar({ configured: () => true, now: () => now, logger: { warn: data => logs.push(data) },
    request: async options => {
      assert.deepEqual(options.query, { date })
      assert.equal(options.path, '/api/v1/market-calendar/KR')
      assert.equal(options.retry, false)
      assert.ok(options.signal instanceof AbortSignal)
      if (++calls === 2) throw Object.assign(new Error('private upstream data'), { statusCode: 429, retryAfter: '3600' })
      return payload()
    },
  })
  const results = await Promise.all([getStatus(), getStatus(), getStatus()])
  assert.equal(calls, 1)
  assert.ok(results.every(result => result.phase === 'preMarket'))
  now = at('08:50:00')
  assert.equal((await getStatus()).phase, 'waiting')
  assert.equal(calls, 1)
  now = at('08:51:00')
  assert.equal((await getStatus()).stale, true)
  now = at('09:00:00')
  const regularStatus = await getStatus()
  assert.equal(regularStatus.phase, 'regularMarket')
  assert.equal(regularStatus.stale, true)
  assert.equal(regularStatus.fetchedAt, results[0].fetchedAt)
  assert.equal(calls, 2)
  assert.deepEqual(logs, [{ status: 429, stage: 'calendar', reason: 'upstream-http' }])
  now = at('09:51:00')
  assert.equal((await getStatus()).stale, false)
  assert.equal(calls, 3)
})

test('new day upstream failure never uses yesterday and neutral route ignores credentials', async t => {
  let now = at('23:59:59')
  const getStatus = createMarketCalendar({ configured: () => true, now: () => now, request: async ({ query }) => {
    if (query.date !== date) throw Object.assign(new Error('private upstream error'), { statusCode: 403, tossStage: 'token' })
    return payload()
  } })
  const app = Fastify()
  t.after(() => app.close())
  registerMarketCalendarRoutes(app, getStatus)
  const url = '/api/public/market/session'
  const guest = await app.inject(url)
  const signedIn = await app.inject({ url, headers: { authorization: 'Bearer fixture' } })
  assert.equal(guest.statusCode, 200)
  assert.equal(guest.headers['cache-control'], 'no-store')
  assert.deepEqual(guest.json(), signedIn.json())
  now += 1000
  const unavailable = await app.inject(url)
  assert.equal(unavailable.statusCode, 503)
  assert.equal(unavailable.json().phase, null)
  assert.equal(unavailable.json().fetchedAt, null)
  assert.doesNotMatch(unavailable.body, /private upstream/)
})
