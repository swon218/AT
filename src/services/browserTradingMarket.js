import { dateOnly, koreanDate, utcSeconds } from '../utils/chartTime.js'
import { validateIndicators } from '../utils/indicatorValidation.js'

const brokers = new Set(['kiwoom', 'toss', 'nh', 'kb'])
const periods = new Set(['1분', '5분', '10분', '15분', '30분', '60분', '일', '주', '월'])
const names = { kiwoom: '키움', toss: '토스', nh: 'NH', kb: 'KB' }
const apiBase = import.meta.env?.VITE_API_BASE_URL ?? ''
const copy = value => structuredClone(value)
const problem = (code, message) => Object.assign(new Error(message), { code })
const abortError = () => new DOMException('Aborted', 'AbortError')
const instantText = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && utcSeconds(value) !== null ? Date.parse(value) : NaN

// Only these already-public read endpoints are reachable through this client.
// No account, trading, order, cancel or worker endpoint is accepted.
const publicReads = new Set(['/api/public/market/session', '/api/screener'])
export async function browserTradingReadJson(path, { fetcher = fetch, signal } = {}) {
  if (!publicReads.has(path)) throw problem('browser_market_path_forbidden', '허용되지 않은 조회 경로입니다.')
  const response = await fetcher(path === '/api/screener' ? path : `${apiBase}${path}`, {
    method: 'GET', signal, credentials: 'same-origin', headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw problem('browser_market_read_failed', path === '/api/screener' ? '확정 일봉 기준일을 확인할 수 없습니다.' : '장 상태를 확인할 수 없습니다.')
  try { return await response.json() } catch { throw problem('browser_market_read_failed', '조회 응답을 해석하지 못했습니다.') }
}

export function browserTradingWarmup(indicators = [], { crossing = false, maxBars = 500 } = {}) {
  validateIndicators(indicators)
  const needed = Math.max(1, ...indicators.map(row => {
    if (row.id === 'ma') return Number(row.longPeriod)
    if (row.id === 'rsi' || row.id === 'mfi') return Number(row.period) + 1
    if (row.id === 'macd') return Number(row.slow) + Number(row.signal) - 1
    if (row.id === 'dmi') return Number(row.period) + Number(row.adxPeriod)
    if (row.id === 'stochastic') return Number(row.period) + Number(row.kPeriod) + Number(row.dPeriod) - 2
    if (row.id === 'obv') return row.showAverage ? Number(row.maPeriod) : 2
    return Number(row.period || 1)
  })) + Number(crossing)
  if (needed > maxBars) throw problem('browser_market_warmup_limit', `선택한 지표에 필요한 준비 봉이 조회 한도 ${maxBars}개를 초과합니다. 지표 기간을 줄여 주세요.`)
  return needed
}

export function normalizeBrowserTradingCandles(rows, { period = '15분', timestampMeaning = 'start', now = Date.now() } = {}) {
  if (!Array.isArray(rows) || rows.length > 2000) throw problem('browser_market_invalid_data', '차트 데이터 형식을 확인할 수 없습니다.')
  const intraday = period.endsWith('분'), unique = new Map()
  const latestAllowed = now / 1000 + (timestampMeaning === 'end' && intraday ? Number.parseInt(period, 10) * 60 : 5)
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.quality === 'quarantined') throw problem('browser_market_invalid_data', '가격 오류가 있는 봉은 계산에 사용할 수 없습니다.')
    const time = intraday ? utcSeconds(row.time ?? row.timestamp ?? row.date) : dateOnly(row.time ?? row.date)
    const values = ['open', 'high', 'low', 'close', 'volume'].map(key => row[key] === null || row[key] === undefined || row[key] === '' ? NaN : Number(row[key]))
    const [open, high, low, close, volume] = values
    if (time === null || intraday && time > latestAllowed || !intraday && time > koreanDate(now / 1000)
      || values.some(value => !Number.isFinite(value)) || Math.min(open, high, low, close) <= 0 || volume < 0
      || low > Math.min(open, close) || high < Math.max(open, close) || high < low) {
      throw problem('browser_market_invalid_data', '차트의 시각·가격·거래량을 확인할 수 없습니다.')
    }
    // The last response for a bucket is authoritative; never sum a cumulative
    // bucket's volume across refreshes or synthesize a missing bucket.
    unique.set(time, { time, open, high, low, close, volume, ...(row.tradable === 0 ? { tradable: 0 } : {}), ...(row.quality === 'corrected' ? { quality: 'corrected' } : {}) })
  }
  return [...unique.values()].sort((a, b) => intraday ? a.time - b.time : a.time.localeCompare(b.time))
}

export function mergeBrowserTradingCandles(previous = [], incoming = [], limit = 500) {
  if (!incoming.length) return []
  if (previous.length && incoming.at(-1).time < previous.at(-1).time) throw problem('browser_market_time_reversed', '이전 시점의 차트 응답이 도착했습니다. 다시 조회해 주세요.')
  const rows = new Map(previous.map(row => [row.time, row]))
  for (const row of incoming) rows.set(row.time, row)
  return [...rows.values()].sort((a, b) => typeof a.time === 'number' ? a.time - b.time : a.time.localeCompare(b.time)).slice(-limit)
}

function waitFor(job, signal) {
  signal?.throwIfAborted()
  if (!signal) return job
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError())
    signal.addEventListener('abort', abort, { once: true })
    job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function createBrowserTradingMarket({ readCandles, readDaily, readSession, readScreenMeta, fetcher = fetch, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map(), waiters = []
  let active = 0
  const limited = async work => {
    if (active >= 2) await new Promise(resolve => waiters.push(resolve))
    else active++
    try { return await work() } finally {
      const next = waiters.shift()
      if (next) next() // Transfer the reserved slot; a new caller cannot jump it.
      else active--
    }
  }
  const defaultCandles = async (...args) => (await import('./kiwoomMarketApi.js')).getBrokerCandleResponse(...args)
  const candles = readCandles || defaultCandles
  const dailyRead = readDaily || (async (...args) => (await import('./labApi.js')).getLabCandles(...args))
  const session = readSession || (signal => browserTradingReadJson('/api/public/market/session', { fetcher, signal }))
  const screen = readScreenMeta || (signal => browserTradingReadJson('/api/screener', { fetcher, signal }))
  async function cached(key, ttl, work, signal) {
    const prior = cache.get(key)
    if (prior && now() - prior.at < ttl) { signal?.throwIfAborted(); return copy(prior.value) }
    if (!pending.has(key)) {
      const promise = limited(() => work(AbortSignal.timeout(25000), prior?.value)).then(value => {
        if (cache.size >= 64) cache.delete(cache.keys().next().value)
        cache.set(key, { at: now(), value }); return value
      }).finally(() => pending.delete(key))
      pending.set(key, promise)
    }
    return copy(await waitFor(pending.get(key), signal))
  }
  function identity({ broker, symbol, scope = '' }) {
    if (!brokers.has(broker) || !/^[0-9][0-9A-Z]{5}$/.test(symbol) || typeof scope !== 'string' || !scope || scope.length > 300) throw problem('browser_market_invalid_query', '조회 증권사와 종목·사용자 범위를 확인해 주세요.')
    return [scope, broker, symbol]
  }
  async function chart({ broker, symbol, period = '15분', indicators = [], scope = '', signal, minimumBars, requireWarmup = true } = {}) {
    const id = identity({ broker, symbol, scope })
    if (!periods.has(period)) throw problem('browser_market_invalid_query', '지원하는 차트 주기를 선택해 주세요.')
    const required = minimumBars ?? browserTradingWarmup(indicators)
    if (!Number.isInteger(required) || required < 1 || required > 500) throw problem('browser_market_warmup_limit', '차트 API에서 제공할 수 있는 준비 봉 범위를 확인해 주세요.')
    const limit = Math.min(500, Math.max(200, required + 80))
    return cached(JSON.stringify([...id, period, limit, required, requireWarmup]), period === '일' ? 60000 : 15000, async (requestSignal, prior) => {
      const payload = await candles(broker, symbol, period, limit, { signal: requestSignal })
      const meta = payload?.meta || payload?.metadata || {}
      const sourceBroker = payload?.sourceBroker || meta.sourceBroker || meta.source
      if (!brokers.has(sourceBroker) || sourceBroker !== broker && !(broker === 'kb' && sourceBroker === 'kiwoom' && payload?.fallback === true)) {
        throw problem('browser_market_source_unknown', '요청한 증권사의 차트 출처를 확인할 수 없습니다.')
      }
      if (Number(meta.invalidRows || meta.invalidRowCount || 0) > 0) throw problem('browser_market_invalid_data', '오류 봉이 포함되어 차트 데이터를 사용할 수 없습니다.')
      const rows = normalizeBrowserTradingCandles(payload?.items ?? payload?.candles, { period, timestampMeaning: meta.timestampMeaning, now: now() })
      const merged = mergeBrowserTradingCandles(prior?.candles, rows, limit)
      if (merged.length && requireWarmup && merged.length < required) throw problem('browser_market_warmup_missing', `지표 준비 봉이 부족합니다. ${required}개 이상 필요합니다.`)
      return { candles: merged, metadata: { ...meta, requestedBroker: broker, sourceBroker, fallback: sourceBroker !== broker,
        sourceLabel: `${names[sourceBroker]}${sourceBroker !== broker ? ' · 대체 시세' : ''}`, requestedInterval: period, requiredBars: required,
        receivedAt: new Date(now()).toISOString() }, receivedAt: new Date(now()).toISOString() }
    }, signal)
  }
  async function marketContext(signal) {
    let status
    try { status = await cached('public-market-session', 15000, requestSignal => session(requestSignal), signal) }
    catch (error) { if (signal?.aborted) throw error; return { marketOpen: false, marketUnavailable: true, marketReason: '장 상태를 확인할 수 없습니다.', marketDate: koreanDate(now() / 1000) } }
    const at = instantText(status?.serverNow), date = status?.date, current = status?.currentSession
    const valid = dateOnly(date) && date === koreanDate(now() / 1000) && date === koreanDate(at / 1000) && Number.isFinite(at) && Math.abs(at - now()) <= 120000
      && status.stale === false && status.source === '토스증권' && Array.isArray(status.markets) && status.markets.includes('KRX')
    if (!valid || !['regularMarket','preMarket','afterMarket','waiting','closed','holiday'].includes(status.phase)) return { marketOpen: false, marketUnavailable: true, marketReason: '검증된 장 상태를 확인할 수 없습니다.', marketDate: date, marketAt: status?.serverNow }
    if (status.phase !== 'regularMarket') return { marketOpen: false, marketUnavailable: false, marketReason: status.label || '정규장 시작을 기다립니다.', marketDate: date, marketAt: status.serverNow, marketPhase: status.phase }
    const open = instantText(current?.startAt), close = instantText(current?.endAt)
    if (current?.phase !== 'regularMarket' || !Number.isFinite(open) || !Number.isFinite(close) || open > at || at >= close || koreanDate(open / 1000) !== date || koreanDate(close / 1000) !== date) {
      return { marketOpen: false, marketUnavailable: true, marketReason: '정규장 거래시간을 확인할 수 없습니다.', marketDate: date, marketAt: status.serverNow }
    }
    return { marketOpen: true, marketUnavailable: false, marketDate: date, marketAt: status.serverNow, marketPhase: status.phase, marketWindow: { open: current.startAt, close: current.endAt } }
  }
  async function evaluate({ broker, symbol, strategy, scope = '', signal } = {}) {
    identity({ broker, symbol, scope })
    const context = await marketContext(signal)
    if (!context.marketOpen) return context
    const crossing = (strategy?.backtest_settings?.entryConditions || []).some(row => row.enabled && ['crossUp', 'crossDown'].includes(row.operator))
    const required = browserTradingWarmup(strategy?.indicators || [], { crossing, maxBars: 2000 })
    const meta = await cached('public-screen-meta', 60000, requestSignal => screen(requestSignal), signal)
    const previousDay = dateOnly(meta?.cutoff)
    if (meta?.available !== true || !previousDay || previousDay >= context.marketDate) throw problem('browser_market_daily_unconfirmed', '확정 일봉 기준일을 확인할 수 없습니다.')
    // Match the existing LIVE signal source: one selected symbol's published
    // daily DB. Chart period/provider never silently becomes the signal period.
    const daily = await cached(JSON.stringify(['published-daily', scope, symbol]), 60000, async requestSignal => {
      const payload = await dailyRead(symbol, requestSignal)
      const quality = payload?.quality
      if (payload?.ready !== true || payload?.symbol?.code !== symbol || typeof quality?.policy !== 'string' || !quality.policy
        || !Number.isSafeInteger(quality.quarantined) || quality.quarantined !== 0 || !Array.isArray(quality.issues)
        || !Array.isArray(payload.items) || payload.items.some((row, index) => index > 0 && payload.items[index - 1].time >= row.time)) {
        throw problem('browser_market_daily_unconfirmed', '공개된 일봉의 품질·종목 범위를 확인할 수 없습니다.')
      }
      const rows = normalizeBrowserTradingCandles(payload.items, { period: '일', now: now() })
      return { candles: rows, source: `실험실 확정 일봉 DB / ${payload.symbol.source || '공개 일봉'}` }
    }, signal)
    const confirmed = daily.candles.filter(row => row.time <= previousDay)
    if (confirmed.at(-1)?.time !== previousDay || confirmed.length < required) throw problem('browser_market_daily_unconfirmed', '확정 일봉 또는 지표 준비 데이터를 확인할 수 없습니다.')
    const ticks = await chart({ broker, symbol, period: '1분', indicators: [], minimumBars: 1, scope, signal, requireWarmup: false })
    const actual = Date.parse(context.marketAt), open = Date.parse(context.marketWindow.open), close = Date.parse(context.marketWindow.close)
    // An end-stamped provider may include the unfinished minute with a future
    // endpoint. Keep that bar for display, but evaluate the newest actual
    // observation that has already occurred without shifting its timestamp.
    const latest = ticks.candles.findLast(row => {
      const observed = row.time * 1000
      return koreanDate(row.time) === context.marketDate && observed >= open && observed < close && observed <= actual
    })
    const observed = latest ? latest.time * 1000 : NaN
    if (!latest || actual - observed > 90000) throw problem('browser_market_quote_stale', '최근 1분봉의 실제 시각을 확인할 수 없습니다. 다음 유효 시세를 기다립니다.')
    return { ...context, daily: confirmed, previousDay, price: latest.close, observedAt: new Date(observed).toISOString(),
      receivedAt: ticks.receivedAt, sourceBroker: ticks.metadata.sourceBroker, requestedBroker: broker, sourceLabel: ticks.metadata.sourceLabel,
      timestampMeaning: ticks.metadata.timestampMeaning || 'unverified', maxObservationAgeMs: 90000,
      dailySource: daily.source, calendarThrough: previousDay }
  }
  return { chart, evaluate, marketContext }
}
