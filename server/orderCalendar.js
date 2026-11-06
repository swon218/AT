import { httpError } from './brokerHttp.js'

export const koreanDay = (now = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))

// Same reviewed XKRX calendar as the screener. No model, paid API or operator key.
export function createOrderCalendar({ base = process.env.AI_INTERNAL_URL || 'http://127.0.0.1:8010', secret = process.env.AI_INTERNAL_SECRET || '', fetcher = fetch } = {}) {
  const origin = new URL(base)
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw httpError('주문내역 달력 연결 설정을 확인해 주세요.', 503)
  return async date => {
    if (secret.length < 32) throw httpError('주문내역 거래일 달력을 사용할 수 없습니다.', 503)
    let result
    try {
      const url = new URL('/calendar/order-days', origin)
      url.searchParams.set('date', date)
      const response = await fetcher(url, { redirect: 'error', headers: { 'X-Atlas-Internal': secret }, signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error()
      result = await response.json()
    } catch { throw httpError('주문내역 거래일 달력을 확인하지 못했습니다.', 503) }
    if (!Array.isArray(result.days) || result.days.length !== 5 || new Set(result.days).size !== 5 || result.days.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day) || day > date) || result.days.some((day, i) => i && day >= result.days[i - 1]) || result.timezone !== 'Asia/Seoul') throw httpError('주문내역 거래일 달력 응답을 확인해 주세요.', 503)
    return result
  }
}
