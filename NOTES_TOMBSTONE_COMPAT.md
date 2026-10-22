# Tombstone compatibility guards — isolated previews only

Status (2026-10-21): `js/notes-tombstone-compat.js` is implemented and isolated-
tested, but **not loaded by the app**. No saved-state normalization, import,
undo, merge, Delete control, cloud request, or database schema was changed.
Cloud Sync stays OFF. The running Docker lab is not used by these pure tests.

## Why the existing paths cannot be reused unchanged

- `CapOff.normalize()` supplies defaults for known collections but does not
  validate owner-bound note lifecycle evidence.
- `mergeList()` can choose an edit over an omitted record and uses `_u` for
  some conflicting fields. That is not an explicit tombstone conflict policy.
- JSON "Replace" assigns the imported state wholesale, potentially removing
  deletion evidence absent from an older backup.
- "Undo import" restores the earlier snapshot wholesale; it could reinstate a
  note deleted since that snapshot.
- The existing JSON merge/import count paths focus on financial collections;
  they do not independently reconcile note tombstones. CSV carries transaction
  content, not note deletion evidence.

None of those existing implementations has been modified in this step. The
prototype deletion modules remain unwired until all relevant callers can use
the eventual verified apply guard together, not just one happy-path button.

## Module contract

Exports only `inspect`, `planMerge`, `planImport`, `review`, and `exportPrivate`.
No boot hooks, S access, persistence, UI, timers, executor, or cloud transport.

### Inspection, not silent normalization

`inspect(state, owner)` validates a detached snapshot without changing it.
Omitted `noteTombstones` means no evidence in that snapshot, not proof that
existing evidence elsewhere should be cleared. Null/object/malformed sidecars,
duplicate mappings, active/tombstone coexistence, bad original content hashes,
invalid lifecycle versions/dates, and wrong owners block.

Supported local-intent and remote-origin sidecar shapes match the isolated
staging/apply prototype. Legacy string notes without lifecycle evidence remain
legacy text: inspection does not convert them. Merge/import previews involving
legacy text require separate migration review rather than manufacturing IDs,
dates, or delete intent.

The owner argument is a future adapter's verified identity context. Accepting
that argument in a pure function does not itself authenticate a user.

### Three-way note merge preview

`planMerge({ owner, base, local, remote })` returns only a proposal:

- Retain exact deletion evidence from any of the three snapshots, including a
  baseline tombstone omitted on both other sides. Never expire it by timestamp.
- Identical evidence is retained once. Divergent operation IDs, revisions,
  acknowledgements, timestamps, or mappings require review; do not pick the
  "newest" tombstone or silently upgrade an acknowledgement.
- A stale active copy matching retained deleted content may be suppressed in
  the **private preview**, with a suppression count. Its original input is not
  modified and there is no automatic state application or cloud deletion.
- Any edited deleted content conflicts. Unknown custom active-note fields also
  require review rather than discarding information absent from the canonical
  deleted-content snapshot.
- Missing active records without explicit tombstone evidence block, including
  both sides omitting the same baseline record.
- For active notes not involved in deletion, identical or one-sided record
  edits can be proposed; divergent edits conflict. `_u` is not a winner-selection
  clock. New non-colliding active records can appear in a private proposal;
  this does not implement mapped cloud creation or authorize any write.

### Import/replace/undo preview

`planImport({ owner, current, incoming, format, mode })` supports JSON proposals
and transaction-only CSV compatibility checks. It is not the app's importer.

- Old raw JSON and the existing version `1.01` Cap backup wrapper are recognized.
  Unknown wrapper formats/versions block instead of guessing.
- Existing deletion evidence survives old JSON that omits it, for merge,
  replacement, and undo proposals. Matching stale deleted content is not restored.
- Imported edited deleted content requires separate restoration review; no
  restoration API or default choice exists.
- A newly imported tombstone is not fresh server evidence or permission to hide
  an active note. It requires independent verification. A backup containing the
  exact already-retained evidence can round-trip without clearing it.
- Replace/undo omission cannot delete a current active note. Changed active
  content requires note review rather than silently winning as an old backup.
- CSV compatibility preserves the current note projection exactly. CSV cannot
  carry notes/tombstones or act as a lifecycle replace/undo operation.

The candidate is **note-only** (`privateNotes.notes`,
`privateNotes.noteTombstones`). It never returns an accounts/transactions/balance
replacement or validates financial import semantics. A future adapter must
combine this note guard with the independent financial importer safely; success
here cannot authorize financial imports, recalculate balances, or apply S.

### Private exports and fresh evidence

`exportPrivate(state, owner)` emits a private JSON envelope with owner binding
and the complete copied state, including unknown app fields and lifecycle
evidence. Because the file contains original note and possibly financial data,
`privateJson` must never be printed as a diagnostic. It is not automatically
downloaded, uploaded, or persisted.

Previews likewise include note content only under the explicitly private
`privateNotes` field. Public statuses/classifications/counts contain no content,
IDs, financial values, or raw exceptions. Every diagnostic result is
`executable: false`, `authorized: false`, with restoration/purge unavailable.

Preview tickets hash the detached full input and operation kind/version.
`review(kind, input, ticket)` rederives a proposal and rejects stale evidence;
it still does not execute it. Key-order changes are equivalent, but owner,
content, sidecar, baseline, or unrelated-state changes invalidate the ticket.

## Verification and remaining work

`tests/notes-tombstone-compat.cjs`: **73 pure checks**. Covers legacy omission,
JSON merge/replace/undo, CSV separation, both sidecar shapes, divergent lifecycle
evidence, edit-versus-delete, identity/owner/schema failures, private JSON round
trip, input immutability, caller changes during hashing, ticket freshness,
key-order stability, redaction, and no ambient browser/storage/network access.
Static checks confirm the module is absent from HTML and the cached shell.

All **27** ordinary isolated suites and syntax checks pass. The separate real
PostgreSQL race run remains the recorded 10-check/8-lock-wait result; it was not
repeated for this client-only work.

Next gates before any real application:

1. Compose these guards with actual normalization, cross-tab merge, JSON/CSV
   preview/apply, replace, undo, and reset entry points in disposable rehearsals.
2. Verify owner/sync-off/persistence/recovery locks and a verified backup before
   one atomic local apply. Update the collection schema/defaults/tracking and
   backup/import guards together; do not wire just the Delete button first.
3. Audit existing server roles/privileged endpoints and design a separately
   reviewed migration/old-client lockout. The lab is not a deployable migration.
4. Rehearse failure cases in light/dark/offline/reload flows, then request any
   needed SQL installation/live trial authorization separately.

## Actual app-definition composition rehearsal (2026-10-21)

`tests/notes-tombstone-entrypoints.cjs` runs the actual offline-layer
normalizer/`mergeDoc` and actual `expJSON`, `jsonPlan`, `csvPlan`, `impApply`,
and `impUndo` definitions in separate VMs, with synthetic memory/localStorage,
fake IndexedDB, and no app boot or network. It also stages/applies synthetic
tombstones using the actual isolated local module, then feeds those results
through compatibility inspection and the app's real JSON export/parser.

**28 passing rehearsals** cover:

- Both local-intent and remote-origin outputs validate and survive the real
  app's JSON export/parser round trip, without changing financial state.
- The current normalizer retains an existing valid sidecar, but does not
  validate malformed sidecars; the compatibility inspector catches these.
- Explicit regression demonstrations show the unmodified legacy Replace and
  Undo paths erase lifecycle proof, and that the importer swallows a backup
  write failure. These calls happen **only in synthetic VMs** to expose unsafe
  behavior, not as authorized app behavior or live fixes.
- The real generic merge can erase baseline-only tombstones, produce active/
  tombstone coexistence after an edit-versus-delete, or timestamp-pick a
  content winner. Compatibility proposals retain proof or block for review.
- Preview-only composition protects old merge/replace/undo proposals without
  calling `impApply`, `render`, `save`, storage writes, or balance callbacks.
- The actual CSV parser can produce a transaction candidate while the note
  compatibility projection remains unchanged; the candidate is not applied.
- A note-only proposal never consumes an imported account-balance replacement.

**Wrapper handling gate:** the actual `jsonPlan` unwraps `.data` and does not
preserve wrapper owner/version metadata in its returned state. The rehearsal
therefore validates using the legacy parser but passes the **original full
input envelope** to the compatibility guard, not merely `parsed.d`. Tests
confirm that foreign private wrappers and unknown formats/versions remain
blocked even when the legacy parser accepts their inner account/transaction
shape. An owned supported private wrapper round-trips successfully.

At that stage all **28** ordinary isolated suites and syntax checks passed. This
closed the synthetic real-definition composition check, **not** live integration.
There was still no verified-backup/atomic compatibility-apply adapter, changed default
schema, replaced storage event, guarded live Undo/Reset, or Delete UI wiring.
Those must be integrated coherently before any real tombstone operation; the
legacy importer must not be reused as its own verified-backup apply mechanism.

The subsequent adapter and fresh-origin rehearsal are recorded below. No
financial import or balance change is authorized by that adapter.

## Atomic note-only compatibility apply (2026-10-21; still unwired)

`js/notes-tombstone-compat-apply.js` adds an explicit dependency-injected local
prototype. It does not invoke the legacy importer, render/save, balance
callbacks, network, or cloud writers. The caller supplies an already-open
isolated database, compatibility planner, synchronous owner/sync-off guard,
state/localStorage adapters, and the existing shared lock. No database or schema
is opened/upgraded by module loading.

Evidence binds operation kind (`merge`/`import`), the original full planner
input/envelope, exact current local JSON, expected owned v2 baseline, stable
operation UUID/request time, and strict sync-OFF evidence. The current/local
input must match the full local snapshot, not just the target note. A fresh
ticket and explicit true confirmation are required before any persistent action.

- No-op proposals need no confirmation, backup, checkpoint, or state write.
- Baseline/outbox/persistence must match exactly, with no test/demo/pull/
  tombstone checkpoint. The adapter shares `manual-notes-tombstone-v1` and
  `cap-controlled-notes-test`, so the isolated staging/apply prototypes block
  one another while recovery is pending. Existing live guards remain unwired.
- Before replacing notes, commit `manual-notes-compat-backup:` original full
  evidence/desired JSON plus a `prepared` checkpoint; verify both in a separate
  read transaction and inspect the source again.
- Atomically write only the derived full local state and an `applied`
  checkpoint. The derived state replaces `notes` and advances `_mt`; it retains
  every other field from the current state. Financial candidates in an imported
  file are not consumed. Baseline and outbox are never changed.
- The compatibility adapter **cannot introduce/change/remove tombstones or
  remove an existing active note ID**, even if a pure merge proposal suggests
  newly encountered lifecycle evidence. Such evidence needs independent
  lifecycle verification through the separate deletion flow. Existing sidecar
  evidence is retained verbatim, including serialization order; an absent empty
  sidecar is not added as an implicit schema migration.
- Update memory/localStorage and verify IDB, baseline, backup, queue, guard, and
  persistence before removing only this completed checkpoint. Keep the backup.
  On post-commit failure, explicitly report that the local apply committed;
  preserve applied recovery rather than rolling back or retrying automatically.
- If cleanup committed but its read-back failed, report checkpoint absence
  accurately while retaining the backup. A read-only inspector never performs
  cleanup or claims cloud verification.

Methods are `preview`, `apply`, `inspectRecovery`, `exportRecovery`, and
`inspectExport`. Private recovery exports contain original source/state data and
must not become diagnostics. The export inspector validates ownership and
derived state but never imports/restores. No restore/purge/cloud API is present.

Verification: **43** isolated fake-IDB adapter checks and **31** real-definition
entrypoint rehearsals. Coverage includes import/merge success, no-op/cancel,
stale source/full-state tickets, owner/sync/persistence drift, existing recovery,
baseline/outbox retention, backup tampering/failure, transaction rollback,
memory/localStorage/read-back/cleanup failures, replay prevention, concurrent
instances, database reopen, private export, and rejection of new lifecycle
evidence. Real-parser composition keeps the original wrapper metadata and
preserves acknowledged tombstones and financial state through the note-only
adapter, without calling legacy apply or financial callbacks.

### Fresh-origin native browser rehearsal

A minimal synthetic page at `http://127.0.0.1:8053/` loaded only the unwired
compatibility and apply modules, with native IndexedDB and Web Locks. It loaded
no real Cap profile, Supabase API, auth/config script, or service worker.
Injected confirmation responses tested cancellation and approval; a native
confirmation dialog or integrated app UI was not exercised.

- Preview ready; cancellation produced no backup/checkpoint/write.
- Approved action: `NOTE-ONLY LOCAL APPLY VERIFIED — BACKUP RETAINED; NO CLOUD
  WRITE`; desired active notes present, stale deleted note not restored.
- Existing tombstone evidence (including serialization), non-note data, and
  baseline unchanged; outbox 0; one verified backup; checkpoint absent; memory/
  localStorage/IDB agreed; network calls 0; no cloud API loaded.
- A first check identified a serialization-only key reorder in retained
  sidecars. The adapter was tightened to leave the original sidecar verbatim;
  the final fresh-origin run verified exact serialization retention.
- Reload/reopen confirmed desired state, baseline, tombstone, and backup
  persisted; outbox 0 and checkpoint absent. No live profile was inspected or
  changed for this rehearsal, and the completed PostgreSQL race run was not repeated.

All **30** ordinary isolated suites and syntax checks pass. No script inclusion,
cached shell resource, app default/schema, storage event, import/undo/reset
entry point, or real saved state changed. A read-only production audit now
records the blocking privilege/role/endpoint findings and a sidecar-first
migration/lockout design in `PRODUCTION_PRIVILEGE_AUDIT.md`; it was not executed
against Supabase. Next is the user decision on sidecar/reader/lockout, then a
separately authorized live read-only audit—not enabling deletion or deploying
the lab SQL. Full production privilege/migration and financial sync gates remain
open.

No user action is needed now. No live import, note deletion, marker cleanup,
baseline reset, or additional cloud write is authorized by these previews.
