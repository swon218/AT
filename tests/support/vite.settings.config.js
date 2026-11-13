import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
const users=new Map(),calls=[]
const fields={kiwoom:['kiwoomAppKey','kiwoomSecretKey'],toss:['tossApiKey','tossSecretKey'],nh:['nhAppKey','nhSecretKey'],kb:['kbAppKey','kbSecretKey']}
const mode={fail:false,deleteMode:'success',readFailure:false,oldApi:false}
const row=owner=>{if(!users.has(owner))users.set(owner,{nickname:'검증회원',hiddenTelegram:'fixture-existing-hidden',credentials:{},version:null});return users.get(owner)}
const status=data=>({...Object.fromEntries(Object.entries(fields).map(([broker,keys])=>[`${broker}Configured`,keys.every(k=>Boolean(data.credentials[k]))])),telegramConfigured:true,...(mode.oldApi?{}:{settingsVersion:data.version,brokerStored:Object.fromEntries(Object.entries(fields).map(([b,keys])=>[b,keys.some(k=>Boolean(data.credentials[k]))]))})})
export default defineConfig({envDir:false,plugins:[react(),{name:'settings-fixture-network-only',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  const url=new URL(req.url,'http://localhost'),owner=req.headers.authorization?.replace('Bearer ','')||url.searchParams.get('user')||'fixture-a'
  if(!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/__fixture/'))return next()
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store')
  let raw='';for await(const chunk of req)raw+=chunk
  const input=raw?JSON.parse(raw):{},data=row(owner)
  const error=(code,message,http=409)=>{res.statusCode=http;res.end(JSON.stringify({code,error:message}))}
  if(url.pathname==='/__fixture/mode'){for(const k of Object.keys(mode))if(Object.hasOwn(input,k))mode[k]=input[k];res.end('{}');return}
  if(url.pathname==='/__fixture/external'){const broker=input.broker||'kiwoom';for(const key of fields[broker])data.credentials[key]='external-invalid-fixture';data.version=randomUUID();res.end('{}');return}
  if(url.pathname==='/__fixture/report'){res.end(JSON.stringify({mode,requests:calls,users:[...users].map(([id,value])=>({id,saved:status(value),telegramPreserved:value.hiddenTelegram==='fixture-existing-hidden'}))}));return}
  if(url.pathname==='/__fixture/profile'){if(req.method==='PUT')data.nickname=input.nickname;res.end(JSON.stringify({nickname:data.nickname}));return}
  if(url.pathname==='/api/account/settings'&&req.method==='GET'){
    if(mode.readFailure)return error('settings_unavailable','모의 저장 상태 조회 실패',503)
    res.end(JSON.stringify(status(data)));return
  }
  if(url.pathname==='/api/account/settings'&&req.method==='PUT'){
    const call={owner,method:'PUT',fields:Object.keys(input),success:false};calls.push(call)
    if(mode.fail)return error('settings_unavailable','모의 저장 실패 · 기존 저장 정보는 유지됩니다.',503)
    if(!Object.hasOwn(input,'expectedVersion')||input.expectedVersion!==data.version)return error('settings_conflict','최신 설정을 다시 확인해 주세요.')
    if(input.clearBrokers?.length)return error('separate_delete_required','증권사별 삭제 버튼을 사용해 주세요.',400)
    for(const keys of Object.values(fields))if(keys.some(k=>input[k]?.trim())&&keys.some(k=>data.credentials[k]))return error('credentials_already_saved','기존 API 키를 삭제한 후 다시 등록해 주세요.')
    for(const keys of Object.values(fields))for(const k of keys)if(typeof input[k]==='string'&&input[k].trim())data.credentials[k]=input[k].trim()
    data.version=randomUUID();call.success=true;res.end(JSON.stringify(status(data)));return
  }
  const deleting=url.pathname.match(/^\/api\/account\/settings\/(kiwoom|toss|nh|kb)$/)
  if(deleting&&req.method==='DELETE'){
    const broker=deleting[1],call={owner,method:'DELETE',broker,success:false};calls.push(call)
    if(mode.deleteMode==='slow')await new Promise(resolve=>setTimeout(resolve,2000))
    if(input.expectedVersion!==data.version)return error('settings_conflict','설정이 변경되었습니다. 최신 상태를 다시 확인해 주세요.')
    if(mode.deleteMode==='fail')return error('delete_failed','모의 삭제 실패 · 기존 키는 유지됩니다.',400)
    if(mode.deleteMode==='unknown-kept')return error('settings_result_unknown','모의 응답 유실 · 결과 재확인 필요',504)
    for(const key of fields[broker])delete data.credentials[key]
    data.version=randomUUID();call.success=true
    if(mode.deleteMode==='unknown-deleted')return error('settings_result_unknown','모의 삭제 후 응답 유실',504)
    res.end(JSON.stringify(status(data)));return
  }
  if(url.pathname==='/api/account/kakao'&&req.method==='GET'){res.end(JSON.stringify({available:true,status:'connected',maskedId:'모의 ***1234',linkedAt:'2026-11-13T00:00:00Z',messageAuthorized:true}));return}
  return error('fixture_only','Fixture blocks all other APIs, messages and broker requests',403)
})}}],resolve:{alias:[{find:'../services/supabaseClient',replacement:fileURLToPath(new URL('./settingsSession.js',import.meta.url))},{find:'./supabaseClient',replacement:fileURLToPath(new URL('./settingsSession.js',import.meta.url))}]},server:{host:'127.0.0.1',port:5184,strictPort:true}})
