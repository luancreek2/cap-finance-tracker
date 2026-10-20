-- Manual installation only. Defines functions and permissions; no app rows are
-- inserted, updated or deleted by running this script. Cloud Sync stays OFF.
-- Notes-only pilot: no deletes, financial tables, or automatic client wiring.
begin;

create or replace function public.cap_sync_note_put(
  p_id uuid,
  p_expected jsonb,
  p_desired jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  uid uuid := auth.uid();
  existing public.notes%rowtype;
  current_content jsonb;
  candidate jsonb;
  desired_date date;
  inserted boolean := false;
begin
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_id is null then raise exception 'NOTE_ID_REQUIRED'; end if;

  -- Both snapshots contain exactly the four synced note fields. Identity and
  -- ownership cannot be supplied in JSON; they come from p_id and auth.uid().
  -- SQL NULL p_expected means "expect absence", not an unreadable cloud row.
  foreach candidate in array array[p_desired, p_expected] loop
    if candidate is null then continue; end if;
    if jsonb_typeof(candidate) is distinct from 'object'
       or not (candidate ?& array['legacy_id','title','body','note_date'])
       or (candidate - array['legacy_id','title','body','note_date']::text[]) <> '{}'::jsonb
       or jsonb_typeof(candidate->'legacy_id') is distinct from 'string'
       or length(btrim(candidate->>'legacy_id')) = 0
       or jsonb_typeof(candidate->'title') not in ('string','null')
       or jsonb_typeof(candidate->'body') not in ('string','null')
       or jsonb_typeof(candidate->'note_date') not in ('string','null')
    then raise exception 'INVALID_NOTE_SNAPSHOT'; end if;
    if candidate->>'note_date' is not null then
      if candidate->>'note_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'INVALID_NOTE_DATE'; end if;
      -- PostgreSQL rejects impossible calendar dates; require an exact ISO date.
      if ((candidate->>'note_date')::date)::text <> candidate->>'note_date' then raise exception 'INVALID_NOTE_DATE'; end if;
    end if;
  end loop;
  if p_desired is null then raise exception 'DESIRED_NOTE_REQUIRED'; end if;
  desired_date := (p_desired->>'note_date')::date;

  perform pg_advisory_xact_lock(hashtextextended('cap.notes:' || p_id::text, 0));
  select * into existing from public.notes
    where id = p_id and user_id = uid for update;
  if found then
    current_content := jsonb_build_object('legacy_id',existing.legacy_id,
      'title',existing.title,'body',existing.body,'note_date',existing.note_date);
    if current_content = p_desired then
      return jsonb_build_object('status','ALREADY_APPLIED');
    end if;
    if p_expected is null or current_content is distinct from p_expected then
      return jsonb_build_object('status','CONFLICT');
    end if;
    update public.notes set legacy_id = p_desired->>'legacy_id',
      title = p_desired->>'title', body = p_desired->>'body', note_date = desired_date
      where id = p_id and user_id = uid returning * into existing;
    if not found then raise exception 'NOTE_WRITE_NOT_VERIFIED'; end if;
  else
    if p_expected is not null then
      return jsonb_build_object('status','CONFLICT');
    end if;
    -- Direct table writers may not take the advisory lock. Never overwrite a
    -- concurrently inserted row, including a UUID hidden by RLS.
    insert into public.notes(id,user_id,legacy_id,title,body,note_date)
      values(p_id,uid,p_desired->>'legacy_id',p_desired->>'title',p_desired->>'body',desired_date)
      on conflict (id) do nothing returning * into existing;
    inserted := found;
    if not inserted then
      select * into existing from public.notes
        where id = p_id and user_id = uid for update;
      if not found then return jsonb_build_object('status','CONFLICT'); end if;
      current_content := jsonb_build_object('legacy_id',existing.legacy_id,
        'title',existing.title,'body',existing.body,'note_date',existing.note_date);
      if current_content = p_desired then return jsonb_build_object('status','ALREADY_APPLIED'); end if;
      return jsonb_build_object('status','CONFLICT');
    end if;
  end if;

  -- A trigger changing synced content must roll the entire write back.
  select * into existing from public.notes where id = p_id and user_id = uid;
  if not found then raise exception 'NOTE_WRITE_NOT_VERIFIED'; end if;
  current_content := jsonb_build_object('legacy_id',existing.legacy_id,
    'title',existing.title,'body',existing.body,'note_date',existing.note_date);
  if current_content is distinct from p_desired then raise exception 'NOTE_WRITE_NOT_VERIFIED'; end if;
  return jsonb_build_object('status','APPLIED');
end;
$$;

comment on function public.cap_sync_note_put(uuid,jsonb,jsonb) is 'CAP_NOTES_CAS_V1';
revoke all on function public.cap_sync_note_put(uuid,jsonb,jsonb) from public, anon;
grant execute on function public.cap_sync_note_put(uuid,jsonb,jsonb) to authenticated;

-- Metadata only. This verifier NEVER invokes cap_sync_note_put or reads notes.
create or replace function public.cap_verify_notes_rpc()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  target oid := to_regprocedure('public.cap_sync_note_put(uuid,jsonb,jsonb)');
  signature_ok boolean := false;
  invoker_ok boolean := false;
  config_ok boolean := false;
  version_ok boolean := false;
  auth_exec boolean := false;
  anon_exec boolean := false;
  public_exec boolean := false;
  rls_ok boolean := false;
  policy_ok boolean := false;
  table_grants_ok boolean := false;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if target is not null then
    select p.prokind = 'f' and l.lanname = 'plpgsql'
        and oidvectortypes(p.proargtypes) = 'uuid, jsonb, jsonb'
        and p.prorettype = 'jsonb'::regtype and p.provolatile = 'v',
      not p.prosecdef, p.proconfig = array['search_path=pg_catalog'],
      obj_description(p.oid,'pg_proc') = 'CAP_NOTES_CAS_V1'
      into signature_ok, invoker_ok, config_ok, version_ok
      from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = target;
    auth_exec := has_function_privilege('authenticated',target,'EXECUTE');
    anon_exec := has_function_privilege('anon',target,'EXECUTE');
    select exists(select 1 from pg_proc p,
      lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid = target and a.grantee = 0 and a.privilege_type = 'EXECUTE') into public_exec;
  end if;
  select c.relrowsecurity
      and not pg_has_role('authenticated',c.relowner,'USAGE')
      and not exists(select 1 from pg_roles r where r.rolname = 'authenticated' and (r.rolsuper or r.rolbypassrls))
    into rls_ok from pg_class c
    where c.oid = to_regclass('public.notes');
  -- Fail closed unless the notes table has only the repository's known owner
  -- policy. A custom/equivalent policy requires review, not a bypass here.
  select count(*) = 1 and coalesce(bool_and(p.polpermissive and p.polcmd = '*'
    and p.polroles = array['authenticated'::regrole::oid]
    and regexp_replace(pg_get_expr(p.polqual,p.polrelid),'[()\s]','','g') = 'user_id=auth.uid'
    and regexp_replace(pg_get_expr(p.polwithcheck,p.polrelid),'[()\s]','','g') = 'user_id=auth.uid'),false)
    into policy_ok from pg_policy p where p.polrelid = to_regclass('public.notes');
  if to_regclass('public.notes') is not null then
    table_grants_ok := has_table_privilege('authenticated','public.notes','SELECT')
      and has_table_privilege('authenticated','public.notes','INSERT')
      and has_table_privilege('authenticated','public.notes','UPDATE')
      and not has_table_privilege('anon','public.notes','SELECT')
      and not has_table_privilege('anon','public.notes','INSERT')
      and not has_table_privilege('anon','public.notes','UPDATE')
      and not has_table_privilege('anon','public.notes','DELETE');
  end if;
  return jsonb_build_object('exists',target is not null,
    'signature_ok',coalesce(signature_ok,false),'security_invoker',coalesce(invoker_ok,false),
    'search_path_ok',coalesce(config_ok,false),'version_ok',coalesce(version_ok,false),
    'authenticated_execute',auth_exec,'anon_execute',anon_exec,'public_execute',public_exec,
    'rls_ok',coalesce(rls_ok,false),'policy_ok',policy_ok,'table_grants_ok',table_grants_ok,
    'version','CAP_NOTES_CAS_V1',
    'ready',coalesce(target is not null and signature_ok and invoker_ok and config_ok
      and version_ok and auth_exec and not anon_exec and not public_exec
      and rls_ok and policy_ok and table_grants_ok,false));
end;
$$;

revoke all on function public.cap_verify_notes_rpc() from public, anon;
grant execute on function public.cap_verify_notes_rpc() to authenticated;
commit;
