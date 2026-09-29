-- Run once in the Supabase SQL Editor for the same project used by ATLAS Auth.
-- Safe to run again: existing strategies and other tables are preserved.
begin;

create table if not exists public.strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 100),
  indicators jsonb not null check (
    jsonb_typeof(indicators) = 'array'
    and jsonb_array_length(indicators) between 1 and 5
    and octet_length(indicators::text) <= 32768
  ),
  backtest_settings jsonb not null check (
    jsonb_typeof(backtest_settings) = 'object'
    and octet_length(backtest_settings::text) <= 16384
  ),
  schema_version integer not null default 1 check (schema_version = 1),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists strategies_owner_name_idx
  on public.strategies (user_id, lower(name));
create index if not exists strategies_owner_updated_idx
  on public.strategies (user_id, updated_at desc, id);

create or replace function public.set_strategy_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  new.revision := old.revision + 1;
  return new;
end;
$$;
drop trigger if exists strategies_updated_at on public.strategies;
create trigger strategies_updated_at before update on public.strategies
  for each row execute function public.set_strategy_updated_at();

alter table public.strategies enable row level security;
revoke all on table public.strategies from public, anon, authenticated;
grant select, delete on table public.strategies to authenticated;
grant insert (user_id, name, indicators, backtest_settings, schema_version)
  on public.strategies to authenticated;
grant update (name, indicators, backtest_settings, schema_version)
  on public.strategies to authenticated;
grant all on table public.strategies to service_role;

drop policy if exists strategies_select_own on public.strategies;
create policy strategies_select_own on public.strategies for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists strategies_insert_own on public.strategies;
create policy strategies_insert_own on public.strategies for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists strategies_update_own on public.strategies;
create policy strategies_update_own on public.strategies for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists strategies_delete_own on public.strategies;
create policy strategies_delete_own on public.strategies for delete to authenticated
  using ((select auth.uid()) = user_id);

commit;
notify pgrst, 'reload schema';
