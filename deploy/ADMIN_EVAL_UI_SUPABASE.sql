-- AI_AGENT_SUPABASE.sql + AI_EVAL_SUPABASE.sql must already exist.
-- Run this whole transaction before the new Node API. No existing records are deleted.
begin;
do $$ begin
  if to_regclass('atlas_ai.requests') is null or to_regprocedure('public.atlas_eval_rpc(text,uuid,jsonb)') is null then raise exception 'Existing AI/evaluation schema required'; end if;
end $$;
alter table public.ai_eval_cases add column if not exists display_number integer;
with firsts as (select owner_id,id,min(created_at) first_at from public.ai_eval_cases group by owner_id,id),
numbers as (select owner_id,id,row_number() over(partition by owner_id order by first_at,id)::integer n from firsts)
update public.ai_eval_cases c set display_number=n.n from numbers n where c.owner_id=n.owner_id and c.id=n.id and c.display_number is null;
alter table public.ai_eval_cases alter column display_number set not null;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.ai_eval_cases'::regclass and conname='ai_eval_display_positive') then
    alter table public.ai_eval_cases add constraint ai_eval_display_positive check(display_number>0);
  end if;
end $$;
create index if not exists ai_eval_display on public.ai_eval_cases(owner_id,display_number);
create index if not exists ai_eval_case_history on public.ai_eval_items((specimen->>'id'),run_id);
create or replace function public.atlas_eval_number() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('eval-number:'||new.owner_id::text,0));
  select display_number into new.display_number from public.ai_eval_cases where id=new.id and owner_id=new.owner_id limit 1;
  if new.display_number is null then select coalesce(max(display_number),0)+1 into new.display_number from public.ai_eval_cases where owner_id=new.owner_id; end if;
  return new;
end $$;
drop trigger if exists atlas_eval_number on public.ai_eval_cases;
create trigger atlas_eval_number before insert on public.ai_eval_cases for each row execute function public.atlas_eval_number();
alter table public.ai_eval_runs drop constraint if exists ai_eval_runs_mode_check;
alter table public.ai_eval_runs add constraint ai_eval_runs_mode_check check(mode in ('code','live','production'));
-- Share the member's existing owner lock, concurrency and 10/min limit with normal analysis.
create or replace function public.atlas_eval_analysis_guard() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.owner_key,0));
  perform pg_advisory_xact_lock(hashtextextended('ai-request-id:'||new.id::text,0));
  if exists(select 1 from public.ai_eval_runs where id=new.id and mode='production') then raise exception 'idempotency_conflict'; end if;
  if new.owner_key not like 'u:%' then return new; end if;
  uid=substring(new.owner_key from 3)::uuid;
  if exists(select 1 from public.ai_eval_items i join public.ai_eval_runs r on r.id=i.run_id where r.owner_id=uid and r.mode='production' and i.state='running') then raise exception 'concurrency_limit'; end if;
  if (select count(*) from atlas_ai.requests where owner_key=new.owner_key and created_at>now()-interval '1 minute')+
     (select count(*) from public.ai_eval_runs where owner_id=uid and mode='production' and created_at>now()-interval '1 minute')>=10 then raise exception 'minute_limit'; end if;
  return new;
end $$;
drop trigger if exists atlas_eval_analysis_guard on atlas_ai.requests;
create trigger atlas_eval_analysis_guard before insert on atlas_ai.requests for each row execute function public.atlas_eval_analysis_guard();
do $$ begin
  if to_regprocedure('public.atlas_eval_rpc_v1(text,uuid,jsonb)') is null then alter function public.atlas_eval_rpc(text,uuid,jsonb) rename to atlas_eval_rpc_v1; end if;
end $$;
create or replace function public.atlas_eval_rpc(action text,actor uuid,payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.ai_eval_cases; i public.ai_eval_items; r public.ai_eval_runs; v integer; old_note jsonb; request_data jsonb; value jsonb;
begin
  if action in ('ui_status','workspace','save_question','production_lookup','start_production','production_active','production_step','finish_production','question_history','save_note','review') then
    if actor is null or not exists(select 1 from public.admin_users where user_id=actor) then raise exception 'admin_forbidden'; end if;
  end if;
  if action='ui_status' then return '{"version":2}';
  elsif action='workspace' then
    -- Expired paid runs are interrupted, never replayed or reported as zero-cost.
    update public.ai_eval_items x set state='interrupted',ended_at=now(),result=coalesce(x.result,'{}')||'{"error_code":"execution_interrupted","usage":{"status":"unknown"}}'
      from public.ai_eval_runs rr where x.run_id=rr.id and rr.owner_id=actor and rr.mode='production' and x.state='running' and x.started_at<now()-interval '3 minutes';
    value=coalesce((select jsonb_agg(to_jsonb(q) order by q.display_number) from(
      select t.id,t.revision,t.display_number,jsonb_build_object('question',t.spec->>'question','title',t.spec->>'title','status',t.spec->>'status') spec,
       (select jsonb_build_object('id',x.id,'run_id',x.run_id,'revision',x.specimen->>'revision','question',x.specimen->'spec'->>'question',
        'created_at',rr.created_at,'preview',left(coalesce(x.result->'presentation'->>'content',x.result->'answer'->>'content',''),1200),
        'state',case when x.state='completed' and x.result->>'status'='partial' then 'partial' else x.state end,
        'kind',x.result->'answer'->>'kind','error_code',coalesce(x.result->>'error_code',x.result->>'error'),'metadata',x.metadata,'review',x.review)
        from public.ai_eval_items x join public.ai_eval_runs rr on rr.id=x.run_id where rr.owner_id=actor and rr.mode='production' and x.specimen->>'id'=t.id::text order by rr.created_at desc,x.id desc limit 1) latest
      from(select distinct on(id) * from public.ai_eval_cases where owner_id=actor order by id,revision desc)t
      where coalesce(payload->>'view','all')='all' or exists(select 1 from public.ai_eval_items x join public.ai_eval_runs rr on rr.id=x.run_id where rr.owner_id=actor and rr.mode='production' and x.specimen->>'id'=t.id::text)
      order by t.display_number limit 10 offset (greatest(1,coalesce((payload->>'page')::integer,1))-1)*10
    )q),'[]');
    return jsonb_build_object('questions',value,'running',exists(select 1 from public.ai_eval_items x join public.ai_eval_runs rr on rr.id=x.run_id where rr.owner_id=actor and rr.mode='production' and x.state='running'),'total',(select count(distinct t.id) from public.ai_eval_cases t where t.owner_id=actor and
      (coalesce(payload->>'view','all')='all' or exists(select 1 from public.ai_eval_items x join public.ai_eval_runs rr on rr.id=x.run_id where rr.owner_id=actor and rr.mode='production' and x.specimen->>'id'=t.id::text))));
  elsif action='save_question' then
    perform pg_advisory_xact_lock(hashtextextended('eval-number:'||actor::text,0));
    select * into c from public.ai_eval_cases where id=(payload->>'id')::uuid order by revision desc limit 1;
    if found and c.owner_id<>actor then raise exception 'eval_not_found'; end if;
    if jsonb_typeof(payload->'question')<>'string' or char_length(payload->>'question')>6000 then raise exception 'eval_invalid'; end if;
    if c.id is null and (select count(distinct id) from public.ai_eval_cases where owner_id=actor)>=300 then raise exception 'eval_limit'; end if;
    if c.id is not null and c.spec->>'question'=payload->>'question' then return to_jsonb(c); end if;
    if coalesce(c.revision,0)<>(payload->>'revision')::integer then raise exception 'eval_conflict'; end if;
    insert into public.ai_eval_cases(id,revision,owner_id,spec) values((payload->>'id')::uuid,coalesce(c.revision,0)+1,actor,
      coalesce(c.spec,'{"title":"새 질문","category":"운영 질문","context":[],"dataset":"production","scenario":"base","success":"질문에 근거로 답변","failure":"근거 없는 답변","rubric":"직접 검토","checks":[],"split":"dev","status":"active"}')||jsonb_build_object('question',payload->>'question','title',coalesce(nullif(left(payload->>'question',80),''),'새 질문'))) returning * into c;
    return to_jsonb(c);
  elsif action='production_lookup' then
    select * into r from public.ai_eval_runs where id=(payload->>'id')::uuid;
    if not found then return 'null'; end if;
    if r.owner_id<>actor or r.mode<>'production' then raise exception 'eval_not_found'; end if;
    if r.request<>payload-'runtime' then raise exception 'eval_conflict'; end if;
    return jsonb_build_object('id',r.id,'created',false);
  elsif action='start_production' then
    value=public.atlas_eval_rpc('production_lookup',actor,payload);
    if value<>'null'::jsonb then return value; end if;
    perform pg_advisory_xact_lock(hashtext('atlas-eval-start'));
    perform pg_advisory_xact_lock(hashtextextended('u:'||actor::text,0));
    perform pg_advisory_xact_lock(hashtextextended('ai-request-id:'||(payload->>'id'),0));
    if exists(select 1 from atlas_ai.requests where id=(payload->>'id')::uuid) then raise exception 'eval_conflict'; end if;
    value=public.atlas_eval_rpc('production_lookup',actor,payload);
    if value<>'null'::jsonb then return value; end if;
    if exists(select 1 from public.ai_eval_items where state in ('queued','running')) then raise exception 'eval_busy'; end if;
    if exists(select 1 from atlas_ai.requests where owner_key='u:'||actor::text and status='running') then raise exception 'concurrency_limit'; end if;
    if (select count(*) from atlas_ai.requests where owner_key='u:'||actor::text and created_at>now()-interval '1 minute')+
       (select count(*) from public.ai_eval_runs where owner_id=actor and mode='production' and created_at>now()-interval '1 minute')>=10 then raise exception 'minute_limit'; end if;
    select * into c from public.ai_eval_cases where id=(payload->>'case_id')::uuid and owner_id=actor order by revision desc limit 1;
    if not found then raise exception 'eval_not_found'; end if;
    if c.revision<>(payload->>'revision')::integer or c.spec->>'question'<>payload->>'question' then raise exception 'eval_conflict'; end if;
    if nullif(btrim(payload->>'question'),'') is null or char_length(payload->>'question')>6000 or (payload->>'paidConfirmed')::boolean is distinct from true then raise exception 'eval_invalid'; end if;
    insert into public.ai_eval_runs(id,owner_id,request,mode,budget,reserved) values((payload->>'id')::uuid,actor,payload-'runtime','production',(payload->'runtime'->'limits'->>'max_usd')::numeric,(payload->'runtime'->'limits'->>'max_usd')::numeric);
    insert into public.ai_eval_items(id,run_id,ordinal,specimen,repetition,state,lease,allowance,metadata,started_at,heartbeat_at)
      values((payload->>'id')::uuid,(payload->>'id')::uuid,1,to_jsonb(c),1,'running',gen_random_uuid(),(payload->'runtime'->'limits'->>'max_usd')::numeric,coalesce(payload->'runtime','{}'),now(),now()) returning * into i;
    return jsonb_build_object('id',i.id,'created',true,'lease',i.lease);
  elsif action in ('production_active','production_step','finish_production') then
    select x.* into i from public.ai_eval_items x join public.ai_eval_runs rr on rr.id=x.run_id where x.id=(payload->>'id')::uuid and rr.owner_id=actor and rr.mode='production' and x.lease=(payload->>'lease')::uuid for update of x;
    if not found then raise exception 'eval_not_found'; end if;
    if action='production_active' then return to_jsonb(i.state='running'); end if;
    if i.state<>'running' then return '{"accepted":false}'; end if;
    if action='production_step' then
      value=payload->'event'; v=(value->>'seq')::integer;
      if v not between 1 and 100 or value->>'kind' not in ('model','tool','validation') or octet_length(value::text)>12000 then raise exception 'eval_invalid'; end if;
      if exists(select 1 from jsonb_array_elements(coalesce(i.result->'steps','[]')) e where (e->>'seq')::integer=v) then return '{"accepted":true}'; end if;
      value=coalesce(i.result->'steps','[]')||jsonb_build_array(value);
      if octet_length(value::text)>150000 then
        select jsonb_agg(jsonb_build_object('seq',e->'seq','kind',e->'kind','agent',e->'agent','name',e->'name','status',e->'status','elapsed_ms',e->'elapsed_ms',
          'arguments',case when octet_length(coalesce(e->'arguments','{}')::text)<1000 then e->'arguments' else '{"truncated":true}'::jsonb end,
          'result',jsonb_build_object('code',e->'result'->'code','status',e->'result'->'status')) order by (e->>'seq')::integer) into value from jsonb_array_elements(value)e;
        update public.ai_eval_items set result=coalesce(result,'{}')||'{"trace_truncated":true}' where id=i.id;
      end if;
      update public.ai_eval_items set heartbeat_at=now(),result=coalesce(result,'{}')||jsonb_build_object('steps',value) where id=i.id;
    else
      if payload->>'state' not in ('completed','failed') then raise exception 'eval_invalid'; end if;
      value=coalesce(i.result,'{}')||payload->'result';
      update public.ai_eval_items set state=payload->>'state',result=value,metadata=coalesce(value->'runtime',metadata),ended_at=now() where id=i.id;
      if value->'usage'->>'status'='known' then update public.ai_eval_runs set reserved=least(budget,greatest(0,coalesce((value->'usage'->>'budget_usd')::numeric,budget))) where id=i.run_id; end if;
    end if;
    return '{"accepted":true}';
  elsif action='question_history' then
    if not exists(select 1 from public.ai_eval_cases where id=(payload->>'id')::uuid and owner_id=actor) then raise exception 'eval_not_found'; end if;
    value=coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at desc,t.id desc) from(select x.id,x.state,x.specimen->>'revision' revision,x.specimen->'spec'->>'question' question,rr.created_at,rr.mode
      from public.ai_eval_items x join public.ai_eval_runs rr on rr.id=x.run_id where rr.owner_id=actor and x.specimen->>'id'=payload->>'id' and
      (payload->'before' is null or (rr.created_at,x.id)<((payload->'before'->>'at')::timestamptz,(payload->'before'->>'id')::uuid))
      order by rr.created_at desc,x.id desc limit 10)t),'[]');
    return jsonb_build_object('items',value,'next',case when jsonb_array_length(value)=10 then jsonb_build_object('at',value->9->>'created_at','id',value->9->>'id') else null end);
  elsif action='save_note' then
    select x.* into i from public.ai_eval_items x join public.ai_eval_runs rr on rr.id=x.run_id where x.id=(payload->>'id')::uuid and rr.owner_id=actor for update of x;
    if not found then raise exception 'eval_not_found'; end if;
    old_note=i.review->'improvement';
    if coalesce((old_note->>'version')::integer,0)<>(payload->>'version')::integer then raise exception 'eval_note_conflict'; end if;
    if jsonb_typeof(payload->'text')<>'string' or char_length(payload->>'text')>2000 then raise exception 'eval_invalid'; end if;
    update public.ai_eval_items set review=coalesce(review,'{}')||jsonb_build_object('improvement',jsonb_build_object('text',payload->>'text','version',coalesce((old_note->>'version')::integer,0)+1,'by',actor,'at',now())) where id=i.id returning * into i;
    return to_jsonb(i)-'lease';
  elsif action='review' then
    select x.review->'improvement' into old_note from public.ai_eval_items x join public.ai_eval_runs rr on rr.id=x.run_id where x.id=(payload->>'id')::uuid and rr.owner_id=actor for update of x;
    if old_note is not null then payload=jsonb_set(payload,'{review}',payload->'review'||jsonb_build_object('improvement',old_note)); end if;
  elsif action='start' and payload->>'mode' not in ('code','live') then raise exception 'eval_invalid';
  end if;
  return public.atlas_eval_rpc_v1(action,actor,payload);
end $$;
revoke all on function public.atlas_eval_number(),public.atlas_eval_analysis_guard() from public,anon,authenticated,service_role;
revoke all on function public.atlas_eval_rpc_v1(text,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.atlas_eval_rpc(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.atlas_eval_rpc(text,uuid,jsonb) to service_role;
comment on function public.atlas_eval_rpc(text,uuid,jsonb) is 'atlas-eval-ui-v2';
notify pgrst,'reload schema';
commit;
-- Expected: false, false, true. Direct table writes remain denied.
select has_function_privilege('anon','public.atlas_eval_rpc(text,uuid,jsonb)','execute') anon_execute,
has_function_privilege('authenticated','public.atlas_eval_rpc(text,uuid,jsonb)','execute') member_execute,
has_function_privilege('service_role','public.atlas_eval_rpc(text,uuid,jsonb)','execute') server_execute;
-- Expected: 0. Each case keeps one number across all revisions, and numbers never collide per owner.
select count(*) as numbering_errors from(select owner_id,display_number from public.ai_eval_cases group by owner_id,display_number having count(distinct id)>1
union all select owner_id,min(display_number) from public.ai_eval_cases group by owner_id,id having count(distinct display_number)>1)q;
-- Rollback: restore the preceding application SHA; keep this additive schema/data.
-- Never re-run the old base SQL over this wrapper or delete records to roll back.
