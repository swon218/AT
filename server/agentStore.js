import { createClient } from '@supabase/supabase-js'

const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
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
