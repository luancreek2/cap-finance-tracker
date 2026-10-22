-- Cap Phase 6L: READ-ONLY transaction-create post-install audit.
--
-- This file opens a read-only transaction and reads PostgreSQL catalogs,
-- privilege functions and object metadata only. It does not call
-- cap_sync_transaction_create(), read/write application rows, create/alter/drop
-- objects, change grants/policies/roles, or touch Cloud Sync.
--
-- Run in a reviewed Supabase SQL Editor session after the guarded
-- supabase_production_transaction_create.sql installation. The expected
-- pre-cutover result is transaction_installation_ready:true while
-- snapshot_installer_absent:true and legacy_precutover_state:true.
--
-- A false core check is drift. Do not "repair" it with ad-hoc DDL; re-review the
-- installer and the exact failing detail first.

begin transaction read only;

with
writer as (
  select r.oid, r.rolname, r.rolcanlogin, r.rolinherit, r.rolsuper,
         r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication
  from pg_roles r
  where r.rolname = 'cap_transaction_writer'
),
tx as (
  select p.oid, p.proname, p.proowner, p.prosecdef, p.provolatile, p.prokind,
         p.pronargs, p.prorettype, p.proargtypes, p.proconfig, p.proacl,
         p.prosrc, l.lanname
  from pg_proc p
  join pg_language l on l.oid = p.prolang
  where p.oid = to_regprocedure('public.cap_sync_transaction_create(uuid,jsonb,jsonb)')
),
receipt as (
  select c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  from pg_class c
  where c.oid = to_regclass('cap_sync_private.transaction_create_receipts')
),
role_state as (
  select w.*,
         not exists (select 1 from pg_auth_members m where m.member = w.oid)
           as no_outgoing_memberships,
         not exists (
           select 1
           from pg_auth_members m
           join pg_roles client on client.oid = m.member
           where m.roleid = w.oid
             and client.rolname in ('authenticated', 'anon', 'service_role')
         ) as no_client_incoming_memberships
  from writer w
),
fn_state as (
  select t.*,
         pg_get_userbyid(t.proowner) as owner_name,
         oidvectortypes(t.proargtypes) as arg_types,
         obj_description(t.oid, 'pg_proc') as comment,
         (select count(*)
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname = 'cap_sync_transaction_create') as overload_count,
         has_function_privilege('authenticated', t.oid, 'EXECUTE') as auth_exec,
         has_function_privilege('anon', t.oid, 'EXECUTE') as anon_exec,
         case when exists (select 1 from pg_roles where rolname = 'service_role')
              then has_function_privilege('service_role', t.oid, 'EXECUTE')
              else false end as service_exec,
         exists (
           select 1
           from aclexplode(coalesce(t.proacl, acldefault('f', t.proowner))) a
           where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         ) as public_exec,
         exists (
           select 1 from unnest(coalesce(t.proconfig, array[]::text[])) c
           where lower(replace(c, ' ', '')) = 'search_path=pg_catalog'
         ) as search_path_ok,
         exists (
           select 1 from unnest(coalesce(t.proconfig, array[]::text[])) c
           where lower(replace(c, ' ', '')) = 'timezone=utc'
         ) as timezone_ok,
         exists (
           select 1 from unnest(coalesce(t.proconfig, array[]::text[])) c
           where lower(replace(c, ' ', '')) = 'datestyle=iso,ymd'
         ) as datestyle_ok,
         not coalesce(t.prosrc like '%auth.uid%', false) as no_auth_uid
  from tx t
),
receipt_state as (
  select r.*,
         (select array_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod)
                           order by a.attnum)
          from pg_attribute a
          where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped) as columns,
         (select array_agg(a.attname::text order by a.attnum)
          from pg_attribute a
          where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
            and a.attnotnull) as not_null_columns,
         (select array_agg(a.attname::text order by k.ord)
          from pg_constraint c
          cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
          where c.conrelid = r.oid and c.contype = 'p') as pk_columns,
         (select count(*) from pg_constraint c
          where c.conrelid = r.oid and c.contype = 'f') as fk_count,
         (select count(*) from pg_constraint c
          where c.conrelid = r.oid and c.contype = 'f' and c.confdeltype = 'r')
           as fk_restrict_count,
         (select count(*) from pg_constraint c
          where c.conrelid = r.oid and c.contype = 'c') as check_count,
         (select count(*)
          from pg_index i
          join pg_class idx on idx.oid = i.indexrelid
          where i.indrelid = r.oid and i.indisunique and i.indpred is not null
            and idx.relname in (
              'transaction_create_one_applied_receipt',
              'transaction_create_one_applied_legacy'
            )) as unique_index_count,
         not exists (select 1 from pg_trigger tg
                     where tg.tgrelid = r.oid and not tg.tgisinternal) as no_triggers,
         r.relowner is distinct from (select oid from writer) as owner_not_writer
  from receipt r
),
writer_privs as (
  select w.oid,
         has_schema_privilege(w.oid, 'cap_sync_private', 'USAGE') as private_usage,
         not has_schema_privilege(w.oid, 'cap_sync_private', 'CREATE') as private_no_create,
         not has_schema_privilege(w.oid, 'public', 'CREATE') as public_no_create,
         not has_schema_privilege(w.oid, 'auth', 'USAGE') as no_auth_usage,
         has_function_privilege(w.oid, 'public.cap_request_uid()', 'EXECUTE') as has_request_uid,
         has_function_privilege(w.oid, 'public.cap_request_identity_ok()', 'EXECUTE') as has_identity_ok,
         has_function_privilege(w.oid, 'public.cap_role_boundary_ok(oid)', 'EXECUTE') as has_role_boundary_ok,
         has_table_privilege(w.oid, 'public.accounts', 'SELECT') as accounts_select,
         not has_table_privilege(w.oid, 'public.accounts',
           'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER') as accounts_no_forbidden,
         (select array_agg(a.attname::text order by a.attname)
          from pg_attribute a
          where a.attrelid = 'public.accounts'::regclass
            and a.attnum > 0 and not a.attisdropped
            and has_column_privilege(w.oid, a.attrelid, a.attnum, 'UPDATE'))
           as account_update_columns,
         not exists (
           select 1 from pg_attribute a
           where a.attrelid = 'public.accounts'::regclass
             and a.attnum > 0 and not a.attisdropped
             and (has_column_privilege(w.oid, a.attrelid, a.attnum, 'INSERT')
               or has_column_privilege(w.oid, a.attrelid, a.attnum, 'REFERENCES'))
         ) as accounts_no_column_insert_refs,
         has_table_privilege(w.oid, 'public.categories', 'SELECT') as categories_select,
         not has_table_privilege(w.oid, 'public.categories',
           'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as categories_no_forbidden,
         not exists (
           select 1 from pg_attribute a
           where a.attrelid = 'public.categories'::regclass
             and a.attnum > 0 and not a.attisdropped
             and (has_column_privilege(w.oid, a.attrelid, a.attnum, 'INSERT')
               or has_column_privilege(w.oid, a.attrelid, a.attnum, 'UPDATE')
               or has_column_privilege(w.oid, a.attrelid, a.attnum, 'REFERENCES'))
         ) as categories_no_column_writes,
         has_table_privilege(w.oid, 'public.transactions', 'SELECT') as transactions_select,
         has_table_privilege(w.oid, 'public.transactions', 'INSERT') as transactions_insert,
         not has_table_privilege(w.oid, 'public.transactions',
           'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as transactions_no_forbidden,
         not exists (
           select 1 from pg_attribute a
           where a.attrelid = 'public.transactions'::regclass
             and a.attnum > 0 and not a.attisdropped
             and (has_column_privilege(w.oid, a.attrelid, a.attnum, 'UPDATE')
               or has_column_privilege(w.oid, a.attrelid, a.attnum, 'REFERENCES'))
         ) as transactions_no_column_writes,
         not exists (
           select 1 from pg_class c
           where c.oid in ('public.accounts'::regclass, 'public.categories'::regclass,
                           'public.transactions'::regclass, (select oid from receipt))
             and c.relowner = w.oid
         ) as no_table_ownership,
         not exists (
           select 1 from pg_namespace n
           where n.nspname = 'cap_sync_private' and n.nspowner = w.oid
         ) as no_schema_ownership
  from writer w
),
receipt_grants as (
  select r.oid as receipt_oid, w.oid as writer_oid,
         has_table_privilege(w.oid, r.oid, 'SELECT') as writer_select,
         has_table_privilege(w.oid, r.oid, 'INSERT') as writer_insert,
         not has_table_privilege(w.oid, r.oid,
           'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as writer_no_mutation,
         not has_any_column_privilege(w.oid, r.oid, 'UPDATE,REFERENCES')
           as writer_no_column_mutation,
         not has_table_privilege('authenticated', r.oid,
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as auth_no_access,
         not has_any_column_privilege('authenticated', r.oid,
           'SELECT,INSERT,UPDATE,REFERENCES') as auth_no_column_access,
         not has_table_privilege('anon', r.oid,
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_no_access,
         not has_any_column_privilege('anon', r.oid,
           'SELECT,INSERT,UPDATE,REFERENCES') as anon_no_column_access,
         (not exists (select 1 from pg_roles where rolname = 'service_role')
          or (not has_table_privilege('service_role', r.oid,
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              and not has_any_column_privilege('service_role', r.oid,
                'SELECT,INSERT,UPDATE,REFERENCES'))) as service_no_access,
         not exists (
           select 1
           from aclexplode(coalesce(r.relacl, acldefault('r', r.relowner))) a
           where a.grantee = 0
         ) as no_public_acl,
         not has_schema_privilege('authenticated', 'cap_sync_private', 'USAGE') as auth_no_schema,
         not has_schema_privilege('anon', 'cap_sync_private', 'USAGE') as anon_no_schema,
         (not exists (select 1 from pg_roles where rolname = 'service_role')
          or not has_schema_privilege('service_role', 'cap_sync_private', 'USAGE'))
           as service_no_schema,
         not exists (
           select 1
           from pg_namespace n,
                lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
           where n.nspname = 'cap_sync_private' and a.grantee = 0
         ) as no_public_schema_acl
  from receipt r
  cross join writer w
),
policy_state as (
  select c.relname, p.polname, p.polcmd, p.polpermissive, p.polroles,
         pg_get_expr(p.polqual, p.polrelid) as qual,
         pg_get_expr(p.polwithcheck, p.polrelid) as with_check
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join writer w on w.oid = any(p.polroles)
  where p.polrelid = any(array[
    'public.accounts'::regclass,
    'public.categories'::regclass,
    'public.transactions'::regclass,
    (select oid from receipt)
  ])
),
policy_agg as (
  select count(*)::int as policy_count,
         array_agg(p.polname || ':' || p.polcmd::text order by p.polname) as policy_signature,
         bool_and(p.polpermissive) as all_permissive,
         bool_and(p.polroles = array[(select oid from writer)]) as exact_roles,
         bool_and(
           coalesce(p.qual, '') not like '%auth.uid%'
           and coalesce(p.with_check, '') not like '%auth.uid%'
         ) as no_auth_uid,
         bool_and(
           (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''))
             like '%cap_request_uid%'
         ) as uses_cap_uid
  from policy_state p
),
legacy_state as (
  select
    to_regprocedure('public.cap_test_transaction_create(uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb)') is not null
      as legacy_test_tx_present,
    case when to_regprocedure('public.cap_test_transaction_create(uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb)') is not null
         then has_function_privilege('authenticated',
           to_regprocedure('public.cap_test_transaction_create(uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb)'),
           'EXECUTE') else null end as legacy_test_tx_auth_exec,
    to_regprocedure('public.cap_verify_transaction_rpc()') is not null
      as legacy_verify_present,
    case when to_regprocedure('public.cap_verify_transaction_rpc()') is not null
         then has_function_privilege('authenticated',
           'public.cap_verify_transaction_rpc()', 'EXECUTE') else null end
      as legacy_verify_auth_exec,
    to_regprocedure('public.cap_sync_note_put(uuid,jsonb,jsonb)') is not null
      as legacy_note_put_present,
    to_regprocedure('public.cap_verify_notes_rpc()') is not null
      as legacy_note_verify_present,
    has_table_privilege('authenticated', 'public.notes',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as notes_auth_any_access
),
snapshot_state as (
  select
    not exists (select 1 from pg_roles where rolname = 'cap_sync_reader') as reader_absent,
    to_regprocedure('public.cap_sync_snapshot_v1()') is null as snapshot_rpc_absent,
    to_regprocedure('public.cap_verify_production_sync_v1()') is null as readiness_rpc_absent
)
select jsonb_pretty(jsonb_build_object(
  'audit_version', 'CAP_TX_CREATE_POSTINSTALL_AUDIT_V1',
  'read_only', true,
  'checks', jsonb_build_object(
    'request_identity_ok', coalesce(public.cap_request_identity_ok(), false),
    'role_boundary_ok', coalesce(public.cap_role_boundary_ok((select oid from writer)), false),
    'writer_role_ok', coalesce((
      select not rolcanlogin and not rolinherit and not rolsuper
             and not rolbypassrls and not rolcreatedb and not rolcreaterole
             and not rolreplication
             and no_outgoing_memberships and no_client_incoming_memberships
      from role_state
    ), false),
    'rpc_metadata_ok', coalesce((
      select overload_count = 1
             and prokind = 'f'
             and lanname = 'plpgsql'
             and prosecdef
             and provolatile = 'v'
             and prorettype = 'jsonb'::regtype
             and pronargs = 3
             and arg_types = 'uuid, jsonb, jsonb'
             and owner_name = 'cap_transaction_writer'
             and comment = 'CAP_TX_CREATE_CAS_RECEIPT_V1'
             and search_path_ok and timezone_ok and datestyle_ok
             and no_auth_uid
      from fn_state
    ), false),
    'rpc_grants_ok', coalesce((
      select auth_exec and not anon_exec and not service_exec and not public_exec
      from fn_state
    ), false),
    'receipt_table_ok', coalesce((
      select columns = array[
               'user_id:uuid', 'operation_id:uuid', 'transaction_id:uuid',
               'account_id:uuid', 'request:jsonb', 'outcome:text',
               'applied_transaction_id:uuid', 'result:jsonb',
               'recorded_at:timestamp with time zone'
             ]
             and not_null_columns = array[
               'user_id', 'operation_id', 'transaction_id', 'account_id',
               'request', 'outcome', 'result', 'recorded_at'
             ]
             and pk_columns is not distinct from array['user_id', 'operation_id']
             and fk_count = 3
             and fk_restrict_count = 3
             and check_count = 2
             and unique_index_count = 2
             and relrowsecurity
             and relforcerowsecurity
             and no_triggers
             and owner_not_writer
      from receipt_state
    ), false),
    'receipt_grants_ok', coalesce((
      select writer_select and writer_insert and writer_no_mutation
             and writer_no_column_mutation
             and auth_no_access and auth_no_column_access
             and anon_no_access and anon_no_column_access
             and service_no_access
             and no_public_acl and auth_no_schema and anon_no_schema
             and service_no_schema and no_public_schema_acl
      from receipt_grants
    ), false),
    'writer_privileges_ok', coalesce((
      select private_usage and private_no_create and public_no_create
             and no_auth_usage
             and has_request_uid and has_identity_ok and has_role_boundary_ok
             and accounts_select and accounts_no_forbidden
             and account_update_columns = array['balance']
             and accounts_no_column_insert_refs
             and categories_select and categories_no_forbidden
             and categories_no_column_writes
             and transactions_select and transactions_insert
             and transactions_no_forbidden and transactions_no_column_writes
             and no_table_ownership and no_schema_ownership
      from writer_privs
    ), false),
    'writer_policies_ok', coalesce((
      select policy_count = 7
             and policy_signature = array[
               'transaction_receipt_insert:a',
               'transaction_receipt_read:r',
               'transaction_writer_account_read:r',
               'transaction_writer_account_update:w',
               'transaction_writer_category_read:r',
               'transaction_writer_transaction_insert:a',
               'transaction_writer_transaction_read:r'
             ]
             and all_permissive and exact_roles and no_auth_uid and uses_cap_uid
      from policy_agg
    ), false),
    'snapshot_installer_absent', coalesce((
      select reader_absent and snapshot_rpc_absent and readiness_rpc_absent
      from snapshot_state
    ), false),
    'legacy_precutover_state', coalesce((
      select legacy_test_tx_present and legacy_verify_present
             and legacy_note_put_present and legacy_note_verify_present
             and notes_auth_any_access
      from legacy_state
    ), false),
    'transaction_installation_ready', (
      coalesce(public.cap_request_identity_ok(), false)
      and coalesce(public.cap_role_boundary_ok((select oid from writer)), false)
      and coalesce((select not rolcanlogin and not rolinherit and not rolsuper
                           and not rolbypassrls and not rolcreatedb and not rolcreaterole
                           and not rolreplication
                           and no_outgoing_memberships and no_client_incoming_memberships
                    from role_state), false)
      and coalesce((select overload_count = 1 and prokind = 'f' and lanname = 'plpgsql'
                           and prosecdef and provolatile = 'v'
                           and prorettype = 'jsonb'::regtype and pronargs = 3
                           and arg_types = 'uuid, jsonb, jsonb'
                           and owner_name = 'cap_transaction_writer'
                           and comment = 'CAP_TX_CREATE_CAS_RECEIPT_V1'
                           and search_path_ok and timezone_ok and datestyle_ok
                           and no_auth_uid
                    from fn_state), false)
      and coalesce((select auth_exec and not anon_exec and not service_exec and not public_exec
                    from fn_state), false)
      and coalesce((select columns = array[
                           'user_id:uuid', 'operation_id:uuid', 'transaction_id:uuid',
                           'account_id:uuid', 'request:jsonb', 'outcome:text',
                           'applied_transaction_id:uuid', 'result:jsonb',
                           'recorded_at:timestamp with time zone'
                         ]
                         and not_null_columns = array[
                           'user_id', 'operation_id', 'transaction_id', 'account_id',
                           'request', 'outcome', 'result', 'recorded_at'
                         ]
                         and pk_columns is not distinct from array['user_id', 'operation_id']
                         and fk_count = 3 and fk_restrict_count = 3
                         and check_count = 2 and unique_index_count = 2
                         and relrowsecurity and relforcerowsecurity and no_triggers
                         and owner_not_writer
                    from receipt_state), false)
      and coalesce((select writer_select and writer_insert and writer_no_mutation
                           and writer_no_column_mutation
                           and auth_no_access and auth_no_column_access
                           and anon_no_access and anon_no_column_access
                           and service_no_access
                           and no_public_acl and auth_no_schema and anon_no_schema
                           and service_no_schema and no_public_schema_acl
                    from receipt_grants), false)
      and coalesce((select private_usage and private_no_create and public_no_create
                           and no_auth_usage
                           and has_request_uid and has_identity_ok and has_role_boundary_ok
                           and accounts_select and accounts_no_forbidden
                           and account_update_columns = array['balance']
                           and accounts_no_column_insert_refs
                           and categories_select and categories_no_forbidden
                           and categories_no_column_writes
                           and transactions_select and transactions_insert
                           and transactions_no_forbidden and transactions_no_column_writes
                           and no_table_ownership and no_schema_ownership
                    from writer_privs), false)
      and coalesce((select policy_count = 7
                           and policy_signature = array[
                             'transaction_receipt_insert:a',
                             'transaction_receipt_read:r',
                             'transaction_writer_account_read:r',
                             'transaction_writer_account_update:w',
                             'transaction_writer_category_read:r',
                             'transaction_writer_transaction_insert:a',
                             'transaction_writer_transaction_read:r'
                           ]
                           and all_permissive and exact_roles and no_auth_uid and uses_cap_uid
                    from policy_agg), false)
    )
  ),
  'details', jsonb_build_object(
    'writer_role', (select to_jsonb(rs) from role_state rs),
    'writer_memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'role', role.rolname,
        'member', member.rolname,
        'admin_option', m.admin_option,
        'inherit_option', m.inherit_option,
        'set_option', m.set_option
      ) order by role.rolname, member.rolname)
      from pg_auth_members m
      join pg_roles role on role.oid = m.roleid
      join pg_roles member on member.oid = m.member
      where m.roleid = (select oid from writer)
         or m.member = (select oid from writer)
    ), '[]'::jsonb),
    'rpc', (select jsonb_build_object(
      'signature', oid::regprocedure,
      'owner', owner_name,
      'language', lanname,
      'kind', prokind,
      'argument_types', arg_types,
      'returns', prorettype::regtype,
      'volatility', provolatile,
      'security_definer', prosecdef,
      'config', proconfig,
      'version_comment', comment,
      'acl', proacl::text,
      'authenticated_execute', auth_exec,
      'anon_execute', anon_exec,
      'service_role_execute', service_exec,
      'public_execute_acl', public_exec
    ) from fn_state),
    'receipt_table', (select jsonb_build_object(
      'columns', columns,
      'not_null_columns', not_null_columns,
      'primary_key_columns', pk_columns,
      'foreign_key_count', fk_count,
      'foreign_key_restrict_count', fk_restrict_count,
      'check_constraint_count', check_count,
      'partial_unique_index_count', unique_index_count,
      'rls_enabled', relrowsecurity,
      'rls_forced', relforcerowsecurity,
      'non_internal_triggers_absent', no_triggers,
      'owner_is_not_writer', owner_not_writer,
      'acl', relacl::text
    ) from receipt_state),
    'receipt_grants', (select to_jsonb(rg) from receipt_grants rg),
    'receipt_constraints', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', c.conname,
        'type', c.contype,
        'definition', pg_get_constraintdef(c.oid)
      ) order by c.conname)
      from pg_constraint c
      where c.conrelid = (select oid from receipt)
    ), '[]'::jsonb),
    'receipt_indexes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', idx.relname,
        'definition', pg_get_indexdef(i.indexrelid)
      ) order by idx.relname)
      from pg_index i
      join pg_class idx on idx.oid = i.indexrelid
      where i.indrelid = (select oid from receipt)
    ), '[]'::jsonb),
    'writer_privileges', (select to_jsonb(wp) from writer_privs wp),
    'writer_policies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'relation', ps.relname,
        'policy', ps.polname,
        'command', ps.polcmd,
        'permissive', ps.polpermissive,
        'roles', ps.polroles,
        'using', ps.qual,
        'with_check', ps.with_check
      ) order by ps.relname, ps.polname)
      from policy_state ps
    ), '[]'::jsonb),
    'legacy', (select to_jsonb(ls) from legacy_state ls),
    'snapshot', (select to_jsonb(ss) from snapshot_state ss)
  )
));

commit;
