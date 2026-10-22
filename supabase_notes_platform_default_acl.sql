-- Cap notes platform default-ACL hardening.
--
-- MANUAL PLATFORM-ADMIN SCRIPT. The live audit shows unsafe default ACLs owned
-- by `supabase_admin` in schema `public`. The normal app SQL Editor session runs
-- as `postgres`, which is not a superuser and is not a member of
-- `supabase_admin`, so it cannot alter those defaults. This script intentionally
-- aborts unless it is run by `supabase_admin` or another superuser.
--
-- This changes default privileges only. It does not create, alter, drop, read,
-- or write application rows. Do not run it as a substitute for the app-level
-- hardening script.
--
-- REQUIRED SESSION GUARD. In the same SQL Editor session, run this first:
--   select set_config('cap.platform_acl_approved','platform-admin-review',false);
-- Then run this entire file.

begin;

do $$
begin
  if current_setting('cap.platform_acl_approved', true) is distinct from 'platform-admin-review' then
    raise exception 'PLATFORM_ACL_NOT_APPROVED';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'PLATFORM_ACL_BLOCKED: supabase_admin role not found';
  end if;

  if not (
    exists (select 1 from pg_roles where rolname = current_user and rolsuper)
    or pg_has_role(current_user, 'supabase_admin', 'MEMBER')
  ) then
    raise exception 'PLATFORM_ACL_BLOCKED: current role % cannot alter supabase_admin defaults; use supabase_admin or a superuser/platform-admin session', current_user;
  end if;
end $$;

alter default privileges for role supabase_admin in schema public
  revoke all on tables from anon, authenticated, public;
alter default privileges for role supabase_admin in schema public
  revoke all on sequences from anon, authenticated, public;
alter default privileges for role supabase_admin in schema public
  revoke all on functions from anon, authenticated, public;
alter default privileges for role supabase_admin in schema public
  revoke all on types from anon, authenticated, public;

commit;
