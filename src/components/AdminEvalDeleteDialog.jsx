import {useEffect,useId,useRef} from 'react'
import {createPortal} from 'react-dom'
import {Trash2,X} from 'lucide-react'

export default function AdminEvalDeleteDialog({targets,pending,onCancel,onConfirm,fallbackFocus}) {
  const title=useId(),description=useId(),panel=useRef(null),cancel=useRef(null),actions=useRef(null)
  actions.current={pending,onCancel}
  useEffect(()=>{
    const previous=document.activeElement
    cancel.current?.focus()
    const keydown=event=>{
      if(event.key==='Escape'){
        event.preventDefault();event.stopPropagation()
        if(!actions.current.pending)actions.current.onCancel()
      }
      if(event.key==='Tab'){
        const buttons=[...panel.current.querySelectorAll('button:not(:disabled)')]
        if(!buttons.length){event.preventDefault();return}
        if(event.shiftKey&&document.activeElement===buttons[0]){event.preventDefault();buttons.at(-1).focus()}
        else if(!event.shiftKey&&document.activeElement===buttons.at(-1)){event.preventDefault();buttons[0].focus()}
      }
    }
    document.addEventListener('keydown',keydown,true)
    return()=>{document.removeEventListener('keydown',keydown,true);if(previous?.isConnected)previous.focus();else fallbackFocus?.current?.focus()}
  },[])
  return createPortal(<div className="auth-overlay confirm-overlay eval-delete-overlay" onMouseDown={event=>{if(event.target===event.currentTarget&&!pending)onCancel()}}>
    <section ref={panel} className="confirm-dialog eval-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby={title} aria-describedby={description} aria-busy={pending}>
      <button type="button" className="auth-close" aria-label="질문 삭제 확인 창 닫기" disabled={pending} onClick={onCancel}><X aria-hidden="true"/></button>
      <span className="confirm-icon"><Trash2 aria-hidden="true"/></span><h2 id={title}>평가 질문 {targets.length}개 삭제</h2>
      <div id={description}><p>선택한 질문을 평가 질문 및 실행·보완 목록에서 삭제하시겠습니까?</p>
        <p className="eval-delete-numbers">선택한 번호: {targets.map(row=>row.display_number).join(', ')}</p>
        <p>미저장 질문·메모는 사라지고 남은 질문 번호가 다시 정리됩니다. 과거 실행·비용 기록은 기존 평가 기록에 보존됩니다.</p></div>
      <div className="confirm-actions"><button ref={cancel} type="button" disabled={pending} onClick={onCancel}>취소</button><button type="button" className="danger" disabled={pending} onClick={onConfirm}>{pending?'삭제 중…':'삭제 확인'}</button></div>
    </section>
  </div>,document.body)
}
