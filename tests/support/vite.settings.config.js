import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import {fileURLToPath} from 'node:url'
const users=new Map(),calls=[]
const fields={kiwoom:['kiwoomAppKey','kiwoomSecretKey'],toss:['tossApiKey','tossSecretKey'],nh:['nhAppKey','nhSecretKey'],kb:['kbAppKey','kbSecretKey']}
let fail=false
const row=owner=>{if(!users.has(owner))users.set(owner,{nickname:'검증회원',hiddenTelegram:'fixture-existing-hidden',credentials:{}});return users.get(owner)}
const status=data=>Object.fromEntries(Object.entries(fields).map(([broker,keys])=>[`${broker}Configured`,keys.every(k=>Boolean(data.credentials[k]))]))
export default defineConfig({envDir:false,plugins:[react(),{name:'settings-fixture-network-only',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  const url=new URL(req.url,'http://localhost'),owner=req.headers.authorization?.replace('Bearer ','')||url.searchParams.get('user')||'fixture-a'
  if(!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/__fixture/'))return next()
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store')
  let raw='';for await(const chunk of req)raw+=chunk
  const input=raw?JSON.parse(raw):{},data=row(owner)
  if(url.pathname==='/__fixture/mode'){fail=input.fail===true;res.end('{}');return}
  if(url.pathname==='/__fixture/report'){res.end(JSON.stringify({fail,requests:calls,users:[...users].map(([id,value])=>({id,saved:status(value),telegramPreserved:value.hiddenTelegram==='fixture-existing-hidden'}))}));return}
  if(url.pathname==='/__fixture/profile'){if(req.method==='PUT')data.nickname=input.nickname;res.end(JSON.stringify({nickname:data.nickname}));return}
  if(url.pathname==='/api/account/settings'){
    if(req.method==='PUT'){
      calls.push({owner,fields:Object.keys(input),clearBrokers:input.clearBrokers||[],success:!fail})
      if(fail){res.statusCode=500;res.end('{"error":"모의 저장 실패 · 기존 저장 정보는 유지됩니다."}');return}
      for(const keys of Object.values(fields))for(const k of keys)if(typeof input[k]==='string'&&input[k].trim())data.credentials[k]=input[k].trim()
      for(const broker of input.clearBrokers||[])for(const key of fields[broker]||[])delete data.credentials[key]
    }
    res.end(JSON.stringify({...status(data),telegramConfigured:true}));return
  }
  if(url.pathname==='/api/account/kakao'&&req.method==='GET'){res.end(JSON.stringify({available:true,status:'connected',maskedId:'모의 ***1234',connectedAt:'2026-11-13T00:00:00Z',messageAuthorized:true}));return}
  res.statusCode=403;res.end('{"error":"Fixture blocks all other APIs, messages and broker requests"}')
})}}],resolve:{alias:[{find:'../services/supabaseClient',replacement:fileURLToPath(new URL('./settingsSession.js',import.meta.url))},{find:'./supabaseClient',replacement:fileURLToPath(new URL('./settingsSession.js',import.meta.url))}]},server:{host:'127.0.0.1',port:5184,strictPort:true}})
