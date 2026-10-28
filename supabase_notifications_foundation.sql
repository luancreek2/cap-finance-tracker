-- CAP_NOTIFICATIONS_FOUNDATION_5B1_V1. LOCAL REVIEW ARTIFACT ONLY.
-- NOT APPLIED. Phase 5B.1 does not send push notifications.
-- First install, transactional, collision/rerun fails closed. No history baseline.
-- After separate production review ONLY, the installer must explicitly set
-- cap.notifications_install = 'reviewed-5b1-v1' in its SQL session.
-- No extensions, secrets, scheduler, sender, financial objects or role changes.
begin;
do $$
declare r record;
begin
  if current_setting('cap.notifications_install',true) is distinct from 'reviewed-5b1-v1' then
    raise exception 'NOTIFICATION_INSTALL_NOT_APPROVED';
  end if;
  if to_regprocedure('public.cap_request_identity_ok()') is null
     or not public.cap_request_identity_ok() then raise exception 'NOTIFICATION_IDENTITY_PREREQUISITE'; end if;
  if to_regnamespace('cap_notifications_private') is not null
     or exists(select 1 from pg_roles where rolname in ('cap_notification_manager','cap_notification_runtime'))
     or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname like 'cap_notifications_%') then
    raise exception 'NOTIFICATION_INSTALL_TARGET_NOT_EMPTY';
  end if;
  if (select count(*) from pg_roles where rolname in
    ('cap_sync_reader','cap_transaction_writer','cap_notes_sidecar_writer')
    and not rolcanlogin and not rolinherit and not rolsuper and not rolbypassrls
    and not rolcreatedb and not rolcreaterole and not rolreplication) <> 3 then
    raise exception 'NOTIFICATION_EXISTING_ROLE_DRIFT';
  end if;
  for r in select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','cap_sync_private','cap_notes_private') and c.relkind in ('r','p') loop
    if not (select relrowsecurity from pg_class where oid=r.oid)
       or has_table_privilege('anon',r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_table_privilege('authenticated',r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege('anon',r.oid,'SELECT,INSERT,UPDATE,REFERENCES')
       or has_any_column_privilege('authenticated',r.oid,'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'NOTIFICATION_EXISTING_TABLE_DRIFT';
    end if;
  end loop;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'cap\_%' escape '\'
    and (has_function_privilege('anon',p.oid,'EXECUTE') or exists(select 1 from
      aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0))) then
    raise exception 'NOTIFICATION_EXISTING_RPC_DRIFT';
  end if;
end $$;

create role cap_notification_manager nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
create role cap_notification_runtime nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
-- Temporary SET-capable membership/schema CREATE needed by Supabase's
-- non-superuser installer for ALTER FUNCTION OWNER. Revoked before postflight.
do $$ begin execute format('grant cap_notification_manager to %I with admin false, inherit true, set true',current_user); end $$;
grant usage,create on schema public to cap_notification_manager;
create schema cap_notifications_private;
comment on schema cap_notifications_private is 'CAP_NOTIFICATIONS_FOUNDATION_5B1_V1; first-install reviewed artifact; no managed migration-history backfill';
revoke all on schema cap_notifications_private from public,anon,authenticated,service_role,cap_notification_runtime;
grant usage on schema cap_notifications_private to cap_notification_manager;

-- Notification-specific gateway identity; no changes/grants to existing Cap RPCs.
-- Claims are trusted only behind JWT-validating PostgREST, never arbitrary SQL.
create function cap_notifications_private.request_owner() returns uuid
language plpgsql stable security invoker set search_path=pg_catalog as $$
declare claims jsonb; uid uuid;
begin
  if current_setting('role',true) is distinct from 'authenticated' then raise exception 'NOTIFICATION_AUTH_REQUIRED'; end if;
  claims:=nullif(current_setting('request.jwt.claims',true),'')::jsonb;
  if claims->>'role' is distinct from 'authenticated' then raise exception 'NOTIFICATION_AUTH_REQUIRED'; end if;
  uid:=(claims->>'sub')::uuid;
  if uid is null then raise exception 'NOTIFICATION_AUTH_REQUIRED'; end if;
  return uid;
exception when invalid_text_representation then raise exception 'NOTIFICATION_AUTH_REQUIRED';
end $$;
revoke all on function cap_notifications_private.request_owner() from public,anon,authenticated,service_role;
grant execute on function cap_notifications_private.request_owner() to cap_notification_manager;

create function cap_notifications_private.valid_timezone(zone text) returns boolean
language sql stable security invoker set search_path=pg_catalog as $$
  select coalesce(zone is not null and zone !~ '^(posix|right)/'
    and (zone='UTC' or zone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+\-]+)+$')
    and exists(select 1 from pg_catalog.pg_timezone_names where name=zone),false)
$$;
revoke all on function cap_notifications_private.valid_timezone(text) from public,anon,authenticated,service_role;
grant execute on function cap_notifications_private.valid_timezone(text) to cap_notification_manager;

create function cap_notifications_private.valid_keys(dh text,secret text) returns boolean
language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare k bytea; a bytea;
begin
  if dh is null or secret is null or dh !~ '^[A-Za-z0-9_-]{87}$' or secret !~ '^[A-Za-z0-9_-]{22}$' then return false; end if;
  k:=decode(translate(dh,'-_','+/')||'=','base64'); a:=decode(translate(secret,'-_','+/')||'==','base64');
  return octet_length(k)=65 and get_byte(k,0)=4 and octet_length(a)=16
    and rtrim(translate(replace(encode(k,'base64'),chr(10),''),'+/','-_'),'=')=dh
    and rtrim(translate(encode(a,'base64'),'+/','-_'),'=')=secret;
exception when others then return false;
end $$;
revoke all on function cap_notifications_private.valid_keys(text,text) from public,anon,authenticated,service_role;
grant execute on function cap_notifications_private.valid_keys(text,text) to cap_notification_manager;

-- One canonical endpoint predicate for table constraints and registration.
-- Exact FCM/Mozilla hosts; DNS-label subdomains only for Apple and Edge/WNS.
-- No userinfo, ports, fragments, whitespace, IP literals or malformed escapes.
create function cap_notifications_private.valid_endpoint(endpoint text) returns boolean
language sql immutable security invoker set search_path=pg_catalog as $$
  select coalesce(length(endpoint)<=4096 and endpoint ~
    '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(push\.apple\.com|notify\.windows\.com))/([A-Za-z0-9_./~?=&+\-]|%[0-9A-Fa-f]{2})+$',false)
$$;
revoke all on function cap_notifications_private.valid_endpoint(text) from public,anon,authenticated,service_role,cap_notification_runtime;
grant execute on function cap_notifications_private.valid_endpoint(text) to cap_notification_manager;

create table cap_notifications_private.control (
  singleton boolean primary key default true check(singleton),
  migration_id text not null check(migration_id='CAP_NOTIFICATIONS_FOUNDATION_5B1_V1'),
  protocol text not null check(protocol='CAP_PUSH_V1'),
  engine_identity text not null check(engine_identity='cap-reminder-v1'),
  digest_version text not null check(digest_version='hmac-sha256-v1'),
  delivery_time time not null check(delivery_time=time '09:00'),
  max_publication interval not null check(max_publication=interval '168 hours'),
  background_enabled boolean not null default false check(not background_enabled)
);
insert into cap_notifications_private.control values
  (true,'CAP_NOTIFICATIONS_FOUNDATION_5B1_V1','CAP_PUSH_V1','cap-reminder-v1','hmac-sha256-v1',time '09:00',interval '168 hours',false);

-- Keep endpoint ownership reservations after replacement/disable: no silent
-- cross-account reassignment. Later cleanup requires a reviewed lifecycle rule.
create table cap_notifications_private.endpoint_owners (
  fingerprint bytea primary key check(octet_length(fingerprint)=32),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default statement_timestamp(),
  unique(user_id,fingerprint)
);
create table cap_notifications_private.bindings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  installation_id uuid not null,
  generation bigint not null default 1 check(generation>0),
  protocol text not null default 'CAP_PUSH_V1' check(protocol='CAP_PUSH_V1'),
  state text not null default 'pending' check(state in ('pending','disabled','retired')),
  endpoint text not null check(cap_notifications_private.valid_endpoint(endpoint)),
  endpoint_fingerprint bytea not null unique,
  p256dh text not null,
  auth text not null,
  vapid_key_version text not null check(vapid_key_version='unconfigured'),
  schedule_revision bigint not null default 0 check(schedule_revision>=0),
  preference_revision bigint not null default 0 check(preference_revision>=0),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  last_confirmed_at timestamptz check(last_confirmed_at is null),
  browser_expiration timestamptz check(browser_expiration is null or isfinite(browser_expiration)),
  unique(user_id,id), unique(user_id,installation_id),
  foreign key(user_id,endpoint_fingerprint) references cap_notifications_private.endpoint_owners(user_id,fingerprint),
  check(endpoint_fingerprint=sha256(convert_to(endpoint,'UTF8'))),
  check(cap_notifications_private.valid_keys(p256dh,auth))
);
create table cap_notifications_private.schedules (
  user_id uuid not null,
  binding_id uuid not null,
  generation bigint not null check(generation>0),
  candidate_digest text not null check(candidate_digest ~ '^[0-9a-f]{64}$'),
  protocol text not null check(protocol='CAP_PUSH_V1'),
  engine_identity text not null check(engine_identity='cap-reminder-v1'),
  digest_version text not null check(digest_version='hmac-sha256-v1'),
  schedule_revision bigint not null check(schedule_revision>0),
  preference_revision bigint not null check(preference_revision>=0),
  eligible_local_date date not null,
  timezone text not null check(cap_notifications_private.valid_timezone(timezone)),
  send_after timestamptz not null,
  expires_at timestamptz not null,
  published_at timestamptz not null,
  publication_valid_until timestamptz not null,
  state text not null default 'prepared' check(state='prepared'),
  primary key(user_id,binding_id,candidate_digest),
  foreign key(user_id,binding_id) references cap_notifications_private.bindings(user_id,id) on delete cascade,
  check(publication_valid_until>published_at and publication_valid_until<=published_at+interval '168 hours'),
  check(send_after=(eligible_local_date+time '09:00') at time zone timezone),
  check(expires_at>send_after and expires_at>published_at and expires_at<=publication_valid_until),
  check(expires_at<=(eligible_local_date+1)::timestamp at time zone timezone)
);
create index schedules_eligibility_idx on cap_notifications_private.schedules(send_after,expires_at);
create table cap_notifications_private.delivery_ledger (
  user_id uuid not null,
  binding_id uuid not null,
  candidate_digest text not null check(candidate_digest ~ '^[0-9a-f]{64}$'),
  state text not null default 'queued' check(state in ('queued','claimed','dispatch_started','retry_wait','accepted','unknown','retired','suppressed')),
  attempt_count integer not null default 0 check(attempt_count between 0 and 10),
  claim_token uuid,
  claimed_at timestamptz,
  dispatch_started_at timestamptz,
  next_retry_at timestamptz,
  accepted_at timestamptz,
  failure_class text check(failure_class in ('temporary_rejection','ambiguous','invalid_subscription','configuration','expired','disabled')),
  recorded_at timestamptz not null default statement_timestamp(),
  primary key(user_id,binding_id,candidate_digest),
  foreign key(user_id,binding_id) references cap_notifications_private.bindings(user_id,id) on delete cascade,
  check((state='accepted')=(accepted_at is not null)),
  check((claim_token is null)=(claimed_at is null)),
  check(state not in ('claimed','dispatch_started') or claim_token is not null),
  check(state not in ('claimed','dispatch_started','retry_wait','accepted','unknown') or attempt_count>0),
  check(state not in ('dispatch_started','accepted','unknown') or dispatch_started_at is not null),
  check(dispatch_started_at is null or attempt_count>0),
  check(state<>'retry_wait' or next_retry_at is not null),
  check(state<>'unknown' or failure_class is not distinct from 'ambiguous')
);

alter table cap_notifications_private.control enable row level security;
alter table cap_notifications_private.control force row level security;
alter table cap_notifications_private.endpoint_owners enable row level security;
alter table cap_notifications_private.endpoint_owners force row level security;
alter table cap_notifications_private.bindings enable row level security;
alter table cap_notifications_private.bindings force row level security;
alter table cap_notifications_private.schedules enable row level security;
alter table cap_notifications_private.schedules force row level security;
alter table cap_notifications_private.delivery_ledger enable row level security;
alter table cap_notifications_private.delivery_ledger force row level security;
revoke all on all tables in schema cap_notifications_private from public,anon,authenticated,service_role,cap_notification_runtime;
grant select on cap_notifications_private.control to cap_notification_manager;
grant select,insert on cap_notifications_private.endpoint_owners,cap_notifications_private.delivery_ledger to cap_notification_manager;
grant select,insert,update on cap_notifications_private.bindings to cap_notification_manager;
grant select,insert,delete on cap_notifications_private.schedules to cap_notification_manager;
create policy control_manager_read on cap_notifications_private.control for select to cap_notification_manager using(singleton);
create policy endpoint_owner on cap_notifications_private.endpoint_owners to cap_notification_manager
  using(user_id=cap_notifications_private.request_owner()) with check(user_id=cap_notifications_private.request_owner());
create policy binding_owner on cap_notifications_private.bindings to cap_notification_manager
  using(user_id=cap_notifications_private.request_owner()) with check(user_id=cap_notifications_private.request_owner());
create policy schedule_owner on cap_notifications_private.schedules to cap_notification_manager
  using(user_id=cap_notifications_private.request_owner()) with check(user_id=cap_notifications_private.request_owner());
create policy ledger_owner on cap_notifications_private.delivery_ledger to cap_notification_manager
  using(user_id=cap_notifications_private.request_owner()) with check(user_id=cap_notifications_private.request_owner());

create function public.cap_notifications_register_v1(p_installation_id uuid,p_expected_generation bigint,
  p_protocol text,p_endpoint text,p_p256dh text,p_auth text,p_vapid_key_version text,p_browser_expiration timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' as $$
declare uid uuid:=cap_notifications_private.request_owner(); b cap_notifications_private.bindings%rowtype; fp bytea;
begin
  if not cap_notifications_private.contract_ok() then raise exception 'NOTIFICATION_CONTRACT_NOT_READY'; end if;
  if p_protocol is distinct from 'CAP_PUSH_V1' then raise exception 'NOTIFICATION_PROTOCOL_UNSUPPORTED'; end if;
  if p_installation_id is null or p_expected_generation is null or p_expected_generation<0
    or not cap_notifications_private.valid_endpoint(p_endpoint)
    or not cap_notifications_private.valid_keys(p_p256dh,p_auth)
    or p_vapid_key_version is distinct from 'unconfigured'
    or (p_browser_expiration is not null and (not isfinite(p_browser_expiration) or p_browser_expiration<=statement_timestamp())) then
    raise exception 'NOTIFICATION_BINDING_INVALID'; end if;
  fp:=sha256(convert_to(p_endpoint,'UTF8'));
  -- Owner-scoped admission lock also serializes first registrations (no row
  -- exists yet). It is not an ownership/authentication substitute.
  perform pg_advisory_xact_lock(hashtextextended('cap-notifications:'||uid::text,0));
  select * into b from cap_notifications_private.bindings where user_id=uid and installation_id=p_installation_id for update;
  if (b.id is null and p_expected_generation<>0) or (b.id is not null and b.generation<>p_expected_generation) then
    raise exception 'NOTIFICATION_STALE_BINDING'; end if;
  if b.id is null and (select count(*) from cap_notifications_private.bindings where user_id=uid)>=20 then
    raise exception 'NOTIFICATION_BINDING_CAPACITY'; end if;
  if not exists(select 1 from cap_notifications_private.endpoint_owners where fingerprint=fp and user_id=uid)
    and (select count(*) from cap_notifications_private.endpoint_owners where user_id=uid)>=256 then
    raise exception 'NOTIFICATION_ENDPOINT_CAPACITY'; end if;
  insert into cap_notifications_private.endpoint_owners(fingerprint,user_id) values(fp,uid) on conflict(fingerprint) do nothing;
  if not exists(select 1 from cap_notifications_private.endpoint_owners where fingerprint=fp and user_id=uid) then
    raise exception 'NOTIFICATION_BINDING_CONFLICT'; end if;
  if b.id is null then
    insert into cap_notifications_private.bindings(user_id,installation_id,endpoint,endpoint_fingerprint,p256dh,auth,vapid_key_version,browser_expiration)
      values(uid,p_installation_id,p_endpoint,fp,p_p256dh,p_auth,p_vapid_key_version,p_browser_expiration) returning * into b;
  else
    delete from cap_notifications_private.schedules where user_id=uid and binding_id=b.id;
    update cap_notifications_private.bindings set generation=generation+1,state='pending',endpoint=p_endpoint,
      endpoint_fingerprint=fp,p256dh=p_p256dh,auth=p_auth,vapid_key_version=p_vapid_key_version,
      browser_expiration=p_browser_expiration,last_confirmed_at=null,schedule_revision=schedule_revision+1,updated_at=statement_timestamp()
      where id=b.id and user_id=uid returning * into b;
  end if;
  return jsonb_build_object('binding_id',b.id,'installation_id',b.installation_id,'generation',b.generation,
    'state',b.state,'schedule_revision',b.schedule_revision);
exception when unique_violation or foreign_key_violation then raise exception 'NOTIFICATION_BINDING_CONFLICT';
end $$;
revoke all on function public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamptz) from public,anon,authenticated,service_role;
alter function public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamptz) owner to cap_notification_manager;
grant execute on function public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamptz) to authenticated;

create function public.cap_notifications_publish_v1(p_binding_id uuid,p_generation bigint,p_expected_revision bigint,
  p_preference_revision bigint,p_protocol text,p_engine_identity text,p_digest_version text,p_timezone text,
  p_valid_until timestamptz,p_entries jsonb)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' set datestyle='ISO, YMD' as $$
declare uid uuid:=cap_notifications_private.request_owner(); b cap_notifications_private.bindings%rowtype;
  e jsonb; d date; expires timestamptz; send_at timestamptz; revision bigint; count_new integer; pub timestamptz:=statement_timestamp();
begin
  if not cap_notifications_private.contract_ok() then raise exception 'NOTIFICATION_CONTRACT_NOT_READY'; end if;
  if p_protocol is distinct from 'CAP_PUSH_V1' or p_engine_identity is distinct from 'cap-reminder-v1'
     or p_digest_version is distinct from 'hmac-sha256-v1' then raise exception 'NOTIFICATION_PROTOCOL_UNSUPPORTED'; end if;
  if not cap_notifications_private.valid_timezone(p_timezone) then raise exception 'NOTIFICATION_TIMEZONE_INVALID'; end if;
  if p_valid_until is null or not isfinite(p_valid_until) or p_valid_until<=pub or p_valid_until>pub+interval '168 hours' then
    raise exception 'NOTIFICATION_PUBLICATION_EXPIRED_OR_TOO_LONG'; end if;
  if p_entries is null or jsonb_typeof(p_entries) is distinct from 'array' then raise exception 'NOTIFICATION_ENTRIES_INVALID'; end if;
  if jsonb_array_length(p_entries)>1000 or octet_length(p_entries::text)>262144 then raise exception 'NOTIFICATION_ENTRIES_INVALID'; end if;
  select * into b from cap_notifications_private.bindings where id=p_binding_id and user_id=uid for update;
  if b.id is null or b.state<>'pending' or b.generation is distinct from p_generation or b.browser_expiration<=pub then raise exception 'NOTIFICATION_STALE_BINDING'; end if;
  if b.schedule_revision is distinct from p_expected_revision or p_preference_revision is null
    or p_preference_revision<b.preference_revision then raise exception 'NOTIFICATION_STALE_REVISION'; end if;
  -- Validate the complete bounded request before any replacement. Unknown fields
  -- (including financial content) are rejected, never persisted as arbitrary JSON.
  for e in select value from jsonb_array_elements(p_entries) loop
    if jsonb_typeof(e) is distinct from 'object' then raise exception 'NOTIFICATION_ENTRY_INVALID'; end if;
    if (select array_agg(k order by k) from jsonb_object_keys(e) k)
      is distinct from array['candidate_digest','eligible_local_date','expires_at']::text[]
      or jsonb_typeof(e->'candidate_digest') is distinct from 'string' or e->>'candidate_digest' !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(e->'eligible_local_date') is distinct from 'string' or e->>'eligible_local_date' !~ '^\d{4}-\d{2}-\d{2}$'
      or jsonb_typeof(e->'expires_at') is distinct from 'string' or e->>'expires_at' !~ '(Z|[+-]\d{2}:\d{2})$' then
      raise exception 'NOTIFICATION_ENTRY_INVALID'; end if;
    begin d:=(e->>'eligible_local_date')::date; expires:=(e->>'expires_at')::timestamptz;
    exception when others then raise exception 'NOTIFICATION_ENTRY_INVALID'; end;
    send_at:=(d+time '09:00') at time zone p_timezone;
    if not isfinite(expires) or expires<=send_at or expires<=pub or expires>p_valid_until
      or expires>(d+1)::timestamp at time zone p_timezone then raise exception 'NOTIFICATION_ENTRY_WINDOW_INVALID'; end if;
  end loop;
  if (select count(distinct value->>'candidate_digest') from jsonb_array_elements(p_entries))<>jsonb_array_length(p_entries) then
    raise exception 'NOTIFICATION_DUPLICATE_CANDIDATE'; end if;
  select count(*) into count_new from jsonb_array_elements(p_entries) j(value) where not exists
    (select 1 from cap_notifications_private.delivery_ledger l where l.user_id=uid and l.binding_id=b.id and l.candidate_digest=j.value->>'candidate_digest');
  if count_new+(select count(*) from cap_notifications_private.delivery_ledger where user_id=uid and binding_id=b.id)>1000 then
    raise exception 'NOTIFICATION_LEDGER_FULL'; end if;
  revision:=b.schedule_revision+1;
  delete from cap_notifications_private.schedules where user_id=uid and binding_id=b.id;
  insert into cap_notifications_private.schedules(user_id,binding_id,generation,candidate_digest,protocol,engine_identity,digest_version,
    schedule_revision,preference_revision,eligible_local_date,timezone,send_after,expires_at,published_at,publication_valid_until)
    select uid,b.id,b.generation,value->>'candidate_digest',p_protocol,p_engine_identity,p_digest_version,revision,p_preference_revision,
      (value->>'eligible_local_date')::date,p_timezone,((value->>'eligible_local_date')::date+time '09:00') at time zone p_timezone,
      (value->>'expires_at')::timestamptz,pub,p_valid_until from jsonb_array_elements(p_entries);
  insert into cap_notifications_private.delivery_ledger(user_id,binding_id,candidate_digest)
    select uid,b.id,value->>'candidate_digest' from jsonb_array_elements(p_entries) on conflict do nothing;
  update cap_notifications_private.bindings set schedule_revision=revision,preference_revision=p_preference_revision,updated_at=pub where id=b.id and user_id=uid;
  return jsonb_build_object('binding_id',b.id,'generation',b.generation,'schedule_revision',revision,
    'entry_count',jsonb_array_length(p_entries),'valid_until',p_valid_until,'dispatch_ready',false);
end $$;
revoke all on function public.cap_notifications_publish_v1(uuid,bigint,bigint,bigint,text,text,text,text,timestamptz,jsonb) from public,anon,authenticated,service_role;
alter function public.cap_notifications_publish_v1(uuid,bigint,bigint,bigint,text,text,text,text,timestamptz,jsonb) owner to cap_notification_manager;
grant execute on function public.cap_notifications_publish_v1(uuid,bigint,bigint,bigint,text,text,text,text,timestamptz,jsonb) to authenticated;

create function public.cap_notifications_invalidate_v1(p_binding_id uuid,p_generation bigint,p_expected_revision bigint,p_disable boolean)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog as $$
declare uid uuid:=cap_notifications_private.request_owner(); b cap_notifications_private.bindings%rowtype;
begin
  if not cap_notifications_private.contract_ok() then raise exception 'NOTIFICATION_CONTRACT_NOT_READY'; end if;
  select * into b from cap_notifications_private.bindings where id=p_binding_id and user_id=uid for update;
  if b.id is null or b.generation is distinct from p_generation then raise exception 'NOTIFICATION_STALE_BINDING'; end if;
  if b.schedule_revision is distinct from p_expected_revision or p_disable is null then raise exception 'NOTIFICATION_STALE_REVISION'; end if;
  delete from cap_notifications_private.schedules where user_id=uid and binding_id=b.id;
  update cap_notifications_private.bindings set schedule_revision=schedule_revision+1,
    generation=generation+case when p_disable then 1 else 0 end,
    state=case when p_disable then 'disabled' else state end,updated_at=statement_timestamp()
    where id=b.id and user_id=uid returning * into b;
  return jsonb_build_object('binding_id',b.id,'generation',b.generation,'schedule_revision',b.schedule_revision,'state',b.state);
end $$;
revoke all on function public.cap_notifications_invalidate_v1(uuid,bigint,bigint,boolean) from public,anon,authenticated,service_role;
alter function public.cap_notifications_invalidate_v1(uuid,bigint,bigint,boolean) owner to cap_notification_manager;
grant execute on function public.cap_notifications_invalidate_v1(uuid,bigint,bigint,boolean) to authenticated;

create function public.cap_notifications_summary_v1() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare uid uuid:=cap_notifications_private.request_owner(); result jsonb;
begin
  if not cap_notifications_private.contract_ok() then raise exception 'NOTIFICATION_CONTRACT_NOT_READY'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('binding_id',id,'installation_id',installation_id,'generation',generation,
    'state',state,'schedule_revision',schedule_revision,'preference_revision',preference_revision,
    'created_at',created_at,'updated_at',updated_at,'last_confirmed_at',last_confirmed_at) order by created_at,id),'[]'::jsonb)
    into result from cap_notifications_private.bindings where user_id=uid;
  return jsonb_build_object('protocol','CAP_PUSH_V1','bindings',result,'background_enabled',false);
end $$;
revoke all on function public.cap_notifications_summary_v1() from public,anon,authenticated,service_role;
alter function public.cap_notifications_summary_v1() owner to cap_notification_manager;
grant execute on function public.cap_notifications_summary_v1() to authenticated;

-- Catalog-only verifier. Independent of the existing financial role-name
-- allowlist: never widen/refactor public.cap_role_boundary_ok for this phase.
create function cap_notifications_private.contract_ok() returns boolean
language plpgsql stable security invoker set search_path=pg_catalog as $$
declare r record; target oid;
begin
  if to_regprocedure('cap_notifications_private.valid_endpoint(text)') is null then return false; end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='cap_notifications_private' and c.relkind='r' and c.relname in
      ('control','endpoint_owners','bindings','schedules','delivery_ledger'))<>5 then return false; end if;
  if not exists(select 1 from cap_notifications_private.control where singleton and not background_enabled
    and migration_id='CAP_NOTIFICATIONS_FOUNDATION_5B1_V1' and protocol='CAP_PUSH_V1'
    and engine_identity='cap-reminder-v1' and digest_version='hmac-sha256-v1'
    and delivery_time=time '09:00' and max_publication=interval '168 hours') then return false; end if;
  if exists(select 1 from pg_roles client_role where client_role.rolname in ('anon','authenticated','service_role','cap_notification_runtime')
      and has_schema_privilege(client_role.oid,'cap_notifications_private','USAGE')) then return false; end if;
  if has_table_privilege('cap_notification_manager','cap_notifications_private.control','INSERT,UPDATE,DELETE,TRUNCATE')
    or has_table_privilege('cap_notification_manager','cap_notifications_private.delivery_ledger','UPDATE,DELETE,TRUNCATE')
    or has_any_column_privilege('cap_notification_manager','cap_notifications_private.delivery_ledger','UPDATE')
    or has_table_privilege('cap_notification_manager','cap_notifications_private.endpoint_owners','UPDATE,DELETE,TRUNCATE') then return false; end if;
  for r in select oid,rolname,rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication
    from pg_roles where rolname in ('cap_notification_manager','cap_notification_runtime') loop
    if r.rolcanlogin or r.rolinherit or r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole or r.rolreplication
      or exists(select 1 from pg_auth_members where member=r.oid)
      or exists(select 1 from pg_auth_members m where m.roleid=r.oid and not coalesce(
        m.member=to_regrole('postgres')::oid and m.admin_option and not m.inherit_option and not m.set_option
        and exists(select 1 from pg_roles x where x.oid=m.grantor and x.oid=10 and x.rolsuper),false))
      or has_schema_privilege(r.oid,'public','CREATE') or has_schema_privilege(r.oid,'cap_notifications_private','CREATE') then return false; end if;
    for target in select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','cap_sync_private','cap_notes_private') and c.relkind in ('r','p') loop
      if has_table_privilege(r.oid,target,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r.oid,target,'SELECT,INSERT,UPDATE,REFERENCES') then return false; end if;
    end loop;
  end loop;
  if (select count(*) from pg_roles where rolname in ('cap_notification_manager','cap_notification_runtime'))<>2 then return false; end if;
  for r in select c.oid,c.relrowsecurity,c.relforcerowsecurity,c.relowner from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='cap_notifications_private' and c.relkind in ('r','p') loop
    if not r.relrowsecurity or not r.relforcerowsecurity
      or r.relowner in (to_regrole('cap_notification_manager')::oid,to_regrole('cap_notification_runtime')::oid)
      or exists(select 1 from pg_roles x where x.rolname in ('anon','authenticated','service_role','cap_notification_runtime')
        and (has_table_privilege(x.oid,r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or has_any_column_privilege(x.oid,r.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) then return false; end if;
    if (select count(*) from pg_policy where polrelid=r.oid)<>1 or not exists(select 1 from pg_policy p
      where p.polrelid=r.oid and p.polpermissive and p.polroles=array[to_regrole('cap_notification_manager')::oid]
      and ((r.oid='cap_notifications_private.control'::regclass and p.polcmd='r'
        and pg_get_expr(p.polqual,p.polrelid)='singleton' and p.polwithcheck is null)
        or (r.oid<>'cap_notifications_private.control'::regclass and p.polcmd='*'
        and pg_get_expr(p.polqual,p.polrelid)='(user_id = cap_notifications_private.request_owner())'
        and pg_get_expr(p.polwithcheck,p.polrelid)='(user_id = cap_notifications_private.request_owner())'))) then return false; end if;
  end loop;
  for r in select p.oid,p.proowner,p.prosecdef,p.proconfig,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='cap_notifications_private' or n.nspname='public' and p.proname like 'cap_notifications_%' loop
    if has_function_privilege('anon',r.oid,'EXECUTE') or has_function_privilege('service_role',r.oid,'EXECUTE')
      or has_function_privilege('cap_notification_runtime',r.oid,'EXECUTE')
      or exists(select 1 from aclexplode(coalesce((select proacl from pg_proc where oid=r.oid),acldefault('f',r.proowner))) a where a.grantee=0)
      or not coalesce(r.proconfig @> array['search_path=pg_catalog'],false)
      or r.nspname='public' and (not r.prosecdef or r.proowner<>to_regrole('cap_notification_manager')::oid
        or not has_function_privilege('authenticated',r.oid,'EXECUTE'))
      or r.nspname='cap_notifications_private' and (has_function_privilege('authenticated',r.oid,'EXECUTE') or r.prosecdef
        or not has_function_privilege('cap_notification_manager',r.oid,'EXECUTE')
        or r.proowner<>(select nspowner from pg_namespace where nspname='cap_notifications_private')) then return false; end if;
  end loop;
  return true;
end $$;
revoke all on function cap_notifications_private.contract_ok() from public,anon,authenticated,service_role;
grant execute on function cap_notifications_private.contract_ok() to cap_notification_manager;

create function public.cap_notifications_readiness_v1() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare uid uuid:=cap_notifications_private.request_owner(); ok boolean;
begin
  ok:=cap_notifications_private.contract_ok();
  return jsonb_build_object('migration_id','CAP_NOTIFICATIONS_FOUNDATION_5B1_V1','protocol','CAP_PUSH_V1',
    'engine_identity','cap-reminder-v1','digest_version','hmac-sha256-v1','foundation_ready',ok,
    'background_enabled',false,'background_ready',false,'runtime_parked',true,
    'max_publication_hours',168,'delivery_local_time','09:00','title','Cap reminder','body','Open Cap to review your reminders.');
end $$;
revoke all on function public.cap_notifications_readiness_v1() from public,anon,authenticated,service_role;
alter function public.cap_notifications_readiness_v1() owner to cap_notification_manager;
grant execute on function public.cap_notifications_readiness_v1() to authenticated;

revoke create on schema public from cap_notification_manager;
do $$ begin execute format('revoke cap_notification_manager from %I',current_user); end $$;
-- No LOGIN role, password, runtime membership, claim RPC, sender or activation
-- RPC is provisioned. Existing schema/function/default ACLs are not rewritten.
do $$ begin
  if not cap_notifications_private.contract_ok() then raise exception 'NOTIFICATION_POSTFLIGHT_FAILED'; end if;
end $$;
commit;
