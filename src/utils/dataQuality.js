export const isQuarantined = candle => candle.quality === 'quarantined'

// Retain each missing date and restart chart indicators after a quarantined bar.
// Whitespace also covers the new segment's warmup, so lines cannot bridge gaps.
export function gapSafeSeries(candles, calculate, line = true) {
  const result = []
  let segment = []
  const flush = () => {
    if (!segment.length) return
    const values = new Map(calculate(segment).map(point => [point.time, point]))
    result.push(...segment.map(c => values.get(c.time) || { time: c.time }))
    segment = []
  }
  for (const candle of candles) {
    if (isQuarantined(candle)) { flush(); result.push({ time: candle.time }) }
    else segment.push(candle)
  }
  flush()
  // Lightweight Charts connects valid line points across whitespace. Hide the
  // outgoing stroke before each gap as well as retaining whitespace dates.
  if (line) for (let i = 0; i < result.length - 1; i++) {
    if (Number.isFinite(result[i].value) && !Number.isFinite(result[i + 1].value)) result[i] = { ...result[i], color: 'transparent' }
  }
  return result
}

export function validDailyDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
const nextDay = value => new Date(Date.parse(`${value}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
const weekend = value => [0, 6].includes(new Date(`${value}T00:00:00Z`).getUTCDay())

export function backtestWindow(candles, indicators, settings) {
  if (!Array.isArray(candles) || candles.length < 2 || candles.length > 2000) throw new Error('백테스트에 필요한 일봉이 부족합니다.')
  candles.forEach((c, i) => {
    if (!validDailyDate(c.time) || (i && candles[i - 1].time >= c.time)) throw new Error('일봉 데이터의 날짜가 올바르지 않습니다.')
  })
  const start = settings.start || candles[0].time, end = settings.end || candles.at(-1).time
  if (!validDailyDate(start) || !validDailyDate(end) || start > end || start < candles[0].time) throw new Error('수집된 기간 안에서 시작일과 종료일을 선택하세요.')
  const fiveYears = new Date(`${end}T00:00:00Z`); fiveYears.setUTCFullYear(fiveYears.getUTCFullYear() - 5)
  if (start < fiveYears.toISOString().slice(0, 10)) throw new Error('백테스트 조회 기간은 최대 5년입니다.')
  const calendar = Array.isArray(settings.tradingDays) && validDailyDate(settings.calendarThrough) && settings.calendarThrough >= end ? new Set(settings.tradingDays) : null
  if (calendar && [...calendar].some(d => !validDailyDate(d))) throw new Error('검증 거래일 달력의 날짜가 올바르지 않습니다.')
  const storedEnd = candles.at(-1).time
  if (end > storedEnd) {
    const tail = []; for (let date = nextDay(storedEnd); date <= end && tail.length < 32; date = nextDay(date)) tail.push(date)
    const verifiedClosed = calendar && tail.length < 32 && tail.every(d => !calendar.has(d))
    const boundedWeekend = tail.length <= 2 && tail.every(weekend)
    if (!verifiedClosed && !boundedWeekend) throw new Error('종료일까지 수집된 일봉이 없습니다. 최신 데이터 또는 확인된 거래일 달력이 필요합니다.')
  }
  const first = candles.findIndex(c => c.time >= start), last = candles.findLastIndex(c => c.time <= end)
  if (first < 0 || last < first) throw new Error('선택한 기간에 유효한 일봉이 없습니다.')
  const enabled = (settings.entryConditions || []).filter(c => c.enabled)
  const neededIds = new Set(enabled.flatMap(c => [c.indicatorId, c.right?.indicatorId || c.indicatorId]))
  const used = Object.hasOwn(settings, 'entryConditions') ? indicators.filter(c => neededIds.has(c.id)) : indicators
  // Recursive/seeded indicators retain all supplied history. Reference-only
  // chart indicators do not create artificial warmup or missing-data failures.
  const recursive = used.some(c => ['rsi', 'macd', 'atr', 'dmi', 'obv', 'supertrend'].includes(c.id) || (c.id === 'ma' && c.type === 'EMA'))
  const cross = enabled.some(c => ['crossUp', 'crossDown'].includes(c.operator)) || [...(settings.entry || []), ...(settings.exit || [])].some(id => id.includes('cross'))
  const lookback = Math.max(0, ...used.map(c => {
    const period = c.id === 'ma' ? Number(c.longPeriod) : c.id === 'stochastic' ? Number(c.period) + Number(c.kPeriod) + Number(c.dPeriod) - 2 : Number(c.period || 1) + (c.id === 'mfi' ? 1 : 0)
    return period - 1 + Number(cross)
  }))
  const from = recursive ? 0 : Math.max(0, first - lookback)
  const bad = candles.slice(from, last + 1).find(isQuarantined)
  if (bad) throw new Error(`${bad.time}: ${bad.time >= start ? '선택한 검증 기간' : '지표 준비 구간'}에 미해결 가격 오류가 있어 백테스트를 실행할 수 없습니다.${recursive ? ' 재귀·누적 지표는 저장된 이전 이력 전체를 사용합니다.' : ''}`)
  const provided = new Set(candles.map(c => c.time))
  if (calendar) {
    const missing = [...calendar].sort().find(d => d >= candles[from].time && d <= end && !provided.has(d))
    if (missing) throw new Error(`${missing}: 거래일 일봉이 누락되어 백테스트를 실행할 수 없습니다. 휴장으로 간주하지 않습니다.`)
  }
  const observedEnd = candles[last].time === end
  const coverage = { endStatus: observedEnd ? 'observed' : calendar ? 'non-trading-confirmed' : 'unverified-gap', valuationDate: candles[last].time, calendarVerified: Boolean(calendar), warning: '' }
  if (!calendar) coverage.warning = observedEnd
    ? '제공된 일봉으로 계산했습니다. 거래일 달력과 데이터 누락 여부를 독립 대조하지 않았습니다.'
    : `종료일 ${end}의 일봉이 없어 마지막 제공 일봉 ${candles[last].time} 종가로 평가했습니다. 휴장일인지 데이터 누락인지 확인되지 않아 종료일 평가 완료로 간주하지 않습니다.`
  return { candles: candles.slice(from, last + 1), start, end, coverage }
}
