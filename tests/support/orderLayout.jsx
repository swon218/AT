import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import OrderEntryPanel from '../../src/components/OrderEntryPanel'
import {INDICATOR_CATALOG,createIndicatorConfig} from '../../src/utils/indicators'
import {setFixtureCount} from './orderLayoutApi'
import '../../src/styles.css'
import '../../src/lab.css'
function Fixture(){
  const [broker,setBroker]=useState('kiwoom'),[account,setAccount]=useState('a'.repeat(32)),[mode,setMode]=useState('holding'),[lab,setLab]=useState(false),[theme,setTheme]=useState('dark'),[revision,setRevision]=useState(0),[name,setName]=useState('검증용 전략'),[configs,setConfigs]=useState(()=>INDICATOR_CATALOG.slice(0,7).map(v=>createIndicatorConfig(v.id)))
  const guest=mode==='guest',error=mode==='error'?'모의 계좌 조회 실패 · 연결 상태를 확인하고 새로고침해 주세요. '.repeat(9):''
  const storage={authenticated:true,selectedId:'',rows:[],onSelect:()=>{},refresh:()=>{},onSave:()=>{},dirty:true}
  const shared={stock:{code:'005930',name:'모의 검증 종목',market:'KRX'},userId:'layout-fixture',credentialVersion:revision,authenticated:!guest,integrationStatus:{kiwoomConfigured:true,tossConfigured:true,nhConfigured:true,kbConfigured:true},broker,onBrokerChange:setBroker,accountId:account,onAccountChange:setAccount,accountOptions:[{id:'a'.repeat(32),label:'모의 계좌 1'},{id:'c'.repeat(32),label:'모의 계좌 2'}],accountSummary:{broker,selectedAccountId:account,orderableAmount:1000000,holdings:[{code:'005930',averagePrice:70000,quantity:10,tradableQuantity:8,purchaseAmount:700000,evaluationProfit:1000}]},accountError:error,indicatorsOnly:lab,indicatorConfigs:configs,strategyName:name,onStrategyNameChange:setName,onUpdateIndicator:(id,p)=>setConfigs(a=>a.map(c=>c.id===id?{...c,...p}:c)),onRemoveIndicator:id=>setConfigs(a=>a.filter(c=>c.id!==id)),onAddIndicator:id=>setConfigs(a=>[...a,createIndicatorConfig(id)]),onResetIndicators:()=>setConfigs([]),onDeleteIndicators:()=>setConfigs([]),strategyStorage:storage}
  return <div className={`app-shell ${lab?'lab-mode':''}`}><aside className="sidebar"><b>ATLAS · 로컬 검증</b><p>실제 API·주문 연결 없음</p></aside><main><header><span>주식 주문 · 레이아웃 모의 검증</span><button onClick={()=>{const next=theme==='dark'?'light':'dark';setTheme(next);document.documentElement.dataset.theme=next}}>테마 전환</button></header><div className="content guest-content order-content"><section className="preview-grid order-preview-grid">
    <article className={`panel chart-panel ${lab?'lab-chart-panel':''}`}><div style={{padding:16,display:'flex',gap:8,flexWrap:'wrap'}}><label>검증 상태<select aria-label="검증 상태" value={mode} onChange={e=>{setMode(e.target.value);setFixtureCount(e.target.value==='empty'?0:16);setRevision(v=>v+1)}}>{['holding','error','guest','empty'].map(v=><option key={v}>{v}</option>)}</select></label><button onClick={()=>setLab(v=>!v)}>주문 / 실험실 검증</button></div><p style={{padding:16}}>차트 자리 · 실제 주문·정정·취소 전송 차단</p></article>
    <article className="panel preview-order"><OrderEntryPanel key={broker} {...shared}/></article></section></div></main></div>
}
document.documentElement.dataset.theme='dark'
createRoot(document.getElementById('root')).render(<Fixture/> )
