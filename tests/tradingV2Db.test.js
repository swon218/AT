import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {tradingExecutionPolicy} from '../shared/tradingPolicies.js'
import {tradingCredentialVersion} from '../server/tradingBrokerCommon.js'

const names=['BROKER_CREDENTIAL_LIFECYCLE_SUPABASE.sql','WATCHLIST_SUPABASE.sql','STRATEGIES_SUPABASE.sql','BACKTEST_STRATEGIES_V2_SUPABASE.sql','TRADING_AGENT_V1_SUPABASE.sql']
const migrations=await Promise.all(names.map(file=>readFile(new URL(`../deploy/${file}`,import.meta.url),'utf8')))
const v2=await readFile(new URL('../deploy/TRADING_AGENT_V2_SUPABASE.sql',import.meta.url),'utf8')
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222'
const strategyId='33333333-3333-4333-8333-333333333333',staleId='44444444-4444-4444-8444-444444444444'
const otherId='99999999-9999-4999-8999-999999999999',worker='55555555-5555-4555-8555-555555555555'
const request1='77777777-7777-4777-8777-777777777777',request2='88888888-8888-4888-8888-888888888888'
const initialEpoch='e1111111-1111-4111-8111-111111111111'
const spec=(code='005930',broker='kiwoom',extra={})=>({code,broker,accountRef:'a'.repeat(32),strategyId,strategyRevision:1,quantityMode:'fixed',quantity:2,entryAction:'once',...extra})
const setup=`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 insert into auth.users values('${a}'),('${b}');
 create table public.user_integrations(user_id uuid primary key references auth.users(id) on delete cascade,
  credentials_ciphertext text not null default 'T0xE',credentials_iv text not null default 'AAAAAAAAAAAAAAAA',credentials_auth_tag text not null default 'AAAAAAAAAAAAAAAAAAAAAA==',
  settings_version uuid not null default gen_random_uuid(),kiwoom_configured boolean not null default false,toss_configured boolean not null default false,
  nh_configured boolean not null default false,kb_configured boolean not null default false,telegram_configured boolean not null default false,updated_at timestamptz not null default now());
 alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
 grant usage on schema public to anon,authenticated,service_role;`
const seed=`insert into public.watchlist_items(user_id,code,name,slot) values
 ('${a}','005930','삼성전자',1),('${a}','000660','SK하이닉스',2),('${a}','035420','NAVER',3),('${b}','051910','LG화학',1);
 insert into public.strategies(id,user_id,name,indicators,backtest_settings,schema_version) values
 ('${strategyId}','${a}','저장 당시 전략','[]','{"entryMode":"all","entryConditions":[],"takeProfitPct":10,"stopLossPct":5}',2),
 ('${staleId}','${a}','이전 버전 전략','[]','{"entryMode":"all","entryConditions":[],"takeProfitPct":12,"stopLossPct":6}',2),
 ('${otherId}','${b}','다른 회원 전략','[]','{"entryMode":"all","entryConditions":[],"takeProfitPct":10,"stopLossPct":5}',2);
 insert into public.user_integrations(user_id,settings_version,kiwoom_configured,toss_configured,nh_configured) values('${a}','${initialEpoch}',true,true,true);`
async function fixture(t,{applyV2=true}={}){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(setup)
 for(const sql of migrations)await db.exec(sql)
 await db.exec(seed)
 if(applyV2)await db.exec(v2)
 const call=async(action,actor=null,p={})=>(await db.query('select public.atlas_trading_rpc($1,$2,$3::jsonb) result',[action,actor,JSON.stringify(p)])).rows[0].result
 const save=(value=spec(),extra={})=>call('save_config',a,{expectedRevision:0,spec:value,...extra})
 const preview=(config,extra={})=>call('preview_start',a,{configId:config.id,configRevision:config.revision,mode:'LIVE',credentialVersion:'f'.repeat(64),initialState:{position:null,intentProgress:{}},...extra})
 const start=async(config,requestId=request1)=>call('start',a,{previewId:(await preview(config)).id,requestId,confirmed:true})
 return {db,call,save,preview,start}
}

test('V2 apply/reapply preserves V1 sessions, fills, unknown order refs and exact-version-only configuration backfill',async t=>{
 const {db,call,save,preview,start}=await fixture(t,{applyV2:false})
 const legacyConfig=await save(),legacyPreview=await preview(legacyConfig)
 const active=await save(spec('000660','kiwoom',{strategyId:staleId}))
 const run=await start(active)
 const {lease}=await call('claim',null,{workerId:worker})
 const refs={acceptanceId:'market-1',originalMarketOrderId:'original-market-1',integratedOrderId:'integrated-1',cancelOrderIds:['cancel-market-1'],exchange:'KRX'}
 const {intent}=await call('prepare_intent',null,{lease,sessionId:run.id,actionKey:'legacy-entry',side:'buy',kind:'entry',quantity:2,price:100,cashAvailable:1000,cashReservation:210,metadata:{refs}})
 await call('dispatch_intent',null,{lease,intentId:intent.id})
 await call('write_gate',null,{lease,intentId:intent.id})
 await call('settle_intent',null,{lease,intentId:intent.id,status:'partial',brokerOrderId:'private-original',cumulativeQuantity:1,cumulativeNotional:100,fills:[{key:'old-fill',quantity:1,price:100,at:'2026-11-16T00:00:01Z'}],metadata:{refs}})
 await call('settle_intent',null,{lease,intentId:intent.id,status:'unknown',cumulativeQuantity:1,cumulativeNotional:100})
 await db.query("update public.strategies set name='새 버전은 옛 설정의 근거가 아님' where id=$1",[staleId])
 const before=await call('session',a,{sessionId:run.id})
 const originalConfig=(await call('context',a)).configs.find(row=>row.id===legacyConfig.id)
 await db.exec(v2)
 assert.deepEqual(await call('session',a,{sessionId:run.id}),before)
 const configs=(await call('context',a)).configs
 const backed=configs.find(row=>row.id===legacyConfig.id)
 assert.deepEqual(Object.fromEntries(Object.entries(backed).filter(([key])=>!['account_label','strategy_snapshot'].includes(key))),originalConfig)
 assert.equal(backed.strategy_snapshot.revision,1);assert.equal(backed.strategy_snapshot.name,'저장 당시 전략')
 assert.equal(configs.find(row=>row.id===active.id).strategy_snapshot,null)
 assert.equal(backed.account_label,'본인 API 계좌')
 const legacy=await call('start',a,{previewId:legacyPreview.id,requestId:request2,confirmed:true})
 assert.equal(legacy.broker,'kiwoom');assert.equal(legacy.snapshot.executionPolicy,undefined)
 const preserved=await call('context',a)
 await db.exec(v2)
 assert.deepEqual(await call('context',a),preserved)
 assert.deepEqual((await call('session',a,{sessionId:run.id})).intents[0].metadata.refs,refs)
 assert.equal((await call('marker')).version,'atlas-trading-v2')
})

test('new broker policy comes from SQL, matches shared policy and cannot be forged by save/preview/start payloads',async t=>{
 const {db,call,save,preview}=await fixture(t)
 const config=await save(spec('005930','toss'),{accountLabel:'본인 계좌 ••12',strategySnapshot:{name:'조작된 전략'},executionPolicy:{route:'KRX'}})
 assert.equal(config.account_label,'본인 계좌 ••12')
 assert.equal(config.strategy_snapshot.name,'저장 당시 전략')
 const view=await preview(config,{accountLabel:'브라우저에서 지정한 다른 계좌',executionPolicy:{version:'forged',route:'KRX'}})
 assert.deepEqual(view.snapshot.executionPolicy,tradingExecutionPolicy('toss'))
 assert.equal(view.snapshot.accountLabel,'본인 계좌 ••12')
 const read=await call('preview_read',a,{previewId:view.id})
 assert.deepEqual(read.executionPolicy,tradingExecutionPolicy('toss'))
 const run=await call('start',a,{previewId:view.id,requestId:request1,confirmed:true,executionPolicy:{route:'KRX'}})
 assert.deepEqual(run.snapshot.executionPolicy,tradingExecutionPolicy('toss'))
 assert.equal(run.snapshot.accountLabel,'본인 계좌 ••12')
 await db.query("update public.strategies set name='현재 이름',backtest_settings=jsonb_set(backtest_settings,'{takeProfitPct}','20') where id=$1",[strategyId])
 const now=(await call('context',a)).configs[0]
 assert.equal(now.strategy_snapshot.name,'저장 당시 전략');assert.equal(now.strategy_snapshot.revision,1)
 const session=(await call('session',a,{sessionId:run.id})).session
 assert.equal(session.snapshot.strategy.name,'저장 당시 전략');assert.equal(session.snapshot.strategy.backtest_settings.takeProfitPct,10)
 await assert.rejects(preview(config),/trading_strategy_conflict/)
 await db.exec(v2)
 assert.equal((await call('context',a)).configs[0].strategy_snapshot.name,'저장 당시 전략')
})

test('NH has a predefined immutable policy, KB remains unsupported and old Toss previews cannot acquire a V2 policy implicitly',async t=>{
 const {db,call,save,preview}=await fixture(t,{applyV2:false})
 const old=await save(spec('005930','toss')),oldPreview=await preview(old)
 await db.exec(v2)
 await assert.rejects(call('start',a,{previewId:oldPreview.id,requestId:request1,confirmed:true,executionPolicy:tradingExecutionPolicy('toss')}),/trading_policy_mismatch/)
 const nh=await save(spec('000660','nh'),{accountLabel:'NH 본인 계좌'})
 assert.deepEqual((await preview(nh)).snapshot.executionPolicy,tradingExecutionPolicy('nh'))
 const kiwoom=await save(spec('035420','kiwoom'))
 assert.deepEqual((await preview(kiwoom)).snapshot.executionPolicy,tradingExecutionPolicy('kiwoom'))
 await db.query('delete from public.trading_v1_previews where config_id=$1',[kiwoom.id])
 const kb=await save(spec('035420','kb'),{expectedRevision:kiwoom.revision,id:kiwoom.id})
 const before=(await db.query('select count(*)::integer n from public.trading_v1_previews')).rows[0].n
 await assert.rejects(preview(kb),/trading_policy_unsupported/)
 assert.equal((await db.query('select count(*)::integer n from public.trading_v1_previews')).rows[0].n,before)
})

test('RPC ownership, private legacy base, safe search_path and newly added column privileges stay closed after repeat application',async t=>{
 const {db,call,save,preview}=await fixture(t)
 const config=await save(spec(),{accountLabel:'본인 계좌'})
 const v=await preview(config)
 await assert.rejects(call('preview_read',b,{previewId:v.id}),/trading_not_found/)
 await assert.rejects(call('save_config',b,{expectedRevision:0,spec:spec()}),/trading_strategy_conflict/)
 assert.deepEqual((await call('context',b)).configs,[])
 const metadata=(await db.query(`select prosecdef,proconfig,pg_get_userbyid(proowner) owner from pg_proc where oid='public.atlas_trading_rpc(text,uuid,jsonb)'::regprocedure`)).rows[0]
 assert.equal(metadata.prosecdef,true);assert.deepEqual(metadata.proconfig,['search_path=pg_catalog, pg_temp'])
 const functionOwners=(await db.query(`select count(distinct proowner)::integer n from pg_proc where oid in ('public.atlas_trading_rpc(text,uuid,jsonb)'::regprocedure,'public.atlas_trading_v1_base(text,uuid,jsonb)'::regprocedure)`)).rows[0].n
 assert.equal(functionOwners,1)
 await db.exec('grant select(account_label,strategy_snapshot),insert(account_label),update(strategy_snapshot) on public.trading_v1_configs to anon,authenticated,service_role;grant execute on function public.atlas_trading_v1_base(text,uuid,jsonb) to service_role')
 await db.exec(v2)
 for(const role of ['anon','authenticated','service_role']){
  await db.exec(`set role ${role}`)
  await assert.rejects(db.query("select public.atlas_trading_v1_base('context',$1,'{}')",[a]),{code:'42501'})
  if(role==='service_role')assert.equal((await call('context',a)).configs.length,1)
  else await assert.rejects(call('context',a),{code:'42501'})
  await assert.rejects(db.exec('select account_label,strategy_snapshot from public.trading_v1_configs'),{code:'42501'})
  await assert.rejects(db.exec("update public.trading_v1_configs set strategy_snapshot='{}'"),{code:'42501'})
  await assert.rejects(db.exec('delete from public.trading_v1_sessions'),{code:'42501'})
  await db.exec('reset role')
 }
 const rls=(await db.query("select count(*)::integer n from pg_class where relnamespace='public'::regnamespace and relname in ('trading_v1_configs','trading_v1_accounts','trading_v1_previews','trading_v1_sessions','trading_v1_intents','trading_v1_fills','trading_v1_events') and relrowsecurity")).rows[0].n
 assert.equal(rls,7)
})

test('V2 wrapper preserves fenced same-account cash reservations and unknown/cancel parent references',async t=>{
 const {call,save,start}=await fixture(t)
 const first=await start(await save(spec('005930','toss')))
 const second=await start(await save(spec('000660','toss')),request2)
 const claimed=await call('claim',null,{workerId:worker}),{lease}=claimed
 assert.equal(claimed.sessions.length,2)
 assert.ok(claimed.sessions.every(row=>row.snapshot.executionPolicy.route==='SOR'))
 const prepare=(run,key)=>call('prepare_intent',null,{lease,sessionId:run.id,actionKey:key,side:'buy',kind:'entry',quantity:2,price:200,cashAvailable:1000,cashReservation:600})
 const attempts=await Promise.allSettled([prepare(first,'same-account-first'),prepare(second,'same-account-second')])
 assert.equal(attempts.filter(item=>item.status==='fulfilled').length,1)
 assert.match(attempts.find(item=>item.status==='rejected').reason.message,/trading_insufficient_cash/)
 const parent=attempts.find(item=>item.status==='fulfilled').value.intent
 await call('dispatch_intent',null,{lease,intentId:parent.id})
 assert.equal((await call('write_gate',null,{lease,intentId:parent.id})).allowed,true)
 const refs={orderId:'provider-order',originalOrderId:'original-provider-order',accountRef:spec().accountRef,exchange:'SOR'}
 await call('settle_intent',null,{lease,intentId:parent.id,status:'accepted',brokerOrderId:'provider-order',metadata:{refs}})
 const cancel=(await call('prepare_intent',null,{lease,sessionId:parent.session_id,actionKey:`cancel:${parent.id}`,side:'buy',kind:'cancel',quantity:2,price:0,cashAvailable:0,cashReservation:0,metadata:{parentIntentId:parent.id,refs:{cancelId:'provider-cancel',parentOrderId:'provider-order'}}})).intent
 await call('dispatch_intent',null,{lease,intentId:cancel.id})
 assert.equal((await call('write_gate',null,{lease,intentId:cancel.id})).allowed,true)
 await call('settle_intent',null,{lease,intentId:cancel.id,status:'unknown',metadata:{cancelRefs:{requestId:'provider-cancel',originalOrderId:'provider-order'}}})
 const saved=await call('session',a,{sessionId:parent.session_id})
 assert.deepEqual(saved.intents.find(row=>row.id===parent.id).metadata.refs,refs)
 assert.equal(saved.intents.find(row=>row.id===cancel.id).metadata.cancelRefs.originalOrderId,'provider-order')
 assert.equal(saved.intents.find(row=>row.id===cancel.id).status,'unknown')
 await call('release',null,{lease})
 const resumed=await call('claim',null,{workerId:'66666666-6666-4666-8666-666666666666'})
 assert.equal(resumed.lease.epoch,2)
 await assert.rejects(call('dispatch_intent',null,{lease,intentId:cancel.id}),/trading_lease_lost/)
 assert.equal((await call('dispatch_intent',null,{lease:resumed.lease,intentId:cancel.id})).dispatch,false)
 assert.deepEqual(resumed.intents.find(row=>row.id===parent.id).metadata.refs,refs)
})

test('broker-local epochs preserve legacy hashes and unrelated protection across real credential CAS delete/readd operations',async t=>{
 const {db}=await fixture(t)
 const raw=async owner=>(await db.query('select * from public.user_integrations where user_id=$1',[owner])).rows[0]
 const original=await raw(a),epochs=original.trading_broker_versions
 assert.deepEqual(epochs,{kiwoom:initialEpoch,toss:initialEpoch,nh:initialEpoch,kb:initialEpoch})
 const account={user:{id:a},credentials:{kiwoomAppKey:'fixture-kiwoom-app',kiwoomSecretKey:'fixture-kiwoom-secret',tossApiKey:'fixture-toss-api',tossSecretKey:'fixture-toss-secret'},status:{kiwoomConfigured:true,tossConfigured:true},tradingCredentialEpoch:initialEpoch}
 const legacyHash=tradingCredentialVersion(account,'kiwoom')
 assert.equal(tradingCredentialVersion({...account,tradingCredentialEpochs:epochs},'kiwoom'),legacyHash)
 const payload=row=>Object.fromEntries(['credentials_ciphertext','credentials_iv','credentials_auth_tag','kiwoom_configured','toss_configured','nh_configured','kb_configured','telegram_configured'].map(key=>[key,row[key]]))
 const cas=async(owner,version,row)=>(await db.query('select public.atlas_broker_credentials_cas($1,$2,$3::jsonb) result',[owner,version,JSON.stringify(row)])).rows[0].result
 await db.exec('set role service_role')
 const deleted=await cas(a,original.settings_version,{...payload(original),toss_configured:false,trading_broker_versions:epochs})
 const afterDelete=await raw(a)
 assert.equal(afterDelete.settings_version,deleted.version);assert.notEqual(deleted.version,initialEpoch)
 assert.equal(afterDelete.trading_broker_versions.kiwoom,initialEpoch)
 assert.notEqual(afterDelete.trading_broker_versions.toss,initialEpoch)
 assert.equal(afterDelete.trading_broker_versions.nh,initialEpoch)
 assert.equal(afterDelete.trading_broker_versions.kb,initialEpoch)
 assert.equal(tradingCredentialVersion({...account,tradingCredentialEpoch:deleted.version,tradingCredentialEpochs:afterDelete.trading_broker_versions},'kiwoom'),legacyHash)
 await assert.rejects(cas(a,original.settings_version,payload(original)),{code:'40001'})
 assert.deepEqual(await raw(a),afterDelete)
 const readded=await cas(a,afterDelete.settings_version,{...payload(afterDelete),toss_configured:true,trading_broker_versions:epochs})
 const afterReadd=await raw(a)
 assert.equal(afterReadd.settings_version,readded.version)
 assert.notEqual(afterReadd.trading_broker_versions.toss,afterDelete.trading_broker_versions.toss)
 assert.notEqual(afterReadd.trading_broker_versions.toss,initialEpoch)
 assert.equal(afterReadd.trading_broker_versions.kiwoom,initialEpoch)
 assert.notEqual(tradingCredentialVersion({...account,tradingCredentialEpochs:afterReadd.trading_broker_versions},'toss'),tradingCredentialVersion(account,'toss'))
 // A legacy caller may bump the global CAS version without changing any broker
 // flags. The new server must keep all four broker-local epochs unchanged.
 await cas(a,afterReadd.settings_version,payload(afterReadd))
 const globalOnly=await raw(a)
 assert.notEqual(globalOnly.settings_version,afterReadd.settings_version)
 assert.deepEqual(globalOnly.trading_broker_versions,afterReadd.trading_broker_versions)
 for(const role of ['anon','authenticated','service_role']){
  await db.exec('reset role');await db.exec(`set role ${role}`)
  if(role==='service_role')assert.deepEqual((await db.query('select trading_broker_versions from public.user_integrations')).rows[0].trading_broker_versions,globalOnly.trading_broker_versions)
  else await assert.rejects(db.exec('select trading_broker_versions from public.user_integrations'),{code:'42501'})
  await assert.rejects(db.exec("update public.user_integrations set trading_broker_versions='{}'"),{code:'42501'})
  await assert.rejects(db.exec('select public.atlas_trading_broker_epoch_guard()'),{code:'42501'})
 }
 await db.exec('reset role')
 await db.exec(v2)
 assert.deepEqual(await raw(a),globalOnly)
 // Even an owner-side accidental direct UPDATE cannot restore old epochs.
 await db.query('update public.user_integrations set trading_broker_versions=$1::jsonb where user_id=$2',[JSON.stringify(epochs),a])
 assert.deepEqual((await raw(a)).trading_broker_versions,globalOnly.trading_broker_versions)
 for(const broker of ['kiwoom','toss','nh','kb']){
  const prior=await raw(a),flag=`${broker}_configured`
  await cas(a,prior.settings_version,{...payload(prior),[flag]:!prior[flag]})
  const toggled=await raw(a)
  assert.notEqual(toggled.trading_broker_versions[broker],prior.trading_broker_versions[broker])
  for(const other of ['kiwoom','toss','nh','kb'].filter(value=>value!==broker))assert.equal(toggled.trading_broker_versions[other],prior.trading_broker_versions[other])
  await cas(a,toggled.settings_version,{...payload(toggled),[flag]:prior[flag]})
  const restored=await raw(a)
  assert.notEqual(restored.trading_broker_versions[broker],prior.trading_broker_versions[broker])
  assert.notEqual(restored.trading_broker_versions[broker],toggled.trading_broker_versions[broker])
 }
 const finalA=await raw(a)
 assert.notEqual(tradingCredentialVersion({...account,tradingCredentialEpochs:finalA.trading_broker_versions},'kiwoom'),legacyHash)
 await db.exec(v2);assert.deepEqual(await raw(a),finalA)
 const bPayload={...payload(original),kiwoom_configured:true}
 const firstInsert=await cas(b,null,bPayload),firstRow=await raw(b)
 assert.ok(Object.values(firstRow.trading_broker_versions).every(value=>value===firstInsert.version))
 await db.query('delete from public.user_integrations where user_id=$1',[b])
 const secondInsert=await cas(b,null,bPayload),secondRow=await raw(b)
 assert.notEqual(secondInsert.version,firstInsert.version)
 assert.ok(Object.values(secondRow.trading_broker_versions).every(value=>value===secondInsert.version))
 assert.deepEqual((await raw(a)).trading_broker_versions,finalA.trading_broker_versions)
})

test('native V2 PostgreSQL blocks concurrent strategy edits during snapshot save and serializes two cash reservations',{skip:!process.env.TRADING_V2_TEST_PSQL,timeout:45000},async t=>{
 const database=`atlas_trading_v2_test_${process.pid}_${Date.now()}`
 const binary=process.env.TRADING_V2_TEST_PSQL
 const literal=value=>`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`
 const command=(action,actor,p)=>`select public.atlas_trading_rpc('${action}',${actor?`'${actor}'::uuid`:'null'},${literal(p)});`
 function psql(sql,{db=database,app='atlas-trading-v2-test'}={}){
  return new Promise((resolve,reject)=>{
   const child=spawn(binary,['-X','-q','-A','-t','-h','127.0.0.1','-p','54984','-U','atlas_test','-d',db,'-v','ON_ERROR_STOP=1'],{windowsHide:true,env:{...process.env,PGAPPNAME:app,PGCONNECT_TIMEOUT:'3'},stdio:['pipe','pipe','pipe']})
   let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk)
   child.on('error',reject);child.on('exit',code=>code===0?resolve(stdout.trim()):reject(Object.assign(Error(stderr.trim()||`psql_exit_${code}`),{stdout,code})))
   child.stdin.end(sql)
  })
 }
 const result=async(sql,options)=>JSON.parse((await psql(sql,options)).split(/\r?\n/).find(line=>line.trim()))
 const pathText=value=>String(value).replaceAll('\\','/').toLowerCase().replace(/\/$/,'')
 assert.equal(pathText(await result("select to_json(current_setting('data_directory'));",{db:'postgres'})),pathText(fileURLToPath(new URL('../node_modules/.cache/trading-pg-v2/data',import.meta.url))),'refuse a non-fixture database cluster')
 assert.match(database,/^atlas_trading_v2_test_[0-9_]+$/)
 await psql(`create database ${database};`,{db:'postgres'})
 t.after(()=>psql(`drop database ${database} with (force);`,{db:'postgres'}))
 await psql(setup)
 for(const sql of migrations)await psql(sql)
 await psql(seed);await psql(v2)
 async function waitEvent(app,type){
  for(let n=0;n<30;n++){
   const value=await result(`select count(*)::integer from pg_stat_activity where application_name='${app}' and ${type==='sleep'?"wait_event='PgSleep'":"wait_event_type='Lock'"};`)
   if(value>0)return
   await new Promise(resolve=>setTimeout(resolve,40))
  }
  assert.fail(`fixture did not reach ${type}`)
 }
 const savePayload={expectedRevision:0,spec:spec('005930','toss'),accountLabel:'저장 당시 계좌'}
 const saving=psql(`begin;${command('save_config',a,savePayload)}select pg_sleep(2);commit;`,{app:'atlas-trading-v2-save'})
 await waitEvent('atlas-trading-v2-save','sleep')
 const editing=psql(`update public.strategies set name='동시 변경 후 이름' where id='${strategyId}';`,{app:'atlas-trading-v2-edit'})
 await waitEvent('atlas-trading-v2-edit','lock')
 const originalConfig=JSON.parse((await saving).split(/\r?\n/).find(Boolean));await editing
 const after=await result(command('context',a,{}))
 assert.equal(after.configs[0].strategy_snapshot.name,'저장 당시 전략');assert.equal(after.configs[0].strategy_snapshot.revision,1)
 assert.equal(after.strategies.find(row=>row.id===strategyId).name,'동시 변경 후 이름')
 const current=await result(command('save_config',a,{expectedRevision:originalConfig.revision,id:originalConfig.id,spec:spec('005930','toss',{strategyRevision:2}),accountLabel:'저장 당시 계좌'}))
 const second=await result(command('save_config',a,{expectedRevision:0,spec:spec('000660','toss',{strategyRevision:2}),accountLabel:'같은 계좌'}))
 const runs=[]
 for(const [index,config] of [current,second].entries()){
  const view=await result(command('preview_start',a,{configId:config.id,configRevision:config.revision,mode:'LIVE',credentialVersion:'f'.repeat(64),initialState:{position:null,intentProgress:{}}}))
  assert.deepEqual(view.snapshot.executionPolicy,tradingExecutionPolicy('toss'))
  runs.push(await result(command('start',a,{previewId:view.id,requestId:index?request2:request1,confirmed:true})))
 }
 const {lease}=await result(command('claim',null,{workerId:worker}))
 const prepare=run=>result(command('prepare_intent',null,{lease,sessionId:run.id,actionKey:'v2-cash-race',side:'buy',kind:'entry',quantity:2,price:200,cashAvailable:1000,cashReservation:600}))
 const attempts=await Promise.allSettled(runs.map(prepare))
 assert.equal(attempts.filter(row=>row.status==='fulfilled').length,1)
 assert.match(attempts.find(row=>row.status==='rejected').reason.message,/trading_insufficient_cash/)
 const intent=attempts.find(row=>row.status==='fulfilled').value.intent
 await result(command('dispatch_intent',null,{lease,intentId:intent.id}))
 await result(command('write_gate',null,{lease,intentId:intent.id}))
 const refs={originalOrderId:'native-provider-order',cancelOrderIds:['native-cancel-ref'],exchange:'SOR'}
 await result(command('settle_intent',null,{lease,intentId:intent.id,status:'unknown',metadata:{refs}}))
 const before=await result(command('session',a,{sessionId:intent.session_id}))
 await psql(v2)
 assert.deepEqual(await result(command('session',a,{sessionId:intent.session_id})),before)
 await assert.rejects(psql(`set role service_role;select public.atlas_trading_v1_base('context','${a}','{}');`),/permission denied/)
 await assert.rejects(psql('set role service_role;update public.trading_v1_configs set account_label=\'forged\';'),/permission denied/)
})
