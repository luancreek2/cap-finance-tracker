# Manual conflict resolution — keep cloud and keep local

Shell `cap-shell-v314`. This phase adds both explicit directions to note
conflict resolution when one existing baseline-mapped note changed in both the
browser and Supabase:

- **Keep the cloud version** is the non-destructive direction. The browser
  version is backed up first, then the local note and its one baseline record
  are updated.
- **Keep this browser’s version** is the destructive direction. It asks for
  explicit confirmation, saves and verifies a local backup, and overwrites the
  exact reviewed cloud note through the notes CAS RPC. The local note stays as
  it is; only its baseline acknowledgement changes locally.

Keep-local is implemented and covered by isolated tests. A separately authorized
live overwrite returned success on 2026-10-21 and passed the read-only cloud
recheck and subsequent normal-browser convergence/blocker checks.
Further cloud writes require new explicit authorization. There is still no merge, automatic resolution,
background sync, tombstone, or financial-record change. Cloud Sync remains OFF
before, during, and after every flow.

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
4. **Keep this browser’s version (overwrite cloud, confirm)** requires a
   distinct destructive confirmation. It states that exactly one Supabase note
   will be overwritten after a verified local backup, that no financial record,
   outbox entry, or other note changes, and that Cloud Sync stays OFF. The
   confirmation is explicit; there is no default choice and no typed value is
   requested or stored.
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

## Keep-local application

This direction also reuses the `manual-notes-pull-v1` checkpoint and
`manual-notes-pull-backup:` namespace. The cloud write is destructive, so the
local backup and prepared checkpoint must commit and read back **before** any
CAS request is sent.

Before the cloud write:

- verify the local note, local fingerprint, and previewed baseline record;
- verify the exact reviewed cloud row and its ownership;
- require the local and cloud fingerprints to differ from the baseline and from
  each other;
- verify current localStorage/IndexedDB persistence, empty outbox, and absence
  of other recovery checkpoints;
- write the conflicted local JSON, baseline, and losing cloud snapshot to the backup, write the
  prepared `conflict-local` checkpoint, and re-read both;
- re-read the exact cloud row again immediately before the CAS.

The CAS call is `cap_sync_note_put` with the reviewed cloud record ID, the
expected original cloud content, and the desired local content. It targets one
existing note only; it never inserts or deletes a note. `APPLIED` and
`ALREADY_APPLIED` continue to verification. `CONFLICT` triggers an exact cloud
read: if the cloud already equals the desired local content, the action may
continue; if it still equals the original, or differs from both, the action
stops without a local baseline update.

After a successful CAS:

- re-read the exact cloud row and require the desired content;
- write a `cloud-written` checkpoint containing the next baseline and the
  verified cloud row;
- in one IDB transaction, write the next baseline and the `applied` checkpoint;
- increment the baseline revision once and update only the mapped note record
  (`contentFingerprint` = local fingerprint, `cloud_updated_at` from the
  verified cloud row, new `last_resolution_id`);
- verify the local note/persistence, baseline, outbox, backup, and cloud again;
- delete the checkpoint only after all verification succeeds. The backup is
  retained, including the losing cloud version for separately reviewed recovery.

The local note itself is not replaced. Its ordinary `_mt`/save timestamp is not
rewritten, and the local outbox is not touched. No financial collection is
written.

Failure handling is fail-closed:

- before backup: nothing is written;
- after backup but before the cloud write: the backup and prepared checkpoint
  remain, and no cloud write is attempted;
- cloud written but baseline not updated: the `cloud-written` checkpoint remains,
  the local note and baseline remain original, and recovery inspection reports
  the cloud evidence separately;
- baseline committed but final verification failed: both writes remain recorded
  for inspection;
- unknown cloud outcome or read failure: stop immediately with an explicit
  unknown-outcome status. There is no automatic retry or rollback.

## Recovery

**Inspect note-pull recovery (read-only)** recognizes a resolution checkpoint
by `kind: "manual-note-resolution"` and labels it
`READ-ONLY NOTE-RESOLUTION RECOVERY`. It also shows whether the mode is
`keep cloud` or `keep local (cloud overwrite)`. It reports phase, ownership,
backup verification, outbox count, local state, baseline, persistence,
unchanged financial collections, and cloud evidence without values or
identifiers.

- `prepared` means the backup and checkpoint exist, but the local replacement
  or cloud CAS may not have completed.
- `cloud-written` is specific to keep-local: the cloud row matched the desired
  local content, but the baseline acknowledgement was not verified.
- `applied` means the local/baseline side committed; the checkpoint is retained
  only because final verification or cleanup did not complete.

The inspector distinguishes cloud evidence that matches the original, matches
the desired snapshot, or differs. For keep-local it reports
`LOCAL OVERWRITE CLOUD WRITTEN — BASELINE NOT UPDATED` when the cloud is desired
but the baseline is still original. A prepared or cloud-written checkpoint
blocks other manual sync actions until reviewed. Do not clear, reset, or retry
it blindly.

## Verification

- `node tests/notes-resolution.cjs`: **29** pure planning/confirmation checks.
  Covers the one-note conflict preview, both available directions, field names,
  local-only/cloud-only/agreement, pending/recovery precedence, unrelated
  changes, mapping/ownership/content failures, stale persistence, Cloud Sync
  OFF, confirmation, ticket changes, backup-first errors, post-commit errors,
  cloud-written/unknown-outcome statuses, and lock failure. It also proves the
  preview receipt is not mutated and statuses/field names do not contain note
  content, IDs, or financial values.
- `node tests/notes-resolution-idb.cjs`: **39** UI/atomic IndexedDB checks.
  Covers read-only review, both versions, both enabled actions, cancellation,
  keep-cloud commit, keep-local CAS commit, local state retention, baseline
  acknowledgement, backup retention, checkpoint cleanup, evidence changed
  during confirmation, cloud changed after backup, CAS conflict, cloud-written/
  baseline-not-updated recovery, unknown write outcome, failed cloud reads,
  local storage/set failures, transaction rollback, backup staging failure,
  checkpoint delete failure, guard failures, changed baseline, pending outbox,
  existing recovery, invalid cloud fields, wrong fingerprints, converged
  content, unrelated financial changes, and read-only recovery inspection.
  Also checks that local changes during RPC readiness block the CAS and that
  recovery refuses a missing losing-cloud backup. The mocked CAS is the only
  cloud mutation path exercised.
  Additional failure coverage proves that a lost response and an already-applied
  response never trigger a second CAS; an unreadable cloud after `APPLIED` does
  not acknowledge the baseline; failed cloud-checkpoint staging preserves the
  prepared evidence; failed cleanup retains both versions and blocks another
  action; later cloud divergence cannot report verified recovery; and changed
  confirmation evidence creates no backup.
- `node tests/notes-conflict.cjs`: **13** checks; the synthetic self-check now
  proves a resolution preview is available with both keep-cloud and keep-local
  actions while still making no overwrite.
- `node tests/notes-pull-idb.cjs`: **50** checks; the original conflict preview
  still shows only field names and offers no action.
- `node tests/notes-manual-idb.cjs`: **24** checks; queue/push behavior is
  unchanged.
- All **22** isolated `.cjs` suites pass, plus JavaScript syntax and JSON
  parsing checks. The PostgreSQL-WASM suite passes with
  `CAP_PGLITE_PATH` pointing at the installed `@electric-sql/pglite` package;
  fake-IndexedDB suites use `CAP_FAKE_IDB_PATH`.

## Disposable-browser rehearsal

A native keep-cloud rehearsal ran at the unique disposable origin
`http://localhost:8047/` with a synthetic 4-record baseline (one note, one
account, profile, preferences) and a mocked cloud GET. The local note body and
cloud note body were both changed after the baseline.

- Review: `CONFLICT — resolution preview ready`; both synthetic versions shown;
  differing field `body`; keep-local button was disabled in that version; no
  UUID rendered.
- Keep cloud: `RESOLVED — CLOUD VERSION KEPT; LOCAL BACKUP RETAINED`.
- Local note and localStorage/IndexedDB persistence matched the reviewed cloud
  version; note baseline revision became 1; the retained backup contained the
  conflicted local version; checkpoint absent; outbox 0.
- Exact cloud reads: 2. Cloud mutation requests: 0. Synthetic financial value
  unchanged.
- `CapSync.status()`: `mode: "off"`, pending 0, conflicts 0.
- After reload: the cloud version persisted, baseline revision 1, backup
  retained, checkpoint absent, outbox 0, shell cache `cap-shell-v313`.

### Keep-local browser rehearsal (2026-10-21)

The hardened v314 implementation passed at disposable origin
`http://localhost:8049/`, with a synthetic 4-record baseline, native IndexedDB
and DOM, and mocked identity, migration inputs, cloud transport, and confirmation
responses. Real fetch requests were blocked during the action. No Supabase
connection or real profile was used.

- Both explicit choices were enabled in the conflict review.
- Cancellation made zero mock writes and created no checkpoint.
- Confirmed keep-local returned `RESOLVED — LOCAL VERSION KEPT; CLOUD
  OVERWRITTEN; LOCAL BACKUP RETAINED`, with one mocked CAS call and four exact
  cloud reads. The local note and financial collection were unchanged.
- One baseline record was acknowledged; revision became 1. One verified backup
  retained both the conflicted local state and the losing cloud snapshot.
- Checkpoint absent, outbox 0, Cloud Sync OFF. A subsequent preview reported
  local/baseline/cloud agreement.
- Light and dark styles rendered the result visibly with distinct foreground
  and background colors.
- After reload, note content and identity, baseline, backup (including the
  losing cloud version), and financial collection persisted; checkpoint remained
  absent, outbox 0, mode OFF, shell cache `cap-shell-v314`. Normal startup changed
  only the note's `_u` metadata, not its title/body/date/ID.

The native confirmation dialog itself was not exercised: its true/false results
were simulated. This rehearsal is not a live Supabase trial and does not
authorize one. A live overwrite still requires separate explicit authorization.

## Live keep-local trial checklist

This is an execution checklist, not permission to run it. The separate setup
and overwrite authorizations and results are recorded below. Those authorized
operations have been performed; they do not authorize another write. The real note and its existing cloud trial marker
remain preserved. No cleanup or restoration is included.

1. **Read-only preflight in the user's real profile.** Verify the updated shell,
   online ownership, Cloud Sync OFF, current localStorage/IndexedDB persistence,
   a verified owned v2 baseline, empty outbox, and absent test/demo/pull recovery
   checkpoints. Revalidate full coverage and all unrelated records. Do not
   initialize a baseline, clear storage, or remove metadata to make this pass.
2. **Select and back up one existing mapped note privately.** Confirm the user's
   intended winning local version and preserve the current local and cloud
   versions on-device. Do not put content, IDs, or financial values in reports.
3. **Authorize setup separately if there is no conflict.** The last real-profile
   check was converged, so an end-to-end trial needs divergent local and cloud
   edits. A setup cloud edit is an additional real CAS mutation, not part of a
   one-overwrite authorization. Its exact scope and preservation of the current
   marker must be approved first. The local trial edit is user-driven. If an
   eligible conflict already exists, do not create another one.
4. **Read-only review.** Require exactly one note conflict, no unrelated
   differences, and the expected differing fields. The user privately reviews
   both versions. Stop if either version or the mapping is unexpected.
5. **Authorize the actual overwrite explicitly.** Only after a fresh review,
   obtain permission for one keep-local CAS on the selected note, then use the
   real destructive confirmation. The verified backup must retain the losing
   cloud snapshot. Keep other tabs idle; never queue or enable automatic sync.
6. **Verify without further cloud writes.** Expect local/cloud/baseline agreement,
   exactly one acknowledged baseline record, unchanged local note and financial
   data, outbox 0, checkpoint absent, and both versions retained in the backup.
   Reload and recheck persistence. Record only redacted statuses/counts/booleans.
7. **Stop on partial or unknown outcome.** Inspect recovery read-only. Do not
   retry the writer, restore a version, clear a checkpoint, or reset anything
   without a separate reviewed recovery plan and explicit authorization.

A setup edit plus the overwrite would be **two cloud mutation calls**, each
separately authorized. Neither marker cleanup nor restoration is implicitly
authorized by passing the trial.

### Authorized setup-only edit (2026-10-21)

After the user provided a clean real-profile read-only blocker (46 owned v2
baseline/current records, outbox 0, checkpoints absent, all differences 0) and
five passing conflict self-check lines, they explicitly authorized the cloud
setup edit only. They then signed in to the separate automation browser.

- The automation browser was authenticated with mode OFF, outbox 0, and all
  test/demo/pull checkpoints absent. It had no baseline; none was initialized,
  copied, or reset. The local trial/resolution remains in the user's normal
  browser profile.
- An owned cloud query uniquely identified the previously selected note by its
  existing approved trial marker. The notes CAS readiness verifier passed.
- A retained on-device setup backup saved the original cloud snapshot and the
  desired setup content, with read-back verification before the CAS.
- Exactly one `cap_sync_note_put` mutation request returned `APPLIED`. It
  appended a distinct generic cloud setup marker. An exact owned-row read
  verified the desired content, original body prefix, existing marker, and new
  marker; title and date were unchanged.
- Cloud Sync remained OFF. No baseline, outbox, local note, or financial record
  was changed. No marker was removed, and no restore or automatic retry ran.
- **Stopped before keep-local.** Next the user makes a distinct local edit to
  the same note in their normal browser, then runs a read-only conflict preview.
  Actual overwrite authorization will be requested only after reviewing that
  evidence. The setup authorization does not authorize the overwrite.

### Authorized keep-local overwrite (2026-10-21) — passed

- The user's local trial edit produced a conflict on `body` and `note_date`.
  Investigation found that the note editor stamps its date when edited; the
  new-day date change was explained before continuing. No corrective local or
  cloud write was made to suppress this difference.
- The user privately reviewed the two versions, then separately authorized one
  keep-local overwrite of the selected note's body and date. This explicitly
  replaced the temporary cloud setup marker with the reviewed local version;
  the prior approved marker remained. No financial record was in scope.
- The user clicked and confirmed the action in their normal browser. Their
  screenshot reported `RESOLVED — LOCAL VERSION KEPT; CLOUD OVERWRITTEN;
  LOCAL BACKUP RETAINED`, with Cloud Sync OFF.
- A separate read-only cloud recheck verified one owned row, unchanged title,
  the reviewed local date, preserved original body and prior marker, local
  trial marker present, and temporary setup marker absent. The setup backup
  was retained. This verification made zero mutation requests.
- The successful action reports that the resolution backup was retained.
  Following the requested reload/check steps, the user supplied a pull preview
  reporting `NO CLOUD NOTE CHANGE TO PULL — local, baseline, and cloud agree`.
- The subsequent real-profile blocker screenshot reported baseline/current 46,
  version 2, ownership verified, outbox 0, all test/demo/manual-pull checkpoints
  absent, and zero missing, unexpected, mismatch, foreign-key, without-baseline,
  baseline-only, or baseline-content differences. It reported no deletion,
  reset, apply, or baseline action by the diagnostic; mode remained OFF.
- **Trial passed.** No extra overwrite, rollback, marker cleanup, baseline
  reset, or checkpoint cleanup is authorized. The retained backup has not been
  independently opened in the user's browser; its retention is evidenced by
  the successful action status, alongside isolated backup-retention tests.

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
changed at that stage. Keep-cloud was not applied during these read-only checks,
and keep-local was unavailable in that shell. The read-only check did not itself
authorize a live trial; a later separately authorized trial is recorded below.
The later v314 keep-local trial is recorded above, separately from these
historical v313 checks.

## Authorized live conflict trial (2026-10-20)

After separate authorization, one existing baseline-mapped note in the real
signed-in profile was used. Cloud Sync stayed OFF. No other note, financial
record, baseline entry, outbox entry, or checkpoint was targeted. Only statuses,
field names, counts, and generic trial markers are recorded here; no note
content, financial value, or user/record identifier is included.

- **Cloud side:** one CAS `cap_sync_note_put` call appended a generic cloud
  trial marker to the selected note. Title, date, ownership, and row count were
  unchanged, and the cloud row was re-read. This was the only Supabase mutation.
- **Local side:** the user appended a distinct generic local marker to the same
  note and saved it. No queue or push was performed.
- **Preview:** `CONFLICT — local and cloud changed; nothing overwritten`; only
  `body` differed; both versions were preserved; no changes were made.
- **Review:** both on-device versions were displayed; differing field `body`;
  keep-local was disabled; Cloud Sync remained OFF.
- **Keep cloud:** `RESOLVED — CLOUD VERSION KEPT; LOCAL BACKUP RETAINED`. The
  atomic local/baseline update committed, the resolution checkpoint was removed
  after verification, and the backup was retained.
- **Convergence:** post-resolution pull preview reported
  `NO CLOUD NOTE CHANGE TO PULL — local, baseline, and cloud agree`.
- **Blocker:** baseline 46 records, version 2, ownership verified; outbox 0;
  recovery, demo-refresh, and manual note-pull checkpoints absent; current 46;
  all comparison difference categories 0; nothing deleted, applied, reset, or
  baselined; Cloud Sync OFF.
- **Cloud recheck:** one owned row; cloud marker present; local marker absent;
  title and date unchanged. The resolution made no Supabase write.

The cloud trial marker remains by user approval. No restoration was authorized.
The retained backup was not deleted. Keep-local was not part of that authorized
trial; the separately authorized v314 keep-local trial is recorded above.
Merge, automatic resolution, background sync, and
financial-record changes remain unimplemented or blocked.

## Not implemented

- Field-by-field merge or automatic conflict resolution.
- New/deleted notes, legacy string notes, multiple-note conflicts, or bounded
  financial records.
- Background/automatic sync or any change that enables Cloud Sync.

Those require separate design, review, and explicit authorization.
