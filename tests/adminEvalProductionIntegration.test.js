import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setTimeout as wait} from 'node:timers/promises'
import {startHarness} from './support/agentHarness.js'
import {createAgentMarketData} from '../server/agentMarketData.js'

test('admin rows use the same actual HTTP production graph/model/data boundary and preserve proposal-only state',async()=>{
 const dataService=createAgentMarketData({configured:()=>true,scope:()=> 'fixture',sleep:async()=>{},search:async()=>({items:[{code:'005930',name:'삼성전자',market:'KOSPI'}],total:1}),request:async()=>({return_code:0,stk_cd:'005930',stk_nm:'삼성전자',cur_prc:'1000',pred_pre:'10',pred_pre_sig:'2',flu_rt:'1',trde_qty:'0'})})
 const h=await startHarness({port:13012,pythonPort:18022,dataService,adminEvaluation:true})
 try{
  const headers={authorization:'Bearer fixture-user-a','Content-Type':'application/json'}
  const catalog=await(await fetch(h.base+'/api/agent/admin/catalog',{headers})).json()
  const runtime=catalog.runtime.execution
  const caseId=randomUUID(),question='삼성전자 시세'
  const saved=await(await fetch(h.base+'/api/agent/admin/questions/'+caseId,{method:'PUT',headers,body:JSON.stringify({revision:0,question})})).json()
  const id=randomUUID(),payload={id,revision:saved.revision,question,paidConfirmed:true}
  const execute=()=>fetch(`${h.base}/api/agent/admin/questions/${caseId}/execute`,{method:'POST',headers,body:JSON.stringify(payload)})
  assert.equal((await execute()).status,202);assert.equal((await execute()).status,202)
  let item
  for(let i=0;i<150;i++){item=await(await fetch(h.base+'/api/agent/admin/items/'+id,{headers})).json();if(item.state!=='running')break;await wait(100)}
  assert.equal(item.state,'completed',JSON.stringify(item))
  assert.equal(item.metadata.model,runtime.model);assert.equal(item.metadata.prompt_hash,runtime.prompt_hash);assert.equal(item.metadata.schema_hash,runtime.schema_hash)
  assert.equal(item.metadata.data_mode,'production');assert.equal(item.result.answer.sources[0].scope,'quote')
  assert.ok(item.result.steps.some(step=>step.agent==='market'&&step.name==='get_market_quote'))
  assert.equal((await h.db.query('select count(*)::int n from atlas_ai.messages')).rows[0].n,0)
  assert.equal((await h.db.query('select count(*)::int n from ai_eval_runs')).rows[0].n,1)
  const denied=await fetch(h.base+'/api/agent/admin/items/'+id,{headers:{authorization:'Bearer fixture-user-b'}})
  assert.equal(denied.status,404)
  const note=await fetch(h.base+'/api/agent/admin/items/'+id+'/note',{method:'POST',headers,body:JSON.stringify({version:0,text:'공급자 시각 미확인 안내 유지'})})
  assert.equal(note.status,200)
  const workspace=await(await fetch(h.base+'/api/agent/admin/workspace?view=executed&page=1',{headers})).json()
  assert.equal(workspace.questions[0].display_number,1);assert.equal(workspace.questions[0].latest.review.improvement.text,'공급자 시각 미확인 안내 유지')
 }finally{await h.close()}
})
