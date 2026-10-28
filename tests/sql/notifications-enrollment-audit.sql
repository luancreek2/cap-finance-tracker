-- Phase 5B.2A1 — catalog-only audit for the VAPID enrollment amendment.
-- READ ONLY. Never selects binding content, endpoints, keys or financial rows.
-- Run only against a database where the reviewed foundation and the reviewed
-- 5B.2A1 amendment are installed.
begin transaction read only;

select jsonb_build_object(
  'amendment_id','CAP_NOTIFICATIONS_ENROLLMENT_5B2A1_V1',
  'check_name','bindings_vapid_key_version_check',
  'check_definition',(select pg_get_constraintdef(oid) from pg_constraint
    where conrelid='cap_notifications_private.bindings'::regclass
      and conname='bindings_vapid_key_version_check'),
  'register_signature',(select pg_get_function_identity_arguments(p.oid) from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='cap_notifications_register_v1'),
  'register_owner',(select pg_get_userbyid(proowner) from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='cap_notifications_register_v1'),
  'register_security_definer',(select prosecdef from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='cap_notifications_register_v1'),
  'register_config',(select to_jsonb(proconfig) from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='cap_notifications_register_v1'),
  'authenticated_execute',has_function_privilege('authenticated',
    'public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamp with time zone)','EXECUTE'),
  'anon_execute',has_function_privilege('anon',
    'public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamp with time zone)','EXECUTE'),
  'service_role_execute',has_function_privilege('service_role',
    'public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamp with time zone)','EXECUTE'),
  'runtime_execute',has_function_privilege('cap_notification_runtime',
    'public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamp with time zone)','EXECUTE'),
  'public_execute_grantees',(select count(*) from pg_proc p,
    aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid='public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamp with time zone)'::regprocedure
      and a.grantee=0),
  'bindings',(select count(*) from cap_notifications_private.bindings),
  'control',(select jsonb_build_object('migration_id',migration_id,'protocol',protocol,
      'engine_identity',engine_identity,'digest_version',digest_version,
      'delivery_time',delivery_time,'max_publication',max_publication,
      'background_enabled',background_enabled) from cap_notifications_private.control),
  'private_tables',(select count(*) from pg_tables where schemaname='cap_notifications_private'),
  'public_notification_functions',(select count(*) from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'cap_notifications_%'),
  'financial_privilege_violations',(select coalesce(jsonb_agg(jsonb_build_object(
      'role',r.rolname,'object',c.oid::regclass::text) order by r.rolname,c.oid::regclass::text),'[]'::jsonb)
    from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
    where r.rolname in ('cap_notification_manager','cap_notification_runtime')
      and n.nspname in ('public','cap_sync_private','cap_notes_private')
      and c.relkind in ('r','p')
      and has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
) as notification_enrollment_catalog;

commit;
