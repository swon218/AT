-- V1 적용 DB 전용 추가 마이그레이션. 백업 후 전체 실행합니다.
-- 기존 V1 SQL을 다시 실행하지 마세요. 기존 설정/실행/주문/체결은 보존합니다.
begin;
set local lock_timeout='5s';
do $$ declare marker text; begin
 if to_regprocedure('public.atlas_trading_rpc(text,uuid,jsonb)') is null then raise exception 'trading_v1_required'; end if;
 select obj_description('public.atlas_trading_rpc(text,uuid,jsonb)'::regprocedure,'pg_proc') into marker;
 if marker='atlas-trading-v1' and to_regprocedure('public.atlas_trading_v1_base(text,uuid,jsonb)') is null then
  alter function public.atlas_trading_rpc(text,uuid,jsonb) rename to atlas_trading_v1_base;
 elsif marker is distinct from 'atlas-trading-v2' or to_regprocedure('public.atlas_trading_v1_base(text,uuid,jsonb)') is null then
  raise exception 'trading_schema_conflict';
 end if;
end $$;
alter table public.trading_v1_configs add column if not exists account_label text not null default '본인 API 계좌';
alter table public.trading_v1_configs add column if not exists strategy_snapshot jsonb;
-- Credentials remain in their existing encrypted store. Broker-local epochs
-- prevent editing one broker from invalidating another broker's protection.
-- Existing runs used settings_version: the initial backfill MUST be identical.
alter table public.user_integrations add column if not exists trading_broker_versions jsonb not null default '{}';
update public.user_integrations set trading_broker_versions=jsonb_build_object(
 'kiwoom',coalesce(trading_broker_versions->>'kiwoom',settings_version::text),
 'toss',coalesce(trading_broker_versions->>'toss',settings_version::text),
 'nh',coalesce(trading_broker_versions->>'nh',settings_version::text),
 'kb',coalesce(trading_broker_versions->>'kb',settings_version::text))
 where not trading_broker_versions ?& array['kiwoom','toss','nh','kb'];
create or replace function public.atlas_trading_broker_epoch_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare epochs jsonb:='{}'; broker text; epoch text; changed boolean; baseline text;
begin
 if tg_op='INSERT' then
  -- The existing CAS generates a fresh global UUID for every new row. Keeping
  -- that initial value also permits an old API to read during the rollout.
  baseline:=coalesce(new.settings_version::text,gen_random_uuid()::text);
  new.trading_broker_versions:=jsonb_build_object('kiwoom',baseline,'toss',baseline,'nh',baseline,'kb',baseline);
  return new;
 end if;
 foreach broker in array array['kiwoom','toss','nh','kb'] loop
  epoch:=coalesce(old.trading_broker_versions->>broker,old.settings_version::text);
  changed:=case broker
   when 'kiwoom' then new.kiwoom_configured is distinct from old.kiwoom_configured
   when 'toss' then new.toss_configured is distinct from old.toss_configured
   when 'nh' then new.nh_configured is distinct from old.nh_configured
   when 'kb' then new.kb_configured is distinct from old.kb_configured end;
  if changed then epoch:=gen_random_uuid()::text; end if;
  epochs:=epochs||jsonb_build_object(broker,epoch);
 end loop;
 -- A caller cannot provide or restore an older epoch through an UPDATE.
 new.trading_broker_versions:=epochs;
 return new;
end $$;
revoke all on function public.atlas_trading_broker_epoch_guard() from public,anon,authenticated,service_role;
drop trigger if exists atlas_trading_broker_epoch_guard on public.user_integrations;
create trigger atlas_trading_broker_epoch_guard before insert or update on public.user_integrations
 for each row execute function public.atlas_trading_broker_epoch_guard();
revoke select(trading_broker_versions),insert(trading_broker_versions),update(trading_broker_versions),references(trading_broker_versions)
 on public.user_integrations from public,anon,authenticated,service_role;
grant select(trading_broker_versions) on public.user_integrations to service_role;
do $$ begin
 if has_any_column_privilege('service_role','public.user_integrations','insert,update')
  or has_table_privilege('service_role','public.user_integrations','delete,truncate')
  or has_any_column_privilege('anon','public.user_integrations','select,insert,update')
  or has_any_column_privilege('authenticated','public.user_integrations','select,insert,update') then
  raise exception 'trading_credentials_privileges_require_review';
 end if;
end $$;
-- 이전 버전을 현재 전략으로 꾸미지 않습니다. 정확히 일치하는 버전만 보완합니다.
update public.trading_v1_configs c set strategy_snapshot=to_jsonb(s)
 from public.strategies s where c.strategy_snapshot is null and s.user_id=c.owner_id
 and s.id=(c.spec->>'strategyId')::uuid and s.revision=(c.spec->>'strategyRevision')::integer;
revoke select(account_label,strategy_snapshot),insert(account_label,strategy_snapshot),update(account_label,strategy_snapshot),references(account_label,strategy_snapshot)
 on public.trading_v1_configs from public,anon,authenticated,service_role;
revoke all on function public.atlas_trading_v1_base(text,uuid,jsonb) from public,anon,authenticated,service_role;

create or replace function public.atlas_trading_rpc(p_action text,p_actor uuid,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
 p jsonb:=coalesce(p_payload,'{}'); result jsonb; policy jsonb; target uuid; broker text;
 row_config public.trading_v1_configs; row_preview public.trading_v1_previews; row_strategy public.strategies; snap jsonb;
begin
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>524288 then raise exception 'trading_invalid_payload'; end if;
 if p_action='marker' then return '{"version":"atlas-trading-v2","legacy":"atlas-trading-v1","executionPolicySnapshots":true}'::jsonb; end if;
 if p_action in ('save_config','preview_start','preview_read','start') then
  if p_actor is null then raise exception 'trading_auth_required'; end if;
 end if;
 if p_action='save_config' then
  if p ? 'accountLabel' and (jsonb_typeof(p->'accountLabel') is distinct from 'string' or char_length(p->>'accountLabel') not between 1 and 80 or p->>'accountLabel' ~ '[[:cntrl:]]') then raise exception 'trading_invalid_account_label'; end if;
  -- Keep the version validated by the base RPC stable until its immutable
  -- display snapshot has been written; a concurrent edit/delete must wait.
  select * into row_strategy from public.strategies s where s.user_id=p_actor
   and s.id=(p->'spec'->>'strategyId')::uuid for share;
  if not found or row_strategy.revision is distinct from (p->'spec'->>'strategyRevision')::integer then raise exception 'trading_strategy_conflict'; end if;
  result:=public.atlas_trading_v1_base(p_action,p_actor,p);
  target:=(result->>'id')::uuid;
  update public.trading_v1_configs c set account_label=coalesce(p->>'accountLabel',c.account_label),
   strategy_snapshot=to_jsonb(row_strategy)
   where c.id=target and c.owner_id=p_actor returning * into row_config;
  return to_jsonb(row_config);
 elsif p_action='preview_start' then
  -- The broker policy is selected in SQL, never accepted from a browser payload.
  result:=public.atlas_trading_v1_base(p_action,p_actor,p);
  select * into row_preview from public.trading_v1_previews where id=(result->>'id')::uuid and owner_id=p_actor for update;
  broker:=row_preview.snapshot->'spec'->>'broker';
  policy:=case broker
   when 'kiwoom' then '{"version":"krx-cash-v1","route":"KRX","quoteMarket":"KRX","chartMarket":"KRX","tradingWindow":"KRX_REGULAR","routeLabel":"KRX 지정","quoteLabel":"KRX 체결 시세","chartLabel":"KRX 캔들","entryOrder":"KRX 현금 지정가 · 60초 후 잔량 취소 확인","exitOrder":"KRX 현금 시장가"}'::jsonb
   when 'toss' then '{"version":"toss-default-sor-v2","route":"SOR","quoteMarket":"PROVIDER","chartMarket":"PROVIDER","tradingWindow":"KRX_REGULAR","routeLabel":"토스 기본 SOR · KRX 지정 아님","quoteLabel":"토스 제공 시세 · 거래소 미제공","chartLabel":"토스 제공 캔들 · 거래소 미제공","entryOrder":"토스 기본 SOR 현금 지정가 DAY · 60초 후 잔량 취소 확인","exitOrder":"토스 기본 SOR 현금 시장가 DAY"}'::jsonb
   when 'nh' then '{"version":"nh-krx-cash-v2","route":"KRX","quoteMarket":"KRX","chartMarket":"KRX","tradingWindow":"KRX_REGULAR","routeLabel":"KRX 지정","quoteLabel":"KRX 체결 시세","chartLabel":"KRX 캔들","entryOrder":"NH KRX 현금 지정가 · 60초 후 잔량 취소 확인","exitOrder":"NH KRX 현금 시장가"}'::jsonb
   else null end;
  if policy is null then raise exception 'trading_policy_unsupported'; end if;
  select * into row_config from public.trading_v1_configs where id=row_preview.config_id and owner_id=p_actor;
  snap:=row_preview.snapshot||jsonb_build_object('executionPolicy',policy,'accountLabel',row_config.account_label);
  update public.trading_v1_previews set snapshot=snap where id=row_preview.id;
  return result||jsonb_build_object('snapshot',snap);
 elsif p_action='preview_read' then
  result:=public.atlas_trading_v1_base(p_action,p_actor,p);
  select * into row_preview from public.trading_v1_previews where id=(p->>'previewId')::uuid and owner_id=p_actor;
  return result||jsonb_build_object('executionPolicy',row_preview.snapshot->'executionPolicy','accountLabel',row_preview.snapshot->>'accountLabel');
 elsif p_action='start' then
  select * into row_preview from public.trading_v1_previews where id=(p->>'previewId')::uuid and owner_id=p_actor;
  if not found then raise exception 'trading_not_found'; end if;
  broker:=row_preview.snapshot->'spec'->>'broker';
  -- Existing Kiwoom V1 previews are compatible. New venues require a V2 snapshot.
  if broker<>'kiwoom' and (row_preview.snapshot->'executionPolicy'->>'version' is distinct from case broker when 'toss' then 'toss-default-sor-v2' when 'nh' then 'nh-krx-cash-v2' else '' end) then raise exception 'trading_policy_mismatch'; end if;
 end if;
 return public.atlas_trading_v1_base(p_action,p_actor,p);
end $$;
revoke all on function public.atlas_trading_rpc(text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.atlas_trading_rpc(text,uuid,jsonb) to service_role;
comment on function public.atlas_trading_rpc(text,uuid,jsonb) is 'atlas-trading-v2';
notify pgrst,'reload schema';
commit;

-- 기대값: atlas-trading-v2 / false,false,true / false,false,false.
select obj_description('public.atlas_trading_rpc(text,uuid,jsonb)'::regprocedure,'pg_proc') as marker;
select has_function_privilege('anon','public.atlas_trading_rpc(text,uuid,jsonb)','execute') as anon,
 has_function_privilege('authenticated','public.atlas_trading_rpc(text,uuid,jsonb)','execute') as authenticated,
 has_function_privilege('service_role','public.atlas_trading_rpc(text,uuid,jsonb)','execute') as service_role;
select has_function_privilege('anon','public.atlas_trading_v1_base(text,uuid,jsonb)','execute') as anon,
 has_function_privilege('authenticated','public.atlas_trading_v1_base(text,uuid,jsonb)','execute') as authenticated,
 has_function_privilege('service_role','public.atlas_trading_v1_base(text,uuid,jsonb)','execute') as service_role;
-- 7행 모두 RLS=true, 직접 접근=false. 기존 데이터 원문은 표시하지 않습니다.
select c.relname,c.relrowsecurity as rls,
 has_table_privilege('authenticated',c.oid,'select,insert,update,delete') or has_any_column_privilege('authenticated',c.oid,'select,insert,update') as member_direct_access,
 has_table_privilege('service_role',c.oid,'select,insert,update,delete') or has_any_column_privilege('service_role',c.oid,'select,insert,update') as service_direct_access
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
 and c.relname in ('trading_v1_configs','trading_v1_accounts','trading_v1_previews','trading_v1_sessions','trading_v1_intents','trading_v1_fills','trading_v1_events') order by c.relname;
-- 기존 세션은 수정하지 않았습니다. 대상별 건수만 비교용으로 확인합니다.
select (select count(*) from public.trading_v1_configs) configs,(select count(*) from public.trading_v1_sessions) sessions,
 (select count(*) from public.trading_v1_intents) intents,(select count(*) from public.trading_v1_fills) fills;
-- Broker epochs are private metadata. Expected false,false,true / false,false,false.
select has_column_privilege('anon','public.user_integrations','trading_broker_versions','select') as anon_read,
 has_column_privilege('authenticated','public.user_integrations','trading_broker_versions','select') as member_read,
 has_column_privilege('service_role','public.user_integrations','trading_broker_versions','select') as service_read,
 has_column_privilege('service_role','public.user_integrations','trading_broker_versions','insert,update') as service_write,
 has_function_privilege('authenticated','public.atlas_trading_broker_epoch_guard()','execute') as member_execute,
 has_function_privilege('service_role','public.atlas_trading_broker_epoch_guard()','execute') as service_execute;
-- Expected 0. No ciphertext, user identifiers or per-user version values are printed.
select count(*) as missing_broker_epochs from public.user_integrations
 where not trading_broker_versions ?& array['kiwoom','toss','nh','kb'];
