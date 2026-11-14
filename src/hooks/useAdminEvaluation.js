import {useCallback,useEffect,useRef,useState} from 'react'
import {agentApi} from '../services/agentApi'
import {evaluationMessage,questionDraft,toggleEvaluationSelection,withoutEvaluationQuestions} from '../utils/evaluationRows'

export default function useAdminEvaluation(userId,view,page,onPage) {
  const [rows,setRows]=useState([]),[total,setTotal]=useState(0),[catalog,setCatalog]=useState(null),[loading,setLoading]=useState(true),[resolvedKey,setResolvedKey]=useState('')
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[drafts,setDrafts]=useState({}),[rowState,setRowState]=useState({}),[running,setRunning]=useState(false)
  const [selected,setSelected]=useState([]),[busy,setBusy]=useState(false),[deleting,setDeleting]=useState(false)
  const [deletionError,setDeletionError]=useState('')
  const mounted=useRef(false),epoch=useRef(0),refreshId=useRef(0),locked=useRef(new Set()),pending=useRef(new Map()),adding=useRef(null),queryKey=useRef(''),rowsKey=useRef('')
  queryKey.current=`${userId}:${view}:${page}`
  const api=useCallback((path,options)=>agentApi('/admin'+path,{...options,userId}),[userId])
  useEffect(()=>{mounted.current=true;epoch.current++;setSelected([]);setBusy(false);setDeleting(false);setDeletionError('');locked.current.clear();return()=>{mounted.current=false;epoch.current++;refreshId.current++}},[userId])
  const current=token=>mounted.current&&epoch.current===token
  async function deletionApi(path,options) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000)
    try{return await api(path,{...options,signal:controller.signal})}
    finally{clearTimeout(timer)}
  }
  const refresh=useCallback(async()=>{
    const key=`${userId}:${view}:${page}`
    if(queryKey.current!==key)return
    const serial=++refreshId.current,token=epoch.current
    try {
      const c=await api('/catalog')
      if(!current(token)||serial!==refreshId.current||queryKey.current!==key)return
      setCatalog(c)
      if(!c.features?.questionRows){setRows([]);setTotal(0);setLoading(false);setError('관리자 개선 API·SQL 반영 준비 중입니다. 기존 실행 기록은 아래에서 열람할 수 있습니다.');return}
      const data=await api(`/workspace?view=${view}&page=${page}`)
      if(!current(token)||serial!==refreshId.current||queryKey.current!==key)return
      const lastPage=Math.max(1,Math.ceil(data.total/10))
      if(page>lastPage){onPage(lastPage);return}
      rowsKey.current=key
      setRows(data.questions);setTotal(data.total);setRunning(data.running)
      setDrafts(previous=>({...previous,...Object.fromEntries(data.questions.map(row=>[row.id,questionDraft(previous[row.id],row)]))}))
      for(const row of data.questions){const intent=pending.current.get(row.id);if(intent?.uncertain&&row.latest?.id===intent.id){intent.uncertain=false;setRowState(previous=>({...previous,[row.id]:{message:'실행 접수 확인 완료'}}))}}
      setError('')
    }catch(e){if(current(token)&&serial===refreshId.current&&queryKey.current===key)setError(evaluationMessage(e))}
    finally{if(current(token)&&serial===refreshId.current&&queryKey.current===key){setResolvedKey(key);setLoading(false)}}
  },[api,view,page])
  useEffect(()=>{setLoading(true);void refresh()},[refresh])
  useEffect(()=>{
    if(!running&&!Object.values(rowState).some(state=>state.uncertain))return
    const timer=setInterval(refresh,3000);return()=>clearInterval(timer)
  },[refresh,running,rowState])
  useEffect(()=>{
    if(!Object.values(drafts).some(row=>row.text!==row.base))return
    const warn=event=>{event.preventDefault();event.returnValue=''}
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)
  },[drafts])
  const setState=(id,value)=>setRowState(previous=>({...previous,[id]:value}))
  function lock(key) {
    if(locked.current.size)return false
    locked.current.add(key);setBusy(true);return true
  }
  function unlock(key,token) {
    if(!current(token))return
    locked.current.delete(key);setBusy(locked.current.size>0)
  }
  async function add() {
    if(!lock('add'))return
    refreshId.current++;const token=epoch.current
    adding.current??=crypto.randomUUID()
    try {
      const row=await api('/questions/'+adding.current,{method:'PUT',body:{revision:0,question:''}})
      if(!current(token))return
      refreshId.current++
      adding.current=null;setNotice(`질문 ${row.display_number}번을 추가했습니다.`)
      const destination=Math.ceil(row.display_number/10)
      if(queryKey.current===`${userId}:all:${page}`){if(destination!==page)onPage(destination);else await refresh()}
    }catch(e){if(current(token))setError(evaluationMessage(e))}
    finally{unlock('add',token)}
  }
  async function saveValue(row,draft,token) {
    refreshId.current++
    const saved=await api('/questions/'+row.id,{method:'PUT',body:{revision:draft.revision,question:draft.text}})
    if(!current(token))return saved
    refreshId.current++
    setDrafts(previous=>({...previous,[row.id]:{...previous[row.id],base:draft.text,revision:saved.revision}}))
    setRows(previous=>previous.map(item=>item.id===row.id?{...item,...saved}:item))
    setSelected(previous=>previous.map(item=>item.id===row.id?{...item,revision:saved.revision,display_number:saved.display_number}:item))
    return saved
  }
  async function save(row) {
    if(!lock(row.id))return
    const token=epoch.current
    setState(row.id,{busy:true})
    try {await saveValue(row,{...drafts[row.id]},token);if(current(token))setState(row.id,{message:'저장 완료'})}
    catch(e){if(current(token))setState(row.id,{error:evaluationMessage(e)})}
    finally{unlock(row.id,token)}
  }
  async function execute(row,paid) {
    if(!paid||!lock(row.id))return
    const token=epoch.current
    const draft={...drafts[row.id]}
    setState(row.id,{busy:true})
    try {
      const saved=await saveValue(row,draft,token)
      if(!current(token))return
      let intent=pending.current.get(row.id)
      const signature=JSON.stringify([saved.revision,draft.text])
      // An unknown POST result retains its exact ID/payload until reconciled.
      if(intent?.uncertain&&intent.signature!==signature)throw new Error('이전 실행의 접수 여부를 먼저 확인해 주세요. 입력 내용은 저장되었습니다.')
      if(!intent||!intent.uncertain)intent={id:crypto.randomUUID(),signature,body:{revision:saved.revision,question:draft.text,paidConfirmed:true}}
      pending.current.set(row.id,intent)
      const accepted=await api(`/questions/${row.id}/execute`,{method:'POST',body:{id:intent.id,...intent.body}})
      intent.uncertain=false;intent.accepted=accepted.id
      if(current(token)){setState(row.id,{message:'실행 접수 완료'});setRunning(true);await refresh()}
    }catch(e){
      if(!current(token))return
      const intent=pending.current.get(row.id)
      if(intent&&!e.code){intent.uncertain=true;setState(row.id,{uncertain:true,error:'접수 여부를 확인하지 못했습니다. 같은 실행 ID로 접수를 확인합니다.'})}
      else{pending.current.delete(row.id);setState(row.id,{error:evaluationMessage(e)})}
    }finally{unlock(row.id,token)}
  }
  async function selectAll() {
    if(!catalog?.features?.questionDeletion||!lock('selection'))return
    setDeletionError('')
    const token=epoch.current
    try {
      const data=await deletionApi('/questions/selection')
      if(!current(token))return
      setSelected(data.questions);setNotice(`선택 시점의 전체 질문 ${data.questions.length}개를 선택했습니다. 이후 추가한 질문은 포함하지 않습니다.`);setError('')
    }catch(e){if(current(token))setDeletionError(typeof e.code==='string'?evaluationMessage(e):'전체 질문을 선택하지 못했습니다. 연결 상태를 확인한 뒤 다시 선택해 주세요.')}
    finally{unlock('selection',token)}
  }
  async function deleteQuestions(targets) {
    if(!catalog?.features?.questionDeletion||!targets.length||!lock('delete'))return null
    const token=epoch.current
    refreshId.current++;setDeleting(true);setError('');setDeletionError('');setNotice('')
    function removeLocal(ids) {
      const removed=new Set(ids)
      setRows(previous=>previous.filter(row=>!removed.has(row.id)))
      setSelected(previous=>previous.filter(row=>!removed.has(row.id)))
      setDrafts(previous=>withoutEvaluationQuestions(previous,ids));setRowState(previous=>withoutEvaluationQuestions(previous,ids))
      ids.forEach(id=>pending.current.delete(id))
    }
    try {
      const result=await deletionApi('/questions/delete',{method:'POST',body:{questions:targets.map(({id,revision})=>({id,revision}))}})
      if(!current(token))return null
      const ids=[...new Set([...(result.deleted||[]),...(result.alreadyDeleted||[])])]
      removeLocal(ids);setNotice(`${ids.length}개 질문을 삭제했습니다. 남은 질문 번호를 다시 정리했습니다.`)
      const lastPage=Math.max(1,Math.ceil(result.remaining/10))
      if(view==='all'&&page>lastPage)onPage(lastPage);else await refresh()
      return ids
    }catch(e){
      if(!current(token))return null
      // A lost POST response is never retried blindly. Reconcile membership first.
      let reconciled=[]
      const coded=typeof e.code==='string'
      if(!coded){
        try {
          const latest=await deletionApi('/questions/selection')
          if(!current(token))return null
          const present=new Set(latest.questions.map(row=>row.id)),absent=targets.filter(row=>!present.has(row.id)).map(row=>row.id)
          removeLocal(absent);reconciled=absent
          if(absent.length===targets.length){setNotice(`${absent.length}개 질문이 목록에서 삭제된 것을 확인했습니다.`);await refresh();return absent}
        }catch{/* Keep the last known state until an explicit refresh succeeds. */}
      }
      if(current(token)){
        const message=coded?evaluationMessage(e):'삭제 결과를 확인하지 못했습니다. 새로고침으로 최신 목록을 확인한 뒤 다시 선택해 주세요.'
        setSelected([]);await refresh();if(current(token))setDeletionError(message)
      }
      return reconciled.length?reconciled:null
    }finally{if(current(token)){setDeleting(false);unlock('delete',token)}}
  }
  return {api,rows:rowsKey.current===queryKey.current?rows:[],total,catalog,loading:loading||resolvedKey!==queryKey.current,error:deletionError||error,notice,drafts,rowState,running,refresh:()=>{setDeletionError('');return refresh()},add,save,execute,busy,deleting,selected,selectAll,deleteQuestions,
    select:(row,checked)=>{if(!locked.current.size)setSelected(previous=>toggleEvaluationSelection(previous,row,checked))},
    clearSelection:()=>{if(!locked.current.size)setSelected([])},
    change:(id,text)=>setDrafts(previous=>({...previous,[id]:{...previous[id],text}})),
    reset:row=>{setDrafts(previous=>({...previous,[row.id]:{text:row.spec.question,base:row.spec.question,revision:row.revision}}));setState(row.id,{})}}
}
