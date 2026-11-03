import { config } from './config.js'
import { requestToss } from './tossClient.js'

const dayMs = 86_400_000
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
export const koreanDate = timestamp => dateFormat.format(timestamp)
const markets = ['KRX', 'NXT']
const sessions = [['preMarket', '프리마켓'], ['regularMarket', '정규장'], ['afterMarket', '애프터마켓']]

function parseSessionTime(value, date) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`)
  const time = Date.parse(value)
  if (!Number.isFinite(day) || !new Date(day).toISOString().startsWith(value.slice(0, 10))) return NaN
  return Number.isFinite(time) && koreanDate(time) === date ? time : NaN
}

function readDay(day, date) {
  if (day?.date !== date) return null
  if (day.integrated === null) return []
  const result = []
  for (const [phase, label] of sessions) {
    const session = day.integrated?.[phase]
    if (session === null) continue
    const start = parseSessionTime(session?.startTime, date)
    const end = parseSessionTime(session?.endTime, date)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || start < (result.at(-1)?.end ?? -Infinity)) return null
    result.push({ phase, label, start, end })
  }
  // The calendar represents a fully closed date as integrated: null.
  return result.length ? result : null
}

export function readCalendar(payload, date) {
  const result = payload?.result
  const today = readDay(result?.today, date)
  if (!today) return null
  const next = result.nextBusinessDay
  const nextDate = next?.date
  const nextDay = typeof nextDate === 'string' && nextDate > date ? readDay(next, nextDate) : null
  return { date, today, nextSession: nextDay?.[0] ?? null }
}

function sessionData(session) {
  return session && {
    phase: session.phase, label: session.label,
    startAt: new Date(session.start).toISOString(), endAt: new Date(session.end).toISOString(),
  }
}

export function calculateMarketStatus(calendar, now) {
  const date = koreanDate(now)
  const midnight = Date.parse(`${date}T00:00:00+09:00`) + dayMs
  const base = { date, markets, source: '토스증권', serverNow: new Date(now).toISOString() }
  if (calendar?.date !== date) {
    return { ...base, phase: null, label: '장 상태 확인 불가', currentSession: null, nextSession: null, transitionAt: new Date(midnight).toISOString() }
  }
  const current = calendar.today.find(session => session.start <= now && now < session.end) ?? null
  const upcoming = calendar.today.find(session => session.start > now) ?? null
  const transition = Math.min(current?.end ?? upcoming?.start ?? midnight, midnight)
  const phase = current?.phase ?? (upcoming ? 'waiting' : calendar.today.length ? 'closed' : 'holiday')
  const label = current?.label ?? (upcoming ? '개장 대기' : calendar.today.length ? '장 종료' : '휴장')
  return { ...base, phase, label, currentSession: sessionData(current),
    nextSession: sessionData(upcoming ?? calendar.nextSession), transitionAt: new Date(transition).toISOString() }
}

function retryDelay(value, now) {
  if (!value) return 0
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) ? Math.max(0, delay) : 0
}

export function createMarketCalendar({
  request = requestToss, now = Date.now, ttl = 300_000, logger,
  configured = () => Boolean(config.tossApiKey && config.tossSecretKey),
} = {}) {
  let cached, pending, failures = 0, retryAt = 0

  async function refresh(date) {
    try {
      const payload = await request({
        path: '/api/v1/market-calendar/KR', query: { date }, retry: false,
        signal: AbortSignal.timeout(12_000),
      })
      const calendar = readCalendar(payload, date)
      if (!calendar) throw Object.assign(new Error('Invalid calendar'), { invalidCalendar: true })
      cached = { calendar, fetchedAt: now() }
      failures = 0
      retryAt = 0
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : null
      const stage = error.tossStage === 'token' ? 'token' : 'calendar'
      const reason = error.invalidCalendar ? 'invalid-calendar' : status ? 'upstream-http' : 'transport'
      logger?.warn({ status, stage, reason }, 'Toss market calendar refresh failed')
      failures++
      const at = now()
      const backoff = status === 401 || status === 403 ? 300_000 : Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4))
      retryAt = at + Math.max(backoff, status === 429 ? retryDelay(error.retryAfter, at) : 0)
    }
  }

  return async function getMarketStatus() {
    const startedAt = now()
    const date = koreanDate(startedAt)
    if (configured() && startedAt >= retryAt &&
        (cached?.calendar.date !== date || startedAt - cached.fetchedAt >= ttl)) {
      // Keep one upstream request in flight even if it spans KST midnight.
      pending ??= { date, job: refresh(date).finally(() => { pending = undefined }) }
      const { date: requestedDate, job } = pending
      await job
      if (!failures && koreanDate(now()) !== requestedDate) return getMarketStatus()
    }
    const at = now()
    const current = cached?.calendar.date === koreanDate(at) ? cached : null
    return { ...calculateMarketStatus(current?.calendar, at),
      fetchedAt: current ? new Date(current.fetchedAt).toISOString() : null,
      stale: Boolean(current && (failures || at - current.fetchedAt >= ttl)) }
  }
}

export function registerMarketCalendarRoutes(app, getStatus = createMarketCalendar({ logger: app.log })) {
  app.get('/api/public/market/session', async (_request, reply) => {
    const status = await getStatus()
    return reply.header('Cache-Control', 'no-store').code(status.phase ? 200 : 503).send(status)
  })
}
