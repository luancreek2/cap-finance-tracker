# Phase 5B.2B — dark client enrollment machinery

**Status: implemented and verified locally; committed as the Phase 5B.2B
checkpoint and not deployed.**
Phase 5B.2B adds the client-side machinery that can enroll this browser for
background reminders, but it ships **dark**: the public VAPID configuration is
absent, so every enrollment surface is hidden and inert. No permission prompt,
no `PushManager.subscribe()`, no registration RPC and no push delivery can
happen in this phase.

Phase 5B.2A1 V2 remains the frozen, production-applied server contract. This
phase adds no DDL, DML, Edge Function, sender, cron job, `pg_cron` or `pg_net`.
Bounded client schedule publication and schedule lifecycle are deliberately
deferred to Phase 5B.4; sender dispatch belongs to Phase 5B.3 and automatic
Cron/invocation belongs to Phase 5B.5.

## Files

| File | Role |
| --- | --- |
| `js/vapid-public.js` | Public VAPID boundary. Ships `{}`; validates the reviewed public shape. |
| `js/notification-enrollment.js` | Capability evidence, state machine, notification-only IndexedDB, explicit enrollment/removal, bounded sign-out hook. |
| `js/production-rpc.js` | Four strict notification RPC wrappers; still RPC-only. |
| `js/supabase.js` | Transport allowlist, notification 4xx semantics, side-effect-free `authEvidence()`, verification/sign-out hooks. |
| `js/notifications.js` | Injects the background-reminder block into existing Settings. |
| `index.html` | Loads `vapid-public.js` before `production-rpc.js` and `notification-enrollment.js` after `notifications.js`. |
| `service-worker.js` | Shell `cap-shell-v369`; precaches both new modules. No `push` or `pushsubscriptionchange` listener. |
| `css/notifications.css` | Presentation-only `.cn-bg` block with 44px action targets and focus-visible treatment. |
| `docs/notifications-phase5b2.md` | This record. |
| `tests/notification-enrollment.cjs` | A1–A8 static/unit contract checks. |
| `tests/notification-enrollment-browser.cjs` | B1–B26 real-browser checks with fake push/session/RPC surfaces. |

No financial module, storage key, baseline, outbox, note, account record or
Cloud Sync contract is changed.

## Dark VAPID shipment

`CapVapidPublic.current()` returns the frozen empty object unless a host
explicitly injects `window.CAP_VAPID_PUBLIC`. The reviewed provisioned shape is:

```js
{
  version: 'v1',                 // ^v[1-9][0-9]{0,2}$
  publicKey: '...',             // unpadded base64url, 65 bytes, uncompressed point (0x04)
  fingerprint: '...',           // lowercase SHA-256 hex of the 65 public-key bytes
  createdAt: '2026-10-28T...Z'  // ISO timestamp
}
```

`inspect()` is synchronous and structural. `validate()` additionally imports the
raw point as a P-256 key (proving the point is on the curve and rejects a
degenerate/off-curve point with `VAPID_PUBLIC_KEY_INVALID`) and proves the
published fingerprint is the SHA-256 of the exact public-key bytes. Unknown
fields, padded base64url, a wrong point length/prefix, an uppercase or wrong
fingerprint and a malformed `createdAt` all fail closed.

When the config is absent:

* `settingsMarkup()` returns `''`, so Settings contains no background block.
* Explicit actions fail with `VAPID_CONFIG_UNAVAILABLE`.
* Reconciliation never prompts, subscribes, registers or invalidates.

The VAPID private key is not present in the browser, repository, IndexedDB,
localStorage, service-worker cache, logs, tests, HTML or configuration. Only the
public key and its fingerprint are ever accepted here.

## Capability evidence

The evaluator uses flat, testable evidence. C1–C14 are:

| ID | Evidence |
| --- | --- |
| C1 | Secure context (`isSecureContext === true`). |
| C2 | `navigator.serviceWorker` exists. |
| C3 | `Notification` is a function. |
| C4 | `typeof PushManager !== 'undefined' && typeof ServiceWorkerRegistration !== 'undefined' && 'pushManager' in ServiceWorkerRegistration.prototype` — presence only, the prototype value is never read. |
| C5 | `(display-mode: standalone)` or `(display-mode: fullscreen)` matches, or `navigator.standalone === true`. |
| C6 | Current `Notification.permission` (`default`, `granted`, `denied`). |
| C7 | A service-worker registration exists with `active.state === 'activated'`. |
| C8 | `registration.pushManager.getSubscription()` result, if any. |
| C9 | Subscription endpoint is HTTPS, bounded, has no credentials/port/fragment and belongs to FCM, Mozilla or an accepted Apple/WNS host. |
| C10 | `p256dh` is exactly 65 bytes and starts with `0x04`. |
| C11 | `auth` is exactly 16 bytes. |
| C12 | The subscription's `applicationServerKey` bytes equal the current VAPID public key. |
| C13 | Verified session user id, cached local owner and session generation; divergence is computed, never assumed. |
| C14 | Online state, notification-only storage availability, foundation readiness, and VAPID public-config validity. |

Apple mobile detection is device-class evidence only. It decides whether the
Home Screen remedy is the actionable one; it never blocks macOS Safari merely
because the site is not in the Dock.

## State machine

The evaluator is deterministic and first-match-wins. Precedence is:

1. `error-fatal`
2. `unsupported-insecure`
3. `ios-install-required`
4. `unsupported-browser`
5. `signed-out`
6. `unverified-session`
7. `storage-unavailable`
8. `session-diverged`
9. `foundation-unavailable`
10. `pending-disable`
11. `foreign-account-reservation`
12. `disabled-server-subscription-live` / `disabled`
13. `stale-local-generation`
14. `server-binding-missing`
15. `stale-vapid-key` / `subscription-mismatch`
16. `registered-pending` / `subscription-lost`
17. `local-subscription-unregistered`
18. `supported-not-enrolled`
19. `error-retry`
20. `disabled` (master switch)
21. `permission-denied`
22. `permission-granted-no-subscription`
23. `permission-prompt-available`

The complete set is 25 distinct states:

`unsupported-insecure`, `unsupported-browser`, `ios-install-required`,
`signed-out`, `unverified-session`, `foundation-unavailable`,
`storage-unavailable`, `session-diverged`, `disabled`, `pending-disable`,
`supported-not-enrolled`, `permission-prompt-available`, `permission-denied`,
`permission-granted-no-subscription`, `local-subscription-unregistered`,
`registered-pending`, `stale-local-generation`, `stale-vapid-key`,
`subscription-mismatch`, `server-binding-missing`, `subscription-lost`,
`foreign-account-reservation`, `disabled-server-subscription-live`,
`error-retry`, `error-fatal`.

Invariants:

* `Notification.permission === 'granted'` without a subscription is
  `permission-granted-no-subscription`, never `registered-pending`.
* A bare subscription with no matching local/server binding is
  `local-subscription-unregistered`, never registered.
* Startup reconciliation is read-only. It never prompts, subscribes,
  registers, invalidates or retries automatically.
* `onSessionVerified()` only re-runs read-only reconciliation. Session
  divergence skips server reads entirely.

## Notification-only IndexedDB

Separate database `cap-notifications`, version `1`, object store `state`.
Out-of-line string keys only; no keyPath, no autoIncrement. Each connection is
closed after its transaction, and an `onversionchange` handler releases the
handle so a future schema upgrade is never blocked by this module.

Exactly three records:

```text
installation: { id, created_at, protocol }
binding:      { installation_id, binding_id, generation, schedule_revision,
                state, vapid_key_version, endpoint_sha256, updated_at }
sync:         { in_flight, started_at, tab_id, last_error_code,
                last_attempt_at, retry_after }
```

`installation.id` comes only from `crypto.randomUUID()`; there is no insecure
fallback. Unknown, missing or extra fields are rejected on read and write.
States are `pending`, `disabled`, `retired` and local `disable_pending`.

The raw endpoint, `p256dh` and `auth` are never persisted. The endpoint is
stored only as SHA-256. `p256dh`/`auth` are sent once to the reviewed RPC as
canonical unpadded base64url and are not retained. Pending disable is
represented with existing fields: `binding.state = 'disable_pending'` and
`sync.last_error_code = 'DISABLE_PENDING'`; no schema expansion is required.

## RPC surface

The strict allowlist now contains thirteen RPCs. The four added paths are:

* `cap_notifications_register_v1`
* `cap_notifications_invalidate_v1`
* `cap_notifications_summary_v1`
* `cap_notifications_readiness_v1`

`cap_notifications_publish_v1` is **not** reachable from the browser. It is not
in `CapProductionRpc.ALLOWED` and is refused with
`UNSUPPORTED_PRODUCTION_RPC`.

Wrappers validate every input before the network, require `disable: true` for
invalidation, and verify the exact server response shape. Summary exposes only
identifiers, generations, revisions, states and lifecycle timestamps; readiness
must report the installed foundation identity and remain parked. No wrapper
returns endpoint or key material.

## Transport and session semantics

Notification application errors are not authentication evidence. A 4xx on a
notification RPC never invalidates a previously verified session. A generic
application-level 4xx on another data RPC is also no longer treated as proof
that the session is invalid. Only a fresh `/auth/v1/user` verification path,
an offline transition, or a non-4xx failure can establish invalidity through
the existing transport rules. Non-allowlisted non-auth paths still fail with
`DIRECT_TABLE_ACCESS_DISABLED` before any request.

`CapSupabase.authEvidence()` is side-effect-free and is the only session
evidence the enrollment module reads. It never calls `status()`, which may
invalidate verification merely because it was read while offline.

## Explicit enrollment and removal

Enrollment happens only through the Settings action **Turn on background
reminders on this device**. The action:

1. Re-validates VAPID, preferences, capabilities, online state and verified
   identity.
2. Captures owner and session generation.
3. Enters the `cap-notifications-enrollment` Web Lock when available.
4. Requests permission only if it is still `default`.
5. Reuses an existing valid subscription or subscribes once with the reviewed
   public key.
6. Validates endpoint, keys and key match.
7. Registers against the expected local generation.
8. Re-checks owner/session generation after each async boundary.
9. Persists the bounded binding only for the captured owner and endpoint.

A concurrent tab that finds the same installation, endpoint, key version and
matching server generation returns the existing pending binding instead of
registering again. Subscriptions are never transferred between accounts.

Removal is server-first then local: invalidate with the current binding id,
generation and revision, then `unsubscribe()`. If server invalidation fails,
the local subscription still goes away and pending-disable is persisted for a
later online attempt.

`beforeSignOut()` is bounded to eight seconds, starts before the session is
cleared, and can never permanently block sign-out. Server invalidation is
attempted twice inside the budget; local unsubscribe happens regardless. On
failure the hook returns `pending-disable`, and sign-out continues.

## Verification

Local commands run for this phase:

```powershell
node tests/notification-enrollment.cjs
# CAP_PLAYWRIGHT_PATH required
node tests/notification-enrollment-browser.cjs
node tests/notifications.cjs
node tests/notifications-browser.cjs
node tests/client-rpc-only.cjs
node tests/cloud-pull-security.cjs
node tests/cloud-pull-shell.cjs
node tests/financial-health-browser.cjs
node tests/local-development-browser.cjs
node tests/ui-presentation.cjs
node tests/upcoming-presentation.cjs
node tests/offline-auth.cjs
node tests/notes-rpc-readiness.cjs
node tests/cloud-pull.cjs
node tests/cloud-bootstrap.cjs
node tests/sync-production.cjs
node tests/notifications-foundation-sql.cjs
node tests/notifications-enrollment-sql.cjs
node tests/phase6o-sql.cjs
```

Results observed locally:

* A1–A8: 11 static/unit checks passed.
* B1–B26 (B25b included): 27 real-browser checks passed.
* Notifications unit 61, Notifications browser 68.
* Client RPC-only 13, cloud-pull security 4, shell cache 5.
* Financial Health browser 47, local development browser 10.
* UI presentation 15, Upcoming presentation 20.
* Offline auth 42, Notes readiness 25, Cloud pull 48, Cloud bootstrap 64.
* Notification foundation SQL 69, enrollment amendment SQL 21, Phase 6O SQL 23.
* Syntax: every `js/*.js` and `service-worker.js` passes `node --check`.
* `manifest.json` and `vercel.json` parse as JSON.
* Privacy greps find no private key literal, no private-key identifier and no
  raw endpoint/key field in the notification record schema.

The browser suite uses real Chrome, real IndexedDB and real Web Locks. The
Notification, PushManager, ServiceWorkerRegistration, session identity and
reviewed RPC wrappers are explicit fakes. No live Supabase or push service is
contacted.

## Manual platform matrix

No physical device or real push service was used for this phase. Real
permission prompts, OS-level delivery and vendor push endpoints remain
out of scope for a dark shipment.

| Platform | Install / standalone | Permission + subscribe | Register / remove | Status |
| --- | --- | --- | --- | --- |
| Chrome desktop (Windows) | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| Edge desktop (Windows) | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| Android Chrome | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| iOS Safari (Home Screen) | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| iPadOS Safari (Home Screen) | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| Firefox desktop | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| Safari macOS | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |

Because VAPID ships dark, the expected production observation is the same on
every platform: no background-reminder block, no permission prompt, and no
push subscription.

## Deferred to later phases

* Phase 5B.3: provisioned VAPID public identity, key rotation and sender dispatch.
* Phase 5B.4: bounded client schedule publication (`cap_notifications_publish_v1`)
  and schedule lifecycle.
* `browser_expiration` gating and sender integration. The browser's
  `expirationTime === null` is accepted and forwarded as `null`; the client
  never synthesizes an expiration. Deciding how publication treats a null
  expiration (and when it must be treated as non-publishable) is a Phase 5B.3
  gate.
* Phase 5B.6: real-platform enrollment matrix and OS-level delivery verification.
* Phase 5B.3: isolated sender Edge Function; Phase 5B.5: automatic Cron/invocation
  mechanism, including any approved `pg_cron` / `pg_net` use.

## Rollback

Revert the client files, restore `service-worker.js` to `cap-shell-v368`, and
remove the two new modules from `CORE` and `index.html`. No database change was
made in this phase. Notification-only `cap-notifications` data remains separate
from financial state and can be deleted by the client without touching `pera`,
the baseline, the outbox or any account record.
