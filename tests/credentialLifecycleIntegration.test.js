import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {PGlite} from '@electric-sql/pglite'
import {config} from '../server/config.js'
import {encryptCredentials,decryptCredentials} from '../server/credentialCrypto.js'
import {getAccountSettings,updateAccountSettings,deleteAccountBroker} from '../server/accountSettings.js'

const migration=await readFile(new URL('../deploy/BROKER_CREDENTIAL_LIFECYCLE_SUPABASE.sql',import.meta.url),'utf8')
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222'
const fields={kiwoom:['kiwoomAppKey','kiwoomSecretKey'],toss:['tossApiKey','tossSecretKey'],nh:['nhAppKey','nhSecretKey'],kb:['kbAppKey','kbSecretKey']}

test('Node AES lifecycle handlers use actual SQL CAS to preserve hidden data and reject concurrent/stale mutations',async()=>{
  const previous=config.credentialEncryptionKey,db=new PGlite(),invalidated=[]
  config.credentialEncryptionKey='a'.repeat(64)
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create table auth.users(id uuid primary key);
      insert into auth.users values ('${a}'),('${b}');
      create table public.user_integrations(user_id uuid primary key references auth.users(id) on delete cascade,
        credentials_ciphertext text not null,credentials_iv text not null,credentials_auth_tag text not null,
        kiwoom_configured boolean not null default false,toss_configured boolean not null default false,
        nh_configured boolean not null default false,kb_configured boolean not null default false,
        telegram_configured boolean not null default false,updated_at timestamptz not null default now());
      grant usage on schema public to anon,authenticated,service_role;`)
    async function seed(owner,credentials){
      const encrypted=encryptCredentials(owner,credentials)
      await db.query(`insert into public.user_integrations(user_id,credentials_ciphertext,credentials_iv,credentials_auth_tag,
        kiwoom_configured,toss_configured,nh_configured,kb_configured,telegram_configured)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[owner,encrypted.ciphertext,encrypted.iv,encrypted.authTag,
        ...Object.values(fields).map(pair=>pair.every(key=>Boolean(credentials[key]))),Boolean(credentials.telegramBotToken)])
    }
    const hidden={telegramBotToken:'fixture-hidden-token',telegramChatId:'fixture-hidden-chat',legacyValue:'retain'}
    const original={kiwoomAppKey:'fixture-old-key',kiwoomSecretKey:'fixture-old-secret',tossApiKey:'fixture-toss',tossSecretKey:'fixture-toss-secret',...hidden}
    await seed(a,original);await seed(b,{kbAppKey:'fixture-other-owner',kbSecretKey:'fixture-other-secret'})
    await db.exec(migration);await db.exec('set role service_role')
    const raw=async owner=>(await db.query('select * from public.user_integrations where user_id=$1',[owner])).rows[0]
    const stored=async owner=>{const value=await raw(owner);return decryptCredentials(owner,{ciphertext:value.credentials_ciphertext,iv:value.credentials_iv,authTag:value.credentials_auth_tag})}
    const other=await raw(b)
    let uncertain=false
    const client={from:table=>{
      assert.equal(table,'user_integrations');let id
      const q={select:()=>q,eq:(column,value)=>{assert.equal(column,'user_id');id=value;return q},maybeSingle:async()=>({data:await raw(id)})}
      return q
    },rpc:async(name,args)=>{
      assert.equal(name,'atlas_broker_credentials_cas')
      let result
      try{result=(await db.query('select public.atlas_broker_credentials_cas($1,$2,$3::jsonb) result',[args.p_user_id,args.p_expected_version,JSON.stringify(args.p_row)])).rows[0].result}
      catch(error){return {error:{code:error.code}}}
      if(uncertain){uncertain=false;throw Error('fixture response lost after commit')}
      return {data:result}
    }}
    const deps={client,authenticate:async()=>({id:a}),invalidate:(owner,brokers)=>invalidated.push({owner,brokers})}
    const request=(body,broker)=>({body,params:{broker}})
    const initial=await getAccountSettings({},deps)
    await assert.rejects(updateAccountSettings(request({expectedVersion:initial.settingsVersion,kiwoomAppKey:'forbidden-replacement',kiwoomSecretKey:'forbidden-secret'}),deps),{code:'credentials_already_saved'})
    const added=await updateAccountSettings(request({expectedVersion:initial.settingsVersion,nhAppKey:'fixture-nh',nhSecretKey:'fixture-nh-secret'}),deps)
    assert.notEqual(added.settingsVersion,initial.settingsVersion)
    assert.deepEqual(await stored(a),{...original,nhAppKey:'fixture-nh',nhSecretKey:'fixture-nh-secret'})
    const removed=await deleteAccountBroker(request({expectedVersion:added.settingsVersion},'kiwoom'),deps)
    assert.equal(removed.kiwoomConfigured,false);assert.equal(removed.brokerStored.kiwoom,false)
    assert.deepEqual(await stored(a),{tossApiKey:original.tossApiKey,tossSecretKey:original.tossSecretKey,...hidden,nhAppKey:'fixture-nh',nhSecretKey:'fixture-nh-secret'})
    const readded=await updateAccountSettings(request({expectedVersion:removed.settingsVersion,kiwoomAppKey:'fixture-new-key',kiwoomSecretKey:'fixture-new-secret'}),deps)
    await assert.rejects(deleteAccountBroker(request({expectedVersion:removed.settingsVersion},'kiwoom'),deps),{code:'settings_conflict'})
    assert.equal((await stored(a)).kiwoomAppKey,'fixture-new-key')
    const race=await Promise.allSettled([
      updateAccountSettings(request({expectedVersion:readded.settingsVersion,kbAppKey:'fixture-kb',kbSecretKey:'fixture-kb-secret'}),deps),
      deleteAccountBroker(request({expectedVersion:readded.settingsVersion},'nh'),deps),
    ])
    assert.equal(race.filter(value=>value.status==='fulfilled').length,1)
    assert.equal(race.find(value=>value.status==='rejected').reason.code,'settings_conflict')
    const raced=await stored(a)
    assert.equal(raced.kiwoomAppKey,'fixture-new-key');assert.equal(raced.tossApiKey,original.tossApiKey)
    assert.equal(raced.telegramBotToken,hidden.telegramBotToken)
    assert.ok((raced.kbAppKey==='fixture-kb'&&raced.nhAppKey==='fixture-nh')||(!raced.kbAppKey&&!raced.nhAppKey))
    const fresh=await getAccountSettings({},deps)
    uncertain=true
    await assert.rejects(deleteAccountBroker(request({expectedVersion:fresh.settingsVersion},'toss'),deps),{code:'settings_result_unknown'})
    const reconciled=await getAccountSettings({},deps)
    assert.equal(reconciled.brokerStored.toss,false);assert.equal((await stored(a)).tossSecretKey,undefined)
    assert.equal((await stored(a)).telegramBotToken,hidden.telegramBotToken)
    await assert.rejects(deleteAccountBroker(request({expectedVersion:other.settings_version,user_id:b},'kb'),deps),{code:'settings_conflict'})
    assert.deepEqual(await raw(b),other)
    assert.ok(invalidated.some(value=>value.owner===a&&value.brokers.includes('toss')))
    assert.ok(!JSON.stringify(reconciled).includes('fixture-'))
    assert.ok(!JSON.stringify(await raw(a)).includes('fixture-'))
  }finally{config.credentialEncryptionKey=previous;await db.close()}
})
