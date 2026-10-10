import { config } from './config.js'

const cache = new Map()
const entities = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }
const clean = (value = '') => String(value).replace(/<[^>]*>/g, '').replace(/&(amp|quot|#39|lt|gt);/g, (match) => entities[match] || match).trim()

export const newsCategories = {
  all: { label: '전체', query: '증시' }, market: { label: '시장', query: '국내 증시' },
  stock: { label: '종목', query: '주식 기업' }, economy: { label: '경제', query: '경제 금리' },
  overseas: { label: '해외', query: '미국 증시' }, disclosure: { label: '공시', query: '기업 공시' },
}
const safeUrl = value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : '' } catch { return '' }
}
const publishers = { 'hankyung.com': '한국경제', 'mk.co.kr': '매일경제', 'yna.co.kr': '연합뉴스', 'yonhapnewstv.co.kr': '연합뉴스TV', 'edaily.co.kr': '이데일리', 'mt.co.kr': '머니투데이', 'newsis.com': '뉴시스', 'news1.kr': '뉴스1', 'sedaily.com': '서울경제', 'fnnews.com': '파이낸셜뉴스', 'biz.chosun.com': '조선비즈', 'asiae.co.kr': '아시아경제' }

export function decorateNews(item, fallback = 'market') {
  const content = `${item.title} ${item.description}`
  const classify = text => /공시|유상증자|무상증자|자사주.*(?:취득|소각)|주요사항보고/.test(text) ? 'disclosure'
    : /나스닥|뉴욕증시|월가|월스트리트|S&P|다우지수|[미美].*증시|해외증시|연준/.test(text) ? 'overseas'
      : /금리|환율|물가|한국은행|경제성장|GDP/.test(text) ? 'economy'
        : /코스피|코스닥|증시|증권시장/.test(text) ? 'market'
          : /실적|영업이익|목표주가|수주|배당/.test(text) ? 'stock' : null
  const category = classify(item.title) || classify(item.description) || (fallback === 'all' ? 'market' : fallback)
  const tags = ['코스피', '코스닥', '나스닥', 'S&P500', '반도체', '금리', '환율', '실적', '배당', '공시', 'AI']
    .filter(tag => tag === 'S&P500' ? /S&P\s*500/i.test(content) : tag === 'AI' ? /\bAI\b/.test(content) : content.includes(tag)).slice(0, 3)
  let source = '뉴스'
  try {
    const host = new URL(item.link || item.naverLink).hostname.replace(/^www\./, '')
    source = Object.entries(publishers).find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1] || host
  } catch { /* Invalid source URLs are omitted by getNews. */ }
  return { ...item, source, category, categoryLabel: newsCategories[category].label, breaking: /(?:\[|\(|【)?속보(?:\]|\)|】|\s|:)/.test(item.title), tags }
}

export async function getDashboardNews(category = 'all') {
  if (!Object.hasOwn(newsCategories, category)) throw Object.assign(new Error('지원하지 않는 뉴스 분류입니다.'), { statusCode: 400 })
  const { label, query } = newsCategories[category]
  const items = await getNews(query, category === 'all' ? 20 : 50)
  const seen = new Set()
  const filtered = items.map(item => decorateNews(item, category)).filter(item => {
    if (seen.has(item.link)) return false
    seen.add(item.link)
    if (category !== 'all' && item.category !== category) return false
    if (category === 'disclosure' && /공시가격|공시지가|공시지원금|대학알리미|졸업생/.test(`${item.title} ${item.description}`)) return false
    return true
  }).slice(0, 20)
  return { category, label, items: filtered, searchUrl: `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(query)}` }
}

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
  const response = await fetch(url, { headers: { 'X-Naver-Client-Id': config.naverClientId, 'X-Naver-Client-Secret': config.naverClientSecret }, signal: AbortSignal.timeout(15_000) })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.errorMessage || `네이버 뉴스 요청에 실패했습니다. (${response.status})`)
  const items = (payload.items || []).map((item) => ({
    title: clean(item.title), description: clean(item.description), link: safeUrl(item.originallink) || safeUrl(item.link),
    naverLink: safeUrl(item.link), publishedAt: item.pubDate, source: 'Naver News',
  })).filter(item => item.title && item.link)
  cache.set(key, { at: Date.now(), items })
  return items
}
