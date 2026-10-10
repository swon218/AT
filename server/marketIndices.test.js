import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { createMarketIndices, registerMarketIndexRoutes } from './marketIndices.js'
import { createMarketRequestContext } from './marketContext.js'

const now = () => Date.parse('2026-10-10T12:00:00+09:00')
const quote = { cur_prc: '-6625.93', pred_pre_sig: '5', pred_pre: '-177.97', flu_rt: '-2.62', trde_qty: '302539' }
const row = (date, price = '662593') => ({ dt: date, cur_prc: price, trde_qty: '500' })
const create = () => createMarketIndices({ now, pause: async () => {} })

test('1일은 휴일에도 최근 거래일 분봉만 반환하고 지수 100배 및 거래량 천주 단위를 변환한다', async () => {
  const calls = []
  const result = await create()('kospi', '1d', { requester: async req => {
    calls.push(req)
    if (req.apiId === 'ka20001') return quote
    return { body: { inds_min_pole_qry: [
      { cntr_tm: '20261008153000', cur_prc: '-662593', trde_qty: '24184' },
      { cntr_tm: '20261008090000', cur_prc: '+680868', trde_qty: '100' },
      { cntr_tm: '20261007153000', cur_prc: '680390', trde_qty: '100' },
    ] }, contYn: 'Y', nextKey: 'older' }
  } })
  assert.equal(result.price, 6625.93)
  assert.equal(result.change, -177.97)
  assert.equal(result.changeRate, -2.62)
  assert.equal(result.volume, 302539000)
  assert.equal(result.candles.length, 2)
  assert.equal(result.candles[1].close, 6625.93)
  assert.equal(result.candles[1].volume, 24184000)
  assert.equal(result.asOf, '2026-10-08T15:30:00+09:00')
  assert.equal(calls[1].apiId, 'ka20005')
  assert.deepEqual(calls[0].body, { mrkt_tp: '0', inds_cd: '001' })
})

test('1주부터 1년까지 일봉 기간을 자르고 코스닥 코드를 독립적으로 사용한다', async () => {
  const rows = ['20261008', '20261001', '20260930', '20260908', '20260907', '20260708', '20260707', '20251008', '20251007'].map(d => row(d))
  for (const [period, first] of [['1w', '2026-10-01'], ['1m', '2026-09-08'], ['3m', '2026-07-08'], ['1y', '2025-10-08']]) {
    const result = await create()('kosdaq', period, { requester: async req => {
      assert.equal(req.body.inds_cd, '101')
      if (req.apiId === 'ka20001') { assert.equal(req.body.mrkt_tp, '1'); return quote }
      assert.equal(req.apiId, 'ka20006')
      return { body: { inds_dt_pole_qry: rows }, contYn: 'N' }
    } })
    assert.equal(result.candles[0].time, first)
    assert.equal(result.asOf, '2026-10-08')
  }
})

test('연속 조회 시 중복 봉 제거, 순서 정렬 및 단위 변환은 한 번만 한다', async () => {
  let pages = 0
  const result = await create()('kospi', '1y', { requester: async req => {
    if (req.apiId === 'ka20001') return quote
    pages++
    if (!req.nextKey) return { body: { inds_dt_pole_qry: [row('20261008'), row('20260101')] }, contYn: 'Y', nextKey: 'page2' }
    assert.equal(req.contYn, 'Y')
    return { body: { inds_dt_pole_qry: [row('20260101'), row('20251008'), row('20251007')] }, contYn: 'N' }
  } })
  assert.equal(pages, 2)
  assert.equal(result.candles.length, 3)
  assert.ok(result.candles.every(candle => candle.close === 6625.93 && candle.volume === 500000))
})

test('말일에서 1개월 조회 시 이전 달의 마지막 날짜를 기준으로 한다', async () => {
  const result = await create()('kospi', '1m', { requester: async req => req.apiId === 'ka20001' ? quote : { body: { inds_dt_pole_qry: [row('20260331'), row('20260228'), row('20260227')] }, contYn: 'N' } })
  assert.equal(result.candles[0].time, '2026-02-28')
})

test('동시 요청을 합치고 사용자 및 키 버전별로 캐시를 분리하며 만료 후 갱신한다', async () => {
  let time = now(), calls = 0
  const get = createMarketIndices({ now: () => time, pause: async () => {}, ttl: 1000 })
  const requester = async req => { calls++; return req.apiId === 'ka20001' ? quote : { body: { inds_dt_pole_qry: [row('20261008')] }, contYn: 'N' } }
  const context = { requester, cacheScope: 'operator' }
  await Promise.all([get('kospi', '1w', context), get('kospi', '1w', context)])
  assert.equal(calls, 2)
  await get('kospi', '1w', { requester, cacheScope: 'user:1:key1' })
  await get('kospi', '1w', { requester, cacheScope: 'user:1:key2' })
  assert.equal(calls, 6)
  time += 1001
  await get('kospi', '1w', context)
  assert.equal(calls, 8)
})

test('잘못된 입력과 빈 데이터는 실패하고 오류를 성공 데이터로 캐시하지 않는다', async () => {
  const get = create()
  await assert.rejects(get('nasdaq', '1d'), { statusCode: 400 })
  await assert.rejects(get('kospi', '5y'), { statusCode: 400 })
  await assert.rejects(get('kospi', '1d', { requester: async () => ({ cur_prc: '' }) }), /현재 지수/)
  await assert.rejects(get('kospi', '1d', { requester: async req => req.apiId === 'ka20001' ? quote : { body: { inds_min_pole_qry: [] } } }), /응답이 비어/)
  const result = await get('kospi', '1w', { requester: async req => req.apiId === 'ka20001' ? quote : { body: { inds_dt_pole_qry: [row('20261008')] }, contYn: 'N' } })
  assert.equal(result.price, 6625.93)
})

test('동일 연속 키가 반복되면 불완전한 차트를 반환하지 않는다', async () => {
  await assert.rejects(create()('kospi', '1y', { requester: async req => req.apiId === 'ka20001' ? quote : { body: { inds_dt_pole_qry: [row('20261008')] }, contYn: 'Y', nextKey: 'repeat' } }), /연속 조회/)
})

test('지수 경로도 관리자/개인 키 정책과 인증 오류를 유지하고 응답의 공용 캐싱을 차단한다', async t => {
  const app = Fastify()
  t.after(() => app.close())
  const context = createMarketRequestContext({
    operator: async () => 'operator', personal: async () => 'personal',
    authenticate: async req => {
      if (req.headers.authorization === 'Bearer expired') throw Object.assign(new Error('expired'), { statusCode: 401 })
      const configured = req.headers.authorization === 'Bearer personal'
      return { user: { id: 'u1' }, status: { kiwoomConfigured: configured }, credentials: configured ? { kiwoomAppKey: 'test', kiwoomSecretKey: 'test' } : {} }
    },
  })
  registerMarketIndexRoutes(app, { context, getIndex: async (symbol, period, auth) => ({ symbol, period, caller: await auth.requester({}) }) })
  const url = '/api/public/market/kiwoom/indices?symbol=kospi&period=1d'
  for (const [authorization, caller] of [['', 'operator'], ['Bearer no-key', 'operator'], ['Bearer personal', 'personal']]) {
    const r = await app.inject({ url, headers: authorization ? { authorization } : {} })
    assert.equal(r.statusCode, 200)
    assert.equal(r.json().caller, caller)
    assert.equal(r.headers['cache-control'], 'private, no-store')
  }
  assert.equal((await app.inject({ url, headers: { authorization: 'Bearer expired' } })).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/public/market/kiwoom/indices?symbol=bad&period=1d' })).statusCode, 400)
})
