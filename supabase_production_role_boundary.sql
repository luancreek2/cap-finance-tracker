-- PREPARED ONLY. Shared PG16+ role-boundary prerequisite, after Cap identity.
-- SET cap.role_boundary_install='reviewed-draft-only'; run the whole file.
-- Does not alter memberships, managed roles, Auth objects or application data.
begin;
do $$ begin
  if to_regprocedure('public.cap_request_identity_ok()') is null then
    raise exception 'ROLE_BOUNDARY_REQUEST_IDENTITY_REQUIRED';
  end if;
  if current_setting('cap.role_boundary_install',true) is distinct from 'reviewed-draft-only'
    or not public.cap_request_identity_ok() then
    raise exception 'ROLE_BOUNDARY_INSTALL_NOT_APPROVED';
  end if;
  if (select proowner from pg_proc where oid='public.cap_request_uid()'::regprocedure)
      is distinct from current_user::regrole then
    raise exception 'ROLE_BOUNDARY_IDENTITY_OWNER_REQUIRED';
  end if;
end $$;
create function public.cap_role_boundary_ok(target oid) returns boolean
language sql stable security invoker set search_path=pg_catalog as $boundary$
  select coalesce((select
    r.rolname in ('cap_notes_sidecar_writer','cap_transaction_writer','cap_sync_reader')
    and not r.rolcanlogin and not r.rolinherit and not r.rolsuper
    and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication
    -- OUTGOING memberships are always forbidden, including ADMIN-only ones.
    and not exists(select 1 from pg_auth_members m where m.member=target)
    -- INCOMING memberships: only the PG16+ automatic creator ADMIN grant to
    -- the trusted postgres table owner, issued by the bootstrap superuser.
    and not exists(select 1 from pg_auth_members m where m.roleid=target
      and not coalesce(m.member=to_regrole('postgres')::oid and m.admin_option
        and not m.inherit_option and not m.set_option
        and exists(select 1 from pg_roles b where b.oid=m.grantor and b.oid=10 and b.rolsuper)
        and exists(select 1 from pg_roles a where a.oid=m.member and a.rolcreaterole)
        and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind in ('r','p')
            and c.relname=any(array['profiles','user_preferences','categories','accounts','goals',
              'debts','bills','account_statements','transactions','transfers','bill_payments','budgets','notes'])
            and c.relowner<>m.member),false))
    -- No indirect client path to the trusted administrator or to this role.
    and not exists(select 1 from pg_roles client
      where client.rolname in ('authenticated','anon','service_role')
        and (coalesce(pg_has_role(client.oid,target,'MEMBER'),false)
          or coalesce(pg_has_role(client.oid,to_regrole('postgres')::oid,'MEMBER'),false)))
    from pg_roles r where r.oid=target),false)
$boundary$;
comment on function public.cap_role_boundary_ok(oid) is 'CAP_ROLE_BOUNDARY_V1';
revoke all on function public.cap_role_boundary_ok(oid) from public,anon,authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'revoke all on function public.cap_role_boundary_ok(oid) from service_role';
  end if;
end $$;
commit;
