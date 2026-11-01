-- CAP_NOTIFICATIONS_AUTHORIZATION_V1: guarded DARK successor. Local review only.
-- No client, sender activation, auth-table access, device capability, or receipt API.
begin;
do $$ begin
  if current_setting('cap.notifications_authorization_install',true) is distinct from 'reviewed-authorization-v1' then
    raise exception 'NOTIFICATION_AUTHORIZATION_INSTALL_NOT_APPROVED'; end if;
  if current_user<>'postgres' or not cap_notifications_runtime.contract_ok_v1()
    or to_regclass('cap_notifications_private.installation_authority') is not null
    or not exists(select 1 from cap_notifications_private.control where singleton
      and scheduling_migration_id='CAP_NOTIFICATIONS_SCHEDULING_V2'
      and not background_enabled and sender_runtime_parked and not sender_dispatch_enabled
      and sender_allowed_vapid_versions='{}'::text[])
    or exists(select 1 from pg_roles where rolname='cap_notification_sender_login' and rolcanlogin) then
    raise exception 'NOTIFICATION_AUTHORIZATION_PREFLIGHT_FAILED'; end if;
end $$;

-- Preserve the existing platform ADMIN-only grant, exactly as prior successors.
grant cap_notification_manager to current_user with admin false, inherit true, set true granted by current_user;
grant cap_notification_runtime to current_user with admin false, inherit true, set true granted by current_user;
grant create on schema public to cap_notification_manager;

alter table cap_notifications_private.control
  add column authorization_migration_id text not null default 'CAP_NOTIFICATIONS_AUTHORIZATION_V1'
    check(authorization_migration_id='CAP_NOTIFICATIONS_AUTHORIZATION_V1'),
  add column authorization_dispatch_blocked boolean not null default true check(authorization_dispatch_blocked);

create table cap_notifications_private.installation_authority (
  user_id uuid not null references auth.users(id), installation_id uuid not null,
  revocation_epoch bigint not null default 1 check(revocation_epoch between 1 and 9007199254740991),
  device_key_sha256 bytea check(device_key_sha256 is null or octet_length(device_key_sha256)=32),
  credential_revision bigint not null default 0 check(credential_revision between 0 and 9007199254740991),
  active_authorization_id uuid, locked_out boolean not null default false,
  last_revoked_at timestamptz, last_revocation_reason text,
  created_at timestamptz not null default statement_timestamp(), updated_at timestamptz not null default statement_timestamp(),
  primary key(user_id,installation_id), check(not locked_out or active_authorization_id is null),
  check((device_key_sha256 is null)=(credential_revision=0))
);
create table cap_notifications_private.delivery_authorizations (
  authorization_id uuid primary key, user_id uuid not null, installation_id uuid not null,
  binding_id uuid not null, binding_generation bigint not null check(binding_generation between 1 and 9007199254740991),
  revocation_epoch bigint not null check(revocation_epoch between 1 and 9007199254740991),
  contract_id text not null check(contract_id='CAP_NOTIFICATION_AUTH_V1'), auth_session_id uuid not null,
  credential_revision bigint not null check(credential_revision between 1 and 9007199254740991),
  state text not null check(state in ('active','revoked')),
  created_at timestamptz not null default statement_timestamp(), revoked_at timestamptz, revocation_reason text,
  foreign key(user_id,installation_id) references cap_notifications_private.installation_authority(user_id,installation_id),
  foreign key(user_id,binding_id) references cap_notifications_private.bindings(user_id,id),
  unique(user_id,installation_id,authorization_id), unique(user_id,authorization_id,revocation_epoch),
  check((state='revoked')=(revoked_at is not null)), check((state='revoked')=(revocation_reason is not null))
);
create unique index authorization_one_active_per_installation on cap_notifications_private.delivery_authorizations(user_id,installation_id) where state='active';
alter table cap_notifications_private.installation_authority add constraint authority_active_grant_fk
  foreign key(user_id,installation_id,active_authorization_id)
  references cap_notifications_private.delivery_authorizations(user_id,installation_id,authorization_id) deferrable initially deferred;
create table cap_notifications_private.enrollment_intents (
  intent_id uuid primary key, user_id uuid not null, installation_id uuid not null,
  binding_id uuid not null, binding_generation bigint not null check(binding_generation between 1 and 9007199254740991),
  expected_epoch bigint not null check(expected_epoch between 1 and 9007199254740991),
  auth_session_id uuid not null, contract_id text not null check(contract_id='CAP_NOTIFICATION_AUTH_V1'),
  request_digest bytea not null check(octet_length(request_digest)=32),
  state text not null check(state in ('prepared','committed','cancelled','expired')),
  authorization_id uuid references cap_notifications_private.delivery_authorizations(authorization_id),
  created_at timestamptz not null default statement_timestamp(), expires_at timestamptz not null,
  foreign key(user_id,installation_id) references cap_notifications_private.installation_authority(user_id,installation_id),
  foreign key(user_id,binding_id) references cap_notifications_private.bindings(user_id,id),
  check(isfinite(expires_at) and expires_at>created_at and expires_at<=created_at+interval '10 minutes')
);
create unique index authorization_one_prepared_intent on cap_notifications_private.enrollment_intents(user_id,installation_id) where state='prepared';
create table cap_notifications_private.revocation_requests (
  user_id uuid not null, installation_id uuid not null, request_id uuid not null,
  request_digest bytea not null check(octet_length(request_digest)=32),
  resulting_epoch bigint not null check(resulting_epoch between 1 and 9007199254740991),
  reason text not null, locked_out boolean not null, committed_at timestamptz not null default statement_timestamp(),
  primary key(user_id,installation_id,request_id),
  foreign key(user_id,installation_id) references cap_notifications_private.installation_authority(user_id,installation_id)
);
alter table cap_notifications_private.schedules
  add column authorization_id uuid, add column authorization_epoch bigint,
  add constraint schedule_authorization_pair check((authorization_id is null)=(authorization_epoch is null)),
  add constraint schedule_authorization_fk foreign key(user_id,authorization_id,authorization_epoch)
    references cap_notifications_private.delivery_authorizations(user_id,authorization_id,revocation_epoch);
alter table cap_notifications_private.delivery_ledger
  add column claimed_authorization_id uuid, add column claimed_authorization_epoch bigint,
  add constraint ledger_authorization_pair check((claimed_authorization_id is null)=(claimed_authorization_epoch is null)),
  add constraint ledger_authorization_fk foreign key(user_id,claimed_authorization_id,claimed_authorization_epoch)
    references cap_notifications_private.delivery_authorizations(user_id,authorization_id,revocation_epoch);

-- Only owner-scoped management functions can reach these rows. No raw keys.
do $$ declare name text; begin
  foreach name in array array['installation_authority','delivery_authorizations','enrollment_intents','revocation_requests'] loop
    execute format('alter table cap_notifications_private.%I enable row level security',name);
    execute format('alter table cap_notifications_private.%I force row level security',name);
    execute format('revoke all on cap_notifications_private.%I from public,anon,authenticated,service_role,cap_notification_runtime,cap_notification_sender_login',name);
    execute format('grant select,insert on cap_notifications_private.%I to cap_notification_manager',name);
    if name<>'revocation_requests' then execute format('grant update on cap_notifications_private.%I to cap_notification_manager',name); end if;
    execute format('create policy authorization_owner on cap_notifications_private.%I to cap_notification_manager using(user_id=cap_notifications_private.request_owner()) with check(user_id=cap_notifications_private.request_owner())',name);
  end loop;
end $$;
grant update(state,failure_class) on cap_notifications_private.delivery_ledger to cap_notification_manager;

-- Backfill does not manufacture consent, keys, sessions, intents or grants.
insert into cap_notifications_private.installation_authority(user_id,installation_id)
  select user_id,installation_id from cap_notifications_private.bindings;
-- Existing schedules are retained with NULL authorization references (quarantined).
-- Already-started dispatch is uncertain; it is NEVER made retryable.
update cap_notifications_private.delivery_ledger set state='unknown',failure_class='ambiguous' where state='dispatch_started';
update cap_notifications_private.delivery_ledger set state='suppressed',failure_class='disabled' where state in ('queued','claimed','retry_wait');

create function cap_notifications_private.authorization_contract_ok_v1() returns boolean
language sql stable security invoker set search_path=pg_catalog as $$
 select cap_notifications_private.contract_ok() and exists(select 1 from cap_notifications_private.control
 where singleton and authorization_migration_id='CAP_NOTIFICATIONS_AUTHORIZATION_V1'
 and authorization_dispatch_blocked and not background_enabled and sender_runtime_parked and not sender_dispatch_enabled)
$$;
-- Deliberately no GUC, JWT-only success, auth-table grant, or production bypass.
create function cap_notifications_private.authorization_session_live_v1(p_owner uuid,p_session uuid) returns boolean
language sql stable security invoker set search_path=pg_catalog as $$ select false $$;
create function cap_notifications_private.authorization_session_id_v1() returns uuid
language plpgsql stable security invoker set search_path=pg_catalog as $$
declare s text; begin
  s:=current_setting('request.jwt.claims',true)::jsonb->>'session_id';
  if s is null then return null; end if;
  return s::uuid;
exception when others then return null; end $$;

create function cap_notifications_private.lock_authority_v1(p_installation uuid)
returns cap_notifications_private.installation_authority
language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare uid uuid:=cap_notifications_private.request_owner(); a cap_notifications_private.installation_authority%rowtype;
begin
  if not cap_notifications_private.authorization_contract_ok_v1() then raise exception 'NOTIFICATION_AUTHORIZATION_CONTRACT_NOT_READY'; end if;
  if p_installation is null then raise exception 'NOTIFICATION_INSTALLATION_INVALID'; end if;
  -- Same owner admission lock as historical registration; includes absent rows.
  perform pg_advisory_xact_lock(hashtextextended('cap-notifications:'||uid::text,0));
  insert into cap_notifications_private.installation_authority(user_id,installation_id) values(uid,p_installation) on conflict do nothing;
  select * into strict a from cap_notifications_private.installation_authority where user_id=uid and installation_id=p_installation for update;
  return a;
end $$;

create function cap_notifications_private.revoke_authority_v1(p_installation uuid,p_request uuid,p_reason text,p_reset_digest text default null)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare uid uuid:=cap_notifications_private.request_owner(); a cap_notifications_private.installation_authority%rowtype;
 b cap_notifications_private.bindings%rowtype; r cap_notifications_private.revocation_requests%rowtype; digest bytea; exhausted boolean;
begin
  if p_request is null or p_reason is null or p_reason not in ('disable','sign_out','legacy_mutation','key_reset','administrative') then
    raise exception 'NOTIFICATION_REVOCATION_INVALID'; end if;
  if (p_reason='key_reset' and (p_reset_digest is null or p_reset_digest !~ '^[0-9a-f]{64}$'))
    or (p_reason<>'key_reset' and p_reset_digest is not null) then raise exception 'NOTIFICATION_REVOCATION_INVALID'; end if;
  a:=cap_notifications_private.lock_authority_v1(p_installation);
  digest:=sha256(convert_to(jsonb_build_array(p_installation,p_reason,p_reset_digest)::text,'UTF8'));
  select * into r from cap_notifications_private.revocation_requests where user_id=uid and installation_id=p_installation and request_id=p_request;
  if found then
    if r.request_digest<>digest then raise exception 'NOTIFICATION_IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('ok',true,'state','revoked','revocation_epoch',r.resulting_epoch,'locked_out',r.locked_out,'replayed',true);
  end if;
  select * into b from cap_notifications_private.bindings where user_id=uid and installation_id=p_installation for update;
  exhausted:=a.locked_out or a.revocation_epoch>=9007199254740990 or coalesce(b.generation>=9007199254740990,false)
    or coalesce(b.schedule_revision>=9007199254740990,false) or (p_reason='key_reset' and a.credential_revision>=9007199254740990);
  update cap_notifications_private.installation_authority set
    revocation_epoch=least(revocation_epoch+1,9007199254740991),active_authorization_id=null,locked_out=exhausted,
    last_revoked_at=statement_timestamp(),last_revocation_reason=p_reason,updated_at=statement_timestamp()
    where user_id=uid and installation_id=p_installation returning * into a;
  update cap_notifications_private.delivery_authorizations set state='revoked',revoked_at=statement_timestamp(),revocation_reason=p_reason
    where user_id=uid and installation_id=p_installation and state='active';
  update cap_notifications_private.enrollment_intents set state='cancelled'
    where user_id=uid and installation_id=p_installation and state='prepared';
  if b.id is not null then
    delete from cap_notifications_private.schedules where user_id=uid and binding_id=b.id;
    update cap_notifications_private.delivery_ledger set state='unknown',failure_class='ambiguous'
      where user_id=uid and binding_id=b.id and state='dispatch_started';
    update cap_notifications_private.delivery_ledger set state='suppressed',failure_class='disabled'
      where user_id=uid and binding_id=b.id and state in ('queued','claimed','retry_wait');
    update cap_notifications_private.bindings set state='disabled',generation=case when generation>=9007199254740991 then generation else generation+1 end,
      schedule_revision=case when schedule_revision>=9007199254740991 then schedule_revision else schedule_revision+1 end,updated_at=statement_timestamp()
      where user_id=uid and id=b.id;
  end if;
  insert into cap_notifications_private.revocation_requests(user_id,installation_id,request_id,request_digest,resulting_epoch,reason,locked_out)
    values(uid,p_installation,p_request,digest,a.revocation_epoch,p_reason,a.locked_out);
  return jsonb_build_object('ok',true,'state','revoked','revocation_epoch',a.revocation_epoch,'locked_out',a.locked_out,'replayed',false);
end $$;

-- Preserve the sealed transport validator privately; not callable by browsers.
do $$ declare body text; begin
  select prosrc into strict body from pg_proc where oid='public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamptz)'::regprocedure;
  execute format($ddl$create function cap_notifications_private.register_transport_v3(p_installation_id uuid,p_expected_generation bigint,
    p_protocol text,p_endpoint text,p_p256dh text,p_auth text,p_vapid_key_version text,p_browser_expiration timestamptz)
    returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog set timezone='UTC' as %L$ddl$,body);
end $$;

create function public.cap_notifications_revoke_authorization_v1(p_installation_id uuid,p_request_id uuid,p_reason text)
returns jsonb language sql volatile security definer set search_path=pg_catalog as $$
 select cap_notifications_private.revoke_authority_v1(p_installation_id,p_request_id,p_reason)
$$;
create function public.cap_notifications_register_v3(p_installation_id uuid,p_expected_generation bigint,p_expected_epoch bigint,
 p_contract_id text,p_endpoint text,p_p256dh text,p_auth text,p_vapid_key_version text,p_browser_expiration timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog as $$
declare a cap_notifications_private.installation_authority%rowtype; begin
  a:=cap_notifications_private.lock_authority_v1(p_installation_id);
  if p_contract_id is distinct from 'CAP_NOTIFICATION_AUTH_V1' or a.locked_out or a.active_authorization_id is not null
    or p_expected_epoch is distinct from a.revocation_epoch or p_expected_generation is null or p_expected_generation<0 or p_expected_generation>=9007199254740991 then
    return jsonb_build_object('ok',false,'reason','AUTHORIZATION_PRECONDITION_FAILED'); end if;
  if exists(select 1 from cap_notifications_private.enrollment_intents where user_id=a.user_id and installation_id=a.installation_id and state='prepared') then
    return jsonb_build_object('ok',false,'reason','ENROLLMENT_INTENT_PENDING'); end if;
  return cap_notifications_private.register_transport_v3(p_installation_id,p_expected_generation,'CAP_PUSH_V1',p_endpoint,p_p256dh,p_auth,p_vapid_key_version,p_browser_expiration);
end $$;

create function public.cap_notifications_prepare_authorization_v1(p_installation_id uuid,p_binding_id uuid,p_generation bigint,
 p_expected_epoch bigint,p_intent_id uuid,p_device_key_sha256 text,p_contract_id text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog as $$
declare a cap_notifications_private.installation_authority%rowtype; b cap_notifications_private.bindings%rowtype;
 i cap_notifications_private.enrollment_intents%rowtype; sid uuid:=cap_notifications_private.authorization_session_id_v1(); digest bytea;
begin
  a:=cap_notifications_private.lock_authority_v1(p_installation_id);
  if a.locked_out or a.revocation_epoch=9007199254740991 or a.active_authorization_id is not null or p_expected_epoch is distinct from a.revocation_epoch
    or p_contract_id is distinct from 'CAP_NOTIFICATION_AUTH_V1' or p_intent_id is null
    or p_device_key_sha256 is null or p_device_key_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok',false,'reason','AUTHORIZATION_PRECONDITION_FAILED'); end if;
  select * into b from cap_notifications_private.bindings where user_id=a.user_id and id=p_binding_id and installation_id=p_installation_id for update;
  if b.id is null or b.state<>'pending' or b.generation is distinct from p_generation or b.generation>9007199254740991
    or b.browser_expiration<=statement_timestamp() then return jsonb_build_object('ok',false,'reason','STALE_BINDING'); end if;
  if sid is null or not cap_notifications_private.authorization_session_live_v1(a.user_id,sid) then
    return jsonb_build_object('ok',false,'reason','SESSION_AUTHORITY_UNVERIFIED'); end if;
  digest:=sha256(convert_to(jsonb_build_array(p_installation_id,p_binding_id,p_generation,p_expected_epoch,p_intent_id,p_device_key_sha256,p_contract_id,sid)::text,'UTF8'));
  select * into i from cap_notifications_private.enrollment_intents where intent_id=p_intent_id and user_id=a.user_id;
  if found then
    if i.request_digest<>digest then return jsonb_build_object('ok',false,'reason','IDEMPOTENCY_CONFLICT'); end if;
    if i.state<>'prepared' or i.expires_at<=statement_timestamp() then return jsonb_build_object('ok',false,'reason','INTENT_NOT_PREPARED'); end if;
    return jsonb_build_object('ok',true,'intent_id',i.intent_id,'revocation_epoch',i.expected_epoch,'request_digest',encode(i.request_digest,'hex'));
  end if;
  if a.device_key_sha256 is not null and a.device_key_sha256<>decode(p_device_key_sha256,'hex') then
    return jsonb_build_object('ok',false,'reason','CREDENTIAL_RESET_REQUIRED'); end if;
  if a.device_key_sha256 is null then
    update cap_notifications_private.installation_authority set device_key_sha256=decode(p_device_key_sha256,'hex'),credential_revision=1
      where user_id=a.user_id and installation_id=p_installation_id;
  end if;
  update cap_notifications_private.enrollment_intents set state='cancelled' where user_id=a.user_id and installation_id=p_installation_id and state='prepared';
  insert into cap_notifications_private.enrollment_intents(intent_id,user_id,installation_id,binding_id,binding_generation,expected_epoch,
    auth_session_id,contract_id,request_digest,state,expires_at)
    values(p_intent_id,a.user_id,p_installation_id,b.id,b.generation,a.revocation_epoch,sid,p_contract_id,digest,'prepared',statement_timestamp()+interval '10 minutes');
  return jsonb_build_object('ok',true,'intent_id',p_intent_id,'revocation_epoch',a.revocation_epoch,'request_digest',encode(digest,'hex'));
end $$;

create function public.cap_notifications_commit_authorization_v1(p_intent_id uuid,p_expected_epoch bigint,p_request_digest text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog as $$
declare uid uuid:=cap_notifications_private.request_owner(); sid uuid:=cap_notifications_private.authorization_session_id_v1();
 i cap_notifications_private.enrollment_intents%rowtype; a cap_notifications_private.installation_authority%rowtype;
 b cap_notifications_private.bindings%rowtype; g cap_notifications_private.delivery_authorizations%rowtype;
begin
  select * into i from cap_notifications_private.enrollment_intents where user_id=uid and intent_id=p_intent_id;
  if not found then return jsonb_build_object('ok',false,'reason','INTENT_UNAVAILABLE'); end if;
  a:=cap_notifications_private.lock_authority_v1(i.installation_id);
  select * into b from cap_notifications_private.bindings where user_id=uid and id=i.binding_id for update;
  select * into i from cap_notifications_private.enrollment_intents where user_id=uid and intent_id=p_intent_id for update;
  if a.locked_out or a.revocation_epoch=9007199254740991 or p_expected_epoch is distinct from a.revocation_epoch or i.expected_epoch<>a.revocation_epoch
    or p_request_digest is distinct from encode(i.request_digest,'hex') or b.id is null or b.state<>'pending'
    or b.generation<>i.binding_generation or b.browser_expiration<=statement_timestamp() or sid is distinct from i.auth_session_id then
    return jsonb_build_object('ok',false,'reason','AUTHORIZATION_PRECONDITION_FAILED'); end if;
  if not cap_notifications_private.authorization_session_live_v1(uid,sid) then return jsonb_build_object('ok',false,'reason','SESSION_AUTHORITY_UNVERIFIED'); end if;
  if i.state='committed' then
    select * into g from cap_notifications_private.delivery_authorizations where user_id=uid and authorization_id=i.authorization_id;
    if g.state is distinct from 'active' or a.active_authorization_id is distinct from g.authorization_id then
      return jsonb_build_object('ok',false,'reason','AUTHORIZATION_REVOKED'); end if;
  else
    if i.state<>'prepared' or i.expires_at<=statement_timestamp() or a.active_authorization_id is not null then
      return jsonb_build_object('ok',false,'reason','INTENT_NOT_PREPARED'); end if;
    insert into cap_notifications_private.delivery_authorizations(authorization_id,user_id,installation_id,binding_id,binding_generation,
      revocation_epoch,contract_id,auth_session_id,credential_revision,state)
      values(gen_random_uuid(),uid,a.installation_id,b.id,b.generation,a.revocation_epoch,i.contract_id,sid,a.credential_revision,'active') returning * into g;
    update cap_notifications_private.installation_authority set active_authorization_id=g.authorization_id,updated_at=statement_timestamp()
      where user_id=uid and installation_id=a.installation_id;
    update cap_notifications_private.enrollment_intents set state='committed',authorization_id=g.authorization_id where user_id=uid and intent_id=i.intent_id;
  end if;
  return jsonb_build_object('ok',true,'authorization_id',g.authorization_id,'installation_id',g.installation_id,
    'binding_id',g.binding_id,'generation',g.binding_generation,'revocation_epoch',g.revocation_epoch,
    'credential_revision',g.credential_revision,'contract_id',g.contract_id,'state','active','dispatch_ready',false);
end $$;

create function public.cap_notifications_authorization_status_v1(p_installation_id uuid,p_intent_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare uid uuid:=cap_notifications_private.request_owner(); a cap_notifications_private.installation_authority%rowtype; g cap_notifications_private.delivery_authorizations%rowtype; i cap_notifications_private.enrollment_intents%rowtype;
begin
  if not cap_notifications_private.authorization_contract_ok_v1() then raise exception 'NOTIFICATION_AUTHORIZATION_CONTRACT_NOT_READY'; end if;
  select * into a from cap_notifications_private.installation_authority where user_id=uid and installation_id=p_installation_id;
  if not found then return jsonb_build_object('state','unauthorized','dispatch_ready',false); end if;
  select * into g from cap_notifications_private.delivery_authorizations where user_id=uid and authorization_id=a.active_authorization_id;
  select * into i from cap_notifications_private.enrollment_intents where user_id=uid and installation_id=p_installation_id and intent_id=p_intent_id;
  return jsonb_build_object('state',case when g.state='active' then 'active' else 'unauthorized' end,
    'revocation_epoch',a.revocation_epoch,'locked_out',a.locked_out,'authorization_id',a.active_authorization_id,
    'intent_state',i.state,'session_authority_verified',false,'dispatch_ready',false);
end $$;

create function public.cap_notifications_reset_device_key_v1(p_installation_id uuid,p_request_id uuid,p_device_key_sha256 text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog as $$
declare a cap_notifications_private.installation_authority%rowtype; r jsonb;
begin
  if p_request_id is null or p_device_key_sha256 is null or p_device_key_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'NOTIFICATION_KEY_RESET_INVALID'; end if;
  a:=cap_notifications_private.lock_authority_v1(p_installation_id);
  r:=cap_notifications_private.revoke_authority_v1(p_installation_id,p_request_id,'key_reset',p_device_key_sha256);
  if not (r->>'replayed')::boolean and not (r->>'locked_out')::boolean then
    update cap_notifications_private.installation_authority set device_key_sha256=decode(p_device_key_sha256,'hex'),credential_revision=credential_revision+1
      where user_id=a.user_id and installation_id=p_installation_id;
  end if;
  return r||jsonb_build_object('dispatch_ready',false);
end $$;

-- Legacy calls return incompatibility AFTER durable denial, never throw after it.
create or replace function public.cap_notifications_register_v1(p_installation_id uuid,p_expected_generation bigint,
 p_protocol text,p_endpoint text,p_p256dh text,p_auth text,p_vapid_key_version text,p_browser_expiration timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' as $$
declare r jsonb; begin
  r:=cap_notifications_private.revoke_authority_v1(p_installation_id,gen_random_uuid(),'legacy_mutation');
  return r||jsonb_build_object('ok',false,'reason','AUTHORIZATION_UPGRADE_REQUIRED','dispatch_ready',false);
end $$;
create function cap_notifications_private.legacy_binding_denial_v1(p_binding uuid,p_disable boolean) returns jsonb
language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare uid uuid:=cap_notifications_private.request_owner(); installation uuid; r jsonb;
begin
  select installation_id into installation from cap_notifications_private.bindings where user_id=uid and id=p_binding;
  if installation is null then return jsonb_build_object('ok',false,'reason','BINDING_UNAVAILABLE'); end if;
  r:=cap_notifications_private.revoke_authority_v1(installation,gen_random_uuid(),'legacy_mutation');
  if p_disable then
    return r|| (select jsonb_build_object('binding_id',id,'generation',generation,'schedule_revision',schedule_revision,'state',state)
      from cap_notifications_private.bindings where user_id=uid and id=p_binding);
  end if;
  return r||jsonb_build_object('ok',false,'reason','AUTHORIZATION_UPGRADE_REQUIRED','dispatch_ready',false);
end $$;
create or replace function public.cap_notifications_invalidate_v1(p_binding_id uuid,p_generation bigint,p_expected_revision bigint,p_disable boolean)
returns jsonb language sql volatile security definer set search_path=pg_catalog as $$
 select cap_notifications_private.legacy_binding_denial_v1(p_binding_id,true)
$$;
do $$ declare sig text; p record; begin
  for p in select oid,proname from pg_proc where oid in (
    'public.cap_notifications_publish_v1(uuid,bigint,bigint,bigint,text,text,text,text,timestamptz,jsonb)'::regprocedure,
    'public.cap_notifications_publish_v2(uuid,bigint,bigint,bigint,text,text,text,text,jsonb)'::regprocedure) loop
    sig:=pg_get_function_arguments(p.oid);
    execute format('create or replace function public.%I(%s) returns jsonb language sql volatile security definer set search_path=pg_catalog as %L',
      p.proname,sig,'select cap_notifications_private.legacy_binding_denial_v1(p_binding_id,false)');
  end loop;
end $$;

-- Phase 1 does not implement positive sender authorization. Independent of flags.
create or replace function cap_notifications_runtime.claim_v1(p_run uuid) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' as $$
begin perform cap_notifications_runtime.check_caller_v1(); return jsonb_build_object('ok',false,'status','authorization_foundation_dark'); end $$;
create or replace function cap_notifications_runtime.start_dispatch_v1(p_run uuid,p_claim uuid) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' as $$
begin perform cap_notifications_runtime.check_caller_v1(); return jsonb_build_object('ok',false,'status','authorization_foundation_dark'); end $$;

-- Lock down only this migration's functions; preserve historical entrypoint ACLs.
do $$ declare p record; begin
  for p in select proc.oid,proc.proname,n.nspname from pg_proc proc join pg_namespace n on n.oid=proc.pronamespace where
    n.nspname='cap_notifications_private' and proc.proname in ('authorization_contract_ok_v1','authorization_session_live_v1',
      'authorization_session_id_v1','lock_authority_v1','revoke_authority_v1','register_transport_v3','legacy_binding_denial_v1')
    or n.nspname='public' and proc.proname in ('cap_notifications_revoke_authorization_v1','cap_notifications_register_v3',
      'cap_notifications_prepare_authorization_v1','cap_notifications_commit_authorization_v1',
      'cap_notifications_authorization_status_v1','cap_notifications_reset_device_key_v1') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role,cap_notification_runtime,cap_notification_sender_login',p.oid::regprocedure);
    if p.nspname='public' then
      execute format('alter function %s owner to cap_notification_manager',p.oid::regprocedure);
      execute format('grant execute on function %s to authenticated',p.oid::regprocedure);
    else execute format('grant execute on function %s to cap_notification_manager',p.oid::regprocedure); end if;
  end loop;
end $$;
revoke create on schema public from cap_notification_manager;
revoke cap_notification_manager from current_user granted by current_user;
revoke cap_notification_runtime from current_user granted by current_user;
do $$ declare digest text; begin
  digest:=cap_notifications_runtime.catalog_digest_v1();
  execute format('create or replace function cap_notifications_runtime.catalog_seal_v1() returns text language sql immutable security invoker set search_path=pg_catalog set timezone=''UTC'' as %L','select '||quote_literal(digest)||'::text');
  if not cap_notifications_runtime.contract_ok_v1() then raise exception 'NOTIFICATION_AUTHORIZATION_POSTFLIGHT_FAILED'; end if;
end $$;
commit;
