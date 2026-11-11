import {useEffect,useRef,useState} from 'react'
import {evaluationLabels,evaluationError,evaluationMessage,usedEvaluationTools} from '../utils/evaluationRows'
import architecture from '../../shared/agentArchitecture.json'
import {safeAgentLink,agentErrors} from '../services/agentApi'
import {agentSourceLabel,agentSourceTime} from '../utils/agentSources'
export function EvalJson({title,value}){return <details><summary>{title}</summary><pre>{JSON.stringify(value,null,2)}</pre></details>}
export function EvalStatus({state}){return <span className={`eval-badge ${state}`}>{evaluationLabels[state]||state||'미실행'}</span>}
const roleName=id=>architecture.agents.find(row=>row.id===id)?.name||id

function ImprovementNote({item,notes,setNotes,api,onSaved}) {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('')
  const lock=useRef(false),live=useRef(true)
  useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
  const saved=item.review?.improvement||{text:'',version:0}
  const draft=notes[item.id]||{text:saved.text,base:saved.text,version:saved.version}
  useEffect(()=>{
    setNotes(previous=>{
      const existing=previous[item.id]
      if(existing&&(existing.text!==existing.base||existing.version>=saved.version))return previous
      return {...previous,[item.id]:{text:saved.text,base:saved.text,version:saved.version}}
    })
  },[item.id,saved.version])
  async function save() {
    if(lock.current)return
    lock.current=true;setBusy(true);setMessage('');setError('')
    const text=draft.text
    try {
      const result=await api(`/items/${item.id}/note`,{method:'POST',body:{version:draft.version,text}})
      if(!live.current)return
      setNotes(previous=>({...previous,[item.id]:{text:previous[item.id]?.text??text,base:text,version:result.review.improvement.version}}))
      onSaved(result);setMessage('메모 저장 완료')
    }catch(e){if(live.current)setError(evaluationMessage(e))}
    finally{lock.current=false;if(live.current)setBusy(false)}
  }
  return <div className="eval-improvement-note"><label htmlFor={`note-${item.id}`}>연결·등록할 도구 / 보완 사항</label>
    <textarea id={`note-${item.id}`} rows={4} maxLength={2000} value={draft.text} onChange={event=>{setNotes(previous=>({...previous,[item.id]:{...draft,text:event.target.value}}));setMessage('')}}/>
    <small>{draft.text!==draft.base?'미저장 변경':'저장된 내용'} · {draft.text.length} / 2000</small>
    <button type="button" disabled={busy||draft.text===draft.base} onClick={save}>{busy?'저장 중…':'메모 저장'}</button>
    {message&&<p role="status">{message}</p>}{error&&<p role="alert" className="eval-error">{error}</p>}
  </div>
}

export default function AdminEvalResult({row,api,improvement=false,notes,setNotes}) {
  const [selected,setSelected]=useState(null),[item,setItem]=useState(null),[history,setHistory]=useState(null),[expanded,setExpanded]=useState(improvement),[error,setError]=useState('')
  const itemId=selected||row.latest?.id,seq=useRef(0),historySeq=useRef(0),live=useRef(false)
  useEffect(()=>{live.current=true;return()=>{live.current=false;seq.current++;historySeq.current++}},[])
  useEffect(()=>{
    if(!itemId||!expanded)return
    let active=true;setItem(null);setError('')
    async function read(){const token=++seq.current;try{const data=await api('/items/'+itemId);if(active&&token===seq.current)setItem(previous=>{
      if(previous?.id===data.id&&(previous.review?.improvement?.version||0)>(data.review?.improvement?.version||0))data.review=previous.review
      return data
    })}catch(e){if(active&&token===seq.current)setError(evaluationMessage(e))}}
    void read()
    const timer=setInterval(()=>{if(row.latest?.state==='running'||row.latest?.state==='queued')void read()},3000)
    return()=>{active=false;seq.current++;clearInterval(timer)}
  },[itemId,api,expanded,row.latest?.state])
  async function loadHistory(more=false) {
    const token=++historySeq.current
    try{const data=await api(`/questions/${row.id}/history${more&&history?.next?'?before='+encodeURIComponent(history.next):''}`);if(live.current&&token===historySeq.current)setHistory(previous=>({...data,items:more?[...(previous?.items||[]),...data.items]:data.items}))}
    catch(e){if(live.current)setError(evaluationMessage(e))}
  }
  const preview=!selected||selected===row.latest?.id?row.latest:null
  const answer=item?.result?.presentation?.content||item?.result?.answer?.content||preview?.preview
  const code=item?.result?.error_code||item?.result?.error||preview?.error_code
  const state=item?.result?.status==='partial'?'partial':item?.state||preview?.state
  const steps=item?.result?.steps||[],tools=usedEvaluationTools(steps),roles=[...new Set(steps.map(step=>step.agent).filter(Boolean))]
  const question=item?.specimen?.spec?.question||preview?.question||'이전 실행 조회 중…'
  if(!row.latest)return improvement?<td colSpan={4}>실행 기록 조회 중…</td>:<span>—</span>
  const toolList=<>{roles.length>0&&<p className="eval-tool-note">{roles.map(roleName).join(' · ')}</p>}{tools.length?<ul className="eval-used-tools">{tools.map((tool,n)=><li key={`${tool.seq}-${n}`}>{tool.seq}. {roleName(tool.agent)} · <code>{tool.name}</code> · {tool.status}{tool.code&&<> · <code>{tool.code}</code></>}</li>)}</ul>:<p>{!item||['running','queued'].includes(state)?'도구 호출 기록 대기':'도구 사용 없음'}</p>}</>
  const body=<div className="eval-row-result">
    {question!==row.spec.question&&<small>이전 질문 버전의 결과입니다.</small>}
    {(improvement||expanded)&&<p className="eval-snapshot-question">실행한 질문: {question}</p>}
    <div className="eval-answer-preview">{answer||(!item&&!preview?'실행 기록 조회 중…':['running','queued'].includes(state)?'결과를 기다리고 있습니다.':'응답 내용 없음')}</div>
    {code&&<p className="eval-error">{agentErrors[code]||evaluationError(code)} <code>{code}</code></p>}
    {(item?.result?.answer?.kind||row.latest?.kind)==='clarification'&&<p className="eval-tool-note">추가 확인이 필요한 답변입니다. 질문을 수정한 뒤 다시 실행해 주세요.</p>}
    <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?'상세 접기':'결과·실행 이력 보기'}</button>
    {expanded&&<>
      {error&&<p role="alert" className="eval-error">{error}</p>}
      {!item&&!error&&<p role="status">실행 상세 조회 중…</p>}
      {item&&<>
        <p className="eval-tool-note">{item.metadata?.data_mode==='production'?'운영 데이터 · 현재 분석 서비스':item.metadata?.dataset?'과거 고정 합성 데이터 평가':'실행 데이터 구분 미확인'}</p>
        <p><EvalStatus state={state}/> · {item.metadata?.model||'실행 모델 확인 중'} · {item.metadata?.architecture||'구조 확인 중'}</p>
        <p className="eval-tool-note">담당: {roles.length?roles.map(roleName).join(' · '):['running','queued'].includes(state)?'실행 기록 대기':'담당 기록 없음'}</p>
        {!improvement&&<details><summary>실제 사용한 도구·담당</summary>{toolList}</details>}
        {!!item.result?.answer?.sources?.length&&<details><summary>근거·출처</summary><ul>{item.result.answer.sources.map(source=><li key={source.id}>{safeAgentLink(source.url)?<a href={safeAgentLink(source.url)} target="_blank" rel="noopener noreferrer">{source.title||source.excerpt||source.id}</a>:source.excerpt||source.title||source.id}<small>{agentSourceLabel(source)} · {agentSourceTime(source)}</small></li>)}</ul></details>}
        <EvalJson title="도구 입력·결과·오류 기록" value={steps}/><EvalJson title="실행 당시 모델·버전·한도" value={item.metadata}/>
        <EvalJson title="담당별 시간·사용량" value={item.result?.answer?.execution||item.result?.usage}/>
        {(item.result?.presentation||item.result?.alert_action)&&<div className="eval-proposal"><p>평가용 제안입니다. 사용자 승인·관심종목 변경·알림 저장은 실행하지 않았습니다.</p><EvalJson title="확인 카드·미저장 초안 제안" value={item.result.presentation||item.result.alert_action}/></div>}
      </>}
      <details onToggle={event=>{if(event.currentTarget.open&&!history)void loadHistory()}}><summary>이전 실행 선택</summary>
        {history&&<label>확인할 실행<select value={itemId} onChange={event=>setSelected(event.target.value)}>{history.items.map(entry=><option key={entry.id} value={entry.id}>{new Date(entry.created_at).toLocaleString()} · {evaluationLabels[entry.mode]} · v{entry.revision} · {evaluationLabels[entry.state]}</option>)}</select></label>}
        {history?.next&&<button type="button" onClick={()=>loadHistory(true)}>이전 이력 더 보기</button>}
        {selected&&<button type="button" onClick={()=>setSelected(null)}>최신 실행 보기</button>}
      </details>
    </>}
  </div>
  return improvement?<><td className="eval-executed-question">{question}</td><td>{toolList}</td><td>{body}</td><td>{item?<ImprovementNote key={item.id} item={item} notes={notes} setNotes={setNotes} api={api} onSaved={setItem}/>:<span>상세 조회 후 입력할 수 있습니다.</span>}</td></>:body
}
