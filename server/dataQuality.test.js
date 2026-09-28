import test from 'node:test'
import assert from 'node:assert/strict'
import { backtestWindow, gapSafeSeries } from '../src/utils/dataQuality.js'
import { runBacktest, DEFAULT_BACKTEST } from '../src/utils/backtest.js'
import { calculateSma, calculateRsi, calculateMacd } from '../src/utils/indicators.js'

const bars = () => Array.from({ length: 25 }, (_, i) => ({ time: `2025-01-${String(i + 1).padStart(2, '0')}`, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 100, tradable: 1 }))
const gap = row => ({ time: row.time, quality: 'quarantined', open: null, high: null, low: null, close: null, volume: null, tradable: 0 })
const ma = [{ id: 'ma', type: 'SMA', shortPeriod: 1, longPeriod: 3 }]
const options = { ...DEFAULT_BACKTEST, entry: ['ma-up'], exit: ['ma-down'] }

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
  assert.throws(() => runBacktest(data, ma, { ...options, start: data[9].time, entry: ['ma-cross-up'] }), /지표 준비 구간/)
})

test('recursive indicators reject an older unresolved seed even beyond nominal periods', () => {
  const data = bars(); data[0] = gap(data[0])
  for (const indicator of [{ ...ma[0], type: 'EMA' }, { id: 'rsi', period: 2 }, { id: 'macd', fast: 1, slow: 2, signal: 2 }]) {
    assert.throws(() => backtestWindow(data, [indicator], { ...options, start: data[20].time }), /이전 이력 전체/)
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

test('calendar end between trading days is accepted and null unmarked prices are rejected', () => {
  const data = bars().filter(row => row.time !== '2025-01-20')
  assert.equal(runBacktest(data, ma, { ...options, end: '2025-01-20' }).end, '2025-01-19')
  data[5].close = null
  assert.throws(() => runBacktest(data, ma, options), /가격/)
})
