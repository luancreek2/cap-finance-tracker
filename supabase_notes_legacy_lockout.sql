-- Cap notes legacy lockout — CUTOVER ONLY.
--
-- DO NOT RUN THIS AS PRE-MIGRATION HARDENING.
-- This is the server-side old-client lockout. It intentionally removes the
-- current notes read/write path and drops the legacy notes RPCs. Run it only in
-- an approved cutover window, together with the private sidecar/new reader
-- deployment and after the read-only audit has been re-run cleanly.
--
-- It does not create the sidecar, backfill lifecycle rows, migrate content,
-- enable Cloud Sync, or touch financial tables. It does not change note rows.
--
-- REQUIRED SESSION GUARD. In the same SQL Editor session, run this first:
--   select set_config('cap.lockout_approved','cutover-window-only',false);
-- Then run this entire file.

begin;

do $$
declare
  note_owner oid;
begin
  if current_setting('cap.lockout_approved', true) is distinct from 'cutover-window-only' then
    raise exception 'LOCKOUT_NOT_APPROVED';
  end if;

  if to_regclass('public.notes') is null then
    raise exception 'LOCKOUT_BLOCKED: public.notes is missing';
  end if;

  select c.relowner into note_owner
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'notes';

  if note_owner is distinct from (select oid from pg_roles where rolname = current_user) then
    raise exception 'LOCKOUT_BLOCKED: current role % does not own public.notes', current_user;
  end if;
end $$;

-- 1. Remove every direct table privilege from clients and PUBLIC.
revoke all on table public.notes from anon, authenticated, public;

-- 2. Defensive column-level revocation. This catches grants that a table-level
--    REVOKE does not remove.
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
    execute format('revoke all (%I) on table public.notes from anon, authenticated, public', c.attname);
  end loop;
end $$;

-- 3. Remove the old content-only owner policy. The new reader must not depend
--    on direct table SELECT or on the old ALL policy.
drop policy if exists own_rows on public.notes;
alter table public.notes force row level security;

-- 4. Remove the legacy notes write and readiness functions. Their exact
--    signatures are required so no overload is left behind.
drop function if exists public.cap_sync_note_put(uuid, jsonb, jsonb);
drop function if exists public.cap_verify_notes_rpc();

-- 5. Idempotent removal of the test-only financial RPCs. The app-level
--    hardening script should already have removed them.
drop function if exists public.cap_test_transaction_create(
  uuid, text, uuid, uuid, uuid, numeric, date, date, text, text, text, jsonb
);
drop function if exists public.cap_verify_transaction_rpc();

-- 6. Keep the platform/trigger helpers from being client-executable even if an
--    earlier hardening step was skipped. This does not drop them.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;

  if to_regprocedure('public.set_updated_at()') is not null then
    execute 'revoke execute on function public.set_updated_at() from public, anon, authenticated';
  end if;
end $$;

commit;
