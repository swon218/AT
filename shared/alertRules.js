export const ALERT_KINDS = {
  price_touch: '현재가',
  rise_gte: '전일 대비 상승률',
  fall_lte: '전일 대비 하락률',
}

export const LEGACY_ALERT_KINDS = {
  price_gte: '현재가 이상',
  price_lte: '현재가 이하',
}

export const ALERT_FREQUENCIES = { once: '최초 1회', repeat: '만료일까지 반복' }
export const legacyAlertKind = kind => Object.hasOwn(LEGACY_ALERT_KINDS, kind)
export const alertFrequencyLabel = frequency => ALERT_FREQUENCIES[frequency] || ALERT_FREQUENCIES.once
export const alertSessionLabel = market => market === 'NXT' ? 'NXT 애프터마켓' : 'KRX 정규장'

export const ALERT_RULES_PER_SYMBOL = 10

export const alertCode = /^[0-9][0-9A-Z]{5}$/
export const alertUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const koreanAlertDay = (now = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
export const addAlertDays = (day, count) => new Date(Date.parse(day) + count * 86400000).toISOString().slice(0, 10)
export const priceRule = kind => kind === 'price_touch' || legacyAlertKind(kind)

export function alertThreshold(kind, input) {
  if (!(Object.hasOwn(ALERT_KINDS, kind) || legacyAlertKind(kind)) || !['string', 'number'].includes(typeof input)) return null
  const text = String(input).trim()
  if (!(priceRule(kind) ? /^\d{1,10}$/ : /^\d{1,3}(?:\.\d{1,2})?$/).test(text)) return null
  const value = Number(text)
  return priceRule(kind) ? (value >= 1 && value <= 1e9 ? value : null) : (value <= 100 ? value : null)
}

export function alertExpiry(value, today = koreanAlertDay()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < today || value > addAlertDays(today, 30)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function alertCondition(kind, threshold) {
  const value = Number(threshold).toLocaleString('ko-KR', { maximumFractionDigits: 2 })
  if (kind === 'fall_lte') return `전일 대비 ${value}% 이상 하락`
  if (kind === 'rise_gte') return `전일 대비 ${value}% 이상 상승`
  if (kind === 'price_touch') return `현재가 ${value}원 도달`
  return `현재가 ${value}원 ${kind === 'price_gte' ? '이상' : '이하'}`
}
