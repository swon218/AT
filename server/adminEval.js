import { createClient } from '@supabase/supabase-js'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createAgentAuthenticator, createAgentStore } from './agentStore.js'
import { alertAnswer } from './alertAgent.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode })
export const seeds = ['evalCases.json','marketEvalCases.json'].flatMap(name => JSON.parse(readFileSync(new URL('../shared/' + name, import.meta.url), 'utf8')))
export const scenarios = ['base','watched','full','approve','decline','multiple','draft','guest','news_error','news_empty','db_error','market_quote','market_intraday','market_news','market_daily','market_error']
export function validateCase(value) {
  const fields = ['title','category','question','context','dataset','scenario','success','failure','rubric','checks','split','status','source']
  if (!value || Object.keys(value).some(k => !fields.includes(k)) || JSON.stringify(value).length > 18000) throw fail('eval_invalid')
  for (const [key, max] of [['title',120],['category',60],['question',6000],['success',2000],['failure',2000],['rubric',2000]]) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > max) throw fail('eval_invalid')
  }
  if (!['atlas-fixed-v1','unprepared'].includes(value.dataset) || !scenarios.includes(value.scenario)
    || !['dev','holdout'].includes(value.split) || !['active','archived'].includes(value.status)
    || !Array.isArray(value.context) || value.context.length>12 || JSON.stringify(value.context).length>6000
    || value.context.some(x => !['user','assistant'].includes(x.role) || typeof x.content!=='string' || Object.keys(x).some(k=>!['role','content'].includes(k)))
    || !Array.isArray(value.checks) || value.checks.length>12) throw fail('eval_invalid')
  for (const check of value.checks) {
    if (!check || !['tool','no_tools','action','rule','kind','numeric','empty','error','no_mutation'].includes(check.type)
      || Object.keys(check).some(k=>!['type','name','value'].includes(k)) || JSON.stringify(check).length>500) throw fail('eval_invalid')
    if(check.type==='tool' && !['resolve_symbol','get_market_context','screen_rsi','screen_stocks','get_stock_indicators','get_stock_news','get_news_details','get_alert_editor','propose_alert','get_alert_status','resolve_market_symbol','get_market_quote','get_intraday_bars'].includes(check.name)) throw fail('eval_invalid')
    if(check.type==='numeric' && (typeof check.name!=='string'||!Number.isFinite(check.value))) throw fail('eval_invalid')
    if(check.type==='rule' && !['code','kind','threshold','frequency','expires_on'].includes(check.name)) throw fail('eval_invalid')
    if(['action','kind','error'].includes(check.type) && (typeof check.value!=='string'||check.value.length>100)) throw fail('eval_invalid')
  }
  if (value.source && (typeof value.source!=='object' || JSON.stringify(value.source).length>4000)) throw fail('eval_invalid')
  return value
}
export function evalStore(client) {
  const db = client || (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY ? createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}}) : null)
  return async (action, actor, payload={}) => {
    if (!db) throw fail('database_not_configured',503)
    const {data,error} = await db.rpc('atlas_eval_rpc',{action,actor,payload}).abortSignal(AbortSignal.timeout(8000))
    if (error) {
      const code = ['admin_forbidden','eval_not_found','eval_conflict','eval_busy','eval_invalid','eval_case_not_ready','eval_limit'].find(x=>error.message?.includes(x))
      throw fail(code || 'eval_database_unavailable', code==='admin_forbidden'?403:code==='eval_not_found'?404:code?409:503)
    }
    return data
  }
}
export function registerAdminEval(app,{store=evalStore(),authenticate=createAgentAuthenticator(),agentStore=createAgentStore(),
  origin=process.env.AI_PUBLIC_ORIGIN||'http://127.0.0.1:5173',workerSecret=process.env.AI_EVAL_SECRET||''}={}) {
  let workerInfo=null, workerAt=0
  const guarded = fn => async(req,reply)=> {
    reply.header('Cache-Control','no-store')
    try {
      if ((req.headers.origin && req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site') throw fail('origin_forbidden',403)
      const owner=await authenticate(req.headers.authorization||'')
      await store('access',owner)
      return await fn(req,owner)
    } catch(e) { return reply.code(e.statusCode||503).send({error:e.statusCode?e.message:'eval_unavailable'}) }
  }
  const id = req => { if(!uuid.test(req.params.id)) throw fail('eval_invalid'); return req.params.id }
  app.get('/api/agent/admin/status',guarded(async()=>({admin:true})))
  app.get('/api/agent/admin/catalog',guarded(async()=>({seeds,scenarios,datasets:[{id:'atlas-fixed-v1',now:'2026-10-28T08:00:00+09:00',description:'합성 일봉·뉴스·시세 / KST 고정 시각'}],maxBudget:25,maxRepeats:3,perItemBudget:0.25,worker:Date.now()-workerAt<30000?workerInfo:null,
    runtime:app.hasDecorator('agentResearchRuntime')?await app.agentResearchRuntime():null})))
  app.get('/api/agent/admin/cases',guarded((req,owner)=>store('cases',owner)))
  app.put('/api/agent/admin/cases/:id',{bodyLimit:24000},guarded((req,owner)=>{
    if(Object.keys(req.body||{}).some(k=>!['revision','spec'].includes(k))||!Number.isInteger(req.body?.revision)||req.body.revision<0) throw fail('eval_invalid')
    return store('save_case',owner,{id:id(req),revision:req.body.revision,spec:validateCase(req.body.spec)})
  }))
  app.get('/api/agent/admin/runs',guarded((req,owner)=>store('runs',owner)))
  app.post('/api/agent/admin/runs',guarded((req,owner)=>{
    const b=req.body||{}
    if(Object.keys(b).some(k=>!['id','mode','budget','repeats','cases','paidConfirmed'].includes(k))||!uuid.test(b.id)||!['code','live'].includes(b.mode)
      ||!Number.isInteger(b.repeats)||b.repeats<1||b.repeats>3||!Number.isFinite(b.budget)||b.budget<0||b.budget>25
      ||(b.mode==='live'&&(b.paidConfirmed!==true||b.budget<0.25))||(b.mode==='code'&&b.budget!==0)
      ||!Array.isArray(b.cases)||b.cases.length<1||b.cases.length>30||new Set(b.cases.map(c=>c.id)).size!==b.cases.length
      ||b.cases.some(c=>!uuid.test(c.id)||!Number.isInteger(c.revision)||c.revision<1||Object.keys(c).some(k=>!['id','revision'].includes(k)))) throw fail('eval_invalid')
    return store('start',owner,b)
  }))
  app.get('/api/agent/admin/runs/:id',guarded((req,owner)=>store('run',owner,{id:id(req)})))
  app.post('/api/agent/admin/runs/:id/cancel',guarded((req,owner)=>store('cancel',owner,{id:id(req)})))
  app.get('/api/agent/admin/items/:id',guarded((req,owner)=>store('item',owner,{id:id(req)})))
  app.post('/api/agent/admin/items/:id/review',guarded((req,owner)=>{
    const b=req.body||{}
    if(!['pass','fail','hold'].includes(b.status)||typeof b.note!=='string'||b.note.length>2000||typeof b.category!=='string'||b.category.length>60||Object.keys(b).some(k=>!['status','note','category'].includes(k))) throw fail('eval_invalid')
    return store('review',owner,{id:id(req),review:b})
  }))
  app.get('/api/agent/admin/import/:id',guarded(async(req,owner)=>{
    // Existing RPC enforces ownership; admin does NOT confer access to other rooms.
    const result=await agentStore.call('request',`u:${owner}`,{request_id:id(req)})
    const room=await agentStore.call('messages',`u:${owner}`,{room_id:result.room_id})
    const messages=room.messages||[]; const at=messages.findIndex(m=>m.request_id===result.id)
    return {question:result.question,context:messages.slice(Math.max(0,at-6),Math.max(0,at)).map(m=>({role:m.role,content:m.content.slice(0,700)})),
      source:{request_id:result.id,error:result.error_code||null,answer:String(result.answer?.content||'').slice(0,1800)},
      steps:(result.steps||[]).slice(0,30).map(s=>({name:s.name,status:s.status,result:s.result}))}
  }))
  app.post('/api/internal/eval/:action',{bodyLimit:220000},async(req,reply)=>{
    reply.header('Cache-Control','no-store')
    const supplied=String(req.headers['x-atlas-eval']||'')
    if(workerSecret.length<32||Buffer.byteLength(supplied)!==Buffer.byteLength(workerSecret)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(workerSecret))) return reply.code(401).send({error:'internal_auth_required'})
    if(!['claim','heartbeat','finish'].includes(req.params.action)) return reply.code(404).send({error:'not_found'})
    try {
      if(req.params.action==='finish' && req.body?.result) await materializeEvaluation(req.body.result)
      const result=await store(req.params.action,null,req.body||{})
      if(req.params.action==='claim') { workerInfo=req.body; workerAt=Date.now() }
      return result
    } catch { return reply.code(503).send({error:'eval_worker_store_unavailable'}) }
  })
}

export async function materializeEvaluation(result) {
  const state=result.eval_state
  if(result.alert_action && state) {
    const before=JSON.stringify(state)
    const answer=await alertAnswer(result.alert_action,{store:async action=>{
      if(action!=='read') throw fail('eval_write_forbidden')
      return {...structuredClone(state),history:[]}
    },userId:'evaluation-only',roomId:'evaluation-only',requestId:'evaluation-only',editor:{revision:null,draft:state.draft},today:'2026-10-28'})
    result.presentation=answer
    result.checks||=[]
    result.checks.push({name:'실제 알림 응답 생성기: 승인 전 저장 없음',status:JSON.stringify(state)===before?'pass':'fail',critical:true})
    if(result.scenario==='full') result.checks.push({name:'20개 한도에서 추가 카드 차단',status:answer&&!answer.watchlistConfirmation&&!answer.alertDraft?'pass':'fail',critical:true})
    if(['approve','decline'].includes(result.scenario)) {
      // This boundary is deliberately not reported as an end-to-end SQL/browser pass.
      result.checks.push({name:'확인 카드 승인·거절: 격리 DB·브라우저 통합 검증 필요',status:'review',critical:true})
    }
    if(result.checks.some(c=>c.status==='fail')) result.grade='fail'
  }
  delete result.eval_state
}
