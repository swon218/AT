import { useEffect, useState } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { getDashboardNews } from '../services/newsApi'

const categories = [['all', '전체'], ['market', '시장'], ['stock', '종목'], ['economy', '경제'], ['overseas', '해외'], ['disclosure', '공시']]
function publishedTime(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}
const isoTime = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined

export default function DashboardNews() {
  const [category, setCategory] = useState('all')
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState({})
  const current = state.category === category ? state : { loading: true }
  useEffect(() => {
    const controller = new AbortController()
    let timer, inFlight = false
    setState({ category, loading: true })
    const load = async () => {
      if (inFlight || controller.signal.aborted) return
      clearTimeout(timer)
      inFlight = true
      try {
        const payload = await getDashboardNews(category, controller.signal)
        if (!controller.signal.aborted) setState({ ...payload, category, loading: false })
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, category, loading: false, error: error.message }))
      } finally {
        inFlight = false
        if (!controller.signal.aborted) timer = setTimeout(() => { if (!document.hidden) load() }, 5 * 60_000)
      }
    }
    const onVisible = () => { if (!document.hidden) load() }
    load()
    document.addEventListener('visibilitychange', onVisible)
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [category, revision])
  return <article className="panel dashboard-news" aria-labelledby="dashboard-news-title">
    <div className="dashboard-news-heading"><h2 id="dashboard-news-title">주요 뉴스 · 공시</h2>{current.searchUrl && <a href={current.searchUrl} target="_blank" rel="noreferrer">더보기 <ChevronRight size={14}/></a>}</div>
    <div className="dashboard-news-tabs" role="group" aria-label="뉴스 분류">{categories.map(([id, label]) => <button type="button" key={id} aria-pressed={category === id} onClick={() => setCategory(id)}>{label}</button>)}</div>
    <div className="dashboard-news-feed" aria-busy={current.loading}>
      {current.items?.map(item => <a className="dashboard-news-story" href={item.link} target="_blank" rel="noreferrer" key={item.link}>
        <span className={`news-category-badge ${item.breaking ? 'breaking' : item.category}`} title={item.breaking ? '기사 제목에 속보가 표시된 뉴스' : '기사 제목·요약 기준 분류'}>{item.breaking ? '속보' : item.categoryLabel}</span>
        <div className="news-story-content"><strong>{item.title}</strong><div className="news-story-meta"><time dateTime={isoTime(item.publishedAt)}>{publishedTime(item.publishedAt)}</time><span>{item.source}</span></div><p>{item.description}</p>
          {!!item.tags?.length && <div className="news-story-tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
        </div>
      </a>)}
      {current.loading && <div className="index-chart-message" role="status"><span className="loading-ring"/><span>뉴스를 불러오고 있습니다.</span></div>}
      {current.error && <div className="index-chart-message" role="alert"><span>{current.items?.length ? '뉴스 갱신에 실패했습니다. 마지막 수신 기사를 표시합니다.' : current.error}</span><button type="button" onClick={() => setRevision(v => v + 1)}><RefreshCw size={14}/> 다시 시도</button></div>}
      {!current.loading && !current.error && !current.items?.length && <div className="data-message">표시할 뉴스가 없습니다.</div>}
    </div>
    <div className="dashboard-news-footer">{category === 'disclosure' ? '공시 관련 뉴스 · NAVER · 5분 갱신' : 'NAVER 뉴스 · 5분 갱신'}</div>
  </article>
}
