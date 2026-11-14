import React,{useMemo,useState} from 'react'
import {createRoot} from 'react-dom/client'
import LabChartPanel from '../../src/components/LabChartPanel'
import OrderEntryPanel from '../../src/components/OrderEntryPanel'
import useStrategies from '../../src/hooks/useStrategies'
import useIndicatorDraft from '../../src/hooks/useIndicatorDraft'
import {strategyPayload,STRATEGY_CONFLICT} from '../../src/services/strategyRepository'
import {INDICATOR_CATALOG} from '../../src/utils/indicators'
import {getTheme,setTheme as applyTheme} from '../../src/services/theme'
import '../../src/styles.css'

const owner='fixture-owner'
const stock={code:'999999',name:'모의 검증 종목',market:'모의',price:100,change:0,volume:10000}
const rows=[]
const calls={list:0,save:0,remove:0}
const sameOwner=userId=>{if(userId!==owner)throw new Error('모의 소유권 거부')}
const repository={
  async list(userId){sameOwner(userId);calls.list++;return structuredClone(rows)},
  async save(userId,input,selected){
    sameOwner(userId);calls.save++
    const payload=strategyPayload(input),index=selected?rows.findIndex(r=>r.id===selected.id&&r.user_id===userId&&r.revision===selected.revision):-1
    if(selected&&index<0)throw new Error(STRATEGY_CONFLICT)
    if(rows.some(r=>r.name.toLocaleLowerCase()===payload.name.toLocaleLowerCase()&&r.id!==selected?.id))throw new Error('같은 이름의 모의 전략이 있습니다.')
    const previous=index<0?null:rows[index],row={...payload,user_id:userId,id:previous?.id||crypto.randomUUID(),revision:(previous?.revision||0)+1,created_at:previous?.created_at||new Date().toISOString(),updated_at:new Date().toISOString()}
    if(index<0)rows.push(row);else rows[index]=row
    return structuredClone(row)
  },
  async remove(userId,selected){sameOwner(userId);calls.remove++;const index=rows.findIndex(r=>r.user_id===userId&&r.id===selected.id&&r.revision===selected.revision);if(index<0)throw new Error(STRATEGY_CONFLICT);rows.splice(index,1)},
}

function BacktestQA(){
  const [page,setPage]=useState('lab'),[theme,setTheme]=useState(getTheme),[refreshVersion,setRefreshVersion]=useState(0),[report,setReport]=useState(null)
  const library=useStrategies(owner,repository),lab=useIndicatorDraft(owner,library),order=useIndicatorDraft(owner,library)
  const current=page==='lab'?lab:order
  const workspace=useMemo(()=>({selection:stock,catalogError:'',catalogMessage:'',initialError:'',refreshVersion,refreshData:()=>setRefreshVersion(v=>v+1)}),[refreshVersion])
  const seed=()=>{
    current.onStrategyNameChange('모의 완성 전략')
    current.onAddIndicator('ma')
    current.onBacktestSettingsChange(previous=>({...previous,initialQuantity:'10',entryConditions:[{indicatorId:'ma',enabled:true,left:'short',operator:'gte',right:{type:'constant',value:0}}],takeProfitPct:5,stopLossPct:2}))
  }
  return <div className={`app-shell backtest-qa ${page==='lab'?'lab-mode':''}`}>
    <style>{`.backtest-qa>main{margin-left:0;min-width:0;width:100%}.backtest-qa header{gap:8px;flex-wrap:wrap;height:auto;min-height:58px;padding:8px 18px}.backtest-qa header button{font-size:12px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel2)}.backtest-qa header button[aria-current=page]{border-color:var(--blue);background:var(--surface-selected)}.backtest-qa .fixture-info{margin:0;padding:8px 18px;color:var(--muted);font-size:11px;line-height:1.5}.backtest-qa .fixture-tools{padding:8px 18px;display:flex;flex-wrap:wrap;gap:7px}.backtest-qa .fixture-tools button{font-size:11px;padding:5px 8px}.backtest-qa .fixture-state{margin:14px 18px;font-size:11px}.backtest-qa .fixture-state pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}.backtest-qa .mock-order-placeholder{padding:22px;min-height:420px}.backtest-qa .content{width:100%}@media(max-width:850px){.backtest-qa header{position:static}.backtest-qa .fixture-info{font-size:10px}}`}</style>
    <main>
      <header><strong>백테스트 v2 · 모의 검증</strong><button type="button" aria-current={page==='lab'?'page':undefined} onClick={()=>setPage('lab')}>실험실</button><button type="button" aria-current={page==='order'?'page':undefined} onClick={()=>setPage('order')}>주식 주문</button><button type="button" onClick={()=>{const next=theme==='dark'?'light':'dark';setTheme(next);applyTheme(next)}}>테마 전환</button></header>
      <p className="fixture-info">999999 모의 종목 · 합성 평일 일봉 80개 · 메모리 전략 저장소 · 실제 회원·증권사·DB·주문·카카오·AI 연결 없음</p>
      <div className="fixture-tools"><button type="button" onClick={seed}>모의 완성 전략 채우기</button><button type="button" onClick={()=>INDICATOR_CATALOG.forEach(({id})=>current.onAddIndicator(id))}>전체 지표 추가 (모의)</button><button type="button" onClick={async()=>setReport(await(await fetch('/__fixture/backtest/report')).json())}>모의 요청 기록 확인</button></div>
      <div className="content order-content"><section className="preview-grid order-preview-grid" aria-label={page==='lab'?'실험실':'주식 주문'}>
        {page==='lab'?<LabChartPanel workspace={workspace} indicators={lab.indicatorConfigs} strategyName={lab.strategyName} settings={lab.backtestSettings} onSettingsChange={lab.onBacktestSettingsChange} onResetBacktest={lab.onResetBacktest} resetVersion={lab.resetVersion}/>:<article className="panel chart-panel mock-order-placeholder"><h2>모의 검증 종목 · 주식 주문</h2><p>오른쪽 ‘지표 설정’에서 같은 전략 편집기를 확인합니다. 증권사 키는 없으며 모든 주문 경로를 차단합니다.</p><p>실험실과 주문 탭의 미저장 초안은 각각 유지합니다.</p></article>}
        <article className="panel preview-order"><OrderEntryPanel key={page} stock={stock} userId={owner} credentialVersion={0} authenticated={true} integrationStatus={{}} broker="kiwoom" indicatorsOnly={page==='lab'} {...current}/></article>
      </section></div>
      <details className="fixture-state"><summary>모의 상태 보기</summary><pre aria-label="백테스트 모의 상태">{JSON.stringify({page,theme,selectedSymbol:stock.code,libraryCount:library.rows.length,repositoryCalls:calls,requestReport:report,lab:{name:lab.strategyName,settings:lab.backtestSettings,indicators:lab.indicatorConfigs.map(i=>i.id),selected:lab.strategyStorage.selectedId,resetVersion:lab.resetVersion},order:{name:order.strategyName,settings:order.backtestSettings,indicators:order.indicatorConfigs.map(i=>i.id),selected:order.strategyStorage.selectedId,resetVersion:order.resetVersion},saved:library.rows},null,2)}</pre></details>
    </main>
  </div>
}
applyTheme('dark')
createRoot(document.getElementById('root')).render(<BacktestQA/> )
