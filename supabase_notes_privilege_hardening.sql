-- Cap notes privilege hardening — pre-migration, app-level.
--
-- MANUAL REVIEW ONLY. This is not the sidecar migration, backfill, or cutover.
-- It removes unnecessary current exposure without taking away the current notes
-- app's SELECT/INSERT/UPDATE path. The destructive own_rows policy, direct
-- authenticated SELECT/write path, and the legacy notes RPCs are deliberately
-- left for the separately approved lockout script.
--
-- It does not insert, update, delete, truncate, or migrate application rows.
-- It does not touch financial tables. It does not change Cloud Sync.
--
-- REQUIRED SESSION GUARD. In the same SQL Editor session, run this first:
--   select set_config('cap.hardening_approved','privilege-hardening-only',false);
-- Then run this entire file. Without the guard the transaction aborts.

begin;

do $$
begin
  if current_setting('cap.hardening_approved', true) is distinct from 'privilege-hardening-only' then
    raise exception 'HARDENING_NOT_APPROVED';
  end if;
end $$;

do $$
declare
  note_owner oid;
begin
  if to_regclass('public.notes') is null then
    raise exception 'HARDENING_BLOCKED: public.notes is missing';
  end if;

  select c.relowner into note_owner
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'notes';

  if note_owner is distinct from (select oid from pg_roles where rolname = current_user) then
    raise exception 'HARDENING_BLOCKED: current role % does not own public.notes', current_user;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notes' and policyname = 'own_rows'
  ) then
    raise exception 'HARDENING_BLOCKED: expected own_rows policy is missing; re-audit before changing';
  end if;
end $$;

-- 1. Remove all anonymous/PUBLIC note access, including TRUNCATE, REFERENCES,
--    TRIGGER, and any column-level grants. The live audit found no anon DML,
--    but it did find those three direct table privileges.
revoke all on table public.notes from anon, public;

-- 2. The current notes app does not delete or truncate notes. Remove those
--    direct paths. Keep SELECT/INSERT/UPDATE so the pre-migration app remains
--    usable until the approved lockout.
revoke delete, truncate, references, trigger on table public.notes from authenticated;

-- 3. Defensive column-level revokes. The live audit returned no column grants,
--    but this closes a future or omitted grant without removing authenticated
--    SELECT/INSERT/UPDATE.
do $$
declare
  c record;
begin
  for c in
    select a.attname
    from pg_attribute a
    where a.attrelid = 'public.notes'::regclass
      and a.attnum > 0
      and not a.attisdropped
  loop
    execute format('revoke all (%I) on table public.notes from anon, public', c.attname);
    execute format('revoke references (%I) on table public.notes from authenticated', c.attname);
  end loop;
end $$;

-- 4. Defense in depth. The live owner is postgres, which also has BYPASSRLS;
--    this does not replace revoking grants or using a dedicated sidecar writer.
alter table public.notes force row level security;

-- 5. Remove client EXECUTE from unnecessary PUBLIC-executable functions.
--    Trigger execution does not require the invoking client to hold EXECUTE on
--    the trigger function, so existing updated_at triggers keep working.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;

  if to_regprocedure('public.set_updated_at()') is not null then
    execute 'revoke execute on function public.set_updated_at() from public, anon, authenticated';
  end if;
end $$;

-- 6. Retire the test-only financial RPCs. These are not the notes pilot and
--    the audit marks them high. Dropping the functions removes no user data.
drop function if exists public.cap_test_transaction_create(
  uuid, text, uuid, uuid, uuid, numeric, date, date, text, text, text, jsonb
);
drop function if exists public.cap_verify_transaction_rpc();

-- 7. Stop postgres-owned default ACLs from re-granting client privileges on
--    future public objects. Existing objects are handled above; these
--    statements only affect future postgres-created objects.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, public;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, public;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, public;
alter default privileges for role postgres in schema public
  revoke all on types from anon, authenticated, public;

do $$
begin
  if exists (
    select 1
    from pg_default_acl d
    join pg_roles r on r.oid = d.defaclrole
    where r.rolname = 'supabase_admin'
  ) then
    raise notice 'PLATFORM_DEFAULT_ACL_REVIEW_REQUIRED: run supabase_notes_platform_default_acl.sql with a superuser/platform-admin session before cutover';
  end if;
end $$;

commit;
