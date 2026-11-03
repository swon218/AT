import { config } from './config.js'
import { requestToss } from './tossClient.js'

const CACHE_MS = 60_000
const source = { source: '토스증권', baseCurrency: 'USD', quoteCurrency: 'KRW' }

function parseTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN
  const date = value.slice(0, 10)
  const midnight = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(midnight.getTime()) || !midnight.toISOString().startsWith(date)) return NaN
  return Date.parse(value)
}

function readRate({ result } = {}, receivedAt) {
  const midRate = typeof result?.midRate === 'string' && /^\d+(\.\d+)?$/.test(result.midRate)
    ? Number(result.midRate) : NaN
  const from = parseTime(result?.validFrom)
  const until = parseTime(result?.validUntil)
  if (result?.baseCurrency !== 'USD' || result?.quoteCurrency !== 'KRW' ||
      !Number.isFinite(midRate) || midRate <= 0 ||
      !Number.isFinite(from) || !Number.isFinite(until) || from >= until ||
      receivedAt < from || receivedAt >= until) {
    throw Object.assign(new Error('Invalid exchange rate'), { invalidRate: true })
  }
  return { midRate, validFrom: result.validFrom, validUntil: result.validUntil, receivedAt: new Date(receivedAt).toISOString() }
}

function retryAfterMs(value, now) {
  if (!value) return 0
  if (/^\d+$/.test(value)) return Number(value) * 1000
  return Math.max(0, Date.parse(value) - now) || 0
}

export function createExchangeRateService({
  request = requestToss, now = Date.now, logger,
  configured = () => Boolean(config.tossApiKey && config.tossSecretKey),
} = {}) {
  let lastGood, pending, retryAt = 0, failures = 0

  async function refresh() {
    try {
      const payload = await request({
        path: '/api/v1/exchange-rate',
        query: { baseCurrency: 'USD', quoteCurrency: 'KRW' },
        signal: AbortSignal.timeout(12_000),
        retry: false,
      })
      lastGood = readRate(payload, now())
      failures = 0
      retryAt = 0
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : null
      const stage = error.tossStage === 'token' ? 'token' : 'exchange-rate'
      const reason = error.invalidRate ? 'invalid-rate' : status ? 'upstream-http' : 'transport'
      logger?.warn({ status, stage, reason }, 'Toss exchange rate refresh failed')
      failures++
      const backoff = Math.min(300_000, CACHE_MS * 2 ** Math.min(failures - 1, 3))
      const delay = status === 401 || status === 403 ? 300_000 : backoff
      const at = now()
      retryAt = at + Math.max(delay, status === 429 ? retryAfterMs(error.retryAfter, at) : 0)
    }
  }

  return async function getExchangeRate() {
    if (configured() && now() >= retryAt &&
        (!lastGood || now() - Date.parse(lastGood.receivedAt) >= CACHE_MS)) {
      pending ??= refresh().finally(() => { pending = undefined })
      await pending
    }
    if (!lastGood) return { ...source, midRate: null, validFrom: null, validUntil: null, receivedAt: null, stale: true, error: '환율 조회에 실패했습니다.' }
    return { ...source, ...lastGood, stale: failures > 0 || now() >= Date.parse(lastGood.validUntil) }
  }
}

export function registerExchangeRateRoutes(app, getRate = createExchangeRateService({ logger: app.log })) {
  app.get('/api/public/market/toss/exchange-rate', async (_request, reply) => {
    const data = await getRate()
    return reply.header('Cache-Control', 'no-store').code(data.midRate === null ? 503 : 200).send(data)
  })
}
