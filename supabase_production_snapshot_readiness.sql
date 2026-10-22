-- Phase 6L DRAFT: prepare/review only. NOT authorized for production deployment.
-- Prerequisite: guarded supabase_production_identity.sql (Cap-owned identity).
-- Also requires supabase_production_role_boundary.sql (PG16+ admin membership).
-- First-install, dependency-ordered script, not an idempotent migration:
--   1. prepared private notes sidecar and cap_notes_change must already exist;
--   2. supabase_production_transaction_create.sql must already be installed;
--   3. this script installs the owner-scoped snapshot reader and readiness RPC.
-- Installation does not insert, update or delete any application row. It does
-- NOT revoke existing client table grants, legacy RPCs or direct writers. Those
-- cutover actions remain mandatory; readiness reports them as not ready.
-- Guard (explicitly set by the isolated harness or reviewed installer):
--   SET cap.snapshot_readiness_install = 'reviewed-draft-only';
begin;
do $$
declare
  t text;
  public_tables text[] := array['profiles','user_preferences','categories','accounts','goals',
    'debts','bills','account_statements','transactions','transfers','bill_payments','budgets','notes'];
begin
  if current_setting('cap.snapshot_readiness_install',true) is distinct from 'reviewed-draft-only' then
    raise exception 'SNAPSHOT_INSTALL_NOT_APPROVED';
  end if;
  if to_regprocedure('public.cap_request_identity_ok()') is null
     or to_regprocedure('public.cap_role_boundary_ok(oid)') is null then
    raise exception 'IDENTITY_AND_ROLE_BOUNDARY_PREREQUISITES_REQUIRED';
  end if;
  if not public.cap_request_identity_ok() then raise exception 'REQUEST_IDENTITY_NOT_VERIFIED'; end if;
  if exists(select 1 from pg_roles where rolname='cap_sync_reader')
     or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname in ('cap_sync_snapshot_v1','cap_verify_production_sync_v1')) then
    raise exception 'SNAPSHOT_INSTALL_TARGET_NOT_EMPTY';
  end if;
  if to_regclass('cap_sync_private.transaction_create_receipts') is null
     or to_regclass('cap_notes_private.note_lifecycle') is null
     or to_regclass('cap_notes_private.operations') is null
     or to_regprocedure('public.cap_sync_transaction_create(uuid,jsonb,jsonb)') is null
     or to_regprocedure('public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)') is null then
    raise exception 'SNAPSHOT_DEPENDENCIES_REQUIRED';
  end if;
  foreach t in array public_tables loop
    if to_regclass(format('public.%I',t)) is null then raise exception 'SNAPSHOT_DEPENDENCIES_REQUIRED'; end if;
    if not (select relrowsecurity from pg_class where oid=format('public.%I',t)::regclass) then
      raise exception 'SNAPSHOT_TABLE_RLS_REQUIRED';
    end if;
  end loop;
  if not (select relforcerowsecurity from pg_class where oid='public.notes'::regclass)
     or not (select relforcerowsecurity from pg_class where oid='cap_notes_private.note_lifecycle'::regclass)
     or not (select relforcerowsecurity from pg_class where oid='cap_notes_private.operations'::regclass)
     or not (select relforcerowsecurity from pg_class where oid='cap_sync_private.transaction_create_receipts'::regclass) then
    raise exception 'SNAPSHOT_PRIVATE_RLS_REQUIRED';
  end if;
  if (select count(*) from information_schema.columns where table_schema='cap_notes_private'
        and table_name='note_lifecycle' and column_name in ('note_id','user_id','revision','deleted_at','operation_id')) <> 5
     or (select count(*) from information_schema.columns where table_schema='cap_notes_private'
        and table_name='operations' and column_name in ('user_id','operation_id','note_id','action','expected','desired','result')) <> 7 then
    raise exception 'SNAPSHOT_DEPENDENCIES_REQUIRED';
  end if;
end $$;

create role cap_sync_reader nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
-- Temporary membership and CREATE let a non-superuser installer assign
-- function ownership. Both are revoked before commit.
do $$ begin execute format('grant cap_sync_reader to %I with admin false, inherit true, set true',current_user); end $$;
grant usage, create on schema public to cap_sync_reader;
grant usage on schema cap_notes_private, cap_sync_private to cap_sync_reader;
grant execute on function public.cap_request_uid(),public.cap_request_identity_ok(),public.cap_role_boundary_ok(oid) to cap_sync_reader;

grant select on table public.profiles, public.user_preferences, public.categories, public.accounts,
  public.goals, public.debts, public.bills, public.account_statements, public.transactions,
  public.transfers, public.bill_payments, public.budgets, public.notes to cap_sync_reader;
grant select on cap_notes_private.note_lifecycle to cap_sync_reader;

create policy snapshot_reader_profile_read on public.profiles
  for select to cap_sync_reader using(id=public.cap_request_uid());
do $$
declare
  t text;
  public_tables text[] := array['user_preferences','categories','accounts','goals','debts','bills',
    'account_statements','transactions','transfers','bill_payments','budgets','notes'];
begin
  foreach t in array public_tables loop
    execute format('create policy %I on public.%I for select to cap_sync_reader using(user_id=public.cap_request_uid())',
      'snapshot_reader_' || t || '_read', t);
  end loop;
end $$;
create policy snapshot_reader_lifecycle_read on cap_notes_private.note_lifecycle
  for select to cap_sync_reader using(user_id=public.cap_request_uid());

-- One statement, one READ COMMITTED snapshot. Every synchronized entity and
-- singleton is read, including empty collections. Notes require the complete
-- lifecycle v1 sidecar; missing/orphan lifecycle rows reject the response.
create function public.cap_sync_snapshot_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog
set timezone='UTC'
as $$
declare
  uid uuid;
  payload jsonb;
  t text;
  table_names text[] := array['public.profiles','public.user_preferences','public.categories',
    'public.accounts','public.goals','public.debts','public.bills','public.account_statements',
    'public.transactions','public.transfers','public.bill_payments','public.budgets','public.notes',
    'cap_notes_private.note_lifecycle'];
begin
  uid := public.cap_request_uid();
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.cap_request_identity_ok() or current_user <> 'cap_sync_reader'
     or not exists(select 1 from pg_roles r where r.rolname=current_user
       and not r.rolcanlogin and not r.rolinherit and not r.rolsuper and not r.rolbypassrls
       and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication)
     or not public.cap_role_boundary_ok(current_user::regrole)
     or exists(select 1 from pg_roles where rolname in ('anon','authenticated')
       and (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication))
     or has_schema_privilege(current_user,'public','CREATE')
     or has_schema_privilege(current_user,'cap_notes_private','CREATE')
     or has_schema_privilege(current_user,'cap_sync_private','CREATE')
     or has_schema_privilege('anon','cap_notes_private','USAGE')
     or has_schema_privilege('authenticated','cap_notes_private','USAGE')
     or has_table_privilege('anon','public.notes','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('authenticated','public.notes','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('anon','cap_notes_private.note_lifecycle','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('authenticated','cap_notes_private.note_lifecycle','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('anon','cap_notes_private.operations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('authenticated','cap_notes_private.operations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_function_privilege('anon','public.cap_sync_snapshot_v1()','EXECUTE')
     or exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       where p.oid='public.cap_sync_snapshot_v1()'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE')
     or not (select relforcerowsecurity from pg_class where oid='public.notes'::regclass)
     or not (select relforcerowsecurity from pg_class where oid='cap_notes_private.note_lifecycle'::regclass)
     or exists(select 1 from pg_class where oid in ('public.notes'::regclass,
       'cap_notes_private.note_lifecycle'::regclass) and relowner=current_user::regrole) then
    raise exception 'SNAPSHOT_CONTRACT_NOT_VERIFIED';
  end if;

  foreach t in array table_names loop
    if not exists(select 1 from pg_class c where c.oid=t::regclass and c.relrowsecurity)
       or not has_table_privilege(current_user,t,'SELECT')
       or not exists(select 1 from pg_policy p where p.polrelid=t::regclass and p.polpermissive
         and p.polcmd in ('r','*') and p.polroles @> array[current_user::regrole::oid]) then
      raise exception 'SNAPSHOT_CONTRACT_NOT_VERIFIED';
    end if;
  end loop;

  with
    profile_rows as (
      select 'profiles'::text entity, jsonb_build_object('entity','profiles','row',to_jsonb(p)) rec
      from public.profiles p where p.id=uid
    ),
    preference_rows as (
      select 'user_preferences'::text entity,
        jsonb_build_object('entity','user_preferences','row',to_jsonb(x)) rec
      from public.user_preferences x where x.user_id=uid
    ),
    category_rows as (
      select 'categories'::text entity, jsonb_build_object('entity','categories','row',to_jsonb(x)) rec
      from public.categories x where x.user_id=uid
    ),
    account_rows as (
      select 'accounts'::text entity, jsonb_build_object('entity','accounts','row',to_jsonb(x)) rec
      from public.accounts x where x.user_id=uid
    ),
    goal_rows as (
      select 'goals'::text entity, jsonb_build_object('entity','goals','row',to_jsonb(x)) rec
      from public.goals x where x.user_id=uid
    ),
    debt_rows as (
      select 'debts'::text entity, jsonb_build_object('entity','debts','row',to_jsonb(x)) rec
      from public.debts x where x.user_id=uid
    ),
    bill_rows as (
      select 'bills'::text entity, jsonb_build_object('entity','bills','row',to_jsonb(x)) rec
      from public.bills x where x.user_id=uid
    ),
    statement_rows as (
      select 'account_statements'::text entity,
        jsonb_build_object('entity','account_statements','row',to_jsonb(x)) rec
      from public.account_statements x where x.user_id=uid
    ),
    transaction_rows as (
      select 'transactions'::text entity,
        jsonb_build_object('entity','transactions','row',to_jsonb(x)) rec
      from public.transactions x where x.user_id=uid
    ),
    transfer_rows as (
      select 'transfers'::text entity, jsonb_build_object('entity','transfers','row',to_jsonb(x)) rec
      from public.transfers x where x.user_id=uid
    ),
    payment_rows as (
      select 'bill_payments'::text entity,
        jsonb_build_object('entity','bill_payments','row',to_jsonb(x)) rec
      from public.bill_payments x where x.user_id=uid
    ),
    budget_rows as (
      select 'budgets'::text entity, jsonb_build_object('entity','budgets','row',to_jsonb(x)) rec
      from public.budgets x where x.user_id=uid
    ),
    note_rows as (
      select 'notes'::text entity,
        jsonb_build_object('entity','notes','row',to_jsonb(n),
          'lifecycle',jsonb_build_object('version',1,'revision',l.revision,
            'deleted_at',case when l.deleted_at is null then null else
              to_char(l.deleted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
            'operation_id',l.operation_id)) rec
      from public.notes n
      join cap_notes_private.note_lifecycle l
        on l.note_id=n.id and l.user_id=n.user_id
      where n.user_id=uid
    ),
    records as (
      select entity,rec from profile_rows union all
      select entity,rec from preference_rows union all
      select entity,rec from category_rows union all
      select entity,rec from account_rows union all
      select entity,rec from goal_rows union all
      select entity,rec from debt_rows union all
      select entity,rec from bill_rows union all
      select entity,rec from statement_rows union all
      select entity,rec from transaction_rows union all
      select entity,rec from transfer_rows union all
      select entity,rec from payment_rows union all
      select entity,rec from budget_rows union all
      select entity,rec from note_rows
    ),
    counts as (
      select 'profiles'::text entity,count(*) n from profile_rows union all
      select 'user_preferences',count(*) from preference_rows union all
      select 'categories',count(*) from category_rows union all
      select 'accounts',count(*) from account_rows union all
      select 'goals',count(*) from goal_rows union all
      select 'debts',count(*) from debt_rows union all
      select 'bills',count(*) from bill_rows union all
      select 'account_statements',count(*) from statement_rows union all
      select 'transactions',count(*) from transaction_rows union all
      select 'transfers',count(*) from transfer_rows union all
      select 'bill_payments',count(*) from payment_rows union all
      select 'budgets',count(*) from budget_rows union all
      select 'notes',count(*) from note_rows
    )
  select jsonb_build_object(
    'version','CAP_SYNC_SNAPSHOT_V1',
    'owner',uid,
    'complete',
      not exists(select 1 from public.notes n where n.user_id=uid
        and not exists(select 1 from cap_notes_private.note_lifecycle l
          where l.note_id=n.id and l.user_id=n.user_id))
      and not exists(select 1 from cap_notes_private.note_lifecycle l where l.user_id=uid
        and not exists(select 1 from public.notes n where n.id=l.note_id and n.user_id=l.user_id)),
    'record_count',(select count(*) from records),
    'counts',(select jsonb_object_agg(entity,n) from counts),
    'records',coalesce((select jsonb_agg(rec order by entity, rec->'row'->>'id', rec->'row'->>'user_id')
      from records),'[]'::jsonb)
  ) into payload;

  if not coalesce((payload->>'complete')::boolean,false) then
    raise exception 'SNAPSHOT_SIDECAR_INCOMPLETE';
  end if;
  if octet_length(payload::text) > 8388608 then
    raise exception 'SNAPSHOT_TOO_LARGE';
  end if;
  return payload;
exception
  when insufficient_privilege then raise exception 'SNAPSHOT_CONTRACT_NOT_VERIFIED';
  when others then
    if SQLSTATE='P0001' and SQLERRM=any(array[
      'AUTH_REQUIRED','SNAPSHOT_CONTRACT_NOT_VERIFIED','SNAPSHOT_SIDECAR_INCOMPLETE',
      'SNAPSHOT_TOO_LARGE']) then raise;
    end if;
    raise exception 'SNAPSHOT_FAILED';
end $$;
comment on function public.cap_sync_snapshot_v1() is 'CAP_SYNC_SNAPSHOT_V1';

-- Metadata-only readiness. This function never reads note/financial rows and
-- never invokes a mutation RPC. Every flag is derived from catalogs, function
-- bodies/comments, role attributes, grants, RLS and receipt contracts.
create function public.cap_verify_production_sync_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog
as $$
declare
  uid uuid;
  reader_oid oid := (select oid from pg_roles where rolname='cap_sync_reader');
  tx_writer_oid oid := (select oid from pg_roles where rolname='cap_transaction_writer');
  notes_writer_oid oid := (select oid from pg_roles where rolname='cap_notes_sidecar_writer');
  snapshot_oid oid := to_regprocedure('public.cap_sync_snapshot_v1()');
  readiness_oid oid := to_regprocedure('public.cap_verify_production_sync_v1()');
  tx_oid oid := to_regprocedure('public.cap_sync_transaction_create(uuid,jsonb,jsonb)');
  notes_oid oid := to_regprocedure('public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)');
  notes_read_oid oid := to_regprocedure('public.cap_notes_read(uuid)');
  notes_verify_oid oid := to_regprocedure('public.cap_verify_notes_lifecycle()');
  legacy_tx_oid oid := to_regprocedure('public.cap_test_transaction_create(uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb)');
  legacy_tx_verify_oid oid := to_regprocedure('public.cap_verify_transaction_rpc()');
  legacy_note_put_oid oid := to_regprocedure('public.cap_sync_note_put(uuid,jsonb,jsonb)');
  legacy_note_verify_oid oid := to_regprocedure('public.cap_verify_notes_rpc()');
  snapshot_contract boolean := false;
  snapshot_read_access boolean := false;
  readiness_contract boolean := false;
  transaction_create_contract boolean := false;
  durable_receipts boolean := false;
  notes_receipts boolean := false;
  notes_sidecar boolean := false;
  notes_change_contract boolean := false;
  notes_read_contract boolean := false;
  notes_verify_contract boolean := false;
  rpc_only_reads boolean := false;
  legacy_lockout boolean := false;
  writer_privileges boolean := false;
  service_role_private boolean := false;
  reader_safe boolean := false;
  tx_safe boolean := false;
  notes_safe boolean := false;
  client_roles_safe boolean := false;
  checks jsonb;
  contracts jsonb;
  is_ready boolean;
begin
  uid := public.cap_request_uid();
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;

  if reader_oid is not null then
    select exists(select 1 from pg_roles r where r.oid=reader_oid
        and not r.rolcanlogin and not r.rolinherit and not r.rolsuper and not r.rolbypassrls
        and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication)
      and public.cap_role_boundary_ok(reader_oid)
      and not pg_has_role('authenticated',reader_oid,'MEMBER')
      and not pg_has_role('anon',reader_oid,'MEMBER')
      and has_schema_privilege(reader_oid,'cap_notes_private','USAGE')
      and not has_schema_privilege(reader_oid,'cap_notes_private','CREATE')
      and not has_schema_privilege(reader_oid,'cap_sync_private','CREATE')
      and not has_schema_privilege(reader_oid,'public','CREATE')
    into reader_safe;
  end if;
  if tx_writer_oid is not null then
    select exists(select 1 from pg_roles r where r.oid=tx_writer_oid
        and not r.rolcanlogin and not r.rolinherit and not r.rolsuper and not r.rolbypassrls
        and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication)
      and public.cap_role_boundary_ok(tx_writer_oid)
      and not pg_has_role('authenticated',tx_writer_oid,'MEMBER')
      and not pg_has_role('anon',tx_writer_oid,'MEMBER')
      and has_schema_privilege(tx_writer_oid,'cap_sync_private','USAGE')
      and not has_schema_privilege(tx_writer_oid,'cap_sync_private','CREATE')
      and not has_schema_privilege(tx_writer_oid,'public','CREATE')
    into tx_safe;
  end if;
  if notes_writer_oid is not null then
    select exists(select 1 from pg_roles r where r.oid=notes_writer_oid
        and not r.rolcanlogin and not r.rolinherit and not r.rolsuper and not r.rolbypassrls
        and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication)
      and public.cap_role_boundary_ok(notes_writer_oid)
      and not pg_has_role('authenticated',notes_writer_oid,'MEMBER')
      and not pg_has_role('anon',notes_writer_oid,'MEMBER')
      and has_schema_privilege(notes_writer_oid,'cap_notes_private','USAGE')
      and not has_schema_privilege(notes_writer_oid,'cap_notes_private','CREATE')
      and not has_schema_privilege(notes_writer_oid,'public','CREATE')
    into notes_safe;
  end if;
  client_roles_safe := not exists(select 1 from pg_roles where rolname in ('anon','authenticated')
    and (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication));
  writer_privileges := public.cap_request_identity_ok() and coalesce(reader_safe and tx_safe and notes_safe and client_roles_safe,false);
  -- Reject a mixed old/new deployment even when the RPC version comments
  -- match: every custom-role function AND policy must use Cap identity.
  writer_privileges := writer_privileges
    and not exists(select 1 from pg_proc p where p.oid in
      (snapshot_oid,readiness_oid,tx_oid,notes_oid,notes_read_oid,notes_verify_oid)
      and p.prosrc like ('%auth.' || 'uid%'))
    and not exists(select 1 from pg_policy p
      where p.polroles && array[reader_oid,tx_writer_oid,notes_writer_oid]
        and (coalesce(pg_get_expr(p.polqual,p.polrelid),'') like ('%auth.' || 'uid%')
          or coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'') like ('%auth.' || 'uid%')))
    and not exists(select 1 from pg_roles r
      where r.oid in (reader_oid,tx_writer_oid,notes_writer_oid)
        and (not has_function_privilege(r.oid,'public.cap_request_uid()','EXECUTE')
          or not has_function_privilege(r.oid,'public.cap_request_identity_ok()','EXECUTE')));
  writer_privileges := writer_privileges and not exists(select 1 from pg_roles r
    where r.oid in (reader_oid,tx_writer_oid,notes_writer_oid)
      and not has_function_privilege(r.oid,'public.cap_role_boundary_ok(oid)','EXECUTE'));

  select p.prokind='f' and l.lanname='plpgsql' and p.pronargs=0
      and p.prorettype='jsonb'::regtype and p.provolatile='s' and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog']
      and exists(select 1 from unnest(p.proconfig) c where lower(c)='timezone=utc')
      and p.proowner=reader_oid
      and obj_description(p.oid,'pg_proc')='CAP_SYNC_SNAPSHOT_V1'
      and has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not exists(select 1 from pg_proc q, lateral aclexplode(coalesce(q.proacl,acldefault('f',q.proowner))) a
        where q.oid=p.oid and a.grantee=0 and a.privilege_type='EXECUTE')
    into snapshot_contract
    from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=snapshot_oid;
  snapshot_contract := coalesce(snapshot_contract,false);

  snapshot_read_access := reader_oid is not null
    and not exists(
      select 1 from unnest(array['public.profiles','public.user_preferences','public.categories',
        'public.accounts','public.goals','public.debts','public.bills','public.account_statements',
        'public.transactions','public.transfers','public.bill_payments','public.budgets','public.notes',
        'cap_notes_private.note_lifecycle']) t(name)
      where not has_table_privilege(reader_oid,t.name,'SELECT')
        or not exists(select 1 from pg_class c where c.oid=t.name::regclass and c.relrowsecurity)
        or not exists(select 1 from pg_policy p where p.polrelid=t.name::regclass and p.polpermissive
          and p.polcmd in ('r','*') and p.polroles @> array[reader_oid]))
    and not exists(select 1 from pg_class where oid in ('public.notes'::regclass,
      'cap_notes_private.note_lifecycle'::regclass) and not relforcerowsecurity);

  select p.prokind='f' and l.lanname='plpgsql' and p.pronargs=0
      and p.prorettype='jsonb'::regtype and p.provolatile='s' and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog']
      and p.proowner=reader_oid
      and obj_description(p.oid,'pg_proc')='CAP_PRODUCTION_SYNC_READINESS_V1'
      and has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not exists(select 1 from pg_proc q, lateral aclexplode(coalesce(q.proacl,acldefault('f',q.proowner))) a
        where q.oid=p.oid and a.grantee=0 and a.privilege_type='EXECUTE')
    into readiness_contract
    from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=readiness_oid;
  readiness_contract := coalesce(readiness_contract,false);

  select p.prokind='f' and l.lanname='plpgsql' and p.prorettype='jsonb'::regtype
      and oidvectortypes(p.proargtypes)='uuid, jsonb, jsonb'
      and p.provolatile='v' and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog']
      and exists(select 1 from unnest(p.proconfig) c where lower(c)='timezone=utc')
      and p.proowner=tx_writer_oid
      and obj_description(p.oid,'pg_proc')='CAP_TX_CREATE_CAS_RECEIPT_V1'
      and has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not exists(select 1 from pg_proc q, lateral aclexplode(coalesce(q.proacl,acldefault('f',q.proowner))) a
        where q.oid=p.oid and a.grantee=0 and a.privilege_type='EXECUTE')
      and case when tx_writer_oid is null then false else
        has_table_privilege(tx_writer_oid,'public.transactions','INSERT')
        and has_table_privilege(tx_writer_oid,'public.accounts','SELECT')
        and has_column_privilege(tx_writer_oid,'public.accounts','balance','UPDATE')
        and has_table_privilege(tx_writer_oid,'public.categories','SELECT') end
    into transaction_create_contract
    from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=tx_oid;
  transaction_create_contract := coalesce(transaction_create_contract,false);

  durable_receipts := to_regclass('cap_sync_private.transaction_create_receipts') is not null
    and exists(select 1 from pg_class c where c.oid='cap_sync_private.transaction_create_receipts'::regclass
      and c.relrowsecurity and c.relforcerowsecurity)
    and exists(select 1 from pg_constraint where conrelid='cap_sync_private.transaction_create_receipts'::regclass
      and contype='p')
    and case when tx_writer_oid is null then false else
      has_table_privilege(tx_writer_oid,'cap_sync_private.transaction_create_receipts','SELECT')
      and has_table_privilege(tx_writer_oid,'cap_sync_private.transaction_create_receipts','INSERT')
      and not has_table_privilege(tx_writer_oid,'cap_sync_private.transaction_create_receipts',
        'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') end
    and not has_table_privilege('authenticated','cap_sync_private.transaction_create_receipts',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('anon','cap_sync_private.transaction_create_receipts',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not exists(select 1 from pg_class c, lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where c.oid='cap_sync_private.transaction_create_receipts'::regclass and a.grantee=0);

  notes_receipts := to_regclass('cap_notes_private.operations') is not null
    and exists(select 1 from pg_class c where c.oid='cap_notes_private.operations'::regclass
      and c.relrowsecurity and c.relforcerowsecurity)
    and exists(select 1 from pg_constraint where conrelid='cap_notes_private.operations'::regclass
      and contype='p')
    and case when notes_writer_oid is null then false else
      has_table_privilege(notes_writer_oid,'cap_notes_private.operations','SELECT')
      and has_table_privilege(notes_writer_oid,'cap_notes_private.operations','INSERT')
      and not has_table_privilege(notes_writer_oid,'cap_notes_private.operations',
        'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') end
    and not has_table_privilege('authenticated','cap_notes_private.operations',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('anon','cap_notes_private.operations',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');

  notes_change_contract := notes_oid is not null
    and exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=notes_oid
      and p.prokind='f' and l.lanname='plpgsql' and p.prorettype='jsonb'::regtype
      and oidvectortypes(p.proargtypes)='uuid, jsonb, text, jsonb, uuid'
      and p.provolatile='v' and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog']
      and p.proowner=notes_writer_oid
      and obj_description(p.oid,'pg_proc')='CAP_NOTES_SIDECAR_V1'
      and has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not exists(select 1 from pg_proc q, lateral aclexplode(coalesce(q.proacl,acldefault('f',q.proowner))) a
        where q.oid=p.oid and a.grantee=0 and a.privilege_type='EXECUTE'));

  notes_read_contract := notes_read_oid is not null
    and exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=notes_read_oid
      and p.prokind='f' and p.prorettype='jsonb'::regtype
      and oidvectortypes(p.proargtypes)='uuid'
      and p.provolatile='s' and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog']
      and p.proowner=notes_writer_oid
      and obj_description(p.oid,'pg_proc')='CAP_NOTES_SIDECAR_V1'
      and has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not exists(select 1 from pg_proc q, lateral aclexplode(coalesce(q.proacl,acldefault('f',q.proowner))) a
        where q.oid=p.oid and a.grantee=0 and a.privilege_type='EXECUTE'));

  notes_verify_contract := notes_verify_oid is not null
    and exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=notes_verify_oid
      and p.prokind='f' and l.lanname='plpgsql' and p.pronargs=0
      and p.prorettype='jsonb'::regtype and p.provolatile='s' and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog']
      and p.proowner=notes_writer_oid
      and obj_description(p.oid,'pg_proc')='CAP_NOTES_SIDECAR_V1'
      and has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not exists(select 1 from pg_proc q, lateral aclexplode(coalesce(q.proacl,acldefault('f',q.proowner))) a
        where q.oid=p.oid and a.grantee=0 and a.privilege_type='EXECUTE'));

  notes_sidecar := to_regclass('cap_notes_private.note_lifecycle') is not null
    and to_regclass('cap_notes_private.operations') is not null
    and to_regclass('public.notes') is not null
    and not exists(select 1 from pg_class where oid in ('public.notes'::regclass,
      'cap_notes_private.note_lifecycle'::regclass,'cap_notes_private.operations'::regclass)
      and not (relrowsecurity and relforcerowsecurity))
    and notes_change_contract and notes_read_contract and notes_verify_contract
    and case when notes_writer_oid is null then false else
      has_table_privilege(notes_writer_oid,'public.notes','SELECT')
      and has_table_privilege(notes_writer_oid,'public.notes','INSERT')
      and has_table_privilege(notes_writer_oid,'public.notes','UPDATE')
      and not has_table_privilege(notes_writer_oid,'public.notes','DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and has_table_privilege(notes_writer_oid,'cap_notes_private.note_lifecycle','SELECT')
      and has_table_privilege(notes_writer_oid,'cap_notes_private.note_lifecycle','INSERT')
      and has_table_privilege(notes_writer_oid,'cap_notes_private.note_lifecycle','UPDATE')
      and not has_table_privilege(notes_writer_oid,'cap_notes_private.note_lifecycle','DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and has_table_privilege(notes_writer_oid,'cap_notes_private.operations','SELECT')
      and has_table_privilege(notes_writer_oid,'cap_notes_private.operations','INSERT')
      and not has_table_privilege(notes_writer_oid,'cap_notes_private.operations','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') end
    and not has_table_privilege('authenticated','public.notes',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('anon','public.notes',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('authenticated','cap_notes_private.note_lifecycle',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('anon','cap_notes_private.note_lifecycle',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('authenticated','cap_notes_private.operations',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('anon','cap_notes_private.operations',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');

  rpc_only_reads := not exists(
    select 1 from pg_class c where c.oid in ('public.profiles'::regclass,
      'public.user_preferences'::regclass,'public.categories'::regclass,'public.accounts'::regclass,
      'public.goals'::regclass,'public.debts'::regclass,'public.bills'::regclass,
      'public.account_statements'::regclass,'public.transactions'::regclass,
      'public.transfers'::regclass,'public.bill_payments'::regclass,'public.budgets'::regclass,
      'public.notes'::regclass)
      and (has_table_privilege('authenticated',c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_table_privilege('anon',c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
    and not exists(
      select 1 from pg_attribute a where a.attrelid in ('public.profiles'::regclass,
        'public.user_preferences'::regclass,'public.categories'::regclass,'public.accounts'::regclass,
        'public.goals'::regclass,'public.debts'::regclass,'public.bills'::regclass,
        'public.account_statements'::regclass,'public.transactions'::regclass,
        'public.transfers'::regclass,'public.bill_payments'::regclass,'public.budgets'::regclass,
        'public.notes'::regclass)
        and a.attnum>0 and not a.attisdropped
        and (has_column_privilege('authenticated',a.attrelid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES')
          or has_column_privilege('anon',a.attrelid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES')))
    and not exists(
      select 1 from pg_class c, lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      where c.oid in ('public.profiles'::regclass,'public.user_preferences'::regclass,
        'public.categories'::regclass,'public.accounts'::regclass,'public.goals'::regclass,
        'public.debts'::regclass,'public.bills'::regclass,'public.account_statements'::regclass,
        'public.transactions'::regclass,'public.transfers'::regclass,
        'public.bill_payments'::regclass,'public.budgets'::regclass,'public.notes'::regclass)
        and acl.grantee=0)
    and not exists(
      select 1 from pg_policy p
      where p.polrelid in ('public.profiles'::regclass,'public.user_preferences'::regclass,
        'public.categories'::regclass,'public.accounts'::regclass,'public.goals'::regclass,
        'public.debts'::regclass,'public.bills'::regclass,'public.account_statements'::regclass,
        'public.transactions'::regclass,'public.transfers'::regclass,
        'public.bill_payments'::regclass,'public.budgets'::regclass,'public.notes'::regclass)
        and (0=any(p.polroles) or exists(select 1 from pg_roles r
          where r.rolname in ('anon','authenticated') and r.oid=any(p.polroles))))
    and not has_schema_privilege('authenticated','cap_notes_private','USAGE')
    and not has_schema_privilege('anon','cap_notes_private','USAGE')
    and not has_schema_privilege('authenticated','cap_sync_private','USAGE')
    and not has_schema_privilege('anon','cap_sync_private','USAGE')
    and not has_schema_privilege('authenticated','public','CREATE')
    and not has_schema_privilege('anon','public','CREATE');

  legacy_lockout := case when legacy_tx_oid is null then true else
      not has_function_privilege('authenticated',legacy_tx_oid,'EXECUTE') end
    and case when legacy_tx_verify_oid is null then true else
      not has_function_privilege('authenticated',legacy_tx_verify_oid,'EXECUTE') end
    and case when legacy_note_put_oid is null then true else
      not has_function_privilege('authenticated',legacy_note_put_oid,'EXECUTE') end
    and case when legacy_note_verify_oid is null then true else
      not has_function_privilege('authenticated',legacy_note_verify_oid,'EXECUTE') end
    and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'cap\_test\_%'
        and (has_function_privilege('authenticated',p.oid,'EXECUTE')
          or has_function_privilege('anon',p.oid,'EXECUTE')));

  if exists(select 1 from pg_roles where rolname='service_role') then
    service_role_private := not has_schema_privilege('service_role','cap_notes_private','USAGE')
      and not has_schema_privilege('service_role','cap_sync_private','USAGE')
      and not has_table_privilege('service_role','cap_notes_private.note_lifecycle',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege('service_role','cap_notes_private.operations',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege('service_role','cap_sync_private.transaction_create_receipts',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  else
    service_role_private := true;
  end if;

  checks := jsonb_build_object(
    'snapshot_contract',coalesce(snapshot_contract,false),
    'snapshot_read_access',coalesce(snapshot_read_access,false),
    'readiness_contract',coalesce(readiness_contract,false),
    'transaction_create_contract',coalesce(transaction_create_contract,false),
    'durable_receipts',coalesce(durable_receipts,false),
    'notes_receipts',coalesce(notes_receipts,false),
    'notes_sidecar',coalesce(notes_sidecar,false),
    'rpc_only_reads',coalesce(rpc_only_reads,false),
    'legacy_lockout',coalesce(legacy_lockout,false),
    'writer_privileges',coalesce(writer_privileges,false),
    'service_role_private',coalesce(service_role_private,false));
  is_ready := coalesce(snapshot_contract and snapshot_read_access and readiness_contract
    and transaction_create_contract and durable_receipts and notes_receipts and notes_sidecar
    and rpc_only_reads and legacy_lockout and writer_privileges and service_role_private,false);
  contracts := jsonb_build_object(
    'readiness',case when coalesce(readiness_contract,false)
      then 'CAP_PRODUCTION_SYNC_READINESS_V1' else null end,
    'snapshot',case when coalesce(snapshot_contract,false)
      then 'CAP_SYNC_SNAPSHOT_V1' else null end,
    'transaction_create',case when coalesce(transaction_create_contract,false)
      then 'CAP_TX_CREATE_CAS_RECEIPT_V1' else null end,
    'notes_change',case when coalesce(notes_change_contract,false)
      then 'CAP_NOTES_SIDECAR_V1' else null end);
  return jsonb_build_object(
    'version','CAP_PRODUCTION_SYNC_V1',
    'ready',is_ready,
    'legacy_lockout',coalesce(legacy_lockout,false),
    'private_sidecar',coalesce(notes_sidecar,false),
    'rpc_only_reads',coalesce(rpc_only_reads,false),
    'writer_bypassrls',not coalesce(writer_privileges,false),
    'atomic_transaction_create',coalesce(transaction_create_contract and durable_receipts,false),
    'durable_operation_receipts',coalesce(durable_receipts and notes_receipts,false),
    'checks',checks,
    'contracts',contracts);
exception
  when insufficient_privilege then raise exception 'READINESS_CONTRACT_NOT_VERIFIED';
  when others then
    if SQLSTATE='P0001' and SQLERRM=any(array['AUTH_REQUIRED','READINESS_CONTRACT_NOT_VERIFIED']) then raise; end if;
    raise exception 'READINESS_FAILED';
end $$;
comment on function public.cap_verify_production_sync_v1() is 'CAP_PRODUCTION_SYNC_READINESS_V1';

revoke all on function public.cap_sync_snapshot_v1() from public, anon, authenticated;
revoke all on function public.cap_verify_production_sync_v1() from public, anon, authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'revoke all on function public.cap_sync_snapshot_v1() from service_role';
    execute 'revoke all on function public.cap_verify_production_sync_v1() from service_role';
  end if;
end $$;
alter function public.cap_sync_snapshot_v1() owner to cap_sync_reader;
alter function public.cap_verify_production_sync_v1() owner to cap_sync_reader;
grant execute on function public.cap_sync_snapshot_v1() to authenticated;
grant execute on function public.cap_verify_production_sync_v1() to authenticated;
revoke create on schema public from cap_sync_reader;
do $$ begin execute format('revoke cap_sync_reader from %I',current_user); end $$;
do $$ begin
  if not public.cap_role_boundary_ok('cap_sync_reader'::regrole) then
    raise exception 'SNAPSHOT_INSTALL_ROLE_BOUNDARY_FAILED';
  end if;
end $$;
commit;
