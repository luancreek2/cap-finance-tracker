# Production Sync Plan (proposal)

Status: **not started**. Cloud Sync remains OFF until every item below is done.

Decisions already made:

- **Balance model:** derive balances from transactions (single source of truth).
- **Conflict policy:** prompt per conflict, keep local or keep cloud.
- **Deletions:** tombstone on delete, purge only after both sides agree (see below).

## 1. Balance derivation (highest risk)

Today `bal` is a stored number mutated by `bApply` and by transfers, card
payments, fees, interest, deposits, goal moves, and CSV import
(`js/transactions.js`, `js/cards.js`, `js/app.js`, `js/calendar-popup.js`).
Any missed path drifts permanently.

Phased migration:

1. **Add a pure deriver.** `derivedBalance(accountId)` computes
   `anchor + posted transactions + transfers`, using the same sign rules as
   `bApply` (`credit` accounts invert the sign). Pending transactions are
   excluded until posted.
2. **Opening entries (implemented).** Account creation writes a normal
   transaction marked `opening:true` instead of a hidden field, so
   `balance = Σ entries` holds on every device. Migration inserts one entry per
   account equal to its implied anchor and is idempotent. Opening entries are
   excluded from income/spending aggregates and from card statement cycles.
3. **Report-only check.** Compare stored vs derived for every account and show
   the difference in a read-only diagnostic. No behaviour change.
4. **Fix drift sources.** Any account where stored != derived is investigated
   against statement history before anything is rewritten.
5. **Write-through cache (implemented, on by default).** Every save recomputes
   each complete account's balance from its entries; corrections are recorded
   for the dev report. `cap_derived_balance=0` disables it. Accounts without an
   opening entry are left unchanged. Once stable, reads can move directly to the
   derivation and `bal` can be dropped.

Covered by tests: posting a pending transaction, deleting a transaction,
editing an amount, card payment, account transfer, goal move, deposit, interest
credit, cash-advance/foreign fee, CSV import adjustment.

**Verified 2026-10-20** on disposable origins across 19 write paths (add/edit/
delete transaction, internal and external deposit, card payment and its
deletion, pending then posted, goal move, cash-advance fee, interest credit,
simulated interest, CSV import, JSON merge). Two defects were found and fixed:
`postOk` re-applied the effect already applied at save, and CSV/JSON imports
inserted pending credit rows without applying them, so such rows never reached
the balance.

Resolved: the import option that recorded transactions without moving balances
has been removed. Imports always apply, so the ledger stays authoritative.

**Shadow mode (dev-only, 2026-10-20):** anchors are captured on demand and stored
in `localStorage` under `cap_balance_anchors_v1`, outside `S`, so they are never
synced or exported. `balanceShadowReport()` compares stored against
anchor + effects and lists drift. Verified: five mutations (income, transfer,
card payment, pending then posted) kept drift at 0; an injected +75 was detected
as one drifting account; the capture guard refused to overwrite existing anchors;
anchors and drift survived a reload. Production still needs anchors inside the
synced account record, with an explicit field and mapping.

**Opening entries (verified 2026-10-20):** migration created three entries
(−450, 3880, −9701); every implied anchor became 0, Home stats were unchanged,
a second run created nothing, and five later mutations kept anchors at 0.
Statement cycles and income/spending aggregates exclude the entries.

**Write-through (verified 2026-10-20):** with the flag off, an injected +100
stayed in place; with it on, the same injection was corrected to the ledger
value and recorded. Five mutations produced zero corrections, and the state
survived a reload.

**Default-on flip (verified 2026-10-20):** with no flag set, an injected +100
self-corrected; setting `cap_derived_balance=0` restored the old behaviour.
A CSV import of two posted rows and one pending row moved balances exactly,
left every implied anchor at 0, and recorded zero corrections. The adjustable
import option is gone from the preview.

## 2. Outbox and push/pull worker

**First live existing-note pull trial passed (user screenshots).** The user
separately authorized and made one cloud-only note body edit, reviewed its
read-only PULL preview, and confirmed local application. Result: `PULLED —
VERIFIED AND FINALIZED; LOCAL BACKUP RETAINED`. A subsequent unverified-auth
plan attempt was blocked without changes; after an online reload the added
line persisted and the blocker reported baseline/current 46, owned version 2,
outbox 0, all three recovery checkpoints absent, and all comparison differences
0. Cloud Sync remained OFF. No retry, reset, or backup cleanup was needed.
The live push and pull UPDATE milestones are now verified separately; this
does not enable full production sync or authorize further live changes.

**Guarded existing-note pull implementation.** Shell v311 adds a read-only
cloud-note preview and separately confirmed local apply. The local note must
still equal the owned baseline; unrelated records/queue entries, conflicts,
missing mappings, or recovery checkpoints block it. A verified local backup
precedes atomic IndexedDB state + one-note baseline acknowledgement, followed
by localStorage/in-memory/read-back/cloud-snapshot verification. Partial or
ambiguous application retains a pull recovery checkpoint and backup; a separate
read-only inspector reports safe state comparisons without values. Existing
scoped write/cleanup helpers reject pending pull recovery. There are no cloud
mutations, automatic pulls/retries, financial writes, or SQL changes. Live pull
testing remains separately unauthorized. Details: `NOTES_PULL.md`.

**Simulated conflict protection.** Shell v312 adds field-name-only conflict
reports to both previews and a read-only synthetic self-check. Divergent local
and cloud edits to the same note are blocked before any backup, checkpoint,
outbox change, baseline update, or cloud write; neither version is overwritten.
Identical two-sided content is not mislabelled as a conflict and still requires
separate baseline review. Pending operations and recovery checkpoints take
precedence. Tests cover pull and push conflicts, retained backups, reload
behavior, and the self-check. A separate live keep-cloud resolution trial later
passed; the separately authorized keep-local live trial also passed on
2026-10-21. Merge and automatic resolution remain unimplemented. Details:
`CONFLICT_PROTECTION.md`.

**First live manual note trial passed (user screenshots).** Following the
offline-auth verification and separate authorization, the user previewed one
existing note body edit, confirmed local queueing, previewed the pending note,
and separately confirmed its cloud push. Result: `APPLIED — VERIFIED AND
FINALIZED`. After reload, the blocker reported baseline/current 46, owned
version 2, outbox 0, both recovery checkpoints absent, and zero record,
relationship, coverage, or baseline-content differences. The actual note edit
was retained and Cloud Sync remained OFF. This closes the one-existing-note
manual UPDATE trial, not full production sync; no additional writes are
authorized. Details: `NOTES_MANUAL_SYNC.md`.

**Offline-auth blocker and fix.** The user's first DevTools-offline reload
loaded the cached shell but displayed the cloud login screen. Startup had
discarded the saved session after ambiguous network failures. After online
sign-in, the blocker was still clean: 46 current/baseline records, owned version
2, outbox 0, checkpoints absent, all differences 0, Cloud Sync OFF. The user
authorized the auth fix, not a live manual note write. Shell v310 preserves
cached local access on transient auth failures while requiring fresh online
identity verification for cloud access. It does not change financial state,
baseline, or queue. All 17 isolated suites pass, including 41 new auth checks.
Native simulated-offline/reconnect rehearsal passed on a disposable mock-only
origin. The user's subsequent screenshots confirm a true DevTools-offline
reload kept the dashboard accessible with the local-only notice; online reload
removed the notice without another login. The offline-auth milestone is closed;
live manual note queue/push remains separately unauthorized. Details:
`OFFLINE_AUTH.md`.

**Controlled notes re-test complete (user screenshots).** The fresh authorized
round trip returned `PASS — NOTE RESTORED; BOTH PUSHES VERIFIED`. After reload,
the blocker reported baseline/current 46, owned version 2, outbox 0, both
checkpoints absent, all record/relationship/baseline differences 0, and Cloud
Sync OFF. The marker-test milestone is closed; this does not enable production
sync or authorize another live write.

**Manual existing-note sync implementation.** Shell v309 adds a developer-only
read-only preview, separately confirmed local queue staging, and separately
confirmed one-note CAS push/atomic acknowledgement. No save hooks, background
worker, automatic retries, inserts/deletes, or financial writes are added.
Changed evidence, unrelated records/queue entries, conflicts, stale local state,
or recovery checkpoints fail closed. The existing outbox retains pending work
across reload; a lost-response convergence can be acknowledged without another
RPC, only after fresh explicit confirmation. The agent has not performed live
manual writes or baseline/queue mutations in the user's profile. Details,
limits, and simulated checks: `NOTES_MANUAL_SYNC.md`.

**User-authorized stale outbox cleanup UI (2026-10-20).** The user approved
preparing removal of only the three diagnostically verified old account-test
entries in their separate browser profile. Shell v302 offers an exact-scope
native-confirmation button after the read-only diagnostic. Fresh ownership,
strict harness identity, local/cloud absence, baseline-reference and recovery
checks run before and after confirmation; changing evidence blocks removal.
One IndexedDB transaction deletes the exact three snapshots, preserving the
baseline and all unrelated entries. Read-back verifies both deletion and
baseline immutability. No cloud mutation or app-record deletion is involved.

Verification: 13 controller checks, 17 isolated IndexedDB checks (including
mid-delete rollback and postcommit verification failure), and native browser
light/dark rehearsals with zero cloud mutation requests and unchanged app/
baseline state. The agent did not perform cleanup in the user's browser.
The separate 1 missing / 3 unexpected / 12 mismatch diagnostic is unresolved;
neither baseline reset nor controlled note writes are authorized by cleanup.

**Profile-specific blocker diagnostic (2026-10-20).** A user screenshot showed
44 baseline records and three ignored test artifacts at localhost:8000/?dev=1,
while the connected browser had 46 records and an empty queue. The query flag
does not change origin; stored state must be inspected in the affected browser
profile rather than assuming the connected profile represents it. No artifacts
were deleted and no baseline was reset or regenerated.

The Plan Outbox panel now exposes a read-only notes-test diagnostic covering
all queue entries, ownership, strict recognition of the old account harness,
local/cloud presence, baseline references, recovery metadata, and dynamic
plan/baseline/cloud counts. Cleanup eligibility is evidence, not authorization.
Raw IDs, payload values and API errors are not rendered. Ten isolated checks
pass, including failed absence reads and zero mutation assertions. Shell v301.

**Explicitly confirmed demo bridge (2026-10-20).** The dev-only Plan Outbox
panel can now start a controlled notes round trip. Read-only full validation,
per-record baseline matching, metadata readiness, a cross-tab Web Lock, and a
native confirmation precede any persistent changes. A local recovery checkpoint
then protects two scoped operations: append a marker to one existing demo note,
verify/finalize it, restore its original body, and verify/finalize restoration.
Unrelated baseline/financial state must remain unchanged; the outbox must be
empty before checkpoint cleanup. No blind rollback or automatic retry exists.

Production execution stays locked and Cloud Sync stays OFF. No live user
Supabase write was performed in this implementation step. Rehearsals: 24
simulated bridge checks and actual local UI/Web Lock/IndexedDB tests on a
disposable origin against a simulated cloud, including cancellation and both
themes. Instructions, authorized scope and recovery rules are in
`NOTES_CONTROLLED_TEST.md`. Multi-session PostgreSQL races remain pending.

**First live controlled notes attempt stopped at final restoration verification
(2026-10-20).** After the clean blocker diagnostic (46 records, empty outbox,
zero mismatches), the user confirmed the controlled test. The temporary push
verified, but the final restoration check returned `STOPPED — RESTORATION NOT
VERIFIED`. There was no automatic retry, rollback, reset, or cleanup, and Cloud
Sync remained OFF.

The ordinary data validation can report zero mismatches even when local and
cloud both still contain the temporary marker, so it is not sufficient for
recovery. A dedicated **Inspect notes-test recovery (read-only)** control now
checks the checkpoint phase/ownership, exact pending outbox entry, cloud and
local note equality (reported only as original / temporary marker / different),
local note-snapshot canonical equality, financial collection-level differences,
the target baseline record, unrelated baseline records, persisted local state,
and sync mode. It classifies exact convergence but does not delete the
checkpoint, retry a write, or alter any data. Checkpoints written before this
tool do not contain the preflight baseline, so the inspector compares the
baseline note record directly and reports unrelated baseline records as not
stored, using a limited-evidence convergence status; the blocker diagnostic
must then confirm the full baseline/cloud counts. Forty-seven pure recovery
and notes-snapshot checks cover pending operations, temporary/missing/unknown
cloud states, evidence gaps, full and limited convergence, sync-metadata-only
drift, content changes, added/removed notes, and reordering. A native
disposable-origin rehearsal produced the expected converged, temporary-cloud,
pending-outbox, metadata-only, and content-change diagnostics with no
identifier or content leakage and no mutation request. The user's specific
recovery state remains pending this inspection; no retry, reset, baseline
change, or automatic checkpoint cleanup is authorized.

**Diagnosis of the stopped restoration check (2026-10-20).** The final local
comparison used raw `S.notes` JSON. `save()` stamps changed local note objects
with `_u` sync metadata; restoring the note body leaves that timestamp changed.
Cloud/local note content, the baseline note record, financial snapshot, outbox,
and persisted state were all clean. The controlled test now compares note
content with `_u`/`_mt` stripped, and the recovery inspector reports
sync-metadata-only drift separately from content changes. The existing
checkpoint can now be finalized only through the separately confirmed
checkpoint-only control described below; no retry, reset, baseline change, or
automatic cleanup is authorized.

**Verified recovery finalization (2026-10-20).** The recovery inspector can
offer a button only for a `CONVERGED` recovery status (including limited
evidence). It re-runs the full read-only blocker validation, requires baseline
version 2 with current
records equal to baseline records and zero missing, unexpected, mismatched,
foreign-key, unaccounted, or baseline-content differences, then uses a native
confirmation. One atomic local transaction deletes only
`controlled-notes-test-v1` after rechecking the exact baseline/checkpoint, empty
outbox, absent demo-refresh checkpoint, and a synchronous local
note/financial/state/ownership guard. Read-back verifies the checkpoint is
absent and baseline/outbox unchanged; a post-commit check re-verifies local and
cloud note content, financial snapshot, persisted state, and sync mode. It never
retries, clears the outbox, changes the baseline, or calls a cloud mutation.
Fourteen pure orchestration checks and 21 isolated IndexedDB checks cover
success, cancellation, changed evidence, guard/rollback/read-back failures, and
retry rejection. A native disposable-origin run with 43 records and
metadata-only `_u` drift: cancellation retained the checkpoint; confirmation
removed only the checkpoint, preserved the note, `_u`, baseline, and outbox,
made zero mutation requests, and then reported `BLOCKED — NO RECOVERY
CHECKPOINT`.

**Live recovery resolution (2026-10-20).** The user ran the checkpoint-only
finalizer in their browser profile. Preflight reported baseline 46 records,
current 46, outbox 0, and full validation clean. The finalizer returned
`RECOVERY FINALIZED — CHECKPOINT REMOVED; NOTE/BASELINE/CLOUD VERIFIED`. The
post-cleanup read-only blocker reported baseline 46/version 2/ownership verified,
outbox 0, recovery and demo-refresh checkpoints absent, current 46, and zero
missing, unexpected, mismatches, foreign-key, without-baseline, baseline-only,
or baseline-content differences. Cloud Sync remained OFF. No retry, reset,
baseline change, outbox clear, or cloud mutation occurred.

**Adapter-only notes push/finalization (2026-10-20).** The notes core now
performs guarded preflight, readiness, local/auth/queue/baseline rechecks,
expected-content CAS, fresh cloud verification, and finalization via explicit
adapters only. No live defaults or apply button are wired. Ambiguous RPC
outcomes retain the queue/baseline; converged retries do not reapply the write.

The dormant IndexedDB helper updates exactly one baseline record and removes
the exact outbox entry in a single transaction, preserving unrelated records.
It verifies transaction completion and read-back, rejects stale receipts,
requires a synchronous local guard, and makes acknowledgement retries
idempotent. Per-record fingerprints remain authoritative; the legacy aggregate
fingerprint is marked stale rather than presented as a current global hash.

Verification: 32 isolated pipeline checks, 18 isolated IndexedDB checks, and a
native browser IndexedDB/mock-cloud rehearsal on a disposable origin. An
injected cleanup failure rolled back both stores. No main-origin or live
Supabase state was changed. Details and remaining gates:
`NOTES_PUSH_REHEARSAL.md`.

- Enqueue per changed record: `{entity, localId, op, payloadFingerprint, ts}`.
- Process sequentially; group dependent writes atomically on the server
  (transaction + account delta today; derived balances should remove the need
  for a dependent account write entirely).
- Idempotency: stable `legacy_id` + full-payload comparison; retries must be
  safe (`ALREADY_APPLIED` semantics).
- Backoff with a cap; surface a per-record error state instead of retrying
  forever.
- No processing unless the user has enabled sync.

**Planner (implemented, read-only).** `CapSync.planOutbox(entries, {userId,
readCloud, baseline})` validates ownership and the entity allow-list, coalesces
repeated operations per record (latest write wins, delete supersedes), orders
by dependency, resolves Supabase identities from the baseline, and classifies
each operation as INSERT / UPDATE / DELETE / NOOP / ALREADY_DELETED, or BLOCKED.
A failed cloud read is BLOCKED and is never treated as absence.
`CapSync.processOutbox({dryRun:true})` wraps it with the authenticated user,
skips other users' entries and known test artifacts (both counted), and refuses
any non-dry-run call.

Verified 2026-10-20: coalescing (two writes → one INSERT), dependency ordering,
baseline identity resolution, already-applied detection, ownership rejection,
malformed entries, and a thrown reader (blocked). Wrapper test on a disposable
origin: nothing applied, nothing removed, exactly one cloud read.

**Single-operation execution (implemented, rehearsal only).**
`CapSync.executeOutboxOperation(id, …)` re-plans exactly one entry, refuses
blocked operations, payload-id mismatches, and ownership mismatches, applies it,
reads it back, and removes the outbox entry only after verification. Failure
markers: `CLOUD WRITE OCCURRED — VERIFICATION FAILED`, `WRITE FAILED — NOTHING
VERIFIED`, `DATA CONVERGED — OUTBOX CLEANUP FAILED`. An unreadable result is
never treated as success, and a failed or unverified write leaves the entry
(retry count and last error recorded locally). The baseline is deliberately not
touched in this phase, so a verified push reads as CONVERGED until reconciled.

Verified 2026-10-20 against an in-memory cloud: insert, update, delete,
already-applied, verification mismatch, write failure, planning read failure,
verification read failure, ownership mismatch, payload-id mismatch, and
concurrent double execution. No real cloud request was made.

**First controlled real execution (2026-10-20).** One disposable account
(`phase6-test-outbox-…`) was queued, planned as INSERT, executed, and verified
against Supabase; a queued delete was then executed and verified absent. Both
returned APPLIED — VERIFIED and removed their outbox entries. The outbox was
empty afterwards, no baseline existed on that origin and none was created, and
Cloud Sync remained OFF.

The bulk planner's test-artifact filter matches either the payload `legacy_id`
or the outbox `local_id` prefix, so a test delete is skipped as well (verified
with two test entries skipped and one real entry planned).

## 3. Conflict handling

**Review-only conflict UI (2026-10-20).** A conflicting outbox plan now offers
“Review conflicts (no changes applied)”. Each queued conflict shows its entity,
ordinal and differing top-level field names only, never payload values or
record/user identifiers. Unknown field names are redacted as “other fields”.
Delete-versus-edit choices explicitly label the deleting side. A conflict
without a verified baseline is displayed but cannot be selected.

Keep local / Keep cloud note a page-session preference, NOT a resolution.
Nothing is written to local financial state, cloud, outbox, baseline or
`syncconflicts`. Preferences are held in memory only, bound to the owner and
exact queue/baseline/canonical-cloud snapshot, and revalidated on every click.
Changed data, authentication, failed reads or stale review tokens refuse the
choice. A refresh clears preferences. Reopening the unchanged conflict shows
the preference rather than asking again. The executor never consumes these
preferences and remains locked for production operations.

Verification: the isolated suite passes 49 checks. The actual Privacy & Sync
panel on a disposable origin was checked in light/dark themes: both buttons
rendered, a preference was noted, a simulated subsequent cloud edit made the
other choice stale, no values/identifiers leaked, and no fixture storage writes
occurred. Applying a resolution and durable resolution history remain pending
atomic server checks, verified winning-side writes, and baseline reconciliation.

**Queued-change guard (2026-10-20).** The outbox planner now compares the
queued payload and the fresh cloud record against a verified, owner-matched
version-2 per-record baseline. Cloud-only changes block for PULL; divergent
changes block for CONFLICT. A local delete cannot overwrite a cloud edit, and
an upsert cannot silently recreate a cloud-deleted baseline record. Existing
cloud records without a baseline cannot be overwritten or deleted. Equal
canonical local/cloud content is UNCHANGED or CONVERGED rather than an update.

Invalid baseline identity/ownership/fingerprints and invalid cloud response
shapes fail closed. A failed read reports RECORD ABSENCE NOT PROVEN without
echoing raw API errors. The planner UI reports classifications and counts,
including malformed blocked entries, without payloads or record/user IDs.

Client-side preflight does not eliminate read/write races. The default real
executor is therefore restricted to disposable `phase6-test-` operations;
production operations (including outbox cleanup) are refused until atomic
server-side compare-and-write and baseline reconciliation are implemented.
Injected transports remain available for isolated rehearsals only. No live
cloud writes, baseline writes, or outbox mutations were performed in this step.

Verification: `node tests/sync-outbox.cjs` passes 32 dependency-free isolated
checks covering the three-way matrix, deletions, invalid/missing baselines,
ownership and identity mismatches, invalid/read-failure responses, canonical
key ordering, redacted UI output, execution refusal, and production lockout.
All JavaScript and service-worker syntax checks and manifest/config JSON
parsing pass. The actual Privacy & Sync panel was also exercised on a disposable
origin in light and dark themes with simulated conflicting records: BLOCKED
and CONFLICT rendered, identifiers/payloads remained redacted, and no fixture
storage writes occurred. Guarded note conflict resolution is now a separate
manual flow; this outbox release does not apply it automatically.

**Authorized demo reset (2026-10-20).** The user confirmed that the current
data was demo/test-only and authorized resetting both local and cloud demo
records. An on-device backup was retained under `cap_demo_reset_backup_v1`.
Only the signed-in user's app-record rows were deleted, in dependency order,
and absence was verified per table; the auth identity and profile were kept.
The built-in demo was reseeded locally, three opening entries were created,
and the matching migration plan was uploaded and verified.

A version-2 baseline was initialized only after two clean validations and
matching per-record fingerprints. After reload: 46 local/baseline/cloud
records, zero missing/unexpected/mismatched records, zero foreign-key errors,
zero unaccounted balances, empty outbox, and Cloud Sync OFF. A redacted result
was rendered in the actual Privacy & Sync panel. No production execution or
conflict-resolution readiness is implied by this demo baseline.

**Profile-local demo reconciliation (2026-10-20).** A second browser profile
still held older demo data (44-record baseline; 1 missing, 3 unexpected, 12
mismatched records). The dev-only Plan Outbox panel now offers **Refresh this
browser’s demo (local only)**. It reads the authenticated cloud snapshot
read-only page by page to an explicit empty page, rejects repeated/unowned
records, reconstructs a candidate, and requires full per-record content
fingerprints plus a ledger that explains every balance before offering
confirmation. A count-only match is insufficient.

On confirmation it commits a verified on-device backup first, then replaces
local state and the version-2 baseline in one IndexedDB transaction and verifies
read-back. Old local-only demo records and balance anchors leave the active
dataset but remain in the backup. No Supabase row, auth session, or cloud
baseline is changed, and Cloud Sync stays OFF. Cancellation changes nothing. A
pre-replacement failure retains the backup and leaves local/baseline state
intact; a post-replacement verification failure is reported as `LOCAL WRITE
OCCURRED — VERIFICATION FAILED` with a recovery checkpoint for inspection. No
automatic retry, rollback, or baseline reset exists.

Verification so far: 23 reconstruction/confirmation checks and 15 atomic
IndexedDB checks, plus a native disposable-origin rehearsal that reconstructed
46 records from 44, retained the 44-record backup, matched every fingerprint,
survived reload, and made zero cloud mutation requests. Cancellation, a
simulated server that ignored pagination offsets, and changed local/cloud state
all blocked without replacement. This has **not** been run in the user's
separate browser profile; that step still requires explicit approval. A PASS
does not update the cloud or authorize the controlled notes test by itself.

- Three-way compare against the baseline (already implemented).
- A divergent note opens a **read-only on-device comparison** of the local and
  cloud versions. **Keep cloud** is implemented in shell v313: it saves a
  verified backup, replaces only that local note and its baseline
  acknowledgement, and makes no Supabase write.
- **Keep local** is implemented in shell v314: after a verified backup and
  explicit destructive confirmation, it performs one exact CAS write to the
  reviewed cloud note, then acknowledges only that note in the baseline. It
  does not replace the local note, touch the outbox, or change financial data.
  Its separately authorized live trial passed on 2026-10-21. Further cloud
  writes require new explicit authorization.
- Resolution checkpoints and backups are retained until separately reviewed;
  there is no automatic merge or re-prompt suppression yet. See
  `CONFLICT_RESOLUTION.md`.

**First live keep-cloud conflict trial passed (2026-10-20).** With Cloud Sync
OFF and separate authorization, one existing baseline-mapped note was edited in
Supabase through the notes CAS RPC and locally in the real signed-in profile.
The pull preview reported `CONFLICT` with only `body` differing; the review
showed both on-device versions with keep-local disabled; keep-cloud returned
`RESOLVED — CLOUD VERSION KEPT; LOCAL BACKUP RETAINED`. The post-resolution pull
preview reported local, baseline, and cloud agreement; the blocker reported 46
baseline/current records, version 2, outbox 0, absent recovery/demo-refresh/
manual-note-pull checkpoints, and all comparison difference categories 0, with
Cloud Sync OFF. A read-only cloud recheck confirmed the cloud marker remained
and the local marker was not present, so resolution made no second Supabase
write. The cloud marker remains by user approval; no restoration was
authorized. That trial covered keep-cloud only; keep-local was implemented
later in v314 and a live keep-local overwrite still requires separate explicit
authorization. Details: `CONFLICT_RESOLUTION.md`.

**Keep-local isolated milestone (2026-10-21).** The v314 backup-first CAS flow
passes 29 planning/confirmation checks and 39 UI/atomic IndexedDB checks. Its
retained backup now includes the losing cloud snapshot, not just local state
and baseline. A disposable-browser rehearsal with synthetic inputs and mocked
transport passed cancellation, successful overwrite, baseline acknowledgement,
backup retention, light/dark rendering, and reload persistence. Mode remained
OFF, outbox 0, checkpoint absent after success. No live overwrite or marker
cleanup was performed; separate authorization is still required.
The proposed live checklist in `CONFLICT_RESOLUTION.md` separates any cloud
conflict-setup edit from the actual overwrite: the last converged real profile
would require two separately authorized cloud mutation calls for a new trial,
not one. Lost-response, already-applied, post-CAS read failure, checkpoint-staging
failure, and cleanup-failure paths are now isolated-test covered without retries.

**Authorized keep-local setup only (2026-10-21).** After a clean 46-record
real-profile read-only preflight and five passing self-check lines, the user
authorized one cloud setup edit. A verified on-device original-cloud backup
preceded one CAS call, which returned `APPLIED`; an owned-row read verified the
appended generic setup marker with original content, prior marker, title, and
date preserved. Mode stayed OFF. The authenticated automation profile has no
baseline and none was initialized; no local note, financial record, baseline,
or outbox changed. The user-driven local edit and read-only conflict preview
are next. The actual keep-local overwrite is **not yet authorized or executed**.

**Keep-local live trial passed (2026-10-21).** The local
edit changed `body` and the automatically stamped `note_date`. After reviewing
both fields and separately authorizing their overwrite, the user confirmed
keep-local in their normal browser; the screenshot reported `RESOLVED — LOCAL
VERSION KEPT; CLOUD OVERWRITTEN; LOCAL BACKUP RETAINED`, mode OFF. A read-only
cloud recheck verified one owned row, unchanged title, reviewed local date,
original content/prior marker preserved, local marker present, and temporary
cloud setup marker absent. No verification mutation was sent. Following the
requested reload/check steps, the user's normal-browser screenshots confirmed
local/baseline/cloud agreement and a clean blocker: baseline/current 46, owned
v2 baseline, outbox 0, all test/demo/manual-pull checkpoints absent, and every
comparison difference category 0; Cloud Sync OFF. The successful resolution
status reports the backup retained. No further write, marker cleanup, reset,
or restoration is authorized. Deletions/tombstones are the next design milestone,
followed by financial-record sync, server/race hardening, and controlled rollout.

## 4. Deletions

**Notes-only lifecycle design (2026-10-21; design only).** See
`NOTES_TOMBSTONES.md`. No deletion executor, SQL deployment, schema migration, or
live deletion has been performed. Cloud Sync remains OFF.

- Current queued `delete` transport physically deletes rows; it is not a
  durable tombstone implementation and must not be reused by the new pilot.
- Local deletion needs explicit retained owner-bound intent and a verified
  backup, not inference from absence. Cloud deletion needs a retained row,
  explicit lifecycle state, and server revision/CAS evidence.
- New lifecycle fields require versioned readers/writers and explicit note
  content projection to preserve existing v2 fingerprints. No baseline reset.
- Delete-versus-edit conflicts preserve both versions and require review;
  timestamps, absent rows, failed reads, and import omissions never resolve them.
- Direct table-writer bypass protection and real two-session staging races are
  deployment gates, not assumed properties of the existing RPC or own-row RLS.
- No purge: both present tabs agreeing is insufficient for offline devices or
  old backups. Retain evidence until device acknowledgement/resurrection
  barriers and a retention policy are separately implemented and reviewed.
- The pure unwired planner is now implemented (see below), followed next by
  local backup/recovery, server design, and disposable rehearsals. Any
  live SQL installation or tombstone write needs separate explicit approval.

**Pure tombstone planner (2026-10-21; isolated only).**
`js/notes-tombstone-plan.js` and `tests/notes-tombstone-plan.cjs` implement the
read-only matrix with 105 passing synthetic checks. Missing/unreadable evidence
does not imply deletion; owner/mapping/content/revision/capability drift fails
closed. Preview tickets bind detached evidence and never authorize execution.
There is no transport, storage adapter, UI, app boot hook, schema migration,
restoration, purge, or cloud write. The module is not loaded by HTML or cached
in the shell; existing v314 behavior is unchanged. Tests explicitly forbid
storage/network/DOM/timer access. The new suite brings the isolated suite count
to 23 at that step. Server lifecycle support and app integration remain pending.

**Isolated local tombstone staging (2026-10-21).**
`js/notes-tombstone-local.js` adds an unwired dependency-injected prototype, with
37 passing fake-IDB tests. It verifies a full original local/cloud backup before
atomically staging one local deletion intent and its recovery checkpoint.
Baseline/outbox/financial data remain unchanged; no cloud transport is present.
Recovery distinguishes prepared versus committed stages and never claims cloud
verification. Database reopen and private recovery export validation pass;
existing app merge/import compatibility is not claimed. There is no real
database adapter, Delete UI wiring, schema/default change, restore/purge API,
or live deletion. All 24 isolated suites and syntax checks pass. The subsequent
remote-apply extension is recorded below; server lifecycle and integration gates
still block live use.

**Isolated remote tombstone apply (2026-10-21).** The unwired local factory now
offers a separately ticketed/confirmed remote-apply path. It verifies a retained
original snapshot before atomically removing one synthetic local note,
retaining remote-origin deletion evidence, acknowledging one baseline record,
and writing an applied checkpoint. Exact post-apply cloud reads and local
read-back precede checkpoint cleanup; backups remain. Failed reads/divergence,
atomic rollback, cleanup failure, replay, database reopen, and stale evidence
are covered. No cloud writer exists. The combined persistence suite now passes
59 checks, and the pure planner passes 105. Checkpoint/backup prototype version
2 rejects prior bundles without changing them. No app, database schema, SQL
deployment, Delete UI, or automatic sync integration changed. Next is the server
lifecycle/bypass-protection contract and isolated SQL testing; live use remains
blocked pending those and merge/import/integration gates.

**Isolated lifecycle SQL lab (2026-10-21).** A separate-schema SQL draft and
70-check PGlite suite now cover a least-privilege SECURITY DEFINER writer,
forced owner RLS, denied direct writes/role escalation, strict content/lifecycle
CAS, private operation receipts, idempotence, ABA rejection, and trigger rollback.
The lab does not migrate public notes or change deployed RPCs; its verifier
always returns production readiness false. All 25 isolated suites pass. This
does not prove concurrent PostgreSQL/Supabase safety. Next are two-session
disposable race tests and an existing-privilege/writer/migration audit before
any proposed live deployment. Details: `NOTES_LIFECYCLE_SERVER.md`.

**Two-session race harness prepared (2026-10-21; NOT RUN).**
`tests/manual/notes-lifecycle-races.cjs` requires a fresh dedicated literal-
loopback PostgreSQL cluster/database and explicit test acknowledgement. It
checks independent backend IDs and real `pg_blocking_pids` contention for
edit/delete, retry, rollback, cross-note receipt collisions, and repeatable-read/
serializable failures, plus denied direct writes during a lock. No destructive
cleanup or app/Supabase URL is accepted. Its 21 target/static guard tests pass;
all 26 ordinary isolated suites pass. Actual races are blocked by the absence
of PostgreSQL/Docker/Podman in this environment. They have not been replaced by
PGlite simulation or counted as passed. Progress remains approximately 85%; the
next actual run requires a fresh disposable local runtime, not a live database.
Details and remaining gates: `NOTES_LIFECYCLE_RACES.md`.

**Real disposable PostgreSQL races passed (2026-10-21).** The user installed
Docker Desktop and explicitly authorized one loopback-only PostgreSQL container.
The harness then passed once on PostgreSQL 16.15: 10 checks, three independent
backends, and eight observed `pg_blocking_pids` waits covering all planned
contention cases, plus concurrent direct-write denial. Production readiness
remained false. The same healthy container was retained for inspection; data
is tmpfs-only, with no host/app-data mount. No Supabase, app-state, baseline,
outbox, or real financial data changed. A setup interruption was inspected and
resumed without recreating the container or repeating completed work. The
runtime blocker is resolved; next are lifecycle-safe client integration,
merge/import/export compatibility, and the production privilege/migration audit.
Overall progress remains approximate (85–88%); no rollout/live deletion is authorized.

**Pure tombstone compatibility guards (2026-10-21; unwired).**
`js/notes-tombstone-compat.js` and its 73-check suite cover owner-bound sidecar
validation, three-way note proposals, old JSON merge/replace/undo, private export
round trips, CSV separation, stale tickets, and retention of omitted evidence.
Edited/ambiguous restored content and divergent lifecycle evidence require
review instead of timestamps deciding. Candidates contain note fields only;
financial importer/balance semantics are not modified or authorized. All 27
ordinary suites and syntax checks pass. No live app entry point, schema default,
state merge/import/undo, or cloud transport was wired. Next is disposable
composition with the existing app entry points plus verified atomic local apply,
then the production privilege/migration audit. See `NOTES_TOMBSTONE_COMPAT.md`.

**Real-definition compatibility rehearsals (2026-10-21; synthetic only).**
The new 28-check `tests/notes-tombstone-entrypoints.cjs` loads actual normalizer,
merge, export, JSON/CSV parser, Replace, and Undo definitions into isolated VMs
with fake storage. Local/remote tombstone outputs survive real export/parser
round trips. Regression cases expose raw Replace/Undo evidence loss, swallowed
backup failure, and generic merge timestamp/conflict problems. Guarded previews
block or retain evidence without applying state or balances. A critical wrapper
gate is tested: pass the original backup envelope to lifecycle validation,
because the legacy parser strips owner/version metadata. All 28 ordinary
isolated suites pass. Live entry points remain unchanged; next is a verified-
backup atomic note-only apply adapter and fresh-origin rehearsal, not a financial
import or live tombstone operation. Localhost:8000 was restored separately as a
loopback-only static server; Cloud Sync remains OFF.

**Atomic compatibility note-only apply (2026-10-21; unwired).** The new
`js/notes-tombstone-compat-apply.js` verifies original full state, owned baseline,
source envelope, empty queue/recovery, fresh ticket, and explicit confirmation.
A verified backup precedes the atomic local note-state/applied-checkpoint
transaction; all non-note state (including tombstone evidence), baseline, and
outbox remain unchanged. It cannot introduce lifecycle evidence or remove
current active note IDs, consume imported financial changes, restore/purge, or
call a cloud writer. Its 43 fake-IDB checks and the expanded 31 real-definition
entrypoint rehearsals pass. A native IndexedDB/Web Locks rehearsal on a fresh
synthetic origin passed cancellation, apply, backup retention, cleanup, exact
sidecar retention, and reopen persistence. All 29 ordinary suites pass. Actual
app script/default/schema/import/undo/reset/storage wiring is still unchanged;
next is coherent guarding and disposable UI integration, followed by production
privilege/migration review. No real state or Supabase was changed.

**Static production privilege/migration audit (2026-10-21; no live run).**
`PRODUCTION_PRIVILEGE_AUDIT.md` and the read-only
`tests/sql/production-privilege-audit.sql` record the repository-derived
deployed posture: `authenticated` has direct table and possible column-level
`INSERT`/`UPDATE`/`DELETE` on `public.notes`; the policy is permissive `FOR ALL`;
RLS is not forced; the legacy content-only CAS/verifier remains executable; test
transaction RPCs may remain; and default privileges, memberships, definer
endpoints, extensions, and PostgREST exposure are not attested. These are
blocking facts for a tombstone boundary, not cosmetic hardening.

The design recommends a private lifecycle sidecar with content-only
`public.notes`, explicit RPC-only reads, a non-login forced-RLS writer role,
private operation ledger, and server-side old-client lockout by revoking all
direct note privileges and retiring the legacy writer/verifier. Adding lifecycle
columns to `public.notes` is the fallback only after every client projects
explicit fields and old clients are locked out, because `select=*` would change
v2 fingerprints and expose tombstone state. The audit SQL is read-only; its
8-check PGlite harness passes and deliberately never claims production
readiness. No live Supabase connection, grant, policy, SQL, sidecar, or
migration was executed. At that stage all 30 ordinary isolated suites passed. Next is a user
decision on sidecar/reader/lockout and one separately authorized live read-only
audit. Overall progress remains approximate (85–88%).

**Private sidecar contract lab (2026-10-21; no live run).**
`tests/sql/notes-sidecar-lab.sql` and `tests/notes-sidecar-sql.cjs` now implement
and exercise the recommended production shape in disposable PGlite: content-only
`public.notes`, private `cap_notes_private.note_lifecycle`/`operations` with
forced RLS, a dedicated non-login writer owner, RPC-only reader/writer/verifier
endpoints, and no client table/schema access. The 83 checks cover exact backfill,
a cutover that revokes direct note grants and drops both legacy RPCs, old-client
denial, new edit/tombstone CAS and retry binding, direct/column/schema/`SET ROLE`
bypass denial, metadata drift, restored-legacy-RPC blocking, a tombstone-aware
rollback guard, and reinstall without resetting evidence. A separate 5-check
rollback rehearsal covers the clean-abort path after cutover but before any
tombstone, restoring the old policy/grants/RPCs and verifying old CAS again.
Both always report `production_ready: false`. No live SQL, grant, policy, sidecar,
or migration was executed. All 32 ordinary isolated suites pass. The user
decisions on sidecar/reader/lockout and a separately authorized live read-only
audit are still required before any live action. Overall progress remains
approximate (88–90%).

## 5. Server side

**Live notes metadata verification (2026-10-20).** After the user manually ran
the SQL script successfully, the authenticated app invoked only
`cap_verify_notes_rpc` via the actual readiness button. All metadata gates
passed (`ready: true`) and the result rendered in Privacy & Sync. Cloud Sync
remained OFF and the outbox remained empty. The mutation RPC was not called;
no app records, baseline, or outbox entries were changed. Installation and
metadata readiness do not imply production enablement or a live write test.

**Notes-only atomic RPC draft (2026-10-20).**
`supabase_production_notes_rpc.sql` defines an authenticated SECURITY INVOKER
notes compare-and-swap writer and a metadata-only readiness verifier. The
writer checks expected content under advisory/row locks, handles idempotent
retries and insert collisions without overwriting, rejects stale updates to
missing rows, and rolls back if read-back differs. No financial tables or
deletes are supported. Identity/ownership is not accepted in content snapshots.

The verifier never invokes the writer or reads notes. The new client readiness
method and Plan Outbox readiness button call only the verifier; production
execution remains locked regardless of metadata success. No SQL was installed
in Supabase and no live app records or baseline were changed in this step.
Manual installation instructions and remaining gates are in
`NOTES_RPC_SETUP.md`. Local verification: 41 PostgreSQL-WASM integration checks,
26 readiness-contract checks, the existing 49 outbox checks, and light/dark
readiness UI checks. True multi-session races and live Supabase behavior remain
unverified. Client CAS transport and per-operation baseline updates are pending.

- Replace `cap_test_transaction_create` with production RPCs (SECURITY INVOKER,
  ownership checks, advisory locks on the record UUID).
- Review RLS per table with an explicit matrix (select/insert/update/delete,
  own rows only). Verify no table is readable across users.
- Retire test objects once the harness is no longer needed
  (`supabase_phase6k7_remove_test_rpcs.sql`).

## 6. Enablement and rollout

- Explicit user toggle, default OFF, with a clear description.
- First enable runs a dry run and requires zero differences before pushing.
- Background sync via the existing service worker sync event.
- Kill switch: disabling sync stops the worker without touching data.
- Back up (JSON export) before the first real sync.

## 7. Testing

- Reuse the controlled harness against the production code path in dry-run mode.
- Multi-device test: two browsers, same account, one record each direction.
- Failure drills: offline mid-push, RLS denial, expired token, conflict, delete.
- Offline shell and light/dark checks after each shell change.

## Open items

- Statement history semantics under derived balances (opening/closing values
  are currently stored, not computed).
- Credit-account "owed" display vs. derived sign convention.
- Retention window for tombstones.
- Whether `accounts.balance` is dropped or kept as a cache long term.
