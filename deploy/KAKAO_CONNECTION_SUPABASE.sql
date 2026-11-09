-- Run as the project database administrator before deploying the API.
begin;

create table if not exists public.atlas_kakao_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  generation uuid not null default gen_random_uuid()
);

create table if not exists public.atlas_kakao_links (
  kakao_id text primary key check (kakao_id ~ '^[1-9][0-9]{0,18}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('connected','reconnect','unavailable','unlinking')),
  tokens jsonb,
  access_until timestamptz,
  refresh_until timestamptz,
  scopes text[] not null default '{}',
  linked_at timestamptz default now(),
  checked_at timestamptz,
  verified_at timestamptz,
  operation uuid,
  lease_until timestamptz,
  check (status <> 'unlinking' or (tokens is null and access_until is null and refresh_until is null
    and scopes = '{}' and linked_at is null and checked_at is null and verified_at is null))
);
create unique index if not exists atlas_kakao_one_active
  on public.atlas_kakao_links(user_id) where status <> 'unlinking';
create index if not exists atlas_kakao_links_user on public.atlas_kakao_links(user_id);

create table if not exists public.atlas_kakao_oauth (
  user_id uuid primary key references auth.users(id) on delete cascade,
  request_id uuid unique not null,
  session_id uuid not null,
  generation uuid not null,
  browser_hash text,
  launch_hash text unique,
  state_hash text unique,
  proof_hash text not null,
  phase text not null check (phase in ('created','waiting','exchanging','ready','failed')),
  replace_existing boolean not null,
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  result jsonb
);
create index if not exists atlas_kakao_oauth_expiry on public.atlas_kakao_oauth(expires_at);

alter table public.atlas_kakao_users enable row level security;
alter table public.atlas_kakao_links enable row level security;
alter table public.atlas_kakao_oauth enable row level security;
revoke all on public.atlas_kakao_users, public.atlas_kakao_links, public.atlas_kakao_oauth
  from public, anon, authenticated, service_role;

create or replace function public.atlas_kakao_connection(action text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  u uuid := (p->>'user_id')::uuid;
  s uuid := (p->>'session_id')::uuid;
  q uuid := (p->>'request_id')::uuid;
  op uuid := (p->>'operation')::uuid;
  k text := p->>'kakao_id';
  g uuid;
  f public.atlas_kakao_oauth%rowtype;
  l public.atlas_kakao_links%rowtype;
  r jsonb;
begin
  if action in ('prune','start') then
    delete from public.atlas_kakao_oauth where expires_at <= now();
    if action = 'prune' then return null; end if;
  end if;

  if action in ('start','finish','cancel','detach') then
    perform 1 from auth.sessions where id = s and user_id = u for key share;
    if not found then return '"session_changed"'::jsonb; end if;
    insert into public.atlas_kakao_users(user_id) values (u) on conflict do nothing;
    select generation into g from public.atlas_kakao_users where user_id = u for update;
  end if;

  if action = 'start' then
    if exists (select 1 from public.atlas_kakao_links where user_id = u and status = 'unlinking')
      then return '"cleanup_pending"'::jsonb; end if;
    if not (p->>'replace')::boolean and exists (select 1 from public.atlas_kakao_links where user_id = u)
      then return '"replacement_required"'::jsonb; end if;
    delete from public.atlas_kakao_oauth where user_id = u;
    insert into public.atlas_kakao_oauth
      (user_id, request_id, session_id, generation, launch_hash, proof_hash, phase, replace_existing)
    values (u,q,s,g,p->>'launch_hash',p->>'proof_hash','created',(p->>'replace')::boolean);
    return '"started"'::jsonb;
  elsif action in ('launch','claim') then
    update public.atlas_kakao_oauth o set
      phase = case when action = 'launch' then 'waiting' else 'exchanging' end,
      launch_hash = null, state_hash = case when action = 'launch' then p->>'state_hash' else null end,
      browser_hash = case when action = 'launch' then p->>'browser_hash' else null end
    where o.expires_at > now() and
      ((action = 'launch' and o.phase = 'created' and o.launch_hash = p->>'launch_hash') or
       (action = 'claim' and o.phase = 'waiting' and o.state_hash = p->>'state_hash' and o.browser_hash = p->>'browser_hash'))
      and exists (select 1 from auth.sessions a where a.id = o.session_id and a.user_id = o.user_id)
    returning o.* into f;
    if not found then return null; end if;
    return jsonb_build_object('user_id',f.user_id,'request_id',f.request_id,'replace',f.replace_existing);
  elsif action = 'stage' then
    update public.atlas_kakao_oauth set phase = p->>'phase', result = p->'result'
      where request_id = q and phase = 'exchanging' and expires_at > now();
    return to_jsonb(found);
  elsif action in ('finish','cancel') then
    select * into f from public.atlas_kakao_oauth
      where user_id = u and session_id = s and request_id = q and generation = g
        and proof_hash = p->>'proof_hash' and expires_at > now() for update;
    if not found then return '"expired"'::jsonb; end if;
    if action = 'cancel' then
      delete from public.atlas_kakao_oauth where request_id = q;
      return '"canceled"'::jsonb;
    end if;
    if f.phase not in ('ready','failed') then return '"pending"'::jsonb; end if;
    delete from public.atlas_kakao_oauth where request_id = q;
    if f.phase = 'failed' then return f.result->'outcome'; end if;
    r := f.result;
    k := r->>'kakao_id';
    select * into l from public.atlas_kakao_links where user_id = u and status <> 'unlinking' for update;
    if found and not f.replace_existing then return '"replacement_required"'::jsonb; end if;
    begin
      -- This subtransaction restores the old link if another member owns the new ID.
      if l.kakao_id is distinct from k then
        update public.atlas_kakao_links set status = 'unlinking', tokens = null, access_until = null,
          refresh_until = null, scopes = '{}', linked_at = null, checked_at = null, verified_at = null,
          operation = null, lease_until = null
          where kakao_id = l.kakao_id;
        insert into public.atlas_kakao_links(kakao_id,user_id,status) values (k,u,'connected');
      end if;
      update public.atlas_kakao_links set status = 'connected', tokens = r->'tokens',
        access_until = (r->>'access_until')::timestamptz, refresh_until = (r->>'refresh_until')::timestamptz,
        scopes = array(select jsonb_array_elements_text(r->'scopes')), checked_at = now(), verified_at = now(),
        operation = null, lease_until = null where kakao_id = k and user_id = u;
    exception when unique_violation then
      return '"conflict"'::jsonb;
    end;
    return '"connected"'::jsonb;
  elsif action = 'detach' then
    update public.atlas_kakao_users set generation = gen_random_uuid() where user_id = u;
    delete from public.atlas_kakao_oauth where user_id = u;
    update public.atlas_kakao_links set status = 'unlinking', tokens = null, access_until = null,
      refresh_until = null, scopes = '{}', linked_at = null, checked_at = null, verified_at = null,
      operation = null, lease_until = null
      where user_id = u and status <> 'unlinking';
    return '"detached"'::jsonb;
  elsif action = 'read' then
    return (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) from public.atlas_kakao_links a where a.user_id = u);
  elsif action in ('check_claim','unlink_claim') then
    update public.atlas_kakao_links set operation = op, lease_until = now() + interval '45 seconds'
      where user_id = u and kakao_id = k and (lease_until is null or lease_until <= now())
        and ((action = 'check_claim' and status in ('connected','unavailable')
          and (checked_at is null or checked_at <= now() - interval '5 seconds'))
          or (action = 'unlink_claim' and status = 'unlinking'))
      returning * into l;
    if not found then return null; end if;
    return to_jsonb(l);
  elsif action = 'check_finish' then
    r := p->'result';
    update public.atlas_kakao_links set status = r->>'status', tokens = nullif(r->'tokens','null'::jsonb),
      access_until = (r->>'access_until')::timestamptz, refresh_until = (r->>'refresh_until')::timestamptz,
      scopes = array(select jsonb_array_elements_text(r->'scopes')), checked_at = now(),
      verified_at = case when r->>'status' = 'connected' then now() else verified_at end,
      operation = null, lease_until = null
      where user_id = u and kakao_id = k and operation = op and status <> 'unlinking';
    return to_jsonb(found);
  elsif action = 'unlink_finish' then
    if (p->>'ok')::boolean then
      delete from public.atlas_kakao_links where user_id = u and kakao_id = k and operation = op and status = 'unlinking';
    else
      update public.atlas_kakao_links set operation = null, lease_until = now() + interval '10 seconds'
        where user_id = u and kakao_id = k and operation = op and status = 'unlinking';
    end if;
    return to_jsonb(found);
  end if;
  raise exception 'Unsupported Kakao action';
end;
$$;
revoke all on function public.atlas_kakao_connection(text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.atlas_kakao_connection(text,jsonb) to service_role;
commit;

-- Optional maintenance as database administrator. Expired requests are also deleted on start.
-- select public.atlas_kakao_connection('prune', '{}'::jsonb);

-- Verify: all rows should show rls=true, browser_access=false, service_role_direct=false.
select c.relname, c.relrowsecurity as rls,
  (has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) as browser_access,
  has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as service_role_direct
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('atlas_kakao_users','atlas_kakao_links','atlas_kakao_oauth');
-- Expected: false, false, true.
select has_function_privilege('anon','public.atlas_kakao_connection(text,jsonb)','EXECUTE') as anon_rpc,
  has_function_privilege('authenticated','public.atlas_kakao_connection(text,jsonb)','EXECUTE') as authenticated_rpc,
  has_function_privilege('service_role','public.atlas_kakao_connection(text,jsonb)','EXECUTE') as service_role_rpc;
