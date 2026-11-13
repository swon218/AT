import React,{useState,useCallback,useEffect} from 'react'
import {createRoot} from 'react-dom/client'
import AccountSettingsModal from '../../src/components/AccountSettingsModal'
import SidebarFooter from '../../src/components/SidebarFooter'
import {fixtureOwner,fixtureAuthDelay} from './settingsSession'
import '../../src/styles.css'
function Fixture(){
  const [open,setOpen]=useState(true),[owner,setOwner]=useState('fixture-a'),[report,setReport]=useState({}),[tools,setTools]=useState(false),[saved,setSaved]=useState(null),[theme,setTheme]=useState('dark')
  const close=useCallback(()=>setOpen(false),[]),user={id:owner,email:`${owner}@example.invalid`}
  useEffect(()=>{const t=setInterval(()=>fetch('/__fixture/report').then(r=>r.json()).then(setReport),300);return()=>clearInterval(t)},[])
  return <main style={{padding:24,margin:0,minWidth:0,width:'100%'}}><h1>개인설정 모의 검증</h1><p>실제 회원·계좌·DB·카카오·증권사 연결 없음</p><button onClick={()=>setOpen(true)}>개인설정 열기</button>
    <div style={{width:230}}><SidebarFooter user={user} nickname="모의 회원" connections={{kiwoom:false,toss:false,nh:false,kb:false}} onProfileClick={()=>setOpen(true)} onSessionClick={()=>{}}/></div>
    <AccountSettingsModal key={owner} user={user} open={open} onClose={close} onNicknameSaved={()=>{}} onIntegrationStatusChange={setSaved} onIntegrationMutation={()=>{}}/>
    <aside style={{position:'fixed',bottom:8,left:8,zIndex:400,maxWidth:'min(330px,90vw)',maxHeight:'35vh',overflow:'auto',padding:8,border:'1px solid var(--line)',borderRadius:8,background:'var(--surface-panel)'}}>
      <button onClick={()=>setTools(v=>!v)}>{tools?'검증 도구 닫기':'검증 도구 열기'}</button>{tools&&<><button onClick={()=>{const next=theme==='dark'?'light':'dark';setTheme(next);document.documentElement.dataset.theme=next}}>테마 전환</button>
        <button onClick={()=>fetch('/__fixture/mode',{method:'POST',body:JSON.stringify({fail:true})})}>다음 저장 실패</button><button onClick={()=>fetch('/__fixture/mode',{method:'POST',body:JSON.stringify({fail:false,readFailure:false,oldApi:false,deleteMode:'success'})})}>정상 응답 복원</button>
        <label>삭제 응답<select aria-label="모의 삭제 응답" onChange={e=>fetch('/__fixture/mode',{method:'POST',body:JSON.stringify({deleteMode:e.target.value})})}>{['success','fail','unknown-deleted','unknown-kept','slow'].map(v=><option key={v}>{v}</option>)}</select></label>
        <button onClick={()=>fetch('/__fixture/mode',{method:'POST',body:JSON.stringify({readFailure:true})})}>조회 실패 설정</button><button onClick={()=>fetch('/__fixture/mode',{method:'POST',body:JSON.stringify({oldApi:true})})}>구형 API 설정</button>
        <button onClick={()=>fixtureAuthDelay(2000)}>인증 조회 2초 지연</button><button onClick={()=>fixtureAuthDelay(0)}>인증 지연 해제</button>
        <button onClick={()=>fetch(`/__fixture/external?user=${owner}`,{method:'POST',body:JSON.stringify({broker:'kiwoom'})})}>다른 기기 키움 재등록</button>
        <button onClick={()=>{const next=owner==='fixture-a'?'fixture-b':'fixture-a';fixtureOwner(next);setOwner(next);setOpen(true)}}>모의 계정 전환</button>
        <pre style={{fontSize:10,whiteSpace:'pre-wrap'}}>저장 콜백: {JSON.stringify(saved)}<br/>검증 기록: {JSON.stringify(report)}</pre></>}
    </aside>
  </main>
}
document.documentElement.dataset.theme='dark'
createRoot(document.getElementById('root')).render(<Fixture/> )
