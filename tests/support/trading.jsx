import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import TradingAgentPanel from '../../src/components/TradingAgentPanel'
import {getTheme,setTheme as applyTheme} from '../../src/services/theme.js'
import '../../src/styles.css'
import '../../src/components/AlertAgentPanel.css'

const strategy={id:'11111111-1111-4111-8111-111111111111',name:'격리 검증 익절·손절',schema_version:2,revision:1,indicators:[],backtest_settings:{takeProfitPct:5,stopLossPct:3,entryMode:'all',entryConditions:[]}}
const code='005930',accountRef='a'.repeat(32)
const baseSpec={code,broker:'kiwoom',accountRef,strategyId:strategy.id,strategyRevision:1,quantityMode:'fixed',quantity:3,entryAction:'once'}
let context,requests=[],failSave=false,proof=false
function reset(){context={flags:{liveEnabled:true,workerEnabled:true,paperEnabled:false},capabilities:Object.fromEntries(['kiwoom','toss','nh','kb'].map(b=>[b,{supported:b==='kiwoom',ordersEnabled:b==='kiwoom',reason:b==='kiwoom'?'KRX 현금 주문·취소·체결 지원':'공식 KRX 주문·대사 미확정 · V1 미지원'}])),watchlist:[{code,name:'삼성전자'},{code:'000660',name:'SK하이닉스'},{code:'009150',name:'삼성전기'}],strategies:[strategy],configs:[{id:'22222222-2222-4222-8222-222222222222',code,revision:1,spec:baseSpec}],sessions:[],intents:[],events:[]};requests=[];proof=false;failSave=false}
reset()
const api=async(path='',{body}={})=>{
 requests.push({path,mutation:Boolean(body)})
 if(path==='/connections')return Object.fromEntries(['kiwoom','toss','nh','kb'].map(b=>[b,{connected:b==='kiwoom'&&!proof,status:proof?'failed':b==='kiwoom'?'connected':'unconfigured',expiresAt:Date.now()+60000,accounts:b==='kiwoom'?[{ref:accountRef,label:'본인 API 연결 계좌'}]:[]}]))
 if(path==='/config'){if(failSave)throw new Error('격리 저장 실패 · 기존 설정 유지');const c=context.configs.find(x=>x.code===body.spec.code);if(c){c.spec=body.spec;c.revision++}else context.configs.push({id:crypto.randomUUID(),code:body.spec.code,revision:1,spec:body.spec})}
 if(path==='/preview'){const c=context.configs.find(x=>x.id===body.configId);return {id:crypto.randomUUID(),expiresAt:new Date(Date.now()+30000).toISOString(),summary:{code:c.code,broker:c.spec.broker,accountLabel:'격리 모의 계좌 · 실제 주문 없음',strategy,spec:c.spec,mode:'LIVE',entryMethod:'KRX 현금 지정가 · 60초 후 잔량 취소 확인',exitMethod:'KRX 현금 시장가',session:'KRX 정규장',stopPolicy:'신규 진입 중단 · 보유분 관리 유지'}}}
 if(path==='/start'){context.sessions.unshift({id:'33333333-3333-4333-8333-333333333333',config_id:context.configs[0].id,code,broker:'kiwoom',account_ref:accountRef,mode:'LIVE',status:'waiting_signal',revision:1,snapshot:{spec:baseSpec,strategy},state:{position:null,closedTrades:[],entryCount:0,checkedAt:new Date().toISOString(),reason:'signal_unmet'},created_at:new Date().toISOString(),updated_at:new Date().toISOString()})}
 if(path==='/stop'){const s=context.sessions.find(x=>x.id===body.sessionId);s.status=body.abandon||!s.state.position?'stopped':'stopping';s.stop_requested=true;s.abandon_requested=body.abandon;s.revision++;s.state.reason=body.abandon?'protection_stopped':null}
 if(path.startsWith('/chart?')){const period=new URLSearchParams(path.split('?')[1]).get('interval'),minute=period.endsWith('분'),n=Number(period.replace('분',''))||1;return {candles:Array.from({length:80},(_,i)=>({time:minute?Date.UTC(2026,10,13,0,0)/1000+i*n*60:new Date(Date.UTC(2026,8,i+1)).toISOString().slice(0,10),open:198000+i*100,high:200000+i*100,low:197000+i*100,close:199000+i*100,volume:1000+i*20})),metadata:{sourceBroker:'kiwoom',fallback:false}}}
 return structuredClone(context)
}
function Harness(){const [theme,setTheme]=useState(getTheme()),[owner,setOwner]=useState('fixture-owner'),[version,setVersion]=useState(0),[notice,setNotice]=useState('')
 function scenario(type){let s=context.sessions[0];if(!s){setNotice('먼저 실행 화면에서 격리 모의 시작을 확인하세요. 실제 API는 호출되지 않습니다.');return}const time=new Date().toISOString();s.revision++;s.state.checkedAt=time
  if(type==='holding'){s.status='holding';s.state={...s.state,position:{quantity:3,costMicros:'600000000000',averagePrice:200000,initialCostMicros:'600000000000',entryQuantity:3,entryAt:'2026-11-13T00:10:00Z'},markPrice:202000,entryCount:1};context.intents=[{id:'i1',session_id:s.id,side:'buy',quantity:3,cumulative_quantity:3,status:'filled'}]}
  if(type==='closed'){s.status='closed';s.state={...s.state,position:null,closedTrades:[{id:'t1',entryAt:'2026-11-13T00:10:00Z',decisionAt:'2026-11-13T00:29:50Z',exitAt:'2026-11-13T00:30:00Z',entryPrice:200000,exitPrice:210000,quantity:3,pnl:30000,reason:'take_profit'}]}}
  if(type==='waiting'){s.status='waiting_signal';s.state={...s.state,position:null,reason:'signal_unmet'}}
  if(type==='unknown'){s.status='unknown';s.state.reason='order_unknown'}
  context.events.unshift({id:crypto.randomUUID(),session_id:s.id,code:`격리 ${type} 상태`,created_at:time});setNotice(`${type} 반영 · 매매 상태 확인 버튼으로 조회`)
 }
 return <div style={{maxWidth:1400,margin:'auto',padding:16}}><h1 style={{fontSize:16}}>격리 UI 검증 · 모든 계좌·가격·주문은 모의 데이터 · 실제 주문 없음</h1><div className="trading-actions"><button onClick={()=>{const next=theme==='dark'?'light':'dark';setTheme(next);applyTheme(next)}}>테마 {theme}</button><button onClick={()=>setOwner(owner?'': 'fixture-owner')}>{owner?'로그아웃 모의':'로그인 모의'}</button><button onClick={()=>{reset();setVersion(v=>v+1);setNotice('초기화')}}>fixture 초기화</button><button onClick={()=>{failSave=!failSave;setNotice(`저장 실패 ${failSave}`)}}>저장 실패 전환</button><button onClick={()=>{context.flags.workerEnabled=false;context.flags.liveEnabled=false;setNotice('서버 비활성 · 상태 확인 클릭')}}>서버 비활성 모의</button><button onClick={()=>{proof=!proof;setNotice('연결 검증 모의 상태 변경 · 재진입 시 확인')}}>연결 실패 전환</button>{['holding','closed','waiting','unknown'].map(type=><button key={type} onClick={()=>scenario(type)}>{type}</button>)}</div><p role="status">{notice}</p><TradingAgentPanel key={`${version}:${owner}`} userId={owner} onLogin={()=>setOwner('fixture-owner')} api={api}/><details><summary>모의 요청 기록</summary><pre>{JSON.stringify(requests,null,2)}</pre></details></div>
}
createRoot(document.getElementById('root')).render(<Harness/> )
