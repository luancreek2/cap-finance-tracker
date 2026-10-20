-- Phase 6K.2A manual-review SQL only. Do not apply automatically.
-- Atomic transaction INSERT + dependent account UPDATE for the controlled test.

create or replace function public.cap_test_transaction_create(
  p_transaction_id uuid,
  p_legacy_id text,
  p_account_id uuid,
  p_category_id uuid,
  p_bill_id uuid,
  p_amount numeric,
  p_transaction_date date,
  p_posting_date date,
  p_status text,
  p_title text,
  p_description text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  a public.accounts%rowtype;
  existing public.transactions%rowtype;
  inserted_id uuid;
  expected_balance numeric(18,2);
  updated_balance numeric(18,2);
  delta numeric(18,2);
  canonical_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
begin
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_transaction_id is null or p_account_id is null then raise exception 'TRANSACTION_ID_AND_ACCOUNT_REQUIRED'; end if;
  if p_amount is null or p_amount = 'NaN'::numeric or p_amount = 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_transaction_date is null then raise exception 'TRANSACTION_DATE_REQUIRED'; end if;
  if p_posting_date is not null and p_posting_date < p_transaction_date then raise exception 'INVALID_POSTING_DATE'; end if;
  if p_status not in ('posted','pending') then raise exception 'INVALID_TRANSACTION_STATUS'; end if;

  -- Serialize retries for the same stable transaction UUID before checking or inserting.
  perform pg_advisory_xact_lock(hashtextextended(p_transaction_id::text, 0));

  select * into existing
  from public.transactions
  where id = p_transaction_id
  for update;

  if found then
    if existing.user_id is distinct from uid then raise exception 'TRANSACTION_OWNERSHIP_FAILED'; end if;
    if existing.account_id is distinct from p_account_id
       or existing.category_id is distinct from p_category_id
       or existing.bill_id is distinct from p_bill_id
       or existing.legacy_id is distinct from p_legacy_id
       or existing.amount is distinct from p_amount
       or existing.transaction_date is distinct from p_transaction_date
       or existing.posting_date is distinct from p_posting_date
       or existing.status is distinct from p_status
       or existing.title is distinct from p_title
       or existing.description is distinct from p_description
       or existing.metadata is distinct from canonical_metadata
    then raise exception 'ALREADY_APPLIED_PAYLOAD_MISMATCH'; end if;
    return jsonb_build_object('status','ALREADY_APPLIED','transaction_id',existing.id,'account_id',existing.account_id);
  end if;

  select * into a
  from public.accounts
  where id = p_account_id and user_id = uid
  for update;
  if not found then raise exception 'ACCOUNT_OWNERSHIP_FAILED'; end if;
  if p_category_id is not null and not exists(select 1 from public.categories where id=p_category_id and user_id=uid) then raise exception 'CATEGORY_OWNERSHIP_FAILED'; end if;
  if p_bill_id is not null and not exists(select 1 from public.bills where id=p_bill_id and user_id=uid) then raise exception 'BILL_OWNERSHIP_FAILED'; end if;

  insert into public.transactions(id,user_id,account_id,category_id,bill_id,legacy_id,amount,transaction_date,posting_date,status,title,description,metadata)
  values(p_transaction_id,uid,p_account_id,p_category_id,p_bill_id,p_legacy_id,p_amount,p_transaction_date,p_posting_date,p_status,p_title,p_description,canonical_metadata)
  returning id into inserted_id;

  -- Matches Cap's existing bApply(): credit accounts use -amount; all other
  -- account types use amount. Amounts remain signed exactly as Cap stores them.
  delta = case when a.account_type = 'credit' then -p_amount else p_amount end;
  expected_balance = round(a.balance + delta, 2);
  update public.accounts
  set balance = expected_balance
  where id = p_account_id and user_id = uid;
  if not found then raise exception 'ACCOUNT_UPDATE_FAILED'; end if;
  select balance into updated_balance from public.accounts where id=p_account_id and user_id=uid;
  if updated_balance is distinct from expected_balance then raise exception 'ACCOUNT_BALANCE_VERIFICATION_FAILED'; end if;
  return jsonb_build_object('status','APPLIED','transaction_id',inserted_id,'account_id',p_account_id);
end;
$$;

revoke all on function public.cap_test_transaction_create(uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb) from anon, public;
grant execute on function public.cap_test_transaction_create(uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb) to authenticated;
