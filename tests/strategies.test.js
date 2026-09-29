import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createIndicatorConfig } from '../src/utils/indicators.js'
import { DEFAULT_BACKTEST } from '../src/utils/backtest.js'
import { createStrategyRepository, strategyPayload, strategyError, STRATEGY_CONFLICT } from '../src/services/strategyRepository.js'

const input = () => ({ name: '이동평균 전략', indicators: [createIndicatorConfig('ma')], backtest_settings: { ...DEFAULT_BACKTEST, entry: ['ma-cross-up'], exit: ['ma-cross-down'] } })

test('strategy payload preserves settings and removes unrelated workspace/credential fields', () => {
  const data = input()
  data.name = '  이동평균 전략  '
  data.indicators[0].shortPeriod = '9'
  data.indicators[0].longPeriod = '20'
  data.indicators[0].shortColor = '#123abc'
  data.indicators[0].secret = 'must not save'
  Object.assign(data.backtest_settings, { symbol: '005930', start: '2021-01-01', end: '2026-01-01', token: 'must not save', feePct: '0.1' })
  const payload = strategyPayload(data)
  assert.equal(payload.name, '이동평균 전략')
  assert.equal(payload.indicators[0].shortPeriod, 9)
  assert.equal(payload.indicators[0].shortColor, '#123abc')
  assert.equal(payload.backtest_settings.feePct, 0.1)
  assert.deepEqual(payload.backtest_settings.entry, ['ma-cross-up'])
  assert(!JSON.stringify(payload).includes('must not save'))
  assert(!('symbol' in payload.backtest_settings))
  assert(!('start' in payload.backtest_settings))
  assert.deepEqual(strategyPayload(payload), payload)
})

test('invalid names, indicators, costs and orphan rules are rejected before writing', () => {
  for (const patch of [{ name: '' }, { name: 'x'.repeat(101) }, { indicators: [] }, { indicators: [createIndicatorConfig('unknown')] }, { indicators: [createIndicatorConfig('ma'), createIndicatorConfig('ma')] }, { indicators: [{ ...createIndicatorConfig('ma'), shortPeriod: 30 }] }, { indicators: [{ ...createIndicatorConfig('ma'), shortColor: 'javascript:bad' }] }, { backtest_settings: { ...DEFAULT_BACKTEST, feePct: -1 } }, { backtest_settings: { ...DEFAULT_BACKTEST, entry: ['rsi-low'] } }, { backtest_settings: { ...DEFAULT_BACKTEST, exitMode: 'bad' } }]) {
    assert.throws(() => strategyPayload({ ...input(), ...patch }))
  }
  assert.doesNotThrow(() => strategyPayload({ ...input(), backtest_settings: DEFAULT_BACKTEST }))
})

function mockClient(userId = 'owner', result = { data: [], error: null }) {
  const calls = []
  const chain = new Proxy({}, { get: (_, key) => key === 'then' ? (resolve, reject) => Promise.resolve(result).then(resolve, reject) : (...args) => { calls.push([key, ...args]); return chain } })
  return { calls, auth: { getSession: async () => ({ data: { session: userId ? { user: { id: userId } } : null }, error: null }) }, from: table => { calls.push(['from', table]); return chain } }
}

test('repository requires matching account before any request', async () => {
  const client = mockClient('different')
  const repo = createStrategyRepository(client)
  await assert.rejects(repo.list('owner'), /로그인 정보/)
  await assert.rejects(repo.save('owner', input()), /로그인 정보/)
  await assert.rejects(repo.remove('owner', { id: 'one', revision: 1 }), /로그인 정보/)
  assert.equal(client.calls.length, 0)
})

test('repository scopes writes to owner and revision and detects conflicts', async () => {
  const client = mockClient('owner', { data: null, error: null })
  const repo = createStrategyRepository(client)
  await assert.rejects(repo.save('owner', input(), { id: 'one', revision: 3 }), { message: STRATEGY_CONFLICT })
  assert(client.calls.some(call => JSON.stringify(call) === JSON.stringify(['eq', 'user_id', 'owner'])))
  assert(client.calls.some(call => JSON.stringify(call) === JSON.stringify(['eq', 'revision', 3])))
  await assert.rejects(repo.remove('owner', { id: 'one', revision: 3 }), { message: STRATEGY_CONFLICT })
  const created = mockClient('owner', { data: { id: 'new', revision: 1 }, error: null })
  await createStrategyRepository(created).save('owner', input())
  assert.equal(created.calls.find(call => call[0] === 'insert')[1].user_id, 'owner')
})

test('safe errors distinguish missing migration and duplicate names', () => {
  assert.match(strategyError({ code: 'PGRST205' }), /SQL/)
  assert.match(strategyError({ code: '23505' }), /같은 이름/)
  assert(!strategyError({ message: 'secret from server' }).includes('secret'))
})

test('Supabase migration enforces ownership, grants, revision and cascade in PostgreSQL', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to authenticated, anon;
    insert into auth.users values ('${A}'), ('${B}');`)
  const migration = await readFile(new URL('../deploy/STRATEGIES_SUPABASE.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  const as = async id => { await db.exec('reset role; set role authenticated;'); await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]) }
  const insert = (owner, name = 'First') => db.query('insert into public.strategies(user_id,name,indicators,backtest_settings) values ($1,$2,$3,$4) returning *', [owner, name, JSON.stringify(input().indicators), JSON.stringify(input().backtest_settings)])
  await as(A)
  const row = (await insert(A)).rows[0]
  assert.equal(row.revision, 1)
  await t.test('owner cannot spoof another owner or server-controlled metadata', async () => {
    await assert.rejects(insert(B), /row-level security/)
    await assert.rejects(db.query('update public.strategies set user_id=$1 where id=$2', [B, row.id]), /permission denied/)
    await assert.rejects(db.query('update public.strategies set revision=99 where id=$1', [row.id]), /permission denied/)
    await assert.rejects(db.query('update public.strategies set created_at=now() where id=$1', [row.id]), /permission denied/)
  })
  await t.test('another account cannot read, change or delete saved strategy', async () => {
    await as(B)
    assert.equal((await db.query('select * from public.strategies')).rows.length, 0)
    assert.equal((await db.query("update public.strategies set name='stolen' where id=$1 returning id", [row.id])).rows.length, 0)
    assert.equal((await db.query('delete from public.strategies where id=$1 returning id', [row.id])).rows.length, 0)
    await insert(B)
    await as(A)
    assert.equal((await db.query('select * from public.strategies')).rows.length, 1)
  })
  await t.test('optimistic revision prevents stale update and delete', async () => {
    const updated = (await db.query("update public.strategies set name='Updated' where id=$1 and revision=1 returning *", [row.id])).rows[0]
    assert.equal(updated.revision, 2)
    assert.equal(new Date(updated.created_at).valueOf(), new Date(row.created_at).valueOf())
    assert(new Date(updated.updated_at) >= new Date(row.updated_at))
    assert.equal((await db.query("update public.strategies set name='stale' where id=$1 and revision=1 returning id", [row.id])).rows.length, 0)
    assert.equal((await db.query('delete from public.strategies where id=$1 and revision=1 returning id', [row.id])).rows.length, 0)
  })
  await t.test('duplicate names and malformed JSON shape are rejected', async () => {
    await assert.rejects(insert(A, 'updated'), /unique constraint/)
    await assert.rejects(db.query("update public.strategies set indicators='[]' where id=$1", [row.id]), /check constraint/)
    await assert.rejects(db.query("update public.strategies set backtest_settings='[]' where id=$1", [row.id]), /check constraint/)
    await assert.rejects(insert(A, ' spaced '), /check constraint/)
  })
  await t.test('guests cannot access the table', async () => {
    await db.exec('reset role; set role anon;')
    await assert.rejects(db.query('select * from public.strategies'), /permission denied/)
    await assert.rejects(insert(A, 'guest'), /permission denied/)
    await assert.rejects(db.query('delete from public.strategies'), /permission denied/)
  })
  await t.test('rerunning migration preserves rows; account deletion cascades', async () => {
    await db.exec('reset role;')
    await db.exec(migration)
    assert.equal((await db.query('select * from public.strategies')).rows.length, 2)
    await db.query('delete from auth.users where id=$1', [A])
    assert.equal((await db.query('select * from public.strategies')).rows.length, 1)
    await as(B)
    assert.equal((await db.query('delete from public.strategies returning id')).rows.length, 1)
  })
})
