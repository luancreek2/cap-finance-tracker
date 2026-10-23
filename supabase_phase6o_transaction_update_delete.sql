-- Phase 6O DRAFT: prepare/review only. NOT authorized for production deployment.
-- Prerequisite: supabase_production_transaction_create.sql must already be
-- installed (it creates cap_transaction_writer, cap_sync_private and the create
-- receipt contract). This is a first-install script, not an idempotent migration.
-- Runtime supports simple POSTED transaction UPDATE and DELETE only. It does not
-- support pending transitions, bill/parent/statement links, transfers, fees,
-- statements or any other financial entity.
-- This script alone does NOT make Cloud Sync ready. The client gates these writes
-- on cap_verify_transaction_update_delete_v1, a separate attestation that never
-- widens the Phase 6N readiness contract.
-- Guard (must be explicitly set by the isolated harness/reviewed installer):
--   SET cap.transaction_update_delete_install = 'reviewed-draft-only';
begin;
do $$ begin
  if current_setting('cap.transaction_update_delete_install',true) is distinct from 'reviewed-draft-only' then
    raise exception 'TRANSACTION_UPDATE_DELETE_INSTALL_NOT_APPROVED';
  end if;
  if to_regprocedure('public.cap_sync_transaction_create(uuid,jsonb,jsonb)') is null
     or to_regclass('cap_sync_private.transaction_create_receipts') is null
     or not exists(select 1 from pg_roles where rolname='cap_transaction_writer')
     or to_regnamespace('cap_sync_private') is null then
    raise exception 'TRANSACTION_CREATE_PREREQUISITE_REQUIRED';
  end if;
  if to_regclass('cap_sync_private.transaction_change_receipts') is not null
     or to_regprocedure('public.cap_sync_transaction_update(uuid,uuid,jsonb,jsonb,jsonb)') is not null
     or to_regprocedure('public.cap_sync_transaction_delete(uuid,uuid,jsonb,jsonb)') is not null
     or to_regprocedure('public.cap_verify_transaction_update_delete_v1()') is not null then
    raise exception 'TRANSACTION_UPDATE_DELETE_INSTALL_TARGET_NOT_EMPTY';
  end if;
  if exists(select 1 from pg_class where oid in ('public.accounts'::regclass,
      'public.transactions'::regclass,'public.categories'::regclass) and not relrowsecurity) then
    raise exception 'TRANSACTION_TABLE_RLS_REQUIRED';
  end if;
end $$;

-- The SQL editor role is not a superuser and Phase 6N deliberately revokes its
-- temporary membership in cap_transaction_writer before committing. PostgreSQL's
-- ALTER ... OWNER TO therefore requires a fresh, SET-capable membership, and the
-- incoming owner needs CREATE on the containing schema. Mirror Phase 6N: make
-- both temporary, transfer ownership below, then remove them before the final
-- role-boundary assertion and commit. USAGE on cap_sync_private remains.
do $$ begin
  execute format('grant cap_transaction_writer to %I with admin false, inherit true, set true', current_user);
end $$;
grant usage, create on schema public to cap_transaction_writer;
grant usage, create on schema cap_sync_private to cap_transaction_writer;

-- Receipts bind an operation UUID to the exact request and outcome. DELETE
-- receipts intentionally have no transaction FK because the row is removed.
create table cap_sync_private.transaction_change_receipts (
  user_id uuid not null references auth.users(id) on delete restrict,
  operation_id uuid not null,
  action text not null check(action in ('UPDATE','DELETE')),
  transaction_id uuid not null,
  account_ids uuid[] not null,
  request jsonb not null,
  outcome text not null check(outcome in ('APPLIED','CONFLICT')),
  result jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key(user_id,operation_id),
  check(cardinality(account_ids) between 0 and 2)
);
create index transaction_change_receipts_lookup
  on cap_sync_private.transaction_change_receipts(user_id,transaction_id,action);
revoke all on cap_sync_private.transaction_change_receipts from public, anon, authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'revoke all on cap_sync_private.transaction_change_receipts from service_role';
  end if;
end $$;
grant select, insert on cap_sync_private.transaction_change_receipts to cap_transaction_writer;
alter table cap_sync_private.transaction_change_receipts enable row level security;
alter table cap_sync_private.transaction_change_receipts force row level security;
create policy transaction_change_receipt_read on cap_sync_private.transaction_change_receipts
  for select to cap_transaction_writer using(user_id=public.cap_request_uid());
create policy transaction_change_receipt_insert on cap_sync_private.transaction_change_receipts
  for insert to cap_transaction_writer with check(user_id=public.cap_request_uid());

-- A Phase 6O delete removes the transaction row but must retain the Phase 6N
-- create receipt for create idempotency. The original FK was ON DELETE RESTRICT,
-- so replace it with an unenforced historical UUID reference.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
    where conrelid='cap_sync_private.transaction_create_receipts'::regclass
      and contype='f' and confrelid='public.transactions'::regclass loop
    execute format('alter table cap_sync_private.transaction_create_receipts drop constraint %I',c.conname);
  end loop;
end $$;

-- Narrow table capability: only the exact columns the RPC rewrites. No DELETE
-- on accounts, no UPDATE on transactions for anon/authenticated, no ownership.
grant update(account_id,category_id,bill_id,parent_transaction_id,statement_id,legacy_id,
  amount,transaction_date,posting_date,status,title,description,metadata)
  on public.transactions to cap_transaction_writer;
grant delete on public.transactions to cap_transaction_writer;
create policy transaction_writer_transaction_update on public.transactions
  for update to cap_transaction_writer using(user_id=public.cap_request_uid())
  with check(user_id=public.cap_request_uid());
create policy transaction_writer_transaction_delete on public.transactions
  for delete to cap_transaction_writer using(user_id=public.cap_request_uid());

-- Direct client writes are not part of the reviewed create/update/delete RPC
-- architecture. Revoke table-level and column-level write privileges from
-- browser roles and PUBLIC, while leaving existing read access untouched.
-- Phase 6N CREATE remains available through cap_sync_transaction_create, whose
-- SECURITY DEFINER owner is the narrow cap_transaction_writer role.
revoke insert, update, delete, truncate on public.transactions
  from public, anon, authenticated;
do $$
declare c record;
begin
  for c in select attname from pg_attribute
    where attrelid='public.transactions'::regclass and attnum>0 and not attisdropped
  loop
    execute format('revoke insert (%I) on public.transactions from public, anon, authenticated',c.attname);
    execute format('revoke update (%I) on public.transactions from public, anon, authenticated',c.attname);
  end loop;
end $$;
do $$ begin
  if has_any_column_privilege('authenticated','public.transactions','INSERT')
     or has_any_column_privilege('authenticated','public.transactions','UPDATE')
     or has_table_privilege('authenticated','public.transactions','DELETE')
     or has_table_privilege('authenticated','public.transactions','TRUNCATE')
     or has_any_column_privilege('anon','public.transactions','INSERT')
     or has_any_column_privilege('anon','public.transactions','UPDATE')
     or has_table_privilege('anon','public.transactions','DELETE')
     or has_table_privilege('anon','public.transactions','TRUNCATE') then
    raise exception 'TRANSACTION_DIRECT_WRITE_CUTOVER_FAILED';
  end if;
end $$;
-- PHASE6O_PERMISSION_CUTOVER_COMPLETE

-- Single runtime contract check shared by both RPCs and the attestation.
create function cap_sync_private.cap_transaction_change_contract_ok()
returns boolean language sql stable security definer
set search_path=pg_catalog as $$
  select public.cap_request_identity_ok()
    and current_user='cap_transaction_writer'
    and not exists(select 1 from pg_roles where rolname=current_user and
      (rolsuper or rolbypassrls or rolcanlogin or rolcreatedb or rolcreaterole or rolreplication or rolinherit))
    and public.cap_role_boundary_ok(current_user::regrole)
    and not exists(select 1 from pg_roles where rolname in ('anon','authenticated') and
      (rolsuper or rolbypassrls or rolcreaterole))
    and not exists(select 1 from pg_class where oid in ('public.accounts'::regclass,
      'public.categories'::regclass,'public.transactions'::regclass,
      'cap_sync_private.transaction_change_receipts'::regclass)
      and (not relrowsecurity or relowner=current_user::regrole))
    and coalesce((select relforcerowsecurity from pg_class
      where oid='cap_sync_private.transaction_change_receipts'::regclass),false)
    and not has_schema_privilege(current_user,'public','CREATE')
    and not has_schema_privilege(current_user,'cap_sync_private','CREATE')
    and not has_any_column_privilege('authenticated','public.transactions','INSERT')
    and not has_any_column_privilege('authenticated','public.transactions','UPDATE')
    and not has_table_privilege('authenticated','public.transactions','DELETE')
    and not has_table_privilege('authenticated','public.transactions','TRUNCATE')
    and not has_any_column_privilege('anon','public.transactions','INSERT')
    and not has_any_column_privilege('anon','public.transactions','UPDATE')
    and not has_table_privilege('anon','public.transactions','DELETE')
    and not has_table_privilege('anon','public.transactions','TRUNCATE')
    and not has_schema_privilege('anon','cap_sync_private','USAGE')
    and not has_schema_privilege('authenticated','cap_sync_private','USAGE')
    and not has_any_column_privilege('anon','cap_sync_private.transaction_change_receipts','SELECT,INSERT,UPDATE,REFERENCES')
    and not has_any_column_privilege('authenticated','cap_sync_private.transaction_change_receipts','SELECT,INSERT,UPDATE,REFERENCES')
    and not has_table_privilege('anon','cap_sync_private.transaction_change_receipts','DELETE,TRUNCATE,TRIGGER')
    and not has_table_privilege('authenticated','cap_sync_private.transaction_change_receipts','DELETE,TRUNCATE,TRIGGER')
    and not exists(select 1 from pg_trigger
      where tgrelid='cap_sync_private.transaction_change_receipts'::regclass and not tgisinternal)
$$;
revoke all on function cap_sync_private.cap_transaction_change_contract_ok() from public, anon, authenticated;
grant execute on function cap_sync_private.cap_transaction_change_contract_ok() to cap_transaction_writer;
alter function cap_sync_private.cap_transaction_change_contract_ok() owner to cap_transaction_writer;

create function public.cap_sync_transaction_update(
  p_operation_id uuid, p_id uuid, p_transaction jsonb,
  p_expected_transaction jsonb, p_expected_accounts jsonb
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog set timezone='UTC' set datestyle='ISO, YMD' as $$
declare
  uid uuid := public.cap_request_uid();
  txid uuid; acctid uuid; catid uuid; tx_amount numeric; txdate date; postdate date;
  old_tx public.transactions%rowtype; verified public.transactions%rowtype;
  old_acct public.accounts%rowtype; new_acct public.accounts%rowtype;
  after_old public.accounts%rowtype; after_new public.accounts%rowtype;
  category public.categories%rowtype;
  receipt cap_sync_private.transaction_change_receipts%rowtype;
  request_body jsonb; result_body jsonb; m jsonb;
  old_delta numeric; new_delta numeric; next_old numeric(18,2); next_new numeric(18,2);
  expected_count int; expected_account jsonb; expected_id uuid; same_account boolean;
  tx_keys text[]; desired_keys text[] := array['id','user_id','account_id','category_id','bill_id',
    'parent_transaction_id','statement_id','legacy_id','amount','transaction_date','posting_date',
    'status','title','description','metadata'];
  k text;
begin
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'UNSUPPORTED_ISOLATION'; end if;
  if not cap_sync_private.cap_transaction_change_contract_ok() then raise exception 'TRANSACTION_CONTRACT_NOT_VERIFIED'; end if;

  if p_operation_id is null or p_operation_id='00000000-0000-0000-0000-000000000000'::uuid then raise exception 'OPERATION_ID_REQUIRED'; end if;
  if p_id is null or p_id='00000000-0000-0000-0000-000000000000'::uuid then raise exception 'TRANSACTION_ID_REQUIRED'; end if;
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
    if txid is distinct from p_id then raise exception 'TRANSACTION_IDENTITY_CHANGED'; end if;
    if jsonb_typeof(p_transaction->'category_id') not in ('string','null') then raise exception 'INVALID_TRANSACTION_PAYLOAD'; end if;
    catid := (p_transaction->>'category_id')::uuid;
    if catid is not null and catid::text <> p_transaction->>'category_id' then raise exception 'INVALID_TRANSACTION_PAYLOAD'; end if;
    tx_amount := (p_transaction->>'amount')::numeric;
    if tx_amount=0 or tx_amount<>round(tx_amount,2) or abs(tx_amount)>9999999999999999.99 then raise exception 'INVALID_AMOUNT'; end if;
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

  if p_expected_transaction is null or jsonb_typeof(p_expected_transaction) is distinct from 'object'
     or octet_length(p_expected_transaction::text)>131072
     or p_expected_transaction->>'id' is distinct from p_id::text
     or p_expected_transaction->>'user_id' is distinct from uid::text
     or p_expected_transaction->>'legacy_id' is distinct from p_transaction->>'legacy_id' then
    raise exception 'INVALID_EXPECTED_TRANSACTION'; end if;
  if p_expected_accounts is null or jsonb_typeof(p_expected_accounts) is distinct from 'array'
     or jsonb_array_length(p_expected_accounts)>2 then raise exception 'INVALID_EXPECTED_ACCOUNTS'; end if;
  if exists(select 1 from jsonb_array_elements(p_expected_accounts) e where jsonb_typeof(e) is distinct from 'object')
     or (select count(distinct e->>'id') from jsonb_array_elements(p_expected_accounts) e)
        <> jsonb_array_length(p_expected_accounts) then raise exception 'INVALID_EXPECTED_ACCOUNTS'; end if;

  request_body := jsonb_build_object('version',1,'action','UPDATE','user_id',uid,'transaction_id',p_id,
    'transaction',p_transaction,'expected_transaction',p_expected_transaction,'expected_accounts',p_expected_accounts);
  -- Replay detection is always first, before any current-row comparison.
  perform pg_advisory_xact_lock(hashtextextended('cap.tx.change.operation:'||uid::text||':'||p_operation_id::text,0));
  select * into receipt from cap_sync_private.transaction_change_receipts
    where user_id=uid and operation_id=p_operation_id;
  if found then
    if receipt.request is distinct from request_body then raise exception 'OPERATION_REUSE_CONFLICT'; end if;
    if receipt.outcome='CONFLICT' then return receipt.result; end if;
    return receipt.result || jsonb_build_object('status','ALREADY_APPLIED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cap.tx.identity:'||p_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('cap.tx.legacy:'||uid::text||':'||(p_transaction->>'legacy_id'),0));
  select * into old_tx from public.transactions where id=p_id and user_id=uid for update;
  if not found then
    result_body := jsonb_build_object('status','CONFLICT');
  else
    select array_agg(attname::text order by attnum) into tx_keys from pg_attribute
      where attrelid='public.transactions'::regclass and attnum>0 and not attisdropped;
    if not(p_expected_transaction ?& tx_keys) or (p_expected_transaction-tx_keys)<>'{}'::jsonb then
      raise exception 'INVALID_EXPECTED_TRANSACTION'; end if;
    if old_tx.legacy_id is distinct from p_transaction->>'legacy_id'
       or old_tx.id is distinct from p_id or old_tx.user_id is distinct from uid then
      raise exception 'TRANSACTION_IDENTITY_CHANGED'; end if;
    if to_jsonb(old_tx) is distinct from p_expected_transaction then
      result_body := jsonb_build_object('status','CONFLICT');
    else
      -- Deterministic account lock order.
      if old_tx.account_id < acctid then
        perform 1 from public.accounts where id=old_tx.account_id and user_id=uid for update;
        if acctid is distinct from old_tx.account_id then
          perform 1 from public.accounts where id=acctid and user_id=uid for update; end if;
      else
        perform 1 from public.accounts where id=acctid and user_id=uid for update;
        if acctid is distinct from old_tx.account_id then
          perform 1 from public.accounts where id=old_tx.account_id and user_id=uid for update; end if;
      end if;
      select * into old_acct from public.accounts where id=old_tx.account_id and user_id=uid;
      if not found then raise exception 'ACCOUNT_OWNERSHIP_FAILED'; end if;
      select * into new_acct from public.accounts where id=acctid and user_id=uid;
      if not found then raise exception 'ACCOUNT_OWNERSHIP_FAILED'; end if;
      if old_acct.status <> 'Active' or new_acct.status <> 'Active' then raise exception 'ACCOUNT_NOT_ACTIVE'; end if;
      if m ? 'acct' and (jsonb_typeof(m->'acct') not in ('string','number')
        or m->>'acct' is distinct from new_acct.legacy_id) then raise exception 'TRANSACTION_METADATA_MISMATCH'; end if;
      if catid is not null then
        select * into category from public.categories where id=catid and user_id=uid;
        if not found then raise exception 'CATEGORY_OWNERSHIP_FAILED'; end if;
      end if;
      if m ? 'cat' and (jsonb_typeof(m->'cat') is distinct from 'string'
        or m->>'cat' is distinct from category.name) then raise exception 'TRANSACTION_METADATA_MISMATCH'; end if;

      same_account := old_tx.account_id = acctid;
      old_delta := case when old_acct.account_type='credit' then -old_tx.amount else old_tx.amount end;
      new_delta := case when new_acct.account_type='credit' then -tx_amount else tx_amount end;
      expected_count := jsonb_array_length(p_expected_accounts);
      if same_account then
        if old_delta = new_delta then
          if expected_count <> 0 then raise exception 'INVALID_EXPECTED_ACCOUNTS'; end if;
        elsif expected_count <> 1 then raise exception 'INVALID_EXPECTED_ACCOUNTS'; end if;
      elsif expected_count <> 2 then raise exception 'INVALID_EXPECTED_ACCOUNTS'; end if;

      for expected_account in select value from jsonb_array_elements(p_expected_accounts) loop
        expected_id := (expected_account->>'id')::uuid;
        if expected_id not in (old_tx.account_id, acctid) then raise exception 'INVALID_EXPECTED_ACCOUNTS'; end if;
        if expected_id = old_tx.account_id and to_jsonb(old_acct) is distinct from expected_account then
          result_body := jsonb_build_object('status','CONFLICT');
        elsif expected_id = acctid and to_jsonb(new_acct) is distinct from expected_account then
          result_body := jsonb_build_object('status','CONFLICT');
        end if;
      end loop;

      if result_body is null then
        if same_account then
          if old_delta <> new_delta then
            next_old := round(old_acct.balance+new_delta-old_delta,2);
            update public.accounts set balance=next_old where id=old_acct.id and user_id=uid;
            if not found then raise exception 'ACCOUNT_WRITE_NOT_VERIFIED'; end if;
            select * into after_old from public.accounts where id=old_acct.id and user_id=uid;
            if not found or (to_jsonb(after_old)-'updated_at') is distinct from
              ((to_jsonb(old_acct)-'updated_at')||jsonb_build_object('balance',next_old)) then
              raise exception 'ACCOUNT_WRITE_NOT_VERIFIED'; end if;
          else
            after_old := old_acct;
          end if;
          after_new := after_old;
        else
          next_old := round(old_acct.balance-old_delta,2);
          next_new := round(new_acct.balance+new_delta,2);
          update public.accounts set balance=next_old where id=old_acct.id and user_id=uid;
          if not found then raise exception 'ACCOUNT_WRITE_NOT_VERIFIED'; end if;
          update public.accounts set balance=next_new where id=new_acct.id and user_id=uid;
          if not found then raise exception 'ACCOUNT_WRITE_NOT_VERIFIED'; end if;
          select * into after_old from public.accounts where id=old_acct.id and user_id=uid;
          if not found or (to_jsonb(after_old)-'updated_at') is distinct from
            ((to_jsonb(old_acct)-'updated_at')||jsonb_build_object('balance',next_old)) then
            raise exception 'ACCOUNT_WRITE_NOT_VERIFIED'; end if;
          select * into after_new from public.accounts where id=new_acct.id and user_id=uid;
          if not found or (to_jsonb(after_new)-'updated_at') is distinct from
            ((to_jsonb(new_acct)-'updated_at')||jsonb_build_object('balance',next_new)) then
            raise exception 'ACCOUNT_WRITE_NOT_VERIFIED'; end if;
        end if;
        update public.transactions set account_id=acctid,category_id=catid,amount=tx_amount,
          transaction_date=txdate,posting_date=postdate,status='posted',
          title=p_transaction->>'title',description=p_transaction->>'description',metadata=m
        where id=txid and user_id=uid;
        if not found then raise exception 'TRANSACTION_WRITE_NOT_VERIFIED'; end if;
        select * into verified from public.transactions where id=txid and user_id=uid;
        if not found or (to_jsonb(verified)-array['created_at','updated_at']) is distinct from p_transaction then
          raise exception 'TRANSACTION_WRITE_NOT_VERIFIED'; end if;
        result_body := jsonb_build_object('status','APPLIED','receipt_version',1,'operation_id',p_operation_id,
          'action','UPDATE','transaction_id',txid,'transaction',to_jsonb(verified),
          'accounts',(case when same_account then jsonb_build_array(to_jsonb(after_old))
            else jsonb_build_array(to_jsonb(after_old),to_jsonb(after_new)) end));
      end if;
    end if;
  end if;
  insert into cap_sync_private.transaction_change_receipts(user_id,operation_id,action,transaction_id,
    account_ids,request,outcome,result)
  values(uid,p_operation_id,'UPDATE',p_id,
    (select array_agg(distinct x) from unnest(array[old_tx.account_id,(p_transaction->>'account_id')::uuid]) x where x is not null),
    request_body,result_body->>'status',result_body);
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
    if SQLSTATE='P0001' and SQLERRM=any(array[
      'AUTH_REQUIRED','UNSUPPORTED_ISOLATION','TRANSACTION_CONTRACT_NOT_VERIFIED',
      'OPERATION_ID_REQUIRED','TRANSACTION_ID_REQUIRED','INVALID_TRANSACTION_PAYLOAD',
      'TRANSACTION_OWNERSHIP_FAILED','UNSUPPORTED_TRANSACTION_GROUP','INVALID_AMOUNT',
      'INVALID_TRANSACTION_DATE','UNSUPPORTED_TRANSACTION_METADATA','TRANSACTION_METADATA_MISMATCH',
      'INVALID_TRANSACTION_METADATA','INVALID_EXPECTED_TRANSACTION','INVALID_EXPECTED_ACCOUNTS',
      'OPERATION_REUSE_CONFLICT','TRANSACTION_IDENTITY_CHANGED','ACCOUNT_OWNERSHIP_FAILED',
      'ACCOUNT_NOT_ACTIVE','CATEGORY_OWNERSHIP_FAILED','TRANSACTION_WRITE_NOT_VERIFIED',
      'ACCOUNT_WRITE_NOT_VERIFIED']) then raise;
    end if;
    raise exception 'TRANSACTION_UPDATE_FAILED';
end $$;

create function public.cap_sync_transaction_delete(
  p_operation_id uuid, p_id uuid, p_expected_transaction jsonb, p_expected_accounts jsonb
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog set timezone='UTC' set datestyle='ISO, YMD' as $$
declare
  uid uuid := public.cap_request_uid();
  old_tx public.transactions%rowtype; old_acct public.accounts%rowtype; after_acct public.accounts%rowtype;
  receipt cap_sync_private.transaction_change_receipts%rowtype;
  request_body jsonb; result_body jsonb; delta numeric; next_balance numeric(18,2);
  expected_account jsonb; tx_keys text[]; account_keys text[];
begin
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'UNSUPPORTED_ISOLATION'; end if;
  if not cap_sync_private.cap_transaction_change_contract_ok() then raise exception 'TRANSACTION_CONTRACT_NOT_VERIFIED'; end if;
  if p_operation_id is null or p_operation_id='00000000-0000-0000-0000-000000000000'::uuid then raise exception 'OPERATION_ID_REQUIRED'; end if;
  if p_id is null or p_id='00000000-0000-0000-0000-000000000000'::uuid then raise exception 'TRANSACTION_ID_REQUIRED'; end if;
  if p_expected_transaction is null or jsonb_typeof(p_expected_transaction) is distinct from 'object'
     or octet_length(p_expected_transaction::text)>131072
     or p_expected_transaction->>'id' is distinct from p_id::text
     or p_expected_transaction->>'user_id' is distinct from uid::text then
    raise exception 'INVALID_EXPECTED_TRANSACTION'; end if;
  if p_expected_accounts is null or jsonb_typeof(p_expected_accounts) is distinct from 'array'
     or jsonb_array_length(p_expected_accounts) <> 1
     or jsonb_typeof(p_expected_accounts->0) is distinct from 'object' then
    raise exception 'INVALID_EXPECTED_ACCOUNTS'; end if;

  request_body := jsonb_build_object('version',1,'action','DELETE','user_id',uid,'transaction_id',p_id,
    'expected_transaction',p_expected_transaction,'expected_accounts',p_expected_accounts);
  perform pg_advisory_xact_lock(hashtextextended('cap.tx.change.operation:'||uid::text||':'||p_operation_id::text,0));
  select * into receipt from cap_sync_private.transaction_change_receipts
    where user_id=uid and operation_id=p_operation_id;
  if found then
    if receipt.request is distinct from request_body then raise exception 'OPERATION_REUSE_CONFLICT'; end if;
    if receipt.outcome='CONFLICT' then return receipt.result; end if;
    return receipt.result || jsonb_build_object('status','ALREADY_APPLIED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cap.tx.identity:'||p_id::text,0));
  select * into old_tx from public.transactions where id=p_id and user_id=uid for update;
  if not found then
    result_body := jsonb_build_object('status','CONFLICT');
  else
    perform pg_advisory_xact_lock(hashtextextended('cap.tx.legacy:'||uid::text||':'||old_tx.legacy_id,0));
    select array_agg(attname::text order by attnum) into tx_keys from pg_attribute
      where attrelid='public.transactions'::regclass and attnum>0 and not attisdropped;
    if not(p_expected_transaction ?& tx_keys) or (p_expected_transaction-tx_keys)<>'{}'::jsonb then
      raise exception 'INVALID_EXPECTED_TRANSACTION'; end if;
    if old_tx.status <> 'posted' or old_tx.bill_id is not null
       or old_tx.parent_transaction_id is not null or old_tx.statement_id is not null then
      raise exception 'UNSUPPORTED_TRANSACTION_GROUP'; end if;
    if to_jsonb(old_tx) is distinct from p_expected_transaction then
      result_body := jsonb_build_object('status','CONFLICT');
    else
      select * into old_acct from public.accounts where id=old_tx.account_id and user_id=uid for update;
      if not found then raise exception 'ACCOUNT_OWNERSHIP_FAILED'; end if;
      if old_acct.status <> 'Active' then raise exception 'ACCOUNT_NOT_ACTIVE'; end if;
      select array_agg(attname::text order by attnum) into account_keys from pg_attribute
        where attrelid='public.accounts'::regclass and attnum>0 and not attisdropped;
      if not(p_expected_accounts->0 ?& account_keys)
         or ((p_expected_accounts->0)-account_keys)<>'{}'::jsonb
         or (p_expected_accounts->0->>'id') is distinct from old_acct.id::text
         or (p_expected_accounts->0->>'user_id') is distinct from uid::text then
        raise exception 'INVALID_EXPECTED_ACCOUNTS'; end if;
      if to_jsonb(old_acct) is distinct from p_expected_accounts->0 then
        result_body := jsonb_build_object('status','CONFLICT');
      else
        delta := case when old_acct.account_type='credit' then old_tx.amount else -old_tx.amount end;
        next_balance := round(old_acct.balance+delta,2);
        update public.accounts set balance=next_balance where id=old_acct.id and user_id=uid;
        if not found then raise exception 'ACCOUNT_WRITE_NOT_VERIFIED'; end if;
        select * into after_acct from public.accounts where id=old_acct.id and user_id=uid;
        if not found or (to_jsonb(after_acct)-'updated_at') is distinct from
          ((to_jsonb(old_acct)-'updated_at')||jsonb_build_object('balance',next_balance)) then
          raise exception 'ACCOUNT_WRITE_NOT_VERIFIED'; end if;
        delete from public.transactions where id=p_id and user_id=uid;
        if not found then raise exception 'TRANSACTION_WRITE_NOT_VERIFIED'; end if;
        if exists(select 1 from public.transactions where id=p_id and user_id=uid) then
          raise exception 'TRANSACTION_WRITE_NOT_VERIFIED'; end if;
        result_body := jsonb_build_object('status','APPLIED','receipt_version',1,'operation_id',p_operation_id,
          'action','DELETE','transaction_id',p_id,'account',to_jsonb(after_acct));
      end if;
    end if;
  end if;
  insert into cap_sync_private.transaction_change_receipts(user_id,operation_id,action,transaction_id,
    account_ids,request,outcome,result)
  values(uid,p_operation_id,'DELETE',p_id,
    (case when old_tx.account_id is null then '{}'::uuid[] else array[old_tx.account_id] end),
    request_body,result_body->>'status',result_body);
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
    if SQLSTATE='P0001' and SQLERRM=any(array[
      'AUTH_REQUIRED','UNSUPPORTED_ISOLATION','TRANSACTION_CONTRACT_NOT_VERIFIED',
      'OPERATION_ID_REQUIRED','TRANSACTION_ID_REQUIRED','INVALID_EXPECTED_TRANSACTION',
      'INVALID_EXPECTED_ACCOUNTS','OPERATION_REUSE_CONFLICT','UNSUPPORTED_TRANSACTION_GROUP',
      'ACCOUNT_OWNERSHIP_FAILED','ACCOUNT_NOT_ACTIVE','ACCOUNT_WRITE_NOT_VERIFIED',
      'TRANSACTION_WRITE_NOT_VERIFIED']) then raise;
    end if;
    raise exception 'TRANSACTION_DELETE_FAILED';
end $$;

comment on function public.cap_sync_transaction_update(uuid,uuid,jsonb,jsonb,jsonb) is 'CAP_TX_UPDATE_CAS_RECEIPT_V1';
comment on function public.cap_sync_transaction_delete(uuid,uuid,jsonb,jsonb) is 'CAP_TX_DELETE_CAS_RECEIPT_V1';
revoke all on function public.cap_sync_transaction_update(uuid,uuid,jsonb,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.cap_sync_transaction_delete(uuid,uuid,jsonb,jsonb) from public, anon, authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'revoke all on function public.cap_sync_transaction_update(uuid,uuid,jsonb,jsonb,jsonb) from service_role';
    execute 'revoke all on function public.cap_sync_transaction_delete(uuid,uuid,jsonb,jsonb) from service_role';
  end if;
end $$;
grant execute on function public.cap_sync_transaction_update(uuid,uuid,jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.cap_sync_transaction_delete(uuid,uuid,jsonb,jsonb) to authenticated;
alter function public.cap_sync_transaction_update(uuid,uuid,jsonb,jsonb,jsonb) owner to cap_transaction_writer;
alter function public.cap_sync_transaction_delete(uuid,uuid,jsonb,jsonb) owner to cap_transaction_writer;

create function public.cap_verify_transaction_update_delete_v1()
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog set timezone='UTC' as $$
declare
  update_oid oid := to_regprocedure('public.cap_sync_transaction_update(uuid,uuid,jsonb,jsonb,jsonb)');
  delete_oid oid := to_regprocedure('public.cap_sync_transaction_delete(uuid,uuid,jsonb,jsonb)');
  checks jsonb; ready boolean;
begin
  if public.cap_request_uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  checks := jsonb_build_object(
    'update_function', update_oid is not null,
    'delete_function', delete_oid is not null,
    'receipts_table', to_regclass('cap_sync_private.transaction_change_receipts') is not null,
    'receipts_forced_rls', coalesce((select relforcerowsecurity from pg_class
      where oid='cap_sync_private.transaction_change_receipts'::regclass),false),
    'create_receipt_delete_safe', not exists(select 1 from pg_constraint
      where conrelid='cap_sync_private.transaction_create_receipts'::regclass
        and contype='f' and confrelid='public.transactions'::regclass),
    'writer_role', exists(select 1 from pg_roles where rolname='cap_transaction_writer'
      and not rolcanlogin and not rolinherit and not rolsuper and not rolbypassrls
      and not rolcreatedb and not rolcreaterole and not rolreplication),
    'contract', cap_sync_private.cap_transaction_change_contract_ok(),
    'update_comment', update_oid is not null
      and coalesce(obj_description(update_oid,'pg_proc'),'')='CAP_TX_UPDATE_CAS_RECEIPT_V1',
    'delete_comment', delete_oid is not null
      and coalesce(obj_description(delete_oid,'pg_proc'),'')='CAP_TX_DELETE_CAS_RECEIPT_V1',
    'update_owner', update_oid is not null and coalesce((select r.rolname from pg_proc p
      join pg_roles r on r.oid=p.proowner where p.oid=update_oid),'')='cap_transaction_writer',
    'delete_owner', delete_oid is not null and coalesce((select r.rolname from pg_proc p
      join pg_roles r on r.oid=p.proowner where p.oid=delete_oid),'')='cap_transaction_writer',
    'anon_update_execute', coalesce(update_oid is not null and has_function_privilege('anon',update_oid,'EXECUTE'),false),
    'anon_delete_execute', coalesce(delete_oid is not null and has_function_privilege('anon',delete_oid,'EXECUTE'),false),
    'authenticated_update_execute', coalesce(update_oid is not null and has_function_privilege('authenticated',update_oid,'EXECUTE'),false),
    'authenticated_delete_execute', coalesce(delete_oid is not null and has_function_privilege('authenticated',delete_oid,'EXECUTE'),false),
    'authenticated_insert_denied', not has_any_column_privilege('authenticated','public.transactions','INSERT'),
    'authenticated_update_denied', not has_any_column_privilege('authenticated','public.transactions','UPDATE'),
    'authenticated_delete_denied', not has_table_privilege('authenticated','public.transactions','DELETE'),
    'authenticated_truncate_denied', not has_table_privilege('authenticated','public.transactions','TRUNCATE'),
    'anon_insert_denied', not has_any_column_privilege('anon','public.transactions','INSERT'),
    'anon_update_denied', not has_any_column_privilege('anon','public.transactions','UPDATE'),
    'anon_delete_denied', not has_table_privilege('anon','public.transactions','DELETE'),
    'anon_truncate_denied', not has_table_privilege('anon','public.transactions','TRUNCATE'),
    'update_public_execute_denied', update_oid is not null and not exists(
      select 1 from pg_proc p,
        aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=update_oid and a.grantee=0 and a.privilege_type='EXECUTE'),
    'delete_public_execute_denied', delete_oid is not null and not exists(
      select 1 from pg_proc p,
        aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=delete_oid and a.grantee=0 and a.privilege_type='EXECUTE'),
    'receipt_direct_access_denied',
      not has_schema_privilege('anon','cap_sync_private','USAGE')
      and not has_schema_privilege('authenticated','cap_sync_private','USAGE')
      and not has_any_column_privilege('anon','cap_sync_private.transaction_change_receipts','SELECT,INSERT,UPDATE,REFERENCES')
      and not has_any_column_privilege('authenticated','cap_sync_private.transaction_change_receipts','SELECT,INSERT,UPDATE,REFERENCES')
      and not has_table_privilege('anon','cap_sync_private.transaction_change_receipts','DELETE,TRUNCATE,TRIGGER')
      and not has_table_privilege('authenticated','cap_sync_private.transaction_change_receipts','DELETE,TRUNCATE,TRIGGER')
  );
  ready := (checks->>'update_function')::boolean and (checks->>'delete_function')::boolean
    and (checks->>'receipts_table')::boolean and (checks->>'receipts_forced_rls')::boolean
    and (checks->>'create_receipt_delete_safe')::boolean
    and (checks->>'writer_role')::boolean and (checks->>'contract')::boolean
    and (checks->>'update_comment')::boolean and (checks->>'delete_comment')::boolean
    and (checks->>'update_owner')::boolean and (checks->>'delete_owner')::boolean
    and not (checks->>'anon_update_execute')::boolean
    and not (checks->>'anon_delete_execute')::boolean
    and (checks->>'authenticated_update_execute')::boolean
    and (checks->>'authenticated_delete_execute')::boolean
    and (checks->>'authenticated_insert_denied')::boolean
    and (checks->>'authenticated_update_denied')::boolean
    and (checks->>'authenticated_delete_denied')::boolean
    and (checks->>'authenticated_truncate_denied')::boolean
    and (checks->>'anon_insert_denied')::boolean
    and (checks->>'anon_update_denied')::boolean
    and (checks->>'anon_delete_denied')::boolean
    and (checks->>'anon_truncate_denied')::boolean
    and (checks->>'update_public_execute_denied')::boolean
    and (checks->>'delete_public_execute_denied')::boolean
    and (checks->>'receipt_direct_access_denied')::boolean;
  return jsonb_build_object('version','CAP_TX_UPDATE_DELETE_READINESS_V1','ready',ready,
    'update_contract','CAP_TX_UPDATE_CAS_RECEIPT_V1','delete_contract','CAP_TX_DELETE_CAS_RECEIPT_V1',
    'checks',checks);
end $$;
revoke all on function public.cap_verify_transaction_update_delete_v1() from public, anon, authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'revoke all on function public.cap_verify_transaction_update_delete_v1() from service_role';
  end if;
end $$;
grant execute on function public.cap_verify_transaction_update_delete_v1() to authenticated;
alter function public.cap_verify_transaction_update_delete_v1() owner to cap_transaction_writer;

-- Remove every temporary install-only privilege before the boundary check. A
-- failed transaction rolls these grants and all ownership changes back atomically.
revoke create on schema public from cap_transaction_writer;
revoke create on schema cap_sync_private from cap_transaction_writer;
do $$ begin
  execute format('revoke cap_transaction_writer from %I', current_user);
end $$;

do $$ begin
  if not public.cap_role_boundary_ok('cap_transaction_writer'::regrole) then
    raise exception 'TRANSACTION_UPDATE_DELETE_INSTALL_ROLE_BOUNDARY_FAILED';
  end if;
end $$;
commit;
