-- Fresh install: WATCHLIST, KAKAO_CONNECTION, ALERT_AGENT, then this file.
-- Existing install: stop alert workers and API writers, then run this file only.
begin;

do $$
begin
  if to_regprocedure('public.atlas_alert_rpc_v3(text,jsonb)') is not null then
    raise exception 'Alert v3 is already installed; do not reapply the v2 baseline';
  end if;
  if exists (select 1 from public.atlas_alert_events where status='sending' and lease_until>clock_timestamp())
    or exists (select 1 from public.atlas_alert_worker where operation is not null and lease_until>clock_timestamp()) then
    raise exception 'alert_dispatch_in_progress';
  end if;
  if to_regprocedure('public.atlas_alert_rpc_v1(text,jsonb)') is null then
    alter function public.atlas_alert_rpc(text,jsonb) rename to atlas_alert_rpc_v1;
  end if;
end;
$$;
revoke all on function public.atlas_alert_rpc_v1(text,jsonb) from public,anon,authenticated,service_role;

alter table public.atlas_alert_rules add column if not exists rule_id uuid not null default gen_random_uuid();
alter table public.atlas_alert_events add column if not exists rule_id uuid;
update public.atlas_alert_events e set rule_id=r.rule_id from public.atlas_alert_rules r
  where e.rule_id is null and e.user_id=r.user_id and e.code=r.code;
-- History can outlive its rule. Keep those legacy snapshots together without a foreign key.
with orphans as materialized (
  select a.user_id,a.code,gen_random_uuid() as rule_id from (
    select distinct user_id,code from public.atlas_alert_events where rule_id is null
  ) a
)
update public.atlas_alert_events e set rule_id=o.rule_id from orphans o
  where e.rule_id is null and e.user_id=o.user_id and e.code=o.code;
alter table public.atlas_alert_events alter column rule_id set not null;
alter table public.atlas_alert_rules drop constraint if exists atlas_alert_rules_pkey,
  drop constraint if exists atlas_alert_rules_status_check;
alter table public.atlas_alert_rules add primary key(rule_id),
  add constraint atlas_alert_rules_status_check check (status in ('active','stopped','expired','queued','sent','failed','unknown','canceled'));
-- v1 maintenance and finalization still match the owner, code and globally unique version.
create unique index if not exists atlas_alert_rule_version on public.atlas_alert_rules(version);
create index if not exists atlas_alert_rule_owner on public.atlas_alert_rules(user_id,code);
create unique index if not exists atlas_alert_active_condition on public.atlas_alert_rules(user_id,code,kind,threshold)
  where status in ('active','queued');
create unique index if not exists atlas_alert_event_version on public.atlas_alert_events(rule_id,version);

create table if not exists public.atlas_alert_mutations (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation uuid not null,
  request jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,operation)
);
create index if not exists atlas_alert_mutations_created on public.atlas_alert_mutations(created_at);
alter table public.atlas_alert_mutations enable row level security;
revoke all on public.atlas_alert_mutations from public,anon,authenticated,service_role;

-- Dependency triggers use this lock too. Maintenance takes the exclusive side to
-- avoid deadlocks and status changes in the middle of an owner transaction.
create or replace function public.atlas_alert_lock(owner_id uuid)
returns void language sql set search_path = '' as $$
  select pg_advisory_xact_lock_shared(481922,2);
  select pg_advisory_xact_lock(hashtextextended(owner_id::text,481922));
$$;

create or replace function public.atlas_alert_rpc_v2(action text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  u uuid := (p->>'user_id')::uuid;
  op uuid := (p->>'operation')::uuid;
  c text := p->>'code';
  t timestamptz := clock_timestamp();
  day date := (t at time zone 'Asia/Seoul')::date;
  r public.atlas_alert_rules%rowtype;
  e public.atlas_alert_events%rowtype;
  k public.atlas_kakao_links%rowtype;
  q jsonb;
  item jsonb;
  payload jsonb;
  previous jsonb;
  mutation text;
  due date;
  px bigint;
  rate numeric;
  amount numeric;
  observed timestamptz;
  valid_tick boolean;
  stock_name text;
begin
  if action='read' then
    q := public.atlas_alert_rpc_v1(action,p);
    return q || jsonb_build_object('ruleManagement',true,'rules',(
      select coalesce(jsonb_agg(a.value || jsonb_build_object('status',case when exists (
        select 1 from public.atlas_alert_events x where x.rule_id=(a.value->>'rule_id')::uuid
          and x.version=(a.value->>'version')::uuid and x.status='sending'
      ) then 'sending' else a.value->>'status' end) order by a.value->>'updated_at' desc,a.value->>'rule_id'),'[]')
      from jsonb_array_elements(q->'rules') a));
  elsif action='begin_tick' then
    perform pg_advisory_xact_lock(481922,2);
    q := public.atlas_alert_rpc_v1(action,p);
    if q='true' then delete from public.atlas_alert_mutations where created_at<clock_timestamp()-interval '90 days'; end if;
    return q;
  end if;

  perform pg_advisory_xact_lock_shared(481922,2);
  if action in ('consent_start','consent_account','end_tick','scope_due','scope_checked','symbols','queue','finish','kakao_block') then
    return public.atlas_alert_rpc_v1(action,p);
  elsif action in ('mutation_replay','mutate') then
    if u is null or op is null then raise exception 'alert_invalid'; end if;
    perform public.atlas_alert_lock(u);
    payload := p - 'user_id' - 'operation';
    select request into previous from public.atlas_alert_mutations where user_id=u and operation=op;
    if found then
      if previous<>payload then raise exception 'alert_request_conflict'; end if;
      return 'true';
    end if;
    if action='mutation_replay' then return 'false'; end if;
    t := clock_timestamp();
    day := (t at time zone 'Asia/Seoul')::date;
    mutation := p->>'mutation';
    if mutation is null or mutation not in ('create','update','cancel','restart') then raise exception 'alert_invalid'; end if;
    if mutation<>'create' then
      select * into r from public.atlas_alert_rules where rule_id=(p->>'rule_id')::uuid and user_id=u for update;
      if not found or r.version is distinct from (p->>'version')::uuid then raise exception 'alert_version_conflict'; end if;
      if exists (select 1 from public.atlas_alert_events where rule_id=r.rule_id and version=r.version and status='sending') then
        raise exception 'alert_dispatch_in_progress';
      end if;
      if (mutation in ('update','cancel') and r.status not in ('active','queued')) or
        (mutation='restart' and r.status in ('active','queued') and r.expires_on>=day) then
        raise exception 'alert_invalid_state';
      end if;
    end if;
    if mutation='update' and r.expires_on<day then raise exception 'alert_expired'; end if;
    if mutation='cancel' then
      update public.atlas_alert_rules set status='canceled',reason='manual',version=gen_random_uuid(),updated_at=t
        where rule_id=r.rule_id;
    else
      select * into k from public.atlas_kakao_links where user_id=u and status='connected'
        and 'talk_message'=any(scopes) and access_until>t;
      if not found then raise exception 'alert_kakao_required'; end if;
      q := case when mutation='create' then p->'rules' else jsonb_build_array(p->'rule') end;
      if jsonb_typeof(q) is distinct from 'array' or jsonb_array_length(q) not between 1 and 20 then raise exception 'alert_invalid'; end if;
      for item in select value from jsonb_array_elements(q) loop
        c := item->>'code';
        due := (item->>'expires_on')::date;
        amount := (item->>'threshold')::numeric;
        if due is null or due not between day and day+30 then raise exception 'alert_expired'; end if;
        if mutation<>'create' and c is distinct from r.code then raise exception 'alert_invalid'; end if;
        if not exists (select 1 from public.watchlist_items where user_id=u and code=c) then
          raise exception 'alert_watchlist_required';
        end if;
        if mutation='update' and r.kind=item->>'kind' and r.threshold=amount and r.expires_on=due then
          -- A save without changes must leave the version and any queue untouched.
          r.rule_id := null;
          continue;
        end if;
        if exists (select 1 from public.atlas_alert_rules where user_id=u and code=c and status in ('active','queued')
          and kind=item->>'kind' and threshold=amount and rule_id is distinct from r.rule_id) then
          raise exception 'alert_duplicate_condition';
        end if;
        if mutation='create' then
          if (select count(*) from public.atlas_alert_rules where user_id=u and code=c)>=10 then raise exception 'alert_rule_limit'; end if;
          insert into public.atlas_alert_rules(user_id,code,kakao_id,kind,threshold,expires_on,status)
            values(u,c,k.kakao_id,item->>'kind',amount,due,'active');
        else
          update public.atlas_alert_rules set version=gen_random_uuid(),kakao_id=k.kakao_id,kind=item->>'kind',threshold=amount,
            expires_on=due,status='active',reason=null,next_check=t,scope_check=t,updated_at=t where rule_id=r.rule_id;
        end if;
      end loop;
    end if;
    if r.rule_id is not null then
      update public.atlas_alert_events set status='canceled',reason=case when mutation='cancel' then 'manual' else 'rule_replaced' end,finished_at=t
        where rule_id=r.rule_id and version=r.version and status='queued';
    end if;
    insert into public.atlas_alert_mutations(user_id,operation,request) values(u,op,payload);
    return 'true';
  end if;

  if action not in ('observe','dispatch') or action is null then raise exception 'alert_invalid'; end if;
  if not exists (select 1 from public.atlas_alert_worker where singleton and operation=op and lease_until>t for share) then
    raise exception 'alert_worker_lease';
  end if;
  if action='observe' then
    q := p->'quote';
    observed := (q->>'observed_at')::timestamptz;
    rate := (q->>'change_rate')::numeric;
    px := (q->>'price')::bigint;
    if q is not null and q<>'null' and (
      (q->>'market') is distinct from 'KRX' or (q->>'trade_day')::date is distinct from day
      or (observed at time zone 'Asia/Seoul')::date is distinct from day or (q->>'base_day')::date>=day
      or q->>'base_day' is null or px is null or px<=0 or rate is null
      or observed>t or observed<t-interval '90 seconds' or rate not between -100 and 1000
    ) then raise exception 'alert_invalid_quote'; end if;
    for r in select a.* from public.atlas_alert_rules a join (
      select rule_id from public.atlas_alert_rules where code=c and status='active' and next_check<=t
        order by next_check,rule_id limit 100
    ) pending using(rule_id) order by a.user_id,a.rule_id loop
      perform public.atlas_alert_lock(r.user_id);
      valid_tick := observed is not null and observed>=clock_timestamp()-interval '90 seconds';
      update public.atlas_alert_rules set next_check=t+interval '60 seconds',
        reason=case when valid_tick then null else 'quote_unavailable' end
        where rule_id=r.rule_id and version=r.version and status='active' and next_check<=t and expires_on>=day;
      if found and valid_tick and (case r.kind when 'price_gte' then px>=r.threshold when 'price_lte' then px<=r.threshold
        when 'rise_gte' then rate>=r.threshold when 'fall_lte' then rate<=-r.threshold end) then
        select name into stock_name from public.watchlist_items where user_id=r.user_id and code=c;
        if found then
          insert into public.atlas_alert_events(rule_id,user_id,code,name,version,kind,threshold,observed_at,trade_day,base_day,market,price,change_rate)
            values(r.rule_id,r.user_id,c,stock_name,r.version,r.kind,r.threshold,observed,day,(q->>'base_day')::date,'KRX',px,rate)
            on conflict(rule_id,version) do nothing;
          update public.atlas_alert_rules set status='queued',updated_at=t where rule_id=r.rule_id and version=r.version;
        end if;
      end if;
    end loop;
    return 'true';
  end if;

  select * into e from public.atlas_alert_events where id=(p->>'event_id')::uuid and status='queued' and next_try<=t;
  if not found then return null; end if;
  perform public.atlas_alert_lock(e.user_id);
  t := clock_timestamp();
  day := (t at time zone 'Asia/Seoul')::date;
  select * into e from public.atlas_alert_events where id=e.id and status='queued' and next_try<=t for update;
  if not found then return null; end if;
  select * into r from public.atlas_alert_rules where rule_id=e.rule_id and user_id=e.user_id and code=e.code
    and version=e.version and status='queued' and expires_on>=day;
  if not found or not exists (select 1 from public.watchlist_items where user_id=e.user_id and code=e.code) then return null; end if;
  select * into k from public.atlas_kakao_links where user_id=e.user_id and kakao_id=r.kakao_id and status='connected'
    and access_until>t+interval '10 seconds' and 'talk_message'=any(scopes) and verified_at>t-interval '60 seconds'
    and (operation is null or lease_until<=t);
  if not found or k.kakao_id is distinct from p->>'kakao_id' or k.tokens is distinct from p->'tokens' then return null; end if;
  if e.trade_day<>day or e.observed_at<t-interval '5 minutes' then
    update public.atlas_alert_events set status='failed',reason='event_stale',finished_at=t where id=e.id;
    update public.atlas_alert_rules set status='failed',reason='event_stale',updated_at=t where rule_id=r.rule_id and version=r.version;
    return null;
  end if;
  if (select count(*) from public.atlas_alert_attempts where requested_at>=day::timestamp at time zone 'Asia/Seoul')
    >= (p->>'day_limit')::int then return null; end if;
  update public.atlas_alert_events set status='sending',attempts=attempts+1,operation=op,lease_until=t+interval '45 seconds'
    where id=e.id returning * into e;
  insert into public.atlas_alert_attempts(event_id,attempt,result) values(e.id,e.attempts,'sending');
  return to_jsonb(e);
end;
$$;

revoke all on function public.atlas_alert_rpc_v2(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.atlas_alert_rpc_v2(text,jsonb) to service_role;
-- Release the pre-deploy drain gate while the old worker remains stopped.
update public.atlas_alert_worker set next_tick=now() where singleton and next_tick='infinity'::timestamptz;
commit;

-- Expected: false, false, true, false, false, true.
select has_function_privilege('anon','public.atlas_alert_rpc_v2(text,jsonb)','EXECUTE') as anon_rpc,
  has_function_privilege('authenticated','public.atlas_alert_rpc_v2(text,jsonb)','EXECUTE') as member_rpc,
  has_function_privilege('service_role','public.atlas_alert_rpc_v2(text,jsonb)','EXECUTE') as server_rpc,
  has_function_privilege('service_role','public.atlas_alert_rpc_v1(text,jsonb)','EXECUTE') as legacy_server_rpc,
  has_table_privilege('service_role','public.atlas_alert_mutations','SELECT,INSERT,UPDATE,DELETE') as direct_receipts,
  (select relrowsecurity from pg_class where oid='public.atlas_alert_mutations'::regclass) as receipts_rls;
-- Expected: 0, 0. Output counts only.
select (select count(*) from public.atlas_alert_rules where rule_id is null) as rules_without_id,
  (select count(*) from public.atlas_alert_events where rule_id is null) as events_without_id;
