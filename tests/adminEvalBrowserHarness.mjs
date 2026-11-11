import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import {startHarness} from './support/agentHarness.js'
import {createAgentMarketData} from '../server/agentMarketData.js'
if(process.env.NODE_ENV==='production')throw new Error('Fixture forbidden in production')
const dataService=createAgentMarketData({configured:()=>true,scope:()=> 'fixture',sleep:async()=>{},search:async()=>({items:[{code:'005930',name:'삼성전자',market:'KOSPI'}],total:1}),request:async()=>({return_code:0,stk_cd:'005930',stk_nm:'삼성전자',cur_prc:'1000',pred_pre:'10',pred_pre_sig:'2',flu_rt:'1',trde_qty:'0'})})
const h=await startHarness({port:13179,pythonPort:18179,publicOrigin:'http://127.0.0.1:15179',adminEvaluation:true,dataService})
const vite=await createServer({configFile:false,envDir:false,plugins:[react(),{name:'eval-fixture-auth',enforce:'pre',resolveId(id){if(id.endsWith('/supabaseClient'))return '\0eval-auth'},load(id){if(id==='\0eval-auth')return `
export const fixtureAccounts={a:'${h.userA}',b:'${h.userB}'};
let current='a';export const setFixtureAccount=value=>{current=value};
export const supabase={auth:{getSession:async()=>({data:{session:{user:{id:fixtureAccounts[current]},access_token:'fixture-user-'+current}}})}};`}}],server:{host:'127.0.0.1',port:15179,strictPort:true,proxy:{'/api':'http://127.0.0.1:13179'}}})
await vite.listen()
console.log('http://127.0.0.1:15179/tests/adminEvalBrowser.html')
async function close(){await vite.close();await h.close();process.exit(0)}
process.on('SIGINT',close);process.on('SIGTERM',close)
