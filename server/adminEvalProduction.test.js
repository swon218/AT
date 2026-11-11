import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {registerAdminEval,seeds} from './adminEval.js'
import {registerAgentRoutes} from './agent.js'
import {evaluationDatabase,evalUI,runtime} from '../tests/support/adminEvaluation.js'
import {proxyTarget} from '../api/agent-proxy.js'

test('additive migration preserves old revisions, numbering, reviews and histories across reapply',async()=>{
 const h=await evaluationDatabase({migrate:false});try{
  const old=randomUUID();await h.store('save_case',h.owner,{id:old,revision:0,spec:seeds[0].spec})
  await h.db.exec(evalUI)
  const a=await h.question('첫 질문'),b=await h.question('둘째 질문')
  assert.equal(a.display_number,2);assert.equal(b.display_number,3)
  const request=h.request(a),started=await h.store('start_production',h.owner,request)
  assert.equal(started.created,true);assert.equal((await h.store('start_production',h.owner,request)).created,false)
  const edited=await h.store('save_question',h.owner,{id:a.id,revision:1,question:'수정한 질문'})
  assert.equal(edited.display_number,2);assert.equal(edited.revision,2)
  await h.store('finish_production',h.owner,{id:started.id,lease:started.lease,state:'completed',result:{answer:{content:'이전 질문 답'},runtime,usage:{status:'known',budget_usd:0.01}}})
  assert.equal((await h.store('item',h.owner,{id:started.id})).specimen.spec.question,'첫 질문')
  await h.store('review',h.owner,{id:started.id,review:{status:'pass',note:'이전 판정',category:'도구 선택'}})
  await h.store('save_note',h.owner,{id:started.id,version:0,text:'보완 기록'})
  await h.store('review',h.owner,{id:started.id,review:{status:'hold',note:'판정 수정',category:'도구 선택'}})
  await h.db.exec(evalUI)
  const item=await h.store('item',h.owner,{id:started.id})
  assert.equal(item.review.improvement.text,'보완 기록');assert.equal(item.review.note,'판정 수정')
  assert.equal((await h.store('workspace',h.owner,{view:'executed'})).questions[0].display_number,2)
  assert.equal((await h.store('workspace',h.owner,{})).total,3)
  const next=await h.store('start_production',h.owner,h.request(edited));await h.store('finish_production',h.owner,{id:next.id,lease:next.lease,state:'failed',result:{error_code:'cost_limit',usage:{status:'unknown'}}})
  assert.equal((await h.store('question_history',h.owner,{id:a.id})).items.length,2)
  assert.equal((await h.store('item',h.owner,{id:next.id})).review,null)
 }finally{await h.db.close()}
})

test('permissions, owner isolation and optimistic note versions fail closed',async()=>{
 const h=await evaluationDatabase();try{
  const a=await h.question('질문'),s=await h.store('start_production',h.owner,h.request(a))
  await assert.rejects(h.store('item',h.other,{id:s.id}),/eval_not_found/)
  await assert.rejects(h.store('save_note',h.other,{id:s.id,version:0,text:'침범'}),/eval_not_found/)
  await h.store('save_note',h.owner,{id:s.id,version:0,text:'<script>문자 그대로</script>'})
  await assert.rejects(h.store('save_note',h.owner,{id:s.id,version:0,text:'덮기'}),/eval_note_conflict/)
  await assert.rejects(h.store('workspace',h.member,{}),/admin_forbidden/)
  for(const role of ['anon','authenticated','service_role']) {
   await h.db.exec(`set role ${role}`)
   await assert.rejects(h.db.query('update ai_eval_items set review=null'),/permission denied/)
   if(role!=='service_role')await assert.rejects(h.db.query("select atlas_eval_rpc('workspace',$1,'{}')",[h.owner]),/permission denied/)
   await h.db.exec('reset role')
  }
  await h.db.query('delete from admin_users where user_id=$1',[h.owner])
  await assert.rejects(h.store('production_active',h.owner,{id:s.id,lease:s.lease}),/admin_forbidden/)
 }finally{await h.db.close()}
})

test('evaluations and normal analysis share concurrency/minute limits and never replay stale paid work',async()=>{
 const h=await evaluationDatabase();try{
  const owner='u:'+h.owner,room=await h.agentStore.call('create_room',owner)
  const q=await h.question('질문'),request=h.request(q),s=await h.store('start_production',h.owner,request)
  await assert.rejects(h.agentStore.call('reserve',owner,{room_id:room.id,request_id:randomUUID(),question:'동시 일반 질문'}),/concurrency_limit/)
  await h.db.query("update ai_eval_items set started_at=now()-interval '4 minutes' where id=$1",[s.id])
  await h.store('workspace',h.owner,{})
  assert.equal((await h.store('item',h.owner,{id:s.id})).state,'interrupted')
  assert.equal((await h.store('start_production',h.owner,request)).created,false)
  await assert.rejects(h.agentStore.call('reserve',owner,{room_id:room.id,request_id:s.id,question:'다른 namespace 요청'}),/idempotency_conflict/)
  for(let i=0;i<9;i++)await h.db.query("insert into atlas_ai.requests(id,owner_key,room_id,question,status) values($1,$2,$3,'완료된 질문','failed')",[randomUUID(),owner,room.id])
  await assert.rejects(h.store('start_production',h.owner,h.request(q)),/minute_limit/)
  await assert.rejects(h.agentStore.call('reserve',owner,{room_id:room.id,request_id:randomUUID(),question:'한도초과'}),/minute_limit/)
 }finally{await h.db.close()}
})

test('request IDs cannot cross normal/production namespaces or reuse another owners cached answer',async()=>{
 const h=await evaluationDatabase();try{
  const owner='u:'+h.owner,room=await h.agentStore.call('create_room',owner)
  const id=randomUUID()
  await h.db.query("insert into atlas_ai.requests(id,owner_key,room_id,question,status) values($1,$2,$3,'다른 요청','failed')",[id,owner,room.id])
  const question=await h.question('평가 질문',h.other)
  await assert.rejects(h.store('start_production',h.other,h.request(question,{id})),/eval_conflict/)
 }finally{await h.db.close()}
})

test('numbered pages, execution history cursors and bounded streamed failures preserve their identity',async()=>{
 const h=await evaluationDatabase();try{
  const questions=[]
  for(let n=1;n<=12;n++)questions.push(await h.question(`질문 ${n}`))
  const first=await h.store('workspace',h.owner,{page:1}),second=await h.store('workspace',h.owner,{page:2})
  assert.deepEqual(first.questions.map(q=>q.display_number),[1,2,3,4,5,6,7,8,9,10])
  assert.deepEqual(second.questions.map(q=>q.display_number),[11,12]);assert.equal(second.total,12)
  const q=questions[1],ids=[]
  for(let n=0;n<12;n++){
   const s=await h.store('start_production',h.owner,h.request(q));ids.push(s.id)
   if(n===0){
    for(let seq=1;seq<=70;seq++)await h.store('production_step',h.owner,{id:s.id,lease:s.lease,event:{seq,kind:'tool',name:'get_stock_news',agent:'news',status:'failed',arguments:{code:'005930'},result:{code:'provider_unavailable',excerpt:'x'.repeat(5500)}}})
    const streamed=await h.store('item',h.owner,{id:s.id})
    assert.equal(streamed.result.steps.length,70);assert.equal(streamed.result.trace_truncated,true)
    assert.equal(streamed.result.steps[0].result.code,'provider_unavailable')
   }
   await h.store('finish_production',h.owner,{id:s.id,lease:s.lease,state:'completed',result:{status:'partial',error_code:n%2?'cost_limit':'execution_timeout',usage:{status:'unknown'}}})
   await h.db.query("update ai_eval_runs set created_at=now()-($2::integer*interval '1 minute') where id=$1",[s.id,n+2])
  }
  const latest=(await h.store('workspace',h.owner,{view:'executed'})).questions
  assert.deepEqual(latest.map(row=>row.display_number),[2]);assert.equal(latest[0].latest.state,'partial')
  const a=await h.store('question_history',h.owner,{id:q.id}),b=await h.store('question_history',h.owner,{id:q.id,before:a.next})
  assert.equal(a.items.length,10);assert.equal(b.items.length,2)
  assert.equal(new Set([...a.items,...b.items].map(item=>item.id)).size,12)
  assert.equal(a.items[0].question,q.spec.question)
 }finally{await h.db.close()}
})

test('API uses the production bridge, keeps idempotency, denies imports and persists safe trace',async()=>{
 const h=await evaluationDatabase(),app=Fastify();let calls=0,release
 try {
  registerAgentRoutes(app,{store:h.agentStore,internalSecret:'x'.repeat(40),cookieSecret:'x'.repeat(40),alertStore:async()=>{throw new Error('no fixture alerts')},
   bridge:{call:async(path,body)=>{
    if(path==='/health')return{key_configured:true,runtime,registered_agents:['news'],architecture:runtime.architecture}
    calls++;await new Promise(resolve=>{release=resolve})
    const event={seq:1,kind:'tool',agent:'news',name:'get_stock_news',status:'success',arguments:{code:'005930'},result:{count:1},elapsed_ms:2}
    const callback=await app.inject({url:'/api/internal/agent/events',method:'POST',headers:{'x-atlas-internal':'x'.repeat(40)},payload:{request_id:body.request_id,step:event}})
    assert.equal(callback.statusCode,200)
    return{status:'completed',runtime,answer:{content:'운영 경로 모의 검증',execution:{reports:[{agent:'news'}]}},steps:[event],usage:{status:'known',budget_usd:0}}
   }}})
  registerAdminEval(app,{store:h.store,authenticate:async token=>{if(token!==`Bearer ${h.owner}`)throw Object.assign(new Error('invalid_authentication'),{statusCode:401});return h.owner}})
  const req=(url,method='GET',payload)=>app.inject({url,method,headers:{authorization:`Bearer ${h.owner}`},payload})
  const q=await h.question('최신 뉴스'),request=h.request(q);delete request.runtime;delete request.case_id
  const url=`/api/agent/admin/questions/${q.id}/execute`
  assert.equal((await req(url,'POST',{...request,paidConfirmed:false})).statusCode,400)
  assert.equal((await req('/api/agent/admin/workspace?view=executed&page=1')).json().total,0)
  assert.equal((await req(url,'POST',request)).statusCode,202)
  await new Promise(resolve=>setTimeout(resolve,1))
  assert.equal((await req(url,'POST',request)).statusCode,202);assert.equal(calls,1)
  assert.equal((await req(url,'POST',{...request,id:randomUUID()})).statusCode,409)
  assert.equal((await req(url,'POST',{...request,question:'다른 요청'})).statusCode,409)
  assert.equal((await req('/api/agent/admin/import/'+randomUUID())).statusCode,404)
  assert.equal(proxyTarget('/api/agent/admin/import/'+randomUUID()),null)
  assert.ok(proxyTarget(`/api/agent/admin/questions/${q.id}/history?before=abc`))
  release()
  for(let i=0;i<100&&(await h.store('item',h.owner,{id:request.id})).state==='running';i++)await new Promise(resolve=>setTimeout(resolve,10))
  const item=await h.store('item',h.owner,{id:request.id})
  assert.equal(item.result.answer.content,'운영 경로 모의 검증');assert.equal(item.metadata.model,runtime.model)
  assert.equal(item.result.steps[0].agent,'news');assert.equal(item.result.usage.budget_usd,0)
  assert.equal((await req('/api/agent/admin/workspace?view=executed&page=1')).json().total,1)
 }finally{release?.();await app.close();await h.db.close()}
})

test('production proposals only read the authorized owners alert state and never perform mutations',async()=>{
 const app=Fastify(),owner=randomUUID(),reads=[]
 const state={watchlist:[],rules:[],history:[]}
 const expires_on=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date())
 try{
  registerAgentRoutes(app,{alertStore:async(action,payload)=>{assert.equal(action,'read');assert.equal(payload.user_id,owner);reads.push(action);return state},bridge:{call:async path=>{
   assert.equal(path,'/run')
   return{status:'completed',runtime,answer:{content:'추가 확인'},usage:{status:'known',budget_usd:0},alert_action:{kind:'watchlist_confirmation',stock:{code:'005930',name:'삼성전자'},rule:{code:'005930',kind:'price_touch',threshold:1000000,frequency:'once',expires_on}}}
  }}})
  await app.ready()
  const before=JSON.stringify(state)
  const result=await app.agentProductionRunner.run({id:randomUUID(),owner,question:'삼성전자 100만원 알림',isActive:async()=>true,onStep:async()=>{}})
  assert.equal(result.proposal_only,true);assert.equal(result.presentation.watchlistConfirmation.status,'pending')
  assert.deepEqual(reads,['read']);assert.equal(JSON.stringify(state),before)
 }finally{await app.close()}
})
