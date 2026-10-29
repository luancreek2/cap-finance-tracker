# Scheduling V2 — Phase 2A database/RPC successor

Local implementation and certification only. No production SQL, migration,
deployment, enrollment, real push, activation, Cron or pg_net. No client publisher,
picker/UI, service-worker, financial/Cloud Sync or Edge TypeScript changes.
Historical SQL and v1 tests remain immutable. No commit or push authorized.

## Installation boundary

`supabase_notifications_scheduling_v2.sql` is a transactional review artifact,
not an automatically applied migration. It requires the sealed, dark 5B.3B
successor, the `postgres` installer and the explicit session guard:

```sql
set cap.notifications_scheduling_install = 'reviewed-scheduling-v2';
```

Do not run this against production under Phase 2A authorization. The preflight
verifies the old catalog seal before modifying anything and refuses reruns or
in-flight receipts. Temporary installer membership is attributed to the installer
and removed before resealing. Existing platform ADMIN-only membership is retained.
The original runtime verifier's security assertions are preserved; its control
predicate additionally recognizes the successor identity and 8760-hour horizon.
An additional manager financial table/column/RPC privilege check detects external
financial ACL drift, which is outside the notification catalog seal.
The final seal covers new functions, columns, constraints, index, RLS and ACLs.
Runtime operations and their signatures remain unchanged.

## Durable storage versus dispatch

Reuse `schedules`; no new table or promotion worker. A client-computed occurrence
can be accepted up to **8760 elapsed hours (365 days)** in advance. For v2 rows,
`publication_valid_until = expires_at`: it is per-occurrence authorization, not a
renewable seven-day lease. No reopening is required for an acknowledged occurrence.
The legacy control fields still describe the preserved v1 seven-day/09:00 contract.

For each v2 occurrence:

```text
send_after < expires_at
expires_at <= min(next local midnight, send_after + 24 elapsed hours)
```

Next local midnight is midnight following `eligible_local_date` in that entry's
accepted `timezone`, converted to UTC. The local-day ceiling is NOT replaced by a
generic TTL. Absolute entries retain their accepted creation timezone context.
Expired entries cannot be published. New entries cannot be backdated; unchanged
accepted entries may remain in a replacement snapshot during their unexpired
delivery window. Known browser expiry must cover the entire requested window.

Claim/start still enforce `send_after <= now`, expiry, binding state, generation,
schedule/preference revision, ledger eligibility, browser validity and VAPID
isolation. Existing run/attempt limits and short provider TTL remain unchanged.
Long-range storage is not a long provider TTL or an OS-display guarantee.

## RPC contract

All three new public functions are SECURITY DEFINER, owned by the NOLOGIN,
NOBYPASSRLS manager, with fixed `pg_catalog` search path. Only authenticated may
execute them; owner comes from the existing JWT gateway identity predicate.
Anon, service_role, sender and runtime cannot execute management RPCs.

### `cap_notifications_publish_v2`

Arguments: `p_binding_id uuid`, `p_generation bigint`, `p_expected_revision bigint`,
`p_preference_revision bigint`, `p_protocol text`, `p_engine_identity text`,
`p_digest_version text`, `p_timezone text`, `p_entries jsonb`.

Identity constants remain `CAP_PUSH_V1`, `cap-reminder-v1`, `hmac-sha256-v1`.
The bounded JSON array is a complete atomic binding snapshot. Each entry has
exactly these string-valued keys (no financial text or arbitrary JSON):

```text
candidate_digest       64 lowercase hexadecimal characters
obligation_digest      64 lowercase hexadecimal characters
time_basis             wall | absolute
eligible_local_date    YYYY-MM-DD
local_time             HH:mm, 00:00 through 23:59
timezone               accepted IANA timezone or UTC
send_after             explicit UTC ISO timestamp ending Z
expires_at             explicit UTC ISO timestamp ending Z
```

The client derives notification-only HMAC identities and UTC instructions from
local financial truth. SQL validates scheduling metadata, never financial dates.
The candidate identity excludes mutable due time, revision and generation; the
obligation identity supports rejecting two reminders for the same obligation at
the same UTC instant. Different times remain permitted. Recurring obligation
continuity must be explicit in the future compiler, not merchant-text matching.

All wall entries must use `p_timezone`. Successful publication acknowledges it as
the binding's `notification_timezone`; absolute entries retain their own creation
timezone independently. Offline timezone changes cannot modify that remote value.

Success advances revision and negotiates `bindings.scheduling_contract = 2` in
the same transaction. There is no separate destructive upgrade call. A failed
snapshot does not change rows, receipts, revisions or negotiated version. Legacy
v1 publication remains available on v1 bindings, but cannot downgrade v2 bindings.
Registration and invalidation retain their existing fenced lifecycle semantics.

Return: binding/generation/contract/revisions, acceptance time, entry count and
exact acknowledged occurrences including UTC instants, timezone/local context and
delivery state. `dispatch_ready` is false: Phase 2A does not activate delivery.
Acknowledgment of storage is not a claim that the sender is operational.

### `cap_notifications_schedule_readback_v2(binding, generation)`

Owner-scoped authoritative reconciliation of exact revision and occurrences,
including receipt state. Binding lock serializes readback with replacement and
invalidation. An unknown publication response is resolved by readback; callers
must not blindly advance local revision. No endpoint, browser keys or financial
content is returned.

### `cap_notifications_readiness_v2()`

Authenticated contract readiness, explicit horizon/expiry/DST policy, and the
unchanged dark background/runtime flags. V1 readiness continues to describe v1.

## Timezone and DST

Wall/relative times use the last remotely acknowledged notification timezone.
Every wall entry must match the database's expected UTC resolution:

* **Gap:** reject. A round trip explicitly detects PostgreSQL's automatic
  normalization; a gap invalidates the entire atomic publication.
* **Fold:** choose the later matching UTC instant. The resolver compares offsets
  in the surrounding 48 hours on either side, including non-hour/negative-DST
  transitions, and selects the maximum matching instant. Earlier expected UTC
  is rejected. Resolution is independent of session timezone.

For a new/edited absolute original selection, the same resolver validates gap/fold
policy. An unchanged accepted absolute entry retains its UTC instant without
re-resolving it during later publication. Device or notification timezone changes
do not rewrite its accepted context. This phase supplies no custom-selection UI
or client resolver; those remain future work.

## Locking, receipts, capacity and privacy

Publication takes the binding lock before any schedule mutation. Runtime retains
`binding FOR UPDATE -> authoritative schedule SELECT -> ledger FOR UPDATE`.
Schedules remain SELECT-only for runtime; no dummy UPDATE privilege or lock helper
is added. Management ledger privileges remain SELECT/INSERT only.

Publication is busy while any receipt is claimed/dispatch_started; recovery must
resolve it first. Replacement never resets terminal receipts. Removing/readding
or editing the same identity does not revive delivery. No cancellation promise
is made after committed `start_dispatch`.

Existing caps remain: 1000 entries, 256 KiB JSON, 1000 accumulated ledger identities
per binding. Capacity failure is atomic and explicit, never silent truncation.
No protected-receipt pruning is introduced. Ledger lifecycle/capacity expansion is
separate reviewed work; 365-day coverage is subject to explicit admission limits.

Remote storage is notification metadata only: no merchant, amount, raw financial
ID, title, description or financial record scanning. The encrypted payload remains
exactly `protocol`, `type`, `version`, `installation_id`, `binding_id`, `generation`,
`expires_at`. Sender login and VAPID isolation remain unchanged.

## Future client/product obligations (not implemented)

Compile finite recurrence coverage, including leads falling inside the horizon
for obligations just beyond it. Canonical default time, inherited/overridden
relative rules, multiple reminders and fixed absolute instants remain the accepted
client model. Do not claim infinite recurring scheduling.

* Local/offline new intent: "Pending sync — not yet scheduled".
* Exact remotely acknowledged occurrence: "Scheduled" only when delivery is
  enabled/ready; it is not an OS-delivery guarantee.
* Offline edit: "Change pending — previous schedule still active".
* Offline cancel: "Cancellation pending — may still notify".
* Beyond 365 days: "Saved on this device — not scheduled for background delivery.
  Open Cap within 365 days of the reminder to schedule it."
* Capacity/subscription/enrollment failure: explicit action required.
* Recurrence: expose last acknowledged coverage date, not unlimited coverage.

Previously acknowledged instructions survive offline absence. Payments,
cancellations and due-date changes elsewhere cannot be detected without a
notification invalidation signal. Reconcile when the client returns. Online
sign-out attempts existing invalidation/unsubscribe; offline sign-out cannot
guarantee remote cancellation. Generic remote copy mitigates stale/private detail.
Future Cron invokes the sender only, never recomputes financial reminders.

## Migration and rollback

Existing v1 rows retain exact expiry and receipts; added fields default to v1.
No silent lease extension. Explicit v2 publication is required for upgrade.
Do not edit/apply historical artifacts to introduce this successor.

Operational rollback should stop admitting new v2 publications while retaining a
compatible path to honor accepted instructions. Never restore a seven-day check
by silently deleting/truncating long-range rows. Full schema rollback requires
draining or explicit invalidation first and is not transparent. Emergency parking
suspends delivery and needs later client reconciliation; it cannot recall a
committed dispatch. No activation/rollback automation is introduced here.

## Local validation

Run `node tests/notifications-scheduling-sql.cjs --static` for source/frozen-file
checks. The real PostgreSQL suite reuses `tests/helpers/sender-pg.cjs` with external
`CAP_PG_BIN`, `CAP_PG_PATH` and the approved external `CAP_TEST_TEMP`. It creates a
fresh loopback-only synthetic cluster and stops it in the existing helper's
finally block. It refuses non-loopback/non-synthetic database URLs.

Deterministic calendar tests use an unexposed test-only publication clone with a
fixed acceptance clock; production RPC bodies/constraints and dark flags are not
relaxed. Real installer, RPC ACLs, transactions and RLS are exercised locally.

### Certification results

**LOCAL POSTGRES CERTIFICATION:** PostgreSQL **17.6**, x86_64 Windows,
MSVC 19.44.35213, 64-bit. The project-approved native fresh-cluster helper was
used. Local Docker version/image discovery worked, but subsequent image inspection
timed out (60/120 seconds); no Docker container or newer-minor certification was
completed, and no machine configuration was changed to force it.

**PRODUCTION-MINOR COMPATIBILITY NOT YET CERTIFIED.** Local 17.6 results do not
certify an exact deployed minor. No production contact occurred to close this gap.

| Validation | Result |
| --- | --- |
| Scheduling V2 static + real PostgreSQL successor suite | **38 PASS** |
| Historical sender real PostgreSQL suite, unchanged | **31 PASS** |
| Historical foundation SQL, disposable PGlite | **69 PASS** |
| Historical enrollment amendment SQL, disposable PGlite | **21 PASS** |
| Existing notification engine unit suite | **61 PASS** |
| Existing seven-field payload/Web Push Deno suite, cached/no network | **5 PASS** |
| Existing dark Edge handler Deno unit suite (not actual Edge runtime certification) | **1 PASS** |
| Active release/security gate | **4 PASS**, protections unchanged |
| JS/new-test syntax, manifest/vercel JSON, tracked diff whitespace | **PASS** |

The unchanged `tests/notification-enrollment.cjs` additionally produced **10 PASS,
1 FAIL**: its final historical A8 assertion pins `cap-shell-v369`, while the
legitimate current worker is `cap-shell-v375`. This pre-existing mismatch is not
fixed, skipped or relabeled PASS. Neither the historical test nor the worker was
modified. All other original working files retain their baseline bytes.

The v2 suite proves both real live-clock publication and simulated runtime time
advancement: an acknowledged 45-day instruction cannot be claimed early, becomes
claimable/dispatchable without republication, and keeps the original publication
timestamp and short permit TTL. Runtime simulation uses an unexposed test-only
clone, not enabled production functions. Existing receipt, generation/revision,
expiry, lock and invalidation boundaries remain enforced. The real runtime still
returns parked and its sender role remains NOLOGIN after certification.

The 297 original files, substituting only the pre-change security gate in memory,
retain baseline aggregate SHA-256
`6bd1f23a71f5d4c8b9e331a83818dcdd2a08f3e31e7264ee29e606a3b5e40ec9`.
The worker retains raw SHA-256
`E4A5B68B08CD5B48A04B9C9B2F1B030F023557B16BF3656121467B396A377E1D`.

## Release-gate amendment

Only these three exact paths are appended to `tests/cloud-pull-security.cjs`:

* `supabase_notifications_scheduling_v2.sql`
* `docs/notification-scheduling-amendment.md`
* `tests/notifications-scheduling-sql.cjs`

All previous allowed paths and every security/deny assertion remain unchanged.
No wildcard, directory exemption, reduced count or unknown-file bypass is added.
