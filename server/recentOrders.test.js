import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { createRecentOrderHandlers, registerRecentOrderRoutes, sortRecentOrders } from './recentOrders.js'
import { createBrokerHistory, HISTORY_BROKERS, normalizeHistoryOrder } from './brokerOrderHistory.js'
import { createOrderCalendar } from './orderCalendar.js'
import { createKbClient } from './kbClient.js'

const days = ['2026-11-06', '2026-11-05', '2026-11-04', '2026-11-03', '2026-11-02']
const calendar = async () => ({ days, timezone: 'Asia/Seoul' })
const now = () => Date.parse('2026-11-06T23:00:00+09:00')
const account = (id = 'user-a', count = 4) => ({ user: { id }, status: Object.fromEntries(HISTORY_BROKERS.map((b, i) => [`${b}Configured`, i < count])),
  credentials: { kiwoomAppKey: 'personal-key', kiwoomSecretKey: 'personal-secret', tossApiKey: 'personal-toss', tossSecretKey: 'toss-secret', nhAppKey: 'personal-nh', nhSecretKey: 'nh-secret', kbAppKey: 'personal-kb', kbSecretKey: 'kb-secret' } })
const authenticate = async req => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token === 'expired') throw Object.assign(new Error('secret upstream error'), { statusCode: 401 })
  return account(token, /^\d$/.test(token) ? Number(token) : 4)
}
const request = (token = 'user-a', query = {}) => ({ headers: { authorization: `Bearer ${token}` }, query })
const makeOrder = (broker, ref = 'a'.repeat(32), day = days[0], id = '1', values = {}) => normalizeHistoryOrder(broker, ref, day, id, { symbol: '005930', quantity: 10, filledQuantity: 4, pending: true, ...values })

test('list AND detail reject guests and invalid sessions before calendar or ANY brokerage call', async t => {
  let brokerageCalls = 0, calendarCalls = 0
  const app = Fastify(); t.after(() => app.close())
  registerRecentOrderRoutes(app, createRecentOrderHandlers({ authenticate, calendar: async () => { calendarCalls++; return calendar() }, readBroker: async () => { brokerageCalls++; throw new Error('forbidden') } }))
  for (const path of ['/api/account/orders/recent', `/api/account/orders/recent/kiwoom/${'a'.repeat(64)}`]) {
    for (const token of ['', 'expired']) {
      const response = await app.inject({ url: path + '?brokers=kiwoom&userId=admin&kiwoomConfigured=true&accountId=12345678901', headers: token ? { authorization: `Bearer ${token}` } : {} })
      assert.equal(response.statusCode, 401)
      assert.equal(response.headers['cache-control'], 'private, no-store')
      assert.ok(!response.body.includes('secret'))
    }
  }
  assert.equal(brokerageCalls, 0); assert.equal(calendarCalls, 0)
})

test('all 16 selections query only selected registered brokers, including zero and partially configured users', async () => {
  const calls = []; let calendarCalls = 0, registrationMask = 0
  const handlers = createRecentOrderHandlers({ now, calendar: async () => { calendarCalls++; return calendar() }, authenticate: async () => {
    const a = account()
    for (const [i, broker] of HISTORY_BROKERS.entries()) a.status[`${broker}Configured`] = Boolean(registrationMask & (1 << i))
    return a
  }, readBroker: async broker => { calls.push(broker); return { status: 'ready', items: [makeOrder(broker)], accounts: [] } } })
  for (registrationMask = 0; registrationMask < 16; registrationMask++) for (let selectedMask = 0; selectedMask < 16; selectedMask++) {
    calls.length = 0; calendarCalls = 0
    const selected = HISTORY_BROKERS.filter((_, i) => selectedMask & (1 << i))
    const expected = HISTORY_BROKERS.filter((_, i) => selectedMask & registrationMask & (1 << i))
    const result = await handlers.list(request('user-a', { brokers: selected.join(',') }))
    assert.deepEqual(calls, expected)
    assert.deepEqual(result.brokers.map(b => b.broker), selected)
    assert.equal(calendarCalls, expected.length ? 1 : 0)
    assert.ok(result.brokers.every(b => b.status === (expected.includes(b.broker) ? 'ready' : 'unconfigured')))
  }
  calls.length = 0; calendarCalls = 0
  await assert.rejects(handlers.list(request('user-a', { brokers: 'unknown' })), { statusCode: 400 })
  assert.equal(calls.length, 0); assert.equal(calendarCalls, 0)
})

test('credentials are checked for each broker on every request; an unrelated missing key never blocks detail', async () => {
  let calls = 0, registered = true, authCalls = 0
  const handlers = createRecentOrderHandlers({ now, calendar, authenticate: async () => { authCalls++; const a = account(); if (!registered) delete a.credentials.kbSecretKey; return a },
    readBroker: async broker => { calls++; return { status: 'ready', items: [makeOrder(broker)], accounts: [] } } })
  const result = await handlers.list(request())
  assert.equal(calls, 4); assert.equal(result.items.length, 4)
  registered = false
  const partial = await handlers.list(request())
  assert.equal(calls, 7); assert.equal(partial.brokers.find(b => b.broker === 'kb').status, 'unconfigured')
  await assert.rejects(handlers.detail({ ...request(), params: { broker: 'kb', id: result.items[0].id } }), { statusCode: 403 })
  assert.equal(calls, 7)
  assert.equal((await handlers.detail({ ...request(), params: { broker: 'kiwoom', id: makeOrder('kiwoom').id } })).item.broker, 'kiwoom')
  assert.equal(calls, 8); assert.equal(authCalls, 4)
})

test('selected brokers use authenticated identity, latest FIVE are displayed oldest first, partial failure and all-empty stay distinct', async () => {
  const callers = []; let failed = '', empty = false
  const handlers = createRecentOrderHandlers({ authenticate, calendar, now, readBroker: async (broker, owner) => {
    callers.push([broker, owner.user.id]); if (failed === broker) throw new Error('token=secret account=12345678901')
    return { status: 'ready', accounts: [], items: empty ? [] : [1, 2, 3, 4].map(i => makeOrder(broker, 'a'.repeat(32), days[0], String(i), { orderedAt: `2026-11-06T09:00:0${i}+09:00` })) }
  } })
  const first = await handlers.list(request('alice', { userId: 'mallory' }))
  assert.equal(first.items.length, 5)
  assert.ok(first.items.every((row, i, rows) => !i || Date.parse(rows[i - 1].orderedAt) <= Date.parse(row.orderedAt)))
  assert.equal(first.items[0].orderedAt, '2026-11-06T09:00:03+09:00')
  assert.equal(first.items.at(-1).orderedAt, '2026-11-06T09:00:04+09:00')
  assert.deepEqual(callers.slice(0, 4), HISTORY_BROKERS.map(b => [b, 'alice']))
  failed = 'nh'
  const partial = await handlers.list(request('bob', { brokers: 'kiwoom,nh,toss' }))
  assert.equal(partial.brokers.find(b => b.broker === 'nh').status, 'error')
  assert.equal(partial.items.length, 5); assert.ok(!JSON.stringify(partial).includes('secret'))
  assert.ok(callers.slice(4).every(([broker, id]) => id === 'bob' && broker !== 'kb'))
  failed = ''; empty = true
  const zero = await handlers.list(request('user-a', { brokers: 'toss' }))
  assert.deepEqual(zero.items, []); assert.deepEqual(zero.brokers.map(b => [b.broker, b.status]), [['toss', 'ready']])
})

test('deadline records a broker failure; details cannot escape current authorized account or range', async () => {
  const item = makeOrder('kiwoom')
  const handlers = createRecentOrderHandlers({ authenticate, calendar, now, timeoutMs: 20,
    readBroker: async (broker, owner) => broker === 'kb' ? new Promise(() => {}) : { status: 'ready', accounts: [], items: owner.user.id === 'user-a' ? [item] : [] } })
  const result = await handlers.list(request())
  assert.equal(result.brokers.at(-1).error, 'timeout')
  assert.equal((await handlers.detail({ ...request(), params: { broker: 'kiwoom', id: item.id } })).item.id, item.id)
  await assert.rejects(handlers.detail({ ...request('user-b'), params: { broker: 'kiwoom', id: item.id } }), { statusCode: 404 })
})

// Fixtures below follow the official schemas. They are NOT real-account evidence.
const kiwoomRow = { ord_no: '0000001', stk_cd: 'A005930', stk_nm: '삼성전자', io_tp_nm: '현금매수', ord_tm: '09:30:00', ord_qty: '0000000010', cntr_qty: '0000000004', ord_uv: '70000', ord_remnq: '0', acpt_tp: '접수', ori_ord: '0000000' }
const nhRow = { itg_orr_no: 1, org_itg_orr_no: 0, iem_cd: '005930', iem_nm: '삼성전자', sby_dit_cd_nm: '매수', orr_qty: 10, tot_cns_qty: 4, cns_avg_uit_pr: 70000, can_qty: 6, ny_cns_qty: 0 }
const kbRow = { ordr_no: '0000000001', stnd_is_no: 'KR7005930003', hngl_shrt_nm: '삼성전자', trd_dl_ccd_nm: '현금매수', ordr_tm: '093000', ordr_q: '10', tl_ccls_q: '4', nccls_q: '0', sor_cncl_q: '6', ordr_uprc: '70000', ccls_uprc: '70000', ordr_ccd: '00' }
const tossRow = { orderId: 'opaque-order-id', symbol: '005930', side: 'BUY', orderType: 'LIMIT', status: 'CANCELED', price: '70000', quantity: '10', currency: 'KRW', orderedAt: '2026-11-06T09:30:00+09:00', execution: { filledQuantity: '4', averageFilledPrice: '70000', filledAmount: '280000', filledAt: '2026-11-06T09:31:00+09:00' } }

test('Kiwoom kt00007 + actual kt00009 fills: continuation duplicates, weighted average, cancellation child folded and day collision', async () => {
  const calls = []
  const read = createBrokerHistory({ pause: async () => {}, kiwoom: async def => {
    calls.push(def); assert.equal(def.appKey, 'personal-key'); assert.equal(def.body.dmst_stex_tp, '%')
    if (def.apiId === 'kt00007') return { body: { return_code: 0, acnt_ord_cntr_prps_dtl: [kiwoomRow, { ...kiwoomRow, ord_no: '2', ori_ord: '1', mdfy_cncl: '취소확인', cnfm_qty: '6', cntr_qty: '0' }] } }
    const fill = { ord_no: '1', cntr_no: '101', cntr_qty: '2', cntr_uv: '70000', cntr_tm: '09:30:01', dmst_stex_tp: 'KRX' }
    return { body: { return_code: 0, acnt_ord_cntr_prst_array: def.nextKey ? [fill, { ...fill, cntr_no: '102', cntr_uv: '71000', cntr_tm: '09:30:02' }] : [fill] }, contYn: def.nextKey ? 'N' : 'Y', nextKey: def.nextKey ? '' : 'next' }
  } })
  const result = await read('kiwoom', account(), days.slice(0, 2))
  assert.equal(result.items.length, 2); assert.notEqual(result.items[0].id, result.items[1].id)
  for (const item of result.items) {
    assert.equal(item.status, 'residualCancelled'); assert.equal(item.quantity, 10); assert.equal(item.filledQuantity, 4)
    assert.equal(item.averageFilledPrice, 70500); assert.equal(item.executions.length, 2)
  }
  assert.equal(calls.length, 6)
})

test('Toss OPEN and CLOSED: documented cursors, overseas excluded and CLOSED never means automatically filled', async () => {
  const calls = []
  const read = createBrokerHistory({ tossAccount: async () => ({ accountSeq: 123 }), toss: async def => {
    calls.push(def); assert.equal(def.apiKey, 'personal-toss'); assert.equal(def.accountSeq, 123)
    if (def.query.status === 'OPEN') return { result: { orders: [{ ...tossRow, status: 'PARTIAL_FILLED' }, { ...tossRow, symbol: 'AAPL', currency: 'USD' }], hasNext: false, nextCursor: null } }
    return { result: { orders: def.query.cursor ? [{ ...tossRow, orderId: 'reject', status: 'REJECTED', execution: { filledQuantity: '0' } }] : [tossRow], hasNext: !def.query.cursor, nextCursor: def.query.cursor ? null : 'page2' } }
  } })
  const result = await read('toss', account(), days)
  assert.equal(result.items.length, 2); assert.equal(result.items[0].status, 'residualCancelled'); assert.equal(result.items[1].status, 'rejected')
  assert.equal(result.items[0].averageFilledPrice, 70000); assert.equal(calls.length, 3)
  assert.equal(calls[0].query.from, days.at(-1)); assert.equal(calls[0].query.to, days[0])
  assert.ok(!JSON.stringify(result).includes('accountSeq'))
})

test('NH verifies account membership, returns opaque selection IDs and masks numbers; five daily queries, duplicate pages and cancellation quantities', async () => {
  const calls = [], accounts = [{ id: '12345678901', label: '123-****-8901' }, { id: '12345678902', label: '123-****-8902' }]
  const read = createBrokerHistory({ nhAccounts: async () => accounts, nh: { request: async (auth, path, input, options) => {
    calls.push({ auth, path, input, options }); assert.equal(input.ost_cns_dit, '0')
    return { rsp_cd: '00000', Output_0: [nhRow, { ...nhRow, itg_orr_no: 2, org_itg_orr_no: 1, orr_qty: 6, tot_cns_qty: 0, can_qty: 6 }], hasMore: !options.cts, continuation: options.cts ? '' : 'page2' }
  } } })
  const choose = await read('nh', account(), days)
  assert.equal(choose.status, 'accountRequired'); assert.equal(calls.length, 0)
  assert.ok(!JSON.stringify(choose).includes('12345678901'))
  const result = await read('nh', account(), days, choose.accounts[0].id)
  assert.equal(result.items.length, 5); assert.equal(calls.length, 10)
  assert.ok(result.items.every(item => item.status === 'residualCancelled' && item.orderedAt === null && item.averageFilledPrice === 70000))
  assert.ok(!JSON.stringify(result).includes('12345678901'))
  await assert.rejects(read('nh', account('other-user'), days, choose.accounts[0].id), { statusCode: 400 })
  assert.equal(calls.length, 10)
  assert.equal(sortRecentOrders([makeOrder('kiwoom'), ...result.items]).length, 6)
})

test('KB SSQM2341 official request field names and next key: distinct days and null average for an undocumented aggregate', async () => {
  const calls = []
  const read = createBrokerHistory({ kb: { request: async (auth, code, input) => {
    calls.push({ auth, code, input }); assert.equal(code, 'ssqm2341'); assert.equal(input.ccls_clsf, '0')
    return { Record1: [kbRow, { ...kbRow, ordr_no: '2', orgn_ordr_no: '1', ordr_q: '6', tl_ccls_q: '0' }], nxt_key: input.nxt_key ? '' : 'page2' }
  } } })
  const result = await read('kb', account(), days)
  assert.equal(result.items.length, 5); assert.equal(calls.length, 10)
  assert.ok(result.items.every(item => item.status === 'residualCancelled' && item.averageFilledPrice === null && item.symbol === '005930'))
  const ids = new Set([makeOrder('kiwoom').id, makeOrder('toss').id, makeOrder('nh').id, makeOrder('kb').id, makeOrder('kb', 'b'.repeat(32)).id, makeOrder('kb', 'a'.repeat(32), days[1]).id])
  assert.equal(ids.size, 6)
})

test('repeated or missing continuation keys fail instead of claiming complete or empty results', async () => {
  const read = createBrokerHistory({ kb: { request: async () => ({ Record1: [], nxt_key: 'repeat' }) } })
  await assert.rejects(read('kb', account(), days), /연속 조회/)
  const toss = createBrokerHistory({ tossAccount: async () => ({ accountSeq: 1 }), toss: async () => ({ result: { orders: [], hasNext: true, nextCursor: null } }) })
  await assert.rejects(toss('toss', account(), days), /연속 조회/)
})

test('all four real adapters can return an honest empty result, with no personal account response cache', async () => {
  const calls = []; let accounts = 0
  const read = createBrokerHistory({ pause: async () => {}, kiwoom: async def => { calls.push('kiwoom'); return { body: { return_code: 0 } } },
    toss: async def => { calls.push('toss'); if (def.path === '/api/v1/accounts') { accounts++; return { result: [{ accountType: 'BROKERAGE', accountSeq: 42 }] } } return { result: { orders: [], hasNext: false, nextCursor: null } } },
    nhAccounts: async () => [{ id: '12345678901', label: '123-****-8901' }], nh: { request: async () => { calls.push('nh'); return { rsp_cd: '00000' } } },
    kb: { request: async () => { calls.push('kb'); return { Record1: [], nxt_key: '' } } },
  })
  const handlers = createRecentOrderHandlers({ authenticate, calendar, now, readBroker: read })
  for (const user of ['user-a', 'user-b']) {
    const result = await handlers.list(request(user))
    assert.ok(result.brokers.every(broker => broker.status === 'ready'))
    assert.deepEqual(result.items, [])
  }
  assert.deepEqual(new Set(calls), new Set(HISTORY_BROKERS))
  assert.equal(accounts, 2)
})

test('full fill, unfilled cancellation, partial cancellation and rejection remain distinct', () => {
  assert.equal(makeOrder('kiwoom', undefined, undefined, undefined, { filledQuantity: 10 }).status, 'filled')
  assert.equal(makeOrder('toss', undefined, undefined, undefined, { filledQuantity: 0, cancelled: true }).status, 'cancelled')
  assert.equal(makeOrder('nh', undefined, undefined, undefined, { cancelledQuantity: 6 }).status, 'residualCancelled')
  assert.equal(makeOrder('kb', undefined, undefined, undefined, { cancelledQuantity: 2 }).status, 'partiallyFilled')
  assert.equal(makeOrder('kb', undefined, undefined, undefined, { rejected: true }).status, 'rejected')
  assert.equal(makeOrder('kb', undefined, undefined, undefined, { filledQuantity: null, quantity: null, pending: false }).status, 'unknown')
})

test('KB client permits the read-only TR with writes disabled and the canonical envelope', async () => {
  const calls = []
  const kb = createKbClient({ ip: 'test-ip', mac: 'test-mac', throttle: async () => {}, fetcher: async (url, options) => {
    calls.push([url, JSON.parse(options.body)])
    return new Response(JSON.stringify({ dataHeader: { resultCode: '200', processFlag: 'A' }, dataBody: url.endsWith('/token') ? { access_token: 'test-token', expires_in: 86400 } : { Record1: [] } }))
  } })
  await kb.request({ appKey: 'test-key', secretKey: 'test-secret' }, 'ssqm2341', { ccls_clsf: '0', ordr_dt: '20261106', nxt_key: '' })
  assert.ok(calls[1][0].endsWith('/api/v1/ssqm2341')); assert.equal(calls[1][1].dataBody.ordr_dt, '20261106')
})

test('calendar bridge reuses authenticated loopback calendar and rejects malformed or unavailable ranges', async () => {
  const get = createOrderCalendar({ secret: 'x'.repeat(32), fetcher: async (url, options) => {
    assert.equal(url.pathname, '/calendar/order-days'); assert.equal(url.searchParams.get('date'), days[0]); assert.equal(options.headers['X-Atlas-Internal'].length, 32)
    return new Response(JSON.stringify({ days, timezone: 'Asia/Seoul' }))
  } })
  assert.deepEqual((await get(days[0])).days, days)
  await assert.rejects(createOrderCalendar({ secret: 'x'.repeat(32), fetcher: async () => new Response('{}') })(days[0]), { statusCode: 503 })
})

test('history pages keep all rows, filter out-of-range rows, deduplicate and use the same past account for detail', async t => {
  const app = Fastify(); t.after(() => app.close())
  const reads = [], ref = 'a'.repeat(32)
  const query = { from: '2024-12-28', to: '2025-01-09', brokers: 'nh', nhAccount: ref }
  registerRecentOrderRoutes(app, createRecentOrderHandlers({ authenticate, now, calendar: () => assert.fail('history must not use the trading-day calendar'),
    readBroker: async (broker, account, days, accountRef) => {
      reads.push([account.user.id, days, accountRef])
      if (account.user.id !== 'user-a' || accountRef !== ref) return { status: 'accountRequired', accounts: [], items: [] }
      const items = days.flatMap(day => ['1', '2', '3'].map(id => makeOrder(broker, ref, day, id)))
      return { status: 'ready', items: [...items, items[0], makeOrder(broker, ref, '2024-01-01')], accounts: [] }
    },
  }))
  const get = (path, params = query, token = 'user-a') => app.inject({
    url: `/api/account/orders/history${path}?${new URLSearchParams(params)}`, headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  const first = await get('')
  assert.equal(first.statusCode, 200)
  assert.equal(first.headers['cache-control'], 'private, no-store')
  const latest = first.json()
  assert.equal(latest.items.length, 21)
  assert.equal(latest.items[0].date, '2025-01-03')
  assert.equal(latest.items.at(-1).date, query.to)
  assert.equal(latest.orderingIncomplete, true)
  const older = (await get('', { ...query, before: latest.window.nextBefore })).json()
  const items = [...older.items, ...latest.items]
  assert.equal(items.length, 39)
  assert.equal(new Set(items.map(item => item.id)).size, 39)
  assert.equal(items[0].date, query.from)
  assert.equal(older.window.nextBefore, null)
  const order = items[0], path = `/nh/${order.id}`, detail = { ...query, day: order.date }
  assert.equal((await get(path, detail)).json().item.id, order.id)
  assert.deepEqual(reads.at(-1), ['user-a', [order.date], ref])
  assert.equal((await get(path, detail, 'user-b')).statusCode, 400)
  assert.equal((await get(path, { ...detail, nhAccount: 'b'.repeat(32) })).statusCode, 400)
  assert.equal((await get(path, { ...detail, from: '2024-12-29' })).statusCode, 400)
  const count = reads.length
  for (const invalid of [{ from: '2024-02-30' }, { from: '2025-01-10' }, { to: '2026-11-07' }, { before: query.from }, { from: '2024-01-01' }]) {
    assert.equal((await get('', { ...query, ...invalid })).statusCode, 400)
  }
  assert.equal((await get('', query, '')).statusCode, 401)
  assert.equal((await get(path, detail, '')).statusCode, 401)
  assert.equal(reads.length, count)
})

test('history preserves confirmed dates and separates broker limits, timeouts and rate limits', async () => {
  let kbCount = 0, tossCount = 0
  const readBroker = createBrokerHistory({
    pause: async () => {},
    kiwoom: async () => { throw Object.assign(new Error('private token=secret'), { upstreamStatus: 429, retryAfter: '11' }) },
    tossAccount: async () => ({ accountSeq: 123 }),
    toss: async () => { tossCount++; return { result: { orders: [], hasNext: true, nextCursor: String(tossCount) } } },
    nhAccounts: async () => [{ id: '12345678901', label: '123-****-8901' }],
    nh: { request: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }) } },
    kb: { request: async () => {
      if (++kbCount > 1) throw new Error('조회 기간 제한: 12345678901')
      return { Record1: [kbRow] }
    } },
  })
  const handlers = createRecentOrderHandlers({ authenticate, now, readBroker })
  const query = { from: days[1], to: days[0] }
  const result = await handlers.history(request('user-a', query))
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].broker, 'kb')
  assert.deepEqual(result.brokers.map(({ status, error }) => [status, error]), [
    ['error', 'rate_limited'], ['error', 'page_limit'], ['error', 'timeout'], ['partial', 'period_unsupported'],
  ])
  assert.equal(tossCount, 40)
  assert.equal(result.brokers[0].retryAfterSeconds, 11)
  assert.deepEqual(result.brokers[3].completedDays, [days[0]])
  assert.doesNotMatch(JSON.stringify(result), /token|12345678901/)
})
