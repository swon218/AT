import {useEffect,useRef,useState} from 'react'
import {Play,Square,RefreshCw,ShieldAlert} from 'lucide-react'
import {tradingApi} from '../services/tradingApi'
import {tradingReadiness,tradingPerformance,tradingThresholds,tradingReason} from '../../shared/tradingV1.js'
import {tradingConnectionStage,orderTradingConfigs} from '../utils/tradingPresentation'
import {tradingActive,latestTradingSession,tradingConfigDirty,tradingExecutionBlock,browserTradingExecutionBlock,tradingExecutionSnapshot,tradingSessionFilter,browserTradingProgressSessions,eligibleTradingSelection,selectTradingDetail} from '../utils/tradingManagement'
import TradingViewChart from './TradingViewChart'
import './TradingAgentPanel.css'

const names={kiwoom:'키움',toss:'토스',nh:'NH',kb:'KB'},brokers=Object.keys(names)
const phases={waiting_signal:'신호 대기',waiting_funds:'자금 부족 대기',buying:'매수 주문 처리 중',buy_open:'매수 미체결',buy_partial:'매수 부분체결',holding:'보유 중',selling:'매도 주문 처리 중',sell_open:'매도 미체결',sell_partial:'매도 부분체결',closed:'청산 완료',completed:'실행 완료',stopping:'정지 처리 중 · 보유분 관리 중',stopped:'정지',unknown:'접수 결과 불명확',reconciliation_required:'정합성 확인 필요',connection_required:'연결 장애 · 보유분 관리 불가',market_closed:'시장 종료 대기',missed_open:'개장 진입 기회 놓침',paused:'서버 실행 비활성'}
const eventLabels={fill_confirmed:'체결 수량·평균가 확인',entry_cancel_requested:'소유 미체결 진입 잔량 취소 요청',order_accepted:'주문 접수 확인',order_rejected:'주문 거부 확인 · 자동 재시도 안 함',order_unknown:'주문 결과 불명 · 재전송 차단',run_started:'실행 시작',stop_requested:'정지 요청',management_stop_requested:'보유분 관리 중단 요청'}
const browserEventLabels={run_started:'실행 시작',run_stopped:'실행 정지',position_entered:'진입',take_profit:'익절',stop_loss:'손절'}
const intentLabels={prepared:'전송 준비',sending:'접수 확인 중',accepted:'접수·미체결',partial:'부분체결',filled:'체결 완료',cancelled:'취소 확인',rejected:'거부 확인',unknown:'결과 불명'}
const active=tradingActive
const initial=code=>({code,broker:'',accountRef:'',strategyId:'',strategyRevision:0,quantity:1,quantityMode:'fixed',entryAction:'',manageQuantity:1})
const savedFor=(data,code)=>data?.configs?.find(row=>row.code===code)
const sessionFor=(data,code)=>latestTradingSession(data?.sessions||[],code)
const phase=(session,intents=[])=>{
  if(session?.stop_requested&&active(session))return 'stopping'
  const state=session?.state?.phase||session?.status
  if(['buying','selling'].includes(state)&&intents.some(row=>row.session_id===session.id&&row.status==='partial'))return state==='buying'?'buy_partial':'sell_partial'
  return state
}
const money=value=>Number.isFinite(Number(value))&&value!==null&&value!==undefined?new Intl.NumberFormat('ko-KR',{maximumFractionDigits:4}).format(Number(value)):'—'
const when=value=>value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'medium'}).format(new Date(value)):'—'
const entryLabel=spec=>spec?.entryAction==='once'?'신규 1회 진입 후 관리':spec?.entryAction==='manage'?`기존 ${spec.manageQuantity}주 관리 · 신규 매수 없음`:'확정 일봉 신호 반복'
const quantityLabel=(spec,simulated=false)=>spec?.quantityMode==='all_cash'?(simulated?'운용 자금 전체 사용':'주문가능 현금 전체 사용'):`${spec?.quantity??'—'}주 고정`
const text=value=>typeof value==='string'?value:value?.label||value?.name||value?.description||''
const browserReasons={market_closed:'거래시간 밖입니다. 마지막 수신 데이터를 표시합니다.',quote_unavailable:'최신 시세를 확인할 수 없습니다.',signal_unmet:'확정 일봉 진입 조건이 충족되지 않았습니다.',daily_unavailable:'판단에 필요한 확정 일봉이 부족하거나 유효하지 않습니다.',cash_insufficient:'운용 자금이 부족합니다.',data_error:'데이터를 확인하지 못했습니다.',screen_closed:'화면을 닫아 실행이 중단되었습니다.',screen_hidden:'화면이 비활성화되어 실행을 중단했습니다.',catalog_unavailable:'관심종목과 전략을 확인하지 못해 실행을 중단했습니다. 목록을 다시 확인한 뒤 시작해 주세요.',stopped:'실행을 정지했습니다.',watchlist_removed:'관심종목에서 삭제되어 실행을 중단했습니다.'}

function PolicySummary({policy,broker,compact=false}) {
  const route=text(policy?.routeLabel||policy?.route||policy?.routing),quote=text(policy?.quoteLabel||policy?.quoteMarket||policy?.quoteVenue),chart=text(policy?.chartLabel||policy?.chartMarket||policy?.chartVenue)
  return <div className={`trading-policy-summary ${compact?'compact':''}`}>
    <span>주문 경로: {route||(broker==='kiwoom'?'KRX':'실행 확인에서 재검증')}</span>
    {!compact&&<><span>시세 기준: {quote||(broker==='kiwoom'?'KRX':'공급자 제공 기준')}</span><span>차트 기준: {chart||(broker==='kiwoom'?'KRX':'공급자 제공 기준')}</span></>}
    <span>자동매매 시간: {policy?.tradingWindow==='KRX_REGULAR'?'KRX 정규장 시간 내':text(policy?.tradingWindow)||'KRX 정규장 시간 내'}</span>
  </div>
}

function Confirmation({value,busy,error,onClose,onConfirm}) {
  const dialog=useRef(null),origin=useRef(document.activeElement)
  useEffect(()=>{dialog.current.showModal();return()=>{dialog.current?.close();origin.current?.isConnected&&origin.current.focus()}},[])
  const stop=value.kind==='stop'
  return <dialog className="trading-confirm" ref={dialog} aria-labelledby="trading-confirm-title" onCancel={event=>{event.preventDefault();if(!busy)onClose()}} onClick={event=>{if(event.target===dialog.current&&!busy)onClose()}}>
    <h2 id="trading-confirm-title">{stop?'자동매매 정지 확인':'저장된 설정 실행 확인'}</h2>
    {stop?<><p>신규 진입을 중단하고 이 실행의 미체결 매수 주문만 취소·확인합니다. 이미 체결된 보유분은 익절·손절 관리를 계속합니다.</p><p>정지는 강제 매도를 실행하지 않습니다.</p>
      <label className="trading-abandon"><input type="checkbox" checked={value.abandon} onChange={event=>value.change(event.target.checked)} disabled={busy}/>보유분 관리까지 중단합니다. 주식은 계좌에 남으며 자동 익절·손절이 중단됩니다.</label></>
      :<><p><strong>{value.mode==='LIVE'?'LIVE · 실제 주문':'PAPER · 가상 실행'}</strong> · 시작 확인은 5분 동안 유효하며 시작 직전에 계좌 상태를 다시 확인합니다.</p>
        {value.previews.map(item=><article key={item.id} className="trading-confirm-row"><h3>{value.byCode[item.summary.code]||item.summary.code} · {names[item.summary.broker]}</h3>
          <p>{item.summary.accountLabel} · {item.summary.strategy.name} v{item.summary.strategy.revision}</p><p>{quantityLabel(item.summary.spec)} · {entryLabel(item.summary.spec)}</p>
          {item.summary.spec.quantityMode==='all_cash'&&<p>전체 현금을 사용한 앞선 종목이 다른 종목의 진입을 막을 수 있습니다.</p>}
          {item.summary.holding&&<p>확인 보유분 {item.summary.holding.quantity}주 · 평균 {money(item.summary.holding.averagePrice)}원</p>}
          <p>진입: {item.summary.entryMethod}<br/>청산: {item.summary.exitMethod}<br/>{item.summary.session} · {item.summary.stopPolicy}</p><PolicySummary policy={item.summary.executionPolicy} broker={item.summary.broker}/>
        </article>)}<p>조건 도달은 체결가를 보장하지 않습니다. 실제 수수료·세금이 미확정이면 성과는 비용 미반영 손익입니다.</p></>}
    {error&&<p role="alert" className="trading-error">{error}</p>}
    <div className="trading-actions"><button type="button" disabled={busy} onClick={onClose}>취소</button><button type="button" className="primary" disabled={busy} onClick={onConfirm}>{busy?'처리 중…':stop?'정지 확인':'위 내용으로 시작'}</button></div>
  </dialog>
}

function RunDetails({session,intents,events,simulated=false}) {
  if(!session)return null
  const s=session.state||{},p=s.position,average=p?.averagePrice??(p?.quantity>0?Number(p.costMicros)/1e6/p.quantity:null)
  const quantity=p?.quantity||0,risk=session.snapshot?.strategy?.backtest_settings||{},thresholds=quantity?tradingThresholds(p,risk):null
  const freshMark=Number.isFinite(Date.parse(s.markAt))&&Date.now()-Date.parse(s.markAt)<=30000&&!['connection_required','reconciliation_required','unknown'].includes(session.status)
  const perf={...(session.performance||tradingPerformance(s)),unrealizedPnl:tradingPerformance(s,freshMark?s.markPrice:null).unrealizedPnl}
  return <div className="trading-details"><h3>{phases[phase(session,intents)]||phase(session,intents)||'저장됨'} {!simulated&&<small>{session.mode}</small>}</h3><p>{names[session.broker]} · {session.snapshot?.accountLabel||(simulated?'운용 계정':'본인 API 연결 계좌')} · {session.snapshot?.strategy?.name} v{session.snapshot?.strategy?.revision}</p>
    {simulated&&<p>판단 주기: 확정 일봉 · 차트 표시 주기와 별도로 적용합니다.</p>}
    <p>최근 {simulated?'조건 평가':'확인'} {when(simulated?s.evaluatedAt:s.checkedAt||session.updated_at)} {s.reason&&<span className="trading-reason">{(simulated?browserReasons:tradingReason)[s.reason]||(s.reason==='order_rejected'?'주문이 거부되었습니다. 자동 재시도하지 않습니다. 계좌와 설정을 확인해 주세요.':s.reason)}</span>}</p>
    {simulated&&s.error&&<p role="alert" className="trading-error">{s.error}</p>}
    <dl><div><dt>보유수량</dt><dd>{quantity}주</dd></div><div><dt>평균 진입가</dt><dd>{money(average)}원</dd></div><div><dt>익절 기준</dt><dd>{money(thresholds?.takeProfitPrice)}원</dd></div><div><dt>손절 기준</dt><dd>{money(thresholds?.stopLossPrice)}원</dd></div><div><dt>진입 / 완료</dt><dd>{perf.entries} / {perf.closedTrades}</dd></div><div><dt>실현손익</dt><dd>{money(perf.realizedPnl)}원</dd></div><div><dt>미실현손익</dt><dd>{money(perf.unrealizedPnl)}원</dd></div><div><dt>익절 / 손절</dt><dd>{perf.takeProfits} / {perf.stopLosses}</dd></div></dl>
    {simulated&&<dl><div><dt>현재가</dt><dd>{money(s.markPrice)}원</dd></div><div><dt>최근 수신</dt><dd>{when(s.markAt)}</dd></div></dl>}
    <small>{simulated?'해당 실행의 거래 기록만 집계':'해당 실행 소유·인수분만 집계'} · 비용 미확정/미반영 · 시세 조회 간 가격 도달을 놓칠 수 있습니다. 시세 기준 {when(s.markAt)}{!freshMark&&' · 최신 평가손익 미확인'}</small>
    <p>시작 당시 처리 순서 {s.priority??'—'} · 같은 순서는 시작 시각과 실행 ID 순서로 처리합니다.</p>{!simulated&&<><h4>주문·체결</h4>{intents.length?<div className="trading-table-scroll"><table><thead><tr><th>구분</th><th>수량</th><th>확인 체결</th><th>상태</th></tr></thead><tbody>{intents.map(row=><tr key={row.id}><td>{row.side==='buy'?'매수':'매도'}</td><td>{row.quantity}</td><td>{row.cumulative_quantity??row.filled_quantity??0}</td><td>{intentLabels[row.status]||row.status}</td></tr>)}</tbody></table></div>:<p>이 실행의 주문 기록이 없습니다.</p>}</>}
    {!simulated&&session.broker==='toss'&&<small>토스 체결은 누적 수량·금액과 마지막 체결시각 기준입니다. 개별 체결별 마커는 제공하지 않습니다.</small>}
    <h4>실행 이벤트</h4><ol className="trading-events">{events.length?events.map(row=><li key={row.id}><time>{when(row.created_at)}</time> {(simulated?browserEventLabels:eventLabels)[row.code||row.kind]||row.code||row.kind}</li>):<li>이벤트가 없습니다.</li>}</ol>
  </div>
}

function RunChart({session,data,userId,api,credentialRevision,simulated=false}) {
  const [period,setPeriod]=useState(simulated?'15분':'일'),[history,setHistory]=useState(false),[focusedTrade,setFocusedTrade]=useState(null),[chart,setChart]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0)
  const request=useRef(0)
  const scope=JSON.stringify([session.id,session.broker,session.account_ref,period,userId,credentialRevision])
  useEffect(()=>{
    const seq=++request.current,controller=new AbortController();setChart(null);setError('');setLoading(true)
    let pending=false
    const load=async()=>{
      if(pending||controller.signal.aborted)return
      pending=true
      try {
        const value=await api(`/chart?sessionId=${session.id}&interval=${encodeURIComponent(period)}`,{userId,signal:controller.signal})
        if(!controller.signal.aborted&&request.current===seq){setChart(old=>({scope,...value,candles:old?.scope===scope&&JSON.stringify(old.candles)===JSON.stringify(value.candles)?old.candles:value.candles}));setError('')}
      }catch(e){if(!controller.signal.aborted&&request.current===seq)setError(e.message)}
      finally{pending=false;if(!controller.signal.aborted&&request.current===seq)setLoading(false)}
    }
    void load()
    const timer=simulated?setInterval(()=>{if(document.visibilityState==='visible')void load()},15000):null
    return()=>{++request.current;controller.abort();if(timer)clearInterval(timer)}
  },[scope,api,retry,simulated])
  const current=chart?.scope===scope?chart:null,p=session.state?.position,avg=p?.quantity>0?(p.averagePrice??Number(p.costMicros)/1e6/p.quantity):null
  const closed=session.state?.closedTrades||[],show=history||Boolean(focusedTrade)||['closed','completed','stopped'].includes(session.status)
  const codeName=data.watchlist.find(row=>row.code===session.code)?.name||session.snapshot?.name||session.code
  const provider=current?.metadata?.sourceBroker||current?.metadata?.source
  const sourceMismatch=current&&(simulated?(!provider||provider!==session.broker&&!current.metadata?.fallback):(current.metadata?.fallback||provider!==session.broker))
  const rawMarket=text(current?.metadata?.market||current?.metadata?.exchange||session.snapshot?.executionPolicy?.chartMarket)
  const chartMarket=rawMarket==='PROVIDER'?'공급자 기준 · 거래소 미제공':rawMarket||'거래소 기준 미확인'
  return <section className="trading-run-chart" aria-label={`${codeName} 실행 차트와 결과`}>
    <div className="trading-actions"><strong>{codeName} · {session.code}</strong><select aria-label="실행 차트 주기" value={period} onChange={e=>setPeriod(e.target.value)}>{['1분','5분','10분','15분','30분','60분','일','주','월'].map(p=><option key={p}>{p}</option>)}</select><span>{names[provider]||names[session.broker]} {simulated?'시세':'개인 시세'}{simulated&&provider&&provider!==session.broker?' · 대체 시세':''} · {chartMarket} · 한국 시간</span></div>
    <p className="trading-session-id">실행 ID {session.id}</p>{simulated?<p className="trading-chart-received">최근 수신 {when(current?.metadata?.receivedAt||current?.metadata?.fetchedAt)} · 판단 주기: 확정 일봉</p>:<PolicySummary policy={session.snapshot?.executionPolicy} broker={session.broker}/>}
    <label><input type="checkbox" checked={history} onChange={e=>{setHistory(e.target.checked);if(!e.target.checked)setFocusedTrade(null)}}/>거래 이력 표시</label>
    {loading?<p role="status">{simulated?'차트':'개인 API 차트'} 조회 중</p>:error||sourceMismatch?<p role="alert">{sourceMismatch?'선택한 증권사의 차트 출처를 확인할 수 없습니다.':error}{!simulated&&' · 주문 가능 여부와 차트 제공 여부는 별개입니다.'} <button type="button" onClick={()=>setRetry(value=>value+1)}>다시 조회</button></p>:current?.candles?.length?<div className="trading-chart-host"><TradingViewChart stock={{code:session.code,name:codeName}} period={period} broker={session.broker} credentialScope={`trading:${userId}:${session.id}:${session.account_ref}:${credentialRevision}`} candles={current.candles} indicators={session.snapshot?.strategy?.indicators||[]} averagePurchasePrice={avg} executionTrades={show?(focusedTrade?closed.filter(t=>t.id===focusedTrade):closed):[]} preserveDataViewport={simulated} executionMode={simulated?'BROWSER_SIMULATION':undefined}/></div>:<p>{simulated?'선택 증권사의 차트 데이터가 없습니다.':'선택 증권사의 개인 차트 데이터가 없습니다. 대체 시세를 사용하지 않습니다.'} <button type="button" onClick={()=>setRetry(value=>value+1)}>다시 조회</button></p>}
    <div className="trading-results-scroll" aria-label="선택 실행의 거래 결과">
      {show&&closed.length>0&&<div className="trading-table-scroll"><table><caption>{simulated?'완료 거래 · 진입과 청산 시각':'확인된 완료 거래 · 판단 시각과 체결 시각'}</caption><thead><tr><th>{simulated?'진입':'진입 체결'}</th><th>청산 판단</th><th>{simulated?'청산':'청산 체결'}</th><th>가격·수량</th></tr></thead><tbody>{closed.map((t,i)=><tr key={t.id||i}><td><button type="button" onClick={()=>setFocusedTrade(t.id)}>거래 #{i+1} 보기</button> {t.adopted?'기존 보유분 · 매입 시각 미확인':when(t.entryAt)}</td><td>{when(t.decisionAt)}</td><td>{when(t.exitAt)}</td><td>{money(t.entryPrice)} → {money(t.exitPrice)}원 · {t.quantity}주 · {t.reason==='take_profit'?'익절':t.reason==='stop_loss'?'손절':t.reason}</td></tr>)}</tbody></table></div>}
      <RunDetails session={session} simulated={simulated} intents={data.intents.filter(row=>row.session_id===session.id)} events={data.events.filter(row=>row.session_id===session.id)}/>
    </div>
  </section>
}

function SelectedProgress({session,data,userId,api,credentialRevision,simulated=false}) {
  const [detail,setDetail]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState('')
  const request=useRef(0),scope=JSON.stringify([session.id,session.broker,session.account_ref,userId,credentialRevision])
  useEffect(()=>{
    const seq=++request.current,controller=new AbortController();setLoading(true);setError('')
    api(`/session?sessionId=${session.id}`,{userId,signal:controller.signal}).then(value=>{
      if(!controller.signal.aborted&&request.current===seq&&value.sessions?.[0]?.id===session.id)setDetail({scope,data:value})
    }).catch(e=>{if(!controller.signal.aborted&&request.current===seq)setError(e.message)}).finally(()=>{if(!controller.signal.aborted&&request.current===seq)setLoading(false)})
    return()=>{++request.current;controller.abort()}
  },[scope,session.revision,api])
  const current=detail?.scope===scope?detail.data:null
  const {session:shown,data:records}=selectTradingDetail(session,data,current)
  return <div className="trading-progress-detail">{loading&&<p role="status">선택 실행의 기록 확인 중</p>}{error&&<p role="alert">{error} · 마지막으로 확인한 실행 정보만 표시합니다.</p>}<RunChart session={shown} data={records} userId={userId} api={api} credentialRevision={credentialRevision} simulated={simulated}/></div>
}

export default function TradingAgentPanel({userId,onLogin,credentialRevision=0,connectionEvidence,api=tradingApi,executionMode='LIVE'}) {
  const simulated=executionMode==='BROWSER_SIMULATION'
  if(simulated&&api===tradingApi)throw new Error('browser_trading_runtime_required')
  const [view,setView]=useState('settings'),[data,setData]=useState(null),[connections,setConnections]=useState(null),[drafts,setDrafts]=useState({}),[checked,setChecked]=useState([]),[runChecked,setRunChecked]=useState([]),[selected,setSelected]=useState(null),[filter,setFilter]=useState('active'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[messages,setMessages]=useState({}),[confirmation,setConfirmation]=useState(null),[mode,setMode]=useState(simulated?'BROWSER_SIMULATION':'LIVE')
  const epoch=useRef(0),pending=useRef(false),tabs=useRef([]),owner=useRef(null)
  useEffect(()=>{
    const seq=++epoch.current,controller=new AbortController();setConnections(null);setError('')
    if(owner.current!==userId){owner.current=userId;setData(null);setDrafts({});setSelected(null);setChecked([]);setRunChecked([]);setConfirmation(null);setMessages({})}
    if(!userId)return
    const load=()=>api('',{userId,signal:controller.signal}).then(value=>{if(epoch.current===seq&&!controller.signal.aborted)setData(value)}).catch(e=>{if(epoch.current===seq&&!controller.signal.aborted)setError(e.message)})
    const verify=()=>{setConnections(old=>old&&Object.fromEntries(Object.entries(old).map(([b,row])=>[b,tradingConnectionStage(row,undefined)==='expired'?{...row,status:'expired',connected:false}:row])));api('/connections',{userId,signal:controller.signal}).then(value=>{if(epoch.current===seq&&!controller.signal.aborted)setConnections(value)}).catch(e=>{if(epoch.current===seq&&!controller.signal.aborted)setError(e.message)})}
    load();verify();window.addEventListener('focus',verify);const timer=setInterval(load,10000),proof=setInterval(verify,60000)
    return()=>{++epoch.current;controller.abort();window.removeEventListener('focus',verify);clearInterval(timer);clearInterval(proof)}
  },[userId,api,credentialRevision])
  const refresh=async()=>{const seq=epoch.current;try{const value=await api('',{userId});if(seq===epoch.current){setData(value);setError('')}}catch(e){if(seq===epoch.current)setError(e.message)}}
  const run=async fn=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');try{await fn()}catch(e){setError(e.message)}finally{pending.current=false;setBusy(false)}}
  const update=(code,patch)=>setDrafts(old=>({...old,[code]:{...(old[code]||savedFor(data,code)?.spec||initial(code)),...patch}}))
  const toggle=(value,list,set)=>set(list.includes(value)?list.filter(x=>x!==value):[...list,value])
  const proofState=b=>simulated?(data?.capabilities?.[b]?.supported&&connections?.[b]?.accounts?.length?'connected':'checking'):tradingConnectionStage(connections?.[b],connectionEvidence?.[b])
  const proofLabel=b=>simulated?(data?.capabilities?.[b]?.supported?'시세 조회':'시세 미지원'):({checking:'연결 확인 중',unconfigured:'개인 API 미등록',failed:'연결 확인 실패',expired:'연결 검증 만료',connected:'연결 확인'})[proofState(b)]
  const orderedConfigs=simulated?(data?.configs||[]):orderTradingConfigs(data?.configs||[],data?.watchlist||[])
  const byCode=Object.fromEntries((data?.watchlist||[]).map(row=>[row.code,row.name]))
  const settingsCodes=(data?.watchlist||[]).filter(row=>!active(sessionFor(data,row.code))).map(row=>row.code)
  const selectedSettings=eligibleTradingSelection(checked,settingsCodes)
  const blocks=Object.fromEntries(orderedConfigs.map(config=>[config.code,(simulated?browserTradingExecutionBlock:tradingExecutionBlock)({config,sessions:data.sessions,strategies:data.strategies,connection:connections?.[config.spec.broker],evidence:connectionEvidence?.[config.spec.broker],capability:data.capabilities[config.spec.broker],flags:data.flags,dirty:tradingConfigDirty(drafts[config.code],config),mode})]))
  const executable=orderedConfigs.filter(config=>!blocks[config.code]).map(row=>row.code),selectedRuns=eligibleTradingSelection(runChecked,executable)
  const progress=simulated?browserTradingProgressSessions(data?.sessions||[],filter,selected):tradingSessionFilter(data?.sessions||[],filter),chosen=progress.find(row=>row.id===selected)
  const accountLabel=spec=>connections?.[spec.broker]?.accounts?.find(row=>row.ref===spec.accountRef)?.label||(simulated?'운용 계정':'저장된 본인 계좌')
  const funds=data?.virtualFunds||data?.capital||{}
  if(!userId)return <section className="agent-mode-card trading-agent"><h2>자동매매 에이전트</h2><p>로그인 후 관심종목별 매매 설정과 실행 기록을 확인할 수 있습니다.</p><button type="button" onClick={onLogin}>로그인</button></section>
  const save=()=>run(async()=>{
    const seq=epoch.current
    for(const code of selectedSettings){const original=savedFor(data,code),spec=drafts[code]||original?.spec||initial(code)
      try{const value=await api('/config',{userId,body:{id:original?.id,expectedRevision:original?.revision||0,spec}});if(seq!==epoch.current)return;setData(value);setDrafts(old=>{const out={...old};delete out[code];return out});setMessages(old=>({...old,[code]:'저장됨 · 실행은 별도 시작'}))}catch(e){if(seq!==epoch.current)return;setMessages(old=>({...old,[code]:e.message}))}}
  })
  const preview=codes=>run(async()=>{
    const previews=[],seq=epoch.current
    for(const config of orderedConfigs.filter(row=>codes.includes(row.code))){if(blocks[config.code]){setMessages(old=>({...old,[config.code]:blocks[config.code]}));continue}
      try{const value=await api('/preview',{userId,body:{configId:config.id,configRevision:config.revision,mode}});if(seq!==epoch.current)return;previews.push({...value,requestId:crypto.randomUUID()});setMessages(old=>({...old,[config.code]:''}))}catch(e){if(seq!==epoch.current)return;setMessages(old=>({...old,[config.code]:e.message}))}}
    if(simulated){
      let first=null
      for(const item of previews){try{const value=await api('/start',{userId,body:{previewId:item.id,requestId:item.requestId,confirmed:true}});if(seq!==epoch.current)return;setData(value);first||=value.startedSessionId||value.sessions?.find(s=>s.code===item.summary.code&&active(s))?.id;setMessages(old=>({...old,[item.summary.code]:'실행 시작됨'}));setRunChecked(old=>old.filter(code=>code!==item.summary.code))}catch(e){if(seq!==epoch.current)return;setMessages(old=>({...old,[item.summary.code]:e.message}))}}
      if(first){setSelected(first);setFilter('active')}
    }else if(previews.length)setConfirmation({kind:'start',previews,mode,byCode})
  })
  const confirm=()=>run(async()=>{
    const seq=epoch.current
    if(confirmation.kind==='stop'){const value=await api('/stop',{userId,body:{sessionId:confirmation.session.id,expectedRevision:confirmation.session.revision,abandon:confirmation.abandon}});if(seq!==epoch.current)return;setData(value)}
    else for(const item of confirmation.previews){try{const value=await api('/start',{userId,body:{previewId:item.id,requestId:item.requestId,confirmed:true}});if(seq!==epoch.current)return;setData(value);setMessages(old=>({...old,[item.summary.code]:'실행 시작됨'}));setRunChecked(old=>old.filter(code=>code!==item.summary.code))}catch(e){if(seq!==epoch.current)return;setMessages(old=>({...old,[item.summary.code]:e.message}))}}
    setConfirmation(null)
  })
  const stop=session=>{
    if(simulated){void run(async()=>{const seq=epoch.current;const value=await api('/stop',{userId,body:{sessionId:session.id,expectedRevision:session.revision,abandon:false}});if(seq===epoch.current){setData(value);setSelected(session.id);setFilter('all');setMessages(old=>({...old,[session.code]:'실행 정지됨'}))}});return}
    setError('');setConfirmation({kind:'stop',session,abandon:false,change:abandon=>setConfirmation(old=>({...old,abandon}))})
  }
  return <section className={`agent-mode-card trading-agent${simulated?' browser-trading':''}`}>
    <div className="trading-heading"><h2>자동매매 에이전트</h2><button type="button" onClick={refresh} disabled={busy}><RefreshCw size={14}/>상태 확인</button></div>
    <p className="trading-policy"><ShieldAlert size={16}/>{simulated?'확정 일봉 전략 · 선택 증권사의 시세 · 한국 시간':'현금주식 · KRX 정규장 시간 내 · 증권사별 공식 주문 경로 · 브라우저를 닫아도 서버 실행 유지'}</p>
    {simulated&&data?.storageError&&<p className="trading-error" role="alert">{data.storageError}</p>}
    {!simulated&&data&&!data.flags.liveEnabled&&<p className="trading-notice" role="status">LIVE 비활성 · 설정을 저장해도 실제 주문은 시작되지 않습니다.</p>}
    {!simulated&&data&&(!data.flags.workerEnabled||!data.flags.liveEnabled)&&data.sessions.some(active)&&<p className="trading-error" role="alert">실행 서버가 비활성입니다. 남은 보유분·미체결의 자동 관리가 중단될 수 있으므로 상태와 계좌를 확인해 주세요.</p>}
    <div className="trading-tabs" role="tablist" aria-label="매매 관리">{[['settings','설정'],['execution','실행'],['progress','진행상황']].map(([id,label],i)=><button type="button" role="tab" id={`trading-tab-${id}`} aria-controls="trading-panel" aria-selected={view===id} tabIndex={view===id?0:-1} ref={el=>tabs.current[i]=el} key={id} onClick={()=>setView(id)} onKeyDown={event=>{const n={ArrowRight:(i+1)%3,ArrowLeft:(i+2)%3,Home:0,End:2}[event.key];if(n!==undefined){event.preventDefault();setView(['settings','execution','progress'][n]);tabs.current[n]?.focus()}}}>{label}</button>)}</div>
    {error&&<p role="alert" className="trading-error">{error} <button type="button" onClick={refresh} disabled={busy}>다시 확인</button></p>}
    {!data?<p role="status">{error?'설정을 조회하지 못했습니다. 빈 목록으로 처리하지 않습니다.':'저장된 설정 조회 중'}</p>:<div id="trading-panel" role="tabpanel" aria-labelledby={`trading-tab-${view}`}>
      {view==='settings'?<>
        <div className="trading-actions"><label><input type="checkbox" checked={settingsCodes.length>0&&selectedSettings.length===settingsCodes.length} disabled={busy||!settingsCodes.length} onChange={e=>setChecked(e.target.checked?settingsCodes:[])}/>전체 선택</label><button type="button" disabled={busy||!selectedSettings.length} onClick={save}>{simulated?'저장':'선택 항목 저장'}</button><span>저장은 시작이 아닙니다.</span></div>
        {!data.watchlist.length?<p>관심종목을 먼저 등록해 주세요. 최대 20개 종목을 설정할 수 있습니다.</p>:data.watchlist.map((stock,index)=>{
          const config=savedFor(data,stock.code),spec=drafts[stock.code]||config?.spec||initial(stock.code),strategy=data.strategies.find(s=>s.id===spec.strategyId),ready=strategy?tradingReadiness(strategy,spec.entryAction):null,session=sessionFor(data,stock.code),running=active(session),dirty=tradingConfigDirty(drafts[stock.code],config)
          const accounts=connections?.[spec.broker]?.accounts||[],brokerReason=simulated?(spec.broker&&!data.capabilities[spec.broker]?.supported?data.capabilities[spec.broker]?.reason:''):spec.broker&&(!data.capabilities[spec.broker]?.supported?data.capabilities[spec.broker]?.reason:proofState(spec.broker)!=='connected'?proofLabel(spec.broker):!spec.accountRef?'계좌 선택 필요':data.capabilities[spec.broker]?.ordersEnabled===false?'서버 주문 기능 비활성 · 설정 저장 가능':'')
          return <article className="trading-config" key={stock.code}>
            <div className="trading-config-head"><label><input type="checkbox" checked={selectedSettings.includes(stock.code)} onChange={()=>toggle(stock.code,checked,setChecked)} disabled={busy||running}/><strong>{stock.name}</strong> {stock.code}</label><span>{dirty?'변경사항 미저장':config?'저장됨':'미저장'} · 처리 순서 {index+1}</span></div>
            <div className="trading-fields">
              <label>증권사<select aria-label={`${stock.name} 증권사`} value={spec.broker} disabled={busy||running} onChange={e=>{const list=connections?.[e.target.value]?.accounts||[];update(stock.code,{broker:e.target.value,accountRef:list.length===1?list[0].ref:''})}}><option value="">증권사 선택</option>{brokers.map(b=><option key={b} value={b} disabled={(!simulated&&proofState(b)!=='connected')||!data.capabilities[b]?.supported}>{names[b]}{!simulated&&` · ${proofState(b)==='connected'&&!data.capabilities[b]?.supported?'주문 기능 미지원':proofLabel(b)}`}</option>)}</select></label>
              <label>{simulated?'운용 계정':'계좌'}<select aria-label={`${stock.name} 계좌`} value={spec.accountRef} disabled={!spec.broker||busy||running} onChange={e=>update(stock.code,{accountRef:e.target.value})}><option value="">{simulated?'운용 계정 선택':'계좌 선택'}</option>{accounts.map(a=><option key={a.ref} value={a.ref}>{a.label}</option>)}</select></label>
              <label>저장 전략<select aria-label={`${stock.name} 전략`} value={spec.strategyId} disabled={busy||running} onChange={e=>{const s=data.strategies.find(s=>s.id===e.target.value);update(stock.code,{strategyId:s?.id||'',strategyRevision:s?.revision||0,entryAction:simulated?(tradingReadiness(s,'signal').hasEntry?'signal':'once'):''})}}><option value="">전략 선택</option>{data.strategies.map(s=>{const r=tradingReadiness(s,(s.backtest_settings?.entryConditions||[]).some(c=>c.enabled)?'signal':'once');return <option key={s.id} value={s.id} disabled={!r.ready}>{s.name} v{s.revision}</option>})}</select></label>
              <label>수량 운용<select value={spec.quantityMode} disabled={busy||running} onChange={e=>update(stock.code,{quantityMode:e.target.value})}><option value="fixed">고정 수량</option><option value="all_cash">{simulated?'운용 자금 전체 사용':'주문가능 현금 전체 사용'}</option></select></label>
              <label>{spec.quantityMode==='all_cash'?'수량 (전체 현금 모드에서 미사용)':simulated?'수량 · 주':'주문수량 · 주'}<input type="number" min="1" max="1000000" step="1" value={spec.quantity} disabled={spec.quantityMode==='all_cash'||busy||running} onChange={e=>update(stock.code,{quantity:e.target.value})}/></label>
              <label>최초 실행 방식<select value={spec.entryAction} disabled={!strategy||busy||running} onChange={e=>update(stock.code,{entryAction:e.target.value})}><option value="">실행 방식 선택</option>{ready?.hasEntry?<option value="signal">확정 일봉 신호 반복</option>:<><option value="once">신규 1회 진입 후 관리</option>{!simulated&&<option value="manage">기존 보유분 관리 · 신규 매수 없음</option>}</>}</select></label>
              {simulated&&<div className="trading-capital"><span>운용 자금</span><strong>{money(funds[spec.broker]?.cash)}원</strong></div>}
              {spec.entryAction==='manage'&&<label>관리할 기존 보유수량 · 주<input type="number" min="1" step="1" value={spec.manageQuantity} disabled={busy||running} onChange={e=>update(stock.code,{manageQuantity:e.target.value})}/></label>}
            </div>
            {running&&<p className="trading-reason">{simulated?'실행 중인 설정은 변경할 수 없습니다. 정지한 뒤 수정해 주세요.':'실행 중인 설정은 변경할 수 없습니다. 정지와 보유분 관리 상태를 먼저 확인해 주세요.'}</p>}
            {spec.quantityMode==='all_cash'&&<small>수수료·가격 여유와 예약금을 제외합니다. 앞선 종목이 현금을 사용하면 나머지는 자금 부족 대기합니다.</small>}
            {brokerReason&&<p className="trading-reason">{brokerReason}</p>}{ready&&!ready.ready&&<p className="trading-reason">{ready.issues.join(' ')}</p>}{messages[stock.code]&&<p role="status">{messages[stock.code]}</p>}
          </article>
        })}
        {!simulated&&<details className="trading-support"><summary>증권사 지원·실행 제한</summary>{brokers.map(b=><div key={b}><p>{names[b]}: {data.capabilities[b]?.reason||(data.capabilities[b]?.supported?'자동매매 어댑터 지원':'지원되지 않는 주문 기능')} · {proofLabel(b)}</p>{data.capabilities[b]?.executionPolicy&&<PolicySummary policy={data.capabilities[b].executionPolicy} broker={b}/>}</div>)}</details>}
      </>:view==='execution'?<>
        <div className="trading-actions"><label><input type="checkbox" checked={executable.length>0&&selectedRuns.length===executable.length} disabled={busy||!executable.length} onChange={e=>setRunChecked(e.target.checked?executable:[])}/>실행 가능한 항목 전체 선택</label>{!simulated&&<select aria-label="실행 환경" value={mode} onChange={e=>setMode(e.target.value)}><option value="LIVE">LIVE · 실제 주문</option><option value="PAPER" disabled>PAPER · 실행 미지원</option></select>}<button type="button" disabled={busy||!selectedRuns.length} onClick={()=>preview(selectedRuns)}>{simulated?'시작':'선택 항목 실행'}</button><span>설정 수정은 설정 영역에서 할 수 있습니다.</span></div>
        <div className="trading-execution-configs">
          {!orderedConfigs.length&&<p>설정에서 실행 대상을 먼저 저장해 주세요.</p>}
          {orderedConfigs.map(config=>{const s=sessionFor(data,config.code),running=active(s),shown=tradingExecutionSnapshot(config,s,data.strategies),spec=shown.spec,block=blocks[config.code]
            return <article className="trading-config trading-execution-row" key={config.id}>
              <div className="trading-config-head"><label><input type="checkbox" aria-label={`${byCode[config.code]||config.code} 실행 대상`} checked={selectedRuns.includes(config.code)} disabled={busy||Boolean(block)} onChange={()=>toggle(config.code,runChecked,setRunChecked)}/><strong>{byCode[config.code]||config.code}</strong> {config.code}</label><span>{running?'실행 스냅샷 적용 중':tradingConfigDirty(drafts[config.code],config)?'변경사항 미저장':'저장됨 · 시작 가능 여부 확인'}</span></div>
              <dl className="trading-fields trading-readonly-fields"><div><dt>{simulated?'증권사·운용 계정':'증권사·계좌'}</dt><dd>{names[spec.broker]} · {shown.accountLabel||accountLabel(spec)}</dd></div><div><dt>전략·저장 버전</dt><dd>{shown.strategy?.name||'전략 확인 필요'} v{shown.strategy?.revision??spec.strategyRevision}</dd></div><div><dt>수량 운용</dt><dd>{quantityLabel(spec,simulated)}</dd></div><div><dt>최초 실행 방식</dt><dd>{entryLabel(spec)}</dd></div><div><dt>현재 상태</dt><dd>{s?phases[phase(s,data.intents)]||phase(s,data.intents):'저장됨 · 시작 전'}</dd></div><div><dt>저장 설정 버전</dt><dd>v{config.revision}</dd></div></dl>
              {!simulated&&<PolicySummary compact policy={shown.policy||data.capabilities[spec.broker]?.executionPolicy} broker={spec.broker}/>}
              {block&&<p className="trading-reason">{block}</p>}
              <div className="trading-actions"><button type="button" aria-label={`${byCode[config.code]||config.code} 실행`} disabled={busy||Boolean(block)} onClick={()=>preview([config.code])}><Play size={14}/>시작</button><button type="button" aria-label={`${byCode[config.code]||config.code} 정지`} disabled={busy||!running} onClick={()=>stop(s)}><Square size={14}/>정지</button></div>
              {messages[config.code]&&<p role="status">{messages[config.code]}</p>}
            </article>
          })}
        </div>
      </>:<>
        <div className="trading-actions"><label>실행 이력 구분<select aria-label="진행상황 실행 필터" value={filter} onChange={e=>{setFilter(e.target.value);setSelected(null)}}><option value="active">진행 중</option><option value="stopped">정지</option><option value="completed">완료</option><option value="all">전체 이력</option></select></label><span>같은 종목도 실행 ID별로 구분합니다.</span></div>
        <div className="trading-progress-layout"><div className="trading-run-list" aria-label="진행상황 실행 목록">
          {!progress.length&&<p>이 구분에 해당하는 실행이 없습니다.</p>}
          {progress.map(s=><article key={s.id} className={selected===s.id?'selected':''}><button type="button" className="trading-run-select" aria-pressed={selected===s.id} aria-label={`${byCode[s.code]||s.code} ${names[s.broker]} 실행 ${s.id} 진행상황`} onClick={()=>setSelected(s.id)}><strong>{byCode[s.code]||s.snapshot?.name||s.code} · {s.code}</strong><span>{names[s.broker]} · {phases[phase(s,data.intents)]||phase(s,data.intents)}</span><small>{s.snapshot?.accountLabel||(simulated?'운용 계정':'본인 계좌')}{!simulated&&` · ${s.mode}`}</small><small>실행 {s.id.slice(0,8)} · {when(s.created_at)}</small></button></article>)}
        </div>{chosen?<SelectedProgress key={chosen.id} session={chosen} data={data} userId={userId} api={api} credentialRevision={credentialRevision} simulated={simulated}/>:<div className="trading-chart-empty">종목을 선택하면 진행상황을 확인할 수 있습니다</div>}</div>
      </>}
    </div>}
    {confirmation&&<Confirmation value={confirmation} busy={busy} error={error} onClose={()=>setConfirmation(null)} onConfirm={confirm}/>}</section>
}
