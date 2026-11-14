import { calculateBollinger, calculateEma, calculateMacd, calculateRsi, calculateSma, indicatorDisplayName } from './indicators.js'
import { advancedSeries } from './advancedIndicators.js'
import { validateIndicators } from './indicatorValidation.js'

export const OPERATORS = [
  { id: 'gt', label: '초과 (>)' }, { id: 'gte', label: '이상 (≥)' },
  { id: 'lt', label: '미만 (<)' }, { id: 'lte', label: '이하 (≤)' },
  { id: 'eq', label: '정확히 같음 (=)' },
  { id: 'crossUp', label: '상향 돌파' }, { id: 'crossDown', label: '하향 돌파' },
]
const field = (id, label, unit, extra = {}) => ({ id, label, unit, ...extra })
const percent = (id, label) => field(id, label, 'percent', { min: 0, max: 100 })
const price = (id, label) => field(id, label, 'price', { min: 0 })
const volume = (id, label) => field(id, label, 'volume')

// Selection metadata and the evaluator use the same field identifiers. Display
// switches never disable calculations (e.g. hidden ADX/OBV average).
export function getConditionFields(config) {
  switch (config?.id) {
    case 'ma': return [price('short', '단기선'), price('long', '장기선'), price('close', '종가')]
    case 'bollinger': return [price('close', '종가'), price('high', '고가'), price('low', '저가'), price('upper', '상단선'), price('middle', '중심선'), price('lower', '하단선')]
    case 'volume-ma': return [volume('volume', '거래량'), volume('average', '거래량 평균')]
    case 'rsi': return [percent('rsi', 'RSI')]
    case 'macd': return [field('macd', 'MACD', 'price'), field('signal', '시그널', 'price'), field('histogram', '히스토그램', 'price')]
    case 'atr': return [price('atr', 'ATR'), field('atr_percent', 'ATR%', 'percent', { min: 0 })]
    case 'dmi': return [percent('adx', 'ADX'), percent('plus_di', '+DI'), percent('minus_di', '−DI')]
    case 'stochastic': return [percent('stoch_k', '%K'), percent('stoch_d', '%D')]
    case 'obv': return [volume('obv', 'OBV'), volume('obv_ma', 'OBV 평균선')]
    case 'mfi': return [percent('mfi', 'MFI')]
    case 'cci': return [field('cci', 'CCI', 'index')]
    case 'supertrend': return [price('supertrend', '슈퍼트렌드선'), price('close', '종가'), field('supertrend_direction', '추세 방향', 'state', { stateValues: [-1, 1] }), field('supertrend_flip', '방향 전환', 'state', { stateValues: [-1, 0, 1] })]
    default: return []
  }
}

export function defaultEntryCondition(config) {
  const indicatorId = config.id
  const common = { indicatorId, enabled: false, left: getConditionFields(config)[0]?.id || '', operator: 'gte', right: { type: 'constant', value: '' } }
  const series = field => ({ type: 'series', field })
  if (indicatorId === 'ma') return { ...common, operator: 'gt', right: series('long') }
  if (indicatorId === 'bollinger') return { ...common, operator: 'lte', right: series('lower') }
  if (indicatorId === 'volume-ma') return { ...common, operator: 'gt', right: series('average') }
  if (['rsi', 'mfi'].includes(indicatorId)) return { ...common, operator: 'lte', right: { type: 'constant', value: Number(config.lower) } }
  if (indicatorId === 'macd') return { ...common, operator: 'crossUp', right: series('signal') }
  if (indicatorId === 'dmi') return { ...common, right: { type: 'constant', value: 25 } }
  if (indicatorId === 'stochastic') return { ...common, operator: 'crossUp', right: series('stoch_d') }
  if (indicatorId === 'obv') return { ...common, operator: 'crossUp', right: series('obv_ma') }
  if (indicatorId === 'cci') return { ...common, operator: 'crossUp', right: { type: 'constant', value: Number(config.lower) } }
  if (indicatorId === 'supertrend') return { ...common, left: 'supertrend_direction', operator: 'eq', right: { type: 'constant', value: 1 } }
  return common
}

export function normalizeRiskSettings(settings, { allowIncomplete = true } = {}) {
  const out = {}
  for (const [key, label, maximum] of [['takeProfitPct', '익절 비율', 10000], ['stopLossPct', '손절 비율', 100]]) {
    const value = settings?.[key]
    if ((value === '' || value == null) && allowIncomplete) { out[key] = ''; continue }
    const n = Number(value)
    if (value === '' || value == null || !['string', 'number'].includes(typeof value) || !Number.isFinite(n) || n <= 0 || n > maximum || (key === 'stopLossPct' && n >= 100)) throw new Error(`${label}은 0보다 ${key === 'stopLossPct' ? '크고 100% 미만' : '크고 10000% 이하'}의 숫자로 입력하세요.`)
    out[key] = n
  }
  return out
}

export function validateEntryConditions(indicators, settings, { requireEntry = false } = {}) {
  const conditions = settings?.entryConditions ?? []
  if (!['all', 'any'].includes(settings?.entryMode ?? 'all') || !Array.isArray(conditions) || conditions.length > 64) throw new Error('진입 조건 조합을 확인하세요.')
  const normalized = conditions.map(condition => {
    const config = indicators.find(c => c.id === condition?.indicatorId)
    if (!config || typeof condition.enabled !== 'boolean') throw new Error('진입 조건에 필요한 지표와 사용 여부를 확인하세요.')
    const fields = getConditionFields(config), left = fields.find(f => f.id === condition.left)
    const op = OPERATORS.find(o => o.id === condition.operator)
    const right = condition.right
    if (!left || !op || !right || !['constant', 'series'].includes(right.type)) throw new Error('진입 조건의 비교 값과 방식을 확인하세요.')
    if (left.unit === 'state' && (op.id !== 'eq' || right.type !== 'constant')) throw new Error('추세 상태는 정확히 같음과 상태값으로 비교하세요.')
    let target
    if (right.type === 'constant') {
      const value = right.value
      const n = Number(value)
      if (value === '' || value == null || (typeof value === 'string' && !value.trim()) || !['number', 'string'].includes(typeof value) || !Number.isFinite(n) || (left.min != null && n < left.min) || (left.max != null && n > left.max) || (left.stateValues && !left.stateValues.includes(n))) throw new Error(`${left.label} 진입 조건 기준값을 확인하세요.`)
      target = { type: 'constant', value: n }
    } else {
      const other = indicators.find(c => c.id === (right.indicatorId || config.id))
      const targetField = getConditionFields(other).find(f => f.id === right.field)
      if (!other || !targetField || targetField.unit !== left.unit || targetField.unit === 'state') throw new Error('비교 지표의 단위와 계산 설정을 확인하세요.')
      target = { type: 'series', field: targetField.id, ...(other.id !== config.id ? { indicatorId: other.id } : {}) }
    }
    return { indicatorId: config.id, enabled: condition.enabled, left: left.id, operator: op.id, right: target }
  })
  if (requireEntry && !normalized.some(c => c.enabled)) throw new Error('진입 판단에 사용할 조건을 한 개 이상 설정하세요.')
  return normalized
}

export function strategyReadiness(indicators, settings) {
  const issues = []
  try { validateIndicators(indicators) } catch (error) { issues.push(error.message) }
  try { validateEntryConditions(indicators, settings, { requireEntry: true }) } catch (error) { issues.push(error.message) }
  try { normalizeRiskSettings(settings, { allowIncomplete: false }) } catch (error) { issues.push(error.message) }
  return issues
}

export function describeEntryCondition(condition, indicators) {
  const config = indicators.find(c => c.id === condition?.indicatorId)
  if (!config) return '진입 조건 설정 필요'
  const left = getConditionFields(config).find(f => f.id === condition.left)?.label || '비교 항목'
  const right = condition.right?.type === 'series'
    ? getConditionFields(indicators.find(c => c.id === (condition.right.indicatorId || config.id))).find(f => f.id === condition.right.field)?.label || '비교 지표'
    : condition.right?.value === '' || condition.right?.value == null ? '기준값 미입력' : String(condition.right.value)
  return `${indicatorDisplayName(config)} · ${left} ${OPERATORS.find(o => o.id === condition.operator)?.label || '비교 방식'} ${right}`
}

const points = (candles, data) => {
  const map = new Map(data.map(p => [p.time, p.value]))
  return candles.map(c => map.get(c.time) ?? null)
}

export function calculateConditionEvaluator(candles, indicators) {
  const values = new Map()
  for (const c of indicators) {
    let result
    if (c.id === 'ma') { const fn = c.type === 'EMA' ? calculateEma : calculateSma; result = { short: points(candles, fn(candles, Number(c.shortPeriod))), long: points(candles, fn(candles, Number(c.longPeriod))), close: candles.map(b => b.close) } }
    else if (c.id === 'bollinger') { const bands = calculateBollinger(candles, Number(c.period), Number(c.multiplier)); result = { ...Object.fromEntries(Object.entries(bands).map(([key, data]) => [key, points(candles, data)])), ...Object.fromEntries(['close', 'high', 'low'].map(key => [key, candles.map(b => b[key])])) } }
    else if (c.id === 'volume-ma') result = { volume: candles.map(b => b.volume), average: points(candles, calculateSma(candles, Number(c.period), 'volume')) }
    else if (c.id === 'rsi') result = { rsi: points(candles, calculateRsi(candles, Number(c.period))) }
    else if (c.id === 'macd') { const m = calculateMacd(candles, Number(c.fast), Number(c.slow), Number(c.signal)); result = Object.fromEntries(['macd', 'signal', 'histogram'].map(key => [key, points(candles, m[key])])) }
    else { result = advancedSeries(candles, c); if (c.id === 'supertrend') result.close = candles.map(b => b.close) }
    values.set(c.id, result)
  }
  return (condition, index) => {
    const a = offset => values.get(condition.indicatorId)?.[condition.left]?.[index + offset]
    const b = offset => condition.right.type === 'constant' ? Number(condition.right.value) : values.get(condition.right.indicatorId || condition.indicatorId)?.[condition.right.field]?.[index + offset]
    const left = a(0), right = b(0)
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null
    switch (condition.operator) {
      case 'gt': return left > right
      case 'gte': return left >= right
      case 'lt': return left < right
      case 'lte': return left <= right
      case 'eq': return left === right // Calculated values, never rounded or epsilon-adjusted.
      case 'crossUp': return Number.isFinite(a(-1)) && Number.isFinite(b(-1)) ? left > right && a(-1) <= b(-1) : null
      case 'crossDown': return Number.isFinite(a(-1)) && Number.isFinite(b(-1)) ? left < right && a(-1) >= b(-1) : null
      default: return null
    }
  }
}
