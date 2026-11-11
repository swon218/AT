import {useEffect,useRef,useState} from 'react'
import {compareRuns,summarize,verdict} from '../utils/evalResults'
import {evaluationLabels,evaluationMessage} from '../utils/evaluationRows'
import {EvalJson,EvalStatus} from './AdminEvalResult'

export default function AdminEvalArchive({api}) {
  const [runs,setRuns]=useState([]),[run,setRun]=useState(null),[item,setItem]=useState(null),[error,setError]=useState('')
  const [left,setLeft]=useState(''),[right,setRight]=useState(''),[comparison,setComparison]=useState(null)
  const live=useRef(false),selection=useRef(0),detail=useRef(0),comparisonId=useRef(0)
  useEffect(()=>{live.current=true;api('/runs').then(data=>{if(live.current)setRuns(data)}).catch(e=>{if(live.current)setError(evaluationMessage(e))});return()=>{live.current=false;selection.current++;detail.current++;comparisonId.current++}},[api])
  async function openRun(id){const token=++selection.current;detail.current++;setItem(null);setRun(null);try{const value=await api('/runs/'+id);if(live.current&&token===selection.current){setRun(value);setError('')}}catch(e){if(live.current&&token===selection.current)setError(evaluationMessage(e))}}
  async function openItem(id){const token=++detail.current;setItem(null);try{const value=await api('/items/'+id);if(live.current&&token===detail.current)setItem(value)}catch(e){if(live.current&&token===detail.current)setError(evaluationMessage(e))}}
  async function compare(){const token=++comparisonId.current;setComparison(null);try{const [a,b]=await Promise.all([api('/runs/'+left),api('/runs/'+right)]);if(live.current&&token===comparisonId.current)setComparison(compareRuns(a,b))}catch(e){if(live.current&&token===comparisonId.current)setError(evaluationMessage(e))}}
  const stats=run&&summarize(run.items)
  return <section className="eval-archive" aria-label="기존 평가 기록과 비교">
    <p className="eval-tool-note">과거 질문·실행·수동 판정을 보존합니다. 고정 합성 데이터 평가는 운영 데이터 조회와 구분합니다.</p>
    {error&&<p role="alert" className="eval-error">{error}</p>}
    <label>저장된 실행<select value={run?.run.id||''} onChange={event=>event.target.value&&openRun(event.target.value)}><option value="">실행 선택</option>{runs.map(row=><option key={row.id} value={row.id}>{new Date(row.created_at).toLocaleString()} · {evaluationLabels[row.mode]} · {row.id.slice(0,8)}</option>)}</select></label>
    {run&&<><p>{evaluationLabels[run.run.mode]} · {stats.total}건 · 실패 {stats.fail} · 검토 {stats.review} · 대기 {stats.pending}</p>
      <div className="eval-table"><table><thead><tr><th>실행 당시 질문</th><th>상태</th><th>과거 판정</th><th>상세</th></tr></thead><tbody>{run.items.map(row=><tr key={row.id}><td>{row.title}</td><td><EvalStatus state={row.state}/></td><td>{verdict(row)}</td><td><button type="button" onClick={()=>openItem(row.id)}>기록 보기</button></td></tr>)}</tbody></table></div>
    </>}
    {item&&<div className="eval-archive-item"><p>{item.specimen.spec.question}</p><div className="eval-answer-preview">{item.result?.presentation?.content||item.result?.answer?.content||item.result?.error||'결과 대기'}</div><EvalJson title="실행 당시 질문·데이터·기준" value={item.specimen}/><EvalJson title="보존된 수동 판정·메모" value={item.review}/><EvalJson title="실행 기록·버전" value={{result:item.result,metadata:item.metadata}}/></div>}
    <details><summary>버전 비교</summary><p>같은 사례 버전·데이터·모델·예산의 기록만 직접 비교합니다.</p><div className="eval-form-row">{[['이전 실행',left,setLeft],['현재 실행',right,setRight]].map(([label,value,set])=><label key={label}>{label}<select value={value} onChange={event=>set(event.target.value)}><option value="">선택</option>{runs.map(row=><option key={row.id} value={row.id}>{row.created_at} · {evaluationLabels[row.mode]}</option>)}</select></label>)}<button type="button" disabled={!left||!right||left===right} onClick={compare}>비교</button></div>
      {comparison&&<ul>{comparison.map(row=><li key={row.key}>{row.title} · {row.change} · {row.firstArchitecture} → {row.lastArchitecture}</li>)}</ul>}
    </details>
  </section>
}
