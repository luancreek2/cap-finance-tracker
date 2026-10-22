# Phase 6L: production snapshot, readiness and security cutover drafts

> Current correction: `PHASE_6L_AUTH_IDENTITY_REPAIR.md` supersedes the deployment
> order and backup-status assumptions below. Notes is reportedly installed and
> backfilled; the custom-role `auth` dependency failed in production. Install
> the Cap-owned identity and PG16+ role-boundary prerequisites, then repair Notes
> before the revised transaction/snapshot drafts. No new production action is
> authorized.

Status: **prepared, isolated-test verified, and dependency-complete on paper;
NOT deployed or activation-ready**. Cloud Sync remains OFF. No production SQL,
Supabase connection, application row, baseline, outbox, backup or existing browser
profile was read or changed by this work. The 47-record convergence remains
user-provided evidence, not reverified here.

## Prepared contracts

`supabase_production_snapshot_readiness.sql` is a guarded first-install draft. It
depends on the prepared transaction-create contract and the prepared production
private notes sidecar already existing. It does not create, migrate or repair either
one.

### Notes sidecar dependency

`supabase_production_notes_sidecar.sql` is now a guarded first-install draft, still
separate from this snapshot script and not deployed. It provides:

- `cap_notes_read(uuid)`: owner-scoped note content plus the exact lifecycle v1
  envelope.
- `cap_notes_change(uuid,jsonb,text,jsonb,uuid)`: `create`, `edit` and `tombstone`
  only. Create requires an SQL-NULL expected state; edit requires the full expected
  content/lifecycle; tombstone retains content and writes server-derived deletion
  metadata. There is no restore, purge or silent overwrite fallback.
- `cap_verify_notes_lifecycle()`: metadata/catalog-only notes contract check. It
  reports `contract_ready` after installation, backfill and the separate direct-grant
  cutover, but always reports `ready:false` and `production_ready:false`.

The draft creates a dedicated NOLOGIN, NOINHERIT, non-superuser, non-BYPASSRLS
writer; forces RLS on the private lifecycle and operation-receipt tables; grants the
minimum SELECT/INSERT/UPDATE on notes and lifecycle plus SELECT/INSERT on receipts;
and keeps direct client and service-role access revoked. Stable operation UUIDs and
request-bound private receipts make exact retries return `ALREADY_APPLIED`,
payload/resource mismatches raise `OPERATION_REUSE_CONFLICT`, stale expected
lifecycle returns `CONFLICT`, and row/lifecycle/receipt read-back verification rolls
all three back together. It does not revoke existing direct grants, legacy RPCs or
old writers; that cutover remains a separate reviewed action.

### `cap_sync_snapshot_v1()`

Returns one owner-scoped JSONB response:

```json
{
  "version": "CAP_SYNC_SNAPSHOT_V1",
  "owner": "<auth.uid()>",
  "complete": true,
  "record_count": 0,
  "counts": { "profiles": 0, "user_preferences": 0, "categories": 0,
    "accounts": 0, "goals": 0, "debts": 0, "bills": 0,
    "account_statements": 0, "transactions": 0, "transfers": 0,
    "bill_payments": 0, "budgets": 0, "notes": 0 },
  "records": [{ "entity": "notes", "row": {}, "lifecycle": {} }]
}
```

- All 13 synchronized entities, including empty collections and the
  `profiles`/`user_preferences` singletons, are read.
- The whole response is built by **one SQL statement** under READ COMMITTED, so
  every table scan sees one statement snapshot. A writer commit cannot produce a
  torn transaction/account pair within the response.
- Every row is explicitly owner-filtered by `auth.uid()` and protected by RLS.
  Foreign rows, direct authenticated table access and anonymous execution fail.
- Notes require the exact lifecycle v1 envelope
  `{version:1,revision,deleted_at,operation_id}`. A note without a lifecycle row
  rejects the whole response with `SNAPSHOT_SIDECAR_INCOMPLETE`; it is never
  silently omitted. Tombstones are returned so the client blocks them instead of
  interpreting absence as deletion.
- The response is rejected above 8 MiB with `SNAPSHOT_TOO_LARGE`. The client also
  requires `record_count`, every `counts` key, the exact record count and
  per-entity counts to agree before planning. Truncation cannot become deletion.
- Other fixed failures: `AUTH_REQUIRED`, `SNAPSHOT_CONTRACT_NOT_VERIFIED`,
  `SNAPSHOT_FAILED`.

### Reader boundary

The draft creates `cap_sync_reader` NOLOGIN, NOINHERIT, non-superuser,
non-BYPASSRLS, no database/role creation or replication. It owns neither schemas
nor tables. It receives SELECT only on the 13 entity tables and the private
lifecycle sidecar, plus permissive owner policies; it has no CREATE, receipt access
or client membership. Both RPCs are SECURITY DEFINER, owned by that role, with
`search_path=pg_catalog` and explicit UTC formatting. Runtime checks reject role,
RLS, policy, grant, schema-visibility or execute-grant drift.

### `cap_verify_production_sync_v1()`

Metadata/catalog-only readiness. It never reads note or financial rows and never
invokes a mutation RPC. It returns the legacy top-level flags for compatibility
plus the exact server-derived checks and contract versions:

```text
checks:
  snapshot_contract, snapshot_read_access, readiness_contract,
  transaction_create_contract, durable_receipts, notes_receipts,
  notes_sidecar, rpc_only_reads, legacy_lockout, writer_privileges,
  service_role_private

contracts:
  readiness          CAP_PRODUCTION_SYNC_READINESS_V1
  snapshot           CAP_SYNC_SNAPSHOT_V1
  transaction_create CAP_TX_CREATE_CAS_RECEIPT_V1
  notes_change       CAP_NOTES_SIDECAR_V1
```

`ready` is true only when all checks are true. Checks cover function comments,
bodies/volatility/security-definer/search-path, owners, exact signatures, function
grants (authenticated yes; anon/PUBLIC no), reader SELECT/policies/RLS, direct
authenticated/anon table and column grants, **client policies on the 13
synchronized tables (none may target `authenticated`, `anon` or `PUBLIC`)**,
**no client usage of the private schemas and no client `CREATE` on `public`**,
legacy test RPC lockout, dedicated role attributes/memberships/CREATE, forced
private RLS, receipt primary keys and grants, and service-role private-schema
access. The notes dependency check now requires the `cap_notes_read`,
`cap_notes_change` and `cap_verify_notes_lifecycle` function metadata, the
minimum writer INSERT on `public.notes` and the private lifecycle, and no writer
DELETE/TRUNCATE/REFERENCES/TRIGGER or direct client access. It still does not
invoke the notes verifier, so global readiness remains catalog/metadata-only.

The draft deliberately does **not** revoke existing direct client grants, legacy
RPCs or old writers. Readiness therefore remains false until the separate reviewed
lockout/cutover is applied. It also remains false until the prepared notes sidecar
and transaction-create contracts are actually installed/deployed.

## Production security cutover (prepared, not deployed)

`supabase_production_cutover.sql` is the guarded final cutover step. It runs
**after** the three installers and performs the whole old-client lockout in one
transaction. Guard: `SET cap.production_cutover = 'reviewed-draft-only';`

Dependency-ordered effect of the cutover:

1. **Preflight (fails closed, no mutation).** Requires the notes sidecar,
   transaction-create and snapshot/readiness contracts to exist with the exact
   contract comments (`CAP_NOTES_SIDECAR_V1`, `CAP_TX_CREATE_CAS_RECEIPT_V1`,
   `CAP_SYNC_SNAPSHOT_V1`, `CAP_PRODUCTION_SYNC_READINESS_V1`), the three
   dedicated roles to be NOLOGIN/NOINHERIT/non-superuser/non-BYPASSRLS, RLS
   enabled on all 13 synchronized tables, forced RLS on the private sidecar and
   receipt tables, and the installer to own every target table. Any deviation
   aborts with a fixed code (`PRODUCTION_CUTOVER_NOT_APPROVED`,
   `..._DEPENDENCIES_REQUIRED`, `..._CONTRACT_VERSION_MISMATCH`,
   `..._TABLE_OWNERSHIP_REQUIRED`, `..._PRIVATE_RLS_REQUIRED`).
2. **Backfill.** Runs `cap_notes_private.backfill_lifecycle()` inside the same
   transaction and requires zero missing and zero orphan lifecycle rows
   (`..._NOTES_COVERAGE_FAILED`).
3. **Forced RLS** on `public.notes`, `cap_notes_private.note_lifecycle`,
   `cap_notes_private.operations` and
   `cap_sync_private.transaction_create_receipts`.
4. **Client policy removal.** Every policy that still targets `authenticated`,
   `anon` or `PUBLIC` on the 13 synchronized tables is dropped. The dedicated
   snapshot-reader and writer policies are kept.
5. **Direct access revocation.** All table and column privileges for
   `authenticated`, `anon` and `PUBLIC` are revoked on all 13 tables; both
   private schemas, their tables and their functions are revoked from the
   browser roles and from `service_role`.
6. **Legacy RPC lockout.** `cap_sync_note_put`, `cap_verify_notes_rpc`,
   `cap_verify_transaction_rpc` and every `cap_test_%` overload are dropped;
   `rls_auto_enable()`/`set_updated_at()` stay non-executable by clients.
7. **Postflight (fail closed).** The catalog must be exactly the reviewed
   state: role attributes and memberships, RLS flags, no client table/column
   grants or `PUBLIC` table ACLs, no client policies, no private-schema client
   access, no legacy functions, notes coverage, writer/reader minimum grants,
   and the six reviewed RPCs still SECURITY DEFINER, owned by their dedicated
   role, executable by `authenticated` only. Otherwise the whole transaction
   rolls back with `PRODUCTION_CUTOVER_POSTFLIGHT_FAILED` and a fixed list of
   failed check names.

The cutover inserts no application row. It only writes the private lifecycle
rows required by the backfill. It is rerunnable: a second run keeps the same
final contract. The three installers remain first-install scripts and are not
idempotent.

## Client integration

`js/sync-production.js` now requires:

- the exact 11 readiness check keys, all true, with no extra/missing keys;
- the exact four contract versions above;
- the legacy top-level readiness flags;
- snapshot `version`, owner, `complete:true`, exact integer `record_count`, all 13
  non-negative `counts` keys, summed counts equal to `record_count`, per-entity
  counts equal to the returned records, unique record keys and ownership.

The pure `validateSnapshot` is exported for isolated tests and used by the browser
RPC adapter. New activation reasons cover oversized, incomplete-sidecar,
unverified-contract and failed snapshot responses. A top-level `ready:true` or an
old/partial verifier can no longer enable the controller.

## Installation order and guards

1. Reviewed `supabase_production_notes_sidecar.sql` (guarded by
   `cap.notes_sidecar_install`).
2. `supabase_production_transaction_create.sql` (guarded by
   `cap.transaction_create_install`).
3. `supabase_production_snapshot_readiness.sql` (guarded by
   `cap.snapshot_readiness_install`).
4. `supabase_production_cutover.sql` (guarded by `cap.production_cutover`): the
   notes lifecycle backfill, the direct-grant/legacy-RPC lockout and the
   fail-closed postflight in one transaction.

The notes sidecar and snapshot installers are guarded separately. The snapshot
installer is guarded by `SET cap.snapshot_readiness_install =
'reviewed-draft-only'`. It aborts if the reader role or either RPC already exists,
if required dependencies/columns are missing, if synchronized table RLS is
disabled, or if private/lifecycle/receipt RLS is not forced. It is a first-install
review artifact, not an idempotent migration. It changes
schema/role/function/policy/grant state only; it does not call the RPCs or modify
application rows.

## Tests run

- `tests/notes-sidecar-production-sql.cjs`: **89 checks passed**, disposable
  PGlite. Covers guarded install, legacy lockout, pre-cutover refusal, create/edit/
  tombstone, exact replay, payload/resource mismatch, stale lifecycle, operation
  reuse, rollback triggers, coverage gaps, revision exhaustion, direct-write and
  anonymous denial, ownership isolation, drift restoration and first-install guard.
- `tests/manual/notes-sidecar-production-races.cjs`: **17 checks passed**, real
  PostgreSQL 17.11, **8 observed backend lock waits** and independent backends.
  Covers concurrent edit/delete winners, exact retries, winner rollback, cross-note
  operation collision, concurrent create conflict/retry/rollback, lost responses,
  payload mismatch, direct-writer denial and foreign-owner isolation.
- `tests/notes-sidecar-production-race-guards.cjs`: **9 target/opt-in guards passed**.
- `tests/snapshot-readiness-sql.cjs`: **16 checks passed**, disposable PGlite.
  Covers installer guard, pre-cutover readiness false, exact locked-down readiness,
  all-entity/singleton/empty-collection snapshot, owner/foreign isolation, lifecycle
  and tombstone envelope, authentication/anon denial, malformed invocations,
  read-only state, incomplete sidecar, contract/RLS/access drift, each independent
  readiness failure, no-overwrite install guard and readiness read-only behavior.
- `tests/manual/snapshot-readiness-races.cjs`: **94 checks passed**, real PostgreSQL
  17.11, **24 concurrent write/snapshot iterations**, 7 independent backends. It
  verifies owner/foreign snapshots, direct-access denial, anon/malformed denial,
  readiness true/false, incomplete-sidecar rejection, contract/reader drift,
  read-only state, note create/edit/tombstone interaction with snapshots, exact
  account/transaction invariants during overlapping atomic writes, and that foreign
  snapshots never gain owner transactions.
- `tests/snapshot-readiness-race-guards.cjs`: **7 target/opt-in guards passed**.
- `tests/production-cutover-sql.cjs`: **11 checks passed**, disposable PGlite.
  Covers the cutover guard, missing-dependency abort, contract-version drift
  abort, rollback of a failure that happens after the backfill and the revokes,
  the exact post-cutover readiness and notes verifier, denial of every direct
  table/column/private-schema/legacy path, the six reviewed RPCs still working,
  and a rerun that does not weaken the contract.
- `tests/manual/production-cutover-races.cjs`: **31 checks passed**, real
  PostgreSQL 17, fresh network-none/tmpfs-only Docker cluster. It runs the
  complete dependency order (notes sidecar -> transaction -> snapshot -> cutover),
  proves the guard and dependency failures, proves that a failure after the
  backfill and the revokes rolls the whole cutover back with no partial state,
  proves the post-cutover backfill with unchanged application rows, proves
  readiness with all 11 checks true and the four exact contract versions, proves
  14 old-client bypass attempts are denied with their fixed error codes
  (`permission denied` / `does not exist`), proves the reviewed RPCs still work
  for an authenticated owner, and proves a rerun is safe.
- `tests/production-cutover-race-guards.cjs`: **11 target/opt-in guards passed**.
- `tests/client-rpc-only.cjs`: **10 checks passed**, isolated. It scans the
  shipped bundle for legacy/test endpoints and direct table paths, proves the
  transport allowlist, the exact readiness/notes-contract flags, the snapshot
  ownership/completeness rules, the note create/edit/tombstone payloads and the
  transaction create payload, and the fixed unsupported-operation failure.
- Full isolated suite run: **46 suites, 46 passed**. Syntax and manifest/vercel JSON
  checks passed. Service worker shell advanced to `cap-shell-v319` (the client
  bundle changed).

The real harness accepts no database URL/container target, creates its own unique
`cap-snapshot-lab-*` network-none, tmpfs-only PostgreSQL 17 container, verifies
zero host ports and no bind/volume mounts, and removes only its exact labelled
container. It never uses an existing lab or production connection.

Commands (dependencies remain outside this dependency-free app):

```powershell
# CAP_PGLITE_PATH points at an external @electric-sql/pglite install.
node tests/notes-sidecar-production-sql.cjs
node tests/notes-sidecar-production-race-guards.cjs
node tests/snapshot-readiness-sql.cjs
node tests/snapshot-readiness-race-guards.cjs
node tests/production-cutover-sql.cjs
node tests/production-cutover-race-guards.cjs

# The notes real harness expects an already-ready disposable loopback database.
$env:CAP_NOTES_RACE_ACK = 'DISPOSABLE_LOCAL_CLUSTER_ONLY'
node tests/manual/notes-sidecar-production-races.cjs

$env:CAP_SNAPSHOT_RACE_ACK = 'CREATE_DISPOSABLE_DOCKER_ONLY'
node tests/manual/snapshot-readiness-races.cjs

$env:CAP_CUTOVER_RACE_ACK = 'CREATE_DISPOSABLE_DOCKER_ONLY'
node tests/manual/production-cutover-races.cjs
```

## Remaining blockers

1. The prepared production notes sidecar/`cap_notes_change` contract is **still not
   deployed**, its backfill/cutover is not applied, and the client note-create/import
   wiring is not implemented. Snapshot installation depends on the deployed sidecar.
2. **The shipped client is now RPC-only, so the cutover no longer breaks the
   live app.** The client-side migration is done: `js/production-rpc.js` is the
   only cloud surface, the transport in `js/supabase.js` refuses every table,
   legacy and test path with `DIRECT_TABLE_ACCESS_DISABLED` before a request is
   made, and the notes, outbox, demo-refresh and developer-tool paths use
   `cap_sync_snapshot_v1`, `cap_notes_read`, `cap_notes_change` and
   `cap_sync_transaction_create`. The **released** build must still be newer
   than the cutover: the currently published PWA is the old one, so the new
   build has to be released before or together with the cutover window.
3. The prepared transaction-create and snapshot/readiness drafts are **not
   deployed**. They require review, backup verification and a controlled
   dependency-ordered installation. The client that will call them is ready and
   fails closed until they exist.
4. The prepared `supabase_production_cutover.sql` is **not executed**. It is
   tested in a disposable cluster only. The direct authenticated table/column
   grants, the `own_rows` client policies, the legacy test RPCs and the old
   writers are therefore still live, and readiness correctly stays false until
   the cutover is reviewed and applied in the approved window.
5. The cutover requires the installer to own the 13 synchronized tables and to
   be able to read/execute the private helper functions. If the production SQL
   Editor session is not the table owner, the cutover aborts with
   `PRODUCTION_CUTOVER_TABLE_OWNERSHIP_REQUIRED` instead of half-applying.
6. Platform default-ACL cleanup (`supabase_admin`/`postgres` defaults), the
   `rls_auto_enable` review, platform privileged roles and `service_role`
   custody are still separate platform-admin steps and are **not** part of the
   cutover script.
7. Backup restore verification remains incomplete; the last reported restore
   failed at `ensure_rls` owner assignment. It was deliberately not repeated
   in this step.
8. All-entity automatic sync, production conflict/recovery resolution UI,
   transaction edits/deletes/posting, transfers, payments, fees, financial pulls
   and client-side new-note insertion remain unsupported.
9. Residual privilege-audit items remain (`supabase_etl_admin`,
   `supabase_read_only_user`, `rls_auto_enable`, `SERVICE_ROLE_PRESENT`).

## Next move and completion estimate

Next: release the RPC-only client build, then review the four prepared
scripts and, only with explicit approval and a verified backup, deploy them in
the documented dependency order (notes sidecar -> transaction create ->
snapshot/readiness -> cutover) in one window; verify
`cap_verify_production_sync_v1()` reports `ready:true` with all 11 checks true;
then complete backup restore verification before any Cloud Sync activation.

Estimated overall Phase 6L completion: **84%** (scope estimate, not activation
readiness). Cloud Sync stays **OFF**.
