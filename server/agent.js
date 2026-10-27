import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createAgentAuthenticator, createAgentStore } from './agentStore.js'

const uuid = { type: 'string', format: 'uuid' }
const error = (code, statusCode = 400) => Object.assign(new Error(code), { statusCode })
const hash = value => createHash('sha256').update(value).digest('hex')
const equal = (a, b) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right) }
export function guestToken(secret, id = randomUUID()) {
  const value = `${id}.${randomBytes(32).toString('base64url')}`
  return `${value}.${createHmac('sha256', secret).update(value).digest('base64url')}`
}
export function verifyGuestToken(token, secret) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3 || !/^[0-9a-f-]{36}$/.test(parts[0]) || !/^[\w-]{43}$/.test(parts[1]) || !/^[\w-]{43}$/.test(parts[2])) return null
  const signature = createHmac('sha256', secret).update(parts.slice(0, 2).join('.')).digest('base64url')
  return equal(parts[2], signature) ? { id: parts[0], token_hash: hash(token) } : null
}

export function createAgentBridge({ base = process.env.AI_INTERNAL_URL || 'http://127.0.0.1:8010', secret = process.env.AI_INTERNAL_SECRET || '', fetcher = fetch } = {}) {
  const target = new URL(base)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.protocol !== 'http:') throw error('internal_url_must_be_loopback')
  return {
    configured: secret.length >= 32,
    async call(path, body) {
      if (secret.length < 32) throw error('internal_secret_missing', 503)
      const response = await fetcher(new URL(path, target), {
        method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Atlas-Internal': secret },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 130000 : 5000), redirect: 'error',
      })
      const data = await response.json()
      if (!response.ok) throw error(['api_key_missing', 'run_busy'].includes(data.detail) ? data.detail : 'internal_service_error', 503)
      return data
    },
  }
}

export function registerAgentRoutes(app, {
  store = createAgentStore(), authenticate = createAgentAuthenticator(), bridge = createAgentBridge(),
  cookieSecret = process.env.AI_GUEST_COOKIE_SECRET || '', internalSecret = process.env.AI_INTERNAL_SECRET || '',
  publicOrigin = process.env.AI_PUBLIC_ORIGIN || 'http://127.0.0.1:5173',
  secureCookie = process.env.NODE_ENV === 'production', enabled = process.env.AI_ENABLED !== 'false',
} = {}) {
  const cookieName = secureCookie ? '__Host-atlas_ai_guest' : 'atlas_ai_guest'
  const guestDays = Math.max(1, Math.min(30, Number(process.env.AI_GUEST_DAYS || 7)))
  const inFlight = new Map()
  // Fastify normally strips extra JSON properties. Reject them before validation for AI
  // routes only, without changing validation behavior of existing broker/dashboard routes.
  app.addHook('preValidation', async request => {
    const schema = request.routeOptions.schema?.body
    if (request.routeOptions.url?.startsWith('/api/agent/') && schema?.additionalProperties === false
      && request.body && Object.keys(request.body).some(key => !Object.hasOwn(schema.properties, key))) {
      throw error('invalid_arguments')
    }
  })
  let lastMaintenance = 0
  async function maintenance() {
    if (Date.now() - lastMaintenance > 60000) {
      lastMaintenance = Date.now()
      await store.call('maintenance', '', { guest_days: Number(process.env.AI_GUEST_DAYS || 7) })
    }
  }
  async function actor(request, reply, allowIssue = false) {
    reply.header('Cache-Control', 'no-store')
    if (request.headers.origin && request.headers.origin !== publicOrigin) throw error('origin_forbidden', 403)
    if (request.headers['sec-fetch-site'] === 'cross-site') throw error('same_origin_proxy_required', 403)
    if (request.headers.authorization !== undefined) return `u:${await authenticate(request.headers.authorization)}`
    if (cookieSecret.length < 32) throw error('guest_cookie_not_configured', 503)
    const cookies = Object.fromEntries(String(request.headers.cookie || '').split(';').map(x => x.trim().split('=')))
    const existing = cookies[cookieName]
    if (existing) {
      const verified = verifyGuestToken(existing, cookieSecret)
      // Never silently mint a new visitor after a forged, expired or rejected credential.
      if (!verified) throw error('guest_cookie_invalid', 401)
      return (await store.call('guest_verify', '', verified)).key
    }
    if (!allowIssue) throw error('guest_cookie_required', 401)
    const token = guestToken(cookieSecret)
    const verified = verifyGuestToken(token, cookieSecret)
    const guest = await store.call('guest_create', '', { ...verified, days: guestDays })
    reply.header('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${guestDays * 86400}${secureCookie ? '; Secure' : ''}`)
    return guest.key
  }
  const wrap = fn => async (request, reply) => {
    try { return await fn(request, reply) }
    catch (exc) { return reply.code(exc.statusCode || 503).send({ error: exc.statusCode ? exc.message : 'agent_unavailable' }) }
  }
  const payload = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })
  async function getContext(owner, roomId, requestId) {
    const data = await store.call('messages', owner, { room_id: roomId })
    const messages = data.messages.filter(m => m.request_id !== requestId).slice(-12).map(m => ({ role: m.role, content: m.content.slice(0, 2000),
      ...(m.answer ? { answer: { as_of: m.answer.as_of, sources: (m.answer.sources || []).slice(0, 12), coverage: m.answer.coverage || [], result_sets: (m.answer.result_sets || []).slice(-3) } } : {}) }))
    while (Buffer.byteLength(JSON.stringify(messages)) > 24000 && messages.length > 1) messages.shift()
    return messages
  }
  async function execute(owner, reservation) {
    try {
      const context = await getContext(owner, reservation.room_id, reservation.id)
      const result = await bridge.call('/run', { request_id: reservation.id, question: reservation.question, context })
      if (!['completed', 'partial', 'failed'].includes(result.status) || !result.usage || Buffer.byteLength(JSON.stringify(result.answer)) > 100000) throw error('invalid_internal_result')
      await store.call('finish', owner, { request_id: reservation.id, status: result.status,
        answer: result.answer, usage: result.usage, error_code: result.error_code || null })
    } catch (exc) {
      // Response loss, restart or unknown provider usage is not reported as zero usage.
      await store.call('finish', owner, { request_id: reservation.id, status: 'failed',
        usage: { status: 'unknown' }, error_code: 'execution_interrupted' }).catch(() => {})
    } finally { inFlight.delete(reservation.id) }
  }
  app.get('/api/agent/status', wrap(async (request, reply) => {
    const owner = await actor(request, reply, true)
    if (!store.configured) throw error('database_not_configured', 503)
    await maintenance()
    let service
    try { service = await bridge.call('/health') } catch { service = { provider: { state: 'connection_failed' } } }
    return { enabled, database: 'ready', guest: owner.startsWith('g:'), daily_limit: owner.startsWith('g:') ? 2 : null, ...service }
  }))
  app.get('/api/agent/rooms', wrap(async (request, reply) => {
    const owner = await actor(request, reply)
    return { rooms: await store.call('rooms', owner, { search: String(request.query.search || '').slice(0, 80) }) }
  }))
  app.post('/api/agent/rooms', { schema: { body: payload({}) } }, wrap(async (request, reply) => store.call('create_room', await actor(request, reply))))
  app.put('/api/agent/rooms/:id', { schema: { params: payload({ id: uuid }), body: payload({ title: { type: 'string', minLength: 1, maxLength: 80 } }) } }, wrap(async (request, reply) => store.call('rename_room', await actor(request, reply), { room_id: request.params.id, title: request.body.title })))
  app.delete('/api/agent/rooms/:id', { schema: { params: payload({ id: uuid }) } }, wrap(async (request, reply) => store.call('delete_room', await actor(request, reply), { room_id: request.params.id })))
  app.get('/api/agent/rooms/:id/messages', { schema: { params: payload({ id: uuid }), querystring: { type: 'object', additionalProperties: false, properties: { before: { type: 'string', pattern: '^[0-9]{1,18}$' } } } } }, wrap(async (request, reply) => {
    const owner = await actor(request, reply)
    await maintenance()
    return store.call('messages', owner, { room_id: request.params.id, ...(request.query.before ? { before: request.query.before } : {}) })
  }))
  app.get('/api/agent/requests/:id', { schema: { params: payload({ id: uuid }) } }, wrap(async (request, reply) => {
    const owner = await actor(request, reply)
    await maintenance()
    return store.call('request', owner, { request_id: request.params.id })
  }))
  app.post('/api/agent/rooms/:id/requests', { schema: { params: payload({ id: uuid }), body: payload({ request_id: uuid, question: { type: 'string', minLength: 1, maxLength: 6000 } }) } }, wrap(async (request, reply) => {
    const owner = await actor(request, reply)
    if (!enabled) throw error('agent_disabled', 503)
    await maintenance()
    // Check idempotency BEFORE provider readiness, so a reconnect can recover a prior result with no new call.
    try {
      const existing = await store.call('request', owner, { request_id: request.body.request_id })
      if (existing.room_id !== request.params.id || existing.question !== request.body.question) throw error('idempotency_conflict', 409)
      return existing
    } catch (exc) { if (exc.statusCode !== 404) throw exc }
    const service = await bridge.call('/health')
    if (!service.key_configured) throw error('api_key_missing', 503)
    if (!request.body.question.trim()) throw error('empty_question')
    const reservation = await store.call('reserve', owner, { room_id: request.params.id, ...request.body })
    if (reservation.created) {
      inFlight.set(reservation.id, { owner })
      void execute(owner, reservation)
    }
    return reply.code(202).send(reservation)
  }))
  app.post('/api/internal/agent/events', { bodyLimit: 16000 }, wrap(async (request, reply) => {
    const supplied = request.headers['x-atlas-internal'] || ''
    if (internalSecret.length < 32 || !equal(String(supplied), internalSecret)) throw error('internal_auth_required', 401)
    const active = inFlight.get(request.body?.request_id)
    if (!active) throw error('request_not_active', 409)
    const step = request.body.step
    if (!step || !Number.isInteger(step.seq) || step.seq < 1 || step.seq > 100 || !['model', 'tool', 'validation'].includes(step.kind)) throw error('invalid_step')
    return store.call('step', active.owner, { request_id: request.body.request_id, event: step,
      ...(step.result?.usage_status ? { usage: { ...step.result.usage_total, status: step.result.usage_status } } : {}) })
  }))
}
