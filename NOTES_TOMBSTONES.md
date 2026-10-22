# Notes deletion/tombstone pilot — design and isolated planner

Status: **pure planner and isolated local-staging/remote-apply prototypes implemented; live
storage integration, deletion UI, and server lifecycle
support not implemented, installed, enabled, or live-tested**. This document
authorizes no mutation. Current shell remains `cap-shell-v314`; Cloud Sync stays
OFF. The successful keep-local trial is recorded in `CONFLICT_RESOLUTION.md`.
Its retained backups and remaining trial markers are not cleanup targets.

## Scope and invariants

First support exactly one existing, owned, baseline-mapped array-form note.
No financial records, account cascades, bulk deletes, legacy string notes,
automatic retries, restoration, purge, or background sync. A tombstone records
an explicit deletion; a missing row is **not** a tombstone.

- Require explicit on-device delete intent, a verified backup, fresh identity,
  exact persistence/mapping/baseline evidence, a preview, and confirmation.
- Preserve the winning deletion and losing content; never silently prefer an
  edit or deletion using a device timestamp.
- A failed read, empty response, missing baseline record, import omission, or
  empty local list never authorizes deleting anything on the other side.
- Keep sync OFF before, during, and after every manual stage.
- Stop on partial outcomes. A local/cloud distributed operation is not atomic;
  only each local transaction and server CAS can be atomic individually.
- Diagnostics contain fixed statuses, counts, field names, and booleans only.
  Note content and identifiers stay private in local backups/review receipts.

## Current code findings

1. `js/app.js:openNote()` removes notes with `S.notes.filter(...)`. It does not
   retain durable, owner-bound deletion intent. The legacy reset button in
   `js/cards.js` is broader and must not be used to stage this pilot.
2. `js/sync.js:applyOperation()` translates a queued `delete` into HTTP DELETE.
   Its old engine test labels that path a tombstone, but it physically removes
   a disposable account. It is not production soft-delete support.
3. `classifyQueuedChange()` classifies missing cloud rows and legacy delete
   queue entries. Those classifications do not constitute deletion evidence or
   permit calling that hard-delete transport from the new pilot.
4. `recordFingerprints()` only emits local rows with a matching cloud row.
   Manual note validation requires exact coverage; deletion needs a separate
   lifecycle-aware comparison, not a waiver of coverage checks.
5. `supabase_schema.sql` has no note deletion state or lifecycle revision.
   `cap_sync_note_put` compares content only and has no delete/restore contract.
6. `content()` in `js/notes-manual.js` rejects unknown cloud columns. The
   fingerprint canonicalizer would also include new lifecycle columns unless
   projected out. Adding nullable columns alone would break active-note
   comparisons against existing v2 baselines.
7. Generic `mergeList()` keeps edits against deletion and uses `_u` for some
   conflicts. That is not the explicit-choice policy required for tombstones.

## Proposed representation

### Local (pilot schema proposal; no saved data changed)

- Keep active notes in `S.notes` with their existing identity/content shape.
- Add an optional `S.noteTombstones` collection. Missing means an empty
  collection, not implicit delete intent. Each entry has a stable, owner-scoped
  identity, mapped local/cloud identities, explicit operation ID, original note
  snapshot, expected baseline content fingerprint, and expected server lifecycle
  evidence. A local timestamp is informational, never an ordering authority.
- A local stage transaction saves a verified recovery backup first, then
  atomically removes exactly one active note from persisted state and records
  its tombstone/intent. Memory/localStorage must reflect and verify that commit;
  failures retain recovery evidence rather than pretending nothing happened.
- Active and tombstoned representations of the same mapped note cannot coexist
  except inside an explicitly blocked recovery/conflict receipt.
- Baseline mapping remains: do not remove it merely because a note is hidden.
  Add optional lifecycle acknowledgement only after verified convergence.

This collection is **not** ready to add merely by listing it in `LIST_KEYS`.
Implementation must update normalization/defaults, stamp/tracking, merge,
account-owner isolation, migration mapping, JSON backup/import, and CSV paths.
Merge must preserve conflicting evidence and block the manual flow, never
timestamp-pick a winner. JSON round trips must retain tombstones and owner
binding. CSV omission is not deletion; CSV may restore content only through an
explicit reviewed import, never consume or clear tombstones. Importing old
JSON without lifecycle metadata cannot clear existing deletion evidence.

### Cloud and baseline (requires separately reviewed SQL)

Propose retaining the note row with `deleted_at` plus a server-controlled,
monotonically increasing lifecycle revision. Retain note content during this
pilot; hiding and physical erasure are different operations. New clients must
read active and deleted states explicitly, rather than filtering deleted rows
out and mistaking them for absent rows.

- Keep legacy active-note content hashes unchanged using an explicit
  `legacy_id/title/body/note_date` projection. Do not change the global hash
  exclusions or reinitialize/replace the v2 baseline.
- Add optional lifecycle evidence to the affected baseline record only, with
  an explicit version/capability handshake for the new path. No implicit
  all-record baseline upgrade is authorized.
- CAS must check identity/owner, the complete expected content, deletion state,
  and revision under a row lock. The revision prevents a delete/restore cycle
  from looking like the old active state (ABA). A stale edit must never clear a
  tombstone, and a stale delete must never discard a newer edit.
- A new notes-only lifecycle RPC and metadata-only readiness verifier are
  proposed. They must not accept a client `user_id`, perform a hard DELETE,
  create an absent row for a delete, or offer restoration in this milestone.
- Existing notes RPCs/readers must be capability-gated or upgraded before any
  lifecycle write is possible. Legacy writers must reject tombstoned rows;
  unsupported clients fail closed, not silently recreate or overwrite them.

**Server deployment gate:** current own-row RLS alone permits direct writers.
An RPC-only comparison does not protect against a direct PostgREST update or
delete. A reviewed privilege/trigger/RPC design must prevent bypasses while
preserving the chosen invoker/definer security model; simply revoking UPDATE
breaks a SECURITY INVOKER writer too. Do not claim this gate solved by adding
columns or a readiness flag. This must be settled and race-tested in staging
before any live lifecycle migration/write is proposed.

## Read-only decision matrix

All rows below additionally require proven ownership, exact mapping, complete
reads, current persistence, unchanged unrelated records, sync OFF, and no
pending outbox/recovery work. A preview never executes its proposed action.

| Local evidence | Cloud evidence | Decision |
| --- | --- | --- |
| Active, baseline content | Active, same baseline lifecycle | No deletion work |
| Missing, no explicit intent | Active | Block: local absence is not intent |
| Explicit delete intent from baseline | Active, exact expected lifecycle/content | Preview one cloud tombstone CAS |
| Explicit delete intent | Active, changed content or revision | Delete-versus-edit conflict; preserve both |
| Active, exact acknowledged lifecycle/content | Explicit newer cloud tombstone | Preview one local tombstone application |
| Active with a local edit | Explicit cloud tombstone | Edit-versus-delete conflict; preserve both |
| Same local intent | Matching cloud tombstone/operation evidence | Preview acknowledgement only; no writer call |
| Tombstones with incompatible lifecycle evidence | Tombstone | Block for review; do not merge by timestamp |
| Any | Missing row, unreadable row, or malformed/ambiguous result | Block; do not infer a tombstone |
| Missing on both sides without explicit proof | Missing | Block; not automatically acknowledged or purged |

Restoration/keep-edit against a tombstone is not implemented in this pilot.
Explicitly reviewed deletion choices may be designed later; do not reuse the
content-only keep-cloud/keep-local helper for a delete-versus-edit conflict.

## Manual phases and recovery

1. **Read-only candidate:** verify one supported record and all unrelated
   coverage. Return a fresh owner/state/baseline/cloud/intent-bound ticket.
2. **Confirm local intent:** the user chooses one existing note. Verify and
   retain a local note/state/baseline backup; commit the local staging described
   above. Existing Delete UI must be deliberately wired or blocked for mapped
   notes during the pilot; do not globally wrap every `save()` into queueing.
3. **Separate cloud confirmation:** re-read everything, verify the saved backup
   and exact cloud snapshot, and send at most one tombstone CAS. No background
   queue drain. A pre-existing matching tombstone needs no mutation request.
4. **Verify before acknowledging:** exact-read the resulting lifecycle. Only
   then atomically acknowledge one baseline record and the matching local
   tombstone. Leave any unrelated outbox entry or checkpoint untouched.
5. **Local application of a remote tombstone:** separately confirmed and backed
   up; atomically update local state, local evidence, and one baseline record.
   Make zero cloud mutation requests for this direction.
6. **Final verification:** verify persisted local state, retained snapshots,
   baseline lifecycle, empty outbox, unrelated financial collections, and exact
   cloud state. Remove only this operation's completed recovery checkpoint.

Proposed checkpoint: `manual-notes-tombstone-v1`; proposed backup prefix:
`manual-notes-tombstone-backup:`. Use a distinct recovery kind/mode instead of
pretending a tombstone is a content pull. Integrate mutual exclusion with the
existing `cap-controlled-notes-test` lock and **every** manual push/pull,
resolution, baseline, controlled-test, and cleanup guard before wiring UI.

Recovery phases: `prepared`, `local-staged`, `cloud-written`, `applied`.
Read-only inspection compares original/desired local, cloud, and baseline
snapshots independently. Preserve a pre-request marker so an interrupted or
unknown CAS cannot be mistaken for a definitely-not-attempted operation.
If a response is lost, read the exact cloud lifecycle; never auto-retry a
writer. Cloud written but baseline original is partial completion, not success.
Only mark verified when both sides match the intended lifecycle. Backups remain
after success; their expiry is not tied to checkpoint removal.

## Purge and device acknowledgements

**No physical purge in this milestone, even after both current tabs agree.**
An offline device or old backup may still resurrect content. Device membership,
revocation, per-device acknowledgement, a retention policy, and resurrection
barriers are not implemented. Until those exist, retain deletion evidence
indefinitely. Retention duration remains an open product decision; a wall-clock
age or empty outbox alone can never prove global acknowledgement.

## Delivery and acceptance gates

1. Add a pure, unwired planner with isolated tests for every matrix row, stale
   tickets, owner/identity mismatches, unknown fields, missing versus unreadable
   evidence, revision/ABA changes, and redacted statuses. No app boot hook.
2. Add backup-first local staging/application and recovery tests with fake IDB:
   reload, export/import, old backups, owner switch, localStorage failure,
   interrupted checkpoints, concurrent tabs, and unchanged financial collections.
3. Design and test versioned SQL/readiness/bypass protection in isolated
   PostgreSQL, followed by true two-session staging races and the RLS matrix.
   Run no Supabase SQL from the design/isolated-test steps.
4. Integrate guarded developer-only UI/readers and update shell version/cache
   paths if shell files change. Recheck existing manual notes flows, field-name
   diagnostics, light/dark themes, and online-then-offline reload.
5. Rehearse on a fresh disposable origin with synthetic notes; verify local
   stage, cloud CAS, remote tombstone apply, recovery, reload, and backup retention.
6. Only then request separate authorization for SQL installation and any one-note
   live tombstone trial. Never use the current real trial note by default.

## Isolated planner implementation (2026-10-21)

`js/notes-tombstone-plan.js` exposes only `plan(snapshot)` and
`review(snapshot, ticket)`. It is intentionally absent from `index.html` and
service-worker `CORE`: this new standalone module is not an app-shell resource,
has no boot hooks, and does not change the installed shell. It has no storage,
DOM, timers, cloud transport, executor, confirmation prompt, or side-effecting
app dependency. Browser integration is a later gate, not an implicit next load.

Input contract (all evidence is synthetic in current tests):

- `version: 1`, owner, strict boolean `syncOff`/`persisted`, empty `entries`,
  explicit null test/demo/pull/tombstone checkpoint slots, and strict complete
  coverage/unchanged-unrelated-record attestations.
- Versioned lifecycle reader/CAS/bypass-protection capability attestations.
  **These flags do not implement or prove a live server gate.** A future adapter
  must derive them from a reviewed server verifier, not user-controlled flags.
- Owned v2 baseline records and exactly one notes target mapping. The target
  baseline needs proposed lifecycle evidence; existing baselines without it
  intentionally fail closed. Nothing adds/initializes that evidence today.
- A local `active` row, `missing` evidence, or an explicit staged `tombstone`
  intent with original content, expected content hash/lifecycle, operation ID,
  ownership/mapping, and null or exact prior acknowledgement.
- An exact owned cloud row plus lifecycle envelope. Missing, unreadable,
  ambiguous, unknown-version, malformed, or unexpected-field evidence blocks.
- Lifecycle fields: version 1, safe positive integer revision, null or exact
  UTC ISO deletion timestamp, and null/explicit operation ID. A deleted state
  requires an operation ID. Local time never selects a winner.

The planner hashes an explicit sorted `body/note_date/title` projection,
consistent with existing content hashing's exclusion of identities. It validates
identities independently, so an equal content hash never bypasses owner/mapping
checks. Cloud revisions may not regress; changed state/content without a new
revision blocks. Intent convergence requires matching operation, original
content, and precisely the expected next revision; same content after an
intervening lifecycle change is not silently accepted (ABA protection).

Candidate results contain only fixed redacted statuses/classifications/actions,
field names, and a SHA-256 ticket. All results have `executable: false`,
`authorized: false`, `canRestore: false`, and `canPurge: false`. A candidate
`previewReady: true` means **reviewable**, not writable, and requires future
confirmation/backup execution logic. There is no current function that consumes
these tickets to write anything.

Tickets bind the complete detached input snapshot and planner version, including
owner, baseline, operation, cloud lifecycle, coverage, queue, and recovery
evidence. Key-order changes do not invalidate equivalent evidence; actual
evidence changes do. `review()` recomputes the ticket and still returns only a
non-executable preview. Input detachment before awaits prevents caller mutation
from mixing a decision against one snapshot with a ticket against another.
Malformed input and hashing failures return fixed blocked statuses, not raw
errors or private content.

Verification: `node tests/notes-tombstone-plan.cjs` passes **105 checks** covering
the complete decision matrix, capability/mapping/owner/schema/date failures,
pending/recovery precedence, both kinds of missing evidence, lifecycle revisions,
already-acknowledged retention, no restoration/purge, ticket freshness and
key-order stability, caller mutation, redaction, cyclic/throwing inputs, and
ticket-hash failure. Forbidden environment accessors prove that loading and
calling the planner never touches storage, network, DOM, or app boot. A wiring
check confirms it is not included in HTML or the cached app shell.

## Isolated local staging and recovery prototype (2026-10-21)

`js/notes-tombstone-local.js` exposes a dependency-injected factory, with no
ambient IndexedDB/localStorage access and no database creation/upgrade. The
caller must supply an already-open disposable database, state/storage adapters,
the lifecycle planner, a synchronous owner/sync-off guard, and the shared lock
adapter. It is not loaded by HTML, cached in the service worker, or referenced
by existing Delete controls. Existing app schema/defaults/merge/import are
unchanged. Do not pass the real app state/database to this prototype yet.

Methods:

- `preview(evidence)` binds one unchanged active local note and its full local
  JSON to a stable operation ID/request time, owned lifecycle baseline, and
  exact cloud evidence. It derives a proposed intent for planner validation;
  an edited note, legacy baseline, existing/malformed tombstone collection, or
  unsupported candidate blocks. Preview itself writes nothing.
- `stage(ticket, { inspect, confirm })` requires a fresh preview, explicit true
  confirmation, current memory/localStorage/IDB agreement, exact baseline,
  empty outbox, and no test/demo/pull/tombstone recovery checkpoint. It checks
  evidence before/after confirmation and again after backup verification.
- The first IDB transaction saves the full original local JSON, baseline,
  original cloud evidence, and target note, plus a `prepared` checkpoint. A
  separate read transaction verifies both before staging can proceed.
- A second IDB transaction removes only the selected active note, adds its
  owner-bound `noteTombstones` intent with original content, and writes a
  `local-staged` checkpoint. It changes no baseline or outbox record. All
  unrelated state, including financial collections and other notes, is copied
  unchanged. Memory and localStorage are updated and read back after commit.
- A success is **local staging**, not synced deletion. The checkpoint and
  backup deliberately remain for the future separately confirmed cloud stage.
  No checkpoint cleanup, cloud request, restoration, or purge API exists.
- A failure before staging retains the active note. If backup committed, its
  checkpoint remains. A failure after IDB staging returns an explicit committed/
  verification-incomplete result; no automatic rollback or retry occurs.
- `inspectRecovery()` reads local evidence only. It reports original/staged IDB
  agreement, baseline unchanged, backup verified, persistence agreement,
  unrelated state unchanged, and pending/recovery guards. It explicitly labels
  cloud evidence **NOT CHECKED**, even when local staging verifies.
- `exportRecovery()` provides an explicitly private JSON bundle containing the
  checkpoint and backup; it must never be printed as a diagnostic. The bundle
  retains both original content and proposed intent for external backup.
  `inspectExport()` validates version, derived desired state, owner binding,
  original snapshots, and ticket without importing, restoring, or writing
  anything. Old content-only JSON and missing/modified lifecycle evidence fail
  validation rather than clearing retained intent.

The initial staging-only version passed 37 isolated checks; the current
`tests/notes-tombstone-local.cjs` passes **59 isolated checks**
using a separate fake IndexedDB factory/database and synthetic records. Coverage
includes backup-before-removal, atomic rollback, cancellation, stale tickets,
changed evidence, owner switches, queue/recovery precedence, two adapter
instances, in-memory/localStorage/post-commit read failures, prepared checkpoint
retention, backup tampering, unchanged baseline/financial records, database
close/reopen, private export round trip, and rejection of old/tampered/foreign
bundles. Environment traps prohibit ambient storage/network/DOM/timer access;
wiring assertions confirm no app-shell inclusion. All **24** isolated suites
and JavaScript/JSON syntax checks pass.

**Still blocked from live use:** default/schema/merge/import compatibility,
existing manual-operation mutual exclusion, actual browser integration, and a
server lifecycle contract with bypass protection. The export inspector is not a general backup importer;
its tests do not claim that the existing app importer is tombstone-safe.

## Isolated remote-tombstone application (2026-10-21)

The same unwired factory now also exposes `previewRemote(evidence)` and
`applyRemote(ticket, { inspect, confirm, readCloud })`. This is a separate mode:
local-stage tickets cannot authorize remote application, or vice versa.

- Require an active local note matching the acknowledged baseline content, plus
  a newer explicit cloud tombstone with identical retained content. A missing
  row, failed read, active cloud row, edited local/cloud content, unsupported
  lifecycle capability, or incomplete coverage blocks before any backup/write.
- Back up and verify the original local JSON, baseline, note, and reviewed
  cloud tombstone before removing anything. Re-read the full evidence after
  confirmation and after backup verification. No cloud writer is supplied.
- In one IDB transaction, remove the selected active local note, retain its
  original content as an owner-bound `origin: "cloud"` tombstone, acknowledge
  only that baseline record's lifecycle, and write an `applied` checkpoint.
  Advance the baseline revision once, retain the content hash/mapping, and
  preserve all unrelated baseline records, notes, financial state, and outbox.
- Remote-origin evidence records the actual cloud operation/revision in its
  acknowledgement. It does not invent a local delete intent or fictitious
  immediately preceding revision. The planner explicitly recognizes a matching
  retained remote acknowledgement even after multiple intervening revisions.
- Verify memory/localStorage/IDB agreement and exactly re-read the supplied cloud
  lifecycle/content after the local commit. Only then remove this completed
  checkpoint; the original backup remains. This is point-in-time verification,
  not a lock preventing subsequent remote changes.
- A failure between state/baseline/checkpoint writes rolls all three back and
  retains the prepared backup/checkpoint. Failures after commit preserve the
  applied data and report a committed-but-unverified outcome; no rollback,
  writer retry, restoration, or purge is attempted.
- If cleanup commits but its read-back fails, the result explicitly reports
  that the checkpoint was removed and the backup retained. It does not falsely
  promise that an applied checkpoint still exists.

Remote recovery inspection requires an explicit `readCloud` reader to report
verified data. Without it, or after failed/divergent reads, recovery remains
blocked. Local evidence is reread after asynchronous cloud verification to
refuse owner/state/baseline/backup changes during inspection. Read-only
inspection never cleans a checkpoint up automatically.

Prototype checkpoint/backup version is now **2**; lifecycle and intent contracts
remain version 1. Earlier prototype bundles are not silently reinterpreted or
migrated: they are rejected and left untouched for review. The private export
API exports an existing unresolved checkpoint and its backup, not an inventory
of retained backups after completed checkpoint cleanup.

The persistence suite's 59 checks include both local staging and remote apply:
remote cancellation and preflight failures, atomic baseline rollback,
post-commit memory/localStorage failures, cloud read failure/divergence, cleanup
failure, recovery/export inspection, database reopen, mode-bound tickets,
intervening revisions, replay prevention, and accurate cleanup read-back failure
reporting. Five additional planner cases cover retained remote acknowledgements,
identity/content/operation mismatches, and blocked implicit restoration. All
24 isolated suites and JavaScript/JSON syntax checks pass.

## Server lifecycle lab (2026-10-21)

`tests/sql/notes-lifecycle-lab.sql` and `tests/notes-lifecycle-sql.cjs` now exercise
a separate-schema, least-privilege definer contract, forced owner RLS, blocked
direct client writes, exact content/lifecycle CAS, and a private operation ledger.
The 70 SQL checks pass in isolated PostgreSQL WASM; public notes and deployed
RPCs remain unchanged. The verifier deliberately never reports production
readiness. See `NOTES_LIFECYCLE_SERVER.md` for the contract, threat-model limits,
and mandatory two-session/production audit gates. All 25 isolated suites pass.

The disposable two-session race runner in `NOTES_LIFECYCLE_RACES.md` has now
passed a real PostgreSQL 16.15 run after explicit Docker-test authorization:
10 checks, three independent backends, and eight observed lock waits. Its 21
target/static guards and the 26 ordinary isolated suites had also passed.
Production readiness remains false; these measured races do not replace the
client merge/import/integration and production privilege/migration gates. No
Supabase connection or live SQL is authorized by this run. Existing
real-note Delete controls remain non-tombstone-aware; no live deletion or SQL
installation is authorized.

## Pure compatibility previews (2026-10-21)

`js/notes-tombstone-compat.js` adds unwired note shape inspection, three-way
merge/import/replace/undo proposals, CSV separation, private JSON export, and
fresh-ticket review. It retains omitted tombstone evidence, refuses automatic
restoration or timestamp winners, and returns note-only private candidates—not
financial replacements or a state executor. Its 73 synthetic checks pass; all
27 ordinary isolated suites pass. Actual app normalization/import/undo/merge,
collection defaults, and real storage are still unchanged. The real Docker race
run was not repeated. Contract and integration gates: `NOTES_TOMBSTONE_COMPAT.md`.

The subsequent 28-check real-definition entrypoint rehearsal uses actual app
normalizer/merge/export/import/undo definitions with synthetic VM/fake IDB data.
It confirms the pure guards compose with those parsers without invoking legacy
apply or financial callbacks; it also reproduces unsafe legacy behavior only in
isolated regression fixtures. Original backup wrapper ownership/version must be
retained for validation rather than stripped via `jsonPlan(...).d`. All 28
ordinary suites pass. A verified-backup atomic note-only apply adapter and
browser integration gates remain; live code and saved state are unchanged.

The subsequent **unwired** note-only compatibility apply adapter now passes 43
fake-IDB checks; the real-definition entrypoint suite passes 31. A native fresh-
origin rehearsal also passed cancellation, backup-first local apply, unchanged
sidecar/baseline/non-note state, and reopen persistence, with zero network/cloud
calls. At that stage all 30 ordinary suites passed. This adapter cannot add/change/delete
tombstones or remove existing active note identities, does not call the legacy
financial importer, and shares the isolated tombstone recovery lock/checkpoint.
No live app entry point or schema default is wired. Contract and remaining
integration gates are in `NOTES_TOMBSTONE_COMPAT.md`.

## Production privilege/migration audit (2026-10-21; static)

The read-only catalog audit in `tests/sql/production-privilege-audit.sql` and
the review in `PRODUCTION_PRIVILEGE_AUDIT.md` now cover the deployed
repository-derived notes posture. They identify the blocking facts: direct
`INSERT`/`UPDATE`/`DELETE` and column-level write grants for `authenticated`,
the permissive `FOR ALL` policy, RLS without `FORCE`, the legacy content-only
CAS/verifier, the test transaction RPCs, and the unknown default-privilege,
role-membership, definer-endpoint, and PostgREST-exposure surface.

The audit SQL is read-only, reads catalogs only, and never selects note content.
Its 8-check PGlite harness proves detection of table and column write paths,
transitive client membership in privileged/`cap_*` roles, and
shows that a hardening simulation clears critical/high findings without ever
claiming `production_notes_lifecycle_ready`. The design recommends a private
lifecycle sidecar (content-only `public.notes`) over adding columns to the
public row, because `select=*` would otherwise change old clients' v2
fingerprints and expose tombstone columns. No live audit, SQL, grant, policy,
sidecar, or migration was executed. The next step is a user decision on the
sidecar/reader/lockout design, then separately authorized live read-only audit.

## Private sidecar contract lab (2026-10-21; isolated)

`tests/sql/notes-sidecar-lab.sql` and `tests/notes-sidecar-sql.cjs` now rehearse
the recommended production shape in disposable PGlite: content-only
`public.notes`; private `cap_notes_private.note_lifecycle` and `operations` with
forced RLS and exact writer-only policies; a dedicated non-login
`cap_notes_sidecar_writer` owner; RPC-only reader/writer/verifier endpoints; no
client table or schema grants; and admin-only backfill/coverage/rollback guards.

The **83 checks** cover the full cutover sequence: legacy readiness first;
sidecar install and exact revision-1 backfill; the new verifier refusing the
still-open legacy grants/policy; an explicit cutover that revokes direct note
access and drops both legacy RPCs; old-client failure; new edit/tombstone CAS;
retry and operation-reuse binding; missing/cross-owner denial; direct table,
column, schema, and `SET ROLE` bypass denial; metadata drift and restored legacy
RPC blocking; rollback-guard refusal after any tombstone; and reinstall without
resetting content, revisions, tombstones, or receipts. It always reports
`production_ready: false`.

A separate 5-check `tests/notes-sidecar-rollback-sql.cjs` rehearsal covers the
clean abort after cutover but before any tombstone: restore the old
policy/grants/RPCs, drop the sidecar schema/functions/role, and verify the old
verifier and content-only CAS work again. It does not attempt rollback after a
tombstone; the guard blocks that path instead.

This proves the isolated contract shape and guard composition, not live
Supabase/PostgREST behavior, the real migration window, client integration, or a
tombstone trial. All 32 ordinary isolated suites pass. No live SQL, grant,
policy, sidecar, or migration was executed; Cloud Sync remains OFF.
