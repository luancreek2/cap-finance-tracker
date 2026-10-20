# Guarded existing-note pull

Shell `cap-shell-v312`. **One separately authorized live existing-note pull
passed, including post-reload verification in the user's profile.** The user
performed the cloud edit and local confirmation; the agent performed no live
writes. Cloud Sync remains OFF. This is a manual developer-tool workflow, not
background or full production sync. Conflict-protection behavior is simulated
only and documented in `CONFLICT_PROTECTION.md`.

## Flow

Privacy & Sync → developer tools → Plan Outbox (read-only) → **Preview cloud
note pull (read-only)**.

- A pull is offered for exactly one changed existing cloud note, with the local
  note and every other local record still matching the owned version-2 baseline.
  Every unrelated cloud record must also match its baseline.
- The full snapshot must have exact coverage, valid ownership/mappings, and no
  missing, unexpected, or foreign-key errors. Local edits, any pending outbox
  entry, conflicting edits, inserts, deletions, multiple changed notes, or
  unresolved test/demo/pull recovery checkpoints block the action.
- Only array-form notes with stable mapping are supported. Cloud title/body
  must be strings; date may be a valid-shaped date string or null. Unsupported
  null text is blocked rather than silently converted by the local mapper.
- Preview displays action and field names only. No title, body, user/record ID,
  financial value, payload, or raw error is rendered.
- **Pull this cloud note locally (confirm)** requires native consent and the
  same unchanged preview ticket before and after confirmation under the shared
  notes Web Lock. This is a local data/baseline write; preview alone is read-only.

## Apply and persistence

The offline-layer helper constructs the next state itself from the exact
original JSON. It changes only the selected note's title/body/date and advances
the top-level persistence timestamp. Note IDs, other note fields/metadata,
other records, financial collections, preferences, and balance anchors remain
unchanged. It does not call `save()`, recalculate balances, enqueue operations,
or write any Supabase record.

1. Verify the local mapped note fingerprint still equals its baseline and the
   incoming content fingerprint equals the planned acknowledgement. LocalStorage,
   in-memory state, and IndexedDB state must agree before applying.
2. Atomically save a private local backup and `manual-notes-pull-v1` checkpoint.
   Read back and verify both before replacement.
3. Freshly verify the authenticated cloud note read-only. Changed/failed/absent
   cloud reads stop with the original local state and recovery evidence retained.
4. In one IndexedDB transaction, recheck original state, exact baseline and
   checkpoint, empty outbox, no competing recovery, and the synchronous local/
   ownership guard. Commit state and exactly one baseline note acknowledgement
   together, with the checkpoint marked applied. Unrelated baseline rows remain
   byte-for-byte unchanged. A failure between puts rolls back all of them.
5. Update in-memory and localStorage copies without rendering/saving, reset
   change tracking, and read back consistent applied state/baseline/backup.
6. Verify the cloud snapshot again read-only, then remove only the exact active
   pull checkpoint and verify its absence. Retain the backup under its unique
   `manual-notes-pull-backup:` key.

Success: `PULLED — VERIFIED AND FINALIZED; LOCAL BACKUP RETAINED`.

Cloud comparison is point-in-time, not a lock on future remote edits. A remote
edit after the final read will be detected by a subsequent preview; no cloud
record is overwritten by this flow.

## Keep-cloud conflict resolution reuse

Shell v313 reuses the `manual-notes-pull-v1` checkpoint and
`manual-notes-pull-backup:` namespace for the non-destructive **keep-cloud**
resolution of one conflicted note. The same backup, atomic local-note + baseline
update, cloud re-read, and checkpoint cleanup rules apply; the only difference
is that the current local note is allowed to differ from the baseline because
both sides changed. The recovery inspector labels such a checkpoint
`READ-ONLY NOTE-RESOLUTION RECOVERY`. Keeping the browser version (overwriting
the cloud) is not implemented. See `CONFLICT_RESOLUTION.md`.

## Interrupted work

The backup and checkpoint contain private original state/baseline and recovery
snapshots. They stay in IndexedDB, are not diagnostics, and are not covered by
the normal state JSON/CSV export. Do not delete them manually.

On any stopped/ambiguous result, use **Inspect note-pull recovery (read-only)**.
It reports checkpoint phase/ownership, backup verification, outbox count,
original/pulled local and baseline equality, persistence, financial equality,
and whether the cloud still matches the pulled snapshot. It never displays
stored values, applies, rolls back, retries, or deletes anything.

A pre-replacement failure retains original state plus recovery evidence. A
post-commit/localStorage/read-back/cloud-verification failure is explicitly a
local-write failure, not a claim that nothing happened. LocalStorage cannot
join the IndexedDB transaction; the checkpoint is the durable evidence for
partial persistence. Do not assume reload alone finalizes recovery.

Manual queue/push, note acknowledgement, controlled marker testing, demo
refresh, and existing scoped cleanup helpers refuse a pending pull checkpoint.
The blocker diagnostic now lists the manual pull checkpoint separately. There
is deliberately **no automatic recovery, rollback, cleanup, or retry**.

## Verification

- `node tests/notes-pull.cjs`: 42 pure pull planning/confirmation checks.
- `node tests/notes-pull-idb.cjs`: 50 UI/real-helper/atomic IndexedDB checks with
  fake-indexeddb and mocked cloud GETs only. Includes backup-first verification,
  exact application, unchanged unrelated data, reload persistence, cancellation,
  changed evidence, conflicting edits, auth/read failures, rollback between
  state and baseline puts, localStorage/in-memory partial failures, post-apply
  cloud races, retained recovery, and redacted read-only inspection.
- External test dependencies use the same `CAP_FAKE_IDB_PATH` arrangement as
  the existing suites. No runtime dependencies or SQL changes are needed.
- Native disposable-browser rehearsal used a 43-record fixture and a mocked
  cloud: light-theme cancellation left no checkpoint; confirmed light/dark
  pulls updated body then title/date, retained two backups, left the outbox
  empty and checkpoint absent, preserved all financial and unrelated baseline
  records, and made zero mutation calls. Note content, financial data, baseline,
  backups, and clean queue/checkpoint state survived a real reload. Preview and
  result diagnostics were redacted; Cloud Sync remained OFF. The updated module
  was present in the v311 shell cache.
- All 20 isolated `.cjs` suites and JavaScript/JSON syntax checks pass. Conflict
  behavior has its own 13-check pure suite and six additional IndexedDB cases;
  see `CONFLICT_PROTECTION.md`.

## First live pull trial (passed)

Following separate authorization, the user appended a non-sensitive line to
one existing cloud note body, leaving the local note unchanged. The read-only
preview reported one existing-note PULL, body only. The user confirmed local
application, which returned `PULLED — VERIFIED AND FINALIZED; LOCAL BACKUP
RETAINED`.

A subsequent plan attempt reported unverified cloud authentication and was
blocked without applying/removing operations. After an online reload, the user
confirmed the added line persisted locally and provided the blocker result:
baseline/current 46, owned version 2, outbox 0, marker-test/demo-refresh/manual-
pull checkpoints absent, and zero missing, unexpected, mismatches, foreign
keys, without-baseline, baseline-only, or baseline-content differences. Cloud
Sync remained OFF. No pull retry or recovery cleanup was needed. The retained
local backup should remain intact.

This closes the one-existing-note pull trial only. It does not authorize
additional writes, conflict resolution, or production/background sync.
