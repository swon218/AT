// In-memory CAS fixture; real SQL locking and grants have separate DB tests.
import {randomUUID} from 'node:crypto'
import {encryptCredentials,decryptCredentials} from '../../server/credentialCrypto.js'
const pairs={kiwoom:['kiwoomAppKey','kiwoomSecretKey'],toss:['tossApiKey','tossSecretKey'],nh:['nhAppKey','nhSecretKey'],kb:['kbAppKey','kbSecretKey']}
export function createCredentialStore(initial={}){
  const rows=new Map(),events=[]
  let failure=null,afterCommit=null,beforeCommit=null
  const seed=(id,credentials)=>{
    const encrypted=encryptCredentials(id,credentials)
    rows.set(id,{user_id:id,credentials_ciphertext:encrypted.ciphertext,credentials_iv:encrypted.iv,credentials_auth_tag:encrypted.authTag,
      ...Object.fromEntries(Object.entries(pairs).map(([broker,keys])=>[`${broker}_configured`,keys.every(k=>Boolean(credentials[k]))])),telegram_configured:Boolean(credentials.telegramBotToken),settings_version:randomUUID()})
  }
  Object.entries(initial).forEach(([id,credentials])=>seed(id,credentials))
  const client={from:table=>{
    if(table!=='user_integrations')throw Error('Fixture table only')
    let id
    const query={select:()=>query,eq:(_field,value)=>{id=value;return query},maybeSingle:async()=>({data:rows.has(id)?structuredClone(rows.get(id)):null})}
    return query
  },rpc:async(name,args)=>{
    if(name!=='atlas_broker_credentials_cas')throw Error('Fixture RPC only')
    if(beforeCommit)await beforeCommit(args)
    if(failure)return {error:failure}
    const row=rows.get(args.p_user_id)
    if((row?.settings_version??null)!==args.p_expected_version)return {error:{code:'40001'}}
    const version=randomUUID()
    rows.set(args.p_user_id,{...args.p_row,user_id:args.p_user_id,settings_version:version})
    events.push({user:args.p_user_id,version})
    if(afterCommit)await afterCommit(args)
    return {data:{version}}
  }}
  return {client,rows,events,seed,deps:id=>({client,authenticate:async()=>({id})}),fail:error=>{failure=error},before:fn=>{beforeCommit=fn},after:fn=>{afterCommit=fn},version:id=>rows.get(id)?.settings_version??null,
    credentials:id=>{const r=rows.get(id);return r?decryptCredentials(id,{ciphertext:r.credentials_ciphertext,iv:r.credentials_iv,authTag:r.credentials_auth_tag}):{}},
  }
}
