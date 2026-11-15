// Opt-in native PostgreSQL test. Run ONLY against a newly initialized disposable
// local cluster owned by atlas_test on port 54983. No URL/password is accepted.
// TRADING_TEST_PSQL must point to an existing local psql.exe binary.
import assert from 'node:assert/strict'
import test from 'node:test'
import {spawn} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

const binary=process.env.TRADING_TEST_PSQL
const a='11111111-1111-4111-8111-111111111111',strategyId='33333333-3333-4333-8333-333333333333'
const worker1='55555555-5555-4555-8555-555555555555',worker2='66666666-6666-4666-8666-666666666666'
const literal=value=>`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`
const command=(action,actor,p)=>`select public.atlas_trading_rpc('${action}',${actor?`'${actor}'::uuid`:'null'},${literal(p)});`
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))

test('native PostgreSQL independent sessions serialize account cash, skip locked workers and recover a committed dispatch after backend crash',{skip:!binary,timeout:45000},async t=>{
 const database=`atlas_trading_test_${process.pid}_${Date.now()}`
 assert.match(database,/^atlas_trading_test_[0-9_]+$/)
 function psql(sql,{db=database,app='atlas-trading-test'}={}){
  return new Promise((resolve,reject)=>{
   const child=spawn(binary,['-X','-q','-A','-t','-h','127.0.0.1','-p','54983','-U','atlas_test','-d',db,'-v','ON_ERROR_STOP=1'],{windowsHide:true,env:{...process.env,PGAPPNAME:app,PGCONNECT_TIMEOUT:'3'},stdio:['pipe','pipe','pipe']})
   let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk)
   child.on('error',reject);child.on('exit',code=>code===0?resolve(stdout.trim()):reject(Object.assign(Error(stderr.trim()||`psql_exit_${code}`),{stdout,code})))
   child.stdin.end(sql)
  })
 }
 const result=async(sql,options)=>JSON.parse((await psql(sql,options)).split(/\r?\n/).find(line=>line.trim()))
 const dataDirectory=await result("select to_json(current_setting('data_directory'));",{db:'postgres'})
 const expectedDirectory=fileURLToPath(new URL('../node_modules/.cache/trading-pg-v1/data',import.meta.url))
 const pathText=value=>String(value).replaceAll('\\','/').toLowerCase().replace(/\/$/,'')
 assert.equal(pathText(dataDirectory),pathText(expectedDirectory),'refuse any existing or non-fixture PostgreSQL cluster')
 await psql(`create database ${database};`,{db:'postgres'})
 t.after(async()=>{await psql(`drop database ${database} with (force);`,{db:'postgres'})})
 await psql(`do $$begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls;end if;end$$;
  create schema auth;create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  insert into auth.users values('${a}');grant usage on schema public to anon,authenticated,service_role;`)
 for(const file of ['WATCHLIST_SUPABASE.sql','STRATEGIES_SUPABASE.sql','BACKTEST_STRATEGIES_V2_SUPABASE.sql','TRADING_AGENT_V1_SUPABASE.sql'])await psql(await readFile(new URL(`../deploy/${file}`,import.meta.url),'utf8'))
 await psql(`insert into public.watchlist_items(user_id,code,name,slot) values('${a}','005930','삼성전자',1),('${a}','000660','SK하이닉스',2);
  insert into public.strategies(id,user_id,name,indicators,backtest_settings,schema_version) values('${strategyId}','${a}','관리','[]','{"entryMode":"all","entryConditions":[],"takeProfitPct":10,"stopLossPct":5}',2);`)
 const runs=[]
 for(const [index,code] of ['005930','000660'].entries()){
  const spec={code,broker:'kiwoom',accountRef:'a'.repeat(32),strategyId,strategyRevision:1,quantityMode:'fixed',quantity:1,entryAction:'once'}
  const config=await result(command('save_config',a,{spec,expectedRevision:0}))
  const preview=await result(command('preview_start',a,{configId:config.id,configRevision:config.revision,mode:'LIVE',credentialVersion:'f'.repeat(64),initialState:{position:null,intentProgress:{}}}))
  runs.push(await result(command('start',a,{previewId:preview.id,requestId:`77777777-7777-4777-8777-77777777777${index}`,confirmed:true})))
 }
 async function waitSleep(app){
  for(let n=0;n<25;n++){
   const waiting=await result(`select count(*)::integer from pg_stat_activity where application_name='${app}' and wait_event='PgSleep';`)
   if(waiting>0)return
   await sleep(50)
  }
  assert.fail(`fixture process did not reach sleep: ${app}`)
 }
 // A transaction holds the account row while B tries SKIP LOCKED. B must not
 // wait for A and must not acquire a second lease on the same account.
 const first=psql(`begin;${command('claim',null,{workerId:worker1})} select pg_sleep(2);commit;`,{app:'atlas-trading-lock-a'})
 await waitSleep('atlas-trading-lock-a')
 assert.equal(await result(command('claim',null,{workerId:worker2})),null)
 const claimed=JSON.parse((await first).split(/\r?\n/).find(Boolean)),lease=claimed.lease
 assert.equal(claimed.sessions.length,2);assert.equal(lease.epoch,1)
 const prepare=run=>command('prepare_intent',null,{lease,sessionId:run.id,actionKey:'concurrent-entry',side:'buy',kind:'entry',quantity:1,price:500,cashAvailable:1000,cashReservation:600})
 const reserved=await Promise.allSettled(runs.map(run=>result(prepare(run))))
 assert.equal(reserved.filter(item=>item.status==='fulfilled').length,1)
 assert.match(reserved.find(item=>item.status==='rejected').reason.message,/trading_insufficient_cash/)
 const intent=reserved.find(item=>item.status==='fulfilled').value.intent
 // B's competing dispatch waits for A's account transaction. A commits one
 // sending state, then is killed before it could report a broker outcome.
 const crash=psql(`begin;${command('dispatch_intent',null,{lease,intentId:intent.id})}select pg_sleep(1);commit;select pg_sleep(30);`,{app:'atlas-trading-crash'}).catch(error=>error)
 await waitSleep('atlas-trading-crash')
 assert.equal((await result(command('dispatch_intent',null,{lease,intentId:intent.id}))).dispatch,false)
 await psql("select pg_terminate_backend(pid) from pg_stat_activity where application_name='atlas-trading-crash';")
 const crashed=await crash;assert.ok(crashed instanceof Error)
 assert.equal(JSON.parse(crashed.stdout.split(/\r?\n/).find(Boolean)).dispatch,true)
 await psql("update public.trading_v1_accounts set lease_expires_at=clock_timestamp()-interval '1 second';")
 const replacement=await result(command('claim',null,{workerId:worker2}))
 assert.equal(replacement.lease.epoch,2);assert.equal(replacement.intents[0].status,'sending')
 await assert.rejects(result(command('dispatch_intent',null,{lease,intentId:intent.id})),/trading_lease_lost/)
 await assert.rejects(result(command('write_gate',null,{lease,intentId:intent.id})),/trading_lease_lost/)
 assert.equal((await result(command('dispatch_intent',null,{lease:replacement.lease,intentId:intent.id}))).dispatch,false)
 const run=runs.find(row=>row.id===intent.session_id)
 await result(command('stop',a,{sessionId:run.id,expectedRevision:run.revision}))
 const gate=await result(command('write_gate',null,{lease:replacement.lease,intentId:intent.id}))
 assert.equal(gate.allowed,false);assert.equal(gate.unknown,false)
 const detail=await result(command('session',a,{sessionId:run.id}))
 assert.equal(detail.intents[0].status,'rejected');assert.equal(Number(detail.intents[0].cash_reservation),0)
 // Column-level permissions must not permit bypassing RPC reservation limits.
 await assert.rejects(psql('set role service_role;update public.trading_v1_intents set cash_reservation=0;'),/permission denied/)
 await assert.rejects(psql(`set role authenticated;${command('context',a,{})}`),/permission denied/)
 assert.equal((await result(command('context',a,{}))).sessions.length,2)
})
