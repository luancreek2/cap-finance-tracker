-- Cap-owned request identity primitive. Included by the prepared installers;
-- not a deployment authorization. Never grant access to managed auth objects.
-- PostgREST validates the JWT and installs request.jwt.claims before SET ROLE.
-- These settings are trusted ONLY through that gateway, not as authentication
-- for arbitrary SQL sessions. Browser roles must never receive SQL execution
-- endpoints or database login credentials.
begin;
do $$ begin
  if current_setting('cap.request_identity_install',true) is distinct from 'reviewed-draft-only' then
    raise exception 'REQUEST_IDENTITY_INSTALL_NOT_APPROVED';
  end if;
end $$;
create function public.cap_request_uid() returns uuid
language sql stable security invoker set search_path=pg_catalog as $cap_identity$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'
  )::uuid
$cap_identity$;
comment on function public.cap_request_uid() is 'CAP_REQUEST_IDENTITY_V1';
revoke all on function public.cap_request_uid() from public,anon,authenticated;

create function public.cap_request_identity_ok() returns boolean
language sql stable security invoker set search_path=pg_catalog as $cap_check$
  select coalesce((select p.prokind='f' and p.prorettype='uuid'::regtype
    and p.pronargs=0 and not p.prosecdef and p.provolatile='s'
    and l.lanname='sql' and p.proconfig=array['search_path=pg_catalog']
    and obj_description(p.oid,'pg_proc')='CAP_REQUEST_IDENTITY_V1'
    and p.prosrc=$expected$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'
  )::uuid
$expected$
    and not exists(select 1 from pg_roles r where r.oid=p.proowner
      and r.rolname in ('anon','authenticated','cap_notes_sidecar_writer',
        'cap_transaction_writer','cap_sync_reader'))
    and not has_schema_privilege('anon','public','CREATE')
    and not has_schema_privilege('authenticated','public','CREATE')
    and not has_function_privilege('anon',p.oid,'EXECUTE')
    and not has_function_privilege('authenticated',p.oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(p.proacl,
      acldefault('f',p.proowner))) a where a.grantee=0)
    from pg_proc p join pg_language l on l.oid=p.prolang
    where p.oid=to_regprocedure('public.cap_request_uid()')),false)
$cap_check$;
revoke all on function public.cap_request_identity_ok() from public,anon,authenticated;
comment on function public.cap_request_identity_ok() is 'CAP_REQUEST_IDENTITY_CHECK_V1';
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'revoke all on function public.cap_request_uid(),public.cap_request_identity_ok() from service_role';
  end if;
  if not public.cap_request_identity_ok() then raise exception 'REQUEST_IDENTITY_NOT_VERIFIED'; end if;
end $$;
commit;
