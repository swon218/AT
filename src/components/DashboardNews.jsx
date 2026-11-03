import { useEffect, useState } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { getDashboardNews } from '../services/newsApi'
import { NewsCategoryTabs, NewsStory } from './NewsShared'
import { mergeNewsItems, NEWS_REFRESH_MS } from '../utils/news'

export default function DashboardNews({ onOpenNews }) {
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
        if (!controller.signal.aborted) setState({ ...payload, items: mergeNewsItems([], payload.items).slice(0, 6), category, loading: false })
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, category, loading: false, error: error.message }))
      } finally {
        inFlight = false
        if (!controller.signal.aborted) timer = setTimeout(() => { if (!document.hidden) load() }, NEWS_REFRESH_MS)
      }
    }
    const onVisible = () => { if (!document.hidden) load() }
    load()
    document.addEventListener('visibilitychange', onVisible)
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [category, revision])
  return <article className="panel dashboard-news" aria-labelledby="dashboard-news-title">
    <div className="dashboard-news-heading"><h2 id="dashboard-news-title">주요 뉴스 · 공시</h2><button type="button" className="dashboard-news-more" onClick={() => onOpenNews(category)}>더보기 <ChevronRight size={14}/></button></div>
    <NewsCategoryTabs category={category} onChange={setCategory}/>
    <div className="dashboard-news-feed" aria-busy={current.loading}>
      {current.items?.map(item => <NewsStory item={item} key={item.link}/>)}
      {current.loading && <div className="index-chart-message" role="status"><span className="loading-ring"/><span>뉴스를 불러오고 있습니다.</span></div>}
      {current.error && <div className="index-chart-message" role="alert"><span>{current.items?.length ? '뉴스 갱신에 실패했습니다. 마지막 수신 기사를 표시합니다.' : current.error}</span><button type="button" onClick={() => setRevision(v => v + 1)}><RefreshCw size={14}/> 다시 시도</button></div>}
      {!current.loading && !current.error && !current.items?.length && <div className="data-message">표시할 뉴스가 없습니다.</div>}
    </div>
    <div className="dashboard-news-footer">{category === 'disclosure' ? '공시 관련 뉴스 · NAVER · 5분 갱신' : 'NAVER 뉴스 · 5분 갱신'}</div>
  </article>
}
