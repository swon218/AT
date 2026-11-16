import { nhClient, validateNhResponse } from './nhClient.js'
import { createAddedBrokerData } from './addedBrokerData.js'
import { accountRef as makeAccountRef, personalAuth } from './personalBroker.js'
import { tradingCredentialVersion } from './tradingBrokerCommon.js'
import { seoulTimestamp, dateOnly } from '../src/utils/chartTime.js'
import { tradingExecutionPolicy } from '../shared/tradingPolicies.js'

export const NH_TRADING_SOURCE = 'https://www.nhplug.com/openapi-docs/krstock/openapi.json'
export const NH_TRADING_POLICY = Object.freeze(tradingExecutionPolicy('nh'))
const blockedReason='NH 시장주문번호와 통합주문번호의 연결 및 재시작 후 실제 체결시각 복구 계약을 확인하지 못해 자동매매를 시작할 수 없습니다.'
const enabled=value=>typeof value==='function'?value()===true:value===true
const problem=(code,message,statusCode=409)=>Object.assign(new Error(message),{code,statusCode,safeTradingError:true})
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)
const integer=(value,{positive=false}={})=>{
  if(!['string','number'].includes(typeof value)||!/^[+]?\d+$/.test(String(value).replaceAll(',','').trim()))return null
  const n=Number(String(value).replaceAll(',','').trim())
  return Number.isSafeInteger(n)&&n>=(positive?1:0)?n:null
}
const decimal=value=>{
  if(!['string','number'].includes(typeof value)||!/^\d+(?:\.\d{1,6})?$/.test(String(value).replaceAll(',','').trim()))return null
  const n=Number(String(value).replaceAll(',','').trim());return Number.isFinite(n)?n:null
}
const identifier=value=>{
  const s=String(value??'').trim()
  if(!/^\d{1,11}$/.test(s)||!Number.isSafeInteger(Number(s))||Number(s)<=0)return null
  return s.replace(/^0+(?=\d)/,'')
}
const marketIdentifier=value=>{
  const id=identifier(value)
  if(!id||id.length>10)throw problem('trading_nh_market_order_missing','NH 접수 응답의 시장주문번호를 확인할 수 없습니다.')
  return id
}
const symbolCode=value=>String(value??'').trim().replace(/^A(?=[0-9][0-9A-Z]{5}$)/,'')
const validSymbol=value=>/^[0-9][0-9A-Z]{5}$/.test(value)
const dayAt=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at))
const operationSignal=signal=>signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)
const success=value=>{
  if(!object(value))throw problem('trading_nh_response_invalid','NH 업무 응답을 확인할 수 없습니다.')
  try{validateNhResponse(value)}catch{throw problem('trading_nh_response_failed','NH가 조회를 정상 처리하지 않았습니다.')}
  if(!String(value.rsp_cd||'').trim()||!/조회.*(?:완료|계속|없)|정상|내역.*없|데이터.*없/.test(value.rsp_msg||value.message?.usr_msg||''))throw problem('trading_nh_response_invalid','NH 조회의 정상 처리 여부를 확인할 수 없습니다.')
  return value
}
const bounded=(work,signal)=>new Promise((resolve,reject)=>{
  const aborted=()=>reject(signal.reason)
  signal.addEventListener('abort',aborted,{once:true})
  if(signal.aborted){signal.removeEventListener('abort',aborted);reject(signal.reason);return}
  Promise.resolve().then(()=>{signal.throwIfAborted();return work()}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted))
})

export function nhTradingCapabilities({ordersEnabled=false}={}) {
  return {broker:'nh',supported:false,readSupported:true,ordersEnabled:enabled(ordersEnabled),exchange:'KRX',policy:NH_TRADING_POLICY,
    code:'nh_recovery_contract_unverified',reason:blockedReason,source:NH_TRADING_SOURCE,recoveryVerified:false,
    missingContracts:['market_to_integrated_order_mapping','restart_execution_timestamp_recovery']}
}

// The official cash-order response explicitly identifies mkt_orr_no as the
// number required for modify/cancel. No integrated number is manufactured.
export function nhAcceptedReferences(payload,{accountRef,symbol,date,kind='entry'}={}) {
  success(payload)
  const result=payload?.Output_0
  if(!object(result)||!validSymbol(symbol)||!dateOnly(date)||typeof accountRef!=='string'||!/^[a-zA-Z0-9_-]{16,128}$/.test(accountRef))throw problem('trading_nh_acceptance_invalid','NH 주문 접수 범위를 확인할 수 없습니다.')
  const acceptedMarketOrderId=marketIdentifier(result.mkt_orr_no)
  return {version:'nh-order-references-v2',source:'cash_order_response',accountRef,symbol,date,exchange:'KRX',kind,acceptedMarketOrderId,
    originalMarketOrderId:acceptedMarketOrderId,
    ...(result.anw_cld_mkt_orr_no1?{krxChildMarketOrderId:marketIdentifier(result.anw_cld_mkt_orr_no1)}:{})}
}

export function nhCancelInput(references,{rawAccount,accountRef,symbol,remainingQuantity}={}) {
  if(references?.source!=='cash_order_response'||references.exchange!=='KRX'||references.accountRef!==accountRef||references.symbol!==symbol||!/^\d{11}$/.test(rawAccount||'')||integer(remainingQuantity,{positive:true})===null)throw problem('trading_nh_cancel_scope_invalid','실행 소유 NH 시장주문과 취소가능 잔량을 확인할 수 없습니다.')
  const market=marketIdentifier(references.acceptedMarketOrderId)
  if(references.originalMarketOrderId!==market)throw problem('trading_nh_cancel_scope_invalid','NH 원시장주문번호 연결이 일치하지 않습니다.')
  return {act_no:rawAccount,org_mkt_orr_no:Number(market),all_pat_dit_cd:'2',iem_cd:symbol,cor_qty:remainingQuantity}
}

export function nhCancelReferences(payload,parent) {
  success(payload)
  if(parent?.source!=='cash_order_response')throw problem('trading_nh_cancel_scope_invalid','NH 취소 원주문을 확인할 수 없습니다.')
  const cancelMarketOrderId=marketIdentifier(payload?.Output_0?.mkt_orr_no)
  return {...parent,cancelMarketOrderId,cancelParentMarketOrderId:parent.acceptedMarketOrderId,
    ...(payload.Output_0.can_cld_mkt_orr_no1?{cancelKrxChildMarketOrderId:marketIdentifier(payload.Output_0.can_cld_mkt_orr_no1)}:{})}
}

export function normalizeNhOrderSnapshot(row,date) {
  const integratedOrderId=identifier(row?.itg_orr_no),symbol=symbolCode(row?.iem_cd),quantity=integer(row?.orr_qty,{positive:true}),filledQuantity=integer(row?.tot_cns_qty),remainingQuantity=integer(row?.ny_cns_qty),cancelledQuantity=integer(row?.can_qty)
  const averageFilledPrice=decimal(row?.cns_avg_uit_pr),filledNotional=integer(row?.cns_amt)
  const side=/매수|BUY/i.test(row?.sby_dit_cd_nm||'')?'buy':/매도|SELL/i.test(row?.sby_dit_cd_nm||'')?'sell':null
  if(!integratedOrderId||!validSymbol(symbol)||!dateOnly(date)||!side||quantity===null||filledQuantity===null||remainingQuantity===null||cancelledQuantity===null||filledQuantity+remainingQuantity+cancelledQuantity>quantity||filledNotional===null||filledQuantity>0&&!(averageFilledPrice>0))throw problem('trading_nh_order_snapshot_invalid','NH 주문·체결 수량 응답을 확인할 수 없습니다.')
  const rejected=Boolean(String(row.orr_rjt_rsn_cd_nm||'').trim())
  const status=filledQuantity===quantity&&quantity>0?'filled':remainingQuantity>0?filledQuantity>0?'partial':'open':cancelledQuantity>0?'cancelled':rejected?'rejected':'unknown'
  return {integratedOrderId,originalIntegratedOrderId:identifier(row.org_itg_orr_no),symbol,date,side,quantity,filledQuantity,remainingQuantity,cancelledQuantity,averageFilledPrice,filledNotional,
    status,exchange:['KRX','NXT','SOR'].includes(row.rmt_mkt_cd)?row.rmt_mkt_cd:'unknown',
    marketOrderId:null,lastFilledAt:null,executions:[],recoveryVerified:false}
}

export function parseNhTradingQuote(payload,symbol,session,now=Date.now()) {
  success(payload)
  if(!validSymbol(symbol)||payload.Output_1?.iem_cd!==symbol||!session||session.date!==dayAt(now)||session.market&&session.market!=='KRX'||!Number.isFinite(Date.parse(session.open))||!Number.isFinite(Date.parse(session.close)))throw problem('trading_nh_quote_invalid','NH KRX 시세의 종목·거래일을 확인할 수 없습니다.')
  const rows=payload.Output_0
  if(!Array.isArray(rows)||!rows.length)throw problem('trading_nh_quote_missing','NH 실제 체결 시세가 없습니다.')
  const valid=rows.map(row=>{
    const time=String(row?.bsop_hour||'').replaceAll(':','')
    const stamp=/^\d{6}$/.test(time)?seoulTimestamp(session.date,time):null,price=integer(row?.stck_prpr,{positive:true})
    return stamp!==null&&price?{stamp:stamp*1000,price}:null
  }).filter(Boolean).sort((a,b)=>b.stamp-a.stamp)
  const last=valid[0]
  if(!last||last.stamp>=Date.parse(session.close)||last.stamp<Date.parse(session.open)||last.stamp>now||now-last.stamp>15000)throw problem('trading_nh_quote_stale','NH 최신 정규장 체결 시각을 확인할 수 없습니다.')
  return {symbol,exchange:'KRX',price:last.price,observedAt:new Date(last.stamp).toISOString(),fresh:true,halted:null,timestampBasis:'current_session_date_and_provider_execution_clock'}
}

export function createTradingNhGateway({settings={},nh=nhClient,data=createAddedBrokerData({nh}),now=Date.now,loadAccount}={}) {
  function scope(input) {
    if(input.broker&&input.broker!=='nh')throw problem('trading_nh_broker_invalid','NH 전용 조회입니다.',400)
    let auth
    try{auth=personalAuth(input.account,'nh')}catch{throw problem('trading_nh_credentials_missing','NH 개인 API를 등록해 주세요.',403)}
    if(input.symbol!==undefined&&!validSymbol(input.symbol))throw problem('trading_symbol_invalid','국내주식 종목코드를 확인해 주세요.',400)
    const version=tradingCredentialVersion(input.account,'nh',auth)
    if(input.expectedCredentialVersion&&input.expectedCredentialVersion!==version)throw problem('trading_credentials_changed','NH 개인 API가 변경되었습니다.')
    return {auth,version}
  }
  async function read(auth,path,body,signal,cts='') {
    try{return success(await bounded(()=>nh.request(auth,path,body,{signal,cts,retry:false}),signal))}
    catch(error){if(error.safeTradingError)throw error;throw problem('trading_nh_read_unavailable','NH 개인 API 조회를 완료하지 못했습니다.',502)}
  }
  async function ownAccounts(input,signal) {
    const {auth,version}=scope(input),result=await read(auth,'/n2/acctinfo',{},signal)
    const raw=(Array.isArray(result.Output_0)?result.Output_0:[]).filter(row=>(nh.simulated?['03']:['01','02']).includes(row?.acct_type)&&/^\d{11}$/.test(row.acct_no||''))
    if(!raw.length)throw problem('trading_nh_accounts_missing','NH 개인 API의 본인 계좌를 확인할 수 없습니다.')
    const rows=raw.map((row,i)=>({raw:row.acct_no,ref:makeAccountRef(input.account,'nh',auth,row.acct_no),label:`NH 계좌 ${i+1}`}))
    if(new Set(rows.map(row=>row.ref)).size!==rows.length)throw problem('trading_nh_accounts_invalid','NH 계좌 목록이 중복되어 확인이 필요합니다.')
    return {auth,version,rows}
  }
  async function selected(input,signal) {
    const own=await ownAccounts(input,signal),chosen=input.accountRef?own.rows.find(row=>row.ref===input.accountRef):own.rows.length===1?own.rows[0]:null
    if(input.accountRef&&!chosen)throw problem('trading_account_scope_invalid','본인 API의 NH 계좌를 선택해 주세요.',403)
    return {...own,chosen,accounts:own.rows.map(({ref,label})=>({ref,label}))}
  }
  async function freshOwner(input,version) {
    if(!loadAccount)return
    try{
      const latest=await loadAccount(input.account.user.id)
      if(latest?.user?.id===input.account.user.id&&tradingCredentialVersion(latest,'nh')===version)return
    }catch{ /* No provider or storage message escapes this boundary. */ }
    throw problem('trading_credentials_changed','조회 중 NH 개인 API가 변경되었습니다.')
  }
  async function snapshots(own,input,signal) {
    const day=dateOnly(input.date||dayAt(now()))
    if(!day)throw problem('trading_nh_date_invalid','NH 주문 조회일을 확인해 주세요.',400)
    let cts='',rows=[],seen=new Set()
    for(let page=0;page<50;page++) {
      const result=await read(own.auth,'/krstock/inquiry/v1/dailyOrderExecution',{orr_dt:day.replaceAll('-',''),act_no:own.chosen.raw,itg_orr_no:0,orr_mkt_cd:'00',ost_cns_dit:'0'},signal,cts)
      if(result.Output_0!==undefined&&!Array.isArray(result.Output_0))throw problem('trading_nh_order_snapshot_invalid','NH 주문 목록 형식을 확인할 수 없습니다.')
      if(result.Output_0===undefined&&!/내역.*없|데이터.*없|조회.*없/.test(result.rsp_msg||''))throw problem('trading_nh_order_snapshot_missing','NH 빈 주문 응답의 정상 여부를 확인할 수 없습니다.')
      rows.push(...(result.Output_0||[]).map(row=>normalizeNhOrderSnapshot(row,day)))
      if(!result.hasMore&&!['00165','00218'].includes(result.rsp_cd))break
      if(!result.continuation||seen.has(result.continuation)||page===49)throw problem('trading_nh_history_incomplete','NH 주문 연속조회를 완료하지 못했습니다.')
      seen.add(result.continuation);cts=result.continuation
    }
    const unique=new Map()
    for(const row of rows){const previous=unique.get(row.integratedOrderId);if(previous&&JSON.stringify(previous)!==JSON.stringify(row))throw problem('trading_nh_history_conflict','NH 페이지 사이 주문 상태가 달라 재확인이 필요합니다.');unique.set(row.integratedOrderId,row)}
    return [...unique.values()]
  }
  const capabilities=()=>nhTradingCapabilities({ordersEnabled:settings.nhOrdersEnabled})
  async function accounts(input) {
    const signal=operationSignal(input.signal),own=await selected(input,signal)
    await freshOwner(input,own.version)
    return {accounts:own.accounts,accountRequired:!own.chosen,accountRef:own.chosen?.ref||'',credentialVersion:own.version}
  }
  async function inspect(input) {
    const signal=operationSignal(input.signal),own=await selected(input,signal)
    if(!own.chosen){await freshOwner(input,own.version);return {accounts:own.accounts,accountRequired:true,accountRef:'',credentialVersion:own.version,complete:false,eligible:false,reason:'trading_account_required',cashAvailable:null,holdingQuantity:null,averagePrice:null,openOrders:[]}}
    let cts='',seen=new Set(),rows=[],total=null
    for(let page=0;page<50;page++) {
      const result=await read(own.auth,'/krstock/inquiry/v1/balance',{act_no:own.chosen.raw,bnc_bse_cd:'1',ltg_aot_dit_cd:'9',aet_bse:'1',qut_dit_cd:'KRX',aly_qut_cd:'1'},signal,cts)
      if(object(result.Output_0))total=result.Output_0
      if(result.Output_1!==undefined&&!Array.isArray(result.Output_1))throw problem('trading_nh_balance_invalid','NH 잔고 응답을 확인할 수 없습니다.')
      if(result.Output_1===undefined&&!(total&&integer(total.tot_byn_amt)===0&&integer(total.tot_eal_amt)===0)&&!rows.length)throw problem('trading_nh_balance_missing','NH 보유정보가 누락되었습니다.')
      rows.push(...(result.Output_1||[]))
      if(!result.hasMore&&!['00165','00218'].includes(result.rsp_cd))break
      if(!result.continuation||seen.has(result.continuation)||page===49)throw problem('trading_nh_balance_incomplete','NH 잔고 연속조회를 완료하지 못했습니다.')
      seen.add(result.continuation);cts=result.continuation
    }
    if(!total||integer(total.tot_byn_amt)===null||integer(total.tot_eal_amt)===null)throw problem('trading_nh_balance_missing','NH 최종 잔고 합계를 확인할 수 없습니다.')
    const matching=rows.filter(row=>symbolCode(row.iem_cd)===input.symbol)
    if(matching.length>1)throw problem('trading_nh_holding_ambiguous','NH 동일 종목의 복수 보유 구분을 자동으로 합산하지 않습니다.')
    const row=matching[0],holdingQuantity=row?integer(row.itg_bnc_qty):0,averagePrice=row?decimal(row.phs_pr):null
    if(holdingQuantity===null||holdingQuantity>0&&!(averagePrice>0))throw problem('trading_nh_holding_invalid','NH 현재 보유수량과 평균 매입가를 확인할 수 없습니다.')
    if(row&&!/^(?:현금|일반|보통|CASH)/i.test(String(row.tp_cd_nm||'')))throw problem('trading_nh_holding_type_unknown','NH 현금 보유 구분을 확인할 수 없습니다.')
    const price=input.price>0?input.price:0
    const power=await read(own.auth,'/krstock/inquiry/v1/buyableQuantity',{ost_dit_cd:'1',act_no:own.chosen.raw,iem_cd:input.symbol,nmn_pr_tp_cd:price?'01':'05',orr_pr:price,cfd_lon_cd:'',lon_dt:''},signal)
    const sell=await read(own.auth,'/krstock/inquiry/v1/sellableQuantity',{act_no:own.chosen.raw,iem_cd:input.symbol,lon_dt:'',cfd_lon_cd:'00'},signal)
    const cashAvailable=integer(power.Output_0?.csh_orr_pbl_amt),buyableQuantity=integer(power.Output_0?.csh_orr_pbl_qty),sellableQuantity=integer(sell.Output_0?.sll_pbl_qty)
    if(cashAvailable===null||buyableQuantity===null||sellableQuantity===null)throw problem('trading_nh_cash_unknown','NH 미수 없는 현금 주문가능금액·수량을 확인할 수 없습니다.')
    const orders=await snapshots(own,input,signal)
    await freshOwner(input,own.version)
    return {broker:'nh',accountRef:own.chosen.ref,accounts:own.accounts,credentialVersion:own.version,complete:true,eligible:true,reason:null,
      holdingQuantity,averagePrice,sellableQuantity,cashAvailable,buyableQuantity,
      openOrders:orders.filter(row=>['open','partial'].includes(row.status)).map(row=>({...row,orderNumber:null,accountRef:own.chosen.ref})),
      orderRecoverySupported:false,recoveryReason:blockedReason,fetchedAt:new Date(now()).toISOString()}
  }
  async function quote(input) {
    const signal=operationSignal(input.signal),{auth,version}=scope(input)
    const payload=await read(auth,'/krstock/quote/v1/currentExecution',{market_cd:'KRX',iem_cd:input.symbol,array_cnt:'20',view_main_yn:'Y'},signal)
    const result=parseNhTradingQuote(payload,input.symbol,input.session,now())
    await freshOwner(input,version)
    return result
  }
  async function candles(input) {
    const {auth,version}=scope(input),signal=operationSignal(input.signal)
    const own=await selected(input,signal)
    if(!own.chosen)throw problem('trading_account_required','NH 계좌를 선택해 주세요.')
    const result=await bounded(()=>data.candleResponse('nh',input.symbol,input.interval||'일',500,auth,{market:'KRX',includeExtended:false,cacheScope:`trading:${input.account.user.id}:${version}`,signal}),signal)
    if(result.meta?.source!=='nh'||result.meta.market!=='KRX'||result.meta.fallback||result.meta.invalidRows>0)throw problem('trading_nh_chart_invalid','NH 개인 KRX 차트 응답을 확인할 수 없습니다.')
    await freshOwner(input,version)
    return {candles:result.items,metadata:{...result.meta,sourceBroker:'nh',personal:true}}
  }
  async function readOrderSnapshots(input) {
    const signal=operationSignal(input.signal),own=await selected(input,signal)
    if(!own.chosen)throw problem('trading_account_required','NH 계좌를 선택해 주세요.')
    const rows=await snapshots(own,input,signal);await freshOwner(input,own.version);return rows
  }
  const noWrite=async()=>({status:'rejected',notTransmitted:true,code:'trading_nh_recovery_contract_unverified'})
  async function reconcile(input) {
    scope(input)
    return {complete:false,reason:'nh_recovery_contract_unverified',orders:(input.intents||[]).map(intent=>({intentId:intent.id,status:'unknown',orderNumber:intent.orderNumber,filledQuantity:intent.cumulative_quantity||0,filledNotional:intent.cumulative_notional||0,executions:[]}))}
  }
  return {capabilities,accounts,inspect,quote,candles,readOrderSnapshots,submit:noWrite,cancel:noWrite,reconcile}
}
