-- CAP_NOTIFICATIONS_SENDER_5B3_V1. REVIEW ARTIFACT ONLY; NEVER applied remotely.
-- Transactional DARK install. This artifact cannot enable delivery or LOGIN.
-- Future activation requires a separate reviewed constraint/verifier amendment.
-- Approved binding-fence clarification: schedules are SELECT-only. Every fixed
-- schedule-mutating management path MUST lock the binding first. Runtime locks
-- binding -> re-reads/revalidates schedule (NO row lock) -> locks ledger.
-- This is a reviewed-function invariant, NOT a PostgreSQL rule for arbitrary SQL.
begin;
do $$ begin
  if current_setting('cap.notifications_sender_install',true) is distinct from 'reviewed-5b3b-v1' then
    raise exception 'NOTIFICATION_SENDER_INSTALL_NOT_APPROVED';
  end if;
  if current_user <> 'postgres' or not cap_notifications_private.contract_ok()
    or to_regnamespace('cap_notifications_runtime') is not null
    or to_regrole('cap_notification_sender_login') is not null then
    raise exception 'NOTIFICATION_SENDER_PREFLIGHT_FAILED';
  end if;
  if not exists(select 1 from pg_constraint where conrelid='cap_notifications_private.bindings'::regclass
    and conname='bindings_vapid_key_version_check' and position('^v[1-9][0-9]{0,2}$' in pg_get_constraintdef(oid))>0)
    or not exists(select 1 from pg_proc where oid='public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamptz)'::regprocedure
      and position('p_vapid_key_version !~' in prosrc)>0)
    or exists(select 1 from cap_notifications_private.bindings)
    or exists(select 1 from cap_notifications_private.schedules)
    or exists(select 1 from cap_notifications_private.delivery_ledger) then
    raise exception 'NOTIFICATION_SENDER_V2_OR_EMPTY_STATE_REQUIRED';
  end if;
end $$;

create role cap_notification_sender_login nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
create schema cap_notifications_runtime;
revoke all on schema cap_notifications_runtime from public,anon,authenticated,service_role;
grant usage on schema cap_notifications_runtime to cap_notification_runtime,cap_notification_sender_login,cap_notification_manager;
grant cap_notification_runtime to current_user with admin false, inherit true, set true granted by current_user;
grant create on schema cap_notifications_runtime to cap_notification_runtime;

alter table cap_notifications_private.control
  add column sender_migration_id text not null default 'CAP_NOTIFICATIONS_SENDER_5B3_V1' check(sender_migration_id='CAP_NOTIFICATIONS_SENDER_5B3_V1'),
  add column sender_runtime_parked boolean not null default true check(sender_runtime_parked),
  add column sender_dispatch_enabled boolean not null default false check(not sender_dispatch_enabled),
  add column sender_allowed_vapid_versions text[] not null default '{}' check(sender_allowed_vapid_versions='{}'::text[]),
  add column sender_run_token uuid,
  add column sender_run_until timestamptz,
  add column sender_last_started_at timestamptz,
  add constraint sender_run_pair check((sender_run_token is null)=(sender_run_until is null));
alter table cap_notifications_private.delivery_ledger
  add column claimed_generation bigint,
  add column claimed_schedule_revision bigint,
  add column claimed_preference_revision bigint,
  add column claimed_vapid_key_version text,
  add constraint sender_claim_snapshot check(claim_token is null or
    (claimed_generation is not null and claimed_generation between 1 and 9007199254740991
      and claimed_schedule_revision is not null and claimed_schedule_revision>=0
      and claimed_preference_revision is not null and claimed_preference_revision>=0
      and claimed_vapid_key_version is not null and claimed_vapid_key_version ~ '^v[1-9][0-9]{0,2}$'));
create index sender_ledger_recovery_idx on cap_notifications_private.delivery_ledger(claimed_at)
  where state in ('claimed','dispatch_started');
create index sender_ledger_retry_idx on cap_notifications_private.delivery_ledger(next_retry_at)
  where state='retry_wait';

create table cap_notifications_private.vapid_tokens (
  origin text not null check(origin ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(push\.apple\.com|notify\.windows\.com))$'),
  version text not null check(version ~ '^v[1-9][0-9]{0,2}$'),
  "authorization" text check(octet_length("authorization")<=2048 and "authorization" ~ '^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]{87}$'),
  created_at timestamptz,
  expires_at timestamptz,
  generation_token uuid unique,
  generation_until timestamptz,
  primary key(origin,version),
  check(("authorization" is null)=(created_at is null) and ("authorization" is null)=(expires_at is null)),
  check(expires_at is null or (isfinite(expires_at) and expires_at>created_at and expires_at<=created_at+interval '24 hours')),
  check((generation_token is null)=(generation_until is null))
);
alter table cap_notifications_private.vapid_tokens enable row level security;
alter table cap_notifications_private.vapid_tokens force row level security;
revoke all on table cap_notifications_private.vapid_tokens from public,anon,authenticated,service_role,cap_notification_manager,cap_notification_sender_login;
grant usage on schema cap_notifications_private to cap_notification_runtime;
grant select on cap_notifications_private.control,cap_notifications_private.bindings,
  cap_notifications_private.schedules,cap_notifications_private.delivery_ledger to cap_notification_runtime;
grant update(state,generation,schedule_revision,updated_at) on cap_notifications_private.bindings to cap_notification_runtime;
grant update(state,attempt_count,claim_token,claimed_at,dispatch_started_at,next_retry_at,accepted_at,failure_class,
  claimed_generation,claimed_schedule_revision,claimed_preference_revision,claimed_vapid_key_version)
  on cap_notifications_private.delivery_ledger to cap_notification_runtime;
grant update(sender_run_token,sender_run_until,sender_last_started_at) on cap_notifications_private.control to cap_notification_runtime;
grant select,insert,update on cap_notifications_private.vapid_tokens to cap_notification_runtime;
grant execute on function cap_notifications_private.valid_endpoint(text),cap_notifications_private.valid_keys(text,text),
  cap_notifications_private.valid_timezone(text) to cap_notification_runtime;
create policy sender_control_read on cap_notifications_private.control for select to cap_notification_runtime using(singleton);
create policy sender_control_update on cap_notifications_private.control for update to cap_notification_runtime using(singleton) with check(singleton);
create policy sender_binding_read on cap_notifications_private.bindings for select to cap_notification_runtime using(true);
create policy sender_binding_update on cap_notifications_private.bindings for update to cap_notification_runtime using(true) with check(true);
create policy sender_schedule_read on cap_notifications_private.schedules for select to cap_notification_runtime using(true);
create policy sender_ledger_read on cap_notifications_private.delivery_ledger for select to cap_notification_runtime using(true);
create policy sender_ledger_update on cap_notifications_private.delivery_ledger for update to cap_notification_runtime using(true) with check(true);
create policy sender_token_access on cap_notifications_private.vapid_tokens to cap_notification_runtime using(true) with check(true);

-- Catalog-only seal: includes exact definitions/ACLs/columns/constraints/indexes/
-- policies, role flags/memberships and schema privileges, not financial records.
create function cap_notifications_runtime.catalog_digest_v1() returns text
language sql stable security invoker set search_path=pg_catalog set timezone='UTC' as $$
  select md5(jsonb_build_object(
    'relations',(select jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relkind,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity) order by c.oid)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('cap_notifications_private','cap_notifications_runtime')),
    'columns',(select jsonb_agg(jsonb_build_array(a.attrelid,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attacl::text,pg_get_expr(d.adbin,d.adrelid)) order by a.attrelid,a.attnum)
      from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where n.nspname in ('cap_notifications_private','cap_notifications_runtime') and a.attnum>0 and not a.attisdropped),
    'constraints',(select jsonb_agg(jsonb_build_array(x.oid,x.conname,pg_get_constraintdef(x.oid)) order by x.oid)
      from pg_constraint x join pg_namespace n on n.oid=x.connamespace where n.nspname in ('cap_notifications_private','cap_notifications_runtime')),
    'indexes',(select jsonb_agg(jsonb_build_array(i.indexrelid,pg_get_indexdef(i.indexrelid)) order by i.indexrelid)
      from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='cap_notifications_private'),
    'policies',(select jsonb_agg(to_jsonb(p) order by p.schemaname,p.tablename,p.policyname) from pg_policies p where p.schemaname='cap_notifications_private'),
    'functions',(select jsonb_agg(jsonb_build_array(p.oid,p.proname,p.proargtypes::text,p.prorettype,p.proowner,p.prosecdef,p.provolatile,p.proconfig,p.proacl::text,p.prosrc) order by p.oid)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname in ('cap_notifications_private','cap_notifications_runtime') or n.nspname='public' and p.proname like 'cap_notifications_%') and p.proname<>'catalog_seal_v1'),
    'roles',(select jsonb_agg(jsonb_build_array(r.oid,r.rolname,r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolconfig) order by r.oid)
      from pg_roles r where r.rolname in ('cap_notification_manager','cap_notification_runtime','cap_notification_sender_login')),
    'memberships',(select jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor) from pg_auth_members m where m.roleid in
      (select oid from pg_roles where rolname in ('cap_notification_manager','cap_notification_runtime','cap_notification_sender_login')) or m.member in
      (select oid from pg_roles where rolname in ('cap_notification_manager','cap_notification_runtime','cap_notification_sender_login'))),
    'schemas',(select jsonb_agg(jsonb_build_array(n.oid,n.nspname,n.nspowner,n.nspacl::text) order by n.oid)
      from pg_namespace n where n.nspname in ('cap_notifications_private','cap_notifications_runtime'))
  )::text)
$$;

-- The seal is installed only after all deterministic DDL/ACLs and temporary
-- grant cleanup. It cannot bless a preexisting surface: preflight rejects one.
create function cap_notifications_runtime.catalog_seal_v1() returns text
language sql immutable security invoker set search_path=pg_catalog set timezone='UTC' as $$ select 'not-sealed'::text $$;

create function cap_notifications_runtime.contract_ok_v1() returns boolean
language plpgsql stable security invoker set search_path=pg_catalog set timezone='UTC' as $$
declare r record; obj record;
begin
  if cap_notifications_runtime.catalog_digest_v1() is distinct from cap_notifications_runtime.catalog_seal_v1() then return false; end if;
  if not exists(select 1 from cap_notifications_private.control where singleton and not background_enabled
    and sender_runtime_parked and not sender_dispatch_enabled and sender_allowed_vapid_versions='{}'::text[]
    and sender_migration_id='CAP_NOTIFICATIONS_SENDER_5B3_V1' and migration_id='CAP_NOTIFICATIONS_FOUNDATION_5B1_V1'
    and protocol='CAP_PUSH_V1' and engine_identity='cap-reminder-v1' and digest_version='hmac-sha256-v1'
    and delivery_time=time '09:00' and max_publication=interval '168 hours') then return false; end if;
  -- Effective PUBLIC paths count. No financial/auth/storage/private sync/notes
  -- privilege or application-role membership is acceptable for either role.
  for r in select oid,rolname from pg_roles where rolname in ('cap_notification_runtime','cap_notification_sender_login') loop
    if exists(select 1 from pg_auth_members where member=r.oid) then return false; end if;
    for obj in select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','cap_sync_private','cap_notes_private','auth','storage') and c.relkind in ('r','p','v','m','S') loop
      if has_table_privilege(r.oid,obj.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r.oid,obj.oid,'SELECT,INSERT,UPDATE,REFERENCES') then return false; end if;
    end loop;
    if exists(select 1 from pg_namespace n where n.nspname in ('cap_sync_private','cap_notes_private','auth','storage')
      and has_schema_privilege(r.oid,n.oid,'USAGE,CREATE')) then return false; end if;
    if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where
      (n.nspname in ('cap_sync_private','cap_notes_private','auth','storage') or n.nspname='public' and p.proname like 'cap\_%' escape '\')
      and has_function_privilege(r.oid,p.oid,'EXECUTE')) then return false; end if;
  end loop;
  if has_schema_privilege('cap_notification_sender_login','cap_notifications_private','USAGE,CREATE') then return false; end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='cap_notifications_private' and c.relkind='r'
      and (has_table_privilege('cap_notification_sender_login',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege('cap_notification_sender_login',c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) then return false; end if;
  if not has_table_privilege('cap_notification_runtime','cap_notifications_private.schedules','SELECT')
    or has_table_privilege('cap_notification_runtime','cap_notifications_private.schedules','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_any_column_privilege('cap_notification_runtime','cap_notifications_private.schedules','INSERT,UPDATE,REFERENCES')
    or has_table_privilege('cap_notification_sender_login','cap_notifications_private.schedules','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_any_column_privilege('cap_notification_sender_login','cap_notifications_private.schedules','SELECT,INSERT,UPDATE,REFERENCES')
    or not has_table_privilege('cap_notification_runtime','cap_notifications_private.bindings','SELECT')
    or not has_any_column_privilege('cap_notification_runtime','cap_notifications_private.bindings','UPDATE')
    or not has_table_privilege('cap_notification_runtime','cap_notifications_private.delivery_ledger','SELECT')
    or not has_any_column_privilege('cap_notification_runtime','cap_notifications_private.delivery_ledger','UPDATE')
    or has_column_privilege('cap_notification_runtime','cap_notifications_private.bindings','endpoint','UPDATE')
    or has_column_privilege('cap_notification_runtime','cap_notifications_private.bindings','endpoint_fingerprint','UPDATE')
    or has_column_privilege('cap_notification_runtime','cap_notifications_private.bindings','p256dh','UPDATE')
    or has_column_privilege('cap_notification_runtime','cap_notifications_private.bindings','auth','UPDATE')
    or has_column_privilege('cap_notification_runtime','cap_notifications_private.bindings','user_id','UPDATE')
    or has_column_privilege('cap_notification_runtime','cap_notifications_private.bindings','installation_id','UPDATE')
    or has_column_privilege('cap_notification_runtime','cap_notifications_private.bindings','browser_expiration','UPDATE')
    or has_column_privilege('cap_notification_runtime','cap_notifications_private.bindings','vapid_key_version','UPDATE')
    or has_column_privilege('cap_notification_runtime','cap_notifications_private.delivery_ledger','user_id','UPDATE')
    or has_column_privilege('cap_notification_runtime','cap_notifications_private.delivery_ledger','binding_id','UPDATE')
    or has_column_privilege('cap_notification_runtime','cap_notifications_private.delivery_ledger','candidate_digest','UPDATE')
    or has_column_privilege('cap_notification_runtime','cap_notifications_private.delivery_ledger','recorded_at','UPDATE') then return false; end if;
  if exists(select 1 from pg_policy where polrelid='cap_notifications_private.schedules'::regclass
    and (polcmd='w' or polcmd='*') and 'cap_notification_runtime'::regrole=any(polroles)) then return false; end if;
  -- The catalog seal fixes the management/runtime function inventory and bodies,
  -- including the reviewed binding-first schedule lifecycle fence. New mutators
  -- require migration review; PostgreSQL itself does not enforce this invariant.
  if exists(select 1 from pg_proc p where p.oid='cap_notifications_runtime.catalog_seal_v1()'::regprocedure
    and (p.prosecdef or p.proowner<>(select nspowner from pg_namespace where nspname='cap_notifications_runtime')
      or exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 or a.grantee in
        (select oid from pg_roles where rolname in ('anon','authenticated','service_role','cap_notification_sender_login'))))) then return false; end if;
  return true;
end $$;

-- Preserve the management verifier entrypoint and all old management RPCs.
-- The exact successor seal replaces only the now-inapplicable parked-runtime
-- ACL predicates; it does not replace financial identity/ACL checks with true.
create or replace function cap_notifications_private.contract_ok() returns boolean
language sql stable security invoker set search_path=pg_catalog as $$
  select cap_notifications_runtime.contract_ok_v1()
$$;

create function cap_notifications_runtime.check_caller_v1() returns void
language plpgsql stable security invoker set search_path=pg_catalog set timezone='UTC' as $$
begin
  if session_user <> 'cap_notification_sender_login' then raise exception 'NOTIFICATION_SENDER_AUTH_REQUIRED'; end if;
  if not cap_notifications_runtime.contract_ok_v1() then raise exception 'NOTIFICATION_SENDER_CONTRACT_NOT_READY'; end if;
end $$;
create function cap_notifications_runtime.run_ok_v1(p_run uuid) returns boolean
language sql stable security invoker set search_path=pg_catalog set timezone='UTC' as $$
  select coalesce(p_run is not null and exists(select 1 from cap_notifications_private.control
    where singleton and background_enabled and not sender_runtime_parked and sender_dispatch_enabled
      and sender_run_token=p_run and sender_run_until>clock_timestamp()),false)
$$;

create function cap_notifications_runtime.begin_run_v1(p_run_id uuid) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' as $$
declare c cap_notifications_private.control%rowtype; t timestamptz:=clock_timestamp(); k uuid:=gen_random_uuid();
begin
  perform cap_notifications_runtime.check_caller_v1();
  if p_run_id is null then raise exception 'NOTIFICATION_SENDER_INPUT_INVALID'; end if;
  select * into c from cap_notifications_private.control where singleton for update;
  if not c.background_enabled or c.sender_runtime_parked or not c.sender_dispatch_enabled then
    return jsonb_build_object('ok',false,'status','parked'); end if;
  if c.sender_run_until>t then return jsonb_build_object('ok',false,'status','busy'); end if;
  if c.sender_last_started_at>t-interval '60 seconds' then return jsonb_build_object('ok',false,'status','rate_limited'); end if;
  update cap_notifications_private.control set sender_run_token=k,sender_run_until=t+interval '45 seconds',sender_last_started_at=t where singleton;
  return jsonb_build_object('ok',true,'run_token',k,'run_until',t+interval '45 seconds');
end $$;

create function cap_notifications_runtime.claim_v1(p_run uuid) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' as $$
declare b cap_notifications_private.bindings%rowtype; s cap_notifications_private.schedules%rowtype;
  l cap_notifications_private.delivery_ledger%rowtype; candidate record; t timestamptz:=clock_timestamp(); k uuid:=gen_random_uuid();
begin
  perform cap_notifications_runtime.check_caller_v1();
  if not cap_notifications_runtime.run_ok_v1(p_run) then return jsonb_build_object('ok',false); end if;
  -- Discovery is never authoritative. Snapshot identity/revisions to reject a
  -- candidate changed before its binding fence can be obtained.
  for candidate in select a.user_id,a.binding_id,a.candidate_digest,to_jsonb(a) as schedule_snapshot,
      x.generation as binding_generation,x.schedule_revision as binding_revision,x.preference_revision as binding_preference,
      x.vapid_key_version as binding_vapid
    from cap_notifications_private.schedules a join cap_notifications_private.bindings x on x.id=a.binding_id and x.user_id=a.user_id
    join cap_notifications_private.delivery_ledger z on z.user_id=a.user_id and z.binding_id=a.binding_id and z.candidate_digest=a.candidate_digest
    where x.state='pending' and a.send_after<=t and a.expires_at>t and a.publication_valid_until>t
      and z.state in ('queued','retry_wait') and z.attempt_count<3 and (z.next_retry_at is null or z.next_retry_at<=t)
    order by a.send_after,a.binding_id,a.candidate_digest loop
    select * into b from cap_notifications_private.bindings where id=candidate.binding_id and user_id=candidate.user_id for update skip locked;
    if not found then continue; end if;
    t:=clock_timestamp();
    if b.state<>'pending' or b.generation<>candidate.binding_generation or b.schedule_revision<>candidate.binding_revision
      or b.preference_revision<>candidate.binding_preference or b.vapid_key_version<>candidate.binding_vapid
      or b.generation>9007199254740991 or (b.browser_expiration is not null and b.browser_expiration<=t)
      or not exists(select 1 from cap_notifications_private.control where b.vapid_key_version=any(sender_allowed_vapid_versions)) then continue; end if;
    select * into s from cap_notifications_private.schedules where user_id=b.user_id and binding_id=b.id and candidate_digest=candidate.candidate_digest;
    if not found or to_jsonb(s) is distinct from candidate.schedule_snapshot then continue; end if;
      select * into l from cap_notifications_private.delivery_ledger where user_id=s.user_id and binding_id=s.binding_id
        and candidate_digest=s.candidate_digest for update skip locked;
      t:=clock_timestamp();
      if not found or not cap_notifications_runtime.run_ok_v1(p_run) or l.state not in ('queued','retry_wait') or l.attempt_count>=3 or l.next_retry_at>t
        or s.generation<>b.generation or s.schedule_revision<>b.schedule_revision or s.preference_revision<>b.preference_revision
        or s.protocol<>'CAP_PUSH_V1' or s.engine_identity<>'cap-reminder-v1' or s.digest_version<>'hmac-sha256-v1'
        or s.send_after>t or s.expires_at<=t or s.publication_valid_until<=t or b.browser_expiration<=t then continue; end if;
      update cap_notifications_private.delivery_ledger set state='claimed',attempt_count=attempt_count+1,claim_token=k,claimed_at=t,
        dispatch_started_at=null,next_retry_at=null,failure_class=null,claimed_generation=b.generation,
        claimed_schedule_revision=b.schedule_revision,claimed_preference_revision=b.preference_revision,claimed_vapid_key_version=b.vapid_key_version
        where user_id=l.user_id and binding_id=l.binding_id and candidate_digest=l.candidate_digest;
      return jsonb_build_object('ok',true,'claim_token',k,'claim_until',t+interval '60 seconds','generation',b.generation::text,
        'schedule_revision',b.schedule_revision::text,'preference_revision',b.preference_revision::text,
        'vapid_key_version',b.vapid_key_version,'expires_at',floor(extract(epoch from least(s.expires_at,s.publication_valid_until))));
  end loop;
  return jsonb_build_object('ok',false);
end $$;

create function cap_notifications_runtime.start_dispatch_v1(p_run uuid,p_claim uuid) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' as $$
declare b cap_notifications_private.bindings%rowtype; s cap_notifications_private.schedules%rowtype;
  l cap_notifications_private.delivery_ledger%rowtype; t timestamptz:=clock_timestamp(); ttl integer; expiry timestamptz;
begin
  perform cap_notifications_runtime.check_caller_v1();
  if not cap_notifications_runtime.run_ok_v1(p_run) or p_claim is null then return jsonb_build_object('ok',false); end if;
  -- Initial locator releases no data. The binding fence protects the following
  -- schedule re-read from all fixed management mutators; only ledger is locked next.
  select x.* into b from cap_notifications_private.bindings x where exists(select 1 from cap_notifications_private.delivery_ledger z
    where z.binding_id=x.id and z.user_id=x.user_id and z.claim_token=p_claim) for update;
  if not found then return jsonb_build_object('ok',false); end if;
  select x.* into s from cap_notifications_private.schedules x where x.user_id=b.user_id and x.binding_id=b.id
    and exists(select 1 from cap_notifications_private.delivery_ledger z where z.user_id=x.user_id and z.binding_id=x.binding_id
      and z.candidate_digest=x.candidate_digest and z.claim_token=p_claim);
  if not found then return jsonb_build_object('ok',false); end if;
  select * into l from cap_notifications_private.delivery_ledger where user_id=s.user_id and binding_id=s.binding_id and candidate_digest=s.candidate_digest for update;
  t:=clock_timestamp();
  if l.claim_token is distinct from p_claim or l.state<>'claimed' or l.claimed_at<=t-interval '60 seconds'
    or b.state<>'pending' or b.generation<>l.claimed_generation or b.generation>9007199254740991
    or b.schedule_revision<>l.claimed_schedule_revision or b.preference_revision<>l.claimed_preference_revision
    or b.vapid_key_version<>l.claimed_vapid_key_version or s.generation<>b.generation or s.schedule_revision<>b.schedule_revision
    or s.preference_revision<>b.preference_revision or s.protocol<>'CAP_PUSH_V1' or s.engine_identity<>'cap-reminder-v1'
    or s.digest_version<>'hmac-sha256-v1' or s.send_after>t or s.expires_at<=t or s.publication_valid_until<=t
    or b.browser_expiration<=t or not cap_notifications_runtime.run_ok_v1(p_run)
    or not exists(select 1 from cap_notifications_private.control where b.vapid_key_version=any(sender_allowed_vapid_versions)) then
      return jsonb_build_object('ok',false); end if;
  expiry:=least(s.expires_at,s.publication_valid_until,coalesce(b.browser_expiration,'infinity'::timestamptz));
  ttl:=least(300,floor(extract(epoch from expiry-t))::integer);
  if ttl<=2 then return jsonb_build_object('ok',false); end if;
  update cap_notifications_private.delivery_ledger set state='dispatch_started',dispatch_started_at=t
    where user_id=l.user_id and binding_id=l.binding_id and candidate_digest=l.candidate_digest;
  return jsonb_build_object('ok',true,'claim_token',p_claim,'endpoint',b.endpoint,'p256dh',b.p256dh,'auth',b.auth,
    'vapid_key_version',l.claimed_vapid_key_version,'ttl_seconds',ttl,
    'installation_id',b.installation_id,'binding_id',b.id,'generation',l.claimed_generation::text,
    'expires_at',floor(extract(epoch from expiry)));
end $$;

create function cap_notifications_runtime.finalize_v1(p_claim uuid,p_result text,p_retry integer) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' as $$
declare b cap_notifications_private.bindings%rowtype; l cap_notifications_private.delivery_ledger%rowtype;
  s cap_notifications_private.schedules%rowtype; t timestamptz:=clock_timestamp(); target text; failure text; delay integer;
begin
  perform cap_notifications_runtime.check_caller_v1();
  if p_claim is null or p_result is null or p_result not in ('accepted','invalid_subscription','configuration','temporary_rejection','ambiguous','expired','disabled')
    or (p_retry is not null and (p_retry<0 or p_retry>604800)) then raise exception 'NOTIFICATION_SENDER_INPUT_INVALID'; end if;
  select x.* into b from cap_notifications_private.bindings x where exists(select 1 from cap_notifications_private.delivery_ledger z
    where z.user_id=x.user_id and z.binding_id=x.id and z.claim_token=p_claim) for update;
  if not found then return jsonb_build_object('ok',false); end if;
  select x.* into s from cap_notifications_private.schedules x where x.user_id=b.user_id and x.binding_id=b.id and exists
    (select 1 from cap_notifications_private.delivery_ledger z where z.user_id=x.user_id and z.binding_id=x.binding_id
      and z.candidate_digest=x.candidate_digest and z.claim_token=p_claim);
  select * into l from cap_notifications_private.delivery_ledger where user_id=b.user_id and binding_id=b.id and claim_token=p_claim for update;
  if l.state<>'dispatch_started' then return jsonb_build_object('ok',false,'state',l.state); end if;
  target:=case p_result when 'accepted' then 'accepted' when 'ambiguous' then 'unknown'
    when 'temporary_rejection' then 'retry_wait' when 'expired' then 'suppressed' when 'disabled' then 'suppressed' else 'retired' end;
  failure:=case p_result when 'accepted' then null when 'ambiguous' then 'ambiguous' else p_result end;
  if p_result='temporary_rejection' then
    delay:=greatest(coalesce(p_retry,60),least(900,60*(2^(l.attempt_count-1))::integer));
    delay:=delay+floor(random()*(floor(delay*0.2)+1))::integer;
    if l.attempt_count>=3 then target:='retired';
    elsif s.binding_id is null or s.generation<>l.claimed_generation or s.schedule_revision<>l.claimed_schedule_revision
      or b.state<>'pending' or b.generation<>l.claimed_generation or b.schedule_revision<>l.claimed_schedule_revision then target:='suppressed';failure:='disabled';
    elsif least(s.expires_at,s.publication_valid_until,coalesce(b.browser_expiration,'infinity'::timestamptz))<=t+make_interval(secs=>delay)
      then target:='suppressed';failure:='expired'; end if;
  end if;
  if p_result='invalid_subscription' and b.generation=l.claimed_generation and b.vapid_key_version=l.claimed_vapid_key_version then
    update cap_notifications_private.bindings set state='retired',generation=generation+1,schedule_revision=schedule_revision+1,updated_at=t where id=b.id and user_id=b.user_id;
  end if;
  update cap_notifications_private.delivery_ledger set state=target,failure_class=failure,
    accepted_at=case when target='accepted' then t else null end,
    next_retry_at=case when target='retry_wait' then t+make_interval(secs=>delay) else null end
    where user_id=l.user_id and binding_id=l.binding_id and candidate_digest=l.candidate_digest;
  return jsonb_build_object('ok',true,'state',target);
end $$;

create function cap_notifications_runtime.recover_v1(p_run uuid) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' as $$
declare b cap_notifications_private.bindings%rowtype; s cap_notifications_private.schedules%rowtype;
  l cap_notifications_private.delivery_ledger%rowtype; candidate record; t timestamptz:=clock_timestamp(); n integer:=0; target text;
begin
  perform cap_notifications_runtime.check_caller_v1();
  if not cap_notifications_runtime.run_ok_v1(p_run) then return jsonb_build_object('ok',false,'recovered',0); end if;
  for b in select x.* from cap_notifications_private.bindings x where exists(select 1 from cap_notifications_private.delivery_ledger z
    where z.user_id=x.user_id and z.binding_id=x.id and z.state in ('claimed','dispatch_started') and z.claimed_at<=t-interval '60 seconds')
    order by x.created_at,x.id for update skip locked loop
    for candidate in select candidate_digest from cap_notifications_private.delivery_ledger where user_id=b.user_id and binding_id=b.id
      and state in ('claimed','dispatch_started') and claimed_at<=t-interval '60 seconds' order by candidate_digest loop
      if n>=100 then return jsonb_build_object('ok',true,'recovered',n); end if;
      select * into s from cap_notifications_private.schedules where user_id=b.user_id and binding_id=b.id and candidate_digest=candidate.candidate_digest;
      select * into l from cap_notifications_private.delivery_ledger where user_id=b.user_id and binding_id=b.id
        and candidate_digest=candidate.candidate_digest for update skip locked;
      t:=clock_timestamp();
      if not found or l.state not in ('claimed','dispatch_started') or l.claimed_at>t-interval '60 seconds' then continue; end if;
      if l.dispatch_started_at is not null then
        update cap_notifications_private.delivery_ledger set state='unknown',failure_class='ambiguous'
          where user_id=l.user_id and binding_id=l.binding_id and candidate_digest=l.candidate_digest;
      else
        target:=case when b.state='pending' and b.generation=l.claimed_generation and b.schedule_revision=l.claimed_schedule_revision
          and b.preference_revision=l.claimed_preference_revision and b.vapid_key_version=l.claimed_vapid_key_version
          and s.generation=b.generation and s.schedule_revision=b.schedule_revision and s.preference_revision=b.preference_revision
          and s.send_after<=t and s.expires_at>t and s.publication_valid_until>t and s.protocol='CAP_PUSH_V1'
          and s.engine_identity='cap-reminder-v1' and s.digest_version='hmac-sha256-v1' and (b.browser_expiration is null or b.browser_expiration>t)
          and l.attempt_count<3 and exists(select 1 from cap_notifications_private.control where b.vapid_key_version=any(sender_allowed_vapid_versions))
          then 'queued' else 'suppressed' end;
        update cap_notifications_private.delivery_ledger set state=target,claim_token=null,claimed_at=null,
          claimed_generation=null,claimed_schedule_revision=null,claimed_preference_revision=null,claimed_vapid_key_version=null,
          failure_class=case when target='suppressed' then 'expired' else null end
          where user_id=l.user_id and binding_id=l.binding_id and candidate_digest=l.candidate_digest;
      end if;
      n:=n+1;
    end loop;
  end loop;
  return jsonb_build_object('ok',true,'recovered',n);
end $$;

create function cap_notifications_runtime.vapid_token_get_v1(p_run uuid,p_origin text,p_version text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' as $$
declare v cap_notifications_private.vapid_tokens%rowtype; t timestamptz:=clock_timestamp(); k uuid:=gen_random_uuid();
begin
  perform cap_notifications_runtime.check_caller_v1();
  if not cap_notifications_runtime.run_ok_v1(p_run) or p_origin is null or p_version is null
    or p_origin !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(push\.apple\.com|notify\.windows\.com))$'
    or not exists(select 1 from cap_notifications_private.control where p_version=any(sender_allowed_vapid_versions)) then
    return jsonb_build_object('ok',false); end if;
  insert into cap_notifications_private.vapid_tokens(origin,version) values(p_origin,p_version) on conflict do nothing;
  select * into v from cap_notifications_private.vapid_tokens where origin=p_origin and version=p_version for update;
  if v.authorization is not null and v.expires_at>t+interval '5 minutes' then
    return jsonb_build_object('ok',true,'authorization',v.authorization); end if;
  if v.generation_until>t or (v."authorization" is not null and v.created_at>t-interval '1 hour') then return jsonb_build_object('ok',false); end if;
  update cap_notifications_private.vapid_tokens set generation_token=k,generation_until=t+interval '15 seconds' where origin=p_origin and version=p_version;
  return jsonb_build_object('ok',true,'generation_token',k);
end $$;

create function cap_notifications_runtime.vapid_token_put_v1(p_generation uuid,p_authorization text,p_expires timestamptz) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' as $$
declare v cap_notifications_private.vapid_tokens%rowtype; t timestamptz:=clock_timestamp(); claims jsonb; h text; public_key text;
begin
  perform cap_notifications_runtime.check_caller_v1();
  select * into v from cap_notifications_private.vapid_tokens where generation_token=p_generation for update;
  if not found or p_generation is null or v.generation_until<=t or p_authorization is null
    or octet_length(p_authorization)>2048 or p_authorization !~ '^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]{87}$'
    or p_expires is null or not isfinite(p_expires) or p_expires<=t+interval '5 minutes' or p_expires>t+interval '24 hours'
    or (v."authorization" is not null and v.created_at>t-interval '1 hour' and v.expires_at>t) then return jsonb_build_object('ok',false); end if;
  begin
    h:=split_part(split_part(p_authorization,'t=',2),'.',2);
    claims:=convert_from(decode(translate(h,'-_','+/')||repeat('=',(4-length(h)%4)%4),'base64'),'UTF8')::jsonb;
    public_key:=split_part(p_authorization,', k=',2);
    if claims->>'aud' is distinct from v.origin or (claims->>'exp')::numeric is distinct from extract(epoch from p_expires)
      or (claims->>'sub') !~ '^https://[^/[:space:]]+' or length(public_key)<>87 then return jsonb_build_object('ok',false); end if;
  exception when others then return jsonb_build_object('ok',false); end;
  update cap_notifications_private.vapid_tokens set "authorization"=p_authorization,created_at=t,expires_at=p_expires,
    generation_token=null,generation_until=null where origin=v.origin and version=v.version;
  return jsonb_build_object('ok',true);
end $$;

-- Explicit ACLs for EVERY new function, including non-endpoint helpers.
do $$ declare r record; begin
  for r in select p.oid::regprocedure as f,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='cap_notifications_runtime' loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role,cap_notification_manager,cap_notification_sender_login',r.f);
    if r.proname in ('begin_run_v1','claim_v1','start_dispatch_v1','finalize_v1','recover_v1','vapid_token_get_v1','vapid_token_put_v1') then
      execute format('alter function %s owner to cap_notification_runtime',r.f);
      execute format('grant execute on function %s to cap_notification_sender_login',r.f);
    else
      execute format('grant execute on function %s to cap_notification_runtime',r.f);
      if r.proname in ('catalog_digest_v1','catalog_seal_v1','contract_ok_v1') then
        execute format('grant execute on function %s to cap_notification_manager',r.f);
      end if;
    end if;
  end loop;
end $$;
revoke create on schema cap_notifications_runtime from cap_notification_runtime;
revoke cap_notification_runtime from current_user granted by current_user;

-- Seal actual catalog AFTER deterministic installation and cleanup. Guards
-- above refuse rerun/preexisting objects; postflight rejects PUBLIC/financial
-- effective privileges even if unexpectedly inherited from platform defaults.
do $$ declare digest text; begin
  digest:=cap_notifications_runtime.catalog_digest_v1();
  execute format('create or replace function cap_notifications_runtime.catalog_seal_v1() returns text language sql immutable security invoker set search_path=pg_catalog set timezone=''UTC'' as %L', 'select '||quote_literal(digest)||'::text');
  if not cap_notifications_runtime.contract_ok_v1() then raise exception 'NOTIFICATION_SENDER_POSTFLIGHT_FAILED'; end if;
end $$;
commit;
