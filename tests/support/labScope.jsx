import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../../src/App'
import '../../src/styles.css'

function LabQA() {
  const [mount, setMount] = useState(0)
  const [open, setOpen] = useState(false)
  const [requests, setRequests] = useState([])
  const restart = async mode => {
    setMount(null)
    await fetch(`/__qa/mode/${mode}`, { method: 'POST' })
    setMount(previous => (previous ?? 0) + 1)
  }
  return <>
    {mount !== null && <App key={mount}/>}
    <aside style={{ position: 'fixed', right: 8, bottom: 8, zIndex: 100, maxWidth: 'min(440px, 95vw)', maxHeight: '38vh', overflow: 'auto', padding: 8, background: 'var(--surface-panel, #18304a)' }}>
      <button type="button" onClick={() => setOpen(!open)}>{open ? '검증 도구 접기' : '검증 도구 열기'}</button>
      {open && <>
        <div aria-label="QA 시나리오">
          <button onClick={() => restart('normal')}>정상 진입</button>
          <button onClick={() => restart('ranking-delayed')}>순위 응답 지연</button>
          <button onClick={() => restart('ranking-error')}>순위 조회 실패</button>
          <button onClick={() => restart('candles-delayed')}>일봉 응답 지연</button>
          <button onClick={() => restart('candles-error')}>일봉 조회 실패</button>
          <button onClick={() => restart('catalog-error')}>종목 목록 오류</button>
          <button onClick={() => fetch('/__qa/mode/normal', { method: 'POST' })}>오류 해제</button>
          <button onClick={() => fetch('/__qa/release', { method: 'POST' })}>지연 응답 전달</button>
          <button onClick={async () => setRequests(await (await fetch('/__qa/requests')).json())}>요청 기록 확인</button>
        </div>
        <pre aria-label="API 요청 기록">{JSON.stringify(requests, null, 2)}</pre>
      </>}
    </aside>
  </>
}
const root = createRoot(document.getElementById('root'))
root.render(<LabQA/> )
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
