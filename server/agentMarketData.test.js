import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { createAgentMarketData } from './agentMarketData.js'
import { registerAgentRoutes } from './agent.js'
import { testDatabase } from '../tests/support/agentDatabase.js'

const now = Date.parse('2026-10-28T10:00:00+09:00')
const quote = { return_code:0,stk_cd:'005930',stk_nm:'삼성전자',cur_prc:'-990',pred_pre:'10',pred_pre_sig:'5',flu_rt:'-1',trde_qty:'0' }
const row = (stamp='20261028095900',price='990') => ({cntr_tm:stamp,cur_prc:price,open_pric:'1000',high_pric:'1010',low_pric:'980',trde_qty:'10'})
const barArgs = {code:'005930',market:'KRX',kind:'minute',interval:1,start_date:'2026-10-28',end_date:'2026-10-28',limit:120}
function service(request, more={}) {
  return createAgentMarketData({request,configured:()=>true,scope:()=> 'fixture-public-credential-version',now:()=>now,sleep:async()=>{},...more})
}

test('quote reuses normalization, keeps zero volume and never fabricates provider time or realtime proof',async()=>{
  let count=0
  const data=service(async args=>{assert.equal(args.apiId,'ka10001');assert.equal(args.body.stk_cd,'005930');count++;return quote})
  const read=()=>data.read('get_market_quote',{code:'005930',market:'KRX'},()=>{})
  const [first,second]=await Promise.all([read(),read()])
  assert.equal(count,1);assert.equal(first.price,990);assert.equal(first.volume,0);assert.equal(first.changeAmount,-10)
  assert.equal(first.provider_at,null);assert.equal(first.realtime,'unknown');assert.equal(second.cache_hit,true)
  assert.equal(data.status().market.last_success_at,new Date(now).toISOString())
})

test('quote business errors, missing data, symbol/market mismatch and provider failures are explicit and redacted',async()=>{
  for(const [payload,code] of [[{...quote,return_code:5},'market_invalid_response'],[{...quote,cur_prc:''},'market_no_data'],[{...quote,stk_cd:'005930_NX'},'market_symbol_mismatch']]){
    assert.equal((await service(async()=>payload).read('get_market_quote',{code:'005930',market:'KRX'},()=>{})).code,code)
  }
  for(const [error,code] of [[{statusCode:401},'market_auth_error'],[{statusCode:429},'market_rate_limit'],[{name:'TimeoutError'},'market_timeout']]){
    const result=await service(async()=>{throw Object.assign(new Error('private-provider-body'),error)}).read('get_market_quote',{code:'005930',market:'KRX'},()=>{})
    assert.equal(result.code,code);assert.ok(!JSON.stringify(result).includes('private-provider-body'))
  }
  assert.equal((await service(async()=>quote).read('get_market_quote',{code:'005930',market:'NXT'},()=>{})).code,'unsupported_market')
})

test('minute and tick pages preserve ordering, duplicate-time trades and bounded explicit coverage',async()=>{
  let calls=0
  const data=service(async args=>{
    calls++;assert.equal(args.body.upd_stkpc_tp,'1')
    return {body:{return_code:0,stk_cd:'005930',stk_tic_chart_qry:args.nextKey?[row('20261028095900'),row('20261028095800')]:[row(),row()]},contYn:args.nextKey?'N':'Y',nextKey:'page2'}
  })
  const result=await data.read('get_intraday_bars',{...barArgs,kind:'tick'},()=>{})
  assert.equal(calls,2);assert.equal(result.items.length,3)
  assert.deepEqual(result.items.map(x=>x.time),['2026-10-28T09:58:00+09:00','2026-10-28T09:59:00+09:00','2026-10-28T09:59:00+09:00'])
  assert.equal(result.items[0].completed,'unknown');assert.equal(result.adjusted,true)
  const bounded=await service(async()=>({body:{return_code:0,stk_cd:'005930',stk_min_pole_chart_qry:[row()]},contYn:'Y',nextKey:'another'})).read('get_intraday_bars',{...barArgs,limit:1},()=>{})
  assert.equal(bounded.status,'partial');assert.equal(bounded.more_available,true)
})

test('period, malformed bars, empty data, unsupported intervals and credential cache versions',async()=>{
  const empty=()=>({body:{return_code:0,stk_cd:'005930',stk_min_pole_chart_qry:[]},contYn:'N'})
  assert.equal((await service(async()=>empty()).read('get_intraday_bars',barArgs,()=>{})).status,'empty')
  for(const args of [{...barArgs,start_date:'2026-02-30'},{...barArgs,end_date:'2026-10-29'},{...barArgs,start_date:'2026-10-01'}]){
    assert.ok(['invalid_period','unsupported_period'].includes((await service(async()=>empty()).read('get_intraday_bars',args,()=>{})).code))
  }
  assert.equal((await service(async()=>empty()).read('get_intraday_bars',{...barArgs,interval:3},()=>{})).code,'unsupported_interval')
  const malformed=await service(async()=>({body:{return_code:0,stk_cd:'005930',stk_min_pole_chart_qry:[{...row(),high_pric:'1'}]},contYn:'N'})).read('get_intraday_bars',barArgs,()=>{})
  assert.equal(malformed.status,'error')
  let version='first',calls=0,time=now
  const data=service(async()=>{calls++;return quote},{scope:()=>version,now:()=>time})
  const read=()=>data.read('get_market_quote',{code:'005930',market:'KRX'},()=>{})
  await read();await read();version='second';await read();time+=5001;await read()
  assert.equal(calls,3)
})

test('internal data needs server authentication and an owned active request, enforces calls and rejects arbitrary tools',async()=>{
  const {db,store}=await testDatabase(),app=Fastify(),secret='fixture-internal-secret-'.repeat(3),user=randomUUID()
  await db.query('insert into auth.users values($1)',[user])
  let finish
  const pending=new Promise(resolve=>{finish=resolve})
  registerAgentRoutes(app,{store,internalSecret:secret,authenticate:async()=>user,bridge:{configured:true,call:async path=>path==='/health'?{key_configured:true,alert_tools:false}:pending},
    dataService:service(async()=>quote),publicOrigin:'http://fixture.invalid'})
  try{
    const headers={authorization:'Bearer fixture'}
    const room=(await app.inject({method:'POST',url:'/api/agent/rooms',headers,payload:{}})).json()
    const id=randomUUID()
    assert.equal((await app.inject({method:'POST',url:`/api/agent/rooms/${room.id}/requests`,headers,payload:{request_id:id,question:'시세 확인'}})).statusCode,202)
    const send=(body,auth=secret)=>app.inject({method:'POST',url:'/api/internal/agent/data',headers:{'x-atlas-internal':auth},payload:body})
    const body={request_id:id,tool:'get_market_quote',arguments:{code:'005930',market:'KRX'},max_calls:1}
    assert.equal((await send(body,'')).statusCode,401)
    assert.equal((await send({...body,request_id:randomUUID()})).statusCode,409)
    const valid=await send(body);assert.equal(valid.statusCode,200);assert.equal(valid.json().external_requests,1)
    assert.equal((await send({...body,tool:'arbitrary_sql'})).json().code,'invalid_arguments')
    assert.equal((await send({...body,arguments:{...body.arguments,user_id:'other'}})).json().code,'invalid_arguments')
  }finally{
    finish({status:'completed',answer:{content:'fixture'},usage:{status:'known'},error_code:null})
    await wait(30);await app.close();await db.close()
  }
})
