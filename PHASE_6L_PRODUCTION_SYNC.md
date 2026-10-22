# Phase 6L — conservative production controller

> Deployment correction: see `PHASE_6L_AUTH_IDENTITY_REPAIR.md`. The user now
> reports Notes installed/backfilled in production, but its custom role cannot
> use managed `auth`. The shared Cap identity prerequisite, PG16+ role-boundary
> prerequisite and in-place Notes repair are prepared only. Earlier “none deployed”, incomplete-restore and zero-breakage
> release claims below are historical, not current deployment instructions.

Status: **RPC-only client plus prepared server drafts, not
activation-ready**. No production connection, record access, RPC invocation, SQL
deployment, baseline change, queue change or Cloud Sync activation was performed
during implementation. Reported 47-record convergence is user-provided evidence,
not reverified by this work. Transaction-create, production notes-sidecar,
snapshot/readiness and the dependency-ordered security cutover are isolated and
real-PostgreSQL tested drafts only; none is deployed.

The shipped client is now **RPC-only**: it no longer contains a direct table
endpoint, the legacy `cap_sync_note_put`/`cap_test_transaction_create`
endpoints or the legacy `cap_verify_notes_rpc`/`cap_verify_transaction_rpc`
probes. The transport refuses anything outside the six reviewed production RPCs
before a request is made, so an old path cannot silently reappear.

This is deliberately NOT a claim of complete, all-entity automatic sync.
Cloud Sync defaults OFF. Loading the new code with no `production-sync-v1`
setting only reads local sync metadata. It does not initialize metadata or
baseline records. The original test-only executor was removed with the
direct-table path it depended on.

## RPC-only client migration

- `js/production-rpc.js` (new): the only cloud data surface of the shipped
  client. It exposes exactly the reviewed production contracts
  (`cap_verify_production_sync_v1`, `cap_sync_snapshot_v1`,
  `cap_sync_transaction_create`, `cap_notes_change`, `cap_notes_read`,
  `cap_verify_notes_lifecycle`), validates the readiness flags, contract
  versions, snapshot completeness/ownership, the note content + lifecycle
  envelope and the transaction payload, and refuses every other endpoint with a
  fixed code.
- `js/supabase.js`: the transport now allows only `/auth/v1/*` and the six
  production RPC paths. Any table endpoint, legacy RPC or test RPC is refused
  with `DIRECT_TABLE_ACCESS_DISABLED` before a network request. The readiness
  probes use the production verifiers, the bulk migration upload is removed and
  the developer tools are read-only through the production snapshot.
- `js/sync.js`: the generic direct-table executor (row upsert/delete, test
  artifact cleanup, the disposable cloud account round trip) is removed. The
  outbox planner, the notes push rehearsal and the demo refresh read through the
  production snapshot; the notes write uses `cap_notes_change` with the content
  **and** lifecycle envelope plus a stable operation id.
- `js/notes-manual.js`: note reads use the production snapshot/note read and
  note writes use `cap_notes_change`. A proven absent note is a `create`, an
  existing note is a lifecycle compare-and-swap.
- `js/app.js`: the developer tools use the production contracts. Operations
  without an adapter (transaction update, account delete, bulk upload) now stop
  with a fixed `UNSUPPORTED_OPERATION` reason instead of writing a table.
- Local-first behaviour is unchanged: no local storage, baseline or outbox write
  was added, Cloud Sync still defaults OFF, and every local operation keeps
  working without a network.

## Implemented

- `js/sync-production.js`: persisted ON/OFF preference, explicit clean-state
  enable preflight, capability-gated RPC transport, and foreground scheduler.
- Save/debounce, authenticated identity transition, online, pageshow, visible
  resume, service-worker wakeup and a visible-page 15-second sweep all wake the
  same controller. A wakeup is not authorization to write.
- Offline capture uses the already-associated local identity plus the owned v2
  baseline, never cached credentials as permission for cloud access. On startup,
  locally saved changes not yet journaled are rediscovered from that baseline.
- Durable per-record immutable queue versions. Rapid offline edits are not
  overwritten in place. Verified superseded versions remain in private receipts.
- One cross-tab lock shared with existing manual-note flows. Unsupported Web
  Locks fails closed. An external localStorage edit pauses the controller rather
  than invoking the old automatic document merge over an active sync snapshot.
- An IDB compare-and-commit checks settings, baseline, queue, conflicts, recovery
  checkpoints, persisted state and the live local generation before committing.
- Push intent is journaled before network mutation. A lost response retries the
  same operation ID/payload; it never invents another transaction ID or repeats
  an independent account PATCH.
- Exact verified baseline acknowledgement, exact queue removals, private receipt
  retention and journal clearing commit together. Unrelated queue entries remain.
- Note pulls retain a private before-state backup, commit IDB state and baseline
  together, then verify the localStorage/in-memory mirror. A crash leaves a
  recovery journal; it does not silently restart a push from the old local copy.
- Client three-way conflicts retain baseline/local/cloud snapshots privately.
  Server CAS conflicts retain the journal and block further cloud writes.
- Network failures preserve queue/baseline/journal, expose fixed error codes and
  use capped retry delays with jitter. Raw backend messages are not persisted in
  production-controller status or failure metadata.
- OFF immediately fences additional requests, persists the preference under the
  shared lock and never clears queue, conflicts, baseline or recovery evidence.
  An already submitted request cannot be undone; its journal remains recoverable.
- While ON, legacy/manual mutation RPCs/raw writes and generic sync-metadata
  mutations are blocked. The ambient `claude.use` backend is not run alongside
  the Supabase production controller.
- Service worker shell version advanced; the new script is cached.

## Conservative supported client paths

Only after production server readiness is deployed and explicitly approved:

1. Updates to existing active notes through the private-sidecar
   `cap_notes_change` revision/content CAS contract, with operation receipts.
   The prepared server contract also supports create/tombstone, but the client
   create/import and delete UI wiring is not enabled by this phase.
2. Pulls of existing active notes, preserving all unrelated state.
3. One simple new posted transaction and its exact dependent account delta in a
   single production RPC. The account cloud snapshot must match its baseline;
   the local account change must be explained exactly by that transaction.
4. Verified content convergence acknowledgements without another cloud write.

The **entire proposed batch is checked before any write**. Unsupported writes,
unsupported pulls, ownership failures, presence changes or conflicts block the
batch. This intentionally prefers a recoverable queue over partial financial
sync. No `DELETE` request or raw table upsert is issued by the controller.

## Remaining implementation/deployment blockers

### 1. Production server endpoints remain undeployed

**Client prerequisite (not yet satisfied):** the shipped PWA is not RPC-only. It
still calls `cap_sync_note_put` (`js/notes-manual.js`, `js/sync.js`),
`cap_test_transaction_create` (`js/app.js`), the legacy readiness probes
`cap_verify_notes_rpc`/`cap_verify_transaction_rpc` (`js/supabase.js`) and
direct PostgREST table endpoints (`/rest/v1/notes`, `/rest/v1/accounts`,
`/rest/v1/profiles`, `/rest/v1/transactions`, ...). The prepared cutover removes
exactly those paths, so **the client migration must ship before the cutover
window**, otherwise the live app loses notes/transaction writes and its
readiness probe. Only `js/sync-production.js` is RPC-only today, and it is
capability-gated and OFF by default.

Transaction-create update: `supabase_production_transaction_create.sql` is now a
guarded, isolated-tested draft (31 PGlite checks; 18 real PostgreSQL checks with
11 observed backend lock waits). Snapshot/readiness update:
`supabase_production_snapshot_readiness.sql` is a guarded draft (16 PGlite checks;
94 real PostgreSQL 17 checks including 24 concurrent write/snapshot iterations).
Notes-sidecar update: `supabase_production_notes_sidecar.sql` is a guarded draft
(89 PGlite checks; 17 real PostgreSQL checks with 8 observed backend lock waits).
Security cutover update: `supabase_production_cutover.sql` is a guarded draft
(11 PGlite checks; 31 real PostgreSQL 17 checks; 11 target/opt-in guards). It is
the only prepared script that revokes the direct authenticated/anon table and
column grants, removes the `own_rows` client policies, retires the legacy
`cap_sync_note_put`/`cap_verify_notes_rpc`/`cap_verify_transaction_rpc`/
`cap_test_*` RPCs, forces RLS on the private sidecar, and finishes with a
fail-closed catalog postflight. None is deployed. See
`PHASE_6L_TRANSACTION_CREATE.md`, `PHASE_6L_SNAPSHOT_READINESS.md` and
`NOTES_LIFECYCLE_SERVER.md`. The prepared notes draft is a required dependency
for snapshot installation, and the cutover is the required final step before
readiness can report `ready:true`.

The required server contracts are prepared as drafts. They must still be reviewed,
approved, deployed and verified on the production project before activation:

| RPC | Required contract |
| --- | --- |
| `cap_verify_production_sync_v1()` | Prepared draft. Return `version: CAP_PRODUCTION_SYNC_V1`, the legacy flags and exact server-derived `checks`/`contracts`. All 11 checks must be true; contract versions are readiness `CAP_PRODUCTION_SYNC_READINESS_V1`, snapshot `CAP_SYNC_SNAPSHOT_V1`, transaction `CAP_TX_CREATE_CAS_RECEIPT_V1`, notes `CAP_NOTES_SIDECAR_V1`. Catalog/body/role/grant/RLS checks only; no row reads or mutation probing. |
| `cap_sync_snapshot_v1()` | Prepared draft. One complete, owner-scoped, single-statement READ COMMITTED snapshot: `{version, owner, complete:true, record_count, counts:{13 entities}, records:[{entity,row,lifecycle?}]}`. Covers all synchronized entities and singletons, rejects oversized/incomplete reads and requires the exact notes lifecycle v1 envelope. Client requires exact counts before planning. |
| `cap_sync_transaction_create(p_operation_id uuid,p_transaction jsonb,p_expected_account jsonb)` | Prepared and tested draft. Promotes the verified transaction INSERT + locked account delta algorithm, with exact expected-account CAS, strict payload allowlist/ownership/FK checks, immutable request-bound durable receipts, replay-before-delta and fixed `APPLIED`/`ALREADY_APPLIED`/`CONFLICT` results. Unsupported pending/post, parent/statement/bill/fee groups fail closed. |
| `cap_notes_change(...)` | Prepared and tested draft. Private lifecycle/content CAS with stable operation UUIDs and request-bound receipts. Supports `create` (SQL-NULL expected state), `edit` and `tombstone`; exact retries return `ALREADY_APPLIED`, payload/resource mismatches fail, stale revision/content returns `CONFLICT`, and note/lifecycle/receipt verification rolls back together. No restore/purge. The client still sends only `edit`; new-note client wiring remains unsupported. |

The existing `cap_test_transaction_create`/`cap_verify_transaction_rpc` are
**not** accepted as production readiness. The verified algorithm is the basis of
the promotion, but its current test signature lacks expected-account CAS and the
full production receipt contract. This change does not silently rename it or
call it automatically.

Keep the dedicated non-login, non-BYPASSRLS sidecar writer, fixed search paths,
server-derived `auth.uid()`, forced RLS, private ledger, explicit grants and old
client lockout architecture. Do not solve these gaps with service-role keys,
client check-then-PATCH, or enabling direct authenticated note access.

### 2. All-entity automatic sync is not implemented yet

The controller explicitly blocks and retains:

- transaction edits/deletes/posting transitions;
- multiple new transactions sharing one account in a batch;
- transfers, bill payments, fees/children, statement groups, goal/debt/account
  mutations and standalone balance writes;
- generic entity updates and financial pulls;
- client-side new note insertion/import and cloud-only new entities (the prepared
  server draft supports create, but the client is not wired to use it);
- any local/cloud absence, note tombstone, restore or purge.

Add reviewed atomic/CAS adapters and dependency-aware pull mapping for each
operation before advertising unrestricted automatic sync. Financial pulls must
not apply an account balance independently of its related records.

### 3. Explicit production conflict/recovery resolution remains to be implemented

Private conflicts and journals are retained and pause automatic writes. Existing
manual-note resolution is not a generic resolver for production queues. Do not
clear a conflict/journal to resume sync. A production review UI must compare all
versions, refresh evidence, confirm the exact action and finalize it atomically.

### 4. Operational gates remain

- Finish the private logical restore verification; the last reported database
  restore had failed. This work did not access or certify that backup.
- Resolve/review the production privilege audit and the existing hardening and
  lockout plan. Scripts 1–3 remain unexecuted, and the unified
  `supabase_production_cutover.sql` (which supersedes the notes-only lockout for
  the production order) is prepared and tested but not executed. Platform
  default-ACL cleanup still needs platform-admin access.
- Preserve the current baseline; do not run initialization or recreate it.
  Per-record acknowledgements mark aggregate fingerprints stale rather than
  pretending the old aggregate fingerprint is current.
- Run approved multi-session PostgreSQL races and an isolated browser rehearsal:
  offline/restart/reconnect, two tabs, session switch, OFF mid-flight, storage
  failure and lost replies after server commit. No live mutation tests here.
- Background sync only wakes open pages. This is NOT closed-app background
  execution or an iOS background-delivery guarantee.

## Unsupported user operations after the RPC-only migration

These are the normal user operations that still have **no production RPC
adapter**. The client refuses them explicitly (fixed
`UNSUPPORTED_OPERATION:<op>` reason or "no production RPC" message) instead of
writing a table directly, and the change stays local until an adapter exists.

Financial:

- Editing or deleting an existing transaction.
- Posting/status transitions, pending-to-posted moves and bill, parent,
  statement, fee or child-transaction groups.
- Transfers (account to account, card payment, goal transfer).
- Bill payments, fees and child transactions.
- Creating, editing or deleting an account, profile, category, goal, debt,
  bill, budget, statement, transfer or payment.
- Financial pulls (account, transaction, bill, goal, debt, budget, transfer,
  payment, statement and preference rows are not mapped back into local state;
  only notes are mapped).
- Standalone balance writes and any financial conflict resolution.

Notes:

- Creating a cloud note from the normal UI (the server contract supports
  `create` and the rehearsal maps a proven absent note to it, but the shipped
  UI still only edits existing notes).
- Deleting a cloud note from the UI (the contract supports `tombstone`; the UI
  has no user-facing delete).
- Note restore, purge and any note conflict resolution that is not the reviewed
  manual resolution flow.

Platform:

- Bulk upload of local data to the cloud (removed with the direct migration
  path).
- Generic outbox writes for any entity (the outbox can be inspected and
  planned, never applied generically).
- Direct table reads/writes for every synchronized entity, by any client.

## Files and extension points

- `js/production-rpc.js`: the RPC-only cloud surface: allowlist, readiness
  and notes-contract validation, snapshot validation, note read/change and
  transaction create adapters, fixed `UNSUPPORTED_OPERATION` failures.
- `js/sync-production.js`: `createEngine`, `capture`, `plan`, `groups`, `send`,
  `pull`, `acknowledge`, `setEnabled`, browser RPC/mapper adapters and scheduler.
- `js/app.js`: `productionSyncTransaction` and the new CapOff snapshot/commit
  methods; `save()` notification; owner-explicit mapping for offline capture;
  render-only pull refresh and legacy-backend/cross-tab fences.
- `js/supabase.js`: identity/session-generation accessors and auth wakeups;
  production-mode mutation allowlist. Cached identity is tagging evidence only.
- `js/sync.js`: canonical row-fingerprint export, actual mode reporting and
  settings integration. The existing real-data executor guard is unchanged.
- `supabase_production_transaction_create.sql`,
  `supabase_production_notes_sidecar.sql`,
  `supabase_production_snapshot_readiness.sql`,
  `supabase_production_cutover.sql`: undeployed guarded drafts.
- `index.html`, `service-worker.js`: script loading and shell update
  (`cap-shell-v318`).
- `tests/sync-production*.cjs`, `tests/snapshot-readiness-*.cjs`,
  `tests/notes-sidecar-production-*.cjs`, `tests/production-cutover-*.cjs`,
  `tests/client-rpc-only.cjs`: synthetic controller/IDB/browser wiring,
  snapshot/readiness contracts, notes-sidecar contracts, the dependency-ordered
  cutover contracts and the RPC-only client contract.
- `tests/manual/snapshot-readiness-races.cjs`,
  `tests/manual/notes-sidecar-production-races.cjs`,
  `tests/manual/production-cutover-races.cjs`: disposable real-PostgreSQL 17
  concurrent harnesses.

## Invariants

Never reset the baseline or queue to obtain a clean status. No private data in
diagnostic output. No timestamp-based last-writer-wins. No interpreting a failed,
partial or invisible cloud read as deletion. No financial group splitting. No
acknowledgement based only on an HTTP success or request `onsuccess`. No automatic
conflict resolution. Preserve all uncertain outcomes and versions for review.

## Activation verdict

Validation: all **46 isolated suites passed**, including 31 controller checks, 8
IDB transaction checks, 5 browser-adapter wiring checks, 16 snapshot/readiness
PGlite checks, 89 production notes-sidecar PGlite checks, 11 production-cutover
PGlite checks, 10 RPC-only client checks and 27 target/opt-in guards. Real PostgreSQL 17 testing covers 18
transaction-create checks with 11 observed lock waits, 94 snapshot/readiness
checks with 24 concurrent write/snapshot iterations, 17 production notes-sidecar
checks with 8 observed lock waits, and 31 production-cutover checks covering the
complete dependency order, cutover rollback on failure and old-client bypass
denial. The wiring fixture retains 47 synthetic records byte-for-byte while OFF
and verifies zero network/metadata mutations. These tests use fake storage/mocked
transport or disposable PostgreSQL, not the real app profile or production
Supabase.

**NOT SAFE TO TURN CLOUD SYNC ON YET.** The client side of the boundary is
now RPC-only and fails closed, but the server side of the contract is still
undeployed. The switch is capability-gated and must refuse activation until
`cap_verify_production_sync_v1()` reports `ready:true` with all 11 checks
true on the real project. Client tests do not establish production SQL
availability or authorize deployment. Estimated overall Phase 6L completion:
**84%**, a scope estimate, not activation readiness.
