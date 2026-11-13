import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {config} from './config.js'
import {getAccountSettings,getAuthenticatedCredentials,updateAccountSettings,deleteAccountBroker,registerAccountSettingsRoutes} from './accountSettings.js'
import {createCredentialStore} from '../tests/support/credentialStore.js'
import {createAccountConnectionHandler} from './accountConnections.js'
import {createAccountConnectionCache} from './accountConnectionCache.js'
const pairs={kiwoomAppKey:'invalid-ki-key',kiwoomSecretKey:'invalid-ki-secret',tossApiKey:'invalid-toss-key',tossSecretKey:'invalid-toss-secret',nhAppKey:'invalid-nh-key',nhSecretKey:'invalid-nh-secret',kbAppKey:'invalid-kb-key',kbSecretKey:'invalid-kb-secret'}
const withEncryption=async fn=>{const old=config.credentialEncryptionKey;config.credentialEncryptionKey='a'.repeat(64);try{await fn()}finally{config.credentialEncryptionKey=old}}
const request=(body,broker)=>({body,params:{broker}})

test('registration returns safe stored metadata; invalid keys save without implying connection',()=>withEncryption(async()=>{
  const store=createCredentialStore(),deps=store.deps('alice'),initial=await getAccountSettings({},deps)
  assert.equal(initial.settingsVersion,null);assert.ok(Object.values(initial.brokerStored).every(v=>!v))
  const saved=await updateAccountSettings(request({...pairs,expectedVersion:null}),deps)
  assert.ok(Object.values(saved.brokerStored).every(Boolean));assert.notEqual(saved.settingsVersion,null)
  assert.equal(saved.kiwoomConfigured,true);assert.deepEqual(await getAccountSettings({},deps),saved)
  assert.ok(!JSON.stringify(saved).includes('invalid-'));assert.ok(!JSON.stringify(store.rows.get('alice')).includes('invalid-'))
  const connection=createAccountConnectionHandler({authenticate:r=>getAuthenticatedCredentials(r,deps),cache:createAccountConnectionCache(),probe:async()=>false})
  for(const broker of ['kiwoom','toss','nh','kb'])assert.equal((await connection({},broker)).connected,false)
}))
test('direct overwrites and legacy deletion are refused; deleting then registering requires current version',()=>withEncryption(async()=>{
  const store=createCredentialStore({alice:pairs}),deps=store.deps('alice'),version=store.version('alice')
  for(const body of [{kiwoomAppKey:'other',kiwoomSecretKey:'other'},{kiwoomAppKey:pairs.kiwoomAppKey}])await assert.rejects(updateAccountSettings(request({...body,expectedVersion:version}),deps),{code:'credentials_already_saved'})
  await assert.rejects(updateAccountSettings(request({expectedVersion:version,clearBrokers:['kiwoom']}),deps),{code:'separate_delete_required'})
  await assert.rejects(updateAccountSettings(request(pairs),deps),{code:'settings_conflict'})
  const removed=await deleteAccountBroker(request({expectedVersion:version},'kiwoom'),deps)
  assert.equal(removed.kiwoomConfigured,false);assert.equal(removed.brokerStored.kiwoom,false)
  assert.equal(store.credentials('alice').kiwoomSecretKey,undefined)
  const readded=await updateAccountSettings(request({kiwoomAppKey:'new-invalid',kiwoomSecretKey:'new-invalid-secret',expectedVersion:removed.settingsVersion}),deps)
  assert.equal(readded.kiwoomConfigured,true)
  await assert.rejects(deleteAccountBroker(request({expectedVersion:version},'kiwoom'),deps),{code:'settings_conflict'})
  assert.equal(store.credentials('alice').kiwoomAppKey,'new-invalid')
  await assert.rejects(updateAccountSettings(request({nhAppKey:'late',nhSecretKey:'late',expectedVersion:removed.settingsVersion}),deps),{code:'settings_conflict'})
}))
test('only authenticated selected broker is removed; hidden Telegram and unrelated user data survive',()=>withEncryption(async()=>{
  const hidden={telegramBotToken:'fixture-hidden',telegramChatId:'fixture-legacy',legacySetting:'preserved'}
  const store=createCredentialStore({alice:{...pairs,...hidden},bob:pairs}),deps=store.deps('alice'),bob=structuredClone(store.rows.get('bob'))
  const removed=await deleteAccountBroker(request({expectedVersion:store.version('alice'),user_id:'bob'},'nh'),deps)
  assert.equal(removed.nhConfigured,false);assert.equal(removed.telegramConfigured,true)
  assert.deepEqual(store.credentials('alice'),Object.fromEntries(Object.entries({...pairs,...hidden}).filter(([key])=>!key.startsWith('nh'))))
  assert.deepEqual(store.rows.get('bob'),bob)
  await assert.rejects(deleteAccountBroker(request({expectedVersion:store.version('bob')},'kb'),deps),{code:'settings_conflict'})
}))
test('CAS prevents concurrent lost updates and duplicate stale deletion cannot remove newly registered keys',()=>withEncryption(async()=>{
  const store=createCredentialStore({alice:{kiwoomAppKey:'old',kiwoomSecretKey:'old-secret'}}),deps=store.deps('alice'),version=store.version('alice')
  const results=await Promise.allSettled([updateAccountSettings(request({tossApiKey:'new-toss',tossSecretKey:'new-toss-secret',expectedVersion:version}),deps),deleteAccountBroker(request({expectedVersion:version},'kiwoom'),deps)])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'settings_conflict')
  assert.equal(store.credentials('alice').kiwoomAppKey,'old');assert.equal(store.credentials('alice').tossApiKey,'new-toss')
  const current=store.version('alice'),deletes=await Promise.allSettled([deleteAccountBroker(request({expectedVersion:current},'kiwoom'),deps),deleteAccountBroker(request({expectedVersion:current},'kiwoom'),deps)])
  assert.equal(deletes.filter(r=>r.status==='fulfilled').length,1)
  await updateAccountSettings(request({kiwoomAppKey:'new',kiwoomSecretKey:'new-secret',expectedVersion:store.version('alice')}),deps)
  await assert.rejects(deleteAccountBroker(request({expectedVersion:current},'kiwoom'),deps),{code:'settings_conflict'})
  assert.equal(store.credentials('alice').kiwoomAppKey,'new')
}))
test('failed mutation preserves ciphertext; a timed-out committed delete is reconciled by fresh read',()=>withEncryption(async()=>{
  const store=createCredentialStore({alice:pairs}),deps=store.deps('alice'),before=structuredClone(store.rows.get('alice'))
  store.fail({code:'fixture-failure',message:'SECRET raw database payload'})
  await assert.rejects(deleteAccountBroker(request({expectedVersion:store.version('alice')},'kb'),deps),{code:'settings_unavailable'})
  assert.deepEqual(store.rows.get('alice'),before)
  store.fail(null);store.after(()=>{throw Error('SECRET network timeout after commit')})
  await assert.rejects(deleteAccountBroker(request({expectedVersion:store.version('alice')},'kb'),deps),{code:'settings_result_unknown'})
  assert.equal((await getAccountSettings({},deps)).brokerStored.kb,false)
}))
test('pair, length, partial legacy records, auth and encryption safeguards fail closed',()=>withEncryption(async()=>{
  const store=createCredentialStore({alice:{kiwoomAppKey:'legacy-partial',telegramBotToken:'hidden'}}),deps=store.deps('alice')
  const status=await getAccountSettings({},deps);assert.equal(status.kiwoomConfigured,false);assert.equal(status.brokerStored.kiwoom,true)
  await assert.rejects(updateAccountSettings(request({kiwoomSecretKey:'replacement',expectedVersion:status.settingsVersion}),deps),{code:'credentials_already_saved'})
  for(const body of [{tossApiKey:'one'},{tossApiKey:'x'.repeat(4097),tossSecretKey:'secret'},{nhAppKey:42,nhSecretKey:'secret'},{}])await assert.rejects(updateAccountSettings(request({...body,expectedVersion:status.settingsVersion}),deps),e=>e.statusCode===400)
  await assert.rejects(deleteAccountBroker(request({expectedVersion:status.settingsVersion},'all'),deps),{code:'invalid_broker'})
  await assert.rejects(deleteAccountBroker(request({expectedVersion:status.settingsVersion},'kiwoom'),{...deps,authenticate:async()=>{throw Object.assign(Error('fixture auth denied'),{statusCode:401})}}),{statusCode:401})
  const before=structuredClone(store.rows.get('alice'));config.credentialEncryptionKey='wrong'
  await assert.rejects(deleteAccountBroker(request({expectedVersion:status.settingsVersion},'kiwoom'),deps),{code:'settings_unavailable'})
  assert.deepEqual(store.rows.get('alice'),before)
}))
test('HTTP session guards, safe conflict responses and secret-free logging',()=>withEncryption(async()=>{
  const logs=[],store=createCredentialStore({alice:pairs}),app=Fastify({logger:{stream:{write:line=>logs.push(line)}}})
  registerAccountSettingsRoutes(app,{client:store.client,authenticate:async r=>{if(r.headers.authorization!=='Bearer fixture')throw Object.assign(Error('SECRET auth raw'),{statusCode:401});return{id:'alice'}}})
  try{
    for(const method of ['GET','PUT','DELETE'])assert.equal((await app.inject({method,url:method==='DELETE'?'/api/account/settings/kiwoom':'/api/account/settings'})).statusCode,401)
    const read=await app.inject({url:'/api/account/settings',headers:{authorization:'Bearer fixture'}})
    assert.equal(read.headers['cache-control'],'private, no-store');assert.equal(read.json().brokerStored.kiwoom,true)
    const conflict=await app.inject({method:'PUT',url:'/api/account/settings',headers:{authorization:'Bearer fixture'},payload:{kiwoomAppKey:'SECRET KEY',expectedVersion:read.json().settingsVersion}})
    assert.equal(conflict.statusCode,409);assert.equal(conflict.json().code,'credentials_already_saved')
    const removed=await app.inject({method:'DELETE',url:'/api/account/settings/kiwoom?user_id=bob',headers:{authorization:'Bearer fixture'},payload:{expectedVersion:read.json().settingsVersion}})
    assert.equal(removed.statusCode,200);assert.equal(removed.json().kiwoomConfigured,false)
    const malformed=await app.inject({method:'PUT',url:'/api/account/settings',headers:{authorization:'Bearer fixture','content-type':'application/json'},payload:'{"kiwoomAppKey":"SECRET-malformed"'})
    assert.equal(malformed.statusCode,400);assert.equal(malformed.json().code,'invalid_settings_request');assert.ok(!malformed.body.includes('SECRET'))
    assert.ok(!JSON.stringify(logs).match(/SECRET|fixture|invalid-|ciphertext|auth_tag/));assert.ok(!removed.body.includes('invalid-'))
  }finally{await app.close()}
}))
