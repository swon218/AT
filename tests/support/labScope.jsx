import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import LabChartPanel from '../../src/components/LabChartPanel'
import { DEFAULT_BACKTEST } from '../../src/utils/backtest'
import '../../src/styles.css'

function LabQA() {
  const [settings, setSettings] = useState({ ...structuredClone(DEFAULT_BACKTEST), symbol: '005930' })
  const [mount, setMount] = useState(0)
  const [requests, setRequests] = useState([])
  const restart = async mode => {
    setMount(null)
    await fetch(`/__qa/mode/${mode}`, { method: 'POST' })
    setMount(previous => (previous ?? 0) + 1)
  }
  return <main style={{ padding: 24, maxWidth: 1000, margin: 'auto' }}>
    <style>{'.lab-qa-controls{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.lab-qa-controls button{width:auto;padding:8px 12px;color:#dbe8ff;background:#18304a;border:1px solid #365573;border-radius:6px;cursor:pointer}'}</style>
    <p>실험실 fixture QA · 외부 API 및 운영 DB 사용 없음</p>
    <nav className="lab-qa-controls" aria-label="QA 시나리오">
      <button onClick={() => restart('normal')}>정상 진입</button>
      <button onClick={() => restart('ranking-delayed')}>순위 응답 지연</button>
      <button onClick={() => restart('ranking-error')}>순위 조회 실패</button>
      <button onClick={() => restart('candles-delayed')}>일봉 응답 지연</button>
      <button onClick={() => fetch('/__qa/release', { method: 'POST' })}>지연 응답 전달</button>
      <button onClick={async () => setRequests(await (await fetch('/__qa/requests')).json())}>요청 기록 확인</button>
    </nav>
    <output aria-label="선택 설정">{settings.symbol}</output>
    {mount !== null && <LabChartPanel key={mount} indicators={[]} strategyName="" settings={settings} onSettingsChange={setSettings}/>}
    <pre aria-label="API 요청 기록">{JSON.stringify(requests, null, 2)}</pre>
  </main>
}
const root = createRoot(document.getElementById('root'))
root.render(<LabQA/> )
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
