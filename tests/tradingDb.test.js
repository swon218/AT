import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import {createTradingEngine,initialTradingState} from '../server/tradingEngine.js'

const sql=await readFile(new URL('../deploy/TRADING_AGENT_V1_SUPABASE.sql',import.meta.url),'utf8')
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222'
const strategyId='33333333-3333-4333-8333-333333333333',otherStrategy='44444444-4444-4444-8444-444444444444'
const worker1='55555555-5555-4555-8555-555555555555',worker2='66666666-6666-4666-8666-666666666666'
const request1='77777777-7777-4777-8777-777777777777',request2='88888888-8888-4888-8888-888888888888'
const spec=(code='005930',extra={})=>({code,broker:'kiwoom',accountRef:'a'.repeat(32),strategyId,strategyRevision:1,quantityMode:'fixed',quantity:2,entryAction:'once',...extra})
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 insert into auth.users values('${a}'),('${b}');
 alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
 grant usage on schema public to anon,authenticated,service_role;`)
 for(const file of ['WATCHLIST_SUPABASE.sql','STRATEGIES_SUPABASE.sql','BACKTEST_STRATEGIES_V2_SUPABASE.sql'])await db.exec(await readFile(new URL(`../deploy/${file}`,import.meta.url),'utf8'))
 await db.exec(`insert into public.watchlist_items(user_id,code,name,slot) values('${a}','005930','삼성전자',1),('${a}','000660','SK하이닉스',2),('${b}','035420','NAVER',1);
 insert into public.strategies(id,user_id,name,indicators,backtest_settings,schema_version) values
 ('${strategyId}','${a}','위험 관리','[]','{"entryMode":"all","entryConditions":[],"takeProfitPct":10,"stopLossPct":5}',2),
 ('${otherStrategy}','${b}','다른 회원','[]','{"entryMode":"all","entryConditions":[],"takeProfitPct":10,"stopLossPct":5}',2);`)
 await db.exec(sql)
 const call=async(action,actor=null,p={})=>(await db.query('select public.atlas_trading_rpc($1,$2,$3::jsonb) result',[action,actor,JSON.stringify(p)])).rows[0].result
 const save=async(value=spec(),expectedRevision=0)=>call('save_config',a,{expectedRevision,spec:value})
 const preview=async(config,extra={})=>call('preview_start',a,{configId:config.id,configRevision:config.revision,mode:'PAPER',credentialVersion:'f'.repeat(64),initialState:{position:{quantity:0,entryNotional:0,averagePrice:0}},accountLabel:'API 연결 계좌',...extra})
 const start=async(config,requestId=request1)=>{const v=await preview(config);return call('start',a,{previewId:v.id,requestId,confirmed:true})}
 return {db,call,save,preview,start}
}

test('trading SQL owner access, service-only RPC, immutable snapshots and repeat application preserve data',async t=>{
 const {db,call,save,preview}=await fixture(t)
 await assert.rejects(call('context',null),/trading_auth_required/)
 await assert.rejects(call('claim',a,{workerId:worker1}),/trading_worker_only/)
 const c=await save();assert.equal(c.revision,1)
 await assert.rejects(call('save_config',a,{expectedRevision:0,spec:spec('999999')}),/trading_watchlist_required/)
 await assert.rejects(call('save_config',b,{expectedRevision:0,spec:spec()}),/trading_watchlist_required/)
 await assert.rejects(call('save_config',a,{expectedRevision:0,spec:spec('000660',{strategyId:otherStrategy})}),/trading_strategy_conflict/)
 await assert.rejects(call('save_config',a,{expectedRevision:0,spec:spec('000660',{quantity:undefined})}),/trading_invalid_config/)
 await assert.rejects(call('save_config',a,{expectedRevision:0,spec:spec('000660',{entryAction:'signal'})}),/trading_entry_action/)
 await assert.rejects(call('save_config',a,{expectedRevision:0,spec:spec('000660',{entryAction:'manage'})}),/trading_invalid_config/)
 const v=await preview(c)
 const readable=await call('preview_read',a,{previewId:v.id});assert.deepEqual(readable.spec,spec())
 await assert.rejects(call('preview_read',b,{previewId:v.id}),/trading_not_found/)
 const run=await call('start',a,{previewId:v.id,requestId:request1,confirmed:true})
 assert.equal((await call('start_read',a,{requestId:request1})).id,run.id)
 assert.equal(await call('start_read',b,{requestId:request1}),null)
 assert.equal(run.state.priority,2)
 assert.equal(run.snapshot.strategy.name,'위험 관리')
 assert.deepEqual(await call('start',a,{previewId:v.id,requestId:request1,confirmed:true}),run)
 await assert.rejects(call('start',a,{previewId:v.id,requestId:request2,confirmed:true}),/trading_confirmation_expired/)
 const v2=await preview(c)
 await assert.rejects(call('start',a,{previewId:v2.id,requestId:request2,confirmed:true}),/trading_run_active/)
 await assert.rejects(call('session',b,{sessionId:run.id}),/trading_not_found/)
 assert.deepEqual((await call('context',b)).sessions,[])
 await db.exec(`update public.strategies set name='새 전략 이름' where id='${strategyId}'`)
 assert.equal((await call('session',a,{sessionId:run.id})).session.snapshot.strategy.name,'위험 관리')
 await assert.rejects(preview(c),/trading_strategy_conflict/)
 await db.exec('grant select(code),update(spec),insert(owner_id,code,spec) on public.trading_v1_configs to anon,authenticated,service_role')
 await db.exec(sql)
 assert.equal((await call('context',a)).sessions.length,1)
 const grants=(await db.query(`select has_function_privilege('anon','public.atlas_trading_rpc(text,uuid,jsonb)','execute') anon,has_function_privilege('authenticated','public.atlas_trading_rpc(text,uuid,jsonb)','execute') member,has_function_privilege('service_role','public.atlas_trading_rpc(text,uuid,jsonb)','execute') service`)).rows[0]
 assert.deepEqual(grants,{anon:false,member:false,service:true})
 for(const role of ['anon','authenticated','service_role']){
  await db.exec(`set role ${role}`)
  if(role==='service_role')assert.equal((await call('marker')).version,'atlas-trading-v1')
  else await assert.rejects(call('context',a),{code:'42501'})
  for(const table of ['configs','accounts','previews','sessions','intents','fills','events']){
   await assert.rejects(db.exec(`select * from public.trading_v1_${table}`),{code:'42501'})
   await assert.rejects(db.exec(`delete from public.trading_v1_${table}`),{code:'42501'})
  }
  await assert.rejects(db.exec('select code from public.trading_v1_configs'),{code:'42501'})
  await assert.rejects(db.exec("update public.trading_v1_configs set spec='{}'"),{code:'42501'})
  await assert.rejects(db.exec(`insert into public.trading_v1_configs(owner_id,code,spec) values('${a}','123456','{}')`),{code:'42501'})
  await db.exec('reset role')
 }
})

test('account lease fencing, same-account cash reservations and dispatch are durable across worker replacement',async t=>{
 const {db,call,save,start}=await fixture(t)
 const c1=await save(),c2=await save(spec('000660'))
 const s1=await start(c1),s2=await start(c2,request2)
 const claims=await Promise.all([call('claim',null,{workerId:worker1}),call('claim',null,{workerId:worker2})])
 assert.equal(claims.filter(Boolean).length,1)
 const {lease}=claims.find(Boolean);assert.equal(lease.epoch,1);assert.equal(claims.find(Boolean).sessions.length,2)
 const prepare=(sessionId,actionKey,cashReservation=600)=>call('prepare_intent',null,{lease,sessionId,actionKey,side:'buy',kind:'entry',quantity:2,price:200,cashAvailable:1000,cashReservation})
 const first=await prepare(s1.id,'entry-20261116');assert.equal(first.created,true)
 const duplicate=await prepare(s1.id,'entry-20261116');assert.equal(duplicate.created,false);assert.equal(duplicate.intent.id,first.intent.id)
 await assert.rejects(prepare(s2.id,'entry-20261116'),/trading_insufficient_cash/)
 const dispatched=await call('dispatch_intent',null,{lease,intentId:first.intent.id});assert.equal(dispatched.dispatch,true)
 assert.equal((await call('dispatch_intent',null,{lease,intentId:first.intent.id})).dispatch,false)
 await call('settle_intent',null,{lease,intentId:first.intent.id,status:'unknown',cashReflected:true})
 await assert.rejects(prepare(s2.id,'another',200),/trading_account_uncertain/)
 assert.equal((await call('session',a,{sessionId:s1.id})).intents[0].cash_reservation,600)
 await db.exec(`update public.trading_v1_accounts set lease_expires_at=clock_timestamp()-interval '1 second'`)
 const replacement=await call('claim',null,{workerId:worker2});assert.equal(replacement.lease.epoch,2)
 assert.equal(replacement.intents[0].id,first.intent.id)
 for(const action of ['renew','release','dispatch_intent'])await assert.rejects(call(action,null,{lease,intentId:first.intent.id}),/trading_lease_lost/)
 assert.equal((await call('dispatch_intent',null,{lease:replacement.lease,intentId:first.intent.id})).dispatch,false)
 await call('settle_intent',null,{lease:replacement.lease,intentId:first.intent.id,status:'accepted',brokerOrderId:'private-order',cashReflected:true})
 assert.equal((await call('session',a,{sessionId:s1.id})).intents[0].cash_reservation,0)
 const second=await call('prepare_intent',null,{lease:replacement.lease,sessionId:s2.id,actionKey:'second',side:'buy',kind:'entry',quantity:2,price:200,cashAvailable:400,cashReservation:400})
 assert.equal(second.created,true)
 await call('release',null,{lease:replacement.lease})
 await assert.rejects(call('renew',null,{lease:{...replacement.lease,token:null}}),/trading_lease_lost/)
 await assert.rejects(call('renew',null,{lease:{...replacement.lease,token:replacement.lease.token}}),/trading_lease_lost/)
})

test('monotonic fills, duplicate/reversed events, cancel-fill race and concurrent stop preserve executed ownership',async t=>{
 const {call,save,start}=await fixture(t),run=await start(await save())
 const {lease}=await call('claim',null,{workerId:worker1})
 const {intent}=await call('prepare_intent',null,{lease,sessionId:run.id,actionKey:'entry',side:'buy',kind:'entry',quantity:3,price:200,cashAvailable:1000,cashReservation:630})
 await call('dispatch_intent',null,{lease,intentId:intent.id})
 const fill={key:'fill-1',quantity:1,price:190,at:'2026-11-16T00:01:00Z'}
 const settled=await call('settle_intent',null,{lease,intentId:intent.id,status:'partial',brokerOrderId:'owned-order',cumulativeQuantity:1,cumulativeNotional:190,fills:[fill]})
 assert.equal(settled.intent.cumulative_quantity,1)
 await call('settle_intent',null,{lease,intentId:intent.id,status:'partial',cumulativeQuantity:1,cumulativeNotional:190,fills:[fill]})
 assert.equal((await call('session',a,{sessionId:run.id})).fills.length,1)
 assert.equal((await call('settle_intent',null,{lease,intentId:intent.id,status:'accepted',cumulativeQuantity:0,cumulativeNotional:0})).ignored,true)
 await assert.rejects(call('settle_intent',null,{lease,intentId:intent.id,status:'partial',cumulativeQuantity:1,cumulativeNotional:200}),/trading_fill_conflict/)
 await assert.rejects(call('settle_intent',null,{lease,intentId:intent.id,status:'partial',brokerOrderId:'external-order'}),/trading_order_conflict/)
 await call('settle_intent',null,{lease,intentId:intent.id,status:'cancelled',cumulativeQuantity:1,cumulativeNotional:190})
 const late=await call('settle_intent',null,{lease,intentId:intent.id,status:'partial',cumulativeQuantity:2,cumulativeNotional:390,fills:[{key:'fill-2',quantity:1,price:200,at:'2026-11-16T00:01:01Z'}]})
 assert.equal(late.intent.status,'cancelled');assert.equal(late.intent.cumulative_quantity,2)
 // Terminal intents are included after a crash between settle and state commit.
 await call('release',null,{lease})
 const recovered=await call('claim',null,{workerId:worker2});assert.equal(recovered.intents[0].cumulative_quantity,2)
 const updated=await call('commit',null,{lease:recovered.lease,sessionId:run.id,expectedRevision:run.revision,status:'holding',state:{position:{quantity:2,entryNotional:390,averagePrice:195}},events:[{code:'partial_fill',data:{quantity:2}}]})
 const stopped=await call('stop',a,{sessionId:run.id,expectedRevision:updated.revision,abandon:false});assert.equal(stopped.status,'stopping')
 await assert.rejects(call('commit',null,{lease:recovered.lease,sessionId:run.id,expectedRevision:updated.revision,status:'holding',state:{position:{quantity:2}}}),/trading_revision_conflict/)
 const committed=await call('commit',null,{lease:recovered.lease,sessionId:run.id,expectedRevision:stopped.revision,status:'holding',state:{position:{quantity:2}}})
 assert.equal(committed.stop_requested,true);assert.equal(committed.status,'stopping')
 await assert.rejects(call('prepare_intent',null,{lease:recovered.lease,sessionId:run.id,actionKey:'another-buy',side:'buy',kind:'entry',quantity:1,price:200,cashAvailable:1000,cashReservation:210}),/trading_entry_blocked/)
 await assert.rejects(call('stop',b,{sessionId:run.id,expectedRevision:committed.revision}),/trading_not_found/)
})

test('watchlist removal blocks prepared entry dispatch, flat stop is immediate and PAPER/LIVE scopes remain separate',async t=>{
 const {db,call,save,preview,start}=await fixture(t),c=await save(),paper=await start(c)
 const livePreview=await preview(c,{mode:'LIVE'}),live=await call('start',a,{previewId:livePreview.id,requestId:request2,confirmed:true})
 assert.equal(live.mode,'LIVE');assert.notEqual(live.account_key,paper.account_key)
 const {lease}=await call('claim',null,{workerId:worker1})
 const managedRun=lease.mode==='PAPER'?paper:live
 const {intent}=await call('prepare_intent',null,{lease,sessionId:managedRun.id,actionKey:'opening',side:'buy',kind:'entry',quantity:1,price:200,cashAvailable:1000,cashReservation:210})
 await db.exec(`delete from public.watchlist_items where user_id='${a}' and code='005930'`)
 const blocked=await call('dispatch_intent',null,{lease,intentId:intent.id});assert.equal(blocked.dispatch,false);assert.equal(blocked.intent.status,'rejected');assert.equal(blocked.intent.cash_reservation,0)
 const other=lease.mode==='PAPER'?live:paper
 const stopped=await call('stop',a,{sessionId:other.id,expectedRevision:other.revision});assert.equal(stopped.status,'stopped')
 await assert.rejects(preview(c),/trading_watchlist_required/)
})

test('actual engine and SQL recover durable fills, complete owned-only TP trade and never duplicate a broker dispatch',async t=>{
 const {call,save,preview}=await fixture(t),c=await save()
 const v=await preview(c,{mode:'LIVE',initialState:initialTradingState()})
 const run=await call('start',a,{previewId:v.id,requestId:request1,confirmed:true})
 let clock=Date.parse('2026-11-16T00:00:10Z'),holding=0,mark=100
 const submitted=[],facts=new Map()
 const context=()=>({accountRef:spec().accountRef,credentialVersion:'f'.repeat(64),cashAvailable:10000,holdingQuantity:holding,sellableQuantity:holding,openOrders:[],complete:true,eligible:true})
 const gateway={
  async inspect(){return context()},
  async quote(){return {symbol:'005930',price:mark,exchange:'KRX',fresh:true,halted:false,observedAt:new Date(clock).toISOString()}},
  async submit({intent,beforeWrite}){assert.equal((await beforeWrite()).allowed,true);submitted.push(intent);return {status:'accepted',orderNumber:`private-${intent.id}`}},
  async cancel(){assert.fail('no cancellation expected')},
  async reconcile({intents}){return {complete:true,holdingQuantity:holding,openOrders:[],orders:intents.map(intent=>({intentId:intent.id,orderNumber:intent.orderNumber,status:'filled',filledQuantity:Number(intent.quantity),filledNotional:facts.get(intent.id),executions:[{id:`fill-${intent.id}`,quantity:Number(intent.quantity),price:facts.get(intent.id)/Number(intent.quantity),time:new Date(clock).toISOString()}]}))}},
 }
 const engine=createTradingEngine({store:{call},gateway,calendar:async()=>({date:'2026-11-16',previous:'2026-11-13',open:'2026-11-16T00:00:00Z',close:'2026-11-16T06:30:00Z'}),readDaily:async()=>assert.fail('risk-only does not read daily signals'),loadAccount:async()=>({user:{id:a}}),credentialVersionFor:()=> 'f'.repeat(64),flags:()=>({workerEnabled:true,liveEnabled:true,paperEnabled:false}),now:()=>clock,workerId:worker1})
 await engine.tick();assert.equal(submitted.length,1);assert.equal(submitted[0].side,'buy')
 holding=2;facts.set(submitted[0].id,200);clock+=1000
 await engine.tick()
 let detail=await call('session',a,{sessionId:run.id})
 assert.equal(detail.session.status,'holding');assert.equal(detail.session.state.position.quantity,2);assert.equal(detail.session.state.position.averagePrice,100)
 assert.equal(detail.fills.length,1)
 // A second engine instance reloads terminal buy intent and applies no duplicate delta.
 const restarted=createTradingEngine({store:{call},gateway,calendar:async()=>({date:'2026-11-16',previous:'2026-11-13',open:'2026-11-16T00:00:00Z',close:'2026-11-16T06:30:00Z'}),readDaily:async()=>[],loadAccount:async()=>({user:{id:a}}),credentialVersionFor:()=> 'f'.repeat(64),flags:()=>({workerEnabled:true,liveEnabled:true}),now:()=>clock,workerId:worker2})
 mark=111;clock+=1000
 await restarted.tick();assert.equal(submitted.length,2);assert.equal(submitted[1].side,'sell')
 holding=0;facts.set(submitted[1].id,222);clock+=1000
 await restarted.tick()
 detail=await call('session',a,{sessionId:run.id})
 assert.equal(detail.session.status,'closed');assert.equal(detail.session.state.position,null);assert.equal(detail.session.state.closedTrades.length,1);assert.equal(detail.session.state.closedTrades[0].pnl,22)
 await restarted.tick()
 detail=await call('session',a,{sessionId:run.id})
 assert.equal(detail.session.status,'completed');assert.equal(submitted.length,2);assert.equal(detail.fills.length,2)
 assert.equal(detail.intents.filter(i=>i.status==='filled').length,2)
 assert.ok(detail.intents.every(i=>i.write_granted_at!==null))
})

test('stale configuration and expired confirmations fail, active runs stay visible beyond bounded history and active fanout is capped',async t=>{
 const {db,call,save,preview,start}=await fixture(t)
 const old=await save(),current=await save(spec('005930',{quantity:3}),old.revision)
 assert.equal(current.revision,2)
 await assert.rejects(save(spec('005930',{quantity:4}),old.revision),/trading_revision_conflict/)
 await assert.rejects(preview(old),/trading_revision_conflict/)
 const expired=await preview(current)
 await db.query("update public.trading_v1_previews set expires_at=clock_timestamp()-interval '1 second' where id=$1",[expired.id])
 await assert.rejects(call('start',a,{previewId:expired.id,requestId:request1,confirmed:true}),/trading_confirmation_expired/)
 const active=await start(current),second=await save(spec('000660'))
 await db.query("update public.trading_v1_sessions set created_at='2000-01-01' where id=$1",[active.id])
 await db.query(`insert into public.trading_v1_sessions(owner_id,config_id,account_key,broker,account_ref,code,mode,request_id,snapshot,state,status)
  select owner_id,config_id,account_key,broker,account_ref,lpad(n::text,6,'0'),mode,gen_random_uuid(),snapshot,'{}','completed'
  from public.trading_v1_sessions cross join generate_series(100,304) n where id=$1`,[active.id])
 const context=await call('context',a)
 assert.equal(context.sessions.length,201)
 assert.equal(context.sessions.filter(row=>row.id===active.id).length,1)
 await db.query(`insert into public.trading_v1_sessions(owner_id,config_id,account_key,broker,account_ref,code,mode,request_id,snapshot,state,status)
  select owner_id,config_id,account_key,broker,account_ref,lpad(n::text,6,'0'),mode,gen_random_uuid(),snapshot,'{}','waiting_signal'
  from public.trading_v1_sessions cross join generate_series(400,418) n where id=$1`,[active.id])
 await assert.rejects(start(second,request2),/trading_run_limit/)
 assert.equal((await call('context',a)).sessions.filter(row=>row.status==='waiting_signal').length,20)
})

test('stop after terminal fill but before position commit keeps recovery active and cannot lose the filled shares',async t=>{
 const {call,save,start}=await fixture(t),run=await start(await save())
 const {lease}=await call('claim',null,{workerId:worker1})
 const {intent}=await call('prepare_intent',null,{lease,sessionId:run.id,actionKey:'crash-fill',side:'buy',kind:'entry',quantity:1,price:200,cashAvailable:1000,cashReservation:210})
 await call('dispatch_intent',null,{lease,intentId:intent.id})
 await call('settle_intent',null,{lease,intentId:intent.id,status:'filled',brokerOrderId:'private-owned',cumulativeQuantity:1,cumulativeNotional:200})
 // Simulate the exact crash boundary: durable fill exists; position JSON is old.
 const stop=await call('stop',a,{sessionId:run.id,expectedRevision:run.revision})
 assert.equal(stop.status,'stopping')
 await assert.rejects(call('commit',null,{lease,sessionId:run.id,expectedRevision:stop.revision,status:'stopped',state:{position:null}}),/trading_unresolved_intent/)
 await call('release',null,{lease})
 const recovered=await call('claim',null,{workerId:worker2})
 assert.equal(recovered.sessions[0].id,run.id);assert.equal(recovered.intents[0].cumulative_quantity,1)
 const maintained=await call('commit',null,{lease:recovered.lease,sessionId:run.id,expectedRevision:stop.revision,status:'holding',state:{position:{quantity:1,averagePrice:200},intentProgress:{[intent.id]:{quantity:1,notionalMicros:'200000000'}}}})
 assert.equal(maintained.status,'stopping');assert.equal(maintained.state.position.quantity,1)
})

test('immediate write gate fences expired leases, blocks stop-after-dispatch and consumes an HTTP permit once',async t=>{
 const {db,call,save,start}=await fixture(t),run=await start(await save())
 const {lease}=await call('claim',null,{workerId:worker1})
 const makeIntent=async(actionKey,side='buy',kind='entry')=>{
  const {intent}=await call('prepare_intent',null,{lease,sessionId:run.id,actionKey,side,kind,quantity:1,price:side==='buy'?200:0,cashAvailable:1000,cashReservation:side==='buy'?210:0})
  await call('dispatch_intent',null,{lease,intentId:intent.id});return intent
 }
 const first=await makeIntent('expired-before-http')
 await db.exec("update public.trading_v1_accounts set lease_expires_at=clock_timestamp()-interval '1 second'")
 await assert.rejects(call('write_gate',null,{lease,intentId:first.id}),/trading_lease_lost/)
 let detail=await call('session',a,{sessionId:run.id})
 assert.equal(detail.intents[0].write_granted_at,null);assert.equal(detail.intents[0].status,'sending')
 const replacement=await call('claim',null,{workerId:worker2})
 // No network request was made in this fixture. A verified reconciliation may
 // reject it before preparing another action; the real worker never resends it.
 await call('settle_intent',null,{lease:replacement.lease,intentId:first.id,status:'rejected'})
 const p={lease:replacement.lease,sessionId:run.id,actionKey:'stop-before-http',side:'buy',kind:'entry',quantity:1,price:200,cashAvailable:1000,cashReservation:210}
 const second=(await call('prepare_intent',null,p)).intent
 await call('dispatch_intent',null,{lease:replacement.lease,intentId:second.id})
 const stopped=await call('stop',a,{sessionId:run.id,expectedRevision:run.revision})
 assert.equal(stopped.status,'stopping')
 assert.deepEqual(await call('write_gate',null,{lease:replacement.lease,intentId:second.id}),{allowed:false,unknown:false,reason:'not_transmitted'})
 detail=await call('session',a,{sessionId:run.id})
 const rejected=detail.intents.find(i=>i.id===second.id)
 assert.equal(rejected.status,'rejected');assert.equal(rejected.cash_reservation,0);assert.equal(rejected.metadata.notTransmitted,true)
 // A stop request keeps the owned position protected; it is not a liquidation
 // request or permission to cancel somebody else's orders.
 const exit=(await call('prepare_intent',null,{lease:replacement.lease,sessionId:run.id,actionKey:'protected-exit',side:'sell',kind:'stop_loss',quantity:1,price:0,cashAvailable:0,cashReservation:0})).intent
 await call('dispatch_intent',null,{lease:replacement.lease,intentId:exit.id})
 assert.deepEqual(await call('write_gate',null,{lease:replacement.lease,intentId:exit.id}),{allowed:true})
 const duplicate=await call('write_gate',null,{lease:replacement.lease,intentId:exit.id})
 assert.equal(duplicate.allowed,false);assert.equal(duplicate.unknown,true)
 detail=await call('session',a,{sessionId:run.id})
 assert.equal(detail.intents.find(i=>i.id===exit.id).status,'sending')
})
