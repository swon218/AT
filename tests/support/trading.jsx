import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import TradingAgentPanel from '../../src/components/TradingAgentPanel'
import {getTheme,setTheme as applyTheme} from '../../src/services/theme.js'
import '../../src/styles.css'
import '../../src/components/AlertAgentPanel.css'

const strategy={id:'11111111-1111-4111-8111-111111111111',name:'격리 검증 익절·손절',schema_version:2,revision:1,indicators:[],backtest_settings:{takeProfitPct:5,stopLossPct:3,entryMode:'all',entryConditions:[]}}
const brokers=['kiwoom','toss','nh','kb'],refs={kiwoom:'a'.repeat(32),toss:'b'.repeat(32),nh:'c'.repeat(32)}
const policies={kiwoom:{routeLabel:'KRX',quoteLabel:'KRX',chartLabel:'KRX',tradingWindow:'KRX 정규장 시간 내'},toss:{routeLabel:'증권사 기본 SOR · 거래소 지정 없음',quoteLabel:'공급자 시세 · 거래소 미제공',chartLabel:'공급자 봉 · 거래소 미제공',tradingWindow:'KRX 정규장 시간 내'},nh:{routeLabel:'KRX · 격리 계약 모의',quoteLabel:'KRX',chartLabel:'KRX',tradingWindow:'KRX 정규장 시간 내'}}
let context,requests,failSave,proof,delayedCharts,previews,started
const fixtureAccountLabel=spec=>`격리 ${spec.broker} 계좌 ${spec.broker==='nh'&&spec.accountRef==='d'.repeat(32)?2:1}`
const specFor=(code,broker)=>({code,broker,accountRef:refs[broker],strategyId:strategy.id,strategyRevision:1,quantityMode:'fixed',quantity:3,entryAction:'once'})
function reset(){
 context={flags:{liveEnabled:true,workerEnabled:true,paperEnabled:false},capabilities:Object.fromEntries(brokers.map(b=>[b,{supported:b!=='kb',ordersEnabled:b!=='kb',reason:b==='kb'?'개인 시세·체결 대사 계약 확인 필요':'격리 모의 어댑터 지원 · 실제 운영 지원과 별개',executionPolicy:policies[b]}])),watchlist:[{code:'005930',name:'삼성전자'},{code:'000660',name:'SK하이닉스'},{code:'009150',name:'삼성전기'}],strategies:[structuredClone(strategy)],configs:[],sessions:[],intents:[],events:[]}
 context.configs=context.watchlist.map((row,i)=>({id:crypto.randomUUID(),code:row.code,revision:1,spec:specFor(row.code,brokers[i]),accountLabel:fixtureAccountLabel(specFor(row.code,brokers[i])),strategySnapshot:structuredClone(strategy),executionPolicy:structuredClone(policies[brokers[i]])}))
 requests=[];failSave=false;proof=false;delayedCharts=false;previews=new Map();started=new Map()
}
reset()
const makeSession=(config,status='waiting_signal')=>({id:crypto.randomUUID(),config_id:config.id,code:config.code,broker:config.spec.broker,account_ref:config.spec.accountRef,mode:'LIVE',status,revision:1,snapshot:{spec:structuredClone(config.spec),strategy:structuredClone(config.strategySnapshot||strategy),accountLabel:config.accountLabel,executionPolicy:structuredClone(config.executionPolicy||policies[config.spec.broker])},state:{position:null,closedTrades:[],entryCount:0,checkedAt:new Date().toISOString(),reason:'signal_unmet',priority:context.configs.indexOf(config)+1},created_at:new Date().toISOString(),updated_at:new Date().toISOString()})
const api=async(path='',{body}={})=>{
 requests.push({path,mutation:Boolean(body)})
 if(path==='/connections')return Object.fromEntries(brokers.map(b=>[b,{connected:b!=='kb'&&!proof,status:proof?'failed':b!=='kb'?'connected':'unconfigured',expiresAt:Date.now()+60000,accounts:refs[b]?[{ref:refs[b],label:`격리 ${b} 계좌 1`},...(b==='nh'?[{ref:'d'.repeat(32),label:'격리 nh 계좌 2'}]:[])]:[]}]))
 if(path==='/config'){
  if(failSave)throw new Error('격리 저장 실패 · 기존 설정 유지')
  const selectedStrategy=context.strategies.find(row=>row.id===body.spec.strategyId&&Number(row.revision)===Number(body.spec.strategyRevision))
  if(!selectedStrategy)throw new Error('격리 저장 전략 버전 변경 · 다시 선택해 주세요.')
  const canonical={spec:structuredClone(body.spec),accountLabel:fixtureAccountLabel(body.spec),strategySnapshot:structuredClone(selectedStrategy),executionPolicy:structuredClone(policies[body.spec.broker])}
  const c=context.configs.find(x=>x.code===body.spec.code)
  if(c)Object.assign(c,canonical,{revision:c.revision+1})
  else context.configs.push({id:crypto.randomUUID(),code:body.spec.code,revision:1,...canonical})
 }
 if(path==='/preview'){
  const c=context.configs.find(x=>x.id===body.configId),id=crypto.randomUUID();previews.set(id,c)
  return {id,expiresAt:new Date(Date.now()+300000).toISOString(),summary:{code:c.code,broker:c.spec.broker,accountLabel:c.accountLabel||'격리 모의 계좌 · 실제 주문 없음',strategy:structuredClone(c.strategySnapshot||strategy),spec:structuredClone(c.spec),mode:'LIVE',entryMethod:'개인 API 현금 지정가 · 미체결 취소 확인',exitMethod:'개인 API 현금 시장가',session:'KRX 정규장 시간 내',stopPolicy:'신규 진입 중단 · 보유분 관리 유지',executionPolicy:policies[c.spec.broker]}}
 }
 if(path==='/start'&&!started.has(body.requestId)){const c=previews.get(body.previewId);if(!c)throw Error('격리 확인 만료');const s=makeSession(c);context.sessions.unshift(s);started.set(body.requestId,s.id)}
 if(path==='/stop'){const s=context.sessions.find(x=>x.id===body.sessionId);s.status=body.abandon||!s.state.position?'stopped':'stopping';s.stop_requested=true;s.abandon_requested=body.abandon;s.revision++;s.state.reason=body.abandon?'protection_stopped':null}
 if(path.startsWith('/session?')){const id=new URLSearchParams(path.split('?')[1]).get('sessionId'),s=context.sessions.find(row=>row.id===id);if(!s)throw Error('격리 실행 없음');return structuredClone({...context,sessions:[s],intents:context.intents.filter(i=>i.session_id===id),events:context.events.filter(e=>e.session_id===id)})}
 if(path.startsWith('/chart?')){
  const params=new URLSearchParams(path.split('?')[1]),period=params.get('interval'),s=context.sessions.find(row=>row.id===params.get('sessionId'));if(!s)throw Error('격리 실행 없음')
  const broker=s.broker,base=broker==='kiwoom'?198000:broker==='toss'?498000:248000,minute=period.endsWith('분'),n=Number(period.replace('분',''))||1
  const result={candles:Array.from({length:80},(_,i)=>({time:minute?Date.UTC(2026,10,13,0,0)/1000+i*n*60:new Date(Date.UTC(2026,8,i+1)).toISOString().slice(0,10),open:base+i*100,high:base+2000+i*100,low:base-1000+i*100,close:base+1000+i*100,volume:1000+i*20})),metadata:{sourceBroker:broker,source:broker,market:broker==='toss'?'공급자 기준 · 거래소 미제공':'KRX',fallback:false}}
  if(delayedCharts)await new Promise(resolve=>setTimeout(resolve,broker==='kiwoom'?2500:100))
  return result
 }
 return structuredClone(context)
}
function Harness(){const [theme,setTheme]=useState(getTheme()),[owner,setOwner]=useState('fixture-owner'),[version,setVersion]=useState(0),[notice,setNotice]=useState('')
 function scenario(type){const s=context.sessions.find(row=>!['stopped','completed'].includes(row.status));if(!s){setNotice('먼저 실행 화면에서 격리 모의 시작을 확인하세요. 실제 API는 호출되지 않습니다.');return}const time=new Date().toISOString();s.revision++;s.state.checkedAt=time
  const base=s.broker==='toss'?500000:s.broker==='nh'?250000:200000
  if(type==='holding'){s.status='holding';s.state={...s.state,position:{quantity:3,costMicros:String(base*3*1e6),averagePrice:base,initialCostMicros:String(base*3*1e6),entryQuantity:3,entryAt:'2026-11-13T00:10:00Z'},markPrice:base+2000,markAt:time,entryCount:1,reason:null};context.intents.push({id:crypto.randomUUID(),session_id:s.id,side:'buy',quantity:3,cumulative_quantity:3,status:'filled'})}
  if(type==='partial'){s.status='buying';s.state={...s.state,position:{quantity:1,costMicros:String(base*1e6),averagePrice:base,initialCostMicros:String(base*1e6),entryQuantity:1,entryAt:'2026-11-13T00:10:00Z'},markPrice:base+2000,markAt:time,entryCount:1,reason:'waiting_fill'};context.intents.push({id:crypto.randomUUID(),session_id:s.id,side:'buy',quantity:3,cumulative_quantity:1,status:'partial'})}
  if(type==='closed'){s.status='closed';s.state={...s.state,position:null,closedTrades:[{id:crypto.randomUUID(),entryAt:'2026-11-13T00:10:00Z',decisionAt:'2026-11-13T00:29:50Z',exitAt:'2026-11-13T00:30:00Z',entryPrice:base,exitPrice:base+10000,quantity:3,pnl:30000,reason:'take_profit'}]}}
  if(type==='waiting'){s.status='waiting_signal';s.state={...s.state,position:null,reason:'signal_unmet'}}
  if(type==='unknown'){s.status='unknown';s.state.reason='order_unknown'}
  context.events.unshift({id:crypto.randomUUID(),session_id:s.id,code:`fixture_${type}`,created_at:time});setNotice(`${s.code} ${type} 반영 · 매매 상태 확인 버튼으로 조회`)
 }
 function history(){const c=context.configs[0],stopped=makeSession(c,'stopped'),completed=makeSession(c,'completed');completed.snapshot.strategy.name='완료 이력의 이전 전략';completed.snapshot.strategy.revision=1;context.sessions.push(stopped,completed);setNotice('같은 종목의 정지/완료 실행 ID 2개 추가 · 상태 확인 클릭')}
 function longList(){context.watchlist=Array.from({length:20},(_,i)=>({code:String(900000+i),name:`격리 긴 종목명 검증 기업 ${i+1}`}));context.configs=context.watchlist.map((row,i)=>({id:crypto.randomUUID(),code:row.code,revision:1,spec:specFor(row.code,brokers[i%3]),accountLabel:fixtureAccountLabel(specFor(row.code,brokers[i%3])),strategySnapshot:structuredClone(strategy),executionPolicy:structuredClone(policies[brokers[i%3]])}));context.sessions=[];setVersion(v=>v+1);setNotice('격리 관심종목 20개')}
 return <div style={{maxWidth:1400,margin:'auto',padding:16}}><h1 style={{fontSize:16}}>격리 UI 검증 · 모든 계좌·가격·주문은 모의 데이터 · 실제 주문 없음</h1><div className="trading-actions">
  <button onClick={()=>{const next=theme==='dark'?'light':'dark';setTheme(next);applyTheme(next)}}>테마 {theme}</button><button onClick={()=>setOwner(owner?'':'fixture-owner')}>{owner?'로그아웃 모의':'로그인 모의'}</button>
  <button onClick={()=>{reset();setVersion(v=>v+1);setNotice('초기화')}}>fixture 초기화</button><button onClick={()=>{failSave=!failSave;setNotice(`저장 실패 ${failSave}`)}}>저장 실패 전환</button>
  <button onClick={()=>{context.flags.workerEnabled=false;context.flags.liveEnabled=false;setNotice('서버 비활성 · 상태 확인 클릭')}}>서버 비활성 모의</button><button onClick={()=>{proof=!proof;setVersion(v=>v+1);setNotice('연결 검증 모의 상태 변경')}}>연결 실패 전환</button>
  <button onClick={()=>{context.capabilities.nh.supported=false;context.capabilities.nh.reason='REST 재시작 복구의 시장주문번호 매핑 확인 필요';setNotice('NH 실제 제한 모의 · 상태 확인 클릭')}}>NH 제한 모의</button>
  <button onClick={()=>{delayedCharts=!delayedCharts;setNotice(`응답 순서 역전 모의 ${delayedCharts}`)}}>차트 응답 지연 전환</button><button onClick={()=>{context.strategies[0]={...strategy,name:'수정된 원본 전략',revision:2};setNotice('원본만 변경 · 상태 확인 클릭')}}>원본 전략 수정 모의</button>
  <button onClick={history}>이력 추가</button><button onClick={longList}>20개 긴 목록</button>{['holding','partial','closed','waiting','unknown'].map(type=><button key={type} onClick={()=>scenario(type)}>{type}</button>)}
 </div><p role="status">{notice}</p><TradingAgentPanel key={`${version}:${owner}`} userId={owner} onLogin={()=>setOwner('fixture-owner')} api={api}/><details><summary>모의 요청 기록</summary><pre>{JSON.stringify(requests,null,2)}</pre></details></div>
}
createRoot(document.getElementById('root')).render(<Harness/>)
