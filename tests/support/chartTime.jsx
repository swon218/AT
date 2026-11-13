import React,{useState,useEffect} from 'react'
import {createRoot} from 'react-dom/client'
import TradingViewChart from '../../src/components/TradingViewChart'
import {describeChartScope} from '../../src/utils/chartScope'
import {createIndicatorConfig} from '../../src/utils/indicators'
import {setLegacy,showCrosshair,reportCharts} from './chartTimeCharts'
import '../../src/styles.css'
let theme='dark';const listeners=new Set()
window.atlasTheme={getSnapshot:()=>theme,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)},set:value=>{theme=value;document.documentElement.dataset.theme=value;listeners.forEach(f=>f())}}
document.documentElement.dataset.theme=theme
const labRows=Array.from({length:80},(_,n)=>({time:new Date(Date.UTC(2026,5,n+1)).toISOString().slice(0,10),open:10000+n,high:10020+n,low:9980+n,close:10005+n,volume:100+n}))
function Fixture(){
  const [period,setPeriod]=useState('1분'),[broker,setBroker]=useState('kiwoom'),[symbol,setSymbol]=useState('000001'),[lab,setLab]=useState(false),[legacy,setOld]=useState(false),[indicators,setIndicators]=useState(true),[record,setRecord]=useState(null),[report,setReport]=useState({}),[requests,setRequests]=useState([])
  useEffect(()=>{const timer=setInterval(()=>{setReport(reportCharts());fetch('/api/fixture/requests').then(r=>r.json()).then(setRequests)},250);return()=>clearInterval(timer)},[])
  const p=lab?'일':period,stock={code:symbol,name:`모의 검증 종목 ${symbol}`}
  const key=JSON.stringify([symbol,p,'guest',broker]),current=record?.key===key?record:null
  return <main style={{padding:16,minWidth:0,maxWidth:1300,margin:'auto'}}>
    <h2>ATLAS · 차트 시간 모의 검증</h2><p>실제 증권사·계좌·주문 연결 없음 · 설치된 Lightweight Charts 5.2</p>
    <div style={{display:'flex',flexWrap:'wrap',gap:10,padding:'10px 0'}}>
      <label>증권사 <select aria-label="증권사" value={broker} onChange={e=>setBroker(e.target.value)}>{['kiwoom','toss','nh','kb'].map(v=><option key={v}>{v}</option>)}</select></label>
      <label>주기 <select aria-label="주기" value={period} onChange={e=>setPeriod(e.target.value)}>{['1분','5분','10분','15분','30분','60분','일','주','월'].map(v=><option key={v}>{v}</option>)}</select></label>
      <label>응답 <select aria-label="응답" value={symbol} onChange={e=>setSymbol(e.target.value)}>{[['000001','정상'],['000002','다른 종목'],['000003','빈 결과'],['000004','통신 실패'],['000005','부분 조회'],['000006','느린 이전 종목']].map(([v,n])=><option value={v} key={v}>{n}</option>)}</select></label>
      <button onClick={()=>window.atlasTheme.set(theme==='dark'?'light':'dark')}>테마 전환</button>
      <button onClick={()=>{setLab(v=>!v);setRecord(null)}}>실험실 일봉 전환</button>
      <button onClick={()=>setIndicators(v=>!v)}>보조지표 전환</button>
      <button onClick={()=>{setLegacy(!legacy);setOld(!legacy)}}>기존 UTC 표시 재현</button>
    </div>
    <article className="panel chart-panel" style={{height:'min(62vh,600px)',minHeight:330,display:'flex',flexDirection:'column'}}>
      <h3 style={{margin:8}}>{stock.name} · {p} · {legacy?'기존 기본 표시':'한국 시간 표시'}</h3>
      <p className="chart-data-scope">{lab?'내장 DB 일봉 · 날짜 기준':describeChartScope(current,p)}</p>
      <div className="tradingview-host" style={{flex:'1 1 0',minHeight:0}}><TradingViewChart key={`${legacy}:${lab}`} stock={stock} period={p} broker={broker} candles={lab?labRows:undefined} onMetadataChange={setRecord} indicators={indicators?[createIndicatorConfig('ma'),createIndicatorConfig('cci')]:[]}/></div>
    </article>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',margin:'12px 0'}}>{['08:00','08:30','09:00','15:30','20:00','date'].map(v=><button key={v} onClick={()=>showCrosshair(v)}>{v==='date'?'날짜 봉 교차선':`${v} 교차선`}</button>)}</div>
    <output aria-label="실제 차트 포맷터 호출 결과">교차선: {report.label||'기본 라이브러리 표시 / 선택 전'}</output>
    <pre style={{fontSize:11,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>차트 상태: {JSON.stringify(report)}<br/>요청 기록: {JSON.stringify(requests)}</pre>
  </main>
}
createRoot(document.getElementById('root')).render(<Fixture/> )
