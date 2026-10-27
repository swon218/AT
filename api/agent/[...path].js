// Vercel same-origin proxy for HttpOnly guest cookies. Only the /api/agent namespace.
export default async function handler(req, res) {
  const base = process.env.ATLAS_API_ORIGIN
  if (!base) return res.status(503).json({ error: 'agent_proxy_not_configured' })
  const origin = new URL(base)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/') return res.status(503).json({ error: 'invalid_agent_proxy_origin' })
  const path = req.url.split('?')[0]
  if (!/^\/api\/agent\/(?:status|rooms(?:\/[0-9a-f-]{36}(?:\/(?:messages|requests))?)?|requests\/[0-9a-f-]{36})$/.test(path)) return res.status(404).end()
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return res.status(405).end()
  try {
    const headers = { 'Content-Type': 'application/json' }
    for (const name of ['authorization', 'cookie', 'origin', 'sec-fetch-site']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name]
    const body = ['POST', 'PUT'].includes(req.method) ? JSON.stringify(req.body || {}) : undefined
    if (body && Buffer.byteLength(body) > 30000) return res.status(413).end()
    const target = new URL(req.url, origin)
    if (target.origin !== origin.origin) return res.status(400).end()
    const response = await fetch(target, { method: req.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(10000) })
    res.setHeader('Cache-Control', 'no-store')
    const cookie = response.headers.get('set-cookie')
    if (cookie) res.setHeader('Set-Cookie', cookie)
    const output = await response.text()
    if (Buffer.byteLength(output) > 256000) return res.status(502).json({ error: 'proxy_response_too_large' })
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    return res.status(response.status).send(output)
  } catch { return res.status(502).json({ error: 'agent_proxy_unavailable' }) }
}
