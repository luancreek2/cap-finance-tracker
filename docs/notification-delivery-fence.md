# Phase 5B.3C — local delivery fence and generic receiver

Implementation/review only. Production remote activation remains **BLOCKED**.
No SQL, remote publish, VAPID activation, real subscription, real push, Edge
invocation, deployment, commit, or push is part of this work.

## Audited canonical notification storage

`js/notification-enrollment.js` owns IndexedDB `cap-notifications`, version 1,
object store `state` (out-of-line keys). Existing records:

* `installation`: exactly `id`, `created_at`, `protocol`.
* `binding`: exactly `installation_id`, `binding_id`, `generation`,
  `schedule_revision`, `state`, `vapid_key_version`, `endpoint_sha256`,
  `updated_at`. No raw endpoint or cryptographic subscription keys are stored.
* `sync`: `in_flight`, `started_at`, `tab_id`, `last_error_code`,
  `last_attempt_at`, `retry_after`. This is reconciliation metadata, NOT
  delivery authorization.

Server binding states remain exactly `pending`, `disabled`, `retired`.
Existing local `disable_pending` remains. The explicitly approved local-only
`delivery_eligible` is accepted only by local normalization, never RPC response
validation. `pending` alone is never sufficient for presentation. UI continues
to report `registered-pending`, not Scheduled or global background activation.

## Approved record-schema amendment

One key `delivery-fence:v1` in the same store; no new database/schema version,
identity allocation, financial fields or owner ID. Exact shape:

```
{version:1, enabled:true, installation_id:UUID, binding_id:UUID, generation:positiveInteger}
```

Canonical disabled tombstone:

```
{version:1, enabled:false, installation_id:null, binding_id:null, generation:0}
```

Existing installations have no enabled migration. Startup/reload/activation,
reconciliation, master ON, existing subscriptions, existing bindings and push
receipt cannot promote delivery. Missing/unknown/malformed state denies it.

## Atomic lifecycle and locking

All new enrollment, replacement, rotation, disable and sign-out notification
cleanup uses exclusive Web Lock `cap-notifications-enrollment`. The old
page-local Promise fallback is removed: it cannot coordinate with a worker.
Master OFF holds this lock through fencing and notification preference storage.
No Web Locks or a rejected lock means failure, never a fallback authorization.

Before network/destructive work, one notification-store read/write transaction
reads installation, binding and fence, writes the disabled tombstone and
de-promotes any eligible binding to `pending` (or authoritative disabled/retired
when reconciliation proves revocation). Replacement begins non-eligible.

Only the private explicit enrollment/rotation path may promote. After verified
acknowledgment, one read/write transaction rereads all three records, verifies
captured session, master preference, exact acknowledgment identity/generation,
server `pending`, canonical local `pending`, and the prior disabled fence. It
atomically writes `delivery_eligible` plus its matching enabled fence. Success
is returned only on transaction completion. Abort/write failure rolls back both
promotion writes to the preceding disabled state. A lost response is not guessed.

Disable-first failure returns an error and does NOT proceed to remote cleanup.
Auth/session code is unchanged; its existing bounded sign-out semantics remain.
If storage refuses a disable transaction, it is impossible to promise that an
old durable authorization was revoked: the previous committed values may
remain. This is reported as fencing failure, never successful revocation. A
receiver with unreadable storage drops; no new cross-process/durable revocation
claim is invented when storage itself cannot commit. This limitation and old
clients are activation-review concerns, not excuses to relax receiver checks.

## Receiver

`push` synchronously attaches the async operation with `event.waitUntil`.
Decode at most 512 bytes with fatal UTF-8 decoding. Require an exact seven-key
JSON object: protocol CAP_PUSH_V1, type reminder, numeric version 1, canonical
lowercase UUIDs (versions 1–5/standard variant), positive safe generation and
positive safe Unix expiry within JavaScript's representable Date range.
Reject missing/extra fields, arrays, null, malformed encoding, non-integers and
expired input. No server-supplied copy, URL, actions, or assets are accepted.

Under the same exclusive Web Lock, read installation/binding/fence together in
one **readonly** transaction, waiting for transaction completion. The worker
does not create/migrate a missing store: it aborts on upgrade. Open/read failures,
blocked/version-changed storage and a three-second storage timeout drop safely.
Exact matching IDs/generation, canonical records, local `delivery_eligible`,
and enabled v1 fence are all required. Hold the lock through notification lookup
and awaited presentation; recheck expiry immediately before showNotification.

Only compiled copy is shown:

* Title: **Cap reminder**
* Body: **Open Cap to review your reminders.**
* tag: `cap-background-reminder-v1`, `renotify:false`
* data: `{type:'cap-reminder',version:1}`
* same-scope existing Cap 192px icon / 48px badge

An already-visible notification with that tag coalesces receipt. This is NOT a
durable exactly-once ledger, nor occurrence-level deduplication: the frozen
payload contains no occurrence identifier. Once dismissed, a later valid event
may show the same generic notification again. No receipt writes are introduced.
The existing safe click handler is byte-for-byte unchanged; payload destinations
are never used. No financial storage, network, auth refresh or page is needed.

## Mixed versions — activation BLOCKED

Tests load the actual pre-amendment enrollment implementation from `8afee71`.
Its normalizer rejects `delivery_eligible` rather than silently mapping it to
pending. Consequently old disable may fetch a binding summary and invalidate
before a local tombstone; old sign-out may not recognize the binding at all.
Old disable still holds its existing Web Lock during network cleanup, so a
coordinated receiver waits; successful old removal subsequently denies receipt.
But it omits the required durable tombstone, and old sign-out does not use that
lock. Tests explicitly demonstrate receipt after old sign-out leaves stale
canonical authorization. Old rotation also
unsubscribes without a fence, and old replacement persistence does not transfer
eligibility to a new generation (the new pending binding is denied).

These tests document an unsafe mixed-version window, NOT successful activation
certification. A separate reviewed rollout/client-compatibility protocol and
Phase 5A/background channel coordination remain prerequisites for activation.
Do not enable delivery merely because receiver tests pass.

## Platform and implementation checkpoint

The receiver requires worker Web Locks and IndexedDB. Unsupported/missing/failed
coordination drops pushes and prevents new lifecycle authorization; no weaker
fallback. Chromium worker/IndexedDB/locks are exercised locally. No physical
iPhone/Android certification is claimed. Per the frozen audit section 10, no
`pushsubscriptionchange` listener or automatic resubscription is introduced.
Dropping malformed/stale pushes can conflict with platform user-visible-push
policies; server-side TTL/fencing and future activation review remain required.

Shell stays `cap-shell-v376`, CORE/MEDIA are unchanged. Runtime scripts already
belong to CORE. A later production release requires separate v377 packaging;
this local implementation is not released. Server SQL, Phase 2A/2B contracts,
Phase 2C editor/compiler logic, financial writes, Cloud Sync, auth/RLS, Edge
sender, seven-field payload, and VAPID configuration remain untouched.

## Verification scope

The deterministic receiver suite runs actual worker/enrollment source against
disposable fake IndexedDB and shared lock scheduling. It includes transaction
abort/put failures, no-fence migration denial, state/identity/schema validation,
new and actual pre-amendment client lifecycle behavior. Mixed-version tests
deliberately demonstrate unsafe old-client behavior; passing that assertion is
evidence to KEEP activation blocked, not evidence that old clients are safe.
Real Chrome tests use an actual worker, IndexedDB and cross-context Web Locks,
with synthetic receipt and a mocked OS presentation sink (no real push).

Concurrent, unrelated UI/skill work appeared during this task. It is preserved,
not included or exempted from the release allowlist. With user approval, a
detached temporary checkout at `8afee71` with only the eleven notification-scope
paths overlaid is used for scoped security and final regression. The full
working-tree security check rejects unrelated files; that failure must not be
reported as a combined-tree pass. A local-development browser check also failed
in the combined tree and passed in the notification-only checkout.

Final scoped results: receiver/fence 83; real-worker browser 6; reminder adapter
17; reminder UI browser 29; notification engine 61/browser 71; enrollment
unit 11/browser 27; scheduling compiler 44/browser 14; publisher 25; RPC-only 14;
security 4; shell/cache 5; offline-auth 44; Web Push 5; sender Deno 7/Edge 1;
Upcoming 20; local-development unit 15/browser 10; sync wiring 5. All passed.
JavaScript syntax: 144 files; JSON: manifest/vercel both valid. The isolated
cache test initially lacked its ignored generated config asset; it passed with
an explicitly empty synthetic config, without copying credentials. No SQL was
run for this phase. The original Phase 2A SQL certification remains unchanged.
