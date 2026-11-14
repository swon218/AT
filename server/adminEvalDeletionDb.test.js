import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {evaluationDatabase,evalDeletion,runtime} from '../tests/support/adminEvaluation.js'

const snapshot = q => ({id:q.id,revision:q.revision})
const remove = (h,rows,owner=h.owner) => h.store('delete_questions',owner,{questions:rows.map(snapshot)})
const active = (h,view='all',page=1) => h.store('workspace',h.owner,{view,page})
async function completed(h,q) {
 const request=h.request(q),run=await h.store('start_production',h.owner,request)
 await h.store('finish_production',h.owner,{id:run.id,lease:run.lease,state:'completed',result:{answer:{content:'fixture result'},usage:{status:'known',budget_usd:0.01},runtime}})
 return {request,run}
}

test('deletion removes all revisions from both lists, renumbers active questions and retains immutable audit/costs',async()=>{
 const h=await evaluationDatabase({deletion:true});try {
  const a=await h.question('첫 질문'),b=await h.question('둘째 질문'),c=await h.question('셋째 질문')
  const aRun=await completed(h,a),cRun=await completed(h,c)
  await h.store('save_note',h.owner,{id:aRun.run.id,version:0,text:'보존할 보완 메모'})
  const revised=await h.store('save_question',h.owner,{...snapshot(a),question:'첫 질문 수정본'})
  const audit=await h.db.query('select to_jsonb(r) r,to_jsonb(i) i from ai_eval_runs r join ai_eval_items i on i.run_id=r.id order by r.id')
  const result=await remove(h,[revised])
  assert.deepEqual(result,{deleted:[a.id],alreadyDeleted:[],remaining:2})
  assert.deepEqual((await active(h)).questions.map(q=>[q.id,q.display_number]),[[b.id,1],[c.id,2]])
  const executed=await active(h,'executed')
  assert.equal(executed.total,1);assert.deepEqual(executed.questions.map(q=>[q.id,q.display_number]),[[c.id,2]])
  assert.equal(executed.questions[0].latest.id,cRun.run.id)
  assert.deepEqual((await h.db.query('select to_jsonb(r) r,to_jsonb(i) i from ai_eval_runs r join ai_eval_items i on i.run_id=r.id order by r.id')).rows,audit.rows)
  const rows=(await h.db.query('select revision,deleted_at from ai_eval_cases where id=$1 order by revision',[a.id])).rows
  assert.deepEqual(rows.map(r=>r.revision),[1,2]);assert.ok(rows.every(r=>r.deleted_at))
  const retained=await h.store('item',h.owner,{id:aRun.run.id})
  assert.equal(retained.specimen.revision,1);assert.equal(retained.specimen.spec.question,'첫 질문')
  assert.equal(retained.review.improvement.text,'보존할 보완 메모')
  assert.equal(retained.result.usage.budget_usd,0.01)
  assert.equal((await h.store('run',h.owner,{id:aRun.run.id})).items.length,1)
  assert.deepEqual((await h.store('cases',h.owner)).map(q=>q.id).sort(),[b.id,c.id].sort())
  const next=await h.question('새 질문')
  assert.equal(next.display_number,3)
  assert.deepEqual((await h.store('question_selection',h.owner)).questions.map(q=>q.display_number),[1,2,3])
  // Database historical ordinals are not rewritten to make the current display dense.
  assert.deepEqual((await h.db.query('select display_number from ai_eval_cases where id=$1',[a.id])).rows.map(q=>q.display_number),[1,1])
 }finally{await h.db.close()}
})

test('selection spans every page and deletion paginates the filtered, densely numbered list',async()=>{
 const h=await evaluationDatabase({deletion:true});try {
  const questions=[];for(let n=1;n<=24;n++)questions.push(await h.question(`질문 ${n}`))
  const initial=await h.store('question_selection',h.owner)
  assert.equal(initial.total,24);assert.equal(initial.questions.length,24)
  assert.deepEqual(Object.keys(initial.questions[0]).sort(),['display_number','id','revision'])
  await remove(h,[questions[0],questions[9],questions[23]])
  const first=await active(h),second=await active(h,'all',2),third=await active(h,'all',3)
  assert.equal(first.total,21);assert.deepEqual(first.questions.map(q=>q.display_number),[1,2,3,4,5,6,7,8,9,10])
  assert.deepEqual(second.questions.map(q=>q.display_number),[11,12,13,14,15,16,17,18,19,20])
  assert.deepEqual(third.questions.map(q=>q.display_number),[21])
  const selection=await h.store('question_selection',h.owner)
  const result=await remove(h,selection.questions)
  assert.equal(result.deleted.length,21);assert.equal(result.remaining,0)
  assert.deepEqual(await active(h),{questions:[],total:0,running:false})
  assert.equal((await h.db.query('select count(*)::int n from ai_eval_cases')).rows[0].n,24)
 }finally{await h.db.close()}
})

test('stale snapshots, foreign/missing IDs and invalid batches cannot partially remove questions; repeat deletion is idempotent',async()=>{
 const h=await evaluationDatabase({deletion:true});try {
  const a=await h.question('a'),b=await h.question('b'),foreign=await h.question('other',h.other)
  const revision=await h.store('save_question',h.owner,{...snapshot(b),question:'b revision'})
  await assert.rejects(remove(h,[a,b]),/eval_delete_conflict/)
  assert.equal((await active(h)).total,2)
  await assert.rejects(remove(h,[a,foreign]),/eval_not_found/)
  await assert.rejects(remove(h,[a,{id:randomUUID(),revision:1}]),/eval_not_found/)
  assert.equal((await active(h)).total,2)
  await assert.rejects(remove(h,[a],h.member),/admin_forbidden/)
  await assert.rejects(remove(h,[a],null),/admin_forbidden/)
  const invalid=[null,[],{}, {questions:[]},{questions:'all'},{questions:[null]},
   {questions:[snapshot(a)],extra:true},{questions:[{...snapshot(a),extra:true}]},
   {questions:[{id:'bad',revision:1}]},{questions:[{id:a.id,revision:'1'}]},
   {questions:[{id:a.id,revision:0}]},{questions:[{id:a.id,revision:1.5}]},
   {questions:[{id:a.id,revision:2147483648}]},{questions:[{id:a.id,revision:1e50}]},
   {questions:[snapshot(a),{id:a.id.toUpperCase(),revision:1}]},
   {questions:Array.from({length:301},()=>snapshot(a))}]
  for(const payload of invalid)await assert.rejects(h.store('delete_questions',h.owner,payload),/eval_invalid/)
  assert.equal((await active(h)).total,2)
  const result=await remove(h,[a,revision]);assert.equal(result.deleted.length,2)
  assert.deepEqual(await remove(h,[a,revision]),{deleted:[],alreadyDeleted:[a.id,b.id],remaining:0})
  await assert.rejects(remove(h,[{id:revision.id,revision:2147483647}]),/eval_delete_conflict/)
  assert.equal((await h.store('workspace',h.other)).total,1)
 }finally{await h.db.close()}
})

test('running and queued targeted executions block deletion without cancellation; unrelated active work does not block',async()=>{
 const h=await evaluationDatabase({deletion:true});try {
  const a=await h.question('running'),b=await h.question('unrelated')
  const started=await h.store('start_production',h.owner,h.request(a))
  await assert.rejects(remove(h,[a,b]),/eval_delete_busy/)
  assert.equal((await active(h)).total,2)
  assert.equal((await h.store('item',h.owner,{id:started.id})).state,'running')
  await remove(h,[b]);assert.equal((await active(h)).total,1)
  await h.store('finish_production',h.owner,{id:started.id,lease:started.lease,state:'completed',result:{usage:{status:'unknown'}}})
  const queued=await h.question('queued'),run=randomUUID()
  await h.db.query("insert into ai_eval_runs(id,owner_id,request,mode,budget) values($1,$2,'{}','code',1)",[run,h.owner])
  await h.db.query("insert into ai_eval_items(run_id,ordinal,specimen,repetition) values($1,1,$2,1)",[run,JSON.stringify(queued)])
  await assert.rejects(remove(h,[a,queued]),/eval_delete_busy/)
  const before=(await h.db.query('select cancel_requested from ai_eval_runs where id=$1',[run])).rows[0]
  assert.equal(before.cancel_requested,false)
  assert.equal((await h.db.query('select state from ai_eval_items where run_id=$1',[run])).rows[0].state,'queued')
  await h.db.query("update ai_eval_items set state='canceled' where run_id=$1",[run])
  assert.equal((await remove(h,[a,queued])).deleted.length,2)
 }finally{await h.db.close()}
})

test('deleted UUIDs and old revisions cannot be resurrected or executed through any legacy save/start path',async()=>{
 const h=await evaluationDatabase({deletion:true});try {
  const q=await h.question('history'),{request,run}=await completed(h,q)
  const edited=await h.store('save_question',h.owner,{...snapshot(q),question:'new revision'})
  await remove(h,[edited])
  for(const [action,payload] of [
   ['save_question',{...snapshot(edited),question:'try recreate'}],['save_question',{...snapshot(q),question:q.spec.question}],
   ['save_case',{...snapshot(edited),spec:{...q.spec,dataset:'atlas-fixed-v1'}}],
   ['save_case',{id:q.id,revision:0,spec:q.spec}],['production_lookup',request],
   ['start_production',request],['start_production',h.request(edited)],['question_history',{id:q.id}],
   ['start',{id:randomUUID(),mode:'code',cases:[snapshot(q)],repeats:1,budget:0}],
   ['start',{id:randomUUID(),mode:'live',cases:[snapshot(edited)],repeats:1,budget:0.25}]
  ])await assert.rejects(h.store(action,h.owner,payload),/eval_not_found/)
  assert.equal((await h.db.query('select count(*)::int n from ai_eval_cases where id=$1',[q.id])).rows[0].n,2)
  assert.equal((await h.store('item',h.owner,{id:run.id})).state,'completed')
  assert.equal((await active(h)).total,0)
 }finally{await h.db.close()}
})

test('active 300-question cap frees slots after deletion without reusing historical identities or numbers',async()=>{
 const h=await evaluationDatabase({deletion:true});try {
  const rows=Array.from({length:300},(_,i)=>({id:randomUUID(),spec:{question:`q${i+1}`,title:`q${i+1}`,dataset:'production',status:'active'}}))
  await h.db.query('insert into ai_eval_cases(id,revision,owner_id,spec) select x.id,1,$1,x.spec from jsonb_to_recordset($2::jsonb)x(id uuid,spec jsonb)',[h.owner,JSON.stringify(rows)])
  await assert.rejects(h.question('301st'),/eval_limit/)
  const selected=await h.store('question_selection',h.owner)
  assert.equal(selected.questions.length,300)
  await remove(h,[selected.questions[0]])
  const next=await h.question('new slot');assert.equal(next.display_number,300)
  const number=(await h.db.query('select display_number from ai_eval_cases where id=$1',[next.id])).rows[0].display_number
  assert.equal(number,301)
  await assert.rejects(h.question('again 301st'),/eval_limit/)
  const all=await h.store('question_selection',h.owner)
  assert.equal(all.total,300);assert.equal((await remove(h,all.questions)).remaining,0)
  assert.equal((await h.db.query('select count(*)::int n from ai_eval_cases')).rows[0].n,301)
 }finally{await h.db.close()}
})

test('service-only top RPC, private nested functions and direct table permissions remain fail closed',async()=>{
 const h=await evaluationDatabase({deletion:true});try {
  const q=await h.question('private')
  for(const role of ['anon','authenticated','service_role']) {
   const permissions=(await h.db.query(`select has_function_privilege($1,'public.atlas_eval_rpc(text,uuid,jsonb)','execute') top,
    has_function_privilege($1,'public.atlas_eval_rpc_ui_v2(text,uuid,jsonb)','execute') nested,
    has_function_privilege($1,'public.atlas_eval_rpc_v1(text,uuid,jsonb)','execute') legacy,
    has_function_privilege($1,'public.atlas_eval_active_questions(uuid)','execute') helper`,[role])).rows[0]
   assert.deepEqual(permissions,{top:role==='service_role',nested:false,legacy:false,helper:false})
   await h.db.exec(`set role ${role}`)
   for(const table of ['ai_eval_cases','ai_eval_runs','ai_eval_items']) {
    await assert.rejects(h.db.query(`select * from public.${table}`),/permission denied/)
    await assert.rejects(h.db.query(`update public.${table} set id=id`),/permission denied/)
    await assert.rejects(h.db.query(`delete from public.${table}`),/permission denied/)
   }
   await assert.rejects(h.db.query('insert into ai_eval_cases(id,revision,owner_id,spec) values($1,2,$2,$3)',[q.id,h.owner,JSON.stringify(q.spec)]),/permission denied/)
   await assert.rejects(h.db.query('select * from public.atlas_eval_active_questions($1)',[h.owner]),/permission denied/)
   await assert.rejects(h.db.query("select public.atlas_eval_rpc_ui_v2('save_question',$1,$2)",[h.owner,JSON.stringify({...snapshot(q),question:'bypass'})]),/permission denied/)
   await assert.rejects(h.db.query("select public.atlas_eval_rpc_v1('save_case',$1,$2)",[h.owner,JSON.stringify({...snapshot(q),spec:q.spec})]),/permission denied/)
   if(role!=='service_role')await assert.rejects(h.db.query("select public.atlas_eval_rpc('delete_questions',$1,$2)",[h.owner,JSON.stringify({questions:[snapshot(q)]})]),/permission denied/)
   else {
    await assert.rejects(h.store('delete_questions',h.member,{questions:[snapshot(q)]}),/admin_forbidden/)
    assert.deepEqual(await h.store('ui_status',h.owner),{version:2,questionDeletionVersion:1})
   }
   await h.db.exec('reset role')
  }
  const rls=(await h.db.query("select relrowsecurity from pg_class where oid in ('public.ai_eval_cases'::regclass,'public.ai_eval_runs'::regclass,'public.ai_eval_items'::regclass)")).rows
  assert.equal(rls.length,3);assert.ok(rls.every(r=>r.relrowsecurity))
 }finally{await h.db.close()}
})

test('migration is additive/repeatable and preserves old v2 API plus worker contracts',async()=>{
 const h=await evaluationDatabase();try {
  const q=await h.question('existing'),{run}=await completed(h,q)
  const casesBefore=(await h.db.query('select id,revision,owner_id,spec,created_at,display_number from ai_eval_cases')).rows
  await h.db.exec(evalDeletion)
  assert.deepEqual((await h.db.query('select id,revision,owner_id,spec,created_at,display_number from ai_eval_cases')).rows,casesBefore)
  assert.equal((await active(h)).total,1)
  assert.equal((await h.store('ui_status',h.owner)).version,2)
  assert.equal(await h.store('claim',null),null)
  await remove(h,[q]);const state=(await h.db.query('select * from ai_eval_cases')).rows
  await h.db.exec(evalDeletion);await h.db.exec(evalDeletion)
  assert.deepEqual((await h.db.query('select * from ai_eval_cases')).rows,state)
  assert.equal((await active(h)).total,0)
  assert.equal((await h.store('item',h.owner,{id:run.id})).result.answer.content,'fixture result')
  assert.equal((await h.question('after repeat')).display_number,1)
 }finally{await h.db.close()}
})
