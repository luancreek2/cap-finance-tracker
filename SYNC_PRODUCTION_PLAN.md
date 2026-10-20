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
change, or checkpoint cleanup is authorized yet.

**Diagnosis of the stopped restoration check (2026-10-20).** The final local
comparison used raw `S.notes` JSON. `save()` stamps changed local note objects
with `_u` sync metadata; restoring the note body leaves that timestamp changed.
Cloud/local note content, the baseline note record, financial snapshot, outbox,
and persisted state were all clean. The controlled test now compares note
content with `_u`/`_mt` stripped, and the recovery inspector reports
sync-metadata-only drift separately from content changes. The existing
checkpoint still requires read-only confirmation before any checkpoint-only
cleanup; no retry, reset, baseline change, or cleanup is authorized yet.

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
storage writes occurred. Interactive conflict resolution remains unimplemented.

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
- Divergence opens a resolution prompt with the differing fields only,
  keep local / keep cloud.
- Resolutions are recorded so the same conflict is not re-prompted.

## 4. Deletions

- Local delete: write a tombstone (`deleted_at`) locally, push it.
- Cloud delete: tombstone in cloud; the other device observes it.
- Purge only when both sides agree and the tombstone is older than a retention
  window. Never infer deletion from a failed read.

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
