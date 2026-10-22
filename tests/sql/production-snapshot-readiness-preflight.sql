-- Cap Phase 6L: READ-ONLY pre-install audit for snapshot/readiness.
--
-- Opens a read-only transaction, reads catalogs/privilege functions only, and
-- does not call a mutation RPC, read application rows, or change any object.
--
-- Run this before the guarded supabase_production_snapshot_readiness.sql
-- installation. The expected result is preinstall_ready:true with all target
-- objects absent.

begin transaction read only;

with
public_tables(name) as (
  values
    ('public.profiles'), ('public.user_preferences'), ('public.categories'),
    ('public.accounts'), ('public.goals'), ('public.debts'), ('public.bills'),
    ('public.account_statements'), ('public.transactions'), ('public.transfers'),
    ('public.bill_payments'), ('public.budgets'), ('public.notes')
),
table_state as (
  select t.name,
         to_regclass(t.name) is not null as present,
         coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass(t.name)), false) as rls_enabled
  from public_tables t
),
notes_columns as (
  select
    (select count(*) from information_schema.columns
     where table_schema = 'cap_notes_private' and table_name = 'note_lifecycle'
       and column_name in ('note_id','user_id','revision','deleted_at','operation_id')) as lifecycle_columns,
    (select count(*) from information_schema.columns
     where table_schema = 'cap_notes_private' and table_name = 'operations'
       and column_name in ('user_id','operation_id','note_id','action','expected','desired','result')) as operation_columns
),
target_state as (
  select
    exists(select 1 from pg_roles where rolname = 'cap_sync_reader') as reader_present,
    to_regprocedure('public.cap_sync_snapshot_v1()') is not null as snapshot_rpc_present,
    to_regprocedure('public.cap_verify_production_sync_v1()') is not null as readiness_rpc_present
),
checks as (
  select
    case when to_regprocedure('public.cap_request_identity_ok()') is null then false
         else public.cap_request_identity_ok() end as request_identity_ok,
    case when to_regprocedure('public.cap_role_boundary_ok(oid)') is null then false
         else coalesce(public.cap_role_boundary_ok(to_regrole('cap_notes_sidecar_writer')), false) end as notes_role_boundary_ok,
    case when to_regprocedure('public.cap_role_boundary_ok(oid)') is null then false
         else coalesce(public.cap_role_boundary_ok(to_regrole('cap_transaction_writer')), false) end as transaction_role_boundary_ok,
    (to_regclass('cap_notes_private.note_lifecycle') is not null
     and to_regclass('cap_notes_private.operations') is not null
     and to_regprocedure('public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)') is not null
     and to_regprocedure('public.cap_notes_read(uuid)') is not null
     and to_regprocedure('public.cap_verify_notes_lifecycle()') is not null
     and (select lifecycle_columns = 5 and operation_columns = 7 from notes_columns)) as notes_sidecar_dependencies_ok,
    (coalesce((select c.relforcerowsecurity from pg_class c where c.oid = to_regclass('public.notes')), false)
     and coalesce((select c.relforcerowsecurity from pg_class c where c.oid = to_regclass('cap_notes_private.note_lifecycle')), false)
     and coalesce((select c.relforcerowsecurity from pg_class c where c.oid = to_regclass('cap_notes_private.operations')), false)
     and coalesce((select c.relforcerowsecurity from pg_class c where c.oid = to_regclass('cap_sync_private.transaction_create_receipts')), false)) as private_rls_forced_ok,
    (to_regclass('cap_sync_private.transaction_create_receipts') is not null
     and to_regprocedure('public.cap_sync_transaction_create(uuid,jsonb,jsonb)') is not null) as transaction_dependencies_ok,
    (not exists (select 1 from table_state where not present)
     and not exists (select 1 from table_state where not rls_enabled)) as synchronized_tables_ok,
    not (select reader_present from target_state) as reader_target_absent,
    not (select snapshot_rpc_present from target_state) as snapshot_rpc_target_absent,
    not (select readiness_rpc_present from target_state) as readiness_rpc_target_absent
)
select jsonb_pretty(jsonb_build_object(
  'audit_version', 'CAP_SNAPSHOT_PREINSTALL_AUDIT_V1',
  'read_only', true,
  'checks', jsonb_build_object(
    'request_identity_ok', c.request_identity_ok,
    'notes_role_boundary_ok', c.notes_role_boundary_ok,
    'transaction_role_boundary_ok', c.transaction_role_boundary_ok,
    'notes_sidecar_dependencies_ok', c.notes_sidecar_dependencies_ok,
    'private_rls_forced_ok', c.private_rls_forced_ok,
    'transaction_dependencies_ok', c.transaction_dependencies_ok,
    'synchronized_tables_ok', c.synchronized_tables_ok,
    'reader_target_absent', c.reader_target_absent,
    'snapshot_rpc_target_absent', c.snapshot_rpc_target_absent,
    'readiness_rpc_target_absent', c.readiness_rpc_target_absent,
    'preinstall_ready', (
      c.request_identity_ok and c.notes_role_boundary_ok and c.transaction_role_boundary_ok
      and c.notes_sidecar_dependencies_ok and c.private_rls_forced_ok
      and c.transaction_dependencies_ok and c.synchronized_tables_ok
      and c.reader_target_absent and c.snapshot_rpc_target_absent
      and c.readiness_rpc_target_absent
    )
  ),
  'details', jsonb_build_object(
    'missing_or_rls_disabled_tables', coalesce((
      select jsonb_agg(jsonb_build_object('table', name, 'present', present, 'rls_enabled', rls_enabled)
                       order by name)
      from table_state where not present or not rls_enabled
    ), '[]'::jsonb),
    'notes_columns', (select to_jsonb(nc) from notes_columns nc),
    'targets', (select to_jsonb(ts) from target_state ts)
  )
))
from checks c;

rollback;
