import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BACKTEST, runBacktest } from '../src/utils/backtest.js'
import { calculateRsi } from '../src/utils/indicators.js'

const bars = values => values.map((close, i) => ({ time: `2025-01-${String(i + 1).padStart(2, '0')}`, open: close, high: close + 1, low: close - 1, close, volume: 100, tradable: 1 }))
const indicators = [{ id: 'ma', type: 'SMA', shortPeriod: 1, longPeriod: 2 }]
const options = { ...DEFAULT_BACKTEST, initialCapital: 1000, feePct: 0, taxPct: 0, slippagePct: 0, entry: ['ma-up'], exit: ['ma-down'] }

test('close signal executes at next open; final signal is unfilled', () => {
  const r = runBacktest(bars([10, 11, 12, 9, 8, 10]), indicators, options)
  assert.equal(r.trades[0].entrySignal, '2025-01-02')
  assert.equal(r.trades[0].entryDate, '2025-01-03')
  assert.equal(r.trades[0].entryPrice, 12)
  assert.equal(r.trades[0].exitSignal, '2025-01-04')
  assert.equal(r.trades[0].exitDate, '2025-01-05')
  assert.equal(r.trades[0].quantity, 83)
  assert.equal(r.finalEquity, 668)
  assert.deepEqual(r.unfilledSignal, { side: 'buy', date: '2025-01-06' })
})

test('future bars cannot alter earlier equity or completed fills', () => {
  const prefix = bars([10, 11, 12, 9, 8, 10])
  const a = runBacktest(prefix, indicators, options)
  const b = runBacktest([...prefix, ...bars([100, 1]).map((v, i) => ({ ...v, time: `2025-01-0${i + 7}` }))], indicators, options)
  assert.deepEqual(a.equity, b.equity.slice(0, prefix.length))
  assert.deepEqual(a.trades, b.trades.slice(0, a.trades.length))
})

test('fees, sell tax and slippage affect prices, quantity and net cash', () => {
  const r = runBacktest(bars([10, 11, 12, 9, 8]), indicators, { ...options, feePct: 1, taxPct: 2, slippagePct: 1 })
  const quantity = Math.floor(1000 / (12 * 1.01 * 1.01))
  const buy = quantity * 12 * 1.01 * 1.01
  const sale = quantity * 8 * .99 * .97
  assert.ok(Math.abs(r.finalEquity - (1000 - buy + sale)) < 1e-8)
  assert.ok(Math.abs(r.trades[0].pnl - (sale - buy)) < 1e-8)
  assert.equal(r.trades[0].quantity, quantity)
})

test('open position is marked to close rather than fabricated liquidation', () => {
  const r = runBacktest(bars([10, 11, 12, 15]), indicators, options)
  assert.equal(r.closedTrades, 0)
  assert.equal(r.winRate, null)
  assert.equal(r.openPosition.quantity, 83)
  assert.equal(r.finalEquity, 1249)
})

test('suspended bars never fill an order and cancel previous signal', () => {
  const data = bars([10, 11, 12, 9, 8])
  data[2] = { ...data[2], open: 0, high: 0, low: 0, volume: 0, tradable: 0 }
  const r = runBacktest(data, indicators, options)
  assert.equal(r.closedTrades, 0)
  assert.equal(r.openPosition, null)
  assert.equal(r.finalEquity, 1000)
})

test('invalid indicators, missing rules and insufficient warmup are rejected', () => {
  const data = bars([10, 11, 12])
  assert.throws(() => runBacktest(data, [{ id: 'bollinger', period: -1, multiplier: 2 }], options), /기간/)
  assert.throws(() => runBacktest(data, indicators, { ...options, entry: [] }), /각각/)
  assert.throws(() => runBacktest(data, indicators, { ...options, exit: ['rsi-high'] }), /지표/)
  assert.throws(() => runBacktest(data, [{ ...indicators[0], longPeriod: 200 }], options), /준비 기간/)
})

test('date window uses older candles only for warmup; no pre-start fill', () => {
  const r = runBacktest(bars([10, 11, 12, 13, 14]), indicators, { ...options, start: '2025-01-03' })
  assert.equal(r.firstSignalDate, '2025-01-03')
  assert.equal(r.openPosition.entryDate, '2025-01-04')
  assert.equal(r.equity[0].value, 1000)
})

test('AND and OR combine independently; flat RSI is neutral', () => {
  const data = bars([10, 11, 12, 13, 14])
  const all = runBacktest(data, indicators, { ...options, entry: ['ma-up', 'ma-down'], entryMode: 'all' })
  const any = runBacktest(data, indicators, { ...options, entry: ['ma-up', 'ma-down'], entryMode: 'any' })
  assert.equal(all.openPosition, null)
  assert.ok(any.openPosition)
  assert.equal(calculateRsi(bars([10, 10, 10, 10]), 2)[0].value, 50)
})
