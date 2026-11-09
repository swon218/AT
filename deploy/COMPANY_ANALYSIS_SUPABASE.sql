begin;

create table if not exists public.atlas_dart_symbols (
  symbol text primary key check (symbol ~ '^[0-9A-Z]{6}$'),
  corp_code text not null check (corp_code ~ '^[0-9]{8}$'),
  name text not null,
  modified_on date not null,
  active boolean not null default true
);
create index if not exists atlas_dart_symbols_corp on public.atlas_dart_symbols(corp_code) where active;

create table if not exists public.atlas_dart_jobs (
  key text primary key,
  corp_code text check (corp_code ~ '^[0-9]{8}$'),
  kind text not null check (kind in ('codes','overview','financials','report','business','shareholders','disclosures','outlook')),
  args jsonb not null,
  data jsonb,
  checked_at timestamptz,
  expires_at timestamptz,
  lease uuid,
  lease_until timestamptz,
  retry_at timestamptz,
  error_code text,
  failures integer not null default 0 check (failures >= 0)
);
create index if not exists atlas_dart_jobs_due on public.atlas_dart_jobs(expires_at, retry_at) where kind <> 'report';

create table if not exists public.atlas_dart_filings (
  receipt text primary key check (receipt ~ '^[0-9]{14}$'),
  corp_code text not null check (corp_code ~ '^[0-9]{8}$'),
  filed_on date not null,
  title text not null,
  series text,
  corrected boolean not null,
  collected_at timestamptz not null default now()
);
create index if not exists atlas_dart_filings_corp_date on public.atlas_dart_filings(corp_code, filed_on desc);
create index if not exists atlas_dart_filings_series on public.atlas_dart_filings(corp_code, series) where series is not null;

create table if not exists public.atlas_dart_accounts (
  report_key text not null references public.atlas_dart_jobs(key),
  corp_code text not null check (corp_code ~ '^[0-9]{8}$'),
  receipt text not null references public.atlas_dart_filings(receipt),
  fiscal_year smallint not null check (fiscal_year >= 2015),
  report_code text not null check (report_code in ('11011','11012','11013','11014')),
  period_end date not null,
  scope text not null check (scope in ('CFS','OFS')),
  metric text not null,
  account_id text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount text check (amount ~ '^-?[0-9]+([.][0-9]+)?$'),
  accumulated text check (accumulated ~ '^-?[0-9]+([.][0-9]+)?$'),
  comparison text check (comparison ~ '^-?[0-9]+([.][0-9]+)?$'),
  collected_at timestamptz not null default now(),
  primary key (report_key, metric)
);
create index if not exists atlas_dart_accounts_period on public.atlas_dart_accounts(corp_code, scope, period_end desc);

create table if not exists public.atlas_dart_budget (
  day date primary key,
  calls integer not null check (calls > 0)
);

alter table public.atlas_dart_symbols enable row level security;
alter table public.atlas_dart_jobs enable row level security;
alter table public.atlas_dart_filings enable row level security;
alter table public.atlas_dart_accounts enable row level security;
alter table public.atlas_dart_budget enable row level security;
revoke all on public.atlas_dart_symbols, public.atlas_dart_jobs, public.atlas_dart_filings,
  public.atlas_dart_accounts, public.atlas_dart_budget from public, anon, authenticated, service_role;
grant select on public.atlas_dart_symbols, public.atlas_dart_jobs, public.atlas_dart_filings,
  public.atlas_dart_accounts, public.atlas_dart_budget to service_role;

create or replace function public.atlas_dart_work(action text, input jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  job_key text := input->>'key';
  token uuid := (input->>'lease')::uuid;
  job_kind text := input->>'kind';
  affected integer;
begin
  if action = 'budget' then
    insert into public.atlas_dart_budget as b(day,calls)
    values ((now() at time zone 'Asia/Seoul')::date,1)
    on conflict (day) do update set calls = b.calls + 1
    where b.calls < greatest(1,least(10000,(input->>'limit')::integer));
    return found;
  end if;

  if action = 'claim' then
    perform pg_catalog.pg_advisory_xact_lock(8436,1);
    if job_kind <> 'report' and (select count(*) from public.atlas_dart_jobs
      where kind <> 'report' and lease_until > now()) >= 2 then return false; end if;
    insert into public.atlas_dart_jobs(key,corp_code,kind,args)
      values(job_key,input->>'corp_code',job_kind,input->'args') on conflict(key) do nothing;
    update public.atlas_dart_jobs
    set lease = token, lease_until = now() + interval '3 minutes'
    where key = job_key and kind = job_kind
      and (lease_until is null or lease_until <= now())
      and (expires_at is null or expires_at <= now())
      and (retry_at is null or retry_at <= now());
    return found;
  end if;

  if action = 'fail' then
    update public.atlas_dart_jobs set lease = null, lease_until = null, error_code = input->>'error',
      retry_at = now() + pg_catalog.make_interval(secs => greatest(
        coalesce((input->>'delay')::integer,60), least(3600,60 * (1 << least(failures,6))))),
      failures = least(failures + 1,20)
    where key = job_key and lease = token and lease_until > now();
    return found;
  end if;

  if action <> 'finish' then raise exception 'invalid_dart_operation'; end if;
  perform pg_catalog.pg_advisory_xact_lock(8436,2);
  update public.atlas_dart_jobs set data = input->'data', checked_at = now(),
    expires_at = now() + pg_catalog.make_interval(secs => (input->>'ttl')::integer),
    lease = null, lease_until = null, retry_at = null, error_code = null, failures = 0
  where key = job_key and lease = token and lease_until > now()
  returning kind into job_kind;
  if not found then return false; end if;

  if job_kind in ('overview','financials','business','shareholders') and exists (
    select 1 from (
      select corp_code,series,max(receipt) as newest
      from jsonb_to_recordset(coalesce(input->'filings','[]')) as f(receipt text,corp_code text,series text)
      where series is not null group by corp_code,series
    ) snapshot join public.atlas_dart_filings saved
      on saved.corp_code=snapshot.corp_code and saved.series=snapshot.series and saved.receipt>snapshot.newest
  ) then raise exception 'outdated_dart_snapshot'; end if;

  if job_kind = 'codes' then
    if jsonb_array_length(input->'symbols') < 1 then raise exception 'empty_symbol_catalog'; end if;
    update public.atlas_dart_symbols set active = false where active;
    insert into public.atlas_dart_symbols(symbol,corp_code,name,modified_on,active)
    select symbol,corp_code,name,modified_on,true from
      jsonb_to_recordset(input->'symbols') as r(symbol text,corp_code text,name text,modified_on date)
    on conflict(symbol) do update set corp_code=excluded.corp_code,name=excluded.name,
      modified_on=excluded.modified_on,active=true;
  end if;

  -- A newly discovered periodic receipt invalidates other cached views of that company.
  update public.atlas_dart_jobs j set expires_at = now()
  where j.key <> job_key and j.checked_at is not null and j.expires_at > now()
    and j.kind in ('overview','financials','business','shareholders')
    and j.corp_code in (
      select f.corp_code from jsonb_to_recordset(coalesce(input->'filings','[]'))
        as f(receipt text,corp_code text,series text)
      where f.series is not null and not exists
        (select 1 from public.atlas_dart_filings old where old.receipt=f.receipt)
    );

  insert into public.atlas_dart_filings(receipt,corp_code,filed_on,title,series,corrected)
  select receipt,corp_code,filed_on,title,series,corrected from
    jsonb_to_recordset(coalesce(input->'filings','[]')) as f(receipt text,corp_code text,
      filed_on date,title text,series text,corrected boolean)
  on conflict(receipt) do update set title=excluded.title,series=excluded.series,
    corrected=excluded.corrected,collected_at=now();

  if job_kind = 'report' then
    delete from public.atlas_dart_accounts where report_key = job_key;
    insert into public.atlas_dart_accounts(report_key,corp_code,receipt,fiscal_year,report_code,period_end,
      scope,metric,account_id,currency,amount,accumulated,comparison)
    select job_key,corp_code,receipt,fiscal_year,report_code,period_end,
      scope,metric,account_id,currency,amount,accumulated,comparison from
    jsonb_to_recordset(coalesce(input->'accounts','[]')) as a(corp_code text,receipt text,
      fiscal_year smallint,report_code text,period_end date,scope text,metric text,account_id text,
      currency text,amount text,accumulated text,comparison text);
  end if;
  return true;
end;
$$;
revoke all on function public.atlas_dart_work(text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.atlas_dart_work(text,jsonb) to service_role;
commit;

-- Each table must have RLS on, browser read/write false, and server read true.
select c.relname, c.relrowsecurity,
  has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') as anon_access,
  has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') as authenticated_access,
  has_table_privilege('service_role',c.oid,'SELECT') as server_read
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('atlas_dart_symbols','atlas_dart_jobs',
  'atlas_dart_filings','atlas_dart_accounts','atlas_dart_budget') order by c.relname;
select has_function_privilege('anon','public.atlas_dart_work(text,jsonb)','EXECUTE') as anon_execute,
  has_function_privilege('authenticated','public.atlas_dart_work(text,jsonb)','EXECUTE') as authenticated_execute,
  has_function_privilege('service_role','public.atlas_dart_work(text,jsonb)','EXECUTE') as server_execute;
