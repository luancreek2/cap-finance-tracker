# Conflict protection

Shell `cap-shell-v312`, with keep-cloud resolution added in `cap-shell-v313`
(see `CONFLICT_RESOLUTION.md`). The original conflict-protection work was
**simulated only**. A separately authorized live conflict trial was later
performed on one baseline-mapped note; see [Live conflict trial](#live-conflict-trial).
Cloud Sync remained OFF throughout. The checks verify that Cap refuses to
overwrite a note when both the browser and Supabase changed it after the same
baseline.

## What counts as a conflict

For one baseline-mapped note:

- **cloud-only change** → safe to preview a pull.
- **local-only change** → preview is blocked until that edit is queued/reviewed.
- **both changed, different content** → `CONFLICT`; no pull or push action is
  offered and neither version is overwritten.
- **both changed, identical content** → not mislabelled as a conflict; baseline
  acknowledgement still requires separate review.
- **unrelated records changed on either side**, a pending outbox entry, a
  recovery checkpoint, failed validation, stale persistence, or unverified auth
  blocks earlier, regardless of note content.

## Read-only conflict preview

Use **Privacy & Sync → developer tools → Plan Outbox**:

- **Preview cloud note pull (read-only)** reports a conflict as:
  `CONFLICT — local and cloud changed; nothing overwritten`.
- **Preview manual note sync (read-only)** reports the push-side equivalent:
  `CONFLICT — cloud note changed; no overwrite permitted`.
- The conflict preview itself shows only differing **field names** (`title`,
  `body`, `note_date`). Note values, financial data, record IDs, user IDs,
  payloads, and raw errors are never rendered there. A separate, explicit
  resolution review can display both note versions on-device; see
  `CONFLICT_RESOLUTION.md`.
- A conflict preview offers **no action button**. It performs no local write,
  backup, checkpoint, outbox change, baseline change, or cloud mutation.
- A retained backup from an earlier successful pull is left untouched.

Field names are informational. They do not authorize a merge, choice, retry,
reset, or cleanup.

## Synthetic self-check

**Run conflict protection self-check (read-only)** runs fixed in-memory rows
through the same planner four times:

1. simultaneous different local/cloud edits → blocked as `CONFLICT`;
2. the same pending edit against a changed cloud note → blocked as `CONFLICT`;
3. a cloud-only change → still allowed as a pull preview;
4. the same divergent note → allowed only as a resolution preview with
   keep-cloud available and keep-local unavailable.

It confirms the inputs were unchanged after planning. It does not read real
notes, localStorage, IndexedDB, or the network, and it makes no writes. Expected:
all five `PASS` lines.

## Recovery behavior

A conflict is blocked **before** any backup or checkpoint exists. Therefore:

- no `manual-notes-pull-v1` checkpoint should appear;
- no `manual-notes-pull-backup:` entry should be created;
- outbox count must remain unchanged;
- local note, financial collections, baseline, and cloud rows remain unchanged.

If a conflict appears together with a recovery checkpoint, inspect recovery
first. Do not retry, reset, clear storage, or delete metadata.

## Verification

- `node tests/notes-conflict.cjs`: 13 pure conflict-planning checks, including
  single/multiple field conflicts, same-content convergence, local-only vs
  cloud-only changes, pending/recovery precedence, push-side conflicts, leakage,
  and repeatable synthetic self-check. The self-check now also proves that a
  divergent note can be previewed for keep-cloud resolution while keep-local is
  unavailable.
- `node tests/notes-pull-idb.cjs`: 50 UI/real-helper/atomic IndexedDB checks.
  Six new conflict cases cover UI field names, no offered action, no writes or
  backup/checkpoint, push-side blocking, retained-backup preservation, reload
  behavior, recovery precedence, and the self-check button.
- Keep-cloud resolution adds `node tests/notes-resolution.cjs` (26 pure checks)
  and `node tests/notes-resolution-idb.cjs` (22 UI/atomic IndexedDB checks).
  Details and the disposable-origin result are in `CONFLICT_RESOLUTION.md`.
- Native disposable-browser rehearsal (`127.0.0.1:8036`, 43-record fixture,
  mocked cloud) produced `CONFLICT` for both previews with only `body` named,
  no action button, zero cloud mutations/exact reads, no outbox/backup/checkpoint,
  and unchanged local edit, baseline, persistence, and financial collections.
  The self-check showed all four `PASS` lines. After reload, the local edit and
  baseline were unchanged and the conflict still blocked; shell cache was v312.
- All 22 current isolated `.cjs` suites and JavaScript/JSON syntax checks pass.

## User profile verification (read-only)

### Shell v313 (pre-trial read-only)

Before the authorized live trial, after reloading shell v313 and signing in,
the user ran the developer-tool checks on the real profile with no live
conflict created:

- Plan Outbox: 0 outbox entries, 0 conflicts, nothing queued; no operation was
  applied or removed;
- conflict self-check: all five `PASS` lines, including the keep-cloud
  resolution-preview line and the disabled keep-local path;
- blocker diagnostic: baseline 46 records, version 2, ownership verified;
  outbox 0; recovery, demo-refresh, and manual note-pull checkpoints absent;
  current 46 records; missing 0, unexpected 0, mismatches 0, foreign keys 0,
  without baseline 0, baseline-only 0, and baseline-content differences 0;
- the blocker reported nothing deleted, applied, reset, or baselined;
- Cloud Sync remained OFF.

At that point no real note, financial, or cloud data was changed. The
keep-cloud path was only previewed synthetically in the self-check; it had not
yet been executed on real data. Keep-local remains unavailable. This verifies
the installed read-only conflict checks before the later authorized trial; it
was not itself a live conflict trial, merge, or resolution apply.

### Shell v312 (historical)

After reloading shell v312, the user ran the earlier developer-tool checks on
the real profile with no live conflict created:

- conflict self-check: all four `PASS` lines at the time of the v312 check;
- cloud pull preview: `NO CLOUD NOTE CHANGE TO PULL — local, baseline, and cloud agree`;
- manual push preview: `NO NOTE EDIT TO QUEUE — local, baseline, and cloud agree`;
- Cloud Sync remained OFF, with no changes made.

That v312 blocker check also reported baseline/current 46, owned version 2,
outbox 0, all three recovery checkpoints absent, and zero missing, unexpected,
mismatch, foreign-key, without-baseline, baseline-only, or baseline-content
differences. No cleanup or baseline action was taken.

## Live conflict trial

A live trial was separately authorized and performed on 2026-10-20 against the
signed-in real profile, with Cloud Sync OFF. Scope was one existing
baseline-mapped note selected by the user; no financial record was touched. The
cloud marker remains by user approval; no restoration was authorized.

1. **Cloud side:** one CAS `cap_sync_note_put` call appended a generic cloud
   trial marker to the selected note. Title, date, ownership, and row count were
   unchanged, and the cloud row was re-read. This was the only Supabase
   mutation.
2. **Local side:** the user appended a distinct generic local marker to the same
   note and saved it. No queue or push was performed.
3. **Pull preview:** `CONFLICT — local and cloud changed; nothing overwritten`;
   only `body` differed; both versions were preserved; no changes were made.
4. **Review:** both on-device versions were shown; differing field `body`;
   keep-local remained disabled.
5. **Keep cloud:** `RESOLVED — CLOUD VERSION KEPT; LOCAL BACKUP RETAINED`.
6. **Post-resolution preview:** `NO CLOUD NOTE CHANGE TO PULL — local, baseline,
   and cloud agree`.
7. **Blocker:** baseline 46 records, version 2, ownership verified; outbox 0;
   recovery, demo-refresh, and manual note-pull checkpoints absent; current 46;
   missing 0, unexpected 0, mismatches 0, foreign keys 0, without baseline 0,
   baseline-only 0, baseline-content differences 0; nothing deleted, applied,
   reset, or baselined; Cloud Sync OFF.
8. **Cloud recheck:** one owned row; cloud marker present; local marker absent;
   title and date unchanged. The resolution made no second Supabase write.

The retained backup was not deleted. The cloud marker remains by user approval;
restoration would require a separate authorization and another guarded cloud
write. Keep-local, merge, automatic resolution, background sync, and
financial-record changes remain unimplemented or blocked.
