import { useEffect, useRef, useState } from 'react'
import { Play, Square, RefreshCw, ShieldAlert } from 'lucide-react'
import { tradingApi } from '../services/tradingApi'
import { tradingReadiness, tradingPerformance, tradingThresholds, tradingReason } from '../../shared/tradingV1.js'
import TradingViewChart from './TradingViewChart'
import './TradingAgentPanel.css'

const names={kiwoom:'키움',toss:'토스',nh:'NH',kb:'KB'},brokers=Object.keys(names)
const phases={waiting_signal:'신호 대기',waiting_funds:'자금 부족 대기',buying:'매수 주문 확인 중',buy_open:'매수 미체결',buy_partial:'매수 부분체결',holding:'보유 중',selling:'매도 주문 확인 중',sell_open:'매도 미체결',sell_partial:'매도 부분체결',closed:'청산 완료',completed:'실행 완료',stopping:'정지 처리 중 · 보유분 관리 중',stopped:'정지',unknown:'접수 결과 불명확',reconciliation_required:'정합성 확인 필요',connection_required:'연결 장애 · 보유분 관리 불가',market_closed:'시장 종료 대기',missed_open:'개장 진입 기회 놓침'}
const money=value=>Number.isFinite(Number(value))&&value!==null&&value!==undefined?new Intl.NumberFormat('ko-KR',{maximumFractionDigits:4}).format(Number(value)):'—'
const eventLabels={fill_confirmed:'체결 수량·평균가 확인',entry_cancel_requested:'소유 미체결 진입 잔량 취소 요청',order_accepted:'주문 접수 확인',order_rejected:'주문 거부 확인 · 자동 재시도 안 함',order_unknown:'주문 결과 불명 · 재전송 차단',started:'실행 시작',stop_requested:'정지 요청',abandon_requested:'보유분 관리 중단 요청'}
const intentLabels={prepared:'전송 준비',sending:'접수 확인 중',accepted:'접수·미체결',partial:'부분체결',filled:'체결 완료',cancelled:'취소 확인',rejected:'거부 확인',unknown:'결과 불명'}
const active=session=>session && !['stopped','completed'].includes(session.status)
const initial=code=>({code,broker:'',accountRef:'',strategyId:'',strategyRevision:0,quantity:1,quantityMode:'fixed',entryAction:'',manageQuantity:1})
const savedFor=(data,code)=>data?.configs?.find(row=>row.code===code)
const sessionFor=(data,code)=>data?.sessions?.find(row=>row.code===code)
function selectedRun(data,id) {
  const session=data.sessions.find(row=>row.id===id)
  if(session)return session
  const config=data.configs.find(row=>`config:${row.id}`===id)
  const latest=config&&data.sessions.find(row=>row.config_id===config.id)
  if(latest)return latest
  return config?{id:config.id,code:config.code,broker:config.spec.broker,account_ref:config.spec.accountRef,configOnly:true,snapshot:{spec:config.spec,strategy:data.strategies.find(s=>s.id===config.spec.strategyId)},state:{}}:null
}
const phase=session=>session?.stop_requested&&active(session)?'stopping':session?.state?.phase || session?.status
const when=value=>value?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'medium'}).format(new Date(value)):'—'

function Confirmation({value,busy,onClose,onConfirm}) {
  const dialog=useRef(null),origin=useRef(document.activeElement)
  useEffect(()=>{dialog.current.showModal();return()=>{dialog.current?.close();origin.current?.isConnected&&origin.current.focus()}},[])
  const stop=value.kind==='stop'
  return <dialog className="trading-confirm" ref={dialog} aria-labelledby="trading-confirm-title" onCancel={event=>{event.preventDefault();if(!busy)onClose()}} onClick={event=>{if(event.target===dialog.current&&!busy)onClose()}}>
    <h2 id="trading-confirm-title">{stop?'자동매매 정지 확인':'저장된 설정 실행 확인'}</h2>
    {stop?<><p>신규 진입을 중단하고 이 실행의 미체결 매수 주문만 취소·확인합니다. 이미 체결된 보유분은 익절·손절 관리를 계속합니다.</p><p>정지는 강제 매도를 실행하지 않습니다.</p>
      <label className="trading-abandon"><input type="checkbox" checked={value.abandon} onChange={event=>value.change(event.target.checked)} disabled={busy}/>보유분 관리까지 중단합니다. 주식은 계좌에 남으며 자동 익절·손절이 중단됩니다.</label></>
      :<><p><strong>{value.mode==='LIVE'?'LIVE · 실제 주문':'PAPER · 가상 실행'}</strong> · 시작 확인은 5분 동안 유효하며 시작 직전에 계좌 상태를 다시 확인합니다.</p>{value.previews.map(item=><article key={item.id} className="trading-confirm-row"><h3>{value.byCode[item.summary.code] || item.summary.code} · {names[item.summary.broker]}</h3><p>{item.summary.accountLabel} · {item.summary.strategy.name} v{item.summary.strategy.revision}</p><p>{item.summary.spec.quantityMode==='all_cash'?'주문가능 현금 전체 사용 (다른 종목의 진입을 막을 수 있음)':`${item.summary.spec.quantity}주 고정`} · {item.summary.spec.entryAction==='once'?'최초 신규 1회 매수 후 관리':item.summary.spec.entryAction==='manage'?`기존 ${item.summary.spec.manageQuantity}주 관리 · 새 매수 없음`:'확정 일봉 신호 · 다음 허용 개장 기회'}</p>{item.summary.holding&&<p>확인 보유분 {item.summary.holding.quantity}주 · 평균 {money(item.summary.holding.averagePrice)}원</p>}<p>진입: {item.summary.entryMethod}<br/>청산: {item.summary.exitMethod}<br/>{item.summary.session} · {item.summary.stopPolicy}</p></article>)}<p>조건 도달은 체결가를 보장하지 않습니다. 실제 수수료·세금이 미확정이면 성과는 비용 미반영 손익입니다.</p></>}
    <div className="trading-actions"><button type="button" disabled={busy} onClick={onClose}>취소</button><button type="button" className="primary" disabled={busy} onClick={onConfirm}>{busy?'처리 중…':stop?'정지 확인':'위 내용으로 시작'}</button></div>
  </dialog>
}

function RunDetails({session,intents,events}) {
  if(!session)return null
  const s=session.state||{},p=s.position,average=p?.averagePrice??(p?.quantity>0?Number(p.costMicros)/1e6/p.quantity:null)
  const quantity=p?.quantity||0,risk=session.snapshot?.strategy?.backtest_settings||{},thresholds=quantity?tradingThresholds(p,risk):null
  const freshMark=Number.isFinite(Date.parse(s.markAt))&&Date.now()-Date.parse(s.markAt)<=30000&&!['connection_required','reconciliation_required','unknown'].includes(session.status)
  const perf=tradingPerformance(s,freshMark?s.markPrice:null)
  return <div className="trading-details"><h3>{phases[phase(session)]||phase(session)||'저장됨'} <small>{session.mode}</small></h3><p>{names[session.broker]} · 본인 API 연결 계좌 · {session.snapshot?.strategy?.name} v{session.snapshot?.strategy?.revision}</p>
    <p>최근 확인 {when(s.checkedAt||session.updated_at)} {s.reason&&<span className="trading-reason">{tradingReason[s.reason]||(s.reason==='order_rejected'?'주문이 거부되었습니다. 자동 재시도하지 않습니다. 계좌와 설정을 확인해 주세요.':s.reason)}</span>}</p>
    <dl><div><dt>보유수량</dt><dd>{quantity}주</dd></div><div><dt>평균 진입가</dt><dd>{money(average)}원</dd></div><div><dt>익절 기준</dt><dd>{money(thresholds?.takeProfitPrice)}원</dd></div><div><dt>손절 기준</dt><dd>{money(thresholds?.stopLossPrice)}원</dd></div><div><dt>진입 / 완료</dt><dd>{perf.entries} / {perf.closedTrades}</dd></div><div><dt>실현손익</dt><dd>{money(perf.realizedPnl)}원</dd></div><div><dt>미실현손익</dt><dd>{money(perf.unrealizedPnl)}원</dd></div><div><dt>익절 / 손절</dt><dd>{perf.takeProfits} / {perf.stopLosses}</dd></div></dl>
    <small>해당 실행 소유·인수분만 집계 · 비용 미확정/미반영 · 시세 조회 간 가격 도달을 놓칠 수 있습니다. 시세 기준 {when(s.markAt)}{!freshMark&&' · 최신 평가손익 미확인'}</small>
    <h4>주문·체결</h4>{intents.length?<div className="trading-table-scroll"><table><thead><tr><th>구분</th><th>수량</th><th>확인 체결</th><th>상태</th></tr></thead><tbody>{intents.map(row=><tr key={row.id}><td>{row.side==='buy'?'매수':'매도'}</td><td>{row.quantity}</td><td>{row.cumulative_quantity??row.filled_quantity??0}</td><td>{intentLabels[row.status]||row.status}</td></tr>)}</tbody></table></div>:<p>이 실행의 주문 기록이 없습니다.</p>}
    <h4>실행 이벤트</h4><ol className="trading-events">{events.length?events.map(row=><li key={row.id}><time>{when(row.created_at)}</time> {eventLabels[row.code||row.kind]||row.code||row.kind}</li>):<li>이벤트가 없습니다.</li>}</ol>
  </div>
}

function RunChart({session,data,userId,api}) {
  const [period,setPeriod]=useState('일'),[history,setHistory]=useState(false),[focusedTrade,setFocusedTrade]=useState(null),[chart,setChart]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false)
  useEffect(()=>{setHistory(false)},[session.id])
  useEffect(()=>{
    const controller=new AbortController();setChart(null);setError('');setLoading(true)
    api(`/chart?${session.configOnly?'configId':'sessionId'}=${session.id}&interval=${encodeURIComponent(period)}`,{userId,signal:controller.signal}).then(setChart).catch(e=>{if(!controller.signal.aborted)setError(e.message)}).finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return()=>controller.abort()
  },[session.id,period,userId,api])
  const p=session.state?.position,avg=p?.quantity>0?(p.averagePrice??Number(p.costMicros)/1e6/p.quantity):null
  const closed=session.state?.closedTrades||session.state?.trades||[]
  const show=history||Boolean(focusedTrade)||['closed','completed','stopped'].includes(session.status)
  const codeName=data.watchlist.find(row=>row.code===session.code)?.name||session.code
  return <section className="trading-run-chart"><div className="trading-actions"><strong>{codeName} · {session.code}</strong><select aria-label="실행 차트 주기" value={period} onChange={e=>setPeriod(e.target.value)}>{['1분','5분','10분','15분','30분','60분','일','주','월'].map(p=><option key={p}>{p}</option>)}</select><span>{names[session.broker]} 개인 시세 · 한국 시간</span></div>
    <label><input type="checkbox" checked={history} onChange={e=>setHistory(e.target.checked)}/>거래 이력 표시</label>
    {loading?<p role="status">개인 API 차트 조회 중</p>:error?<p role="alert">{error} · 주문 가능 여부와 차트 제공 여부는 별개입니다.</p>:chart?.candles?.length?<div className="trading-chart-host"><TradingViewChart stock={{code:session.code,name:codeName}} period={period} broker={session.broker} credentialScope={`trading:${userId}:${session.id}`} candles={chart.candles} indicators={session.snapshot?.strategy?.indicators||[]} averagePurchasePrice={avg} executionTrades={show?(focusedTrade?closed.filter(t=>t.id===focusedTrade):closed):[]}/></div>:<p>선택 증권사의 개인 차트 데이터가 없습니다. 대체 시세를 사용하지 않습니다.</p>}
    {show&&closed.length>0&&<div className="trading-table-scroll"><table><caption>확인된 완료 거래 · 판단 시각과 체결 시각</caption><thead><tr><th>진입 체결</th><th>청산 판단</th><th>청산 체결</th><th>가격·수량</th></tr></thead><tbody>{closed.map((t,i)=><tr key={t.id||i}><td><button type="button" onClick={()=>setFocusedTrade(t.id)}>거래 #{i+1} 보기</button> {t.adopted?'기존 보유분 · 매입 시각 미확인':when(t.entryAt||t.entryTime||t.openedAt)}</td><td>{when(t.decisionAt||t.decisionTime)}</td><td>{when(t.exitAt||t.exitTime||t.closedAt)}</td><td>{money(t.entryPrice)} → {money(t.exitPrice)}원 · {t.quantity}주 · {t.reason==='take_profit'?'익절':t.reason==='stop_loss'?'손절':t.reason}</td></tr>)}</tbody></table></div>}
    {session.configOnly?<p>저장된 설정 · 아직 시작하지 않았습니다.</p>:<RunDetails session={session} intents={data.intents.filter(row=>row.session_id===session.id)} events={data.events.filter(row=>row.session_id===session.id)}/>}
  </section>
}

export default function TradingAgentPanel({userId,onLogin,api=tradingApi}) {
  const [view,setView]=useState('settings'),[data,setData]=useState(null),[connections,setConnections]=useState(null),[drafts,setDrafts]=useState({}),[checked,setChecked]=useState([]),[runChecked,setRunChecked]=useState([]),[selected,setSelected]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[messages,setMessages]=useState({}),[confirmation,setConfirmation]=useState(null),[mode,setMode]=useState('LIVE')
  const epoch=useRef(0),pending=useRef(false),tabs=useRef([])
  useEffect(()=>{
    const seq=++epoch.current,controller=new AbortController();setData(null);setConnections(null);setDrafts({});setSelected(null);setChecked([]);setRunChecked([]);setError('')
    if(!userId)return
    const load=()=>api('',{userId,signal:controller.signal}).then(value=>{if(epoch.current===seq)setData(value)}).catch(e=>{if(epoch.current===seq&&!controller.signal.aborted)setError(e.message)})
    const verify=()=>{setConnections(null);api('/connections',{userId,signal:controller.signal}).then(value=>{if(epoch.current===seq)setConnections(value)}).catch(e=>{if(epoch.current===seq&&!controller.signal.aborted)setError(e.message)})}
    load();verify();const timer=setInterval(load,10000),proof=setInterval(verify,60000)
    return()=>{++epoch.current;controller.abort();clearInterval(timer);clearInterval(proof)}
  },[userId,api])
  const refresh=async()=>{const seq=epoch.current;try{const value=await api('',{userId});if(seq===epoch.current){setData(value);setError('')}}catch(e){if(seq===epoch.current)setError(e.message)}}
  const run=async fn=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');try{await fn()}catch(e){setError(e.message)}finally{pending.current=false;setBusy(false)}}
  const update=(code,patch)=>setDrafts(old=>({...old,[code]:{...(old[code]||savedFor(data,code)?.spec||initial(code)),...patch}}))
  const toggle=(value,list,set)=>set(list.includes(value)?list.filter(x=>x!==value):[...list,value])
  const byCode=Object.fromEntries((data?.watchlist||[]).map(row=>[row.code,row.name]))
  if(!userId)return <section className="agent-mode-card trading-agent"><h2>매매 에이전트</h2><p>로그인 후 관심종목별 매매 설정과 실행 기록을 확인할 수 있습니다.</p><button type="button" onClick={onLogin}>로그인</button></section>
  const save=()=>run(async()=>{
    const seq=epoch.current
    for(const code of checked){const original=savedFor(data,code),spec=drafts[code]||original?.spec||initial(code)
      try{const value=await api('/config',{userId,body:{id:original?.id,expectedRevision:original?.revision||0,spec}});if(seq!==epoch.current)return;setData(value);setDrafts(old=>{const out={...old};delete out[code];return out});setMessages(old=>({...old,[code]:'저장됨 · 실행은 별도 시작'}))}catch(e){if(seq!==epoch.current)return;setMessages(old=>({...old,[code]:e.message}))}}
  })
  const preview=codes=>run(async()=>{
    const previews=[],seq=epoch.current
    for(const code of codes){const config=savedFor(data,code);if(!config)continue
      try{const value=await api('/preview',{userId,body:{configId:config.id,configRevision:config.revision,mode}});if(seq!==epoch.current)return;previews.push({...value,requestId:crypto.randomUUID()});setMessages(old=>({...old,[code]:''}))}catch(e){if(seq!==epoch.current)return;setMessages(old=>({...old,[code]:e.message}))}}
    if(previews.length)setConfirmation({kind:'start',previews,mode,byCode})
  })
  const confirm=()=>run(async()=>{
    const seq=epoch.current
    if(confirmation.kind==='stop'){const value=await api('/stop',{userId,body:{sessionId:confirmation.session.id,expectedRevision:confirmation.session.revision,abandon:confirmation.abandon}});if(seq!==epoch.current)return;setData(value)}
    else for(const item of confirmation.previews){try{const value=await api('/start',{userId,body:{previewId:item.id,requestId:item.requestId,confirmed:true}});if(seq!==epoch.current)return;setData(value);setMessages(old=>({...old,[item.summary.code]:'실행 시작됨'}))}catch(e){if(seq!==epoch.current)return;setMessages(old=>({...old,[item.summary.code]:e.message}))}}
    setConfirmation(null)
  })
  const stop=session=>setConfirmation({kind:'stop',session,abandon:false,change:abandon=>setConfirmation(old=>({...old,abandon}))})
  return <section className="agent-mode-card trading-agent"><div className="trading-heading"><h2>매매 에이전트</h2><button type="button" onClick={refresh} disabled={busy}><RefreshCw size={14}/>상태 확인</button></div>
    <p className="trading-policy"><ShieldAlert size={16}/>KRX 정규장 현금주식 · 저장된 전략을 서버에서 실행 · 브라우저를 닫아도 실행 유지</p>
    {data&&!data.flags.liveEnabled&&<p className="trading-notice" role="status">LIVE 비활성 · 설정을 저장해도 실제 주문은 시작되지 않습니다.</p>}
    {data&&(!data.flags.workerEnabled||!data.flags.liveEnabled)&&data.sessions.some(active)&&<p className="trading-error" role="alert">실행 서버가 비활성입니다. 남은 보유분·미체결의 자동 관리가 중단될 수 있으므로 상태와 계좌를 확인해 주세요.</p>}
    <div className="trading-tabs" role="tablist" aria-label="매매 관리">{[['settings','설정'],['execution','실행'],['progress','진행상황']].map(([id,label],i)=><button type="button" role="tab" id={`trading-tab-${id}`} aria-controls="trading-panel" aria-selected={view===id} tabIndex={view===id?0:-1} ref={el=>tabs.current[i]=el} key={id} onClick={()=>setView(id)} onKeyDown={event=>{const n={ArrowRight:(i+1)%3,ArrowLeft:(i+2)%3,Home:0,End:2}[event.key];if(n!==undefined){event.preventDefault();setView(['settings','execution','progress'][n]);tabs.current[n]?.focus()}}}>{label}</button>)}</div>
    {error&&<p role="alert" className="trading-error">{error} <button type="button" onClick={refresh} disabled={busy}>다시 확인</button></p>}
    {!data?<p role="status">{error?'설정을 조회하지 못했습니다. 빈 목록으로 처리하지 않습니다.':'저장된 설정 조회 중'}</p>:<div id="trading-panel" role="tabpanel" aria-labelledby={`trading-tab-${view}`}>
      {view==='settings'?<><div className="trading-actions"><label><input type="checkbox" checked={data.watchlist.length>0&&checked.length===data.watchlist.length} onChange={event=>setChecked(event.target.checked?data.watchlist.map(x=>x.code):[])}/>전체 선택</label><button type="button" disabled={busy||!checked.length} onClick={save}>선택 항목 저장</button><span>저장은 시작이 아닙니다.</span></div>
        {!data.watchlist.length?<p>관심종목을 먼저 등록해 주세요. 최대 20개 종목을 설정할 수 있습니다.</p>:data.watchlist.map((stock,index)=>{const config=savedFor(data,stock.code),spec=drafts[stock.code]||config?.spec||initial(stock.code),strategy=data.strategies.find(s=>s.id===spec.strategyId),ready=strategy?tradingReadiness(strategy,spec.entryAction):null,session=sessionFor(data,stock.code)
          return <article className="trading-config" key={stock.code}><div className="trading-config-head"><label><input type="checkbox" checked={checked.includes(stock.code)} onChange={()=>toggle(stock.code,checked,setChecked)} disabled={busy}/><strong>{stock.name}</strong> {stock.code}</label><span>{drafts[stock.code]?'변경사항 미저장':config?'저장됨':'미저장'} · 처리 순서 {index+1}</span></div><div className="trading-fields">
            <label>증권사<select aria-label={`${stock.name} 증권사`} value={spec.broker} disabled={busy||active(session)} onChange={e=>update(stock.code,{broker:e.target.value,accountRef:connections?.[e.target.value]?.accounts?.[0]?.ref||''})}><option value="">증권사 선택</option>{brokers.map(b=><option key={b} value={b} disabled={!connections?.[b]?.connected||!data.capabilities[b]?.supported}>{names[b]} · {!connections?'연결 확인 중':!connections[b]?.connected?connections[b]?.status==='unconfigured'?'미등록':'연결 실패':!data.capabilities[b]?.supported?'V1 미지원':'연결 확인'}</option>)}</select></label>
            <label>계좌<select aria-label={`${stock.name} 계좌`} value={spec.accountRef} disabled={!spec.broker||busy||active(session)} onChange={e=>update(stock.code,{accountRef:e.target.value})}><option value="">계좌 선택</option>{connections?.[spec.broker]?.accounts?.map(a=><option key={a.ref} value={a.ref}>{a.label}</option>)}</select></label>
            <label>저장 전략<select aria-label={`${stock.name} 전략`} value={spec.strategyId} disabled={busy||active(session)} onChange={e=>{const s=data.strategies.find(s=>s.id===e.target.value);update(stock.code,{strategyId:s?.id||'',strategyRevision:s?.revision||0,entryAction:''})}}><option value="">전략 선택</option>{data.strategies.map(s=>{const r=tradingReadiness(s,(s.backtest_settings?.entryConditions||[]).some(c=>c.enabled)?'signal':'once');return <option key={s.id} value={s.id} disabled={!r.ready}>{s.name} v{s.revision}</option>})}</select></label>
            <label>수량 운용<select value={spec.quantityMode} disabled={busy||active(session)} onChange={e=>update(stock.code,{quantityMode:e.target.value})}><option value="fixed">고정 수량</option><option value="all_cash">주문가능 현금 전체 사용</option></select></label>
            <label>{spec.quantityMode==='all_cash'?'수량 (전체 현금 모드에서 미사용)':'주문수량 · 주'}<input type="number" min="1" max="1000000" step="1" value={spec.quantity} disabled={spec.quantityMode==='all_cash'||busy||active(session)} onChange={e=>update(stock.code,{quantity:e.target.value})}/></label>
            <label>최초 실행 방식<select value={spec.entryAction} disabled={!strategy||busy||active(session)} onChange={e=>update(stock.code,{entryAction:e.target.value})}><option value="">실행 방식 선택</option>{ready?.hasEntry?<option value="signal">확정 일봉 신호 반복</option>:<><option value="once">신규 1회 진입 후 관리</option><option value="manage">기존 보유분 관리 · 신규 매수 없음</option></>}</select></label>
            {spec.entryAction==='manage'&&<label>관리할 기존 보유수량 · 주<input type="number" min="1" step="1" value={spec.manageQuantity} disabled={busy||active(session)} onChange={e=>update(stock.code,{manageQuantity:e.target.value})}/></label>}
          </div>{spec.quantityMode==='all_cash'&&<small>수수료·가격 여유와 예약금을 제외합니다. 앞선 종목이 현금을 사용하면 나머지는 자금 부족 대기합니다.</small>}{spec.broker&&data.capabilities[spec.broker]?.ordersEnabled===false&&<p className="trading-reason">증권사 주문 기능 비활성 · 설정 저장 가능, 실행 불가</p>}{ready&&!ready.ready&&<p className="trading-reason">{ready.issues.join(' ')}</p>}{messages[stock.code]&&<p role="status">{messages[stock.code]}</p>}</article>})}
        <details className="trading-support"><summary>증권사 지원·실행 제한</summary>{brokers.map(b=><p key={b}>{names[b]}: {data.capabilities[b]?.reason||'KRX 현금 주문·취소·체결 확인 지원'} · {!connections?'연결 확인 중':connections[b]?.connected?'개인 계좌 수신 확인':connections[b]?.status==='unconfigured'?'개인 API 미등록':'연결 확인 실패'}</p>)}</details>
      </>:view==='execution'?<><div className="trading-actions"><label><input type="checkbox" checked={data.configs.length>0&&runChecked.length===data.configs.length} onChange={e=>setRunChecked(e.target.checked?data.configs.map(x=>x.code):[])}/>전체 선택</label><select aria-label="실행 환경" value={mode} onChange={e=>setMode(e.target.value)}><option value="LIVE">LIVE · 실제 주문</option><option value="PAPER" disabled>PAPER · V1 실행 미지원</option></select><button type="button" disabled={busy||!runChecked.length||!data.flags.workerEnabled||!(mode==='LIVE'?data.flags.liveEnabled:data.flags.paperEnabled)} onClick={()=>preview(runChecked)}>선택 항목 실행</button></div>
        <div className="trading-execution"><div className="trading-run-list">{!data.configs.length&&<p>설정에서 실행 대상을 먼저 저장해 주세요.</p>}{data.configs.map(config=>{const s=sessionFor(data,config.code),running=active(s);return <article key={config.id} className={selected===s?.id?'selected':''}><label><input type="checkbox" checked={runChecked.includes(config.code)} onChange={()=>toggle(config.code,runChecked,setRunChecked)}/>{byCode[config.code]||config.code}</label><button type="button" className="trading-run-select" onClick={()=>setSelected(s?.id||`config:${config.id}`)}><strong>{names[config.spec.broker]} · 본인 API 연결 계좌</strong><small>{running?s.snapshot?.strategy?.name:data.strategies.find(x=>x.id===config.spec.strategyId)?.name||s?.snapshot?.strategy?.name} v{running?s.snapshot?.strategy?.revision:config.spec.strategyRevision}</small><span>{s?phases[phase(s)]||phase(s):'저장됨 · 시작 전'}</span></button><div className="trading-actions"><button type="button" aria-label={`${byCode[config.code]||config.code} 실행`} disabled={busy||running||!data.flags.workerEnabled||!(mode==='LIVE'?data.flags.liveEnabled:data.flags.paperEnabled)} onClick={()=>preview([config.code])}><Play size={14}/>시작</button><button type="button" aria-label={`${byCode[config.code]||config.code} 정지`} disabled={busy||!running} onClick={()=>stop(s)}><Square size={14}/>정지</button></div>{messages[config.code]&&<p role="status">{messages[config.code]}</p>}</article>})}</div>
        {selectedRun(data,selected)?<RunChart key={selected} session={selectedRun(data,selected)} data={data} userId={userId} api={api}/>:<div className="trading-chart-empty">종목을 선택하면 해당 실행의 개인 API 차트와 기록을 표시합니다.</div>}</div>
      </>:<div className="trading-progress">{!data.sessions.length?<p>시작한 실행이 없습니다.</p>:data.sessions.map(s=><article key={s.id}><h3>{byCode[s.code]||s.code} · {s.mode}</h3><RunDetails session={s} intents={data.intents.filter(row=>row.session_id===s.id)} events={data.events.filter(row=>row.session_id===s.id)}/></article>)}</div>}
    </div>}{confirmation&&<Confirmation value={confirmation} busy={busy} onClose={()=>setConfirmation(null)} onConfirm={confirm}/>}</section>
}
