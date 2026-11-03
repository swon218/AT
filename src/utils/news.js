export const NEWS_CATEGORIES = [['all', '전체'], ['market', '시장'], ['stock', '종목'], ['economy', '경제'], ['overseas', '해외'], ['disclosure', '공시']]
export const NEWS_REFRESH_MS = 5 * 60_000

export function safeNewsUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}

// Use both URLs to recognize the same story across upstream pages.
export function mergeNewsItems(previous = [], incoming = []) {
  const seen = new Set()
  return [...previous, ...incoming].flatMap(item => {
    const link = safeNewsUrl(item.link) || safeNewsUrl(item.naverLink)
    const naverLink = safeNewsUrl(item.naverLink)
    if (!link || !item.title || seen.has(link) || (naverLink && seen.has(naverLink))) return []
    seen.add(link)
    if (naverLink) seen.add(naverLink)
    return [{ ...item, link, naverLink }]
  })
}

export function publishedTime(value) {
  const date = new Date(value)
  if (!value || !Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}
export const isoTime = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
