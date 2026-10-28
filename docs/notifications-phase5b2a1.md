# Phase 5B.2A1 — versioned VAPID enrollment contract amendment

**Status: applied to production exactly once on 2026-10-28 and verified.** The
reviewed V1 artifact was attempted once in production and failed closed before
commit; its transaction rolled back completely and V1 was never retried. V2
(`CAP_NOTIFICATIONS_ENROLLMENT_5B2A1_V2`) is the corrected amendment and is now
the installed production VAPID contract. Phase 5B.2B enrollment remains dark and
unstarted. No VAPID key pair, PushManager subscription, notification permission
request, frontend enrollment code, service worker push handler, Edge Function,
pg_cron/pg_net installation or Web Push send is part of this amendment.

This phase changes exactly one contract assumption identified by the Phase 5B.2A
architecture audit: the foundation's placeholder VAPID version made a truthful
real subscription impossible to register.

## Review history

* Amendment identity V1: **`CAP_NOTIFICATIONS_ENROLLMENT_5B2A1_V1`**
* Artifact V1: `supabase_notifications_enrollment_5b2a1.sql`
* SHA-256 V1: `CB597A5D1D47A90EEFF8B5E336C68540CC0A98B86DFBFB7693B79BADFF2A3364`
* V1 was reviewed, then applied once in production and failed with
  `ERROR 42501: must be owner of function cap_notifications_register_v1`.
* The entire V1 transaction rolled back. No production mutation survived: the old
  CHECK and predicate, zero binding/endpoint/schedule/ledger rows, control
  identity, background flags, financial fingerprints and readiness were verified
  unchanged after the failure.
* Cause: production `postgres` owns the private tables but
  `public.cap_notifications_register_v1` is owned by `cap_notification_manager`.
  The platform-created membership `postgres <- cap_notification_manager` is
  `ADMIN true, INHERIT false, SET false` from `supabase_admin`; it is not usable
  for `CREATE OR REPLACE` ownership checks.
* V1 remains preserved verbatim as the record of the failed reviewed attempt. It
  is **superseded, rolled back and must not be applied**. It must not be treated
  as applied or overwritten, and its preserved SHA-256 must not be changed (for
  example by appending a warning) because that would destroy the audit record.
  The warning lives here in documentation instead. **DO NOT APPLY
  `supabase_notifications_enrollment_5b2a1.sql`.**

## V2 identity and artifact

* Amendment identity: **`CAP_NOTIFICATIONS_ENROLLMENT_5B2A1_V2`**
* Artifact: `supabase_notifications_enrollment_5b2a1_v2.sql`
* SHA-256: `291AA08EBF3D867233235150DCCC5B038060E3DFC32D42C0B2DBB90FA6D444CA`
* Reviewed-install guard: `cap.notifications_enrollment_5b2a1 = 'reviewed-5b2a1-v2'`
* Foundation prerequisite: `CAP_NOTIFICATIONS_FOUNDATION_5B1_V1`
* Foundation artifact and approved SHA-256 remain unchanged:
  `7126F10B3699F2A54B216A3045E92E5EF7CB3405C89BB25E80BCDB913BD9443B`

V2 is a new, additive migration. It never edits or redefines
`supabase_notifications_foundation.sql`, and it does not change the reviewed V1
file. It is transactional, guarded, and fails closed on missing foundation,
installed bindings, identity/readiness drift, missing or drifted VAPID constraint,
drifted registration predicate, replay, unexpected installer membership, a
pre-existing `CURRENT_USER` grant, or a failed postflight.

The VAPID contract (`CHECK` expression and registration predicate) is
byte-identical to V1. V2 adds only the transactional installer membership
lifecycle required by the production ownership boundary.

This is intentionally **not** a backward-compatibility promise for
`'unconfigured'`. Production held zero bindings when the amendment was prepared,
so the contract transitions from the parked placeholder to real versioned VAPID
identities without migrating rows.

## Production application record

Status: **applied once and verified**. V2 is the installed production VAPID
contract; the foundation remains parked and background delivery stays off.

* Applied artifact: `supabase_notifications_enrollment_5b2a1_v2.sql`.
* Approved and applied SHA-256:
  `291AA08EBF3D867233235150DCCC5B038060E3DFC32D42C0B2DBB90FA6D444CA`. The hash
  was recalculated locally and again over the exact bytes submitted, and both
  matched before execution.
* Result: **applied exactly once, successfully**. The artifact body was not
  edited; only the approved guard
  `set cap.notifications_enrollment_5b2a1 = 'reviewed-5b2a1-v2';` was prepended
  for the single execution session. No statement was extracted, no `GRANT` was
  issued manually and no external privilege workaround was used.
* Execution was one atomic transaction. The temporary `CURRENT_USER` membership
  was created and removed inside it, and the original `supabase_admin` platform
  membership (`ADMIN true / INHERIT false / SET false`) was preserved and proven
  restored before `COMMIT`.
* Post-apply catalog: **no `postgres`/self-granted membership remains**; exactly
  one `cap_notification_manager -> postgres` membership exists, granted by
  `supabase_admin`. `contract_ok()` remained `true` after cleanup.
* Contract before: `CHECK ((vapid_key_version = 'unconfigured'::text))` and
  predicate `p_vapid_key_version is distinct from 'unconfigured'`.
* Contract after: `CHECK ((vapid_key_version ~ '^v[1-9][0-9]{0,2}$'::text))` and
  predicate `p_vapid_key_version is null or p_vapid_key_version !~ '^v[1-9][0-9]{0,2}$'`.
* Accepted: `v1`, `v2`, `v10`, `v999`. Rejected: `unconfigured`, `v0`, `v01`,
  `V1`, `v1000`, empty/whitespace/malformed values and `NULL`.
* The matrix was evaluated against the live constraint expression inside a
  rolled-back transaction; no binding row was created for testing and
  notification data remained empty (bindings, endpoint owners, schedules and
  delivery ledger all `0`).
* Function surface unchanged: eight arguments,
  `cap_notification_manager` ownership, `SECURITY DEFINER`,
  `search_path=pg_catalog`, `TimeZone=UTC`, `EXECUTE` only for
  `authenticated` (not `PUBLIC`, `anon`, `service_role` or the parked runtime).
  Endpoint/key validation, `request_owner()` derivation, generation/CAS,
  endpoint reservations, capacity limits, schedule invalidation, exception
  mapping and return shape are unchanged.
* Control identity unchanged: `CAP_NOTIFICATIONS_FOUNDATION_5B1_V1`,
  `CAP_PUSH_V1`, `cap-reminder-v1`, `hmac-sha256-v1`, 168-hour maximum, 09:00
  local delivery, `background_enabled=false`. Readiness remains
  `foundation_ready=true`, `background_ready=false`, `runtime_parked=true`.
  `control.migration_id` was deliberately **not** rewritten; the V2 identity is
  an audit/amendment identity, not a control-row value.
* Structure unchanged: five private tables with RLS and FORCE RLS, five owner
  policies, unchanged notification role definitions and schema privileges.
* Background infrastructure absent: no VAPID key or private secret (Vault secret
  count `0`), no sender, no scheduler, no `pg_cron`, no `pg_net`, no cron or net
  schema, zero Edge Functions, no PushManager subscription, no notification
  permission request and no Web Push request or send.
* Financial state unchanged: identical pre/post financial catalog fingerprint and
  identical digests for all 13 financial tables; zero financial write privileges
  for `cap_notification_manager` and `cap_notification_runtime`; zero
  notification-owned financial functions.
* Advisors: 15 warnings / 0 errors / 0 infos before and after, the same 15 items
  (14 intentional SECURITY DEFINER notices including the five notification RPCs,
  plus leaked-password protection). No new finding and nothing auto-fixed.
* Supabase managed migration history remains **intentionally untouched**. This
  project carries no CLI migration registry; nothing was baselined or rewritten.

### Financial fingerprint caveat

The historical 5B.1 preflight digest derivation SQL was not preserved, so it
cannot be reproduced exactly. A new explicit derivation was written for this
checkpoint and used **identically before and after** the V2 apply: a 325-part
catalog fingerprint plus one row digest per financial table. The 325-part
fingerprint is **not** directly comparable to the older 329-part value and no
such comparison is claimed. The valid non-regression evidence is:

* equality of the newly captured pre-apply and post-apply catalog fingerprint
  (`c65cb5d8f27d1061afb76e59bcce1a04`, 325 parts), and
* equality of all 13 newly captured row digests.

## Verified production baseline (read-only)

Before drafting, the live catalog was inspected read-only and matched the review
assumptions:

* `bindings_vapid_key_version_check` existed with
  `CHECK ((vapid_key_version = 'unconfigured'::text))`.
* `public.cap_notifications_register_v1` had the reviewed eight-argument
  signature, `cap_notification_manager` ownership, `SECURITY DEFINER`,
  `search_path=pg_catalog`, `TimeZone=UTC`, and accepted only `'unconfigured'`.
* Binding count: 0. Endpoint ownership reservations: 0.
* Five private notification tables and five public notification RPCs.
* `foundation_ready=true`, `background_enabled=false`,
  `background_ready=false`, `runtime_parked=true`, 168-hour maximum, 09:00 local
  delivery.
* Control identity: `CAP_NOTIFICATIONS_FOUNDATION_5B1_V1`, protocol
  `CAP_PUSH_V1`, engine `cap-reminder-v1`, digest `hmac-sha256-v1`.

Any difference is an installation blocker, not permission to improvise.

## Contract change 1 — bindings VAPID constraint

Before:

```sql
CHECK ((vapid_key_version = 'unconfigured'::text))
```

After:

```sql
CHECK ((vapid_key_version ~ '^v[1-9][0-9]{0,2}$'::text))
```

## Contract change 2 — registration predicate

Before, inside `public.cap_notifications_register_v1`:

```sql
p_vapid_key_version is distinct from 'unconfigured'
```

After:

```sql
p_vapid_key_version is null or p_vapid_key_version !~ '^v[1-9][0-9]{0,2}$'
```

Only that predicate changes. The function signature, body, `SECURITY DEFINER`,
owner, fixed search path, UTC session time zone, `request_owner()` derivation,
endpoint/key validation, generation/CAS checks, endpoint reservations, capacity
limits, schedule invalidation, exception mapping and return shape are preserved.
`CREATE OR REPLACE` preserves the existing owner and ACL; no new grant is issued
merely to recreate the function. The V2 `CREATE OR REPLACE` block is
byte-identical to the V1 block.

## V2 installer membership lifecycle

V2 runs one transaction:

1. `BEGIN`.
2. Approval guard for `cap.notifications_enrollment_5b2a1 = 'reviewed-5b2a1-v2'`.
3. Foundation, control identity, zero-binding, CHECK, predicate and replay
   preflight. `contract_ok()` is called here, **before** any temporary privilege.
4. Exact installer preflight. It requires all of the following and stops
   otherwise:
   * `current_user = postgres`;
   * a superuser `supabase_admin` role exists;
   * exactly one membership for
     `cap_notification_manager -> postgres`: grantor `supabase_admin`,
     `admin_option = true`, `inherit_option = false`, `set_option = false`;
   * no membership for that role/member pair granted by `current_user`.
5. Temporary membership, created inside the transaction and attributed to the
   installer:

   ```sql
   GRANT cap_notification_manager
     TO CURRENT_USER
     WITH ADMIN FALSE, INHERIT TRUE, SET TRUE
     GRANTED BY CURRENT_USER;
   ```

6. Replace the CHECK constraint with the versioned VAPID expression.
7. `CREATE OR REPLACE public.cap_notifications_register_v1` with the unchanged
   V1 body.
8. Remove **only** the temporary grant:

   ```sql
   REVOKE cap_notification_manager
     FROM CURRENT_USER
     GRANTED BY CURRENT_USER;
   ```

9. Restoration proof: no `CURRENT_USER`-granted membership remains; exactly one
   platform membership remains with grantor `supabase_admin`,
   `ADMIN true`, `INHERIT false`, `SET false`.
10. Postflight (ownership, ACL, security attributes, control row, surface, zero
    rows) and `contract_ok()`.
11. `COMMIT`.

The platform grant from `supabase_admin` is never revoked or modified. No broad
`REVOKE` is used. `contract_ok()` is not called while the temporary membership
exists, because the verifier correctly rejects that temporary shape; it is not
weakened. Any failure rolls back the CHECK replacement, the function replacement,
the temporary grant and every other transaction effect.

## Accepted and rejected versions

| Value | Result |
|---|---|
| `v1` | accepted |
| `v2` | accepted |
| `v10` | accepted |
| `v999` | accepted |
| `unconfigured` | rejected |
| `v0` | rejected |
| `v01` | rejected |
| `V1` | rejected |
| `v1000` | rejected |
| empty string | rejected |
| whitespace / leading or trailing space / newline | rejected |
| `v1.0`, `v-1`, `v001`, `v 1` | rejected |
| injection-shaped values | rejected |
| `NULL` | rejected |

A valid registration stores the exact accepted string in
`cap_notifications_private.bindings.vapid_key_version`.

## Privilege and boundary re-verification

The postflight fails closed unless all of the following remain true after
`CREATE OR REPLACE`:

* `authenticated` can execute `cap_notifications_register_v1`;
* `anon`, `service_role`, `cap_notification_runtime` and `PUBLIC` cannot;
* owner remains `cap_notification_manager`;
* `SECURITY DEFINER` remains true;
* fixed `search_path=pg_catalog` and `TimeZone=UTC` remain;
* exactly the existing two non-PUBLIC grantees remain;
* the temporary `CURRENT_USER` grant is absent;
* exactly the original platform membership remains
  (`supabase_admin`, `ADMIN true`, `INHERIT false`, `SET false`);
* the foundation control row is unchanged;
* the five private tables and five public notification functions are unchanged;
* `contract_ok()` remains true and is not weakened.

No notification table privilege and no financial schema, table, column, RPC,
role, policy or row is changed. Explicit tests cover zero financial privileges
for both notification roles.

## Platform audit corrections

### Capability detection

Feature-detect PushManager support by prototype membership:

```js
'pushManager' in ServiceWorkerRegistration.prototype
```

Do **not** evaluate `ServiceWorkerRegistration.prototype.pushManager` as a truth
test. The actual `PushManager` is obtained from a real
`ServiceWorkerRegistration` instance, not from the prototype property value.

### macOS Safari

Standards-based Web Push has been supported by Safari on macOS Ventura since
Safari 16.1 and generally does not require Add to Dock. Add to Dock web apps also
support Web Push on supported macOS versions. Older Safari/macOS combinations
outside that support envelope remain unsupported.

### iPhone and iPad

Keep both requirements: the site must be added to the Home Screen as a web app,
and notification permission must be requested from a direct user interaction.
Do not infer permission from installation alone.

### VAPID version wording

The foundation's `'unconfigured'` value was a parked placeholder, not a
supported enrollment identity. This amendment intentionally retires it because
production contains zero bindings. Future bindings use versioned identities such
as `v1`.

## VAPID key handling deferred

This phase does not generate a real VAPID key pair and does not lock the private
key serialization format. The sender phase will choose the Web Push library and
then finalize the exact private-key representation. The architectural
requirements remain:

* one stable production key pair per version;
* the public key may be shipped to the browser;
* the private key stays server-side only;
* the private key never enters Git, the browser, localStorage, IndexedDB or logs.

## Validation

* `tests/notifications-enrollment-v2-real-pg.cjs`: **18 checks against real
  PostgreSQL 17.6** on a disposable loopback database. The fixture builds the
  production role shape (bootstrap `supabase_admin` oid 10, restricted `postgres`
  installer, manager-owned function, platform membership
  `ADMIN true / INHERIT false / SET false`). It proves:
  * `CREATE OR REPLACE` fails with ownership error 42501 before a usable
    membership;
  * a temporary `CURRENT_USER` membership is usable, and its grantor-scoped
    revoke removes only that grant;
  * the platform membership is preserved before, during and after the amendment;
  * `contract_ok()` rejects the temporary installer shape and is not weakened;
  * failures before cleanup and after replacement/before commit roll back the
    temporary grant, the CHECK and the function;
  * the exact V2 artifact applies once and leaves `contract_ok=true`, parked
    readiness, zero notification data, restricted roles and the unchanged
    financial fingerprint.
* `tests/notifications-enrollment-sql.cjs`: 21 supplemental disposable-PGlite
  checks covering the VAPID accept/reject matrix, guard/replay/rollback,
  zero-binding precondition, constraint behavior, CAS and endpoint ownership,
  readiness/parked state, execution privileges, unchanged control/policies/roles,
  byte-level predicate diff, catalog audit and zero financial negative
  privileges.
* `tests/sql/notifications-enrollment-audit.sql`: read-only catalog audit. It
  reads no binding content, endpoint, key or financial rows.
* Existing Phase 5B.1 foundation suite: 69 checks.
* Financial transaction SQL regression: 31 checks.
* RPC-only client contract: 10 checks.
* Phase 5A notification rules: 61 checks.
* Phase 5A notification browser suite: 68 checks.

Synthetic and real-PostgreSQL results did not by themselves authorize production
DDL. Applying V2 required separate explicit approval of this artifact, its
SHA-256 and a fresh read-only production preflight; that approval was granted and
the artifact was applied once as recorded under **Production application record**
above.

## Rollback and production boundary

The V1 production attempt failed and rolled back as one transaction; no mutation
survived. V2 was applied once in production and committed atomically, including
the temporary installer membership removal. A successful amendment does not
enable background delivery, create a sender or alter financial behavior. Rolling
it back would require a separate reviewed artifact; no destructive rollback SQL is
shipped here. Production now runs the reviewed 5B.1 foundation with the V2 VAPID
contract, still `background_enabled=false`, `background_ready=false`,
`runtime_parked=true`, and remains so until a separately approved amendment is
applied.
