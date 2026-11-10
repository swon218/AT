-- Run AFTER AI_EVAL_SUPABASE.sql as the Supabase project database owner.
-- Find your ATLAS account in Authentication > Users and copy its UID.
-- Replace the placeholder locally. Do not enter an email/password here.
insert into public.admin_users(user_id)
values ('<관리자로 지정할 사용자 UID>'::uuid)
on conflict(user_id) do nothing;

select user_id,created_at from public.admin_users
where user_id='<관리자로 지정할 사용자 UID>'::uuid;

-- Revocation (run ONLY when intentionally removing this administrator):
-- delete from public.admin_users where user_id='<관리자로 지정할 사용자 UID>'::uuid;
