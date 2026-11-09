import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { authenticateAccountRequest } from './accountSettings.js'
import { config } from './config.js'
import { decryptCredentials, encryptCredentials } from './credentialCrypto.js'
import { createKakaoProvider } from './kakaoProvider.js'

const prefix = '/api/account/kakao'
const callbackPath = `${prefix}/callback`
const secret = () => randomBytes(32).toString('base64url')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const isSecret = (value) => typeof value === 'string' && /^[\w-]{43}$/.test(value)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (value) => typeof value === 'string' && uuid.test(value)
const cookieName = (digest) => `__Secure-atlas-kakao-${digest.slice(0, 24)}`
const cookieAttrs = `Path=${callbackPath}; Secure; HttpOnly; SameSite=Lax`
const sealed = (userId, tokens) => ({
  tokens: encryptCredentials(`kakao:${userId}`, { access: tokens.access, refresh: tokens.refresh }),
  access_until: tokens.access_until,
  refresh_until: tokens.refresh_until,
  scopes: tokens.scopes,
})

export function kakaoSafeRequestLog(request) {
  const raw = request.url || ''
  const path = raw.split('?')[0]
  let decoded = path
  try { decoded = decodeURIComponent(path) } catch { /* Malformed paths are not routed. */ }
  return {
    method: request.method,
    url: decoded.includes(prefix) ? path : raw,
    hostname: request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  }
}

function origins(settings) {
  try {
    const web = new URL(settings.frontendOrigin)
    const api = new URL(settings.kakaoRedirectUri)
    if (web.origin !== settings.frontendOrigin || !['http:', 'https:'].includes(web.protocol)
      || api.protocol !== 'https:' || api.href !== `${api.origin}${callbackPath}`) return null
    return { web: web.origin, api: api.origin }
  } catch {
    return null
  }
}

function rpcStore(settings) {
  if (!settings.supabaseUrl || !settings.supabaseSecretKey) return null
  const db = createClient(settings.supabaseUrl, settings.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return async (action, p) => {
    const { data, error } = await db.rpc('atlas_kakao_connection', { action, p }).abortSignal(AbortSignal.timeout(10_000))
    if (error) throw new Error('kakao_store_unavailable')
    return data
  }
}

async function authenticatedActor(request, authenticate) {
  const user = await authenticate(request)
  // Decode only after Supabase authenticates this exact bearer token.
  try {
    const payload = JSON.parse(Buffer.from(request.headers.authorization.slice(7).trim().split('.')[1], 'base64url').toString('utf8'))
    if (payload.sub === user.id && isUuid(user.id) && isUuid(payload.session_id)) {
      return { user_id: user.id, session_id: payload.session_id }
    }
  } catch {
    // A bearer token without an identifiable session cannot complete OAuth.
  }
  throw Object.assign(new Error('session_changed'), { statusCode: 401 })
}

function display(rows) {
  const active = rows.find((row) => row.status !== 'unlinking')
  const cleanupPending = rows.some((row) => row.status === 'unlinking')
  const stale = active?.status === 'connected'
    && (Date.parse(active.access_until) <= Date.now() || Date.parse(active.verified_at) <= Date.now() - 60_000)
  return {
    status: stale ? 'unavailable' : active?.status ?? (cleanupPending ? 'unlinking' : 'disconnected'),
    ...(active ? {
      maskedId: `••••${active.kakao_id.length > 4 ? active.kakao_id.slice(-4) : ''}`,
      linkedAt: active.linked_at,
      verifiedAt: active.verified_at,
    } : {}),
    cleanupPending,
    available: true,
  }
}

async function verifyLink(actor, read, db, provider, force) {
  const row = (await read()).find((item) => item.status !== 'unlinking')
  if (!row || row.status === 'reconnect') return
  const age = Date.now() - new Date(row.checked_at).getTime()
  if (!force && row.checked_at && age < (row.status === 'connected' ? 60_000 : 10_000)
    && (row.status !== 'connected' || Date.parse(row.access_until) > Date.now())) return
  const key = { ...actor, kakao_id: row.kakao_id, operation: randomUUID() }
  const claimed = await db('check_claim', key)
  if (!claimed) return
  let updated = {
    tokens: claimed.tokens, access_until: claimed.access_until,
    refresh_until: claimed.refresh_until, scopes: claimed.scopes,
  }
  let status = 'connected'
  try {
    let tokens = { ...updated, ...decryptCredentials(`kakao:${actor.user_id}`, claimed.tokens) }
    const renew = async () => {
      if (!tokens.refresh || Date.parse(tokens.refresh_until) <= Date.now()) throw Object.assign(new Error('revoked'), { kind: 'revoked' })
      tokens = await provider.refresh(tokens)
      // Keep a rotated refresh token even if the following identity check is temporarily unavailable.
      updated = sealed(actor.user_id, tokens)
      return provider.identity(tokens.access)
    }
    let id
    if (!tokens.access || Date.parse(tokens.access_until) <= Date.now()) {
      id = await renew()
    } else {
      try { id = await provider.identity(tokens.access) }
      catch (error) {
        if (error.kind !== 'expired') throw error
        id = await renew()
      }
    }
    if (id !== claimed.kakao_id) status = 'reconnect'
  } catch (error) {
    status = error.kind === 'revoked' || error.kind === 'expired' ? 'reconnect' : 'unavailable'
  }
  if (status === 'reconnect') updated = { tokens: null, access_until: null, refresh_until: null, scopes: [] }
  await db('check_finish', { ...key, result: { ...updated, status } })
}

async function cleanLinks(actor, read, db, provider) {
  const links = (await read()).filter((row) => row.status === 'unlinking')
  await Promise.all(links.map(async ({ kakao_id }) => {
    const key = { ...actor, kakao_id, operation: randomUUID() }
    if (!await db('unlink_claim', key)) return
    const ok = await provider.unlink(kakao_id)
    await db('unlink_finish', { ...key, ok })
  }))
}

function callbackPage(reply, target, requestId, statusCode = 200) {
  const nonce = secret()
  const message = requestId ? '카카오 인증이 끝났습니다. ATLAS 개인설정에서 결과를 확인해 주세요.' : '유효하지 않거나 만료된 연결 요청입니다. ATLAS에서 다시 시작해 주세요.'
  const notify = requestId ? `try{window.opener?.postMessage({type:"atlas:kakao",requestId:${JSON.stringify(requestId)}},${JSON.stringify(target)})}catch{}` : ''
  const script = `<script nonce="${nonce}">try{history.replaceState(null,"",location.pathname)}catch{}${notify}</script>`
  return reply.code(statusCode).type('text/html; charset=utf-8')
    .header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`)
    .header('Cross-Origin-Opener-Policy', 'unsafe-none')
    .send(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ATLAS 카카오 연결</title><body><p>${message}</p><p>이 창은 닫아도 됩니다.</p>${script}</body></html>`)
}

export function registerKakaoConnectionRoutes(app, {
  settings = config, db = rpcStore(settings), provider = createKakaoProvider(settings),
  authenticate = authenticateAccountRequest,
} = {}) {
  const origin = origins(settings)
  const enabled = Boolean(db && origin && settings.credentialEncryptionKey
    && settings.kakaoRestKey && settings.kakaoClientSecret && settings.kakaoAdminKey)
  const privateHeaders = (reply) => reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
  const guarded = (handler) => async (request, reply) => {
    privateHeaders(reply)
    try {
      if (!request.headers.authorization?.startsWith('Bearer ')) return reply.code(401).send({ error: '로그인이 필요합니다.' })
      const actor = await authenticatedActor(request, authenticate)
      if (!enabled) return { status: 'unavailable', available: false }
      return await handler(request, reply, actor, () => db('read', actor))
    } catch (error) {
      if (error.statusCode === 401) return reply.code(401).send({ error: '로그인 세션을 확인해 주세요.' })
      return reply.code(503).send({ error: '일시적으로 카카오 연결을 확인할 수 없습니다.' })
    }
  }
  const badInput = (reply) => reply.code(400).send({ error: '올바르지 않은 카카오 연결 요청입니다.' })

  app.get(prefix, guarded(async (_request, _reply, actor, read) => {
    await verifyLink(actor, read, db, provider, false)
    return display(await read())
  }))
  app.post(`${prefix}/check`, guarded(async (_request, _reply, actor, read) => {
    await verifyLink(actor, read, db, provider, true)
    return display(await read())
  }))
  app.post(`${prefix}/start`, guarded(async (request, reply, actor) => {
    const { proofHash, replace } = request.body ?? {}
    if (typeof proofHash !== 'string' || !/^[a-f0-9]{64}$/.test(proofHash) || typeof replace !== 'boolean') return badInput(reply)
    const launch = secret(), requestId = randomUUID()
    const outcome = await db('start', { ...actor, request_id: requestId, launch_hash: hash(launch), proof_hash: proofHash, replace })
    if (outcome !== 'started') return { outcome }
    return { requestId, launchUrl: `${origin.api}${prefix}/authorize?t=${launch}` }
  }))
  app.get(`${prefix}/authorize`, async (request, reply) => {
    privateHeaders(reply)
    const t = request.query?.t
    if (!enabled || !isSecret(t)) return callbackPage(reply, null, null, 400)
    try {
      const state = secret(), browser = secret(), digest = hash(state)
      const started = await db('launch', { launch_hash: hash(t), state_hash: digest, browser_hash: hash(browser) })
      if (!started) return callbackPage(reply, null, null, 400)
      return reply.header('Set-Cookie', `${cookieName(digest)}=${browser}; Max-Age=300; ${cookieAttrs}`)
        .redirect(provider.authorize(state, started.replace))
    } catch {
      return callbackPage(reply, null, null, 503)
    }
  })
  app.get(callbackPath, async (request, reply) => {
    privateHeaders(reply)
    const { state, code, error } = request.query ?? {}
    if (!enabled || !isSecret(state)) return callbackPage(reply, null, null, 400)
    const digest = hash(state)
    const name = cookieName(digest)
    const browser = request.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1)
    if (!isSecret(browser)) return callbackPage(reply, null, null, 400)
    reply.header('Set-Cookie', `${name}=; Max-Age=0; ${cookieAttrs}`)
    try {
      const started = await db('claim', { state_hash: digest, browser_hash: hash(browser) })
      if (!started) return callbackPage(reply, null, null, 400)
      const ref = { request_id: started.request_id }
      let staged
      try {
        if (error === 'access_denied' && !code) staged = { phase: 'failed', result: { outcome: 'canceled' } }
        else {
          if (error || typeof code !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(code)) throw new Error('invalid_code')
          const tokens = await provider.exchange(code)
          const id = await provider.identity(tokens.access)
          staged = { phase: 'ready', result: { kakao_id: id, ...sealed(started.user_id, tokens) } }
        }
      } catch {
        staged = { phase: 'failed', result: { outcome: 'oauth_failed' } }
      }
      if (!await db('stage', { ...ref, ...staged })) return callbackPage(reply, null, null, 400)
      return callbackPage(reply, origin.web, started.request_id)
    } catch {
      return callbackPage(reply, null, null, 503)
    }
  })
  for (const action of ['finish', 'cancel']) {
    app.post(`${prefix}/${action}`, guarded(async (request, reply, actor, read) => {
      const { requestId, proof } = request.body ?? {}
      if (!isUuid(requestId) || !isSecret(proof)) return badInput(reply)
      const outcome = await db(action, { ...actor, request_id: requestId, proof_hash: hash(proof) })
      if (outcome === 'pending') return { outcome }
      // Previous account cleanup is independent of the successfully committed new link.
      if (action === 'finish' && outcome === 'connected') await cleanLinks(actor, read, db, provider).catch(() => {})
      return { outcome, ...display(await read()) }
    }))
  }
  app.post(`${prefix}/unlink`, guarded(async (request, _reply, actor, read) => {
    if (request.body?.pendingOnly !== true) {
      const outcome = await db('detach', actor)
      if (outcome !== 'detached') return { outcome, ...display(await read()) }
    }
    await cleanLinks(actor, read, db, provider)
    return display(await read())
  }))
}
