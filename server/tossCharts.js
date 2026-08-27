import { requestTossWithCredentials } from './tossClient.js'

const cache = new Map()
const allowedIntervals = new Set(['1분', '5분', '10분', '15분', '30분', '60분', '일', '주', '월'])
const minuteFactors = { '1분': 1, '5분': 5, '10분': 10, '15분': 15, '30분': 30, '60분': 60 }

const number = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function candleFromToss(row) {
  const timestamp = String(row.timestamp || '')
  const milliseconds = new Date(timestamp).getTime()
  return {
    time: Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : timestamp.slice(0, 10),
    sourceTime: timestamp,
    open: number(row.openPrice),
    high: number(row.highPrice),
    low: number(row.lowPrice),
    close: number(row.closePrice),
    volume: Math.max(0, number(row.volume)),
  }
}

function bucketKey(item, interval) {
  const factor = minuteFactors[interval]
  if (factor) return `m:${Math.floor(Number(item.time) / (factor * 60))}`
  const date = item.sourceTime.slice(0, 10)
  if (interval === '일') return `d:${date}`
  if (interval === '월') return `M:${date.slice(0, 7)}`
  const day = new Date(`${date}T00:00:00Z`)
  const weekday = day.getUTCDay() || 7
  day.setUTCDate(day.getUTCDate() - weekday + 1)
  return `w:${day.toISOString().slice(0, 10)}`
}

function aggregateCandles(items, interval) {
  if (interval === '1분' || interval === '일') return items
  const groups = new Map()
  items.forEach((item) => {
    const key = bucketKey(item, interval)
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { ...item })
      return
    }
    existing.high = Math.max(existing.high, item.high)
    existing.low = Math.min(existing.low, item.low)
    existing.close = item.close
    existing.volume += item.volume
  })
  return [...groups.values()]
}

async function fetchRawCandles(symbol, interval, limit, credentials) {
  const minuteFactor = minuteFactors[interval]
  const rawInterval = minuteFactor ? '1m' : '1d'
  const target = minuteFactor
    ? Math.min(3000, Math.max(200, limit * minuteFactor))
    : interval === '일' ? Math.min(200, limit) : Math.min(1000, Math.max(200, limit * (interval === '주' ? 7 : 31)))
  const collected = new Map()
  let before = ''
  let previousBefore = ''

  for (let page = 0; page < 15 && collected.size < target; page += 1) {
    const payload = await requestTossWithCredentials({
      ...credentials,
      path: '/api/v1/candles',
      query: { symbol, interval: rawInterval, count: Math.min(200, target - collected.size), before, adjusted: true },
    })
    const result = payload.result || {}
    const rows = Array.isArray(result.candles) ? result.candles : []
    rows.forEach((row) => {
      if (row.timestamp) collected.set(row.timestamp, candleFromToss(row))
    })
    if (!result.nextBefore || result.nextBefore === previousBefore || rows.length === 0) break
    previousBefore = before
    before = result.nextBefore
  }
  return [...collected.values()].filter((item) => item.time && item.open && item.high && item.low && item.close)
    .sort((a, b) => Number(a.time) - Number(b.time))
}

export async function getTossCandles(symbol, interval, limit = 200, { apiKey, secretKey, cacheScope = 'operator' }) {
  if (!/^\d{6}$/.test(symbol)) throw new Error('올바른 6자리 종목코드가 필요합니다.')
  if (!allowedIntervals.has(interval)) throw new Error('지원하지 않는 차트 주기입니다.')
  const key = `${cacheScope}:${symbol}:${interval}:${limit}`
  const existing = cache.get(key)
  if (existing && Date.now() - existing.at < 30_000) return existing.items

  const raw = await fetchRawCandles(symbol, interval, limit, { apiKey, secretKey })
  const items = aggregateCandles(raw, interval).map(({ sourceTime, ...item }) => item).slice(-limit)
  cache.set(key, { at: Date.now(), items })
  return items
}
