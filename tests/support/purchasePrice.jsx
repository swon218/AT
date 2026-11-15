import React,{useCallback,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ChartWorkspace} from '../../src/App'
import useOrderAccountSummary from '../../src/hooks/useOrderAccountSummary'
import useIndicatorDraft from '../../src/hooks/useIndicatorDraft'
import {isBrokerConfigured} from '../../src/utils/brokers'
import {getTheme,setTheme} from '../../src/services/theme'
import {fixtureUsers,setPurchaseFixtureAuth} from './purchasePriceAuth'
import {purchaseChartReport,zoomPurchaseFixtureCharts} from './purchasePriceCharts'
import '../../src/styles.css'
import '../../src/lab.css'

const noop=()=>{}
const watchlist={rows:[],canToggle:false}
const scenarios=[['holding','보유 10주 · 평균 200,000원'],['updated','추가 매수 · 평균 210,000원'],['partial','부분 매도 · 보유 5주'],['pendingSell','미체결 매도 · 보유 10주 / 가능 0주'],['sold','전량 매도 확인 · 보유 0주'],['pendingBuy','미체결 매수만 · 보유 0주'],['notHeld','선택 종목 미보유'],['missingAverage','평균 매입가 누락'],['missingQuantity','보유수량 누락'],['error','보유정보 조회 실패'],['duplicate','같은 종목 복수 보유 구분'],['kbUnsettled','KB 미결제 보유분 · 기준 미확인'],['outside','평균 800,000원 · 차트 범위 밖'],['slow','느린 이전 응답 3초']]
const stocks={'005930':{code:'005930',name:'삼성전자',market:'KRX',price:205000,change:1},'000660':{code:'000660',name:'SK하이닉스',market:'KRX',price:255000,change:1}}

function Fixture(){
 const [user,setUser]=useState('a'),[registered,setRegistered]=useState('toss'),[scenario,setScenario]=useState('holding'),[broker,setBroker]=useState('toss'),[symbol,setSymbol]=useState('005930'),[period,setPeriod]=useState('일'),[accountId,setAccountId]=useState(''),[version,setVersion]=useState(0),[refreshVersion,setRefreshVersion]=useState(0),[active,setActive]=useState(true),[lab,setLab]=useState(false),[theme,saveTheme]=useState(getTheme),[report,setReport]=useState(null),[requestLog,setRequestLog]=useState(null)
 const currentUser=user==='guest'?null:{id:fixtureUsers[user]}
 const integrationStatus=Object.fromEntries(['kiwoom','toss','nh','kb'].map(id=>[`${id}Configured`,registered==='all'||registered===id]))
 const refresh=useCallback(()=>setRefreshVersion(value=>value+1),[])
 const account=useOrderAccountSummary({active:active&&!lab,userId:currentUser?.id,broker,configured:isBrokerConfigured(integrationStatus,broker),credentialVersion:version,accountId,symbol,refreshVersion})
 const draft=useIndicatorDraft(currentUser?.id,{authenticated:!!currentUser,rows:[],save:async()=>{throw Error('격리 검증에서는 전략 DB를 변경하지 않습니다.')},remove:async()=>{},refresh:noop})
 const labDraft=useIndicatorDraft(currentUser?.id,{authenticated:!!currentUser,rows:[],save:async()=>{throw Error('격리 검증에서는 전략 DB를 변경하지 않습니다.')},remove:async()=>{},refresh:noop})
 const changeUser=value=>{setPurchaseFixtureAuth({user:value});setUser(value);setAccountId('')}
 const changeScenario=value=>{setPurchaseFixtureAuth({scenario:value});setScenario(value);refresh()}
 const changeBroker=value=>{setBroker(value);setAccountId('')}
 const changeRegistration=value=>{setRegistered(value);setVersion(value=>value+1)}
 async function inspect(){setReport(purchaseChartReport());setRequestLog(await(await fetch('/__purchase_fixture/log')).json())}
 return <div className={`app-shell${lab?' lab-mode':''}`}><aside className="sidebar"><b>ATLAS · 매입가 모의 검증</b><p>개인 API·실계좌·주문·유료 호출 없음</p><p>실험실 일봉도 합성 데이터입니다. 운영 DB에는 접속하지 않습니다.</p></aside><main>
  <header style={{gap:8}}><details className="purchase-fixture-controls"><summary>검증 조건</summary><div>
   <label>회원<select aria-label="검증 회원" value={user} onChange={event=>changeUser(event.target.value)}><option value="guest">비회원</option><option value="a">회원 A</option><option value="b">회원 B</option></select></label>
   <label>개인 API 등록<select aria-label="검증 API 등록" value={registered} onChange={event=>changeRegistration(event.target.value)}><option value="none">미등록</option><option value="toss">토스만 등록</option><option value="all">4개 등록</option></select></label>
   <label>계좌 응답<select aria-label="검증 계좌 응답" value={scenario} onChange={event=>changeScenario(event.target.value)}>{scenarios.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
   <label>종목<select aria-label="검증 종목" value={symbol} onChange={event=>setSymbol(event.target.value)}>{Object.values(stocks).map(stock=><option value={stock.code} key={stock.code}>{stock.name}</option>)}</select></label>
   <label>주기<select aria-label="검증 차트 주기" value={period} onChange={event=>setPeriod(event.target.value)}>{['1분','5분','10분','15분','30분','60분','일','주','월'].map(value=><option key={value}>{value}</option>)}</select></label>
   <button type="button" onClick={()=>changeRegistration('none')}>개인 API 삭제 모의</button>
   <button type="button" onClick={refresh}>계좌 새로고침 모의</button>
   <button type="button" onClick={()=>setActive(value=>!value)}>{active?'화면 나가기':'주식주문 다시 진입'}</button>
   <button type="button" onClick={zoomPurchaseFixtureCharts}>차트 확대 모의</button>
  </div></details>
  <button type="button" onClick={()=>{const next=theme==='dark'?'light':'dark';setTheme(next);saveTheme(next)}}>테마 전환</button>
  <button type="button" onClick={()=>setLab(value=>!value)}>{lab?'주식주문 검증 전환':'실험실 검증 전환'}</button>
  <button type="button" onClick={inspect}>차트·요청 기록 확인</button></header>
  <div className="content guest-content order-content">{active?<ChartWorkspace key={lab?'lab':'order'} indicatorsOnly={lab} labWorkspace={{selection:stocks[symbol],refreshVersion,refreshData:refresh}} watchlist={watchlist} selected={stocks[symbol]} period={period} onPeriodChange={setPeriod} currentUser={currentUser} integrationStatus={integrationStatus} integrationVersion={version} broker={broker} onBrokerChange={changeBroker} accountSummary={account.summary||null} accountLoading={account.status==='loading'} accountError={account.error||''} accountReceivedAt={account.receivedAt} accountScope={account.accountScope} accountId={accountId} accountOptions={account.accounts} onAccountChange={setAccountId} onAccountRefresh={refresh} {...(lab?labDraft:draft)}/>:<p>주식주문 화면을 나갔습니다. 매입가 표시 상태는 보존하지 않습니다.</p>}</div>
  <details className="purchase-fixture-report" open={!!report}><summary>격리 검증 결과</summary><pre aria-label="차트 계측 결과">{JSON.stringify(report,null,2)}</pre><pre aria-label="모의 API 요청 기록">{JSON.stringify(requestLog,null,2)}</pre></details>
 </main><style>{`.purchase-fixture-controls{position:relative;font-size:12px}.purchase-fixture-controls>div{position:absolute;left:0;top:28px;z-index:1000;width:min(650px,calc(100vw - 40px));padding:12px;background:var(--surface-panel);border:1px solid var(--border-default);border-radius:8px;display:flex;gap:10px;flex-wrap:wrap}.purchase-fixture-controls label{display:flex;flex-direction:column;gap:5px}.purchase-fixture-controls :is(select,button),header>button{color:var(--text-primary);background:var(--surface-field);border:1px solid var(--border-default);border-radius:5px;padding:6px;font-size:12px}.purchase-fixture-controls summary{cursor:pointer;white-space:nowrap}.purchase-fixture-report{padding:16px;font-size:12px}.purchase-fixture-report pre{max-width:100%;max-height:500px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}header>button{white-space:nowrap;cursor:pointer}.sidebar>b,.sidebar>p{margin:16px;font-size:12px;line-height:1.6}@media(max-width:540px){header{height:auto;min-height:67px;flex-wrap:wrap;padding:8px!important}}`}</style></div>
}
createRoot(document.getElementById('root')).render(<Fixture/> )
