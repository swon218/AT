// Public daily-data search only. No auth/broker secrets or user-selected targets.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'screen_method_not_allowed' })
  let origin
  try { origin = new URL(process.env.ATLAS_API_ORIGIN) } catch { return res.status(503).json({ error: 'screen_unavailable' }) }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return res.status(503).json({ error: 'screen_unavailable' })
  try {
    const headers = {}
    for (const key of ['origin', 'sec-fetch-site']) if (typeof req.headers[key] === 'string') headers[key] = req.headers[key]
    const body = req.method === 'POST' ? JSON.stringify(req.body || {}) : undefined
    if (body && Buffer.byteLength(body) > 16000) return res.status(413).json({ error: 'invalid_screen_query' })
    if (body) headers['Content-Type'] = 'application/json'
    const upstream = await fetch(new URL('/api/screener', origin), { method: req.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(18000) })
    const output = await upstream.text()
    if (upstream.status === 404 || Buffer.byteLength(output) > 256000) return res.status(503).json({ error: 'screen_unavailable' })
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    return res.status(upstream.status).send(output)
  } catch { return res.status(503).json({ error: 'screen_unavailable' }) }
}
