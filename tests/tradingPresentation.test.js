import test from 'node:test'
import assert from 'node:assert/strict'
import {executionChartMarkers} from '../src/utils/tradingPresentation.js'

test('only closed actual trades create labeled markers on existing bars; KST dates and intraday alignment preserve candles',()=>{
 const candles=[{time:Date.parse('2026-11-13T08:30:00+09:00')/1000},{time:Date.parse('2026-11-13T08:35:00+09:00')/1000}]
 const trade={id:'t',entryAt:'2026-11-12T23:32:00Z',exitAt:'2026-11-12T23:36:00Z',reason:'stop_loss'}
 const before=structuredClone(candles),markers=executionChartMarkers([trade],candles)
 assert.equal(markers.length,2);assert.equal(markers[0].time,candles[0].time);assert.equal(markers[1].time,candles[1].time)
 assert.match(markers[0].text,/실제 진입/);assert.equal(markers[1].shape,'square');assert.deepEqual(candles,before)
 assert.equal(executionChartMarkers([trade],[{time:'2026-11-13'}]).length,2)
 assert.deepEqual(executionChartMarkers([trade],[{time:'2026-11-12'}]),[])
 assert.deepEqual(executionChartMarkers([],candles),[])
})
