import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createAddedBrokerHandlers, registerAddedBrokerRoutes, normalizeAddedOrder, nhOrderInput, kbOrderInput } from './addedBrokers.js'
import { createAddedBrokerData } from './addedBrokerData.js'
import { createNhClient } from './nhClient.js'
import { createKbClient } from './kbClient.js'
import { createBrokerOrderStore } from './brokerOrderStore.js'
import { httpError } from './brokerHttp.js'

const auth = { appKey: 'test-key', secretKey: 'test-secret' }
const request = (token = '', body = {}) => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, query: { symbol: '005930', interval: '일' }, body })
const authenticate = async req => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token || token === 'expired') throw httpError('로그인 필요', 401)
  const broker = token.startsWith('nh') ? 'nh' : token.startsWith('kb') ? 'kb' : ''
  return { user: { id: token }, status: { [`${broker}Configured`]: Boolean(broker) }, credentials: broker ? { [`${broker}AppKey`]: `${token}-key`, [`${broker}SecretKey`]: `${token}-secret` } : {} }
}
const settings = { nhAppKey: 'operator-nh', nhSecretKey: 'operator-secret', kbAppKey: '', kbSecretKey: '', nhOrdersEnabled: true, kbOrdersEnabled: true }
const order = { side: 'buy', symbol: '005930', quantity: '2', price: '70000', session: 'regular', priceType: 'limit', exchange: 'KRX', clientRequestId: 'request-00000001' }
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const kbResponse = dataBody => response({ dataHeader: { resultCode: '200', processFlag: 'A' }, dataBody })

test('NH/KB chart policy isolates operator, personal credentials and KB fallback', async () => {
  const calls = [], fallback = []
  const handlers = createAddedBrokerHandlers({ settings, authenticate, data: { candles: async (...args) => { calls.push(args); return [{ close: 70000 }] } }, kiwoomCandles: async (...args) => { fallback.push(args); return [{ close: 71000 }] } })
  for (const token of ['', 'no-key', 'kb-user']) {
    const result = await handlers.candles(request(token), 'nh')
    assert.equal(result.sourceBroker, 'nh')
    assert.equal(calls.at(-1).at(-1).appKey, 'operator-nh')
  }
  for (const token of ['', 'no-key', 'nh-user']) {
    const result = await handlers.candles(request(token), 'kb')
    assert.equal(result.sourceBroker, 'kiwoom')
    assert.equal(result.fallback, true)
    assert.equal(fallback.at(-1).at(-1).cacheScope, 'operator')
  }
  for (const broker of ['nh', 'kb']) {
    for (const token of [`${broker}-user1`, `${broker}-user2`]) {
      assert.equal((await handlers.candles(request(token), broker)).credentialScope, 'personal')
      assert.equal(calls.at(-1).at(-1).appKey, `${token}-key`)
    }
    await assert.rejects(handlers.candles(request('expired'), broker), { statusCode: 401 })
  }
  assert.equal(fallback.length, 3)
})

test('a future KB operator key is used, but personal authentication failure never falls back', async () => {
  let calls = 0
  const handlers = createAddedBrokerHandlers({ settings: { ...settings, kbAppKey: 'kb-operator', kbSecretKey: 'secret' }, authenticate,
    data: { candles: async (_b, _s, _i, _l, a) => { calls++; if (a.appKey !== 'kb-operator') throw httpError('invalid key', 401); return [] } }, kiwoomCandles: () => assert.fail('fallback') })
  assert.equal((await handlers.candles(request(), 'kb')).sourceBroker, 'kb')
  await assert.rejects(handlers.candles(request('kb-user'), 'kb'), { statusCode: 401 })
  assert.equal(calls, 2)
})

test('account and order routes require personal keys; caller cannot supply operator credentials', async t => {
  const app = Fastify(); t.after(() => app.close())
  registerAddedBrokerRoutes(app, createAddedBrokerHandlers({ settings, authenticate, data: { summary: () => assert.fail('unauthorized account call') } }))
  for (const broker of ['nh', 'kb']) for (const method of ['GET', 'POST']) {
    const url = method === 'GET' ? `/api/account/${broker}/summary` : `/api/orders/${broker}`
    const guest = await app.inject({ method, url, ...(method === 'POST' ? { payload: { ...order, ...auth } } : {}) })
    assert.equal(guest.statusCode, 401)
    const noKey = await app.inject({ method, url, headers: { authorization: 'Bearer no-key' }, ...(method === 'POST' ? { payload: order } : {}) })
    assert.equal(noKey.statusCode, 403)
    assert.equal(noKey.headers['cache-control'], 'private, no-store')
  }
})

test('order translations follow distinct broker codes and validate input', () => {
  const normalized = normalizeAddedOrder(order)
  assert.equal(nhOrderInput(normalized, '12345678901').nmn_pr_tp_cd, '01')
  assert.equal(kbOrderInput(normalized).ordr_ccd, '00')
  assert.equal(kbOrderInput(normalized).sor_ordr_ccd, 'K')
  for (const [session, nhCode, kbSession] of [['pre', '61', '2'], ['post', '71', '3']]) {
    const value = normalizeAddedOrder({ ...order, session, priceType: 'market', price: '' })
    assert.equal(nhOrderInput(value, '12345678901').nmn_pr_tp_cd, nhCode)
    assert.deepEqual([kbOrderInput(value).ordr_ccd, kbOrderInput(value).mkt_tm_clsf], ['99', kbSession])
  }
  const market = normalizeAddedOrder({ ...order, priceType: 'market', price: '123' })
  assert.equal(nhOrderInput(market, '12345678901').nmn_pr_tp_cd, '05')
  assert.equal(kbOrderInput(market).ordr_ccd, '03')
  assert.equal(market.price, 0)
  for (const bad of [{ quantity: '1.5' }, { quantity: '-1' }, { price: '1e5' }, { priceType: 'bad' }, { side: 'short' }, { symbol: '../../x' }, { session: 'bad' }, { clientRequestId: 'tiny' }, { session: 'pre', exchange: 'NXT' }]) assert.throws(() => normalizeAddedOrder({ ...order, ...bad }))
})

test('NH/KB buy and sell use personal credentials, real order ids and no automatic write retry', async () => {
  const calls = [], reservations = []
  const data = { nhAccounts: async () => [{ id: '12345678901' }], selectAccount: (_a, id) => id || '12345678901' }
  const handlers = createAddedBrokerHandlers({ settings, authenticate, data,
    nh: { request: async (...args) => { calls.push(args); return { Output_0: { mkt_orr_no: 1234 } } } },
    kb: { request: async (...args) => { calls.push(args); return { ordr_no: '0000001235' } } },
    storeOrder: async (identity, submit) => { reservations.push(identity); return submit() },
  })
  for (const broker of ['nh', 'kb']) for (const side of ['buy', 'sell']) {
    const result = await handlers.order(request(`${broker}-user`, { ...order, side }), broker)
    const call = calls.at(-1)
    assert.equal(call[0].appKey, `${broker}-user-key`)
    assert.equal(call[3].write, true)
    assert.equal(result.side, side)
    assert.match(result.orderNumber, /123[45]$/)
    assert.equal(call[1], broker === 'nh' ? `/krstock/order/v1/${side === 'buy' ? 'cashBuy' : 'cashSell'}` : side === 'buy' ? 'ssam1802' : 'ssam1801')
    assert.match(reservations.at(-1).digest, /^[a-f0-9]{64}$/)
  }
  const disabled = createAddedBrokerHandlers({ settings: { ...settings, nhOrdersEnabled: false }, authenticate })
  await assert.rejects(disabled.order(request('nh-user', order), 'nh'), { statusCode: 503 })
  const missingId = createAddedBrokerHandlers({ settings, authenticate, storeOrder: (_id, submit) => submit(), kb: { request: async () => ({ ordr_no: '0000000000' }) } })
  await assert.rejects(missingId.order(request('kb-user', order), 'kb'), /주문번호/)
})

test('NH transport uses query token auth, reuses token, parses continuation and never retries writes', async () => {
  let issued = 0, writes = 0
  const client = createNhClient({ throttle: async () => {}, fetcher: async (url, options) => {
    if (String(url).includes('/oauth2/token')) {
      assert.equal(new URL(url).searchParams.get('appsecretkey'), auth.secretKey)
      issued++; return response({ access_token: 'token', expires_in: 86400 })
    }
    assert.equal(options.headers.Authorization, 'Bearer token')
    if (String(url).includes('/order/')) { writes++; return response({}, 401) }
    return response({ Output_0: {}, rsp_cd: '00165', rsp_msg: '조회가 계속됩니다.' }, 200, { cts_flag: 'Y', cts: 'abc' })
  } })
  await Promise.all([client.request(auth, '/n2/acctinfo'), client.request(auth, '/n2/acctinfo')])
  const result = await client.request(auth, '/n2/acctinfo')
  assert.equal(result.continuation, 'abc'); assert.equal(issued, 1)
  await assert.rejects(client.request(auth, '/krstock/order/v1/cashBuy', {}, { write: true }), { statusCode: 401 })
  assert.equal(writes, 1)
})

test('KB token envelope follows detailed B2C spec and business failures are not successes', async () => {
  let issued = 0, writes = 0, rejected = false
  const client = createKbClient({ ip: '192.0.2.1', mac: '00:11:22:33:44:55', throttle: async () => {}, fetcher: async (url, options) => {
    const input = JSON.parse(options.body)
    assert.equal(input.dataHeader.ipAddr, '192.0.2.1')
    if (String(url).includes('/oauth2/token')) {
      assert.deepEqual(input.dataBody, { appKey: auth.appKey, appSecret: auth.secretKey, grantType: 'client_credentials' })
      issued++; return kbResponse({ access_token: 'kb-token', expires_in: 86400 })
    }
    if (String(url).includes('ssam1802')) { writes++; return response({}, 401) }
    return rejected ? response({ dataHeader: { resultCode: '200', processFlag: 'B', processMessage: '권한 없음' }, dataBody: {} }) : kbResponse({ out2: [] })
  } })
  await client.request(auth, 'ivs11560', {})
  await client.request(auth, 'ivs11560', {})
  assert.equal(issued, 1)
  rejected = true
  await assert.rejects(client.request(auth, 'ivs11560', {}), /권한 없음/)
  await assert.rejects(client.request(auth, 'ssam1802', {}, { write: true }), { statusCode: 401 })
  assert.equal(writes, 1)
})

test('NH account selection rejects foreign accounts and requires choice with multiple accounts', async () => {
  const data = createAddedBrokerData({ nh: { simulated: false, request: async () => ({ Output_0: [{ acct_no: '12345678901', acct_type: '01' }, { acct_no: '12345678902', acct_type: '01' }, { acct_no: '12345678903', acct_type: '03' }] }) } })
  const summary = await data.summary('nh', auth, '005930')
  assert.equal(summary.accounts.length, 2)
  assert.equal(summary.accountRequired, true)
  await assert.rejects(data.summary('nh', auth, '005930', '99999999999'), { statusCode: 403 })
})

test('NH balance follows all pages and uses cash buying power and sellable quantity', async () => {
  const calls = []
  const data = createAddedBrokerData({ nh: { simulated: false, request: async (_auth, path, input, options) => {
    calls.push([path, input, options])
    if (path === '/n2/acctinfo') return { Output_0: [{ acct_no: '12345678901', acct_type: '01' }] }
    if (path.endsWith('/balance')) return options.cts ? { Output_0: { dca: 1000, nas_amt: 1100, tot_byn_amt: 50, tot_eal_amt: 100, tot_eal_pls: 50, pft_rt: 100 }, Output_1: [], hasMore: false } : { Output_1: [{ iem_cd: '005930', iem_nm: '삼성전자', itg_bnc_qty: 2, phs_pr: 25, now_pr: 50, eal_amt: 100, eal_pls_amt: 50, pft_rt: 100 }], hasMore: true, continuation: 'page2' }
    if (path.endsWith('/buyableQuantity')) return { Output_0: { csh_orr_pbl_amt: 900, max_pbl_amt: 99999 } }
    return { Output_0: { sll_pbl_qty: 1 } }
  } } })
  const summary = await data.summary('nh', auth, '005930')
  assert.equal(summary.orderableAmount, 900)
  assert.equal(summary.holdings[0].tradableQuantity, 1)
  assert.equal(summary.holdings[0].purchaseAmount, 50)
  assert.equal(calls.filter(([path]) => path.endsWith('/balance')).length, 2)
})

test('NH and KB candles map KOSDAQ, fractional prices, dates and credential-specific caches', async () => {
  const calls = []
  const data = createAddedBrokerData({ nh: { request: async (_auth, path, input) => {
    calls.push(input)
    return path.endsWith('currentPrice') ? { Output_0: { mrkt_div_isnm: '코스닥' } } : { Output_1: [{ bsop_date: '20261012', bsop_time: '091500', stck_oprc: '100', stck_hgpr: '120', stck_lwpr: '90', stck_prpr: '110', vol: '200' }] }
  } }, kb: { request: async (_auth, code, input) => {
    calls.push(input)
    return code === 'ivu10140' ? { mkt_clsf_nm: '코스닥' } : { out2: [{ dt: '20261012', tm: '', opn_prc_p2: ' 100.50', hgh_prc_p2: '120', lw_prc_p2: '90', cls_prc_p2: '110', vlm: '200' }] }
  } } })
  assert.equal((await data.candles('nh', '035900', '15분', 200, auth))[0].time, '2026-10-12T09:15:00+09:00')
  assert.equal(calls.at(-1).mrkt_div_cls_code, '4')
  const kbRows = await data.candles('kb', '035900', '일', 200, auth)
  assert.equal(kbRows[0].open, 100.5)
  assert.equal(calls.at(-1).mkt_clsf, '1')
  await data.candles('kb', '035900', '일', 200, auth)
  assert.equal(calls.length, 4)
  await data.candles('kb', '035900', '일', 200, { ...auth, secretKey: 'changed' })
  assert.equal(calls.length, 6)
})

function fakeOrderDb() {
  const rows = new Map()
  return { rows, from: () => ({
    insert: async row => { const key = `${row.user_id}:${row.broker}:${row.request_id}`; if (rows.has(key)) return { error: { code: '23505' } }; rows.set(key, { ...row }); return {} },
    select: () => ({ match: id => ({ single: async () => ({ data: rows.get(`${id.user_id}:${id.broker}:${id.request_id}`) }) }) }),
    update: values => ({ match: async id => { Object.assign(rows.get(`${id.user_id}:${id.broker}:${id.request_id}`), values); return {} } }),
  }) }
}

test('durable order reservation survives handlers restarting and blocks uncertain/conflicting retries', async () => {
  const db = fakeOrderDb(), identity = { userId: 'u', broker: 'kb', requestId: 'request-00000001', digest: 'a'.repeat(64) }
  let submissions = 0
  const submit = async () => { submissions++; return { orderNumber: '1234' } }
  await createBrokerOrderStore({ client: db })(identity, submit)
  assert.deepEqual(await createBrokerOrderStore({ client: db })(identity, submit), { orderNumber: '1234' })
  assert.equal(submissions, 1)
  await assert.rejects(createBrokerOrderStore({ client: db })({ ...identity, digest: 'b'.repeat(64) }, submit), { statusCode: 409 })
  const uncertain = { ...identity, requestId: 'request-00000002' }
  await assert.rejects(createBrokerOrderStore({ client: db })(uncertain, async () => { throw httpError('timeout', 504) }))
  await assert.rejects(createBrokerOrderStore({ client: db })(uncertain, submit), { statusCode: 409 })
  assert.equal(submissions, 1)
})

test('KB cash summary uses settlement quantity, full sellable pages and never replaces missing values with zero', async () => {
  const calls = []
  const data = createAddedBrokerData({ kb: { request: async (_auth, code, input) => {
    calls.push([code, input])
    if (code === 'ssqm2952') return { tl_data_cnt: '2', Record1: [
      { is_cd: 'A005930', is_nm: '삼성전자', clsf: '현금', ec_q: '3', hld_q: '0', byng_avr_prc: '100', byng_amt: '300' },
      { is_cd: '000660', clsf: '신용융자', ec_q: '2' },
    ] }
    if (code === 'ssqm1802') return { pcnt100_ordr_psbl_amt: '1,000', ordr_psbl_amt: '99999' }
    return input.nxt_key ? { Record1: [{ is_no: '005930', ordr_psbl_q: '2' }], nxt_key: '' } : { Record1: [], nxt_key: 'page2' }
  } } })
  const summary = await data.summary('kb', auth, '005930')
  assert.equal(summary.orderableAmount, 1000)
  assert.equal(summary.holdings.length, 1)
  assert.equal(summary.holdings[0].quantity, 3)
  assert.equal(summary.holdings[0].tradableQuantity, 2)
  assert.equal(summary.holdings[0].evaluationProfit, null)
  assert.equal(summary.cash, null)
  assert.equal(calls.filter(([code]) => code === 'ssqm1801').length, 2)
})

test('simultaneous identical order requests reach the broker only once', async () => {
  const db = fakeOrderDb(), store = createBrokerOrderStore({ client: db })
  const identity = { userId: 'u', broker: 'nh', requestId: 'request-concurrent', digest: 'c'.repeat(64) }
  let submissions = 0, finish
  const pending = new Promise(resolve => { finish = resolve })
  const first = store(identity, async () => { submissions++; await pending; return { orderNumber: '1234' } })
  await assert.rejects(store(identity, async () => { submissions++; return {} }), { statusCode: 409 })
  finish()
  await first
  assert.equal(submissions, 1)
})
