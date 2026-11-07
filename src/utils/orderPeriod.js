export const ORDER_TIME_ZONE = 'Asia/Seoul'
export const ORDER_WINDOW_DAYS = 7
// The daily broker endpoints need a separate request per date (two for Kiwoom).
// This is an ATLAS search limit, independent of the brokers' retention policies.
export const MAX_ORDER_PERIOD_DAYS = 31

const formatKoreanDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: ORDER_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
})
const DAY_MS = 86_400_000
export const koreanOrderDay = (now = Date.now()) => formatKoreanDay.format(new Date(now))
const dayTime = day => Date.parse(`${day}T00:00:00Z`)
export const shiftOrderDay = (day, delta) => new Date(dayTime(day) + delta * DAY_MS).toISOString().slice(0, 10)
export function validOrderDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day.startsWith('0000')) return false
  return Number.isFinite(dayTime(day)) && shiftOrderDay(day, 0) === day
}

export function recentOrderPeriod(now) {
  const end = koreanOrderDay(now)
  return { start: shiftOrderDay(end, 1 - ORDER_WINDOW_DAYS), end }
}

export function orderPeriodError({ start, end }, now) {
  if (!validOrderDay(start) || !validOrderDay(end)) return '시작일과 종료일을 올바르게 입력해 주세요.'
  if (start > end) return '시작일은 종료일보다 늦을 수 없습니다.'
  if (end > koreanOrderDay(now)) return '미래 날짜는 조회할 수 없습니다.'
  if ((dayTime(end) - dayTime(start)) / DAY_MS >= MAX_ORDER_PERIOD_DAYS) {
    return `한 번에 최대 ${MAX_ORDER_PERIOD_DAYS}일을 조회할 수 있습니다.`
  }
  return ''
}

export function orderPeriodWindow({ start, end }, before) {
  const last = before ? shiftOrderDay(before, -1) : end
  const days = [last]
  while (days.length < ORDER_WINDOW_DAYS && days.at(-1) > start) days.push(shiftOrderDay(days.at(-1), -1))
  return { start: days.at(-1), end: last, days, nextBefore: days.at(-1) > start ? days.at(-1) : null }
}
