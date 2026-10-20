-- Phase 6K.3A/6K.4A manual-review SQL only. Do not apply automatically.
-- Adds an allowlisted metadata verifier; it never invokes the financial RPC.
-- 6K.4A correction: PostgreSQL's pg_get_function_identity_arguments() includes
-- parameter names ("p_amount numeric"), so the signature check now compares the
-- canonical type vector via oidvectortypes() instead of a formatted string.

comment on function public.cap_test_transaction_create(uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb)
is 'CAP_PHASE_6K2A_V1';

create or replace function public.cap_verify_transaction_rpc()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  target_oid oid := to_regprocedure('public.cap_test_transaction_create(uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb)');
  target_schema text;
  target_name text;
  target_language text;
  target_security_invoker boolean;
  target_comment text;
  target_kind "char";
  target_arg_types text;
  auth_exec boolean := false;
  anon_exec boolean := false;
  public_exec boolean := false;
  signature_ok boolean := false;
  version_ok boolean := false;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if target_oid is not null then
    select n.nspname, p.proname, l.lanname, not p.prosecdef,
           obj_description(p.oid, 'pg_proc'), p.prokind,
           pg_catalog.oidvectortypes(p.proargtypes)
      into target_schema, target_name, target_language, target_security_invoker, target_comment,
           target_kind, target_arg_types
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where p.oid = target_oid;
    signature_ok := target_schema = 'public'
      and target_name = 'cap_test_transaction_create'
      and target_kind = 'f'
      and regexp_replace(coalesce(target_arg_types, ''), '\s+', '', 'g') =
          'uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb';
    auth_exec := has_function_privilege('authenticated', target_oid, 'EXECUTE');
    anon_exec := has_function_privilege('anon', target_oid, 'EXECUTE');
    select exists(
      select 1
      from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where p.oid = target_oid and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ) into public_exec;
    version_ok := target_comment = 'CAP_PHASE_6K2A_V1';
  end if;
  return jsonb_build_object(
    'exists', target_oid is not null,
    'signature_ok', signature_ok,
    'security_invoker', coalesce(target_security_invoker, false),
    'language_ok', target_language = 'plpgsql',
    'authenticated_execute', auth_exec,
    'anon_execute', anon_exec,
    'public_execute', public_exec,
    'version', coalesce(target_comment, ''),
    'version_ok', version_ok,
    'ready', target_oid is not null and signature_ok and coalesce(target_security_invoker, false)
      and target_language = 'plpgsql' and auth_exec and not anon_exec and not public_exec and version_ok
  );
end;
$$;

revoke all on function public.cap_verify_transaction_rpc() from public;
revoke all on function public.cap_verify_transaction_rpc() from anon;
grant execute on function public.cap_verify_transaction_rpc() to authenticated;
