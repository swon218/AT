import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import {startHarness} from './support/agentHarness.js'
import {createAgentMarketData} from '../server/agentMarketData.js'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {evaluationDatabase} from './support/adminEvaluation.js'
import {registerAdminEval} from '../server/adminEval.js'
if(process.env.NODE_ENV==='production')throw new Error('Fixture forbidden in production')
const dataService=createAgentMarketData({configured:()=>true,scope:()=> 'fixture',sleep:async()=>{},search:async()=>({items:[{code:'005930',name:'삼성전자',market:'KOSPI'}],total:1}),request:async()=>({return_code:0,stk_cd:'005930',stk_nm:'삼성전자',cur_prc:'1000',pred_pre:'10',pred_pre_sig:'2',flu_rt:'1',trde_qty:'0'})})
async function deletionHarness(){
 const db=await evaluationDatabase(),app=Fastify()
 registerAdminEval(app,{store:db.store,origin:'http://127.0.0.1:15179',authenticate:async authorization=>{
  if(authorization==='Bearer fixture-user-a')return db.owner
  if(authorization==='Bearer fixture-user-b')return db.other
  throw Object.assign(new Error('invalid_authentication'),{statusCode:401})
 }})
 await app.listen({port:13179,host:'127.0.0.1'})
 return {db:db.db,evaluationStore:db.store,userA:db.owner,userB:db.other,close:async()=>{await app.close();await db.db.close()}}
}
const h=process.argv.includes('--deletion')?await deletionHarness():await startHarness({port:13179,pythonPort:18179,publicOrigin:'http://127.0.0.1:15179',adminEvaluation:true,dataService})
if(process.argv.includes('--deletion')){
 await h.db.exec(await readFile(new URL('../deploy/ADMIN_EVAL_DELETE_SUPABASE.sql',import.meta.url),'utf8'))
 for(let index=1;index<=12;index++){
  const question=await h.evaluationStore('save_question',h.userA,{id:randomUUID(),revision:0,question:`격리 질문 ${index} · 삭제와 번호 확인`})
  if(index<=3||index===12){
   const started=await h.evaluationStore('start_production',h.userA,{id:randomUUID(),case_id:question.id,revision:question.revision,question:question.spec.question,paidConfirmed:true,runtime:{model:'fixture-only',limits:{max_usd:0.25}}})
   await h.evaluationStore('finish_production',h.userA,{id:started.id,lease:started.lease,state:'completed',result:{status:'completed',answer:{content:`격리 답변 ${index} · 유료 호출 없음`},usage:{status:'known',budget_usd:0}}})
  }
 }
 await h.evaluationStore('save_question',h.userB,{id:randomUUID(),revision:0,question:'다른 관리자에게만 보이는 격리 질문'})
}
const vite=await createServer({configFile:false,envDir:false,plugins:[react(),{name:'eval-fixture-auth',enforce:'pre',resolveId(id){if(id.endsWith('/supabaseClient'))return '\0eval-auth'},load(id){if(id==='\0eval-auth')return `
export const fixtureAccounts={a:'${h.userA}',b:'${h.userB}'};
let current='a';export const setFixtureAccount=value=>{current=value};
export const supabase={auth:{getSession:async()=>({data:{session:{user:{id:fixtureAccounts[current]},access_token:'fixture-user-'+current}}})}};`}}],server:{host:'127.0.0.1',port:15179,strictPort:true,proxy:{'/api':'http://127.0.0.1:13179'}}})
await vite.listen()
console.log('http://127.0.0.1:15179/tests/adminEvalBrowser.html')
async function close(){await vite.close();await h.close();process.exit(0)}
process.on('SIGINT',close);process.on('SIGTERM',close)
