-- Prerequisite: AI_EVAL_SUPABASE.sql and ADMIN_EVAL_UI_SUPABASE.sql already applied.
-- Run the entire file as the database owner BEFORE deploying the deletion API.
-- Questions are removed from active lists; immutable revisions, executions, costs and notes remain.
-- No existing question is deleted merely by applying/reapplying this migration.
begin;
do $$ begin
  if to_regprocedure('public.atlas_eval_rpc_v1(text,uuid,jsonb)') is null
     or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='ai_eval_cases' and column_name='display_number')
     or coalesce(obj_description(to_regprocedure('public.atlas_eval_rpc(text,uuid,jsonb)'),'pg_proc'),'') not in ('atlas-eval-ui-v2','atlas-eval-delete-v1') then
    raise exception 'ADMIN_EVAL_UI_SUPABASE.sql must already be applied';
  end if;
end $$;
alter table public.ai_eval_cases add column if not exists deleted_at timestamptz;
create index if not exists ai_eval_active_questions on public.ai_eval_cases(owner_id,display_number,id,revision desc) where deleted_at is null;

-- Numbers are a current-list presentation only. Historical ordinals and UUIDs never change.
create or replace function public.atlas_eval_active_questions(actor uuid)
returns table(id uuid,revision integer,display_number integer,spec jsonb,created_at timestamptz)
language sql stable security definer set search_path=pg_catalog,public as $$
  select t.id,t.revision,row_number() over(order by t.display_number,t.id)::integer,t.spec,t.created_at
  from (select distinct on(c.id) c.* from public.ai_eval_cases c where c.owner_id=actor
    and not exists(select 1 from public.ai_eval_cases d where d.id=c.id and d.deleted_at is not null)
    order by c.id,c.revision desc)t
$$;
do $$ begin
  if to_regprocedure('public.atlas_eval_rpc_ui_v2(text,uuid,jsonb)') is null then
    alter function public.atlas_eval_rpc(text,uuid,jsonb) rename to atlas_eval_rpc_ui_v2;
  end if;
end $$;
create or replace function public.atlas_eval_rpc(action text,actor uuid,payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.ai_eval_cases; ref jsonb; value jsonb; removed jsonb:='[]'; previous jsonb:='[]'; n integer;
begin
  if action in ('ui_status','workspace','cases','question_selection','delete_questions','save_question','save_case','start','start_production','production_lookup','question_history') then
    if actor is null or not exists(select 1 from public.admin_users where user_id=actor) then raise exception 'admin_forbidden'; end if;
  end if;
  -- Same lock order as production start, then the existing numbering lock. Reentrant in the v2 wrapper.
  -- This serializes cross-tab saves/deletes/starts, including old API entry points.
  if action in ('delete_questions','save_question','save_case','start','start_production','production_lookup') then
    perform pg_advisory_xact_lock(hashtext('atlas-eval-start'));
    perform pg_advisory_xact_lock(hashtextextended('u:'||actor::text,0));
    perform pg_advisory_xact_lock(hashtextextended('eval-number:'||actor::text,0));
  end if;
  if action='ui_status' then return '{"version":2,"questionDeletionVersion":1}';
  elsif action='question_selection' then
    select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'revision',q.revision,'display_number',q.display_number) order by q.display_number),'[]'),count(*)
      into value,n from public.atlas_eval_active_questions(actor)q;
    return jsonb_build_object('questions',value,'total',n);
  elsif action='delete_questions' then
    if jsonb_typeof(payload) is distinct from 'object' then raise exception 'eval_invalid'; end if;
    if (select count(*) from jsonb_object_keys(payload))<>1 or jsonb_typeof(payload->'questions') is distinct from 'array' then raise exception 'eval_invalid'; end if;
    if jsonb_array_length(payload->'questions') not between 1 and 300 then raise exception 'eval_invalid'; end if;
    for ref in select x from jsonb_array_elements(payload->'questions')x loop
      if jsonb_typeof(ref) is distinct from 'object' then raise exception 'eval_invalid'; end if;
      if (select count(*) from jsonb_object_keys(ref))<>2 or jsonb_typeof(ref->'id') is distinct from 'string'
         or coalesce(ref->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or jsonb_typeof(ref->'revision') is distinct from 'number' or coalesce(ref->>'revision','') !~ '^[1-9][0-9]{0,9}$' then raise exception 'eval_invalid'; end if;
      if (ref->>'revision')::numeric>2147483647 then raise exception 'eval_invalid'; end if;
    end loop;
    if (select count(distinct (x->>'id')::uuid) from jsonb_array_elements(payload->'questions')x)<>jsonb_array_length(payload->'questions') then raise exception 'eval_invalid'; end if;
    -- Validate every snapshot before any change: a stale selection never partially deletes a batch.
    for ref in select x from jsonb_array_elements(payload->'questions')x loop
      select * into c from public.ai_eval_cases where id=(ref->>'id')::uuid order by revision desc limit 1;
      if not found or c.owner_id<>actor then raise exception 'eval_not_found'; end if;
      if c.revision<>(ref->>'revision')::integer then raise exception 'eval_delete_conflict'; end if;
      if exists(select 1 from public.ai_eval_items i join public.ai_eval_runs r on r.id=i.run_id
        where r.owner_id=actor and i.specimen->>'id'=c.id::text and i.state in ('queued','running')) then raise exception 'eval_delete_busy'; end if;
    end loop;
    for ref in select x from jsonb_array_elements(payload->'questions')x loop
      if exists(select 1 from public.ai_eval_cases where id=(ref->>'id')::uuid and deleted_at is not null) then
        previous=previous||jsonb_build_array((ref->>'id')::uuid);
      else
        update public.ai_eval_cases set deleted_at=now() where id=(ref->>'id')::uuid and owner_id=actor;
        removed=removed||jsonb_build_array((ref->>'id')::uuid);
      end if;
    end loop;
    return jsonb_build_object('deleted',removed,'alreadyDeleted',previous,'remaining',(select count(*) from public.atlas_eval_active_questions(actor)));
  elsif action='workspace' then
    -- Preserve the existing stale paid-call handling; never cancel/replay work as part of deletion.
    update public.ai_eval_items x set state='interrupted',ended_at=now(),result=coalesce(x.result,'{}')||'{"error_code":"execution_interrupted","usage":{"status":"unknown"}}'
      from public.ai_eval_runs rr where x.run_id=rr.id and rr.owner_id=actor and rr.mode='production' and x.state='running' and x.started_at<now()-interval '3 minutes';
    with questions as (select q.*,
      (select jsonb_build_object('id',x.id,'run_id',x.run_id,'revision',x.specimen->>'revision','question',x.specimen->'spec'->>'question',
        'created_at',rr.created_at,'preview',left(coalesce(x.result->'presentation'->>'content',x.result->'answer'->>'content',''),1200),
        'state',case when x.state='completed' and x.result->>'status'='partial' then 'partial' else x.state end,
        'kind',x.result->'answer'->>'kind','error_code',coalesce(x.result->>'error_code',x.result->>'error'),'metadata',x.metadata,'review',x.review)
      from public.ai_eval_items x join public.ai_eval_runs rr on rr.id=x.run_id where rr.owner_id=actor and rr.mode='production' and x.specimen->>'id'=q.id::text order by rr.created_at desc,x.id desc limit 1) latest
      from public.atlas_eval_active_questions(actor)q),
    filtered as (select * from questions where coalesce(payload->>'view','all')='all' or latest is not null),
    page as (select id,revision,display_number,jsonb_build_object('question',spec->>'question','title',spec->>'title','status',spec->>'status') spec,latest
      from filtered order by display_number limit 10 offset (greatest(1,coalesce((payload->>'page')::integer,1))-1)*10)
    select jsonb_build_object('questions',coalesce((select jsonb_agg(to_jsonb(p) order by p.display_number) from page p),'[]'),
      'total',(select count(*) from filtered),'running',exists(select 1 from public.ai_eval_items x join public.ai_eval_runs r on r.id=x.run_id where r.owner_id=actor and r.mode='production' and x.state='running')) into value;
    return value;
  elsif action='cases' then
    return coalesce((select jsonb_agg(to_jsonb(case_row)||jsonb_build_object('display_number',q.display_number) order by case_row.created_at desc)
      from public.atlas_eval_active_questions(actor)q join public.ai_eval_cases case_row on case_row.id=q.id and case_row.revision=q.revision),'[]');
  elsif action in ('save_question','save_case') then
    if jsonb_typeof(payload->'id') is distinct from 'string' or coalesce(payload->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(payload->'revision') is distinct from 'number' or coalesce(payload->>'revision','') !~ '^(0|[1-9][0-9]{0,9})$' then raise exception 'eval_invalid'; end if;
    if (payload->>'revision')::numeric>2147483647 then raise exception 'eval_invalid'; end if;
    select * into c from public.ai_eval_cases where id=(payload->>'id')::uuid order by revision desc limit 1;
    if found and (c.owner_id<>actor or exists(select 1 from public.ai_eval_cases where id=c.id and deleted_at is not null)) then raise exception 'eval_not_found'; end if;
    if c.id is null and (select count(*) from public.atlas_eval_active_questions(actor))>=300 then raise exception 'eval_limit'; end if;
    if action='save_question' then
      if jsonb_typeof(payload->'question') is distinct from 'string' or char_length(payload->>'question')>6000 then raise exception 'eval_invalid'; end if;
      if c.id is null or c.spec->>'question' is distinct from payload->>'question' then
        if coalesce(c.revision,0)<>(payload->>'revision')::integer then raise exception 'eval_conflict'; end if;
        insert into public.ai_eval_cases(id,revision,owner_id,spec) values((payload->>'id')::uuid,coalesce(c.revision,0)+1,actor,
          coalesce(c.spec,'{"title":"새 질문","category":"운영 질문","context":[],"dataset":"production","scenario":"base","success":"질문에 근거로 답변","failure":"근거 없는 답변","rubric":"직접 검토","checks":[],"split":"dev","status":"active"}')
          ||jsonb_build_object('question',payload->>'question','title',coalesce(nullif(left(payload->>'question',80),''),'새 질문'))) returning * into c;
      end if;
    else
      if coalesce(c.revision,0)<>(payload->>'revision')::integer then raise exception 'eval_conflict'; end if;
      insert into public.ai_eval_cases(id,revision,owner_id,spec) values((payload->>'id')::uuid,coalesce(c.revision,0)+1,actor,payload->'spec') returning * into c;
    end if;
    select display_number into n from public.atlas_eval_active_questions(actor) where id=c.id;
    return to_jsonb(c)||jsonb_build_object('display_number',n);
  elsif action in ('start_production','production_lookup','question_history') then
    if not exists(select 1 from public.ai_eval_cases where id=(case when action='question_history' then payload->>'id' else payload->>'case_id' end)::uuid and owner_id=actor)
       or exists(select 1 from public.ai_eval_cases where id=(case when action='question_history' then payload->>'id' else payload->>'case_id' end)::uuid and deleted_at is not null) then raise exception 'eval_not_found'; end if;
  elsif action='start' then
    if jsonb_typeof(payload->'cases') is distinct from 'array' then raise exception 'eval_invalid'; end if;
    for ref in select x from jsonb_array_elements(payload->'cases')x loop
      if exists(select 1 from public.ai_eval_cases where id=(ref->>'id')::uuid and deleted_at is not null) then raise exception 'eval_not_found'; end if;
    end loop;
  end if;
  -- Worker claim/heartbeat/finish and immutable execution/audit reads retain their existing contracts.
  return public.atlas_eval_rpc_ui_v2(action,actor,payload);
end $$;
revoke all on function public.atlas_eval_active_questions(uuid),public.atlas_eval_rpc_ui_v2(text,uuid,jsonb),public.atlas_eval_rpc_v1(text,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.atlas_eval_rpc(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.atlas_eval_rpc(text,uuid,jsonb) to service_role;
comment on function public.atlas_eval_rpc(text,uuid,jsonb) is 'atlas-eval-delete-v1';
notify pgrst,'reload schema';
commit;

-- Postcheck 1: expected atlas-eval-delete-v1, then false,false,true.
select obj_description('public.atlas_eval_rpc(text,uuid,jsonb)'::regprocedure,'pg_proc') rpc_marker;
select has_function_privilege('anon','public.atlas_eval_rpc(text,uuid,jsonb)','execute') anon_execute,
  has_function_privilege('authenticated','public.atlas_eval_rpc(text,uuid,jsonb)','execute') member_execute,
  has_function_privilege('service_role','public.atlas_eval_rpc(text,uuid,jsonb)','execute') server_execute;
-- Postcheck 2: expected false,false,false for each role. Nested entry points must not bypass the wrapper.
select role_name,
  has_function_privilege(role_name,'public.atlas_eval_rpc_ui_v2(text,uuid,jsonb)','execute') old_ui_execute,
  has_function_privilege(role_name,'public.atlas_eval_rpc_v1(text,uuid,jsonb)','execute') legacy_execute,
  has_function_privilege(role_name,'public.atlas_eval_active_questions(uuid)','execute') helper_execute
from unnest(array['anon','authenticated','service_role']) role_name;
-- Postcheck 3: expected false for every direct read/write privilege (RLS remains enabled).
select role_name,table_name,
  has_table_privilege(role_name,'public.'||table_name,'SELECT') direct_read,
  has_table_privilege(role_name,'public.'||table_name,'INSERT') direct_insert,
  has_table_privilege(role_name,'public.'||table_name,'UPDATE') direct_update,
  has_table_privilege(role_name,'public.'||table_name,'DELETE') direct_delete
from unnest(array['anon','authenticated','service_role']) role_name
cross join unnest(array['ai_eval_cases','ai_eval_runs','ai_eval_items']) table_name;
select relname,relrowsecurity from pg_class where oid in ('public.ai_eval_cases'::regclass,'public.ai_eval_runs'::regclass,'public.ai_eval_items'::regclass);
-- Postcheck 4: expected 0; historical display_number values intentionally keep their immutable gaps.
select count(*) mixed_deletion_errors from(select id from public.ai_eval_cases group by id having bool_or(deleted_at is null) and bool_or(deleted_at is not null))q;
-- Roll back application code only if necessary; retain this additive schema and all audit data.
-- Do not reapply AI_EVAL_SUPABASE.sql / ADMIN_EVAL_UI_SUPABASE.sql over the new wrapper.
-- Do not clear deleted_at or delete executions/costs as a rollback mechanism.
