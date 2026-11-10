import Fastify from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { registerAdminEval } from '../server/adminEval.js'
if(process.env.NODE_ENV==='production')throw new Error('Fixture forbidden in production')
const fixtureCode = `import asyncio,json,sys
from ai_agent.config import Settings
from ai_agent.evaluation.engine import evaluate,metadata
job=json.load(sys.stdin)
assert not job or job['mode']=='code'
print(json.dumps(asyncio.run(evaluate(job,Settings())) if job else metadata(Settings()),ensure_ascii=False))`
function graphFixture(job) {
  return new Promise((resolve,reject)=>{
    const child=spawn(fileURLToPath(new URL('../.venv-ai/Scripts/python.exe',import.meta.url)),['-c',fixtureCode],{
      cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true,
      env:{...Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]])),PYTHONIOENCODING:'utf-8'},
    })
    let output=''
    child.stdout.on('data',data=>{output+=data})
    child.stderr.resume()
    child.on('error',reject)
    child.on('close',code=>{if(code)reject(new Error('fixture_graph_failed'));else{try{resolve(JSON.parse(output))}catch{reject(new Error('fixture_graph_invalid'))}}})
    child.stdin.end(JSON.stringify(job))
  })
}
const graphMetadata=await graphFixture(null)
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
const vite=await createServer({configFile:false,envDir:false,plugins:[react(),{name:'eval-fixture-auth',enforce:'pre',resolveId(id){if(id.endsWith('/supabaseClient'))return '\0eval-auth'},load(id){if(id==='\0eval-auth')return `export const supabase={auth:{getSession:async()=>({data:{session:{user:{id:'${owner}'},access_token:'fixture-admin'}}})}};`}}],server:{host:'127.0.0.1',port:15179,strictPort:true,proxy:{'/api':'http://127.0.0.1:13179'}}})
await vite.listen()
let evaluating=false
const timer=setInterval(async()=>{
 if(evaluating)return
 evaluating=true
 try{
  const job=await store('claim',null,graphMetadata)
  if(!job)return
  const result=await graphFixture(job)
  await store('finish',null,{id:job.id,lease:job.lease,state:result.status==='failed'?'failed':'completed',result})
 }catch{/* Only the local production graph and fixed-data ContractProvider are available. */}
 finally{evaluating=false}
},1000)
console.log('http://127.0.0.1:15179/tests/adminEvalBrowser.html')
async function close(){clearInterval(timer);await vite.close();await api.close();await db.close();process.exit(0)}
process.on('SIGINT',close);process.on('SIGTERM',close)
