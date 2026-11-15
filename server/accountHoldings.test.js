import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeKiwoomHoldings,createKiwoomAccountSummary} from './kiwoomAccount.js'
import {normalizeTossHoldings,createTossAccountSummary} from './tossAccount.js'
import {createAddedBrokerData,kbPurchasePriceQuantity} from './addedBrokerData.js'

const kiwoomRow = extra => ({stk_cd:'A005930',stk_nm:'삼성전자',rmnd_qty:'10',trde_able_qty:'0',pur_pric:'200000',cur_prc:'210000',pur_amt:'999',...extra})
const kiwoomBalance = rows => ({return_code:0,acnt_evlt_remn_indv_tot:rows})
const tossRow = extra => ({symbol:'005930',name:'삼성전자',marketCountry:'KR',currency:'KRW',quantity:'10',averagePurchasePrice:'200000',lastPrice:'210000',marketValue:{purchaseAmount:'999'},...extra})
const tossPayload = items => ({result:{items}})
const auth = {appKey:'fixture-personal-key',secretKey:'fixture-personal-secret'}
const authenticate = async()=>({credentials:{kiwoomAppKey:auth.appKey,kiwoomSecretKey:auth.secretKey},status:{kiwoomConfigured:true}})

test('Kiwoom and Toss use current owned quantity and the broker average, never sellable/current/amount substitutes',()=>{
 const a=normalizeKiwoomHoldings(kiwoomBalance([kiwoomRow()]))[0]
 const b=normalizeTossHoldings(tossPayload([tossRow()]),'005930',0)[0]
 for(const row of [a,b]){assert.equal(row.quantity,10);assert.equal(row.tradableQuantity,0);assert.equal(row.averagePrice,200000)}
 assert.equal(normalizeKiwoomHoldings(kiwoomBalance([kiwoomRow({pur_pric:'201234.56'})]))[0].averagePrice,201234.56)
 assert.equal(normalizeTossHoldings(tossPayload([tossRow({averagePurchasePrice:'201234.56'})]))[0].averagePrice,201234.56)
})

test('missing/invalid quantities and averages stay unknown instead of successful zero or a fabricated mean',()=>{
 for(const value of [undefined,null,'','not-a-number',Infinity,[10],{value:10}]){
  const a=normalizeKiwoomHoldings(kiwoomBalance([kiwoomRow({rmnd_qty:value,pur_pric:value})]))[0]
  const b=normalizeTossHoldings(tossPayload([tossRow({quantity:value,averagePurchasePrice:value})]))[0]
  for(const row of [a,b]){assert.equal(row.quantity,null);assert.equal(row.averagePrice,null)}
 }
 assert.equal(normalizeKiwoomHoldings(kiwoomBalance([kiwoomRow({rmnd_qty:'-1'})]))[0].quantity,null)
 assert.equal(normalizeTossHoldings(tossPayload([tossRow({quantity:'-1'})]))[0].quantity,null)
 const duplicates=normalizeKiwoomHoldings(kiwoomBalance([kiwoomRow(),kiwoomRow({pur_pric:'190000',crd_tp:'03'})]))
 assert.equal(duplicates.length,2);assert.deepEqual(duplicates.map(row=>row.averagePrice),[200000,190000])
 assert.equal(normalizeTossHoldings(tossPayload([tossRow(),tossRow({averagePurchasePrice:'190000'})])).length,2)
})

test('authoritative empty/zero holdings differ from HTTP 200 errors and incomplete payloads',()=>{
 assert.deepEqual(normalizeKiwoomHoldings(kiwoomBalance([])),[])
 assert.deepEqual(normalizeKiwoomHoldings({return_code:0,tot_pur_amt:'0',tot_evlt_amt:'0'}),[])
 assert.deepEqual(normalizeKiwoomHoldings(kiwoomBalance([kiwoomRow({rmnd_qty:'0'})])),[])
 assert.equal(normalizeTossHoldings(tossPayload([tossRow({quantity:'0'})]))[0].quantity,0)
 assert.deepEqual(normalizeTossHoldings(tossPayload([])),[])
 for(const value of [{},null,{return_code:1,acnt_evlt_remn_indv_tot:[]},{return_code:0},{return_code:0,tot_pur_amt:'100',tot_evlt_amt:'100'},kiwoomBalance([null]),kiwoomBalance([{stk_cd:'bad'}])])assert.throws(()=>normalizeKiwoomHoldings(value),{statusCode:502})
 for(const value of [{},null,{result:{}},{result:{items:null}},{error:{code:'rejected'},result:{items:[]}},{success:false,result:{items:[]}},tossPayload([null]),tossPayload([tossRow({symbol:'bad'})])])assert.throws(()=>normalizeTossHoldings(value),{statusCode:502})
 assert.deepEqual(normalizeTossHoldings(tossPayload([tossRow({symbol:'AAPL',marketCountry:'US',currency:'USD'})])),[])
})

test('Kiwoom summary reuses authenticated credentials and reads bounded continuation pages without any order write',async()=>{
 const calls=[]
 const get=createKiwoomAccountSummary({authenticate,requestAccount:async call=>{
  calls.push(call);assert.equal(call.appKey,auth.appKey);assert.equal(call.secretKey,auth.secretKey);assert.equal(call.endpoint,'/api/dostk/acnt')
  if(call.apiId==='kt00001')return {entr:'0'}
  assert.equal(call.apiId,'kt00018')
  return call.nextKey?{body:kiwoomBalance([kiwoomRow()]),contYn:'N',nextKey:''}:{body:kiwoomBalance([kiwoomRow({stk_cd:'A000660',pur_pric:'100000'})]),contYn:'Y',nextKey:'page-2'}
 }})
 const summary=await get({query:{symbol:'005930'}})
 assert.equal(summary.broker,'kiwoom')
 assert.deepEqual(summary.holdings.map(row=>row.code),['000660','005930'])
 const pages=calls.filter(call=>call.apiId==='kt00018')
 assert.deepEqual(pages.map(call=>[call.contYn,call.nextKey]),[['N',''],['Y','page-2']])
 assert.equal(new Set(calls.map(call=>call.signal)).size,1)
 assert.equal(JSON.stringify(summary).includes(auth.appKey),false)
 assert.equal(JSON.stringify(summary).includes(auth.secretKey),false)
})

test('Kiwoom unconfigured auth, business errors, continuation loops and incomplete pages fail closed',async()=>{
 let calls=0
 const forbidden=createKiwoomAccountSummary({authenticate:async()=>({credentials:{},status:{}}),requestAccount:async()=>{calls++}})
 await assert.rejects(forbidden({}),{statusCode:403});assert.equal(calls,0)
 for(const result of [{body:kiwoomBalance([]),contYn:'Y',nextKey:''},{body:kiwoomBalance([]),contYn:'Y',nextKey:'repeated'},{body:{return_code:0},contYn:'N'},{body:{return_code:3,acnt_evlt_remn_indv_tot:[]},contYn:'N'}]){
  const get=createKiwoomAccountSummary({authenticate,requestAccount:async call=>call.apiId==='kt00001'?{}:result})
  await assert.rejects(get({}),{statusCode:502})
 }
 let pages=0
 const bounded=createKiwoomAccountSummary({authenticate,requestAccount:async call=>call.apiId==='kt00001'?{}:{body:kiwoomBalance([]),contYn:'Y',nextKey:`page-${++pages}`}})
 await assert.rejects(bounded({}),{statusCode:502});assert.equal(pages,50)
})

test('NH and KB preserve the existing cash holdings scope and broker quantity/average fields',async()=>{
 const data=createAddedBrokerData({nh:{simulated:false,request:async(_auth,path)=>{
  if(path==='/n2/acctinfo')return {Output_0:[{acct_no:'12345678901',acct_type:'01'}]}
  return {Output_0:{tot_byn_amt:2000000,tot_eal_amt:2100000},Output_1:[{iem_cd:'005930',tp_cd_nm:'현금',itg_bnc_qty:10,phs_pr:200000},{iem_cd:'005930',tp_cd_nm:'신용융자',itg_bnc_qty:5,phs_pr:100000}]}
 }},kb:{request:async(_auth,code)=>code==='ssqm2952'?{Record1:[{is_cd:'A005930',clsf:'현금',ec_q:10,hld_q:0,ordr_psbl_q:0,byng_avr_prc:200000},{is_cd:'005930',clsf:'신용융자',ec_q:5,byng_avr_prc:100000}],tl_data_cnt:2}:{}}})
 for(const broker of ['nh','kb']){
  const summary=await data.summary(broker,auth,'')
  assert.equal(summary.holdings.length,1);assert.equal(summary.holdings[0].quantity,10);assert.equal(summary.holdings[0].averagePrice,200000)
 }
})

test('NH final empty omitted block requires valid zero totals; malformed and missing positive holdings fail',async()=>{
 async function summary(response){return createAddedBrokerData({nh:{simulated:false,request:async(_auth,path)=>path==='/n2/acctinfo'?{Output_0:[{acct_no:'12345678901',acct_type:'01'}]}:response}}).summary('nh',auth,'')}
 for(const response of [{Output_0:{tot_byn_amt:0,tot_eal_amt:0}},{Output_0:{tot_byn_amt:0,tot_eal_amt:0},Output_1:[]}])assert.deepEqual((await summary(response)).holdings,[])
 for(const response of [{},{Output_0:{}},{Output_0:{tot_byn_amt:100,tot_eal_amt:100}},{Output_0:{tot_byn_amt:0,tot_eal_amt:0},Output_1:null},{Output_0:{tot_byn_amt:0,tot_eal_amt:0},hasMore:true,continuation:'more'}])await assert.rejects(summary(response),{statusCode:502})
 let page=0
 const paged=createAddedBrokerData({nh:{simulated:false,request:async(_auth,path)=>path==='/n2/acctinfo'?{Output_0:[{acct_no:'12345678901',acct_type:'01'}]}:++page===1?{Output_1:[{iem_cd:'005930',itg_bnc_qty:1,phs_pr:200000}],hasMore:true,continuation:'next'}:{Output_0:{tot_byn_amt:200000,tot_eal_amt:210000}}}})
 assert.equal((await paged.summary('nh',auth,'')).holdings[0].averagePrice,200000)
})

test('KB valid empty counts differ from missing/malformed or truncated holding lists',async()=>{
 const summary=response=>createAddedBrokerData({kb:{request:async(_auth,code)=>code==='ssqm2952'?response:{}}}).summary('kb',auth,'')
 for(const response of [{Record1:[],tl_data_cnt:0},{dy_tfnd:0,tl_data_cnt:0}])assert.deepEqual((await summary(response)).holdings,[])
 for(const response of [{},{tl_data_cnt:0},{Record1:null,tl_data_cnt:0},{Record1:[],tl_data_cnt:1}])await assert.rejects(summary(response),{statusCode:502})
 const unknown=await summary({Record1:[{is_cd:'005930',ec_q:null,byng_avr_prc:''}],tl_data_cnt:1})
 assert.equal(unknown.holdings[0].quantity,null);assert.equal(unknown.holdings[0].averagePrice,null)
})

test('Toss summary shares one deadline and selected personal account from account lookup through all reads',async()=>{
 const calls=[],signals=[]
 const get=createTossAccountSummary({authenticate:async()=>({credentials:{tossApiKey:'fixture-toss-key',tossSecretKey:'fixture-toss-secret'},status:{tossConfigured:true}}),
  getAccount:async(auth,options)=>{assert.equal(auth.apiKey,'fixture-toss-key');signals.push(options.signal);return {accountSeq:42}},
  requestAccount:async call=>{
   calls.push(call);signals.push(call.signal);assert.equal(call.accountSeq,42)
   if(call.path==='/api/v1/holdings')return tossPayload([tossRow()])
   return {result:{cashBuyingPower:'0',sellableQuantity:'0'}}
  }})
 const summary=await get({query:{symbol:'005930'}})
 assert.equal(summary.broker,'toss');assert.equal(summary.holdings[0].averagePrice,200000)
 assert.equal(summary.holdings[0].quantity,10);assert.equal(summary.holdings[0].tradableQuantity,0)
 assert.equal(new Set(signals).size,1);assert.equal(signals.length,4)
 assert.ok(calls.every(call=>call.method===undefined&&call.path.startsWith('/api/v1/')))
 assert.equal(JSON.stringify(summary).includes('fixture-toss'),false)
 let forbiddenReads=0
 const forbidden=createTossAccountSummary({authenticate:async()=>({credentials:{},status:{}}),getAccount:async()=>{forbiddenReads++}})
 await assert.rejects(forbidden({}),{statusCode:403});assert.equal(forbiddenReads,0)
})

test('NH and KB summary-wide deadlines stop stalled reads without returning authoritative empty holdings',async()=>{
 const keepAlive=setTimeout(()=>{},500)
 try{
  for(const broker of ['nh','kb']){
   const signals=[]
   const data=createAddedBrokerData({accountTimeoutMs:20,nh:{simulated:false,request:async(_auth,path,_input,options)=>{
    signals.push(options.signal)
    if(path==='/n2/acctinfo')return {Output_0:[{acct_no:'12345678901',acct_type:'01'}]}
    return new Promise(()=>{})
   }},kb:{request:async(_auth,_code,_input,options)=>{signals.push(options.signal);return new Promise(()=>{})}}})
   await assert.rejects(data.summary(broker,auth,''),{name:'TimeoutError'})
   assert.equal(new Set(signals).size,1);assert.equal(signals[0].aborted,true)
  }
 }finally{clearTimeout(keepAlive)}
})

test('Toss account lookup and holdings requests consume the same deadline without a fresh per-stage timeout',async()=>{
 const keepAlive=setTimeout(()=>{},500),signals=[]
 try{
  const get=createTossAccountSummary({timeoutMs:25,
   authenticate:async()=>({credentials:{tossApiKey:'fixture-key',tossSecretKey:'fixture-secret'},status:{tossConfigured:true}}),
   getAccount:async(_auth,{signal})=>{signals.push(signal);await new Promise(resolve=>setTimeout(resolve,10));return {accountSeq:1}},
   requestAccount:async({path,signal})=>{
    signals.push(signal);signal.throwIfAborted()
    if(path!=='/api/v1/holdings')return {result:{cashBuyingPower:'0'}}
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
   }})
  await assert.rejects(get({query:{}}),{name:'TimeoutError'})
  assert.equal(new Set(signals).size,1);assert.equal(signals[0].aborted,true)
 }finally{clearTimeout(keepAlive)}
})

test('KB optional overlay verifies only equal owned/settlement quantity with explicit zero unsettled quantities',()=>{
 const settled={hld_q:'10',ec_q:'10',nstmt_b_q:'0',nstmt_s_q:'0'}
 assert.deepEqual(kbPurchasePriceQuantity(settled),{purchasePriceQuantity:10,purchasePriceQuantityStatus:'verified'})
 assert.deepEqual(kbPurchasePriceQuantity({...settled,hld_q:'0',ec_q:'0'}),{purchasePriceQuantity:0,purchasePriceQuantityStatus:'verified'})
 for(const change of [{hld_q:'9'},{ec_q:'9'},{nstmt_b_q:'1'},{nstmt_s_q:'1'},{hld_q:null},{ec_q:''},{nstmt_b_q:undefined},{nstmt_s_q:''},{hld_q:'-1',ec_q:'-1'},{hld_q:'invalid'},{ec_q:Infinity},{nstmt_b_q:[0]},{hld_q:[10],ec_q:[10]}]){
  assert.deepEqual(kbPurchasePriceQuantity({...settled,...change}),{purchasePriceQuantity:null,purchasePriceQuantityStatus:'unconfirmed'})
 }
})

test('KB overlay metadata never changes the legacy settlement quantity used by existing assets/orders',async()=>{
 const data=createAddedBrokerData({kb:{request:async(_auth,code)=>code==='ssqm2952'?{Record1:[
  {is_cd:'A005930',clsf:'현금',ec_q:10,hld_q:9,nstmt_b_q:1,nstmt_s_q:0,byng_avr_prc:200000},
  {is_cd:'A000660',clsf:'현금',ec_q:3,hld_q:3,nstmt_b_q:0,nstmt_s_q:0,byng_avr_prc:100000},
 ],tl_data_cnt:2}:{}}})
 const summary=await data.summary('kb',auth,'')
 assert.deepEqual(summary.holdings.map(({code,quantity,purchasePriceQuantity,purchasePriceQuantityStatus,averagePrice})=>({code,quantity,purchasePriceQuantity,purchasePriceQuantityStatus,averagePrice})),[
  {code:'005930',quantity:10,purchasePriceQuantity:null,purchasePriceQuantityStatus:'unconfirmed',averagePrice:200000},
  {code:'000660',quantity:3,purchasePriceQuantity:3,purchasePriceQuantityStatus:'verified',averagePrice:100000},
 ])
})
