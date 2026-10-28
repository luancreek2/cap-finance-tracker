# Phase 5B.1 — notification-only foundation (production installed, parked)

**Phase 5B.1 does not send push notifications.** The reviewed foundation was
manually installed in production on 2026-10-28 from the SHA-verified artifact
and remains parked; see **Production installation record** below. No enrollment
UI, PushManager subscription, VAPID key, Edge Function, sender, cron job,
pg_cron or pg_net installation is included. Phase 5A remains the running
application at shell **cap-shell-v368**.

## Evidence and production boundary

The owner supplied a completed read-only production preflight: Cap is healthy on
PostgreSQL 17.11; the three dedicated financial reader/writer roles and two
private schemas exist; Cap tables have RLS; anon/authenticated have zero direct
Cap table grants; PUBLIC/anon have zero Cap RPC execution; the existing nine
intentional authenticated RPCs are retained. pgcrypto 1.3, supabase_vault 0.3.1
and uuid-ossp 1.1 are installed. pg_cron 1.6.4 and pg_net 0.20.4 are available
but not installed; cron/net schemas and deployed Edge Functions are absent.
Vault exists and is inaccessible to browser roles. No material blocker was
reported. This paragraph records the pre-installation evidence supplied for
review; the live preflight and post-installation verification are recorded below.

Existing SECURITY DEFINER advisor warnings, disabled leaked-password protection
and performance recommendations predate this work and are not changed here. The
production installation added only the five expected notification SECURITY
DEFINER notices; see the production record below.

The managed Supabase migration registry has **zero tracked migrations**, despite
the existing production database, and remains empty after the 2026-10-28
installation. It was intentionally **not** retroactively modified; the foundation
identity is recorded in the schema COMMENT and the private `control` row instead.
Do not reapply/reconstruct existing migrations, reset history, or mark old
migrations applied.

### Exact proposed migration and tracking

Review the entire root artifact **`supabase_notifications_foundation.sql`**.
Identity: **`CAP_NOTIFICATIONS_FOUNDATION_5B1_V1`**. Before applying, separately
approve its exact SHA-256, installer identity and preflight/postflight results.
The proposed initial tracking is an isolated, manually reviewed installation:

* schema COMMENT records the notification migration identity;
* the private singleton `control.migration_id` records the same identity;
* the operator records approved file SHA-256, execution time and postflight in
  the change record; a later approved Git commit records the reviewed artifact.

This file does not read, write or baseline `supabase_migrations` history. Adoption
of managed migration tracking is a separate explicit decision; this migration
does not claim such a registry entry will exist.

It is a guarded **first-install transaction**, not `CREATE OR REPLACE` or an
idempotent state-resetter. A rerun/collision fails before creating anything.
After separate DDL approval only, the SQL session must explicitly set
`cap.notifications_install` to `reviewed-5b1-v1`; there is no default approval.
The installer needs the usual reviewed Cap ownership/CREATEROLE capabilities,
schema/database creation rights and REFERENCES on auth.users. The artifact does
not add grants to managed Auth objects or change existing financial roles/RPCs.
Missing prerequisites are blockers, not permission to relax them.

## Production installation record

Status: **manually installed and parked**. The production foundation was
installed on 2026-10-28 from the exact reviewed artifact; no Phase 5B.2
capability is present.

* Artifact: `supabase_notifications_foundation.sql`
* Approved/installed SHA-256:
  `7126F10B3699F2A54B216A3045E92E5EF7CB3405C89BB25E80BCDB913BD9443B`
* Installation guard: `cap.notifications_install = 'reviewed-5b1-v1'`
* Result: transactional success (`Success. No rows returned`); the approved body
  was not edited, and the guard was prepended only for the installation session.
* Identity: `CAP_NOTIFICATIONS_FOUNDATION_5B1_V1`; protocol `CAP_PUSH_V1`;
  engine `cap-reminder-v1`; digest `hmac-sha256-v1`.
* Catalog: 5 private tables with RLS and FORCE RLS, 10 functions (5 public RPCs
  plus 5 private helpers), 5 owner policies, 59 constraints and 10 indexes;
  roles `cap_notification_manager` and `cap_notification_runtime`.
* Privileges: only `authenticated` can execute the five public RPCs; anon,
  PUBLIC, service_role and the parked runtime have none. Runtime has no
  private-schema, table or helper access.
* Delivery: `background_enabled=false`, `background_ready=false`,
  `runtime_parked=true`, 168-hour maximum and 09:00 local delivery.
* Production state: zero bindings, schedules, ledger rows and endpoint
  reservations; pg_cron/pg_net absent; no Edge Functions, VAPID key, sender or
  push subscription.
* Registry: the Supabase managed migration registry remains empty and was
  intentionally not modified.
* Financial boundary: all 13 financial tables, rows, RPCs and role definitions
  are unchanged. The only pre-existing-object ACL change is the approved
  `USAGE` (no `CREATE`) grant on schema `public` to `cap_notification_manager`.
* Advisors: 10 pre-existing warnings before installation; 15 after, the five new
  ones being the expected SECURITY DEFINER notices for the five public
  notification RPCs. No advisor finding was auto-fixed.

The production platform (`supabase_admin`) grants `postgres` an ADMIN membership
on every new `cap_` role, including the three pre-existing financial roles. This
is a Supabase install-shape artifact, not a grant to a browser or financial role;
`postgres` already owns the installed objects.

## Locked product/security decisions

* Candidates come from the unchanged Phase 5A engine, not SQL recurrence/payment
  logic. No financial rows are read by notification management functions.
* Each browser/PWA installation is independent. No account-global subscription,
  schedule or read-state synchronization is introduced.
* Notification preferences remain device-specific, outside financial
  `user_preferences`, baseline, outbox, conflicts and migration mappings.
* A publication expires in at most **168 elapsed hours (seven days)** from the
  server publication statement timestamp. A replacement needs a fresh explicit
  request; neither reads nor retries renew the lease.
* Default future remote text is fixed: **Cap reminder** / **Open Cap to review
  your reminders.** Readiness reports this contract copy; it is not a sent payload.
* No merchant/bill/account names, amounts, numbers, balances, net worth,
  transaction history/descriptions, raw financial source IDs or notification
  bodies are accepted into schedules/ledger.
* Future ambiguous dispatch outcomes are terminal `unknown`, not blind retries.
  Phase 5B.1 provides storage constraints only, not a dispatch state machine.

## Objects proposed

Private schema: **`cap_notifications_private`**, owned by the reviewed installer.
Browser roles and service_role have no USAGE or direct private-table privileges.

### Roles

* `cap_notification_manager`: NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS,
  NOCREATEDB, NOCREATEROLE, NOREPLICATION; owns the five notification public RPCs,
  not their tables or schema. No financial grants or role memberships.
* `cap_notification_runtime`: same restricted flags; **parked**, with no schema,
  table, helper or management-RPC access. No LOGIN/password is created. Later
  claim/result/retirement capabilities require their own reviewed migration.

Supabase-compatible temporary membership in the new manager role and CREATE on
`public` permit ownership transfer by a non-superuser installer. Both are revoked
before the final postflight. No membership/grant for an existing financial role
is changed. Existing `cap_role_boundary_ok` has an explicit financial-role name
allowlist, so it is deliberately not widened; notification checks are separate.

### Tables and constraints

| Table | Purpose and enforced boundaries |
|---|---|
| `control` | One singleton, exact migration/protocol constants, 09:00 time, 168-hour maximum; `background_enabled=false` is enforced by CHECK |
| `endpoint_owners` | SHA-256 endpoint fingerprint PK; owner FK to auth.users; unique owner/fingerprint; reservations survive replacement/disable |
| `bindings` | Server UUID PK; owner/install unique; owner/id unique; endpoint fingerprint unique and owner-qualified FK; positive generation, nonnegative revisions; endpoint/key encoding checks |
| `schedules` | Owner/binding/digest PK; owner-qualified binding FK; known protocol/engine/digest versions; positive generation/revision; explicit timezone/local date; exact 09:00 UTC conversion; finite bounded publication/expiry |
| `delivery_ledger` | Owner/binding/digest PK across generations/revisions; owner-qualified binding FK; bounded attempts, claim/result timestamps and enumerated states/failures; accepted/ambiguous/dispatch consistency checks |

All five tables have **ENABLE and FORCE ROW LEVEL SECURITY**. They are not in
public. Owner deletion cascades only notification-owned records through Auth FK
relationships. There are no FKs to financial rows.

Indexes are the nine PK/UNIQUE backing indexes plus explicit
`schedules_eligibility_idx(send_after, expires_at)`. No financial index changes.
The synthetic PostgreSQL 17 catalog contains **59 CHECK/FK/PK/UNIQUE constraints**.
Breakdown: 45 CHECK, 5 foreign keys, 5 primary keys and 4 UNIQUE constraints.
Their exact names and definitions are inspectable from the SQL
and the catalog-only inventory query below.

Binding states: `pending`, `disabled`, `retired`. There is intentionally no
`active` state yet, and `last_confirmed_at` must remain NULL. VAPID key version
is the literal placeholder `unconfigured`; there is no public/private VAPID key.
Prepared schedules have only `state='prepared'`, not a runnable dispatch state.

Ledger states: `queued`, `claimed`, `dispatch_started`, `retry_wait`, `accepted`,
`unknown`, `retired`, `suppressed`. Failure classes: `temporary_rejection`,
`ambiguous`, `invalid_subscription`, `configuration`, `expired`, `disabled`.
Management can SELECT/INSERT ledger entries but cannot UPDATE/DELETE receipts.
Republication does not reset attempts, accepted state or unknown outcomes.

Operational admission caps: 20 bindings per owner, 256 reserved endpoint hashes
per owner, 1,000 entries per publication/ledger per binding and 256 KiB per entry
array. Capacity exhaustion rejects the request, never erases deduplication data.
No automatic retention cleanup is implemented yet. These are notification-only
caps, not changes to Phase 5A's local history behavior.

### Exact authenticated RPC surface

All public RPCs are SECURITY DEFINER owned by `cap_notification_manager`, with
fixed `search_path=pg_catalog`, qualified application references, explicit owner
filters and RLS. None accepts user_id. PUBLIC, anon and service_role execution is
revoked. Only authenticated receives EXECUTE on these five new signatures:

```text
cap_notifications_register_v1(
  p_installation_id uuid, p_expected_generation bigint, p_protocol text,
  p_endpoint text, p_p256dh text, p_auth text, p_vapid_key_version text,
  p_browser_expiration timestamptz DEFAULT NULL) -> jsonb

cap_notifications_publish_v1(
  p_binding_id uuid, p_generation bigint, p_expected_revision bigint,
  p_preference_revision bigint, p_protocol text, p_engine_identity text,
  p_digest_version text, p_timezone text, p_valid_until timestamptz,
  p_entries jsonb) -> jsonb

cap_notifications_invalidate_v1(
  p_binding_id uuid, p_generation bigint, p_expected_revision bigint,
  p_disable boolean) -> jsonb

cap_notifications_summary_v1() -> jsonb
cap_notifications_readiness_v1() -> jsonb
```

Register creates or replaces **pending** metadata only. Expected generation zero
means new; replacement requires the current generation, increments it, advances
the schedule revision and clears old work. It does not reset receipts. An
owner-scoped transaction advisory lock serializes first registration and capacity
checks; endpoint uniqueness/ownership reservations protect concurrent users.

Publish locks the owned binding, requires its exact generation/current revision,
rejects older preference revisions and atomically replaces all prepared work.
The server generates the next revision and publication time. Full validation
precedes replacement; any failure rolls the entire request back. Changing
timezone/preferences does not rewrite financial dates.

Entry objects accept **exactly** `candidate_digest`, `eligible_local_date`,
`expires_at`. Unknown fields are rejected. The parent call supplies timezone and
known version tags. There is no arbitrary JSON metadata/content column.

Invalidate atomically clears prepared work and increments revision. With disable
true it also disables/increments the binding generation. It never deletes the
endpoint ownership reservation or ledger. Summary exposes only owned identifiers,
generations, states, revisions and lifecycle timestamps, not endpoint/key/hash
material. Readiness exposes no user financial/endpoint data.

### Private helpers

Five SECURITY INVOKER, fixed-search-path functions are owned by the schema
installer; only the manager has EXECUTE:

* `request_owner() -> uuid`
* `valid_timezone(text) -> boolean`
* `valid_keys(text,text) -> boolean`
* `valid_endpoint(text) -> boolean`
* `contract_ok() -> boolean`

`request_owner` requires the gateway's authenticated role plus validated
`request.jwt.claims` role/sub. These GUCs are trusted **only behind PostgREST's JWT
validation**. They are not authentication for arbitrary SQL clients. No browser
SQL execution or privileged credential is introduced. Existing Cap identity/RPC
function grants and bodies are unchanged.

### Exact table privileges and RLS policies

| Table | Manager privileges | Policy |
|---|---|---|
| control | SELECT | `control_manager_read`: SELECT, singleton |
| endpoint_owners | SELECT, INSERT | `endpoint_owner`: own user_id USING/WITH CHECK |
| bindings | SELECT, INSERT, UPDATE | `binding_owner`: own user_id USING/WITH CHECK |
| schedules | SELECT, INSERT, DELETE | `schedule_owner`: own user_id USING/WITH CHECK |
| delivery_ledger | SELECT, INSERT | `ledger_owner`: own user_id USING/WITH CHECK |

No table/column rights go to authenticated, anon, PUBLIC, service_role or the
parked runtime. No generic REST table path is enabled. No new function performs
generic dynamic SQL; the two installer membership operations only quote the
trusted current installer identifier. No default ACLs are globally rewritten.

`contract_ok` checks roles/memberships, schema access, forced RLS, exact owner
policies, function ownership/search paths/execute boundaries, absence of financial
table/column privileges and forbidden manager receipt/control privileges.
Mutators and summary fail closed when that check fails. Readiness reports
`foundation_ready` separately from permanently false `background_ready`.
It is an operational catalog guard, not a cryptographic attestation against a
malicious database administrator replacing SQL definitions.

## Versioned opaque identity contract

* Protocol/binding/schedule/future payload contract: `CAP_PUSH_V1`.
* Authoritative local identity format: `cap-reminder-v1`.
* Remote candidate digest: `hmac-sha256-v1`, lowercase 64-character hex.
* Unknown protocol/engine/digest tags fail closed. Future incompatible revisions
  need an explicitly reviewed migration; no silent reinterpretation.

Future client mapping (not implemented in 5B.1):

```text
message = UTF8("cap-push-digest-v1\0" + lowercase(ownerUUID) + "\0"
               + lowercase(installationUUID) + "\0" + exactPhase5ACandidateId)
candidate_digest = lowercaseHex(HMAC-SHA256(installationDigestKey, message))
```

The future installation digest key is 32 random bytes, kept only in a separate
notification-only local store and shared with the worker for reconciliation.
It is **not a VAPID key**, not sent to the server, and not generated here. The
test vector uses fixed synthetic bytes only. Do not hash titles, amounts or
financial bodies. Binding replacement retains installation/digest continuity;
generation fences requests, not independent deduplication identities.

The server validates digest syntax and ownership/binding/revision boundaries,
not whether a digest genuinely corresponds to an engine candidate: opaque
digests do not attest financial truth. That remains the future client compiler's
responsibility. Authenticated owners can manage their own pending installations;
cryptographic endpoint possession, local dataset-owner confirmation, receipts,
binding activation and account-switch UI belong to later phases.

## Endpoint and key safety

Fingerprint is `SHA256(UTF8(exactEndpoint))`, stored privately, never returned as
a public identifier. Retained reservations block cross-owner reuse even after
replacement/disable. A reinstall cannot silently steal an old installation's
endpoint; an explicit later lifecycle/recovery contract is required.

The single IMMUTABLE, SECURITY INVOKER `valid_endpoint(text)` helper is used by
both the `bindings.endpoint` CHECK and registration RPC. Its fixed search path
is `pg_catalog`; only the manager receives EXECUTE (in addition to the trusted
installer's inherent ownership rights). PUBLIC, anon, authenticated, service_role
and the runtime are explicitly denied. `contract_ok()` verifies its presence and
the existing private-helper owner, invoker, search-path and execute boundaries;
loss of manager EXECUTE also fails readiness closed.

HTTPS destinations are restricted to exactly `fcm.googleapis.com`, exactly
`updates.push.services.mozilla.com`, and DNS-label subdomains of `push.apple.com`
or `notify.windows.com`. Multiple subdomain labels are permitted only within
those last two families. Bare Apple/WNS parent hosts are not accepted. WNS forms
such as `wns2-sg2p.notify.windows.com/w/?token=...`,
`db5.notify.windows.com/w/?token=...` and
`dm3p.notify.windows.com/?token=...` are supported with HTTPS.
Host labels must be syntactically valid lowercase DNS labels. Endpoint strings
retain the maximum length of 4096 characters. Userinfo, all explicit ports,
fragments, localhost/IP literals, lookalike suffixes, unrelated provider hosts,
whitespace and malformed percent escapes are rejected. The path/query permits
the existing conservative token alphabet and well-formed percent encoding.
No URL normalization or endpoint/key disclosure was added.
This foundation performs no HTTP requests. Future sender review must
also validate destinations and redirects/DNS behavior at dispatch time.

Key validation checks canonical base64url format, 65-byte uncompressed p256dh
prefix and 16-byte auth size. It does not prove EC point validity or endpoint
possession. A pending registration is not evidence of enrollment. Future sender
and confirmation work must validate cryptography and possession explicitly.
Do not log parameters/endpoints/keys in application diagnostics. Review external
gateway/database logging settings before actual enrollment; RPC bodies carry
sensitive subscription material even though responses are redacted.

## Timezone, delivery and freshness

Timezone must be an explicit name present in PostgreSQL's IANA tzdata view, with
UTC allowed and path-style IANA/alias names accepted. Numeric offsets, short
abbreviations and posix/right trees are rejected. No UTC offset is hardcoded.
`send_after` is derived server-side from local date **09:00 AT TIME ZONE zone**.
Expiry must be later than send/publication, no later than the next local midnight
and no later than publication validity. This deliberately limits a dispatch slot
to its eligible local day. Publishing after 09:00 can retain a same-day catch-up
slot until expiry; the SQL does not create a new financial reminder stage.

Parent validity is at most seven elapsed days from server publication, not seven
server-local calendar days. Expired work cannot become runnable in this phase;
future claim APIs must recheck current binding/generation/revisions and both
expiry/lease at claim and before dispatch. No automatic extension or fallback
sender exists. Future schedule compilation should choose a shorter validity if
its source snapshot is stale. Offline changes cannot invalidate remote work until
communicated: the seven-day limit is a bound, not proof of financial freshness.

## Kill switch and deferred execution

The persisted server switch defaults OFF and a CHECK prohibits ON in 5B.1.
Bindings cannot become active, confirmation timestamps cannot be set, schedules
cannot become dispatchable, and runtime has zero access. Enabling actual push
therefore requires a separate capability migration, not flipping a boolean.
Readiness always reports `background_enabled=false`, `background_ready=false`,
`runtime_parked=true`. No function claims or dispatches work. The ledger's claim
token/attempt/result fields are a later state-machine contract, not a sender.

Future scheduling remains Supabase Cron -> restricted Edge sender, with narrow
invocation credentials. pg_cron/pg_net/Vault settings and secrets are untouched.

## Validation and rollback boundary

`tests/notifications-foundation-sql.cjs` executes the exact migration in disposable
PGlite by default. Optional real PostgreSQL testing requires explicit
`CAP_NOTIFICATION_REAL_PG=synthetic-only`, a loopback URL whose database is named
`cap_notifications_synthetic_*`, and `CAP_PG_PATH` pointing to an external pg
driver. That database/cluster must be disposable and fresh. It never contacts
Supabase or uses real financial data. Real PG additionally tests a non-superuser
database-owning installer and two simultaneous publication sessions.

`tests/sql/notifications-foundation-audit.sql` is a read-only, catalog-only exact
inventory of roles, memberships, tables/columns, constraints, indexes, policies,
function owners/signatures/ACLs and financial privilege violations. It reads no
endpoint, key, auth/session, Vault secret, schedule or financial rows. It neither
installs anything nor grants readiness by itself.

Tests cover guarded install/replay, late rollback after function ownership
transfers, cross-owner denial, hidden endpoints, unknown versions, seven-day
boundary (+1 microsecond rejection), expiry, malformed data, CAS, DST, disabling,
generation fencing, ledger uniqueness/preservation, privilege drift and negative
financial privileges. Financial records/ACLs/RLS/role definitions and existing
functions are fingerprinted before/after. PGlite is not counted as real concurrent
execution; the optional real runner explicitly tests two sessions.

Before production approval, the catalog preflight was refreshed and the complete
SQL, file hash and inventory were reviewed; that approval was completed on
2026-10-28. Missing required privileges or material drift means STOP, not
modifying financial grants. Synthetic results alone do not authorize live DDL.

A failed migration rolls back its schema, functions, tables, policies, grants,
roles and temporary memberships. Tests inject a failure at final postflight.
For a successfully applied but still dormant foundation, a later separately
reviewed rollback may remove only these notification objects/roles after checking
dependencies and preserving any notification receipts. Do not use broad DROP
CASCADE or touch financial migrations/history. No destructive rollback SQL is
shipped or executed here. No Phase 5B.2 work is included.

### Recorded local review validation

| Execution | Result |
|---|---:|
| Notification foundation, disposable PGlite / PostgreSQL 17.5 WASM | 69 passed |
| Same foundation, isolated PostgreSQL 17.6 | 70 passed |
| Existing Phase 6O transaction SQL regression | 23 passed |
| Existing RPC-only client contract | 10 passed |
| Existing Phase 5A notification pure rules | 61 passed |
| Existing Phase 5A notification browser suite, including actual worker offline reload | 68 passed |

The extra real-PG case uses two simultaneous clients with the same expected
publication revision and proves exactly one succeeds. Real-PG installation and
late rollback also run as non-superuser `postgres` with CREATEROLE/BYPASSRLS,
database/schema ownership and explicit fixture Auth REFERENCES, rather than as
the bootstrap superuser. These are disposable synthetic fixtures, **not** live
Supabase 17.11 or an assertion of its precise installer privileges.

JavaScript syntax checks and manifest/vercel JSON parsing passed. Existing
tracked files remained byte/content unchanged in Git; only the four new review
artifacts were added locally. Synthetic PostgreSQL servers were stopped. At the
time of that local validation, no production migration, installation or catalog
mutation had been performed; the later approved production installation is
recorded above. No actual push, VAPID key, extension or scheduler was created by
this work.

### Edge/WNS endpoint compatibility review

The endpoint regex now exists only in the private helper, not separately in the
table and RPC. The object inventory becomes **10 functions**: five public RPCs
plus five private helpers. Tables, indexes, constraints, policies and existing
financial privileges are unchanged.

The endpoint test matrix compares helper results with actual table CHECK and
authenticated registration acceptance/rejection across **33 endpoint cases**.
Each table/RPC case is rolled
back so synthetic cases do not consume installation slots or leave keys behind.
It includes FCM, Mozilla, Apple, nested Apple, regional/short/root-query WNS,
nested WNS, forbidden schemes/hosts/credentials/ports/fragments, malformed URLs,
and the exact 4096/4097-character boundary. Separate tests inject helper execute
and SECURITY DEFINER drift and verify fail-closed readiness/management behavior.
