# Notes lifecycle server contract — isolated lab only

Status: implemented **only** as isolated PostgreSQL labs: the original
`tests/sql/notes-lifecycle-lab.sql` (run by `tests/notes-lifecycle-sql.cjs`) and
the production-shaped `tests/sql/notes-sidecar-lab.sql` (run by
`tests/notes-sidecar-sql.cjs`). Both execute against disposable PostgreSQL WASM
(PGlite). They are not Supabase migrations, not installation instructions, and
not production-ready servers. No live SQL, cloud mutation, financial change,
baseline upgrade, or app wiring was performed. Cloud Sync remains OFF.

A separate guarded first-install draft now exists at
`supabase_production_notes_sidecar.sql`. It is not the lab: it targets
`public.notes` and the private `cap_notes_private` sidecar, adds request-bound
operation receipts and a metadata-only verifier, and supports create/edit/tombstone.
It remains **undeployed** and requires a separate direct-grant/legacy-RPC cutover.
Its 89 PGlite checks, 9 harness guards and 17 real-PostgreSQL checks are recorded in
`PHASE_6L_SNAPSHOT_READINESS.md`.

The production cutover for that lockout is now prepared as well:
`supabase_production_cutover.sql` (guard `cap.production_cutover`) backfills the
lifecycle, forces RLS on the private sidecar, removes every `authenticated`/
`anon`/`PUBLIC` table, column and policy path on the synchronized tables, drops
the legacy `cap_sync_note_put`/`cap_verify_notes_rpc` RPCs and finishes with a
fail-closed catalog postflight. It runs after the notes, transaction and
snapshot installers. It is **prepared and tested, not executed** (11 PGlite
checks, 11 target/opt-in guards, 31 real PostgreSQL 17 checks in
`tests/production-cutover-sql.cjs`, `tests/production-cutover-race-guards.cjs`
and `tests/manual/production-cutover-races.cjs`). For the production order the
unified cutover replaces the notes-only `supabase_notes_legacy_lockout.sql`
step; that older script remains valid only as a standalone notes-only lockout.

## Separation from the deployed notes pilot

The lab creates `cap_notes_lab.notes` and `cap_notes_lab.operations` plus a
dedicated `cap_notes_lab_writer` role. It does not add lifecycle columns to
`public.notes`, change its privileges, replace `cap_sync_note_put`, or weaken
the existing `cap_verify_notes_rpc`. A sentinel public note and the legacy
RPC's metadata readiness remain unchanged in the isolated tests.

Execution requires an explicit isolated-test session setting. That guard helps
prevent accidental execution; it is **not** a security boundary or permission
to run the file in a live SQL editor. Do not install the lab on Supabase.

## Security model exercised

The existing live pilot uses SECURITY INVOKER with client table-write grants.
That cannot by itself enforce a mandatory lifecycle CAS against direct table
writers. The lab instead exercises:

- An authenticated client with SELECT only on the lab notes table. No direct
  INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, or ledger access.
- A non-login, non-inheriting dedicated writer role with no superuser, BYPASSRLS,
  role/database administration, replication, table ownership, schema ownership,
  schema CREATE, or client membership. It has SELECT/UPDATE on notes and
  SELECT/INSERT on the private operation ledger—no note insertion or deletion.
- A narrowly scoped SECURITY DEFINER mutation function owned by that role. Its
  search path is fixed to `pg_catalog`, all relations/functions are qualified,
  and the authenticated owner comes only from `auth.uid()`, never a payload.
- Forced RLS on both tables. Exact owner policies apply to the definer owner
  too; it is neither the table owner nor a bypass role.
- A SECURITY INVOKER reader exposing an explicit content row/lifecycle envelope,
  including tombstoned rows. A missing/invisible row returns null and must never
  be interpreted by a client as deletion evidence.
- Metadata checks of function signature/security/search path/version/EXECUTE,
  table and column grants, role membership/administrative privileges, forced
  RLS, and the exact policy set. Extra broad or unreviewed policies block.

The mutation function checks this metadata posture on every invocation and
stops if it drifts. This does not stop a trusted administrator from changing
privileges or data: granting direct UPDATE really would reopen that bypass.
Monitoring, administrative controls, and auditing every other privileged writer
remain deployment requirements. Metadata/comment checks are not an attestation
of arbitrary function bodies, triggers, extensions, or the entire project.

## RPC semantics

Lab entry points (not public/deployed endpoints):

- `note_read(uuid)` returns `{ row, lifecycle }` for one owned row or null.
- `note_change(uuid, jsonb, text, jsonb, uuid)` accepts an exact expected
  `{ content, lifecycle }`, action `edit` or `tombstone`, optional desired
  content (edit only), and an operation UUID. Returns a fixed status only.
- `verify_contract()` reads catalogs only and never invokes the writer or
  selects application content. It may report `isolated_ready: true`, but
  **always** reports `ready: false` and `production_ready: false`.

Content contains exactly `legacy_id`, `title`, `body`, `note_date`; identity and
owner are checked separately. Lifecycle contains version 1, positive safe
integer revision, explicit null or canonical millisecond UTC `deleted_at`, and
explicit null or operation UUID. Note dates are real ISO calendar dates, not
best-effort coercions. Empty text and null note dates remain representable.

The writer takes an advisory lock on the note identity and locks the exact
owned row. It compares complete expected content **and** lifecycle. Both edits
and tombstones advance the server revision exactly once. Client timestamps are
not accepted as revision/deletion authority. A tombstone retains content and the
physical row; its time is generated by the server. Stale edits, stale deletes,
edit/revert ABA cycles, and edits against a tombstoned row conflict. Missing
rows cannot be inserted through this API. Legacy identity cannot change.

There is no insert, hard delete, restore, purge, financial record, or dynamic
table-name argument. A schema constraint limits revisions to JavaScript's exact
integer range, with an explicit exhaustion error before advancing beyond it.

## Idempotence and rollback

A private immutable operation ledger binds owner/operation UUID to the exact
note, expected snapshot, action, desired content, and resulting lifecycle.

- Exact retry while the row still equals the recorded result returns
  `ALREADY_APPLIED` without another update/revision/receipt.
- Reusing an operation UUID with a different note, expected snapshot, action,
  or desired content is rejected. It is not an acknowledgement shortcut.
- Retrying an older edit after a subsequent deletion returns `CONFLICT`; it
  cannot recreate content or misleadingly acknowledge the older result.
- Note read-back checks content, identity, ownership, revision, operation,
  deletion state, creation time, and server update time. Receipt read-back
  checks the full stored operation. A trigger-distorted note or receipt raises
  a fixed error and rolls the whole statement back.
- The note update and receipt insertion share one database transaction. Ledger
  uniqueness also rejects cross-note reuse; true concurrent cases still need
  multi-session verification.

The ledger retains prior note content. It is private recovery/idempotence data,
not a diagnostic, and has no client read/export/purge grant. Retention and
account deletion policy must be designed before production deployment.

## Private sidecar contract lab

`tests/sql/notes-sidecar-lab.sql` moves the same lifecycle checks onto the
production-shaped design recommended by `PRODUCTION_PRIVILEGE_AUDIT.md`:

- `public.notes` stays content-only, so old `select=*` note projections and v2
  content fingerprints do not gain lifecycle columns.
- `cap_notes_private.note_lifecycle` stores revision/deletion/operation state and
  `cap_notes_private.operations` stores the private receipt ledger. Both use
  forced RLS, exact writer-only policies, and no client schema `USAGE`.
- `cap_notes_sidecar_writer` is a dedicated no-login/no-inherit role with no
  table/schema ownership, schema `CREATE`, role/database administration,
  replication, or client membership. It has only the note `SELECT`/`UPDATE` and
  sidecar `SELECT`/`UPDATE`/`INSERT` privileges it needs.
- `public.cap_notes_read`, `public.cap_notes_change`, and
  `public.cap_verify_notes_lifecycle` are owned by that writer, fixed to
  `pg_catalog`, and are the only client-executable notes lifecycle endpoints.
  Clients receive no direct note or sidecar table/column grants.
- Admin-only `backfill_lifecycle`, `coverage_ok`, and `rollback_guard` helpers
  are not client endpoints. Backfill inserts missing revision-1 rows without
  changing content and is idempotent. The rollback guard refuses to describe a
  sidecar drop as safe once any tombstone exists; it never performs rollback.

The 83-check sidecar suite rehearses the whole migration shape in one disposable
database: legacy readiness and a content-only legacy edit first; sidecar install
and exact backfill; the new verifier refusing the still-open legacy grants/policy;
an explicit cutover that revokes direct note access and drops both legacy RPCs;
old-client denial; new reader/writer edit and tombstone CAS; retry and operation
reuse binding; missing-row and cross-owner denial; direct table, column, schema,
and `SET ROLE` bypass denial; metadata drift and legacy-RPC restoration blocking;
rollback-guard evidence; and reinstall without resetting content, revisions,
tombstones, or receipts. It always reports `ready: false` and
`production_ready: false`.

A separate `tests/notes-sidecar-rollback-sql.cjs` performs 5 checks for the
clean-abort path after cutover but before any edit receipt or tombstone. It
restores the old grants/policy/RPCs, removes the sidecar schema/functions/role,
and proves the old verifier and content-only CAS work again. It does not model
rollback after a tombstone, which the guard correctly blocks.

This lab proves the isolated contract shape, not live Supabase behavior. It does
not cover PostgREST/auth-role inheritance, provider backups, the real migration
window, service-role paths, concurrent multi-session deadlocks outside the
existing race run, client compatibility/import/undo wiring, or a real tombstone
trial. Live SQL, grant changes, cutover, and the old-client lockout still require
separate authorization.

## Verification and remaining gates

`node tests/notes-lifecycle-sql.cjs`: **70 isolated checks**, including ACL and
column-grant bypasses, role escalation/membership, cross-user reads/writes,
anonymous and missing identity, strict inputs, stale revisions, a real edit/
revert ABA sequence, retry binding, tombstone retention, rejected resurrection,
trigger rollback, revision exhaustion, timezone-stable deletion timestamps,
metadata-only behavior, and reinstallation without resetting rows/history.
The setting guard is also tested before any lab schema is created.

`node tests/notes-sidecar-sql.cjs`: **83 isolated checks** for the private
sidecar, cutover, old-client lockout, backfill, backfill idempotence, direct and
column bypass denial, metadata drift, blocked legacy restoration, and the
tombstone-aware rollback guard. It never contacts Supabase.

`node tests/notes-sidecar-rollback-sql.cjs`: **5 isolated checks** for the
pre-tombstone clean-abort path. It restores the exact old policy/grants/RPCs,
drops the sidecar schema/functions/role, and verifies the old verifier plus CAS
work again.

Tests use the external optional package via `CAP_PGLITE_PATH`; no dependency was
added to the static app. All 32 ordinary isolated suites and JS/JSON syntax
checks pass.

**Not proven by these tests:**

1. PGlite alone does not prove concurrency. The separate Docker PostgreSQL run
   now covers eight observed contention cases and direct-write denial (see
   below), but not every multi-row deadlock/lock-order or deployment scenario.
2. Real Supabase/PostgREST role/JWT behavior, grants inherited from production
   defaults, existing SECURITY DEFINER endpoints, triggers, service-role paths,
   and schema/RLS exposure. The test JWT claim setting is a harness fixture,
   not an authentication implementation.
3. A safe production migration/rollback and old-client capability lockout in the
   real project. The deployed public table/RPC still has its old content-only
   contract. No partial live installation or automatic baseline lifecycle
   upgrade is authorized. `PRODUCTION_PRIVILEGE_AUDIT.md` records the static
   findings and the sidecar-first design, and the isolated sidecar lab now
   rehearses its install/cutover/rollback guards; the read-only catalog audit has
   still not been run against Supabase. The current direct note grants and legacy
   content-only writer are not a lifecycle boundary.
4. Live client reader/writer adapters, retry policy, private receipt retention,
   tombstone-safe normalizing/merging/import/export, all existing manual-operation
   recovery guards, and UI integration. The unwired planner and local prototype
   cannot obtain production capabilities from this lab.

The two-session runner at `tests/manual/notes-lifecycle-races.cjs` has 21 passing
target/static guards. It **passed an actual disposable PostgreSQL 16.15 run** after separate user
authorization: 10 checks, three independent backends, eight observed lock waits,
and production readiness false. The healthy Docker container was left running
for inspection; no app data, Supabase SQL, or public-table migration was involved.
All 32 ordinary isolated suites pass. `NOTES_LIFECYCLE_RACES.md` records the
measured cases and remaining limitations. The subsequent static production
privilege/migration audit is in `PRODUCTION_PRIVILEGE_AUDIT.md` (read-only
catalog audit, 8 isolated checks, no live execution), and the sidecar lab above
rehearses the recommended cutover. The unified production cutover draft
(`supabase_production_cutover.sql`) now covers the notes lockout plus the
financial-table lockout in one fail-closed transaction and is recorded in
`PHASE_6L_SNAPSHOT_READINESS.md`. Client lifecycle-safe
merge/import/integration, the user's design decisions, and a separately
authorized live audit remain next; live SQL installation or a tombstone trial
still requires separate explicit approval.
