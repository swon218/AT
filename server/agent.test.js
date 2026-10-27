import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { testDatabase, agentMigration as migration } from '../tests/support/agentDatabase.js'
import { registerAgentRoutes, guestToken, verifyGuestToken } from './agent.js'
import { createAgentAuthenticator } from './agentStore.js'

const question = 'RSI란 무엇인가요?'
const finish = (request_id, status = 'completed') => ({ request_id, status, answer: { content: 'RSI는 상대강도지수입니다.' }, usage: { status: 'known', input_tokens: 20, output_tokens: 10 }, error_code: null })
async function guest(store) { const id = randomUUID(); await store.call('guest_create', '', { id, token_hash: 'a'.repeat(32) + id.replaceAll('-', '') }); return `g:${id}` }

test('SQL install/reapply, RLS, client RPC and sequence permissions, schema drift fails', async () => {
  assert.equal(await readFile(new URL('../deploy/AI_AGENT_SUPABASE.sql', import.meta.url), 'utf8'), migration)
  const { db } = await testDatabase()
  try {
    await db.exec(migration)
    const tables = (await db.query("SELECT relrowsecurity FROM pg_class WHERE relnamespace='atlas_ai'::regnamespace AND relkind='r'")).rows
    assert.equal(tables.length, 8); assert.ok(tables.every(x => x.relrowsecurity))
    const rights = (await db.query("SELECT has_function_privilege('anon','public.atlas_ai_rpc(text,text,jsonb)','EXECUTE') a,has_function_privilege('authenticated','public.atlas_ai_rpc(text,text,jsonb)','EXECUTE') u,has_function_privilege('service_role','public.atlas_ai_rpc(text,text,jsonb)','EXECUTE') s")).rows[0]
    assert.deepEqual(rights, { a: false, u: false, s: true })
    await db.exec('SET ROLE anon')
    await assert.rejects(db.query('SELECT * FROM atlas_ai.messages'), /permission denied/)
    await db.exec('RESET ROLE; ALTER TABLE atlas_ai.rooms ADD COLUMN unexpected text')
    await assert.rejects(db.exec(migration), /schema drift/)
    await db.exec('ROLLBACK')
  } finally { await db.close() }
})
test('guest quota 1,2 allowed,3 denied; duplicate, failure refund, delete cannot reset; user unlimited; ownership', async () => {
  const { db, store } = await testDatabase()
  try {
    const a = await guest(store), b = await guest(store)
    const room = await store.call('create_room', a)
    const reserve = request_id => store.call('reserve', a, { room_id: room.id, request_id, question })
    const first = randomUUID()
    assert.equal((await reserve(first)).created, true)
    assert.equal((await reserve(first)).created, false)
    await assert.rejects(reserve(randomUUID()), /concurrency_limit/)
    await store.call('finish', a, finish(first, 'failed'))
    for (let i = 0; i < 2; i++) { const id = randomUUID(); await reserve(id); await store.call('finish', a, finish(id)) }
    await assert.rejects(reserve(randomUUID()), /daily_limit/)
    await assert.rejects(store.call('messages', b, { room_id: room.id }), /not_found/)
    await assert.rejects(store.call('request', b, { request_id: first }), /not_found/)
    await assert.rejects(store.call('reserve', b, { room_id: room.id, request_id: randomUUID(), question }), /not_found/)
    await assert.rejects(store.call('delete_room', b, { room_id: room.id }), /not_found/)
    await store.call('delete_room', a, { room_id: room.id })
    const next = await store.call('create_room', a)
    await assert.rejects(store.call('reserve', a, { room_id: next.id, request_id: randomUUID(), question }), /daily_limit/)
    const uid = randomUUID(); await db.query('INSERT INTO auth.users VALUES($1)', [uid]); const u = `u:${uid}`
    const ur = await store.call('create_room', u)
    for (let i = 0; i < 3; i++) { const id = randomUUID(); await store.call('reserve', u, { room_id: ur.id, request_id: id, question }); await store.call('finish', u, finish(id)) }
    assert.equal((await store.call('messages', u, { room_id: ur.id })).messages.length, 6)
    const days = (await db.query("SELECT distinct day=(now() AT TIME ZONE 'Asia/Seoul')::date ok FROM atlas_ai.usage")).rows
    assert.ok(days.every(d => d.ok))
  } finally { await db.close() }
})
test('restart stale lease is unknown/refunded, deleted room cannot resurrect; message cursor and steps', async () => {
  const { db, store } = await testDatabase()
  try {
    const a = await guest(store), room = await store.call('create_room', a), id = randomUUID()
    await store.call('reserve', a, { room_id: room.id, request_id: id, question })
    await store.call('step', a, { request_id: id, event: { seq: 1, kind: 'tool', status: 'started' } })
    await db.query("UPDATE atlas_ai.requests SET lease_until=now()-interval '1 second' WHERE id=$1", [id])
    await store.call('maintenance', '')
    const stale = await store.call('request', a, { request_id: id })
    assert.equal(stale.status, 'failed'); assert.equal(stale.usage.status, 'unknown'); assert.equal(stale.steps.length, 1)
    const second = randomUUID()
    await store.call('reserve', a, { room_id: room.id, request_id: second, question })
    await store.call('delete_room', a, { room_id: room.id })
    await store.call('finish', a, finish(second))
    assert.deepEqual(await store.call('rooms', a), [])
    assert.equal((await db.query('SELECT count(*)::int n FROM atlas_ai.messages')).rows[0].n, 0)
    assert.equal((await db.query('SELECT status FROM atlas_ai.requests WHERE id=$1', [second])).rows[0].status, 'cancelled')
  } finally { await db.close() }
})
test('cookies are server signed; bad auth never downgraded; missing API key does not reserve; real Fastify/SQL API', async () => {
  const { db, store } = await testDatabase()
  const secret = 'test-only-'.repeat(5)
  const token = guestToken(secret)
  assert.ok(verifyGuestToken(token, secret)); assert.equal(verifyGuestToken(token + 'x', secret), null)
  const app = Fastify()
  registerAgentRoutes(app, { store, cookieSecret: secret, internalSecret: secret,
    authenticate: async () => { throw Object.assign(new Error('invalid_authentication'), { statusCode: 401 }) },
    bridge: { async call() { return { key_configured: false, provider: { state: 'api_key_missing' } } } } })
  try {
    const status = await app.inject({ url: '/api/agent/status' })
    assert.equal(status.statusCode, 200)
    const cookie = status.headers['set-cookie'].split(';')[0]
    assert.match(status.headers['set-cookie'], /HttpOnly/)
    const room = (await app.inject({ method: 'POST', url: '/api/agent/rooms', headers: { cookie }, payload: {} })).json()
    const answer = await app.inject({ method: 'POST', url: `/api/agent/rooms/${room.id}/requests`, headers: { cookie }, payload: { request_id: randomUUID(), question } })
    assert.equal(answer.statusCode, 503); assert.equal(answer.json().error, 'api_key_missing')
    assert.equal((await db.query('SELECT count(*)::int n FROM atlas_ai.requests')).rows[0].n, 0)
    assert.equal((await app.inject({ url: '/api/agent/rooms', headers: { cookie, authorization: 'Bearer invalid' } })).statusCode, 401)
    assert.equal((await app.inject({ url: '/api/agent/rooms', headers: { cookie: 'atlas_ai_guest=forged' } })).statusCode, 401)
    assert.equal((await app.inject({ method: 'POST', url: '/api/agent/rooms', headers: { cookie, origin: 'https://attacker.invalid' }, payload: {} })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: `/api/agent/rooms/${room.id}/requests`, headers: { cookie }, payload: { request_id: randomUUID(), question, user_id: randomUUID() } })).statusCode, 400)
  } finally { await app.close(); await db.close() }
})

test('atomic competing reservations, KST day rollover, preserved known usage after response loss, cursor and ownership constraints', async () => {
  const { db, store } = await testDatabase()
  try {
    const a = await guest(store), room = await store.call('create_room', a)
    const ids = [randomUUID(), randomUUID()]
    const competing = await Promise.allSettled(ids.map(request_id => store.call('reserve', a, { room_id: room.id, request_id, question })))
    assert.equal(competing.filter(r => r.status === 'fulfilled').length, 1)
    const request = competing.find(r => r.status === 'fulfilled').value
    await store.call('step', a, { request_id: request.id, event: { seq: 1, kind: 'model', status: 'success' }, usage: { status: 'known', input_tokens: 123, output_tokens: 45 } })
    await store.call('finish', a, { request_id: request.id, status: 'failed', usage: { status: 'unknown' }, error_code: 'connection_failed' })
    const lost = await store.call('request', a, { request_id: request.id })
    assert.equal(lost.usage.status, 'unknown'); assert.equal(lost.usage.input_tokens, 123)
    // A full previous KST day cannot consume today's quota; today's two reservations still can.
    await db.query("INSERT INTO atlas_ai.usage(owner_key,day,used) VALUES($1,(now() AT TIME ZONE 'Asia/Seoul')::date-1,2)", [a])
    for (let i = 0; i < 2; i++) { const id = randomUUID(); await store.call('reserve', a, { room_id: room.id, request_id: id, question }); await store.call('finish', a, finish(id)) }
    const messages = (await store.call('messages', a, { room_id: room.id })).messages
    const earlier = (await store.call('messages', a, { room_id: room.id, before: messages[2].id })).messages
    assert.ok(earlier.every(m => BigInt(m.id) < BigInt(messages[2].id)))
    assert.equal((await store.call('rename_room', a, { room_id: room.id, title: '테스트 대화' })).title, '테스트 대화')
    const b = await guest(store), br = await store.call('create_room', b)
    await assert.rejects(db.query("INSERT INTO atlas_ai.messages(room_id,owner_key,request_id,role,content,answer) VALUES($1,$2,$3,'assistant','x','{}')", [br.id, b, request.id]), /foreign key/)
    await assert.rejects(db.query("INSERT INTO atlas_ai.owners(key) VALUES('invalid')"), /check constraint/)
    await assert.rejects(db.query("UPDATE atlas_ai.requests SET usage='{}' WHERE id=$1", [request.id]), /check constraint/)
    const auth = createAgentAuthenticator({ client: { auth: { getUser: async token => ({ data: { user: token === 'fixture' ? { id: 'fixture-user' } : null }, error: null }) } } })
    assert.equal(await auth('Bearer fixture'), 'fixture-user')
    await assert.rejects(auth('Bearer invalid'), /invalid_authentication/)
  } finally { await db.close() }
})
