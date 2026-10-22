-- Phase 6L DRAFT: prepare/review only. NOT authorized for production deployment.
-- Prerequisite: guarded supabase_production_identity.sql (Cap-owned identity).
-- Also requires supabase_production_role_boundary.sql (PG16+ admin membership).
-- First-install script, not an idempotent migration. No existing app rows are
-- changed by installation. Runtime supports simple POSTED transaction creation
-- only; no edits, deletes, transfers, bills, fees, posting transitions or purge.
-- Existing authenticated table grants/test RPCs are NOT removed here: that is a
-- separate reviewed cutover. This script alone does NOT make Cloud Sync ready.
-- Guard (must be explicitly set by the isolated harness/reviewed installer):
--   SET cap.transaction_create_install = 'reviewed-draft-only';
begin;
do $$ begin
  if current_setting('cap.transaction_create_install',true) is distinct from 'reviewed-draft-only' then
    raise exception 'TRANSACTION_INSTALL_NOT_APPROVED';
  end if;
  if to_regprocedure('public.cap_request_identity_ok()') is null
     or to_regprocedure('public.cap_role_boundary_ok(oid)') is null then
    raise exception 'IDENTITY_AND_ROLE_BOUNDARY_PREREQUISITES_REQUIRED';
  end if;
  if not public.cap_request_identity_ok() then raise exception 'REQUEST_IDENTITY_NOT_VERIFIED'; end if;
  if to_regnamespace('cap_sync_private') is not null
     or exists(select 1 from pg_roles where rolname='cap_transaction_writer')
     or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='cap_sync_transaction_create') then
    raise exception 'TRANSACTION_INSTALL_TARGET_NOT_EMPTY';
  end if;
  if exists(select 1 from pg_class where oid in ('public.accounts'::regclass,
      'public.transactions'::regclass,'public.categories'::regclass) and not relrowsecurity) then
    raise exception 'TRANSACTION_TABLE_RLS_REQUIRED';
  end if;
end $$;

create role cap_transaction_writer nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
-- Temporary installation membership and CREATE permission allow a non-superuser
-- table owner to assign function ownership. Both are revoked before commit.
do $$ begin execute format('grant cap_transaction_writer to %I with admin false, inherit true, set true',current_user); end $$;
grant usage, create on schema public to cap_transaction_writer;
grant execute on function public.cap_request_uid(),public.cap_request_identity_ok(),public.cap_role_boundary_ok(oid) to cap_transaction_writer;
create schema cap_sync_private;
revoke all on schema cap_sync_private from public, anon, authenticated;
grant usage on schema cap_sync_private to cap_transaction_writer;

create table cap_sync_private.transaction_create_receipts (
  user_id uuid not null references auth.users(id) on delete restrict,
  operation_id uuid not null,
  transaction_id uuid not null,
  account_id uuid not null,
  request jsonb not null,
  outcome text not null check(outcome in ('APPLIED','CONFLICT')),
  applied_transaction_id uuid,
  result jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key(user_id,operation_id),
  check((outcome='APPLIED') = (applied_transaction_id is not null)),
  foreign key(user_id,applied_transaction_id) references public.transactions(user_id,id) on delete restrict,
  foreign key(user_id,account_id) references public.accounts(user_id,id) on delete restrict
);
create unique index transaction_create_one_applied_receipt
  on cap_sync_private.transaction_create_receipts(user_id,transaction_id) where outcome='APPLIED';
create unique index transaction_create_one_applied_legacy
  on cap_sync_private.transaction_create_receipts(user_id,(request #>> '{transaction,legacy_id}')) where outcome='APPLIED';
revoke all on cap_sync_private.transaction_create_receipts from public, anon, authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'revoke all on schema cap_sync_private from service_role';
    execute 'revoke all on cap_sync_private.transaction_create_receipts from service_role';
  end if;
end $$;
grant select, insert on cap_sync_private.transaction_create_receipts to cap_transaction_writer;
alter table cap_sync_private.transaction_create_receipts enable row level security;
alter table cap_sync_private.transaction_create_receipts force row level security;
create policy transaction_receipt_read on cap_sync_private.transaction_create_receipts
  for select to cap_transaction_writer using(user_id=public.cap_request_uid());
create policy transaction_receipt_insert on cap_sync_private.transaction_create_receipts
  for insert to cap_transaction_writer with check(user_id=public.cap_request_uid());

-- No table ownership, schema CREATE, DELETE, TRUNCATE, receipt UPDATE or broad
-- financial UPDATE capability is given to the writer.
grant select on public.accounts, public.categories, public.transactions to cap_transaction_writer;
grant update(balance) on public.accounts to cap_transaction_writer;
grant insert on public.transactions to cap_transaction_writer;
create policy transaction_writer_account_read on public.accounts
  for select to cap_transaction_writer using(user_id=public.cap_request_uid());
create policy transaction_writer_account_update on public.accounts
  for update to cap_transaction_writer using(user_id=public.cap_request_uid()) with check(user_id=public.cap_request_uid());
create policy transaction_writer_category_read on public.categories
  for select to cap_transaction_writer using(user_id=public.cap_request_uid());
create policy transaction_writer_transaction_read on public.transactions
  for select to cap_transaction_writer using(user_id=public.cap_request_uid());
create policy transaction_writer_transaction_insert on public.transactions
  for insert to cap_transaction_writer with check(user_id=public.cap_request_uid());

create function public.cap_sync_transaction_create(
  p_operation_id uuid, p_transaction jsonb, p_expected_account jsonb
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog set timezone='UTC' set datestyle='ISO, YMD' as $$
declare
  uid uuid := public.cap_request_uid();
  txid uuid; acctid uuid; catid uuid; amount numeric; txdate date; postdate date;
  a public.accounts%rowtype; after_account public.accounts%rowtype;
  inserted public.transactions%rowtype; verified public.transactions%rowtype;
  category public.categories%rowtype;
  receipt cap_sync_private.transaction_create_receipts%rowtype;
  request_body jsonb; result_body jsonb; m jsonb; delta numeric; next_balance numeric(18,2);
  account_keys text[]; desired_keys text[] := array['id','user_id','account_id','category_id','bill_id',
    'parent_transaction_id','statement_id','legacy_id','amount','transaction_date','posting_date',
    'status','title','description','metadata'];
  k text; collision boolean := false;
begin
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  -- The supported PostgREST isolation is explicit. Higher isolation must retry
  -- from a new READ COMMITTED transaction, never treat a stale snapshot as proof.
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'UNSUPPORTED_ISOLATION'; end if;
  if not public.cap_request_identity_ok() or current_user <> 'cap_transaction_writer'
     or exists(select 1 from pg_roles where rolname=current_user and
       (rolsuper or rolbypassrls or rolcanlogin or rolcreatedb or rolcreaterole or rolreplication or rolinherit))
     or not public.cap_role_boundary_ok(current_user::regrole)
     or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls or rolcreaterole))
     or exists(select 1 from pg_class where oid in ('public.accounts'::regclass,'public.categories'::regclass,
       'public.transactions'::regclass,'cap_sync_private.transaction_create_receipts'::regclass)
       and (not relrowsecurity or relowner=current_user::regrole))
     or not (select relforcerowsecurity from pg_class where oid='cap_sync_private.transaction_create_receipts'::regclass)
     or has_schema_privilege(current_user,'public','CREATE')
     or has_schema_privilege(current_user,'cap_sync_private','CREATE')
     or has_schema_privilege('anon','cap_sync_private','USAGE')
     or has_schema_privilege('authenticated','cap_sync_private','USAGE')
     or has_any_column_privilege('anon','cap_sync_private.transaction_create_receipts','SELECT,INSERT,UPDATE,REFERENCES')
     or has_any_column_privilege('authenticated','cap_sync_private.transaction_create_receipts','SELECT,INSERT,UPDATE,REFERENCES')
     or has_table_privilege('anon','cap_sync_private.transaction_create_receipts','DELETE,TRUNCATE,TRIGGER')
     or has_table_privilege('authenticated','cap_sync_private.transaction_create_receipts','DELETE,TRUNCATE,TRIGGER')
     or has_function_privilege('anon','public.cap_sync_transaction_create(uuid,jsonb,jsonb)','EXECUTE')
     or exists(select 1 from pg_trigger where tgrelid='cap_sync_private.transaction_create_receipts'::regclass and not tgisinternal)
  then raise exception 'TRANSACTION_CONTRACT_NOT_VERIFIED'; end if;

  if p_operation_id is null or p_operation_id='00000000-0000-0000-0000-000000000000'::uuid then raise exception 'OPERATION_ID_REQUIRED'; end if;
  if p_transaction is null or jsonb_typeof(p_transaction) is distinct from 'object'
     or not(p_transaction ?& desired_keys) or (p_transaction-desired_keys) <> '{}'::jsonb
     or octet_length(p_transaction::text)>131072 then raise exception 'INVALID_TRANSACTION_PAYLOAD'; end if;
  if p_transaction->>'user_id' is distinct from uid::text then raise exception 'TRANSACTION_OWNERSHIP_FAILED'; end if;
  if jsonb_typeof(p_transaction->'id') is distinct from 'string'
     or jsonb_typeof(p_transaction->'account_id') is distinct from 'string'
     or jsonb_typeof(p_transaction->'legacy_id') is distinct from 'string'
     or length(btrim(p_transaction->>'legacy_id')) not between 1 and 256
     or jsonb_typeof(p_transaction->'amount') is distinct from 'number'
     or jsonb_typeof(p_transaction->'transaction_date') is distinct from 'string'
     or jsonb_typeof(p_transaction->'title') not in ('string','null')
     or jsonb_typeof(p_transaction->'description') not in ('string','null')
     or jsonb_typeof(p_transaction->'metadata') is distinct from 'object'
     or length(coalesce(p_transaction->>'title',''))>4096
     or length(coalesce(p_transaction->>'description',''))>16384 then raise exception 'INVALID_TRANSACTION_PAYLOAD'; end if;
  if p_transaction->'status' is distinct from '"posted"'::jsonb
     or p_transaction->'bill_id' is distinct from 'null'::jsonb
     or p_transaction->'parent_transaction_id' is distinct from 'null'::jsonb
     or p_transaction->'statement_id' is distinct from 'null'::jsonb then raise exception 'UNSUPPORTED_TRANSACTION_GROUP'; end if;
  begin
    txid := (p_transaction->>'id')::uuid; acctid := (p_transaction->>'account_id')::uuid;
    if txid::text <> p_transaction->>'id' or acctid::text <> p_transaction->>'account_id'
       or txid='00000000-0000-0000-0000-000000000000'::uuid then raise exception 'INVALID_TRANSACTION_PAYLOAD'; end if;
    if jsonb_typeof(p_transaction->'category_id') not in ('string','null') then raise exception 'INVALID_TRANSACTION_PAYLOAD'; end if;
    catid := (p_transaction->>'category_id')::uuid;
    if catid is not null and catid::text <> p_transaction->>'category_id' then raise exception 'INVALID_TRANSACTION_PAYLOAD'; end if;
    amount := (p_transaction->>'amount')::numeric;
    if amount=0 or amount<>round(amount,2) or abs(amount)>9999999999999999.99 then raise exception 'INVALID_AMOUNT'; end if;
    if p_transaction->>'transaction_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'INVALID_TRANSACTION_DATE'; end if;
    txdate := (p_transaction->>'transaction_date')::date;
    if txdate::text <> p_transaction->>'transaction_date' then raise exception 'INVALID_TRANSACTION_DATE'; end if;
    if jsonb_typeof(p_transaction->'posting_date') not in ('string','null') then raise exception 'INVALID_TRANSACTION_DATE'; end if;
    if p_transaction->>'posting_date' is not null then
      if p_transaction->>'posting_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'INVALID_TRANSACTION_DATE'; end if;
      postdate := (p_transaction->>'posting_date')::date;
      if postdate::text <> p_transaction->>'posting_date' or postdate<txdate then raise exception 'INVALID_TRANSACTION_DATE'; end if;
    end if;
  exception when invalid_text_representation or datetime_field_overflow then raise exception 'INVALID_TRANSACTION_PAYLOAD';
  end;
  m := p_transaction->'metadata';
  if (m-array['id','ts','d','pd','amt','cat','acct','note','desc','_u']) <> '{}'::jsonb then raise exception 'UNSUPPORTED_TRANSACTION_METADATA'; end if;
  if m ? 'id' and (jsonb_typeof(m->'id') not in ('number','string') or m->>'id' <> p_transaction->>'legacy_id')
     or m ? 'amt' and (jsonb_typeof(m->'amt') is distinct from 'number' or m->'amt' is distinct from p_transaction->'amount')
     or m ? 'd' and m->'d' is distinct from p_transaction->'transaction_date'
     or m ? 'pd' and (jsonb_typeof(m->'pd') is distinct from 'string' or coalesce(nullif(m->>'pd',''),'') <> coalesce(p_transaction->>'posting_date',''))
     or m ? 'note' and (jsonb_typeof(m->'note') is distinct from 'string' or m->>'note' <> coalesce(p_transaction->>'title',''))
     or m ? 'desc' and (jsonb_typeof(m->'desc') is distinct from 'string' or m->>'desc' <> coalesce(p_transaction->>'description',''))
  then raise exception 'TRANSACTION_METADATA_MISMATCH'; end if;
  foreach k in array array['ts','_u'] loop
    if m ? k then
      if jsonb_typeof(m->k) is distinct from 'number' then raise exception 'INVALID_TRANSACTION_METADATA'; end if;
      if (m->>k)::numeric < 0 or (m->>k)::numeric > 9007199254740991
         or trunc((m->>k)::numeric) <> (m->>k)::numeric then raise exception 'INVALID_TRANSACTION_METADATA'; end if;
    end if;
  end loop;
  if p_expected_account is null or jsonb_typeof(p_expected_account) is distinct from 'object'
     or p_expected_account->>'id' is distinct from acctid::text
     or p_expected_account->>'user_id' is distinct from uid::text
     or jsonb_typeof(p_expected_account->'balance') is distinct from 'number'
     or octet_length(p_expected_account::text)>262144 then raise exception 'INVALID_EXPECTED_ACCOUNT'; end if;
  select array_agg(attname::text order by attnum) into account_keys from pg_attribute
    where attrelid='public.accounts'::regclass and attnum>0 and not attisdropped;
  if not(p_expected_account ?& account_keys) or (p_expected_account-account_keys)<>'{}'::jsonb then raise exception 'INVALID_EXPECTED_ACCOUNT'; end if;

  request_body := jsonb_build_object('version',1,'user_id',uid,'transaction',p_transaction,'expected_account',p_expected_account);
  -- Order is always operation -> transaction -> legacy identity -> account. No balance mutation or
  -- current account comparison precedes replay detection.
  perform pg_advisory_xact_lock(hashtextextended('cap.tx.operation:'||uid::text||':'||p_operation_id::text,0));
  select * into receipt from cap_sync_private.transaction_create_receipts
    where user_id=uid and operation_id=p_operation_id;
  if found then
    if receipt.request is distinct from request_body then raise exception 'OPERATION_REUSE_CONFLICT'; end if;
    if receipt.outcome='CONFLICT' then return receipt.result; end if;
    return receipt.result || jsonb_build_object('status','ALREADY_APPLIED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cap.tx.identity:'||txid::text,0));
  perform pg_advisory_xact_lock(hashtextextended('cap.tx.legacy:'||uid::text||':'||(p_transaction->>'legacy_id'),0));
  select * into a from public.accounts where id=acctid and user_id=uid for update;
  if not found then raise exception 'ACCOUNT_OWNERSHIP_FAILED'; end if;
  if a.status <> 'Active' then raise exception 'ACCOUNT_NOT_ACTIVE'; end if;
  if m ? 'acct' and (jsonb_typeof(m->'acct') not in ('string','number') or m->>'acct' is distinct from a.legacy_id) then raise exception 'TRANSACTION_METADATA_MISMATCH'; end if;
  if catid is not null then
    select * into category from public.categories where id=catid and user_id=uid;
    if not found then raise exception 'CATEGORY_OWNERSHIP_FAILED'; end if;
  end if;
  if m ? 'cat' and (jsonb_typeof(m->'cat') is distinct from 'string' or m->>'cat' is distinct from category.name) then raise exception 'TRANSACTION_METADATA_MISMATCH'; end if;
  if to_jsonb(a) is distinct from p_expected_account then
    result_body := jsonb_build_object('status','CONFLICT');
  elsif exists(select 1 from public.transactions where user_id=uid and (id=txid or legacy_id=p_transaction->>'legacy_id'))
        or exists(select 1 from cap_sync_private.transaction_create_receipts where user_id=uid and outcome='APPLIED'
          and (transaction_id=txid or request #>> '{transaction,legacy_id}'=p_transaction->>'legacy_id')) then
    -- A new operation UUID cannot adopt a pre-existing transaction as its retry.
    result_body := jsonb_build_object('status','CONFLICT');
  else
    -- Same verified algorithm: insert once, then signed delta (+amount for
    -- cash/savings/debit/ewallet, -amount for credit), rounded to two decimals.
    begin
      insert into public.transactions(id,user_id,account_id,category_id,bill_id,parent_transaction_id,statement_id,
        legacy_id,amount,transaction_date,posting_date,status,title,description,metadata)
      values(txid,uid,acctid,catid,null,null,null,p_transaction->>'legacy_id',amount,txdate,postdate,
        'posted',p_transaction->>'title',p_transaction->>'description',m) returning * into inserted;
    exception when unique_violation then collision := true;
    end;
    if collision then result_body := jsonb_build_object('status','CONFLICT');
    else
      if inserted.id is distinct from txid then raise exception 'TRANSACTION_WRITE_NOT_VERIFIED'; end if;
      delta := case when a.account_type='credit' then -amount else amount end;
      next_balance := round(a.balance+delta,2);
      update public.accounts set balance=next_balance where id=acctid and user_id=uid;
      if not found then raise exception 'ACCOUNT_WRITE_NOT_VERIFIED'; end if;
      select * into after_account from public.accounts where id=acctid and user_id=uid;
      if not found or (to_jsonb(after_account)-'updated_at') is distinct from
        ((to_jsonb(a)-'updated_at') || jsonb_build_object('balance',next_balance)) then raise exception 'ACCOUNT_WRITE_NOT_VERIFIED'; end if;
      select * into verified from public.transactions where id=txid and user_id=uid;
      if not found or (to_jsonb(verified)-array['created_at','updated_at']) is distinct from p_transaction then
        raise exception 'TRANSACTION_WRITE_NOT_VERIFIED';
      end if;
      result_body := jsonb_build_object('status','APPLIED','receipt_version',1,'operation_id',p_operation_id,
        'transaction_id',txid,'account_id',acctid,'transaction',to_jsonb(verified),'account',to_jsonb(after_account));
    end if;
  end if;
  -- Bind successful AND CAS-conflicted valid requests. Conflict retries cannot
  -- later turn into writes, and changed request bodies require a new UUID.
  insert into cap_sync_private.transaction_create_receipts(user_id,operation_id,transaction_id,account_id,
    request,outcome,applied_transaction_id,result)
  values(uid,p_operation_id,txid,acctid,request_body,result_body->>'status',
    case when result_body->>'status'='APPLIED' then txid else null end,result_body);
  return result_body;
exception
  when foreign_key_violation then raise exception 'RELATIONSHIP_CHANGED';
  when numeric_value_out_of_range then raise exception 'AMOUNT_OUT_OF_RANGE';
  when unique_violation then raise exception 'TRANSACTION_RECEIPT_CONFLICT';
  when check_violation or not_null_violation then raise exception 'TRANSACTION_CONSTRAINT_FAILED';
  when insufficient_privilege then raise exception 'TRANSACTION_CONTRACT_NOT_VERIFIED';
  when serialization_failure or deadlock_detected or lock_not_available then
    raise exception using errcode=SQLSTATE, message='TRANSACTION_RETRY_REQUIRED';
  when others then
    -- Do not return trigger/constraint error bodies containing financial values.
    if SQLSTATE='P0001' and SQLERRM=any(array[
      'AUTH_REQUIRED','UNSUPPORTED_ISOLATION','TRANSACTION_CONTRACT_NOT_VERIFIED',
      'OPERATION_ID_REQUIRED','INVALID_TRANSACTION_PAYLOAD','TRANSACTION_OWNERSHIP_FAILED',
      'UNSUPPORTED_TRANSACTION_GROUP','INVALID_AMOUNT','INVALID_TRANSACTION_DATE',
      'UNSUPPORTED_TRANSACTION_METADATA','TRANSACTION_METADATA_MISMATCH',
      'INVALID_TRANSACTION_METADATA','INVALID_EXPECTED_ACCOUNT','OPERATION_REUSE_CONFLICT',
      'ACCOUNT_OWNERSHIP_FAILED','ACCOUNT_NOT_ACTIVE','CATEGORY_OWNERSHIP_FAILED',
      'TRANSACTION_WRITE_NOT_VERIFIED','ACCOUNT_WRITE_NOT_VERIFIED']) then raise;
    end if;
    raise exception 'TRANSACTION_CREATE_FAILED';
end $$;

comment on function public.cap_sync_transaction_create(uuid,jsonb,jsonb) is 'CAP_TX_CREATE_CAS_RECEIPT_V1';
revoke all on function public.cap_sync_transaction_create(uuid,jsonb,jsonb) from public, anon, authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'revoke all on function public.cap_sync_transaction_create(uuid,jsonb,jsonb) from service_role';
  end if;
end $$;
grant execute on function public.cap_sync_transaction_create(uuid,jsonb,jsonb) to authenticated;
alter function public.cap_sync_transaction_create(uuid,jsonb,jsonb) owner to cap_transaction_writer;
revoke create on schema public from cap_transaction_writer;
do $$ begin execute format('revoke cap_transaction_writer from %I',current_user); end $$;
do $$ begin
  if not public.cap_role_boundary_ok('cap_transaction_writer'::regrole) then
    raise exception 'TRANSACTION_INSTALL_ROLE_BOUNDARY_FAILED';
  end if;
end $$;
commit;
