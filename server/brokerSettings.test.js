import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { config } from './config.js'
import { updateAccountSettings, getAccountSettings, getAuthenticatedCredentials } from './accountSettings.js'
import { decryptCredentials } from './credentialCrypto.js'
import { createCredentialStore } from '../tests/support/credentialStore.js'

test('NH/KB key updates are encrypted per user, preserve existing keys and only return status', async () => {
  const previous = config.credentialEncryptionKey
  config.credentialEncryptionKey = 'a'.repeat(64)
  try {
    const store = createCredentialStore(), {rows,client} = store
    const dependencies = id => ({ client, authenticate: async () => ({ id }) })
    await updateAccountSettings({ body: { kiwoomAppKey: 'old-key', kiwoomSecretKey: 'old-secret', expectedVersion:null } }, dependencies('user-a'))
    const status = await updateAccountSettings({ body: { nhAppKey: 'nh-key', nhSecretKey: 'nh-secret', kbAppKey: 'kb-key', kbSecretKey: 'kb-secret', user_id: 'user-b', expectedVersion:store.version('user-a') } }, dependencies('user-a'))
    assert.equal(status.nhConfigured, true); assert.equal(status.kbConfigured, true); assert.equal(status.kiwoomConfigured, true)
    assert(!JSON.stringify(status).includes('secret'))
    const stored = rows.get('user-a')
    assert(!JSON.stringify(stored).includes('nh-secret'))
    assert(!rows.has('user-b'))
    const credentials = decryptCredentials('user-a', { ciphertext: stored.credentials_ciphertext, iv: stored.credentials_iv, authTag: stored.credentials_auth_tag })
    assert.equal(credentials.kiwoomAppKey, 'old-key')
    assert.equal(credentials.nhSecretKey, 'nh-secret')
    assert.equal(credentials.kbSecretKey, 'kb-secret')
    assert.throws(() => decryptCredentials('user-b', { ciphertext: stored.credentials_ciphertext, iv: stored.credentials_iv, authTag: stored.credentials_auth_tag }))
    await assert.rejects(updateAccountSettings({ body: { nhSecretKey: 'new-nh-secret', kbAppKey: '', expectedVersion:store.version('user-a') } }, dependencies('user-a')), {code:'credentials_already_saved'})
    assert.equal((await getAuthenticatedCredentials({}, dependencies('user-a'))).credentials.nhSecretKey, 'nh-secret')
    assert.equal((await getAccountSettings({}, dependencies('user-b'))).nhConfigured, false)
    await assert.rejects(updateAccountSettings({ body: { nhAppKey: 'blocked' } }, { client, authenticate: async () => { throw new Error('unauthenticated') } }), /unauthenticated/)
  } finally { config.credentialEncryptionKey = previous }
})

test('broker SQL is repeatable, preserves existing ciphertext and restricts browser access', async t => {
  const db = new PGlite(); t.after(() => db.close())
  const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    grant usage on schema public to anon, authenticated, service_role;
    insert into auth.users values ('${user}');
    create table public.user_integrations(user_id uuid primary key references auth.users(id), credentials_ciphertext text, kiwoom_configured boolean, toss_configured boolean);
    insert into public.user_integrations values ('${user}','preserved-ciphertext',true,false);`)
  const sql = await readFile(new URL('../deploy/BROKERS_SUPABASE.sql', import.meta.url), 'utf8')
  await db.exec(sql); await db.exec(sql)
  const row = (await db.query('select * from public.user_integrations')).rows[0]
  assert.equal(row.credentials_ciphertext, 'preserved-ciphertext')
  assert.equal(row.kiwoom_configured, true)
  assert.equal(row.nh_configured, false); assert.equal(row.kb_configured, false)
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role};`)
    await assert.rejects(db.query('select * from public.user_integrations'), /permission denied/)
    await assert.rejects(db.query('select * from public.broker_order_requests'), /permission denied/)
    await assert.rejects(db.query("update public.user_integrations set nh_configured=true"), /permission denied/)
    await db.exec('reset role;')
  }
  await db.exec('set role service_role;')
  const insert = () => db.query("insert into public.broker_order_requests(user_id,broker,request_id,request_digest) values ($1,'nh','request-00000001',$2)", [user, 'a'.repeat(64)])
  await insert()
  await assert.rejects(insert(), /duplicate key/)
  assert.equal((await db.query('select state from public.broker_order_requests')).rows[0].state, 'pending')
})
