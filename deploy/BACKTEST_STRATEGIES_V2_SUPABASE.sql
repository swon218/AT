-- ATLAS 인증용 Supabase SQL Editor에서 전체 실행합니다.
-- 기존 STRATEGIES_SUPABASE.sql이 적용된 프로젝트용 증분 변경입니다.
-- 기존 v1 전략/리비전은 수정하지 않으며, 반복 실행해도 데이터를 보존합니다.
-- 순서: 복구 기준 확보 → 이 SQL → 확인 쿼리 → 새 프런트 배포.
-- 구버전은 v1 저장을 계속할 수 있지만 v2 전략을 읽지 못할 수 있습니다.
begin;
set local lock_timeout = '5s';
lock table public.strategies in access exclusive mode;

create or replace function public.atlas_strategy_definition_valid(i jsonb, s jsonb)
returns boolean language plpgsql immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  specs constant jsonb := $spec${"ma":{"config":{"type":{"kind":"choice","values":["SMA","EMA"]},"shortPeriod":{"kind":"number","min":1,"max":500,"integer":true},"shortColor":{"kind":"color"},"longPeriod":{"kind":"number","min":1,"max":500,"integer":true},"longColor":{"kind":"color"}},"fields":{"short":{"unit":"price","min":0},"long":{"unit":"price","min":0},"close":{"unit":"price","min":0}}},"bollinger":{"config":{"period":{"kind":"number","min":1,"max":500,"integer":true},"multiplier":{"kind":"number","min":0.1,"max":10,"integer":false},"upperColor":{"kind":"color"},"middleColor":{"kind":"color"},"lowerColor":{"kind":"color"}},"fields":{"close":{"unit":"price","min":0},"high":{"unit":"price","min":0},"low":{"unit":"price","min":0},"upper":{"unit":"price","min":0},"middle":{"unit":"price","min":0},"lower":{"unit":"price","min":0}}},"volume-ma":{"config":{"period":{"kind":"number","min":1,"max":500,"integer":true},"color":{"kind":"color"}},"fields":{"volume":{"unit":"volume"},"average":{"unit":"volume"}}},"rsi":{"config":{"period":{"kind":"number","min":1,"max":500,"integer":true},"lower":{"kind":"number","min":0,"max":100,"integer":false},"upper":{"kind":"number","min":0,"max":100,"integer":false},"color":{"kind":"color"},"upperColor":{"kind":"color"},"lowerColor":{"kind":"color"}},"fields":{"rsi":{"unit":"percent","min":0,"max":100}}},"macd":{"config":{"fast":{"kind":"number","min":1,"max":500,"integer":true},"slow":{"kind":"number","min":1,"max":500,"integer":true},"signal":{"kind":"number","min":1,"max":500,"integer":true},"macdColor":{"kind":"color"},"signalColor":{"kind":"color"},"positiveColor":{"kind":"color"},"negativeColor":{"kind":"color"}},"fields":{"macd":{"unit":"price"},"signal":{"unit":"price"},"histogram":{"unit":"price"}}},"atr":{"config":{"period":{"kind":"number","min":1,"max":500,"integer":true},"display":{"kind":"choice","values":["price","percent"]},"color":{"kind":"color"}},"fields":{"atr":{"unit":"price","min":0},"atr_percent":{"unit":"percent","min":0}}},"dmi":{"config":{"period":{"kind":"number","min":1,"max":500,"integer":true},"adxPeriod":{"kind":"number","min":1,"max":500,"integer":true},"showAdx":{"kind":"boolean"},"adxColor":{"kind":"color"},"showPlus":{"kind":"boolean"},"plusColor":{"kind":"color"},"showMinus":{"kind":"boolean"},"minusColor":{"kind":"color"},"showLevels":{"kind":"boolean"},"lower":{"kind":"number","min":0,"max":100,"integer":true},"upper":{"kind":"number","min":0,"max":100,"integer":true}},"fields":{"adx":{"unit":"percent","min":0,"max":100},"plus_di":{"unit":"percent","min":0,"max":100},"minus_di":{"unit":"percent","min":0,"max":100}}},"stochastic":{"config":{"period":{"kind":"number","min":1,"max":500,"integer":true},"kPeriod":{"kind":"number","min":1,"max":500,"integer":true},"dPeriod":{"kind":"number","min":1,"max":500,"integer":true},"lower":{"kind":"number","min":0,"max":100,"integer":true},"upper":{"kind":"number","min":0,"max":100,"integer":true},"kColor":{"kind":"color"},"dColor":{"kind":"color"}},"fields":{"stoch_k":{"unit":"percent","min":0,"max":100},"stoch_d":{"unit":"percent","min":0,"max":100}}},"obv":{"config":{"color":{"kind":"color"},"showAverage":{"kind":"boolean"},"maType":{"kind":"choice","values":["SMA","EMA"]},"maPeriod":{"kind":"number","min":1,"max":500,"integer":true},"maColor":{"kind":"color"}},"fields":{"obv":{"unit":"volume"},"obv_ma":{"unit":"volume"}}},"mfi":{"config":{"period":{"kind":"number","min":1,"max":500,"integer":true},"lower":{"kind":"number","min":0,"max":100,"integer":true},"upper":{"kind":"number","min":0,"max":100,"integer":true},"color":{"kind":"color"}},"fields":{"mfi":{"unit":"percent","min":0,"max":100}}},"cci":{"config":{"period":{"kind":"number","min":1,"max":500,"integer":true},"source":{"kind":"choice","values":["hlc3","close"]},"lower":{"kind":"number","min":-1000,"max":1000,"integer":true},"middle":{"kind":"number","min":-1000,"max":1000,"integer":true},"upper":{"kind":"number","min":-1000,"max":1000,"integer":true},"color":{"kind":"color"}},"fields":{"cci":{"unit":"index"}}},"supertrend":{"config":{"period":{"kind":"number","min":1,"max":500,"integer":true},"multiplier":{"kind":"number","min":0.1,"max":20,"integer":false},"upColor":{"kind":"color"},"downColor":{"kind":"color"},"showFlips":{"kind":"boolean"}},"fields":{"supertrend":{"unit":"price","min":0},"close":{"unit":"price","min":0},"supertrend_direction":{"unit":"state","stateValues":[-1,1]},"supertrend_flip":{"unit":"state","stateValues":[-1,0,1]}}}}$spec$::jsonb;
  c jsonb; r jsonb; f jsonb; target jsonb; definition jsonb;
  id text; key text; v jsonb; n numeric; ids text[] := '{}';
  source_id text; unit text; state text;
begin
  if jsonb_typeof(i) is distinct from 'array' or jsonb_array_length(i)>12
    or octet_length(i::text)>32768 or jsonb_typeof(s) is distinct from 'object'
    or octet_length(s::text)>16384 then return false; end if;
  if not s ?& array['entryMode','entryConditions','takeProfitPct','stopLossPct']
    or exists(select 1 from jsonb_object_keys(s) k where k not in ('entryMode','entryConditions','takeProfitPct','stopLossPct','legacy'))
    or coalesce(s->>'entryMode','') not in ('all','any')
    or jsonb_typeof(s->'entryConditions') is distinct from 'array'
    or jsonb_array_length(s->'entryConditions')>64 then return false; end if;
  for c in select value from jsonb_array_elements(i) loop
    id := c->>'id'; definition := specs->id;
    if jsonb_typeof(c) is distinct from 'object' or definition is null or id=any(ids)
      or exists(select 1 from jsonb_object_keys(c) k where k<>'id' and not (definition->'config') ? k)
      then return false; end if;
    ids := array_append(ids,id);
    for key,r in select * from jsonb_each(definition->'config') loop
      v := c->key;
      if r->>'kind'='number' then
        if jsonb_typeof(v) is distinct from 'number' then return false; end if;
        n := (v#>>'{}')::numeric;
        if n<(r->>'min')::numeric or n>(r->>'max')::numeric
          or ((r->>'integer')::boolean and n<>trunc(n)) then return false; end if;
      elsif r->>'kind'='boolean' then
        if jsonb_typeof(v) is distinct from 'boolean' then return false; end if;
      elsif r->>'kind'='color' then
        if jsonb_typeof(v) is distinct from 'string' or (v#>>'{}') !~ '^#[0-9a-fA-F]{6}$' then return false; end if;
      elsif not (r->'values') @> jsonb_build_array(v) then return false;
      end if;
    end loop;
    if (id='ma' and (c->>'shortPeriod')::numeric >= (c->>'longPeriod')::numeric)
      or (id='macd' and (c->>'fast')::numeric >= (c->>'slow')::numeric)
      or (c ? 'lower' and (c->>'lower')::numeric >= (c->>'upper')::numeric)
      or (id='cci' and not ((c->>'lower')::numeric < (c->>'middle')::numeric and (c->>'middle')::numeric < (c->>'upper')::numeric))
      then return false; end if;
  end loop;
  for key in select unnest(array['takeProfitPct','stopLossPct']) loop
    v := s->key;
    if v='""'::jsonb then continue; end if;
    if jsonb_typeof(v) is distinct from 'number' then return false; end if;
    n := (v#>>'{}')::numeric;
    if n<=0 or (key='takeProfitPct' and n>10000) or (key='stopLossPct' and n>=100) then return false; end if;
  end loop;
  if cardinality(ids)=0 and jsonb_array_length(s->'entryConditions')=0
    and s->'takeProfitPct'='""'::jsonb and s->'stopLossPct'='""'::jsonb then return false; end if;
  for c in select value from jsonb_array_elements(s->'entryConditions') loop
    id := c->>'indicatorId'; f := specs->id->'fields'->(c->>'left'); r := c->'right';
    if jsonb_typeof(c) is distinct from 'object' or not c ?& array['indicatorId','enabled','left','operator','right']
      or exists(select 1 from jsonb_object_keys(c) k where k not in ('indicatorId','enabled','left','operator','right'))
      or not id=any(ids) or f is null or jsonb_typeof(c->'enabled') is distinct from 'boolean'
      or coalesce(c->>'operator','') not in ('gt','gte','lt','lte','eq','crossUp','crossDown')
      or jsonb_typeof(r) is distinct from 'object' then return false; end if;
    unit := f->>'unit'; state := c->>'operator';
    if r->>'type'='constant' then
      if not r ? 'value' or exists(select 1 from jsonb_object_keys(r) k where k not in ('type','value'))
        or jsonb_typeof(r->'value') is distinct from 'number' then return false; end if;
      n := (r->>'value')::numeric;
      if (f ? 'min' and n<(f->>'min')::numeric) or (f ? 'max' and n>(f->>'max')::numeric)
        or (f ? 'stateValues' and (state<>'eq' or not (f->'stateValues') @> jsonb_build_array(n))) then return false; end if;
    elsif r->>'type'='series' then
      source_id := coalesce(r->>'indicatorId',id); target := specs->source_id->'fields'->(r->>'field');
      if exists(select 1 from jsonb_object_keys(r) k where k not in ('type','field','indicatorId'))
        or not source_id=any(ids) or target is null or target->>'unit'<>unit or unit='state' then return false; end if;
    else return false; end if;
  end loop;
  if s ? 'legacy' then
    v := s->'legacy';
    if jsonb_typeof(v) is distinct from 'object' or octet_length(v::text)>8192 or v->>'schemaVersion' is distinct from '1'
      or exists(select 1 from jsonb_object_keys(v) k where k not in ('schemaVersion','entry','exit','entryMode','exitMode','initialCapital','feePct','taxPct','slippagePct')) then return false; end if;
    for key in select unnest(array['entry','exit']) loop
      if v ? key and (jsonb_typeof(v->key) is distinct from 'array' or jsonb_array_length(v->key)>14) then return false; end if;
      if v ? key and exists(select 1 from jsonb_array_elements(v->key) e where jsonb_typeof(e) is distinct from 'string' or char_length(e#>>'{}')>80) then return false; end if;
    end loop;
    for key in select unnest(array['entryMode','exitMode']) loop
      if v ? key and v->>key not in ('all','any') then return false; end if;
    end loop;
    for key in select unnest(array['initialCapital','feePct','taxPct','slippagePct']) loop
      if v ? key and jsonb_typeof(v->key) is distinct from 'number' then return false; end if;
    end loop;
  end if;
  return true;
exception when others then return false;
end;
$$;
revoke all on function public.atlas_strategy_definition_valid(jsonb,jsonb) from public,anon;
grant execute on function public.atlas_strategy_definition_valid(jsonb,jsonb) to authenticated,service_role;
comment on function public.atlas_strategy_definition_valid(jsonb,jsonb) is 'atlas-strategy-v2; partial definitions; no execution inputs; no orders';

alter table public.strategies drop constraint if exists strategies_schema_version_check;
alter table public.strategies add constraint strategies_schema_version_check check (schema_version in (1,2));
alter table public.strategies drop constraint if exists strategies_indicators_check;
alter table public.strategies add constraint strategies_indicators_check check (
  jsonb_typeof(indicators)='array' and jsonb_array_length(indicators) between 0 and 12
  and (schema_version=2 or jsonb_array_length(indicators)>0) and octet_length(indicators::text)<=32768
);
alter table public.strategies drop constraint if exists strategies_definition_v2_check;
alter table public.strategies add constraint strategies_definition_v2_check check (
  schema_version=1 or public.atlas_strategy_definition_valid(indicators,backtest_settings)
);
alter table public.strategies enable row level security;
-- 기존 소유권 RLS와 revision 트리거는 그대로 사용합니다. 메타데이터 직접 수정은 계속 금지합니다.
revoke all on table public.strategies from public,anon,authenticated;
grant select,delete on table public.strategies to authenticated;
grant insert(user_id,name,indicators,backtest_settings,schema_version) on public.strategies to authenticated;
grant update(name,indicators,backtest_settings,schema_version) on public.strategies to authenticated;
notify pgrst,'reload schema';
commit;

-- 확인: rls=true, invalid_v2=0, allowed_versions=true, revision_trigger=true.
select c.relrowsecurity as rls,
  (select count(*) from public.strategies where schema_version=2 and not public.atlas_strategy_definition_valid(indicators,backtest_settings)) as invalid_v2,
  (select bool_and(schema_version in (1,2)) from public.strategies) is not false as allowed_versions,
  exists(select 1 from pg_trigger where tgrelid=c.oid and tgname='strategies_updated_at' and not tgisinternal) as revision_trigger
from pg_class c where c.oid='public.strategies'::regclass;
-- 확인: guest_read=false, member_read=true, member_revision_write=false, validator_member=true.
select has_table_privilege('anon','public.strategies','select') as guest_read,
  has_table_privilege('authenticated','public.strategies','select') as member_read,
  has_column_privilege('authenticated','public.strategies','revision','update') as member_revision_write,
  has_function_privilege('authenticated','public.atlas_strategy_definition_valid(jsonb,jsonb)','execute') as validator_member;
