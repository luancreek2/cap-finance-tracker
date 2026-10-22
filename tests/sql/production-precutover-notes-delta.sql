-- Cap Phase 6L: READ-ONLY pre-cutover Notes delta audit.
--
-- This file opens a read-only transaction and reads PostgreSQL catalogs and
-- privilege functions only. It does not call an RPC, read application rows,
-- create/alter/drop any object, or change grants, policies or roles.
--
-- Use in a reviewed Supabase SQL Editor session to explain the authenticated
-- Notes verifier's `grants_ok`, `policies_ok` and `legacy_lockout_ok` flags.
-- Do not run the cutover or enable Cloud Sync from this output.

begin transaction read only;

with
target_relations(name, oid) as (
  values
    ('public.notes', to_regclass('public.notes')),
    ('cap_notes_private.note_lifecycle', to_regclass('cap_notes_private.note_lifecycle')),
    ('cap_notes_private.operations', to_regclass('cap_notes_private.operations'))
),
present_relations as (
  select name, oid from target_relations where oid is not null
),
client_roles(role_name) as (
  values ('authenticated'), ('anon'), ('service_role')
),
table_acl as (
  select r.name as relation,
         coalesce(role.rolname, 'PUBLIC') as grantee,
         a.privilege_type,
         a.is_grantable
  from present_relations r
  join pg_class c on c.oid = r.oid
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  left join pg_roles role on role.oid = a.grantee
),
table_effective as (
  select r.name as relation,
         cr.role_name,
         has_table_privilege(cr.role_name, r.oid, 'SELECT') as can_select,
         has_table_privilege(cr.role_name, r.oid, 'INSERT') as can_insert,
         has_table_privilege(cr.role_name, r.oid, 'UPDATE') as can_update,
         has_table_privilege(cr.role_name, r.oid, 'DELETE') as can_delete,
         has_table_privilege(cr.role_name, r.oid, 'TRUNCATE') as can_truncate,
         has_table_privilege(cr.role_name, r.oid, 'REFERENCES') as can_references,
         has_table_privilege(cr.role_name, r.oid, 'TRIGGER') as can_trigger
  from present_relations r
  cross join client_roles cr
),
column_acl as (
  select r.name as relation,
         a.attname,
         coalesce(role.rolname, 'PUBLIC') as grantee,
         x.privilege_type,
         x.is_grantable
  from present_relations r
  join pg_class c on c.oid = r.oid
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  cross join lateral aclexplode(a.attacl) x
  left join pg_roles role on role.oid = x.grantee
  where a.attacl is not null
),
policies as (
  select r.name as relation,
         p.polname,
         p.polpermissive,
         case when cardinality(p.polroles) = 0 then '["PUBLIC"]'::jsonb
              else (
                select jsonb_agg(coalesce(role.rolname, 'PUBLIC')
                                 order by coalesce(role.rolname, 'PUBLIC'))
                from unnest(p.polroles) pr
                left join pg_roles role on role.oid = pr
              )
         end as roles,
         p.polcmd,
         pg_get_expr(p.polqual, p.polrelid) as qual,
         pg_get_expr(p.polwithcheck, p.polrelid) as with_check
  from present_relations r
  join pg_policy p on p.polrelid = r.oid
),
function_names(name) as (
  values
    ('public.cap_notes_read(uuid)'),
    ('public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)'),
    ('public.cap_verify_notes_lifecycle()'),
    ('public.cap_sync_note_put(uuid,jsonb,jsonb)'),
    ('public.cap_verify_notes_rpc()'),
    ('public.cap_request_uid()'),
    ('public.cap_request_identity_ok()'),
    ('public.cap_role_boundary_ok(oid)'),
    ('public.rls_auto_enable()'),
    ('public.set_updated_at()'),
    ('cap_notes_private.backfill_lifecycle()'),
    ('cap_notes_private.rollback_guard()'),
    ('cap_notes_private.coverage_ok()')
),
functions as (
  select fn.name as requested,
         p.oid::regprocedure as signature,
         p.oid is not null as is_present,
         n.nspname,
         p.proname,
         pg_get_function_identity_arguments(p.oid) as args,
         pg_get_userbyid(p.proowner) as owner,
         p.prosecdef,
         p.provolatile,
         p.prokind,
         p.proacl::text as acl,
         p.proconfig,
         obj_description(p.oid, 'pg_proc') as comment,
         case when p.oid is null then null
              else has_function_privilege('authenticated', p.oid, 'EXECUTE') end as auth_exec,
         case when p.oid is null then null
              else has_function_privilege('anon', p.oid, 'EXECUTE') end as anon_exec,
         case when p.oid is null then null
              else exists (
                select 1
                from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE'
              ) end as public_exec
  from function_names fn
  left join pg_proc p on p.oid = to_regprocedure(fn.name)
  left join pg_namespace n on n.oid = p.pronamespace
),
test_functions as (
  select p.oid::regprocedure as signature,
         pg_get_userbyid(p.proowner) as owner,
         p.proacl::text as acl,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'cap\_test\_%' escape '\'
),
schemas as (
  select n.nspname,
         pg_get_userbyid(n.nspowner) as owner,
         n.nspacl::text as acl,
         has_schema_privilege('authenticated', n.oid, 'USAGE') as auth_usage,
         has_schema_privilege('anon', n.oid, 'USAGE') as anon_usage,
         has_schema_privilege('service_role', n.oid, 'USAGE') as service_usage
  from pg_namespace n
  where n.nspname in ('public', 'cap_notes_private', 'cap_sync_private')
),
roles as (
  select rolname,
         rolcanlogin,
         rolinherit,
         rolsuper,
         rolbypassrls,
         rolcreatedb,
         rolcreaterole,
         rolreplication
  from pg_roles
  where rolname in (
    'cap_notes_sidecar_writer',
    'cap_transaction_writer',
    'cap_sync_reader',
    'authenticated',
    'anon',
    'service_role'
  )
),
memberships as (
  select role.rolname as role_name,
         member.rolname as member_name,
         grantor.rolname as grantor_name,
         am.admin_option,
         am.inherit_option,
         am.set_option
  from pg_auth_members am
  join pg_roles role on role.oid = am.roleid
  join pg_roles member on member.oid = am.member
  join pg_roles grantor on grantor.oid = am.grantor
  where role.rolname like 'cap\_%' escape '\'
     or member.rolname in ('authenticated', 'anon', 'service_role')
),
default_acl as (
  select coalesce(n.nspname, '<global>') as schema_name,
         pg_get_userbyid(d.defaclrole) as owner,
         d.defaclobjtype,
         coalesce(role.rolname, 'PUBLIC') as grantee,
         a.privilege_type,
         a.is_grantable
  from pg_default_acl d
  cross join lateral aclexplode(d.defaclacl) a
  left join pg_roles role on role.oid = a.grantee
  left join pg_namespace n on n.oid = d.defaclnamespace
  where coalesce(n.nspname, '<global>') in ('public', 'cap_notes_private', '<global>')
)
select jsonb_pretty(jsonb_build_object(
  'audit', 'cap-precutover-notes-delta',
  'read_only', true,
  'generated_at', now(),
  'environment', jsonb_build_object(
    'current_user', current_user,
    'session_user', session_user,
    'server_version', current_setting('server_version')
  ),
  'table_acl', coalesce((
    select jsonb_agg(to_jsonb(t) order by relation, grantee, privilege_type)
    from table_acl t), '[]'::jsonb),
  'table_effective', coalesce((
    select jsonb_agg(to_jsonb(t) order by relation, role_name)
    from table_effective t), '[]'::jsonb),
  'column_acl', coalesce((
    select jsonb_agg(to_jsonb(c) order by relation, attname, grantee, privilege_type)
    from column_acl c), '[]'::jsonb),
  'policies', coalesce((
    select jsonb_agg(to_jsonb(p) order by relation, polname)
    from policies p), '[]'::jsonb),
  'functions', coalesce((
    select jsonb_agg(to_jsonb(f) order by requested)
    from functions f), '[]'::jsonb),
  'test_functions', coalesce((
    select jsonb_agg(to_jsonb(t) order by signature)
    from test_functions t), '[]'::jsonb),
  'schemas', coalesce((
    select jsonb_agg(to_jsonb(s) order by nspname)
    from schemas s), '[]'::jsonb),
  'roles', coalesce((
    select jsonb_agg(to_jsonb(r) order by rolname)
    from roles r), '[]'::jsonb),
  'memberships', coalesce((
    select jsonb_agg(to_jsonb(m) order by role_name, member_name, grantor_name)
    from memberships m), '[]'::jsonb),
  'default_acl', coalesce((
    select jsonb_agg(to_jsonb(d) order by schema_name, owner, defaclobjtype, grantee, privilege_type)
    from default_acl d), '[]'::jsonb)
)) as production_precutover_notes_delta;

commit;
