import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'

export const agentMigration = await readFile(new URL('../../supabase/migrations/20261028_001_ai_agent.sql', import.meta.url), 'utf8')
export async function testDatabase() {
  const db = new PGlite()
  await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
  await db.exec(agentMigration)
  const store = { configured: true, async call(action, actor, payload = {}) {
    try { return (await db.query('SELECT public.atlas_ai_rpc($1,$2,$3::jsonb) AS value', [action, actor, JSON.stringify(payload)])).rows[0].value }
    catch (e) { throw Object.assign(new Error(e.message), { statusCode: e.message.includes('not_found') ? 404 : e.message.includes('guest_invalid') ? 401 : e.message.includes('idempotency_conflict') ? 409 : 429 }) }
  } }
  return { db, store }
}
