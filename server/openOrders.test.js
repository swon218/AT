import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import Fastify from 'fastify'
import {createOpenOrderBrokers,normalizeOpenOrder} from './openOrderBrokers.js'
import {createOpenOrderHandlers,registerOpenOrderRoutes,validateManagementInput} from './openOrders.js'
import {createKiwoomFlow,SLOW_ACCOUNT_TRS} from './kiwoomFlow.js'
import {accountRef,digest} from './personalBroker.js'
import proxy from '../api/order-management.js'
const user='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
const account={user:{id:user},status:Object.fromEntries(['kiwoom','toss','nh','kb'].map(b=>[`${b}Configured`,true])),credentials:{kiwoomAppKey:'key',kiwoomSecretKey:'secret',tossApiKey:'key',tossSecretKey:'secret',nhAppKey:'key',nhSecretKey:'secret',kbAppKey:'key',kbSecretKey:'secret'}}
const auth={appKey:'key',secretKey:'secret'},now=()=>Date.parse('2026-11-13T01:00:00Z')
const row={ord_no:'101',stk_cd:'A005930',stk_nm:'삼성전자',io_tp_nm:'+매수',ord_qty:'10',oso_qty:'7',cntr_qty:'3',ord_pric:'70000',trde_tp:'보통',stex_tp:'1',tm:'100000'}
const kiwoomPage=oso=>({body:{return_code:0,oso},contYn:'N',nextKey:''})
const request=(body={},broker='kiwoom')=>({headers:{authorization:'Bearer fixture'},query:{broker},body})
const settings={kiwoomOrdersEnabled:true,tossOrdersEnabled:true,kbOrdersEnabled:true,nhOrdersEnabled:true}
const inputFor=(data,extra={})=>({id:data.items[0].id,scope:data.items[0].scope,version:data.items[0].version,accountScope:data.accountScope,accountRef:data.items[0].accountRef,requestId:'fixture_request_0001',action:'amend',quantity:5,price:71000,...extra})
async function database(path){
  const db=new PGlite(path)
  await db.exec('create schema auth; create table auth.users(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls;')
  await db.query('insert into auth.users values($1),($2)',[user,other])
  const sql=await readFile(new URL('../deploy/ORDER_MANAGEMENT_SUPABASE.sql',import.meta.url),'utf8')
  await db.exec(sql)
  const store={call:async(op,actor,p)=>{
    try{return(await db.query('select public.atlas_order_management_rpc($1,$2,$3::jsonb) as v',[op,actor,JSON.stringify(p)])).rows[0].v}
    catch(e){throw Object.assign(Error(/order_locked/.test(e.message)?'잠긴 주문':e.message),{code:/request_conflict/.test(e.message)?'request_conflict':/order_locked/.test(e.message)?'order_locked':'db_error',statusCode:409})}
  }}
  return {db,store,sql}
}
test('all-symbol buy/sell, partial/market, pages deduplicate; HTTP200 business failure is not empty success',async()=>{
  const calls=[]
  const brokers=createOpenOrderBrokers({now,kiwoom:async p=>{calls.push(p);return p.nextKey?kiwoomPage([row,{...row,ord_no:'102',io_tp_nm:'-매도',trde_tp:'시장가'}]):{...kiwoomPage([row]),contYn:'Y',nextKey:'next'}}})
  const data=await brokers.read('kiwoom',account)
  assert.equal(data.status,'success');assert.equal(data.items.length,2)
  assert.deepEqual([data.items[0].quantity,data.items[0].filledQuantity,data.items[0].remainingQuantity],[10,3,7])
  assert.equal(data.items[1].side,'sell');assert.equal(data.items[1].orderPrice,null);assert.equal(data.items[1].canAmend,false);assert.equal(data.items[1].canCancel,true)
  assert.equal(calls[0].body.stk_cd,'');assert.equal(calls[0].body.trde_tp,'0');assert.equal(calls[1].nextKey,'next')
  for(const response of [{body:{return_code:1}},{}])await assert.rejects(createOpenOrderBrokers({kiwoom:async()=>response}).read('kiwoom',account))
  const empty=await createOpenOrderBrokers({kiwoom:async()=>kiwoomPage([])}).read('kiwoom',account);assert.equal(empty.status,'success');assert.equal(empty.items.length,0)
  const partial=await createOpenOrderBrokers({kiwoom:async()=>({...kiwoomPage([row]),contYn:'Y',nextKey:'same'})}).read('kiwoom',account)
  assert.equal(partial.status,'partial');assert.equal(partial.reason,'page_limit')
})
test('Toss OPEN + personal metadata; partial amend restricted, whole cancel supported; NH read-only and KB adapter',async()=>{
  const calls=[],brokers=createOpenOrderBrokers({now,toss:async p=>{
    calls.push(p)
    if(p.path==='/api/v1/accounts')return {result:[{accountType:'BROKERAGE',accountSeq:123456789}]}
    if(p.path==='/api/v1/stocks')return {result:[{symbol:'005930',name:'삼성전자',securityType:'STOCK'}]}
    if(p.method==='POST')return {result:{orderId:'replacement-2'}}
    return {result:{orders:[{orderId:'original-1',symbol:'005930',currency:'KRW',side:'SELL',orderType:'LIMIT',timeInForce:'DAY',status:'PARTIAL_FILLED',quantity:'10',price:'70000',execution:{filledQuantity:'3'},orderedAt:'2026-11-13T10:00:00+09:00'}],hasNext:false}}
  },nhAccounts:async()=>[{id:'12345678901',label:'NH'}],nh:{request:async()=>({rsp_cd:'00000',rsp_msg:'조회가 완료되었습니다.',Output_0:[{itg_orr_no:100,iem_cd:'005930',iem_nm:'삼성전자',sby_dit_cd_nm:'매수',orr_qty:10,tot_cns_qty:3,ny_cns_qty:7,nmn_pr_tp_cd_nm:'보통',orr_pr:70000,cfd_lon_cd:'00',rmt_mkt_cd:'KRX'}]})},kb:{request:async(_a,code,p)=>{
    calls.push({code,p});return code==='ssqm2341'?{Record1:[{ordr_no:'101',stnd_is_no:'005930',hngl_shrt_nm:'삼성전자',trd_dl_ccd_nm:'매도',ordr_q:10,tl_ccls_q:3,nccls_q:7,ordr_uprc:70000,ordr_ccd:'00',sor_ordr_ccd:'K',gds_typ_dtls_nm:'현금',ordr_tm:'100000'}],grid_cnt1:1}:{ordr_no:'102'}
  }}})
  const t=await brokers.read('toss',account);assert.equal(t.items[0].name,'삼성전자');assert.equal(t.items[0].canAmend,false);assert.equal(t.items[0].canCancel,true)
  await brokers.submit('toss',account,t.items[0],'cancel',{quantity:7});assert.deepEqual(calls.find(v=>v.method==='POST').body,{})
  assert.equal(calls.find(v=>v.path==='/api/v1/orders').query.status,'OPEN')
  const n=await brokers.read('nh',account);assert.equal(n.status,'success');assert.equal(n.items[0].canCancel,false);assert.equal(n.items[0].orderedAt,null)
  await assert.rejects(brokers.submit('nh',account,n.items[0],'cancel',{quantity:7}))
  const k=await brokers.read('kb',account);assert.equal(k.items[0].canAmend,true)
  await brokers.submit('kb',account,k.items[0],'amend',{quantity:4,price:71000})
  assert.deepEqual(calls.at(-1),{code:'ssam1805',p:{is_cd:'005930',orgn_ordr_no:'101',crct_clsf:'1',ordr_q:'4',mkt_tm_clsf:'1',ordr_uprc:'71000',ordr_ccd:'00',sor_ordr_ccd:'K'}})
})
test('multiple own accounts need choice; foreign account refs rejected; bad rows remain partial',async()=>{
  let reads=0
  const b=createOpenOrderBrokers({nhAccounts:async()=>[{id:'11111111111',label:'NH1'},{id:'22222222222',label:'NH2'}],nh:{request:async()=>{reads++;throw Error()}}})
  const data=await b.read('nh',account)
  assert.equal(data.status,'accountRequired');assert.equal(reads,0);assert.equal(JSON.stringify(data).includes('11111111111'),false)
  assert.equal((await b.read('nh',account,'a'.repeat(32))).status,'accountRequired');assert.equal(reads,0)
  const invalid=await createOpenOrderBrokers({kiwoom:async()=>kiwoomPage([{...row,oso_qty:''}])}).read('kiwoom',account)
  assert.equal(invalid.status,'partial');assert.equal(invalid.items.length,0)
})
test('durable RPC RLS/privileges, id conflicts, process restart, per-order competing requests, unknown locks and repeated SQL preserve rows',async()=>{
  const {db,store,sql}=await database()
  try{
    const p={broker:'kiwoom',requestId:'request_example_0001',scope:digest('order'),accountScope:digest('account'),digest:digest('input'),version:digest('v1'),action:'cancel'}
    assert.equal((await store.call('reserve',user,p)).fresh,true)
    const results=await Promise.allSettled([store.call('reserve',user,p),store.call('reserve',user,{...p,requestId:'request_example_0002'})])
    assert.equal(results[0].value.fresh,false);assert.equal(results[1].status,'rejected')
    await assert.rejects(store.call('lookup',user,{...p,digest:digest('other')}),{code:'request_conflict'})
    await store.call('finish',user,{...p,state:'uncertain',result:{status:'uncertain'}})
    await store.call('observe',user,{broker:'kiwoom',accountScope:p.accountScope,orders:[]})
    assert.equal((await store.call('lookup',user,p)).state,'uncertain')
    assert.equal((await store.call('locks',other,{broker:'kiwoom',accountScope:p.accountScope})).length,0)
    await db.exec(sql)
    assert.equal((await db.query('select count(*)::int n from public.broker_order_management_requests')).rows[0].n,1)
    for(const role of ['anon','authenticated','service_role']){
      const permissions=(await db.query("select has_table_privilege($1,'public.broker_order_management_requests','select') r,has_table_privilege($1,'public.broker_order_management_requests','insert') w,has_function_privilege($1,'public.atlas_order_management_rpc(text,uuid,jsonb)','execute') x",[role])).rows[0]
      assert.deepEqual(permissions,{r:false,w:false,x:role==='service_role'})
      await db.exec(`set role ${role}`)
      await assert.rejects(db.query('insert into public.broker_order_management_requests(user_id) values($1)',[user]),/permission denied/)
      if(role!=='service_role')await assert.rejects(db.query("select public.atlas_order_management_rpc('locks',$1,'{}')",[user]),/permission denied/)
      await db.exec('reset role')
    }
    await assert.rejects(store.call('locks',null,{broker:'kiwoom'}))
  }finally{await db.close()}
})
test('preflight fill/version change, stale account and forged order cannot write; flags and guests block; accepted is not completed',async()=>{
  const {db,store}=await database();let snapshot={...row},writes=0,readCount=0,delay=false,release
  const brokers=createOpenOrderBrokers({now,kiwoom:async p=>{
    if(p.endpoint==='/api/dostk/ordr'){writes++;if(delay)await new Promise(r=>release=r);return {return_code:0,ord_no:'202'}}
    readCount++;return kiwoomPage([snapshot])
  }})
  const h=createOpenOrderHandlers({authenticate:async()=>account,settings,brokers,store})
  try{
    await assert.rejects(h.list({headers:{},query:{broker:'kiwoom'}}),{statusCode:401});assert.equal(readCount,0)
    const first=await h.list(request());assert.equal(first.managementReady,true);assert.equal(JSON.stringify(first).includes('secret'),false)
    let input=inputFor(first)
    snapshot={...row,cntr_qty:4,oso_qty:6}
    await assert.rejects(h.manage(request(input),'kiwoom'),{code:'order_changed'});assert.equal(writes,0)
    snapshot={...row}
    await assert.rejects(h.manage(request({...input,scope:digest('forged')}),'kiwoom'),{code:'order_changed'});assert.equal(writes,0)
    delay=true
    const a=h.manage(request(input),'kiwoom')
    while(!release)await new Promise(r=>setTimeout(r,1))
    await assert.rejects(h.manage(request({...input,requestId:'fixture_request_0002'}),'kiwoom'),{code:'order_locked'})
    release();const receipt=await a
    assert.equal(receipt.status,'accepted');assert.equal(receipt.originalOrderNumber,'101');assert.equal(receipt.orderNumber,'202');assert.equal(writes,1)
    const restarted=createOpenOrderHandlers({authenticate:async()=>account,settings,brokers,store})
    assert.deepEqual(await restarted.manage(request(input),'kiwoom'),receipt);assert.equal(writes,1)
    await assert.rejects(restarted.manage(request({...input,price:72000}),'kiwoom'),{code:'request_conflict'})
    assert.equal((await h.list(request())).items[0].canCancel,false)
    snapshot={...row,oso_qty:5,ord_qty:8}
    assert.equal((await h.list(request())).items[0].canCancel,true)
    const disabled=createOpenOrderHandlers({authenticate:async()=>account,settings:{},brokers,store})
    await assert.rejects(disabled.manage(request(input),'kiwoom'),{code:'orders_disabled'})
  }finally{await db.close()}
})
test('lost write response remains uncertain after restart; partial/timeout cannot enable actions; route errors never leak raw broker data',async()=>{
  const {db,store}=await database();let writes=0
  const brokers=createOpenOrderBrokers({now,kiwoom:async p=>{
    if(p.endpoint==='/api/dostk/ordr'){writes++;throw Error('PRIVATE ACCOUNT TOKEN RAW')}
    return kiwoomPage([row])
  }})
  const h=createOpenOrderHandlers({authenticate:async()=>account,settings,brokers,store})
  try{
    const data=await h.list(request()),input=inputFor(data,{action:'cancel',quantity:7})
    await assert.rejects(h.manage(request(input),'kiwoom'),{code:'outcome_uncertain'})
    const restarted=createOpenOrderHandlers({authenticate:async()=>account,settings,brokers,store})
    await assert.rejects(restarted.manage(request(input),'kiwoom'),{code:'request_already_recorded'});assert.equal(writes,1)
    const app=Fastify();registerOpenOrderRoutes(app,{list:async()=>{throw Error('PRIVATE ACCOUNT TOKEN RAW')}})
    const response=await app.inject({method:'GET',url:'/api/account/orders/open?broker=kiwoom'})
    assert.equal(response.statusCode,502);assert.equal(response.body.includes('PRIVATE'),false);await app.close()
    const noSql=createOpenOrderHandlers({authenticate:async()=>account,settings,brokers,store:{call:async()=>{throw Error()}}})
    const read=await noSql.list(request());assert.equal(read.items.length,1);assert.equal(read.managementReady,false);assert.equal(read.items[0].canCancel,false)
  }finally{await db.close()}
})
test('strict input and shared Kiwoom lanes distinguish listed 1TPS TRs from 5TPS open/write; cancel/deadline and cooldown',async()=>{
  let virtualNow=10000;const waits=[],flow=createKiwoomFlow({now:()=>virtualNow,pause:async(ms,signal)=>{signal?.throwIfAborted();waits.push(ms);virtualNow+=ms}})
  for(const tr of ['kt00001','kt00018','ka10075','kt10002','kt10003'])await flow.wait(auth,tr)
  assert.deepEqual(waits,[1050,210,210]);assert.equal(SLOW_ACCOUNT_TRS.has('ka10075'),false)
  await flow.wait({appKey:'other',secretKey:'secret'},'kt00001');assert.equal(waits.length,3)
  flow.limited(auth,2);await flow.wait(auth,'ka10075');assert.equal(waits.at(-1),2000)
  const controller=new AbortController();controller.abort();await assert.rejects(flow.wait(auth,'kt00001',controller.signal))
  const valid={id:'a'.repeat(64),scope:'b'.repeat(64),accountScope:'c'.repeat(64),version:'d'.repeat(64),accountRef:'e'.repeat(32),requestId:'request_example_0001',action:'amend',quantity:1,price:70000}
  for(const change of [{quantity:0},{quantity:1.5},{price:70001},{action:'buy'},{accountRef:'12345678901'}])assert.throws(()=>validateManagementInput({...valid,...change}))
})
test('database image loaded in a fresh engine keeps unresolved writes blocked',async()=>{
  let db
  try{
    const first=await database();db=first.db
    const p={broker:'kiwoom',requestId:'restart_request_0001',scope:digest('restart-order'),accountScope:digest('restart-account'),digest:digest('input'),version:digest('v1'),action:'cancel'}
    await first.store.call('reserve',user,p);const image=await db.dumpDataDir();await db.close();db=new PGlite({loadDataDir:image})
    const saved=(await db.query("select public.atlas_order_management_rpc('lookup',$1,$2::jsonb) v",[user,JSON.stringify(p)])).rows[0].v
    assert.equal(saved.fresh,false);assert.equal(saved.state,'pending')
    await assert.rejects(db.query("select public.atlas_order_management_rpc('reserve',$1,$2::jsonb)",[user,JSON.stringify({...p,requestId:'restart_request_0002'})]),/order_locked/)
  }finally{await db?.close()}
})
test('KB ISIN resolves through personal SIQM4900 (never substring), preserves original write symbol; metadata cache scoped',async()=>{
  let reads=0;const calls=[]
  const b=createOpenOrderBrokers({now,kb:{request:async(a,code,p)=>{
    calls.push({a,code,p})
    if(code==='ssqm2341')return {grid_cnt1:1,Record1:[{ordr_no:'300',stnd_is_no:'KR7005931001',hngl_shrt_nm:'삼성전자우',trd_dl_ccd_nm:'매도',ordr_q:10,tl_ccls_q:0,nccls_q:10,ordr_uprc:70000,ordr_ccd:'00',sor_ordr_ccd:'K',gds_typ_dtls_nm:'현금'}]}
    if(code==='siqm4900'){reads++;assert.deepEqual(p,{stnd_is_cd:'KR7005931001'});return {stnd_is_cd:p.stnd_is_cd,shrt_is_cd:'A005935'}}
    return {ordr_no:'301'}
  }}})
  const data=await b.read('kb',account);assert.equal(data.items[0].symbol,'005935')
  await b.read('kb',account);assert.equal(reads,1)
  await b.submit('kb',account,data.items[0],'cancel',{quantity:4})
  assert.equal(calls.at(-1).p.is_cd,'KR7005931001');assert.equal(calls.at(-1).p.ordr_q,'4');assert.equal(calls.at(-1).p.crct_clsf,'1')
  await b.read('kb',{...account,user:{id:other}});assert.equal(reads,2)
})
test('authoritative rejection unlocks unlike timeout; foreign user and changed original cannot write',async()=>{
  const {db,store}=await database();let writes=0,filled=false
  const b=createOpenOrderBrokers({now,kiwoom:async p=>{
    if(p.endpoint==='/api/dostk/ordr'){writes++;throw Object.assign(Error('PRIVATE REJECTION RAW'),{definitiveRejection:true})}
    return kiwoomPage(filled?[]:[row])
  }})
  const make=(a=account)=>createOpenOrderHandlers({authenticate:async()=>a,settings,brokers:b,store})
  try{
    const h=make(),data=await h.list(request()),input=inputFor(data)
    await assert.rejects(make({...account,user:{id:other}}).manage(request(input),'kiwoom'),{code:'order_changed'});assert.equal(writes,0)
    filled=true;await assert.rejects(h.manage(request(input),'kiwoom'),{code:'order_changed'});assert.equal(writes,0)
    filled=false;await assert.rejects(h.manage(request(input),'kiwoom'),{code:'broker_rejected'});assert.equal(writes,1)
    assert.equal((await h.list(request())).items[0].canCancel,true)
    await assert.rejects(h.manage(request(input),'kiwoom'),{code:'request_already_recorded'});assert.equal(writes,1)
  }finally{await db.close()}
})
test('same-origin Vercel proxy to actual Fastify routes and SQL reservation reaches official modify adapter once',async()=>{
  const {db,store}=await database(),app=Fastify();let writes=0
  const b=createOpenOrderBrokers({now,kiwoom:async p=>{
    if(p.endpoint==='/api/dostk/ordr'){assert.equal(p.apiId,'kt10002');assert.equal(p.body.orig_ord_no,'101');assert.equal(p.body.mdfy_qty,'5');assert.equal(p.retry,false);writes++;return {return_code:0,ord_no:'202'}}
    return kiwoomPage([row])
  }})
  registerOpenOrderRoutes(app,createOpenOrderHandlers({authenticate:async()=>account,settings,brokers:b,store}))
  const oldFetch=global.fetch,oldOrigin=process.env.ATLAS_API_ORIGIN
  process.env.ATLAS_API_ORIGIN='https://api.fixture.test'
  global.fetch=async(url,p)=>{const u=new URL(url);const r=await app.inject({method:p.method,url:u.pathname+u.search,headers:p.headers,payload:p.body});return new Response(r.body,{status:r.statusCode})}
  const call=async(method,body)=>{
    const res={setHeader(){},status(v){this.statusCode=v;return this},json(v){this.body=v;return this}}
    await proxy({method,headers:{authorization:'Bearer fixture'},query:{broker:'kiwoom'},body},res);return res
  }
  try{
    const list=await call('GET');assert.equal(list.statusCode,200);assert.equal(list.body.items[0].symbol,'005930')
    const input={...inputFor(list.body),broker:'kiwoom'},first=await call('POST',input),second=await call('POST',input)
    assert.equal(first.statusCode,200);assert.equal(first.body.status,'accepted');assert.deepEqual(second.body,first.body);assert.equal(writes,1)
    const guest=await app.inject({method:'POST',url:'/api/orders/kiwoom/manage',payload:input});assert.equal(guest.statusCode,401)
    const invalid=await app.inject({method:'GET',url:'/api/order-management?broker=bad',headers:{authorization:'Bearer fixture'}});assert.equal(invalid.statusCode,400)
  }finally{global.fetch=oldFetch;if(oldOrigin===undefined)delete process.env.ATLAS_API_ORIGIN;else process.env.ATLAS_API_ORIGIN=oldOrigin;await app.close();await db.close()}
})
test('Toss unfilled DAY limit amend uses positive unchanged remaining size, official type and replacement id',async()=>{
  const calls=[],b=createOpenOrderBrokers({toss:async p=>{calls.push(p);return {result:{orderId:'replacement-9'}}}})
  const item=normalizeOpenOrder('toss','a'.repeat(32),'owner','original-8',{symbol:'005930',name:'삼성전자',side:'sell',quantity:10,filledQuantity:0,remainingQuantity:10,orderPrice:70000,priceType:'limit',orderType:'지정가',session:'정규장'}, {cash:true,exchange:'SOR',type:'LIMIT',account:123,scopeOwner:user})
  assert.equal(item.canAmend,true)
  const result=await b.submit('toss',account,item,'amend',{quantity:4,price:71000})
  assert.equal(result.orderNumber,'replacement-9');assert.equal(calls[0].path,'/api/v1/orders/original-8/modify')
  assert.deepEqual(calls[0].body,{orderType:'LIMIT',quantity:'4',price:'71000',confirmHighValueOrder:false});assert.equal(calls[0].accountSeq,123);assert.equal(calls[0].retry,false)
})
test('a late read begun before acceptance cannot release an accepted-order lock',async()=>{
  const {db,store}=await database()
  try{
    const p={broker:'kiwoom',requestId:'late_read_request_01',scope:digest('late-order'),accountScope:digest('late-account'),digest:digest('input'),version:digest('v1'),action:'amend'}
    const old=await store.call('read_marker',user,{broker:'kiwoom'})
    await store.call('reserve',user,p);await store.call('finish',user,{...p,state:'accepted',result:{status:'accepted'}})
    const stale=await store.call('reconcile',user,{broker:p.broker,accountScope:p.accountScope,readMarker:old.at,orders:[]})
    assert.equal(stale[0].state,'accepted')
    const fresh=await store.call('read_marker',user,{broker:'kiwoom'})
    assert.deepEqual(await store.call('reconcile',user,{broker:p.broker,accountScope:p.accountScope,readMarker:fresh.at,orders:[]}),[])
    assert.equal((await store.call('lookup',user,p)).state,'observed')
  }finally{await db.close()}
})
