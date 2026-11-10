-- Apply after WATCHLIST_SUPABASE.sql and AI_AGENT_SUPABASE.sql.
-- Confirmation state is stored in the existing server-owned request and assistant message.
begin;

create or replace function public.atlas_ai_confirm_watchlist(
  p_room_id uuid, p_request_id uuid, p_decision text, p_revision uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  owner text := 'u:' || uid::text;
  request atlas_ai.requests%rowtype;
  card jsonb;
  next_answer jsonb;
  draft jsonb;
  state text;
  stock_code text;
  already_saved boolean;
  latest uuid;
begin
  if uid is null then raise exception using errcode='42501', message='confirmation_auth_required'; end if;
  if p_decision is null or p_decision not in ('yes','no','draft') then
    raise exception using errcode='22023', message='invalid_arguments';
  end if;
  -- Same owner lock as atlas_ai_rpc so new questions and room deletion cannot race approval.
  perform pg_advisory_xact_lock(hashtextextended(owner,0));
  select r.* into request from atlas_ai.requests r join atlas_ai.rooms room
    on room.id=r.room_id and room.owner_key=r.owner_key
    where r.id=p_request_id and r.room_id=p_room_id and r.owner_key=owner
      and r.status='completed' and r.purged_at is null and room.deleted_at is null;
  card := request.answer->'watchlistConfirmation';
  if card is null then return '{"error":"confirmation_not_found"}'; end if;
  state := card->>'status';
  stock_code := card#>>'{condition,code}';

  if state='pending' then
    if (card->>'expiresAt')::timestamptz <= clock_timestamp() then
      card := card || '{"status":"expired"}';
    elsif p_decision='no' then
      card := card || '{"status":"declined"}';
    elsif p_decision='yes' then
      select m.request_id into latest from atlas_ai.messages m
        where m.room_id=p_room_id and m.owner_key=owner and m.role='user' order by m.id desc limit 1;
      if latest is distinct from p_request_id then
        card := card || '{"status":"superseded"}';
      elsif p_revision is distinct from (card->>'baseRevision')::uuid then
        return '{"error":"confirmation_outdated"}';
      else
        -- Share the exact watchlist lock and authenticated RPC with both star buttons.
        perform pg_advisory_xact_lock(hashtextextended(uid::text,60261107));
        select exists(select 1 from public.watchlist_items w where w.user_id=uid and w.code=stock_code) into already_saved;
        begin
          perform public.set_watchlist_item(uid,stock_code,true,card->>'name');
          card := card || jsonb_build_object('status','added','addition',case when already_saved then 'already_saved' else 'added' end);
        exception when raise_exception then
          if sqlerrm <> 'watchlist_limit' then raise; end if;
          card := card || '{"status":"limit"}';
        end;
      end if;
    else
      return '{"error":"confirmation_not_approved"}';
    end if;
  elsif p_decision='draft' and state in ('added','ready') then
    draft := request.answer->'alertDraft';
    select m.request_id into latest from atlas_ai.messages m
      where m.room_id=p_room_id and m.owner_key=owner and m.role='user' order by m.id desc limit 1;
    if latest is distinct from p_request_id or (p_revision is distinct from (card->>'baseRevision')::uuid
      and (draft is null or p_revision is distinct from (draft->>'revision')::uuid)) then
      return '{"error":"confirmation_outdated"}';
    end if;
    if (card#>>'{condition,expires_on}')::date < (clock_timestamp() at time zone 'Asia/Seoul')::date then
      return '{"error":"alert_expired"}';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(uid::text,60261107));
    if not exists(select 1 from public.watchlist_items w where w.user_id=uid and w.code=stock_code) then
      return '{"error":"alert_watchlist_required"}';
    end if;
    if draft is null then
      draft := (card->'condition') || jsonb_build_object('id',gen_random_uuid(),'revision',gen_random_uuid(),
        'baseRevision',card->'baseRevision','roomId',p_room_id,'requestId',p_request_id);
      card := card || '{"status":"ready"}';
    end if;
  end if;

  if card is distinct from request.answer->'watchlistConfirmation' then
    next_answer := jsonb_set(request.answer,'{watchlistConfirmation}',card);
    if draft is not null then next_answer := next_answer || jsonb_build_object('alertDraft',draft); end if;
    update atlas_ai.requests set answer=next_answer where id=p_request_id and owner_key=owner;
    update atlas_ai.messages set answer=next_answer
      where request_id=p_request_id and room_id=p_room_id and owner_key=owner and role='assistant';
  end if;
  return jsonb_build_object('confirmation',card,'draft',draft);
end $$;

revoke all on function public.atlas_ai_confirm_watchlist(uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.atlas_ai_confirm_watchlist(uuid,uuid,text,uuid) to authenticated;
notify pgrst, 'reload schema';
commit;

-- Expected: false, true, false. Private request/message tables keep their existing RLS and grants.
select has_function_privilege('anon','public.atlas_ai_confirm_watchlist(uuid,uuid,text,uuid)','EXECUTE') as anon_rpc,
       has_function_privilege('authenticated','public.atlas_ai_confirm_watchlist(uuid,uuid,text,uuid)','EXECUTE') as member_rpc,
       has_function_privilege('service_role','public.atlas_ai_confirm_watchlist(uuid,uuid,text,uuid)','EXECUTE') as service_rpc;
