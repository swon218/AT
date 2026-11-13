import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {dateOnly,utcSeconds,seoulTimestamp,koreanDate,normalizeChartTime,formatChartTime,formatChartTick} from '../src/utils/chartTime.js'
test('KST crosshair labels are exact; UTC/offset/seconds/milliseconds represent one instant',()=>{
  for(const clock of ['080000','083000','090000','153000','200000']){
    const t=seoulTimestamp('20261113',clock),hh=clock.slice(0,2),mm=clock.slice(2,4)
    assert.equal(formatChartTime(t),`26년11월13일 ${hh}:${mm}`)
    assert.equal(formatChartTime(t*1000),formatChartTime(t))
    assert.equal(utcSeconds(new Date(t*1000).toISOString()),t)
    assert.equal(utcSeconds(`2026-11-13T${hh}:${mm}:00+09:00`),t)
  }
  const t=utcSeconds('2026-11-12T23:30:00Z')
  assert.equal(formatChartTime(t),'26년11월13일 08:30');assert.equal(koreanDate(t),'2026-11-13')
  assert.equal(formatChartTick(t,3),'08:30');assert.equal(formatChartTick(t,2),'11/13')
})
test('date-only and BusinessDay preserve trading dates without midnight; invalid times never become midnight',()=>{
  for(const value of ['2026-11-13','20261113',{year:2026,month:11,day:13}])assert.equal(formatChartTime(value),'26년11월13일')
  assert.equal(normalizeChartTime(1794524400000,{intraday:true}),1794524400)
  assert.equal(utcSeconds('2026-11-13T09:00:00'),null)
  assert.equal(seoulTimestamp('20261113090000'),utcSeconds('2026-11-13T00:00:00Z'))
  for(const bad of ['',null,'20260230090000','20261113250000','2026-11-13T09:61:00+09:00'])assert.equal(seoulTimestamp(bad),null)
  assert.equal(dateOnly('2026-02-30'),null)
  assert.equal(formatChartTime('invalid'),'—')
})

test('date-only parsing accepts complete compact or ISO dates and rejects mixed separators',()=>{
  for(const value of ['2026-1113','202611-13','2026/11/13','2026-1-13','2026-11-3','2026-02-29','20260229']){
    assert.equal(dateOnly(value),null,value)
    assert.equal(normalizeChartTime(value),null,value)
  }
  for(const value of ['20240229','2024-02-29',{year:2024,month:2,day:29}])assert.equal(dateOnly(value),'2024-02-29')
})
test('formatters and parsers are independent of process timezone',()=>{
  const code="import {formatChartTime,seoulTimestamp} from './src/utils/chartTime.js';process.stdout.write(formatChartTime(seoulTimestamp('20261113083000')))"
  const values=['Asia/Seoul','UTC','America/New_York'].map(TZ=>execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,TZ},encoding:'utf8'}))
  assert.deepEqual(values,['26년11월13일 08:30','26년11월13일 08:30','26년11월13일 08:30'])
})
