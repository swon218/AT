-- ATLAS 인증용 Supabase SQL Editor에서 전체 실행합니다.
-- 순서: 복구 지점 확보 -> 이 SQL -> 마지막 확인 쿼리 -> API/전용 worker 배포.
-- 기존 관심종목/전략/주문/알림 테이블과 데이터는 변경하지 않습니다.
-- 반복 실행해도 매매 설정/실행/주문/체결 기록을 보존합니다.
-- 구버전 API는 이 신규 기능을 사용하지 않습니다. 롤백 시 테이블을 삭제하지 마세요.
begin;
set local lock_timeout = '5s';

create table if not exists public.trading_v1_configs (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 code text not null check(code ~ '^[0-9][0-9A-Z]{5}$'),
 revision integer not null default 1 check(revision>0),
 spec jsonb not null check(jsonb_typeof(spec)='object' and octet_length(spec::text)<=16384),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(owner_id,code)
);
create table if not exists public.trading_v1_accounts (
 account_key text primary key check(account_key ~ '^[a-f0-9]{64}$'),
 owner_id uuid not null references auth.users(id) on delete cascade,
 broker text not null check(broker in ('kiwoom','toss','nh','kb')),
 account_ref text not null check(char_length(account_ref) between 1 and 128),
 mode text not null check(mode in ('PAPER','LIVE')),
 lease_token uuid, lease_owner uuid, lease_epoch bigint not null default 0,
 lease_expires_at timestamptz,
 updated_at timestamptz not null default clock_timestamp(),
 unique(owner_id,broker,account_ref,mode)
);
create table if not exists public.trading_v1_previews (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 config_id uuid not null references public.trading_v1_configs(id) on delete cascade,
 config_revision integer not null,
 mode text not null check(mode in ('PAPER','LIVE')),
 snapshot jsonb not null,
 initial_state jsonb not null default '{}',
 expires_at timestamptz not null default (clock_timestamp()+interval '5 minutes'),
 consumed_at timestamptz,
 created_at timestamptz not null default clock_timestamp()
);
create table if not exists public.trading_v1_sessions (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 config_id uuid not null references public.trading_v1_configs(id) on delete cascade,
 account_key text not null references public.trading_v1_accounts(account_key) on delete cascade,
 broker text not null check(broker in ('kiwoom','toss','nh','kb')),
 account_ref text not null,
 code text not null,
 mode text not null check(mode in ('PAPER','LIVE')),
 request_id uuid not null,
 snapshot jsonb not null,
 state jsonb not null default '{}',
 status text not null default 'waiting_signal',
 revision integer not null default 1 check(revision>0),
 stop_requested boolean not null default false,
 abandon_requested boolean not null default false,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(owner_id,request_id),
 check(status in ('waiting_signal','waiting_funds','buying','holding','selling','closed','stopping','stopped','unknown','connection_required','reconciliation_required','completed','paused')),
 check(jsonb_typeof(state)='object' and octet_length(state::text)<=262144)
);
create unique index if not exists trading_v1_active_scope on public.trading_v1_sessions(owner_id,broker,account_ref,code,mode)
 where status not in ('stopped','completed');
create index if not exists trading_v1_sessions_account on public.trading_v1_sessions(account_key,created_at,id);
create index if not exists trading_v1_sessions_owner on public.trading_v1_sessions(owner_id,created_at desc,id);
create table if not exists public.trading_v1_intents (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 session_id uuid not null references public.trading_v1_sessions(id) on delete cascade,
 account_key text not null references public.trading_v1_accounts(account_key) on delete cascade,
 action_key text not null check(char_length(action_key) between 1 and 160),
 kind text not null check(kind in ('entry','take_profit','stop_loss','cancel')),
 side text not null check(side in ('buy','sell','cancel')),
 quantity bigint not null check(quantity between 1 and 1000000),
 price numeric(24,8) not null check(price>=0),
 cash_reservation numeric(24,8) not null default 0 check(cash_reservation>=0),
 status text not null default 'prepared' check(status in ('prepared','sending','accepted','partial','filled','cancelled','rejected','unknown')),
 broker_order_id text,
 cumulative_quantity bigint not null default 0 check(cumulative_quantity>=0 and cumulative_quantity<=quantity),
 cumulative_notional numeric(30,8) not null default 0 check(cumulative_notional>=0),
 metadata jsonb not null default '{}',
 dispatch_at timestamptz,
 write_granted_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(session_id,action_key),
 check((kind='entry' and side='buy' and price>0) or (kind in ('take_profit','stop_loss') and side='sell' and cash_reservation=0) or (kind='cancel' and cash_reservation=0))
);
create index if not exists trading_v1_intents_account on public.trading_v1_intents(account_key,status);
create table if not exists public.trading_v1_fills (
 intent_id uuid not null references public.trading_v1_intents(id) on delete cascade,
 fill_key text not null check(char_length(fill_key) between 1 and 160),
 quantity bigint not null check(quantity>0),
 price numeric(24,8) not null check(price>0),
 filled_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 primary key(intent_id,fill_key)
);
create table if not exists public.trading_v1_events (
 id bigint generated always as identity primary key,
 owner_id uuid not null references auth.users(id) on delete cascade,
 session_id uuid not null references public.trading_v1_sessions(id) on delete cascade,
 code text not null check(code ~ '^[a-z][a-z0-9_]{0,79}$'),
 data jsonb not null default '{}' check(jsonb_typeof(data)='object' and octet_length(data::text)<=8192),
 created_at timestamptz not null default clock_timestamp()
);
create index if not exists trading_v1_events_session on public.trading_v1_events(session_id,id desc);

-- Owner policy is defense in depth. Only the service-only RPC is granted access.
do $$ declare t text; cols text; begin
 foreach t in array array['configs','accounts','previews','sessions','intents','fills','events'] loop
  execute format('alter table public.trading_v1_%I enable row level security',t);
  execute format('revoke all on public.trading_v1_%I from public,anon,authenticated,service_role',t);
  select string_agg(format('%I',attname),',') into cols from pg_attribute
   where attrelid=format('public.trading_v1_%I',t)::regclass and attnum>0 and not attisdropped;
  execute format('revoke select (%s),insert (%s),update (%s),references (%s) on public.trading_v1_%I from public,anon,authenticated,service_role',cols,cols,cols,cols,t);
 end loop;
end $$;
revoke all on sequence public.trading_v1_events_id_seq from public,anon,authenticated,service_role;

create or replace function public.atlas_trading_rpc(p_action text,p_actor uuid,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
#variable_conflict use_variable
declare
 p jsonb := coalesce(p_payload,'{}');
 c public.trading_v1_configs;
 s public.trading_v1_sessions;
 a public.trading_v1_accounts;
 i public.trading_v1_intents;
 v public.trading_v1_previews;
 st public.strategies;
 spec jsonb; ev jsonb; f jsonb; output jsonb; account_key_value text;
 reserved numeric; cash numeric; amount numeric; cq bigint; cn numeric;
 fresh boolean; desired_status text; terminal boolean;
begin
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>524288 then raise exception 'trading_invalid_payload'; end if;
 if p_action='marker' then return jsonb_build_object('version','atlas-trading-v1'); end if;
 if p_action in ('context','session','save_config','preview_start','preview_read','start_read','start','stop') and p_actor is null then raise exception 'trading_auth_required'; end if;

 if p_action='context' then
  return jsonb_build_object(
   'watchlist',coalesce((select jsonb_agg(to_jsonb(w) order by w.created_at desc,w.code) from public.watchlist_items w where w.user_id=p_actor),'[]'),
   'strategies',coalesce((select jsonb_agg(to_jsonb(t) order by t.updated_at desc,t.id) from public.strategies t where t.user_id=p_actor),'[]'),
   'configs',coalesce((select jsonb_agg(to_jsonb(t) order by t.updated_at desc,t.id) from public.trading_v1_configs t where t.owner_id=p_actor and
    (exists(select 1 from public.watchlist_items w where w.user_id=p_actor and w.code=t.code) or exists(select 1 from public.trading_v1_sessions z where z.config_id=t.id and z.status not in ('stopped','completed')))),'[]'),
   'sessions',coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at desc,t.id) from public.trading_v1_sessions t where t.owner_id=p_actor and
    (t.status not in ('stopped','completed') or t.id in (select id from public.trading_v1_sessions where owner_id=p_actor and status in ('stopped','completed') order by created_at desc,id limit 200))),'[]'),
   'intents',coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at desc,t.id) from (select * from public.trading_v1_intents where owner_id=p_actor order by created_at desc,id limit 1000)t),'[]'),
   'events',coalesce((select jsonb_agg(to_jsonb(t) order by t.id desc) from (select * from public.trading_v1_events where owner_id=p_actor order by id desc limit 200)t),'[]'));
 elsif p_action='session' then
  select * into s from public.trading_v1_sessions where id=(p->>'sessionId')::uuid and owner_id=p_actor;
  if not found then raise exception 'trading_not_found'; end if;
  return jsonb_build_object('session',to_jsonb(s),
   'intents',coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at,t.id) from public.trading_v1_intents t where t.session_id=s.id),'[]'),
   'fills',coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at,f.fill_key) from public.trading_v1_fills f join public.trading_v1_intents t on t.id=f.intent_id where t.session_id=s.id),'[]'),
   'events',coalesce((select jsonb_agg(to_jsonb(t) order by t.id desc) from (select * from public.trading_v1_events where session_id=s.id order by id desc limit 200)t),'[]'));
 elsif p_action='save_config' then
  spec:=p->'spec';
  if jsonb_typeof(spec) is distinct from 'object' or octet_length(spec::text)>16384
   or not spec ?& array['code','broker','accountRef','strategyId','strategyRevision','quantityMode','quantity','entryAction']
   or exists(select 1 from jsonb_object_keys(spec) k where k not in ('code','broker','accountRef','strategyId','strategyRevision','quantityMode','quantity','entryAction','manageQuantity'))
   or coalesce(spec->>'code','') !~ '^[0-9][0-9A-Z]{5}$'
   or coalesce(spec->>'broker','') not in ('kiwoom','toss','nh','kb')
   or char_length(coalesce(spec->>'accountRef','')) not between 1 and 128
   or coalesce(spec->>'quantityMode','') not in ('fixed','all_cash')
   or coalesce(spec->>'entryAction','') not in ('signal','once','manage')
   or jsonb_typeof(spec->'quantity') is distinct from 'number'
   or jsonb_typeof(spec->'strategyRevision') is distinct from 'number'
   or (spec->>'quantity')::numeric not between 1 and 1000000
   or (spec->>'quantity')::numeric<>trunc((spec->>'quantity')::numeric)
   then raise exception 'trading_invalid_config'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text,7061601));
  if not exists(select 1 from public.watchlist_items where user_id=p_actor and code=spec->>'code') then raise exception 'trading_watchlist_required'; end if;
  select * into st from public.strategies where id=(spec->>'strategyId')::uuid and user_id=p_actor;
  if not found or st.revision is distinct from (spec->>'strategyRevision')::integer then raise exception 'trading_strategy_conflict'; end if;
  if st.schema_version<>2 or not public.atlas_strategy_definition_valid(st.indicators,st.backtest_settings)
   or jsonb_typeof(st.backtest_settings->'takeProfitPct') is distinct from 'number'
   or jsonb_typeof(st.backtest_settings->'stopLossPct') is distinct from 'number'
   then raise exception 'trading_strategy_invalid'; end if;
  if (exists(select 1 from jsonb_array_elements(st.backtest_settings->'entryConditions') x where x->>'enabled'='true'))
    is distinct from (spec->>'entryAction'='signal') then raise exception 'trading_entry_action'; end if;
  if spec->>'entryAction'='manage' and (not spec ? 'manageQuantity' or (spec->>'manageQuantity')::numeric not between 1 and 1000000 or (spec->>'manageQuantity')::numeric<>trunc((spec->>'manageQuantity')::numeric)) then raise exception 'trading_invalid_config'; end if;
  select * into c from public.trading_v1_configs where owner_id=p_actor and code=spec->>'code' for update;
  if found then
   if c.revision is distinct from (p->>'expectedRevision')::integer or (p ? 'id' and c.id is distinct from (p->>'id')::uuid) then raise exception 'trading_revision_conflict'; end if;
   if exists(select 1 from public.trading_v1_sessions where config_id=c.id and status not in ('stopped','completed')) then raise exception 'trading_run_active'; end if;
   update public.trading_v1_configs set spec=spec,revision=revision+1,updated_at=clock_timestamp() where id=c.id returning * into c;
  else
   if coalesce((p->>'expectedRevision')::integer,0)<>0 then raise exception 'trading_revision_conflict'; end if;
   insert into public.trading_v1_configs(owner_id,code,spec) values(p_actor,spec->>'code',spec) returning * into c;
  end if;
  return to_jsonb(c);
 elsif p_action='preview_start' then
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text,7061601));
  delete from public.trading_v1_previews where owner_id=p_actor and consumed_at is null and expires_at<clock_timestamp()-interval '1 day';
  if (select count(*) from public.trading_v1_previews where owner_id=p_actor and expires_at>clock_timestamp())>=40 then raise exception 'trading_preview_limit'; end if;
  select * into c from public.trading_v1_configs where id=(p->>'configId')::uuid and owner_id=p_actor;
  if not found then raise exception 'trading_not_found'; end if;
  if c.revision is distinct from (p->>'configRevision')::integer then raise exception 'trading_revision_conflict'; end if;
  select * into st from public.strategies where id=(c.spec->>'strategyId')::uuid and user_id=p_actor;
  if not found or st.revision is distinct from (c.spec->>'strategyRevision')::integer then raise exception 'trading_strategy_conflict'; end if;
  if not exists(select 1 from public.watchlist_items where user_id=p_actor and code=c.code) then raise exception 'trading_watchlist_required'; end if;
  if coalesce(p->>'mode','') not in ('PAPER','LIVE') or coalesce(p->>'credentialVersion','') !~ '^[a-f0-9]{64}$' then raise exception 'trading_invalid_preview'; end if;
  insert into public.trading_v1_previews(owner_id,config_id,config_revision,mode,snapshot,initial_state)
   values(p_actor,c.id,c.revision,p->>'mode',jsonb_build_object('spec',c.spec,'strategy',to_jsonb(st),'credentialVersion',p->>'credentialVersion','accountLabel',p->>'accountLabel'),coalesce(p->'initialState','{}')) returning * into v;
  return jsonb_build_object('id',v.id,'expiresAt',v.expires_at,'snapshot',v.snapshot);
 elsif p_action='preview_read' then
  select * into v from public.trading_v1_previews where id=(p->>'previewId')::uuid and owner_id=p_actor;
  if not found then raise exception 'trading_not_found'; end if;
  if v.consumed_at is not null or v.expires_at<=clock_timestamp() then raise exception 'trading_confirmation_expired'; end if;
  return jsonb_build_object('mode',v.mode,'spec',v.snapshot->'spec','credentialVersion',v.snapshot->>'credentialVersion','initialState',v.initial_state,'expiresAt',v.expires_at);
 elsif p_action='start_read' then
  select * into s from public.trading_v1_sessions where owner_id=p_actor and request_id=(p->>'requestId')::uuid;
  if not found then return 'null'::jsonb; end if;
  return to_jsonb(s);
 elsif p_action='start' then
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text,7061601));
  select * into s from public.trading_v1_sessions where owner_id=p_actor and request_id=(p->>'requestId')::uuid;
  if found then
   select * into v from public.trading_v1_previews where id=(p->>'previewId')::uuid and owner_id=p_actor;
   if not found or v.config_id<>s.config_id or v.snapshot<>s.snapshot then raise exception 'trading_request_conflict'; end if;
   return to_jsonb(s);
  end if;
  select * into v from public.trading_v1_previews where id=(p->>'previewId')::uuid and owner_id=p_actor for update;
  if not found then raise exception 'trading_not_found'; end if;
  if v.consumed_at is not null or v.expires_at<=clock_timestamp() or p->>'confirmed' is distinct from 'true' then raise exception 'trading_confirmation_expired'; end if;
  select * into c from public.trading_v1_configs where id=v.config_id and owner_id=p_actor;
  if c.revision<>v.config_revision then raise exception 'trading_revision_conflict'; end if;
  if not exists(select 1 from public.watchlist_items where user_id=p_actor and code=c.code) then raise exception 'trading_watchlist_required'; end if;
  if not exists(select 1 from public.strategies where id=(c.spec->>'strategyId')::uuid and user_id=p_actor and revision=(c.spec->>'strategyRevision')::integer) then raise exception 'trading_strategy_conflict'; end if;
  account_key_value:=encode(sha256(convert_to(p_actor::text||':'||(c.spec->>'broker')||':'||(c.spec->>'accountRef')||':'||v.mode,'UTF8')),'hex');
  insert into public.trading_v1_accounts(account_key,owner_id,broker,account_ref,mode) values(account_key_value,p_actor,c.spec->>'broker',c.spec->>'accountRef',v.mode) on conflict do nothing;
  if exists(select 1 from public.trading_v1_sessions where owner_id=p_actor and broker=c.spec->>'broker' and account_ref=c.spec->>'accountRef' and code=c.code and mode=v.mode and status not in ('stopped','completed')) then raise exception 'trading_run_active'; end if;
  if (select count(*) from public.trading_v1_sessions where owner_id=p_actor and status not in ('stopped','completed'))>=20 then raise exception 'trading_run_limit'; end if;
  insert into public.trading_v1_sessions(owner_id,config_id,account_key,broker,account_ref,code,mode,request_id,snapshot,state,status)
   values(p_actor,c.id,account_key_value,c.spec->>'broker',c.spec->>'accountRef',c.code,v.mode,(p->>'requestId')::uuid,v.snapshot,
    v.initial_state||jsonb_build_object('priority',(select q.priority from (select code,row_number() over(order by created_at desc,code) as priority from public.watchlist_items where user_id=p_actor)q where q.code=c.code)),
    case when coalesce((v.initial_state->'position'->>'quantity')::bigint,0)>0 then 'holding' else 'waiting_signal' end) returning * into s;
  update public.trading_v1_previews set consumed_at=clock_timestamp() where id=v.id;
  insert into public.trading_v1_events(owner_id,session_id,code) values(p_actor,s.id,'run_started');
  return to_jsonb(s);
 elsif p_action='stop' then
  select * into s from public.trading_v1_sessions where id=(p->>'sessionId')::uuid and owner_id=p_actor for update;
  if not found then raise exception 'trading_not_found'; end if;
  if s.revision is distinct from (p->>'expectedRevision')::integer then raise exception 'trading_revision_conflict'; end if;
  if s.status in ('stopped','completed') then return to_jsonb(s); end if;
  update public.trading_v1_sessions set stop_requested=true,abandon_requested=coalesce((p->>'abandon')::boolean,false),
   status=case when coalesce((s.state->'position'->>'quantity')::bigint,0)=0
    and not exists(select 1 from public.trading_v1_intents t where t.session_id=s.id and
     (t.status not in ('filled','cancelled','rejected') or t.cumulative_quantity>coalesce((s.state->'intentProgress'->t.id::text->>'quantity')::bigint,0))) then 'stopped' else 'stopping' end,
   revision=revision+1,updated_at=clock_timestamp() where id=s.id returning * into s;
  insert into public.trading_v1_events(owner_id,session_id,code) values(p_actor,s.id,case when s.abandon_requested then 'management_stop_requested' else 'stop_requested' end);
  return to_jsonb(s);
 elsif p_action='claim' then
  if p_actor is not null then raise exception 'trading_worker_only'; end if;
  if p->>'workerId' is null then raise exception 'trading_invalid_worker'; end if;
  -- One account is the serialization boundary, including competing stocks.
  select * into a from public.trading_v1_accounts x where (x.lease_expires_at is null or x.lease_expires_at<=clock_timestamp())
   and exists(select 1 from public.trading_v1_sessions z where z.account_key=x.account_key and z.status not in ('stopped','completed'))
   order by x.updated_at,x.account_key for update skip locked limit 1;
  if not found then return 'null'; end if;
  update public.trading_v1_accounts set lease_token=gen_random_uuid(),lease_owner=(p->>'workerId')::uuid,lease_epoch=lease_epoch+1,
   lease_expires_at=clock_timestamp()+make_interval(secs=>least(90,greatest(15,coalesce((p->>'leaseSeconds')::integer,60)))),updated_at=clock_timestamp() where account_key=a.account_key returning * into a;
  select coalesce(sum(cash_reservation),0) into reserved from public.trading_v1_intents where account_key=a.account_key and status not in ('filled','cancelled','rejected');
  return jsonb_build_object('lease',jsonb_build_object('accountKey',a.account_key,'ownerId',a.owner_id,'broker',a.broker,'accountRef',a.account_ref,'mode',a.mode,'token',a.lease_token,'epoch',a.lease_epoch,'expiresAt',a.lease_expires_at,'reservedCash',reserved),
   'sessions',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('watchlisted',exists(select 1 from public.watchlist_items w where w.user_id=t.owner_id and w.code=t.code)) order by coalesce((t.state->>'priority')::integer,2147483647),t.created_at,t.id) from public.trading_v1_sessions t where t.account_key=a.account_key and t.status not in ('stopped','completed')),'[]'),
   'intents',coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at,t.id) from public.trading_v1_intents t join public.trading_v1_sessions z on z.id=t.session_id where t.account_key=a.account_key and z.status not in ('stopped','completed')),'[]'));
 end if;

 -- All remaining operations are fenced worker-only transactions.
 if p_actor is not null then raise exception 'trading_worker_only'; end if;
 select * into a from public.trading_v1_accounts where account_key=p->'lease'->>'accountKey' for update;
 if not found or a.lease_token is null or a.lease_expires_at is null
  or a.lease_token is distinct from (p->'lease'->>'token')::uuid or a.lease_epoch is distinct from (p->'lease'->>'epoch')::bigint or a.lease_expires_at<=clock_timestamp() then raise exception 'trading_lease_lost'; end if;
 if p_action='renew' then
  update public.trading_v1_accounts set lease_expires_at=clock_timestamp()+interval '60 seconds' where account_key=a.account_key returning * into a;
  select coalesce(sum(cash_reservation),0) into reserved from public.trading_v1_intents where account_key=a.account_key and status not in ('filled','cancelled','rejected');
  return jsonb_build_object('expiresAt',a.lease_expires_at,'reservedCash',reserved);
 elsif p_action='release' then
  update public.trading_v1_accounts set lease_token=null,lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp() where account_key=a.account_key;
  return '{"ok":true}';
 elsif p_action='commit' then
  select * into s from public.trading_v1_sessions where id=(p->>'sessionId')::uuid and account_key=a.account_key for update;
  if not found then raise exception 'trading_not_found'; end if;
  if s.revision is distinct from (p->>'expectedRevision')::integer then raise exception 'trading_revision_conflict'; end if;
  if jsonb_typeof(p->'state') is distinct from 'object' then raise exception 'trading_invalid_state'; end if;
  desired_status:=coalesce(p->>'status',s.status);
  if s.stop_requested and desired_status in ('waiting_signal','waiting_funds','buying','holding','closed') then desired_status:='stopping'; end if;
  if desired_status in ('stopped','completed') and exists(select 1 from public.trading_v1_intents t where t.session_id=s.id and
   (t.status not in ('filled','cancelled','rejected') or t.cumulative_quantity>coalesce((p->'state'->'intentProgress'->t.id::text->>'quantity')::bigint,0))) then raise exception 'trading_unresolved_intent'; end if;
  update public.trading_v1_sessions set state=p->'state',status=desired_status,revision=revision+1,updated_at=clock_timestamp() where id=s.id returning * into s;
  for ev in select value from jsonb_array_elements(coalesce(p->'events','[]')) loop
   insert into public.trading_v1_events(owner_id,session_id,code,data) values(s.owner_id,s.id,ev->>'code',coalesce(ev->'data',ev-'code'));
  end loop;
  return to_jsonb(s);
 elsif p_action='prepare_intent' then
  select * into s from public.trading_v1_sessions where id=(p->>'sessionId')::uuid and account_key=a.account_key for update;
  if not found or s.status in ('stopped','completed') then raise exception 'trading_not_active'; end if;
  select * into i from public.trading_v1_intents where session_id=s.id and action_key=p->>'actionKey';
  if found then
   if i.side is distinct from p->>'side' or i.quantity is distinct from (p->>'quantity')::bigint or i.price is distinct from (p->>'price')::numeric or i.kind is distinct from p->>'kind' then raise exception 'trading_intent_conflict'; end if;
   return jsonb_build_object('intent',to_jsonb(i),'created',false);
  end if;
  if (s.stop_requested or not exists(select 1 from public.watchlist_items where user_id=s.owner_id and code=s.code)) and p->>'kind'='entry' then raise exception 'trading_entry_blocked'; end if;
  if s.abandon_requested and p->>'kind' in ('entry','take_profit','stop_loss') then raise exception 'trading_entry_blocked'; end if;
  if p->>'kind'='cancel' and not exists(select 1 from public.trading_v1_intents parent where parent.id=(p->'metadata'->>'parentIntentId')::uuid and parent.session_id=s.id and parent.kind='entry' and parent.status in ('accepted','partial') and parent.broker_order_id is not null) then raise exception 'trading_unowned_cancel'; end if;
  if exists(select 1 from public.trading_v1_intents where account_key=a.account_key and status in ('sending','unknown')) then raise exception 'trading_account_uncertain'; end if;
  if exists(select 1 from public.trading_v1_intents where session_id=s.id and status not in ('filled','cancelled','rejected')) and p->>'kind'<>'cancel' then raise exception 'trading_intent_active'; end if;
  amount:=coalesce((p->>'cashReservation')::numeric,0); cash:=coalesce((p->>'cashAvailable')::numeric,0);
  if amount<0 or cash<0 or (p->>'kind'='entry' and (amount<=0 or amount<(p->>'quantity')::numeric*(p->>'price')::numeric)) or (p->>'kind'<>'entry' and amount<>0) then raise exception 'trading_invalid_reservation'; end if;
  select coalesce(sum(cash_reservation),0) into reserved from public.trading_v1_intents where account_key=a.account_key and status not in ('filled','cancelled','rejected');
  if p->>'kind'='entry' and amount+reserved>cash then raise exception 'trading_insufficient_cash'; end if;
  insert into public.trading_v1_intents(owner_id,session_id,account_key,action_key,kind,side,quantity,price,cash_reservation,metadata)
   values(s.owner_id,s.id,a.account_key,p->>'actionKey',p->>'kind',p->>'side',(p->>'quantity')::bigint,(p->>'price')::numeric,amount,coalesce(p->'metadata','{}')) returning * into i;
  return jsonb_build_object('intent',to_jsonb(i),'created',true);
 elsif p_action in ('dispatch_intent','write_gate','settle_intent') then
  select * into i from public.trading_v1_intents where id=(p->>'intentId')::uuid and account_key=a.account_key for update;
  if not found then raise exception 'trading_not_found'; end if;
  if p_action='write_gate' then
   -- A consumed permit may already be in flight. Never release its cash or
   -- turn it into a definitive rejection merely because another caller retries.
   if i.status<>'sending' or i.write_granted_at is not null then
    return jsonb_build_object('allowed',false,'unknown',true,'reason','already_authorized_or_not_sending');
   end if;
   select * into s from public.trading_v1_sessions where id=i.session_id for update;
   if s.status in ('stopped','completed')
    or (i.kind='entry' and (s.stop_requested or not exists(select 1 from public.watchlist_items where user_id=s.owner_id and code=s.code)))
    or (s.abandon_requested and i.kind in ('entry','take_profit','stop_loss'))
    or (i.kind='cancel' and not exists(select 1 from public.trading_v1_intents parent where parent.id=(i.metadata->>'parentIntentId')::uuid and parent.session_id=s.id and parent.kind='entry' and parent.status in ('accepted','partial') and parent.broker_order_id is not null)) then
    update public.trading_v1_intents set status='rejected',cash_reservation=0,
     metadata=metadata||'{"notTransmitted":true,"writeGate":"blocked"}'::jsonb,updated_at=clock_timestamp() where id=i.id;
    return jsonb_build_object('allowed',false,'unknown',false,'reason','not_transmitted');
   end if;
   update public.trading_v1_intents set write_granted_at=clock_timestamp(),updated_at=clock_timestamp() where id=i.id;
   return jsonb_build_object('allowed',true);
  end if;
  if p_action='dispatch_intent' then
   if i.status<>'prepared' then return jsonb_build_object('dispatch',false,'intent',to_jsonb(i)); end if;
   select * into s from public.trading_v1_sessions where id=i.session_id;
   if (i.kind='entry' and (s.stop_requested or not exists(select 1 from public.watchlist_items where user_id=s.owner_id and code=s.code))) or (s.abandon_requested and i.kind in ('entry','take_profit','stop_loss')) then
    update public.trading_v1_intents set status='rejected',cash_reservation=0,updated_at=clock_timestamp() where id=i.id returning * into i;
    return jsonb_build_object('dispatch',false,'intent',to_jsonb(i));
   end if;
   update public.trading_v1_intents set status='sending',dispatch_at=clock_timestamp(),updated_at=clock_timestamp() where id=i.id returning * into i;
   return jsonb_build_object('dispatch',true,'intent',to_jsonb(i));
  end if;
  desired_status:=p->>'status';
  if desired_status not in ('accepted','partial','filled','cancelled','rejected','unknown') then raise exception 'trading_invalid_intent_state'; end if;
  cq:=coalesce((p->>'cumulativeQuantity')::bigint,i.cumulative_quantity); cn:=coalesce((p->>'cumulativeNotional')::numeric,i.cumulative_notional);
  if cq<i.cumulative_quantity then return jsonb_build_object('intent',to_jsonb(i),'ignored',true); end if;
  if cq>i.quantity or cq<0 or cn<0 or (cq>0 and cn<=0) or (cq=0 and cn<>0) then raise exception 'trading_invalid_fill'; end if;
  if cq=i.cumulative_quantity and cn<>i.cumulative_notional then raise exception 'trading_fill_conflict'; end if;
  if cq>i.cumulative_quantity and cn<=i.cumulative_notional then raise exception 'trading_fill_conflict'; end if;
  if i.broker_order_id is not null and p->>'brokerOrderId' is not null and i.broker_order_id<>p->>'brokerOrderId' then raise exception 'trading_order_conflict'; end if;
  if i.status in ('filled','cancelled','rejected') and cq=i.cumulative_quantity then return jsonb_build_object('intent',to_jsonb(i),'ignored',true); end if;
  -- Late fills after a cancel acknowledgement are retained; never erase executed quantity.
  if desired_status='filled' and cq<>i.quantity then raise exception 'trading_invalid_fill'; end if;
  if cq=i.quantity and desired_status<>'unknown' then desired_status:='filled'; end if;
  if i.status='cancelled' and cq<i.quantity then desired_status:='cancelled'; end if;
  terminal:=desired_status in ('filled','cancelled','rejected');
  for f in select value from jsonb_array_elements(coalesce(p->'fills','[]')) loop
   if exists(select 1 from public.trading_v1_fills where intent_id=i.id and fill_key=f->>'key' and (quantity<>(f->>'quantity')::bigint or price<>(f->>'price')::numeric)) then raise exception 'trading_fill_conflict'; end if;
   insert into public.trading_v1_fills(intent_id,fill_key,quantity,price,filled_at) values(i.id,f->>'key',(f->>'quantity')::bigint,(f->>'price')::numeric,(f->>'at')::timestamptz) on conflict do nothing;
  end loop;
  update public.trading_v1_intents set status=desired_status,broker_order_id=coalesce(broker_order_id,p->>'brokerOrderId'),cumulative_quantity=cq,cumulative_notional=cn,
   cash_reservation=case when terminal or (desired_status in ('accepted','partial') and p->>'cashReflected'='true') then 0 else cash_reservation end,
   metadata=metadata||coalesce(p->'metadata','{}'),updated_at=clock_timestamp() where id=i.id returning * into i;
  return jsonb_build_object('intent',to_jsonb(i),'ignored',false);
 end if;
 raise exception 'trading_invalid_operation';
end $$;
revoke all on function public.atlas_trading_rpc(text,uuid,jsonb) from public,anon,authenticated,service_role;
grant usage on schema public to service_role;
grant execute on function public.atlas_trading_rpc(text,uuid,jsonb) to service_role;
comment on function public.atlas_trading_rpc(text,uuid,jsonb) is 'atlas-trading-v1';
notify pgrst,'reload schema';
commit;

-- 기대값: false,false,true. RPC를 통해서만 서버가 접근합니다.
select has_function_privilege('anon','public.atlas_trading_rpc(text,uuid,jsonb)','execute') as anon,
 has_function_privilege('authenticated','public.atlas_trading_rpc(text,uuid,jsonb)','execute') as authenticated,
 has_function_privilege('service_role','public.atlas_trading_rpc(text,uuid,jsonb)','execute') as service_role;
-- 7행 모두 rls=true, browser_read=false, browser_write=false, service_write=false.
select c.relname,c.relrowsecurity as rls,
 (has_table_privilege('authenticated',c.oid,'select') or has_any_column_privilege('authenticated',c.oid,'select')) as browser_read,
 (has_table_privilege('authenticated',c.oid,'insert,update,delete') or has_any_column_privilege('authenticated',c.oid,'insert,update')) as browser_write,
 (has_table_privilege('service_role',c.oid,'insert,update,delete') or has_any_column_privilege('service_role',c.oid,'insert,update')) as service_write
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in ('trading_v1_configs','trading_v1_accounts','trading_v1_previews','trading_v1_sessions','trading_v1_intents','trading_v1_fills','trading_v1_events') order by c.relname;
-- 기대값 0,0. 회원/계좌/주문 행 원문은 출력하지 않습니다.
select (select count(*) from (select owner_id,broker,account_ref,code,mode from public.trading_v1_sessions where status not in ('stopped','completed') group by owner_id,broker,account_ref,code,mode having count(*)>1)q) as duplicate_active_scopes,
 (select count(*) from public.trading_v1_intents where cumulative_quantity>quantity or cash_reservation<0) as invalid_intents;
