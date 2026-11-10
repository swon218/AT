import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import AdminEvalPanel from '../../src/components/AdminEvalPanel'
import '../../src/styles.css'
import '../../src/theme.css'
function Harness(){const [theme,setTheme]=useState('dark');return <div data-theme={theme} style={{minHeight:'100vh',padding:16,background:'var(--surface-page)',color:'var(--text-primary)'}}><button onClick={()=>{const next=theme==='dark'?'light':'dark';setTheme(next);document.documentElement.dataset.theme=next}}>라이트 / 다크 전환</button><p>격리된 관리자 UI·DB 검증 화면 · 실제 모델 호출 없음</p><AdminEvalPanel userId="11111111-1111-4111-8111-111111111111"/></div>}
createRoot(document.getElementById('root')).render(<Harness/> )
