-- PREPARED ONLY. In-place repair for the already-installed V1 Notes sidecar.
-- First install supabase_production_identity.sql with its separate guard.
-- If identity is already installed, DO NOT reinstall it. Install the new
-- supabase_production_role_boundary.sql prerequisite, then run this repair.
-- Then SET cap.notes_identity_repair='reviewed-draft-only'; run this WHOLE file.
-- No note/lifecycle/operation rows are read or changed. No managed Auth object
-- is altered. Rollback before COMMIT restores the original definitions/policies.
-- After commit do NOT restore the broken identity dependency or drop sidecars.
-- The PG16+ bootstrap-issued ADMIN-only membership of postgres in the writer is
-- EXPECTED and is deliberately retained. Do not retry REVOKE: postgres cannot
-- remove a row whose grantor is the bootstrap superuser.
begin;
set local lock_timeout='10s';
do $$
declare writer oid := 'cap_notes_sidecar_writer'::regrole;
begin
  if current_setting('cap.notes_identity_repair',true) is distinct from 'reviewed-draft-only' then
    raise exception 'NOTES_IDENTITY_REPAIR_NOT_APPROVED';
  end if;
  if to_regprocedure('public.cap_request_identity_ok()') is null
     or to_regprocedure('public.cap_role_boundary_ok(oid)') is null then
    raise exception 'IDENTITY_AND_ROLE_BOUNDARY_PREREQUISITES_REQUIRED';
  end if;
  if not public.cap_request_identity_ok() then
    raise exception 'REQUEST_IDENTITY_NOT_VERIFIED';
  end if;
  if not public.cap_role_boundary_ok(writer)
    or exists(select 1 from pg_roles where oid=writer
      and (rolsuper or rolbypassrls or rolcanlogin or rolinherit)) then
    raise exception 'NOTES_IDENTITY_REPAIR_UNSAFE_ROLE';
  end if;
  if (select count(*) from pg_proc where oid in (
      to_regprocedure('public.cap_notes_read(uuid)'),
      to_regprocedure('public.cap_verify_notes_lifecycle()'),
      to_regprocedure('public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)'))
      and proowner=writer and prosecdef
      and obj_description(oid,'pg_proc')='CAP_NOTES_SIDECAR_V1') <> 3 then
    raise exception 'NOTES_IDENTITY_REPAIR_UNEXPECTED_FUNCTIONS';
  end if;
  if exists(select 1 from pg_class where oid in ('public.notes'::regclass,
      'cap_notes_private.note_lifecycle'::regclass,'cap_notes_private.operations'::regclass)
      and (relowner<>current_user::regrole or not relrowsecurity or not relforcerowsecurity)) then
    raise exception 'NOTES_IDENTITY_REPAIR_TABLE_OWNERSHIP_OR_RLS';
  end if;
end $$;

-- Same temporary ownership capability used by the first-install draft. Never
-- retain operational membership after repair. The bootstrap-issued ADMIN-only
-- baseline is expected and is deliberately NOT removed. No schema CREATE grant.
do $$ begin execute format('grant cap_notes_sidecar_writer to %I with admin false, inherit true, set true',current_user); end $$;
grant execute on function public.cap_request_uid(),public.cap_request_identity_ok(),public.cap_role_boundary_ok(oid)
  to cap_notes_sidecar_writer;
do $$
declare f record; definition text; p record; n integer := 0;
begin
  for f in select oid from pg_proc where oid in (
      'public.cap_notes_read(uuid)'::regprocedure,
      'public.cap_verify_notes_lifecycle()'::regprocedure,
      'public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)'::regprocedure)
  loop
    definition := pg_get_functiondef(f.oid);
    -- Replace both executable calls and the verifier's policy-expression
    -- expectations. No signatures, owners, comments or execution ACLs change.
    definition := replace(definition,'auth.uid','public.cap_request_uid');
    definition := replace(definition,'roles_ok := exists(',
      'roles_ok := public.cap_request_identity_ok() and exists(');
    definition := replace(definition,
      'not exists(select 1 from pg_auth_members where roleid=writer_oid or member=writer_oid)',
      'public.cap_role_boundary_ok(writer_oid)');
    if f.oid = 'public.cap_verify_notes_lifecycle()'::regprocedure then
      if position('pg_auth_members' in definition) > 0 then
        raise exception 'NOTES_IDENTITY_REPAIR_MEMBERSHIP_REWRITE_FAILED';
      end if;
      if position('cap_request_identity_ok' in definition) = 0
         or position('cap_role_boundary_ok' in definition) = 0 then
        raise exception 'NOTES_IDENTITY_REPAIR_VERIFIER_REWRITE_FAILED';
      end if;
    end if;
    execute definition;
  end loop;
  for p in select polname,polrelid,polcmd,
      pg_get_expr(polqual,polrelid) q,pg_get_expr(polwithcheck,polrelid) c
    from pg_policy where polroles=array['cap_notes_sidecar_writer'::regrole::oid]
      and polrelid in ('public.notes'::regclass,
        'cap_notes_private.note_lifecycle'::regclass,'cap_notes_private.operations'::regclass)
  loop
    n := n+1;
    execute format('alter policy %I on %s%s%s',p.polname,p.polrelid::regclass,
      case when p.q is null then '' else ' using ('||replace(p.q,'auth.uid','public.cap_request_uid')||')' end,
      case when p.c is null then '' else ' with check ('||replace(p.c,'auth.uid','public.cap_request_uid')||')' end);
  end loop;
  if n<>8 then raise exception 'NOTES_IDENTITY_REPAIR_UNEXPECTED_POLICIES'; end if;
end $$;
do $$ begin execute format('revoke cap_notes_sidecar_writer from %I',current_user); end $$;
do $$ begin
  if not public.cap_request_identity_ok()
    or exists(select 1 from pg_proc where oid in (
        'public.cap_notes_read(uuid)'::regprocedure,
        'public.cap_verify_notes_lifecycle()'::regprocedure,
        'public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)'::regprocedure)
        and prosrc like '%auth.uid%')
    or not public.cap_role_boundary_ok('cap_notes_sidecar_writer'::regrole) then
    raise exception 'NOTES_IDENTITY_REPAIR_POSTFLIGHT_FAILED';
  end if;
end $$;
commit;
