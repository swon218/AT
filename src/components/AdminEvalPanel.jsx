import {useEffect,useRef,useState} from 'react'
import useAdminEvaluation from '../hooks/useAdminEvaluation'
import AdminToolCatalog from './AdminToolCatalog'
import AdminEvalResult,{EvalStatus} from './AdminEvalResult'
import AdminEvalArchive from './AdminEvalArchive'
import AdminEvalDeleteDialog from './AdminEvalDeleteDialog'
import {evaluationSelection,withoutEvaluationQuestions} from '../utils/evaluationRows'
import './AdminEvalPanel.css'

export default function AdminEvalPanel({userId}) {
  const [tab,setTab]=useState('사용가능 도구'),[page,setPage]=useState(1),[paid,setPaid]=useState(false),[notes,setNotes]=useState({}),[archive,setArchive]=useState(false)
  const [deleteTarget,setDeleteTarget]=useState(null),allCheck=useRef(null),refreshButton=useRef(null),live=useRef(false),confirmLock=useRef(false)
  const view=tab==='보완'?'executed':'all'
  const evaluation=useAdminEvaluation(userId,view,page,setPage)
  const {rows,total,catalog,drafts,rowState,loading,error,notice,running,api,busy,deleting,selected}=evaluation
  const ready=catalog?.features?.questionRows===true
  const canDelete=ready&&catalog?.features?.questionDeletion===true
  const allSelected=selected.length>0&&selected.length===total
  useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
  useEffect(()=>{if(allCheck.current)allCheck.current.indeterminate=selected.length>0&&!allSelected},[selected,allSelected,tab])
  const execution=catalog?.runtime?.execution,limits=execution?.limits
  const canRun=ready&&catalog?.features?.productionExecution&&catalog?.runtime?.key_configured&&catalog?.runtime?.enabled&&execution
  useEffect(()=>{
    if(!Object.values(notes).some(note=>note.text!==note.base))return
    const warn=event=>{event.preventDefault();event.returnValue=''}
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)
  },[notes])
  const changeTab=value=>{if(!busy){setTab(value);setPage(1)}}
  async function confirmDelete() {
    if(confirmLock.current)return
    confirmLock.current=true
    try {
      const ids=await evaluation.deleteQuestions(deleteTarget)
      if(!live.current)return
      if(ids)setNotes(previous=>withoutEvaluationQuestions(previous,ids))
      setDeleteTarget(null)
    }finally{confirmLock.current=false}
  }
  return <section className="admin-eval panel" aria-label="AI 품질 평가">
    <div className="eval-heading"><h2>AI 품질평가</h2><button ref={refreshButton} type="button" disabled={busy} onClick={evaluation.refresh}>새로고침</button></div>
    <nav className="eval-tabs" aria-label="평가 화면">{['사용가능 도구','평가 질문 및 실행','보완'].map(value=><button type="button" key={value} disabled={busy} className={tab===value?'active':''} aria-current={tab===value?'page':undefined} onClick={()=>changeTab(value)}>{value}</button>)}</nav>
    {error&&<p role="alert" className="eval-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {tab==='사용가능 도구'&&<AdminToolCatalog runtime={catalog?.runtime}/>}
    {tab==='평가 질문 및 실행'&&<>
      <div className="eval-toolbar"><button type="button" disabled={!ready||busy} onClick={evaluation.add}>질문 추가</button><span>{total}개 · 실행 전 최신 입력을 저장합니다.</span></div>
      {canDelete?<div className="eval-selection-toolbar">
        <label><input ref={allCheck} type="checkbox" checked={allSelected} disabled={busy||loading||!total} onChange={event=>event.target.checked?evaluation.selectAll():evaluation.clearSelection()}/>전체 선택 (모든 페이지)</label>
        <span role="status">{selected.length}개 선택</span><button type="button" className="eval-delete-button" disabled={busy||loading||!selected.length} onClick={()=>setDeleteTarget(selected.map(row=>({...row})))}>선택 삭제</button>
        {!!selected.length&&<button type="button" disabled={busy} onClick={evaluation.clearSelection}>선택 해제</button>}
      </div>:ready&&<p className="eval-tool-note">질문 삭제 기능은 관리자 API·SQL 반영 후 사용할 수 있습니다.</p>}
      <p className="eval-tool-note">OpenAI 유료 API 호출 · {execution?.model||'운영 모델 확인 중'}{limits&&<> · 최대 모델 {limits.rounds}회 / 도구 {limits.tool_calls}회 / {limits.tokens.toLocaleString()}토큰 / {limits.seconds}초 / 추정 ${limits.max_usd}</>}</p>
      {!canRun&&ready&&<p className="eval-tool-note">운영 AI 실행 설정을 확인하지 못했습니다. 질문 저장·기존 기록 열람은 가능합니다.</p>}
      <label className="eval-consent"><input type="checkbox" checked={paid} onChange={event=>setPaid(event.target.checked)}/>실행 버튼이 실제 유료 모델을 호출함을 확인했습니다.</label>
      {loading?<p role="status">질문 조회 중…</p>:ready&&<div className="eval-table"><table className="eval-question-table"><thead><tr>{canDelete&&<th className="eval-selection-column">선택</th>}<th className="eval-number-column">번호</th><th className="eval-question-column">질문</th><th className="eval-execute-column">실행</th><th className="eval-state-column">상태</th><th>결과</th>{canDelete&&<th className="eval-delete-column">삭제</th>}</tr></thead><tbody>{rows.map(row=>{
        const draft=drafts[row.id]||{text:row.spec.question,base:row.spec.question},state=rowState[row.id]||{},dirty=draft.text!==row.spec.question
        return <tr key={row.id}>{canDelete&&<td><input type="checkbox" aria-label={`질문 ${row.display_number} 선택`} checked={selected.some(item=>item.id===row.id)} disabled={busy} onChange={event=>evaluation.select(row,event.target.checked)}/></td>}<td>{row.display_number}</td><td>
          <label className="eval-sr-only" htmlFor={`question-${row.id}`}>질문 {row.display_number}</label><textarea id={`question-${row.id}`} rows={3} maxLength={6000} disabled={busy} value={draft.text} onChange={event=>evaluation.change(row.id,event.target.value)} placeholder="평가할 질문을 입력하세요"/>
          <div className="eval-question-save"><small>{dirty?'미저장 변경':'저장됨'} · 버전 {row.revision}</small><button type="button" disabled={!dirty||busy} onClick={()=>evaluation.save(row)}>저장</button>{dirty&&<button type="button" disabled={busy} onClick={()=>evaluation.reset(row)}>저장값으로 복원</button>}</div>
        </td><td><button type="button" disabled={!canRun||!paid||!draft.text.trim()||busy||running} onClick={()=>evaluation.execute(row,paid)}>{state.busy?'접수 중…':state.uncertain?'접수 확인':'실행'}</button></td>
          <td><EvalStatus state={row.latest?.state}/>{state.message&&<p role="status">{state.message}</p>}{state.error&&<p role="alert" className="eval-error">{state.error}</p>}</td>
          <td>{row.latest&&draft.text!==row.latest.question&&<small>현재 입력과 다른 질문의 결과</small>}<AdminEvalResult key={row.id} row={row} api={api}/></td>{canDelete&&<td><button type="button" className="eval-delete-button" aria-label={`질문 ${row.display_number} 삭제`} disabled={busy} onClick={()=>setDeleteTarget([evaluationSelection(row)])}>삭제</button></td>}
        </tr>
      })}{!rows.length&&!error&&<tr><td colSpan={canDelete?7:5}>등록된 질문이 없습니다. 질문 추가로 시작하세요.</td></tr>}</tbody></table></div>}
    </>}
    {tab==='보완'&&<>
      <p className="eval-tool-note">실행 접수된 질문만 표시합니다. 메모는 선택한 실행에 저장되며 도구 등록·코드 수정·자동 학습을 실행하지 않습니다.</p>
      {loading?<p role="status">실행한 질문 조회 중…</p>:ready&&<div className="eval-table"><table className="eval-improvement-table"><thead><tr><th>번호</th><th>실행한 질문</th><th>사용한 에이전트·도구</th><th>결과</th><th>보완 메모</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td>{row.display_number}</td><AdminEvalResult row={row} api={api} improvement notes={notes} setNotes={setNotes}/></tr>)}{!rows.length&&!error&&<tr><td colSpan={5}>실행 접수된 질문이 없습니다.</td></tr>}</tbody></table></div>}
    </>}
    {tab!=='사용가능 도구'&&ready&&<div className="eval-pagination"><button type="button" disabled={page<=1||loading||busy} onClick={()=>setPage(value=>value-1)}>이전</button><span>{page} / {Math.max(1,Math.ceil(total/10))}</span><button type="button" disabled={page*10>=total||loading||busy} onClick={()=>setPage(value=>value+1)}>다음</button></div>}
    <details onToggle={event=>setArchive(event.currentTarget.open)}><summary>기존 평가 기록·버전 비교</summary>{archive&&<AdminEvalArchive api={api}/>}</details>
    {deleteTarget&&<AdminEvalDeleteDialog targets={deleteTarget} pending={deleting} onCancel={()=>{if(!deleting)setDeleteTarget(null)}} onConfirm={confirmDelete} fallbackFocus={refreshButton}/>}
  </section>
}
