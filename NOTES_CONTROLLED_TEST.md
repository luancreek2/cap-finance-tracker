# Controlled demo notes test

Built and rehearsed. The first live attempt on 2026-10-20 stopped at final
restoration verification. Recovery is **read-only pending inspection**; do not
rerun the test until the checkpoint is resolved. This is an explicit exception
for a confirmed demo test, not production sync. No additional SQL installation
is required after the notes RPC setup.

## Run only when ready for real writes

1. Reload the app to pick up shell v308 (two reloads may be needed).
2. Open Privacy & Sync → developer tools → **Plan Outbox (read-only)**.
3. Confirm **Inspect notes-test blocker (read-only)** reports a clean baseline,
   zero pending outbox entries, and no recovery checkpoint.
4. Click **Controlled demo notes test (real writes)**.
5. Read the native confirmation and confirm only for demo/test data. Keep
   other app tabs idle; do not edit the note, navigate away, or reload mid-test.
6. Send the resulting status. Expected:
   `PASS — NOTE RESTORED; BOTH PUSHES VERIFIED`.

The initial preflight is read-only. Canceling before confirmation changes no
app data, outbox entries, baseline, or recovery metadata. The test refuses an
unclean baseline, pending outbox, unverifiable metadata, mismatched persisted
local state, an existing recovery checkpoint, or an unavailable Web Lock.

## Exactly what the confirmation authorizes

- Choose one existing, baseline-mapped note from a fully synchronized demo set.
- Store a local recovery checkpoint in `syncmeta` under
  `controlled-notes-test-v1` (original note/local representation and comparison
  data). This is not exported or synced as app data.
- Append a fixed test marker to the note body, queue one exact operation, and
  call only `cap_sync_note_put` through the guarded notes pipeline.
- Verify cloud content; atomically acknowledge one baseline record and remove
  that outbox entry.
- Restore the original body with a second queued CAS operation and verified
  atomic acknowledgement.
- Verify the original note representation/content, unrelated baseline records,
  financial state and empty outbox, then remove the recovery checkpoint.

There are normally two cloud note writes and two local acknowledgements.
There are no inserts/deletes, balance writes, financial-table mutations,
background processing, or automatic retry. Cloud Sync remains OFF. Normal
production execution and conflict-review preferences remain locked/separate.

The test holds a native Web Lock across preflight, confirmation and both
operations, rejects stale localStorage snapshots, and rechecks ownership,
checkpoint identity and local state before writes. This coordinates other
controlled tests, not arbitrary older app tabs/editors: keep those idle. General
multi-tab coordination and true multi-session server race tests remain pending.

## If it stops or the tab closes

For a preflight block, use **Inspect notes-test blocker (read-only)** in the
same Plan Outbox panel and send the resulting diagnostic. It includes *all*
queued entries, including artifacts excluded from the usual plan, plus dynamic
local/cloud/baseline counts. The exact older account harness is recognized only
when its entity, operation, identities, ownership, name and legacy marker all
match. Eligible-for-cleanup means review evidence only: it never deletes an
entry or grants cleanup permission. Failed cloud reads never prove absence.

Storage is scoped to origin **and browser profile**. `?dev=1` does not change
the origin, but two profiles can have different baselines/outboxes at the same
localhost URL. A 44-record baseline is not inherently invalid just because a
different profile has 46 records; diagnose against the current plan, never
reset or hard-code the expected count to force a match.

### Interrupted controlled-test recovery

If the controlled test stops after its checkpoint was created, use
**Inspect notes-test recovery (read-only)** in the same Plan Outbox panel. It
reads the checkpoint, outbox, cloud note, local note, baseline record, unrelated
baseline records, financial snapshot, persisted local state, and sync mode. It
never writes, retries, clears, deletes, or displays note content, financial
values, or identifiers.

Typical classifications:

- `PENDING OPERATION REMAINS — DO NOT RETRY`
- `CLOUD STILL TEMPORARY — RESTORE NOT APPLIED`
- `CLOUD NOTE ABSENT — RESTORE NOT PROVEN`
- `CLOUD RESTORED — LOCAL NOTE DIFFERS`
- `CLOUD RESTORED — LOCAL SNAPSHOT FORMAT DIFFERS`
- `CLOUD RESTORED — FINANCIAL SNAPSHOT DIFFERS`
- `CLOUD RESTORED — BASELINE RECORD DIFFERS`
- `CLOUD RESTORED — PERSISTED LOCAL STATE DIFFERS`
- `CONVERGED — NOTE/BASELINE/LOCAL/OUTBOX RESTORED; CHECKPOINT REMAINS`
- `CONVERGED — NOTE/BASELINE/LOCAL/OUTBOX RESTORED; PREFLIGHT BASELINE NOT STORED; CHECKPOINT REMAINS`
- `CONVERGED — NOTE/BASELINE/CLOUD RESTORED; LOCAL SYNC METADATA ONLY; CHECKPOINT REMAINS`
- `CONVERGED — NOTE/BASELINE/CLOUD RESTORED; LOCAL SYNC METADATA ONLY; PREFLIGHT BASELINE NOT STORED; CHECKPOINT REMAINS`
- `BLOCKED — CLOUD STATE NOT PROVEN`

`Local note snapshot: differs (sync metadata only: _u)` means the app’s change
tracker updated the note’s sync timestamp, not its title, body, or date.
`Local note: matches original` and `Cloud note: matches original` remain the
authoritative content checks. A content difference instead reports changed,
added, or removed notes and the safe field names (`t`, `b`, `d`, and so on),
never the values.

Checkpoints created before the recovery inspector do not contain the preflight
baseline snapshot. For those, the inspector still checks the baseline note
record directly, but reports unrelated baseline records as **not stored in
checkpoint** and uses the limited-evidence convergence status. Follow it with
**Inspect notes-test blocker (read-only)** to verify the full baseline/cloud
counts and differences. Do not delete the checkpoint or change the baseline
even for a `CONVERGED` result until both diagnostics have been reviewed. A
blocked cloud read is never proof that the cloud note is absent or restored.
Reloading for inspection is safe because the checkpoint is persisted, but do
not click the controlled test again.

### Verified recovery finalization

When the inspector reports any `CONVERGED` status — exact, sync-metadata-only,
or limited evidence — it offers **Finalize verified recovery (confirm)**. This
is the only supported checkpoint cleanup. It never retries the controlled test,
changes a note, clears the outbox, changes the baseline, or calls a cloud
mutation.

Before prompting, it rechecks read-only:

- the owned recovery checkpoint is present;
- the outbox is empty and no demo-refresh checkpoint exists;
- the cloud note and local note match the checkpoint's original content;
- the financial snapshot is unchanged and persisted local state is current;
- the baseline note record matches the original;
- Cloud Sync is OFF;
- the recovery classification is `CONVERGED`;
- the full blocker validation has baseline version 2, current records equal to
  baseline records, and zero missing, unexpected, mismatched, foreign-key,
  unaccounted, or baseline-content differences.

After a native confirmation, one IndexedDB transaction rechecks the exact
baseline, checkpoint, absence of a demo-refresh checkpoint, empty outbox, and a
synchronous local note/financial/state/ownership guard, then deletes **only**
`controlled-notes-test-v1`. A read-back must show the checkpoint absent, the
baseline byte-for-byte unchanged, the outbox empty, and no demo checkpoint. A
post-commit check then re-verifies the local note, cloud note, financial
snapshot, persisted state, and sync mode.

Success is `RECOVERY FINALIZED — CHECKPOINT REMOVED; NOTE/BASELINE/CLOUD
VERIFIED`. Cancellation or any failed precondition retains the checkpoint. A
post-commit verification failure reports `LOCAL WRITE OCCURRED — VERIFICATION
FAILED`; do not retry or reset — run the read-only blocker diagnostic and send
the result. The button is not offered for a content mismatch, added/removed
notes, a pending outbox entry, a blocked cloud read, or an unverified baseline.

Live resolution (2026-10-20): the user's profile completed this finalizer.
Preflight reported 46 baseline/current records, an empty outbox, and clean full
validation; the finalizer removed only the checkpoint. The post-cleanup blocker
reported 46 current records, baseline version 2, ownership verified, both
checkpoints absent, and zero missing, unexpected, mismatches, foreign keys,
without-baseline, baseline-only, or baseline-content differences. Cloud Sync
remained OFF. The controlled test has not been rerun.

### Local-only demo reconciliation

When the diagnostic reports missing, unexpected, or mismatched app records,
**Refresh this browser’s demo (local only)** can rebuild this profile's demo
collections from the authenticated cloud snapshot. It is not production sync
and is never automatic.

- It first reads the cloud snapshot read-only, page by page, until an explicit
  empty page. A repeated or unowned record blocks the preview.
- It reconstructs a local candidate and requires every record's full content
  fingerprint to match the cloud, a valid stable mapping, and a ledger that
  explains every account balance. A count-only match is not enough.
- Nothing is replaced until a native confirmation. Cloud Sync must be OFF, the
  outbox empty, the baseline owned and valid, and no controlled-test or
  refresh checkpoint present.
- A verified on-device backup of local state, baseline, and balance anchors is
  committed first. Local state and the replacement baseline then commit in one
  IndexedDB transaction, followed by read-back verification.
- Old local-only demo records and old balance anchors leave the active dataset
  but remain in the backup. No Supabase row, auth session, or cloud baseline is
  changed.
- Canceling changes nothing. A pre-replacement failure retains the backup and
  leaves local state/baseline intact. A post-replacement verification failure
  reports `LOCAL WRITE OCCURRED — VERIFICATION FAILED` and leaves its recovery
  checkpoint for inspection. There is no automatic retry, rollback, or reset.

After a PASS, reload once, rerun the read-only blocker diagnostic, and continue
only when it reports a clean baseline, zero mismatches, and an empty outbox.
Do not update a baseline by hand.

### Approved, narrowly scoped stale-entry cleanup

After the user authorized removing only the three verified old account-harness
entries, the diagnostic can offer **Remove 3 verified stale test entries
(confirm)**. Reload to shell v308, run the read-only diagnostic, and use that
button only for this approved scope. It verifies all evidence before and after
a native confirmation under the same cross-tab test lock. Exactly three unique
owned harness entries are required; a prefix alone never qualifies a record.

The local helper checks the exact queued snapshots, unchanged owned baseline,
absence of recovery metadata/references, and a synchronous local-absence guard
inside one IndexedDB transaction. It deletes those three outbox keys together
and verifies their absence and the unchanged baseline after commit. It never
uses `clear`, writes the baseline, calls a cloud mutation, or removes app data.
Unrelated queued entries are preserved. A changed/failed absence check blocks
cleanup. A postcommit read-back failure is distinguished from an aborted
transaction rather than asserting nothing was removed.

Send the cleanup result and rerun the read-only diagnostic afterwards. The
separate missing/unexpected/mismatched app records are **not** repaired by this
queue cleanup, and the controlled write test must not be retried yet.

Verification: 13 isolated confirmation/revalidation checks, 17 isolated atomic
IndexedDB checks, and native browser light/dark fixtures covering cancellation,
exact removal, unchanged baseline/app state, and zero cloud mutation requests.
No cleanup was performed in the user's separate browser profile by the agent.

**Do not retry, clear the outbox, reset data, or initialize a new baseline.**
Send the status first. The checkpoint and any pending exact operation must be
inspected read-only to determine local/cloud/baseline convergence. The original
note is retained in the checkpoint until successful restoration is verified.
The UI does not automatically resume or blindly roll back interrupted work.
A failed/ambiguous request can mean a cloud write happened despite a lost
response; the pending entry is intentionally retained for safe recovery.

## Rehearsal evidence

- `node tests/notes-controlled.cjs`: 25 simulated bridge/controller checks,
  including expected local `_u` sync metadata.
  Includes cancellation, changed data during confirmation, stale local state,
  unavailable lock, invalid baselines, pending/recovery blocking, queue/save
  failures, racing cloud edits, lost responses, failed acknowledgement,
  failed restoration, user edits before restore, and checkpoint cleanup errors.
- The actual UI, local note edits, Web Lock and IndexedDB finalizer were
  exercised on a disposable browser origin with a simulated cloud: cancellation
  caused zero mocked writes; confirmed light/dark runs each made two mocked
  writes, restored the original note, and left no queue/checkpoint. No user
  identifiers or note content appeared in diagnostics.
- The verified-recovery finalizer was exercised on a disposable origin with a
  43-record baseline, metadata-only `_u` drift, and a simulated cloud: the
  inspector offered the button and reported metadata-only convergence; native
  cancellation retained the checkpoint; after confirmation it removed only the
  checkpoint, left the baseline and outbox unchanged, preserved the note
  content and `_u`, verified the cloud note, kept Cloud Sync OFF, and made zero
  mutation requests. The next inspector run reported `BLOCKED — NO RECOVERY
  CHECKPOINT` and `Cloud Sync: not checked`.
- `node tests/notes-recovery.cjs` passes 47 pure recovery and notes-snapshot
  checks, including pending operations, temporary cloud content, missing
  updates, evidence gaps, exact/limited convergence, sync-metadata-only drift,
  content changes, added/removed notes, and reordering.
- `node tests/notes-recovery-finalize.cjs` passes 14 pure orchestration checks:
  success, cancellation, not-ready/additional evidence, changed tickets,
  pre/post-commit failures, unverified commits, confirmation/lock failures, and
  concurrent finalization.
- `node tests/notes-recovery-idb.cjs` passes 21 isolated atomic IndexedDB
  checks: exact checkpoint removal, unchanged baseline/outbox/unrelated keys,
  invalid receipts, changed baseline/checkpoint, pending outbox, demo-refresh
  checkpoint, failing guards, rollback, postcommit read failure, and retry
  rejection.
- `node tests/demo-refresh.cjs` and `tests/demo-refresh-idb.cjs` pass 23
  reconstruction/confirmation checks and 15 atomic IndexedDB checks. A native
  disposable-origin run reconstructed 46 records from 44, retained the 44-record
  backup, matched all fingerprints, cleared unresolved checkpoints, survived
  reload, and made zero mutation requests. Cancellation, a repeated pagination
  page, and a changed local/cloud state blocked without replacement.
- Existing suites also pass: 32 pipeline, 18 IndexedDB, 49 outbox, 26 readiness,
  and 41 SQL integration checks. No live write test is implied by rehearsal.
