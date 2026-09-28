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

export function backtestWindow(candles, indicators, settings) {
  if (!Array.isArray(candles) || candles.length < 2 || candles.length > 2000) throw new Error('백테스트에 필요한 일봉이 부족합니다.')
  candles.forEach((c, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.time) || (i && candles[i - 1].time >= c.time)) throw new Error('일봉 데이터의 날짜가 올바르지 않습니다.')
  })
  const start = settings.start || candles[0].time, end = settings.end || candles.at(-1).time
  if (start > end || start < candles[0].time || end > candles.at(-1).time) throw new Error('수집된 기간 안에서 시작일과 종료일을 선택하세요.')
  const first = candles.findIndex(c => c.time >= start)
  const last = candles.findLastIndex(c => c.time <= end)
  if (last - first < 1) throw new Error('선택한 기간에 최소 두 개의 일봉이 필요합니다.')
  // EMA, Wilder RSI and MACD depend on their entire seed history. A fixed
  // lookback would silently change those indicators, so keep that history.
  const recursive = indicators.some(c => ['rsi', 'macd'].includes(c.id) || (c.id === 'ma' && c.type === 'EMA'))
  const cross = [...(settings.entry || []), ...(settings.exit || [])].some(id => id.startsWith('ma-cross'))
  const lookback = Math.max(0, ...indicators.map(c => c.id === 'ma' ? Number(c.longPeriod) - 1 + Number(cross) : Number(c.period || 1) - 1))
  const from = recursive ? 0 : Math.max(0, first - lookback)
  const bad = candles.slice(from, last + 1).find(isQuarantined)
  if (bad) throw new Error(`${bad.time}: ${bad.time >= start ? '선택한 검증 기간' : '지표 준비 구간'}에 미해결 가격 오류가 있어 백테스트를 실행할 수 없습니다.${recursive ? ' EMA·RSI·MACD는 저장된 이전 이력 전체를 사용합니다.' : ''}`)
  return { candles: candles.slice(from, last + 1), start, end }
}
