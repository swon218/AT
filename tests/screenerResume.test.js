import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readScreenBatch,screenServerReady} from '../src/services/screenerApi.js'
import {defaultQuery} from '../src/utils/screener.js'

const response=(scanned,extra={})=>({snapshot_id:'a',query:{...defaultQuery(),snapshot_id:'a'},coverage:{universe:2719,scanned,not_scanned:2719-scanned,data_version:'a',data_read_at:'first',...extra},items:[]})

test('four automatic calls keep partial progress; explicit continuation completes the same 2719-stock snapshot',async()=>{
  const values=[1088,1472,1856,2240,2624,2719],seen=[],queries=[]
  const read=async q=>{queries.push(q);return response(values.shift())}
  await readScreenBatch(defaultQuery(),{onResult:r=>seen.push(r),read})
  assert.equal(queries.length,4);assert.equal(seen.at(-1).coverage.not_scanned,479)
  assert.equal(queries[0].snapshot_id,null);assert.equal(queries[3].snapshot_id,'a')
  await readScreenBatch(seen.at(-1).query,{previous:seen.at(-1),onResult:r=>seen.push(r),read})
  assert.equal(queries.length,6);assert.equal(seen.at(-1).coverage.not_scanned,0)
})

test('expired/regressed/version-changed progress is not published over previous results',async()=>{
  const previous=response(2240)
  for(const next of [response(384,{data_read_at:'new'}),response(1088),{...response(2624),snapshot_id:'b'}]){
    const published=[]
    await assert.rejects(readScreenBatch(previous.query,{previous,read:async()=>next,onResult:r=>published.push(r)}),/만료|갱신/)
    assert.equal(published.length,0)
  }
})

test('cancelled or replaced request ignores late replies, and stalled progress cannot loop',async()=>{
  for(const current of [false,true]){
    const controller=new AbortController(),published=[]
    await readScreenBatch(defaultQuery(),{signal:controller.signal,isCurrent:()=>current,onResult:r=>published.push(r),read:async()=>{if(current)controller.abort();return response(1088)}})
    assert.equal(published.length,0)
  }
  let calls=0
  await assert.rejects(readScreenBatch(defaultQuery(),{read:async()=>{calls++;return response(1088)},onResult:()=>{}}),/진행되지/)
  assert.equal(calls,2)
})

test('unit UI rejects an older backend contract while preserving the current supported contract',()=>{
  assert.equal(screenServerReady(null),false)
  assert.equal(screenServerReady({available:true}),false)
  assert.equal(screenServerReady({available:true,condition_version:'screen-units-v1'}),true)
})
