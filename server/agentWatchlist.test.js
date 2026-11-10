import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as wait } from 'node:timers/promises'
import { test } from 'node:test'
import Fastify from 'fastify'
import { registerAgentRoutes } from './agent.js'
import { createAgentWatchlistConfirmer } from './agentStore.js'
import { testDatabase } from '../tests/support/agentDatabase.js'
import { addAlertDays, koreanAlertDay } from '../shared/alertRules.js'
import { WATCHLIST_LIMIT_MESSAGE } from '../shared/watchlist.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const stock = { name: 'NAVER', code: '035420' }
const samsung = { name: '삼성전자', code: '005930' }
const hynix = { name: 'SK하이닉스', code: '000660' }
const original = { code: stock.code, kind: 'price_touch', threshold: 200000,
  expires_on: addAlertDays(koreanAlertDay(), 8), frequency: 'repeat' }
const migration = name => readFile(new URL(`../deploy/${name}.sql`, import.meta.url), 'utf8')

test('authenticated confirmation preserves the original draft and shares the database limit with star writes', async t => {
  const { db, store } = await testDatabase()
  const app = Fastify()
  t.after(async () => { await app.close(); await db.close() })
  await db.exec(`create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    insert into auth.users values ('${A}'), ('${B}');`)
  await db.exec(await migration('WATCHLIST_SUPABASE'))
  for (let i = 0; i < 2; i++) await db.exec(await migration('AI_ALERT_WATCHLIST_CONFIRM_SUPABASE'))
  const asMember = (user, sql, params) => db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [user])
    await tx.exec('set local role authenticated')
    return (await tx.query(sql, params)).rows
  })
  const rows = user => asMember(user, 'select code,name from public.watchlist_items order by code', [])
  const star = (user, { code, name }, saved = true) => asMember(user,
    'select * from public.set_watchlist_item($1,$2,$3,$4)', [user, code, saved, name])
  const confirmSql = 'select public.atlas_ai_confirm_watchlist($1,$2,$3,$4) as value'
  const cardPath = (room, id) => `/api/agent/rooms/${room}/requests/${id}/watchlist-confirmation`
  let calls = 0
  const failDraft = new Set()
  const confirmWatchlist = createAgentWatchlistConfirmer({ url: 'https://supabase.invalid', key: 'publishable-fixture',
    clientFactory: (_url, key, options) => ({ rpc: (name, p) => ({ async abortSignal() {
      assert.equal(key, 'publishable-fixture')
      assert.equal(name, 'atlas_ai_confirm_watchlist')
      const user = options.global.headers.Authorization.slice(7)
      if (p.p_decision === 'draft' && failDraft.delete(p.p_request_id)) return { error: { code: '08006' } }
      try { return { data: (await asMember(user, confirmSql, [p.p_room_id, p.p_request_id, p.p_decision, p.p_revision]))[0].value } }
      catch (error) { return { error } }
    } }) }),
  })
  const subjects = new Map()
  registerAgentRoutes(app, { store, confirmWatchlist, authenticate: async authorization => authorization.slice(7),
    bridge: { async call(path, input) {
      if (path === '/health') return { key_configured: true, alert_tools: true }
      assert.equal(path, '/run'); calls++
      const subject = subjects.get(input.request_id)
      return { status: 'completed', answer: { content: 'mock' }, usage: { status: 'known', model_calls: 1 }, alert_action: {
        kind: input.alert_context.watchlist.some(row => row.code === subject.code) ? 'draft' : 'watchlist_confirmation',
        stock: subject, rule: { ...original, code: subject.code },
      } }
    } }, alertStore: async (action, { user_id }) => {
      assert.equal(action, 'read')
      return { watchlist: await rows(user_id), rules: [], history: [] }
    },
  })
  const headers = user => ({ authorization: `Bearer ${user}` })
  const messages = async (user, room) => (await app.inject({ url: `/api/agent/rooms/${room}/messages`, headers: headers(user) })).json().messages
  const ask = async (user, subject, { room, revision = null } = {}) => {
    room ??= (await app.inject({ method: 'POST', url: '/api/agent/rooms', headers: headers(user), payload: {} })).json().id
    const id = randomUUID()
    subjects.set(id, subject)
    const submitted = await app.inject({ method: 'POST', url: `/api/agent/rooms/${room}/requests`, headers: headers(user),
      payload: { request_id: id, question: `${subject.name} 20만원일 때 알림 받고 싶어`, alert_editor: { revision, draft: null } } })
    assert.equal(submitted.statusCode, 202, submitted.body)
    for (let i = 0; i < 40; i++) {
      const answer = (await messages(user, room)).find(m => m.request_id === id && m.role === 'assistant')?.answer
      if (answer) return { room, id, answer }
      await wait(5)
    }
    assert.fail('Assistant result did not persist')
  }
  const choose = (user, card, decision, revision = null) => app.inject({ method: 'POST', url: cardPath(card.room, card.id),
    ...(user ? { headers: headers(user) } : {}), payload: { decision, revision } })
  const outcome = async (...args) => (await choose(...args)).json()

  const first = await ask(A, stock)
  assert.equal(first.answer.watchlistConfirmation.status, 'pending')
  assert.deepEqual(first.answer.watchlistConfirmation.condition, original)
  assert.equal(first.answer.alertDraft, undefined)
  assert.deepEqual(await rows(A), [])
  assert.equal((await choose(null, first, 'yes')).statusCode, 401)
  assert.equal((await choose(B, first, 'yes')).statusCode, 404)
  assert.equal((await choose(A, { ...first, room: randomUUID() }, 'yes')).statusCode, 404)
  assert.equal((await outcome(A, first, 'draft')).error, 'confirmation_not_approved')
  assert.equal((await outcome(A, first, 'yes', randomUUID())).error, 'confirmation_outdated')
  const usage = (await db.query('select used from atlas_ai.usage where owner_key=$1', [`u:${A}`])).rows[0].used
  const replay = await Promise.all([outcome(A, first, 'yes'), outcome(A, first, 'yes')])
  assert.ok(replay.every(item => item.confirmation.status === 'added' && item.confirmation.addition === 'added'))
  assert.deepEqual(await rows(A), [{ code: stock.code, name: stock.name }])
  failDraft.add(first.id)
  assert.equal((await choose(A, first, 'draft')).statusCode, 503)
  assert.equal((await messages(A, first.room)).at(-1).answer.watchlistConfirmation.status, 'added')
  const ready = await outcome(A, first, 'draft')
  assert.equal(ready.confirmation.status, 'ready')
  assert.deepEqual(Object.fromEntries(Object.keys(original).map(k => [k, ready.draft[k]])), original)
  assert.deepEqual((await outcome(A, first, 'draft')).draft, ready.draft)
  assert.equal((await messages(A, first.room)).at(-1).answer.alertDraft.revision, ready.draft.revision)
  assert.equal(calls, 1)
  assert.equal((await db.query('select used from atlas_ai.usage where owner_key=$1', [`u:${A}`])).rows[0].used, usage)

  const declined = await ask(A, samsung)
  assert.equal((await outcome(A, declined, 'no')).confirmation.status, 'declined')
  assert.equal((await outcome(A, declined, 'yes')).confirmation.status, 'declined')
  assert.equal((await outcome(A, declined, 'draft')).draft, null)
  assert.equal((await messages(A, declined.room)).at(-1).answer.watchlistConfirmation.status, 'declined')
  const existing = await ask(A, stock, { room: declined.room })
  assert.equal(existing.answer.watchlistConfirmation, undefined)
  assert.equal(existing.answer.alertDraft.threshold, 200000)
  const addedElsewhere = await ask(A, samsung)
  await star(A, samsung)
  assert.equal((await outcome(A, addedElsewhere, 'yes')).confirmation.addition, 'already_saved')
  assert.deepEqual(await rows(A), [samsung, stock])

  for (let i = 1; i <= 17; i++) await star(A, { name: `모의 종목 ${i}`, code: String(i).padStart(6, '0') })
  const competing = await ask(A, hynix)
  const otherStock = { name: '현대차', code: '005380' }
  const results = await Promise.allSettled([star(A, otherStock), outcome(A, competing, 'yes')])
  assert.equal((await rows(A)).length, 20)
  if (results[0].status === 'fulfilled') assert.equal(results[1].value.confirmation.status, 'limit')
  else assert.equal(results[0].reason.message, 'watchlist_limit')
  const limit = await ask(A, { name: 'LG전자', code: '066570' })
  assert.equal(limit.answer.content, WATCHLIST_LIMIT_MESSAGE)
  assert.equal(limit.answer.watchlistConfirmation, undefined)
  assert.equal((await ask(A, stock)).answer.alertDraft.code, stock.code)

  const old = await ask(B, stock)
  const recent = await ask(B, samsung, { room: old.room })
  assert.equal((await outcome(B, old, 'yes')).confirmation.status, 'superseded')
  await db.query("update atlas_ai.requests set answer=jsonb_set(answer,'{watchlistConfirmation,expiresAt}','\"2000-01-01T00:00:00Z\"') where id=$1", [recent.id])
  assert.equal((await outcome(B, recent, 'yes')).confirmation.status, 'expired')
  assert.deepEqual(await rows(B), [])
  for (const role of ['anon', 'service_role']) await db.transaction(async tx => {
    await tx.exec(`set local role ${role}`)
    await assert.rejects(tx.query(confirmSql, [first.room, first.id, 'yes', null]), { code: '42501' })
  })
})
