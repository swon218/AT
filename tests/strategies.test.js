import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { INDICATOR_CATALOG, createIndicatorConfig } from '../src/utils/indicators.js'
import { DEFAULT_BACKTEST } from '../src/utils/backtest.js'
import { createStrategyRepository, loadStrategy, strategyPayload, strategyError, STRATEGY_CONFLICT } from '../src/services/strategyRepository.js'

const condition = {indicatorId:'ma',enabled:true,left:'short',operator:'crossUp',right:{type:'series',field:'long'}}
const input = () => ({name:'이동평균 전략',indicators:[createIndicatorConfig('ma')],backtest_settings:{...DEFAULT_BACKTEST,entryConditions:[structuredClone(condition)],takeProfitPct:5,stopLossPct:2}})
const legacy = () => ({name:'이전 전략',indicators:[createIndicatorConfig('ma')],schema_version:1,backtest_settings:{initialCapital:10000000,feePct:0.1,taxPct:0.2,slippagePct:0.05,entryMode:'all',exitMode:'any',entry:['ma-up','ma-cross-up'],exit:['ma-cross-down']}})

test('definition stores v2 and strips all workspace, cost and unrelated input',()=>{
  const data=input();data.name='  이동평균 전략  ';data.indicators[0].shortPeriod='9';data.indicators[0].shortColor='#123abc';data.indicators[0].secret='do not retain'
  Object.assign(data.backtest_settings,{symbol:'005930',start:'2021-01-01',end:'2026-01-01',initialQuantity:99,quantityMode:'reinvest',initialCapital:1000,feePct:5,taxPct:5,slippagePct:5,exit:['ma-down'],token:'do not retain'})
  const payload=strategyPayload(data)
  assert.equal(payload.schema_version,2);assert.equal(payload.name,'이동평균 전략');assert.equal(payload.indicators[0].shortPeriod,9);assert.equal(payload.indicators[0].shortColor,'#123abc')
  assert.deepEqual(Object.keys(payload.backtest_settings).sort(),['entryConditions','entryMode','stopLossPct','takeProfitPct'])
  assert(!JSON.stringify(payload).includes('do not retain'));assert.deepEqual(strategyPayload(payload),payload)
})

test('named indicator-only, risk-only and one-sided risk strategies save without claiming executable completeness',()=>{
  assert.doesNotThrow(()=>strategyPayload({name:'참고 지표',indicators:[createIndicatorConfig('rsi')]}))
  assert.doesNotThrow(()=>strategyPayload({name:'익절만',indicators:[],backtest_settings:{takeProfitPct:5}}))
  assert.doesNotThrow(()=>strategyPayload({name:'손절만',indicators:[],backtest_settings:{stopLossPct:2}}))
  assert.throws(()=>strategyPayload({name:'빈 전략',indicators:[]}),/하나 이상/)
  for(const patch of [{name:''},{name:'x'.repeat(101)},{indicators:[createIndicatorConfig('unknown')]},{indicators:[createIndicatorConfig('ma'),createIndicatorConfig('ma')]},{indicators:[{...createIndicatorConfig('ma'),shortPeriod:30}]},{indicators:[{...createIndicatorConfig('ma'),shortColor:'javascript:bad'}]},{backtest_settings:{entryMode:'bad'}},{backtest_settings:{takeProfitPct:0}},{backtest_settings:{takeProfitPct:-1}},{backtest_settings:{stopLossPct:100}}]) assert.throws(()=>strategyPayload({...input(),...patch}))
})

test('orphan, malformed and incompatible-unit references are rejected before writes',()=>{
  for(const c of [{...condition,indicatorId:'rsi'},{...condition,left:'unknown'},{...condition,operator:'bad'},{...condition,right:{type:'series',field:'volume',indicatorId:'volume-ma'}},{...condition,right:{type:'constant',value:''}}]) assert.throws(()=>strategyPayload({...input(),backtest_settings:{entryConditions:[c]}}))
})

test('v1 migration preserves interpretation, old exit and cost metadata but never invents a risk rule',()=>{
  const old=legacy(),snapshot=JSON.stringify(old),loaded=loadStrategy(old)
  assert.equal(JSON.stringify(old),snapshot);assert.equal(loaded.schema_version,2)
  assert.deepEqual(loaded.backtest_settings.entryConditions.map(c=>c.operator),['gt','crossUp'])
  assert.equal(loaded.backtest_settings.takeProfitPct,'');assert.equal(loaded.backtest_settings.stopLossPct,'')
  assert.deepEqual(loaded.backtest_settings.legacy.exit,['ma-cross-down']);assert.equal(loaded.backtest_settings.legacy.initialCapital,10000000)
  assert(!('initialCapital' in loaded.backtest_settings));assert(!('exit' in loaded.backtest_settings));assert.deepEqual(strategyPayload(loaded),loaded)
})

function mockClient(userId='owner',result={data:[],error:null}){
  const calls=[];const chain=new Proxy({},{get:(_,key)=>key==='then'?(resolve,reject)=>Promise.resolve(result).then(resolve,reject):(...args)=>{calls.push([key,...args]);return chain}})
  return {calls,auth:{getSession:async()=>({data:{session:userId?{user:{id:userId}}:null},error:null})},from:table=>{calls.push(['from',table]);return chain}}
}

test('repository authenticates before requests and scopes all mutations to owner and revision',async()=>{
  const wrong=mockClient('different'),repo=createStrategyRepository(wrong)
  await assert.rejects(repo.list('owner'),/로그인 정보/);await assert.rejects(repo.save('owner',input()),/로그인 정보/);await assert.rejects(repo.remove('owner',{id:'one',revision:1}),/로그인 정보/);assert.equal(wrong.calls.length,0)
  const client=mockClient('owner',{data:null,error:null}),own=createStrategyRepository(client)
  await assert.rejects(own.save('owner',input(),{id:'one',revision:3}),{message:STRATEGY_CONFLICT})
  assert(client.calls.some(c=>JSON.stringify(c)===JSON.stringify(['eq','user_id','owner'])));assert(client.calls.some(c=>JSON.stringify(c)===JSON.stringify(['eq','revision',3])))
  await assert.rejects(own.remove('owner',{id:'one',revision:3}),{message:STRATEGY_CONFLICT})
})

test('safe repository errors distinguish missing migration, conflicts and duplicate names',()=>{
  assert.match(strategyError({code:'PGRST205'}),/SQL/);assert.match(strategyError({code:'23514'}),/SQL/);assert.match(strategyError({code:'23505'}),/같은 이름/);assert(!strategyError({message:'secret'}).includes('secret'))
})

test('PostgreSQL migration preserves old rows and enforces v2 partial strategy, references, ownership and revisions',async t=>{
  const db=new PGlite();t.after(()=>db.close())
  const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema public,auth to authenticated,anon;insert into auth.users values ('${A}'),('${B}');`)
  const baseline=await readFile(new URL('../deploy/STRATEGIES_SUPABASE.sql',import.meta.url),'utf8'),migration=await readFile(new URL('../deploy/BACKTEST_STRATEGIES_V2_SUPABASE.sql',import.meta.url),'utf8')
  await db.exec(baseline)
  const as=async id=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id])}
  const insert=(owner,p)=>db.query('insert into public.strategies(user_id,name,indicators,backtest_settings,schema_version) values($1,$2,$3,$4,$5) returning *',[owner,p.name,JSON.stringify(p.indicators),JSON.stringify(p.backtest_settings),p.schema_version])
  await as(A);const old=(await insert(A,legacy())).rows[0]
  await db.exec('reset role');await db.exec(migration);await db.exec(migration)
  const after=(await db.query('select * from public.strategies where id=$1',[old.id])).rows[0]
  assert.deepEqual(after,old)
  await as(A)
  const row=(await insert(A,strategyPayload(input()))).rows[0];assert.equal(row.revision,1);assert.equal(row.schema_version,2)
  await insert(A,strategyPayload({name:'익절 부분',indicators:[],backtest_settings:{takeProfitPct:5}}))
  await insert(A,strategyPayload({name:'지표 부분',indicators:[createIndicatorConfig('rsi')]}))
  const all=strategyPayload({name:'모든 지표',indicators:INDICATOR_CATALOG.map(c=>createIndicatorConfig(c.id))});await insert(A,all)
  await t.test('database refuses malformed/empty definitions and broken indicator references even bypassing the browser',async()=>{
    for(const settings of [{entryMode:'all',entryConditions:[],takeProfitPct:'',stopLossPct:''},{entryMode:null,entryConditions:[],takeProfitPct:5,stopLossPct:''},{entryMode:'all',entryConditions:[],takeProfitPct:0,stopLossPct:''},{entryMode:'all',entryConditions:[condition],takeProfitPct:5,stopLossPct:2},{entryMode:'all',entryConditions:[],takeProfitPct:5,stopLossPct:'',initialQuantity:1}]) await assert.rejects(insert(A,{name:'Invalid',indicators:[],backtest_settings:settings,schema_version:2}),/check constraint/)
    for(const c of [{...condition,operator:null},{...condition,right:{type:'series',field:'volume',indicatorId:'volume-ma'}},{...condition,indicatorId:'missing'}]) await assert.rejects(insert(A,{...strategyPayload(input()),name:'Invalid condition',backtest_settings:{entryMode:'all',entryConditions:[c],takeProfitPct:5,stopLossPct:2}}),/check constraint/)
    await assert.rejects(insert(A,{...all,name:'13 indicators',indicators:[...all.indicators,all.indicators[0]]}),/check constraint/)
  })
  await t.test('ownership RLS, column permissions and optimistic revisions remain effective',async()=>{
    await assert.rejects(insert(B,{...strategyPayload(input()),name:'spoof'}),/row-level security/)
    await assert.rejects(db.query('update public.strategies set revision=99 where id=$1',[row.id]),/permission denied/)
    await assert.rejects(db.query('update public.strategies set user_id=$1 where id=$2',[B,row.id]),/permission denied/)
    const changed=(await db.query("update public.strategies set name='Updated' where id=$1 and revision=1 returning *",[row.id])).rows[0]
    assert.equal(changed.revision,2);assert.equal((await db.query("update public.strategies set name='stale' where id=$1 and revision=1 returning id",[row.id])).rows.length,0);assert.equal((await db.query('delete from public.strategies where id=$1 and revision=1 returning id',[row.id])).rows.length,0)
    await assert.rejects(insert(A,{...strategyPayload(input()),name:'updated'}),/unique constraint/)
    await as(B);assert.equal((await db.query('select * from public.strategies')).rows.length,0);assert.equal((await db.query("update public.strategies set name='stolen' where id=$1 returning id",[row.id])).rows.length,0);assert.equal((await db.query('delete from public.strategies where id=$1 returning id',[row.id])).rows.length,0)
    await db.exec('reset role;set role anon');await assert.rejects(db.query('select * from public.strategies'),/permission denied/);await assert.rejects(insert(A,strategyPayload(input())),/permission denied/)
  })
  await t.test('old frontend writes remain allowed and account deletion still cascades without changing other users',async()=>{
    await as(B);await insert(B,legacy());await db.exec('reset role');await db.query('delete from auth.users where id=$1',[A]);assert.equal((await db.query('select * from public.strategies')).rows.length,1)
  })
})
