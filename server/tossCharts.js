import { createHash } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { requestTossWithCredentials } from './tossClient.js'
import { dateOnly, koreanDate, utcSeconds } from '../src/utils/chartTime.js'

const allowedIntervals = new Set(['1분', '5분', '10분', '15분', '30분', '60분', '일', '주', '월'])
const minuteFactors = { '1분': 1, '5분': 5, '10분': 10, '15분': 15, '30분': 30, '60분': 60 }
const SEOUL_OFFSET_SECONDS = 9 * 60 * 60

// Official /api/v1/candles supports 1m and 1d only. A 1m timestamp is
// the END of [timestamp - 1 minute, timestamp), not its opening time.
// https://openapi.tossinvest.com/openapi-docs/latest/openapi.json (Candle)
function candleFromToss(row, minute) {
  if (!row || typeof row !== 'object') return null
  const sourceTime = utcSeconds(row.timestamp)
  const time = minute ? sourceTime : dateOnly(row.timestamp) || (sourceTime == null ? null : koreanDate(sourceTime))
  const prices = ['openPrice', 'highPrice', 'lowPrice', 'closePrice'].map(key => Number(row[key]))
  if (time == null || time === '' || !prices.every(value => Number.isFinite(value) && value > 0)) return null
  const volume = row.volume == null || String(row.volume).trim() === '' ? null : Number(row.volume)
  // These fields are not guaranteed by the current Candle schema. If supplied,
  // explicit provider session/exchange changes still prevent cross-session sums.
  const session = ['session', 'sessionType', 'marketSession', 'tradingSession', 'exchange', 'exchangeCode']
    .map(key => row[key] == null ? '' : String(row[key])).join('\0')
  return {
    time,
    open: prices[0], high: prices[1], low: prices[2], close: prices[3],
    volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
    session,
  }
}

function calendarBucket(date, interval) {
  if (interval === '월') return date.slice(0, 7)
  const monday = new Date(`${date}T00:00:00Z`)
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() || 7) - 1))
  return monday.toISOString().slice(0, 10)
}

function aggregateCandles(items, interval) {
  if (interval === '1분' || interval === '일') return items
  const factor = minuteFactors[interval]
  const groups = []
  let previous = null
  let previousKey = ''
  for (const item of items) {
    // Group conceptual minute starts in KST, while displaying observed source
    // endpoints. Gaps and explicit session changes begin a new aggregate even
    // when they fall within the same clock bucket. Missing minutes are not filled.
    const start = factor ? item.time - 60 : null
    const key = factor
      ? `${koreanDate(start)}:${Math.floor((start + SEOUL_OFFSET_SECONDS) / (factor * 60))}`
      : calendarBucket(item.time, interval)
    const split = factor && previous && (item.time - previous.time !== 60 || item.session !== previous.session)
    const existing = groups.at(-1)
    if (!existing || key !== previousKey || split) {
      groups.push({ ...item })
    } else {
      existing.high = Math.max(existing.high, item.high)
      existing.low = Math.min(existing.low, item.low)
      existing.close = item.close
      existing.volume = existing.volume === null || item.volume === null ? null : existing.volume + item.volume
      if (factor) existing.time = item.time
    }
    previous = item
    previousKey = key
  }
  return groups
}

function publicCandle({ session, ...item }) { return item }

export function createTossChartService({
  request = requestTossWithCredentials,
  now = Date.now,
  maxPages = 15,
  maxRawCandles = 3000,
  cacheTtlMs = 30_000,
  timeoutMs = 20_000,
  requestSpacingMs = 50,
  delay = wait,
} = {}) {
  const cache = new Map()
  const inFlight = new Map()
  const rateStates = new Map()
  const pageLimit = Math.min(15, Math.max(1, Math.trunc(maxPages) || 15))
  const rawLimit = Math.min(3000, Math.max(1, Math.trunc(maxRawCandles) || 3000))
  const deadlineMs = Math.min(20_000, Math.max(1, Math.trunc(timeoutMs) || 20_000))

  function rateState(fingerprint) {
    if (!rateStates.has(fingerprint)) {
      if (rateStates.size >= 300) {
        for (const [key, state] of rateStates) {
          if (!state.pending && state.nextAt <= now()) { rateStates.delete(key); break }
        }
      }
      rateStates.set(fingerprint, { nextAt: 0, tail: Promise.resolve(), pending: 0 })
    }
    return rateStates.get(fingerprint)
  }

  async function pace(fingerprint, signal) {
    signal.throwIfAborted()
    // The documented MARKET_DATA_CHART quota is 20 starts/second per client.
    // This chart-only queue spans cache scopes sharing the same credentials.
    // Runtime limits can change; Retry-After takes precedence after a 429.
    // https://developers.tossinvest.com/docs#rate-limits
    const state = rateState(fingerprint)
    const previous = state.tail
    let release
    state.tail = new Promise(resolve => { release = resolve })
    state.pending += 1
    try {
      await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        previous.then(() => { signal.removeEventListener('abort', abort); resolve() })
      })
      signal.throwIfAborted()
      // Recheck after each wait: another in-flight call may have received 429.
      while (state.nextAt > now()) await delay(state.nextAt - now(), undefined, { signal })
      signal.throwIfAborted()
      state.nextAt = now() + Math.max(0, requestSpacingMs)
    } finally {
      state.pending -= 1
      release()
    }
  }

  async function fetchCandles(symbol, interval, limit, credentials, fingerprint, signal, callerSignal) {
    const minute = Boolean(minuteFactors[interval])
    const resampled = interval !== '1분' && interval !== '일'
    const rawInterval = minute ? '1m' : '1d'
    const collected = new Map()
    const cursors = new Set()
    let before = ''
    let hasMore = false
    let exhausted = false
    let stopReason = ''
    let pagesFetched = 0
    let invalidRowCount = 0
    let retryAfterSeconds = null

    for (let page = 0; page < pageLimit && collected.size < rawLimit; page += 1) {
      const count = Math.min(200, rawLimit - collected.size, resampled ? 200 : limit - collected.size + (before ? 1 : 0))
      let payload
      try {
        await pace(fingerprint, signal)
        payload = await request({
          apiKey: credentials.apiKey, secretKey: credentials.secretKey,
          path: '/api/v1/candles',
          query: { symbol, interval: rawInterval, count, before, adjusted: true },
          signal,
        })
        signal.throwIfAborted()
        if (!Array.isArray(payload?.result?.candles)) throw new Error('토스 차트 응답 형식을 확인할 수 없습니다.')
      } catch (error) {
        if (callerSignal?.aborted && callerSignal.reason?.name !== 'TimeoutError') throw callerSignal.reason
        if (error?.name === 'AbortError' && !signal.aborted) throw error
        if (Number(error?.statusCode) === 429) {
          const seconds = Number(error.retryAfter)
          if (Number.isFinite(seconds) && seconds > 0) {
            retryAfterSeconds = seconds
            const state = rateState(fingerprint)
            state.nextAt = Math.max(state.nextAt, now() + seconds * 1000)
          }
        }
        if (!collected.size) throw error
        stopReason = signal.aborted ? 'timeout' : Number(error?.statusCode) === 429 ? 'rate-limit' : 'provider-error'
        hasMore = true
        break
      }
      pagesFetched += 1
      const result = payload.result
      const previousSize = collected.size
      for (const row of result.candles) {
        const item = candleFromToss(row, minute)
        if (!item) { invalidRowCount += 1; continue }
        // before is inclusive. Equivalent timestamps with different offsets are
        // also one candle, so deduplicate by the normalized chart time.
        if (collected.has(item.time)) continue
        if (collected.size >= rawLimit) break
        collected.set(item.time, item)
      }
      hasMore = Boolean(result.nextBefore)
      exhausted = !hasMore
      const sorted = [...collected.values()].sort((a, b) => minute ? a.time - b.time : a.time.localeCompare(b.time))
      // An extra older aggregate proves the left boundary of the requested
      // bars; otherwise a capped page could silently truncate the oldest OHLCV.
      const enough = aggregateCandles(sorted, interval).length >= limit + (resampled && !exhausted ? 1 : 0)
      if (enough) { stopReason = 'limit'; break }
      if (exhausted) { stopReason = 'exhausted'; break }
      const next = String(result.nextBefore)
      if (!result.candles.length || collected.size === previousSize || cursors.has(next)) {
        stopReason = 'cursor-stalled'
        break
      }
      cursors.add(next)
      before = next // The official cursor is passed verbatim, including offset.
    }

    if (!stopReason) stopReason = 'page-limit'
    const sorted = [...collected.values()].sort((a, b) => minute ? a.time - b.time : a.time.localeCompare(b.time))
    let aggregated = aggregateCandles(sorted, interval)
    const omittedPartialBucket = resampled && !exhausted && aggregated.length <= limit && aggregated.length > 0
    if (omittedPartialBucket) aggregated = aggregated.slice(1)
    const items = aggregated.slice(-limit).map(publicCandle)
    const partial = items.length < limit || invalidRowCount > 0 || !['limit', 'exhausted'].includes(stopReason)
    const partialReason = !partial ? null
      : !['limit', 'exhausted'].includes(stopReason) ? stopReason
        : invalidRowCount ? 'invalid-data' : 'insufficient-history'
    return {
      items,
      meta: {
        timeZone: 'Asia/Seoul', rangeMode: 'recent', requestedLimit: limit,
        returnedCount: items.length, requestedInterval: interval, sourceInterval: rawInterval,
        aggregation: resampled ? 'resampled' : 'direct',
        market: 'PROVIDER', sessionCoverage: 'provider-defined-unverified',
        timestampMeaning: minute ? 'end' : 'date', fullDay: false,
        partial, partialReason, pagesFetched, hasMore,
        sourceCandleCount: collected.size, invalidRowCount, omittedPartialBucket,
        ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
      },
    }
  }

  async function getTossCandleResponse(symbol, interval, limit = 200, credentials = {}, options = {}) {
    if (!/^[0-9][0-9A-Z]{5}$/.test(symbol)) throw new Error('올바른 6자리 종목코드가 필요합니다.')
    if (!allowedIntervals.has(interval)) throw new Error('지원하지 않는 차트 주기입니다.')
    const requestedLimit = Math.min(500, Math.max(1, Math.trunc(Number(limit)) || 200))
    const callerSignal = options.signal || credentials.signal
    callerSignal?.throwIfAborted()
    const fingerprint = createHash('sha256').update(`${credentials.apiKey || ''}\0${credentials.secretKey || ''}`).digest('hex')
    const key = `${credentials.cacheScope || 'operator'}:${fingerprint}:${symbol}:${interval}:${requestedLimit}`
    const cached = cache.get(key)
    if (cached && now() - cached.at < cacheTtlMs) return cached.response
    if (!callerSignal && inFlight.has(key)) return inFlight.get(key)
    const deadline = AbortSignal.timeout(deadlineMs)
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline
    const promise = fetchCandles(symbol, interval, requestedLimit, credentials, fingerprint, signal, callerSignal).then(response => {
      if (cache.size >= 300) cache.delete(cache.keys().next().value)
      cache.set(key, { at: now(), response })
      return response
    })
    // Independent AbortSignals must not cancel another caller's request.
    if (!callerSignal) inFlight.set(key, promise)
    try { return await promise } finally { if (!callerSignal) inFlight.delete(key) }
  }

  async function getTossCandles(...args) {
    return (await getTossCandleResponse(...args)).items
  }
  return { getTossCandleResponse, getTossCandles }
}

const service = createTossChartService()
export const getTossCandleResponse = service.getTossCandleResponse
export const getTossCandles = service.getTossCandles
