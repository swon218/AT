import { useEffect, useState } from 'react'
import { agentApi } from '../services/agentApi'

export default function useAdminAccess(userId) {
  const [state,setState]=useState({owner:null,allowed:false})
  useEffect(()=>{
    let active=true
    const refresh=async()=>{
      if(!userId) return
      try { const r=await agentApi('/admin/status',{userId}); if(active)setState({owner:userId,allowed:r.admin===true}) }
      catch { if(active)setState({owner:userId,allowed:false}) }
    }
    refresh()
    const timer=setInterval(refresh,30000)
    window.addEventListener('focus',refresh)
    return ()=>{active=false;clearInterval(timer);window.removeEventListener('focus',refresh)}
  },[userId])
  return Boolean(userId&&state.owner===userId&&state.allowed)
}
