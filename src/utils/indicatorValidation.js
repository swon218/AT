import { INDICATOR_LIMIT } from './indicators.js'
import { ADVANCED_BY_ID, validAdvancedConfig } from './advancedIndicatorCatalog.js'

export function boundedNumber(value, min, max, name, integer = false) {
  if (value === '' || value == null || (typeof value === 'string' && !value.trim()) || !['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max || (integer && !Number.isSafeInteger(Number(value)))) throw new Error(`${name}: ${min}~${max}${integer ? ' 정수' : ''} 값을 입력하세요.`)
  return Number(value)
}

export function validateIndicators(indicators) {
  if (!Array.isArray(indicators) || indicators.length > INDICATOR_LIMIT || indicators.some(i => !i || typeof i.id !== 'string') || new Set(indicators.map(i => i.id)).size !== indicators.length) throw new Error('지표 조합을 확인하세요.')
  const period = (v, name) => boundedNumber(v, 1, 500, name, true)
  for (const c of indicators) {
    if (c.id === 'ma') {
      period(c.shortPeriod, 'MA 단기 기간'); period(c.longPeriod, 'MA 장기 기간')
      if (Number(c.shortPeriod) >= Number(c.longPeriod) || !['SMA', 'EMA'].includes(c.type)) throw new Error('MA 단기 기간은 장기 기간보다 작아야 합니다.')
    } else if (c.id === 'bollinger') { period(c.period, '볼린저 기간'); boundedNumber(c.multiplier, 0.1, 10, '표준편차 배수') }
    else if (c.id === 'volume-ma') period(c.period, '거래량 평균 기간')
    else if (c.id === 'rsi') {
      period(c.period, 'RSI 기간'); boundedNumber(c.lower, 0, 100, 'RSI 하단'); boundedNumber(c.upper, 0, 100, 'RSI 상단')
      if (Number(c.lower) >= Number(c.upper)) throw new Error('RSI 하단은 상단보다 작아야 합니다.')
    } else if (c.id === 'macd') {
      period(c.fast, 'MACD 단기'); period(c.slow, 'MACD 장기'); period(c.signal, 'MACD 시그널')
      if (Number(c.fast) >= Number(c.slow)) throw new Error('MACD 단기 기간은 장기 기간보다 작아야 합니다.')
    } else if (Object.hasOwn(ADVANCED_BY_ID, c.id)) {
      if (!validAdvancedConfig(c)) throw new Error(`${ADVANCED_BY_ID[c.id].shortName} 기간·기준선·표시 설정을 확인하세요.`)
    } else throw new Error('지원하지 않는 지표입니다.')
  }
}
