-- CAP_NOTIFICATIONS_SCHEDULING_V2. LOCAL IMPLEMENTATION / REVIEW ONLY.
-- Successor to the sealed DARK 5B.3B contract. No activation or remote install.
-- Historical artifacts remain immutable. Explicit approval is session-local.
begin;
do $$ begin
  if current_setting('cap.notifications_scheduling_install',true) is distinct from 'reviewed-scheduling-v2' then
    raise exception 'NOTIFICATION_SCHEDULING_INSTALL_NOT_APPROVED'; end if;
  if current_user <> 'postgres' or not cap_notifications_runtime.contract_ok_v1()
    or exists(select 1 from pg_attribute where attrelid='cap_notifications_private.bindings'::regclass
      and attname='scheduling_contract' and not attisdropped)
    or exists(select 1 from cap_notifications_private.delivery_ledger where state in ('claimed','dispatch_started')) then
    raise exception 'NOTIFICATION_SCHEDULING_PREFLIGHT_FAILED'; end if;
end $$;

-- Preserve the platform ADMIN-only membership; remove only our temporary grant.
grant cap_notification_manager to current_user with admin false, inherit true, set true granted by current_user;
grant create on schema public to cap_notification_manager;

alter table cap_notifications_private.control
  add column scheduling_migration_id text not null default 'CAP_NOTIFICATIONS_SCHEDULING_V2'
    check(scheduling_migration_id='CAP_NOTIFICATIONS_SCHEDULING_V2'),
  add column max_future_hours integer not null default 8760 check(max_future_hours=8760);
-- Legacy delivery_time/max_publication still describe v1, not v2.
alter table cap_notifications_private.bindings
  add column scheduling_contract integer not null default 1 check(scheduling_contract in (1,2)),
  add column notification_timezone text check(notification_timezone is null or cap_notifications_private.valid_timezone(notification_timezone)),
  add constraint bindings_v2_timezone check(scheduling_contract=1 or notification_timezone is not null);
alter table cap_notifications_private.schedules
  add column scheduling_contract integer not null default 1 check(scheduling_contract in (1,2)),
  add column time_basis text,
  add column local_time time,
  add column obligation_digest text;

-- Resolve wall time with explicit round-trip rejection of PostgreSQL gap
-- normalization. Compare all offsets around the transition and choose the
-- latest matching instant, including non-hour and negative-DST folds.
create function cap_notifications_private.resolve_wall_v2(d date,t time,z text) returns timestamptz
language plpgsql stable security invoker set search_path=pg_catalog set timezone='UTC' as $$
declare wall timestamp:=d+t; guess timestamptz; resolved timestamptz;
begin
  if d is null or not isfinite(d) or t is null or not cap_notifications_private.valid_timezone(z) then
    raise exception 'NOTIFICATION_LOCAL_TIME_INVALID'; end if;
  guess:=wall at time zone z;
  if (guess at time zone z) is distinct from wall then raise exception 'NOTIFICATION_LOCAL_TIME_GAP'; end if;
  select max(candidate) into resolved from (
    select (wall-((sample at time zone z)-(sample at time zone 'UTC'))) at time zone 'UTC' candidate
    from generate_series(guess-interval '48 hours',guess+interval '48 hours',interval '1 hour') sample
  ) offsets where candidate at time zone z=wall;
  if resolved is null then raise exception 'NOTIFICATION_LOCAL_TIME_INVALID'; end if;
  return resolved;
end $$;
revoke all on function cap_notifications_private.resolve_wall_v2(date,time,text) from public,anon,authenticated,service_role,cap_notification_runtime,cap_notification_sender_login;
grant execute on function cap_notifications_private.resolve_wall_v2(date,time,text) to cap_notification_manager;

-- Remove only the two legacy-only predicates; the original expiry/local-day
-- ceilings remain in place for both versions. Catalog names verified by seal.
alter table cap_notifications_private.schedules drop constraint schedules_check;
alter table cap_notifications_private.schedules drop constraint schedules_check1;
alter table cap_notifications_private.schedules
  add constraint schedules_legacy_or_v2 check(
    (scheduling_contract=1 and time_basis is null and local_time is null and obligation_digest is null
      and publication_valid_until>published_at and publication_valid_until<=published_at+interval '168 hours'
      and send_after=(eligible_local_date+time '09:00') at time zone timezone)
    or
    (scheduling_contract=2 and time_basis is not null and time_basis in ('wall','absolute')
      and local_time is not null and extract(second from local_time)=0 and local_time<time '24:00'
      and obligation_digest is not null and obligation_digest ~ '^[0-9a-f]{64}$'
      and isfinite(send_after) and isfinite(expires_at) and isfinite(published_at)
      and publication_valid_until=expires_at
      and send_after<=published_at+interval '8760 hours'
      and expires_at<=send_after+interval '24 hours'));
create unique index schedules_v2_obligation_instant_idx
  on cap_notifications_private.schedules(user_id,binding_id,obligation_digest,send_after)
  where scheduling_contract=2;

-- Amend the two sealed entrypoints narrowly, without rewriting their legacy
-- behavior. v1 cannot downgrade/replace a negotiated v2 binding. Both versions
-- reject replacement during a claim/dispatch (recovery must resolve it first).
do $$ declare def text; old text; replacement text; begin
  def:=pg_get_functiondef('public.cap_notifications_publish_v1(uuid,bigint,bigint,bigint,text,text,text,text,timestamptz,jsonb)'::regprocedure);
  old:='  -- Validate the complete bounded request before any replacement.';
  replacement:=$guard$  if b.scheduling_contract<>1 then raise exception 'NOTIFICATION_SCHEDULING_VERSION_REQUIRED'; end if;
  if exists(select 1 from cap_notifications_private.delivery_ledger where user_id=uid and binding_id=b.id
    and state in ('claimed','dispatch_started')) then raise exception 'NOTIFICATION_PUBLICATION_BUSY'; end if;
  -- Validate the complete bounded request before any replacement.$guard$;
  if position(old in def)=0 then raise exception 'NOTIFICATION_SCHEDULING_FUNCTION_DRIFT'; end if;
  execute replace(def,old,replacement);
  -- Retain ALL runtime security predicates, changing only the contract identity
  -- predicate to additionally require this successor's immutable control values.
  def:=pg_get_functiondef('cap_notifications_runtime.contract_ok_v1()'::regprocedure);
  old:='and delivery_time=time ''09:00'' and max_publication=interval ''168 hours''';
  replacement:=old||' and scheduling_migration_id=''CAP_NOTIFICATIONS_SCHEDULING_V2'' and max_future_hours=8760';
  if position(old in def)=0 then raise exception 'NOTIFICATION_SCHEDULING_VERIFIER_DRIFT'; end if;
  def:=replace(def,old,replacement);
  -- Keep management isolation dynamically checked too: financial ACLs live
  -- outside the notification catalog seal and must not become a read path.
  old:='  return true;';
  replacement:=$manager$  for obj in select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','cap_sync_private','cap_notes_private','auth','storage') and c.relkind in ('r','p','v','m','S') loop
    if has_table_privilege('cap_notification_manager',obj.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege('cap_notification_manager',obj.oid,'SELECT,INSERT,UPDATE,REFERENCES') then return false; end if;
  end loop;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname in ('cap_sync_private','cap_notes_private','auth','storage')
      or n.nspname='public' and p.proname like 'cap\_%' escape '\' and p.proname not like 'cap_notifications_%')
    and has_function_privilege('cap_notification_manager',p.oid,'EXECUTE')) then return false; end if;
  return true;$manager$;
  if position(old in def)=0 then raise exception 'NOTIFICATION_SCHEDULING_VERIFIER_DRIFT'; end if;
  execute replace(def,old,replacement);
end $$;

-- Successful first v2 publication negotiates the binding contract atomically;
-- there is no separate destructive negotiation step and no downgrade path.
create function public.cap_notifications_publish_v2(p_binding_id uuid,p_generation bigint,p_expected_revision bigint,
  p_preference_revision bigint,p_protocol text,p_engine_identity text,p_digest_version text,p_timezone text,p_entries jsonb)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' set datestyle='ISO, YMD' as $$
declare uid uuid:=cap_notifications_private.request_owner(); b cap_notifications_private.bindings%rowtype;
  prior cap_notifications_private.schedules%rowtype; e jsonb; d date; lt time; z text; basis text;
  send_at timestamptz; expires timestamptz; pub timestamptz:=statement_timestamp(); revision bigint;
  count_new integer; seen text[]:='{}'; duplicate_key text; seen_obligations text[]:='{}'; result jsonb;
begin
  if not cap_notifications_private.contract_ok() then raise exception 'NOTIFICATION_CONTRACT_NOT_READY'; end if;
  if p_protocol is distinct from 'CAP_PUSH_V1' or p_engine_identity is distinct from 'cap-reminder-v1'
    or p_digest_version is distinct from 'hmac-sha256-v1' then raise exception 'NOTIFICATION_PROTOCOL_UNSUPPORTED'; end if;
  if not cap_notifications_private.valid_timezone(p_timezone) then raise exception 'NOTIFICATION_TIMEZONE_INVALID'; end if;
  if p_entries is null or jsonb_typeof(p_entries) is distinct from 'array' then raise exception 'NOTIFICATION_ENTRIES_INVALID'; end if;
  if jsonb_array_length(p_entries)>1000 or octet_length(p_entries::text)>262144 then raise exception 'NOTIFICATION_ENTRIES_INVALID'; end if;
  select * into b from cap_notifications_private.bindings where id=p_binding_id and user_id=uid for update;
  if b.id is null or b.state<>'pending' or b.generation is distinct from p_generation or b.browser_expiration<=pub
    or b.generation>9007199254740991 then raise exception 'NOTIFICATION_STALE_BINDING'; end if;
  if b.schedule_revision is distinct from p_expected_revision or p_preference_revision is null
    or p_preference_revision<b.preference_revision then raise exception 'NOTIFICATION_STALE_REVISION'; end if;
  if exists(select 1 from cap_notifications_private.delivery_ledger where user_id=uid and binding_id=b.id
    and state in ('claimed','dispatch_started')) then raise exception 'NOTIFICATION_PUBLICATION_BUSY'; end if;
  for e in select value from jsonb_array_elements(p_entries) loop
    if jsonb_typeof(e) is distinct from 'object' then raise exception 'NOTIFICATION_ENTRY_INVALID'; end if;
    if (select array_agg(k order by k) from jsonb_object_keys(e) k) is distinct from
      array['candidate_digest','eligible_local_date','expires_at','local_time','obligation_digest','send_after','time_basis','timezone']::text[] then
      raise exception 'NOTIFICATION_ENTRY_INVALID'; end if;
    if exists(select 1 from jsonb_each(e) where jsonb_typeof(value)<>'string')
      or e->>'candidate_digest' !~ '^[0-9a-f]{64}$' or e->>'obligation_digest' !~ '^[0-9a-f]{64}$'
      or e->>'eligible_local_date' !~ '^\d{4}-\d{2}-\d{2}$'
      or e->>'local_time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or e->>'send_after' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.[0-9]{1,6})?Z$'
      or e->>'expires_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.[0-9]{1,6})?Z$'
      or e->>'time_basis' not in ('wall','absolute') or not cap_notifications_private.valid_timezone(e->>'timezone') then
      raise exception 'NOTIFICATION_ENTRY_INVALID'; end if;
    begin
      d:=(e->>'eligible_local_date')::date; lt:=(e->>'local_time')::time; z:=e->>'timezone'; basis:=e->>'time_basis';
      send_at:=(e->>'send_after')::timestamptz; expires:=(e->>'expires_at')::timestamptz;
    exception when others then raise exception 'NOTIFICATION_ENTRY_INVALID'; end;
    if basis='wall' and z<>p_timezone then raise exception 'NOTIFICATION_TIMEZONE_MISMATCH'; end if;
    select * into prior from cap_notifications_private.schedules where user_id=uid and binding_id=b.id
      and candidate_digest=e->>'candidate_digest';
    -- Republication of an unchanged absolute instruction never re-resolves its
    -- UTC instant. New/edited original selections must satisfy gap/fold policy.
    if not coalesce(basis='absolute' and prior.scheduling_contract=2 and prior.time_basis='absolute'
      and prior.send_after=send_at and prior.timezone=z and prior.eligible_local_date=d and prior.local_time=lt,false) then
      if send_at is distinct from cap_notifications_private.resolve_wall_v2(d,lt,z) then
        raise exception 'NOTIFICATION_EXPECTED_UTC_MISMATCH'; end if;
    end if;
    if not isfinite(send_at) or not isfinite(expires) or expires<=send_at or expires<=pub
      or expires>least((d+1)::timestamp at time zone z,send_at+interval '24 hours')
      or send_at>pub+interval '8760 hours'
      or (send_at<pub and (prior.candidate_digest is null or prior.send_after is distinct from send_at)) then
      raise exception 'NOTIFICATION_ENTRY_WINDOW_INVALID'; end if;
    if b.browser_expiration is not null and expires>b.browser_expiration then raise exception 'NOTIFICATION_SUBSCRIPTION_TOO_SHORT'; end if;
    if e->>'candidate_digest'=any(seen) then raise exception 'NOTIFICATION_DUPLICATE_CANDIDATE'; end if;
    seen:=array_append(seen,e->>'candidate_digest');
    duplicate_key:=(e->>'obligation_digest')||':'||extract(epoch from send_at)::text;
    if duplicate_key=any(seen_obligations) then raise exception 'NOTIFICATION_DUPLICATE_OBLIGATION_TIME'; end if;
    seen_obligations:=array_append(seen_obligations,duplicate_key);
  end loop;
  select count(*) into count_new from jsonb_array_elements(p_entries) j(value) where not exists
    (select 1 from cap_notifications_private.delivery_ledger l where l.user_id=uid and l.binding_id=b.id and l.candidate_digest=j.value->>'candidate_digest');
  if count_new+(select count(*) from cap_notifications_private.delivery_ledger where user_id=uid and binding_id=b.id)>1000 then
    raise exception 'NOTIFICATION_LEDGER_FULL'; end if;
  revision:=b.schedule_revision+1;
  delete from cap_notifications_private.schedules where user_id=uid and binding_id=b.id;
  insert into cap_notifications_private.schedules(user_id,binding_id,generation,candidate_digest,protocol,engine_identity,digest_version,
    schedule_revision,preference_revision,eligible_local_date,timezone,send_after,expires_at,published_at,publication_valid_until,
    scheduling_contract,time_basis,local_time,obligation_digest)
    select uid,b.id,b.generation,value->>'candidate_digest',p_protocol,p_engine_identity,p_digest_version,revision,p_preference_revision,
      (value->>'eligible_local_date')::date,value->>'timezone',(value->>'send_after')::timestamptz,(value->>'expires_at')::timestamptz,
      pub,(value->>'expires_at')::timestamptz,2,value->>'time_basis',(value->>'local_time')::time,value->>'obligation_digest'
    from jsonb_array_elements(p_entries);
  insert into cap_notifications_private.delivery_ledger(user_id,binding_id,candidate_digest)
    select uid,b.id,value->>'candidate_digest' from jsonb_array_elements(p_entries) on conflict do nothing;
  update cap_notifications_private.bindings set scheduling_contract=2,notification_timezone=p_timezone,schedule_revision=revision,
    preference_revision=p_preference_revision,updated_at=pub where id=b.id and user_id=uid;
  select coalesce(jsonb_agg(jsonb_build_object('candidate_digest',s.candidate_digest,'send_after',s.send_after,'expires_at',s.expires_at,
    'time_basis',s.time_basis,'timezone',s.timezone,'eligible_local_date',s.eligible_local_date,
    'local_time',left(s.local_time::text,5),'delivery_state',l.state) order by s.candidate_digest),'[]'::jsonb) into result
    from cap_notifications_private.schedules s join cap_notifications_private.delivery_ledger l using(user_id,binding_id,candidate_digest)
    where s.user_id=uid and s.binding_id=b.id;
  return jsonb_build_object('binding_id',b.id,'generation',b.generation,'scheduling_contract',2,'schedule_revision',revision,
    'preference_revision',p_preference_revision,'notification_timezone',p_timezone,'accepted_at',pub,'entry_count',jsonb_array_length(p_entries),
    'occurrences',result,'dispatch_ready',false);
end $$;
revoke all on function public.cap_notifications_publish_v2(uuid,bigint,bigint,bigint,text,text,text,text,jsonb) from public,anon,authenticated,service_role,cap_notification_runtime,cap_notification_sender_login;
alter function public.cap_notifications_publish_v2(uuid,bigint,bigint,bigint,text,text,text,text,jsonb) owner to cap_notification_manager;
grant execute on function public.cap_notifications_publish_v2(uuid,bigint,bigint,bigint,text,text,text,text,jsonb) to authenticated;

create function public.cap_notifications_schedule_readback_v2(p_binding_id uuid,p_generation bigint) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC' as $$
declare uid uuid:=cap_notifications_private.request_owner(); b cap_notifications_private.bindings%rowtype; result jsonb;
begin
  if not cap_notifications_private.contract_ok() then raise exception 'NOTIFICATION_CONTRACT_NOT_READY'; end if;
  -- Serialize with publication/invalidation: revisions and rows form one snapshot.
  select * into b from cap_notifications_private.bindings where id=p_binding_id and user_id=uid for update;
  if b.id is null or b.generation is distinct from p_generation then raise exception 'NOTIFICATION_STALE_BINDING'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('candidate_digest',s.candidate_digest,'obligation_digest',s.obligation_digest,
    'send_after',s.send_after,'expires_at',s.expires_at,'time_basis',s.time_basis,'timezone',s.timezone,
    'eligible_local_date',s.eligible_local_date,'local_time',left(s.local_time::text,5),
    'published_at',s.published_at,'delivery_state',l.state) order by s.candidate_digest),'[]'::jsonb) into result
    from cap_notifications_private.schedules s join cap_notifications_private.delivery_ledger l using(user_id,binding_id,candidate_digest)
    where s.user_id=uid and s.binding_id=b.id;
  return jsonb_build_object('binding_id',b.id,'generation',b.generation,'scheduling_contract',b.scheduling_contract,'state',b.state,
    'schedule_revision',b.schedule_revision,'preference_revision',b.preference_revision,'notification_timezone',b.notification_timezone,'occurrences',result,'dispatch_ready',false);
end $$;
revoke all on function public.cap_notifications_schedule_readback_v2(uuid,bigint) from public,anon,authenticated,service_role,cap_notification_runtime,cap_notification_sender_login;
alter function public.cap_notifications_schedule_readback_v2(uuid,bigint) owner to cap_notification_manager;
grant execute on function public.cap_notifications_schedule_readback_v2(uuid,bigint) to authenticated;

create function public.cap_notifications_readiness_v2() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare uid uuid:=cap_notifications_private.request_owner(); begin
  return jsonb_build_object('migration_id','CAP_NOTIFICATIONS_SCHEDULING_V2','scheduling_contract',2,
    'protocol','CAP_PUSH_V1','engine_identity','cap-reminder-v1','digest_version','hmac-sha256-v1',
    'scheduling_ready',cap_notifications_private.contract_ok(),'max_future_hours',8760,
    'max_delivery_hours',24,'local_midnight_ceiling',true,'gap_policy','reject','fold_policy','later',
    'background_enabled',false,'background_ready',false,'runtime_parked',true,'dispatch_ready',false);
end $$;
revoke all on function public.cap_notifications_readiness_v2() from public,anon,authenticated,service_role,cap_notification_runtime,cap_notification_sender_login;
alter function public.cap_notifications_readiness_v2() owner to cap_notification_manager;
grant execute on function public.cap_notifications_readiness_v2() to authenticated;

revoke create on schema public from cap_notification_manager;
revoke cap_notification_manager from current_user granted by current_user;
-- The old seal is verified BEFORE any changes. This new seal covers every
-- successor function/column/constraint/index/ACL, after privilege cleanup.
do $$ declare digest text; begin
  digest:=cap_notifications_runtime.catalog_digest_v1();
  execute format('create or replace function cap_notifications_runtime.catalog_seal_v1() returns text language sql immutable security invoker set search_path=pg_catalog set timezone=''UTC'' as %L','select '||quote_literal(digest)||'::text');
  if not cap_notifications_runtime.contract_ok_v1() then raise exception 'NOTIFICATION_SCHEDULING_POSTFLIGHT_FAILED'; end if;
end $$;
commit;
