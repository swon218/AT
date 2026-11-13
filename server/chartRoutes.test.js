import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerChartRoutes} from './chartRoutes.js'
test('chart routes pass isolated credentials/options and exact selected interval; no secret/raw errors are returned',async()=>{
  const calls=[],app=Fastify()
  registerChartRoutes(app,{kiwoomContext:async()=>({cacheScope:'user:fixture:version',requester:()=>{}}),tossContext:async()=>({apiKey:'PRIVATE',secretKey:'PRIVATE',cacheScope:'user:fixture'}),kiwoom:async(...args)=>{calls.push(args);return {items:[],meta:{rangeMode:'recent',fullDay:false}}},toss:async()=>{throw Object.assign(Error('PRIVATE provider raw account'),{statusCode:429})}})
  try{
    const r=await app.inject('/api/public/market/kiwoom/candles?symbol=005930&interval=15분&limit=200&market=INTEGRATED')
    assert.equal(r.statusCode,200);assert.equal(r.headers['cache-control'],'private, no-store');assert.equal(r.json().sourceBroker,'kiwoom')
    assert.equal(calls[0][1],'15분');assert.equal(calls[0][3].market,'INTEGRATED');assert.equal(calls[0][3].cacheScope,'user:fixture:version')
    const bad=await app.inject('/api/public/market/toss/candles?symbol=005930&interval=1분&market=NXT')
    assert.equal(bad.statusCode,400);assert.equal(bad.json().code,'chart_option_unsupported')
    const rate=await app.inject('/api/public/market/toss/candles?symbol=005930&interval=1분')
    assert.equal(rate.statusCode,429);assert.equal(rate.json().code,'chart_rate_limited');assert.ok(!rate.body.includes('PRIVATE'))
    const invalid=await app.inject('/api/public/market/kiwoom/candles?symbol=005930&interval=2분')
    assert.equal(invalid.statusCode,400);assert.equal(calls.length,1)
    for(const option of ['limit=501','includeExtended=false','includeExtended=true']){
      const unsupported=await app.inject(`/api/public/market/kiwoom/candles?symbol=005930&interval=1분&${option}`)
      assert.equal(unsupported.statusCode,400)
    }
    assert.equal(calls.length,1)
  }finally{await app.close()}
})
