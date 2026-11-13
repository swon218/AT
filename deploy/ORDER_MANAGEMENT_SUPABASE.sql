-- Apply once (safe to repeat) before deploying the new API. Existing order tables are untouched.
begin;
create table if not exists public.broker_order_management_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null check (broker in ('kiwoom','toss','nh','kb')),
  request_id text not null check (request_id ~ '^[a-zA-Z0-9_-]{12,80}$'),
  order_scope text not null check (order_scope ~ '^[a-f0-9]{64}$'),
  account_scope text not null check (account_scope ~ '^[a-f0-9]{64}$'),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  expected_version text not null check (expected_version ~ '^[a-f0-9]{64}$'),
  action text not null check (action in ('amend','cancel')),
  state text not null default 'pending' check (state in ('pending','accepted','uncertain','observed','rejected')),
  result jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(user_id,broker,request_id)
);
create unique index if not exists broker_order_management_active on public.broker_order_management_requests(order_scope) where state in ('pending','accepted','uncertain');
alter table public.broker_order_management_requests enable row level security;
revoke all on public.broker_order_management_requests from public,anon,authenticated,service_role;
create or replace function public.atlas_order_management_rpc(op text, actor uuid, p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.broker_order_management_requests; v jsonb;
begin
  if actor is null or p->>'broker' not in ('kiwoom','toss','nh','kb') then raise exception 'invalid_actor_or_broker'; end if;
  if op='read_marker' then
    return pg_catalog.jsonb_build_object('at',pg_catalog.clock_timestamp());
  elsif op='lookup' then
    select * into r from public.broker_order_management_requests where user_id=actor and broker=p->>'broker' and request_id=p->>'requestId';
    if not found then return 'null'::jsonb; end if;
    if r.request_digest<>p->>'digest' then raise exception 'request_conflict'; end if;
    return pg_catalog.jsonb_build_object('fresh',false,'state',r.state,'result',r.result);
  elsif op='reserve' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p->>'scope',0));
    select * into r from public.broker_order_management_requests where user_id=actor and broker=p->>'broker' and request_id=p->>'requestId';
    if found then
      if r.request_digest<>p->>'digest' then raise exception 'request_conflict'; end if;
      return pg_catalog.jsonb_build_object('fresh',false,'state',r.state,'result',r.result);
    end if;
    if exists(select 1 from public.broker_order_management_requests where order_scope=p->>'scope' and state in ('pending','accepted','uncertain')) then raise exception 'order_locked'; end if;
    insert into public.broker_order_management_requests(user_id,broker,request_id,order_scope,account_scope,request_digest,expected_version,action)
      values(actor,p->>'broker',p->>'requestId',p->>'scope',p->>'accountScope',p->>'digest',p->>'version',p->>'action');
    return '{"fresh":true,"state":"pending"}';
  elsif op='finish' then
    if p->>'state' not in ('accepted','uncertain','rejected') then raise exception 'invalid_state'; end if;
    update public.broker_order_management_requests set state=p->>'state',result=coalesce(p->'result','{}'),updated_at=now()
      where user_id=actor and broker=p->>'broker' and request_id=p->>'requestId' and request_digest=p->>'digest' and state='pending';
    if not found then raise exception 'request_not_pending'; end if;
    return '{"ok":true}';
  elsif op in ('observe','reconcile') then
    -- Only an accepted request may be released after a COMPLETE authoritative read.
    -- Absence/change is not labelled completion. Uncertain/pending requests stay locked.
    if pg_catalog.jsonb_typeof(p->'orders') is distinct from 'array' then raise exception 'invalid_orders'; end if;
    update public.broker_order_management_requests q set state='observed',updated_at=now()
      where q.user_id=actor and q.broker=p->>'broker' and q.state='accepted'
      and q.account_scope=p->>'accountScope'
      and q.updated_at < (p->>'readMarker')::timestamptz
      and not exists(select 1 from pg_catalog.jsonb_array_elements(p->'orders') x where x->>'scope'=q.order_scope and x->>'version'=q.expected_version);
    if op='observe' then return '{"ok":true}'; end if;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('scope',order_scope,'state',state)),'[]') into v
      from public.broker_order_management_requests where user_id=actor and broker=p->>'broker' and account_scope=p->>'accountScope' and state in ('pending','accepted','uncertain');
    return v;
  elsif op='locks' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('scope',order_scope,'state',state)),'[]') into v
      from public.broker_order_management_requests where user_id=actor and broker=p->>'broker' and account_scope=p->>'accountScope' and state in ('pending','accepted','uncertain');
    return v;
  end if;
  raise exception 'invalid_operation';
end $$;
revoke all on function public.atlas_order_management_rpc(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.atlas_order_management_rpc(text,uuid,jsonb) to service_role;
comment on function public.atlas_order_management_rpc(text,uuid,jsonb) is 'atlas-order-management-v1';
commit;
-- Expected: false,false,true and false,false,false. No account/order rows are printed.
select has_function_privilege('anon','public.atlas_order_management_rpc(text,uuid,jsonb)','execute') as anon,
 has_function_privilege('authenticated','public.atlas_order_management_rpc(text,uuid,jsonb)','execute') as authenticated,
 has_function_privilege('service_role','public.atlas_order_management_rpc(text,uuid,jsonb)','execute') as service_role;
select has_table_privilege('anon','public.broker_order_management_requests','insert') as anon_write,
 has_table_privilege('authenticated','public.broker_order_management_requests','insert') as member_write,
 has_table_privilege('service_role','public.broker_order_management_requests','insert') as service_write;
