import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import Fastify from 'fastify'
import { config } from './config.js'
import { decryptCredentials } from './credentialCrypto.js'
import { kakaoSafeRequestLog, registerKakaoConnectionRoutes } from './kakaoConnection.js'
import { createKakaoProvider, KakaoFailure } from './kakaoProvider.js'

const sql = await readFile(new URL('../deploy/KAKAO_CONNECTION_SUPABASE.sql', import.meta.url), 'utf8')
const prefix = '/api/account/kakao'
const settings = {
  frontendOrigin: 'https://atlas.fixture.invalid', kakaoRedirectUri: `https://api.fixture.invalid${prefix}/callback`,
  credentialEncryptionKey: 'a1'.repeat(32), kakaoRestKey: 'fixture-rest-key', kakaoClientSecret: 'fixture-secret', kakaoAdminKey: 'fixture-admin',
}
const firstId = '9223372036854775806'
const secondId = '9223372036854775807'
const makeTokens = (id = firstId, accessSeconds = 600) => ({
  access: `access-${id}`, refresh: 'fixture-refresh', scopes: [],
  access_until: new Date(Date.now() + accessSeconds * 1000).toISOString(),
  refresh_until: new Date(Date.now() + 1_000_000).toISOString(),
})
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

async function fixture(t) {
  const previous = config.credentialEncryptionKey
  config.credentialEncryptionKey = settings.credentialEncryptionKey
  const pg = new PGlite()
  t.after(async () => { config.credentialEncryptionKey = previous; await pg.close() })
  await pg.exec(`
    create schema auth;
    create table auth.users(id uuid primary key);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users);
    create role anon; create role authenticated; create role service_role bypassrls;
  `)
  await pg.exec(sql)
  const [a, b] = [randomUUID(), randomUUID()]
  const [s, s2, sb] = [randomUUID(), randomUUID(), randomUUID()]
  await pg.query('insert into auth.users values ($1),($2)', [a, b])
  await pg.query('insert into auth.sessions values ($1,$2),($3,$2),($4,$5)', [s, a, s2, sb, b])
  const header = (sub, session_id) => ({
    authorization: `Bearer fixture.${Buffer.from(JSON.stringify({ sub, session_id })).toString('base64url')}.fixture`,
  })
  const headers = [header(a, s), header(b, sb), header(a, s2)]
  let log = ''
  const app = Fastify({ logger: {
    serializers: { req: kakaoSafeRequestLog },
    stream: new Writable({ write(chunk, _encoding, cb) { log += chunk; cb() } }),
  } })
  t.after(() => app.close())
  const provider = {
    authorize(state) { return `https://provider.fixture.invalid/?state=${state}` },
    async exchange(code) { return makeTokens(code === 'alternate' ? secondId : firstId) },
    async identity(access) { return access.slice('access-'.length) },
    async refresh(tokens) { return tokens },
    async unlink() { return true },
  }
  const db = async (action, payload) => (await pg.query('select public.atlas_kakao_connection($1,$2::jsonb) as value',
    [action, JSON.stringify(payload)])).rows[0].value
  registerKakaoConnectionRoutes(app, { settings, provider, db, authenticate: async (request) => {
    const index = headers.findIndex((item) => item.authorization === request.headers.authorization)
    if (index < 0) throw Object.assign(new Error('invalid bearer'), { statusCode: 401 })
    return { id: index === 1 ? b : a }
  } })
  const post = (action, body = {}, account = 0) => app.inject({
    method: 'POST', url: `${prefix}/${action}`, payload: body, headers: headers[account],
  })
  const get = (account = 0) => app.inject({ method: 'GET', url: prefix, headers: headers[account] })
  async function start(account = 0, replace = false) {
    const proof = randomBytes(32).toString('base64url')
    const { requestId, launchUrl, outcome } = (await post('start', {
      proofHash: createHash('sha256').update(proof).digest('hex'), replace, user_id: b,
    }, account)).json()
    if (!launchUrl) return { outcome }
    const url = new URL(launchUrl)
    const launch = await app.inject({ url: url.pathname + url.search })
    assert.equal(launch.statusCode, 302)
    const state = new URL(launch.headers.location).searchParams.get('state')
    assert.match(launch.headers['set-cookie'], /Secure; HttpOnly; SameSite=Lax/)
    assert.equal((await app.inject({ url: url.pathname + url.search })).statusCode, 400, 'launch token must be single use')
    const cookie = launch.headers['set-cookie'].split(';')[0]
    return { requestId, proof, state, cookie, launch: url.searchParams.get('t') }
  }
  const callback = (flow, query = 'code=fixture-authorization-code', overrides = {}) => app.inject({
    url: `${prefix}/callback?state=${overrides.state ?? flow.state}&${query}`,
    headers: { cookie: overrides.cookie ?? flow.cookie },
  })
  const finish = ({ requestId, proof }, account) => post('finish', { requestId, proof }, account)
  async function connect(account = 0, replace = false, query) {
    const flow = await start(account, replace)
    const page = await callback(flow, query)
    assert.equal(page.statusCode, 200)
    return (await finish(flow, account)).json()
  }
  return { pg, app, provider, db, a, b, s, post, get, start, callback, finish, connect, log: () => log }
}

test('authenticated linking consumes launch, state and final proof; suppresses credentials and masks the actual ID', async (t) => {
  const f = await fixture(t)
  for (const action of ['start', 'check', 'finish', 'unlink']) {
    assert.equal((await f.post(action, {}, -1)).statusCode, 401)
  }
  assert.equal((await f.get(-1)).statusCode, 401)
  assert.equal((await f.get()).json().status, 'disconnected')
  const flow = await f.start()
  assert.equal((await f.callback(flow, 'code=do-not-consume', { cookie: '' })).statusCode, 400)
  assert.equal((await f.callback(flow, 'code=do-not-consume', { state: randomBytes(32).toString('base64url') })).statusCode, 400)
  assert.equal((await f.finish(flow)).json().outcome, 'pending')
  const page = await f.callback(flow)
  assert.equal(page.statusCode, 200)
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.match(page.body, /https:\/\/atlas\.fixture\.invalid/)
  assert.equal((await f.callback(flow)).statusCode, 400)
  assert.equal((await f.get()).json().status, 'disconnected', 'callback alone does not connect')
  assert.equal((await f.finish(flow, 1)).json().outcome, 'expired')
  assert.equal((await f.finish(flow, 2)).json().outcome, 'expired', 'same user, different session')
  assert.equal((await f.finish({ ...flow, proof: randomBytes(32).toString('base64url') })).json().outcome, 'expired')
  const linked = (await f.finish(flow)).json()
  assert.equal(linked.status, 'connected')
  assert.equal(linked.maskedId, '••••5806')
  assert.equal((await f.finish(flow)).json().outcome, 'expired')
  const [row] = await f.db('read', { user_id: f.a })
  assert.equal(row.kakao_id, firstId)
  assert.equal(decryptCredentials(`kakao:${f.a}`, row.tokens).refresh, 'fixture-refresh')
  assert.throws(() => decryptCredentials(`kakao:${f.b}`, row.tokens))
  for (const payload of [f.log(), page.body, JSON.stringify(linked), JSON.stringify(row)]) {
    for (const value of ['fixture-authorization-code', flow.state, flow.launch, flow.proof, 'fixture-refresh', 'access-', settings.kakaoAdminKey, settings.kakaoClientSecret, settings.kakaoRestKey]) {
      assert.ok(!payload.includes(value), 'sensitive value appeared')
    }
  }
})

test('RLS and role grants are repeatable; ordinary clients cannot read or mutate private rows or call the RPC', async (t) => {
  const f = await fixture(t)
  await f.connect()
  await f.pg.exec(sql)
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await f.pg.exec(`set role ${role}`)
    for (const name of ['atlas_kakao_users', 'atlas_kakao_oauth', 'atlas_kakao_links']) {
      await assert.rejects(f.pg.query(`select * from public.${name}`), { code: '42501' })
      await assert.rejects(f.pg.query(`delete from public.${name}`), { code: '42501' })
    }
    if (role !== 'service_role') await assert.rejects(f.db('read', { user_id: f.a }), { code: '42501' })
    else assert.equal((await f.db('read', { user_id: f.a })).length, 1)
    await f.pg.exec('reset role')
  }
  assert.equal((await f.get(1)).json().status, 'disconnected')
  assert.equal((await f.post('unlink', { user_id: f.a }, 1)).json().status, 'disconnected')
  assert.equal((await f.get()).json().status, 'connected')
})

test('canceled, expired, provider failure and revoked ATLAS session cannot complete a link', async (t) => {
  const f = await fixture(t)
  let flow = await f.start()
  assert.equal((await f.callback(flow, 'error=access_denied')).statusCode, 200)
  assert.equal((await f.finish(flow)).json().outcome, 'canceled')
  flow = await f.start()
  f.provider.identity = async () => { throw new KakaoFailure('unavailable') }
  await f.callback(flow)
  assert.equal((await f.finish(flow)).json().outcome, 'oauth_failed')
  flow = await f.start()
  await f.pg.query("update public.atlas_kakao_oauth set expires_at=now()-interval '1 second'")
  assert.equal((await f.callback(flow)).statusCode, 400)
  assert.equal((await f.finish(flow)).json().outcome, 'expired')
  await f.db('prune', {})
  assert.equal((await f.pg.query('select count(*)::int n from public.atlas_kakao_oauth')).rows[0].n, 0)
  f.provider.identity = async () => firstId
  flow = await f.start()
  await f.callback(flow)
  await f.pg.query('delete from auth.sessions where id=$1', [f.s])
  assert.equal((await f.finish(flow)).json().outcome, 'session_changed')
  assert.equal((await f.get()).json().status, 'disconnected')
})

test('one Kakao ID per member, failed replacement keeps old connection, successful replacement revokes the old ID', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.connect()).status, 'connected')
  assert.equal((await f.start()).outcome, 'replacement_required')
  assert.equal((await f.connect(1, false, 'code=alternate')).maskedId, '••••5807')
  const conflict = await f.connect(0, true, 'code=alternate')
  assert.equal(conflict.outcome, 'conflict')
  assert.equal(conflict.maskedId, '••••5806')
  assert.ok(!JSON.stringify(conflict).includes(f.b))
  const unlinks = []
  f.provider.unlink = async (id) => { unlinks.push(id); return true }
  await f.post('unlink', {}, 1)
  const replaced = await f.connect(0, true, 'code=alternate')
  assert.equal(replaced.maskedId, '••••5807')
  assert.deepEqual(unlinks, [secondId, firstId])
})

test('checks distinguish expiry, refresh rotation, provider outage and revocation; pending unlink has no tokens and is retryable', async (t) => {
  const f = await fixture(t)
  await f.connect()
  await f.pg.exec("update public.atlas_kakao_links set access_until=now()-interval '1 second', checked_at=null")
  f.provider.refresh = async () => ({ ...makeTokens(), refresh: 'rotated-refresh' })
  f.provider.identity = async () => { throw new KakaoFailure('unavailable') }
  assert.equal((await f.get()).json().status, 'unavailable')
  let [row] = await f.db('read', { user_id: f.a })
  assert.equal(decryptCredentials(`kakao:${f.a}`, row.tokens).refresh, 'rotated-refresh')
  await f.pg.exec('update public.atlas_kakao_links set checked_at=null')
  f.provider.identity = async () => { throw new KakaoFailure('revoked') }
  assert.equal((await f.post('check')).json().status, 'reconnect')
  f.provider.unlink = async () => false
  assert.deepEqual((await f.post('unlink')).json(), { status: 'unlinking', cleanupPending: true, available: true })
  ;[row] = await f.db('read', { user_id: f.a })
  assert.equal(row.tokens, null)
  assert.equal(row.access_until, null)
  assert.equal((await f.start()).outcome, 'cleanup_pending')
  await f.pg.exec('update public.atlas_kakao_links set lease_until=null')
  f.provider.unlink = async () => true
  assert.equal((await f.post('unlink', { pendingOnly: true })).json().status, 'disconnected')
  assert.deepEqual(await f.db('read', { user_id: f.a }), [])
})

test('concurrent refresh and OAuth callback cannot restore an unlinked account; one refresh lease is granted', async (t) => {
  const f = await fixture(t)
  await f.connect()
  const flow = await f.start(0, true)
  const exchangeStarted = deferred(), exchangeRelease = deferred(), refreshStarted = deferred(), refreshRelease = deferred()
  f.provider.exchange = async () => { exchangeStarted.resolve(); return exchangeRelease.promise }
  const callback = f.callback(flow)
  await exchangeStarted.promise
  await f.pg.exec("update public.atlas_kakao_links set access_until=now()-interval '1 second', checked_at=null")
  let refreshes = 0
  f.provider.refresh = async () => { refreshes++; refreshStarted.resolve(); return refreshRelease.promise }
  const check = f.post('check')
  await refreshStarted.promise
  await f.post('check')
  assert.equal(refreshes, 1)
  assert.equal((await f.post('unlink')).json().status, 'disconnected')
  exchangeRelease.resolve(makeTokens())
  refreshRelease.resolve(makeTokens())
  assert.equal((await callback).statusCode, 400)
  assert.equal((await check).json().status, 'disconnected')
  assert.equal((await f.finish(flow)).json().outcome, 'expired')
})

test('official Kakao requests use minimal scope, preserve Long precision and classify protocol failures', async () => {
  let reply = new Response(`{"id":${firstId}}`)
  const requests = []
  const provider = createKakaoProvider(settings, async (url, options) => {
    requests.push([url, options])
    return reply
  })
  const auth = new URL(provider.authorize('fixture-state', true))
  assert.equal(auth.searchParams.get('scope'), null)
  assert.equal(auth.searchParams.get('prompt'), 'login')
  assert.equal(await provider.identity('fixture-access'), firstId)
  assert.equal(new URL(requests.at(-1)[0]).pathname, '/v2/user/me')
  reply = new Response('{"access_token":"new-access","expires_in":100}')
  assert.equal((await provider.refresh(makeTokens())).refresh, 'fixture-refresh')
  assert.equal(requests.at(-1)[1].body.get('grant_type'), 'refresh_token')
  reply = new Response('{"error_code":"KOE322"}', { status: 400 })
  await assert.rejects(provider.refresh(makeTokens()), { kind: 'revoked' })
  reply = new Response('{"code":-401}', { status: 401 })
  await assert.rejects(provider.identity('fixture-access'), { kind: 'expired' })
  reply = new Response('{"code":-101}', { status: 400 })
  assert.equal(await provider.unlink(secondId), true)
  assert.equal(requests.at(-1)[1].body.get('target_id'), secondId)
  assert.equal(requests.at(-1)[1].headers.Authorization, 'KakaoAK fixture-admin')
  reply = new Response('{"id":9223372036854775806}', { status: 503 })
  assert.equal(await provider.unlink(firstId), false)
})
