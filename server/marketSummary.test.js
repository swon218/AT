import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createMarketSummary, normalizeMarketQuote, registerMarketSummaryRoutes } from './marketSummary.js'
import { createMarketRequestContext } from './marketContext.js'

const fixedNow = Date.parse('2026-10-10T12:00:00+09:00')
const quote = { trde_prica: '24376305', rising: '252', stdns: '40', fall: '625', upl: '3', lst: '0' }
const reply = request => {
  if (request.apiId === 'ka20006') return { inds_dt_pole_qry: [{ dt: '20261008' }] }
  if (request.apiId === 'ka20001') return quote
  return { body: { inds_netprps: [
    { inds_cd: '002', frgnr_netprps: '999999', orgn_netprps: '999999' },
    { inds_cd: request.body.mrkt_tp === '0' ? '001' : '101', frgnr_netprps: '-20811', orgn_netprps: '+818' },
  ] }, contYn: 'N' }
}
const create = options => createMarketSummary({ now: () => fixedNow, pause: async () => {}, ...options })

test('휴장일의 최근 거래일, KRX 범위, 거래대금 백만원 및 수급 억원 단위를 구분한다', async () => {
  const calls = []
  const result = await create()({ cacheScope: 'operator', requester: async request => { calls.push(request); return reply(request) } })
  assert.equal(result.markets.length, 2)
  assert.equal(result.markets[0].asOf, '2026-10-08')
  assert.equal(result.markets[0].turnoverWon, 24_376_305_000_000)
  assert.equal(result.markets[0].foreignNetBuyWon, -2_081_100_000_000)
  assert.equal(result.markets[1].institutionNetBuyWon, 81_800_000_000)
  assert.deepEqual(calls.filter(r => r.apiId === 'ka10051').map(r => r.body), [
    { mrkt_tp: '0', amt_qty_tp: '0', stex_tp: '1', base_dt: '20261008' },
    { mrkt_tp: '1', amt_qty_tp: '0', stex_tp: '1', base_dt: '20261008' },
  ])
  assert.ok(calls.every(r => r.timeoutMs === 15_000))
})

test('상하한 종목 수를 중복 합산하지 않고 결측값과 0을 구분한다', () => {
  const normalized = normalizeMarketQuote(quote)
  assert.deepEqual(normalized.breadth, { rising: 252, unchanged: 40, falling: 625, upperLimit: 3, lowerLimit: 0 })
  assert.equal(normalized.breadth.rising + normalized.breadth.unchanged + normalized.breadth.falling, 917)
  assert.equal(normalizeMarketQuote({ trde_prica: '', rising: '-1', stdns: '0' }).turnoverWon, null)
  assert.equal(normalizeMarketQuote({ rising: '-1', stdns: '0' }).breadth.rising, null)
  assert.equal(normalizeMarketQuote({ stdns: '0' }).breadth.unchanged, 0)
})

test('시장 종합 수급을 연속조회에서 찾고 업종별 값을 더하지 않는다', async () => {
  const get = create()
  const data = await get({ cacheScope: 'u', requester: async request => {
    if (request.apiId !== 'ka10051' || request.nextKey) return reply(request)
    return { body: { inds_netprps: [{ inds_cd: '002', frgnr_netprps: '999' }] }, contYn: 'Y', nextKey: 'next' }
  } })
  assert.equal(data.markets[0].foreignNetBuyWon, -2_081_100_000_000)
})

test('부분 조회 실패에도 다른 시장 데이터는 유지하며 빈 금액은 0으로 만들지 않는다', async () => {
  const data = await create()({ cacheScope: 'u', requester: async request => {
    if (request.apiId === 'ka20001' && request.body.mrkt_tp === '0') throw new Error('network')
    if (request.apiId === 'ka10051' && request.body.mrkt_tp === '1') return { body: { inds_netprps: [{ inds_cd: '101', frgnr_netprps: '', orgn_netprps: '0' }] } }
    return reply(request)
  } })
  assert.equal(data.markets[0].turnoverWon, null)
  assert.ok(data.markets[0].quoteError)
  assert.equal(data.markets[0].foreignNetBuyWon, -2_081_100_000_000)
  assert.ok(data.markets[1].turnoverWon > 0)
  assert.equal(data.markets[1].foreignNetBuyWon, null)
  assert.equal(data.markets[1].institutionNetBuyWon, 0)
  assert.ok(data.markets[1].flowError)
})

test('기준 거래일 실패나 잘못된 종합 코드에는 가짜 수급을 표시하지 않는다', async () => {
  let flowCalls = 0
  const data = await create()({ cacheScope: 'u', requester: async request => {
    if (request.apiId === 'ka20006' && request.body.inds_cd === '001') return { inds_dt_pole_qry: [] }
    if (request.apiId === 'ka10051') { flowCalls++; return { body: { inds_netprps: [{ inds_cd: '101_AL', frgnr_netprps: '10' }] }, contYn: 'Y', nextKey: 'repeat' } }
    return reply(request)
  } })
  assert.equal(data.markets[0].asOf, null)
  assert.equal(data.markets[0].foreignNetBuyWon, null)
  assert.equal(data.markets[1].foreignNetBuyWon, null)
  assert.equal(flowCalls, 2)
})

test('동시 요청 병합 및 사용자와 키 버전별 캐시 분리, 만료 후 재조회', async () => {
  let clock = fixedNow, calls = 0
  const get = create({ now: () => clock })
  const requester = async request => { calls++; return reply(request) }
  await Promise.all([get({ requester, cacheScope: 'operator' }), get({ requester, cacheScope: 'operator' })])
  assert.equal(calls, 6)
  await get({ requester, cacheScope: 'user:u:key1' })
  await get({ requester, cacheScope: 'user:u:key2' })
  assert.equal(calls, 18)
  clock += 30_001
  await get({ requester, cacheScope: 'operator' })
  assert.equal(calls, 24)
})

test('시장 요약과 장 상태 경로가 모두 동일한 관리자/개인 인증 정책을 사용한다', async t => {
  const app = Fastify()
  t.after(() => app.close())
  const context = createMarketRequestContext({ operator: async () => 'operator', personal: async () => 'personal', authenticate: async request => {
    if (request.headers.authorization === 'Bearer expired') throw Object.assign(new Error('secret error'), { statusCode: 401 })
    const configured = request.headers.authorization === 'Bearer personal'
    return { user: { id: 'u' }, status: { kiwoomConfigured: configured }, credentials: configured ? { kiwoomAppKey: 'personal-key', kiwoomSecretKey: 'personal-secret' } : {} }
  } })
  const read = async auth => ({ caller: await auth.requester({}) })
  registerMarketSummaryRoutes(app, { context, getSummary: read, sessions: { get: read, close() {} } })
  for (const path of ['summary', 'session']) {
    for (const [token, caller] of [['', 'operator'], ['no-key', 'operator'], ['personal', 'personal']]) {
      const response = await app.inject({ url: `/api/public/market/kiwoom/${path}`, headers: token ? { authorization: `Bearer ${token}` } : {} })
      assert.equal(response.json().caller, caller)
      assert.equal(response.headers['cache-control'], 'private, no-store')
      assert.ok(!response.body.includes('personal-secret'))
    }
    const failed = await app.inject({ url: `/api/public/market/kiwoom/${path}`, headers: { authorization: 'Bearer expired' } })
    assert.equal(failed.statusCode, 401)
    assert.ok(!failed.body.includes('secret error'))
  }
})
