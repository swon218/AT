import assert from 'node:assert/strict'
import test from 'node:test'
import { chartDefinition, createKiwoomChartService, normalizeTime } from './charts.js'

const fixedNow = () => Date.parse('2026-11-14T00:30:00+09:00')
const seconds = iso => Date.parse(iso) / 1000
const row = (stamp, overrides = {}) => ({
  cntr_tm: stamp, dt: stamp.slice(0, 8),
  open_pric: '+100', high_pric: '-120', low_pric: '+90', cur_prc: '-110', trde_qty: '1,000', ...overrides,
})
const page = (rows, contYn = 'N', nextKey = '', key = 'stk_min_pole_chart_qry') => ({ body: { [key]: rows }, contYn, nextKey })
const create = requester => createKiwoomChartService({ requester, now: fixedNow })

test('키움 compact 시각을 한국시간 실제 instant로 보존하고 잘못된 날짜와 시각은 거부한다', () => {
  const normalized = normalizeTime('20261113090500')
  assert.equal(normalized, '2026-11-13T09:05:00+09:00')
  assert.equal(Date.parse(normalized), Date.parse('2026-11-13T00:05:00Z'))
  assert.equal(normalizeTime('20261113'), '2026-11-13')
  assert.equal(normalizeTime('20240229'), '2024-02-29')
  for (const invalid of ['', '20260229', '20261131', '20261113246000', '20261113096000', '20261113090560', '202611130905', '20261113090500000', '2026-11-13T00:05:00Z']) {
    assert.equal(normalizeTime(invalid), '', invalid)
  }
})

test('1/5/10/15/30/60분은 선택한 키움 native tic_scope를 사용한다', async () => {
  for (const minutes of [1, 5, 10, 15, 30, 60]) {
    const calls = []
    const result = await create(async request => { calls.push(request); return page([row('20261113090500')]) }).getCandleResponse('005930', `${minutes}분`, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].apiId, 'ka10080')
    assert.equal(calls[0].endpoint, '/api/dostk/chart')
    assert.deepEqual(calls[0].body, { stk_cd: '005930', tic_scope: String(minutes), upd_stkpc_tp: '1' })
    assert.equal(calls[0].returnPage, true)
    assert.equal(calls[0].contYn, 'N')
    assert.ok(calls[0].signal instanceof AbortSignal)
    assert.equal(result.items[0].time, seconds('2026-11-13T00:05:00Z'))
    assert.equal(result.meta.requestedInterval, `${minutes}분`)
    assert.equal(result.meta.timestampMeaning, 'start')
  }
})

test('KRX/NXT/통합 시장별 공식 접미사를 사용하고 정규장 밖의 실제 봉을 제거하지 않는다', async () => {
  for (const [market, suffix] of [['KRX', ''], ['NXT', '_NX'], ['INTEGRATED', '_AL']]) {
    const result = await create(async request => {
      assert.equal(request.body.stk_cd, `005930${suffix}`)
      return page([row('20261113195900'), row('20261113080000'), row('20261113153000')])
    }).getCandleResponse('005930', '1분', 200, { market })
    assert.deepEqual(result.items.map(item => item.time), ['2026-11-13T08:00:00+09:00', '2026-11-13T15:30:00+09:00', '2026-11-13T19:59:00+09:00'].map(seconds))
    assert.equal(result.meta.market, market)
    assert.equal(result.meta.sessionCoverage, 'provider-defined-unverified')
    assert.equal(result.meta.fullDay, false)
  }
})

test('일주월봉은 날짜를 보존하고 각 TR/list를 사용하며 기준일자는 KST 날짜다', async () => {
  for (const [interval, apiId, listKey] of [['일', 'ka10081', 'stk_dt_pole_chart_qry'], ['주', 'ka10082', 'stk_stk_pole_chart_qry'], ['월', 'ka10083', 'stk_mth_pole_chart_qry']]) {
    const result = await create(async request => {
      assert.equal(request.apiId, apiId)
      assert.deepEqual(request.body, { stk_cd: '005930', base_dt: '20261114', upd_stkpc_tp: '1' })
      return page([row('20261113090500'), row('20261112090500')], 'N', '', listKey)
    }).getCandleResponse('005930', interval)
    assert.deepEqual(result.items.map(item => item.time), ['2026-11-12', '2026-11-13'])
    assert.equal(result.meta.timestampMeaning, 'date')
  }
})

test('분봉은 날짜보다 cntr_tm을 사용하고 유효하지 않은 시각/OHLC는 합성하지 않는다', async () => {
  const result = await create(async () => page([
    row('20261113090500'),
    row('20261113090600', { trde_qty: '' }),
    row('20261113090700', { trde_qty: '0' }),
    row('20261113246000'), row('20260229090500'),
    row('20261113090800', { cntr_tm: '', dt: '20261113' }),
    row('20261113090900', { open_pric: 'NaN' }),
    row('20261113091000', { low_pric: '150' }),
    row('20261113091100', { high_pric: '99' }),
  ])).getCandleResponse('005930', '5분')
  assert.equal(result.items.length, 3)
  assert.deepEqual(result.items[0], { time: seconds('2026-11-13T00:05:00Z'), open: 100, high: 120, low: 90, close: 110, volume: 1000 })
  assert.equal(result.items[1].volume, null)
  assert.equal(result.items[2].volume, 0)
  assert.equal(result.meta.invalidRows, 6)
  assert.equal(result.meta.partial, true)
  assert.equal(result.meta.partialReason, 'invalid-rows')
})

test('연속 조회는 응답 헤더 키를 그대로 전달하고 중복을 제거해 최근 N봉으로 자른다', async () => {
  const calls = []
  const get = create(async request => {
    calls.push(request)
    if (calls.length === 1) return page([row('20261113091000'), row('20261113090900')], 'Y', 'opaque-next-key')
    assert.equal(request.contYn, 'Y')
    assert.equal(request.nextKey, 'opaque-next-key')
    return page([row('20261113090900', { cur_prc: '115' }), row('20261113090800'), row('20261113090700')], 'Y', 'older')
  })
  const result = await get.getCandleResponse('005930', '1분', 3)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].signal, calls[1].signal, '연속 페이지도 같은 전체 요청 제한 signal을 사용한다')
  assert.deepEqual(result.items.map(item => item.time), ['2026-11-13T09:08:00+09:00', '2026-11-13T09:09:00+09:00', '2026-11-13T09:10:00+09:00'].map(seconds))
  assert.equal(result.items[1].close, 110)
  assert.equal(result.meta.requestedLimit, 3)
  assert.equal(result.meta.returnedCount, 3)
  assert.equal(result.meta.rangeMode, 'recent')
  assert.equal(result.meta.fullDay, false)
  assert.equal(result.meta.pagesFetched, 2)
  assert.equal(result.meta.hasMore, true)
  assert.equal(result.meta.countLimited, true)
  assert.equal(result.meta.partial, false)
})

test('3페이지 상한, 반복 연속키, 데이터 진전 없음, 빈 연속 응답을 명시한다', async () => {
  let calls = 0
  const bounded = await create(async () => {
    calls++
    return page([row(`20261113090${10 - calls}00`)], 'Y', `page-${calls}`)
  }).getCandleResponse('005930', '1분', 200)
  assert.equal(calls, 3)
  assert.equal(bounded.meta.partialReason, 'page-limit')
  assert.equal(bounded.meta.hasMore, true)

  calls = 0
  const repeated = await create(async () => page([row(`20261113090${9 - calls++}00`)], 'Y', 'same')).getCandleResponse('005930', '1분')
  assert.equal(calls, 2)
  assert.equal(repeated.meta.partialReason, 'continuation-stalled')

  calls = 0
  const stalled = await create(async () => page([row('20261113090000')], 'Y', `key-${calls++}`)).getCandleResponse('005930', '1분')
  assert.equal(calls, 2)
  assert.equal(stalled.meta.partialReason, 'no-progress')

  const empty = await create(async () => page([], 'Y', 'key')).getCandleResponse('005930', '1분')
  assert.equal(empty.meta.partialReason, 'empty-continuation')
  assert.equal(empty.meta.pagesFetched, 1)
})

test('기존 payload requester와 array getCandles는 호환되며 연속조회 정보 누락을 숨기지 않는다', async () => {
  const service = create(async () => ({ stk_min_pole_chart_qry: [row('20261113090000')] }))
  const response = await service.getCandleResponse('005930', '1분')
  assert.equal(response.meta.hasMore, null)
  assert.equal(response.meta.partial, true)
  assert.equal(response.meta.partialReason, 'continuation-unknown')
  assert.deepEqual(await service.getCandles('005930', '1분'), response.items)
  const empty = await create(async () => page([])).getCandleResponse('005930', '1분')
  assert.deepEqual(empty.items, [])
  assert.equal(empty.meta.hasMore, false)
  assert.equal(empty.meta.exhausted, true)
  assert.equal(empty.meta.partial, false)
  assert.equal(empty.meta.firstTime, null)
  const terminal = await create(async () => page([row('20261113090000')], null)).getCandleResponse('005930', '1분')
  assert.equal(terminal.meta.hasMore, false)
  assert.equal(terminal.meta.partial, false)
  const emptyHeader = await create(async () => page([row('20261113090000')], '')).getCandleResponse('005930', '1분')
  assert.equal(emptyHeader.meta.exhausted, true)
  assert.equal(emptyHeader.meta.partial, false)
})

test('사용자/키 버전, 시장, 주기, 개수, 수정주가와 조회 옵션으로 캐시를 분리한다', async () => {
  let time = fixedNow(), calls = 0
  const service = createKiwoomChartService({ now: () => time, ttl: 1000, requester: async request => { calls++; return page([row('20261113090000')], 'N', '', request.apiId === 'ka10081' ? 'stk_dt_pole_chart_qry' : 'stk_min_pole_chart_qry') } })
  const options = { cacheScope: 'user:one:key-v1' }
  await Promise.all([service.getCandleResponse('005930', '1분', 2, options), service.getCandleResponse('005930', '1분', 2, options)])
  assert.equal(calls, 1)
  for (const changed of [{ cacheScope: 'user:two:key-v1' }, { cacheScope: 'user:one:key-v2' }, { market: 'NXT' }, { market: 'INTEGRATED' }, { adjusted: false }, { baseDate: '20261112' }, { maxPages: 1 }]) {
    await service.getCandleResponse('005930', '1분', 2, { ...options, ...changed })
  }
  await service.getCandleResponse('005930', '5분', 2, options)
  await service.getCandleResponse('005930', '1분', 3, options)
  assert.equal(calls, 10)
  const result = await service.getCandleResponse('005930', '1분', 2, options)
  result.items[0].close = 999
  assert.equal((await service.getCandleResponse('005930', '1분', 2, options)).items[0].close, 110)
  assert.equal(calls, 10)
  time += 1001
  await service.getCandleResponse('005930', '1분', 2, options)
  assert.equal(calls, 11)
})

test('조회 실패와 취소는 캐시하지 않고 개인 요청을 운영자 인증으로 재시도하지 않는다', async () => {
  let calls = 0
  const service = create(async () => { calls++; if (calls === 1) throw new Error('개인 키 인증 실패'); return page([row('20261113090000')]) })
  const options = { cacheScope: 'user:one:personal-key' }
  await assert.rejects(service.getCandleResponse('005930', '1분', 200, options), /개인 키 인증 실패/)
  assert.equal(calls, 1)
  assert.equal((await service.getCandles('005930', '1분', 200, options)).length, 1)
  assert.equal(calls, 2)
  await assert.rejects(createKiwoomChartService().getCandles('005930', '1분', 200, options), { statusCode: 401 })

  const controller = new AbortController()
  let abortCalls = 0
  const abortable = create(async () => { abortCalls++; controller.abort(); return page([row('20261113090000')]) })
  await assert.rejects(abortable.getCandleResponse('005930', '1분', 200, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal((await abortable.getCandles('005930', '1분')).length, 1)
  assert.equal(abortCalls, 2)
})

test('후속 페이지 실패는 일부 봉을 성공으로 반환하지 않고 다음 조회에서 처음부터 다시 시작한다', async () => {
  const calls = []
  let failContinuation = true
  const service = create(async request => {
    calls.push(request.nextKey)
    if (!request.nextKey) return page([row('20261113090100')], 'Y', 'older')
    if (failContinuation) throw new Error('후속 페이지 조회 실패')
    return page([row('20261113090000')])
  })
  await assert.rejects(service.getCandleResponse('005930', '1분', 2), /후속 페이지 조회 실패/)
  failContinuation = false
  const response = await service.getCandleResponse('005930', '1분', 2)
  assert.deepEqual(calls, ['', 'older', '', 'older'])
  assert.equal(response.items.length, 2)
  assert.equal(response.meta.partial, false)
})

test('잘못된 입력과 누락된 봉 목록은 외부 호출이나 성공 캐시로 이어지지 않는다', async () => {
  let calls = 0
  const service = create(async () => { calls++; return {} })
  for (const [symbol, interval, limit, options] of [
    ['bad', '1분', 200, {}], ['005930_AL', '1분', 200, {}], ['005930', '2분', 200, {}],
    ['005930', '1분', 0, {}], ['005930', '1분', 501, {}], ['005930', '1분', 1.5, {}],
    ['005930', '1분', 200, { market: 'SOR' }], ['005930', '1분', 200, { maxPages: 4 }],
    ['005930', '1분', 200, { baseDate: '20260229' }], ['005930', '1분', 200, { adjusted: 'false' }],
  ]) await assert.rejects(service.getCandleResponse(symbol, interval, limit, options), { statusCode: 400 })
  assert.equal(calls, 0)
  await assert.rejects(service.getCandleResponse('005930', '1분'), { statusCode: 502 })
  await assert.rejects(service.getCandleResponse('005930', '1분'), { statusCode: 502 })
  assert.equal(calls, 2)
  assert.equal(chartDefinition('005930', '일', { baseDate: '20261113' }).body.base_dt, '20261113')
})
