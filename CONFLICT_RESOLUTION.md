# Manual conflict resolution — keep cloud

Shell `cap-shell-v313`. This phase adds the **non-destructive half** of note
conflict resolution: when one existing baseline-mapped note changed in both the
browser and Supabase, the user can review both versions and explicitly **keep
the cloud version**. The browser version is backed up first.

Keeping the browser version would overwrite the cloud note. That destructive
direction is **not implemented**; its button is disabled. There is still no
merge, automatic resolution, background sync, tombstone, or financial-record
change. Cloud Sync remains OFF before, during, and after the flow.

## Scope

Supported:

- exactly one existing note that is mapped by the verified v2 baseline;
- array-form local notes with a stable `title`, `body`, and `note_date`;
- local and cloud both changed after the same baseline, with **different**
  content;
- Cloud Sync OFF, fresh verified online identity, current local persistence,
  no outbox entry, no other recovery checkpoint, and complete cloud coverage.

Blocked before any write:

- zero conflicts, one-sided changes, or local/cloud already equal;
- more than one changed note, or any unrelated local/cloud change;
- pending outbox work, a demo-refresh/test/pull checkpoint, or another
  resolution checkpoint;
- incomplete or ambiguous note mapping, ownership mismatch, invalid note
  fields, failed validation, stale persistence, or unverified auth;
- a cloud read failure. A failed read is never treated as record absence.

## User flow

1. **Review note conflict (read-only)** runs the same three-way compare used by
   the pull/push previews. It does not write anything.
2. If exactly one divergent note conflict is proven, the panel shows the
   **private on-device versions** under `THIS BROWSER VERSION` and
   `CLOUD VERSION`, plus the differing field names (`title`, `body`,
   `note_date`). The panel contains no user ID, record UUID, financial value, or
   raw error.
3. **Keep cloud version (confirm)** requires the native confirmation. It
   states that the local note will be replaced, a backup is saved, no Supabase
   record is written, no outbox entry is created, and Cloud Sync stays OFF.
4. **Keep this browser’s version** is visibly disabled with “not available
   yet”. The cloud is never overwritten by this phase.
5. Any evidence change during confirmation cancels the action. There is no
   automatic retry.

The read-only conflict previews still offer **no action** and show only field
names. Displaying note content is limited to the explicit resolution review on
the user’s device; it is never copied into status, action, field-name, or
diagnostic strings.

## Keep-cloud application

The action reuses the `manual-notes-pull-v1` checkpoint and
`manual-notes-pull-backup:` namespace so existing recovery guards and the
read-only recovery inspector apply unchanged.

Before replacement:

- verify the local note still equals the previewed local fingerprint;
- verify the cloud note still equals the previewed cloud fingerprint;
- require both fingerprints to differ from the baseline and from each other;
- verify the exact baseline, local state, localStorage, IndexedDB state, empty
  outbox, and absence of other checkpoints;
- write a backup of the conflicted local JSON and baseline;
- write a prepared checkpoint;
- re-read the backup/checkpoint/state/baseline and re-read the cloud row.

The atomic local write replaces only that note and updates **one** baseline
record (`revision + 1`, cloud fingerprint, `cloud_updated_at`,
`last_resolution_id`). It also writes an `applied` checkpoint. Only after the
local state, baseline, backup, and cloud row verify does it delete the
checkpoint. The backup is retained.

If the transaction fails before commit, the original local state and baseline
remain. If it fails after commit, the applied checkpoint, backup, IndexedDB
state, and baseline remain for inspection. There is no rollback, reset, or
automatic retry.

## Recovery

**Inspect note-pull recovery (read-only)** recognizes a resolution checkpoint
by `kind: "manual-note-resolution"` and labels it
`READ-ONLY NOTE-RESOLUTION RECOVERY`. It reports phase, ownership, backup
verification, outbox count, local state, baseline, persistence, unchanged
financial collections, and cloud evidence without values or identifiers.

A prepared checkpoint means the original local state should still match the
backup. An applied checkpoint means the local state and baseline should match
the reviewed cloud snapshot. In either case the checkpoint blocks other
manual sync actions until reviewed. Do not clear, reset, or retry it blindly.

## Verification

- `node tests/notes-resolution.cjs`: **26** pure planning/confirmation checks.
  Covers the one-note conflict preview, field names, local-only/cloud-only/
  agreement, pending/recovery precedence, unrelated changes, mapping/ownership/
  content failures, stale persistence, Cloud Sync OFF, confirmation, ticket
  changes, backup-first errors, post-commit errors, and lock failure. It also
  proves the preview receipt is not mutated and statuses/field names do not
  contain note content, IDs, or financial values.
- `node tests/notes-resolution-idb.cjs`: **22** UI/atomic IndexedDB checks.
  Covers read-only review, both versions, disabled keep-local, cancellation,
  keep-cloud commit, backup retention, checkpoint cleanup, evidence changed
  during confirmation, cloud changed after backup, failed cloud reads, local
  storage/set failures, transaction rollback, backup staging failure, checkpoint
  delete failure, guard failures, changed baseline, pending outbox, existing
  recovery, invalid cloud fields, wrong fingerprints, converged content,
  unrelated financial changes, and read-only recovery inspection.
- `node tests/notes-conflict.cjs`: **13** checks; the synthetic self-check now
  also proves a resolution preview is available while keep-local remains
  unavailable.
- `node tests/notes-pull-idb.cjs`: **50** checks; the original conflict preview
  still shows only field names and offers no action.
- `node tests/notes-manual-idb.cjs`: **24** checks; queue/push behavior is
  unchanged.
- All **22** isolated `.cjs` suites pass, plus JavaScript syntax and JSON
  parsing checks. The PostgreSQL-WASM suite passes with
  `CAP_PGLITE_PATH` pointing at the installed `@electric-sql/pglite` package;
  fake-IndexedDB suites use `CAP_FAKE_IDB_PATH`.

## Disposable-browser rehearsal

A native rehearsal ran at the unique disposable origin
`http://localhost:8047/` with a synthetic 4-record baseline (one note, one
account, profile, preferences) and a mocked cloud GET. The local note body and
cloud note body were both changed after the baseline.

- Review: `CONFLICT — resolution preview ready`; both synthetic versions shown;
  differing field `body`; keep-local button disabled; no UUID rendered.
- Keep cloud: `RESOLVED — CLOUD VERSION KEPT; LOCAL BACKUP RETAINED`.
- Local note and localStorage/IndexedDB persistence matched the reviewed cloud
  version; note baseline revision became 1; the retained backup contained the
  conflicted local version; checkpoint absent; outbox 0.
- Exact cloud reads: 2. Cloud mutation requests: 0. Synthetic financial value
  unchanged.
- `CapSync.status()`: `mode: "off"`, pending 0, conflicts 0.
- After reload: the cloud version persisted, baseline revision 1, backup
  retained, checkpoint absent, outbox 0, shell cache `cap-shell-v313`.

This disposable rehearsal is not a live Supabase trial and does not authorize
one.

## Real-profile read-only verification

Shell v313 was verified on the signed-in real profile without applying a
resolution:

- Plan Outbox: 0 outbox entries, 0 conflicts, nothing queued;
- conflict self-check: all five `PASS` lines, including the keep-cloud preview;
- blocker diagnostic: baseline 46 records, version 2, ownership verified;
  outbox 0; recovery, demo-refresh, and manual note-pull checkpoints absent;
  current 46 records; all comparison difference categories 0;
- nothing was deleted, applied, reset, or baselined, and Cloud Sync remained
  OFF.

No real note, baseline, outbox, checkpoint, financial, or cloud data was
changed. Keep-cloud was **not applied** to real data, and keep-local remains
unavailable. The user's real profile was used only for these read-only checks;
this does not authorize a live conflict trial or resolution write.

## Not implemented

- Keeping the browser version by overwriting the cloud note.
- Field-by-field merge or automatic conflict resolution.
- New/deleted notes, legacy string notes, multiple-note conflicts, or bounded
  financial records.
- Background/automatic sync or any change that enables Cloud Sync.

Those require separate design, review, and explicit authorization.
