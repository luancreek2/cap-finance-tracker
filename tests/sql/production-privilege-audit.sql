-- Cap production privilege/role/endpoint audit.
--
-- READ-ONLY: this file opens a read-only transaction, reads PostgreSQL
-- catalogs only, and never selects application rows or note content. It does
-- not create, alter, grant, revoke, call an RPC, or write anything.
--
-- Run manually in a reviewed Supabase SQL editor session only after explicit
-- authorization. A local result is not proof of production readiness: PostgREST
-- exposure, JWT/auth hooks, service-role key custody, dashboard settings,
-- inherited/default privileges, and runtime behaviour remain external checks.
--
-- The audit is expected to report blockers against today's deployed notes
-- pilot. Do not treat a partial pass as permission to enable deletion or sync.

begin transaction read only;

with
cap_tables(name) as (
  values ('profiles'), ('user_preferences'), ('categories'), ('accounts'),
         ('goals'), ('debts'), ('bills'), ('account_statements'),
         ('transactions'), ('transfers'), ('bill_payments'), ('budgets'),
         ('notes')
),
cap_expected_functions(name, args) as (
  values
    ('cap_sync_note_put', 'uuid, jsonb, jsonb'),
    ('cap_verify_notes_rpc', ''),
    ('cap_test_transaction_create', 'uuid, text, uuid, uuid, uuid, numeric, date, date, text, text, text, jsonb'),
    ('cap_verify_transaction_rpc', '')
),
notes_rel as (
  select c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity,
         pg_get_userbyid(c.relowner) as owner_name, c.relacl
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'notes' and c.relkind = 'r'
),
notes_columns as (
  select column_name, data_type, is_nullable, column_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'notes'
),
notes_direct_acl as (
  select coalesce(r.rolname, 'PUBLIC') as grantee,
         bool_or(a.privilege_type = 'SELECT') as can_select,
         bool_or(a.privilege_type = 'INSERT') as can_insert,
         bool_or(a.privilege_type = 'UPDATE') as can_update,
         bool_or(a.privilege_type = 'DELETE') as can_delete,
         bool_or(a.privilege_type = 'TRUNCATE') as can_truncate,
         bool_or(a.privilege_type = 'REFERENCES') as can_references,
         bool_or(a.privilege_type = 'TRIGGER') as can_trigger
  from notes_rel c
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  left join pg_roles r on r.oid = a.grantee
  group by coalesce(r.rolname, 'PUBLIC')
),
notes_effective as (
  select role_name,
         case when to_regclass('public.notes') is null then false
              else has_table_privilege(role_name, 'public.notes', 'SELECT') end as can_select,
         case when to_regclass('public.notes') is null then false
              else has_table_privilege(role_name, 'public.notes', 'INSERT') end as can_insert,
         case when to_regclass('public.notes') is null then false
              else has_table_privilege(role_name, 'public.notes', 'UPDATE') end as can_update,
         case when to_regclass('public.notes') is null then false
              else has_table_privilege(role_name, 'public.notes', 'DELETE') end as can_delete,
         case when to_regclass('public.notes') is null then false
              else has_table_privilege(role_name, 'public.notes', 'TRUNCATE') end as can_truncate,
         case when to_regclass('public.notes') is null then false
              else has_table_privilege(role_name, 'public.notes', 'REFERENCES') end as can_references,
         case when to_regclass('public.notes') is null then false
              else has_table_privilege(role_name, 'public.notes', 'TRIGGER') end as can_trigger
  from (values ('anon'), ('authenticated'), ('service_role')) v(role_name)
),
notes_column_grants as (
  select a.attname as column_name,
         coalesce(r.rolname, 'PUBLIC') as grantee,
         x.privilege_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(a.attacl) x
  left join pg_roles r on r.oid = x.grantee
  where n.nspname = 'public' and c.relname = 'notes'
    and a.attnum > 0 and not a.attisdropped and a.attacl is not null
),
notes_policies as (
  select policyname, permissive, roles::text[] as roles, cmd, qual, with_check
  from pg_policies
  where schemaname = 'public' and tablename = 'notes'
),
notes_triggers as (
  select t.tgname, not t.tgisinternal as user_trigger,
         pg_get_triggerdef(t.oid) as definition
  from pg_trigger t
  where t.tgrelid = coalesce((select oid from notes_rel), 0)
    and not t.tgisinternal
),
cap_table_state as (
  select c.relname,
         pg_get_userbyid(c.relowner) as owner_name,
         c.relrowsecurity,
         c.relforcerowsecurity,
         case when has_table_privilege('authenticated', c.oid, 'SELECT') then true else false end as auth_select,
         case when has_table_privilege('authenticated', c.oid, 'INSERT') then true else false end as auth_insert,
         case when has_table_privilege('authenticated', c.oid, 'UPDATE') then true else false end as auth_update,
         case when has_table_privilege('authenticated', c.oid, 'DELETE') then true else false end as auth_delete,
         case when has_table_privilege('anon', c.oid, 'SELECT') then true else false end as anon_select,
         case when has_table_privilege('anon', c.oid, 'INSERT') then true else false end as anon_insert,
         case when has_table_privilege('anon', c.oid, 'UPDATE') then true else false end as anon_update,
         case when has_table_privilege('anon', c.oid, 'DELETE') then true else false end as anon_delete
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in (select name from cap_tables)
),
function_info as (
  select p.oid,
         n.nspname,
         p.proname,
         pg_get_function_identity_arguments(p.oid) as identity_args,
         pg_catalog.oidvectortypes(p.proargtypes) as arg_types,
         p.prosecdef,
         p.provolatile,
         p.prokind,
         pg_get_userbyid(p.proowner) as owner_name,
         p.proacl,
         p.proconfig,
         coalesce(obj_description(p.oid, 'pg_proc'), '') as comment,
         case when has_function_privilege('anon', p.oid, 'EXECUTE') then true else false end as anon_exec,
         case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then true else false end as auth_exec,
         exists (
           select 1
           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         ) as public_exec,
         exists (
           select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
           where cfg like 'search_path=%'
         ) as fixed_search_path
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),
expected_functions as (
  select e.name, e.args, p.oid as resolved_oid
  from cap_expected_functions e
  left join pg_proc p
    on p.oid = to_regprocedure('public.' || e.name || '(' || e.args || ')')
),
role_rows as (
  select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
         rolcanlogin, rolinherit
  from pg_roles
  where rolname in ('anon', 'authenticated', 'service_role', 'authenticator',
                    'postgres', 'supabase_admin', 'supabase_auth_admin',
                    'supabase_storage_admin', 'dashboard_user', 'pgbouncer')
     or rolname like 'cap\_%' escape '\'
),
privileged_role_rows as (
  select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
         rolcanlogin, rolinherit
  from pg_roles
  where rolsuper or rolbypassrls or rolcreaterole
  order by rolname
),
membership_rows as (
  select r.rolname as role_name, m.rolname as member_name, am.admin_option
  from pg_auth_members am
  join pg_roles r on r.oid = am.roleid
  join pg_roles m on m.oid = am.member
  where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator',
                      'postgres', 'supabase_admin', 'supabase_auth_admin',
                      'supabase_storage_admin', 'dashboard_user', 'pgbouncer')
     or r.rolname like 'cap_%'
     or m.rolname in ('anon', 'authenticated', 'service_role')
),
schema_rows as (
  select n.nspname,
         pg_get_userbyid(n.nspowner) as owner_name,
         case when has_schema_privilege('anon', n.oid, 'USAGE') then true else false end as anon_usage,
         case when has_schema_privilege('anon', n.oid, 'CREATE') then true else false end as anon_create,
         case when has_schema_privilege('authenticated', n.oid, 'USAGE') then true else false end as auth_usage,
         case when has_schema_privilege('authenticated', n.oid, 'CREATE') then true else false end as auth_create,
         n.nspacl
  from pg_namespace n
  where n.nspname in ('public', 'auth', 'cap_notes_lab', 'graphql_public',
                      'storage', 'extensions')
),
default_acl_rows as (
  select coalesce(n.nspname, '<global>') as schema_name,
         pg_get_userbyid(d.defaclrole) as owner_name,
         d.defaclobjtype,
         coalesce(g.rolname, 'PUBLIC') as grantee,
         a.privilege_type,
         a.is_grantable
  from pg_default_acl d
  cross join lateral aclexplode(d.defaclacl) a
  left join pg_roles g on g.oid = a.grantee
  left join pg_namespace n on n.oid = d.defaclnamespace
),
extension_rows as (
  select e.extname, n.nspname as schema_name, e.extversion
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
),
facts as (
  select
    (select count(*) from notes_rel) = 1 as notes_exists,
    coalesce((select relrowsecurity from notes_rel), false) as notes_rls,
    coalesce((select relforcerowsecurity from notes_rel), false) as notes_force_rls,
    coalesce((select owner_name from notes_rel), '') as notes_owner,
    coalesce((select can_select from notes_effective where role_name = 'authenticated'), false) as auth_select,
    coalesce((select can_insert from notes_effective where role_name = 'authenticated'), false) as auth_insert,
    coalesce((select can_update from notes_effective where role_name = 'authenticated'), false) as auth_update,
    coalesce((select can_delete from notes_effective where role_name = 'authenticated'), false) as auth_delete,
    coalesce((select can_truncate from notes_effective where role_name = 'authenticated'), false) as auth_truncate,
    coalesce((select can_select from notes_effective where role_name = 'anon'), false) as anon_select,
    coalesce((select can_insert from notes_effective where role_name = 'anon'), false) as anon_insert,
    coalesce((select can_update from notes_effective where role_name = 'anon'), false) as anon_update,
    coalesce((select can_delete from notes_effective where role_name = 'anon'), false) as anon_delete,
    coalesce((select can_truncate from notes_effective where role_name = 'anon'), false) as anon_truncate,
    coalesce((select bool_or(can_select or can_insert or can_update or can_delete or can_truncate or can_references or can_trigger)
              from notes_direct_acl where grantee = 'PUBLIC'), false) as public_any,
    (select count(*) from notes_column_grants
      where grantee in ('anon', 'PUBLIC') and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')) as anon_public_column_grants,
    (select count(*) from notes_column_grants
      where grantee = 'authenticated' and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')) as auth_column_grants,
    (select count(*) from notes_column_grants
      where grantee = 'authenticated' and privilege_type = 'SELECT') as auth_column_select,
    (select count(*) from notes_policies) as policy_count,
    coalesce((select bool_or(cmd in ('ALL', 'DELETE')) from notes_policies), false) as policy_delete_or_all,
    coalesce((select bool_and(permissive = 'PERMISSIVE' and roles = array['authenticated']::text[]
                              and regexp_replace(coalesce(qual, ''), '[()\s]', '', 'g') = 'user_id=auth.uid'
                              and (cmd = 'SELECT'
                                   or regexp_replace(coalesce(with_check, ''), '[()\s]', '', 'g') = 'user_id=auth.uid'))
              from notes_policies where cmd in ('ALL', 'SELECT')), false) as policy_owner_only,
    (select count(*) from notes_columns where column_name in ('deleted_at', 'revision', 'operation_id')) as lifecycle_column_count,
    (select count(*) from notes_columns) as note_column_count,
    (select count(*) from function_info where prosecdef) as definer_count,
    (select count(*) from function_info where prosecdef and public_exec) as definer_public_exec,
    (select count(*) from function_info where prosecdef and anon_exec) as definer_anon_exec,
    (select count(*) from function_info where prosecdef and not fixed_search_path) as definer_unfixed_path,
    (select count(*) from function_info where owner_name in ('anon', 'authenticated')) as client_owned_functions,
    (select count(*) from cap_table_state where owner_name in ('anon', 'authenticated')) as client_owned_tables,
    (select count(*) from schema_rows where nspname = 'cap_notes_lab') as lab_schema_count,
    (select count(*) from schema_rows where auth_create) as auth_schema_create,
    (select count(*) from schema_rows where anon_create) as anon_schema_create,
    (select count(*) from default_acl_rows
      where schema_name = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')) as public_default_client_grants,
    (select count(*) from default_acl_rows
      where grantee in ('anon', 'authenticated')
        and (schema_name in ('public', '<global>') or schema_name like 'cap\_%' escape '\')) as client_default_grants,
    (select count(*) from privileged_role_rows
      where rolname not in ('postgres', 'supabase_admin', 'supabase_auth_admin',
                            'supabase_storage_admin', 'dashboard_user', 'pgbouncer')) as unexpected_privileged_roles,
    (select count(*) from pg_roles r
      where r.rolname <> 'authenticated'
        and (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolname like 'cap\_%' escape '\')
        and pg_has_role('authenticated', r.oid, 'MEMBER')) as auth_transitive_membership,
    (select count(*) from pg_roles r
      where r.rolname <> 'anon'
        and (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolname like 'cap\_%' escape '\')
        and pg_has_role('anon', r.oid, 'MEMBER')) as anon_transitive_membership,
    (select count(*) from role_rows where rolname in ('anon', 'authenticated') and (rolsuper or rolbypassrls or rolcreaterole)) as client_role_elevated,
    (select count(*) from membership_rows
      where member_name in ('anon', 'authenticated')
        and (role_name in ('postgres', 'supabase_admin', 'supabase_auth_admin',
                           'supabase_storage_admin', 'dashboard_user')
             or role_name like 'cap\_%' escape '\')) as client_elevated_membership,
    (select count(*) from expected_functions where name = 'cap_sync_note_put' and resolved_oid is not null) as legacy_cas_exists,
    (select count(*) from expected_functions where name = 'cap_sync_note_put' and resolved_oid is not null
       and (select auth_exec from function_info where oid = resolved_oid)) as legacy_cas_auth_exec,
    (select count(*) from expected_functions where name = 'cap_verify_notes_rpc' and resolved_oid is not null) as legacy_verifier_exists,
    (select count(*) from expected_functions
      where name in ('cap_test_transaction_create', 'cap_verify_transaction_rpc')
        and resolved_oid is not null) as test_rpc_count,
    (select count(*) from extension_rows where schema_name = 'public') as extensions_in_public
),
finding_rows as (
  select 'CRITICAL'::text as severity, 'NOTES_MISSING'::text as code,
         'public.notes does not exist as a table'::text as detail
  where not (select notes_exists from facts)
  union all
  select 'CRITICAL', 'NOTES_RLS_DISABLED', 'public.notes does not have RLS enabled'
  where not (select notes_rls from facts)
  union all
  select 'CRITICAL', 'NOTES_OWNER_CLIENT_ROLE', 'public.notes is owned by anon/authenticated'
  where (select notes_owner from facts) in ('anon', 'authenticated')
  union all
  select 'CRITICAL', 'NOTES_AUTH_DELETE', 'authenticated can directly DELETE note rows, bypassing tombstones'
  where (select auth_delete from facts)
  union all
  select 'CRITICAL', 'NOTES_AUTH_TRUNCATE', 'authenticated can directly TRUNCATE note rows'
  where (select auth_truncate from facts)
  union all
  select 'CRITICAL', 'NOTES_AUTH_INSERT_UPDATE', 'authenticated can directly INSERT/UPDATE note rows, bypassing lifecycle CAS'
  where (select auth_insert or auth_update from facts)
  union all
  select 'CRITICAL', 'NOTES_ANON_ANY', 'anon has a direct note table privilege'
  where (select anon_select or anon_insert or anon_update or anon_delete or anon_truncate from facts)
  union all
  select 'CRITICAL', 'NOTES_PUBLIC_ANY', 'PUBLIC has a direct note table privilege'
  where (select public_any from facts)
  union all
  select 'CRITICAL', 'NOTES_ANON_PUBLIC_COLUMN_GRANT', 'anon/PUBLIC has a column-level note privilege'
  where (select anon_public_column_grants from facts) > 0
  union all
  select 'CRITICAL', 'NOTES_AUTH_COLUMN_WRITE_GRANT', 'authenticated has a column-level note INSERT/UPDATE/REFERENCES grant'
  where exists (
    select 1 from notes_column_grants
    where grantee = 'authenticated' and privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
  )
  union all
  select 'CRITICAL', 'CLIENT_OWNS_CAP_OBJECT', 'authenticated/anon owns a Cap table or function'
  where (select client_owned_tables + client_owned_functions from facts) > 0
  union all
  select 'CRITICAL', 'CLIENT_ROLE_ELEVATED', 'anon/authenticated has superuser, BYPASSRLS, or CREATEROLE'
  where (select client_role_elevated from facts) > 0
  union all
  select 'CRITICAL', 'CLIENT_ELEVATED_MEMBERSHIP', 'anon/authenticated is a member of an administrative or cap_* role'
  where (select client_elevated_membership from facts) > 0
  union all
  select 'CRITICAL', 'CLIENT_TRANSITIVE_MEMBERSHIP', 'anon/authenticated can transitively assume an administrative or cap_* role'
  where (select auth_transitive_membership + anon_transitive_membership from facts) > 0
  union all
  select 'CRITICAL', 'DEFINER_PUBLIC_EXECUTE', 'a SECURITY DEFINER function in public is executable by PUBLIC'
  where (select definer_public_exec from facts) > 0
  union all
  select 'CRITICAL', 'DEFINER_ANON_EXECUTE', 'a SECURITY DEFINER function in public is executable by anon'
  where (select definer_anon_exec from facts) > 0
  union all
  select 'CRITICAL', 'LAB_SCHEMA_INSTALLED', 'cap_notes_lab exists in this database; the lab must not be installed in production'
  where (select lab_schema_count from facts) > 0
  union all
  select 'HIGH', 'NOTES_FORCE_RLS_DISABLED', 'public.notes does not FORCE RLS; a table-owner writer could bypass policies'
  where not (select notes_force_rls from facts)
  union all
  select 'HIGH', 'NOTES_POLICY_DRIFT', 'notes has authenticated SELECT but does not have exactly one reviewed owner-only policy'
  where (select auth_select from facts)
    and (not (select policy_owner_only from facts) or (select policy_count from facts) <> 1)
  union all
  select 'HIGH', 'NOTES_DESTRUCTIVE_POLICY', 'a notes policy grants ALL/DELETE semantics'
  where (select policy_delete_or_all from facts)
  union all
  select 'HIGH', 'LEGACY_CAS_WRITE_PATH', 'cap_sync_note_put still exists with authenticated EXECUTE; old content-only writes are not locked out'
  where (select legacy_cas_auth_exec from facts) > 0
  union all
  select 'HIGH', 'LEGACY_VERIFIER_PRESENT', 'cap_verify_notes_rpc still attests the old content-CAS contract'
  where (select legacy_verifier_exists from facts) > 0
  union all
  select 'HIGH', 'TEST_RPC_PRESENT', 'test-only transaction RPC/verifier is installed'
  where (select test_rpc_count from facts) > 0
  union all
  select 'HIGH', 'DEFINER_UNFIXED_SEARCH_PATH', 'a SECURITY DEFINER function in public has no fixed search_path'
  where (select definer_unfixed_path from facts) > 0
  union all
  select 'HIGH', 'CLIENT_DEFAULT_PRIVILEGES', 'default privileges grant anon/authenticated on future public/cap_* objects'
  where (select client_default_grants from facts) > 0
  union all
  select 'HIGH', 'PUBLIC_DEFAULT_PRIVILEGES', 'default privileges grant PUBLIC/anon/authenticated on future public objects'
  where (select public_default_client_grants from facts) > 0
  union all
  select 'HIGH', 'UNEXPECTED_PRIVILEGED_ROLE', 'a role with SUPERUSER/BYPASSRLS/CREATEROLE is outside the reviewed administrative allowlist'
  where (select unexpected_privileged_roles from facts) > 0
  union all
  select 'HIGH', 'AUTH_SCHEMA_CREATE', 'authenticated can CREATE in a reviewed schema'
  where (select auth_schema_create from facts) > 0
  union all
  select 'HIGH', 'ANON_SCHEMA_CREATE', 'anon can CREATE in a reviewed schema'
  where (select anon_schema_create from facts) > 0
  union all
  select 'HIGH', 'EXTENSION_IN_PUBLIC', 'an extension is installed in the public schema'
  where (select extensions_in_public from facts) > 0
  union all
  select 'REVIEW', 'NOTES_DIRECT_SELECT', 'authenticated can SELECT raw note rows; decide whether reads must go through a lifecycle reader RPC'
  where (select auth_select from facts)
  union all
  select 'REVIEW', 'NOTES_AUTH_COLUMN_SELECT', 'authenticated has a column-level note SELECT grant; include it in the read-path decision'
  where (select auth_column_select from facts) > 0
  union all
  select 'REVIEW', 'LIFECYCLE_COLUMNS_ABSENT', 'no deleted_at/revision/operation_id columns on public.notes; lifecycle migration is not applied'
  where (select lifecycle_column_count from facts) = 0
  union all
  select 'REVIEW', 'LIFECYCLE_COLUMNS_PARTIAL', 'only some lifecycle columns exist on public.notes; migration is incomplete'
  where (select lifecycle_column_count from facts) between 1 and 2
  union all
  select 'REVIEW', 'NOTES_TRIGGERS_PRESENT', 'public.notes has user triggers; review lifecycle/revision enforcement and rollback'
  where exists (select 1 from notes_triggers)
  union all
  select 'REVIEW', 'UNEXPECTED_DEFINER_FUNCTION', 'a SECURITY DEFINER function in public is outside the reviewed allowlist'
  where exists (
    select 1 from function_info f
    where f.prosecdef
      and f.proname not in ('cap_verify_notes_rpc', 'cap_verify_transaction_rpc')
  )
  union all
  select 'REVIEW', 'SERVICE_ROLE_PRESENT', 'service_role exists and bypasses RLS by design; verify key custody and that it never ships to clients'
  where exists (select 1 from role_rows where rolname = 'service_role')
),
finding_summary as (
  select severity, count(*) as count
  from finding_rows
  group by severity
)
select jsonb_pretty(jsonb_build_object(
  'audit', 'cap-production-privilege-audit',
  'audit_version', 1,
  'read_only', true,
  'generated_at', now(),
  'warning', 'Repository-derived catalog audit only. Not production readiness. Do not enable deletion or sync from this output.',
  'environment', jsonb_build_object(
    'current_user', current_user,
    'session_user', session_user,
    'server_version', current_setting('server_version'),
    'postgrest_schemas', current_setting('pgrst.db_schemas', true),
    'postgrest_extra_search_path', current_setting('pgrst.db_extra_search_path', true)
  ),
  'roles', coalesce((select jsonb_agg(to_jsonb(r) order by rolname) from role_rows r), '[]'::jsonb),
  'privileged_roles', coalesce((select jsonb_agg(to_jsonb(r) order by rolname) from privileged_role_rows r), '[]'::jsonb),
  'memberships', coalesce((select jsonb_agg(to_jsonb(m) order by role_name, member_name) from membership_rows m), '[]'::jsonb),
  'schemas', coalesce((select jsonb_agg(jsonb_build_object(
      'name', nspname, 'owner', owner_name,
      'anon_usage', anon_usage, 'anon_create', anon_create,
      'authenticated_usage', auth_usage, 'authenticated_create', auth_create,
      'acl', nspacl::text) order by nspname) from schema_rows), '[]'::jsonb),
  'cap_tables', coalesce((select jsonb_agg(to_jsonb(t) order by relname) from cap_table_state t), '[]'::jsonb),
  'notes', jsonb_build_object(
    'exists', (select notes_exists from facts),
    'owner', (select notes_owner from facts),
    'rls_enabled', (select notes_rls from facts),
    'force_rls', (select notes_force_rls from facts),
    'column_count', (select note_column_count from facts),
    'lifecycle_column_count', (select lifecycle_column_count from facts),
    'columns', coalesce((select jsonb_agg(to_jsonb(c) order by column_name) from notes_columns c), '[]'::jsonb),
    'effective_privileges', coalesce((select jsonb_agg(to_jsonb(p) order by role_name) from notes_effective p), '[]'::jsonb),
    'direct_acl', coalesce((select jsonb_agg(to_jsonb(a) order by grantee) from notes_direct_acl a), '[]'::jsonb),
    'column_grants', coalesce((select jsonb_agg(to_jsonb(g) order by column_name, grantee, privilege_type)
      from notes_column_grants g), '[]'::jsonb),
    'policies', coalesce((select jsonb_agg(to_jsonb(p) order by policyname) from notes_policies p), '[]'::jsonb),
    'triggers', coalesce((select jsonb_agg(to_jsonb(t) order by tgname) from notes_triggers t), '[]'::jsonb)
  ),
  'expected_functions', coalesce((select jsonb_agg(jsonb_build_object(
      'name', name, 'args', args, 'exists', resolved_oid is not null) order by name) from expected_functions), '[]'::jsonb),
  'public_functions', coalesce((select jsonb_agg(jsonb_build_object(
      'name', proname,
      'identity_args', identity_args,
      'arg_types', arg_types,
      'security_definer', prosecdef,
      'volatility', provolatile,
      'kind', prokind,
      'owner', owner_name,
      'acl', proacl::text,
      'config', proconfig,
      'comment', comment,
      'anon_execute', anon_exec,
      'authenticated_execute', auth_exec,
      'public_execute', public_exec,
      'fixed_search_path', fixed_search_path) order by proname, identity_args)
      from function_info), '[]'::jsonb),
  'default_privileges', coalesce((select jsonb_agg(to_jsonb(d) order by schema_name, owner_name, defaclobjtype, grantee, privilege_type)
      from default_acl_rows d), '[]'::jsonb),
  'extensions', coalesce((select jsonb_agg(to_jsonb(e) order by extname) from extension_rows e), '[]'::jsonb),
  'findings', coalesce((select jsonb_agg(jsonb_build_object(
      'severity', severity, 'code', code, 'detail', detail) order by
      case severity when 'CRITICAL' then 1 when 'HIGH' then 2 else 3 end, code)
      from finding_rows), '[]'::jsonb),
  'finding_counts', jsonb_build_object(
    'critical', coalesce((select count from finding_summary where severity = 'CRITICAL'), 0),
    'high', coalesce((select count from finding_summary where severity = 'HIGH'), 0),
    'review', coalesce((select count from finding_summary where severity = 'REVIEW'), 0)
  ),
  'verdict', jsonb_build_object(
    'posture_ready_for_review', coalesce((select sum(count) from finding_summary where severity in ('CRITICAL', 'HIGH')), 0) = 0,
    'production_notes_lifecycle_ready', false,
    'legacy_lockout_complete', (select not auth_insert and not auth_update and not auth_delete
                                and legacy_cas_auth_exec = 0 from facts),
    'reason', 'A catalog pass cannot prove PostgREST exposure, JWT/auth hooks, service-role custody, migration rollback, old-client behaviour, or live race safety.'
  )
)) as production_privilege_audit;

commit;
