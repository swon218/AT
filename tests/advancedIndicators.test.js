import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { advancedSeries } from '../src/utils/advancedIndicators.js'
import { alignedPlot } from '../src/utils/indicatorPlots.js'
import { INDICATOR_CATALOG, createIndicatorConfig } from '../src/utils/indicators.js'
import { DEFAULT_BACKTEST, runBacktest } from '../src/utils/backtest.js'
import { strategyPayload } from '../src/services/strategyRepository.js'

const { bars, cases } = JSON.parse(readFileSync(new URL('./advancedIndicators.fixture.json', import.meta.url), 'utf8'))

test('advanced series match shared hand-checked values and keep null warmup', () => {
  for (const { config, expected } of cases) {
    const calculated = advancedSeries(bars, config)
    for (const [key, values] of Object.entries(expected)) {
      assert.equal(calculated[key].length, bars.length)
      values.forEach((value, i) => value === null ? assert.equal(calculated[key][i], null, `${key}[${i}]`)
        : assert.ok(Math.abs(calculated[key][i] - value) < 1e-9, `${key}[${i}] expected ${value}, got ${calculated[key][i]}`))
    }
  }
})

test('zero volume, missing volume and quarantined data have distinct behavior', () => {
  const flat = bars.map(({ time }) => ({ time, high: 10, low: 10, close: 10, volume: 0 }))
  assert.deepEqual(advancedSeries(flat, cases[0].config).atr, [null, 0, 0, 0, 0, 0])
  assert.equal(advancedSeries(flat, cases[1].config).adx.at(-1), 0)
  assert.equal(advancedSeries(flat, cases[2].config).stoch_k.at(-1), null)
  assert.equal(advancedSeries(flat, cases[5].config).mfi.at(-1), null)
  assert.equal(advancedSeries(flat, cases[6].config).cci.at(-1), null)
  assert.equal(advancedSeries(flat, cases[8].config).supertrend_direction.at(-1), -1)
  const incomplete = bars.map((bar, i) => i === 2 ? { ...bar, volume: null } : i === 4 ? { ...bar, quality: 'quarantined' } : bar)
  assert.deepEqual(advancedSeries(incomplete, cases[3].config).obv, [0, 7, null, 0, null, 0])
  assert.deepEqual(advancedSeries(incomplete, cases[0].config).atr, [null, 3, 3, 2.5, null, null])
  const line = alignedPlot(bars, [1, 2, null, null, 3, 4])
  assert.deepEqual(line.slice(1, 3), [{ time: bars[1].time, value: 2, color: 'transparent' }, { time: bars[2].time }])
})

test('12 settings round-trip and display-only indicators cannot change legacy backtest signals', () => {
  const indicators = INDICATOR_CATALOG.map(({ id }) => createIndicatorConfig(id))
  assert.equal(indicators.length, 12)
  Object.assign(indicators.find(c => c.id === 'dmi'), { showAdx: false, adxPeriod: 17, plusColor: '#123456' })
  Object.assign(indicators.find(c => c.id === 'obv'), { showAverage: true, maType: 'EMA' })
  const payload = strategyPayload({ name: '전략', indicators })
  assert.equal(payload.schema_version, 1)
  assert.deepEqual(payload.indicators, indicators)
  assert.deepEqual(strategyPayload(JSON.parse(JSON.stringify(payload))), payload)
  assert.throws(() => strategyPayload({ ...payload, indicators: [...indicators, indicators[0]] }))
  const ma = { ...createIndicatorConfig('ma'), shortPeriod: 1, longPeriod: 2 }
  const settings = { ...DEFAULT_BACKTEST, entry: ['ma-up'], exit: ['ma-down'] }
  assert.deepEqual(runBacktest(bars, [ma, ...indicators.slice(5)], settings), runBacktest(bars, [ma], settings))
  assert.throws(() => runBacktest(bars, [ma, ...indicators.slice(5)], { ...settings, entry: ['adx'] }), /조건/)
})
