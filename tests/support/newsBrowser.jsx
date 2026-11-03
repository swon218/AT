// Test-only Vite entry. All news fixtures are visibly marked; no external requests are sent.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import NewsPage from '../../src/components/NewsPage'
import DashboardNews from '../../src/components/DashboardNews'
import { NEWS_CATEGORIES, NEWS_REFRESH_MS } from '../../src/utils/news'
import '../../src/styles.css'
import '../../src/components/Dashboard.css'

let mode = 'normal', version = 0, clockOffset = 0, release
const requests = [], timers = new Set(), realNow = Date.now, realInterval = window.setInterval.bind(window), realClear = window.clearInterval.bind(window)
const advanceClock = () => { clockOffset += NEWS_REFRESH_MS + 1; version++; for (const handler of timers) handler() }
Date.now = () => realNow() + clockOffset
window.setInterval = (handler, delay, ...args) => {
  if (delay === NEWS_REFRESH_MS) { timers.add(handler); return handler }
  return realInterval(handler, delay, ...args)
}
window.clearInterval = id => { if (timers.has(id)) timers.delete(id); else realClear(id) }
window.fetch = async input => {
  const url = new URL(input, location.origin)
  if (!url.pathname.startsWith('/api/public/news/')) return new Response('{}', { status: 503 })
  const category = url.searchParams.get('category') || 'all', start = Number(url.searchParams.get('start') || 1)
  requests.push(`${category}:${start}`)
  const currentMode = mode, currentVersion = version
  if (currentMode === 'slow' && category === 'market') await new Promise(resolve => { release = resolve })
  if (currentMode === 'error' || (currentMode === 'append-error' && start > 1)) return new Response(JSON.stringify({ error: '화면 검증용 뉴스 오류' }), { status: 502 })
  const label = NEWS_CATEGORIES.find(([id]) => id === category)[1]
  const item = id => ({ title: `[화면 검증용] ${label} 기사 ${id} · 목록 ${currentVersion}`, link: `https://example.com/${category}/${currentVersion}/${id}`, naverLink: `https://n.news.naver.com/article/000/${category}${currentVersion}${id}`, source: '화면 검증용 출처', publishedAt: '2026-11-03T15:00:00Z', category: category === 'all' ? 'market' : category, categoryLabel: label, description: '테스트 전용으로 제공된 요약입니다. 실제 기사 데이터가 아닙니다. 긴 제목과 요약이 모바일에서도 잘리지 않고 표시되는지 확인합니다.' })
  const empty = currentMode === 'empty' || (currentMode === 'filtered' && start === 1)
  const items = empty ? [] : start === 1 ? Array.from({ length: 50 }, (_, i) => item(i + 1)) : [item(1), ...Array.from({ length: 24 }, (_, i) => item(i + 51))]
  return new Response(JSON.stringify({ category, items, nextStart: currentMode !== 'empty' && start === 1 ? 51 : null, endReason: currentMode === 'empty' || start > 1 ? 'end' : null, scanned: start === 1 ? 50 : 25, start, total: 75, maxResults: 1000, fetchedAt: new Date(Date.now()).toISOString() }))
}

function Harness() {
  const [category, setCategory] = useState('all'), [page, setPage] = useState('news'), [log, setLog] = useState('')
  return <>
    <div style={{ position: 'sticky', top: 0, zIndex: 50, background: '#07101d', padding: 12, borderBottom: '1px solid #456', display: 'flex', flexWrap: 'wrap', gap: 8 }} aria-label="검증 제어">
      <strong>테스트 전용 · 실제 뉴스 아님</strong>
      <select aria-label="응답 시나리오" defaultValue="normal" onChange={event => { mode = event.target.value }}>
        <option value="normal">정상</option><option value="error">오류</option><option value="empty">빈 결과</option><option value="filtered">첫 구간 필터로 빈 결과</option><option value="slow">시장 응답 지연</option><option value="append-error">추가 조회 오류</option>
      </select>
      <button onClick={() => release?.()}>지연 응답 해제</button>
      <button onClick={advanceClock}>5분 경과</button>
      <button onClick={() => setTimeout(advanceClock, 5000)}>5초 뒤 갱신 예약</button>
      <button onClick={() => setLog(requests.join(' → '))}>요청 기록</button>
      <button onClick={() => setPage(page === 'news' ? 'dashboard' : 'news')}>{page === 'news' ? '미리보기로' : '뉴스 페이지로'}</button>
      <output style={{ width: '100%', overflowWrap: 'anywhere' }}>{log}</output>
    </div>
    <div className="content guest-content">
      {page === 'news' ? <NewsPage category={category} onCategoryChange={setCategory}/> : <div className="trading-grid dashboard-market-grid"><DashboardNews onOpenNews={value => { setCategory(value); setPage('news') }}/></div>}
    </div>
  </>
}
createRoot(document.getElementById('root')).render(<Harness/> )
