import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {testDatabase} from './agentDatabase.js'
export const evalBase=await readFile(new URL('../../deploy/AI_EVAL_SUPABASE.sql',import.meta.url),'utf8')
export const evalUI=await readFile(new URL('../../deploy/ADMIN_EVAL_UI_SUPABASE.sql',import.meta.url),'utf8')
export const runtime={model:'fixture-production-model',architecture:'atlas-langgraph-research-v1',code_sha:'fixture-code',prompt_hash:'fixture-prompt',schema_hash:'fixture-schema',role_manifest:{news:['resolve_symbol','get_stock_news']},limits:{rounds:8,tool_calls:12,external_requests:8,tokens:40000,seconds:120,max_usd:0.25}}
export async function evaluationDatabase({migrate=true}={}) {
 const {db,store:agentStore}=await testDatabase()
 await db.exec(evalBase)
 const owner=randomUUID(),other=randomUUID(),member=randomUUID()
 await db.query('insert into auth.users values($1),($2),($3)',[owner,other,member])
 await db.query('insert into admin_users(user_id) values($1),($2)',[owner,other])
 const store=async(action,actor,payload={})=>{
  try{return(await db.query('select atlas_eval_rpc($1,$2,$3) value',[action,actor,JSON.stringify(payload)])).rows[0].value}
  catch(error){throw Object.assign(new Error(error.message),{statusCode:/admin_forbidden/.test(error.message)?403:/eval_not_found/.test(error.message)?404:409})}
 }
 if(migrate)await db.exec(evalUI)
 return {db,store,agentStore,owner,other,member,
  question:async(text='',who=owner)=>store('save_question',who,{id:randomUUID(),revision:0,question:text}),
  request:(row,extra={})=>({id:randomUUID(),case_id:row.id,revision:row.revision,question:row.spec.question,paidConfirmed:true,runtime,...extra})}
}
