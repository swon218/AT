import test from 'node:test'
import assert from 'node:assert/strict'
import { browserTradingReadJson, browserTradingWarmup, normalizeBrowserTradingCandles, mergeBrowserTradingCandles, createBrowserTradingMarket } from '../src/services/browserTradingMarket.js'

const at = Date.parse('2026-11-16T10:00:15+09:00')
const instant = text => Date.parse(text) / 1000
const bar = (time, close = 100, volume = 10) => ({ time, open: close - 1, high: close + 2, low: close - 2, close, volume })
const daily = ['2026-11-06','2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13'].map(day => bar(day))
const strategy = { indicators: [{ id: 'rsi', period: 2, lower: 30, upper: 70, color: '#123456' }, { id: 'bollinger', period: 3, multiplier: 2 }], backtest_settings: { entryConditions: [] } }
const session = (patch = {}) => ({ date: '2026-11-16', phase: 'regularMarket', serverNow: new Date(at).toISOString(), stale: false, source: '토스증권', markets: ['KRX','NXT'],
  currentSession: { phase: 'regularMarket', startAt: '2026-11-16T09:00:00+09:00', endAt: '2026-11-16T15:30:00+09:00' }, ...patch })
function fixture(options = {}) {
  const calls = [], dailyCalls = [], current = { now: at }
  const client = createBrowserTradingMarket({ now: () => current.now, readSession: async () => session(), readScreenMeta: async () => ({ available: true, cutoff: '2026-11-13' }),
    readDaily: async (symbol, signal) => {
      assert.ok(signal instanceof AbortSignal)
      dailyCalls.push(symbol)
      return { ready: true, symbol: { code: symbol, source: 'FDR:NAVER' }, items: daily, quality: { policy: 'naver-close-envelope-1krw-v1', corrected: 0, quarantined: 0, issues: [] } }
    },
    readCandles: async (broker, symbol, period, limit, { signal }) => {
      assert.ok(signal instanceof AbortSignal)
      assert.ok(limit <= 500)
      calls.push({ broker, symbol, period, limit })
      return { items: period === '일' ? daily : ['09:30:00','09:45:00','10:00:00'].map(clock => bar(instant(`2026-11-16T${clock}+09:00`))), sourceBroker: broker,
        meta: { timestampMeaning: period === '일' ? 'date' : broker === 'toss' ? 'end' : 'start', market: broker === 'toss' ? 'PROVIDER' : 'INTEGRATED', invalidRows: 0 } }
    }, ...options })
  return { client, calls, dailyCalls, current }
}
const target = { broker: 'toss', symbol: '089970', scope: 'user-a:credentials-1' }

test('read transport only permits the two existing public GET metadata paths', async () => {
  const requests = []
  const fetcher = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ available: true }) } }
  await browserTradingReadJson('/api/public/market/session', { fetcher })
  await browserTradingReadJson('/api/screener', { fetcher })
  for (const path of ['/api/orders/kiwoom','/api/agent/trading/start','/api/agent/trading/stop','/api/internal/trading/tick','/api/account/toss/summary','https://evil.example/']) {
    await assert.rejects(browserTradingReadJson(path, { fetcher }), { code: 'browser_market_path_forbidden' })
  }
  assert.equal(requests.length, 2)
  assert.ok(requests.every(row => row.options.method === 'GET' && !('body' in row.options)))
})

test('normalization preserves KST instants, replaces current bucket and never sums volume or fills gaps', () => {
  const first = instant('2026-11-16T09:30:00+09:00'), next = first + 900
  const rows = normalizeBrowserTradingCandles([bar(next, 102, 20), bar(first, 100, 10), bar(first, 101, 15)], { now: at })
  assert.deepEqual(rows.map(row => row.time), [first, next])
  assert.equal(rows[0].close, 101)
  assert.equal(rows[0].volume, 15)
  const merged = mergeBrowserTradingCandles(rows, [bar(next, 103, 25), bar(next + 1800, 104, 30)])
  assert.deepEqual(merged.map(row => row.time), [first, next, next + 1800])
  assert.equal(merged[1].volume, 25)
  assert.equal(merged.length, 3, 'the missing 10:00 bucket must not be synthesized')
  assert.throws(() => mergeBrowserTradingCandles(merged, [bar(first)]), { code: 'browser_market_time_reversed' })
  assert.deepEqual(mergeBrowserTradingCandles(merged, []), [], 'empty upstream data must not leave an old chart')
  const day = normalizeBrowserTradingCandles([bar('2026-11-13')], { period: '일', now: at })
  assert.equal(day[0].time, '2026-11-13')
})

test('invalid timestamps, OHLC, missing volume, quarantine and far-future bars are data errors', () => {
  const valid = bar(instant('2026-11-16T10:00:00+09:00'))
  for (const row of [{ ...valid, time: 'not-a-time' }, { ...valid, time: '2026-11-16T10:00:00' }, { ...valid, low: 102 }, { ...valid, close: -1 }, { ...valid, volume: null }, { ...valid, quality: 'quarantined' }, { ...valid, time: at / 1000 + 10000 }]) {
    assert.throws(() => normalizeBrowserTradingCandles([row], { now: at }), { code: 'browser_market_invalid_data' })
  }
})

test('saved indicator preparation requirements stay intact and over-limit combinations fail explicitly', () => {
  assert.equal(browserTradingWarmup(strategy.indicators), 3)
  assert.equal(browserTradingWarmup(strategy.indicators, { crossing: true }), 4)
  assert.equal(browserTradingWarmup([{ id: 'rsi', period: 499, lower: 30, upper: 70 }]), 500)
  assert.equal(browserTradingWarmup([{ id: 'rsi', period: 500, lower: 30, upper: 70 }], { maxBars: 2000 }), 501)
  assert.throws(() => browserTradingWarmup([{ id: 'rsi', period: 500, lower: 30, upper: 70 }]), { code: 'browser_market_warmup_limit' })
  assert.throws(() => browserTradingWarmup([{ id: 'macd', fast: 12, slow: 499, signal: 50 }]), { code: 'browser_market_warmup_limit' })
})

test('chart reads preserve selected provider and only the existing explicit KB fallback is accepted', async () => {
  const good = fixture()
  const chart = await good.client.chart({ ...target, indicators: strategy.indicators })
  assert.equal(good.calls[0].broker, 'toss')
  assert.equal(good.calls[0].period, '15분')
  assert.equal(chart.metadata.sourceBroker, 'toss')
  assert.equal(chart.metadata.market, 'PROVIDER')
  assert.equal(chart.metadata.fallback, false)
  assert.equal(chart.receivedAt, new Date(at).toISOString())
  const payload = { items: [bar(instant('2026-11-16T10:00:00+09:00'))], sourceBroker: 'kiwoom', fallback: true, meta: { timestampMeaning: 'start' } }
  const fallback = fixture({ readCandles: async () => payload })
  const result = await fallback.client.chart({ ...target, broker: 'kb', indicators: [] })
  assert.equal(result.metadata.sourceBroker, 'kiwoom')
  assert.equal(result.metadata.requestedBroker, 'kb')
  assert.match(result.metadata.sourceLabel, /대체 시세/)
  await assert.rejects(fallback.client.chart({ ...target, broker: 'toss' }), { code: 'browser_market_source_unknown' })
})

test('evaluation uses verified regular session, confirmed daily cutoff and actual one-minute timestamp', async () => {
  const { client, calls, dailyCalls } = fixture()
  const result = await client.evaluate({ ...target, strategy })
  assert.equal(result.marketOpen, true)
  assert.equal(result.previousDay, '2026-11-13')
  assert.equal(result.daily.at(-1).time, result.previousDay)
  assert.equal(result.price, 100)
  assert.equal(result.observedAt, '2026-11-16T01:00:00.000Z')
  assert.notEqual(result.observedAt, result.receivedAt, 'receipt time is not manufactured market time')
  assert.equal(result.timestampMeaning, 'end')
  assert.deepEqual(calls.map(row => row.period), ['1분'])
  assert.ok(calls.every(row => row.broker === 'toss'))
  assert.deepEqual(dailyCalls, ['089970'])
  assert.match(result.dailySource, /실험실 확정 일봉 DB/)
})

test('end-stamped unfinished minute stays on the chart while evaluation uses only a fresh non-future observation', async () => {
  const previous = bar(instant('2026-11-16T10:00:00+09:00'), 101)
  const unfinished = bar(instant('2026-11-16T10:01:00+09:00'), 105)
  const make = items => fixture({ readCandles: async broker => ({ items, sourceBroker: broker, meta: { timestampMeaning: 'end' } }) }).client
  const client = make([previous, unfinished])
  const chart = await client.chart({ ...target, period: '1분' })
  assert.equal(chart.candles.at(-1).time, unfinished.time, 'the real provider endpoint is never shifted or removed from the chart')
  const result = await client.evaluate({ ...target, strategy })
  assert.equal(result.price, 101)
  assert.equal(result.observedAt, '2026-11-16T01:00:00.000Z')
  assert.equal(result.timestampMeaning, 'end')
  await assert.rejects(make([unfinished]).evaluate({ ...target, strategy }), { code: 'browser_market_quote_stale' })
  await assert.rejects(make([bar(instant('2026-11-16T09:58:00+09:00')), unfinished]).evaluate({ ...target, strategy }), { code: 'browser_market_quote_stale' })
})

test('closed/holiday/stale/unknown markets cannot run evaluations or fabricate a price, while historical charts still read', async () => {
  for (const status of [session({ phase: 'holiday', label: '휴장', currentSession: null }), session({ phase: 'closed', label: '장 종료', currentSession: null }), session({ stale: true }), session({ phase: null }), session({ date: '2026-11-13' })]) {
    const { client, calls } = fixture({ readSession: async () => status })
    const result = await client.evaluate({ ...target, strategy })
    assert.equal(result.marketOpen, false)
    assert.ok(result.marketReason)
    assert.equal(result.price, undefined)
    assert.equal(calls.length, 0)
    const historical = await client.chart({ ...target, indicators: [] })
    assert.equal(historical.candles.length, 3)
  }
})

test('calendar transport/shape failure remains unavailable rather than falsely claiming a holiday or open session', async () => {
  const broken = fixture({ readSession: async () => { throw new Error('transport') } })
  assert.equal((await broken.client.marketContext()).marketUnavailable, true)
  for (const value of [session({ source: 'unverified' }), session({ stale: undefined }), session({ serverNow: '2026-11-16T10:00:15' }),
    session({ currentSession: { phase: 'regularMarket', startAt: '2026-11-16T12:00:00+09:00', endAt: '2026-11-16T15:30:00+09:00' } })]) {
    const { client } = fixture({ readSession: async () => value })
    const context = await client.marketContext()
    assert.equal(context.marketOpen, false)
    assert.equal(context.marketUnavailable, true)
  }
  const holiday = fixture({ readSession: async () => session({ phase: 'holiday', currentSession: null }) })
  assert.equal((await holiday.client.marketContext()).marketUnavailable, false)
})

test('missing or stale true data fails without substituting current values or another provider', async () => {
  const missingCutoff = fixture({ readScreenMeta: async () => ({ available: true, cutoff: '2026-11-16' }) })
  await assert.rejects(missingCutoff.client.evaluate({ ...target, strategy }), { code: 'browser_market_daily_unconfirmed' })
  const stale = fixture({ readCandles: async (broker, symbol, period) => ({ items: period === '일' ? daily : [bar(instant('2026-11-16T09:55:00+09:00'))], sourceBroker: broker, meta: { timestampMeaning: 'start' } }) })
  await assert.rejects(stale.client.evaluate({ ...target, strategy }), { code: 'browser_market_quote_stale' })
  const missing = fixture({ readDaily: async symbol => ({ ready: true, symbol: { code: symbol }, items: [], quality: { policy: 'published', quarantined: 0, issues: [] } }) })
  await assert.rejects(missing.client.evaluate({ ...target, strategy }), { code: 'browser_market_daily_unconfirmed' })
  const transport = fixture({ readCandles: async () => { throw new Error('read failure') } })
  await assert.rejects(transport.client.chart(target), /read failure/)
})

test('signal daily reads retain the published DB source and reject missing quality, another symbol, quarantine and missing cutoff', async () => {
  const base = { ready: true, symbol: { code: target.symbol, source: 'FDR:NAVER' }, items: daily, quality: { policy: 'naver-close-envelope-1krw-v1', quarantined: 0, issues: [] } }
  for (const invalid of [
    { ...base, ready: false }, { ...base, symbol: { code: '005930' } }, { ...base, quality: { ...base.quality, policy: null } },
    { ...base, quality: { ...base.quality, quarantined: 1 } }, { ...base, items: daily.slice(0, -1) },
    { ...base, items: [...daily].reverse() },
  ]) {
    const { client, calls } = fixture({ readDaily: async () => invalid })
    await assert.rejects(client.evaluate({ ...target, strategy }), { code: 'browser_market_daily_unconfirmed' })
    assert.equal(calls.length, 0, 'invalid daily data cannot be replaced by a broker chart or become a price evaluation')
  }
})

test('duplicate reads share bounded work, copies cannot poison cache and user/credential scopes stay isolated', async () => {
  const { client, calls, current } = fixture()
  const a = await Promise.all([client.chart(target), client.chart(target)])
  assert.equal(calls.length, 1)
  a[0].candles[0].close = 999
  assert.equal(a[1].candles[0].close, 100)
  assert.equal((await client.chart(target)).candles[0].close, 100)
  await client.chart({ ...target, scope: 'user-b:credentials-1' })
  await client.chart({ ...target, scope: 'user-a:credentials-2' })
  assert.equal(calls.length, 3)
  current.now += 15001
  await client.chart(target)
  assert.equal(calls.length, 4)
})

test('refresh refuses time-regressing upstream data and does not keep old candles when the new response is genuinely empty', async () => {
  let value = [bar(instant('2026-11-16T10:00:00+09:00'))]
  const { client, current } = fixture({ readCandles: async broker => ({ items: value, sourceBroker: broker, meta: {} }) })
  const first = await client.chart(target)
  assert.equal(first.candles.length, 1)
  current.now += 15001
  value = [bar(instant('2026-11-16T09:59:00+09:00'))]
  await assert.rejects(client.chart(target), { code: 'browser_market_time_reversed' })
  value = []
  assert.deepEqual((await client.chart(target)).candles, [])
})

test('one aborted consumer cannot poison another same-scope read and candle work never runs unbounded in parallel', async () => {
  let release, started = 0, active = 0, maximum = 0
  const gate = new Promise(resolve => { release = resolve })
  const { client } = fixture({ readCandles: async broker => {
    started++; active++; maximum = Math.max(maximum, active)
    await gate; active--
    return { items: [bar(instant('2026-11-16T10:00:00+09:00'))], sourceBroker: broker, meta: {} }
  } })
  const controller = new AbortController()
  const first = client.chart({ ...target, signal: controller.signal })
  const second = client.chart(target)
  controller.abort()
  await assert.rejects(first, { name: 'AbortError' })
  const more = ['000001','000002','000003'].map(symbol => client.chart({ ...target, symbol }))
  release()
  assert.equal((await second).candles.length, 1)
  await Promise.all(more)
  assert.equal(started, 4)
  assert.ok(maximum <= 2)
})
