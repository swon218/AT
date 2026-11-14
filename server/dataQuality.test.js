import test from 'node:test'
import assert from 'node:assert/strict'
import { backtestWindow, gapSafeSeries } from '../src/utils/dataQuality.js'
import { runBacktest, DEFAULT_BACKTEST } from '../src/utils/backtest.js'
import { calculateSma, calculateRsi, calculateMacd } from '../src/utils/indicators.js'

const bars = () => Array.from({ length: 25 }, (_, i) => ({ time: `2025-01-${String(i + 1).padStart(2, '0')}`, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 100, tradable: 1 }))
const gap = row => ({ time: row.time, quality: 'quarantined', open: null, high: null, low: null, close: null, volume: null, tradable: 0 })
const ma = [{ id: 'ma', type: 'SMA', shortPeriod: 1, longPeriod: 3 }]
const entryCondition = { indicatorId: 'ma', enabled: true, left: 'short', operator: 'gt', right: { type: 'series', field: 'long' } }
const options = { ...DEFAULT_BACKTEST, initialQuantity: 1, takeProfitPct: 5, stopLossPct: 2, entryConditions: [entryCondition] }

test('unresolved dates in selection block even if tradable is zero', () => {
  const data = bars(); data[10] = gap(data[10])
  assert.throws(() => runBacktest(data, ma, options), /2025-01-11.*검증 기간/)
  assert.throws(() => runBacktest(data, ma, { ...options, start: data[10].time }), /가격 오류/)
  assert.throws(() => runBacktest(data, ma, { ...options, end: data[10].time }), /가격 오류/)
})

test('finite warmup checks exact lookback, plus previous bar for a crossover', () => {
  const data = bars(); data[6] = gap(data[6])
  assert.throws(() => backtestWindow(data, ma, { ...options, start: data[8].time }), /지표 준비 구간/)
  assert.doesNotThrow(() => runBacktest(data, ma, { ...options, start: data[9].time }))
  assert.throws(() => runBacktest(data, ma, { ...options, start: data[9].time, entryConditions: [{ ...entryCondition, operator: 'crossUp' }] }), /지표 준비 구간/)
})

test('recursive indicators reject an older unresolved seed even beyond nominal periods', () => {
  const data = bars(); data[0] = gap(data[0])
  for (const indicator of [{ ...ma[0], type: 'EMA' }, { id: 'rsi', period: 2 }, { id: 'macd', fast: 1, slow: 2, signal: 2 }]) {
    const field = indicator.id === 'ma' ? 'short' : indicator.id === 'rsi' ? 'rsi' : 'macd'
    assert.throws(() => backtestWindow(data, [indicator], { ...options, start: data[20].time, entryConditions: [{ indicatorId: indicator.id, enabled: true, left: field, operator: 'gt', right: { type: 'constant', value: 0 } }] }), /이전 이력 전체/)
  }
})

test('future quarantine cannot change earlier completed backtest', () => {
  const data = bars(), end = data[15].time
  const expected = runBacktest(data, ma, { ...options, end })
  data[20] = gap(data[20])
  assert.deepEqual(runBacktest(data, ma, { ...options, end }), expected)
})

test('corrected bars are counted including warmup, with identical fills and costs', () => {
  const data = bars(), settings = { ...options, start: data[5].time }
  const expected = runBacktest(data, ma, settings)
  data[3].quality = 'corrected'; data[10].quality = 'corrected'; data[0].quality = 'corrected'
  const result = runBacktest(data, ma, settings)
  assert.equal(result.quality.correctedBarsUsed, 2)
  assert.equal(result.quality.calculationStart, data[3].time)
  assert.deepEqual(result.trades, expected.trades)
  assert.deepEqual(result.equity, expected.equity)
  assert.equal(result.costs, expected.costs)
})

test('chart retains gap and warmup dates, resets indicators and hides connecting line', () => {
  const data = bars(); data[10] = gap(data[10])
  for (const calc of [s => calculateSma(s, 3), s => calculateRsi(s, 3), s => calculateMacd(s, 2, 3, 2).signal]) {
    const result = gapSafeSeries(data, calc)
    assert.equal(result.length, data.length)
    assert.deepEqual(result[10], { time: data[10].time })
    assert.equal(result[9].color, 'transparent')
    assert.equal(result[11].value, undefined)
    const expected = calc(data.slice(11))
    assert.deepEqual(result.filter(p => p.time > data[10].time && Number.isFinite(p.value)), expected)
    assert.ok(result.every(p => p.value === undefined || Number.isFinite(p.value)))
  }
  const histogram = gapSafeSeries(data, s => calculateSma(s, 1), false)
  assert.equal(histogram[9].color, undefined)
})

test('an unverified end-date gap is explicitly not claimed as a holiday or completed valuation', () => {
  const data = bars().filter(row => row.time !== '2025-01-20')
  const result = runBacktest(data, ma, { ...options, end: '2025-01-20' })
  assert.equal(result.end, '2025-01-19')
  assert.equal(result.coverage.endStatus, 'unverified-gap')
  assert.match(result.coverage.warning, /휴장일인지 데이터 누락인지 확인되지 않아/)
  data[5].close = null
  assert.throws(() => runBacktest(data, ma, options), /가격/)
})

test('confirmed holiday calendar permits last-close marking and blocks known missing trade days', () => {
  const candle = time => ({ time, open: 100, high: 101, low: 99, close: 100, volume: 100 })
  const data = ['2025-01-02', '2025-01-03'].map(candle)
  const calendar = { tradingDays: ['2025-01-02', '2025-01-03'], calendarThrough: '2025-01-05' }
  const r = runBacktest(data, [{ ...ma[0], longPeriod: 2 }], { ...options, end: '2025-01-05', ...calendar })
  assert.equal(r.valuationDate, '2025-01-03')
  assert.equal(r.coverage.endStatus, 'non-trading-confirmed')
  assert.equal(r.coverage.calendarVerified, true)
  assert.throws(() => backtestWindow(['2025-01-02', '2025-01-06', '2025-01-07'].map(candle), ma,
    { ...options, end: '2025-01-06', tradingDays: ['2025-01-02', '2025-01-03', '2025-01-06'], calendarThrough: '2025-01-07' }), /2025-01-03.*누락/)
})

test('stale weekdays are not silently priced as a closed market; bounded weekends remain unverified', () => {
  const data = bars().slice(0, 3) // 2025-01-03 Friday
  assert.throws(() => backtestWindow(data, ma, { ...options, end: '2025-01-06' }), /종료일까지 수집/)
  const r = backtestWindow(data, ma, { ...options, end: '2025-01-05' })
  assert.equal(r.coverage.endStatus, 'unverified-gap')
  assert.throws(() => backtestWindow(data, ma, { ...options, end: '2025-02-30' }), /기간/)
  assert.throws(() => backtestWindow([{ ...data[0], time: '2019-01-01' }, ...data], ma, { ...options, end: '2025-01-03' }), /최대 5년/)
})
