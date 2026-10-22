-- ISOLATED LAB ONLY. Not a Supabase migration or installation instruction.
-- Uses a separate schema/role; never changes public.notes or deployed RPCs.
-- The session guard prevents accidental execution, not a security boundary.
begin;
do $$ begin
  if current_setting('cap.notes_lifecycle_lab', true) is distinct from 'isolated-tests-only' then
    raise exception 'ISOLATED_TESTS_ONLY';
  end if;
  if not exists(select 1 from pg_roles where rolname = 'cap_notes_lab_writer') then
    create role cap_notes_lab_writer nologin noinherit nosuperuser nobypassrls;
  end if;
end $$;
create schema if not exists cap_notes_lab;
revoke all on schema cap_notes_lab from public, anon, authenticated, cap_notes_lab_writer;
grant usage on schema cap_notes_lab to authenticated, cap_notes_lab_writer;
grant usage on schema auth to cap_notes_lab_writer;
grant execute on function auth.uid() to cap_notes_lab_writer;

create table if not exists cap_notes_lab.notes (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  legacy_id text not null check(length(btrim(legacy_id)) > 0),
  title text not null, body text not null, note_date date,
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  deleted_at timestamptz(3), operation_id uuid,
  created_at timestamptz(3) not null default clock_timestamp(),
  updated_at timestamptz(3) not null default clock_timestamp(),
  check(deleted_at is null or operation_id is not null)
);
create table if not exists cap_notes_lab.operations (
  user_id uuid not null references auth.users(id), operation_id uuid not null,
  note_id uuid not null references cap_notes_lab.notes(id),
  action text not null check(action in ('edit','tombstone')),
  expected jsonb not null, desired jsonb, result jsonb not null,
  primary key(user_id, operation_id)
);
alter table cap_notes_lab.notes enable row level security;
alter table cap_notes_lab.notes force row level security;
alter table cap_notes_lab.operations enable row level security;
alter table cap_notes_lab.operations force row level security;
drop policy if exists note_read on cap_notes_lab.notes;
drop policy if exists note_write on cap_notes_lab.notes;
drop policy if exists operation_read on cap_notes_lab.operations;
drop policy if exists operation_insert on cap_notes_lab.operations;
create policy note_read on cap_notes_lab.notes for select to authenticated, cap_notes_lab_writer using(user_id = auth.uid());
create policy note_write on cap_notes_lab.notes for update to cap_notes_lab_writer using(user_id = auth.uid()) with check(user_id = auth.uid());
create policy operation_read on cap_notes_lab.operations for select to cap_notes_lab_writer using(user_id = auth.uid());
create policy operation_insert on cap_notes_lab.operations for insert to cap_notes_lab_writer with check(user_id = auth.uid());
revoke all on cap_notes_lab.notes, cap_notes_lab.operations from public, anon, authenticated, cap_notes_lab_writer;
grant select on cap_notes_lab.notes to authenticated;
grant select, update on cap_notes_lab.notes to cap_notes_lab_writer;
grant select, insert on cap_notes_lab.operations to cap_notes_lab_writer;

create or replace function cap_notes_lab.note_read(p_id uuid) returns jsonb
language sql stable security invoker set search_path = pg_catalog as $$
  select jsonb_build_object('row',jsonb_build_object('id',n.id,'user_id',n.user_id,'legacy_id',n.legacy_id,
      'title',n.title,'body',n.body,'note_date',n.note_date,'created_at',n.created_at,'updated_at',n.updated_at),
    'lifecycle',jsonb_build_object('version',1,'revision',n.revision,
      'deleted_at',case when n.deleted_at is null then null else to_char(n.deleted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'operation_id',n.operation_id)) from cap_notes_lab.notes n where n.id = p_id and n.user_id = auth.uid()
$$;
comment on function cap_notes_lab.note_read(uuid) is 'CAP_NOTES_LIFECYCLE_LAB_V1';
revoke all on function cap_notes_lab.note_read(uuid) from public, anon;
grant execute on function cap_notes_lab.note_read(uuid) to authenticated, cap_notes_lab_writer;

-- Metadata only: never invokes the writer, reads note content, or changes rows.
create or replace function cap_notes_lab.verify_contract() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog as $$
declare
  uid uuid := auth.uid(); roles_ok boolean; rls_ok boolean; policies_ok boolean;
  grants_ok boolean; functions_ok boolean; isolated_ok boolean;
begin
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select not w.rolcanlogin and not w.rolsuper and not w.rolbypassrls and not w.rolinherit
    and not w.rolcreaterole and not w.rolcreatedb and not w.rolreplication
    and not a.rolsuper and not a.rolbypassrls and not a.rolcreaterole and not a.rolcreatedb and not a.rolreplication
    and not z.rolsuper and not z.rolbypassrls and not z.rolcreaterole and not z.rolcreatedb and not z.rolreplication
    and not pg_has_role('authenticated',w.oid,'MEMBER') and not pg_has_role('anon',w.oid,'MEMBER')
    and not has_schema_privilege('authenticated','cap_notes_lab','CREATE')
    and not has_schema_privilege('anon','cap_notes_lab','CREATE')
    and not has_schema_privilege('cap_notes_lab_writer','cap_notes_lab','CREATE')
    into roles_ok from pg_roles w, pg_roles a, pg_roles z
    where w.rolname='cap_notes_lab_writer' and a.rolname='authenticated' and z.rolname='anon';
  select count(*)=2 and bool_and(c.relrowsecurity and c.relforcerowsecurity
    and not pg_has_role('cap_notes_lab_writer',c.relowner,'MEMBER')
    and not pg_has_role('authenticated',c.relowner,'MEMBER')) into rls_ok
    from pg_class c where c.oid in ('cap_notes_lab.notes'::regclass,'cap_notes_lab.operations'::regclass);
  select count(*)=4 and bool_and(p.polpermissive and
    ((p.polrelid='cap_notes_lab.notes'::regclass and p.polname='note_read' and p.polcmd='r'
       and cardinality(p.polroles)=2 and p.polroles @> array['authenticated'::regrole::oid,'cap_notes_lab_writer'::regrole::oid]
       and regexp_replace(pg_get_expr(p.polqual,p.polrelid),'[()\s]','','g')='user_id=auth.uid')
    or (p.polrelid='cap_notes_lab.notes'::regclass and p.polname='note_write' and p.polcmd='w'
       and p.polroles=array['cap_notes_lab_writer'::regrole::oid]
       and regexp_replace(pg_get_expr(p.polqual,p.polrelid),'[()\s]','','g')='user_id=auth.uid'
       and regexp_replace(pg_get_expr(p.polwithcheck,p.polrelid),'[()\s]','','g')='user_id=auth.uid')
    or (p.polrelid='cap_notes_lab.operations'::regclass and p.polname='operation_read' and p.polcmd='r'
       and p.polroles=array['cap_notes_lab_writer'::regrole::oid]
       and regexp_replace(pg_get_expr(p.polqual,p.polrelid),'[()\s]','','g')='user_id=auth.uid')
    or (p.polrelid='cap_notes_lab.operations'::regclass and p.polname='operation_insert' and p.polcmd='a'
       and p.polroles=array['cap_notes_lab_writer'::regrole::oid]
       and regexp_replace(pg_get_expr(p.polwithcheck,p.polrelid),'[()\s]','','g')='user_id=auth.uid')))
    into policies_ok from pg_policy p where p.polrelid in ('cap_notes_lab.notes'::regclass,'cap_notes_lab.operations'::regclass);
  grants_ok := has_table_privilege('authenticated','cap_notes_lab.notes','SELECT')
    and has_table_privilege('cap_notes_lab_writer','cap_notes_lab.notes','SELECT')
    and has_table_privilege('cap_notes_lab_writer','cap_notes_lab.notes','UPDATE')
    and has_table_privilege('cap_notes_lab_writer','cap_notes_lab.operations','SELECT')
    and has_table_privilege('cap_notes_lab_writer','cap_notes_lab.operations','INSERT')
    and not has_table_privilege('cap_notes_lab_writer','cap_notes_lab.notes','INSERT,DELETE,TRUNCATE')
    and not has_table_privilege('cap_notes_lab_writer','cap_notes_lab.operations','UPDATE,DELETE,TRUNCATE')
    and not has_table_privilege('authenticated','cap_notes_lab.notes','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
    and not has_table_privilege('authenticated','cap_notes_lab.operations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
    and not has_table_privilege('anon','cap_notes_lab.notes','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
    and not has_table_privilege('anon','cap_notes_lab.operations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
    and not exists(select 1 from pg_attribute a where a.attrelid in ('cap_notes_lab.notes'::regclass,'cap_notes_lab.operations'::regclass)
      and a.attnum>0 and not a.attisdropped and
      (has_column_privilege('authenticated',a.attrelid,a.attnum,'INSERT,UPDATE,REFERENCES')
       or a.attrelid='cap_notes_lab.operations'::regclass and has_column_privilege('authenticated',a.attrelid,a.attnum,'SELECT')
       or has_column_privilege('anon',a.attrelid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES')))
    and not exists(select 1 from pg_class c, lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      where c.oid in ('cap_notes_lab.notes'::regclass,'cap_notes_lab.operations'::regclass) and acl.grantee=0);
  select count(*)=2 and bool_and(p.proconfig=array['search_path=pg_catalog']
    and p.prorettype='jsonb'::regtype and p.prokind='f'
    and obj_description(p.oid,'pg_proc')='CAP_NOTES_LIFECYCLE_LAB_V1'
    and ((p.proname='note_change' and oidvectortypes(p.proargtypes)='uuid, jsonb, text, jsonb, uuid'
      and p.prosecdef and p.proowner='cap_notes_lab_writer'::regrole and p.provolatile='v')
      or (p.proname='note_read' and oidvectortypes(p.proargtypes)='uuid' and not p.prosecdef and p.provolatile='s'))
    and has_function_privilege('authenticated',p.oid,'EXECUTE')
    and not has_function_privilege('anon',p.oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))
    into functions_ok from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='cap_notes_lab' and p.proname in ('note_change','note_read');
  isolated_ok := coalesce(roles_ok and rls_ok and policies_ok and grants_ok and functions_ok,false);
  return jsonb_build_object('version','CAP_NOTES_LIFECYCLE_LAB_V1','roles_ok',coalesce(roles_ok,false),
    'rls_ok',coalesce(rls_ok,false),'policies_ok',coalesce(policies_ok,false),
    'grants_ok',coalesce(grants_ok,false),'functions_ok',coalesce(functions_ok,false),
    'isolated_ready',isolated_ok,'ready',false,'production_ready',false);
end $$;
revoke all on function cap_notes_lab.verify_contract() from public, anon;
grant execute on function cap_notes_lab.verify_contract() to authenticated, cap_notes_lab_writer;

create or replace function cap_notes_lab.note_change(p_id uuid, p_expected jsonb, p_action text, p_desired jsonb, p_operation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog as $$
declare
  uid uuid := auth.uid(); n cap_notes_lab.notes%rowtype; receipt cap_notes_lab.operations%rowtype;
  candidate jsonb; c jsonb; l jsonb; current_state jsonb; wanted jsonb; after_state jsonb;
  desired_date date; changed_at timestamptz(3); before_created timestamptz(3);
begin
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if not coalesce((cap_notes_lab.verify_contract()->>'isolated_ready')::boolean,false) then raise exception 'LIFECYCLE_CONTRACT_NOT_VERIFIED'; end if;
  if p_id is null or p_operation_id is null or p_action is null or p_action not in ('edit','tombstone') then raise exception 'INVALID_LIFECYCLE_REQUEST'; end if;
  if p_expected is null or jsonb_typeof(p_expected) is distinct from 'object'
    or not(p_expected ?& array['content','lifecycle']) or (p_expected-array['content','lifecycle'])<>'{}'::jsonb then raise exception 'EXPECTED_LIFECYCLE_REQUIRED'; end if;
  c := p_expected->'content'; l := p_expected->'lifecycle';
  if jsonb_typeof(l) is distinct from 'object' or not(l ?& array['version','revision','deleted_at','operation_id'])
    or (l-array['version','revision','deleted_at','operation_id'])<>'{}'::jsonb
    or l->'version' is distinct from '1'::jsonb or jsonb_typeof(l->'revision') is distinct from 'number'
    or (l->>'revision')::numeric not between 1 and 9007199254740991
    or trunc((l->>'revision')::numeric)<>(l->>'revision')::numeric
    or l->'deleted_at' is distinct from 'null'::jsonb and jsonb_typeof(l->'deleted_at') is distinct from 'string'
    or l->'operation_id' is distinct from 'null'::jsonb and jsonb_typeof(l->'operation_id') is distinct from 'string' then raise exception 'INVALID_EXPECTED_LIFECYCLE'; end if;
  if l->>'deleted_at' is not null then
    if l->>'deleted_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      or to_char((l->>'deleted_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>l->>'deleted_at'
      or l->>'operation_id' is null then raise exception 'INVALID_EXPECTED_LIFECYCLE'; end if;
  end if;
  if l->>'operation_id' is not null and ((l->>'operation_id')::uuid)::text<>l->>'operation_id' then raise exception 'INVALID_EXPECTED_OPERATION'; end if;
  if p_action='tombstone' and p_desired is not null or p_action='edit' and p_desired is null then raise exception 'INVALID_DESIRED_CONTENT'; end if;
  foreach candidate in array array[c,p_desired] loop
    if candidate is null then continue; end if;
    if jsonb_typeof(candidate) is distinct from 'object' or not(candidate ?& array['legacy_id','title','body','note_date'])
      or (candidate-array['legacy_id','title','body','note_date'])<>'{}'::jsonb
      or jsonb_typeof(candidate->'legacy_id') is distinct from 'string' or length(btrim(candidate->>'legacy_id'))=0
      or jsonb_typeof(candidate->'title') is distinct from 'string' or jsonb_typeof(candidate->'body') is distinct from 'string'
      or candidate->'note_date' is distinct from 'null'::jsonb and jsonb_typeof(candidate->'note_date') is distinct from 'string' then raise exception 'INVALID_NOTE_CONTENT'; end if;
    if candidate->>'note_date' is not null then
      if candidate->>'note_date' !~ '^\d{4}-\d{2}-\d{2}$' or ((candidate->>'note_date')::date)::text<>candidate->>'note_date' then raise exception 'INVALID_NOTE_DATE'; end if;
    end if;
  end loop;
  if p_action='edit' and p_desired->>'legacy_id' is distinct from c->>'legacy_id' then raise exception 'IDENTITY_CHANGE_NOT_ALLOWED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('cap.notes:'||p_id::text,0));
  select * into n from cap_notes_lab.notes where id=p_id and user_id=uid for update;
  if not found then return jsonb_build_object('status','CONFLICT'); end if;
  current_state := jsonb_build_object('content',jsonb_build_object('legacy_id',n.legacy_id,'title',n.title,'body',n.body,'note_date',n.note_date),
    'lifecycle',jsonb_build_object('version',1,'revision',n.revision,'deleted_at',case when n.deleted_at is null then null else to_char(n.deleted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,'operation_id',n.operation_id));
  select * into receipt from cap_notes_lab.operations where user_id=uid and operation_id=p_operation_id;
  if found then
    if receipt.note_id<>p_id or receipt.action<>p_action or receipt.expected is distinct from p_expected or receipt.desired is distinct from p_desired then raise exception 'OPERATION_REUSE_CONFLICT'; end if;
    return jsonb_build_object('status',case when current_state=receipt.result then 'ALREADY_APPLIED' else 'CONFLICT' end);
  end if;
  if current_state is distinct from p_expected or n.deleted_at is not null then return jsonb_build_object('status','CONFLICT'); end if;
  if n.revision>=9007199254740991 then raise exception 'LIFECYCLE_REVISION_EXHAUSTED'; end if;
  changed_at := clock_timestamp(); before_created := n.created_at;
  wanted := jsonb_build_object('content',case when p_action='edit' then p_desired else c end,
    'lifecycle',jsonb_build_object('version',1,'revision',n.revision+1,'deleted_at',case when p_action='tombstone' then to_char(changed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') else null end,'operation_id',p_operation_id));
  if p_action='edit' then
    desired_date := (p_desired->>'note_date')::date;
    update cap_notes_lab.notes set title=p_desired->>'title',body=p_desired->>'body',note_date=desired_date,
      revision=revision+1,operation_id=p_operation_id,updated_at=changed_at where id=p_id and user_id=uid;
  else
    update cap_notes_lab.notes set deleted_at=changed_at,revision=revision+1,operation_id=p_operation_id,updated_at=changed_at where id=p_id and user_id=uid;
  end if;
  after_state := cap_notes_lab.note_read(p_id);
  if after_state is null or after_state->'lifecycle' is distinct from wanted->'lifecycle'
    or ((after_state->'row')-array['id','user_id','created_at','updated_at']) is distinct from wanted->'content'
    or (after_state->'row'->>'id')::uuid<>p_id or (after_state->'row'->>'user_id')::uuid<>uid
    or (after_state->'row'->>'created_at')::timestamptz is distinct from before_created
    or (after_state->'row'->>'updated_at')::timestamptz is distinct from changed_at then raise exception 'LIFECYCLE_WRITE_NOT_VERIFIED'; end if;
  begin
    insert into cap_notes_lab.operations(user_id,operation_id,note_id,action,expected,desired,result) values(uid,p_operation_id,p_id,p_action,p_expected,p_desired,wanted);
  exception when unique_violation then raise exception 'OPERATION_REUSE_CONFLICT'; end;
  select * into receipt from cap_notes_lab.operations where user_id=uid and operation_id=p_operation_id;
  if not found or receipt.note_id<>p_id or receipt.action<>p_action or receipt.expected is distinct from p_expected
    or receipt.desired is distinct from p_desired or receipt.result is distinct from wanted then raise exception 'OPERATION_RECEIPT_NOT_VERIFIED'; end if;
  return jsonb_build_object('status','APPLIED');
exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then
  raise exception 'INVALID_LIFECYCLE_REQUEST';
end $$;
-- The dedicated owner is NOT a table/schema owner and has no login/membership.
grant create on schema cap_notes_lab to cap_notes_lab_writer;
alter function cap_notes_lab.note_change(uuid,jsonb,text,jsonb,uuid) owner to cap_notes_lab_writer;
revoke create on schema cap_notes_lab from cap_notes_lab_writer;
comment on function cap_notes_lab.note_change(uuid,jsonb,text,jsonb,uuid) is 'CAP_NOTES_LIFECYCLE_LAB_V1';
revoke all on function cap_notes_lab.note_change(uuid,jsonb,text,jsonb,uuid) from public, anon;
grant execute on function cap_notes_lab.note_change(uuid,jsonb,text,jsonb,uuid) to authenticated;
commit;
