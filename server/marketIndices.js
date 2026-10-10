import { requestKiwoom } from './kiwoomClient.js'
import { marketRequestContext } from './marketContext.js'

const indices = { kospi: { name: '코스피', code: '001', market: '0' }, kosdaq: { name: '코스닥', code: '101', market: '1' } }
const periods = new Set(['1d', '1w', '1m', '3m', '1y'])
const error = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode })
const numeric = value => {
  if (value == null || String(value).trim() === '') return null
  const n = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : null
}
const absolute = value => { const n = numeric(value); return n === null ? null : Math.abs(n) }
const seoulDate = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time))

function normalizeRows(rows, intraday) {
  const unique = new Map()
  for (const row of rows) {
    const stamp = String(intraday ? row.cntr_tm : row.dt)
    if (!(intraday ? /^\d{14}$/ : /^\d{8}$/).test(stamp)) continue
    const date = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`
    const time = intraday ? `${date}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}+09:00` : date
    const close = absolute(row.cur_prc)
    if (!Number.isFinite(Date.parse(time)) || close === null || close <= 0) continue
    // Kiwoom sector candles are index points * 100; volume is in thousands of shares.
    unique.set(time, { time, close: close / 100, volume: absolute(row.trde_qty) === null ? null : absolute(row.trde_qty) * 1000 })
  }
  return [...unique.values()].sort((a, b) => a.time.localeCompare(b.time))
}

function startDate(end, period) {
  const date = new Date(`${end}T00:00:00Z`)
  if (period === '1w') date.setUTCDate(date.getUTCDate() - 7)
  else {
    const day = date.getUTCDate()
    date.setUTCDate(1)
    date.setUTCMonth(date.getUTCMonth() - ({ '1m': 1, '3m': 3, '1y': 12 }[period]))
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
    date.setUTCDate(Math.min(day, lastDay))
  }
  return date.toISOString().slice(0, 10)
}

export function createMarketIndices({ now = Date.now, ttl = 30_000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const cache = new Map()
  const pending = new Map()
  return async (symbol, period, { requester = requestKiwoom, cacheScope = 'operator' } = {}) => {
    if (!Object.hasOwn(indices, symbol) || !periods.has(period)) throw error('지원하지 않는 지수 또는 조회 기간입니다.', 400)
    const key = `${cacheScope}:${symbol}:${period}`
    if (cache.get(key)?.expires > now()) return cache.get(key).value
    if (pending.has(key)) return pending.get(key)
    const promise = (async () => {
      const index = indices[symbol]
      const intraday = period === '1d'
      const baseDate = seoulDate(now()).replace(/-/g, '')
      const quote = await requester({ apiId: 'ka20001', endpoint: '/api/dostk/sect', body: { mrkt_tp: index.market, inds_cd: index.code } })
      const price = absolute(quote.cur_prc)
      if (price === null || price <= 0) throw error('현재 지수 응답이 비어 있습니다.')
      let rows = [], rawRows = [], nextKey = '', complete = false
      const seenKeys = new Set()
      for (let page = 0; page < 10; page++) {
        await pause(250)
        const result = await requester({
          apiId: intraday ? 'ka20005' : 'ka20006', endpoint: '/api/dostk/chart',
          body: { inds_cd: index.code, base_dt: baseDate, ...(intraday ? { tic_scope: '1' } : {}) },
          returnPage: true, contYn: nextKey ? 'Y' : 'N', nextKey,
        })
        const list = result.body?.[intraday ? 'inds_min_pole_qry' : 'inds_dt_pole_qry']
        if (!Array.isArray(list) || !list.length) throw error('지수 차트 응답이 비어 있습니다.')
        rawRows.push(...list)
        const normalized = normalizeRows(rawRows, intraday)
        const end = normalized.at(-1)?.time.slice(0, 10)
        if (!end) throw error('유효한 지수 차트 데이터가 없습니다.')
        const cutoff = intraday ? end : startDate(end, period)
        if (normalized[0].time.slice(0, 10) < cutoff || result.contYn !== 'Y') {
          rows = normalized.filter(row => row.time.slice(0, 10) >= cutoff)
          complete = true
          break
        }
        if (!result.nextKey || seenKeys.has(result.nextKey)) throw error('지수 차트 연속 조회를 완료하지 못했습니다.')
        seenKeys.add(result.nextKey)
        nextKey = result.nextKey
      }
      if (!complete) throw error('선택 기간의 지수 차트를 모두 불러오지 못했습니다.')
      const direction = ['1', '2'].includes(String(quote.pred_pre_sig)) ? 1 : ['4', '5'].includes(String(quote.pred_pre_sig)) ? -1 : 0
      const signed = value => { const n = numeric(value); return n === null ? null : direction ? direction * Math.abs(n) : n }
      const value = {
        symbol, name: index.name, period, price, change: signed(quote.pred_pre), changeRate: signed(quote.flu_rt),
        volume: absolute(quote.trde_qty) === null ? null : absolute(quote.trde_qty) * 1000,
        asOf: rows.at(-1).time, fetchedAt: new Date(now()).toISOString(), candles: rows,
      }
      for (const [oldKey, entry] of cache) if (entry.expires <= now()) cache.delete(oldKey)
      if (cache.size >= 200) cache.delete(cache.keys().next().value)
      cache.set(key, { value, expires: now() + ttl })
      return value
    })()
    pending.set(key, promise)
    try { return await promise } finally { pending.delete(key) }
  }
}

const getMarketIndex = createMarketIndices()
export function registerMarketIndexRoutes(app, { context = marketRequestContext, getIndex = getMarketIndex } = {}) {
  app.get('/api/public/market/kiwoom/indices', { schema: { querystring: {
    type: 'object', required: ['symbol', 'period'], additionalProperties: false,
    properties: { symbol: { type: 'string', enum: Object.keys(indices) }, period: { type: 'string', enum: [...periods] } },
  } } }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    try { return await getIndex(request.query.symbol, request.query.period, await context(request)) }
    catch (e) { return reply.code(e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 502).send({ error: e.message }) }
  })
}
