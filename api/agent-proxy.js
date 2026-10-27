// A static Vercel Function plus vercel.json rewrite handles every allowed nesting depth.
// This is a bounded same-origin proxy, never a user-selected upstream or arbitrary URL.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ROUTE = new RegExp(`^(?:status|rooms(?:/${UUID}(?:/(?:messages|requests))?)?|requests/${UUID})$`)
const RESERVED = '__atlas_route'

export function proxyTarget(requestUrl, parsedQuery = {}) {
  const url = new URL(requestUrl, 'https://atlas.invalid')
  // The Node runtime can expose rewrite parameters in req.query while req.url
  // contains only the function pathname. Merge without accepting conflicting values.
  for (const [key, raw] of Object.entries(parsedQuery || {})) {
    const values = Array.isArray(raw) ? raw : [raw]
    if (!values.every(value => typeof value === 'string')) return null
    const present = url.searchParams.getAll(key)
    if (present.length) {
      if (present.length !== values.length || present.some((value, i) => value !== values[i])) return null
    } else for (const value of values) url.searchParams.append(key, value)
  }
  // Vercel can expose either the original path or its rewritten destination to Node.
  // Consume the routing parameter once; never forward it or allow it to replace an original path.
  const routingValues = url.searchParams.getAll(RESERVED)
  if (routingValues.length > 1) return null
  let route
  if (url.pathname.startsWith('/api/agent/')) {
    route = url.pathname.slice('/api/agent/'.length)
    if (routingValues.length && routingValues[0] !== route) return null
  } else if (['/api/agent-proxy', '/api/agent-proxy.js'].includes(url.pathname) && routingValues.length === 1) {
    route = routingValues[0]
  } else return null
  if (!ROUTE.test(route)) return null
  url.searchParams.delete(RESERVED)
  // Some routing runtimes also attach the source wildcard's named parameter.
  if (url.searchParams.has('atlas_route')) {
    if (url.searchParams.getAll('atlas_route').length !== 1 || url.searchParams.get('atlas_route') !== route) return null
    url.searchParams.delete('atlas_route')
  }
  // Cursor/search are the only public query parameters. No unknown routing knobs pass upstream.
  const permitted = route === 'rooms' ? ['search'] : route.endsWith('/messages') ? ['before'] : []
  for (const key of url.searchParams.keys()) {
    if (!permitted.includes(key) || url.searchParams.getAll(key).length !== 1) return null
  }
  const search = url.searchParams.toString()
  return `/api/agent/${route}${search ? '?' + search : ''}`
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  const base = process.env.ATLAS_API_ORIGIN
  if (!base) return res.status(503).json({ error: 'agent_proxy_not_configured' })
  let origin
  try { origin = new URL(base) } catch { return res.status(503).json({ error: 'invalid_agent_proxy_origin' }) }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return res.status(503).json({ error: 'invalid_agent_proxy_origin' })
  let path
  try { path = proxyTarget(req.url, req.query) } catch { /* Malformed request URLs are rejected. */ }
  if (!path) return res.status(404).json({ error: 'agent_route_not_found' })
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'method_not_allowed' })
  try {
    const headers = {}
    for (const name of ['authorization', 'cookie', 'origin', 'sec-fetch-site']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name]
    const body = ['POST', 'PUT'].includes(req.method) ? JSON.stringify(req.body || {}) : undefined
    // Fastify rejects an application/json request with an empty body (e.g. DELETE).
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (body && Buffer.byteLength(body) > 30000) return res.status(413).end()
    const target = new URL(path, origin)
    const response = await fetch(target, { method: req.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(10000) })
    const cookie = response.headers.get('set-cookie')
    if (cookie) res.setHeader('Set-Cookie', cookie)
    const output = await response.text()
    if (Buffer.byteLength(output) > 256000) return res.status(502).json({ error: 'proxy_response_too_large' })
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    return res.status(response.status).send(output)
  } catch { return res.status(502).json({ error: 'agent_proxy_unavailable' }) }
}
