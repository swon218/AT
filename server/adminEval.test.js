import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { registerAdminEval, seeds, validateCase, materializeEvaluation } from './adminEval.js'
import { proxyTarget } from '../api/agent-proxy.js'
import { summarize, compareRuns, seedCaseId } from '../src/utils/evalResults.js'

const migration=await readFile(new URL('../deploy/AI_EVAL_SUPABASE.sql',import.meta.url),'utf8')
async function harness(){
  const db=new PGlite()
  await db.exec('create schema auth; create table auth.users(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls;')
  await db.exec(migration);await db.exec(migration)
  const owner=randomUUID(),other=randomUUID(),member=randomUUID()
  await db.query('insert into auth.users values($1),($2),($3)',[owner,other,member])
  await db.query('insert into admin_users(user_id) values($1),($2)',[owner,other])
  const store=async(action,actor,payload={})=>{
    try{return(await db.query('select atlas_eval_rpc($1,$2,$3) value',[action,actor,JSON.stringify(payload)])).rows[0].value}
    catch(e){throw Object.assign(e,{statusCode:e.message.includes('admin_forbidden')?403:e.message.includes('eval_not_found')?404:409})}
  }
  const app=Fastify()
  registerAdminEval(app,{store,workerSecret:'x'.repeat(40),authenticate:async token=>{
    if(!token?.startsWith('Bearer ')||![owner,other,member].includes(token.slice(7)))throw Object.assign(new Error('invalid_authentication'),{statusCode:401})
    return token.slice(7)
  }})
  const request=(url,method='GET',payload,who=owner)=>app.inject({url,method,headers:who?{authorization:`Bearer ${who}`}:{},payload})
  const save=async(spec=seeds[0].spec)=>{const id=randomUUID();await store('save_case',owner,{id,revision:0,spec});return{id,revision:1}}
  const start=async(mode='code',budget=0,repeats=1)=>{const c=await save();const body={id:randomUUID(),mode,budget,repeats,cases:[c],paidConfirmed:mode==='live'};await store('start',owner,body);return body}
  return {db,store,app,owner,other,member,request,save,start,close:async()=>{await app.close();await db.close()}}
}

test('admin SQL and API deny guests/members, fail closed and observe revocation',async()=>{
 const h=await harness();try{
  assert.equal((await h.request('/api/agent/admin/status','GET',undefined,null)).statusCode,401)
  assert.equal((await h.request('/api/agent/admin/status','GET',undefined,h.member)).statusCode,403)
  assert.equal((await h.request('/api/agent/admin/status')).statusCode,200)
  for(const role of ['anon','authenticated']){
    await h.db.exec(`set role ${role}`)
    await assert.rejects(h.db.query('select * from admin_users'),/permission denied/)
    await assert.rejects(h.db.query('insert into admin_users(user_id) values($1)',[h.member]),/permission denied/)
    await assert.rejects(h.db.query("select atlas_eval_rpc('access',$1,'{}')",[h.owner]),/permission denied/)
    await h.db.exec('reset role')
  }
  await h.db.query('delete from admin_users where user_id=$1',[h.owner])
  assert.equal((await h.request('/api/agent/admin/status')).statusCode,403)
 }finally{await h.close()}
})
test('immutable revisions, idempotent start, owner isolation, cancel and review',async()=>{
 const h=await harness();try{
  const body=await h.start('code',0,2)
  await h.store('start',h.owner,body)
  assert.equal((await h.store('run',h.owner,{id:body.id})).items.length,2)
  await assert.rejects(h.store('start',h.owner,{...body,repeats:3}),/eval_conflict/)
  await assert.rejects(h.store('run',h.other,{id:body.id}),/eval_not_found/)
  const c=body.cases[0];await h.store('save_case',h.owner,{...c,spec:{...seeds[0].spec,question:'변경한 질문'}})
  const claimed=await h.store('claim',null,{model:'fixture'})
  assert.equal(claimed.specimen.spec.question,seeds[0].spec.question)
  await assert.rejects(h.store('item',h.other,{id:claimed.id}),/eval_not_found/)
  await h.store('cancel',h.owner,{id:body.id})
  await h.store('finish',null,{id:claimed.id,lease:claimed.lease,state:'completed',result:{grade:'review',usage:{status:'known',budget_usd:0}}})
  assert.equal((await h.store('finish',null,{id:claimed.id,lease:claimed.lease,state:'completed',result:{grade:'pass'}})).accepted,false)
  const r=await h.store('run',h.owner,{id:body.id});assert.deepEqual(r.items.map(x=>x.state),['completed','canceled'])
  const review=await h.store('review',h.owner,{id:claimed.id,review:{status:'pass',note:'확인',category:'질문 해석'}})
  assert.equal(review.review.by,h.owner)
 }finally{await h.close()}
})
test('single claim, conservative unknown cost, stale run interruption and no paid replay',async()=>{
 const h=await harness();try{
  const body=await h.start('live',0.25,2)
  const a=await h.store('claim',null,{});assert.equal(a.allowance,0.25)
  assert.equal(await h.store('claim',null,{}),null)
  await h.db.query("update ai_eval_items set heartbeat_at=now()-interval '10 minutes' where id=$1",[a.id])
  assert.equal(await h.store('claim',null,{}),null)
  const r=await h.store('run',h.owner,{id:body.id})
  assert.deepEqual(r.items.map(x=>x.state),['interrupted','canceled'])
  assert.equal(r.run.reserved,0.25)
 }finally{await h.close()}
})
test('paid confirmation, case allowlists and worker authentication',async()=>{
 const h=await harness();try{
  const c=await h.save()
  assert.equal((await h.request('/api/agent/admin/runs','POST',{id:randomUUID(),mode:'live',budget:1,repeats:1,cases:[c]})).statusCode,400)
  assert.throws(()=>validateCase({...seeds[0].spec,python:'print(1)'}))
  assert.throws(()=>validateCase({...seeds[0].spec,dataset:'/var/lib/atlas/lab.sqlite'}))
  assert.equal((await h.app.inject({url:'/api/internal/eval/claim',method:'POST',payload:{}})).statusCode,401)
  assert.equal((await h.app.inject({url:'/api/internal/eval/claim',method:'POST',headers:{'x-atlas-eval':'x'.repeat(40)},payload:{}})).statusCode,200)
  assert.equal(proxyTarget('/api/agent/admin/items/'+randomUUID()+'/review')?.startsWith('/api/agent/admin/'),true)
  assert.equal(proxyTarget('/api/agent/admin/../../internal/eval/claim'),null)
 }finally{await h.close()}
})
test('seed cases, fail counts and comparison do not hide unknown or changed conditions',()=>{
 assert.equal(seeds.length,45);assert.equal(seeds.filter(c=>c.spec.split==='holdout').length,8)
 seeds.forEach(c=>validateCase(c.spec))
 const items=[{state:'completed',grade:'review'},{state:'failed'},{state:'canceled'},{state:'completed',review:{status:'pass'},checks:[{status:'fail',critical:true}]}]
 const s=summarize(items);assert.equal(s.total,4);assert.equal(s.fail,2);assert.equal(s.critical,1);assert.equal(s.review,1)
 const a={run:{mode:'live'},items:[{case_id:'a',repetition:1,title:'a',state:'completed',review:{status:'pass'},fingerprint:'old'}]}
 const b={run:{mode:'live'},items:[{...a.items[0],fingerprint:'new'}]}
 assert.match(compareRuns(a,b)[0].change,/비교 불가/)
})
test('SQL detects conflicting pre-existing schema',async()=>{
 const db=new PGlite();try{
  await db.exec('create table admin_users(id int)')
  await assert.rejects(db.exec(migration),/Conflicting table/)
 }finally{await db.close()}
})

test('seed identity is stable per owner and never replaces another owner or seed',async()=>{
 const owner=randomUUID(),seed=randomUUID()
 const id=await seedCaseId(owner,seed)
 assert.equal(id,await seedCaseId(owner,seed))
 assert.notEqual(id,await seedCaseId(randomUUID(),seed))
 assert.notEqual(id,await seedCaseId(owner,randomUUID()))
 assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
test('architecture comparisons require matching model, data, rubric revision and request budget',()=>{
 const metadata={dataset:'fixed',data_hash:'same-data',model:'same-model',now:'fixed-date',settings:{rounds:8,max_usd:0.25}}
 const item={case_id:'a',repetition:1,revision:2,state:'completed',grade:'review',fingerprint:'baseline',metadata}
 const a={run:{mode:'live'},items:[item]}
 const b={run:{mode:'live'},items:[{...item,fingerprint:'graph',metadata:{...metadata,architecture:'atlas-langgraph-v1'}}]}
 assert.doesNotMatch(compareRuns(a,b)[0].change,/비교 불가/)
 for(const change of [{model:'different'},{data_hash:'different'},{settings:{...metadata.settings,rounds:12}}]){
  b.items[0].metadata={...metadata,...change}
  assert.match(compareRuns(a,b)[0].change,/비교 불가/)
 }
 b.items[0].metadata=metadata;b.items[0].revision=3
 assert.match(compareRuns(a,b)[0].change,/비교 불가/)
})
test('same alert presenter uses frozen expiry, blocks full watchlist and never writes',async()=>{
 const action={kind:'watchlist_confirmation',stock:{code:'035420',name:'NAVER'},rule:{code:'035420',kind:'price_touch',threshold:200000,frequency:'once',expires_on:'2026-11-04'}}
 const result={scenario:'approve',alert_action:action,eval_state:{watchlist:[],rules:[],draft:null},checks:[],grade:'review'}
 await materializeEvaluation(result)
 assert.equal(result.presentation.watchlistConfirmation.condition.threshold,200000)
 assert.equal(result.presentation.alertDraft,undefined)
 assert.equal(result.eval_state,undefined)
 assert.equal(result.checks.at(-1).status,'review')
 const full={scenario:'full',alert_action:action,eval_state:{watchlist:Array.from({length:20},(_,i)=>({code:String(700000+i),name:'fixture'})),rules:[],draft:null},checks:[],grade:'review'}
 await materializeEvaluation(full)
 assert.equal(full.presentation.watchlistConfirmation,undefined)
 assert.equal(full.checks.at(-1).status,'pass')
})
