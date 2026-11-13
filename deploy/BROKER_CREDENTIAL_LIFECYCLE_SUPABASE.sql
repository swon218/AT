-- ATLAS 인증용 Supabase SQL Editor에서 전체 실행. 키/암호문을 붙여 넣지 않는다.
-- 순서: 복구 기준 기록 → 이 SQL 전체와 아래 확인 → 새 API → 프런트 통합 확인.
-- SQL 커밋 이후 구버전 개인설정 쓰기는 차단되며, 새 API 전환 전까지 읽기만 유지된다.
-- 기존 암호문/설정/이력을 삭제하지 않는다. 반복 실행은 기존 버전을 보존한다.
-- 구버전 GET은 호환되지만 직접 upsert 쓰기는 의도적으로 차단된다.
-- 이 SQL 이후 BROKERS_SUPABASE.sql 등 과거 권한 SQL을 재실행하지 않는다.
begin;

alter table public.user_integrations
  add column if not exists settings_version uuid not null default gen_random_uuid();
update public.user_integrations set settings_version = gen_random_uuid()
  where settings_version is null;
alter table public.user_integrations
  alter column settings_version set default gen_random_uuid(),
  alter column settings_version set not null;
alter table public.user_integrations enable row level security;

-- 브라우저는 메타데이터도 인증된 VPS API를 통해 조회한다.
-- service_role도 직접 INSERT/UPDATE/DELETE/TRUNCATE할 수 없다.
revoke all on table public.user_integrations from public, anon, authenticated, service_role;
do $$
declare v_columns text;
begin
  select string_agg(format('%I', attname), ',') into v_columns from pg_attribute
    where attrelid='public.user_integrations'::regclass and attnum>0 and not attisdropped;
  execute format('revoke all privileges (%s) on table public.user_integrations from public, anon, authenticated, service_role', v_columns);
end;
$$;
grant select on table public.user_integrations to service_role;
grant usage on schema public to service_role;

create or replace function public.atlas_broker_credentials_cas(
  p_user_id uuid, p_expected_version uuid, p_row jsonb
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_current uuid;
  v_next uuid;
  v_exists boolean;
  v_field text;
begin
  if p_user_id is null or jsonb_typeof(p_row) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'invalid_credentials_mutation';
  end if;
  foreach v_field in array array['credentials_ciphertext','credentials_iv','credentials_auth_tag'] loop
    if jsonb_typeof(p_row -> v_field) is distinct from 'string'
      or length(p_row ->> v_field) = 0 or length(p_row ->> v_field) > 1048576 then
      raise exception using errcode = '22023', message = 'invalid_credentials_mutation';
    end if;
  end loop;
  if (p_row ->> 'credentials_ciphertext') !~ '^[A-Za-z0-9+/]+={0,2}$'
    or length(p_row ->> 'credentials_ciphertext') % 4 <> 0
    or (p_row ->> 'credentials_iv') !~ '^[A-Za-z0-9+/]{16}$'
    or (p_row ->> 'credentials_auth_tag') !~ '^[A-Za-z0-9+/]{22}==$' then
    raise exception using errcode = '22023', message = 'invalid_credentials_mutation';
  end if;
  foreach v_field in array array['kiwoom_configured','toss_configured','nh_configured','kb_configured','telegram_configured'] loop
    if jsonb_typeof(p_row -> v_field) is distinct from 'boolean' then
      raise exception using errcode = '22023', message = 'invalid_credentials_mutation';
    end if;
  end loop;

  -- 없는 행의 동시 최초 등록도 동일 사용자 단위로 직렬화한다.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 6321991));
  select settings_version into v_current from public.user_integrations
    where user_id = p_user_id for update;
  v_exists := found;
  if v_current is distinct from p_expected_version then
    raise exception using errcode = '40001', message = 'credentials_version_conflict';
  end if;
  v_next := gen_random_uuid();

  if v_exists then
    update public.user_integrations set
      credentials_ciphertext = p_row ->> 'credentials_ciphertext',
      credentials_iv = p_row ->> 'credentials_iv',
      credentials_auth_tag = p_row ->> 'credentials_auth_tag',
      kiwoom_configured = (p_row ->> 'kiwoom_configured')::boolean,
      toss_configured = (p_row ->> 'toss_configured')::boolean,
      nh_configured = (p_row ->> 'nh_configured')::boolean,
      kb_configured = (p_row ->> 'kb_configured')::boolean,
      telegram_configured = (p_row ->> 'telegram_configured')::boolean,
      settings_version = v_next, updated_at = now()
    where user_id = p_user_id and settings_version = p_expected_version;
  else
    insert into public.user_integrations (
      user_id, credentials_ciphertext, credentials_iv, credentials_auth_tag,
      kiwoom_configured, toss_configured, nh_configured, kb_configured,
      telegram_configured, settings_version, updated_at
    ) values (
      p_user_id, p_row ->> 'credentials_ciphertext', p_row ->> 'credentials_iv',
      p_row ->> 'credentials_auth_tag', (p_row ->> 'kiwoom_configured')::boolean,
      (p_row ->> 'toss_configured')::boolean, (p_row ->> 'nh_configured')::boolean,
      (p_row ->> 'kb_configured')::boolean, (p_row ->> 'telegram_configured')::boolean,
      v_next, now()
    ) on conflict (user_id) do nothing;
  end if;
  if not found then
    raise exception using errcode = '40001', message = 'credentials_version_conflict';
  end if;
  return jsonb_build_object('version', v_next);
end;
$$;

revoke all on function public.atlas_broker_credentials_cas(uuid,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.atlas_broker_credentials_cas(uuid,uuid,jsonb) to service_role;
comment on function public.atlas_broker_credentials_cas(uuid,uuid,jsonb) is
  'atlas-broker-credentials-v1; service-only atomic encrypted-blob CAS; identity and no-overwrite/delete-confirmation enforced by authenticated VPS';
-- 소유권/상속 권한 등 예상 밖의 우회 권한이 남으면 전체 전환을 커밋하지 않는다.
do $$
declare v_role text;
begin
  foreach v_role in array array['anon','authenticated'] loop
    if has_any_column_privilege(v_role,'public.user_integrations','select,insert,update')
      or has_table_privilege(v_role,'public.user_integrations','delete,truncate')
      or has_function_privilege(v_role,'public.atlas_broker_credentials_cas(uuid,uuid,jsonb)','execute') then
      raise exception using errcode='55000', message='credential_privileges_require_review';
    end if;
  end loop;
  if has_any_column_privilege('service_role','public.user_integrations','insert,update')
    or has_table_privilege('service_role','public.user_integrations','delete,truncate')
    or (select relowner from pg_class where oid='public.user_integrations'::regclass)='service_role'::regrole
    or not has_function_privilege('service_role','public.atlas_broker_credentials_cas(uuid,uuid,jsonb)','execute') then
    raise exception using errcode='55000', message='credential_privileges_require_review';
  end if;
end;
$$;
notify pgrst, 'reload schema';
commit;

-- 확인 1: rpc_anon=false, rpc_member=false, rpc_service=true,
-- direct_insert=false, direct_update=false, direct_delete=false, service_read=true.
select
  has_function_privilege('anon','public.atlas_broker_credentials_cas(uuid,uuid,jsonb)','execute') as rpc_anon,
  has_function_privilege('authenticated','public.atlas_broker_credentials_cas(uuid,uuid,jsonb)','execute') as rpc_member,
  has_function_privilege('service_role','public.atlas_broker_credentials_cas(uuid,uuid,jsonb)','execute') as rpc_service,
  has_any_column_privilege('service_role','public.user_integrations','insert') as direct_insert,
  has_any_column_privilege('service_role','public.user_integrations','update') as direct_update,
  has_table_privilege('service_role','public.user_integrations','delete') as direct_delete,
  has_table_privilege('service_role','public.user_integrations','select') as service_read;
-- 확인 2: rls=true, null_versions=0. 회원별 값/암호문은 출력하지 않는다.
select c.relrowsecurity as rls,
  (select count(*) from public.user_integrations where settings_version is null) as null_versions
from pg_class c where c.oid='public.user_integrations'::regclass;
