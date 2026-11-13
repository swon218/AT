import test from 'node:test'
import assert from 'node:assert/strict'
import { createAddedBrokerData } from './addedBrokerData.js'

const auth = { appKey: 'fixture-key', secretKey: 'fixture-secret' }
const now = () => Date.parse('2026-11-13T16:00:00Z')
const nhRow = (date = '20261113', clock = '090000', overrides = {}) => ({ bsop_date: date, bsop_time: clock, stck_oprc: '100.50', stck_hgpr: '120', stck_lwpr: '90', stck_prpr: '110', vol: '200', ...overrides })
const kbRow = (date = '20261113', clock = '090000', overrides = {}) => ({ dt: date, tm: clock, opn_prc_p2: '100.50', hgh_prc_p2: '120', lw_prc_p2: '90', cls_prc_p2: '110', vlm: '200', ...overrides })

function fixture({ nhRows = [nhRow()], kbRows = [kbRow()] } = {}) {
  const calls = []
  const data = createAddedBrokerData({ now,
    nh: { request: async (credentials, path, input, options) => {
      calls.push({ broker: 'nh', credentials, path, input, options })
      return path.endsWith('currentPrice') ? { Output_0: { mrkt_div_isnm: '코스닥' } } : { Output_1: nhRows }
    } },
    kb: { request: async (credentials, path, input, options) => {
      calls.push({ broker: 'kb', credentials, path, input, options })
      return path === 'ivu10140' ? { mkt_clsf_nm: '코스닥' } : { out2: kbRows }
    } },
  })
  return { data, calls }
}

test('NH and KB request each minute interval directly without aggregating or shifting provider timestamps', async () => {
  for (const broker of ['nh', 'kb']) for (const minutes of [1, 5, 10, 15, 30, 60]) {
    const { data, calls } = fixture()
    const { items, meta } = await data.candleResponse(broker, '035900', `${minutes}분`, 1, auth)
    const input = calls.at(-1).input
    assert.equal(broker === 'nh' ? input.xtick : input.minute_tck_indx, String(minutes))
    assert.equal(broker === 'nh' ? input.gubun : input.chrt_clsf, broker === 'nh' ? '5' : 'B')
    assert.equal(broker === 'nh' ? input.mrkt_div_cls_code : input.mkt_clsf, broker === 'nh' ? '4' : '1')
    assert.equal(items[0].time, Date.parse('2026-11-13T09:00:00+09:00') / 1_000)
    assert.equal(items[0].open, 100.5)
    assert.equal(items[0].volume, 200)
    assert.equal(meta.aggregated, false)
    assert.equal(meta.timestampMeaning, 'provider')
    assert.equal(meta.fullDay, false)
    assert.equal(meta.timeZone, 'Asia/Seoul')
    assert.equal(meta.requestedInterval, `${minutes}분`)
    assert.equal((await data.candles(broker, '035900', `${minutes}분`, 1, auth))[0].time, '2026-11-13T09:00:00+09:00')
  }
})

test('NH requests KRX/NXT/UNT and regular/all sessions independently and keys the cache by both', async () => {
  const { data, calls } = fixture()
  const signal = new AbortController().signal
  for (const [market, code] of [['KRX', 'KRX'], ['NXT', 'NXT'], ['INTEGRATED', 'UNT']]) for (const includeExtended of [false, true]) {
    const result = await data.candleResponse('nh', '035900', '1분', 1, auth, { market, includeExtended, signal })
    const quote = calls.at(-2), chart = calls.at(-1)
    assert.equal(quote.input.market_cd, code)
    assert.equal(chart.input.market_cd, code)
    assert.equal(chart.input.view_main_yn, includeExtended ? 'N' : 'Y')
    assert.equal(chart.input.today_cls_code, '0')
    assert.equal(chart.input.edate, '20261114')
    assert.equal(chart.input.sur_flag, '0')
    assert.equal(chart.options.signal, quote.options.signal)
    assert.equal(chart.options.signal.aborted, false)
    assert.equal(result.meta.market, market)
    assert.equal(result.meta.sessionCoverage, includeExtended ? 'all-requested' : 'regular-requested')
    assert.equal(result.meta.partial, false)
  }
  assert.equal(calls.length, 12)
  await data.candleResponse('nh', '035900', '1분', 1, auth, { market: 'INTEGRATED', includeExtended: true })
  assert.equal(calls.length, 12)
  await data.candleResponse('nh', '035900', '1분', 1, { ...auth, secretKey: 'different' }, { market: 'INTEGRATED', includeExtended: true })
  assert.equal(calls.length, 14)
})

test('NH defaults remain regular KRX while KB count mode has no invented end-date, exchange or session fields', async () => {
  const { data, calls } = fixture()
  const nh = await data.candleResponse('nh', '035900', '1분', 3, auth)
  assert.equal(calls.at(-1).input.market_cd, 'KRX')
  assert.equal(calls.at(-1).input.view_main_yn, 'Y')
  assert.equal(nh.meta.partial, true)
  assert.equal(nh.meta.partialReason, 'requested-count-unavailable')
  const kb = await data.candleResponse('kb', '035900', '1분', 3, auth)
  assert.deepEqual(Object.keys(calls.at(-1).input).sort(), ['chrt_clsf', 'info_ccd', 'inq_clsf', 'inq_cnt', 'is_cd', 'minute_tck_indx', 'mkt_clsf'].sort())
  assert.equal(calls.at(-1).input.inq_clsf, '2')
  assert.equal(calls.at(-1).input.inq_cnt, '3')
  assert.equal(kb.meta.market, 'PROVIDER')
  assert.equal(kb.meta.sessionCoverage, 'provider-defined-unverified')
  assert.deepEqual(kb.meta.supportedMarkets, [])
  assert.equal(kb.meta.hasMore, null)
  assert.equal(kb.meta.pagesFetched, 1)
  assert.equal(kb.meta.fullDay, false)
  const before = calls.length
  for (const options of [{ market: 'KRX' }, { market: 'NXT' }, { market: 'INTEGRATED' }, { includeExtended: true }, { includeExtended: false }]) await assert.rejects(data.candleResponse('kb', '035900', '1분', 3, auth, options), { statusCode: 400 })
  assert.equal(calls.length, before)
})

test('minute normalization retains real midnight and cross-date bars, drops malformed dates and never fabricates midnight from a missing clock', async () => {
  const { data } = fixture({ nhRows: [
    nhRow('20261114', '0000'), nhRow('20261113', '235900'), nhRow('20261114', '000000'),
    nhRow('20260230', '090000'), nhRow('20261113', ''), nhRow('20261113', '246000'),
    nhRow('20261113', '090000', { stck_hgpr: '95' }),
  ] })
  const { items, meta } = await data.candleResponse('nh', '005930', '1분', 10, auth)
  assert.deepEqual(items.map(row => row.time), ['2026-11-13T23:59:00+09:00', '2026-11-14T00:00:00+09:00'].map(value => Date.parse(value) / 1_000))
  assert.equal(meta.returnedCount, 2)
  assert.equal(meta.receivedCount, 7)
  assert.equal(meta.partial, true)
})

test('daily, weekly and monthly chart dates stay sessionless for each broker', async () => {
  for (const broker of ['nh', 'kb']) for (const interval of ['일', '주', '월']) {
    const { data } = fixture({ nhRows: [nhRow('20261113', '')], kbRows: [kbRow('20261113', '')] })
    const result = await data.candleResponse(broker, '005930', interval, 1, auth)
    assert.equal(result.items[0].time, '2026-11-13')
    assert.equal(result.meta.timestampMeaning, 'date')
    assert.equal((await data.candles(broker, '005930', interval, 1, auth))[0].time, '2026-11-13')
  }
})

test('NH follows only advertised continuations, de-duplicates overlaps and stops when the requested recent count is present', async () => {
  const calls = []
  const data = createAddedBrokerData({ now, nh: { request: async (_auth, path, input, options) => {
    if (path.endsWith('currentPrice')) return { Output_0: { mrkt_div_isnm: '코스피' } }
    calls.push({ input, options })
    return options.cts ? { Output_1: [nhRow('20261113', '090100'), nhRow('20261113', '090000')], hasMore: true, continuation: 'later' }
      : { Output_1: [nhRow('20261113', '090200'), nhRow('20261113', '090100')], hasMore: true, continuation: 'page2' }
  } } })
  const result = await data.candleResponse('nh', '005930', '1분', 3, auth)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].options.cts, 'page2')
  assert.deepEqual(calls[0].input, calls[1].input)
  assert.equal(result.items.length, 3)
  assert.equal(new Set(result.items.map(row => row.time)).size, 3)
  assert.equal(result.meta.pagesFetched, 2)
  assert.equal(result.meta.hasMore, true)
  assert.equal(result.meta.partial, false)
})

test('NH repeated or missing continuation and the page cap return honest bounded partial metadata', async () => {
  for (const kind of ['repeated', 'missing', 'cap']) {
    let pages = 0
    const data = createAddedBrokerData({ now, nh: { request: async (_auth, path) => {
      if (path.endsWith('currentPrice')) return { Output_0: { mrkt_div_isnm: '코스피' } }
      pages++
      return { Output_1: [nhRow('20261113', `09${String(pages).padStart(2, '0')}00`)], hasMore: true, continuation: kind === 'missing' ? '' : kind === 'repeated' ? 'same' : `page${pages}` }
    } } })
    const result = await data.candleResponse('nh', '005930', '1분', 20, auth)
    assert.equal(pages, kind === 'missing' ? 1 : kind === 'repeated' ? 2 : 10)
    assert.equal(result.meta.partial, true)
    assert.equal(result.meta.partialReason, kind === 'missing' ? 'continuation-missing' : kind === 'repeated' ? 'continuation-repeated' : 'page-limit')
    assert.equal(result.meta.hasMore, true)
    assert.equal(result.meta.fullDay, false)
  }
})

test('count is bounded and invalid inputs or already-cancelled requests never call a broker', async () => {
  const { data, calls } = fixture()
  const capped = await data.candleResponse('kb', '005930', '1분', 501, auth)
  assert.equal(calls.at(-1).input.inq_cnt, '500')
  assert.equal(capped.meta.requestedLimit, 501)
  assert.equal(capped.meta.effectiveLimit, 500)
  assert.equal(capped.meta.partialReason, 'count-limit')
  const before = calls.length
  for (const limit of [0, -1, 1.5, Infinity, 'invalid']) await assert.rejects(data.candleResponse('nh', '005930', '1분', limit, auth), { statusCode: 400 })
  await assert.rejects(data.candleResponse('nh', '005930', '2분', 1, auth), { statusCode: 400 })
  await assert.rejects(data.candleResponse('nh', '005930', '1분', 1, auth, { market: 'SOR' }), { statusCode: 400 })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(data.candleResponse('nh', '005930', '1분', 1, auth, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls.length, before)
})

test('successful empty arrays remain empty chart responses and malformed nonempty rows report invalid data separately', async () => {
  for (const broker of ['nh', 'kb']) {
    const empty = fixture({ nhRows: [], kbRows: [] })
    const result = await empty.data.candleResponse(broker, '005930', '1분', 10, auth)
    assert.deepEqual(result.items, [])
    assert.deepEqual(await empty.data.candles(broker, '005930', '1분', 10, auth), [])
    assert.equal(result.meta.returnedCount, 0)
    assert.equal(result.meta.receivedCount, 0)
    assert.equal(result.meta.invalidRowCount, 0)
    assert.equal(result.meta.earliestTime, null)
    assert.equal(result.meta.latestTime, null)
    assert.equal(result.meta.partialReason, 'requested-count-unavailable')
    const invalid = fixture({ nhRows: [null, nhRow('20261113', '')], kbRows: [null, kbRow('20261113', '')] })
    const malformed = await invalid.data.candleResponse(broker, '005930', '1분', 10, auth)
    assert.deepEqual(malformed.items, [])
    assert.equal(malformed.meta.receivedCount, 2)
    assert.equal(malformed.meta.invalidRowCount, 2)
    assert.equal(malformed.meta.partial, true)
    assert.equal(malformed.meta.partialReason, 'invalid-rows')
  }
})

test('NH later-page failures preserve successful rows while initial chart failure still rejects', async () => {
  for (const kind of ['transport', 'shape']) {
    let pages = 0
    const data = createAddedBrokerData({ now, nh: { request: async (_auth, path) => {
      if (path.endsWith('currentPrice')) return { Output_0: { mrkt_div_isnm: '코스피' } }
      pages++
      if (pages % 2) return { Output_1: [nhRow()], hasMore: true, continuation: 'next' }
      if (kind === 'shape') return { Output_1: null }
      throw new Error('fixture failure')
    } } })
    const result = await data.candleResponse('nh', '005930', '1분', 10, auth)
    assert.equal(result.items.length, 1)
    assert.equal(result.meta.partialReason, 'continuation-page-failed')
    assert.equal(result.meta.pagesFetched, 1)
    assert.equal(result.meta.hasMore, true)
    await data.candleResponse('nh', '005930', '1분', 10, auth)
    assert.equal(pages, 4, 'transient continuation failures must be retried instead of cached')
  }
  const failed = createAddedBrokerData({ now, nh: { request: async (_auth, path) => {
    if (path.endsWith('currentPrice')) return { Output_0: { mrkt_div_isnm: '코스피' } }
    throw new Error('first chart page failed')
  } } })
  await assert.rejects(failed.candleResponse('nh', '005930', '1분', 10, auth), /first chart page failed/)
})

test('one deadline covers quote/token waits and every continuation, even if the underlying request ignores cancellation', async () => {
  const blockedQuote = createAddedBrokerData({ now, chartTimeoutMs: 5, kb: { request: () => new Promise(() => {}) } })
  await assert.rejects(blockedQuote.candleResponse('kb', '005930', '1분', 1, auth), { statusCode: 504 })
  let quoteSignal, chartSignal, pageSignal
  const laterDeadline = createAddedBrokerData({ now, chartTimeoutMs: 5, nh: { request: async (_auth, path, _input, options) => {
    if (path.endsWith('currentPrice')) { quoteSignal = options.signal; return { Output_0: { mrkt_div_isnm: '코스피' } } }
    if (!options.cts) { chartSignal = options.signal; return { Output_1: [nhRow()], hasMore: true, continuation: 'next' } }
    pageSignal = options.signal
    return new Promise(() => {})
  } } })
  const result = await laterDeadline.candleResponse('nh', '005930', '1분', 10, auth)
  assert.equal(result.items.length, 1)
  assert.equal(result.meta.partialReason, 'deadline-exceeded')
  assert.equal(quoteSignal, chartSignal)
  assert.equal(chartSignal, pageSignal)
  assert.equal(pageSignal.aborted, true)
})

test('caller cancellation propagates through the shared request signal instead of returning a partial success', async () => {
  const controller = new AbortController()
  let nextPageStarted
  const nextPage = new Promise(resolve => { nextPageStarted = resolve })
  let observedSignal
  const data = createAddedBrokerData({ now, nh: { request: async (_auth, path, _input, options) => {
    if (path.endsWith('currentPrice')) return { Output_0: { mrkt_div_isnm: '코스피' } }
    if (!options.cts) return { Output_1: [nhRow()], hasMore: true, continuation: 'next' }
    observedSignal = options.signal
    nextPageStarted()
    return new Promise(() => {})
  } } })
  const result = data.candleResponse('nh', '005930', '1분', 10, auth, { signal: controller.signal })
  await nextPage
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(observedSignal.aborted, true)
})

test('same-owner requests share work while identical credentials in different cache scopes never share results', async () => {
  let releaseQuote
  const quoteGate = new Promise(resolve => { releaseQuote = resolve })
  const calls = []
  const data = createAddedBrokerData({ now, kb: { request: async (_auth, path) => {
    calls.push(path)
    if (path === 'ivu10140') { await quoteGate; return { mkt_clsf_nm: '코스피' } }
    return { out2: [kbRow()] }
  } } })
  const first = data.candleResponse('kb', '005930', '1분', 1, auth, { cacheScope: 'user:one' })
  const sameOwner = data.candleResponse('kb', '005930', '1분', 1, auth, { cacheScope: 'user:one' })
  const secondOwner = data.candleResponse('kb', '005930', '1분', 1, auth, { cacheScope: 'user:two' })
  releaseQuote()
  const results = await Promise.all([first, sameOwner, secondOwner])
  assert.equal(calls.filter(path => path === 'ivu10140').length, 2)
  assert.equal(calls.filter(path => path === 'ivs11560').length, 2)
  assert.equal(results[0], results[1])
  assert.notEqual(results[0], results[2])
  await data.candleResponse('kb', '005930', '1분', 1, auth, { cacheScope: 'user:one' })
  assert.equal(calls.length, 4)
  await data.candleResponse('kb', '005930', '1분', 1, auth, { cacheScope: 'operator' })
  assert.equal(calls.length, 6)
})
