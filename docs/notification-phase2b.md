# Phase 2B — Client scheduling compiler and dark publisher

Phase 2B connects Cap's local notification model to the sealed Scheduling V2
contract (`supabase_notifications_scheduling_v2.sql`, Phase 2A, frozen). It is a
local/dark implementation: no production SQL is applied, no production RPC is
called and no push is sent.

## Modules

| File | Role | Boundaries |
|---|---|---|
| `js/notification-schedule.js` | Deterministic compiler: local financial projection → notification occurrences → V2 instructions | No DOM, no UI, no network, no Supabase, no financial writes, no push registration |
| `js/notification-publisher.js` | Orchestrator: readiness → publish → authoritative acknowledgment → reconciliation | Never derives financial truth, never reads remote tables, never invokes the Edge sender, never displays an OS notification |

Both are loaded by `index.html` with no startup work. The shipped publisher
singleton is permanently **dark** (`activation.phase = PHASE_2B_DARK`) and
returns `PUBLICATION_DISABLED` before any RPC.

## Canonical time model

* `default_local_time` is `HH:mm`, defaulting to `09:00` for existing users.
* Relative reminders use `time_source = inherit | override`; inherited stages
  follow the current default, overrides use their own `override_local_time`.
* Relative subtraction is **calendar-based** (`shiftDateKey`), never
  `days_before * 24 h`, so a DST transition cannot move the reminder date.
* Supported lead days: `14, 7, 5, 3, 2, 1, 0`. Migration never enables stages
  the user did not already have.
* Absolute reminders store the selected local date/time, the accepted timezone
  and the resolved UTC instant. The UTC instant is authoritative; device travel
  or timezone changes never move it.

### DST contract (matches Phase 2A)

* A nonexistent wall time is **rejected** (`NOTIFICATION_LOCAL_TIME_GAP`); it is
  never silently normalized.
* An ambiguous fold resolves to the **later** occurrence.
* Expiry uses `min(next local midnight, send_after + 24 h)` in the accepted
  zone. The local-midnight ceiling normalizes a midnight gap and takes the
  earlier fold instant, exactly as SQL does.

## Horizon, expiry and collisions

* Publication horizon is `reference + 8760 h` (365 × 24 h), compared as an
  instant, not as "same date next year".
* Projection extends `maxLead + 2` days past the horizon so an obligation whose
  due date is outside the horizon can still contribute a reminder inside it.
  Anything still out of range is returned in `outside` and surfaced as
  `OUTSIDE_RANGE`, never silently discarded.
* Same obligation + same resolved UTC minute collapses to one active reminder.
  A custom absolute reminder wins over a relative one. Remaining ties use a
  total order (local time, then reminder id) so the outcome is independent of
  input order. Collapses are reported in `collisions`.
* Different obligations may share a timestamp.

## Identity and digests

* Identity hierarchy: financial source incarnation → obligation **occurrence**
  → reminder. IDs are random opaque UUIDs, allocated once in a notification-only
  IndexedDB transaction. They are not hashes of financial source IDs or dates.
* `source_handle` identifies one explicit source incarnation. A deleted source
  and a later source reusing its local financial ID never share a handle.
* `obligation_id` identifies one outstanding occurrence/cycle (e.g. November).
  Correcting its expected due date retains it; December gets a different ID.
* `reminder_id` identifies one reminder creation. Editing its lead (3 → 7), kind,
  inherited/override time, timezone or custom date/time retains this ID. A deleted
  reminder is tombstoned; an equivalent new reminder gets a new ID.
* No scheduling property, revision, generation or financial display field
  defines either ID. The previous uncommitted date/stage-derived Phase 2B IDs
  are deliberately not retained; old dark plans require explicit remapping.
* Digests reuse the existing installation/owner key architecture and Web Crypto:
  * `candidate_digest = lowercaseHex(HMAC-SHA256(key, "cap-push-digest-v1\0" + owner + "\0" + installation + "\0" + obligation_id + "\0" + reminder_id))`
  * `obligation_digest = lowercaseHex(HMAC-SHA256(key, "cap-push-obligation-v1\0" + owner + "\0" + installation + "\0" + obligation_id))`
* Remote entries contain exactly eight string fields:
  `candidate_digest`, `obligation_digest`, `time_basis`, `eligible_local_date`,
  `local_time`, `timezone`, `send_after`, `expires_at`. Raw financial ids,
  merchant, amount, title, description, account and category never enter a
  publication payload. `local_ref` stays on the local record only.

## Storage

The existing `cap-notifications` IndexedDB database (version 1, store `state`)
is reused. No second notification database or installation identity is created.

| Key | Meaning |
|---|---|
| `scheduling.policy` | `default_local_time`, `default_stages`, `category_stages`, `notification_timezone`, `acknowledged_timezone`, revisions, migration marker |
| `scheduling.plan` | Last compiled plan with a local `revision` |
| `scheduling.ack` | Last authoritative remote acknowledgment |
| `scheduling.digest-key` | 32-byte installation digest key (base64url) |
| `scheduling.identities:<owner>` | Source incarnations, occurrence cycles, reminder creation records and permanent tombstones; local source associations only |

### Explicit continuity boundary

`mutateIdentities(owner, command)` reads and writes the owner-scoped mapping in
one IndexedDB `readwrite` transaction. Concurrent tabs/migration calls with the
same creation tokens receive the same IDs. `loadIdentities(owner)` reads it;
`updateMapping()` is the pure independently testable lifecycle reducer.

Commands: `create_source`, `ensure_occurrence`, `ensure_reminder`,
`delete_reminder`, `close_occurrence`, `close_source`. Creation/cycle/rule tokens
are explicit durable lifecycle evidence (operation tokens), **not** financial
IDs, dates, stages or values recalculated from projection. A timing edit uses
the existing occurrence/reminder records; it does not issue new creation tokens.
An explicitly established new cycle gets a new cycle token. Closed tokens never
reopen; recreate requires a fresh creation token. Closing a source closes all
its occurrences and reminders.

The compiler never infers continuity from a date or a source ID. Each obligation
supplies `occurrences: [{ obligation_id, due_date, reminders }]`, with stable
`reminder_id` on each reminder; absolute instructions also carry the mapped
pair. The owner-scoped `identities` snapshot must prove these records are open.
Raw source associations, when provided, must match the mapped source. Projection
still uses the existing recurrence predicate, but every projected cycle must
have an explicit mapping: unknown/ambiguous identity blocks the **whole** remote
snapshot (`identity_blocked`, `IDENTITY_CONTINUITY_REQUIRED`), never a partial
replacement that accidentally cancels protected work. Both publication and
reconciliation refuse blocked/pre-correction plans.

There is deliberately no automated financial-to-cycle remapper at startup.
Where the financial projection cannot prove source incarnation/cycle continuity,
the safe remapping path is explicit source/cycle establishment after review,
never silently attaching it to an old identity. This remains dark/nonvisual.

`notification_timezone` is the last acknowledged remote zone. A detected device
timezone change recompiles proposed future relative occurrences locally and
leaves them `CHANGE_PENDING`; the old acknowledged remote interpretation remains
authoritative until a replacement is acknowledged.

## State model

`SAVED_LOCAL`, `PENDING_SYNC`, `SCHEDULED`, `CHANGE_PENDING`,
`CANCELLATION_PENDING`, `OUTSIDE_RANGE`, `ACTION_REQUIRED`, `EXPIRED`, `SENT`,
`DELIVERY_UNCERTAIN`.

Timing edits retain the same candidate digest, so `accepted`, `unknown`,
`retired`, and `suppressed` receipts remain terminal/protected. State derivation
retains these receipts even when the proposed timing differs. Phase 2A accepts
these opaque digest pairs without SQL changes; its ledger fences remain intact.

`SCHEDULED` requires an authoritative acknowledgment of the exact occurrence,
time, revision and generation. Local intent alone is never scheduled. Offline
edits are `PENDING_SYNC`; offline cancellation is `CANCELLATION_PENDING`.

## Uncertain outcomes

An uncertain transport/server outcome is never guessed. The publisher performs
an authoritative readback:

* exact acknowledgment → `SCHEDULED`;
* readback shows the previous revision → one bounded retry;
* readback shows a conflicting revision → `CHANGE_PENDING`, no republish;
* readback unavailable → `DELIVERY_UNCERTAIN`.

Publication is bounded to two attempts and one readback per attempt. There is no
uncontrolled retry loop and no "RPC missing → retry" behavior.

## RPC surface

`js/production-rpc.js` adds narrow wrappers for the exact Phase 2A signatures:

* `cap_notifications_readiness_v2`
* `cap_notifications_publish_v2`
  (`p_binding_id`, `p_generation`, `p_expected_revision`, `p_preference_revision`,
  `p_protocol`, `p_engine_identity`, `p_digest_version`, `p_timezone`, `p_entries`)
* `cap_notifications_schedule_readback_v2`

The legacy `cap_notifications_publish_v1` remains unreachable. No private table,
no `service_role`, no sender credential and no VAPID private material is used.

## Migration

`ensurePolicy(preferences)` runs once; an existing policy is returned untouched.
A first run derives the policy from Phase 5A preferences: `default_local_time`
becomes `09:00`, each category keeps its configured lead, and no extra stage is
enabled. History, enrollment state and installation identity are not read,
rewritten or regenerated. Migration never writes an acknowledgment or a plan, so
it cannot claim a remote state that never happened. It is idempotent.

For identity migration, the same lifecycle commands are used with persisted
explicit source-incarnation, outstanding-cycle and existing-rule creation tokens.
They allocate durable IDs once; repeated/concurrent runs and reloads return the
same IDs. Ambiguous sources are held for explicit remapping, not guessed. These
commands do not touch preferences/history, financial records, enrollment, the
installation identity, digest material or remote acknowledgment. They create no
extra reminder rules. Deleted/completed tokens cannot be migrated back to life.

## Phase 5A parity

The compiler is the canonical timing model for future local and remote
occurrence generation, but Phase 2B does not rewire foreground presentation. The
recurrence predicate is injected from `CapFinancialSearchEngine.scheduled` with
an identical local fallback and a parity test, so there is one recurrence
formula, not two.

## Testing

* `tests/notification-schedule.cjs` — pure compiler: default time, stages,
  calendar/leap/DST math, absolute UTC preservation, gaps/folds, horizon, expiry,
  collisions, identity, digests, privacy, recurrence parity.
* `tests/notification-publisher.cjs` — dark default, acknowledgment semantics,
  stale revision, generation mismatch, contract/capacity/busy rejections, offline
  edit/cancel, uncertain timeout/readback, bounded retry, containment.
* `tests/notification-schedule-browser.cjs` — real IndexedDB migration,
  idempotence, digest-key persistence, reload persistence, timezone-change
  pending, absolute UTC preservation, no UI change, no production RPC.

## Frozen

`service-worker.js` (`cap-shell-v375`), the Edge sender, the seven-field payload,
historical notification SQL, financial write paths, Cloud Sync and VAPID
configuration are unchanged.
