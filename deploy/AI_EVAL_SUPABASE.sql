-- ATLAS AI evaluation v1. Run as database owner, before deploying the API.
begin;
-- Do not adopt unrelated existing tables silently.
do $$ declare n text; begin
  foreach n in array array['admin_users','ai_eval_cases','ai_eval_runs','ai_eval_items'] loop
    if to_regclass('public.'||n) is not null and
       obj_description(to_regclass('public.'||n),'pg_class') is distinct from 'atlas-eval-v1' then
      raise exception 'Conflicting table: %', n;
    end if;
  end loop;
end $$;
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.ai_eval_cases (
  id uuid not null, revision integer not null check(revision>0),
  owner_id uuid not null references auth.users(id),
  spec jsonb not null check(jsonb_typeof(spec)='object' and octet_length(spec::text)<24000),
  created_at timestamptz not null default now(), primary key(id,revision)
);
create table if not exists public.ai_eval_runs (
  id uuid primary key, owner_id uuid not null references auth.users(id),
  request jsonb not null, mode text not null check(mode in ('code','live')),
  budget numeric not null check(budget between 0 and 25),
  reserved numeric not null default 0, cancel_requested boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.ai_eval_items (
  id uuid primary key default gen_random_uuid(), run_id uuid not null references public.ai_eval_runs(id) on delete cascade,
  ordinal integer not null, specimen jsonb not null, repetition integer not null,
  state text not null default 'queued' check(state in ('queued','running','completed','failed','interrupted','canceled')),
  lease uuid, allowance numeric, metadata jsonb, result jsonb,
  review jsonb, started_at timestamptz, heartbeat_at timestamptz, ended_at timestamptz,
  unique(run_id,ordinal), check(result is null or octet_length(result::text)<200000)
);
comment on table public.admin_users is 'atlas-eval-v1';
comment on table public.ai_eval_cases is 'atlas-eval-v1';
comment on table public.ai_eval_runs is 'atlas-eval-v1';
comment on table public.ai_eval_items is 'atlas-eval-v1';
create index if not exists ai_eval_queue on public.ai_eval_items(state,run_id,ordinal);
create index if not exists ai_eval_owner on public.ai_eval_runs(owner_id,created_at desc);
alter table public.admin_users enable row level security;
alter table public.ai_eval_cases enable row level security;
alter table public.ai_eval_runs enable row level security;
alter table public.ai_eval_items enable row level security;
revoke all on public.admin_users,public.ai_eval_cases,public.ai_eval_runs,public.ai_eval_items from public,anon,authenticated,service_role;
-- No browser policies. Only the narrowly scoped service RPC accesses these tables.
create or replace function public.atlas_eval_rpc(action text, actor uuid, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.ai_eval_runs; i public.ai_eval_items; v integer; c jsonb; a jsonb; num integer:=0; rep integer;
begin
  if action not in ('claim','heartbeat','finish','worker_status') then
    if actor is null or not exists(select 1 from public.admin_users where user_id=actor) then raise exception 'admin_forbidden'; end if;
  end if;
  if action='access' then return '{"admin":true}';
  elsif action='cases' then
    return coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at desc) from
      (select distinct on(id) * from public.ai_eval_cases where owner_id=actor order by id,revision desc) t),'[]');
  elsif action='save_case' then
    perform pg_advisory_xact_lock(hashtext('atlas-eval-case'),hashtext(payload->>'id'));
    select max(revision) into v from public.ai_eval_cases where id=(payload->>'id')::uuid;
    if v is not null and not exists(select 1 from public.ai_eval_cases where id=(payload->>'id')::uuid and owner_id=actor) then raise exception 'eval_not_found'; end if;
    if coalesce(v,0)<>(payload->>'revision')::integer then raise exception 'eval_conflict'; end if;
    if v is null and (select count(distinct id) from public.ai_eval_cases where owner_id=actor)>=300 then raise exception 'eval_limit'; end if;
    insert into public.ai_eval_cases values((payload->>'id')::uuid,coalesce(v,0)+1,actor,payload->'spec',now());
    return jsonb_build_object('id',payload->>'id','revision',coalesce(v,0)+1);
  elsif action='start' then
    perform pg_advisory_xact_lock(hashtext('atlas-eval-start'));
    select * into r from public.ai_eval_runs where id=(payload->>'id')::uuid;
    if found then
      if r.owner_id<>actor then raise exception 'eval_not_found'; end if;
      if r.request<>payload then raise exception 'eval_conflict'; end if;
      return jsonb_build_object('id',r.id);
    end if;
    if exists(select 1 from public.ai_eval_items where state in ('queued','running')) then raise exception 'eval_busy'; end if;
    if jsonb_array_length(payload->'cases') not between 1 and 30 or (payload->>'repeats')::integer not between 1 and 3 then raise exception 'eval_invalid'; end if;
    insert into public.ai_eval_runs(id,owner_id,request,mode,budget) values((payload->>'id')::uuid,actor,payload,payload->>'mode',(payload->>'budget')::numeric) returning * into r;
    for c in select value from jsonb_array_elements(payload->'cases') loop
      select to_jsonb(t) into a from public.ai_eval_cases t where id=(c->>'id')::uuid and revision=(c->>'revision')::integer and owner_id=actor;
      if a is null or a->'spec'->>'dataset' <> 'atlas-fixed-v1' or a->'spec'->>'status'<>'active' then raise exception 'eval_case_not_ready'; end if;
      for rep in 1..(payload->>'repeats')::integer loop
        num:=num+1;
        insert into public.ai_eval_items(run_id,ordinal,specimen,repetition) values(r.id,num,a,rep);
      end loop;
    end loop;
    return jsonb_build_object('id',r.id);
  elsif action='runs' then
    return coalesce((select jsonb_agg(to_jsonb(t)) from(select rr.*, (select jsonb_agg(jsonb_build_object('state',x.state,'count',x.n)) from(select state,count(*) n from public.ai_eval_items where run_id=rr.id group by state)x) counts from public.ai_eval_runs rr where owner_id=actor order by created_at desc limit 100)t),'[]');
  elsif action in ('run','cancel') then
    select * into r from public.ai_eval_runs where id=(payload->>'id')::uuid and owner_id=actor;
    if not found then raise exception 'eval_not_found'; end if;
    if action='cancel' then
      update public.ai_eval_runs set cancel_requested=true where id=r.id;
      update public.ai_eval_items set state='canceled',ended_at=now() where run_id=r.id and state='queued';
    end if;
    return jsonb_build_object('run',to_jsonb(r),'items',coalesce((select jsonb_agg(jsonb_build_object('id',id,'ordinal',ordinal,'case_id',specimen->>'id','revision',specimen->>'revision','title',specimen->'spec'->>'title','repetition',repetition,'state',state,'grade',result->>'grade','checks',result->'checks','usage',result->'usage','elapsed_ms',result->'elapsed_ms','metadata',metadata,'fingerprint',result->>'fingerprint','review',review) order by ordinal) from public.ai_eval_items where run_id=r.id),'[]'));
  elsif action in ('item','review') then
    select t.* into i from public.ai_eval_items t join public.ai_eval_runs rr on rr.id=t.run_id where t.id=(payload->>'id')::uuid and rr.owner_id=actor;
    if not found then raise exception 'eval_not_found'; end if;
    if action='review' then
      if i.state in ('queued','running') then raise exception 'eval_conflict'; end if;
      update public.ai_eval_items set review=(payload->'review')||jsonb_build_object('by',actor,'at',now()) where id=i.id returning * into i;
    end if;
    return to_jsonb(i)-'lease';
  elsif action='claim' then
    perform pg_advisory_xact_lock(hashtext('atlas-eval-claim'));
    -- A stale paid call is never replayed. Reserved budget remains charged conservatively.
    update public.ai_eval_items set state='interrupted',ended_at=now(),result='{"grade":"fail","error":"worker_interrupted","usage":{"status":"unknown"}}'
      where state='running' and heartbeat_at<now()-interval '5 minutes';
    update public.ai_eval_items set state='canceled',ended_at=now() where state='queued' and run_id in(select id from public.ai_eval_runs rr where cancel_requested or not exists(select 1 from public.admin_users where user_id=rr.owner_id));
    if exists(select 1 from public.ai_eval_items where state='running') then return 'null'; end if;
    select t.* into i from public.ai_eval_items t join public.ai_eval_runs rr on rr.id=t.run_id where t.state='queued' order by rr.created_at,t.ordinal limit 1 for update of t;
    if not found then return 'null'; end if;
    select * into r from public.ai_eval_runs where id=i.run_id for update;
    if r.mode='live' and r.budget-r.reserved<0.25 then
      update public.ai_eval_items set state='canceled',ended_at=now(),result='{"grade":"na","error":"batch_budget_limit"}' where run_id=r.id and state='queued'; return 'null';
    end if;
    update public.ai_eval_runs set reserved=reserved+case when mode='live' then 0.25 else 0 end where id=r.id;
    update public.ai_eval_items set state='running',started_at=now(),heartbeat_at=now(),lease=gen_random_uuid(),allowance=case when r.mode='live' then 0.25 else 0 end,metadata=payload where id=i.id returning * into i;
    return to_jsonb(i)||jsonb_build_object('mode',r.mode);
  elsif action in ('heartbeat','finish') then
    select * into i from public.ai_eval_items where id=(payload->>'id')::uuid and lease=(payload->>'lease')::uuid for update;
    if not found then raise exception 'eval_not_found'; end if;
    if i.state<>'running' then return jsonb_build_object('accepted',false); end if;
    if action='heartbeat' then update public.ai_eval_items set heartbeat_at=now() where id=i.id;
    else
      if payload->>'state' not in ('completed','failed') then raise exception 'eval_invalid'; end if;
      update public.ai_eval_items set state=payload->>'state',result=payload->'result',ended_at=now() where id=i.id;
      -- Unknown usage is not refunded; known cost is capped to the reserved allowance.
      if payload->'result'->'usage'->>'status'='known' then
        update public.ai_eval_runs set reserved=greatest(0,reserved-i.allowance+least(i.allowance,greatest(0,coalesce((payload->'result'->'usage'->>'budget_usd')::numeric,i.allowance)))) where id=i.run_id;
      end if;
    end if;
    return jsonb_build_object('accepted',true);
  end if;
  raise exception 'eval_invalid';
end $$;
revoke all on function public.atlas_eval_rpc(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.atlas_eval_rpc(text,uuid,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
-- Expect false, false, true:
select has_function_privilege('anon','public.atlas_eval_rpc(text,uuid,jsonb)','execute') anon_execute,
has_function_privilege('authenticated','public.atlas_eval_rpc(text,uuid,jsonb)','execute') member_execute,
has_function_privilege('service_role','public.atlas_eval_rpc(text,uuid,jsonb)','execute') server_execute;
