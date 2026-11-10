-- Check the existing constraint and the stored maximum before or after applying.
select conname, convalidated, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.strategies'::regclass and conname = 'strategies_indicators_check';

select coalesce(max(jsonb_array_length(indicators)), 0) as largest_strategy,
       count(*) filter (where jsonb_array_length(indicators) > 5) as requires_expanded_limit
from public.strategies;

begin;
set local lock_timeout = '5s';
lock table public.strategies in access exclusive mode;

do $$
declare
  current_definition text;
  expected_prefix constant text := 'checkjsonb_typeofindicators=''array''andjsonb_array_lengthindicators>=1andjsonb_array_lengthindicators<=';
  expected_suffix constant text := 'andoctet_lengthindicators<=32768';
begin
  select regexp_replace(lower(replace(pg_get_constraintdef(oid), '::text', '')), '[[:space:]()]', '', 'g')
  into current_definition from pg_constraint
  where conrelid = 'public.strategies'::regclass and conname = 'strategies_indicators_check'
    and contype = 'c' and convalidated;

  if current_definition = expected_prefix || '12' || expected_suffix then
    return;
  end if;
  if current_definition is distinct from expected_prefix || '5' || expected_suffix then
    raise exception 'Unexpected strategies_indicators_check; inspect its definition before retrying';
  end if;

  alter table public.strategies drop constraint strategies_indicators_check;
  alter table public.strategies add constraint strategies_indicators_check check (
    jsonb_typeof(indicators) = 'array'
    and jsonb_array_length(indicators) between 1 and 12
    and octet_length(indicators::text) <= 32768
  );
end $$;

commit;

select conname, convalidated, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.strategies'::regclass and conname = 'strategies_indicators_check';
