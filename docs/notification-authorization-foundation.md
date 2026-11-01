# Notification authorization foundation — phase 1

**Implementation/review artifact only. No remote migration or dispatch activation.**
The local successor is `supabase_notifications_authorization_v1.sql`. Historical
SQL remains unchanged. No browser, worker, Edge sender, VAPID, financial or Cloud
Sync code changes belong to this phase.

## Guarantee and explicit limit

Received compatible revocation must disable locally first and then commit server
revocation. Server revocation invalidates enable intents, grants and future
dispatch eligibility atomically. Already-started provider requests/presentation
cannot be recalled. An offline pre-amendment page that changes neither the new
fence nor the server cannot revoke an authorization through an unobservable action.
Worker control, claim, census, BFCache and finite capability challenges are not
authorization evidence.

## Installation boundary

Requires the sealed chain: foundation -> enrollment V2 -> sender 5B.3 -> Scheduling
V2. Apply only to a separately authorized environment, as its `postgres`
non-superuser installer, inside the artifact's single transaction, with the
session setting `cap.notifications_authorization_install=reviewed-authorization-v1`.
This document is not approval to run it remotely. It refuses an unapproved run,
nonmatching predecessor, unsafe sender state, or a second installation.

The exact predecessor catalog seal is checked before DDL. The successor reseals
the notification catalog only after deterministic DDL/ACL changes and removal of
temporary installer-granted memberships. Platform ADMIN-only grants are retained.
No new role, LOGIN, password, extension, scheduler or secret is installed.

## Schema

All four tables are in `cap_notifications_private`, installer-owned, with ENABLE
and FORCE RLS and an owner-scoped policy for `cap_notification_manager`. Browser,
service, sender and runtime roles receive no direct access. Manager has no DELETE
on these history/authority tables. Revocation requests are INSERT/SELECT only.

* `installation_authority`: owner/installation primary key, epoch (1 through
  9007199254740991), optional 32-byte device-key digest, credential revision,
  active-grant pointer, terminal lockout, revocation reason/time and audit times.
  A deferred, owner/installation-qualified FK constrains the active pointer.
* `delivery_authorizations`: random ID, owner/installation, owned binding and
  exact generation, epoch, contract `CAP_NOTIFICATION_AUTH_V1`, consenting session,
  credential revision, active/revoked state and retained revocation metadata.
  A partial unique index permits only one active grant per installation.
* `enrollment_intents`: UUID, exact target/generation/epoch/session/contract,
  SHA-256 request digest, prepared/committed/cancelled/expired state, grant pointer,
  creation time and at-most-ten-minute preparation expiry. Only one prepared
  intent per installation. Expiry is not a replacement for revocation.
* `revocation_requests`: owner/installation/request primary key, canonical request
  digest, resulting epoch, reason, lockout and commit time. A repeated exact
  request never advances the epoch again; conflicting reuse fails.

Schedules add nullable `authorization_id`/`authorization_epoch`. The ledger adds
nullable `claimed_authorization_id`/`claimed_authorization_epoch`. Pair checks and
owner/authorization/epoch FKs reject partial or foreign references. Phase 1 never
writes positive references; positive publication/runtime enforcement is deferred.

Grants reference retained transport rows without cascading away tombstones. No
account-deletion/history-purge policy is introduced: deleting an owner or referenced
transport history requires a separately reviewed purge transaction. Do not bypass
FKs or delete epochs to make cleanup succeed.

## Six public RPC contracts

All are fixed-search-path SECURITY DEFINER functions owned by
`cap_notification_manager`, executable only by `authenticated`. Owner is derived
through the existing `request_owner()` contract; there is no caller-supplied UID.

### `cap_notifications_revoke_authorization_v1`

Arguments: `(p_installation_id uuid, p_request_id uuid, p_reason text)`.
Reasons: disable, sign_out, administrative, legacy_mutation; key_reset is reserved
for the reset RPC, which additionally binds its request to the replacement digest.
Returns `{ok:true,state:"revoked",revocation_epoch,locked_out,replayed}`.

Serializes on the historical owner admission lock, locks/creates installation
authority, then locks the binding before schedule/ledger mutations. It advances
epoch, clears the pointer, revokes active grants, cancels prepared intents,
deletes schedules, suppresses queued/claimed/retry work and marks started dispatch
unknown/ambiguous. Accepted/uncertain terminal receipts are retained. Transport is
disabled and its generation/revision advance without relying on a stale schedule
revision. At epoch/transport exhaustion, denial commits with terminal lockout;
counters never wrap or decrease. No subsequent arm can succeed.

Success is durable only after the RPC transaction COMMIT. A SQL SELECT result
inside a caller-managed transaction is not a committed acknowledgment.

### `cap_notifications_register_v3`

Arguments: `(p_installation_id uuid,p_expected_generation bigint,p_expected_epoch
bigint,p_contract_id text,p_endpoint text,p_p256dh text,p_auth text,
p_vapid_key_version text,p_browser_expiration timestamptz default null)`.

Requires exact epoch/contract, unlocked authority, no active grant/prepared intent
and safe generation. Reuses a private invoker-only copy of the sealed transport
validator. Returns the original transport binding shape (`pending`), **not a
delivery grant**. Contract/precondition failures return `{ok:false,reason}`;
transport validation conflicts retain existing normalized SQL errors.

### `cap_notifications_prepare_authorization_v1`

Arguments: `(p_installation_id uuid,p_binding_id uuid,p_generation bigint,
p_expected_epoch bigint,p_intent_id uuid,p_device_key_sha256 text,
p_contract_id text)`.

Requires current epoch, owned matching pending/unexpired binding, exact contract,
nonempty session ID, verified live-session adapter, and no active grant. First
preparation may store a 64-lowercase-hex SHA-256 digest (never a raw device key).
A different existing digest requires reset. Exact prepared retries return the
same acknowledgment. A new intent cancels an older prepared one. Output is
`{ok:true,intent_id,revocation_epoch,request_digest}` or a fixed denial reason.

### `cap_notifications_commit_authorization_v1`

Arguments: `(p_intent_id uuid,p_expected_epoch bigint,p_request_digest text)`.

Rereads authority, binding and intent under locks; revalidates session, epoch,
digest, generation, pending state and preparation expiry. Grant insert, pointer
update and intent consumption share one transaction. Returns identifiers,
generation, epoch, credential revision, contract and `state:"active"`, always
`dispatch_ready:false`. Committed retry returns that grant only if it is still
current and active. Revocation makes old acknowledgment recovery fail.

### `cap_notifications_authorization_status_v1`

Arguments: `(p_installation_id uuid,p_intent_id uuid default null)`.

Read-only owner-scoped state, epoch, lockout, grant ID and optional intent state.
Missing/foreign installations return unauthorized. No key digest, endpoint,
subscription keys or session ID is exposed. `session_authority_verified:false`
and `dispatch_ready:false` are explicit; stored grant state is not a permit.

### `cap_notifications_reset_device_key_v1`

Arguments: `(p_installation_id uuid,p_request_id uuid,p_device_key_sha256 text)`.

Revoke first, then replace the digest and increment credential revision in the
same transaction. The immutable idempotency digest includes the new key digest.
An old reset replay cannot overwrite keys or revoke a subsequently re-enrolled
grant. Exhaustion commits terminal denial. Returns the revocation acknowledgment
with `dispatch_ready:false`; never returns the digest or raw key.

## Session adapter: deliberately unreachable positive production arm

`authorization_session_live_v1(owner,session)` unconditionally returns **false**.
It has no configurable GUC bypass, auth-table access, JWT-only fallback or public
EXECUTE. Extracting `session_id` from a request claim does not verify its liveness.
Production prepare/commit therefore cannot create an active grant in this phase.
The adapter must be replaced only through a reviewed successor after actual
Supabase logout/session semantics and least-privilege access are certified.

Tests create unexposed functions in a disposable `authorization_whitebox` schema
that substitute `true` only at the adapter call sites. The production adapter,
RPCs, seal and gates remain unchanged. These clones exercise positive transaction
logic, not auth-provider certification, and are never migration content.

## Legacy containment and quarantine

* Old register creates/locks unauthorized installation authority, commits denial,
  and returns `AUTHORIZATION_UPGRADE_REQUIRED`; it no longer registers transport.
* Old publish V1/V2 conservatively revokes an owned binding's installation and
  returns incompatibility, even if obsolete publication fields are invalid.
* Old invalidation conservatively revokes without generation/revision CAS blocking
  the denial, then returns the disabled transport summary.
* Unknown/foreign binding IDs cannot mutate another owner. Revocation and an
  incompatibility result commit together; no exception is thrown after successful
  denial merely to report upgrade required. A caller that explicitly rolls its
  whole transaction back has not committed revocation and receives no durable
  success guarantee.
* Existing binding rows backfill unauthorized, with no credential/grant/intent.
  Existing schedules retain their contents but have NULL authorization references.
  Existing queued claims are suppressed; started dispatch remains uncertain.

## Independent DARK gates

All existing background/sender OFF constraints, empty allowed-VAPID set and
NOLOGIN sender role remain. New `authorization_dispatch_blocked` is constrained
true. Sender `claim_v1` and `start_dispatch_v1` retain caller/security checks but
return hard denial (`authorization_foundation_dark`), independent of run tokens.
No endpoint/keys are released. Positive sender integration requires another
reviewed successor; neither client enrollment nor flipping a flag enables it.

## Deferred to separate phases

No device-revoke/receipt RPC or receipt-decision table is added. Anonymous device
capabilities change the sealed privilege boundary; credential lifecycle, gateway
rate limits, one-use decision storage and receiver request/replay semantics must
be reviewed together. Adding a placeholder positive validation endpoint would be
unsafe. No V3 publisher, client adapter, worker changes, foreground-channel change,
rollout packaging or activation belongs here.

Client implementation may proceed against these explicit contracts/denial results
and test doubles, but real enrollment cannot complete until session authority is
certified. Do not change browser RPC allowlists or enable publication to work
around the denial.

## Verification

```powershell
node tests/notifications-authorization-sql.cjs --static
$env:CAP_PG_BIN = 'C:\path\to\postgresql17\bin'
$env:CAP_PG_PATH = 'C:\external\node_modules\pg'
$env:CAP_TEST_TEMP = "$env:LOCALAPPDATA\Temp\opencode"
node tests/notifications-authorization-sql.cjs
```

Uses the unchanged fresh-cluster helper, loopback only, a synthetic database name,
PG17 and the existing non-superuser/platform-membership model. No default remote
connection, SQL deployment, push, subscription or credential generation occurs.
Local synthetic clusters are stopped in the helper's finally path.

29 checks passed: historical/app preservation, dark gates, unapproved/late-failed
migration rollback, sealed non-superuser installation, unauthorized backfill and
schedule quarantine, legacy containment, session deny, positive whitebox atomicity,
stale intents, idempotency, unrelated revisions, owner/RLS/ACL isolation, rollback,
epoch exhaustion, key-reset replay, concurrent revoke/commit, sender hard denial,
seal drift, and preservation of unrelated catalogs/platform memberships.

Real production-minor/provider behavior is **not certified**. The existing
repository release allowlist is intentionally unchanged; these new files require
a later release-scope review rather than silently weakening that test.

Concurrent UI work appeared during the final run (including a changed worker
shell/version). The combined working tree correctly fails the source-preservation
assertion. The final **29/29** result is scoped to a detached test worktree at
`5f09ec9dabba9c2054a4421f0e1f4c484e82efaa` with only these three new authorization
files overlaid; it is not a combined-tree pass. The unrelated edits were neither
reverted nor included in this phase. No tests or preservation checks were relaxed.

Review status: server foundation ready for review and DARK client integration;
production delivery, publication, dispatch and remote installation remain BLOCKED.
