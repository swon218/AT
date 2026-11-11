// Local-only UI QA against the real Node -> FastAPI -> fixture SQLite path.
// No production .env, API keys, personal accounts or external model calls.
import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import {fileURLToPath} from 'node:url'
import {startHarness} from './support/agentHarness.js'
const root=fileURLToPath(new URL('../',import.meta.url))
const h=await startHarness({port:13180,pythonPort:18180,publicOrigin:'http://127.0.0.1:15180'})
let mode='normal',readCount=0,firstReadAt=null
const body=async req=>{let text='';for await(const part of req)text+=part;return text}
const fixture={name:'local-screen-progress-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  const send=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data))}
  if(req.url==='/__qa/screener-mode'&&req.method==='POST'){
    mode=JSON.parse(await body(req)).mode;readCount=0;firstReadAt=null;send({fixture:true,mode});return
  }
  if(req.url!=='/api/screener'||mode==='normal'){next();return}
  try{
    const response=await fetch(h.base+'/api/screener',{method:req.method,headers:{'Content-Type':'application/json',origin:'http://127.0.0.1:15180'},...(req.method==='POST'?{body:await body(req)}:{})})
    const data=await response.json();res.statusCode=response.status
    if(response.ok&&req.method==='GET'&&mode==='old')data.condition_version=null
    if(response.ok&&req.method==='POST'&&mode==='resume'){
      const scanned=[1088,1472,1856,2240,2624,2719][Math.min(readCount++,5)]
      firstReadAt??=data.coverage.data_read_at
      Object.assign(data.coverage,{universe:2719,scanned,not_scanned:2719-scanned,valid:scanned,excluded:{},data_read_at:firstReadAt})
      data.status=scanned<2719?'partial':'success'
    }
    send(data)
  }catch{res.statusCode=503;send({error:'fixture_unavailable'})}
})}}
const vite=await createServer({root,configFile:false,envDir:false,plugins:[react(),fixture],server:{host:'127.0.0.1',port:15180,strictPort:true,proxy:{'/api':{target:h.base}}}})
await vite.listen()
console.log('SCREENER_UI_FIXTURE_READY http://127.0.0.1:15180/tests/support/screenerBrowser.html')
let closing=false
const close=async()=>{if(closing)return;closing=true;await vite.close();await h.close();process.exit(0)}
process.on('SIGINT',close);process.on('SIGTERM',close)
process.stdin.on('data',data=>{if(data.toString().trim()==='stop')void close()})
