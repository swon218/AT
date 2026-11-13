import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeChartCandles} from '../src/utils/chartCandles.js'
import {formatChartTime,seoulTimestamp} from '../src/utils/chartTime.js'
import {describeChartScope} from '../src/utils/chartScope.js'
const row={open:100,high:110,low:90,close:105,volume:10}
test('all minute periods keep exact timestamps/OHLCV and deduplicate in strict time order',()=>{
  const a=seoulTimestamp('20261113083000'),b=seoulTimestamp('20261116090000')
  for(const period of ['1분','5분','10분','15분','30분','60분']){
    const result=normalizeChartCandles([{...row,time:b*1000},{...row,time:'2026-11-13T08:30:00+09:00'},{...row,time:'2026-11-12T23:30:00Z'},{...row,time:'bad'}],period)
    assert.deepEqual(result.map(v=>v.time),[a,b]);assert.deepEqual(result.map(({time,quality,...v})=>v),[row,row])
    assert.equal(formatChartTime(result[0].time),'26년11월13일 08:30')
  }
})
test('daily weekly monthly and quarantined candles retain dates/gaps, never synthesize midnight or zero prices',()=>{
  for(const period of ['일','주','월']){
    const result=normalizeChartCandles([{...row,time:'2026-11-13'},{time:'2026-11-16',quality:'quarantined'},{...row,time:'2026-02-30'}],period)
    assert.equal(result.length,2);assert.equal(formatChartTime(result[0].time,false),'26년11월13일');assert.equal(result[1].open,undefined)
  }
  assert.equal(normalizeChartCandles([{...row,time:'2026-11-13'}],'1분').length,0)
})

test('malformed array entries do not discard valid candles or quarantine gaps',()=>{
  const malformed=[null,undefined,0,false,'bad',[]]
  for(const period of ['일','주','월']){
    const result=normalizeChartCandles([...malformed,{...row,time:'2026-11-13'},{time:'2026-11-16',quality:'quarantined'}],period)
    assert.deepEqual(result.map(value=>value.time),['2026-11-13','2026-11-16'])
    assert.equal(result[0].close,105)
    assert.equal(result[1].quality,'quarantined')
  }
  const time=seoulTimestamp('20261113083000')
  const intraday=normalizeChartCandles([...malformed,{...row,time}],'1분')
  assert.equal(intraday.length,1)
  assert.equal(intraday[0].time,time)
})
test('scope explains recent count, source coverage and partial resampling without a full-day claim',()=>{
  const text=describeChartScope({meta:{requestedLimit:200,returnedCount:45,market:'PROVIDER',timestampMeaning:'end',aggregation:'resampled',partial:true}},'60분')
  for(const expected of ['한국 시간','최근 45개 봉','시간외 포함 범위 미확인','봉 종료 시각','60분 합성','부분 조회'])assert.ok(text.includes(expected))
  assert.ok(!text.includes('하루 전체'))
  assert.equal(describeChartScope({error:true},'1분'),'한국 시간 · 차트 조회 실패')
})
