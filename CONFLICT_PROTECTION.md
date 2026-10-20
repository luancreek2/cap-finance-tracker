# Conflict protection

Shell `cap-shell-v312`. This phase is **simulated only**. No live local or cloud
edit was made, and Cloud Sync remains OFF. It verifies that Cap refuses to
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
- Only differing **field names** (`title`, `body`, `note_date`) are shown. Note
  values, financial data, record IDs, user IDs, payloads, and raw errors are
  never rendered.
- A conflict preview offers **no action button**. It performs no local write,
  backup, checkpoint, outbox change, baseline change, or cloud mutation.
- A retained backup from an earlier successful pull is left untouched.

Field names are informational. They do not authorize a merge, choice, retry,
reset, or cleanup.

## Synthetic self-check

**Run conflict protection self-check (read-only)** runs fixed in-memory rows
through the same planner three times:

1. simultaneous different local/cloud edits → blocked as `CONFLICT`;
2. the same pending edit against a changed cloud note → blocked as `CONFLICT`;
3. a cloud-only change → still allowed as a pull preview.

It confirms the inputs were unchanged after planning. It does not read real
notes, localStorage, IndexedDB, or the network, and it makes no writes. Expected:
all four `PASS` lines.

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
  and repeatable synthetic self-check.
- `node tests/notes-pull-idb.cjs`: 50 UI/real-helper/atomic IndexedDB checks.
  Six new conflict cases cover UI field names, no offered action, no writes or
  backup/checkpoint, push-side blocking, retained-backup preservation, reload
  behavior, recovery precedence, and the self-check button.
- Native disposable-browser rehearsal (`127.0.0.1:8036`, 43-record fixture,
  mocked cloud) produced `CONFLICT` for both previews with only `body` named,
  no action button, zero cloud mutations/exact reads, no outbox/backup/checkpoint,
  and unchanged local edit, baseline, persistence, and financial collections.
  The self-check showed all four `PASS` lines. After reload, the local edit and
  baseline were unchanged and the conflict still blocked; shell cache was v312.
- All 20 isolated `.cjs` suites and JavaScript/JSON syntax checks pass.

## User profile verification (read-only)

After reloading shell v312, the user ran the developer-tool checks on the real
profile with no live conflict created:

- conflict self-check: all four `PASS` lines;
- cloud pull preview: `NO CLOUD NOTE CHANGE TO PULL — local, baseline, and cloud agree`;
- manual push preview: `NO NOTE EDIT TO QUEUE — local, baseline, and cloud agree`;
- Cloud Sync remained OFF, with no changes made.

This verifies the installed read-only conflict checks only. It is not a live
conflict trial and does not authorize merge or resolution behavior.

A final read-only blocker check reported baseline/current 46, owned version 2,
outbox 0, all three recovery checkpoints absent, and zero missing, unexpected,
mismatch, foreign-key, without-baseline, baseline-only, or baseline-content
differences. Cloud Sync remained OFF. No cleanup or baseline action was taken.

## Live conflict trial

Not authorized or performed. A future live trial would need separate approval
and would require making one local note edit and one cloud note edit against the
same baseline. Until then, conflict behavior is proven only with synthetic and
fake-IndexedDB data. This phase does not implement merge, automatic resolution,
background sync, or any financial-record change.
