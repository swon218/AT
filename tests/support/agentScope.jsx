import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import useServerAgentWorkspace from '../../src/hooks/useServerAgentWorkspace'

// Browser-only QA for the REAL hook. No Supabase authentication or external request.
let deferB = false, release = null
const ids = { a: '00000000-0000-4000-8000-000000000001', b: '00000000-0000-4000-8000-000000000002', guest: '00000000-0000-4000-8000-000000000003' }
const mockApi = async (path, { userId }) => {
  const who = userId || 'guest', id = ids[who]
  const room = { id, title: `${who} 전용 방`, updated_at: new Date().toISOString() }
  if (path === '/status') return { enabled: true, provider: { state: 'api_key_missing' } }
  if (path === '/rooms') return { rooms: [room] }
  if (path.endsWith('/messages')) {
    const result = { room, messages: [{ id: '1', role: 'user', content: `${who} 전용 비공개 기록`, created_at: new Date().toISOString() }], requests: [] }
    if (who === 'b' && deferB) return await new Promise(resolve => { release = () => { deferB = false; resolve(result) } })
    return result
  }
  return {}
}
function ScopeQA() {
  const [user, setUser] = useState('a')
  const agent = useServerAgentWorkspace(user, true, mockApi)
  return <main><h1>실제 hook 계정 격리 검증 · fixture 전용</h1><p>실제 계정·외부 API를 사용하지 않습니다.</p>
    <button onClick={() => setUser('a')}>계정 A</button><button onClick={() => { deferB = true; setUser('b') }}>계정 B 지연 응답</button>
    <button onClick={() => setUser(null)}>로그아웃 guest</button><button onClick={() => release?.()}>늦은 B 응답 전달</button>
    <p>현재 계정: {user || 'guest'}</p><div aria-label="계정 대화">{agent.active.messages.map(m => <p key={m.id}>{m.content}</p>)}</div>
    <textarea aria-label="계정 초안" value={agent.active.draft} onChange={e => agent.setDraft(e.target.value)}/>
  </main>
}
createRoot(document.getElementById('root')).render(<ScopeQA/> )
