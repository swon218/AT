import { readFileSync } from 'node:fs'

export const screenSchema = JSON.parse(readFileSync(new URL('../shared/screener-schema.json', import.meta.url), 'utf8'))
const allowedErrors = new Set(['screen_busy', 'screen_data_changed', 'screen_snapshot_unverified', 'screen_data_not_ready', 'snapshot_changed', 'calendar_unverified'])
const fail = (code, statusCode = 503) => Object.assign(new Error(code), { statusCode })

export function createScreenBridge({ base = process.env.AI_INTERNAL_URL || 'http://127.0.0.1:8010', secret = process.env.AI_INTERNAL_SECRET || '', fetcher = fetch } = {}) {
  const origin = new URL(base)
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw fail('screen_internal_url_must_be_loopback')
  return {
    async call(path, body) {
      if (!['/screen', '/screen/meta'].includes(path) || secret.length < 32) throw fail('screen_unavailable')
      const response = await fetcher(new URL(path, origin), { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { 'X-Atlas-Internal': secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 13000 : 5000) })
      const raw = await response.text()
      if (Buffer.byteLength(raw) > 256000) throw fail('screen_response_too_large')
      let data
      try { data = JSON.parse(raw) } catch { throw fail('screen_unavailable') }
      if (!response.ok) throw fail(response.status === 422 ? 'invalid_screen_query' : allowedErrors.has(data.detail) ? data.detail : 'screen_unavailable', response.status === 422 ? 400 : response.status === 409 ? 409 : 503)
      return data
    },
  }
}

export function registerScreenRoutes(app, { bridge = createScreenBridge(), publicOrigin = process.env.AI_PUBLIC_ORIGIN || 'http://127.0.0.1:5173', maxRequests = 120 } = {}) {
  const admission = { start: Date.now(), count: 0, active: 0 }
  async function execute(request, reply, path, body) {
    reply.header('Cache-Control', 'no-store')
    const origin = request.headers.origin, site = request.headers['sec-fetch-site']
    if ((origin && origin !== publicOrigin) || (site && site !== 'same-origin') || (body && origin !== publicOrigin)) return reply.code(403).send({ error: 'screen_origin_forbidden' })
    if (Date.now() - admission.start >= 60000) { admission.start = Date.now(); admission.count = 0 }
    if (++admission.count > maxRequests) return reply.header('Retry-After', '30').code(429).send({ error: 'screen_rate_limited' })
    if (admission.active >= 2) return reply.code(503).send({ error: 'screen_busy' })
    admission.active++
    try { return await bridge.call(path, body) }
    catch (error) { return reply.code(error.statusCode || 503).send({ error: ['invalid_screen_query', ...allowedErrors].includes(error.message) ? error.message : 'screen_unavailable' }) }
    finally { admission.active-- }
  }
  // No body schema here: Fastify's global AJV removes unknown properties. Keep the
  // original bounded JSON intact for the shared Python model's strict validation.
  app.post('/api/screener', { bodyLimit: 16000 }, async (request, reply) => {
    if (!request.body || Array.isArray(request.body) || typeof request.body !== 'object') return reply.code(400).send({ error: 'invalid_screen_query' })
    return execute(request, reply, '/screen', request.body)
  })
  app.get('/api/screener', async (request, reply) => execute(request, reply, '/screen/meta'))
}
