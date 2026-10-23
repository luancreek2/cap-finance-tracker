# Phase 6O — safe transaction update/delete

Local implementation and synthetic testing only. No production access, commit,
push, deployment, or live two-device test is part of this change.

## Supported groups

Exactly one financial group per snapshot (Policy B). A group is a posted
transaction that already has a baseline entry plus the one or two accounts whose
balances it moves:

- **update push**: the local transaction/baseline/account values change; cloud
  values still match the baseline. The RPC gets the exact prior cloud transaction
  and prior cloud account rows.
- **delete push**: the local transaction is absent but its baseline entry exists;
  the local account is corrected by the reversal delta. The RPC gets the prior
  cloud transaction and account row.
- **update pull**: the cloud transaction and account changed, local values still
  match the baseline.
- **delete pull**: the cloud transaction is gone and the cloud account is
  corrected by the reversal delta, local values still match the baseline.

The signed effect is `credit ? -amount : amount`. `cash`, `savings`, `debit`,
`credit`, and `ewallet` are supported. Same-account updates correct one balance;
A→B updates restore A and apply B. Metadata-only updates send no expected account.
Pending transactions, bill/parent/statement links, transfers, fees, statements,
opening/card-fee metadata, multiple groups, and every other entity remain
unsupported and pause for review.

## Push path

The existing outbox remains the source of operation identity. An update/delete
group is written to a durable journal before the RPC. The client then calls only:

- `cap_sync_transaction_update(p_operation_id,p_id,p_transaction,
  p_expected_transaction,p_expected_accounts)`
- `cap_sync_transaction_delete(p_operation_id,p_id,p_expected_transaction,
  p_expected_accounts)`

Write capability is a separate narrow attestation,
`cap_verify_transaction_update_delete_v1`. The Phase 6N readiness contract is not
widened. If the attestation is absent/false, no journal or RPC is created and the
engine pauses with `TRANSACTION_WRITE_CONTRACT_NOT_READY`.

After an `APPLIED`/`ALREADY_APPLIED` response the engine re-reads the cloud,
verifies every group fingerprint, advances the baseline, retires the exact
outbox entries, writes a private receipt, and clears the journal. A server
`CONFLICT` records inspectable `server-cas-conflict` data, retains the journal,
and pauses; it is never retried as last-write-wins. A network failure after a
possible commit retains the journal and the next cycle replays the same operation
UUID, receiving `ALREADY_APPLIED`.

## Pull path

Cloud groups are installed without entering the generic write path. State,
advanced baseline, and a durable before-image journal commit in one IndexedDB
transaction. The client then installs local state, re-reads it, re-verifies every
cloud and local fingerprint, and only then clears the journal. Failure rolls
state/baseline/journal back to the exact before-image; concurrent third values
halt with `LOCAL_PULL_RECOVERY_REQUIRED`. A pending journal blocks automatic sync
on reload.

## Conflicts

The planner refuses and records inspectable conflict data for:

- `LOCAL_AND_CLOUD_FINANCIAL_CHANGE` / `LOCAL_AND_CLOUD_CHANGED`
- `AFFECTED_ACCOUNT_DIVERGED`
- `UNEXPECTED_ACCOUNT_CHANGE`
- `ACCOUNT_RELATIONSHIP_UNAVAILABLE`

Affected operations pause; nothing is auto-resolved, overwritten, or replayed
against a changed baseline. Unrelated mutations, outbox entries, existing
conflicts, ambiguous account/category relationships, and unsupported shapes also
block the group.

## Database migration

`supabase_phase6o_transaction_update_delete.sql` is a separate first-install
draft with its own reviewed guard. It:

- requires the Phase 6N create install and `cap_transaction_writer`;
- mirrors Phase 6N's Supabase-compatible ownership setup: it temporarily grants
  `cap_transaction_writer` to `current_user` and grants that role `CREATE` on
  `public` and `cap_sync_private`, then revokes all three before the final
  role-boundary assertion and commit. Supabase's SQL Editor `postgres` is not a
  superuser, and Phase 6N's final revoke leaves it without a SET-capable
  membership, so `ALTER FUNCTION ... OWNER TO cap_transaction_writer` otherwise
  fails with `42501: must be able to SET ROLE "cap_transaction_writer"`;
- creates `cap_sync_private.transaction_change_receipts` with forced RLS and no
  anon/authenticated access;
- relaxes the Phase 6N create receipt's `ON DELETE RESTRICT` transaction FK so a
  verified delete can retain create idempotency history with an unenforced UUID;
- grants the writer only the reviewed transaction-update columns plus DELETE,
  and the existing narrow account-balance update;
- revokes table-level and column-level `INSERT`, `UPDATE`, `DELETE`, and
  `TRUNCATE` on `public.transactions` from `PUBLIC`, `anon`, and `authenticated`;
  existing `authenticated` `SELECT` access is preserved;
- asserts the cutover inside the same transaction and fails with
  `TRANSACTION_DIRECT_WRITE_CUTOVER_FAILED` if any browser-role write privilege
  remains, so a failure rolls the whole migration back;
- installs the two CAS/receipt RPCs with ownership, isolation, amount/date/status,
  relationship, active-account, full-row CAS, and post-write verification checks;
- installs `cap_verify_transaction_update_delete_v1` and grants execute only to
  `authenticated`.

Anon/authenticated receive no direct table write or receipt access. The runtime
contract also rejects direct transaction writes if a grant is reintroduced. The
verifier reports authenticated/anon INSERT/UPDATE/DELETE/TRUNCATE denial, RPC
execute for authenticated, anon/PUBLIC RPC denial, and receipt-table denial;
`ready` is false if any check fails. The migration is a draft and is not
authorized for production deployment.

## Verification

`tests/cloud-transaction-update-delete.cjs` (22 checks) executes the real
production planner, browser adapter, engine, pseudo-RPC transport, and fake
IndexedDB. It covers update push (amount up/down, income, A→B credit), metadata-
only update, delete push, update/delete pull, all four conflict classes, Policy B,
unsupported pending/bill-linked shapes, capability false, server CAS conflict,
network failure before commit, network drop after commit with `ALREADY_APPLIED`,
and pull install rollback. Two checks capture the actual UPDATE/DELETE RPC bodies
and assert the expected transaction/account rows are byte-for-byte the canonical
`cap_sync_snapshot_v1` rows, including microsecond `+00:00` timestamps and the
exact date string; Date normalization fails those checks.

`tests/phase6o-sql.cjs` (23 checks) installs the draft in disposable PGlite and
executes the real functions: capability attestation, exact grant cutover,
authenticated/anon direct-write denial, verifier fail-closed mutations, anon RPC
denial, receipt confinement, create/update/delete, replay, stale
transaction/account CAS, metadata-only update, A→B, credit signed effects,
already-gone conflict, operation-UUID request binding, temporary-grant ordering,
committed-state temporary-grant absence, and two rollback injections. The first
rollback case pre-seeds table, column and PUBLIC grants, proves they are restored
on failure, then proves the retried migration removes all of them. The second
fails after all ownership transfers while the temporary membership and schema
`CREATE` grants are still present, then proves those grants, every Phase 6O
object, and the writer update/delete privileges are gone and the Phase 6N
transaction FK is restored.

Disposable PostgreSQL 17.6 verification used a non-superuser `postgres` role with
`CREATEROLE`/`BYPASSRLS` that owns the database and tables, reproducing the
relevant Supabase restriction rather than the prior superuser fixture. The
uncorrected Phase 6O failed at the first ownership transfer with the exact
production error `must be able to SET ROLE "cap_transaction_writer"`; rollback
left no Phase 6O objects and restored the Phase 6N `ON DELETE RESTRICT`
transaction FK. The corrected migration installed successfully and passed 9/9
real-PostgreSQL checks: verifier ready, exact grants, authenticated/anon
direct-write rejection, Phase 6N CREATE → UPDATE → DELETE balances, create replay
after delete, stale/Date-normalized CAS conflict plus exact UTC apply,
UPDATE/DELETE replay, receipt denial, verifier negative mutations, and one real
two-session UPDATE race. A separate injected failure after the ownership
transfers rolled back the temporary membership/schema grants, all Phase 6O
objects, and restored the pre-migration grants and Phase 6N FK. Full regression is
55 suites / 1,616 checks / 0 failures. No production financial data,
`FINAL CLOUD SYNC TEST`, `PHASE 6N DEVICE TEST`, baseline, or live device was
read or changed. No commit/push/deploy was performed.

## Read-only rollback verification

Run the following query in the Supabase SQL Editor after a failed Phase 6O
attempt. It only reads catalogs and ACL state. `rollback_verified` must be
`true`; the raw `authenticated_write_acl`/`anon_write_acl` and ACL strings show
the restored pre-6O grants for comparison with the values captured before the
attempt.

```sql
with state as (
  select
    to_regclass('cap_sync_private.transaction_change_receipts') is null as phase6o_receipt_table_absent,
    to_regprocedure('cap_sync_private.cap_transaction_change_contract_ok()') is null as phase6o_contract_fn_absent,
    to_regprocedure('public.cap_sync_transaction_update(uuid,uuid,jsonb,jsonb,jsonb)') is null as phase6o_update_rpc_absent,
    to_regprocedure('public.cap_sync_transaction_delete(uuid,uuid,jsonb,jsonb)') is null as phase6o_delete_rpc_absent,
    to_regprocedure('public.cap_verify_transaction_update_delete_v1()') is null as phase6o_verifier_absent,
    not exists (
      select 1 from pg_policy
      where polname = any (array[
        'transaction_change_receipt_read',
        'transaction_change_receipt_insert',
        'transaction_writer_transaction_update',
        'transaction_writer_transaction_delete'
      ])
    ) as phase6o_policies_absent,
    not has_any_column_privilege('cap_transaction_writer', 'public.transactions', 'UPDATE')
      and not has_table_privilege('cap_transaction_writer', 'public.transactions', 'DELETE')
      as phase6o_writer_update_delete_absent,
    not has_schema_privilege('cap_transaction_writer', 'public', 'CREATE')
      and not has_schema_privilege('cap_transaction_writer', 'cap_sync_private', 'CREATE')
      as phase6o_writer_schema_create_absent,
    not exists (
      select 1 from pg_auth_members
      where roleid = 'cap_transaction_writer'::regrole
        and (inherit_option or set_option)
    ) as phase6o_temp_membership_absent,
    not exists (
      select 1 from pg_auth_members
      where roleid = 'cap_transaction_writer'::regrole
        and member = current_user::regrole
        and (inherit_option or set_option)
    ) as phase6o_current_user_temp_membership_absent,
    to_regclass('cap_sync_private.transaction_create_receipts') is not null as phase6n_create_receipt_table,
    to_regprocedure('public.cap_sync_transaction_create(uuid,jsonb,jsonb)') is not null as phase6n_create_rpc_present,
    coalesce((
      select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.oid = to_regprocedure('public.cap_sync_transaction_create(uuid,jsonb,jsonb)')
    ), 'MISSING') as phase6n_create_rpc_owner,
    coalesce((
      select r.rolname = 'cap_transaction_writer'
      from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.oid = to_regprocedure('public.cap_sync_transaction_create(uuid,jsonb,jsonb)')
    ), false) as phase6n_create_rpc_owner_is_writer,
    coalesce(has_function_privilege(
      'authenticated',
      'public.cap_sync_transaction_create(uuid,jsonb,jsonb)',
      'EXECUTE'
    ), false) as phase6n_create_rpc_execute_authenticated,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('cap_sync_private.transaction_create_receipts')
        and contype = 'f'
        and confrelid = to_regclass('public.transactions')
        and confdeltype = 'r'
    ) as phase6n_create_receipt_fk_restored,
    (
      select count(*) = 3 from pg_constraint
      where conrelid = to_regclass('cap_sync_private.transaction_create_receipts')
        and contype = 'f'
    ) as phase6n_create_receipt_fk_count,
    (
      select count(*) = 1 from pg_constraint
      where conrelid = to_regclass('cap_sync_private.transaction_create_receipts')
        and contype = 'f'
        and confrelid = to_regclass('public.transactions')
    ) as phase6n_create_receipt_fk_to_transactions_count,
    jsonb_build_object(
      'insert', has_any_column_privilege('authenticated', 'public.transactions', 'INSERT'),
      'update', has_any_column_privilege('authenticated', 'public.transactions', 'UPDATE'),
      'delete', has_table_privilege('authenticated', 'public.transactions', 'DELETE'),
      'truncate', has_table_privilege('authenticated', 'public.transactions', 'TRUNCATE')
    ) as authenticated_write_acl,
    jsonb_build_object(
      'insert', has_any_column_privilege('anon', 'public.transactions', 'INSERT'),
      'update', has_any_column_privilege('anon', 'public.transactions', 'UPDATE'),
      'delete', has_table_privilege('anon', 'public.transactions', 'DELETE'),
      'truncate', has_table_privilege('anon', 'public.transactions', 'TRUNCATE')
    ) as anon_write_acl,
    (select relacl::text from pg_class where oid = to_regclass('public.transactions')) as transactions_relacl,
    coalesce((
      select jsonb_object_agg(a.attname, a.attacl::text)
      from pg_attribute a
      where a.attrelid = to_regclass('public.transactions')
        and a.attnum > 0 and not a.attisdropped and a.attacl is not null
    ), '{}'::jsonb) as transactions_column_acl
)
select jsonb_pretty(jsonb_build_object(
  'current_user', current_user,
  'phase6o_receipt_table_absent', phase6o_receipt_table_absent,
  'phase6o_contract_fn_absent', phase6o_contract_fn_absent,
  'phase6o_update_rpc_absent', phase6o_update_rpc_absent,
  'phase6o_delete_rpc_absent', phase6o_delete_rpc_absent,
  'phase6o_verifier_absent', phase6o_verifier_absent,
  'phase6o_policies_absent', phase6o_policies_absent,
  'phase6o_writer_update_delete_absent', phase6o_writer_update_delete_absent,
  'phase6o_writer_schema_create_absent', phase6o_writer_schema_create_absent,
  'phase6o_temp_membership_absent', phase6o_temp_membership_absent,
  'phase6o_current_user_temp_membership_absent', phase6o_current_user_temp_membership_absent,
  'phase6n_create_receipt_table', phase6n_create_receipt_table,
  'phase6n_create_rpc_present', phase6n_create_rpc_present,
  'phase6n_create_rpc_owner', phase6n_create_rpc_owner,
  'phase6n_create_rpc_owner_is_writer', phase6n_create_rpc_owner_is_writer,
  'phase6n_create_rpc_execute_authenticated', phase6n_create_rpc_execute_authenticated,
  'phase6n_create_receipt_fk_restored', phase6n_create_receipt_fk_restored,
  'phase6n_create_receipt_fk_count', phase6n_create_receipt_fk_count,
  'phase6n_create_receipt_fk_to_transactions_count', phase6n_create_receipt_fk_to_transactions_count,
  'authenticated_write_acl', authenticated_write_acl,
  'anon_write_acl', anon_write_acl,
  'transactions_relacl', transactions_relacl,
  'transactions_column_acl', transactions_column_acl,
  'rollback_verified',
    phase6o_receipt_table_absent
    and phase6o_contract_fn_absent
    and phase6o_update_rpc_absent
    and phase6o_delete_rpc_absent
    and phase6o_verifier_absent
    and phase6o_policies_absent
    and phase6o_writer_update_delete_absent
    and phase6o_writer_schema_create_absent
    and phase6o_temp_membership_absent
    and phase6n_create_receipt_table
    and phase6n_create_rpc_present
    and phase6n_create_rpc_owner_is_writer
    and phase6n_create_rpc_execute_authenticated
    and phase6n_create_receipt_fk_restored
    and phase6n_create_receipt_fk_count
    and phase6n_create_receipt_fk_to_transactions_count
)) as verification
from state;
```
