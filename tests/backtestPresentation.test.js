import test from 'node:test'
import assert from 'node:assert/strict'
import { runBacktest, DEFAULT_BACKTEST } from '../src/utils/backtest.js'
import { createIndicatorConfig } from '../src/utils/indicators.js'
import { backtestChartMarkers, backtestEventLabel, backtestExport, BACKTEST_ASSUMPTIONS } from '../src/utils/backtestPresentation.js'

const indicators = [{ ...createIndicatorConfig('ma'), shortPeriod:1, longPeriod:2 }]
const settings = { ...DEFAULT_BACKTEST, initialQuantity:1, takeProfitPct:5, stopLossPct:2, entryConditions:[{ indicatorId:'ma', enabled:true, left:'close', operator:'gte', right:{ type:'constant', value:0 } }] }

test('same-day entry and ambiguous exit both survive chart mapping with engine identities and distinct shapes', () => {
  const result = runBacktest([
    {time:'2025-01-06',open:99,high:101,low:98,close:100,volume:100},
    {time:'2025-01-07',open:100,high:110,low:90,close:101,volume:100},
  ], indicators, settings)
  assert.equal(result.events.length,2)
  const markers=backtestChartMarkers(result.events)
  assert.equal(markers.length,2)
  assert.equal(markers[0].time,markers[1].time)
  assert.notEqual(markers[0].shape,markers[1].shape)
  assert.notEqual(markers[0].position,markers[1].position)
  assert.equal(new Set(markers.map(marker=>marker.id)).size,2)
  assert.equal(result.events[1].price,result.trades[0].exitPrice)
  assert.match(markers[1].text,/손절.*\*/)
  assert.match(result.events[1].reason,/순서 불명확/)
  assert.match(BACKTEST_ASSUMPTIONS.costs,/반영하지 않은/)
})

test('open holding creates only its real entry, not an invented final exit marker', () => {
  const result=runBacktest([
    {time:'2025-01-06',open:100,high:101,low:99,close:100,volume:100},
    {time:'2025-01-07',open:100,high:101,low:99,close:100,volume:100},
  ],indicators,settings)
  assert(result.openPosition)
  assert.equal(backtestChartMarkers(result.events).length,1)
  assert.equal(backtestEventLabel(result.events[0]),'진입')
  assert.deepEqual(backtestChartMarkers([]),[])
  const exported=JSON.parse(JSON.stringify(backtestExport({run:{result,settings,indicators,name:'모의 검증'},symbol:{code:'999999'},candles:[]})))
  assert.equal(exported.engineVersion,result.version)
  assert.deepEqual(exported.costs,{fee:0,sellTax:0,slippage:0})
  assert.match(exported.assumptions.ambiguous,/손절 우선/)
  assert.match(exported.assumptions.costs,/실제 거래 결과와 차이/)
  assert.equal(exported.result.events.length,1)
  assert.equal(exported.result.openPosition.quantity,1)
})
