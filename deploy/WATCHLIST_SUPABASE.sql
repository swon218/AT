-- Run in the SQL Editor of the Supabase project used for ATLAS Auth.
begin;

create table if not exists public.watchlist_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null check (code ~ '^[0-9][0-9A-Z]{5}$'),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 100),
  slot smallint not null check (slot between 1 and 20),
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, code),
  unique (user_id, slot)
);

create index if not exists watchlist_items_owner_recent_idx
  on public.watchlist_items (user_id, created_at desc, code);

alter table public.watchlist_items enable row level security;
revoke all on public.watchlist_items from public, anon, authenticated, service_role;
grant select on public.watchlist_items to authenticated;

drop policy if exists watchlist_items_select_own on public.watchlist_items;
create policy watchlist_items_select_own on public.watchlist_items
  for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.set_watchlist_item(
  p_expected_user uuid, p_code text, p_saved boolean, p_name text default null
)
returns table (code text, name text, created_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  stock_code text := upper(btrim(p_code));
  stock_name text := btrim(p_name);
  free_slot smallint;
begin
  -- The argument only checks for an account change. The write uses auth.uid().
  if owner_id is null or owner_id is distinct from p_expected_user then
    raise exception using errcode = '42501', message = 'watchlist_auth_required';
  end if;
  if stock_code ~ '^A[0-9]{6}$' then
    stock_code := substr(stock_code, 2);
  end if;
  if stock_code is null or stock_code !~ '^[0-9][0-9A-Z]{5}$' or p_saved is null then
    raise exception using errcode = '22023', message = 'watchlist_invalid_stock';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(owner_id::text, 60261107));
  if not p_saved then
    delete from public.watchlist_items w where w.user_id = owner_id and w.code = stock_code;
  elsif not exists (
    select 1 from public.watchlist_items w where w.user_id = owner_id and w.code = stock_code
  ) then
    if stock_name is null or char_length(stock_name) not between 1 and 100 then
      raise exception using errcode = '22023', message = 'watchlist_invalid_stock';
    end if;
    -- Each user can occupy only 20 distinct slots, even at stricter isolation levels.
    select candidate.slot into free_slot
    from generate_series(1, 20) as candidate(slot)
    where not exists (
      select 1 from public.watchlist_items w where w.user_id = owner_id and w.slot = candidate.slot
    )
    order by candidate.slot limit 1;
    if free_slot is null then
      raise exception using errcode = 'P0001', message = 'watchlist_limit';
    end if;
    insert into public.watchlist_items (user_id, code, name, slot)
      values (owner_id, stock_code, stock_name, free_slot);
  end if;

  return query
    select w.code, w.name, w.created_at from public.watchlist_items w
    where w.user_id = owner_id order by w.created_at desc, w.code;
end;
$$;

revoke all on function public.set_watchlist_item(uuid, text, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_watchlist_item(uuid, text, boolean, text) to authenticated;

notify pgrst, 'reload schema';
commit;
