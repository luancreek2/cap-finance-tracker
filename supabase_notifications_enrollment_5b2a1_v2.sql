-- Phase 5B.2A1 V2 — versioned VAPID enrollment contract amendment.
-- LOCAL REVIEW ARTIFACT. NOT APPLIED to production by this task.
--
-- V1 (`CAP_NOTIFICATIONS_ENROLLMENT_5B2A1_V1`) was reviewed but its production
-- application failed with SQLSTATE 42501 because the installer could not
-- replace the manager-owned registration function. The V1 transaction rolled
-- back completely; no production mutation survived. V1 remains preserved for
-- audit history and must not be treated as applied.
--
-- V2 changes only the installer privilege lifecycle. The VAPID contract itself
-- is unchanged from V1.
--
-- Additive only: this file never edits supabase_notifications_foundation.sql.
-- The approved Phase 5B.1 artifact and its SHA-256 must remain unchanged.
--
-- Identity:  CAP_NOTIFICATIONS_ENROLLMENT_5B2A1_V2
-- Guard:     set cap.notifications_enrollment_5b2a1 = 'reviewed-5b2a1-v2';
--
-- Scope: exactly two contract changes plus transactional installer membership.
--   1. bindings.vapid_key_version accepts versioned VAPID identities
--      ^v[1-9][0-9]{0,2}$ (v1..v999) instead of the parked 'unconfigured'.
--   2. public.cap_notifications_register_v1 rejects NULL and every value that
--      does not match that expression, instead of accepting only 'unconfigured'.
--
-- This intentionally transitions future bindings to real versioned VAPID
-- identities. Production currently holds zero bindings, so this is NOT a
-- backward-compatibility promise for the placeholder value.
--
-- Everything else is preserved byte-for-byte or left untouched: control row,
-- migration/engine/protocol identity, background flags, delivery time,
-- publication horizon, tables, policies, roles, schedules, delivery ledger,
-- endpoint ownership, readiness/summary/invalidate/publish RPCs, and every
-- financial schema, RPC and role.
--
-- Installer boundary: production `postgres` owns the private tables but the
-- registration function is owned by `cap_notification_manager`. `postgres`
-- holds the platform-created ADMIN-only membership from `supabase_admin`
-- (inherit=false, set=false), which is insufficient for CREATE OR REPLACE.
-- This transaction temporarily grants itself an inherit/set-capable membership
-- attributed to CURRENT_USER, performs the replacement, removes only that
-- temporary grant, and proves the original platform membership is restored
-- before contract_ok() and postflight run.

begin;

do $$
begin
  if current_setting('cap.notifications_enrollment_5b2a1', true)
     is distinct from 'reviewed-5b2a1-v2' then
    raise exception 'NOTIFICATION_ENROLLMENT_INSTALL_NOT_APPROVED';
  end if;
end $$;

-- Fail-closed preflight. Any drift from the reviewed Phase 5B.1 state stops the
-- transaction before a single object is modified.
do $$
declare
  fn oid := to_regprocedure('public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamp with time zone)');
  def text;
begin
  if to_regclass('cap_notifications_private.bindings') is null or fn is null then
    raise exception 'NOTIFICATION_ENROLLMENT_FOUNDATION_MISSING';
  end if;

  -- Production is expected to hold zero bindings. This amendment replaces the
  -- placeholder contract; it does not migrate existing rows.
  if (select count(*) from cap_notifications_private.bindings) <> 0 then
    raise exception 'NOTIFICATION_ENROLLMENT_BINDINGS_PRESENT';
  end if;

  if not exists(select 1 from cap_notifications_private.control where singleton
      and migration_id='CAP_NOTIFICATIONS_FOUNDATION_5B1_V1'
      and protocol='CAP_PUSH_V1' and engine_identity='cap-reminder-v1'
      and digest_version='hmac-sha256-v1' and delivery_time=time '09:00'
      and max_publication=interval '168 hours' and not background_enabled) then
    raise exception 'NOTIFICATION_ENROLLMENT_FOUNDATION_NOT_READY';
  end if;

  if (select count(*) from pg_constraint
      where conrelid='cap_notifications_private.bindings'::regclass
        and contype='c' and conname='bindings_vapid_key_version_check') <> 1 then
    raise exception 'NOTIFICATION_ENROLLMENT_CHECK_MISSING';
  end if;

  select pg_get_constraintdef(oid) into def from pg_constraint
    where conrelid='cap_notifications_private.bindings'::regclass
      and conname='bindings_vapid_key_version_check';

  if position('^v[1-9][0-9]{0,2}$' in def) > 0 then
    raise exception 'NOTIFICATION_ENROLLMENT_ALREADY_APPLIED';
  end if;
  if def !~ 'vapid_key_version = ''unconfigured''::text' then
    raise exception 'NOTIFICATION_ENROLLMENT_CHECK_DRIFT';
  end if;

  if not exists(select 1 from pg_proc where oid=fn
      and prosrc ~ 'p_vapid_key_version is distinct from ''unconfigured''') then
    raise exception 'NOTIFICATION_ENROLLMENT_FUNCTION_DRIFT';
  end if;

  -- Exact production installer shape. The platform-created membership must be
  -- the only membership for this role/member pair, and no CURRENT_USER-granted
  -- temporary membership may already exist.
  if current_user is distinct from 'postgres' then
    raise exception 'NOTIFICATION_ENROLLMENT_INSTALLER_DRIFT';
  end if;
  if not exists(select 1 from pg_roles where rolname='supabase_admin' and rolsuper) then
    raise exception 'NOTIFICATION_ENROLLMENT_INSTALLER_DRIFT';
  end if;
  if exists(select 1 from pg_auth_members m
      where m.roleid=to_regrole('cap_notification_manager')
        and m.member=to_regrole(current_user)
        and m.grantor=to_regrole(current_user)) then
    raise exception 'NOTIFICATION_ENROLLMENT_TEMP_MEMBERSHIP_PRESENT';
  end if;
  if (select count(*) from pg_auth_members m
      where m.roleid=to_regrole('cap_notification_manager')
        and m.member=to_regrole(current_user)) <> 1 then
    raise exception 'NOTIFICATION_ENROLLMENT_INSTALLER_MEMBERSHIP_DRIFT';
  end if;
  if not exists(select 1 from pg_auth_members m
      join pg_roles g on g.oid=m.grantor
      where m.roleid=to_regrole('cap_notification_manager')
        and m.member=to_regrole(current_user)
        and g.rolname='supabase_admin'
        and m.admin_option and not m.inherit_option and not m.set_option) then
    raise exception 'NOTIFICATION_ENROLLMENT_INSTALLER_MEMBERSHIP_DRIFT';
  end if;

  -- contract_ok() runs before the temporary membership exists. It must not be
  -- relaxed for the installer state.
  if not cap_notifications_private.contract_ok() then
    raise exception 'NOTIFICATION_ENROLLMENT_FOUNDATION_NOT_READY';
  end if;
end $$;

-- Temporary installer membership. It is created inside this transaction and
-- attributed to CURRENT_USER, leaving the Supabase/platform grant untouched.
-- The privilege exists only until the cleanup REVOKE below; any failure rolls
-- it back with the rest of the transaction.
grant cap_notification_manager to current_user
  with admin false, inherit true, set true
  granted by current_user;

do $$
begin
  if (select count(*) from pg_auth_members
      where roleid=to_regrole('cap_notification_manager')
        and member=to_regrole(current_user)) <> 2 then
    raise exception 'NOTIFICATION_ENROLLMENT_TEMP_GRANT_SHAPE';
  end if;
  if not exists(select 1 from pg_auth_members
      where roleid=to_regrole('cap_notification_manager')
        and member=to_regrole(current_user)
        and grantor=to_regrole(current_user)
        and not admin_option and inherit_option and set_option) then
    raise exception 'NOTIFICATION_ENROLLMENT_TEMP_GRANT_SHAPE';
  end if;
end $$;

alter table cap_notifications_private.bindings
  drop constraint bindings_vapid_key_version_check;

alter table cap_notifications_private.bindings
  add constraint bindings_vapid_key_version_check
  check (vapid_key_version ~ '^v[1-9][0-9]{0,2}$');

-- Only the VAPID predicate changes. Signature, body, SECURITY DEFINER, owner,
-- fixed search_path, UTC, owner derivation, endpoint/key validation, CAS,
-- endpoint reservations, capacity limits, schedule invalidation, exception
-- mapping and return shape are identical to the reviewed Phase 5B.1 function.
-- CREATE OR REPLACE preserves the existing owner and ACL.
create or replace function public.cap_notifications_register_v1(p_installation_id uuid,p_expected_generation bigint,
  p_protocol text,p_endpoint text,p_p256dh text,p_auth text,p_vapid_key_version text,p_browser_expiration timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' as $$
declare uid uuid:=cap_notifications_private.request_owner(); b cap_notifications_private.bindings%rowtype; fp bytea;
begin
  if not cap_notifications_private.contract_ok() then raise exception 'NOTIFICATION_CONTRACT_NOT_READY'; end if;
  if p_protocol is distinct from 'CAP_PUSH_V1' then raise exception 'NOTIFICATION_PROTOCOL_UNSUPPORTED'; end if;
  if p_installation_id is null or p_expected_generation is null or p_expected_generation<0
    or not cap_notifications_private.valid_endpoint(p_endpoint)
    or not cap_notifications_private.valid_keys(p_p256dh,p_auth)
    or p_vapid_key_version is null or p_vapid_key_version !~ '^v[1-9][0-9]{0,2}$'
    or (p_browser_expiration is not null and (not isfinite(p_browser_expiration) or p_browser_expiration<=statement_timestamp())) then
    raise exception 'NOTIFICATION_BINDING_INVALID'; end if;
  fp:=sha256(convert_to(p_endpoint,'UTF8'));
  -- Owner-scoped admission lock also serializes first registrations (no row
  -- exists yet). It is not an ownership/authentication substitute.
  perform pg_advisory_xact_lock(hashtextextended('cap-notifications:'||uid::text,0));
  select * into b from cap_notifications_private.bindings where user_id=uid and installation_id=p_installation_id for update;
  if (b.id is null and p_expected_generation<>0) or (b.id is not null and b.generation<>p_expected_generation) then
    raise exception 'NOTIFICATION_STALE_BINDING'; end if;
  if b.id is null and (select count(*) from cap_notifications_private.bindings where user_id=uid)>=20 then
    raise exception 'NOTIFICATION_BINDING_CAPACITY'; end if;
  if not exists(select 1 from cap_notifications_private.endpoint_owners where fingerprint=fp and user_id=uid)
    and (select count(*) from cap_notifications_private.endpoint_owners where user_id=uid)>=256 then
    raise exception 'NOTIFICATION_ENDPOINT_CAPACITY'; end if;
  insert into cap_notifications_private.endpoint_owners(fingerprint,user_id) values(fp,uid) on conflict(fingerprint) do nothing;
  if not exists(select 1 from cap_notifications_private.endpoint_owners where fingerprint=fp and user_id=uid) then
    raise exception 'NOTIFICATION_BINDING_CONFLICT'; end if;
  if b.id is null then
    insert into cap_notifications_private.bindings(user_id,installation_id,endpoint,endpoint_fingerprint,p256dh,auth,vapid_key_version,browser_expiration)
      values(uid,p_installation_id,p_endpoint,fp,p_p256dh,p_auth,p_vapid_key_version,p_browser_expiration) returning * into b;
  else
    delete from cap_notifications_private.schedules where user_id=uid and binding_id=b.id;
    update cap_notifications_private.bindings set generation=generation+1,state='pending',endpoint=p_endpoint,
      endpoint_fingerprint=fp,p256dh=p_p256dh,auth=p_auth,vapid_key_version=p_vapid_key_version,
      browser_expiration=p_browser_expiration,last_confirmed_at=null,schedule_revision=schedule_revision+1,updated_at=statement_timestamp()
      where id=b.id and user_id=uid returning * into b;
  end if;
  return jsonb_build_object('binding_id',b.id,'installation_id',b.installation_id,'generation',b.generation,
    'state',b.state,'schedule_revision',b.schedule_revision);
exception when unique_violation or foreign_key_violation then raise exception 'NOTIFICATION_BINDING_CONFLICT';
end $$;

-- Remove only the CURRENT_USER-granted temporary membership. The Supabase
-- platform grant from supabase_admin is never targeted.
revoke cap_notification_manager from current_user granted by current_user;

do $$
begin
  if exists(select 1 from pg_auth_members
      where roleid=to_regrole('cap_notification_manager')
        and member=to_regrole(current_user)
        and grantor=to_regrole(current_user)) then
    raise exception 'NOTIFICATION_ENROLLMENT_TEMP_MEMBERSHIP_REMAINS';
  end if;
  if (select count(*) from pg_auth_members
      where roleid=to_regrole('cap_notification_manager')
        and member=to_regrole(current_user)) <> 1 then
    raise exception 'NOTIFICATION_ENROLLMENT_MEMBERSHIP_NOT_RESTORED';
  end if;
  if not exists(select 1 from pg_auth_members m
      join pg_roles g on g.oid=m.grantor
      where m.roleid=to_regrole('cap_notification_manager')
        and m.member=to_regrole(current_user)
        and g.rolname='supabase_admin'
        and m.admin_option and not m.inherit_option and not m.set_option) then
    raise exception 'NOTIFICATION_ENROLLMENT_MEMBERSHIP_NOT_RESTORED';
  end if;
end $$;

-- Postflight: prove the amendment took effect and that privileges, ownership,
-- security attributes, the control row, installer membership and the
-- surrounding contract did not move. Fail closed on any mismatch.
do $$
declare
  fn oid := to_regprocedure('public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamp with time zone)');
  def text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
    where conrelid='cap_notifications_private.bindings'::regclass
      and conname='bindings_vapid_key_version_check';
  if def is null or position('^v[1-9][0-9]{0,2}$' in def) = 0
     or position('unconfigured' in def) > 0 then
    raise exception 'NOTIFICATION_ENROLLMENT_POSTFLIGHT_FAILED: check';
  end if;

  if fn is null or (select pronargs from pg_proc where oid=fn) <> 8
     or not (select prosecdef from pg_proc where oid=fn)
     or (select proowner from pg_proc where oid=fn) <> to_regrole('cap_notification_manager')
     or not (select proconfig from pg_proc where oid=fn) @> array['search_path=pg_catalog']
     or not (select proconfig from pg_proc where oid=fn) @> array['TimeZone=UTC'] then
    raise exception 'NOTIFICATION_ENROLLMENT_POSTFLIGHT_FAILED: function attributes';
  end if;

  if not has_function_privilege('authenticated',fn,'EXECUTE')
     or has_function_privilege('anon',fn,'EXECUTE')
     or has_function_privilege('service_role',fn,'EXECUTE')
     or has_function_privilege('cap_notification_runtime',fn,'EXECUTE')
     or exists(select 1 from aclexplode(coalesce((select proacl from pg_proc where oid=fn),
        acldefault('f',(select proowner from pg_proc where oid=fn)))) a where a.grantee=0)
     or (select count(*) from aclexplode(coalesce((select proacl from pg_proc where oid=fn),
        acldefault('f',(select proowner from pg_proc where oid=fn)))) a where a.grantee<>0) <> 2 then
    raise exception 'NOTIFICATION_ENROLLMENT_POSTFLIGHT_FAILED: privileges';
  end if;

  if (select count(*) from pg_auth_members m
      where m.roleid=to_regrole('cap_notification_manager')
        and m.member=to_regrole(current_user)) <> 1
     or exists(select 1 from pg_auth_members m
        where m.roleid=to_regrole('cap_notification_manager')
          and m.member=to_regrole(current_user)
          and m.grantor=to_regrole(current_user))
     or not exists(select 1 from pg_auth_members m
        join pg_roles g on g.oid=m.grantor
        where m.roleid=to_regrole('cap_notification_manager')
          and m.member=to_regrole(current_user)
          and g.rolname='supabase_admin'
          and m.admin_option and not m.inherit_option and not m.set_option) then
    raise exception 'NOTIFICATION_ENROLLMENT_POSTFLIGHT_FAILED: installer membership';
  end if;

  if not exists(select 1 from cap_notifications_private.control where singleton
      and migration_id='CAP_NOTIFICATIONS_FOUNDATION_5B1_V1'
      and protocol='CAP_PUSH_V1' and engine_identity='cap-reminder-v1'
      and digest_version='hmac-sha256-v1' and delivery_time=time '09:00'
      and max_publication=interval '168 hours' and not background_enabled) then
    raise exception 'NOTIFICATION_ENROLLMENT_POSTFLIGHT_FAILED: control';
  end if;

  if (select count(*) from cap_notifications_private.bindings) <> 0 then
    raise exception 'NOTIFICATION_ENROLLMENT_POSTFLIGHT_FAILED: bindings';
  end if;

  if (select count(*) from pg_tables where schemaname='cap_notifications_private') <> 5
     or (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname like 'cap_notifications_%') <> 5 then
    raise exception 'NOTIFICATION_ENROLLMENT_POSTFLIGHT_FAILED: surface';
  end if;

  if not cap_notifications_private.contract_ok() then
    raise exception 'NOTIFICATION_ENROLLMENT_POSTFLIGHT_FAILED: contract';
  end if;
end $$;

commit;
