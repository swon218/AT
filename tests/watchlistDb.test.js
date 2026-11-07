import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = await readFile(new URL('../deploy/WATCHLIST_SUPABASE.sql', import.meta.url), 'utf8')
const a = '11111111-1111-4111-8111-111111111111'
const b = '22222222-2222-4222-8222-222222222222'

test('watchlist SQL enforces owner access, uniqueness, the 20 slots and account cascade', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    insert into auth.users values ('${a}'), ('${b}');
  `)
  await db.exec(migration)
  const role = async (name, uid = '') => {
    await db.exec(`set role ${name}`)
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid])
  }
  const rows = async () => (await db.query('select * from public.watchlist_items')).rows
  const save = async (uid, code, saved = true, name = '테스트 종목') => (
    await db.query('select * from public.set_watchlist_item($1, $2, $3, $4)', [uid, code, saved, name])
  ).rows

  await role('anon')
  await assert.rejects(rows(), { code: '42501' })
  await assert.rejects(save(a, '005930'), { code: '42501' })
  await role('authenticated')
  await assert.rejects(save(a, '005930'), { code: '42501' })
  await role('authenticated', a)
  assert.deepEqual(await rows(), [])
  const first = await save(a, ' a005930 ')
  assert.equal(first[0].code, '005930')
  assert.deepEqual(await save(a, '005930', true, '다른 이름'), first)
  await assert.rejects(save(a, '5930'), { code: '22023' })
  await assert.rejects(save(b, '005930'), { code: '42501' })
  await assert.rejects(save(b, '005930', false), { code: '42501' })
  for (const sql of [
    `insert into public.watchlist_items(user_id, code, name, slot) values ('${a}', '000001', '직접 쓰기', 2)`,
    'update public.watchlist_items set slot = 20',
    'delete from public.watchlist_items',
  ]) await assert.rejects(db.exec(sql), { code: '42501' })

  await role('authenticated', b)
  assert.deepEqual(await rows(), [])
  assert.deepEqual(await save(b, '005930', false), [])
  assert.equal((await save(b, '005930')).length, 1)
  await role('authenticated', a)
  for (let i = 1; i <= 19; i++) {
    const current = await save(a, String(i).padStart(6, '0'))
    assert.equal(current.length, i + 1)
  }
  await assert.rejects(save(a, '000020'), { code: 'P0001', message: 'watchlist_limit' })
  assert.equal((await save(a, '005930')).length, 20)
  assert.equal((await save(a, '000001', false)).length, 19)
  const restored = await save(a, '0a12b3')
  assert.equal(restored.length, 20)
  assert.equal(restored[0].code, '0A12B3')

  await db.exec('reset role')
  await db.exec(migration)
  assert.equal((await rows()).length, 21)
  await assert.rejects(db.exec(`insert into public.watchlist_items(user_id, code, name, slot)
    values ('${a}', '999999', '잘못된 슬롯', 21)`), { code: '23514' })
  await assert.rejects(db.exec(`insert into public.watchlist_items(user_id, code, name, slot)
    values ('${a}', '999999', '중복 슬롯', 1)`), { code: '23505' })
  await db.query('delete from auth.users where id = $1', [a])
  assert.deepEqual((await rows()).map(row => row.user_id), [b])
})
