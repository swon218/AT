import { config } from './config.js'

const cache = new Map()
const pending = new Map()
export const NEWS_CACHE_MS = 5 * 60_000
export const NEWS_MAX_RESULTS = 1000
const entities = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }
const clean = (value = '') => String(value).replace(/<[^>]*>/g, '').replace(/&(amp|quot|#39|lt|gt);/g, (match) => entities[match] || match).trim()

export const newsCategories = {
  all: { label: '전체', query: '증시' }, market: { label: '시장', query: '국내 증시' },
  stock: { label: '종목', query: '주식 기업' }, economy: { label: '경제', query: '경제 금리' },
  overseas: { label: '해외', query: '미국 증시' }, disclosure: { label: '공시', query: '기업 공시' },
}
const safeUrl = value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '' } catch { return '' }
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

function validateCategory(category) {
  if (!Object.hasOwn(newsCategories, category)) throw Object.assign(new Error('지원하지 않는 뉴스 분류입니다.'), { statusCode: 400 })
}

function filterNews(items, category) {
  const seen = new Set()
  return items.map(item => decorateNews(item, category)).filter(item => {
    if (seen.has(item.link) || (item.naverLink && seen.has(item.naverLink))) return false
    seen.add(item.link)
    if (item.naverLink) seen.add(item.naverLink)
    if (category !== 'all' && item.category !== category) return false
    if (category === 'disclosure' && /공시가격|공시지가|공시지원금|대학알리미|졸업생/.test(`${item.title} ${item.description}`)) return false
    return true
  })
}

export async function getDashboardNews(category = 'all') {
  validateCategory(category)
  const { label, query } = newsCategories[category]
  const items = await getNews(query, category === 'all' ? 20 : 50)
  const filtered = filterNews(items, category).slice(0, 20)
  return { category, label, items: filtered, searchUrl: `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(query)}` }
}

export async function getNewsFeed(category = 'all', start = 1, display = 50) {
  validateCategory(category)
  const page = await getNewsPage(newsCategories[category].query, display, start)
  return { ...page, category, label: newsCategories[category].label, items: filterNews(page.items, category) }
}

export async function getNews(query = '국내 증시', display = 6) {
  return (await getNewsPage(query, display)).items
}

async function getNewsPage(query, display, start = 1) {
  if (!Number.isInteger(start) || start < 1 || start > NEWS_MAX_RESULTS || !Number.isInteger(display) || display < 1 || display > 100) {
    throw Object.assign(new Error('뉴스 조회 범위가 올바르지 않습니다.'), { statusCode: 400 })
  }
  if (!config.naverClientId || !config.naverClientSecret) throw new Error('네이버 뉴스 API 키가 설정되지 않았습니다.')
  // Keep the entire requested range within the supported search window.
  display = Math.min(display, NEWS_MAX_RESULTS - start + 1)
  const key = JSON.stringify([query, display, start])
  const existing = cache.get(key)
  if (existing && Date.now() - existing.at < NEWS_CACHE_MS) return existing.page
  if (pending.has(key)) return pending.get(key)
  const request = fetchNewsPage(query, display, start).then(page => {
    for (const [cacheKey, entry] of cache) if (Date.now() - entry.at >= NEWS_CACHE_MS) cache.delete(cacheKey)
    if (cache.size >= 256) cache.delete(cache.keys().next().value)
    cache.set(key, { at: Date.now(), page })
    return page
  }).finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}

async function fetchNewsPage(query, display, start) {
  const url = new URL('https://openapi.naver.com/v1/search/news.json')
  url.searchParams.set('query', query)
  url.searchParams.set('display', String(display))
  url.searchParams.set('start', String(start))
  url.searchParams.set('sort', 'date')
  const response = await fetch(url, { headers: { 'X-Naver-Client-Id': config.naverClientId, 'X-Naver-Client-Secret': config.naverClientSecret }, signal: AbortSignal.timeout(15_000) })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.errorMessage || `네이버 뉴스 요청에 실패했습니다. (${response.status})`)
  if (!Array.isArray(payload.items) || !Number.isInteger(payload.total) || payload.total < 0) throw new Error('네이버 뉴스 응답 형식이 올바르지 않습니다.')
  const rawItems = payload.items.slice(0, display)
  const items = rawItems.map((item) => ({
    title: clean(item.title), description: clean(item.description), link: safeUrl(item.originallink) || safeUrl(item.link),
    naverLink: safeUrl(item.link), publishedAt: item.pubDate, source: 'Naver News',
  })).filter(item => item.title && item.link)
  // Advance using upstream rows, BEFORE URL validation, deduplication and category filtering.
  const scanned = rawItems.length
  const position = start + scanned
  const limitReached = position > NEWS_MAX_RESULTS && payload.total >= NEWS_MAX_RESULTS
  const exhausted = scanned < display || position > payload.total
  const nextStart = limitReached || exhausted ? null : position
  return { items, start, scanned, nextStart, total: payload.total, maxResults: NEWS_MAX_RESULTS,
    endReason: nextStart !== null ? null : limitReached ? 'limit' : 'end', fetchedAt: new Date().toISOString() }
}

export function registerNewsRoutes(app) {
  const category = { type: 'string', enum: Object.keys(newsCategories), default: 'all' }
  app.get('/api/public/news', async (request, reply) => {
    try {
      const query = String(request.query.query || '국내 증시').slice(0, 100)
      const display = Math.min(10, Math.max(1, Math.trunc(Number(request.query.display)) || 6))
      return { items: await getNews(query, display) }
    } catch (error) { return reply.code(error.statusCode || 502).send({ error: error.message }) }
  })
  app.get('/api/public/news/dashboard', { schema: { querystring: { type: 'object', properties: { category } } } }, async (request, reply) => {
    try { return await getDashboardNews(request.query.category) }
    catch (error) { return reply.code(error.statusCode || 502).send({ error: error.message }) }
  })
  app.get('/api/public/news/feed', { schema: { querystring: { type: 'object', additionalProperties: false, properties: {
    category, start: { type: 'integer', minimum: 1, maximum: NEWS_MAX_RESULTS, default: 1 },
    display: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  } } } }, async (request, reply) => {
    try { return await getNewsFeed(request.query.category, request.query.start, request.query.display) }
    catch (error) { return reply.code(error.statusCode || 502).send({ error: error.message }) }
  })
}
