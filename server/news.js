import { config } from './config.js'

const cache = new Map()
const entities = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }
const clean = (value = '') => String(value).replace(/<[^>]*>/g, '').replace(/&(amp|quot|#39|lt|gt);/g, (match) => entities[match] || match).trim()

export async function getNews(query = '국내 증시', display = 6) {
  if (!config.naverClientId || !config.naverClientSecret) throw new Error('네이버 뉴스 API 키가 설정되지 않았습니다.')
  const key = `${query}:${display}`
  const existing = cache.get(key)
  if (existing && Date.now() - existing.at < 5 * 60_000) return existing.items
  const url = new URL('https://openapi.naver.com/v1/search/news.json')
  url.searchParams.set('query', query)
  url.searchParams.set('display', String(display))
  url.searchParams.set('start', '1')
  url.searchParams.set('sort', 'date')
  const response = await fetch(url, { headers: { 'X-Naver-Client-Id': config.naverClientId, 'X-Naver-Client-Secret': config.naverClientSecret } })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.errorMessage || `네이버 뉴스 요청에 실패했습니다. (${response.status})`)
  const items = (payload.items || []).map((item) => ({
    title: clean(item.title), description: clean(item.description), link: item.originallink || item.link,
    naverLink: item.link, publishedAt: item.pubDate, source: 'Naver News',
  }))
  cache.set(key, { at: Date.now(), items })
  return items
}
