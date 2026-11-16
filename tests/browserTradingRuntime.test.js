import test from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserTradingEngine, BROWSER_TRADING_MODE, browserTradingAccountRef } from '../src/utils/browserTradingEngine.js'
import { createBrowserTradingRuntime } from '../src/services/browserTradingRuntime.js'

function fixture() {
  let time=Date.parse('2026-11-16T09:20:00+09:00'), reads=0
  const userId='runtime-user', engine=createBrowserTradingEngine({userId,now:()=>time})
  const strategy={id:'s',name:'전략',revision:1,schema_version:2,indicators:[],backtest_settings:{takeProfitPct:5,stopLossPct:3,entryConditions:[],entryMode:'all'}}
  engine.setCatalog({watchlist:[{code:'005930',name:'삼성전자'}],strategies:[strategy]})
  const market={evaluate:async()=>{reads++;return {price:200000,observedAt:new Date(time).toISOString(),marketOpen:true,marketDate:'2026-11-16'}},chart:async()=>{reads++;return {candles:[{time:time/1000,open:200000,high:200000,low:200000,close:200000,volume:1}],metadata:{sourceBroker:'toss'}}}}
  const runtime=createBrowserTradingRuntime({userId,engine,market,now:()=>time})
  return {engine,runtime,userId,get reads(){return reads},next(){time+=11000},spec:{code:'005930',broker:'toss',accountRef:browserTradingAccountRef('toss'),strategyId:'s',strategyRevision:1,quantityMode:'fixed',quantity:2,entryAction:'once'}}
}

test('save/start/stop/restart are local and cannot reach an order gateway or trading HTTP writer',async()=>{
  const previous=globalThis.fetch
  const calls=[]
  globalThis.fetch=async(...args)=>{calls.push(args);throw new Error('LIVE gateway/HTTP is forbidden')}
  try{
    const f=fixture(),api=(path,body)=>f.runtime.api(path,{userId:f.userId,...(body?{body}: {})})
    let context=await api('/config',{spec:f.spec,expectedRevision:0})
    assert.equal(context.sessions.length,0)
    const config=context.configs[0]
    let preview=await api('/preview',{configId:config.id,configRevision:config.revision,mode:BROWSER_TRADING_MODE})
    context=await api('/start',{previewId:preview.id,requestId:'request-one',confirmed:true})
    await f.runtime.tick()
    context=await api('')
    assert.equal(context.sessions[0].state.position.quantity,2)
    const id=context.sessions[0].id
    assert.equal((await api('/session?sessionId='+id)).sessions[0].mode,BROWSER_TRADING_MODE)
    assert.equal((await api('/chart?sessionId='+id+'&interval=15분')).metadata.sourceBroker,'toss')
    await api('/stop',{sessionId:id})
    preview=await api('/preview',{configId:config.id,configRevision:config.revision,mode:BROWSER_TRADING_MODE})
    await api('/start',{previewId:preview.id,requestId:'request-two',confirmed:true})
    f.runtime.dispose()
    assert.equal(f.engine.context().sessions.filter(s=>s.status!=='stopped').length,0)
    assert.deepEqual(calls,[])
    assert.equal(f.engine.context().intents.length,0)
  }finally{globalThis.fetch=previous}
})

test('foreign owner, unknown action, worker path and LIVE payload cannot be forwarded',async()=>{
  const f=fixture(), options={userId:f.userId}
  await assert.rejects(f.runtime.api('',{userId:'other'}),/로그인 사용자/)
  await assert.rejects(f.runtime.api('/internal/trading/tick',options),/지원하지 않는/)
  await assert.rejects(f.runtime.api('/cancel',{...options,body:{}}),/지원하지 않는/)
  await assert.rejects(f.runtime.api('/preview',{...options,body:{mode:'LIVE'}}),/실행 범위/)
  assert.equal(f.reads,0)
})

test('late market response after disposal never updates a stopped scope; mount replay does not revive a run',async()=>{
  const f=fixture(),config=f.engine.save({spec:f.spec}).configs[0]
  const view=f.engine.preview({configId:config.id,configRevision:config.revision})
  f.engine.start({previewId:view.id,requestId:'pending-one',confirmed:true})
  let release
  const runtime=createBrowserTradingRuntime({userId:f.userId,engine:f.engine,now:()=>Date.parse('2026-11-16T09:20:00+09:00'),market:{evaluate:()=>new Promise(resolve=>release=resolve)}})
  const pending=runtime.tick()
  runtime.dispose()
  release({price:200000,observedAt:'2026-11-16T09:20:00+09:00',marketOpen:true,marketDate:'2026-11-16'})
  await pending
  assert.equal(f.engine.context().sessions[0].status,'stopped')
  assert.equal(f.engine.context().sessions[0].state.position,null)
  runtime.activate()
  assert.equal((await runtime.api('',{userId:f.userId})).sessions[0].status,'stopped')
})

test('credential revision invalidates a pending chart and observation without applying old scope data',async()=>{
  const f=fixture(),config=f.engine.save({spec:f.spec}).configs[0]
  const view=f.engine.preview({configId:config.id,configRevision:config.revision})
  const context=f.engine.start({previewId:view.id,requestId:'revision-start',confirmed:true})
  let chartRelease,quoteRelease
  const scopes=[]
  const runtime=createBrowserTradingRuntime({userId:f.userId,engine:f.engine,market:{
    chart:({scope})=>{scopes.push(scope);return new Promise(resolve=>chartRelease=resolve)},
    evaluate:({scope})=>{scopes.push(scope);return new Promise(resolve=>quoteRelease=resolve)},
  }})
  const pendingChart=runtime.api('/chart?sessionId='+context.startedSessionId,{userId:f.userId})
  const rejected=assert.rejects(pendingChart,{name:'AbortError'})
  const pendingQuote=runtime.tick()
  runtime.setCredentialRevision(1)
  chartRelease({candles:[{close:200000}]})
  quoteRelease({price:200000,observedAt:new Date().toISOString(),marketOpen:true,marketDate:'2026-11-16'})
  await Promise.all([rejected,pendingQuote])
  assert.equal(f.engine.context().sessions[0].state.position,null)
  assert.deepEqual(scopes,['browser:runtime-user:0','browser:runtime-user:0'])
})

test('hidden screen does not poll or evaluate missed observations',async()=>{
  const f=fixture(),config=f.engine.save({spec:f.spec}).configs[0]
  const view=f.engine.preview({configId:config.id,configRevision:config.revision})
  f.engine.start({previewId:view.id,requestId:'hidden-start',confirmed:true})
  const runtime=createBrowserTradingRuntime({userId:f.userId,engine:f.engine,market:{evaluate:()=>{throw new Error('Hidden screen must not read')}},visible:()=>false})
  await runtime.tick()
  assert.equal(f.engine.context().sessions[0].state.position,null)
  runtime.suspend('screen_hidden')
  assert.equal(f.engine.context().sessions[0].status,'stopped')
})

test('catalog failure blocks new actions and pending evaluation; recovery never restarts a stopped run',async()=>{
  const f=fixture(),config=f.engine.save({spec:f.spec}).configs[0]
  const preview=f.engine.preview({configId:config.id,configRevision:config.revision})
  f.engine.start({previewId:preview.id,requestId:'catalog-start',confirmed:true})
  let available=true,release,reads=0
  const runtime=createBrowserTradingRuntime({userId:f.userId,engine:f.engine,available:()=>available,
    now:()=>Date.parse('2026-11-16T09:20:00+09:00'),market:{evaluate:()=>{reads++;return new Promise(resolve=>release=resolve)}}})
  const pending=runtime.tick()
  available=false
  for(const path of ['/config','/preview','/start'])await assert.rejects(runtime.api(path,{userId:f.userId,body:{}}),/관심종목과 전략을 다시 확인/)
  release({price:200000,observedAt:'2026-11-16T09:20:00+09:00',marketOpen:true,marketDate:'2026-11-16'})
  await pending
  assert.equal(f.engine.context().sessions[0].state.position,null)
  runtime.suspend('catalog_unavailable')
  const stopped=await runtime.api('',{userId:f.userId})
  assert.equal(stopped.sessions[0].status,'stopped')
  assert.equal(stopped.sessions[0].state.reason,'catalog_unavailable')
  // Stopping and reading existing records remain available during recovery.
  assert.equal((await runtime.api('/stop',{userId:f.userId,body:{sessionId:stopped.sessions[0].id}})).sessions[0].status,'stopped')
  available=true
  await runtime.tick()
  assert.equal(reads,1)
  assert.equal(f.engine.context().sessions[0].status,'stopped')
})
