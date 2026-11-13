import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {PGlite} from '@electric-sql/pglite'

const migration=await readFile(new URL('../deploy/BROKER_CREDENTIAL_LIFECYCLE_SUPABASE.sql',import.meta.url),'utf8')
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222'
const row=(text,flags={})=>({credentials_ciphertext:Buffer.from(text).toString('base64'),credentials_iv:'A'.repeat(16),credentials_auth_tag:`${'A'.repeat(22)}==`,kiwoom_configured:false,toss_configured:false,nh_configured:false,kb_configured:false,telegram_configured:true,...flags})
async function fixture(t){
  const db=new PGlite();t.after(()=>db.close())
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    insert into auth.users values ('${a}'),('${b}');
    create table public.user_integrations(user_id uuid primary key references auth.users(id) on delete cascade,
      credentials_ciphertext text not null,credentials_iv text not null,credentials_auth_tag text not null,
      kiwoom_configured boolean not null default false,toss_configured boolean not null default false,
      nh_configured boolean not null default false,kb_configured boolean not null default false,
      telegram_configured boolean not null default false,updated_at timestamptz not null default now());
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    grant all on public.user_integrations to anon,authenticated,service_role;
    grant select(credentials_ciphertext), update(credentials_ciphertext),
      insert(user_id,credentials_ciphertext,credentials_iv,credentials_auth_tag)
      on public.user_integrations to anon,authenticated,service_role;
    grant usage on schema public to anon,authenticated,service_role;`)
  return {db,cas:async(owner,version,value)=>(await db.query('select public.atlas_broker_credentials_cas($1,$2,$3::jsonb) as result',[owner,version,JSON.stringify(value)])).rows[0].result,
    raw:async owner=>(await db.query('select * from public.user_integrations where user_id=$1',[owner])).rows[0]}
}

test('migration preserves existing encrypted blobs and versions, scopes grants and blocks direct writes',async t=>{
  const {db,cas,raw}=await fixture(t),original=row('opaque existing encrypted credentials',{kiwoom_configured:true})
  await db.query('insert into public.user_integrations(user_id,credentials_ciphertext,credentials_iv,credentials_auth_tag,kiwoom_configured,telegram_configured) values ($1,$2,$3,$4,true,true)',[a,original.credentials_ciphertext,original.credentials_iv,original.credentials_auth_tag])
  await db.exec('revoke usage on schema public from service_role')
  await db.exec(migration)
  assert.equal((await db.query("select has_schema_privilege('service_role','public','usage') as ok")).rows[0].ok,true)
  const before=await raw(a)
  assert.match(before.settings_version,/^[0-9a-f-]{36}$/)
  assert.equal(before.credentials_ciphertext,original.credentials_ciphertext)
  await db.exec(migration)
  assert.deepEqual(await raw(a),before)
  const grants=(await db.query(`select has_function_privilege('anon','public.atlas_broker_credentials_cas(uuid,uuid,jsonb)','execute') anon,
    has_function_privilege('authenticated','public.atlas_broker_credentials_cas(uuid,uuid,jsonb)','execute') member,
    has_function_privilege('service_role','public.atlas_broker_credentials_cas(uuid,uuid,jsonb)','execute') service,
    has_any_column_privilege('service_role','public.user_integrations','insert') ins,
    has_any_column_privilege('service_role','public.user_integrations','update') upd,
    has_table_privilege('service_role','public.user_integrations','delete') del`)).rows[0]
  assert.deepEqual(grants,{anon:false,member:false,service:true,ins:false,upd:false,del:false})
  assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.user_integrations'::regclass")).rows[0].relrowsecurity,true)
  for(const role of ['anon','authenticated','service_role']){
    await db.exec(`set role ${role}`)
    if(role==='service_role')assert.equal((await raw(a)).settings_version,before.settings_version)
    else {await assert.rejects(raw(a),{code:'42501'});await assert.rejects(db.query('select credentials_ciphertext from public.user_integrations'),{code:'42501'})}
    for(const sql of ['update public.user_integrations set kiwoom_configured=false',"update public.user_integrations set credentials_ciphertext='changed'",'delete from public.user_integrations','truncate public.user_integrations',`insert into public.user_integrations(user_id,credentials_ciphertext,credentials_iv,credentials_auth_tag) values ('${b}','x','x','x')`])await assert.rejects(db.exec(sql),{code:'42501'})
    if(role!=='service_role')await assert.rejects(cas(a,before.settings_version,original),{code:'42501'})
    await db.exec('reset role')
  }
})

test('real SQL CAS rejects stale writes, duplicate delete and insert races without losing another broker blob',async t=>{
  const {db,cas,raw}=await fixture(t);await db.exec(migration);await db.exec('set role service_role')
  // SQL treats encrypted data as opaque; server tests independently verify AES merge/deletion.
  const first=row('KI+TOSS+NH+KB+hidden Telegram',{kiwoom_configured:true,toss_configured:true,nh_configured:true,kb_configured:true})
  const initial=await cas(a,null,first)
  assert.deepEqual(Object.keys(initial),['version'])
  assert.ok(!JSON.stringify(initial).includes('credentials'))
  const retained=row('TOSS+NH+KB+hidden Telegram',{toss_configured:true,nh_configured:true,kb_configured:true})
  const attempts=await Promise.allSettled([cas(a,initial.version,retained),cas(a,initial.version,row('stale edited blob'))])
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(attempts.find(r=>r.status==='rejected').reason.code,'40001')
  const deleted=await raw(a)
  assert.equal(deleted.credentials_ciphertext,retained.credentials_ciphertext)
  assert.equal(deleted.kiwoom_configured,false);assert.equal(deleted.toss_configured,true)
  assert.notEqual(deleted.settings_version,initial.version)
  await assert.rejects(cas(a,initial.version,retained),{code:'40001',message:'credentials_version_conflict'})
  const registered=await cas(a,deleted.settings_version,first)
  await assert.rejects(cas(a,deleted.settings_version,retained),{code:'40001'})
  assert.equal((await raw(a)).settings_version,registered.version)
  assert.equal((await raw(a)).credentials_ciphertext,first.credentials_ciphertext)
  const inserts=await Promise.allSettled([cas(b,null,retained),cas(b,null,first)])
  assert.equal(inserts.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(inserts.find(r=>r.status==='rejected').reason.code,'40001')
  assert.equal((await raw(b)).credentials_ciphertext,retained.credentials_ciphertext)
  assert.equal((await raw(a)).settings_version,registered.version)
})

test('RPC rejects missing owner, invalid shape and expected versions while returning no ciphertext',async t=>{
  const {db,cas,raw}=await fixture(t);await db.exec(migration);await db.exec('set role service_role')
  await assert.rejects(cas(null,null,row('valid')),{code:'22023'})
  for(const invalid of [null,[],{},row('valid',{kiwoom_configured:'true'}),row('valid',{credentials_iv:'invalid'}),row('valid',{credentials_auth_tag:'invalid'})])await assert.rejects(cas(a,null,invalid),{code:'22023'})
  await assert.rejects(cas(a,'33333333-3333-4333-8333-333333333333',row('valid')),{code:'40001'})
  assert.equal(await raw(a),undefined)
  // Payload identity and version fields are not trusted or stored.
  const result=await cas(a,null,{...row('valid'),user_id:b,settings_version:'33333333-3333-4333-8333-333333333333'})
  assert.equal(await raw(b),undefined)
  assert.equal((await raw(a)).settings_version,result.version)
  assert.notEqual(result.version,'33333333-3333-4333-8333-333333333333')
  await assert.rejects(cas('44444444-4444-4444-8444-444444444444',null,row('valid')),{code:'23503'})
})

test('migration fails transactionally if an unexpected table owner retains an unrevokable write path',async t=>{
  const {db}=await fixture(t)
  await db.exec('alter table public.user_integrations owner to service_role')
  await assert.rejects(db.exec(migration),{code:'55000',message:'credential_privileges_require_review'})
  await db.exec('rollback')
  assert.equal((await db.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='user_integrations' and column_name='settings_version'")).rows[0].n,0)
})
