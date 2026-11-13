import assert from 'node:assert/strict'
import test from 'node:test'
import { createTossChartService } from './tossCharts.js'

const seconds = value => Math.floor(Date.parse(value) / 1000)
const at = seconds('2026-11-13T08:00:00+09:00')
const auth = { apiKey: 'fixture-client', secretKey: 'fixture-secret', cacheScope: 'fixture' }
function row(timestamp, extra = {}) {
  return {
    timestamp: typeof timestamp === 'number' ? new Date(timestamp * 1000).toISOString() : timestamp,
    openPrice: '100', highPrice: '110', lowPrice: '90', closePrice: '105', volume: '10', currency: 'KRW',
    ...extra,
  }
}
const minuteRows = (count, last = at + count * 60) => Array.from({ length: count }, (_, index) => row(last - index * 60))
const fixture = (rows, options = {}) => {
  const calls = []
  const service = createTossChartService({
    requestSpacingMs: 0,
    ...options,
    request: async input => {
      calls.push(input)
      const available = rows.filter(item => !input.query.before || Date.parse(item.timestamp) <= Date.parse(input.query.before))
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      const candles = available.slice(0, input.query.count)
      return { result: { candles, nextBefore: available.length > candles.length ? candles.at(-1).timestamp : null } }
    },
  })
  return { ...service, calls }
}

test('Toss 1m preserves official end timestamps, offsets, and returned extended-hour records', async () => {
  const service = fixture([
    row('2026-11-13T08:01:00+09:00'),
    row('2026-11-13T15:31:00+09:00'),
    row('2026-11-13T20:00:00+09:00'),
  ])
  const response = await service.getTossCandleResponse('005930', '1분', 3, auth)
  assert.deepEqual(response.items.map(item => item.time), [
    seconds('2026-11-13T08:01:00+09:00'), seconds('2026-11-13T15:31:00+09:00'), seconds('2026-11-13T20:00:00+09:00'),
  ])
  assert.deepEqual(service.calls[0].query, { symbol: '005930', interval: '1m', count: 3, before: '', adjusted: true })
  assert.equal(response.meta.timestampMeaning, 'end')
  assert.equal(response.meta.timeZone, 'Asia/Seoul')
  assert.equal(response.meta.rangeMode, 'recent')
  assert.equal(response.meta.sessionCoverage, 'provider-defined-unverified')
  assert.equal(response.meta.market, 'PROVIDER')
  assert.equal(response.meta.fullDay, false)
  assert.equal(response.meta.partial, false)
  assert.deepEqual(await service.getTossCandles('005930', '1분', 3, auth), response.items)
  assert.equal(service.calls.length, 1)
})

test('all selected minute periods use official 1m, KST buckets, and actual observed end labels', async () => {
  const rows = minuteRows(120)
  for (const factor of [1, 5, 10, 15, 30, 60]) {
    const service = fixture(rows)
    const result = await service.getTossCandleResponse('005930', `${factor}분`, 200, auth)
    assert.equal(service.calls[0].query.interval, '1m')
    assert.equal(result.items.length, 120 / factor)
    assert.equal(result.items[0].time, at + factor * 60)
    assert.equal(result.items.at(-1).time, at + 120 * 60)
    assert.equal(result.items[0].volume, factor * 10)
    assert.equal(result.meta.timestampMeaning, 'end')
    assert.equal(result.meta.partial, true)
    assert.equal(result.meta.partialReason, 'insufficient-history')
    assert.equal(result.meta.hasMore, false)
  }
})

test('resampling preserves chronological OHLCV and does not project an unfinished candle into the future', async () => {
  const service = fixture([
    row(at + 60, { openPrice: '100', highPrice: '112', lowPrice: '98', closePrice: '108', volume: '2' }),
    row(at + 120, { openPrice: '108', highPrice: '120', lowPrice: '95', closePrice: '115', volume: '3' }),
    row(at + 180, { openPrice: '115', highPrice: '118', lowPrice: '90', closePrice: '105', volume: '4' }),
  ])
  const { items } = await service.getTossCandleResponse('005930', '5분', 1, auth)
  assert.deepEqual(items, [{ time: at + 180, open: 100, high: 120, low: 90, close: 105, volume: 9 }])
})

test('a midnight endpoint belongs to its prior KST minute and different dates never combine', async () => {
  const service = fixture([
    row('2026-11-13T23:59:00+09:00'), row('2026-11-14T00:00:00+09:00'), row('2026-11-14T00:01:00+09:00'),
  ])
  const { items } = await service.getTossCandleResponse('005930', '60분', 2, auth)
  assert.deepEqual(items.map(item => [item.time, item.volume]), [
    [seconds('2026-11-14T00:00:00+09:00'), 20], [seconds('2026-11-14T00:01:00+09:00'), 10],
  ])
})

test('missing source minutes and explicit provider session changes split a shared clock bucket', async () => {
  const service = fixture([
    row(at + 60, { session: 'PRE' }), row(at + 120, { session: 'PRE' }),
    row(at + 240, { session: 'PRE' }), row(at + 300, { session: 'REGULAR' }),
    row(at + 360, { session: 'REGULAR' }),
  ])
  const { items } = await service.getTossCandleResponse('005930', '60분', 3, auth)
  assert.deepEqual(items.map(item => [item.time, item.volume]), [[at + 120, 20], [at + 240, 10], [at + 360, 20]])
  assert.ok(items.every(item => !('session' in item)))
})

test('daily, weekly, and monthly candles retain trading dates and chronological groups', async () => {
  const rows = [
    row('2026-10-30T00:00:00+09:00', { openPrice: '70', highPrice: '80', lowPrice: '60', closePrice: '75' }),
    row('2026-11-02T00:00:00+09:00', { openPrice: '80', highPrice: '100', lowPrice: '70', closePrice: '90' }),
    row('2026-11-06T00:00:00+09:00', { openPrice: '90', highPrice: '120', lowPrice: '85', closePrice: '110' }),
    row('2026-11-09T00:00:00+09:00', { openPrice: '110', highPrice: '140', lowPrice: '100', closePrice: '130' }),
  ]
  const service = fixture(rows)
  const daily = await service.getTossCandleResponse('005930', '일', 4, auth)
  assert.deepEqual(daily.items.map(item => item.time), ['2026-10-30', '2026-11-02', '2026-11-06', '2026-11-09'])
  assert.equal(daily.meta.timestampMeaning, 'date')
  const weekly = await service.getTossCandleResponse('005930', '주', 3, auth)
  assert.deepEqual(weekly.items, [
    { time: '2026-10-30', open: 70, high: 80, low: 60, close: 75, volume: 10 },
    { time: '2026-11-02', open: 80, high: 120, low: 70, close: 110, volume: 20 },
    { time: '2026-11-09', open: 110, high: 140, low: 100, close: 130, volume: 10 },
  ])
  const monthly = await service.getTossCandleResponse('005930', '월', 2, auth)
  assert.deepEqual(monthly.items, [
    { time: '2026-10-30', open: 70, high: 80, low: 60, close: 75, volume: 10 },
    { time: '2026-11-02', open: 80, high: 140, low: 70, close: 130, volume: 30 },
  ])
  assert.ok(service.calls.every(call => call.query.interval === '1d'))
})

test('inclusive cursors are forwarded verbatim and duplicate source instants are removed', async () => {
  const calls = []
  const cursor = '2026-11-13T08:03:00+09:00'
  const service = createTossChartService({ requestSpacingMs: 0, request: async input => {
    calls.push(input)
    return calls.length === 1
      ? { result: { candles: [row(at + 300), row(at + 240), row(cursor)], nextBefore: cursor } }
      : { result: { candles: [row(at + 180), row(at + 120), row(at + 60)], nextBefore: null } }
  } })
  const response = await service.getTossCandleResponse('005930', '1분', 5, auth)
  assert.deepEqual(response.items.map(item => item.time), [1, 2, 3, 4, 5].map(value => at + value * 60))
  assert.equal(calls[1].query.before, cursor)
  assert.equal(response.meta.sourceCandleCount, 5)
  assert.equal(response.meta.partial, false)
  assert.equal(response.meta.pagesFetched, 2)
})

test('requesting 500 direct candles paginates past 200 without exceeding official per-call count', async () => {
  const service = fixture(minuteRows(600))
  const response = await service.getTossCandleResponse('005930', '1분', 500, auth)
  assert.equal(response.items.length, 500)
  assert.equal(response.meta.partial, false)
  assert.equal(response.meta.hasMore, true)
  assert.equal(service.calls.length, 3)
  assert.ok(service.calls.every(input => input.query.count >= 1 && input.query.count <= 200))
})

test('cursor stalls retain available direct candles and expose an honest partial range', async () => {
  let calls = 0
  const cursor = row(at + 60).timestamp
  const service = createTossChartService({ requestSpacingMs: 0, request: async () => {
    calls += 1
    return { result: { candles: [row(at + 120), row(at + 60)], nextBefore: cursor } }
  } })
  const response = await service.getTossCandleResponse('005930', '1분', 20, auth)
  assert.equal(calls, 2)
  assert.equal(response.items.length, 2)
  assert.equal(response.meta.partial, true)
  assert.equal(response.meta.partialReason, 'cursor-stalled')
  assert.equal(response.meta.fullDay, false)
})

test('bounded pagination omits a possibly truncated oldest aggregate and reports page-limit', async () => {
  const service = fixture(minuteRows(1000), { maxPages: 2 })
  const response = await service.getTossCandleResponse('005930', '60분', 200, auth)
  assert.equal(service.calls.length, 2)
  assert.equal(response.meta.partialReason, 'page-limit')
  assert.equal(response.meta.hasMore, true)
  assert.equal(response.meta.omittedPartialBucket, true)
  assert.equal(response.meta.sourceCandleCount, 399)
  assert.ok(response.items.length > 0 && response.items.length < 200)
})

test('default hard cap is 15 chart requests and at most 3000 distinct source candles', async () => {
  const service = fixture(minuteRows(5000), { maxPages: 100, maxRawCandles: 10_000 })
  const response = await service.getTossCandleResponse('005930', '60분', 500, auth)
  assert.equal(service.calls.length, 15)
  assert.ok(response.meta.sourceCandleCount <= 3000)
  assert.equal(response.meta.partialReason, 'page-limit')
})

test('later provider failures return partial data without leaking provider error content', async () => {
  let calls = 0
  const service = createTossChartService({ requestSpacingMs: 0, request: async () => {
    calls += 1
    if (calls > 1) throw Object.assign(new Error('private-provider-detail'), { statusCode: 429 })
    return { result: { candles: minuteRows(3), nextBefore: row(at + 60).timestamp } }
  } })
  const response = await service.getTossCandleResponse('005930', '1분', 10, auth)
  assert.equal(response.items.length, 3)
  assert.equal(response.meta.partialReason, 'rate-limit')
  assert.ok(!JSON.stringify(response).includes('private-provider-detail'))
})

test('a valid empty or exhausted short history stays a normal response with unavailable-count metadata', async () => {
  for (const rows of [[], minuteRows(2)]) {
    const response = await fixture(rows).getTossCandleResponse('005930', '1분', 10, auth)
    assert.equal(response.items.length, rows.length)
    assert.equal(response.meta.partialReason, 'insufficient-history')
    assert.equal(response.meta.hasMore, false)
    assert.equal('error' in response, false)
  }
})

test('chart pacing uses the documented 20 TPS client quota and honors Retry-After across cache scopes', async () => {
  let tick = 0
  let calls = 0
  const waits = []
  const callTimes = []
  const service = createTossChartService({
    now: () => tick,
    delay: async (milliseconds, value, { signal }) => { signal.throwIfAborted(); waits.push(milliseconds); tick += milliseconds },
    request: async () => {
      calls += 1
      callTimes.push(tick)
      if (calls === 2) throw Object.assign(new Error('fixture rate limit'), { statusCode: 429, retryAfter: '2' })
      return { result: { candles: minuteRows(2), nextBefore: calls === 1 ? row(at + 60).timestamp : null } }
    },
  })
  const limited = await service.getTossCandleResponse('005930', '1분', 10, auth)
  assert.equal(limited.meta.partialReason, 'rate-limit')
  assert.equal(limited.meta.retryAfterSeconds, 2)
  await service.getTossCandleResponse('000660', '1분', 2, { ...auth, cacheScope: 'other-scope' })
  await service.getTossCandleResponse('035420', '1분', 2, { ...auth, secretKey: 'independent-client' })
  await service.getTossCandleResponse('035420', '1분', 2, auth)
  assert.deepEqual(waits, [50, 2000, 50])
  assert.deepEqual(callTimes, [0, 50, 2050, 2050, 2100])
})

test('one overall deadline includes all pages and returns already fetched candles as partial on timeout', async () => {
  let calls = 0
  const service = createTossChartService({ timeoutMs: 20, requestSpacingMs: 0, request: async ({ signal }) => {
    calls += 1
    if (calls === 1) return { result: { candles: minuteRows(2), nextBefore: row(at + 60).timestamp } }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ result: { candles: [], nextBefore: null } }), 1000)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
    })
  } })
  const started = Date.now()
  const response = await service.getTossCandleResponse('005930', '1분', 20, auth)
  assert.equal(response.items.length, 2)
  assert.equal(response.meta.partialReason, 'timeout')
  assert.equal(response.meta.hasMore, true)
  assert.ok(Date.now() - started < 500)
  assert.equal(calls, 2)
})

test('invalid or host-dependent timestamps are discarded and missing volume is never invented', async () => {
  const service = createTossChartService({ requestSpacingMs: 0, request: async () => ({ result: { candles: [
    row('2026-11-13T08:01:00'), row('not-a-date'), row(at + 60, { volume: '' }),
    row(at + 120, { volume: null }), row(at + 180, { volume: 'NaN' }), row(at + 240, { volume: '0' }),
    row(at + 300, { openPrice: 'NaN' }),
  ], nextBefore: null } }) })
  const response = await service.getTossCandleResponse('005930', '1분', 10, auth)
  assert.equal(response.items.length, 4)
  assert.deepEqual(response.items.map(item => item.volume), [null, null, null, 0])
  assert.equal(response.meta.invalidRowCount, 3)
  assert.equal(response.meta.partialReason, 'invalid-data')
})

test('identical in-flight requests coalesce and cache separates credentials, scope, and period', async () => {
  let calls = 0
  let tick = 0
  let release
  const pending = new Promise(resolve => { release = resolve })
  const service = createTossChartService({ requestSpacingMs: 0, now: () => tick, request: async () => {
    calls += 1
    await pending
    return { result: { candles: minuteRows(2), nextBefore: null } }
  } })
  const first = service.getTossCandleResponse('005930', '1분', 2, auth)
  const second = service.getTossCandleResponse('005930', '1분', 2, auth)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  release()
  assert.deepEqual(await first, await second)
  await service.getTossCandleResponse('005930', '1분', 2, auth)
  assert.equal(calls, 1)
  await service.getTossCandleResponse('005930', '1분', 2, { ...auth, cacheScope: 'other-user' })
  await service.getTossCandleResponse('005930', '1분', 2, { ...auth, secretKey: 'rotated-fixture-secret' })
  await service.getTossCandleResponse('005930', '5분', 2, auth)
  assert.equal(calls, 4)
  tick = 30_001
  await service.getTossCandleResponse('005930', '1분', 2, auth)
  assert.equal(calls, 5)
})

test('caller AbortSignal participates in each request and abort does not become successful partial data', async () => {
  const controller = new AbortController()
  let calls = 0
  let requestSignal
  const service = createTossChartService({ requestSpacingMs: 0, request: async input => {
    assert.ok(input.signal instanceof AbortSignal)
    if (!requestSignal) requestSignal = input.signal
    else assert.equal(input.signal, requestSignal)
    calls += 1
    if (calls === 2) { controller.abort(); assert.equal(input.signal.aborted, true) }
    return { result: { candles: minuteRows(2), nextBefore: row(at + 60).timestamp } }
  } })
  await assert.rejects(service.getTossCandleResponse('005930', '1분', 20, auth, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls, 2)
})

test('input validation runs before requester and failed requests are not cached', async () => {
  let calls = 0
  const service = createTossChartService({ requestSpacingMs: 0, request: async () => { calls += 1; throw new Error('fixture failure') } })
  await assert.rejects(service.getTossCandleResponse('bad', '1분', 10, auth), /6자리/)
  await assert.rejects(service.getTossCandleResponse('005930', '2분', 10, auth), /지원하지/)
  assert.equal(calls, 0)
  for (let retry = 0; retry < 2; retry += 1) {
    await assert.rejects(service.getTossCandleResponse('005930', '1분', 10, auth), /fixture failure/)
  }
  assert.equal(calls, 2)
})
