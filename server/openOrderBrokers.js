import {requestKiwoomWithCredentials} from './kiwoomClient.js'
import {requestTossWithCredentials} from './tossClient.js'
import {nhClient,validateNhResponse} from './nhClient.js'
import {kbClient} from './kbClient.js'
import {addedBrokerData} from './addedBrokerData.js'
import {httpError,numeric,stockCode,validSymbol} from './brokerHttp.js'
import {accountRef,personalAuth,credentialVersion,digest} from './personalBroker.js'
import {koreanOrderDay} from '../src/utils/orderPeriod.js'

const id=value=>String(value??'').trim()
const count=value=>{const n=numeric(value);return Number.isSafeInteger(n)&&n>=0?n:null}
const buySell=value=>/매수|BUY/i.test(value)?'buy':/매도|SELL/i.test(value)?'sell':null
const list=(value,key,optional=false)=>{if(value[key]===undefined&&optional)return [];if(!Array.isArray(value[key]))throw httpError('주문 응답 형식을 확인할 수 없습니다.');return value[key]}
const nhSuccess=value=>{validateNhResponse(value);if(!/조회.*(?:완료|계속|없)|정상|내역.*없|데이터.*없/.test(value.rsp_msg||value.message?.usr_msg||''))throw httpError('NH 조회 처리 결과를 확인할 수 없습니다.')}
const clock=(day,time)=>/^(?:[01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(id(time))?`${day}T${id(time).slice(0,2)}:${id(time).slice(2,4)}:${id(time).slice(4)}+09:00`:null
const errorKind=e=>e.statusCode===429||e.upstreamStatus===429?'rate_limited':e.name==='TimeoutError'||e.name==='AbortError'||e.statusCode===504?'timeout':'broker_unavailable'

export function normalizeOpenOrder(broker,ref,owner,rawId,values,control){
  const orderNumber=id(rawId)
  if(!/^[a-zA-Z0-9_-]{1,120}$/.test(orderNumber)||!validSymbol(values.symbol)||!['buy','sell'].includes(values.side)||
    !Number.isSafeInteger(values.remainingQuantity)||values.remainingQuantity<0||!Number.isSafeInteger(values.quantity)||values.quantity<values.remainingQuantity||
    (values.filledQuantity!==null&&(!Number.isSafeInteger(values.filledQuantity)||values.filledQuantity<0||values.filledQuantity+values.remainingQuantity>values.quantity)))throw httpError('주문 필수 데이터가 올바르지 않습니다.')
  const item={broker,accountRef:ref,orderNumber,name:'',orderedAt:null,orderPrice:null,priceType:'other',orderType:'기타',exchange:'확인 불가',session:'확인 불가',pending:false,filledQuantity:null,...values}
  item.name=String(item.name||item.symbol).slice(0,80)
  item.id=digest([owner,ref,item.date,orderNumber])
  // Stable across credential rotation; unresolved writes must remain blocked.
  item.orderScope=digest([control.scopeOwner,broker,item.date,orderNumber])
  if(item.priceType==='limit'&&!(Number.isFinite(item.orderPrice)&&item.orderPrice>0))throw httpError('지정가 주문가격을 확인할 수 없습니다.')
  item.version=digest([item.orderScope,item.side,item.symbol,item.quantity,item.filledQuantity,item.remainingQuantity,item.orderPrice,item.orderType,item.exchange,item.session,item.pending,control])
  item.status=item.pending?'처리 중':item.filledQuantity>0?'부분체결':'미체결'
  item.canAmend=Boolean(item.remainingQuantity>0&&!item.pending&&item.priceType==='limit'&&item.session==='정규장'&&control.cash&&control.exchange)
  item.canCancel=Boolean(item.remainingQuantity>0&&!item.pending&&control.cash&&control.exchange)
  item.quantityMode='remaining'
  if(broker==='nh'){
    item.canAmend=false;item.canCancel=false
    item.managementNote='NH 조회의 통합주문번호와 정정·취소용 시장주문번호 연결을 확인 중입니다. 증권사 앱에서 관리해 주세요.'
  }else if(broker==='toss'&&item.filledQuantity>0){
    item.canAmend=false
    item.managementNote='부분체결 정정 수량 기준을 확인 중입니다. 남은 수량 전체 취소는 가능합니다.'
  }else if(!control.cash)item.managementNote='신용·대출 등 특수 주문은 증권사 앱에서 관리해 주세요.'
  else if(item.pending)item.managementNote='증권사에서 변경 요청을 처리 중입니다.'
  else if(!item.canAmend)item.managementNote='이 주문 유형은 취소만 지원하거나 거래소 확인이 필요합니다.'
  return {...item,control:{...control,rawId:orderNumber}}
}

export function publicOpenOrder({control,orderScope,...item}){return item}

export function createOpenOrderBrokers({kiwoom=requestKiwoomWithCredentials,toss=requestTossWithCredentials,nh=nhClient,kb=kbClient,nhAccounts=(auth,signal)=>addedBrokerData.nhAccounts(auth,signal),now=Date.now}={}){
  const names=new Map()
  const kbSymbols=new Map()
  async function read(broker,account,requestedRef='',signal){
    const auth=personalAuth(account,broker),owner=credentialVersion(account,broker,auth),day=koreanOrderDay(now())
    const operation=signal?AbortSignal.any([signal,AbortSignal.timeout(18000)]):AbortSignal.timeout(18000)
    const ref=raw=>accountRef(account,broker,auth,raw)
    let rawAccount='',accounts,selectedAccountRef,accountLabel
    if(broker==='nh'||broker==='toss'){
      let options
      if(broker==='nh')options=await nhAccounts(auth,operation)
      else{
        const result=await toss({...auth,path:'/api/v1/accounts',signal:operation})
        if(result.error||result.success===false)throw httpError('토스 계좌 조회 실패')
        options=list(result,'result').filter(v=>v.accountType==='BROKERAGE'&&/^\d+$/.test(id(v.accountSeq))).map((v,i)=>({id:v.accountSeq,label:`종합매매 계좌 ${i+1}`}))
      }
      accounts=options.map(v=>({id:ref(v.id),label:broker==='nh'?String(v.label).replace(/\d{7,}/g,'****'):v.label}))
      const selected=requestedRef?options.find(v=>ref(v.id)===requestedRef):options.length===1?options[0]:null
      if(selected){rawAccount=selected.id;selectedAccountRef=ref(selected.id);accountLabel=accounts.find(v=>v.id===selectedAccountRef).label}
    }else{selectedAccountRef=ref('linked');accountLabel='API 연결 계좌';accounts=[{id:selectedAccountRef,label:accountLabel}]}
    if(!selectedAccountRef||requestedRef&&requestedRef!==selectedAccountRef)return {status:'accountRequired',items:[],accounts,selectedAccountRef:''}
    const items=new Map();let partial=false,reason='',pages=0
    const add=(rawId,values,control)=>{
      try{const item=normalizeOpenOrder(broker,selectedAccountRef,owner,rawId,{date:day,...values},{...control,scopeOwner:account.user.id});if(item.remainingQuantity>0)items.set(item.id,item)}
      catch{partial=true;reason='invalid_response'}
    }
    try{
      let cursor='',seen=new Set()
      for(let page=0;page<50;page++){
        operation.throwIfAborted();let more=false,next=''
        if(broker==='kiwoom'){
          const result=await kiwoom({...auth,apiId:'ka10075',endpoint:'/api/dostk/acnt',body:{all_stk_tp:'0',trde_tp:'0',stk_cd:'',stex_tp:'0'},returnPage:true,contYn:cursor?'Y':'N',nextKey:cursor,signal:operation,timeoutMs:8000})
          if(String(result.body?.return_code)!=='0')throw httpError('키움 미체결 조회 실패')
          for(const row of list(result.body,'oso',true)){
            const type=id(row.trde_tp),exchange=row.sor_yn==='Y'?'SOR':({'1':'KRX','2':'NXT'})[id(row.stex_tp)]||(['KRX','NXT','SOR'].includes(row.stex_tp_txt)?row.stex_tp_txt:'')
            add(row.ord_no,{symbol:stockCode(row.stk_cd),name:row.stk_nm,side:buySell(row.io_tp_nm),quantity:count(row.ord_qty),remainingQuantity:count(row.oso_qty),filledQuantity:count(row.cntr_qty),
              orderPrice:/시장가/.test(type)?null:numeric(row.ord_pric),priceType:/^(보통|지정가)$/.test(type)?'limit':type==='시장가'?'market':'other',orderType:type,orderedAt:clock(day,row.tm),exchange:exchange||'확인 불가',session:/장시작전|장전/.test(type)?'장전':/장마감후|장후/.test(type)?'장후':'정규장',pending:/취소|정정.*중|거부/.test(row.ord_stt||'')},
              {exchange,cash:!/(신용|융자|대주|공매)/.test(row.io_tp_nm||''),type})
          }
          more=result.contYn==='Y';next=result.nextKey
        }else if(broker==='toss'){
          const result=await toss({...auth,path:'/api/v1/orders',accountSeq:rawAccount,query:{status:'OPEN'},signal:operation})
          if(result.error||result.success===false||!result.result)throw httpError('토스 미체결 조회 실패')
          for(const row of list(result.result,'orders')){
            if(row.currency!=='KRW')continue
            const filled=count(row.execution?.filledQuantity),quantity=count(row.quantity)
            add(row.orderId,{symbol:row.symbol,side:buySell(row.side),quantity,filledQuantity:filled,remainingQuantity:quantity!==null&&filled!==null?quantity-filled:null,orderPrice:row.orderType==='MARKET'?null:numeric(row.price),priceType:row.orderType==='LIMIT'?'limit':row.orderType==='MARKET'?'market':'other',orderType:row.orderType==='LIMIT'?'지정가':row.orderType==='MARKET'?'시장가':'기타',orderedAt:Number.isFinite(Date.parse(row.orderedAt))?row.orderedAt:null,
              date:Number.isFinite(Date.parse(row.orderedAt))?koreanOrderDay(Date.parse(row.orderedAt)):day,exchange:'SOR (투자자 지시)',session:row.timeInForce==='DAY'?'정규장':row.timeInForce==='OPG'?'장전':'기타',pending:!['PENDING','PARTIAL_FILLED'].includes(row.status)},
              {cash:true,exchange:'SOR',timeInForce:row.timeInForce,account:rawAccount,type:row.orderType})
          }
          // Official OPEN is unpaginated. Unexpected pagination is not complete.
          if(result.result.hasNext||result.result.nextCursor){partial=true;reason='unexpected_pagination'}
        }else if(broker==='nh'){
          const result=await nh.request(auth,'/krstock/inquiry/v1/dailyOrderExecution',{orr_dt:day.replaceAll('-',''),act_no:rawAccount,itg_orr_no:0,orr_mkt_cd:'00',ost_cns_dit:'2'},{cts:cursor,signal:operation})
          nhSuccess(result)
          for(const row of list(result,'Output_0',true))add(row.itg_orr_no,{symbol:stockCode(row.iem_cd),name:row.iem_nm,side:buySell(row.sby_dit_cd_nm),quantity:count(row.orr_qty),filledQuantity:count(row.tot_cns_qty),remainingQuantity:count(row.ny_cns_qty),orderPrice:/시장가/.test(row.nmn_pr_tp_cd_nm||'')?null:numeric(row.orr_pr),priceType:/^(보통|지정가)$/.test(row.nmn_pr_tp_cd_nm)?'limit':/시장가/.test(row.nmn_pr_tp_cd_nm||'')?'market':'other',orderType:id(row.nmn_pr_tp_cd_nm),exchange:row.rmt_mkt_cd||'확인 불가'},
            {cash:row.cfd_lon_cd==='00',exchange:row.rmt_mkt_cd,account:rawAccount})
          more=result.hasMore||['00165','00218'].includes(result.rsp_cd);next=result.continuation
        }else{
          const result=await kb.request(auth,'ssqm2341',{ccls_clsf:'2',ordr_dt:day.replaceAll('-',''),nxt_key:cursor},{signal:operation})
          for(const row of list(result,'Record1',Number(result.grid_cnt1)===0)){
            let symbol=stockCode(row.stnd_is_no)
            if(!validSymbol(symbol)&&/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(symbol)){
              // ISIN is NOT a short code: preferred shares cannot be mapped by slicing.
              const key=digest([owner,symbol]);let info=kbSymbols.get(key)
              if(!info||info.expires<now()){
                const detail=await kb.request(auth,'siqm4900',{stnd_is_cd:symbol},{signal:operation})
                if(id(detail.stnd_is_cd)!==symbol||!validSymbol(stockCode(detail.shrt_is_cd)))throw httpError('KB 표준종목번호 변환 응답을 확인할 수 없습니다.')
                info={code:stockCode(detail.shrt_is_cd),expires:now()+300000}
                if(kbSymbols.size>=1000)kbSymbols.delete(kbSymbols.keys().next().value)
                kbSymbols.set(key,info)
              }
              symbol=info.code
            }
            const type=id(row.ordr_ccd),exchange=({K:'KRX',N:'NXT',S:'SOR'})[row.sor_ordr_ccd]||''
            add(row.ordr_no,{symbol,name:row.hngl_shrt_nm,side:buySell(row.trd_dl_ccd_nm),quantity:count(row.ordr_q),filledQuantity:count(row.tl_ccls_q),remainingQuantity:count(row.nccls_q),orderPrice:type==='03'?null:numeric(row.ordr_uprc),priceType:type==='00'?'limit':type==='03'?'market':'other',orderType:({ '00':'지정가','03':'시장가','99':'시간외종가'})[type]||'기타',exchange:exchange||'확인 불가',session:type==='99'?'시간외':'정규장',orderedAt:clock(day,row.ordr_tm),pending:Boolean(row.rfsl_rsn_nm)},
              {cash:/현금|일반/.test(row.gds_typ_dtls_nm||'')&&!/신용|융자|대출|대주/.test(row.gds_typ_dtls_nm||''),exchange,type,session:'1',symbol:id(row.stnd_is_no)})
          }
          more=id(result.cn_clsf)==='1'||Boolean(id(result.nxt_key));next=id(result.nxt_key)
        }
        pages++
        if(!more)break
        if(!next||seen.has(next)||page===49){partial=true;reason='page_limit';break}
        seen.add(next);cursor=next
      }
    }catch(error){if(signal?.aborted)throw error;if(!pages&&!items.size)throw error;partial=true;reason=errorKind(error)}
    if(broker==='toss'&&items.size){
      if(names.size>50)names.delete(names.keys().next().value)
      let catalog=names.get(owner)
      if(!catalog||catalog.expires<now()){catalog={expires:now()+300000,items:new Map()};names.set(owner,catalog)}
      const missing=[...new Set([...items.values()].map(o=>o.symbol))].filter(code=>!catalog.items.has(code))
      try{for(let i=0;i<missing.length;i+=200){
        const result=await toss({...auth,path:'/api/v1/stocks',query:{symbols:missing.slice(i,i+200).join(',')},signal:operation})
        if(result.error||!Array.isArray(result.result))throw Error()
        for(const v of result.result)if(validSymbol(v.symbol)&&typeof v.name==='string')catalog.items.set(v.symbol,{name:v.name,type:v.securityType})
      }}catch{/* Metadata failure never removes an authoritative order; show its code. */}
      for(const o of items.values()){
        const info=catalog.items.get(o.symbol)
        if(info){o.name=info.name.slice(0,80);o.securityType=info.type}
      }
    }
    return {status:partial?'partial':'success',reason,pages,items:[...items.values()],accounts,selectedAccountRef,accountLabel,accountScope:digest([account.user.id,broker,rawAccount||'linked']),asOf:day,fetchedAt:new Date(now()).toISOString()}
  }

  async function submit(broker,account,item,action,input){
    const auth=personalAuth(account,broker),c=item.control,signal=AbortSignal.timeout(12000)
    let number
    if(broker==='kiwoom'){
      const result=await kiwoom({...auth,apiId:action==='amend'?'kt10002':'kt10003',endpoint:'/api/dostk/ordr',retry:false,signal,
        body:{dmst_stex_tp:c.exchange,orig_ord_no:c.rawId,stk_cd:item.symbol,...(action==='amend'?{mdfy_qty:String(input.quantity),mdfy_uv:String(input.price),mdfy_cond_uv:''}:{cncl_qty:String(input.quantity)})}})
      if(String(result.return_code)!=='0')throw httpError('키움 변경 요청 거절')
      number=id(result.ord_no)
    }else if(broker==='toss'){
      const result=await toss({...auth,path:`/api/v1/orders/${encodeURIComponent(c.rawId)}/${action==='amend'?'modify':'cancel'}`,method:'POST',retry:false,signal,accountSeq:c.account,
        body:action==='amend'?{orderType:c.type,quantity:String(input.quantity),price:String(input.price),confirmHighValueOrder:input.quantity*input.price>=100000000}:{}})
      if(result.error)throw Object.assign(httpError('토스 변경 요청 거절'),{definitiveRejection:true})
      if(!result.result)throw httpError('토스 접수 응답 확인 필요')
      number=id(result.result.orderId)
    }else if(broker==='kb'){
      const result=await kb.request(auth,action==='amend'?'ssam1805':'ssam1806',{
        is_cd:c.symbol||item.symbol,orgn_ordr_no:c.rawId,crct_clsf:'1',ordr_q:String(input.quantity),...(action==='amend'?{mkt_tm_clsf:c.session,ordr_uprc:String(input.price),ordr_ccd:c.type,sor_ordr_ccd:c.exchange==='KRX'?'K':c.exchange==='NXT'?'N':'S'}:{})},{write:true,retry:false,signal})
      number=id(result.ordr_no)
    }else throw httpError('NH 정정·취소용 원주문 식별자 확인이 필요합니다.',409)
    if(!/^[a-zA-Z0-9_-]{1,120}$/.test(number)||/^0+$/.test(number))throw httpError('증권사 접수 결과를 확인할 수 없습니다.')
    return {orderNumber:number,status:'accepted',message:'증권사에 요청이 접수되었습니다. 처리 완료 여부는 갱신된 주문 상태와 거래내역에서 확인해 주세요.'}
  }
  return {read,submit}
}
