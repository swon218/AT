import { ADVANCED_DEFAULTS } from './advancedIndicatorCatalog.js'
import {screenCatalog,metricSpec,sameMetricGroup,ratioComparison,comparableMetrics,conditionIssue,screenQueryIssue,screenIssues,validScreenShape} from '../../shared/screenerSemantics.js'
export {screenCatalog,metricSpec,sameMetricGroup,ratioComparison,comparableMetrics,conditionIssue,screenQueryIssue,screenIssues}

export const metricNames=Object.fromEntries(Object.entries(screenCatalog.metrics).map(([name,spec])=>[name,spec.title]))
export const operators = { lt: '미만 (<)', lte: '이하 (≤)', gt: '초과 (>)', gte: '이상 (≥)', crosses_above: '상향 돌파', crosses_below: '하향 돌파', eq:'상태 일치' }
export const isRawMetric = name => ['open', 'high', 'low', 'close', 'volume'].includes(name)
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
  return { name, period: isRawMetric(name) ? 1 : name.startsWith('macd') ? 12 : name === 'rsi' ? 14 : 20,
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
  { label: '거래량 200% (2배)', condition: () => ({ left: metric('volume'), operator: 'gte', right: relative('volume_sma', 2) }) },
  { label:'거래량 120% · 편의 예시',condition:()=>({left:metric('volume'),operator:'gte',right:relative('volume_sma',1.2)}) },
  { label:'가격 이동평균의 103% · 편의 예시',condition:()=>({left:metric('close'),operator:'gte',right:relative('sma',1.03)}) },
  ...[['rsi',70,'gte'],['mfi',20,'lte'],['mfi',80,'gte'],['stoch_k',20,'lte'],['stoch_k',80,'gte'],['adx',20,'gte'],['adx',25,'gte'],['cci',-100,'lte'],['cci',100,'gte']].map(([name,value,operator])=>({label:`${metricNames[name]} ${operators[operator]} ${value}`,reference:true,condition:()=>({left:metric(name),operator,right:constant(value)})})),
]
export function metricLabel(m) {
  if (isAdvancedMetric(m.name)) {
    const defaults = metric(m.name)
    const values = advancedMetricFields.flatMap(([key,title]) => defaults[key] === null ? [] : [`${title} ${m[key] ?? defaults[key]}${key==='atr_multiplier'?'배':['period','adx_period','k_smoothing','d_smoothing'].includes(key)?'봉':''}`])
    return metricNames[m.name] + (values.length ? `(${values.join(', ')})` : '')
  }
  if(['sma','ema','volume_sma'].includes(m.name))return `${m.period}봉 ${metricNames[m.name]}`
  return `${metricNames[m.name]}${isRawMetric(m.name) ? '' : m.name.startsWith('macd') ? `(${m.period}, ${m.slow}, ${m.signal}봉)` : m.name.startsWith('bb_') ? `(${m.period}봉, ${m.multiplier}배)` : `(${m.period}봉)`}`
}
// Decimal exponent shifting avoids 1.005 * 100 -> 100.499999999... display drift.
function scaleDecimal(value,places){
  if(value===null||value===undefined||typeof value==='boolean'||(typeof value==='string'&&!value.trim())||!Number.isFinite(Number(value)))return ''
  const [base,exponent='0']=String(value).split(/e/i)
  return Number(`${base}e${Number(exponent)+places}`)
}
export const factorToPercent=value=>scaleDecimal(value,2)
export const percentToFactor=value=>scaleDecimal(value,-2)
export function screenNumber(n){
  if(!Number.isFinite(n))return '—'
  const rounded=n.toLocaleString('ko-KR',{maximumFractionDigits:6})
  return n!==0&&Number(rounded.replaceAll(',',''))===0?n.toExponential(3):rounded
}
export function metricValue(name,value,withUnit=true){
  if(!Number.isFinite(value))return '—'
  const spec=metricSpec(name)
  return spec.states?.[value]??`${screenNumber(value)}${withUnit?' '+(spec.unit||''):''}`
}
export function describeCondition(c){
  const r=c.right
  const value=r.kind==='constant'?metricValue(c.left.name,r.value):ratioComparison(c.left.name,r.metric.name)?`${metricLabel(r.metric)}의 ${screenNumber(factorToPercent(r.factor))}%`:`${metricLabel(r.metric)}${r.factor===1?'':` × ${screenNumber(r.factor)} (고급 배수)`}`
  return `${metricLabel(c.left)} ${operators[c.operator]} ${value}`
}
export function describeQuery(q) {
  return `${q.market === 'ALL' ? '코스피·코스닥' : q.market} 확정 일봉 기준, ` + q.conditions.map(describeCondition).join(q.match === 'all' ? ' 그리고 ' : ' 또는 ')
}
export const defaultOperand=(name,kind='constant')=>kind==='constant'||metricSpec(name).states?constant(metricSpec(name).default):relative(metricSpec(name).target)
export function changeConditionMetric(c,left,{preserveConstant=false,preserveOperator=false}={}){
  if(left.name===c.left.name)return {...c,left}
  const spec=metricSpec(left.name),old=metricSpec(c.left.name)
  let right
  if(spec.states){
    const keep=old.states&&c.right.kind==='constant'&&Object.hasOwn(spec.states,c.right.value)
    return {left,operator:old.states?c.operator:'eq',right:constant(keep?c.right.value:spec.default)}
  }
  if(c.right.kind==='metric')right=sameMetricGroup(left.name,c.right.metric.name)?c.right:defaultOperand(left.name,'metric')
  else {
    const keep=(preserveConstant||old.group===spec.group)&&old.domain===spec.domain&&Number.isFinite(c.right.value)&&c.right.value>=spec.min&&c.right.value<=spec.max
    right=keep?c.right:defaultOperand(left.name)
  }
  return {left,operator:!old.states&&(preserveOperator||old.group===spec.group)?c.operator:spec.operator,right}
}
export function queryProblem(q){
  const code=screenQueryIssue(q)
  return code?screenIssues[code]:''
}
// Restore structurally valid old conditions verbatim, including incompatible
// units. Show a correction error and block execution instead of reinterpreting them.
export function importQuery(input) {
  return validScreenShape(input) ? { ...structuredClone(input), page: 1, snapshot_id: null } : null
}
