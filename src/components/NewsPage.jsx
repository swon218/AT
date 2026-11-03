import { Newspaper, RefreshCw, ChevronDown } from 'lucide-react'
import useNewsFeed from '../hooks/useNewsFeed'
import { publishedTime } from '../utils/news'
import { NewsCategoryTabs, NewsStory } from './NewsShared'
import './NewsPage.css'

export default function NewsPage({ category, onCategoryChange }) {
  const news = useNewsFeed(category)
  return <section className="news-page" aria-labelledby="news-page-title">
    <div className="news-page-heading"><div><p>MARKET NEWS</p><h1 id="news-page-title"><Newspaper aria-hidden="true"/>주요 뉴스 · 공시</h1><span>시장 소식과 기업 뉴스를 확인하고 원문으로 이어 읽으세요.</span></div>
      <button type="button" className="news-page-button" onClick={news.refresh} disabled={news.loading}><RefreshCw size={15}/> 최신 목록 보기</button>
    </div>
    <div className="panel news-page-panel">
      <NewsCategoryTabs category={category} onChange={onCategoryChange} className="news-page-tabs"/>
      <div className="news-page-info"><span>{category === 'disclosure' ? '공시 관련 뉴스 · NAVER' : 'NAVER 뉴스'} · 5분마다 새 뉴스 확인</span><span>{news.items.length}건 표시{news.fetchedAt ? ` · 수신 ${publishedTime(news.fetchedAt)} (KST)` : ''}</span></div>
      {category === 'disclosure' && <p className="news-page-disclosure">네이버에서 제공하는 공시 관련 뉴스입니다. DART 공식 공시 목록이 아닙니다.</p>}
      {news.hasUpdate && <div className="news-page-update" role="status"><span>새로운 뉴스 목록이 있습니다. 읽던 목록은 유지됩니다.</span><button type="button" onClick={news.refresh} disabled={news.loading}>최신 목록 보기</button></div>}
      {(news.error || news.refreshError) && <div className="news-page-error" role="alert"><span>{news.error || news.refreshError}{news.items.length > 0 && news.error ? ' 현재 목록은 유지됩니다.' : ''}</span><button type="button" onClick={news.retry} disabled={news.loading}><RefreshCw size={14}/> 다시 시도</button></div>}
      <div className="news-page-list" aria-busy={!!news.loading}>
        {news.items.map(item => <NewsStory item={item} expanded key={item.link}/>)}
        {news.loading && <div className="index-chart-message" role="status"><span className="loading-ring"/><span>{news.loadingMore ? '다음 뉴스를 불러오고 있습니다.' : '뉴스를 불러오고 있습니다.'}</span></div>}
        {!news.loading && !news.error && !news.items.length && <div className="index-chart-message" role="status"><Newspaper/><span>{news.nextStart ? '이번 조회 구간에 해당 분류의 기사가 없습니다. 다음 뉴스를 확인해 주세요.' : '표시할 뉴스가 없습니다.'}</span></div>}
      </div>
      <div className="news-page-pagination">
        {news.nextStart != null && !news.error && <button type="button" className="news-page-button" onClick={news.loadMore} disabled={news.loading}><ChevronDown size={16}/> 더 불러오기</button>}
        {!news.loading && !news.error && news.endReason && <p>{news.endReason === 'limit' ? `이 목록의 조회 범위(${news.maxResults.toLocaleString()}개 검색 결과)를 모두 확인했습니다. 분류를 바꾸거나 최신 목록을 확인해 주세요.` : '조회할 수 있는 뉴스를 모두 확인했습니다.'}</p>}
        <small>제목·요약에 따라 분류하며, 중복 기사와 다른 분류를 제외해 표시 건수는 조회 건수보다 적을 수 있습니다.</small>
      </div>
    </div>
  </section>
}
