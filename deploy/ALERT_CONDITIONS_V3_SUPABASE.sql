-- Apply after ALERT_RULES_V2_SUPABASE.sql. Drain and stop the worker and API first.
begin;
do $$ begin
  if exists (select 1 from public.atlas_alert_events where status='sending' and lease_until>clock_timestamp())
    or exists (select 1 from public.atlas_alert_worker where operation is not null and lease_until>clock_timestamp()) then
    raise exception 'alert_dispatch_in_progress';
  end if;
end $$;

alter table public.atlas_alert_rules
  add column if not exists frequency text not null default 'once' check (frequency in ('once','repeat')),
  add column if not exists activated_at timestamptz not null default now(),
  drop constraint if exists atlas_alert_rules_kind_check,
  drop constraint if exists atlas_alert_rules_check,
  drop constraint if exists atlas_alert_rule_condition;
alter table public.atlas_alert_rules add constraint atlas_alert_rule_condition check (
  (kind in ('price_gte','price_lte','price_touch') and threshold between 1 and 1000000000 and threshold=trunc(threshold)) or
  (kind in ('rise_gte','fall_lte') and threshold between 0 and 100 and threshold=round(threshold,2))
);
alter table public.atlas_alert_events
  add column if not exists frequency text not null default 'once' check (frequency in ('once','repeat')),
  add column if not exists phase text not null default 'regular',
  add column if not exists session_close timestamptz,
  add column if not exists base_price bigint check (base_price>0),
  add column if not exists prior_close bigint check (prior_close>0),
  drop constraint if exists atlas_alert_events_market_check,
  drop constraint if exists atlas_alert_events_user_id_code_version_key,
  drop constraint if exists atlas_alert_event_session;
alter table public.atlas_alert_events add constraint atlas_alert_event_session
  check ((market='KRX' and phase='regular') or (market='NXT' and phase='after'));
drop index if exists public.atlas_alert_event_version;
create unique index if not exists atlas_alert_event_once on public.atlas_alert_events(rule_id,version) where frequency='once';
create unique index if not exists atlas_alert_event_observation on public.atlas_alert_events(rule_id,version,market,observed_at);

create table if not exists public.atlas_alert_observations (
  rule_id uuid references public.atlas_alert_rules(rule_id) on delete cascade,
  market text check (market in ('KRX','NXT')),
  version uuid not null,
  trade_day date not null,
  session_open timestamptz not null,
  observed_at timestamptz not null,
  price bigint not null,
  base_day date not null,
  base_price bigint not null,
  matched boolean not null,
  continuous boolean not null,
  primary key(rule_id,market)
);
alter table public.atlas_alert_observations enable row level security;
revoke all on public.atlas_alert_observations from public,anon,authenticated,service_role;

create or replace function public.atlas_alert_rpc_v3(action text, p jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  u uuid := (p->>'user_id')::uuid;
  op uuid := (p->>'operation')::uuid;
  code_value text := p->>'code';
  t timestamptz := clock_timestamp();
  day date := (t at time zone 'Asia/Seoul')::date;
  m text := p->>'market';
  phase_value text := p->>'phase';
  opening timestamptz := (p->>'session_open')::timestamptz;
  closing timestamptz := (p->>'session_close')::timestamptz;
  r public.atlas_alert_rules%rowtype;
  e public.atlas_alert_events%rowtype;
  k public.atlas_kakao_links%rowtype;
  last public.atlas_alert_observations%rowtype;
  q jsonb;
  item jsonb;
  payload jsonb;
  mutation text;
  kind_value text;
  frequency_value text;
  due date;
  amount numeric;
  observed timestamptz;
  px bigint;
  bp bigint;
  bd date;
  prior bigint;
  rate numeric;
  connected boolean;
  first_today boolean;
  matched_now boolean;
  reached boolean;
  stock_name text;
begin
  if action='read' then
    return public.atlas_alert_rpc_v2(action,p) || '{"conditionVersion":3}';
  elsif action='begin_tick' then
    q := public.atlas_alert_rpc_v2(action,p);
    if q='true' then
      with closed as (
        update public.atlas_alert_events set status='failed',reason='market_closed',finished_at=clock_timestamp()
          where status='queued' and session_close<=clock_timestamp() returning rule_id,version
      )
      update public.atlas_alert_rules a set status='failed',reason='market_closed',updated_at=clock_timestamp()
        from closed where a.rule_id=closed.rule_id and a.version=closed.version and a.status='queued';
    end if;
    return q;
  elsif action in ('consent_start','consent_account','end_tick','scope_due','scope_checked','finish','kakao_block','mutation_replay')
    or (action='mutate' and p->>'mutation'='cancel') then
    return public.atlas_alert_rpc_v2(action,p);
  end if;

  if action='mutate' then
    if u is null or op is null then raise exception 'alert_invalid'; end if;
    perform public.atlas_alert_lock(u);
    payload := p - 'user_id' - 'operation';
    if public.atlas_alert_rpc_v2('mutation_replay',p)='true' then return 'true'; end if;
    t := clock_timestamp();
    day := (t at time zone 'Asia/Seoul')::date;
    mutation := p->>'mutation';
    if mutation is null or mutation not in ('create','update','restart') then raise exception 'alert_invalid'; end if;
    if mutation<>'create' then
      select * into r from public.atlas_alert_rules where rule_id=(p->>'rule_id')::uuid and user_id=u for update;
      if not found or r.version is distinct from (p->>'version')::uuid then raise exception 'alert_version_conflict'; end if;
      if exists (select 1 from public.atlas_alert_events where rule_id=r.rule_id and version=r.version and status='sending') then
        raise exception 'alert_dispatch_in_progress';
      end if;
      if (mutation='update') is distinct from (r.status in ('active','queued') and r.expires_on>=day) then
        raise exception 'alert_invalid_state';
      end if;
    end if;
    select * into k from public.atlas_kakao_links where user_id=u and status='connected'
      and 'talk_message'=any(scopes) and access_until>t;
    if not found then raise exception 'alert_kakao_required'; end if;
    q := case when mutation='create' then p->'rules' else jsonb_build_array(p->'rule') end;
    if jsonb_typeof(q) is distinct from 'array' or jsonb_array_length(q) not between 1 and 20 then raise exception 'alert_invalid'; end if;
    for item in select value from jsonb_array_elements(q) loop
      code_value := item->>'code';
      kind_value := item->>'kind';
      frequency_value := item->>'frequency';
      due := (item->>'expires_on')::date;
      amount := (item->>'threshold')::numeric;
      if kind_value is null or kind_value not in ('price_touch','rise_gte','fall_lte')
        or frequency_value is null or frequency_value not in ('once','repeat') or amount is null
        or (mutation<>'create' and code_value is distinct from r.code) then raise exception 'alert_invalid'; end if;
      if due is null or due not between day and day+30 then raise exception 'alert_expired'; end if;
      if not exists (select 1 from public.watchlist_items where user_id=u and code=code_value) then raise exception 'alert_watchlist_required'; end if;
      if mutation='update' and (r.kind,r.threshold,r.expires_on,r.frequency)=(kind_value,amount,due,frequency_value) then continue; end if;
      if exists (select 1 from public.atlas_alert_rules where user_id=u and code=code_value and status in ('active','queued')
        and kind=kind_value and threshold=amount and rule_id is distinct from r.rule_id) then raise exception 'alert_duplicate_condition'; end if;
      if mutation='create' then
        if (select count(*) from public.atlas_alert_rules where user_id=u and code=code_value)>=10 then raise exception 'alert_rule_limit'; end if;
        insert into public.atlas_alert_rules(user_id,code,kakao_id,kind,threshold,expires_on,frequency,status,activated_at)
          values(u,code_value,k.kakao_id,kind_value,amount,due,frequency_value,'active',t);
      else
        update public.atlas_alert_rules set version=gen_random_uuid(),kakao_id=k.kakao_id,kind=kind_value,threshold=amount,
          expires_on=due,frequency=frequency_value,status='active',reason=null,next_check=t,scope_check=t,updated_at=t,activated_at=t
          where rule_id=r.rule_id;
        update public.atlas_alert_events set status='canceled',reason='rule_replaced',finished_at=t
          where rule_id=r.rule_id and version=r.version and status='queued';
        delete from public.atlas_alert_observations where rule_id=r.rule_id;
      end if;
    end loop;
    insert into public.atlas_alert_mutations(user_id,operation,request) values(u,op,payload);
    return 'true';
  end if;

  if action is null or action not in ('symbols','queue','observe','dispatch') then raise exception 'alert_invalid'; end if;
  perform pg_advisory_xact_lock_shared(481922,2);
  if not exists (select 1 from public.atlas_alert_worker where singleton and operation=op and lease_until>clock_timestamp() for share) then
    raise exception 'alert_worker_lease';
  end if;
  if ((m='KRX' and phase_value='regular') or (m='NXT' and phase_value='after')) is not true
    or (p->>'trade_day')::date is distinct from day or opening is null or closing is null
    or (opening at time zone 'Asia/Seoul')::date<>day or (closing at time zone 'Asia/Seoul')::date<>day
    or not (opening<=t and t<closing) then
    if action in ('symbols','queue') then return '[]'; end if;
    return null;
  end if;
  if action='symbols' then
    return (select coalesce(jsonb_agg(a.code order by a.due,a.code),'[]') from (
      select code,min(next_check) as due from public.atlas_alert_rules where status='active' and next_check<=t and expires_on>=day
        and (m='KRX' or ((p->'symbols') ? code and kind not in ('price_gte','price_lte')))
      group by code order by due,code limit 10) a);
  elsif action='queue' then
    return (select coalesce(jsonb_agg(a),'[]') from (
      select id,user_id from public.atlas_alert_events where status='queued' and next_try<=t and trade_day=day
        and market=m and phase=phase_value and observed_at>=opening and t<coalesce(session_close,closing)
        and (m='KRX' or (p->'symbols') ? code) order by next_try,created_at limit 10) a);
  elsif action='observe' then
    if m='NXT' and ((p->'symbols') ? code_value) is not true then return null; end if;
    q := p->'quote';
    observed := (q->>'observed_at')::timestamptz;
    px := (q->>'price')::bigint;
    bp := (q->>'base_price')::bigint;
    bd := (q->>'base_day')::date;
    prior := (q->>'prior_close')::bigint;
    if observed is not null then
      if (q->>'trade_day')::date is distinct from day or not (opening<=observed and observed<=t)
        or observed<t-interval '90 seconds' or (px>0 and bp>0 and prior>0 and bd<day and bd<=(p->>'previous_day')::date) is not true then
        raise exception 'alert_invalid_quote';
      end if;
      rate := (px-bp)*100::numeric/bp;
      if rate not between -100 and 1000 then raise exception 'alert_invalid_quote'; end if;
    end if;
    for r in select a.* from public.atlas_alert_rules a join (
      select rule_id from public.atlas_alert_rules where code=code_value and status='active' and next_check<=t and expires_on>=day
        and (m='KRX' or kind not in ('price_gte','price_lte')) order by next_check,rule_id limit 100
    ) due_rules using(rule_id) order by a.user_id,a.rule_id loop
      perform public.atlas_alert_lock(r.user_id);
      update public.atlas_alert_rules set next_check=t+interval '60 seconds',reason=case
        when observed>=clock_timestamp()-interval '90 seconds' then null
        when p->>'reason'='reference_or_quote_unavailable' then 'reference_or_quote_unavailable' else 'quote_unavailable' end
        where rule_id=r.rule_id and version=r.version and status='active' and next_check<=t;
      if not found then continue; end if;
      if observed is null or observed<clock_timestamp()-interval '90 seconds' then
        update public.atlas_alert_observations set continuous=false where rule_id=r.rule_id and market=m and version=r.version;
        continue;
      end if;
      if observed<r.activated_at then continue; end if;
      select * into last from public.atlas_alert_observations where rule_id=r.rule_id and market=m and version=r.version;
      if observed<=last.observed_at then continue; end if;
      connected := coalesce(last.trade_day=day and last.session_open=opening and last.continuous
        and observed-last.observed_at<=interval '180 seconds' and last.base_price=bp and last.base_day=bd,false);
      first_today := last.trade_day is distinct from day and not exists (select 1 from public.atlas_alert_events
        where rule_id=r.rule_id and version=r.version and trade_day=day);
      matched_now := case r.kind when 'rise_gte' then (px-bp)*100::numeric>=r.threshold*bp
        when 'fall_lte' then (px-bp)*100::numeric<=-r.threshold*bp
        when 'price_touch' then px=r.threshold when 'price_gte' then px>=r.threshold when 'price_lte' then px<=r.threshold end;
      reached := case r.kind
        when 'price_touch' then (first_today and matched_now) or (connected and
          ((last.price<r.threshold and px>=r.threshold) or (last.price>r.threshold and px<=r.threshold)))
        when 'price_gte' then matched_now when 'price_lte' then matched_now
        else matched_now and (first_today or (connected and not last.matched)) end;
      insert into public.atlas_alert_observations values (r.rule_id,m,r.version,day,opening,observed,px,bd,bp,matched_now,true)
        on conflict(rule_id,market) do update set (version,trade_day,session_open,observed_at,price,base_day,base_price,matched,continuous)=
          (excluded.version,excluded.trade_day,excluded.session_open,excluded.observed_at,excluded.price,excluded.base_day,excluded.base_price,excluded.matched,true);
      if reached then
        select name into stock_name from public.watchlist_items where user_id=r.user_id and code=code_value;
        if not found then continue; end if;
        insert into public.atlas_alert_events(rule_id,user_id,code,name,version,kind,threshold,observed_at,trade_day,base_day,
          market,price,change_rate,frequency,phase,session_close,base_price,prior_close)
          values(r.rule_id,r.user_id,code_value,stock_name,r.version,r.kind,r.threshold,observed,day,bd,
            m,px,rate,r.frequency,phase_value,closing,bp,prior) on conflict do nothing;
        if found and r.frequency='once' then
          update public.atlas_alert_rules set status='queued',updated_at=t where rule_id=r.rule_id and version=r.version;
        end if;
      end if;
    end loop;
    return 'true';
  end if;

  select * into e from public.atlas_alert_events where id=(p->>'event_id')::uuid and status='queued';
  if not found then return null; end if;
  perform public.atlas_alert_lock(e.user_id);
  t := clock_timestamp();
  select * into e from public.atlas_alert_events where id=e.id and status='queued' and next_try<=t for update;
  if not found or e.market<>m or e.phase<>phase_value or e.trade_day<>day or e.observed_at<opening
    or t>=least(closing,coalesce(e.session_close,closing)) or e.observed_at<t-interval '5 minutes'
    or (m='NXT' and ((p->'symbols') ? e.code) is not true) then return null; end if;
  select * into r from public.atlas_alert_rules where rule_id=e.rule_id and user_id=e.user_id and code=e.code
    and version=e.version and expires_on>=day and status=case when e.frequency='repeat' then 'active' else 'queued' end;
  if not found or not exists (select 1 from public.watchlist_items where user_id=e.user_id and code=e.code) then return null; end if;
  select * into k from public.atlas_kakao_links where user_id=e.user_id and kakao_id=r.kakao_id and status='connected'
    and access_until>t+interval '10 seconds' and 'talk_message'=any(scopes) and verified_at>t-interval '60 seconds'
    and (operation is null or lease_until<=t);
  if not found or k.kakao_id is distinct from p->>'kakao_id' or k.tokens is distinct from p->'tokens' then return null; end if;
  if (select count(*) from public.atlas_alert_attempts where requested_at>=day::timestamp at time zone 'Asia/Seoul')
    >= (p->>'day_limit')::int then
    update public.atlas_alert_events set reason='quota' where id=e.id;
    return null;
  end if;
  update public.atlas_alert_events set status='sending',attempts=attempts+1,operation=op,lease_until=t+interval '45 seconds'
    where id=e.id returning * into e;
  insert into public.atlas_alert_attempts(event_id,attempt,result) values(e.id,e.attempts,'sending');
  return to_jsonb(e);
end $$;

revoke all on function public.atlas_alert_rpc_v2(text,jsonb),public.atlas_alert_rpc_v3(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.atlas_alert_rpc_v3(text,jsonb) to service_role;
update public.atlas_alert_worker set next_tick=now() where singleton and next_tick='infinity'::timestamptz;
commit;

-- Expected: false, false, true, false, false, true.
select has_function_privilege('anon','public.atlas_alert_rpc_v3(text,jsonb)','EXECUTE') as anon_rpc,
  has_function_privilege('authenticated','public.atlas_alert_rpc_v3(text,jsonb)','EXECUTE') as member_rpc,
  has_function_privilege('service_role','public.atlas_alert_rpc_v3(text,jsonb)','EXECUTE') as server_rpc,
  has_function_privilege('service_role','public.atlas_alert_rpc_v2(text,jsonb)','EXECUTE') as legacy_rpc,
  has_table_privilege('service_role','public.atlas_alert_observations','SELECT,INSERT,UPDATE,DELETE') as direct_observations,
  (select relrowsecurity from pg_class where oid='public.atlas_alert_observations'::regclass) as observation_rls;
-- Expected: 0, 0.
select (select count(*) from public.atlas_alert_rules where rule_id is null) as rules_without_id,
  (select count(*) from public.atlas_alert_events where rule_id is null) as events_without_id;
