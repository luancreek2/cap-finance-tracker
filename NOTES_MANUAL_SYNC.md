# Guarded manual notes sync

Milestone: **one user-authorized live manual note edit successfully pushed and
verified after reload**. The user performed the confirmations in their browser;
the agent did not access their profile or perform live writes. Automatic Cloud
Sync remains OFF. This is a developer-only, existing-note UPDATE flow, not
production sync or a financial-record worker.

## Entry point and explicit actions

Reload shell `cap-shell-v310`, then open Privacy & Sync → developer tools →
Plan Outbox (read-only) → **Preview manual note sync (read-only)**.

1. Edit one existing baseline-mapped note in the normal notes editor and finish
   saving locally. Editing still does not automatically queue or push anything.
2. Preview reads the full local/cloud/baseline state. It shows only the action
   and field names, never note titles/bodies, financial values, or identifiers.
3. **Queue this note edit locally (confirm)** requires native consent. It adds
   exactly one outbox entry; it does not change the local note, baseline, or any
   Supabase record. This is a local write and should not be done as a diagnostic.
4. Preview again. The persisted pending operation now offers **Push this queued
   note (real cloud write, confirm)**. This separate confirmation authorizes at
   most one note CAS RPC. There is no automatic restoration: this is the user's
   actual edit, not the marker round-trip test.
5. Cloud verification precedes atomic acknowledgement of only the target
   baseline record and deletion of only its exact outbox entry. Other baseline
   records and local/financial state remain unchanged. Reload and inspect the
   read-only blocker after success.

The queue and push confirmations re-run preview under the same Web Lock used
by controlled tests. Changing evidence invalidates the preview. Opening the
app, editing/saving, reconnecting, and reloading never invoke this flow.

## Guards and limits

- Array-form notes with stable IDs/title/date mapping; no silent legacy-text
  conversion, new-note insertion, deletion, pull, merge, or conflict overwrite.
- One existing note edit at a time. Unrelated local/cloud changes or operations
  block. The baseline is owned version 2; coverage, per-record fingerprints,
  unique mappings, snapshot ownership, and full validation must agree except
  for the selected note's intentional content difference.
- No unresolved controlled-test or demo-refresh recovery checkpoint.
- Empty outbox for queue staging; exactly one tagged manual-note operation for
  pushing. Existing operations are never replaced, coalesced, or cleared.
- Snapshot current local persistence and ownership before/after asynchronous
  checks. There is no `save()` call or financial balance recomputation here.
- An atomic staging helper rechecks baseline/recovery/outbox/local guards and
  uses `add`, never `put`/`clear`, for the new queue entry; read-back proves it.
- A pending operation includes its original cloud note as private recovery
  evidence (`manual_original`) and the desired payload in the existing outbox.
  Both remain on-device and are never rendered in diagnostics or sent to RPC as
  metadata. Existing JSON/CSV state import/export formats are unchanged; do not
  mistake a normal state export for an outbox backup.
- The server CAS compares expected complete content atomically. An intervening
  cloud change returns a conflict rather than overwriting it. A failed read is
  blocked, never treated as verified absence or permission to insert.

## Interrupted work

On conflict, lost response, cloud verification failure, stale local edit, or
acknowledgement failure: stop and inspect; do not reset, clear, or automatically
retry. Pending metadata survives reload. If cloud already equals the queued
edit, a fresh explicit preview and confirmation can acknowledge convergence
without replaying the RPC. If the local note was edited again after queueing,
the stale pending snapshot is retained and blocked for separate review.

No automatic rollback, checkpoint cleanup, queue replacement, or recovery
button is introduced. The controlled-notes recovery inspector is for the
separate marker-test checkpoint, not this pending manual operation.

## Verification

- `node tests/notes-manual.cjs`: 46 pure planning/confirmation checks, including
  conflicts, ownership/mapping errors, unrelated changes, unsupported actions,
  stale preview, cancellation, and no automatic retries.
- `node tests/notes-manual-idb.cjs`: 24 real-adapter UI/atomic IndexedDB checks
  with fake-indexeddb and mocked cloud only. Covers two separate consents,
  queue preservation, reload, CAS races, readiness/checkpoint/read failures,
  acknowledgement guards, lost-response convergence without replay, and
  postcommit staging verification failures.
- Set `CAP_FAKE_IDB_PATH` to an externally installed fake-indexeddb module when
  it is not on the normal Node resolution path. No new runtime dependency.
- Native disposable-origin rehearsal: light-theme preview/cancellation/queue
  made no transport calls; pending work survived reload; dark-theme push used
  one mocked CAS and the real IndexedDB finalizer. The note edit was preserved,
  outbox emptied, unrelated baseline/financial/local state stayed unchanged,
  and the next preview reported local = baseline = cloud. Diagnostics were
  redacted and Cloud Sync stayed OFF. No real Supabase writes occurred.
- The new module was present in `cap-shell-v309` cache. A server-down navigation
  was blocked by the connected-browser proxy before the offline app could load;
  a true DevTools-offline reload remains to be checked locally. This is not
  evidence of an app offline pass or failure.

No live manual push should be requested until this implementation and its
simulated results have been reviewed. A live edit/write requires separate
authorization; Cloud Sync stays OFF before, during, and after it.

The user's no-edit read-only preview passed. The subsequent true offline check
found an auth-session restoration bug, now fixed in shell v310. The user then
verified true DevTools-offline dashboard access and online restoration without
another login; see `OFFLINE_AUTH.md`. Passing the offline check did not itself
authorize queueing or pushing.

## First live manual trial (passed)

After separate authorization, the user edited one existing note body. The
read-only preview reported exactly one existing-note UPDATE and the `body`
field. Native confirmation queued it locally with no cloud write; a second
preview reported the pending note. The user then separately confirmed the real
push, which returned `APPLIED — VERIFIED AND FINALIZED`.

After reload, the user's blocker screenshot reported baseline/current 46,
version 2 with ownership verified, outbox 0, recovery and demo-refresh
checkpoints absent, and zero missing, unexpected, mismatches, foreign keys,
without-baseline, baseline-only, or baseline-content differences. Cloud Sync
remained OFF. The actual edit was retained, not restored as in the marker test.
No further live writes, retries, or production/background sync are authorized
by this completed trial.
