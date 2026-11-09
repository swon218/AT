import { createClient } from '@supabase/supabase-js'
import { DartError } from './dartClient.js'

function checked(result) {
  if (!result.error) return result.data
  const code = result.error.code
  if (code === 'P0001' && result.error.message === 'outdated_dart_snapshot') throw new DartError('dart_report_version')
  if (['42P01', '42883', 'PGRST202', 'PGRST205'].includes(code)) throw new DartError('dart_schema_missing')
  if (['42501', 'PGRST301', 'PGRST302'].includes(code) || [401, 403].includes(result.status)) throw new DartError('dart_database_permission')
  throw new DartError('dart_database_unavailable')
}

export function createDartStore({ supabaseUrl, supabaseSecretKey }) {
  const client = supabaseUrl && supabaseSecretKey ? createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(7000) }) },
  }) : null
  const db = () => {
    if (!client) throw new DartError('dart_database_not_configured')
    return client
  }
  return {
    async job(key) { return checked(await db().from('atlas_dart_jobs').select('*').eq('key', key).maybeSingle()) },
    async symbol(symbol) { return checked(await db().from('atlas_dart_symbols').select('symbol,corp_code,name,modified_on').eq('symbol', symbol).eq('active', true).maybeSingle()) },
    async accounts(key) { return checked(await db().from('atlas_dart_accounts').select('*').eq('report_key', key)) },
    async due(limit) {
      const now = new Date().toISOString()
      return checked(await db().from('atlas_dart_jobs').select('key,corp_code,kind,args')
        .not('kind', 'in', '(codes,report)').or(`expires_at.is.null,expires_at.lte.${now}`)
        .or(`retry_at.is.null,retry_at.lte.${now}`).or(`lease_until.is.null,lease_until.lte.${now}`)
        .order('expires_at', { nullsFirst: true }).order('key').limit(limit))
    },
    async work(action, input) { return checked(await db().rpc('atlas_dart_work', { action, input })) },
  }
}
