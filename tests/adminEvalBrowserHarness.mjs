import Fastify from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { registerAdminEval } from '../server/adminEval.js'
if(process.env.NODE_ENV==='production')throw new Error('Fixture forbidden in production')
const db=new PGlite(),owner='11111111-1111-4111-8111-111111111111'
await db.exec('create schema auth;create table auth.users(id uuid primary key);create role anon;create role authenticated;create role service_role bypassrls;')
await db.exec(await readFile(new URL('../deploy/AI_EVAL_SUPABASE.sql',import.meta.url),'utf8'))
await db.query('insert into auth.users values($1)',[owner]);await db.query('insert into admin_users(user_id) values($1)',[owner])
const store=async(action,actor,payload={})=>{
  try{return(await db.query('select atlas_eval_rpc($1,$2,$3) value',[action,actor,JSON.stringify(payload)])).rows[0].value}
  catch(e){throw Object.assign(new Error(e.message),{statusCode:409})}
}
const api=Fastify()
registerAdminEval(api,{store,origin:'http://127.0.0.1:15179',authenticate:async token=>{if(token!=='Bearer fixture-admin')throw Object.assign(new Error('invalid_authentication'),{statusCode:401});return owner}})
api.setNotFoundHandler((_,reply)=>reply.code(503).send({error:'fixture_only'}))
await api.listen({host:'127.0.0.1',port:13179})
const vite=await createServer({configFile:false,plugins:[react(),{name:'eval-fixture-auth',enforce:'pre',resolveId(id){if(id.endsWith('/supabaseClient'))return '\0eval-auth'},load(id){if(id==='\0eval-auth')return `export const supabase={auth:{getSession:async()=>({data:{session:{user:{id:'${owner}'},access_token:'fixture-admin'}}})}};`}}],server:{host:'127.0.0.1',port:15179,strictPort:true,proxy:{'/api':'http://127.0.0.1:13179'}}})
await vite.listen()
const timer=setInterval(async()=>{
 try{
  const job=await store('claim',null,{code_sha:'fixture-ui-only',model:'fixture',now:'2026-10-28T08:00:00+09:00'})
  if(!job)return
  await store('finish',null,{id:job.id,lease:job.lease,state:'completed',result:{grade:'review',fingerprint:job.specimen.id,elapsed_ms:120,usage:{status:'known',budget_usd:0,model_calls:0},checks:[{name:'UI 검증용 합성 결과 · 모델 품질은 검토 필요',status:'review'}],answer:{content:'이 결과는 관리자 화면을 검증하기 위한 합성 응답입니다. 실제 모델은 호출하지 않았습니다.'},tool_outputs:[]}})
 }catch{/* UI harness never reaches a real provider. */}
},1000)
console.log('http://127.0.0.1:15179/tests/adminEvalBrowser.html')
async function close(){clearInterval(timer);await vite.close();await api.close();await db.close();process.exit(0)}
process.on('SIGINT',close);process.on('SIGTERM',close)
