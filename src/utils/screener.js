import schema from '../../shared/screener-schema.json' with { type: 'json' }
import { ADVANCED_DEFAULTS } from './advancedIndicatorCatalog.js'

export const metricNames = { close: '종가', open: '시가', high: '고가', low: '저가', volume: '거래량', sma: '이동평균선 (SMA)', ema: '지수이동평균선 (EMA)', rsi: 'RSI', bb_lower: '볼린저밴드 하단', bb_middle: '볼린저밴드 중심', bb_upper: '볼린저밴드 상단', volume_sma: '평균 거래량', macd: 'MACD', macd_signal: 'MACD 시그널', macd_histogram: 'MACD 히스토그램',
  atr: 'ATR', atr_percent: 'ATR%', adx: 'ADX', plus_di: '+DI', minus_di: '−DI', stoch_k: '스토캐스틱 K', stoch_d: '스토캐스틱 D', obv: 'OBV', obv_ma: 'OBV 평균', mfi: 'MFI', cci: 'CCI', supertrend: '슈퍼트렌드', supertrend_direction: '슈퍼트렌드 방향', supertrend_flip: '슈퍼트렌드 전환' }
export const operators = { lt: '미만 (<)', lte: '이하 (≤)', gt: '초과 (>)', gte: '이상 (≥)', crosses_above: '상향 돌파', crosses_below: '하향 돌파' }
export const isPrice = name => ['open', 'high', 'low', 'close', 'volume'].includes(name)
const d = ADVANCED_DEFAULTS
const advancedPeriods = { atr: d.atr.period, atr_percent: d.atr.period, adx: d.dmi.period, plus_di: d.dmi.period, minus_di: d.dmi.period,
  stoch_k: d.stochastic.period, stoch_d: d.stochastic.period, obv: null, obv_ma: d.obv.maPeriod, mfi: d.mfi.period,
  cci: d.cci.period, supertrend: d.supertrend.period, supertrend_direction: d.supertrend.period, supertrend_flip: d.supertrend.period }
export const isAdvancedMetric = name => Object.hasOwn(advancedPeriods, name)
export function metric(name = 'rsi') {
  if (isAdvancedMetric(name)) return { name, period: advancedPeriods[name], adx_period: name === 'adx' ? d.dmi.adxPeriod : null,
    k_smoothing: name.startsWith('stoch_') ? d.stochastic.kPeriod : null, d_smoothing: name === 'stoch_d' ? d.stochastic.dPeriod : null,
    average_type: name === 'obv_ma' ? d.obv.maType : null, source: name === 'cci' ? d.cci.source : null,
    atr_multiplier: name.startsWith('supertrend') ? d.supertrend.multiplier : null }
  return { name, period: isPrice(name) ? 1 : name.startsWith('macd') ? 12 : name === 'rsi' ? 14 : 20,
    slow: name.startsWith('macd') ? 26 : 1, signal: name.startsWith('macd') ? 9 : 1, multiplier: name.startsWith('bb_') ? 2 : 1 }
}

export const advancedMetricFields = [
  ['period', '기간'], ['adx_period', 'ADX 평활'], ['k_smoothing', 'K 평활'], ['d_smoothing', 'D 평활'],
  ['average_type', 'OBV 평균 종류', { SMA: 'SMA', EMA: 'EMA' }], ['source', '가격 소스', { close: '종가', hlc3: 'HLC3' }],
  ['atr_multiplier', 'ATR 배수'],
]
export const constant = (value = 30) => ({ kind: 'constant', value, metric: null, factor: 1 })
export const relative = (name = 'sma', factor = 1) => ({ kind: 'metric', value: null, metric: metric(name), factor })
export const condition = () => ({ left: metric(), operator: 'lte', right: constant() })
export const defaultQuery = () => ({ market: 'ALL', match: 'all', conditions: [condition()], sort: 'code_asc', page: 1, page_size: 20, snapshot_id: null })
export const presets = [
  { label: 'RSI 30 이하', condition },
  { label: '볼린저 하단 터치', condition: () => ({ left: metric('low'), operator: 'lte', right: relative('bb_lower') }) },
  { label: '20일선 아래', condition: () => ({ left: metric('close'), operator: 'lt', right: relative('sma') }) },
  { label: '거래량 2배', condition: () => ({ left: metric('volume'), operator: 'gte', right: relative('volume_sma', 2) }) },
]
export function metricLabel(m) {
  if (isAdvancedMetric(m.name)) {
    const defaults = metric(m.name)
    const values = advancedMetricFields.flatMap(([key]) => defaults[key] === null ? [] : [m[key] ?? defaults[key]])
    return metricNames[m.name] + (values.length ? `(${values.join(', ')})` : '')
  }
  return `${metricNames[m.name]}${isPrice(m.name) ? '' : m.name.startsWith('macd') ? `(${m.period},${m.slow},${m.signal})` : m.name.startsWith('bb_') ? `(${m.period},${m.multiplier})` : `(${m.period})`}`
}
export function describeQuery(q) {
  return `${q.market === 'ALL' ? '코스피·코스닥' : q.market} 확정 일봉 기준, ` + q.conditions.map(c => `${metricLabel(c.left)} ${operators[c.operator]} ${c.right.kind === 'constant' ? c.right.value : `${c.right.factor === 1 ? '' : c.right.factor + '배의 '}${metricLabel(c.right.metric)}`}`).join(q.match === 'all' ? ' 그리고 ' : ' 또는 ')
}
// Validate server-persisted AI queries before opening a form. The Python model
// remains authoritative for every actual search, including unknown fields.
export function importQuery(input) {
  const validate = (value, node) => {
    if (node.$ref) return validate(value, schema.$defs[node.$ref.split('/').at(-1)])
    if (node.anyOf) return node.anyOf.some(n => validate(value, n))
    if (node.enum && !node.enum.includes(value)) return false
    if (node.type === 'null') return value === null
    if (node.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) && (node.required || []).every(k => k in value) && Object.keys(value).every(k => node.properties[k] && validate(value[k], node.properties[k]))
    if (node.type === 'array') return Array.isArray(value) && value.length >= (node.minItems || 0) && value.length <= (node.maxItems || Infinity) && value.every(v => validate(v, node.items))
    if (['number', 'integer'].includes(node.type)) return typeof value === 'number' && Number.isFinite(value) && (node.type !== 'integer' || Number.isInteger(value)) && value >= (node.minimum ?? -Infinity) && value <= (node.maximum ?? Infinity)
    if (node.type === 'string') return typeof value === 'string' && (!node.pattern || new RegExp(node.pattern).test(value))
    return true
  }
  return validate(input, schema) ? { ...structuredClone(input), page: 1, snapshot_id: null } : null
}
