# Notes push pipeline: rehearsal status

Implemented and rehearsed; **not enabled for live Supabase writes**.
No action or new SQL installation is required for this step.

## Pipeline

`CapSync.rehearseNotePush(operationId, io)` requires explicit adapters for
authentication, current baseline/outbox, current local note, cloud reads,
readiness verification, the notes CAS call, and atomic local finalization.
There are no default live adapters and no apply button. Calling it without
adapters refuses the operation. Review preferences do not authorize execution.

The core supports one explicitly mapped owned notes upsert at a time. It:

1. Requires a complete note payload and verifies it still matches local state.
2. Runs the guarded three-way comparison; conflicts/deletes are refused.
3. Requires readiness and rechecks local/auth/queue/baseline after preflight.
4. Supplies exact `p_expected`/`p_desired` content to the CAS adapter, or skips
   the write if local and cloud content already converge.
5. Reads cloud content back and checks ownership, identity and full content.
6. Rechecks local/auth/queue/baseline again before calling the finalizer.

A lost/ambiguous RPC response is WRITE OUTCOME UNKNOWN, not “nothing written”.
No baseline/outbox changes follow it. A retry can recognize already-converged
data, verify it afresh and finalize without applying the cloud write twice.

## Atomic local acknowledgement

`CapOff.finalizeVerifiedNotePush(receipt, guard)` is dormant until explicitly
called. Its synchronous guard must verify live local state/ownership. A
Promise-returning guard is rejected rather than accepted as a truthy result.

In one IndexedDB transaction spanning `syncmeta` and `outbox`, it verifies the
exact queued entry and target baseline record, replaces/appends exactly one
baseline record, and removes only that outbox entry. Unrelated records and
queued operations are preserved. Failure aborts both changes. It resolves
only after transaction completion and a separate read-back of both stores.
An acknowledgement retry is idempotent via the exact record/operation marker.

The baseline revision advances once per acknowledged operation. The legacy
aggregate `fingerprint` remains the initialization snapshot and is explicitly
marked `aggregateFingerprintStale`; per-record fingerprints are authoritative.
No global “all synced” status is asserted by acknowledging one note.

Failure distinctions include:

- CLOUD WRITE OCCURRED — VERIFICATION FAILED
- WRITE OUTCOME UNKNOWN — NOTHING FINALIZED
- CONFLICT — NOTHING FINALIZED
- DATA CONVERGED — BASELINE UPDATE FAILED
- LOCAL WRITE OCCURRED — VERIFICATION FAILED

## Verification

- `node tests/notes-push.cjs`: 32 isolated pipeline checks.
- `tests/notes-finalize.cjs`: 18 isolated IndexedDB checks, including rollback
  after baseline put but before queue delete, double acknowledgement,
  unrelated-record preservation, stale receipt rejection and postcommit read
  failure. Requires an external `fake-indexeddb` installation; set
  `CAP_FAKE_IDB_PATH` to its module directory, then run the script with Node.
- Native browser IndexedDB on a disposable origin: injected cleanup failure
  rolled back both changes; the mocked-cloud pipeline then completed with
  exactly one baseline record and one revision, and an empty outbox.
- Existing outbox/readiness/SQL checks remain separate regression suites.

No live Supabase records, main-origin local state, baseline, or outbox were
changed. Still pending: explicit-confirmation live adapters, cross-tab
operation coordination, staging multi-session SQL races, live controlled notes
push, and wiring verified conflict resolution. Cloud Sync remains OFF.
