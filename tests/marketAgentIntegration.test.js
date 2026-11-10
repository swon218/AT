import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { createAgentMarketData } from '../server/agentMarketData.js'
import { startHarness } from './support/agentHarness.js'

test('HTTP graph delegates market reads back to authenticated Node, shares budget and persists timestamp limits',async()=>{
  const calls=[]
  const dataService=createAgentMarketData({configured:()=>true,scope:()=> 'fixture',sleep:async()=>{},
    search:async()=>({items:[{code:'005930',name:'삼성전자',market:'KOSPI'}],total:1}),
    request:async definition=>{calls.push(definition);return{return_code:0,stk_cd:'005930',stk_nm:'삼성전자',cur_prc:'1000',pred_pre:'10',pred_pre_sig:'2',flu_rt:'1',trde_qty:'0'}}})
  const h=await startHarness({port:13009,pythonPort:18019,dataService})
  try{
    const initial=await fetch(h.base+'/api/agent/status')
    const headers={'Content-Type':'application/json',cookie:initial.headers.get('set-cookie').split(';')[0]}
    const room=await(await fetch(h.base+'/api/agent/rooms',{method:'POST',headers,body:'{}'})).json()
    const id=randomUUID()
    assert.equal((await fetch(`${h.base}/api/agent/rooms/${room.id}/requests`,{method:'POST',headers,body:JSON.stringify({request_id:id,question:'삼성전자 시세를 알려줘'})})).status,202)
    let result
    for(let i=0;i<120;i++){
      result=await(await fetch(`${h.base}/api/agent/requests/${id}`,{headers})).json()
      if(result.status!=='running')break
      await wait(100)
    }
    assert.equal(result.status,'completed',JSON.stringify(result))
    assert.equal(calls.length,1);assert.equal(calls[0].apiId,'ka10001')
    assert.equal(result.answer.sources[0].provider_at,null)
    assert.equal(result.answer.sources[0].scope,'quote')
    assert.match(result.answer.content,/실시간·지연 여부 확인 불가/)
    assert.ok(result.steps.some(step=>step.agent==='market'&&step.name==='get_market_quote'))
    assert.equal(result.usage.external_requests,1)
  }finally{await h.close()}
})
