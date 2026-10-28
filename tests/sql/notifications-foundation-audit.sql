-- Metadata-only review inventory. Does not read endpoints, keys, schedules,
-- financial rows, Vault secrets or any auth/session data. Not an installer.
begin transaction read only;
select jsonb_build_object(
  'audit','CAP_NOTIFICATIONS_FOUNDATION_5B1_CATALOG_V1',
  'schema',(select jsonb_build_object('name',nspname,'owner',pg_get_userbyid(nspowner),'acl',nspacl::text,
    'identity',obj_description(oid,'pg_namespace')) from pg_namespace where nspname='cap_notifications_private'),
  'roles',(select jsonb_agg(jsonb_build_object('name',rolname,'login',rolcanlogin,'inherit',rolinherit,
    'superuser',rolsuper,'bypassrls',rolbypassrls,'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication))
    from pg_roles where rolname in ('cap_notification_manager','cap_notification_runtime')),
  'memberships',(select coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(roleid),
    'member',pg_get_userbyid(member),'admin',admin_option,'inherit',inherit_option,'set',set_option)),'[]'::jsonb)
    from pg_auth_members where roleid in (select oid from pg_roles where rolname in ('cap_notification_manager','cap_notification_runtime'))
    or member in (select oid from pg_roles where rolname in ('cap_notification_manager','cap_notification_runtime'))),
  'tables',(select jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),
    'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',c.relacl::text) order by c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='cap_notifications_private' and c.relkind='r'),
  'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,
    'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'column_acl',a.attacl::text) order by c.relname,a.attnum)
    from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='cap_notifications_private' and c.relkind='r' and a.attnum>0 and not a.attisdropped),
  'constraints',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'type',k.contype,
    'definition',pg_get_constraintdef(k.oid)) order by c.relname,k.conname)
    from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='cap_notifications_private'),
  'indexes',(select jsonb_agg(jsonb_build_object('name',indexname,'table',tablename,'definition',indexdef) order by indexname)
    from pg_indexes where schemaname='cap_notifications_private'),
  'policies',(select jsonb_agg(to_jsonb(p) order by tablename,policyname) from pg_policies p where schemaname='cap_notifications_private'),
  'functions',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),
    'owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl::text) order by n.nspname,p.proname)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='cap_notifications_private'
      or n.nspname='public' and p.proname like 'cap_notifications_%'),
  'financial_privilege_violations',(select coalesce(jsonb_agg(jsonb_build_object('role',r.rolname,'schema',n.nspname,'table',c.relname)),'[]'::jsonb)
    from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
    where r.rolname in ('cap_notification_manager','cap_notification_runtime') and c.relkind in ('r','p')
    and n.nspname in ('public','cap_sync_private','cap_notes_private')
    and (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') or c.relowner=r.oid)),
  'extensions',(select jsonb_agg(jsonb_build_object('name',name,'available_version',default_version,'installed_version',installed_version))
    from pg_available_extensions where name in ('pgcrypto','supabase_vault','pg_cron','pg_net'))
) as notification_foundation_catalog;
commit;
