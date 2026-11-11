import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import AdminEvalPanel from '../../src/components/AdminEvalPanel'
import '../../src/styles.css'
import '../../src/theme.css'
import {fixtureAccounts,setFixtureAccount} from '../../src/services/supabaseClient'
function Harness(){const [theme,setTheme]=useState('dark'),[account,setAccount]=useState('a');return <div data-theme={theme} style={{minHeight:'100vh',padding:16,background:'var(--surface-page)',color:'var(--text-primary)'}}><button onClick={()=>{const next=theme==='dark'?'light':'dark';setTheme(next);document.documentElement.dataset.theme=next}}>라이트 / 다크 전환</button><p>격리된 관리자 UI·DB 검증 · 모의 모델·공급자 · 유료 호출 없음</p><label>테스트 관리자<select value={account} onChange={event=>{setFixtureAccount(event.target.value);setAccount(event.target.value)}}><option value="a">계정 A</option><option value="b">계정 B</option></select></label><AdminEvalPanel key={account} userId={fixtureAccounts[account]}/></div>}
document.documentElement.dataset.theme='dark'
createRoot(document.getElementById('root')).render(<Harness/> )
