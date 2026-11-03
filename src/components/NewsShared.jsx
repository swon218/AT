import { isoTime, NEWS_CATEGORIES, publishedTime, safeNewsUrl } from '../utils/news'

export function NewsCategoryTabs({ category, onChange, className = '' }) {
  return <div className={`dashboard-news-tabs ${className}`} role="group" aria-label="뉴스 분류">{NEWS_CATEGORIES.map(([id, label]) =>
    <button type="button" key={id} aria-pressed={category === id} onClick={() => onChange(id)}>{label}</button>
  )}</div>
}

export function NewsStory({ item, expanded = false }) {
  const link = safeNewsUrl(item.link) || safeNewsUrl(item.naverLink)
  if (!link) return null
  return <a className={`dashboard-news-story${expanded ? ' news-page-story' : ''}`} href={link} target="_blank" rel="noopener noreferrer">
    <span className={`news-category-badge ${item.breaking ? 'breaking' : item.category}`} title={item.breaking ? '기사 제목에 속보가 표시된 뉴스' : '기사 제목·요약 기준 분류'}>{item.breaking ? '속보' : item.categoryLabel}</span>
    <div className="news-story-content"><strong>{item.title}</strong>
      <div className="news-story-meta">{item.source && <span>{item.source}</span>}{publishedTime(item.publishedAt) && <time dateTime={isoTime(item.publishedAt)}>{publishedTime(item.publishedAt)} (KST)</time>}{expanded && item.breaking && <span>{item.categoryLabel}</span>}{expanded && <span>원문 새 탭 ↗</span>}</div>
      {item.description && <p>{item.description}</p>}
      {!!item.tags?.length && <div className="news-story-tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
    </div>
  </a>
}
