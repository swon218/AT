import {useCallback,useEffect,useRef,useState} from 'react'
import {openOrdersRequest} from '../services/openOrdersApi'
export function useOpenOrders({broker,userId,credentialVersion=0,accountRef='',enabled,api=openOrdersRequest,onAccountRefresh}){
  const scope=JSON.stringify([userId,broker,credentialVersion,accountRef]),current=useRef(scope)
  current.current=scope
  const [state,setState]=useState({scope,data:null,error:'',loading:false}),[clock,setClock]=useState(Date.now())
  const job=useRef(null),followups=useRef([]),refreshCallback=useRef(onAccountRefresh)
  refreshCallback.current=onAccountRefresh
  const refresh=useCallback(async()=>{
    if(!enabled||document.visibilityState==='hidden'||job.current?.scope===scope)return
    job.current?.controller.abort()
    const controller=new AbortController(),entry={scope,controller};job.current=entry
    setState(s=>({scope,data:s.scope===scope?s.data:null,error:'',loading:true}))
    try{
      const data=await api(broker,{accountRef,signal:controller.signal})
      if(!controller.signal.aborted&&current.current===scope)setState({scope,data,error:'',loading:false})
    }catch(e){if(!controller.signal.aborted&&current.current===scope)setState(s=>({...s,scope,loading:false,error:e.message}))}
    finally{if(job.current===entry)job.current=null}
  },[scope,broker,accountRef,enabled,api])
  useEffect(()=>{
    setState({scope,data:null,error:'',loading:enabled});refresh()
    const visible=()=>{setClock(Date.now());if(document.visibilityState==='visible')refresh()}
    document.addEventListener('visibilitychange',visible)
    const timer=setInterval(()=>{setClock(Date.now());refresh()},30000)
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',visible);job.current?.controller.abort();job.current=null;followups.current.forEach(clearTimeout);followups.current=[]}
  },[scope,refresh,enabled])
  const afterRequest=()=>{
    const captured=scope
    refreshCallback.current?.();refresh()
    followups.current.forEach(clearTimeout)
    followups.current=[3000,8000].map(delay=>setTimeout(()=>{if(current.current===captured){refreshCallback.current?.();refresh()}},delay))
  }
  const visible=state.scope===scope?state:{scope,data:null,error:'',loading:enabled}
  return {...visible,refresh,afterRequest,stale:Boolean(visible.error||visible.data?.fetchedAt&&Math.max(clock,Date.now())-Date.parse(visible.data.fetchedAt)>60000)}
}
