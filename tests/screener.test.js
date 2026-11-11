import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultQuery, importQuery, metric, presets, relative, describeQuery, constant, factorToPercent, percentToFactor, metricNames, metricSpec, metricLabel, metricValue, defaultOperand, changeConditionMetric, screenQueryIssue, sameMetricGroup } from '../src/utils/screener.js'
import proxy from '../api/screener.js'

test('manual query import and presets retain actual periods, low-touch and scales', () => {
  assert.deepEqual(importQuery(defaultQuery()), defaultQuery())
  assert.equal(importQuery({ ...defaultQuery(), sql: 'select 1' }), null)
  assert.equal(importQuery({ ...defaultQuery(), snapshot_id: 'forged' }), null)
  assert.equal(importQuery({ ...defaultQuery(), conditions: [] }), null)
  assert.equal(presets[1].condition().left.name, 'low')
  assert.equal(presets[3].condition().right.factor, 2)
  assert.equal(metric('macd').slow, 26)
  assert.equal(metric('close').period, 1)
  const q = defaultQuery(); q.conditions[0] = presets[3].condition()
  assert.match(describeQuery(q), /20봉 거래량 이동평균 \(SMA\)의 200%/)
})

test('percentage conversion preserves factors, decimals, limits and empty input without coerced zero', () => {
  for (const factor of [.01,.2,.9,1,1.1,1.2,2,1.005,1.000001,123.456789,1000]) {
    assert.equal(percentToFactor(factorToPercent(factor)),factor)
    assert.equal(importQuery({...defaultQuery(),conditions:[{left:metric('volume'),operator:'gte',right:relative('volume_sma',factor)}]}).conditions[0].right.factor,factor)
  }
  assert.deepEqual([1,1.1,1.2,.9,2].map(factorToPercent),[100,110,120,90,200])
  for(const bad of ['', ' ',null,undefined,true,NaN,Infinity]) assert.equal(percentToFactor(bad),'')
})

test('all 29 metrics have explicit units, meaningful comparison families and compatible defaults', () => {
  const names=Object.keys(metricNames)
  assert.equal(names.length,29)
  for(const name of names){
    const spec=metricSpec(name)
    assert.ok(spec.unit&&spec.guide&&metricLabel(metric(name)))
    const q={...defaultQuery(),conditions:[{left:metric(name),operator:spec.operator,right:defaultOperand(name)}]}
    assert.equal(screenQueryIssue(q),null,name)
    for(const other of names){
      const item={left:metric(name),operator:'gte',right:relative(other)}
      const code=screenQueryIssue({...defaultQuery(),conditions:[item]})
      assert.equal(code===null,sameMetricGroup(name,other),`${name}/${other}`)
    }
  }
  assert.equal(defaultOperand('volume','metric').metric.name,'volume_sma')
  assert.equal(defaultOperand('macd','metric').metric.name,'macd_signal')
  assert.equal(metricSpec('atr_percent').unit,'%')
  assert.equal(metricSpec('obv').unit,'주(누적)')
})

test('metric edits reset incompatible units but preserve valid manually edited values and legacy signed factors',()=>{
  const initial=defaultQuery().conditions[0]
  const volume=changeConditionMetric(initial,metric('volume'))
  assert.equal(volume.right.value,100000);assert.equal(volume.operator,'gte')
  const manual={...initial,right:constant(42.25)}
  assert.equal(changeConditionMetric(manual,metric('mfi'),{preserveConstant:true}).right.value,42.25)
  assert.equal(changeConditionMetric(manual,metric('close'),{preserveConstant:true}).right.value,10000)
  assert.equal(changeConditionMetric({left:metric('close'),operator:'gte',right:constant(50000)},metric('sma')).right.value,50000)
  const relativeVolume=changeConditionMetric({...initial,right:relative('sma',1.2)},metric('volume'))
  assert.deepEqual(relativeVolume.right,relative('volume_sma'))
  const signed={left:metric('macd'),operator:'crosses_above',right:relative('macd_signal',1.2)}
  assert.deepEqual(changeConditionMetric(signed,metric('macd_histogram')).right,signed.right)
  assert.match(describeQuery({...defaultQuery(),conditions:[signed]}),/1.2 \(고급 배수\)/)
  assert.doesNotMatch(describeQuery({...defaultQuery(),conditions:[signed]}),/120%/)
  const bad={...defaultQuery(),conditions:[{left:metric('volume'),operator:'gte',right:relative('sma',2)}]}
  assert.deepEqual(importQuery(bad),bad)
  assert.equal(screenQueryIssue(importQuery(bad)),'screen_unit_mismatch')
})

test('bounded values, signed zero, invalid operands and Korean state codes are validated without changing multipliers',()=>{
  for(const name of ['rsi','mfi','adx','plus_di','minus_di','stoch_k','stoch_d'])for(const value of [-1,0,100,101,'']){
    const q={...defaultQuery(),conditions:[{left:metric(name),operator:'gte',right:constant(value)}]}
    assert.equal(screenQueryIssue(q)===null,typeof value==='number'&&value>=0&&value<=100)
  }
  for(const name of ['cci','macd','obv'])for(const value of [-100,0,100])assert.equal(screenQueryIssue({...defaultQuery(),conditions:[{left:metric(name),operator:'gte',right:constant(value)}]}),null)
  assert.equal(metricValue('supertrend_direction',1),'상승');assert.equal(metricValue('supertrend_direction',-1),'하락')
  assert.equal(metricValue('supertrend_flip',0),'변화 없음');assert.equal(metricValue('supertrend_flip',-1),'하락 전환')
  for(const name of ['supertrend_direction','supertrend_flip'])for(const value of [-1,0,1,2]){
    const q={...defaultQuery(),conditions:[{left:metric(name),operator:'eq',right:constant(value)}]}
    assert.equal(screenQueryIssue(q)===null,Object.hasOwn(metricSpec(name).states,value))
  }
  for(const right of [{...constant(30),factor:2},{...relative('rsi'),value:1}])assert.equal(screenQueryIssue({...defaultQuery(),conditions:[{left:metric('rsi'),operator:'lte',right}]}),'invalid_screen_query')
  assert.equal(metric('bb_lower').multiplier,2);assert.equal(metric('supertrend').atr_multiplier,3)
})

test('Vercel screen proxy uses one fixed target and never forwards broker/auth cookies', async () => {
  const oldOrigin = process.env.ATLAS_API_ORIGIN, oldFetch = global.fetch
  process.env.ATLAS_API_ORIGIN = 'https://fixture.example'
  let seen
  global.fetch = async (url, options) => { seen = [url.href, options]; return new Response('{"items":[]}', { status: 200 }) }
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, status(s) { this.code = s; return this }, json(v) { this.body = v; return this }, send(v) { this.body = v; return this } }
  try {
    await proxy({ method: 'POST', query: { target: 'https://evil.example' }, headers: { origin: 'https://atlas.example', authorization: 'private', cookie: 'private', 'sec-fetch-site': 'same-origin' }, body: defaultQuery() }, res)
    assert.equal(res.code, 200)
    assert.equal(seen[0], 'https://fixture.example/api/screener')
    assert.deepEqual(Object.keys(seen[1].headers).sort(), ['Content-Type', 'origin', 'sec-fetch-site'])
    assert.equal(res.headers['Cache-Control'], 'no-store')
    global.fetch = async () => new Response('old VPS route missing', { status: 404 })
    await proxy({ method: 'GET', headers: {} }, res)
    assert.equal(res.code, 503)
    assert.deepEqual(res.body, { error: 'screen_unavailable' })
  } finally { global.fetch = oldFetch; if (oldOrigin === undefined) delete process.env.ATLAS_API_ORIGIN; else process.env.ATLAS_API_ORIGIN = oldOrigin }
})
