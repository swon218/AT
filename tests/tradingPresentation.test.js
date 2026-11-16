import test from 'node:test'
import assert from 'node:assert/strict'
import {executionChartMarkers,tradingConnectionStage,orderTradingConfigs} from '../src/utils/tradingPresentation.js'

test('execution rows follow current watchlist order and retain removed active targets after them',()=>{
 const input=[{code:'999999'},{code:'000660'},{code:'005930'}]
 assert.deepEqual(orderTradingConfigs(input,[{code:'005930'},{code:'000660'}]).map(row=>row.code),['005930','000660','999999'])
 assert.equal(input[0].code,'999999')
})

test('display proof expires and cannot overrule the shared connection invalidation on key deletion',()=>{
 const proof={connected:true,status:'connected',expiresAt:200}
 assert.equal(tradingConnectionStage(null,undefined,100),'checking')
 assert.equal(tradingConnectionStage({status:'unconfigured'},false,100),'unconfigured')
 assert.equal(tradingConnectionStage({status:'failed'},false,100),'failed')
 assert.equal(tradingConnectionStage(proof,true,100),'connected')
 assert.equal(tradingConnectionStage(proof,true,200),'expired')
 assert.equal(tradingConnectionStage(proof,false,100),'checking')
})

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

test('browser simulation markers never claim an actual brokerage fill',()=>{
 const trade={id:'browser-trade',entryAt:'2026-11-13T09:00:00+09:00',exitAt:'2026-11-13T09:20:00+09:00',reason:'take_profit'}
 const markers=executionChartMarkers([trade],[{time:'2026-11-13'}],{}, {executionMode:'BROWSER_SIMULATION'})
 assert.deepEqual(markers.map(row=>row.text),['진입 #1','익절 #1'])
 assert.match(executionChartMarkers([trade],[{time:'2026-11-13'}])[0].text,/실제 진입/)
})
