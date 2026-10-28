import schema from '../../shared/screener-schema.json' with { type: 'json' }

export const metricNames = { close: '종가', open: '시가', high: '고가', low: '저가', volume: '거래량', sma: '이동평균선 (SMA)', ema: '지수이동평균선 (EMA)', rsi: 'RSI', bb_lower: '볼린저밴드 하단', bb_middle: '볼린저밴드 중심', bb_upper: '볼린저밴드 상단', volume_sma: '평균 거래량', macd: 'MACD', macd_signal: 'MACD 시그널', macd_histogram: 'MACD 히스토그램' }
export const operators = { lt: '미만 (<)', lte: '이하 (≤)', gt: '초과 (>)', gte: '이상 (≥)', crosses_above: '상향 돌파', crosses_below: '하향 돌파' }
export const isPrice = name => ['open', 'high', 'low', 'close', 'volume'].includes(name)
export const metric = (name = 'rsi') => ({ name, period: isPrice(name) ? 1 : name.startsWith('macd') ? 12 : name === 'rsi' ? 14 : 20, slow: name.startsWith('macd') ? 26 : 1, signal: name.startsWith('macd') ? 9 : 1, multiplier: name.startsWith('bb_') ? 2 : 1 })
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
