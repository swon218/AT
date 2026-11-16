import test from 'node:test'
import assert from 'node:assert/strict'
import {createTradingNhGateway,nhTradingCapabilities,nhAcceptedReferences,nhCancelInput,nhCancelReferences,normalizeNhOrderSnapshot,parseNhTradingQuote} from './tradingNhGateway.js'
import {accountRef} from './personalBroker.js'

const time=Date.parse('2026-11-16T00:10:00Z'),session={date:'2026-11-16',previous:'2026-11-13',market:'KRX',open:'2026-11-16T00:00:00Z',close:'2026-11-16T06:30:00Z'}
const owner='11111111-1111-4111-8111-111111111111',rawAccount='12345678901',otherAccount='12345678902'
const account={user:{id:owner},credentials:{nhAppKey:'fixture-key',nhSecretKey:'fixture-secret'},status:{nhConfigured:true},tradingCredentialEpoch:'fixture-epoch'}
const ref=accountRef(account,'nh',{appKey:'fixture-key',secretKey:'fixture-secret'},rawAccount)
const success=(Output_0,extra={})=>({rsp_cd:'00000',rsp_msg:'조회가 완료되었습니다.',Output_0,...extra})
const snapshot=(extra={})=>({itg_orr_no:98765432101,org_itg_orr_no:0,iem_cd:'005930',sby_dit_cd_nm:'매수',orr_qty:3,orr_pr:200000,tot_cns_qty:1,cns_avg_uit_pr:200000,cns_amt:200000,ny_cns_qty:2,can_qty:0,rmt_mkt_cd:'KRX',...extra})
const quote=()=>success([{bsop_hour:'09:09:55',stck_prpr:200000}],{Output_1:{iem_cd:'005930'}})
function fixture(options={}) {
  const calls=[],state={multiple:false,empty:false,more:false,orders:[snapshot()],...options}
  const nh={simulated:false,request:async(auth,path,body,opts={})=>{
    calls.push({auth,path,body,opts})
    if(state.errorPath===path)throw new Error('PRIVATE_SECRET_PROVIDER_RAW')
    if(path==='/n2/acctinfo')return success([{acct_no:rawAccount,acct_type:'01'},...(state.multiple?[{acct_no:otherAccount,acct_type:'02'}]:[]),{acct_no:'99999999999',acct_type:'03'}])
    if(path.endsWith('/balance'))return success({tot_byn_amt:state.empty?0:600000,tot_eal_amt:state.empty?0:600000},{Output_1:state.empty?[]:[{iem_cd:'005930',tp_cd_nm:'현금',itg_bnc_qty:3,phs_pr:200000}],...(state.more?{hasMore:true,continuation:'repeated'}:{})})
    if(path.endsWith('/buyableQuantity'))return success({csh_orr_pbl_amt:500000,csh_orr_pbl_qty:2,max_pbl_amt:99999999,max_pbl_qty:99999})
    if(path.endsWith('/sellableQuantity'))return success({sll_pbl_qty:1})
    if(path.endsWith('/dailyOrderExecution'))return success(state.orders)
    if(path.endsWith('/currentExecution'))return quote()
    assert.fail('Unexpected NH path, including every order write: '+path)
  }}
  const data={candleResponse:async(...args)=>{calls.push({chartArgs:args});return {items:[{time:'2026-11-13',open:200000,high:201000,low:199000,close:200500,volume:100}],meta:{source:'nh',market:'KRX',fallback:false,invalidRows:0}}}}
  const gateway=createTradingNhGateway({nh,data,settings:{nhOrdersEnabled:true},now:()=>time,loadAccount:state.loadAccount})
  return {gateway,calls,state,input:{account,broker:'nh',accountRef:ref,symbol:'005930',session}}
}

test('NH full-recovery support remains explicitly blocked rather than guessing integrated and market identifiers',async()=>{
  const capability=nhTradingCapabilities({ordersEnabled:true})
  assert.equal(capability.supported,false);assert.equal(capability.readSupported,true);assert.equal(capability.ordersEnabled,true)
  assert.equal(capability.code,'nh_recovery_contract_unverified')
  assert.ok(capability.missingContracts.includes('market_to_integrated_order_mapping'))
  const f=fixture()
  assert.deepEqual(await f.gateway.submit(f.input),{status:'rejected',notTransmitted:true,code:'trading_nh_recovery_contract_unverified'})
  assert.equal((await f.gateway.cancel(f.input)).notTransmitted,true)
  assert.equal(f.calls.length,0)
})

test('NH own account list uses personal credentials and opaque refs, requires explicit choice with multiple own accounts',async()=>{
  const f=fixture({multiple:true}),result=await f.gateway.accounts({...f.input,accountRef:''})
  assert.equal(result.accountRequired,true);assert.equal(result.accounts.length,2)
  assert.equal(result.accounts[0].ref,ref);assert.ok(!JSON.stringify(result).includes(rawAccount))
  const pending=await f.gateway.inspect({...f.input,accountRef:''})
  assert.equal(pending.complete,false);assert.equal(pending.holdingQuantity,null)
  await assert.rejects(f.gateway.inspect({...f.input,accountRef:rawAccount}),{code:'trading_account_scope_invalid'})
  assert.ok(f.calls.every(call=>call.auth.appKey==='fixture-key'))
})

test('NH stored flag alone is not account evidence; missing personal credentials never invokes an operator or another broker',async()=>{
  const f=fixture()
  await assert.rejects(f.gateway.accounts({...f.input,account:{...account,credentials:{},status:{nhConfigured:true}}}),{code:'trading_nh_credentials_missing'})
  assert.equal(f.calls.length,0)
})

test('NH read inspection distinguishes current holdings from sellable quantity and uses no-credit cash buying power',async()=>{
  const f=fixture(),result=await f.gateway.inspect(f.input)
  assert.equal(result.complete,true);assert.equal(result.holdingQuantity,3);assert.equal(result.sellableQuantity,1);assert.equal(result.averagePrice,200000)
  assert.equal(result.cashAvailable,500000);assert.equal(result.buyableQuantity,2);assert.equal(result.orderRecoverySupported,false)
  assert.equal(result.openOrders[0].integratedOrderId,'98765432101');assert.equal(result.openOrders[0].orderNumber,null)
  assert.ok(f.calls.filter(call=>call.body?.act_no).every(call=>call.body.act_no===rawAccount))
  assert.ok(!f.calls.some(call=>call.path?.includes('/order/')))
})

test('NH valid zero holdings remain zero while incomplete pagination and unknown balance blocks fail',async()=>{
  const empty=fixture({empty:true,orders:[]}),result=await empty.gateway.inspect(empty.input)
  assert.equal(result.holdingQuantity,0);assert.equal(result.averagePrice,null)
  const repeated=fixture({more:true})
  await assert.rejects(repeated.gateway.inspect(repeated.input),{code:'trading_nh_balance_incomplete'})
})

test('NH KRX quote requires actual provider execution clock in current verified session, never receipt-time substitution',async()=>{
  const f=fixture(),result=await f.gateway.quote(f.input)
  assert.equal(result.observedAt,'2026-11-16T00:09:55.000Z');assert.equal(result.exchange,'KRX');assert.equal(result.price,200000)
  const sent=f.calls.find(call=>call.path?.endsWith('/currentExecution'))
  assert.equal(sent.body.market_cd,'KRX');assert.equal(sent.body.view_main_yn,'Y')
  assert.throws(()=>parseNhTradingQuote(success([{stck_prpr:200000}],{Output_1:{iem_cd:'005930'}}),'005930',session,time),{code:'trading_nh_quote_stale'})
  assert.throws(()=>parseNhTradingQuote(quote(),'000660',session,time),{code:'trading_nh_quote_invalid'})
  assert.throws(()=>parseNhTradingQuote(quote(),'005930',session,time+60000),{code:'trading_nh_quote_stale'})
})

test('NH private chart keeps personal source, KRX and selected account; no Kiwoom fallback is introduced',async()=>{
  const f=fixture(),result=await f.gateway.candles({...f.input,interval:'15분'})
  assert.equal(result.metadata.sourceBroker,'nh');assert.equal(result.metadata.personal,true)
  const args=f.calls.find(call=>call.chartArgs).chartArgs
  assert.equal(args[0],'nh');assert.equal(args[4].appKey,'fixture-key');assert.equal(args[5].market,'KRX');assert.equal(args[5].includeExtended,false)
})

test('NH accepted market order ids are persisted distinctly and only that official id is used for cancellation input',()=>{
  const refs=nhAcceptedReferences(success({mkt_orr_no:1234567890,anw_cld_mkt_orr_no1:9876543210}),{accountRef:ref,symbol:'005930',date:session.date})
  assert.equal(refs.acceptedMarketOrderId,'1234567890');assert.equal(refs.krxChildMarketOrderId,'9876543210')
  assert.equal(refs.integratedOrderId,undefined)
  const payload=nhCancelInput(refs,{rawAccount,accountRef:ref,symbol:'005930',remainingQuantity:2})
  assert.equal(payload.org_mkt_orr_no,1234567890);assert.equal(payload.cor_qty,2);assert.equal(payload.all_pat_dit_cd,'2')
  assert.throws(()=>nhCancelInput({integratedOrderId:'98765432101'},{rawAccount,symbol:'005930',remainingQuantity:2}),{code:'trading_nh_cancel_scope_invalid'})
  const cancelled=nhCancelReferences(success({mkt_orr_no:1234567891,can_cld_mkt_orr_no1:9876543211}),refs)
  assert.equal(cancelled.cancelMarketOrderId,'1234567891');assert.equal(cancelled.cancelParentMarketOrderId,'1234567890');assert.equal(cancelled.acceptedMarketOrderId,refs.acceptedMarketOrderId)
})

test('NH HTTP-200 business failure, private provider messages and key rotation cannot become read or acceptance success',async()=>{
  assert.throws(()=>nhAcceptedReferences({rsp_cd:'E001',rsp_msg:'주문이 거절되었습니다.',Output_0:{mkt_orr_no:1}},{accountRef:ref,symbol:'005930',date:session.date}),{code:'trading_nh_response_failed'})
  const f=fixture({errorPath:'/krstock/inquiry/v1/balance'})
  await assert.rejects(f.gateway.inspect(f.input),error=>error.code==='trading_nh_read_unavailable'&&!error.message.includes('PRIVATE'))
  const rotated=fixture({loadAccount:async()=>({...account,tradingCredentialEpoch:'new-epoch'})})
  await assert.rejects(rotated.gateway.accounts(rotated.input),{code:'trading_credentials_changed'})
})

test('NH inquiry snapshots never invent market-order mapping, per-fill ids or timestamps from cumulative quantities',async()=>{
  const f=fixture(),rows=await f.gateway.readOrderSnapshots(f.input)
  assert.equal(rows[0].integratedOrderId,'98765432101');assert.equal(rows[0].marketOrderId,null);assert.equal(rows[0].lastFilledAt,null);assert.deepEqual(rows[0].executions,[])
  const restored=await f.gateway.reconcile({...f.input,intents:[{id:'owned-intent',orderNumber:'1234567890',metadata:{references:{acceptedMarketOrderId:'1234567890'}}}]})
  assert.equal(restored.complete,false);assert.equal(restored.orders[0].status,'unknown')
  assert.equal(restored.orders[0].filledQuantity,0)
  assert.throws(()=>normalizeNhOrderSnapshot(snapshot({tot_cns_qty:4}),session.date),{code:'trading_nh_order_snapshot_invalid'})
})
