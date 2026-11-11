import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import ScreenerWorkspace from '../../src/components/ScreenerWorkspace'
import useScreener from '../../src/hooks/useScreener'
import {defaultQuery,metric,relative,describeQuery} from '../../src/utils/screener'
import '../../src/styles.css'
import '../../src/theme.css'
function Harness(){
  const screen=useScreener('local-fixture'),[draft,setDraft]=useState(''),[chart,setChart]=useState(''),[theme,setTheme]=useState('dark')
  const restore=(name,other,factor)=>screen.open({...defaultQuery(),conditions:[{left:metric(name),operator:'gte',right:relative(other,factor)}]})
  return <div style={{padding:16,minHeight:'100vh',background:'var(--surface-page)',color:'var(--text-primary)'}}>
    <p>로컬 검증 · 확정 일봉 테스트 DB · 실제 모델·주문·메시지 없음</p>
    <div style={{display:'flex',flexWrap:'wrap',gap:10,marginBottom:16}}><button onClick={()=>{const next=theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;setTheme(next)}}>라이트 / 다크 전환</button>
      <button onClick={()=>restore('volume','sma',2)}>잘못된 기존 조건 복원</button><button onClick={()=>restore('macd','macd_signal',1.2)}>기존 음수 지표 배수 복원</button><button onClick={()=>restore('volume','volume_sma',1.2)}>기존 거래량 1.2배 복원</button>
    </div>
    <ScreenerWorkspace screen={screen} agentReady onOpenChart={row=>setChart(row.code)} onAskAgent={q=>{setDraft(describeQuery(q));return true}}/>
    <p aria-label="AI 전달 초안">{draft}</p><p aria-label="선택 차트">{chart}</p><output style={{display:'block',overflowWrap:'anywhere'}} aria-label="실제 요청 조건">{JSON.stringify(screen.query)}</output>
  </div>
}
document.documentElement.dataset.theme='dark'
createRoot(document.getElementById('root')).render(<Harness/> )
