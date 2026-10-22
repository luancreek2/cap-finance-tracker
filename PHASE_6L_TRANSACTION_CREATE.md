# Phase 6L: transaction-create RPC draft

> Current prerequisites: `supabase_production_identity.sql` and
> `supabase_production_role_boundary.sql`, reviewed in
> `PHASE_6L_AUTH_IDENTITY_REPAIR.md`. All writer functions/policies now use
> Cap-owned request identity, not managed `auth` access, and the PG16+ retained
> creator ADMIN membership is validated explicitly. Production deployment and
> release-transition gates remain separate and are not authorized here.

Status: **prepared and isolated-test verified; NOT deployed or activation-ready**.
Cloud Sync remains OFF. No production SQL, app/browser data access, baseline or
outbox change, or existing lab/backup modification was performed.

## Prepared contract

`supabase_production_transaction_create.sql` defines:

```sql
public.cap_sync_transaction_create(
  p_operation_id uuid,
  p_transaction jsonb,
  p_expected_account jsonb
) returns jsonb
```

This matches the existing Phase 6L client transport. It does not repoint or unlock
the old test executor. The RPC has version comment `CAP_TX_CREATE_CAS_RECEIPT_V1`;
the global production readiness/snapshot RPCs remain separate prepared but
undeployed contracts.

### Supported scope

One simple new **posted** transaction, on an owned active account, with an
optional owned category. It preserves the verified signed-amount algorithm:

- insert the transaction once;
- cash/savings/debit/ewallet: add the signed amount;
- credit: subtract the signed amount;
- round the resulting balance to two decimal places;
- verify the final transaction and the entire account row (allowing only the
  balance and server-managed `updated_at` to change).

No pending/posting transition, bill/payment/transfer, parent/fee/statement group,
transaction edit/delete, arbitrary account update, restore or purge is supported.
Unsupported requests fail closed rather than attempting part of a financial group.

### Strict payload and relationship checks

- All 15 transaction keys emitted by the client are required; extra keys,
  caller-supplied timestamps, malformed UUIDs/dates, missing/null amounts,
  fractional cents, zero amounts and oversized bodies are rejected.
- Identity comes from `auth.uid()`; the supplied owner must match it. All writes
  and relationship reads are owner-qualified and protected by RLS/composite FKs.
- Bill, parent and statement references must be explicit JSON null.
- `metadata` is limited to the simple local transaction representation:
  `id`, `ts`, `d`, `pd`, `amt`, `cat`, `acct`, `note`, `desc`, `_u`. Mapped values
  must agree with the canonical transaction/account/category. Unknown semantic
  flags (including fee/opening-balance work) are rejected.
- The expected account is the full snapshot, with exact current table keys and
  numeric balance. It must match `to_jsonb(account)` **after `FOR UPDATE` acquires
  the account lock**, including timestamps and non-balance fields.
- Snapshot producers must use the same UTC/ISO representation. A changed or
  lossy representation fails CAS rather than causing an overwrite. Extreme
  numerics cannot safely be round-tripped through JavaScript Numbers; the
  overflow test deliberately keeps that expected snapshot inside PostgreSQL.

### Locking, request binding and replay

Lock order is operation -> transaction UUID -> owned local/legacy identity ->
account row. The supported transaction isolation is **READ COMMITTED**, matching
the intended PostgREST path. Higher isolation is explicitly refused before any
effect; it is not claimed as tested/ready for this contract.

`cap_sync_private.transaction_create_receipts` stores the immutable JSONB request
(owner, complete desired transaction, complete expected account), result and
outcome under `(user_id, operation_id)`.

- Exact successful replay returns `ALREADY_APPLIED` and the original receipt
  snapshots **before** comparing or changing the current account. A later
  legitimate account change is not overwritten by a replay.
- Changed desired data, metadata, identity or expected snapshot with the same
  operation UUID raises fixed `OPERATION_REUSE_CONFLICT`.
- CAS-conflicted valid requests also retain a receipt. Exact retries remain
  `CONFLICT`; reusing that UUID with a refreshed expected snapshot is refused.
- Another operation UUID cannot adopt a pre-existing transaction as its retry.
- Another transaction UUID cannot duplicate the same owned local/legacy identity
  through this RPC. Advisory locks and partial unique receipt indexes protect
  successful claims by both transaction UUID and owned legacy identity.
- Receipt insertion, transaction insertion and balance update commit or roll back
  together. Failed receipt persistence cannot leave an unreceipted balance effect.
- Success receipts retain transaction/account foreign keys with `ON DELETE
  RESTRICT`. No automatic receipt update/delete/purge path is granted.

`CONFLICT` results contain only a fixed status. Successful results include the
operation/transaction/account IDs and verified row snapshots for the owned
caller. Unexpected trigger/constraint error bodies are replaced by fixed errors;
no financial values are emitted in test diagnostics.

**Client rule:** an uncertain outcome must retry the original operation UUID,
transaction UUID, body AND expected snapshot. Never regenerate IDs or fetch a
fresh expected account and silently rebind the old request. Post-write reads and
local baseline/outbox acknowledgement remain mandatory; `ALREADY_APPLIED` does
not prove the cloud has remained unchanged since that receipt was committed.

## Privilege boundary and installation limits

The draft creates `cap_transaction_writer` (NOLOGIN, NOINHERIT, non-superuser,
non-BYPASSRLS, no role/database creation or replication), owns the RPC with it,
fixes `search_path=pg_catalog` and explicitly qualifies application objects.

The writer receives SELECT on accounts/categories/transactions, INSERT on
transactions, UPDATE of **only account balance**, and SELECT/INSERT on its
private receipts. Exact owned-row policies are added for that role. Receipt RLS
is enabled and forced; the role owns neither tables nor schemas. Temporary
installer membership/public schema CREATE is removed before commit. Client and
service-role receipt grants are explicitly revoked. PUBLIC/anon cannot execute
the writer RPC. Runtime privilege/RLS drift checks fail closed.

The installation is guarded by
`cap.transaction_create_install = 'reviewed-draft-only'` and requires fresh target
names: existing private schema, writer role or any public overload of the RPC
causes an abort. This is a first-install review artifact, not an idempotent update.
Do not remove the guard or run it in production without a verified backup and
separate reviewed deployment approval.

Installation makes schema/role/grant/policy changes, but does not call the RPC or
insert/update/delete existing application records. It does **not** revoke the
existing direct authenticated financial grants, remove test RPCs, deploy the
prepared notes sidecar/cutover, change default ACLs or implement old-client
lockout. Those remain activation blockers: direct legacy writers must not be
mistaken for clients enforcing this new boundary. Admin/service-role custody
remains a separate gate.

## Tests run

### Single-session contract tests

`tests/transaction-create-sql.cjs`: **31 checks passed**, disposable PGlite.
Includes all account sign rules, exact account/timestamp CAS, ownership/ACLs,
strict payload/metadata/relationships, UUID/legacy collisions, lost-reply replay,
request mismatches, outer rollback, corrupted transaction/account triggers,
receipt-write failure, overflow, sanitized errors, retention and runtime drift.
This suite makes no concurrency claim.

### Real concurrent PostgreSQL tests

`tests/manual/transaction-create-races.cjs`: **18 checks passed**, PostgreSQL
17.11, **11 observed backend lock waits** using `pg_blocking_pids` and independent
backend PIDs. Cases include exact replay, same-operation payload/resource
mismatch, different operations sharing UUID/account/local identity, winner
rollback, external account write, foreign raw UUID insertion and category
deletion racing FK validation. Real-server tests also cover receipt-write and
post-write verification rollback, credit retry and replay after a later account
change.

Lost-response testing discards the committed reply at the application boundary
and retries from an independent backend. It verifies exact stored state is
unchanged; it is not an HTTP packet-loss or production network test.

The harness accepts **no existing database URL or container target**. It creates
its own uniquely labelled PostgreSQL 17 Docker container, network `none`, zero
published ports, tmpfs database storage and no bind/volume mounts. It verifies
ownership before cleanup and removes only that newly created container. Existing
PostgreSQL 16/17 labs and private backup files are never opened. Docker setup
waits for the final server, not initdb's temporary server.

`tests/transaction-create-race-guards.cjs`: **16 target/opt-in guards passed**.
`tests/helpers/transaction-create-fixture.cjs` extracts repository table
definitions and seeds only synthetic records; it is not production installation SQL.

The prepared production notes sidecar has separate coverage:
`tests/notes-sidecar-production-sql.cjs` (**89 PGlite checks**),
`tests/notes-sidecar-production-race-guards.cjs` (**9 target/opt-in guards**) and
`tests/manual/notes-sidecar-production-races.cjs` (**17 real PostgreSQL checks**,
8 observed backend lock waits). Snapshot/readiness adds **16 PGlite checks**, 7
guards and **94 real PostgreSQL checks** with 24 concurrent iterations. The
dependency-ordered security cutover adds **11 PGlite checks**, **11 target/opt-in
guards** and **31 real PostgreSQL 17 checks** that run the complete install order,
prove cutover rollback on failure and prove that old clients lose every direct
table/column/private-schema/legacy path. The RPC-only client migration adds
**10 RPC-only client checks** and the full isolated suite is **46/46
passing**; shell version is `cap-shell-v319`.

Commands (dependencies stay outside this dependency-free app):

```powershell
# CAP_PGLITE_PATH must already point to the external PGlite installation.
node tests/transaction-create-sql.cjs
node tests/transaction-create-race-guards.cjs

$env:CAP_TRANSACTION_RACE_ACK = 'CREATE_DISPOSABLE_DOCKER_ONLY'
node tests/manual/transaction-create-races.cjs
```

## Next blocker and completion estimate

The transaction-create contract is prepared and tested, **not deployed**. The
owner-scoped production snapshot/readiness and private notes sidecar contracts are
now also prepared and tested (`PHASE_6L_SNAPSHOT_READINESS.md`); neither may report
ready solely because one RPC passes. The final dependency-ordered security
cutover (`supabase_production_cutover.sql`) is prepared and tested as well: it is
the step that revokes the direct authenticated table/column grants, removes the
`own_rows` client policies, retires the legacy RPCs and proves the final catalog
state fail-closed.

The client side of this contract is now RPC-only: the shipped bundle calls
`cap_sync_transaction_create` (and only the reviewed production RPCs) and
refuses every direct table path. The developer tools that used the legacy
`cap_test_transaction_create` now use the production contract, and the tools
that need a transaction **update** (which this contract does not provide) stop
with a fixed `UNSUPPORTED_OPERATION:transaction-update` reason.

Next: release the RPC-only client build, then with explicit approval and a
verified backup deploy notes sidecar -> transaction create ->
snapshot/readiness -> cutover in that order, then complete backup restore
verification. Platform default-ACL cleanup, the missing operation adapters
(transaction update/delete, transfers, payments, fees, financial pulls, account
and profile writes), client note-create wiring, explicit production
conflict/recovery resolution and controlled rollout still block activation.

Estimated overall Phase 6L completion: **84%**, a scope estimate, not production
activation readiness. Cloud Sync stays OFF.
