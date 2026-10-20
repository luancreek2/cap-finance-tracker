# Offline session restoration

Shell: `cap-shell-v310`. Cloud Sync remains OFF. This fix does not change app
state, balances, the sync baseline, outbox entries, or any Supabase data record.

## Failure and fix

Previously, startup treated a failed `/auth/v1/user` read as an expired token,
tried a refresh, then removed `cap_supabase_session` on any further failure.
Offline reload therefore discarded a usable saved session and displayed the
online-only login screen over the locally cached app.

Startup now distinguishes **saved local access** from **verified cloud
authentication**:

- With a saved token and cached user identity, offline startup preserves the
  credentials unchanged and dismisses the cloud login overlay. The local app
  and any existing device-lock controls continue normally.
- A notice says cloud authentication is not verified and Cloud Sync stays OFF.
  This does not assert token validity, offline revocation checking, or a new
  independent security boundary around device-local data.
- `status().localAccess` reports local availability. `authenticated` and
  `userId` indicate only a successful fresh online `/auth/v1/user` response.
  `currentUser()` never returns the cached user as authenticated.
- Cloud REST/RPC requests are blocked before transport while offline or
  unverified. Readiness flags are invalidated on authentication/network
  failures. Reconnecting alone does not verify identity or run sync; reload
  online (or an explicit current-user check) is needed.
- Failed network reads, HTTP 429, and server errors do not prove credential
  revocation: do not refresh or erase the saved session for those failures.
- Only explicit access rejection (401/403) triggers an auth-token refresh.
  A definitive refresh rejection, or rejected identity after refresh, requires
  sign-in. Ambiguous errors retain credentials but keep cloud access blocked.
- A successfully rotated refresh token is retained if a later verification
  request fails. Malformed/mismatched refresh responses cannot replace it.
- Explicit sign-out still removes saved auth immediately and reloads. A late
  pending authentication response cannot reinstate that signed-out session.
- Signing in requires a connection; an offline failed attempt does not erase
  the existing saved credentials. No password/token is rendered in the notice.

The auth layer reads/writes only `cap_supabase_session`. Normal online
verification/refresh is Auth traffic, not financial synchronization. No new
timer, automatic worker, cloud-data fetch on reconnect, or auto-push is added.

## Checks

`node tests/offline-auth.cjs`: 41 isolated mocked-network checks covering local
access, repeated offline reload, transient failures, expired/revoked sessions,
refresh rotation, unverified REST blocking, explicit sign-out, late responses,
malformed sessions, and unchanged non-auth storage.

`tests/notes-rpc-readiness.cjs` now authenticates its fixture explicitly before
checking metadata. A failed cloud request requires re-verification before a
later readiness check. All 17 `.cjs` suites pass with external test dependencies
configured; syntax and JSON checks pass.

For native browser rehearsal, run `node tests/offline-auth-browser-server.js`
on its dedicated disposable port 8033, never the user's localhost:8000 origin.
It replaces runtime configuration with dummy credentials and a mocked Auth
GET. It refuses all REST traffic and mutation methods. `fixtureOffline=1`
simulates `navigator.onLine === false`; it is **not** DevTools network-offline.

Native result: the cached local app was visible without a login overlay in
simulated offline mode, credentials and persisted state hashes survived reload
unchanged, current-user/REST operations were blocked, outbox stayed empty, and
the local-only notice was legible in light/dark themes. Reconnecting with
`fixtureOffline=0` and reloading verified the mocked user, removed the notice,
retained the same saved auth/state, and left Cloud Sync OFF. No real Supabase
endpoint or data mutation was used.

## User-profile verification (passed)

1. Stay online and reload twice to activate shell v310 while signed in.
2. Set DevTools Network to Offline and reload once. Expect the local app and
   local-access notice, not a forced sign-in. Don't run cloud diagnostics while
   offline; those should remain blocked.
3. Restore No throttling and reload once. The app should verify the saved
   session online and remove the notice without another password prompt,
   unless the server definitively rejects that session.
4. If anything unexpected happens, report it; do not clear site data, reset,
   initialize a baseline, or push a note as a workaround.

The user's screenshots confirm the true DevTools-offline reload passed: the
local dashboard remained accessible with the local-only notice and no login
screen. After switching to No throttling and reloading, the dashboard remained
accessible and the notice disappeared without another sign-in. This verifies
the observed offline shell/local-access and online-restoration behavior, not a
new per-record baseline/cloud comparison. Offline failed asset revalidation
requests are expected; cached resources still loaded. No live manual note
queue/push has been authorized by this verification.
