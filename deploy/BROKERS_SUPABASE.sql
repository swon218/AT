-- ATLAS: NH투자증권 / KB증권 추가. 기존 로그인용 Supabase SQL Editor에서 실행.
-- 키 값은 이 SQL에 넣지 않습니다. VPS가 기존 AES-256-GCM 암호문에 함께 저장합니다.
begin;

alter table public.user_integrations
  add column if not exists nh_configured boolean not null default false,
  add column if not exists kb_configured boolean not null default false;

-- 브라우저는 등록 여부도 VPS 인증 경로를 통해 조회합니다.
alter table public.user_integrations enable row level security;
revoke all on table public.user_integrations from anon, authenticated;
grant all privileges on table public.user_integrations to service_role;

-- NH / KB 주문 중복 전송 방지용. 키/토큰/계좌번호를 저장하지 않습니다.
-- 접수 전 pending을 먼저 저장하고, 응답 확인 시에만 succeeded로 바꿉니다.
create table if not exists public.broker_order_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null check (broker in ('nh', 'kb')),
  request_id text not null check (request_id ~ '^[a-zA-Z0-9_-]{12,80}$'),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  state text not null default 'pending' check (state in ('pending', 'succeeded', 'uncertain')),
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, broker, request_id)
);
alter table public.broker_order_requests enable row level security;
revoke all on table public.broker_order_requests from anon, authenticated;
grant all privileges on table public.broker_order_requests to service_role;
comment on table public.broker_order_requests is
  'VPS-only order submission reservations; no credentials. Do not delete pending/uncertain rows to retry an order.';

notify pgrst, 'reload schema';
commit;
