import { createClient } from '@supabase/supabase-js'

const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

export function createAgentWatchlistConfirmer({ url = process.env.SUPABASE_URL, key = process.env.SUPABASE_PUBLISHABLE_KEY,
  clientFactory = createClient } = {}) {
  return async (authorization, payload) => {
    if (!url || !key) throw Object.assign(new Error('database_not_configured'), { statusCode: 503 })
    // Use the member's JWT so the existing write RPC still derives its owner from auth.uid().
    const client = clientFactory(url, key, { ...options, global: { headers: { Authorization: authorization } } })
    const { data, error } = await client.rpc('atlas_ai_confirm_watchlist', payload).abortSignal(AbortSignal.timeout(7000))
    const failure = error ? (['42501', 'PGRST301', 'PGRST303'].includes(error.code) ? 'invalid_authentication' : 'confirmation_unavailable') : data?.error
    if (!failure && data?.confirmation) return data
    const statuses = { invalid_authentication: 401, confirmation_not_found: 404, confirmation_outdated: 409,
      confirmation_not_approved: 409, alert_expired: 409, alert_watchlist_required: 409 }
    throw Object.assign(new Error(failure || 'confirmation_unavailable'), { statusCode: statuses[failure] || 503 })
  }
}
export function createAgentStore({ url = process.env.SUPABASE_URL, secret = process.env.SUPABASE_SECRET_KEY, client } = {}) {
  const db = client || (url && secret ? createClient(url, secret, options) : null)
  return {
    configured: Boolean(db),
    async call(action, actor, payload = {}) {
      if (!db) throw Object.assign(new Error('database_not_configured'), { statusCode: 503 })
      const { data, error } = await db.rpc('atlas_ai_rpc', { action, actor, payload })
      if (error) {
        const known = ['not_found', 'daily_limit', 'concurrency_limit', 'minute_limit', 'idempotency_conflict', 'guest_invalid', 'room_limit']
        const code = known.find(code => error.message?.includes(code)) || 'database_unavailable'
        throw Object.assign(new Error(code), { statusCode: code === 'not_found' ? 404 : code === 'guest_invalid' ? 401 : code === 'idempotency_conflict' ? 409 : code === 'database_unavailable' ? 503 : 429 })
      }
      return data
    },
  }
}

// Login-only client: does not require or read broker encryption/credentials.
export function createAgentAuthenticator({ url = process.env.SUPABASE_URL, key = process.env.SUPABASE_PUBLISHABLE_KEY, client } = {}) {
  const auth = client || (url && key ? createClient(url, key, options) : null)
  return async authorization => {
    if (!/^Bearer \S+$/.test(authorization || '')) throw Object.assign(new Error('invalid_authentication'), { statusCode: 401 })
    if (!auth) throw Object.assign(new Error('auth_not_configured'), { statusCode: 503 })
    const { data, error } = await auth.auth.getUser(authorization.slice(7))
    if (error || !data.user) throw Object.assign(new Error('invalid_authentication'), { statusCode: 401 })
    return data.user.id
  }
}
