// Isolated verification only. Every market response and account is synthetic.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import BrowserTradingAgentPanel from '../../src/components/BrowserTradingAgentPanel'
import { createBrowserTradingEngine } from '../../src/utils/browserTradingEngine.js'
import { createBrowserTradingMarket } from '../../src/services/browserTradingMarket.js'
import { setTheme as applyTheme } from '../../src/services/theme.js'
import '../../src/styles.css'
import '../../src/components/AlertAgentPanel.css'

let clock=Date.parse('2026-11-16T10:00:15+09:00'),price=33000,marketClosed=false,readError=false,falling=false,delayNext=false,release=null
const metrics={reads:[],forbiddenFetches:[],engineReads:0}
// The clock belongs to this fixture, never the production entry point.
Date.now=()=>clock
window.fetch=async(input,options={})=>{
  metrics.forbiddenFetches.push({url:String(input),method:options.method||'GET'})
  throw new Error('Fixture forbids network, broker gateway and LIVE worker requests')
}
const indicators=[{id:'rsi',period:14,lower:30,upper:70,color:'#35cf9c',upperColor:'#ff5c69',lowerColor:'#4b86ff'},
  {id:'bollinger',period:20,multiplier:2,upperColor:'#a98bff',middleColor:'#7589a8',lowerColor:'#a98bff'}]
const base={revision:1,schema_version:2,indicators,backtest_settings:{takeProfitPct:5,stopLossPct:3,entryConditions:[],entryMode:'all'}}
const strategies=[{...base,id:'fixture-rsi-bollinger',name:'RSI·볼린저 조건',backtest_settings:{...base.backtest_settings,entryConditions:[{indicatorId:'rsi',enabled:true,left:'rsi',operator:'lte',right:{type:'constant',value:30}}]}},
  {...base,id:'fixture-once',name:'RSI·볼린저 익절·손절'}]
const stocks=[{code:'089970',name:'브이엠'},{code:'005930',name:'삼성전자'},...Array.from({length:18},(_,i)=>({code:String(100001+i),name:`격리 종목 ${i+3}`}))]
const date=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value))
function dailyRows(){
  const output=[]
  for(let i=450;i>=1;i--){const at=Date.parse('2026-11-16T00:00:00+09:00')-i*86400000,weekday=new Date(at+9*3600000).getUTCDay();if(weekday===0||weekday===6)continue;const n=output.length,close=falling?50000-n*50:10000+n*50;output.push({time:date(at),open:close-10,high:close+40,low:close-40,close,volume:10000+n})}
  return output.slice(-300)
}
function chartRows(symbol,period,limit){
  const offset=symbol==='089970'?0:150000
  if(!period.endsWith('분'))return dailyRows().slice(-limit).map(row=>({...row,open:row.open+offset,high:row.high+offset,low:row.low+offset,close:row.close+offset}))
  const step=Number.parseInt(period,10)*60000,result=[]
  let at=Math.floor(clock/step)*step
  while(result.length<limit){
    const kst=new Date(at+9*3600000),weekday=kst.getUTCDay(),minute=kst.getUTCHours()*60+kst.getUTCMinutes()
    if(weekday!==0&&weekday!==6&&minute>=540&&minute<930){
      const n=result.length,close=n===0?price+offset:price+offset+Math.round(Math.sin(n/7)*500)-n*2
      result.push({time:at/1000,open:close-20,high:close+70,low:close-80,close,volume:1000+n*10})
    }
    at-=step
  }
  return result.reverse()
}
const engineFactory=options=>{
  metrics.engineReads++
  return createBrowserTradingEngine({...options,now:()=>clock})
}
const marketFactory=()=>createBrowserTradingMarket({now:()=>clock,
  readCandles:async(broker,symbol,period,limit,{signal})=>{
    metrics.reads.push({kind:'candles',broker,symbol,period,limit,at:clock})
    if(readError)throw new Error('격리 시세 응답 실패')
    const response={sourceBroker:broker,items:chartRows(symbol,period,limit),meta:{timestampMeaning:period.endsWith('분')?'start':'date',market:broker==='toss'?'PROVIDER':'KRX',invalidRows:0}}
    if(delayNext){delayNext=false;await new Promise(resolve=>{release=resolve})}
    signal?.throwIfAborted();return response
  },
  readDaily:async(symbol,signal)=>{metrics.reads.push({kind:'daily',symbol,at:clock});signal?.throwIfAborted();if(readError)throw new Error('격리 일봉 응답 실패');return {ready:true,symbol:{code:symbol,source:'isolated-fixture'},items:dailyRows(),quality:{policy:'fixture-confirmed',quarantined:0,issues:[]}}},
  readSession:async()=>{metrics.reads.push({kind:'session',at:clock});return {source:'토스증권',markets:['KRX','NXT'],date:date(clock),phase:marketClosed?'afterMarket':'regularMarket',label:marketClosed?'장 종료':'정규장',serverNow:new Date(clock).toISOString(),stale:false,currentSession:{phase:marketClosed?'afterMarket':'regularMarket',startAt:`${date(clock)}T09:00:00+09:00`,endAt:`${date(clock)}T15:30:00+09:00`}}},
  readScreenMeta:async()=>({available:true,cutoff:'2026-11-13'}),
})

function Fixture(){
  const[user,setUser]=useState('qa-browser-a'),[count,setCount]=useState(2),[message,setMessage]=useState(''),[report,setReport]=useState(''),[input,setInput]=useState(String(price)),[theme,setTheme]=useState(document.documentElement.dataset.theme||'dark')
  const control=(fn,label)=>()=>{fn();setMessage(`${label} · ${new Date(clock).toISOString()}`)}
  return <main style={{padding:16,maxWidth:1600,margin:'auto'}}>
    <aside className="panel" style={{padding:12,marginBottom:12,fontSize:12}} aria-label="격리 검증 도구">
      <h1 style={{fontSize:15}}>격리 UI 검증 · 모든 계정·가격·봉은 모의 응답 · 운영 API 접근 금지</h1>
      <div style={{display:'flex',flexWrap:'wrap',gap:7}}>
        <button type="button" onClick={()=>setUser('qa-browser-a')}>계정 A</button><button type="button" onClick={()=>setUser('qa-browser-b')}>계정 B</button><button type="button" onClick={()=>setUser(null)}>로그아웃</button>
        <button type="button" onClick={()=>{const next=theme==='dark'?'light':'dark';applyTheme(next);setTheme(next)}}>테마 {theme}</button>
        <button type="button" onClick={()=>setCount(count===2?20:2)}>관심종목 {count}개</button>
        <button type="button" onClick={control(()=>{clock+=16000},'시각 16초 증가')}>시각 +16초</button>
        <button type="button" onClick={control(()=>{clock+=900000},'다음 15분')}>시각 +15분</button>
        <label>관측 가격 <input aria-label="격리 관측 가격" type="number" value={input} onChange={e=>setInput(e.target.value)} style={{width:100}}/></label>
        <button type="button" onClick={control(()=>{price=Number(input);clock+=16000},'관측 가격 적용')}>가격 적용</button>
        <button type="button" onClick={control(()=>{falling=!falling;clock+=61000},'일봉 방향 전환')}>일봉 방향 전환</button>
        <button type="button" onClick={control(()=>{marketClosed=!marketClosed;clock+=16000},'장 상태 전환')}>장 종료 전환</button>
        <button type="button" onClick={control(()=>{readError=!readError;clock+=61000},'조회 오류 전환')}>조회 오류 전환</button>
        <button type="button" onClick={control(()=>{delayNext=true;clock+=61000},'다음 차트 응답 지연')}>다음 응답 지연</button>
        <button type="button" onClick={control(()=>{release?.();release=null},'지연 응답 전달')}>지연 응답 전달</button>
        <button type="button" onClick={()=>setReport(JSON.stringify({user,clock:new Date(clock).toISOString(),...metrics}))}>검증 상태</button>
      </div><p role="status">{message}</p><pre aria-label="격리 검증 결과" style={{maxHeight:150,overflow:'auto',whiteSpace:'pre-wrap'}}>{report}</pre>
    </aside>
    <BrowserTradingAgentPanel userId={user} onLogin={()=>setUser('qa-browser-a')} watchlist={{ready:true,rows:stocks.slice(0,count),refresh:()=>{}}} strategies={{loading:false,rows:strategies,refresh:()=>{}}} engineFactory={engineFactory} marketFactory={marketFactory}/>
  </main>
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>)
