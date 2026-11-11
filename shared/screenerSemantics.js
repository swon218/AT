import catalog from './screener-metrics.json' with {type:'json'}
import schema from './screener-schema.json' with {type:'json'}

export const screenCatalog=catalog
export const metricSpec=name=>({...catalog.groups[catalog.metrics[name]?.group],...catalog.metrics[name]})
export const sameMetricGroup=(left,right)=>!!catalog.metrics[left]&&catalog.metrics[left].group===catalog.metrics[right]?.group&&!metricSpec(left).states
export const ratioComparison=(left,right)=>sameMetricGroup(left,right)&&metricSpec(left).ratio
export const comparableMetrics=name=>Object.keys(catalog.metrics).filter(other=>sameMetricGroup(name,other))
export const screenIssues={invalid_screen_query:'빈 입력·유효하지 않은 숫자 또는 지표 설정을 확인해 주세요.',screen_unit_mismatch:'비교할 수 없는 지표 조합입니다. 가격·거래량·누적거래량과 각 지표군을 구분해 주세요.',screen_threshold_range:'기준값이 지표 범위를 벗어났습니다. 입력 단위와 허용 범위를 확인해 주세요.',screen_state_comparison:'상태 지표는 유효한 상태와만 비교할 수 있습니다. 배수·퍼센트는 사용할 수 없습니다.',screen_state_operator:'상태 일치 비교는 슈퍼트렌드 방향·전환에만 사용할 수 있습니다.'}

export function validScreenShape(value,node=schema){
  if(node.$ref)return validScreenShape(value,schema.$defs[node.$ref.split('/').at(-1)])
  if(node.anyOf)return node.anyOf.some(n=>validScreenShape(value,n))
  if(node.enum&&!node.enum.includes(value))return false
  if(node.type==='null')return value===null
  if(node.type==='object')return value!==null&&typeof value==='object'&&!Array.isArray(value)&&(node.required||[]).every(k=>k in value)&&Object.keys(value).every(k=>node.properties[k]&&validScreenShape(value[k],node.properties[k]))
  if(node.type==='array')return Array.isArray(value)&&value.length>=(node.minItems||0)&&value.length<=(node.maxItems||Infinity)&&value.every(v=>validScreenShape(v,node.items))
  if(['number','integer'].includes(node.type))return typeof value==='number'&&Number.isFinite(value)&&(node.type!=='integer'||Number.isInteger(value))&&value>=(node.minimum??-Infinity)&&value<=(node.maximum??Infinity)
  if(node.type==='string')return typeof value==='string'&&(!node.pattern||new RegExp(node.pattern).test(value))
  return true
}

export function metricIssue(m){
  if(!m||!catalog.metrics[m.name])return 'invalid_screen_query'
  if(Object.hasOwn(m,'slow')){
    if(['open','high','low','close','volume'].includes(m.name)&&m.period!==1)return 'invalid_screen_query'
    if(m.name.startsWith('macd')?m.period>=m.slow:m.slow!==1||m.signal!==1)return 'invalid_screen_query'
    if(!m.name.startsWith('bb_')&&m.multiplier!==1)return 'invalid_screen_query'
  }else{
    const used={period:m.name!=='obv',adx_period:m.name==='adx',k_smoothing:m.name.startsWith('stoch_'),d_smoothing:m.name==='stoch_d',average_type:m.name==='obv_ma',source:m.name==='cci',atr_multiplier:m.name.startsWith('supertrend')}
    if(Object.entries(used).some(([field,active])=>!active&&m[field]!==null))return 'invalid_screen_query'
  }
  return null
}

export function conditionIssue(c){
  if(!c?.left||!c?.right)return 'invalid_screen_query'
  const m=metricSpec(c.left.name),r=c.right
  if(!m.group)return 'invalid_screen_query'
  if(r.kind==='constant'&&(r.value===null||r.metric!==null||r.factor!==1))return 'invalid_screen_query'
  if(r.kind==='metric'&&(!r.metric||r.value!==null))return 'invalid_screen_query'
  if(m.states){
    if(r.kind!=='constant'||r.factor!==1||!Number.isInteger(r.value)||!Object.hasOwn(m.states,r.value))return 'screen_state_comparison'
  }else if(c.operator==='eq')return 'screen_state_operator'
  if(r.kind==='metric'&&!sameMetricGroup(c.left.name,r.metric?.name))return 'screen_unit_mismatch'
  if(r.kind==='constant'&&!m.states&&(typeof r.value!=='number'||!Number.isFinite(r.value)||r.value<m.min||r.value>m.max))return 'screen_threshold_range'
  return null
}

export function screenQueryIssue(q){
  if(!validScreenShape(q))return 'invalid_screen_query'
  for(const c of q.conditions){
    const issue=metricIssue(c.left)||(c.right.metric&&metricIssue(c.right.metric))||conditionIssue(c)
    if(issue)return issue
  }
  return null
}
