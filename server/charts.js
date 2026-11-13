import { requestKiwoom } from './kiwoomClient.js'
import { dateOnly, seoulTimestamp } from '../src/utils/chartTime.js'

const allowedIntervals = new Set(['1분', '5분', '10분', '15분', '30분', '60분', '일', '주', '월'])
// Official guide: cntr_tm is the bar's start, and exchange selection uses stk_cd.
// https://openapi.kiwoom.com/m/guide/apiguide/07/ka10080 (checked 2026-11-14)
// Exact extended-session inclusion is unspecified; metadata makes no full-day promise.
const marketSuffix = { KRX: '', NXT: '_NX', INTEGRATED: '_AL' }
const MAX_PAGES = 3
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode })
const chartNumber = value => {
  if (value == null || String(value).trim() === '') return null
  const text = String(value).replace(/,/g, '').trim()
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? Math.abs(parsed) : null
}

function todayInSeoul(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)).replace(/-/g, '')
}

// Encode Kiwoom's Korean wall time as the actual instant with its offset.
// Never add nine hours to an existing UTC timestamp.
export function normalizeTime(value) {
  const text = String(value ?? '').trim()
  if (/^\d{8}$/.test(text)) return dateOnly(text) || ''
  if (!/^\d{14}$/.test(text)) return ''
  const time = seoulTimestamp(text)
  return time === null ? '' : `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+09:00`
}

export function chartDefinition(symbol, interval, { market = 'KRX', adjusted = true, baseDate, now = Date.now() } = {}) {
  if (!/^[0-9][0-9A-Z]{5}$/.test(symbol)) throw error('올바른 6자리 종목코드가 필요합니다.')
  if (!allowedIntervals.has(interval)) throw error('지원하지 않는 차트 주기입니다.')
  if (!Object.hasOwn(marketSuffix, market)) throw error('지원하지 않는 차트 시장입니다.')
  if (typeof adjusted !== 'boolean') throw error('수정주가 설정이 올바르지 않습니다.')
  if (baseDate !== undefined && (typeof baseDate !== 'string' || !/^\d{8}$/.test(baseDate))) throw error('기준일자는 YYYYMMDD 형식이어야 합니다.')
  if (baseDate !== undefined && !dateOnly(baseDate)) throw error('올바른 기준일자가 필요합니다.')
  const stk_cd = `${symbol}${marketSuffix[market]}`
  const upd_stkpc_tp = adjusted ? '1' : '0'
  if (interval.endsWith('분')) return {
    apiId: 'ka10080', endpoint: '/api/dostk/chart', listKeys: ['stk_min_pole_chart_qry'],
    body: { stk_cd, tic_scope: interval.replace('분', ''), upd_stkpc_tp, ...(baseDate ? { base_dt: baseDate } : {}) },
  }
  const map = {
    일: ['ka10081', ['stk_dt_pole_chart_qry']],
    주: ['ka10082', ['stk_stk_pole_chart_qry', 'stk_wk_pole_chart_qry']],
    월: ['ka10083', ['stk_mth_pole_chart_qry']],
  }
  const [apiId, listKeys] = map[interval]
  return { apiId, endpoint: '/api/dostk/chart', listKeys, body: { stk_cd, base_dt: baseDate || todayInSeoul(now), upd_stkpc_tp } }
}

function candleFromKiwoom(row, intraday) {
  if (!row || typeof row !== 'object') return null
  // A date field on a minute row cannot substitute for its actual clock.
  const stamp = String(row.cntr_tm ?? '').trim()
  const time = intraday ? (/^\d{14}$/.test(stamp) ? seoulTimestamp(stamp) : null) : dateOnly(row.dt)
  if (time === null) return null
  const open = chartNumber(row.open_pric), high = chartNumber(row.high_pric)
  const low = chartNumber(row.low_pric), close = chartNumber(row.cur_prc)
  if (![open, high, low, close].every(value => value !== null && value > 0)) return null
  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) return null
  return { time, open, high, low, close, volume: chartNumber(row.trde_qty) }
}

const copyResponse = value => ({ items: value.items.map(item => ({ ...item })), meta: { ...value.meta } })

export function createKiwoomChartService({ requester = requestKiwoom, now = Date.now, ttl = 30_000, maxCacheEntries = 200 } = {}) {
  const cache = new Map()
  const pending = new Map()

  async function getCandleResponse(symbol, interval, limit = 200, options = {}) {
    const { requester: contextRequester = requester, cacheScope = 'operator', market = 'KRX', adjusted = true, baseDate, maxPages = MAX_PAGES, signal } = options
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw error('차트 개수는 1~500의 정수여야 합니다.')
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) throw error('차트 연속 조회는 최대 3회까지 가능합니다.')
    if (typeof contextRequester !== 'function') throw error('키움 차트 조회 인증이 필요합니다.', 401)
    if (cacheScope !== 'operator' && contextRequester === requestKiwoom) throw error('개인 키움 차트 조회 인증이 필요합니다.', 401)
    const definition = chartDefinition(symbol, interval, { market, adjusted, baseDate, now: now() })
    const intraday = interval.endsWith('분')
    // marketRequestContext supplies a scope containing a credential fingerprint.
    const key = JSON.stringify([cacheScope, symbol, interval, limit, definition.body, maxPages])
    signal?.throwIfAborted()
    const existing = cache.get(key)
    if (existing?.expires > now()) return copyResponse(existing.value)
    if (!signal && pending.has(key)) return copyResponse(await pending.get(key))

    const promise = (async () => {
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
      const unique = new Map(), seenKeys = new Set()
      let nextKey = '', pagesFetched = 0, hasMore = null, partialReason = null
      let invalidRows = 0, countLimited = false
      for (let page = 0; page < maxPages; page++) {
        requestSignal.throwIfAborted()
        // The shared Kiwoom client applies its credential-level 5 TPS read
        // limiter to every page. Paging and retries remain bounded here.
        const result = await contextRequester({
          ...definition, returnPage: true, contYn: nextKey ? 'Y' : 'N', nextKey,
          signal: requestSignal,
        })
        requestSignal.throwIfAborted()
        pagesFetched++
        const pageEnvelope = result?.body && typeof result.body === 'object'
        const payload = pageEnvelope ? result.body : result
        const rows = definition.listKeys.map(listKey => payload?.[listKey]).find(Array.isArray)
        if (!rows) throw error('키움 차트 응답에 봉 목록이 없습니다.', 502)
        const previousCount = unique.size
        for (const row of rows) {
          const candle = candleFromKiwoom(row, intraday)
          if (!candle) { invalidRows++; continue }
          // Newest page wins if continuation pages overlap.
          if (!unique.has(candle.time)) unique.set(candle.time, candle)
        }
        const continuation = result?.contYn
        // The optional response header is Y only when another page exists.
        // A legacy bare payload did not expose headers, so its state is unknown.
        if (continuation === 'Y') hasMore = true
        else if (pageEnvelope && Object.hasOwn(result, 'contYn') && [null, '', 'N'].includes(continuation)) hasMore = false
        else hasMore = null
        if (unique.size >= limit) { countLimited = unique.size > limit; break }
        if (hasMore === false) break
        if (hasMore === null) { partialReason = 'continuation-unknown'; break }
        if (!rows.length) { partialReason = 'empty-continuation'; break }
        if (!result.nextKey || seenKeys.has(result.nextKey)) { partialReason = 'continuation-stalled'; break }
        if (unique.size === previousCount) { partialReason = 'no-progress'; break }
        if (page === maxPages - 1) { partialReason = 'page-limit'; break }
        seenKeys.add(result.nextKey)
        nextKey = result.nextKey
      }
      const items = [...unique.values()].sort((a, b) => intraday ? a.time - b.time : a.time.localeCompare(b.time)).slice(-limit)
      if (invalidRows && !partialReason) partialReason = 'invalid-rows'
      const value = {
        items,
        meta: {
          source: 'kiwoom', timeZone: 'Asia/Seoul', rangeMode: 'recent',
          requestedLimit: limit, returnedCount: items.length, requestedInterval: interval,
          market, sessionCoverage: 'provider-defined-unverified', timestampMeaning: intraday ? 'start' : 'date',
          partial: Boolean(partialReason), partialReason, pagesFetched, hasMore, fullDay: false,
          firstTime: items[0]?.time || null, lastTime: items.at(-1)?.time || null,
          invalidRows, countLimited, adjusted,
          exhausted: hasMore === false,
        },
      }
      for (const [oldKey, entry] of cache) if (entry.expires <= now()) cache.delete(oldKey)
      if (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value)
      cache.set(key, { value, expires: now() + ttl })
      return value
    })()
    if (!signal) pending.set(key, promise)
    try { return copyResponse(await promise) } finally { if (pending.get(key) === promise) pending.delete(key) }
  }

  return { getCandleResponse, getCandles: async (...args) => (await getCandleResponse(...args)).items }
}

const charts = createKiwoomChartService()
export const getCandleResponse = charts.getCandleResponse
export const getCandles = charts.getCandles
