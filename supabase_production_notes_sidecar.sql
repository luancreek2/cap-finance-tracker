-- Phase 6L DRAFT: prepare/review only. NOT authorized for production deployment.
-- Prerequisite: guarded supabase_production_identity.sql (Cap-owned identity).
-- Also requires supabase_production_role_boundary.sql (PG16+ admin membership).
-- First-install script, not an idempotent migration. It creates the private
-- notes sidecar, the dedicated no-login writer, and the RPC-only lifecycle
-- endpoints. It does NOT revoke existing direct note grants, drop legacy RPCs,
-- or backfill rows automatically; those are separate reviewed cutover steps.
-- This script alone does NOT make Cloud Sync ready.
-- Guard (must be explicitly set by the isolated harness/reviewed installer):
--   SET cap.notes_sidecar_install = 'reviewed-draft-only';
begin;
do $$
declare
  missing_columns integer;
begin
  if current_setting('cap.notes_sidecar_install',true) is distinct from 'reviewed-draft-only' then
    raise exception 'NOTES_SIDECAR_INSTALL_NOT_APPROVED';
  end if;
  if to_regprocedure('public.cap_request_identity_ok()') is null
     or to_regprocedure('public.cap_role_boundary_ok(oid)') is null then
    raise exception 'IDENTITY_AND_ROLE_BOUNDARY_PREREQUISITES_REQUIRED';
  end if;
  if not public.cap_request_identity_ok() then raise exception 'REQUEST_IDENTITY_NOT_VERIFIED'; end if;
  if to_regnamespace('cap_notes_private') is not null
     or exists(select 1 from pg_roles where rolname='cap_notes_sidecar_writer')
     or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public'
         and p.proname in ('cap_notes_read','cap_notes_change','cap_verify_notes_lifecycle')) then
    raise exception 'NOTES_SIDECAR_TARGET_NOT_EMPTY';
  end if;
  if to_regclass('public.notes') is null
     or to_regprocedure('public.cap_request_uid()') is null
     or to_regclass('auth.users') is null then
    raise exception 'NOTES_SIDECAR_DEPENDENCIES_REQUIRED';
  end if;
  select count(*) into missing_columns
    from information_schema.columns
    where table_schema='public' and table_name='notes'
      and column_name in ('id','user_id','legacy_id','title','body','note_date');
  if missing_columns <> 6 then
    raise exception 'NOTES_SIDECAR_DEPENDENCIES_REQUIRED';
  end if;
  if not exists(select 1 from pg_roles where rolname='authenticated')
     or not exists(select 1 from pg_roles where rolname='anon') then
    raise exception 'NOTES_SIDECAR_DEPENDENCIES_REQUIRED';
  end if;
end $$;

create role cap_notes_sidecar_writer nologin noinherit nosuperuser nobypassrls
  nocreatedb nocreaterole noreplication;
-- Temporary installation membership and CREATE permission allow a non-superuser
-- table owner to assign function ownership. Both are revoked before commit.
do $$ begin execute format('grant cap_notes_sidecar_writer to %I with admin false, inherit true, set true',current_user); end $$;
grant usage, create on schema public to cap_notes_sidecar_writer;
grant execute on function public.cap_request_uid(),public.cap_request_identity_ok(),public.cap_role_boundary_ok(oid) to cap_notes_sidecar_writer;

create schema cap_notes_private;
revoke all on schema cap_notes_private from public,anon,authenticated,cap_notes_sidecar_writer;
grant usage on schema cap_notes_private to cap_notes_sidecar_writer;

create table cap_notes_private.note_lifecycle (
  note_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete restrict,
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  deleted_at timestamptz(3),
  operation_id uuid,
  created_at timestamptz(3) not null default clock_timestamp(),
  updated_at timestamptz(3) not null default clock_timestamp(),
  check(deleted_at is null or operation_id is not null),
  foreign key (user_id,note_id) references public.notes(user_id,id) on delete restrict
);
create table cap_notes_private.operations (
  user_id uuid not null references auth.users(id) on delete restrict,
  operation_id uuid not null,
  note_id uuid not null,
  action text not null check(action in ('create','edit','tombstone')),
  expected jsonb,
  desired jsonb,
  result jsonb not null,
  created_at timestamptz(3) not null default clock_timestamp(),
  primary key(user_id,operation_id),
  check((action='create' and expected is null and desired is not null)
    or (action='edit' and expected is not null and desired is not null)
    or (action='tombstone' and expected is not null and desired is null)),
  foreign key (user_id,note_id) references public.notes(user_id,id) on delete restrict
);

-- Every synchronized note must have exactly one private lifecycle row. The
-- writer can read, insert and update; it can never delete or truncate.
alter table public.notes enable row level security;
alter table public.notes force row level security;
alter table cap_notes_private.note_lifecycle enable row level security;
alter table cap_notes_private.note_lifecycle force row level security;
alter table cap_notes_private.operations enable row level security;
alter table cap_notes_private.operations force row level security;

create policy sidecar_notes_read on public.notes
  for select to cap_notes_sidecar_writer using(user_id=public.cap_request_uid());
create policy sidecar_notes_update on public.notes
  for update to cap_notes_sidecar_writer using(user_id=public.cap_request_uid()) with check(user_id=public.cap_request_uid());
create policy sidecar_notes_insert on public.notes
  for insert to cap_notes_sidecar_writer with check(user_id=public.cap_request_uid());
create policy sidecar_lifecycle_read on cap_notes_private.note_lifecycle
  for select to cap_notes_sidecar_writer using(user_id=public.cap_request_uid());
create policy sidecar_lifecycle_update on cap_notes_private.note_lifecycle
  for update to cap_notes_sidecar_writer using(user_id=public.cap_request_uid()) with check(user_id=public.cap_request_uid());
create policy sidecar_lifecycle_insert on cap_notes_private.note_lifecycle
  for insert to cap_notes_sidecar_writer with check(user_id=public.cap_request_uid());
create policy sidecar_operation_read on cap_notes_private.operations
  for select to cap_notes_sidecar_writer using(user_id=public.cap_request_uid());
create policy sidecar_operation_insert on cap_notes_private.operations
  for insert to cap_notes_sidecar_writer with check(user_id=public.cap_request_uid());

revoke all on cap_notes_private.note_lifecycle,cap_notes_private.operations
  from public,anon,authenticated,cap_notes_sidecar_writer;
grant select,insert,update on cap_notes_private.note_lifecycle to cap_notes_sidecar_writer;
grant select,insert on cap_notes_private.operations to cap_notes_sidecar_writer;
revoke all on public.notes from cap_notes_sidecar_writer;
grant select,insert,update on public.notes to cap_notes_sidecar_writer;

do $$
begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'revoke all on schema cap_notes_private from service_role';
    execute 'revoke all on cap_notes_private.note_lifecycle,cap_notes_private.operations from service_role';
  end if;
end $$;

-- Admin-only migration helpers. They are not client endpoints and have no
-- EXECUTE grant to authenticated/anon/PUBLIC. Backfill is NOT automatic.
create function cap_notes_private.backfill_lifecycle() returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare inserted integer; missing integer; orphans integer;
begin
  insert into cap_notes_private.note_lifecycle(note_id,user_id,revision,deleted_at,operation_id)
    select n.id,n.user_id,1,null,null from public.notes n
    where not exists(select 1 from cap_notes_private.note_lifecycle l where l.note_id=n.id)
    on conflict (note_id) do nothing;
  get diagnostics inserted = row_count;
  select count(*) into missing from public.notes n
    where not exists(select 1 from cap_notes_private.note_lifecycle l
      where l.note_id=n.id and l.user_id=n.user_id);
  select count(*) into orphans from cap_notes_private.note_lifecycle l
    where not exists(select 1 from public.notes n
      where n.id=l.note_id and n.user_id=l.user_id);
  return jsonb_build_object('inserted',inserted,'missing',missing,'orphans',orphans);
end $$;
revoke all on function cap_notes_private.backfill_lifecycle()
  from public,anon,authenticated,cap_notes_sidecar_writer;

create function cap_notes_private.coverage_ok() returns boolean
language sql stable security definer set search_path=pg_catalog as $$
  select not exists(select 1 from public.notes n
      where not exists(select 1 from cap_notes_private.note_lifecycle l
        where l.note_id=n.id and l.user_id=n.user_id))
    and not exists(select 1 from cap_notes_private.note_lifecycle l
      where not exists(select 1 from public.notes n
        where n.id=l.note_id and n.user_id=l.user_id));
$$;
revoke all on function cap_notes_private.coverage_ok()
  from public,anon,authenticated,cap_notes_sidecar_writer;
grant execute on function cap_notes_private.coverage_ok() to cap_notes_sidecar_writer;

create function cap_notes_private.rollback_guard() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare tombstones integer; operations integer;
begin
  select count(*) into tombstones from cap_notes_private.note_lifecycle where deleted_at is not null;
  select count(*) into operations from cap_notes_private.operations;
  return jsonb_build_object('safe_to_restore_legacy',tombstones=0,
    'tombstones_present',tombstones>0,'operations_present',operations>0,
    'action',case when tombstones=0
      then 'RESTORE LEGACY ONLY AFTER PRIVATE EXPORT AND REVIEW'
      else 'BLOCKED - DO NOT DROP SIDECAR OR RESTORE DIRECT DELETE' end,
    'production_ready',false);
end $$;
revoke all on function cap_notes_private.rollback_guard()
  from public,anon,authenticated,cap_notes_sidecar_writer;

create function public.cap_notes_read(p_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
  select jsonb_build_object(
    'content',jsonb_build_object('legacy_id',n.legacy_id,'title',n.title,'body',n.body,'note_date',n.note_date),
    'lifecycle',jsonb_build_object('version',1,'revision',l.revision,
      'deleted_at',case when l.deleted_at is null then null
        else to_char(l.deleted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'operation_id',l.operation_id))
  from public.notes n
  join cap_notes_private.note_lifecycle l on l.note_id=n.id and l.user_id=n.user_id
  where n.id=p_id and n.user_id=public.cap_request_uid();
$$;
comment on function public.cap_notes_read(uuid) is 'CAP_NOTES_SIDECAR_V1';
alter function public.cap_notes_read(uuid) owner to cap_notes_sidecar_writer;
revoke all on function public.cap_notes_read(uuid) from public,anon;
grant execute on function public.cap_notes_read(uuid) to authenticated,cap_notes_sidecar_writer;

-- Metadata plus coverage-key verification only. It never returns note content,
-- never invokes the writer, and never changes rows. The global production
-- readiness RPC remains separate and false until transaction/snapshot and the
-- direct-grant/legacy lockout are installed too.
create function public.cap_verify_notes_lifecycle() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare
  uid uuid := public.cap_request_uid();
  writer_oid oid := (select oid from pg_roles where rolname='cap_notes_sidecar_writer');
  snapshot_reader_oid oid := (select oid from pg_roles where rolname='cap_sync_reader');
  reader_oid oid := to_regprocedure('public.cap_notes_read(uuid)');
  writer_fn_oid oid := to_regprocedure('public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)');
  verifier_oid oid := to_regprocedure('public.cap_verify_notes_lifecycle()');
  legacy_cas_oid oid := to_regprocedure('public.cap_sync_note_put(uuid,jsonb,jsonb)');
  legacy_verify_oid oid := to_regprocedure('public.cap_verify_notes_rpc()');
  roles_ok boolean := false; tables_ok boolean := false; rls_ok boolean := false;
  notes_policies_ok boolean := false; lifecycle_policies_ok boolean := false;
  operations_policies_ok boolean := false; policies_ok boolean := false;
  grants_ok boolean := false; functions_ok boolean := false;
  legacy_lockout_ok boolean := false; coverage_ok boolean := false;
  contract_ready boolean := false;
begin
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;

  if writer_oid is not null then
    roles_ok := public.cap_request_identity_ok() and exists(select 1 from pg_roles w where w.oid=writer_oid
        and not w.rolcanlogin and not w.rolinherit and not w.rolsuper and not w.rolbypassrls
        and not w.rolcreatedb and not w.rolcreaterole and not w.rolreplication)
      and not exists(select 1 from pg_roles a where a.rolname in ('authenticated','anon')
        and (a.rolsuper or a.rolbypassrls or a.rolcreaterole or a.rolcreatedb or a.rolreplication))
      and public.cap_role_boundary_ok(writer_oid)
      and not coalesce(pg_has_role('authenticated',writer_oid,'MEMBER'),false)
      and not coalesce(pg_has_role('anon',writer_oid,'MEMBER'),false)
      and not coalesce(pg_has_role(writer_oid,'authenticated','MEMBER'),false)
      and not coalesce(pg_has_role(writer_oid,'anon','MEMBER'),false)
      and has_schema_privilege(writer_oid,'cap_notes_private','USAGE')
      and not has_schema_privilege(writer_oid,'cap_notes_private','CREATE')
      and not has_schema_privilege(writer_oid,'public','CREATE')
      and not has_schema_privilege('authenticated','cap_notes_private','USAGE')
      and not has_schema_privilege('anon','cap_notes_private','USAGE')
      and (not exists(select 1 from pg_roles where rolname='service_role')
        or (not has_schema_privilege('service_role','cap_notes_private','USAGE')
          and not has_table_privilege('service_role','cap_notes_private.note_lifecycle',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          and not has_table_privilege('service_role','cap_notes_private.operations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')));
  end if;

  select count(*)=3 and bool_and(c.relrowsecurity and c.relforcerowsecurity
      and not pg_has_role(writer_oid,c.relowner,'MEMBER')
      and not pg_has_role('authenticated',c.relowner,'MEMBER')) into rls_ok
    from pg_class c
    where c.oid in ('public.notes'::regclass,
      'cap_notes_private.note_lifecycle'::regclass,
      'cap_notes_private.operations'::regclass);
  tables_ok := to_regclass('public.notes') is not null
    and to_regclass('cap_notes_private.note_lifecycle') is not null
    and to_regclass('cap_notes_private.operations') is not null
    and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where ((n.nspname='public' and c.relname='notes')
        or (n.nspname='cap_notes_private' and c.relname in ('note_lifecycle','operations')))
        and pg_get_userbyid(c.relowner) in ('authenticated','anon','cap_notes_sidecar_writer'))
    and (select count(*)=5 from information_schema.columns where table_schema='cap_notes_private'
      and table_name='note_lifecycle'
      and column_name in ('note_id','user_id','revision','deleted_at','operation_id'))
    and (select count(*)=8 from information_schema.columns where table_schema='cap_notes_private'
      and table_name='operations'
      and column_name in ('user_id','operation_id','note_id','action','expected','desired','result','created_at'));

  if writer_oid is not null then
    select count(*)=3 and coalesce(bool_and(p.polpermissive
        and p.polroles=array[writer_oid] and (
          (p.polcmd='r' and regexp_replace(coalesce(pg_get_expr(p.polqual,p.polrelid),''),'[()\s]','','g')='user_id=public.cap_request_uid')
          or (p.polcmd='w'
            and regexp_replace(coalesce(pg_get_expr(p.polqual,p.polrelid),''),'[()\s]','','g')='user_id=public.cap_request_uid'
            and regexp_replace(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''),'[()\s]','','g')='user_id=public.cap_request_uid')
          or (p.polcmd='a'
            and regexp_replace(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''),'[()\s]','','g')='user_id=public.cap_request_uid'))),false)
      into notes_policies_ok from pg_policy p
      where p.polrelid='public.notes'::regclass and p.polroles=array[writer_oid];
    select count(*)=3 and coalesce(bool_and(p.polpermissive
        and p.polroles=array[writer_oid] and (
          (p.polcmd='r' and regexp_replace(coalesce(pg_get_expr(p.polqual,p.polrelid),''),'[()\s]','','g')='user_id=public.cap_request_uid')
          or (p.polcmd='w'
            and regexp_replace(coalesce(pg_get_expr(p.polqual,p.polrelid),''),'[()\s]','','g')='user_id=public.cap_request_uid'
            and regexp_replace(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''),'[()\s]','','g')='user_id=public.cap_request_uid')
          or (p.polcmd='a'
            and regexp_replace(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''),'[()\s]','','g')='user_id=public.cap_request_uid'))),false)
      into lifecycle_policies_ok from pg_policy p
      where p.polrelid='cap_notes_private.note_lifecycle'::regclass and p.polroles=array[writer_oid];
    select count(*)=2 and coalesce(bool_and(p.polpermissive
        and p.polroles=array[writer_oid] and (
          (p.polcmd='r' and regexp_replace(coalesce(pg_get_expr(p.polqual,p.polrelid),''),'[()\s]','','g')='user_id=public.cap_request_uid')
          or (p.polcmd='a'
            and regexp_replace(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''),'[()\s]','','g')='user_id=public.cap_request_uid'))),false)
      into operations_policies_ok from pg_policy p
      where p.polrelid='cap_notes_private.operations'::regclass and p.polroles=array[writer_oid];
  end if;
  policies_ok := coalesce(notes_policies_ok and lifecycle_policies_ok and operations_policies_ok,false)
    and not exists(select 1 from pg_policy p
      where p.polrelid in ('public.notes'::regclass,
        'cap_notes_private.note_lifecycle'::regclass,
        'cap_notes_private.operations'::regclass)
        and p.polroles is distinct from array[writer_oid]
        and not (snapshot_reader_oid is not null
          and p.polroles=array[snapshot_reader_oid] and p.polpermissive
          and p.polcmd='r'
          and p.polrelid in ('public.notes'::regclass,
            'cap_notes_private.note_lifecycle'::regclass)
          and regexp_replace(coalesce(pg_get_expr(p.polqual,p.polrelid),''),'[()\s]','','g')='user_id=public.cap_request_uid'));

  grants_ok := writer_oid is not null
    and has_table_privilege('cap_notes_sidecar_writer','public.notes','SELECT')
    and has_table_privilege('cap_notes_sidecar_writer','public.notes','INSERT')
    and has_table_privilege('cap_notes_sidecar_writer','public.notes','UPDATE')
    and not has_table_privilege('cap_notes_sidecar_writer','public.notes',
      'DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and has_table_privilege('cap_notes_sidecar_writer','cap_notes_private.note_lifecycle','SELECT')
    and has_table_privilege('cap_notes_sidecar_writer','cap_notes_private.note_lifecycle','INSERT')
    and has_table_privilege('cap_notes_sidecar_writer','cap_notes_private.note_lifecycle','UPDATE')
    and not has_table_privilege('cap_notes_sidecar_writer','cap_notes_private.note_lifecycle',
      'DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and has_table_privilege('cap_notes_sidecar_writer','cap_notes_private.operations','SELECT')
    and has_table_privilege('cap_notes_sidecar_writer','cap_notes_private.operations','INSERT')
    and not has_table_privilege('cap_notes_sidecar_writer','cap_notes_private.operations',
      'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('authenticated','public.notes',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('authenticated','cap_notes_private.note_lifecycle',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('authenticated','cap_notes_private.operations',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('anon','public.notes',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('anon','cap_notes_private.note_lifecycle',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('anon','cap_notes_private.operations',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not exists(select 1 from pg_attribute a
      where a.attrelid in ('public.notes'::regclass,
        'cap_notes_private.note_lifecycle'::regclass,
        'cap_notes_private.operations'::regclass)
        and a.attnum>0 and not a.attisdropped
        and (has_column_privilege('authenticated',a.attrelid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES')
          or has_column_privilege('anon',a.attrelid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES')))
    and not exists(select 1 from pg_class c, lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      where c.oid in ('public.notes'::regclass,
        'cap_notes_private.note_lifecycle'::regclass,
        'cap_notes_private.operations'::regclass)
        and acl.grantee=0)
    and case when reader_oid is null then false else has_function_privilege('authenticated',reader_oid,'EXECUTE') end
    and case when writer_fn_oid is null then false else has_function_privilege('authenticated',writer_fn_oid,'EXECUTE') end
    and case when verifier_oid is null then false else has_function_privilege('authenticated',verifier_oid,'EXECUTE') end
    and case when reader_oid is null then false else not has_function_privilege('anon',reader_oid,'EXECUTE') end
    and case when writer_fn_oid is null then false else not has_function_privilege('anon',writer_fn_oid,'EXECUTE') end
    and case when verifier_oid is null then false else not has_function_privilege('anon',verifier_oid,'EXECUTE') end
    and not exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid in (reader_oid,writer_fn_oid,verifier_oid)
        and a.grantee=0 and a.privilege_type='EXECUTE')
    and case when to_regprocedure('cap_notes_private.coverage_ok()') is null
        or writer_oid is null then false
      else has_function_privilege(writer_oid,'cap_notes_private.coverage_ok()','EXECUTE') end
    and not exists(select 1 from pg_proc p
      where p.oid in (to_regprocedure('cap_notes_private.backfill_lifecycle()'),
        to_regprocedure('cap_notes_private.rollback_guard()'),
        to_regprocedure('cap_notes_private.coverage_ok()'))
        and (has_function_privilege('authenticated',p.oid,'EXECUTE')
          or has_function_privilege('anon',p.oid,'EXECUTE')))
    and not exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid in (to_regprocedure('cap_notes_private.backfill_lifecycle()'),
        to_regprocedure('cap_notes_private.rollback_guard()'),
        to_regprocedure('cap_notes_private.coverage_ok()'))
        and a.grantee=0 and a.privilege_type='EXECUTE')
    and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public'
        and p.proname in ('cap_notes_read','cap_notes_change','cap_verify_notes_lifecycle')
        and p.oid is distinct from reader_oid
        and p.oid is distinct from writer_fn_oid
        and p.oid is distinct from verifier_oid);

  select count(*)=3 and coalesce(bool_and(p.prosecdef and p.prokind='f'
      and p.prorettype='jsonb'::regtype
      and p.proconfig @> array['search_path=pg_catalog']
      and p.proowner=writer_oid
      and obj_description(p.oid,'pg_proc')='CAP_NOTES_SIDECAR_V1'
      and ((p.oid=reader_oid and oidvectortypes(p.proargtypes)='uuid' and p.provolatile='s')
        or (p.oid=writer_fn_oid
          and oidvectortypes(p.proargtypes)='uuid, jsonb, text, jsonb, uuid'
          and p.provolatile='v')
        or (p.oid=verifier_oid and p.pronargs=0 and p.provolatile='s'))),false)
    into functions_ok from pg_proc p
    where p.oid in (reader_oid,writer_fn_oid,verifier_oid);

  legacy_lockout_ok := (legacy_cas_oid is null
      or not has_function_privilege('authenticated',legacy_cas_oid,'EXECUTE'))
    and (legacy_verify_oid is null
      or not has_function_privilege('authenticated',legacy_verify_oid,'EXECUTE'));
  coverage_ok := case when to_regprocedure('cap_notes_private.coverage_ok()') is null
      or writer_oid is null then false
    when not has_function_privilege(writer_oid,'cap_notes_private.coverage_ok()','EXECUTE') then false
    else cap_notes_private.coverage_ok() end;
  contract_ready := coalesce(roles_ok and tables_ok and rls_ok and policies_ok and grants_ok
    and functions_ok and legacy_lockout_ok and coverage_ok,false);

  return jsonb_build_object('version','CAP_NOTES_SIDECAR_V1',
    'roles_ok',coalesce(roles_ok,false),'tables_ok',coalesce(tables_ok,false),
    'rls_ok',coalesce(rls_ok,false),'policies_ok',policies_ok,
    'grants_ok',coalesce(grants_ok,false),'functions_ok',coalesce(functions_ok,false),
    'legacy_lockout_ok',legacy_lockout_ok,'coverage_ok',coverage_ok,
    'contract_ready',contract_ready,'ready',false,'production_ready',false);
end $$;
comment on function public.cap_verify_notes_lifecycle() is 'CAP_NOTES_SIDECAR_V1';
alter function public.cap_verify_notes_lifecycle() owner to cap_notes_sidecar_writer;
revoke all on function public.cap_verify_notes_lifecycle() from public,anon;
grant execute on function public.cap_verify_notes_lifecycle()
  to authenticated,cap_notes_sidecar_writer;

create function public.cap_notes_change(
  p_id uuid,
  p_expected jsonb,
  p_action text,
  p_desired jsonb,
  p_operation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path=pg_catalog
as $$
declare
  uid uuid := public.cap_request_uid();
  n public.notes%rowtype;
  l cap_notes_private.note_lifecycle%rowtype;
  receipt cap_notes_private.operations%rowtype;
  candidate jsonb;
  c jsonb;
  lc jsonb;
  current_state jsonb;
  wanted jsonb;
  after_state jsonb;
  desired_date date;
  changed_at timestamptz(3);
begin
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if not coalesce((public.cap_verify_notes_lifecycle()->>'contract_ready')::boolean,false) then
    raise exception 'NOTES_CONTRACT_NOT_READY';
  end if;
  if p_id is null or p_operation_id is null or p_action is null
     or p_action not in ('create','edit','tombstone') then
    raise exception 'INVALID_LIFECYCLE_REQUEST';
  end if;

  if p_action = 'create' then
    if p_expected is not null then raise exception 'INVALID_EXPECTED'; end if;
    if p_desired is null then raise exception 'INVALID_DESIRED_CONTENT'; end if;
  else
    if p_expected is null or jsonb_typeof(p_expected) is distinct from 'object'
       or not(p_expected ?& array['content','lifecycle'])
       or (p_expected-array['content','lifecycle']) <> '{}'::jsonb then
      raise exception 'EXPECTED_LIFECYCLE_REQUIRED';
    end if;
    c := p_expected->'content'; lc := p_expected->'lifecycle';
    if jsonb_typeof(c) is distinct from 'object' then raise exception 'INVALID_NOTE_CONTENT'; end if;
    if jsonb_typeof(lc) is distinct from 'object'
       or not(lc ?& array['version','revision','deleted_at','operation_id'])
       or (lc-array['version','revision','deleted_at','operation_id']) <> '{}'::jsonb
       or lc->'version' is distinct from '1'::jsonb
       or jsonb_typeof(lc->'revision') is distinct from 'number'
       or (lc->>'revision')::numeric not between 1 and 9007199254740991
       or trunc((lc->>'revision')::numeric) <> (lc->>'revision')::numeric
       or (lc->'deleted_at' is distinct from 'null'::jsonb
         and jsonb_typeof(lc->'deleted_at') is distinct from 'string')
       or (lc->'operation_id' is distinct from 'null'::jsonb
         and jsonb_typeof(lc->'operation_id') is distinct from 'string') then
      raise exception 'INVALID_EXPECTED_LIFECYCLE';
    end if;
    if lc->>'deleted_at' is not null then
      if lc->>'deleted_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
         or to_char((lc->>'deleted_at')::timestamptz at time zone 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> lc->>'deleted_at'
         or lc->>'operation_id' is null then
        raise exception 'INVALID_EXPECTED_LIFECYCLE';
      end if;
    end if;
    if lc->>'operation_id' is not null
       and ((lc->>'operation_id')::uuid)::text <> lc->>'operation_id' then
      raise exception 'INVALID_EXPECTED_OPERATION';
    end if;
    if (p_action='tombstone' and p_desired is not null)
       or (p_action='edit' and p_desired is null) then
      raise exception 'INVALID_DESIRED_CONTENT';
    end if;
  end if;

  foreach candidate in array array[c,p_desired] loop
    if candidate is null then continue; end if;
    if jsonb_typeof(candidate) is distinct from 'object'
       or not(candidate ?& array['legacy_id','title','body','note_date'])
       or (candidate-array['legacy_id','title','body','note_date']) <> '{}'::jsonb
       or jsonb_typeof(candidate->'legacy_id') is distinct from 'string'
       or length(btrim(candidate->>'legacy_id'))=0
       or jsonb_typeof(candidate->'title') is distinct from 'string'
       or jsonb_typeof(candidate->'body') is distinct from 'string'
       or (candidate->'note_date' is distinct from 'null'::jsonb
         and jsonb_typeof(candidate->'note_date') is distinct from 'string') then
      raise exception 'INVALID_NOTE_CONTENT';
    end if;
    if candidate->>'note_date' is not null then
      if candidate->>'note_date' !~ '^\d{4}-\d{2}-\d{2}$'
         or ((candidate->>'note_date')::date)::text <> candidate->>'note_date' then
        raise exception 'INVALID_NOTE_DATE';
      end if;
    end if;
  end loop;
  if p_action='edit' and p_desired->>'legacy_id' is distinct from c->>'legacy_id' then
    raise exception 'IDENTITY_CHANGE_NOT_ALLOWED';
  end if;
  if p_desired is not null then desired_date := (p_desired->>'note_date')::date; end if;

  perform pg_advisory_xact_lock(hashtextextended('cap.notes:'||p_id::text,0));
  select * into n from public.notes where id=p_id and user_id=uid for update;
  if found then
    select * into l from cap_notes_private.note_lifecycle
      where note_id=p_id and user_id=uid for update;
    if found then
      current_state := jsonb_build_object(
        'content',jsonb_build_object('legacy_id',n.legacy_id,'title',n.title,
          'body',n.body,'note_date',n.note_date),
        'lifecycle',jsonb_build_object('version',1,'revision',l.revision,
          'deleted_at',case when l.deleted_at is null then null
            else to_char(l.deleted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
          'operation_id',l.operation_id));
    end if;
  end if;

  select * into receipt from cap_notes_private.operations
    where user_id=uid and operation_id=p_operation_id;
  if found then
    if receipt.note_id <> p_id or receipt.action <> p_action
       or receipt.expected is distinct from p_expected
       or receipt.desired is distinct from p_desired then
      raise exception 'OPERATION_REUSE_CONFLICT';
    end if;
    return jsonb_build_object('status',
      case when current_state = receipt.result then 'ALREADY_APPLIED' else 'CONFLICT' end);
  end if;

  if p_action='create' then
    if n.id is not null then return jsonb_build_object('status','CONFLICT'); end if;
    insert into public.notes(id,user_id,legacy_id,title,body,note_date)
      values(p_id,uid,p_desired->>'legacy_id',p_desired->>'title',
        p_desired->>'body',desired_date)
      on conflict (id) do nothing
      returning * into n;
    if not found then return jsonb_build_object('status','CONFLICT'); end if;
    insert into cap_notes_private.note_lifecycle(note_id,user_id,revision,deleted_at,operation_id)
      values(p_id,uid,1,null,p_operation_id);
    wanted := jsonb_build_object('content',p_desired,
      'lifecycle',jsonb_build_object('version',1,'revision',1,
        'deleted_at',null,'operation_id',p_operation_id));
  else
    if n.id is null or l.note_id is null then return jsonb_build_object('status','CONFLICT'); end if;
    if current_state is distinct from p_expected or l.deleted_at is not null then
      return jsonb_build_object('status','CONFLICT');
    end if;
    if l.revision >= 9007199254740991 then raise exception 'LIFECYCLE_REVISION_EXHAUSTED'; end if;
    changed_at := clock_timestamp();
    wanted := jsonb_build_object(
      'content',case when p_action='edit' then p_desired else c end,
      'lifecycle',jsonb_build_object('version',1,'revision',l.revision+1,
        'deleted_at',case when p_action='tombstone'
          then to_char(changed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          else null end,
        'operation_id',p_operation_id));
    if p_action='edit' then
      update public.notes set title=p_desired->>'title',body=p_desired->>'body',
        note_date=desired_date
        where id=p_id and user_id=uid;
    end if;
    update cap_notes_private.note_lifecycle
      set revision=l.revision+1,operation_id=p_operation_id,
        deleted_at=case when p_action='tombstone' then changed_at else null end,
        updated_at=changed_at
      where note_id=p_id and user_id=uid;
  end if;

  after_state := public.cap_notes_read(p_id);
  if after_state is null or after_state is distinct from wanted then
    raise exception 'LIFECYCLE_WRITE_NOT_VERIFIED';
  end if;
  begin
    insert into cap_notes_private.operations(user_id,operation_id,note_id,action,expected,desired,result)
      values(uid,p_operation_id,p_id,p_action,p_expected,p_desired,wanted);
  exception when unique_violation then
    raise exception 'OPERATION_REUSE_CONFLICT';
  end;
  select * into receipt from cap_notes_private.operations
    where user_id=uid and operation_id=p_operation_id;
  if not found or receipt.note_id<>p_id or receipt.action<>p_action
     or receipt.expected is distinct from p_expected
     or receipt.desired is distinct from p_desired
     or receipt.result is distinct from wanted then
    raise exception 'OPERATION_RECEIPT_NOT_VERIFIED';
  end if;
  return jsonb_build_object('status','APPLIED');
exception
  when invalid_text_representation or datetime_field_overflow
    or invalid_datetime_format or numeric_value_out_of_range then
    raise exception 'INVALID_LIFECYCLE_REQUEST';
end $$;
comment on function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)
  is 'CAP_NOTES_SIDECAR_V1';
alter function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)
  owner to cap_notes_sidecar_writer;
revoke all on function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)
  from public,anon;
grant execute on function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)
  to authenticated,cap_notes_sidecar_writer;

revoke create on schema public from cap_notes_sidecar_writer;
do $$ begin execute format('revoke cap_notes_sidecar_writer from %I',current_user); end $$;
do $$ begin
  if not public.cap_role_boundary_ok('cap_notes_sidecar_writer'::regrole) then
    raise exception 'NOTES_INSTALL_ROLE_BOUNDARY_FAILED';
  end if;
end $$;
commit;
