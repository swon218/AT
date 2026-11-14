import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {evalStore,registerAdminEval} from './adminEval.js'
import proxy,{proxyTarget} from '../api/agent-proxy.js'
import {evaluationDatabase} from '../tests/support/adminEvaluation.js'

const origin='https://app.example'
const fault=(message,statusCode)=>Object.assign(new Error(message),{statusCode})

async function deletionApi({schema={version:2,questionDeletionVersion:1},deleteError}={}) {
  const owner=randomUUID(),member=randomUUID(),calls=[],app=Fastify()
  const questions=[{id:randomUUID(),revision:3,display_number:1},{id:randomUUID(),revision:1,display_number:2}]
  registerAdminEval(app,{
    origin,
    authenticate:async authorization=>{
      if(authorization===`Bearer ${owner}`)return owner
      if(authorization===`Bearer ${member}`)return member
      throw fault('invalid_authentication',401)
    },
    store:async(action,actor,payload={})=>{
      calls.push({action,actor,payload})
      if(actor!==owner)throw fault('admin_forbidden',403)
      if(action==='access')return {admin:true}
      if(action==='ui_status')return schema
      if(action==='question_selection')return {questions,total:questions.length}
      if(action==='delete_questions'){
        if(deleteError)throw fault(deleteError,409)
        return {deleted:payload.questions.map(question=>question.id),alreadyDeleted:[],remaining:0}
      }
      throw fault('eval_invalid',409)
    }
  })
  const request=(url,method='GET',payload,headers={})=>app.inject({url,method,payload,
    headers:{origin,authorization:`Bearer ${owner}`,...headers}})
  return {app,owner,member,calls,questions,request}
}

test('question selection and deletion require the existing authenticated administrator and same origin',async()=>{
  const h=await deletionApi()
  try{
    for(const [url,method,payload] of [
      ['/api/agent/admin/questions/selection','GET',undefined],
      ['/api/agent/admin/questions/delete','POST',{questions:h.questions.map(({id,revision})=>({id,revision}))}]
    ]){
      assert.equal((await h.request(url,method,payload,{authorization:''})).statusCode,401)
      assert.equal((await h.request(url,method,payload,{authorization:`Bearer ${h.member}`})).statusCode,403)
      assert.equal((await h.request(url,method,payload,{origin:'https://other.example'})).statusCode,403)
      assert.equal((await h.request(url,method,payload,{'sec-fetch-site':'cross-site'})).statusCode,403)
    }
    assert.equal(h.calls.filter(call=>['question_selection','delete_questions'].includes(call.action)).length,0)
    const selection=await h.request('/api/agent/admin/questions/selection')
    assert.equal(selection.statusCode,200)
    assert.equal(selection.headers['cache-control'],'no-store')
    assert.deepEqual(selection.json(),{questions:h.questions,total:2})
    const deleted=await h.request('/api/agent/admin/questions/delete','POST',{questions:h.questions.map(({id,revision})=>({id,revision}))})
    assert.equal(deleted.statusCode,200)
    assert.deepEqual(deleted.json(),{deleted:h.questions.map(question=>question.id),alreadyDeleted:[],remaining:0})
    assert.equal(h.calls.at(-1).actor,h.owner)
  }finally{await h.app.close()}
})

test('deletion validates immutable identities, expected revisions, bounded size and exact input fields',async()=>{
  const h=await deletionApi(),one={id:randomUUID(),revision:1}
  try{
    const invalid=[undefined,null,[],{}, {questions:[]},{questions:[one],owner_id:h.member},
      {questions:[null]},{questions:['1']},{questions:[{...one,display_number:1}]},
      {questions:[{id:'1',revision:1}]},{questions:[{id:[one.id],revision:1}]},
      ...[0,-1,1.5,2147483648,'1',null].map(revision=>({questions:[{...one,revision}]})),
      {questions:[one,one]},{questions:[one,{...one,id:one.id.toUpperCase()}]},
      {questions:Array.from({length:301},()=>({id:randomUUID(),revision:1}))}]
    for(const payload of invalid){
      const result=await h.request('/api/agent/admin/questions/delete','POST',payload)
      assert.equal(result.statusCode,400,JSON.stringify(payload))
    }
    assert.equal((await h.request('/api/agent/admin/questions/delete?owner_id=other','POST',{questions:[one]})).statusCode,400)
    assert.equal((await h.request('/api/agent/admin/questions/selection?page=1')).statusCode,400)
    assert.equal(h.calls.filter(call=>['question_selection','delete_questions'].includes(call.action)).length,0)
    const batch=Array.from({length:300},()=>({id:randomUUID(),revision:2147483647}))
    const result=await h.request('/api/agent/admin/questions/delete','POST',{questions:batch})
    assert.equal(result.statusCode,200)
    assert.equal(result.json().deleted.length,300)
  }finally{await h.app.close()}
})

test('deletion is advertised only when the installed SQL has its explicit capability',async()=>{
  for(const [schema,expected] of [[{version:2},false],[{version:2,questionDeletionVersion:1},true],
    [{version:1,questionDeletionVersion:1},false],[null,false]]){
    const h=await deletionApi({schema})
    try{
      const catalog=await h.request('/api/agent/admin/catalog')
      assert.equal(catalog.statusCode,200)
      assert.equal(catalog.json().features.questionDeletion,expected)
    }finally{await h.app.close()}
  }
})

test('stale snapshots and active executions return distinct safe conflicts without an execution attempt',async()=>{
  for(const code of ['eval_delete_conflict','eval_delete_busy']){
    const h=await deletionApi({deleteError:code})
    try{
      const response=await h.request('/api/agent/admin/questions/delete','POST',{questions:[{id:h.questions[0].id,revision:1}]})
      assert.equal(response.statusCode,409)
      assert.deepEqual(response.json(),{error:code})
      assert.deepEqual(h.calls.map(call=>call.action),['access','delete_questions'])
    }finally{await h.app.close()}
  }
})

test('database deletion conflicts are sanitized rather than exposing database details',async()=>{
  for(const [message,expected,status] of [
    ['eval_delete_conflict: private details','eval_delete_conflict',409],
    ['eval_delete_busy: private details','eval_delete_busy',409],
    ['unexpected internal private details','eval_database_unavailable',503]
  ]){
    const store=evalStore({rpc(name,params){
      assert.equal(name,'atlas_eval_rpc');assert.equal(params.action,'delete_questions')
      return {abortSignal(signal){assert.ok(signal instanceof AbortSignal);return Promise.resolve({data:null,error:{message}})}}
    }})
    await assert.rejects(store('delete_questions',randomUUID(),{questions:[]}),error=>error.message===expected&&error.statusCode===status)
  }
})

test('Vercel proxy permits only the new bounded public routes and forwards deletion unchanged',async t=>{
  for(const route of ['admin/questions/selection','admin/questions/delete']){
    assert.equal(proxyTarget(`/api/agent/${route}`),`/api/agent/${route}`)
    assert.equal(proxyTarget(`/api/agent-proxy?__atlas_route=${route}`),`/api/agent/${route}`)
    assert.equal(proxyTarget('/api/agent-proxy',{__atlas_route:route}),`/api/agent/${route}`)
    assert.equal(proxyTarget(`/api/agent/${route}?owner_id=other`),null)
    assert.equal(proxyTarget(`/api/agent/${route}/internal`),null)
  }
  const prior=process.env.ATLAS_API_ORIGIN
  process.env.ATLAS_API_ORIGIN='https://upstream.example'
  const payload={questions:[{id:randomUUID(),revision:2}]},headers={origin,authorization:'Bearer fixture-only'}
  t.mock.method(globalThis,'fetch',async(target,options)=>{
    assert.equal(target.href,'https://upstream.example/api/agent/admin/questions/delete')
    assert.equal(options.method,'POST');assert.equal(options.redirect,'error')
    assert.equal(options.headers.origin,origin)
    assert.deepEqual(JSON.parse(options.body),payload)
    return new Response(JSON.stringify({deleted:[payload.questions[0].id],alreadyDeleted:[],remaining:1}),{status:200})
  })
  const response={headers:{},setHeader(key,value){this.headers[key]=value},status(code){this.statusCode=code;return this},
    json(value){this.body=JSON.stringify(value);return this},send(value){this.body=value;return this},end(){return this}}
  try{
    await proxy({url:'/api/agent-proxy?__atlas_route=admin/questions/delete',method:'POST',headers,body:payload},response)
    assert.equal(response.statusCode,200)
    assert.deepEqual(JSON.parse(response.body),{deleted:[payload.questions[0].id],alreadyDeleted:[],remaining:1})
  }finally{
    if(prior===undefined)delete process.env.ATLAS_API_ORIGIN;else process.env.ATLAS_API_ORIGIN=prior
    t.mock.restoreAll()
  }
})

test('actual RPC through HTTP selects all pages, deletes the same identities in both views and preserves execution audit',async()=>{
  const h=await evaluationDatabase({deletion:true}),app=Fastify()
  registerAdminEval(app,{store:h.store,origin,authenticate:async token=>{
    if([h.owner,h.other,h.member].some(actor=>token===`Bearer ${actor}`))return token.slice(7)
    throw fault('invalid_authentication',401)
  }})
  const request=(path,method='GET',payload,actor=h.owner)=>app.inject({url:`/api/agent/admin/${path}`,method,payload,
    headers:{origin,authorization:`Bearer ${actor}`}})
  try{
    const rows=[]
    for(let n=1;n<=12;n++)rows.push(await h.question(`HTTP 질문 ${n}`))
    const audits=[]
    for(const row of rows.slice(0,2)){
      const started=await h.store('start_production',h.owner,h.request(row))
      await h.store('finish_production',h.owner,{id:started.id,lease:started.lease,state:'completed',result:{answer:{content:'격리된 모의 결과'},usage:{status:'known',budget_usd:0}}})
      audits.push(started.id)
    }
    assert.equal((await request('catalog')).json().features.questionDeletion,true)
    const selection=await request('questions/selection')
    assert.equal(selection.statusCode,200)
    assert.equal(selection.json().questions.length,12)
    assert.equal((await request('workspace?page=2')).json().questions.length,2)
    const selected=[selection.json().questions[0],selection.json().questions[10]].map(({id,revision})=>({id,revision}))
    const removed=await request('questions/delete','POST',{questions:selected})
    assert.equal(removed.statusCode,200)
    assert.deepEqual(removed.json(),{deleted:selected.map(row=>row.id),alreadyDeleted:[],remaining:10})
    const all=(await request('workspace')).json(),executed=(await request('workspace?view=executed')).json()
    assert.deepEqual(all.questions.map(row=>row.display_number),[1,2,3,4,5,6,7,8,9,10])
    assert.equal(all.questions[0].id,rows[1].id)
    assert.deepEqual(executed.questions.map(row=>[row.id,row.display_number]),[[rows[1].id,1]])
    assert.equal((await request(`items/${audits[0]}`)).json().specimen.id,rows[0].id)
    assert.equal((await request(`questions/${rows[0].id}/history`)).statusCode,404)
    assert.deepEqual((await request('questions/selection','GET',undefined,h.other)).json(),{questions:[],total:0})
    assert.equal((await request('questions/delete','POST',{questions:[{id:rows[1].id,revision:1}]},h.other)).statusCode,404)
    const edited=await request(`questions/${rows[1].id}`,'PUT',{revision:1,question:'다른 탭에서 수정'})
    assert.equal(edited.statusCode,200)
    const stale=await request('questions/delete','POST',{questions:[{id:rows[1].id,revision:1},{id:rows[2].id,revision:1}]})
    assert.equal(stale.statusCode,409);assert.equal(stale.json().error,'eval_delete_conflict')
    assert.equal((await request('workspace')).json().total,10)
    const repeated=await request('questions/delete','POST',{questions:selected})
    assert.equal(repeated.statusCode,200)
    assert.deepEqual(repeated.json(),{deleted:[],alreadyDeleted:selected.map(row=>row.id),remaining:10})
  }finally{await app.close();await h.db.close()}
})
