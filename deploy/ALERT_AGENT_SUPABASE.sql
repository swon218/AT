-- Apply after WATCHLIST_SUPABASE.sql and KAKAO_CONNECTION_SUPABASE.sql.
begin;

do $$ begin
  if to_regprocedure('public.atlas_alert_rpc_v2(text,jsonb)') is not null then
    raise exception 'Alert v2 is already installed; do not reapply the v1 baseline';
  end if;
end $$;

create table if not exists public.atlas_alert_rules (
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null check (code ~ '^[0-9][0-9A-Z]{5}$'),
  version uuid not null default gen_random_uuid(),
  kakao_id text not null,
  kind text not null check (kind in ('price_gte','price_lte','rise_gte','fall_lte')),
  threshold numeric not null check (
    (kind in ('price_gte','price_lte') and threshold between 1 and 1000000000 and threshold = trunc(threshold))
    or (kind in ('rise_gte','fall_lte') and threshold between 0 and 100 and threshold = round(threshold,2))
  ),
  expires_on date not null,
  status text not null check (status in ('active','stopped','expired','queued','sent','failed','unknown')),
  reason text,
  next_check timestamptz not null default now(),
  scope_check timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id,code)
);
create index if not exists atlas_alert_rules_due on public.atlas_alert_rules(next_check,code) where status = 'active';

create table if not exists public.atlas_alert_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  name text not null,
  version uuid not null,
  kind text not null,
  threshold numeric not null,
  observed_at timestamptz not null,
  trade_day date not null,
  base_day date not null,
  market text not null check (market = 'KRX'),
  price bigint not null check (price > 0),
  change_rate numeric not null,
  created_at timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','unknown','canceled')),
  attempts integer not null default 0 check (attempts between 0 and 2),
  next_try timestamptz not null default now(),
  operation uuid,
  lease_until timestamptz,
  reason text,
  finished_at timestamptz,
  unique (user_id,code,version)
);
create index if not exists atlas_alert_events_history on public.atlas_alert_events(user_id,created_at desc);
create index if not exists atlas_alert_events_queue on public.atlas_alert_events(next_try) where status = 'queued';
create index if not exists atlas_alert_events_in_flight on public.atlas_alert_events(user_id,lease_until) where status = 'sending';

create table if not exists public.atlas_alert_attempts (
  event_id uuid not null references public.atlas_alert_events(id) on delete cascade,
  attempt integer not null check (attempt between 1 and 2),
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  result text not null check (result in ('sending','sent','failed','retry','unknown')),
  reason text,
  primary key (event_id,attempt)
);
create index if not exists atlas_alert_attempts_requested on public.atlas_alert_attempts(requested_at);
create table if not exists public.atlas_alert_worker (
  singleton boolean primary key default true check (singleton),
  operation uuid,
  lease_until timestamptz,
  next_tick timestamptz not null default now()
);
insert into public.atlas_alert_worker(singleton) values (true) on conflict do nothing;
alter table public.atlas_kakao_oauth add column if not exists alert_kakao_id text;

alter table public.atlas_alert_rules enable row level security;
alter table public.atlas_alert_events enable row level security;
alter table public.atlas_alert_attempts enable row level security;
alter table public.atlas_alert_worker enable row level security;
revoke all on public.atlas_alert_rules, public.atlas_alert_events, public.atlas_alert_attempts, public.atlas_alert_worker
  from public, anon, authenticated, service_role;

create or replace function public.atlas_alert_lock(owner_id uuid)
returns void language sql set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended(owner_id::text, 481922));
$$;

create or replace function public.atlas_alert_stop(owner_id uuid, stock_code text, why text)
returns void language plpgsql set search_path = '' as $$
begin
  perform public.atlas_alert_lock(owner_id);
  if exists (select 1 from public.atlas_alert_events
    where user_id=owner_id and (stock_code is null or code=stock_code)
      and status='sending' and lease_until > clock_timestamp()) then
    raise exception 'alert_dispatch_in_progress';
  end if;
  update public.atlas_alert_rules set status='stopped', reason=why, version=gen_random_uuid(), updated_at=now()
    where user_id=owner_id and (stock_code is null or code=stock_code) and status in ('active','queued');
  update public.atlas_alert_events set status='canceled', reason=why, finished_at=now()
    where user_id=owner_id and (stock_code is null or code=stock_code) and status='queued';
end;
$$;

create or replace function public.atlas_alert_dependency()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'watchlist_items' then
    perform public.atlas_alert_stop(old.user_id,old.code,'watchlist_removed');
  elsif tg_op = 'DELETE' then
    if old.status <> 'unlinking' then perform public.atlas_alert_stop(old.user_id,null,'kakao_required'); end if;
  elsif old.status <> 'unlinking' and (new.status in ('reconnect','unlinking')
    or old.kakao_id is distinct from new.kakao_id
    or ('talk_message'=any(old.scopes) and not 'talk_message'=any(new.scopes))) then
    perform public.atlas_alert_stop(old.user_id,null,'kakao_required');
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists atlas_alert_watchlist_removed on public.watchlist_items;
create trigger atlas_alert_watchlist_removed before delete on public.watchlist_items
  for each row execute function public.atlas_alert_dependency();
drop trigger if exists atlas_alert_kakao_changed on public.atlas_kakao_links;
create trigger atlas_alert_kakao_changed before update or delete on public.atlas_kakao_links
  for each row execute function public.atlas_alert_dependency();

create or replace function public.atlas_alert_rpc(action text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  u uuid := (p->>'user_id')::uuid;
  c text := p->>'code';
  op uuid := (p->>'operation')::uuid;
  eid uuid := (p->>'event_id')::uuid;
  t timestamptz := clock_timestamp();
  day date := (t at time zone 'Asia/Seoul')::date;
  r public.atlas_alert_rules%rowtype;
  e public.atlas_alert_events%rowtype;
  k public.atlas_kakao_links%rowtype;
  q jsonb;
  item jsonb;
  outcome text;
  name_value text;
  until_day date;
  observed timestamptz;
  rate numeric;
  px bigint;
begin
  if action = 'read' then
    return jsonb_build_object(
      'watchlist',(select coalesce(jsonb_agg(jsonb_build_object('code',w.code,'name',w.name) order by w.slot),'[]')
        from public.watchlist_items w where w.user_id=u),
      'rules',(select coalesce(jsonb_agg(to_jsonb(a)-'user_id'-'kakao_id'-'next_check'-'scope_check'),'[]')
        from public.atlas_alert_rules a join public.watchlist_items w using(user_id,code) where a.user_id=u),
      'kakao',coalesce((select case when a.status='connected' and 'talk_message'=any(a.scopes) then 'ready'
        when a.status='connected' then 'consent_required' when a.status='unavailable' then 'unavailable' else 'reconnect' end
        from public.atlas_kakao_links a where a.user_id=u and a.status<>'unlinking'),'disconnected'),
      'history',(select coalesce(jsonb_agg(to_jsonb(h)-'user_id'-'operation'-'lease_until'-'next_try' order by h.created_at desc,h.id desc),'[]')
        from (select * from public.atlas_alert_events where user_id=u order by created_at desc,id desc limit 50) h));
  elsif action = 'consent_start' then
    perform 1 from public.atlas_kakao_users where user_id=u for update;
    select * into k from public.atlas_kakao_links where user_id=u and status='connected';
    if not found then return '"connection_required"'; end if;
    q := public.atlas_kakao_connection('start',p||'{"replace":true}');
    if q = '"started"' then
      update public.atlas_kakao_oauth set alert_kakao_id=k.kakao_id where request_id=(p->>'request_id')::uuid;
    end if;
    return q;
  elsif action = 'consent_account' then
    return (select to_jsonb(alert_kakao_id) from public.atlas_kakao_oauth
      where request_id=(p->>'request_id')::uuid and user_id=u and phase='exchanging');
  elsif action in ('save','stop','resume','kakao_block') then
    perform public.atlas_alert_lock(u);
    if action = 'stop' or action = 'kakao_block' then
      perform public.atlas_alert_stop(u,c,case when action='stop' then 'manual' else 'kakao_required' end);
      return 'true';
    end if;
    select * into k from public.atlas_kakao_links where user_id=u and status='connected'
      and 'talk_message'=any(scopes) and access_until > t;
    if not found then raise exception 'alert_kakao_required'; end if;
    if action = 'resume' then
      select * into r from public.atlas_alert_rules where user_id=u and code=c and status='stopped';
      if not found or r.expires_on < day then raise exception 'alert_expired'; end if;
      q := jsonb_build_array(jsonb_build_object('code',c,'kind',r.kind,'threshold',r.threshold,'expires_on',r.expires_on));
    else
      q := p->'rules';
    end if;
    if jsonb_typeof(q) is distinct from 'array' or jsonb_array_length(q) not between 1 and 20
      then raise exception 'alert_invalid'; end if;
    for item in select value from jsonb_array_elements(q) loop
      c := item->>'code';
      until_day := (item->>'expires_on')::date;
      if until_day is null or until_day not between day and day+30 then raise exception 'alert_expired'; end if;
      if not exists (select 1 from public.watchlist_items where user_id=u and code=c)
        then raise exception 'alert_watchlist_required'; end if;
      perform public.atlas_alert_stop(u,c,'rule_replaced');
      insert into public.atlas_alert_rules(user_id,code,kakao_id,kind,threshold,expires_on,status)
        values(u,c,k.kakao_id,item->>'kind',(item->>'threshold')::numeric,until_day,'active')
      on conflict(user_id,code) do update set version=gen_random_uuid(),kakao_id=excluded.kakao_id,
        kind=excluded.kind,threshold=excluded.threshold,expires_on=excluded.expires_on,status='active',
        reason=null,next_check=t,scope_check=t,updated_at=t;
    end loop;
    return 'true';
  elsif action = 'begin_tick' then
    update public.atlas_alert_worker set operation=op,lease_until=t+interval '180 seconds',next_tick=t+interval '60 seconds'
      where singleton and next_tick<=t and (lease_until is null or lease_until<=t);
    if not found then return 'false'; end if;
    with lost as (
      update public.atlas_alert_events set status='unknown', reason='response_unknown', finished_at=t, lease_until=null
        where status='sending' and lease_until<=t returning id,user_id,code,version,attempts
    ), attempts as (
      update public.atlas_alert_attempts a set result='unknown', reason='response_unknown', finished_at=t
        from lost where a.event_id=lost.id and a.attempt=lost.attempts
    )
    update public.atlas_alert_rules a set status='unknown',reason='response_unknown',updated_at=t
      from lost where a.user_id=lost.user_id and a.code=lost.code and a.version=lost.version and a.status='queued';
    update public.atlas_alert_rules set status='expired',reason='expired',updated_at=t
      where status in ('active','stopped','queued') and expires_on < day
        and not exists (select 1 from public.atlas_alert_events x where x.user_id=atlas_alert_rules.user_id
          and x.code=atlas_alert_rules.code and x.version=atlas_alert_rules.version and x.status='sending');
    update public.atlas_alert_events x set status='canceled', reason='expired', finished_at=t
      from public.atlas_alert_rules a where x.user_id=a.user_id and x.code=a.code and x.version=a.version
        and x.status='queued' and a.status='expired';
    with stale as (
      update public.atlas_alert_events set status='failed',reason='event_stale',finished_at=t
        where status='queued' and observed_at<t-interval '5 minutes' returning user_id,code,version
    )
    update public.atlas_alert_rules a set status='failed',reason='event_stale',updated_at=t
      from stale where a.user_id=stale.user_id and a.code=stale.code and a.version=stale.version and a.status='queued';
    delete from public.atlas_alert_events where finished_at < t - interval '90 days';
    delete from public.atlas_alert_rules a where a.updated_at < t - interval '90 days' and a.status not in ('active','queued');
    return 'true';
  elsif action = 'end_tick' then
    update public.atlas_alert_worker set operation=null,lease_until=null where singleton and operation=op;
    return 'true';
  end if;

  if action in ('symbols','observe','queue','dispatch','scope_due','scope_checked') and not exists (
    select 1 from public.atlas_alert_worker where singleton and operation=op and lease_until>t for share
  ) then raise exception 'alert_worker_lease'; end if;
  if action = 'scope_due' then
    return (select coalesce(jsonb_agg(a.user_id),'[]') from (
      select user_id from public.atlas_alert_rules where status in ('active','queued') and scope_check<=t
        group by user_id order by min(scope_check),user_id limit 5) a);
  elsif action = 'scope_checked' then
    update public.atlas_alert_rules set scope_check=t+interval '5 minutes'
      where user_id=u and status in ('active','queued');
    return 'true';
  elsif action = 'symbols' then
    return (select coalesce(jsonb_agg(a.code),'[]') from (
      select code from public.atlas_alert_rules where status='active' and next_check<=t
        group by code order by min(next_check),code limit 10) a);
  elsif action = 'observe' then
    q := p->'quote';
    observed := (q->>'observed_at')::timestamptz;
    rate := (q->>'change_rate')::numeric;
    px := (q->>'price')::bigint;
    if q is not null and q <> 'null' and (
      (q->>'market') is distinct from 'KRX' or (q->>'trade_day')::date is distinct from day
      or (observed at time zone 'Asia/Seoul')::date is distinct from day
      or (q->>'base_day')::date >= day or q->>'base_day' is null or px is null or px<=0 or rate is null
      or observed>t or observed<t-interval '90 seconds' or rate not between -100 and 1000
    ) then raise exception 'alert_invalid_quote'; end if;
    for r in select * from public.atlas_alert_rules where code=c and status='active' and next_check<=t
      order by next_check,user_id limit 100 loop
      perform public.atlas_alert_lock(r.user_id);
      if observed < clock_timestamp()-interval '90 seconds' then observed := null; end if;
      update public.atlas_alert_rules set next_check=t+interval '60 seconds',
        reason=case when observed is null then 'quote_unavailable' else null end
        where user_id=r.user_id and code=c and version=r.version and status='active' and expires_on>=day;
      if found and observed is not null and exists (
        select 1 from public.watchlist_items where user_id=r.user_id and code=c
      ) and (case r.kind when 'price_gte' then px>=r.threshold when 'price_lte' then px<=r.threshold
        when 'rise_gte' then rate>=r.threshold when 'fall_lte' then rate<=-r.threshold end) then
        select name into name_value from public.watchlist_items where user_id=r.user_id and code=c;
        insert into public.atlas_alert_events(user_id,code,name,version,kind,threshold,observed_at,trade_day,base_day,market,price,change_rate)
          values(r.user_id,c,name_value,r.version,r.kind,r.threshold,observed,day,(q->>'base_day')::date,'KRX',px,rate)
          on conflict(user_id,code,version) do nothing;
        update public.atlas_alert_rules set status='queued',updated_at=t
          where user_id=r.user_id and code=c and version=r.version;
      end if;
    end loop;
    return 'true';
  elsif action = 'queue' then
    return (select coalesce(jsonb_agg(a),'[]') from (
      select id,user_id from public.atlas_alert_events where status='queued' and next_try<=t
        order by next_try,created_at limit 10) a);
  elsif action = 'dispatch' then
    select * into e from public.atlas_alert_events where id=eid and status='queued' and next_try<=t;
    if not found then return null; end if;
    perform public.atlas_alert_lock(e.user_id);
    t := clock_timestamp();
    day := (t at time zone 'Asia/Seoul')::date;
    select * into e from public.atlas_alert_events where id=eid and status='queued' and next_try<=t for update;
    if not found then return null; end if;
    select * into r from public.atlas_alert_rules where user_id=e.user_id and code=e.code and version=e.version
      and status='queued' and expires_on>=day;
    if not found or not exists (select 1 from public.watchlist_items where user_id=e.user_id and code=e.code)
      then return null; end if;
    select * into k from public.atlas_kakao_links where user_id=e.user_id and kakao_id=r.kakao_id and status='connected'
      and access_until>t+interval '10 seconds' and 'talk_message'=any(scopes) and verified_at>t-interval '60 seconds'
      and (operation is null or lease_until<=t);
    if not found or k.kakao_id is distinct from p->>'kakao_id' or k.tokens is distinct from p->'tokens'
      then return null; end if;
    if e.trade_day <> day or e.observed_at < t-interval '5 minutes' then
      update public.atlas_alert_events set status='failed',reason='event_stale',finished_at=t where id=e.id;
      update public.atlas_alert_rules set status='failed',reason='event_stale',updated_at=t where user_id=e.user_id and code=e.code;
      return null;
    end if;
    if (select count(*) from public.atlas_alert_attempts where requested_at >= day::timestamp at time zone 'Asia/Seoul')
      >= (p->>'day_limit')::int then return null; end if;
    update public.atlas_alert_events set status='sending',attempts=attempts+1,operation=op,lease_until=t+interval '45 seconds'
      where id=e.id returning * into e;
    insert into public.atlas_alert_attempts(event_id,attempt,result) values(e.id,e.attempts,'sending');
    return to_jsonb(e);
  elsif action = 'finish' then
    select * into e from public.atlas_alert_events where id=eid and status='sending' and operation=op;
    if not found then return 'false'; end if;
    perform public.atlas_alert_lock(e.user_id);
    select * into e from public.atlas_alert_events where id=eid and status='sending' and operation=op for update;
    if not found then return 'false'; end if;
    outcome := p->>'result';
    if outcome not in ('sent','failed','retry','unknown') or outcome is null then raise exception 'alert_invalid'; end if;
    if outcome='retry' and e.attempts>=2 then outcome:='failed'; end if;
    update public.atlas_alert_attempts set result=outcome,reason=p->>'reason',finished_at=t where event_id=e.id and attempt=e.attempts;
    update public.atlas_alert_events set status=case when outcome='retry' then 'queued' else outcome end,
      reason=p->>'reason',next_try=t+interval '60 seconds',finished_at=case when outcome<>'retry' then t end,
      lease_until=null,operation=null where id=e.id;
    if outcome<>'retry' then
      update public.atlas_alert_rules set status=outcome,reason=p->>'reason',updated_at=t
        where user_id=e.user_id and code=e.code and version=e.version and status='queued';
    end if;
    return 'true';
  end if;
  raise exception 'alert_invalid';
end;
$$;
revoke all on function public.atlas_alert_lock(uuid), public.atlas_alert_stop(uuid,text,text),
  public.atlas_alert_dependency(), public.atlas_alert_rpc(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.atlas_alert_rpc(text,jsonb) to service_role;
commit;

-- Expected for all four tables: RLS true, browser write/read false, service-role direct read/write false.
select c.relname, c.relrowsecurity,
  has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') or
    has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') as browser_access,
  has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE') as service_direct
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('atlas_alert_rules','atlas_alert_events','atlas_alert_attempts','atlas_alert_worker');
-- Expected: false, false, true.
select has_function_privilege('anon','public.atlas_alert_rpc(text,jsonb)','EXECUTE') as anon_rpc,
  has_function_privilege('authenticated','public.atlas_alert_rpc(text,jsonb)','EXECUTE') as member_rpc,
  has_function_privilege('service_role','public.atlas_alert_rpc(text,jsonb)','EXECUTE') as server_rpc;
