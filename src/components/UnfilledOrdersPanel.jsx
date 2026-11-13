import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {useOpenOrders} from '../hooks/useOpenOrders'
import {openOrdersRequest} from '../services/openOrdersApi'
import {getBroker} from '../utils/brokers'
import './UnfilledOrdersPanel.css'
const number=v=>v==null?'—':Number(v).toLocaleString('ko-KR')
const price=o=>o.priceType==='market'?'시장가':o.orderPrice==null?'—':`${number(o.orderPrice)}원`
const time=value=>value?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'시각 미제공'
function ManagementDialog({order,action,broker,data,api,onClose,onFinished}){
  const [quantity,setQuantity]=useState(String(order.remainingQuantity)),[newPrice,setNewPrice]=useState(String(order.orderPrice??''))
  const [review,setReview]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[sent,setSent]=useState(false)
  const dialog=useRef(null),busy=useRef(false),controller=useRef(null),mounted=useRef(true)
  const requestId=useRef(globalThis.crypto.randomUUID()).current,label=action==='amend'?'정정':'취소'
  const partialCancel=action==='cancel'&&broker!=='toss'
  const valid=/^\d+$/.test(quantity)&&Number(quantity)>0&&Number(quantity)<=order.remainingQuantity&&(action==='cancel'||/^\d+$/.test(newPrice)&&Number(newPrice)>0)
  useEffect(()=>{
    mounted.current=true
    const opener=document.activeElement
    dialog.current.querySelector('button,input')?.focus()
    const keys=e=>{
      if(e.key==='Escape'&&!busy.current){e.preventDefault();onClose()}
      if(e.key==='Tab'){
        const nodes=[...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled)')],first=nodes[0],last=nodes.at(-1)
        if(!nodes.length){e.preventDefault();dialog.current.focus();return}
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
      }
    }
    document.addEventListener('keydown',keys)
    return()=>{mounted.current=false;controller.current?.abort();document.removeEventListener('keydown',keys);opener?.isConnected&&opener.focus()}
  },[])
  const submit=async()=>{
    if(busy.current||sent||!review||!valid)return
    busy.current=true;setPending(true);setSent(true);controller.current=new AbortController()
    try{
      const result=await api(broker,{input:{id:order.id,version:order.version,scope:order.scope,accountScope:data.accountScope,accountRef:order.accountRef,requestId,action,quantity:Number(quantity),...(action==='amend'?{price:Number(newPrice)}:{})},signal:controller.current.signal})
      if(mounted.current)onFinished(result)
    }catch(e){if(mounted.current){setError(e.message);onFinished(null,e)}}
    finally{busy.current=false;if(mounted.current)setPending(false)}
  }
  return createPortal(<div className="auth-overlay open-order-overlay" onMouseDown={e=>{if(e.target===e.currentTarget&&!pending)onClose()}}>
    <section ref={dialog} tabIndex={-1} className="open-order-dialog" role="dialog" aria-modal="true" aria-labelledby="manage-order-title">
      <h2 id="manage-order-title">{review?`최종 확인 · ${label} 요청`:`주문 ${label}`}</h2>
      <p>{getBroker(broker).name} · {data.accountLabel} · {order.name} ({order.symbol})</p>
      <p>{order.side==='buy'?'매수':'매도'} · 원주문 {order.orderNumber} · {order.exchange} · {order.session}</p>
      <dl><dt>현재 주문</dt><dd>{price(order)} · 주문 {number(order.quantity)}주 / 체결 {number(order.filledQuantity)}주 / 잔여 {number(order.remainingQuantity)}주</dd></dl>
      {!review?<>
        {action==='amend'&&<label>변경 후 지정가 (원)<input type="text" inputMode="numeric" value={newPrice} onChange={e=>setNewPrice(e.target.value.replace(/[^0-9]/g,''))}/></label>}
        <label>{action==='amend'?(broker==='toss'?'변경 후 주문수량':'정정할 잔여수량'):'취소할 잔여수량'} (주)<input type="text" inputMode="numeric" value={quantity} disabled={action==='cancel'&&!partialCancel} onChange={e=>setQuantity(e.target.value.replace(/[^0-9]/g,''))}/></label>
        <p>체결된 수량은 변경할 수 없습니다. {broker==='toss'?(action==='cancel'?'토스는 남은 수량 전체 취소만 지원합니다.':'토스는 미체결 주문의 변경 후 주문수량을 입력합니다. 부분체결 주문의 정정은 지원하지 않습니다.'):'입력한 수량에만 변경을 요청하며, 나머지 잔여수량은 유지됩니다.'}</p>
        {action==='amend'&&<p>지정가·정규장 유형을 유지합니다. 호가단위, 거래소·주문 가능 여부는 증권사가 최종 검증합니다.</p>}
      </>:<><p className="open-order-review">{action==='amend'?`${price(order)} → ${number(newPrice)}원 · ${broker==='toss'?`수량 ${number(order.remainingQuantity)} → ${number(quantity)}주`:`잔여 중 ${number(quantity)}주 정정`}`:`남은 ${number(order.remainingQuantity)}주 중 ${number(quantity)}주 취소`}</p><p>전송 직전 다시 조회합니다. 상태가 달라지면 전송하지 않으며 입력값을 임의로 바꾸지 않습니다. 접수와 처리 완료는 다릅니다.</p></>}
      {pending&&<p role="status">증권사에 요청 전송 중…</p>}
      {error&&<p role="alert" className="open-order-error">{error}</p>}
      <div className="open-order-actions"><button type="button" disabled={pending} onClick={onClose}>확인 창 닫기</button>
        {!sent&&(review?<><button type="button" onClick={()=>setReview(false)}>입력 수정</button><button type="button" disabled={pending||!valid} onClick={submit}>{pending?'전송 중…':`${label} 요청 확정`}</button></>:<button type="button" disabled={!valid} onClick={()=>setReview(true)}>다음 · 최종 확인</button>)}
      </div>
    </section></div>,document.body)
}
export default function UnfilledOrdersPanel({broker,userId,credentialVersion,accountRef='',authenticated,brokerConfigured,onAccountChange,onAccountRefresh,api=openOrdersRequest}){
  const enabled=Boolean(authenticated&&brokerConfigured&&userId),state=useOpenOrders({broker,userId,credentialVersion,accountRef,enabled,api,onAccountRefresh})
  const [draft,setDraft]=useState(null),[receipt,setReceipt]=useState('')
  const data=state.data,items=data?.items||[],blocked=state.loading||state.stale||data?.status!=='success'
  if(!enabled)return <div className="open-orders"><p>{authenticated?'선택한 증권사의 개인 API를 등록해 주세요.':'로그인 후 본인 계좌의 미체결 주문을 확인할 수 있습니다.'}</p></div>
  return <section className="open-orders" aria-label="본인 계좌 전체 종목 미체결">
    <div className="open-orders-toolbar"><span>전체 종목 · {getBroker(broker).name}</span><button type="button" onClick={state.refresh} disabled={state.loading}>새로고침</button></div>
    {data?.accounts?.length>1&&<label>미체결 조회·관리 계좌<select aria-label="미체결 조회·관리 계좌" value={data.selectedAccountRef||''} onChange={e=>onAccountChange?.(e.target.value)}><option value="">계좌 선택</option>{data.accounts.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select></label>}
    <p className="open-orders-meta">{data?.fetchedAt?`마지막 조회 ${time(data.fetchedAt)} · ${data.asOf} 기준`:'아직 조회하지 않았습니다.'} · 화면이 보일 때 30초마다 갱신</p>
    {state.loading&&<p role="status">미체결 주문 조회 중…</p>}
    {state.error&&<p role="alert" className="open-order-error">조회 실패 · {state.error}</p>}
    {state.stale&&data&&<p role="status">오래된 조회 결과 · 새 조회 성공 전에는 변경할 수 없습니다.</p>}
    {data?.status==='accountRequired'&&<p>본인 계좌를 선택해 주세요.</p>}
    {data?.status==='partial'&&<p role="status" className="open-order-error">일부 조회 · {data.reason==='rate_limited'?'조회 한도에 도달했습니다.':'모든 페이지를 확인하지 못했습니다.'} 확인된 주문만 표시하며 변경은 제한합니다.</p>}
    {data?.managementError&&<p role="status">{data.managementError}</p>}
    {receipt&&<p role="status" className="open-order-receipt">{receipt}</p>}
    {data?.status==='success'&&!items.length&&!state.error&&<p>미체결 주문이 없습니다.</p>}
    {items.length>0&&<div className="open-orders-scroll" tabIndex={0} role="region" aria-label="미체결 주문 표 · 가로 세로 스크롤"><table><thead><tr>{['종목 / 주문','매매 / 유형','가격','주문 / 체결 / 잔여','거래소 / 장','주문 관리'].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>{items.map(o=><tr key={o.id}>
      <td><strong>{o.name}</strong><small>{o.symbol} · {time(o.orderedAt)}</small><small>주문 {o.orderNumber}</small></td><td className={o.side}>{o.side==='buy'?'매수':'매도'}<small>{o.orderType} · {o.status}</small></td><td>{price(o)}</td><td>{number(o.quantity)} / {number(o.filledQuantity)} / <b>{number(o.remainingQuantity)}</b>주</td><td>{o.exchange}<small>{o.session}</small></td>
      <td><div className="open-order-actions"><button type="button" disabled={blocked||!o.canAmend} onClick={()=>setDraft({order:o,action:'amend',data})} aria-label={`${o.name} 주문 정정`}>정정</button><button type="button" disabled={blocked||!o.canCancel} onClick={()=>setDraft({order:o,action:'cancel',data})} aria-label={`${o.name} 주문 취소`}>취소</button></div>{o.managementNote&&<small className="open-order-note">{o.managementNote}</small>}</td>
    </tr>)}</tbody></table></div>}
    <p className="open-orders-meta">키움·NH·KB: 당일 미체결. 토스: 제공되는 국내 OPEN 주문. 주문 시각 미제공 시 임의 시각을 만들지 않습니다. 접수 결과 불명 시 증권사 앱에서 확인하세요.</p>
    {draft&&<ManagementDialog {...draft} broker={broker} api={api} onClose={()=>setDraft(null)} onFinished={(result,error)=>{if(result){setReceipt(`${result.message} 원주문 ${result.originalOrderNumber} → 접수번호 ${result.orderNumber}`);setDraft(null)}else setReceipt(error.message);state.afterRequest()}}/>}
  </section>
}
