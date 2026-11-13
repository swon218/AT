import {config} from './config.js'
import {getAuthenticatedCredentials} from './accountSettings.js'
import {createOpenOrderBrokers,publicOpenOrder} from './openOrderBrokers.js'
import {createOrderManagementStore} from './orderManagementStore.js'
import {createOrderReadCoordinator} from './orderReadCoordinator.js'
import {BROKER_IDS,personalAuth,credentialVersion,digest} from './personalBroker.js'
const fail=(code,message,statusCode=409)=>Object.assign(Error(message),{code,statusCode,safeOrderError:true})
const hex=/^[a-f0-9]{64}$/
export function validateManagementInput(p={}){
  if(!['amend','cancel'].includes(p.action)||!hex.test(p.id)||!hex.test(p.version)||!hex.test(p.scope)||!hex.test(p.accountScope)||!/^\w[\w-]{11,79}$/.test(p.requestId)||!/^[a-f0-9]{32}$/.test(p.accountRef))throw fail('invalid_request','주문과 계좌를 다시 선택해 주세요.',400)
  const positive=(v,max)=>/^\d+$/.test(String(v))&&Number.isSafeInteger(Number(v))&&Number(v)>0&&Number(v)<=max
  if(!positive(p.quantity,1000000)||p.action==='amend'&&!positive(p.price,999999999))throw fail('invalid_input','가격·수량을 확인해 주세요.',400)
  // All domestic equity/ETF ticks above KRW 2,000 are multiples of 5.
  // A verified instrument category is required for stricter stock-vs-ETF ticks.
  if(p.action==='amend'&&Number(p.price)>=2000&&Number(p.price)%5)throw fail('invalid_tick','2,000원 이상 주문가격은 최소 5원 단위를 사용합니다. 최종 호가단위는 증권사가 검증합니다.',400)
  return {id:p.id,version:p.version,scope:p.scope,accountScope:p.accountScope,accountRef:p.accountRef,requestId:p.requestId,action:p.action,quantity:Number(p.quantity),...(p.action==='amend'?{price:Number(p.price)}:{})}
}
export function createOpenOrderHandlers({authenticate=getAuthenticatedCredentials,settings=config,brokers=createOpenOrderBrokers(),store=createOrderManagementStore(),now=Date.now}={}){
  const sharedRead=createOrderReadCoordinator({readBroker:async(b,a,_days,ref,signal)=>{
    let marker
    try{marker=await store.call('read_marker',a.user.id,{broker:b})}catch{/* SQL missing must not prevent read-only brokerage access. */}
    signal?.throwIfAborted()
    return {...await brokers.read(b,a,ref,signal),readMarker:marker?.at}
  },timeoutMs:28000})
  async function authorize(request,broker){
    if(!/^Bearer\s+\S+$/i.test(request.headers.authorization||''))throw fail('unauthorized','로그인이 필요합니다.',401)
    if(request.headers.origin&&settings.frontendOrigin&&request.headers.origin!==settings.frontendOrigin)throw fail('origin_forbidden','허용되지 않은 출처입니다.',403)
    if(!BROKER_IDS.includes(broker))throw fail('invalid_broker','증권사를 확인해 주세요.',400)
    const account=await authenticate(request);personalAuth(account,broker);return account
  }
  async function list(request,signal){
    const broker=request.query?.broker,account=await authorize(request,broker),ref=request.query?.accountRef||''
    if(typeof ref!=='string'||ref&&!/^[a-f0-9]{32}$/.test(ref))throw fail('invalid_account','계좌를 다시 선택해 주세요.',400)
    const data=await sharedRead(broker,account,[],ref,signal)
    let locks=[],managementReady=false,managementError=''
    if(data.accountScope)try{
      locks=await store.call('reconcile',account.user.id,{broker,accountScope:data.accountScope,readMarker:data.status==='success'?data.readMarker:null,orders:data.items.map(v=>({scope:v.orderScope,version:v.version}))});managementReady=Boolean(settings[`${broker}OrdersEnabled`])
      if(!managementReady)managementError='서버에서 이 증권사의 주문 변경이 비활성화되어 있습니다.'
    }catch{managementError='주문 관리 저장소를 사용할 수 없습니다. SQL 적용·권한 확인 전에는 조회만 가능합니다.'}
    return {broker,status:data.status,reason:data.reason,pages:data.pages,accounts:data.accounts,selectedAccountRef:data.selectedAccountRef,accountLabel:data.accountLabel,
      accountScope:data.accountScope,asOf:data.asOf,fetchedAt:data.fetchedAt,managementReady,managementError,
      items:data.items.map(v=>{
        const lock=locks.find(l=>l.scope===v.orderScope),ready=managementReady&&data.status==='success'&&!lock
        return {...publicOpenOrder(v),scope:v.orderScope,canAmend:ready&&v.canAmend,canCancel:ready&&v.canCancel,
          ...(lock?{managementNote:lock.state==='accepted'?'변경 요청 접수 후 상태 반영을 기다리고 있습니다.':'결과 확인 필요 · 증권사 앱에서 확인해 주세요. 자동 재전송하지 않습니다.'}:{})}
      })}
  }
  async function manage(request,broker,signal){
    const account=await authorize(request,broker)
    if(!settings[`${broker}OrdersEnabled`])throw fail('orders_disabled','서버에서 주문 변경이 비활성화되어 있습니다.',503)
    const input=validateManagementInput(request.body),auth=personalAuth(account,broker)
    const requestDigest=digest([credentialVersion(account,broker,auth),broker,input])
    const reservation={broker,requestId:input.requestId,digest:requestDigest,scope:input.scope,accountScope:input.accountScope,version:input.version,action:input.action}
    const existing=saved=>{
      if(['accepted','observed'].includes(saved.state))return saved.result
      throw fail('request_already_recorded','이미 기록된 요청입니다. 증권사에서 결과를 확인하세요. 자동 재전송하지 않습니다.')
    }
    const prior=await store.call('lookup',account.user.id,reservation)
    if(prior)return existing(prior)
    let dispatched=false,reserved=false
    try{
      // Never use a cached/shared polling response for a write preflight.
      const fresh=await brokers.read(broker,account,input.accountRef,signal)
      signal?.throwIfAborted()
      const order=fresh.items.find(v=>v.id===input.id)
      if(fresh.status!=='success'||fresh.accountScope!==input.accountScope||!order||order.orderScope!==input.scope||order.version!==input.version)throw fail('order_changed','주문 상태가 변경되었거나 전체 조회에 실패했습니다. 새 목록에서 다시 확인해 주세요.')
      if(!(input.action==='amend'?order.canAmend:order.canCancel))throw fail('operation_unsupported','이 주문의 해당 변경은 지원하지 않습니다. 증권사 앱에서 확인해 주세요.')
      if(input.quantity>order.remainingQuantity||broker==='toss'&&input.action==='cancel'&&input.quantity!==order.remainingQuantity)throw fail('quantity_changed','확인한 잔여수량과 요청 수량을 다시 확인해 주세요.')
      if(input.action==='amend'){
        const stockTick=input.price<2000?1:input.price<5000?5:input.price<20000?10:input.price<50000?50:input.price<200000?100:input.price<500000?500:1000
        const tick=['ETF','ETN'].includes(order.securityType)?(input.price<2000?1:5):order.securityType==='STOCK'?stockTick:null
        if(tick&&input.price%tick)throw fail('invalid_tick',`해당 종목의 주문가격은 ${tick.toLocaleString('ko-KR')}원 단위로 입력해 주세요.`,400)
        if(broker==='toss'&&input.price*input.quantity>3000000000)throw fail('invalid_input','토스 정정 주문금액은 30억원 이하여야 합니다.',400)
      }
      // Reserve only verified scopes. A forged browser scope cannot lock another account.
      const saved=await store.call('reserve',account.user.id,{...reservation,scope:order.orderScope,accountScope:fresh.accountScope})
      if(!saved.fresh)return existing(saved)
      reserved=true
      signal?.throwIfAborted()
      dispatched=true
      const result={...await brokers.submit(broker,account,order,input.action,input),broker,action:input.action,originalOrderNumber:order.orderNumber,requestId:input.requestId}
      await store.call('finish',account.user.id,{...reservation,state:'accepted',result})
      return result
    }catch(error){
      const definite=Boolean(error.definitiveRejection)
      if(reserved)try{await store.call('finish',account.user.id,{...reservation,state:dispatched&&!definite?'uncertain':'rejected',result:{status:dispatched&&!definite?'uncertain':'rejected'}})}catch{/* pending is deliberately not released on persistence failure */}
      if(dispatched&&definite)throw fail('broker_rejected','증권사가 변경 요청을 거절했습니다. 최신 주문을 다시 조회하고 증권사 앱의 거절 사유를 확인해 주세요.',409)
      if(dispatched)throw fail('outcome_uncertain','결과 확인 필요 · 증권사에 접수되었을 수 있습니다. 증권사 앱에서 확인하고 자동·반복 전송하지 마세요.',502)
      if(error.code)throw error
      throw fail('preflight_failed','최신 주문을 확인하지 못했습니다. 목록을 새로 조회해 주세요.',502)
    }
  }
  return {list,manage}
}
export function registerOpenOrderRoutes(app,handlers=createOpenOrderHandlers()){
  const writes=new Set()
  app.addHook('onClose',async()=>{await Promise.allSettled([...writes])})
  const safeCodes=new Set(['unauthorized','origin_forbidden','invalid_broker','invalid_request','invalid_account','invalid_input','invalid_tick','orders_disabled','management_store_unavailable','request_conflict','order_locked','request_already_recorded','order_changed','operation_unsupported','quantity_changed','outcome_uncertain','preflight_failed','broker_rejected'])
  for(const [method,path,fn] of [['get','/api/account/orders/open',(r,s)=>handlers.list(r,s)],['post','/api/orders/:broker/manage',(r,s)=>handlers.manage(r,r.params.broker,s)],
    ['get','/api/order-management',(r,s)=>handlers.list(r,s)],['post','/api/order-management',(r,s)=>handlers.manage(r,r.body?.broker,s)]]){
    app[method](path,{logLevel:'silent',bodyLimit:16000},async(request,reply)=>{
      reply.header('Cache-Control','private, no-store')
      const controller=new AbortController(),abort=()=>controller.abort()
      request.raw.once('aborted',abort);reply.raw.once('close',abort)
      const task=Promise.resolve().then(()=>fn(request,controller.signal))
      if(method==='post')writes.add(task)
      try{return await task}catch(e){
        const rate=e.statusCode===429||e.upstreamStatus===429
        const safe=e.safeOrderError===true&&safeCodes.has(e.code)
        return reply.code(rate?429:([400,401,403,409,503].includes(e.statusCode)?e.statusCode:502)).send({code:safe?e.code:rate?'rate_limited':'open_orders_unavailable',error:safe?e.message:rate?'조회 한도에 도달했습니다. 잠시 후 새로고침해 주세요.':e.statusCode===401?'로그인 세션을 확인해 주세요.':e.statusCode===403?'선택한 증권사의 개인 API를 등록해 주세요.':'증권사 미체결 응답을 확인하지 못했습니다. 빈 목록으로 처리하지 않습니다.'})
      }finally{writes.delete(task);request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',abort)}
    })
  }
}
