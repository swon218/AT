import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createAccountProbe, createAccountConnectionHandler, registerAccountConnectionRoutes, CONNECTION_BROKERS } from './accountConnections.js'
import { createAccountConnectionCache } from './accountConnectionCache.js'
import { createKbClient } from './kbClient.js'
import { createNhClient } from './nhClient.js'
import { updateAccountSettings, getAuthenticatedCredentials } from './accountSettings.js'
import { config } from './config.js'
import { requestKiwoomWithCredentials } from './kiwoomClient.js'
import { requestTossWithCredentials } from './tossClient.js'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const owner = (id = 'alice', configured = CONNECTION_BROKERS) => ({ user: { id },
  credentials: Object.fromEntries(CONNECTION_BROKERS.flatMap(b => [[b === 'toss' ? 'tossApiKey' : `${b}AppKey`, `${id}-${b}`], [`${b}SecretKey`, `${id}-secret`]])),
  status: Object.fromEntries(CONNECTION_BROKERS.map(b => [`${b}Configured`, configured.includes(b)])),
})
const nhOk = extra => ({ rsp_cd: '00000', rsp_msg: '조회가 완료되었습니다.', ...extra })
const fixtures = () => ({
  kiwoom: { return_code: 0, entr: '000000000000' },
  toss: { result: [{ accountType: 'BROKERAGE', accountSeq: 1, accountNo: '12345678901' }] },
  nhAccounts: nhOk({ Output_0: [{ acct_no: '12345678901', acct_type: '01' }, { acct_no: '12345678902', acct_type: '01' }] }),
  nh: nhOk({ Output_0: { dca: '0' }, Output_1: [] }),
  kb: { dy_tfnd: '0', Record1: [], tl_data_cnt: '0' },
})
function probeWith(payloads, calls = []) {
  return createAccountProbe({
    kiwoom: async def => { calls.push(['kiwoom', def]); return payloads.kiwoom },
    toss: async def => { calls.push(['toss', def]); return payloads.toss },
    nh: { request: async (auth, path, input, options) => {
      calls.push(['nh', { auth, path, input, ...options }]); return path === '/n2/acctinfo' ? payloads.nhAccounts : payloads.nh
    } },
    kb: { request: async (auth, code, input, options) => { calls.push(['kb', { auth, code, input, ...options }]); return payloads.kb } },
  })
}

for (let count = 0; count <= 4; count++) test(`new/saved user with ${count} actual successes only probes saved personal brokers`, async () => {
  const account = owner('alice', CONNECTION_BROKERS.slice(0, count)), calls = []
  const handler = createAccountConnectionHandler({ authenticate: async () => account, probe: probeWith(fixtures(), calls), cache: createAccountConnectionCache() })
  const results = await Promise.all(CONNECTION_BROKERS.map(b => handler({}, b)))
  assert.equal(results.filter(r => r.connected).length, count)
  assert.deepEqual([...new Set(calls.map(([broker]) => broker))], CONNECTION_BROKERS.slice(0, count))
  for (const [broker, def] of calls) {
    assert.equal(def.retry, false)
    assert(!JSON.stringify(def).includes('/order/'))
    if (broker === 'kiwoom') { assert.equal(def.appKey, 'alice-kiwoom'); assert.equal(def.apiId, 'kt00001') }
    if (broker === 'toss') { assert.equal(def.apiKey, 'alice-toss'); assert.equal(def.path, '/api/v1/accounts') }
    if (broker === 'nh' && def.path.includes('/balance')) assert.equal(def.input.act_no, '12345678901')
    if (broker === 'kb') assert.equal(def.code, 'ssqm2952')
  }
  assert(results.every(result => Object.keys(result).sort().join() === 'connected,expiresAt'))
})

test('four saved brokers with one invalid key keep the other three connected', async () => {
  const handler = createAccountConnectionHandler({ authenticate: async () => owner(), cache: createAccountConnectionCache(),
    probe: async broker => { if (broker === 'toss') throw new Error('private upstream failure'); return true } })
  const results = await Promise.all(CONNECTION_BROKERS.map(b => handler({}, b)))
  assert.deepEqual(results.map(r => r.connected), [true, false, true, true])
})

test('zero cash/no holdings is evidence; blank, partial, malformed and business errors are not', async () => {
  const good = fixtures(), auth = { appKey: 'fixture', secretKey: 'fixture' }
  for (const broker of CONNECTION_BROKERS) {
    assert.equal(await probeWith(good)(broker, auth), true)
    const failures = broker === 'kiwoom' ? [{}, { return_code: 0 }, { return_code: 0, entr: '' }, { return_code: 0, entr: false }, { return_code: 5, entr: '0' }]
      : broker === 'toss' ? [{}, { result: [] }, { result: [{}] }, { result: [{ accountType: 'BROKERAGE', accountSeq: 1 }] }, { ...good.toss, error: { code: 'blocked' } }, { ...good.toss, success: false }]
        : broker === 'nh' ? [{}, nhOk({ Output_0: {}, Output_1: [] }), { ...good.nh, rsp_msg: '잘못된 계좌입니다.' }, { ...good.nh, message: { msg_lv_code: 'E', usr_msg: '조회 오류' } }]
          : [{}, { dy_tfnd: '' }, { dy_tfnd: null }, { dy_tfnd: 'not-money' }]
    for (const payload of failures) await assert.rejects(probeWith({ ...good, [broker]: payload })(broker, auth))
  }
  // Valid first page suffices when NH sends totals only on a later page.
  assert.equal(await probeWith({ ...good, nh: nhOk({ Output_1: [{ iem_cd: 'A005930', itg_bnc_qty: '1' }], hasMore: true }) })('nh', auth), true)
  await assert.rejects(probeWith({ ...good, nhAccounts: nhOk({ Output_0: [{ acct_no: '12345678901', acct_type: '03' }] }) })('nh', auth))
})

test('HTTP 200 upstream business errors and empty bodies fail through actual NH/KB clients', async () => {
  for (const broker of ['nh', 'kb']) for (const variant of ['business', 'empty', 'malformed']) {
    const client = broker === 'kb' ? createKbClient({ ip: '192.0.2.1', mac: 'fixture', throttle: async () => {}, fetcher: async url => {
      if (String(url).endsWith('/oauth2/token')) return Response.json({ dataHeader: { resultCode: '200', processFlag: 'A' }, dataBody: { access_token: 'fixture' } })
      return variant === 'business' ? Response.json({ dataHeader: { resultCode: '200', processFlag: 'B' }, dataBody: { dy_tfnd: '0' } })
        : variant === 'empty' ? Response.json({}) : new Response('not-json')
    } }) : createNhClient({ throttle: async () => {}, fetcher: async url => {
      if (String(url).includes('/oauth2/token')) return Response.json({ access_token: 'fixture' })
      return variant === 'business' ? Response.json(nhOk({ message: { msg_lv_code: 'E', usr_msg: '권한 오류' }, Output_0: [{ acct_type: '01', acct_no: '12345678901' }] }))
        : variant === 'empty' ? Response.json({}) : new Response('not-json')
    } })
    await assert.rejects(createAccountProbe({ [broker]: client })(broker, { appKey: 'fixture', secretKey: 'fixture' }))
  }
})

test('actual Kiwoom/Toss transports cannot turn HTTP 200 errors or parsing fallbacks into account evidence', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const broker of ['kiwoom', 'toss']) for (const variant of ['business', 'empty', 'malformed', 'zero']) {
      const good = fixtures()[broker]
      globalThis.fetch = async url => {
        if (String(url).endsWith('/oauth2/token')) return Response.json({ token: 'fixture', access_token: 'fixture', expires_in: 86400 })
        if (variant === 'malformed') return new Response('not-json')
        if (variant === 'empty') return new Response('')
        return Response.json(variant === 'business' ? (broker === 'kiwoom' ? { ...good, return_code: 5 } : { ...good, error: { code: 'unauthorized' } }) : good)
      }
      const probe = createAccountProbe({ kiwoom: requestKiwoomWithCredentials, toss: requestTossWithCredentials })
      const auth = { appKey: `fixture-${variant}`, apiKey: `fixture-${variant}`, secretKey: 'transport-test' }
      if (variant === 'zero') assert.equal(await probe(broker, auth), true)
      else await assert.rejects(probe(broker, auth))
    }
  } finally { globalThis.fetch = originalFetch }
})

test('cache deduplicates per user/broker/version, expires, and isolates slow failures', async () => {
  let clock = 100, reads = 0
  const cache = createAccountConnectionCache({ now: () => clock, ttlMs: 60, timeoutMs: 20 })
  const gate = deferred()
  const read = () => { reads++; return gate.promise }
  const a = cache.check('alice', 'kiwoom', 'v1', read), b = cache.check('alice', 'kiwoom', 'v1', read)
  gate.resolve(true)
  assert.equal((await a).connected, true); assert.equal((await b).connected, true); assert.equal(reads, 1)
  await cache.check('alice', 'kiwoom', 'v1', read); assert.equal(reads, 1)
  clock += 61
  await cache.check('alice', 'kiwoom', 'v1', read); assert.equal(reads, 2)
  await cache.check('bob', 'kiwoom', 'v1', read); assert.equal(reads, 3)
  await cache.check('alice', 'kiwoom', 'v2', read); assert.equal(reads, 4)
  const slow = cache.check('alice', 'toss', 'v1', () => new Promise(() => {}))
  assert.equal((await cache.check('alice', 'kb', 'v1', async () => true)).connected, true)
  assert.equal((await slow).connected, false)
})

test('replacement/deletion during a read rejects late success and cannot resurrect an old cache', async () => {
  for (const deleted of [false, true]) {
    let account = owner(), reads = 0
    const gate = deferred(), cache = createAccountConnectionCache()
    const handler = createAccountConnectionHandler({ authenticate: async () => structuredClone(account), cache, probe: async () => { reads++; return gate.promise } })
    const pending = handler({}, 'kiwoom')
    await new Promise(resolve => setImmediate(resolve))
    account = owner('alice', deleted ? [] : CONNECTION_BROKERS)
    account.credentials.kiwoomSecretKey = 'replacement'
    cache.invalidate('alice', ['kiwoom'])
    gate.resolve(true)
    assert.equal((await pending).connected, false)
    if (deleted) assert.equal((await handler({}, 'kiwoom')).connected, false)
    else assert.equal((await handler({}, 'kiwoom')).connected, true)
    assert.equal(reads, deleted ? 1 : 2)
  }
})

test('settings delete only the authenticated broker keys and invalidate even identical-key saves', async () => {
  const previous = config.credentialEncryptionKey
  config.credentialEncryptionKey = 'a'.repeat(64)
  try {
    const rows = new Map()
    const client = { from() {
      let id, row
      const q = { select: () => q, eq: (_, value) => { id = value; return q }, maybeSingle: async () => ({ data: rows.get(id) }),
        upsert: value => { row = value; rows.set(value.user_id, value); return q }, single: async () => ({ data: row }) }
      return q
    } }
    const deps = { client, authenticate: async () => ({ id: 'alice' }) }
    await updateAccountSettings({ body: owner().credentials }, deps)
    const handler = createAccountConnectionHandler({ authenticate: request => getAuthenticatedCredentials(request, deps), probe: async () => true })
    assert.equal((await handler({}, 'kiwoom')).connected, true)
    const gate = deferred()
    const { accountConnectionCache } = await import('./accountConnectionCache.js')
    const pending = accountConnectionCache.check('alice', 'kiwoom', 'old-digest', () => gate.promise)
    await updateAccountSettings({ body: { kiwoomAppKey: 'alice-kiwoom' } }, deps)
    gate.resolve(true)
    assert.equal((await pending).current(), false)
    const status = await updateAccountSettings({ body: { clearBrokers: ['kiwoom'], user_id: 'bob' } }, deps)
    assert.equal(status.kiwoomConfigured, false); assert.equal(status.kbConfigured, true)
    const account = await getAuthenticatedCredentials({}, deps)
    assert.equal(account.credentials.kiwoomAppKey, undefined); assert.equal(account.credentials.kiwoomSecretKey, undefined)
    assert.equal(account.credentials.kbAppKey, 'alice-kb'); assert(!rows.has('bob'))
    assert.equal((await handler({}, 'kiwoom')).connected, false)
  } finally { config.credentialEncryptionKey = previous }
})

test('routes reject guests before auth/upstream; responses and logs contain only safe display data', async t => {
  const logs = [], app = Fastify({ logger: { stream: { write: line => logs.push(line) } } })
  t.after(() => app.close())
  let reads = 0
  registerAccountConnectionRoutes(app, createAccountConnectionHandler({
    authenticate: async request => { reads++; if (request.headers.authorization !== 'Bearer alice') throw Object.assign(new Error('secret token account-number'), { statusCode: 401 }); return owner() },
    probe: async () => { throw new Error('secret token balance raw-payload') }, cache: createAccountConnectionCache(),
  }))
  for (const broker of CONNECTION_BROKERS) assert.equal((await app.inject(`/api/account/connections/${broker}`)).statusCode, 401)
  assert.equal(reads, 0)
  assert.equal((await app.inject({ url: '/api/account/connections/kb', headers: { authorization: 'Bearer invalid' } })).statusCode, 401)
  const result = await app.inject({ url: '/api/account/connections/kb?user_id=bob', headers: { authorization: 'Bearer alice' } })
  assert.equal(result.statusCode, 200); assert.equal(result.json().connected, false)
  assert.equal(result.headers['cache-control'], 'private, no-store')
  assert.deepEqual(Object.keys(result.json()).sort(), ['connected', 'expiresAt'])
  assert(!JSON.stringify(logs).match(/secret|token|balance|raw-payload|account-number/))
})
