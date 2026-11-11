import {useCallback,useEffect,useRef,useState} from 'react'
import {agentApi} from '../services/agentApi'
import {evaluationMessage,questionDraft} from '../utils/evaluationRows'

export default function useAdminEvaluation(userId,view,page,onPage) {
  const [rows,setRows]=useState([]),[total,setTotal]=useState(0),[catalog,setCatalog]=useState(null),[loading,setLoading]=useState(true),[resolvedKey,setResolvedKey]=useState('')
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[drafts,setDrafts]=useState({}),[rowState,setRowState]=useState({}),[running,setRunning]=useState(false)
  const mounted=useRef(false),epoch=useRef(0),refreshId=useRef(0),locked=useRef(new Set()),pending=useRef(new Map()),adding=useRef(null),queryKey=useRef(''),rowsKey=useRef('')
  queryKey.current=`${userId}:${view}:${page}`
  const api=useCallback((path,options)=>agentApi('/admin'+path,{...options,userId}),[userId])
  useEffect(()=>{mounted.current=true;epoch.current++;return()=>{mounted.current=false;epoch.current++;refreshId.current++}},[userId])
  const current=token=>mounted.current&&epoch.current===token
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
  async function add() {
    if(locked.current.has('add'))return
    locked.current.add('add');refreshId.current++;const token=epoch.current
    adding.current??=crypto.randomUUID()
    try {
      const row=await api('/questions/'+adding.current,{method:'PUT',body:{revision:0,question:''}})
      if(!current(token))return
      refreshId.current++
      adding.current=null;setNotice(`질문 ${row.display_number}번을 추가했습니다.`)
      const destination=Math.ceil(row.display_number/10)
      if(queryKey.current===`${userId}:all:${page}`){if(destination!==page)onPage(destination);else await refresh()}
    }catch(e){if(current(token))setError(evaluationMessage(e))}
    finally{locked.current.delete('add')}
  }
  async function saveValue(row,draft,token) {
    refreshId.current++
    const saved=await api('/questions/'+row.id,{method:'PUT',body:{revision:draft.revision,question:draft.text}})
    if(!current(token))return saved
    refreshId.current++
    setDrafts(previous=>({...previous,[row.id]:{...previous[row.id],base:draft.text,revision:saved.revision}}))
    setRows(previous=>previous.map(item=>item.id===row.id?{...item,...saved}:item))
    return saved
  }
  async function save(row) {
    if(locked.current.has(row.id))return
    locked.current.add(row.id);const token=epoch.current
    setState(row.id,{busy:true})
    try {await saveValue(row,{...drafts[row.id]},token);if(current(token))setState(row.id,{message:'저장 완료'})}
    catch(e){if(current(token))setState(row.id,{error:evaluationMessage(e)})}
    finally{locked.current.delete(row.id)}
  }
  async function execute(row,paid) {
    if(!paid||locked.current.has(row.id)||locked.current.has('execute'))return
    locked.current.add(row.id);locked.current.add('execute');const token=epoch.current
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
    }finally{locked.current.delete(row.id);locked.current.delete('execute')}
  }
  return {api,rows:rowsKey.current===queryKey.current?rows:[],total,catalog,loading:loading||resolvedKey!==queryKey.current,error,notice,drafts,rowState,running,refresh,add,save,execute,
    change:(id,text)=>setDrafts(previous=>({...previous,[id]:{...previous[id],text}})),
    reset:row=>{setDrafts(previous=>({...previous,[row.id]:{text:row.spec.question,base:row.spec.question,revision:row.revision}}));setState(row.id,{})}}
}
