-- Phase 6L DRAFT: prepare/review only. NOT authorized for production deployment.
-- Final, dependency-ordered security cutover. Run this only after all of:
--   0. supabase_production_identity.sql + supabase_production_role_boundary.sql
--   1. supabase_production_notes_sidecar.sql (or its in-place identity repair)
--   2. notes lifecycle backfill (also re-run and verified here)
--   3. supabase_production_transaction_create.sql
--   4. supabase_production_snapshot_readiness.sql
-- The three installers are first-install scripts. This cutover removes the old
-- direct authenticated/anon table paths, retires the legacy RPCs, keeps only the
-- reviewed RPC surface, and proves the final catalog state in the same
-- transaction. It does not insert, update or delete any application row.
-- Guard (must be explicitly set by the reviewed installer):
--   SET cap.production_cutover = 'reviewed-draft-only';
begin;

do $$
declare
  t text;
  role_name text;
  target_tables text[] := array['public.profiles','public.user_preferences',
    'public.categories','public.accounts','public.goals','public.debts','public.bills',
    'public.account_statements','public.transactions','public.transfers',
    'public.bill_payments','public.budgets','public.notes'];
  targets oid[] := '{}'::oid[];
begin
  if current_setting('cap.production_cutover',true) is distinct from 'reviewed-draft-only' then
    raise exception 'PRODUCTION_CUTOVER_NOT_APPROVED';
  end if;
  if current_user in ('authenticated','anon','service_role') then
    raise exception 'PRODUCTION_CUTOVER_ADMIN_REQUIRED';
  end if;

  if to_regnamespace('cap_notes_private') is null
     or to_regnamespace('cap_sync_private') is null
     or to_regclass('cap_notes_private.note_lifecycle') is null
     or to_regclass('cap_notes_private.operations') is null
     or to_regclass('cap_sync_private.transaction_create_receipts') is null
     or to_regprocedure('public.cap_notes_read(uuid)') is null
     or to_regprocedure('public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)') is null
     or to_regprocedure('public.cap_verify_notes_lifecycle()') is null
     or to_regprocedure('public.cap_sync_transaction_create(uuid,jsonb,jsonb)') is null
     or to_regprocedure('public.cap_sync_snapshot_v1()') is null
     or to_regprocedure('public.cap_verify_production_sync_v1()') is null
     or to_regprocedure('public.cap_request_uid()') is null
     or to_regprocedure('public.cap_role_boundary_ok(oid)') is null then
    raise exception 'PRODUCTION_CUTOVER_DEPENDENCIES_REQUIRED';
  end if;

  if obj_description(to_regprocedure('public.cap_notes_read(uuid)'),'pg_proc')
       is distinct from 'CAP_NOTES_SIDECAR_V1'
     or obj_description(to_regprocedure('public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)'),'pg_proc')
       is distinct from 'CAP_NOTES_SIDECAR_V1'
     or obj_description(to_regprocedure('public.cap_verify_notes_lifecycle()'),'pg_proc')
       is distinct from 'CAP_NOTES_SIDECAR_V1'
     or obj_description(to_regprocedure('public.cap_sync_transaction_create(uuid,jsonb,jsonb)'),'pg_proc')
       is distinct from 'CAP_TX_CREATE_CAS_RECEIPT_V1'
     or obj_description(to_regprocedure('public.cap_sync_snapshot_v1()'),'pg_proc')
       is distinct from 'CAP_SYNC_SNAPSHOT_V1'
     or obj_description(to_regprocedure('public.cap_verify_production_sync_v1()'),'pg_proc')
       is distinct from 'CAP_PRODUCTION_SYNC_READINESS_V1' then
    raise exception 'PRODUCTION_CUTOVER_CONTRACT_VERSION_MISMATCH';
  end if;

  foreach role_name in array array['cap_notes_sidecar_writer',
    'cap_transaction_writer','cap_sync_reader'] loop
    if not exists(select 1 from pg_roles r where r.rolname=role_name
        and not r.rolcanlogin and not r.rolinherit and not r.rolsuper
        and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole
        and not r.rolreplication) then
      raise exception 'PRODUCTION_CUTOVER_ROLE_CONTRACT_MISMATCH';
    end if;
  end loop;

  foreach t in array target_tables loop
    if to_regclass(t) is null then
      raise exception 'PRODUCTION_CUTOVER_DEPENDENCIES_REQUIRED';
    end if;
    targets := array_append(targets,t::regclass);
  end loop;

  if exists(select 1 from pg_class c where c.oid=any(targets)
      and c.relowner is distinct from current_user::regrole) then
    raise exception 'PRODUCTION_CUTOVER_TABLE_OWNERSHIP_REQUIRED';
  end if;
  if exists(select 1 from pg_class c where c.oid=any(targets) and not c.relrowsecurity) then
    raise exception 'PRODUCTION_CUTOVER_TABLE_RLS_REQUIRED';
  end if;
  if not exists(select 1 from pg_class c where c.oid='public.notes'::regclass
      and c.relrowsecurity and c.relforcerowsecurity)
     or not exists(select 1 from pg_class c
       where c.oid='cap_notes_private.note_lifecycle'::regclass
       and c.relrowsecurity and c.relforcerowsecurity)
     or not exists(select 1 from pg_class c
       where c.oid='cap_notes_private.operations'::regclass
       and c.relrowsecurity and c.relforcerowsecurity)
     or not exists(select 1 from pg_class c
       where c.oid='cap_sync_private.transaction_create_receipts'::regclass
       and c.relrowsecurity and c.relforcerowsecurity) then
    raise exception 'PRODUCTION_CUTOVER_PRIVATE_RLS_REQUIRED';
  end if;

  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public'
        and (p.proname in ('cap_sync_note_put','cap_verify_notes_rpc',
          'cap_verify_transaction_rpc')
          or p.proname like 'cap\_test\_%')
        and p.proowner is distinct from current_user::regrole) then
    raise exception 'PRODUCTION_CUTOVER_LEGACY_FUNCTION_OWNERSHIP_REQUIRED';
  end if;

  -- Platform helpers can only be locked down by their owner. If one of them is
  -- still client-executable and is not owned by this session, the cutover stops
  -- with a fixed code instead of silently leaving the exposure in place.
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public'
        and p.proname in ('rls_auto_enable','set_updated_at')
        and p.proowner is distinct from current_user::regrole
        and (has_function_privilege('authenticated',p.oid,'EXECUTE')
          or has_function_privilege('anon',p.oid,'EXECUTE')
          or exists(select 1 from pg_proc q,
            lateral aclexplode(coalesce(q.proacl,acldefault('f',q.proowner))) a
            where q.oid=p.oid and a.grantee=0 and a.privilege_type='EXECUTE'))) then
    raise exception 'PRODUCTION_CUTOVER_PLATFORM_FUNCTION_OWNERSHIP_REQUIRED';
  end if;
end $$;

-- Backfill is intentionally inside the cutover transaction. A missing or orphan
-- lifecycle row aborts before any grant is removed.
do $$
declare
  result jsonb;
begin
  result := cap_notes_private.backfill_lifecycle();
  if coalesce((result->>'missing')::integer,-1) <> 0
     or coalesce((result->>'orphans')::integer,-1) <> 0
     or not cap_notes_private.coverage_ok() then
    raise exception 'PRODUCTION_CUTOVER_NOTES_COVERAGE_FAILED';
  end if;
end $$;

-- Force RLS where ownership could otherwise bypass row policies. Financial
-- tables keep their existing enabled RLS; their client grants are removed below.
alter table public.notes force row level security;
alter table cap_notes_private.note_lifecycle force row level security;
alter table cap_notes_private.operations force row level security;
alter table cap_sync_private.transaction_create_receipts force row level security;

-- Remove every policy that still targets a client role or PUBLIC on the
-- synchronized tables. Dedicated snapshot-reader and writer policies remain.
do $$
declare
  targets regclass[] := array['public.profiles'::regclass,
    'public.user_preferences'::regclass,'public.categories'::regclass,
    'public.accounts'::regclass,'public.goals'::regclass,'public.debts'::regclass,
    'public.bills'::regclass,'public.account_statements'::regclass,
    'public.transactions'::regclass,'public.transfers'::regclass,
    'public.bill_payments'::regclass,'public.budgets'::regclass,
    'public.notes'::regclass];
  policy_row record;
begin
  for policy_row in
    select c.oid::regclass as relation_name, p.polname
    from pg_policy p join pg_class c on c.oid=p.polrelid
    where c.oid=any(targets)
      and (0=any(p.polroles) or exists(select 1 from pg_roles r
        where r.rolname in ('authenticated','anon') and r.oid=any(p.polroles)))
  loop
    execute format('drop policy %I on %s',policy_row.polname,policy_row.relation_name);
  end loop;
end $$;

-- Remove every direct table and column privilege from clients and PUBLIC.
revoke all on table public.profiles,public.user_preferences,public.categories,
  public.accounts,public.goals,public.debts,public.bills,public.account_statements,
  public.transactions,public.transfers,public.bill_payments,public.budgets,
  public.notes from public,anon,authenticated;

do $$
declare
  targets regclass[] := array['public.profiles'::regclass,
    'public.user_preferences'::regclass,'public.categories'::regclass,
    'public.accounts'::regclass,'public.goals'::regclass,'public.debts'::regclass,
    'public.bills'::regclass,'public.account_statements'::regclass,
    'public.transactions'::regclass,'public.transfers'::regclass,
    'public.bill_payments'::regclass,'public.budgets'::regclass,
    'public.notes'::regclass];
  column_row record;
begin
  for column_row in
    select a.attrelid::regclass as relation_name, a.attname
    from pg_attribute a
    where a.attrelid=any(targets) and a.attnum>0 and not a.attisdropped
  loop
    execute format('revoke all (%I) on table %s from public,anon,authenticated',
      column_row.attname,column_row.relation_name);
  end loop;
end $$;

-- Keep both private schemas invisible and non-executable to browser roles and
-- the platform service credential.
revoke all on schema cap_notes_private,cap_sync_private
  from public,anon,authenticated;
revoke all on table cap_notes_private.note_lifecycle,cap_notes_private.operations,
  cap_sync_private.transaction_create_receipts from public,anon,authenticated;
do $$
declare
  function_row record;
begin
  for function_row in
    select p.oid::regprocedure as function_name
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('cap_notes_private','cap_sync_private')
  loop
    execute format('revoke all on function %s from public,anon,authenticated',
      function_row.function_name);
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'revoke all on schema cap_notes_private,cap_sync_private from service_role';
    execute 'revoke all on table cap_notes_private.note_lifecycle,cap_notes_private.operations, cap_sync_private.transaction_create_receipts from service_role';
    for function_row in
      select p.oid::regprocedure as function_name
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('cap_notes_private','cap_sync_private')
    loop
      execute format('revoke all on function %s from service_role',
        function_row.function_name);
    end loop;
  end if;
end $$;

-- Retire all legacy write/test endpoints, including any overloads. The exact
-- reviewed names are dropped explicitly first for an obvious audit trail.
drop function if exists public.cap_sync_note_put(uuid,jsonb,jsonb);
drop function if exists public.cap_verify_notes_rpc();
drop function if exists public.cap_verify_transaction_rpc();
drop function if exists public.cap_test_transaction_create(
  uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb);

do $$
declare
  function_row record;
begin
  for function_row in
    select p.oid as function_oid, n.nspname, p.proname,
      pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and (p.proname in ('cap_sync_note_put','cap_verify_notes_rpc',
        'cap_verify_transaction_rpc')
        or p.proname like 'cap\_test\_%')
  loop
    execute format('drop function %I.%I(%s)',function_row.nspname,
      function_row.proname,function_row.identity_arguments);
  end loop;
end $$;

-- Trigger helpers stay available to the database, not to browser clients. Only
-- the owner of such a helper can change its grants.
do $$
declare
  helper record;
begin
  for helper in
    select p.oid::regprocedure as function_name
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('rls_auto_enable','set_updated_at')
      and p.proowner=current_user::regrole
  loop
    execute format('revoke execute on function %s from public,anon,authenticated',
      helper.function_name);
  end loop;
end $$;

-- Keep the reviewed schema boundary. The six RPC grants are created by their
-- installers and verified in the postflight; this cutover deliberately does not
-- re-grant functions owned by the dedicated writer/reader roles.
revoke create on schema public from public,anon,authenticated;
grant usage on schema public to authenticated;

-- Fail the whole cutover unless the final catalog is exactly the reviewed state.
do $$
declare
  role_name text;
  targets oid[] := array['public.profiles'::regclass,
    'public.user_preferences'::regclass,'public.categories'::regclass,
    'public.accounts'::regclass,'public.goals'::regclass,'public.debts'::regclass,
    'public.bills'::regclass,'public.account_statements'::regclass,
    'public.transactions'::regclass,'public.transfers'::regclass,
    'public.bill_payments'::regclass,'public.budgets'::regclass,
    'public.notes'::regclass];
  public_tables text[] := array['public.profiles','public.user_preferences',
    'public.categories','public.accounts','public.goals','public.debts',
    'public.bills','public.account_statements','public.transactions',
    'public.transfers','public.bill_payments','public.budgets','public.notes'];
  failed text[] := '{}'::text[];
begin
  if exists(select 1 from pg_roles where rolname in ('authenticated','anon')
      and (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication)) then
    failed := array_append(failed,'client_roles');
  end if;
  foreach role_name in array array['cap_notes_sidecar_writer',
    'cap_transaction_writer','cap_sync_reader'] loop
    if not exists(select 1 from pg_roles r where r.rolname=role_name
        and not r.rolcanlogin and not r.rolinherit and not r.rolsuper
        and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole
        and not r.rolreplication) then
      failed := array_append(failed,'role:'||role_name);
    end if;
    if not public.cap_role_boundary_ok(role_name::regrole) then
      failed := array_append(failed,'membership:'||role_name);
    end if;
  end loop;

  if exists(select 1 from pg_class c where c.oid=any(targets)
      and not c.relrowsecurity) then
    failed := array_append(failed,'table_rls');
  end if;
  if not (select c.relrowsecurity and c.relforcerowsecurity
      from pg_class c where c.oid='public.notes'::regclass)
     or not (select c.relrowsecurity and c.relforcerowsecurity
       from pg_class c where c.oid='cap_notes_private.note_lifecycle'::regclass)
     or not (select c.relrowsecurity and c.relforcerowsecurity
       from pg_class c where c.oid='cap_notes_private.operations'::regclass)
     or not (select c.relrowsecurity and c.relforcerowsecurity
       from pg_class c where c.oid='cap_sync_private.transaction_create_receipts'::regclass) then
    failed := array_append(failed,'private_rls');
  end if;

  if exists(select 1 from pg_class c where c.oid=any(targets)
      and (has_table_privilege('authenticated',c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_table_privilege('anon',c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) then
    failed := array_append(failed,'direct_table_grants');
  end if;
  if exists(select 1 from pg_attribute a where a.attrelid=any(targets)
      and a.attnum>0 and not a.attisdropped
      and (has_column_privilege('authenticated',a.attrelid,a.attnum,
          'SELECT,INSERT,UPDATE,REFERENCES')
        or has_column_privilege('anon',a.attrelid,a.attnum,
          'SELECT,INSERT,UPDATE,REFERENCES'))) then
    failed := array_append(failed,'direct_column_grants');
  end if;
  if exists(select 1 from pg_class c,
      lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      where c.oid=any(targets) and acl.grantee=0) then
    failed := array_append(failed,'public_table_acl');
  end if;
  if exists(select 1 from pg_policy p where p.polrelid=any(targets)
      and (0=any(p.polroles) or exists(select 1 from pg_roles r
        where r.rolname in ('authenticated','anon') and r.oid=any(p.polroles)))) then
    failed := array_append(failed,'client_policies');
  end if;

  if has_schema_privilege('authenticated','cap_notes_private','USAGE')
     or has_schema_privilege('anon','cap_notes_private','USAGE')
     or has_schema_privilege('authenticated','cap_sync_private','USAGE')
     or has_schema_privilege('anon','cap_sync_private','USAGE') then
    failed := array_append(failed,'private_schema_client_access');
  end if;
  if has_table_privilege('authenticated','cap_notes_private.note_lifecycle',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('anon','cap_notes_private.note_lifecycle',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('authenticated','cap_notes_private.operations',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('anon','cap_notes_private.operations',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('authenticated',
        'cap_sync_private.transaction_create_receipts',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('anon',
        'cap_sync_private.transaction_create_receipts',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
    failed := array_append(failed,'private_table_client_access');
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('cap_notes_private','cap_sync_private')
        and (has_function_privilege('authenticated',p.oid,'EXECUTE')
          or has_function_privilege('anon',p.oid,'EXECUTE'))) then
    failed := array_append(failed,'private_function_client_access');
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    if has_schema_privilege('service_role','cap_notes_private','USAGE')
       or has_schema_privilege('service_role','cap_sync_private','USAGE')
       or has_table_privilege('service_role','cap_notes_private.note_lifecycle',
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_table_privilege('service_role','cap_notes_private.operations',
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_table_privilege('service_role',
         'cap_sync_private.transaction_create_receipts',
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      failed := array_append(failed,'service_role_private_access');
    end if;
  end if;

  if to_regprocedure('public.cap_sync_note_put(uuid,jsonb,jsonb)') is not null
     or to_regprocedure('public.cap_verify_notes_rpc()') is not null
     or to_regprocedure('public.cap_verify_transaction_rpc()') is not null
     or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname like 'cap\_test\_%') then
    failed := array_append(failed,'legacy_functions');
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public'
        and (has_function_privilege('authenticated',p.oid,'EXECUTE')
          or has_function_privilege('anon',p.oid,'EXECUTE'))
        and p.proname in ('rls_auto_enable','set_updated_at')) then
    failed := array_append(failed,'platform_function_execute');
  end if;

  if not cap_notes_private.coverage_ok() then
    failed := array_append(failed,'notes_coverage');
  end if;

  if not (select c.relrowsecurity and c.relforcerowsecurity
      from pg_class c
      where c.oid='cap_sync_private.transaction_create_receipts'::regclass)
     or exists(select 1 from pg_class c,
       lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
       where c.oid='cap_sync_private.transaction_create_receipts'::regclass
         and acl.grantee=0) then
    failed := array_append(failed,'transaction_receipts');
  end if;

  if not (has_table_privilege('cap_notes_sidecar_writer','public.notes','SELECT')
      and has_table_privilege('cap_notes_sidecar_writer','public.notes','INSERT')
      and has_table_privilege('cap_notes_sidecar_writer','public.notes','UPDATE'))
     or not (has_table_privilege('cap_notes_sidecar_writer',
        'cap_notes_private.note_lifecycle','SELECT')
      and has_table_privilege('cap_notes_sidecar_writer',
        'cap_notes_private.note_lifecycle','INSERT')
      and has_table_privilege('cap_notes_sidecar_writer',
        'cap_notes_private.note_lifecycle','UPDATE'))
     or not (has_table_privilege('cap_notes_sidecar_writer',
        'cap_notes_private.operations','SELECT')
      and has_table_privilege('cap_notes_sidecar_writer',
        'cap_notes_private.operations','INSERT'))
     or has_table_privilege('cap_notes_sidecar_writer','public.notes',
       'DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('cap_notes_sidecar_writer',
       'cap_notes_private.note_lifecycle','DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('cap_notes_sidecar_writer',
       'cap_notes_private.operations','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
    failed := array_append(failed,'notes_writer_grants');
  end if;
  if not has_table_privilege('cap_transaction_writer','public.transactions','INSERT')
     or not has_table_privilege('cap_transaction_writer','public.accounts','SELECT')
     or not has_column_privilege('cap_transaction_writer','public.accounts',
       'balance','UPDATE')
     or not has_table_privilege('cap_transaction_writer','public.categories','SELECT')
     or has_table_privilege('cap_transaction_writer','public.transactions',
       'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
    failed := array_append(failed,'transaction_writer_grants');
  end if;
  if exists(select 1 from unnest(public_tables) tbl
      where not has_table_privilege('cap_sync_reader',tbl,'SELECT')) then
    failed := array_append(failed,'snapshot_reader_grants');
  end if;

  -- The six reviewed RPCs must stay owned by their dedicated role, remain
  -- SECURITY DEFINER, and be executable by authenticated only. A bare CASE
  -- expression is not allowed in a PL/pgSQL IF condition, so each contract
  -- group is checked with its own explicit owner and comment.
  if exists(select 1 from pg_proc p
      where p.oid in (to_regprocedure('public.cap_notes_read(uuid)'),
        to_regprocedure('public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)'),
        to_regprocedure('public.cap_verify_notes_lifecycle()'))
        and (not p.prosecdef
          or p.proowner is distinct from
            (select oid from pg_roles where rolname='cap_notes_sidecar_writer')
          or not has_function_privilege('authenticated',p.oid,'EXECUTE')
          or has_function_privilege('anon',p.oid,'EXECUTE')
          or exists(select 1 from pg_proc q,
            lateral aclexplode(coalesce(q.proacl,acldefault('f',q.proowner))) a
            where q.oid=p.oid and a.grantee=0 and a.privilege_type='EXECUTE'))) then
    failed := array_append(failed,'rpc:notes');
  end if;
  if exists(select 1 from pg_proc p
      where p.oid=to_regprocedure('public.cap_sync_transaction_create(uuid,jsonb,jsonb)')
        and (not p.prosecdef
          or p.proowner is distinct from
            (select oid from pg_roles where rolname='cap_transaction_writer')
          or not has_function_privilege('authenticated',p.oid,'EXECUTE')
          or has_function_privilege('anon',p.oid,'EXECUTE')
          or exists(select 1 from pg_proc q,
            lateral aclexplode(coalesce(q.proacl,acldefault('f',q.proowner))) a
            where q.oid=p.oid and a.grantee=0 and a.privilege_type='EXECUTE'))) then
    failed := array_append(failed,'rpc:transaction');
  end if;
  if exists(select 1 from pg_proc p
      where p.oid in (to_regprocedure('public.cap_sync_snapshot_v1()'),
        to_regprocedure('public.cap_verify_production_sync_v1()'))
        and (not p.prosecdef
          or p.proowner is distinct from
            (select oid from pg_roles where rolname='cap_sync_reader')
          or not has_function_privilege('authenticated',p.oid,'EXECUTE')
          or has_function_privilege('anon',p.oid,'EXECUTE')
          or exists(select 1 from pg_proc q,
            lateral aclexplode(coalesce(q.proacl,acldefault('f',q.proowner))) a
            where q.oid=p.oid and a.grantee=0 and a.privilege_type='EXECUTE'))) then
    failed := array_append(failed,'rpc:snapshot');
  end if;
  if (select obj_description(to_regprocedure('public.cap_notes_read(uuid)'),'pg_proc')
        is distinct from 'CAP_NOTES_SIDECAR_V1')
     or (select obj_description(
        to_regprocedure('public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)'),'pg_proc')
        is distinct from 'CAP_NOTES_SIDECAR_V1')
     or (select obj_description(to_regprocedure('public.cap_verify_notes_lifecycle()'),'pg_proc')
        is distinct from 'CAP_NOTES_SIDECAR_V1')
     or (select obj_description(
        to_regprocedure('public.cap_sync_transaction_create(uuid,jsonb,jsonb)'),'pg_proc')
        is distinct from 'CAP_TX_CREATE_CAS_RECEIPT_V1')
     or (select obj_description(to_regprocedure('public.cap_sync_snapshot_v1()'),'pg_proc')
        is distinct from 'CAP_SYNC_SNAPSHOT_V1')
     or (select obj_description(
        to_regprocedure('public.cap_verify_production_sync_v1()'),'pg_proc')
        is distinct from 'CAP_PRODUCTION_SYNC_READINESS_V1') then
    failed := array_append(failed,'rpc_comments');
  end if;

  if not public.cap_request_identity_ok() then
    failed := array_append(failed,'request_identity');
  end if;
  if exists(select 1 from pg_proc p where p.oid in (
      to_regprocedure('public.cap_notes_read(uuid)'),
      to_regprocedure('public.cap_verify_notes_lifecycle()'),
      to_regprocedure('public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)'),
      to_regprocedure('public.cap_sync_transaction_create(uuid,jsonb,jsonb)'),
      to_regprocedure('public.cap_sync_snapshot_v1()'),
      to_regprocedure('public.cap_verify_production_sync_v1()'))
      and p.prosrc like '%auth.uid%') then
    failed := array_append(failed,'managed_auth_dependency');
  end if;
  if cardinality(failed) > 0 then
    raise exception 'PRODUCTION_CUTOVER_POSTFLIGHT_FAILED: %',array_to_string(failed,',');
  end if;
end $$;

commit;
