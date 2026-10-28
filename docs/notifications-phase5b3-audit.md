# Phase 5B.3A — Web Push sender and VAPID security audit

Date: **2026-10-28**. Status: **audit architecture approved; design only;
implementation and activation NOT STARTED / NOT AUTHORIZED by this checkpoint**.

Starting HEAD and `origin/main`: `7db591a3bb1a04b7b9998b6f940627ac1443995e`
(`Add dark Web Push enrollment client`), ahead/behind `0/0`, working tree clean
before this document. The audit initially created only this document; finalization
also corrects roadmap wording only in `docs/notifications-phase5b2.md`. No dependency was
installed, no cryptographic keys (even ephemeral ones) were generated, and no
secret was created. Public documentation/registry/GitHub reads are not reads of
the Cap production project. **Production reads: none. Production writes: none.**

## 1. Decisions and approval gates

1. Use **`npm:@block65/webcrypto-web-push@2.0.0`**, pinned with a frozen Deno
   lockfile and reviewed transitive dependencies. Use WebCrypto primitives
   through the library, not home-grown encryption or JWT signing. This is a
   recommendation based on source/documentation, **not runtime certification**.
   Selected package is exactly **`@block65/webcrypto-web-push@2.0.0`**; future
   Edge imports must use exactly **`npm:@block65/webcrypto-web-push@2.0.0`**,
   never `^2`, `~2` or `latest`. Reproducible resolution/locking must be verified.
2. Generate the first production identity, **v1**, only in a separately approved
   key ceremony. Store its private scalar only in **Supabase Edge Function
   Secrets** in an isolated sender project; never in Cap Postgres or Vault.
3. Recommend boundary **C: a dedicated, notification-only Supabase Edge project,
   connecting through Supavisor transaction pooling to Cap using a new
   execution-only database login**. The existing NOLOGIN runtime role owns the
   narrow runtime functions, not the login. No Cap secret API key, postgres URL,
   user JWT, or financial privilege is given to the sender.
4. Why another project? Current hosted Edge functions receive project-wide admin
   API keys and `SUPABASE_DB_URL` automatically. Merely choosing not to use them
   does **not** contain arbitrary code execution in an Edge function deployed
   in the financial project. A same-project design cannot honestly promise
   financial isolation against a compromised function. Separate hosting is an
   **approval/cost/operations gate**, not something created in this audit.
5. Reuse existing ledger states. Add frozen claim snapshot fields and narrow
   claim/start/finalize/recover functions; never run HTTP inside a DB transaction.
   Preserve conservative **at-most-once bias**, not exactly-once delivery.
6. A null browser expiration is **already allowed** at registration AND
   publication. **Conclusion A: no SQL amendment is required for null expiration.**
7. Use a small, versioned, encrypted generic payload. SW copy is compiled locally:
   **Cap reminder** / **Open Cap to review your reminders.** No financial content.
8. Before activation, disable Phase 5A automatic OS presentation on this origin
   when a background subscription exists or enrollment state is uncertain.
   Keep the in-app center and explicit test. Never silently fall back to a
   second automatic OS-delivery channel after an ambiguous push outcome.
9. Everything remains parked through implementation development. No automatic
   invocation until 5B.5; no live transmission until a separately approved 5B.6
   certification window. No sender activation is implied by this design.

## 2. Current documentation consulted

All URLs below were retrieved on **2026-10-28**. Standards take precedence over
old tutorials; publication dates are not assumed to equal access dates.

### Supabase official sources

| Ref | URL | Relevant evidence |
| --- | --- | --- |
| S1 | https://supabase.com/docs/guides/functions | Deno-compatible Edge runtime, short-lived pooled database work |
| S2 | https://supabase.com/docs/guides/functions/secrets | Project secrets, reserved `SUPABASE_` prefix, injected DB/admin credentials, secrets take effect without redeploy |
| S3 | https://supabase.com/docs/guides/functions/auth | `withSupabase`, `secret:<name>`, service-to-service authentication |
| S4 | https://supabase.com/docs/guides/functions/auth-headers | `apikey` vs user `Authorization`; gateway `verify_jwt` alone does not authenticate an API-key caller |
| S5 | https://supabase.com/docs/guides/functions/connect-to-postgres | Direct drivers and Data API options |
| S6 | https://supabase.com/docs/guides/database/connecting-to-postgres | Shared transaction pooler, custom-role usernames, max 1 connection, no prepared statements/session state, TLS verification |
| S7 | https://supabase.com/docs/guides/api/api-keys | `sb_publishable_`, `sb_secret_`, secret maps to `service_role`/BYPASSRLS; legacy key deprecation end of 2026 |
| S8 | https://supabase.com/docs/guides/cron | Cron uses pg_cron; job/run tables, concurrency recommendations |
| S9 | https://supabase.com/docs/guides/database/extensions/pg_cron | Points to current Cron guide |
| S10 | https://supabase.com/docs/guides/database/extensions/pg_net | Beta API, async after commit, queue/response storage, default grants and queue confidentiality |
| S11 | https://supabase.com/docs/guides/functions/schedule-functions | Current secret-key `apikey` example, Vault recommendation, explicit decrypted pg_net queue warning |
| S12 | https://supabase.com/docs/guides/database/vault | Encrypted at rest, decrypted view, root-key/backup portability and access risks |
| S13 | https://supabase.com/docs/guides/database/functions | Functions PUBLIC-executable by default, SECURITY DEFINER/search_path warnings |
| S14 | https://supabase.com/docs/guides/database/postgres/roles | Custom database logins, do not share project postgres password |
| S15 | https://supabase.com/docs/guides/functions/limits | Free 150s wall clock, 2s CPU/request, 256MB; no worker threads |
| S16 | https://supabase.com/docs/guides/functions/dependencies | Per-function deno.json, npm/JSR support and Node compatibility |
| S17 | https://supabase.com/changelog | Current breaking changes surveyed, including 2026 entries |
| S18 | https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically | New public-table grants stop being implicit; all-project rollout October 30, 2026 |
| S19 | https://supabase.com/pricing | Free plan: two active Free projects, pause after one week of inactivity; checked again at audit finalization |

### Standards, browser and push-service sources

| Ref | URL | Relevant evidence |
| --- | --- | --- |
| W1 | https://www.rfc-editor.org/rfc/rfc8030.txt | HTTPS delivery, TTL, acceptance vs delivery, Topic, 404/410 and retries |
| W2 | https://www.rfc-editor.org/rfc/rfc8291.txt | P-256 ECDH, auth secret, HKDF-SHA256, aes128gcm single-record encryption |
| W3 | https://www.rfc-editor.org/rfc/rfc8292.txt | ES256, origin audience, <=24h expiry, contact URI, distinct signing/encryption keys, restricted subscriptions |
| W4 | https://developer.mozilla.org/en-US/docs/Web/API/Push_API | SW receipt, capability URL confidentiality, user-visible push |
| W5 | https://developer.mozilla.org/en-US/docs/Web/API/PushSubscription | Endpoint/keys, null expiration, unsubscribe |
| W6 | https://developer.mozilla.org/en-US/docs/Web/API/PushEvent | ExtendableEvent and data |
| W7 | https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification | Persistent display, tag/renotify/data, errors |
| W8 | https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers | Standards Web Push, SNI, HTTP/1.1 or HTTP/2, response reasons, JWT reuse and no invisible push |
| W8a | https://developer.apple.com/tutorials/data/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers.json | Official machine-readable article used because the HTML page returned no text |
| W9 | https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ | iOS/iPadOS Home Screen requirement; macOS webpages supported; no developer-program membership needed |
| W10 | https://mozilla-services.github.io/autopush-rs/http.html | Current Mozilla endpoint semantics, 201 acceptance, no end-to-end receipt guarantee |
| W11 | https://mozilla-services.github.io/autopush-rs/errors.html | Mozilla error codes, Retry-After, bridge ambiguity |
| W12 | https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/notifications-badges | Explicit permission, Notifications/SW support (updated June 2026) |
| W13 | https://web.dev/articles/push-notifications-web-push-protocol | Useful response classification; crypto examples contain OLD draft aesgcm/WebPush syntax and are NOT the implementation authority |

The old https://autopush.readthedocs.io/en/latest/http.html explicitly marks
itself obsolete; followed its link to W10/W11 rather than designing from it.
Do not confuse native APNs/WNS/FCM OAuth APIs with browser Web Push endpoints.

### Library evidence (read only, no install/execution)

* npm metadata: https://registry.npmjs.org/web-push and
  https://registry.npmjs.org/@block65%2fwebcrypto-web-push
* JSR metadata: https://jsr.io/@negrel/webpush/meta.json and
  https://jsr.io/@negrel/webpush/0.5.0_meta.json
* Recommended version source: https://github.com/block65/webcrypto-web-push/tree/v2.0.0
  (read `packages/web-push/README.md`, `package.json`, `lib/main.ts`,
  `lib/vapid.ts`, `lib/jwt.ts`, `lib/encrypt.ts`, `lib/client-keys.ts`,
  `lib/payload.ts`, and `e2e/README.md` using raw.githubusercontent.com).
* Other candidate source: https://github.com/web-push-libs/web-push/tree/v3.6.7
  (README) and https://jsr.io/@negrel/webpush/0.5.0/
  (`README.md`, `application_server.ts`, `subscriber.ts`, `vapid.ts`).
* Maintenance metadata: public GitHub repository and latest-commit APIs for
  `block65/webcrypto-web-push`, `web-push-libs/web-push`, `negrel/webpush`.
  No evidence here constitutes an independent cryptographic/security audit.

### Relevant current changes, not assumptions from tutorials

* New API keys are NOT JWTs. Use `apikey: sb_secret_...` for service calls;
  `Authorization: Bearer` is for user JWTs. Do not copy a new legacy
  `service_role` JWT into this design. Secret keys still map to broad
  `service_role`; a named key is separately rotatable, **not DB privilege-scoped**.
* `verify_jwt=false` is required for the recommended service-only endpoint;
  this is safe only with mandatory in-function named-secret authentication.
* Use injected `SUPABASE_SECRET_KEYS`/`SUPABASE_PUBLISHABLE_KEYS`, not legacy
  `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_ANON_KEY`. Never dump the environment.
* Framework adapters in `@supabase/server` are deprecated October 5, removal
  December 1, 2026. Use its plain fetch wrapper, not Hono/H3/etc adapters.
* Supabase JS Node 20 support ended June 30, 2026; use supported Deno Edge
  runtime/local Node >=22 for future tools. Runtime compatibility is tested
  in the actual current CLI Edge image, not inferred from Node success.
* October 30 public-table default-grant changes do not make functions safe by
  default. Explicit revokes on each newly created function remain mandatory.
* September PostgreSQL minor/security updates (15.19/17.11), November 10 TLS
  cipher removal, and extension-version-pinning deprecation require checking
  actual deployment versions before implementation/activation. No DB upgrade
  or extension is needed/performed by this audit. No pgjwt dependency.
* Logs `logs.all` was removed September 23; any future operator tooling must
  use the current logs endpoint, without sending subscription material.

## 3. Repository contract audit (not a live catalog attestation)

Inspected the foundation SQL, V1 and V2 amendments, their local SQL regression
contracts, `js/vapid-public.js`, `js/notification-enrollment.js`, notification
RPC additions/transport hooks, `js/notifications.js`, `service-worker.js`, and
`docs/notifications-phase5b2.md`. The supplied production-applied state is
foundation + V2. V1 is preserved history, not an extra production application.
SQL file headers saying LOCAL/NOT APPLIED are historical artifact labels,
not new production verification. No live row counts/catalog were queried.

Frozen SHA-256, checked locally:

| Artifact | SHA-256 |
| --- | --- |
| `supabase_notifications_foundation.sql` | `7126F10B3699F2A54B216A3045E92E5EF7CB3405C89BB25E80BCDB913BD9443B` |
| `supabase_notifications_enrollment_5b2a1.sql` | `CB597A5D1D47A90EEFF8B5E336C68540CC0A98B86DFBFB7693B79BADFF2A3364` |
| `supabase_notifications_enrollment_5b2a1_v2.sql` | `291AA08EBF3D867233235150DCCC5B038060E3DFC32D42C0B2DBB90FA6D444CA` |

### Five private tables

All are in `cap_notifications_private`, RLS **enabled and forced**. The
foundation creates them as the installer (V2 documents production `postgres`
ownership), NOT either notification role. Browser roles and `service_role`
have no schema usage or table grants. Each has exactly one manager policy
in the frozen contract. Primary/unique constraints create their own indexes;
the only extra explicit index is `schedules_eligibility_idx(send_after,expires_at)`.

| Table | Exact column inventory | Constraints/indexes and purpose |
| --- | --- | --- |
| `control` | `singleton,migration_id,protocol,engine_identity,digest_version,delivery_time,max_publication,background_enabled` | Singleton PK/CHECK; exact identities `CAP_NOTIFICATIONS_FOUNDATION_5B1_V1`, `CAP_PUSH_V1`, `cap-reminder-v1`, `hmac-sha256-v1`; 09:00 and 168h fixed; CHECK forbids background true |
| `endpoint_owners` | `fingerprint,user_id,created_at` | 32-byte fingerprint PK; `(user_id,fingerprint)` unique; auth.users cascade FK; persistent cross-account reservation |
| `bindings` | `id,user_id,installation_id,generation,protocol,state,endpoint,endpoint_fingerprint,p256dh,auth,vapid_key_version,schedule_revision,preference_revision,created_at,updated_at,last_confirmed_at,browser_expiration` | UUID PK; `(user_id,id)` and `(user_id,installation_id)` unique; endpoint fingerprint unique + SHA256 equality + composite reservation FK; auth.users cascade; positive generation/nonnegative revisions; pending/disabled/retired; HTTPS endpoint allowlist; canonical 65-byte point-prefix and 16-byte auth checks; V2 version regex; last_confirmed_at CHECK NULL; browser_expiration nullable finite |
| `schedules` | `user_id,binding_id,generation,candidate_digest,protocol,engine_identity,digest_version,schedule_revision,preference_revision,eligible_local_date,timezone,send_after,expires_at,published_at,publication_valid_until,state` | Composite PK `(user_id,binding_id,candidate_digest)` + binding composite cascade FK; lowercase 64-hex digest; fixed protocol/engine/digest; valid IANA timezone; 09:00 local-derived send_after; expiry after send/publication, <= publication validity and local day end; publication <=168h; state only prepared; eligibility index |
| `delivery_ledger` | `user_id,binding_id,candidate_digest,state,attempt_count,claim_token,claimed_at,dispatch_started_at,next_retry_at,accepted_at,failure_class,recorded_at` | Same composite PK, binding cascade FK, survives schedule replacement; states queued/claimed/dispatch_started/retry_wait/accepted/unknown/retired/suppressed; attempts 0..10; token/time pairing; accepted iff accepted_at; dispatch evidence required for accepted/unknown; retries need time; unknown requires ambiguous failure |

Current endpoint predicate: exact FCM/Mozilla hosts, DNS-label subdomains of
`push.apple.com`/`notify.windows.com`, HTTPS, no port/userinfo/fragment/IP or
malformed escapes. `valid_keys` validates canonical representation/length and
prefix, not curve membership; the future sender must perform WebCrypto point
import before dispatch. Never log a bad key or endpoint when import fails.

### Roles, policies, functions

Both roles are NOLOGIN/NOINHERIT/NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE/
NOREPLICATION with no application memberships. V2 preserves the platform
postgres ADMIN-only membership (not SET/INHERIT) for the manager; installer
temporary membership is revoked transactionally. No permanent application
membership may be inferred from the installer grants.

* Manager: private schema USAGE; control SELECT; endpoint_owners and ledger
  SELECT/INSERT; bindings SELECT/INSERT/UPDATE; schedules SELECT/INSERT/DELETE.
  No ledger UPDATE/DELETE or reservation UPDATE/DELETE. Control policy permits
  singleton reads; four owner policies use `request_owner()` for USING and
  WITH CHECK. That helper trusts the JWT-validating PostgREST boundary and
  requires authenticated role/claims, never arbitrary SQL-supplied owner IDs.
* Runtime: **parked**, no private schema/table/helper/public management EXECUTE.
  No financial table/column privileges, ownership or writer memberships.
* Five public RPCs: register/publish/invalidate/summary/readiness; manager-owned
  SECURITY DEFINER with `search_path=pg_catalog`, authenticated-only EXECUTE;
  register/publish fix UTC (publish fixes DateStyle too). Private helpers are
  invoker-only, installer/schema-owner-owned, manager-only EXECUTE.
* Browser allowlist is thirteen RPCs: only register/invalidate/summary/readiness
  added for notifications. **publish is absent from the browser allowlist**.
  Application-4xx/auth verification isolation is unchanged by this audit.

### Hard blockers to naive runtime grants/activation

`contract_ok()` (foundation lines 367–425) explicitly REJECTS runtime schema or
table privileges, any runtime function EXECUTE, extra policies, private
SECURITY DEFINER functions, and public notification functions not owned by
manager/authenticated-executable. Every management RPC calls it. Consequently
"just grant runtime access" would break enrollment/readiness, not enable a
sender. A separately reviewed **successor notification verifier and explicit
runtime surface attestation** are required in a new amendment; never replace
it with `true`, widen financial role allowlists, or edit frozen artifacts.

`control.background_enabled` cannot become true because of its CHECK. Summary
and readiness hard-code false/parked; the client validators require those
flags. Activation therefore needs its own coordinated contract/rollout review,
not a hidden toggle. `last_confirmed_at` must remain NULL unless separately
amended; HTTP acceptance must not be written there. Binding state stays
`pending` (registered) in this design, not a newly invented `active` state.

### Null expiration correction — A, no amendment needed

* Foundation binding line 146: nullable, CHECK `IS NULL OR isfinite(...)`.
* V2 register lines 180–185: validates expiration only **when non-null**.
* Foundation publish line 289: stale condition includes
  `b.browser_expiration <= pub`, not `IS NULL`.
* If the other disjuncts are false, `false OR NULL` is NULL; PL/pgSQL IF enters
  its THEN branch only on TRUE. A null expiration does **not** reject publish.
* Confirmed locally with a disposable in-memory PGlite SELECT:
  `NULL::timestamptz <= now()` => NULL; the combined condition `IS TRUE` => false.
  No migration, rows, external database or cryptographic material used.

The earlier phase doc's deferred expiration-gating wording is not evidence of
a blocker. This document supersedes that interpretation; the frozen doc is
not edited. An explicit `IS NOT NULL AND ... <= pub` is logically equivalent
in this IF and could improve clarity later (option B), but is **not recommended
as a standalone amendment**. Future sender eligibility should write the null
case explicitly: `expiration IS NULL OR expiration > clock_timestamp()`.
No clarity-only SQL rewrite is justified unless a later review identifies an
actual semantic need. Null means unknown lifetime, not infinite delivery validity; schedule and
publication expiry still apply. Never synthesize a browser expiration.

## 4. Library comparison and selected version

| Candidate (exact) | Maintenance evidence on audit date | Runtime/dependencies | RFC/vendor assessment | Decision |
| --- | --- | --- | --- | --- |
| `npm:@block65/webcrypto-web-push@2.0.0` | npm published 2026-09-03; repository not archived, pushed 2026-10-21; modern 2.x crypto source and tests | ESM WebCrypto/fetch, Deno expressly supported; Node >=22 engine for Node usage; no Node crypto/https dependency in reviewed sender path; one direct dependency `uint8array-extras ^1.5.0`; MIT | 2.0 uses aes128gcm and RFC8292 vapid; fresh ECDH per encryption; source derives aud from endpoint.origin, exp +12h, ES256. FCM/Mozilla/Apple/WNS are protocol-compatible, but ALL Cap real-platform checks NOT TESTED | **Recommend**, conditional on local Edge-image + independent vector tests/security review |
| `npm:web-push@3.6.7` | Latest npm release 2024-01-16; repository still not archived/pushed 2026-10-26; master has changed since published package | Node crypto/https/Buffer/CJS; Deno Node compatibility required and not certified in this audit; asn1.js, http_ece 1.2.0, https-proxy-agent, jws, minimist and transitives; MPL-2.0 | Supports aes128gcm + vapid; README lists Chrome/Firefox/Edge/Safari. WNS/Apple/FCM/Mozilla standards path available. No Cap live test. Legacy GCM examples must not be copied | Mature fallback, larger Node/dependency compatibility surface |
| `jsr:@negrel/webpush@0.5.0` | Latest JSR 0.5.0; repo not archived, last commit 2025-06-29; README explicitly says not reviewed by crypto experts | Native Deno/WebCrypto/fetch; std bytes/encoding + @negrel/http-ece 0.7.0; MIT; no Node layer | Source aes128gcm + vapid, aud origin, exp +1h; separate VAPID/ECDH pairs, but ApplicationServer caches ECDH key across messages; protocol compatibility for FCM/Mozilla/Apple/WNS inferred, no vendor certification found | Not chosen; limited maintenance evidence/test coverage and key-lifecycle review burden |

Compatibility above means request-format capability, NOT physical-device
certification or a vendor warranty. Microsoft WNS endpoint testing is required
even if Edge happens to return FCM on a given machine. Apple requires standard
Web Push, not a developer certificate or native APNs payload. No claim that any
candidate has no known vulnerabilities: registry/source review is not an
advisory scan, lockfile audit, or independent cryptographic audit.

Reproducibility: exact `2.0.0` specifier, per-function `deno.json`, checked-in
`deno.lock` with exact transitive versions/integrity, frozen-lock CI, no ranges
at import sites/CDN master URLs, no package install scripts. Observed npm
tarball integrity for the recommended release:
`sha512-BMrw8hABq5krABWPy3zFJvBC73HeRkyT/GTZ2AD7wqzo9hd9vO56MstBqjGMIxIw3e4lbRUbYxgihCcfhoTI2g==`.
Future implementation must verify the fetched artifact matches reviewed tagged
source and rerun dependency/advisory/provenance review; not installed now.

Important library-specific constraints:

* 1.x uses legacy aesgcm/draft WebPush and is **not acceptable** for Apple.
* `buildPushPayload` computes a new JWT on each call. Apple says not to refresh
  a JWT more frequently than once/hour. Use exported `vapidHeaders` with shared
  token caching, and exported `encryptNotification` per message; do not blindly
  call the convenience method for every row (section 8).
* Convenience TTL uses `ttl || 60`, so zero becomes 60. Choose positive TTL
  explicitly and construct request metadata in a thin adapter, not crypto.
* Default encryption pads total body to 4096 bytes. Choose `pad:false` for the
  fixed-shape small generic payload (avoids Mozilla bridge size limits); payload
  contains no financial variable-length data. Test exact byte lengths.
* Library only constructs requests. Cap owns HTTP timeout, redirect rejection,
  response classification, no-retry transport policy, and redaction.

## 5. Future VAPID ceremony, representation, subject, rotation

### Generation — NOT performed

A separately authorized operator uses an audited, dependency-minimal local
WebCrypto ceremony on a controlled workstation (not a web page/online key
generator). Generate once with `crypto.subtle.generateKey` using **ECDSA,
namedCurve P-256**, extractable only for secure transfer, usages sign/verify.
Export private JWK in memory and public raw point. This uses platform CSPRNG
and standard APIs; it is serialization, not hand-written cryptography.

Write only the PRIVATE scalar `d` straight to an approved encrypted secret
transfer channel/Edge Secrets boundary. No console/clipboard history, shell
arguments, transcript, plaintext env file, repository file or test snapshot.
Do not use a deployment tool that requires writing the scalar to a file; select
an approved in-memory secret-transfer path. No ad-hoc CLI
`generate-vapid-keys` that prints the key pair. Retain no separate workstation
or operator-manager copy: the production scalar belongs only in the sender
project's protected Edge secret environment, never documentation.
JavaScript memory zeroization cannot be guaranteed; terminate the isolated
ceremony process, exclude dumps/swap capture, minimize lifetime. No production
key creation is authorized by this document.

| Representation | Exact format |
| --- | --- |
| Private stored value | JWK `d`: canonical unpadded base64url of **32-byte big-endian P-256 private scalar** (43 chars); no PEM, JWT or JSON key-pair blob in public config |
| Public stored value | raw SEC1/X9.62 **0x04 || X[32] || Y[32]**; unpadded canonical base64url, 65 bytes / 87 chars |
| Browser applicationServerKey | decoded 65 bytes, supplied as ArrayBuffer as current enrollment module does |
| Library input | `{subject, publicKey, privateKey}` where publicKey is 87-char point and privateKey is `d`; library assembles/imports ECDSA JWK, non-extractable for signing |
| Fingerprint | SHA-256 of decoded 65 public bytes, **64 lowercase hex chars**; not SHA of the base64 text, not a secret/HMAC |
| Time | ISO 8601 UTC `createdAt`, generated once at ceremony |

For the selected library, `privateKey` means exactly scalar **d encoded as
unpadded base64url**, and `publicKey` means exactly the **65 bytes
0x04 || X(32 bytes) || Y(32 bytes) encoded as unpadded base64url**.
`fingerprint` is lowercase SHA-256 hex of those exact 65 bytes. The browser
metadata has only `{ version, publicKey, fingerprint, createdAt }`; the
production private scalar exists only in the sender project's protected Edge
secret environment (with transient in-memory handling during the approved
generation/transfer ceremony, never a retained workstation copy).

Validate public curve membership/fingerprint using the exact frozen
`CapVapidPublic.validate` contract; additionally assert encode(decode(key))
matches for canonical encoding. Reconstruct/import private JWK, sign a
non-sensitive challenge and verify against PUBLIC key before storing/enabling
anything; do not assume x/y/d correspondence merely because an import succeeds.
Only boolean proof/public fingerprint may be output by the ceremony.

Future public shape (schema, **no usable example key**):

```text
{ version: "v1", publicKey: <87-char canonical point>,
  fingerprint: <64 lowercase hex>, createdAt: <ISO UTC timestamp> }
```

After separate provisioning approval, public metadata lives in a reviewed
public shell config module loaded before `js/vapid-public.js`, setting
`window.CAP_VAPID_PUBLIC`, plus the sender's public manifest. Fingerprint/version
are reviewable in Git. Private key is never there. Existing frozen validator
can stay unchanged; manifest version and public metadata must match sender
secrets before enrollment UI can be exposed. Today the effective config is `{}`.

### Secret names / storage (future names, not values)

* Custom sender-project Edge Secrets: `CAP_PUSH_VAPID_V1_PRIVATE` (d), future
  `CAP_PUSH_VAPID_V2_PRIVATE`, `CAP_PUSH_VAPID_SUBJECT`,
  `CAP_PUSH_DATABASE_URL` (restricted Cap login/pooler URL). No `SUPABASE_`
  custom names. Public versions/points/fingerprints are a code manifest, not
  private secrets. No fallback from a missing version to a different key.
* Platform-provided in the **isolated sender project**: `SUPABASE_URL`,
  `SUPABASE_SECRET_KEYS`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_DB_URL`, JWKS,
  execution/region IDs, and potentially legacy variables. Never use any legacy
  key. Ambient admin URLs/keys reach only the isolated project, which must have
  no financial data, replication, foreign data wrappers or stored Cap admin key.
* Named invocation key `cap-push-invoke` is an **sb_secret_** API key belonging
  only to that isolated project. It is NOT the Cap financial project's key.
* VAPID private material is NOT in any database, notification table, Vault,
  Git, browser, cache, HTML, backup/export, logs or payload. No VAPID value
  appears in the audited document. Runtime JWT cache below holds short-lived
  bearer tokens only, not a VAPID private key.

### Subject

Recommend an approved **public HTTPS Cap contact/support page**, controlled by
the operator and providing a real way for push operators to contact Cap. RFC
8292 permits https: as well as mailto:. It need not expose a personal email.
Do not invent a URL/email; final URI is an **open approval item**. Reject
localhost, private hosts, credentials/fragments, non-https/non-mailto and
unmonitored landing pages. Subject is public in the JWT, not a secret.

The selected library requires a **non-empty subject**. The final subject remains
unresolved until a real Cap HTTPS contact URI is reviewed; this must be resolved
before live sender activation. No personal email is invented or exposed.

### Rotation v1 -> v2

Never reuse version labels; v1..v999 regex unchanged. Publish v2 only after
its secret/public manifest match and the SW/enrollment rollout is reviewed.
Bindings retain their original key version. During a reviewed overlap window,
sender selects that exact version and keeps v1 key available for v1 bindings;
no v1 endpoint is sent with v2. Client `stale-vapid-key` / **Update this device**
remains the explicit rotation authority. Server does not create subscriptions.

Recommended default overlap ceiling: 30 days, operator may shorten on incident;
stop new v1 publications before retirement, allow bounded existing validity to
expire, then disable v1 sends and terminally suppress remaining v1 work. Keep
reservation/accepted/unknown receipts. Delete v1 private secret only after
active claims and JWT lifetime have drained and recovery review is complete.
Compromise: immediately stop that version, revoke invocation/DB credentials if
needed, do not attempt a silent key substitution. Old subscriptions require
explicit user update. JWT expiry/revocation is not a mechanism to rotate the
restricted subscription key itself.

## 6. Database / hosting alternatives and recommendation

| Alternative | Blast radius / secrets / grants | Pooling, atomicity, operations, future invocation |
| --- | --- | --- |
| A. Same-project Edge + direct PG using runtime boundary | Restricted LOGIN URL + VAPID secret; NOLOGIN definer role with narrow functions and RLS is much better than postgres/service-role queries. BUT ambient Edge financial-project admin secrets defeat whole-function compromise isolation | Supavisor transaction pooler, one connection, SQL functions atomic, straightforward pg_stat_statements. Free-capable. Password rotation/revoke EXECUTE recovery simple. Cron can invoke Edge later. **Not strict financial-isolation compliant without hosting isolation** |
| B. Same-project Edge + sb_secret_ + SECURITY DEFINER Data API RPCs | No new legacy JWT; explicit service_role EXECUTE only, no notification-table grant needed. However sb_secret_ is project-wide service_role/Auth/Storage privilege, not limited by the function's narrow normal code path. Compromise can use other APIs outside RPC. RLS bypass does not bypass missing table grants, but broad unrelated existing access remains | REST transaction per RPC, easy pooling/observability, atomic functions/locking possible. Least connection complexity/Free capable, easy named-key rotation. Cannot hold locks across HTTP/RPC transactions; cannot mint a custom-role sb_secret_ to fix scope. **Reject for Cap financial boundary** |
| C. Isolated Supabase sender project + execution-only Cap PG login | Recommended. Ambient admin keys confined to empty notification-only host project. Cap credentials can invoke only runtime functions; no financial privileges or authenticated-user RPCs. VAPID compromise still permits push abuse; DB compromise still exposes claimed notification data across owners by design, but no financial data | Same transaction pooler design as A. Separate project/secret/observability overhead, two-project inventory and recovery runbook. Free feasible only if an available active project slot/quota exists; no paid-only pooler feature required. Pausing/quotas mean no reliability guarantee on Free. Cron later uses isolated project's named key |

**Architecture review decision: isolated sender project C is approved.**
Same-project hosted Edge Functions receive ambient privileged Supabase secret
keys and a database URL. Strict Cap financial isolation therefore requires the
separate sender project, not merely a convention against using ambient keys.
The sender project must NOT receive a Cap secret API key, Cap service_role key,
Cap postgres password, Cap `SUPABASE_DB_URL`, or any financial API credentials.
Its only Cap database credential will be the dedicated notification runtime
LOGIN credential, whose provisioning and grants require later approval.

The sender consumes **one additional active Supabase project**. The current
Free plan permits **two active Free projects**; Free projects may be automatically
paused for insufficient activity (currently after one week). This is an
operational availability consideration, not a reason to weaken isolation.
Verify available slots and an availability/resume runbook before provisioning.
**No sender project is created during this checkpoint.**

No claim that Data API B has a smaller compromise radius than a truly
execution-only direct login: it does not. For C, ensure all functions/secrets
in that host project are trusted: Edge Secrets are project-scoped, not a
per-function hardware vault. Use a dedicated project/deploy credential and
no unrelated functions. If an isolated project is not acceptable/available,
**STOP for an explicit threat-model decision or another isolated supported
host**; do not quietly deploy in the financial project. Creating the project
is out of scope today.

### Exact proposed effective privileges (new amendment only)

The approved connection design is the **Supabase shared TRANSACTION pooler**,
port **6543**, using custom username **`[ROLE].[PROJECT-REF]`**. Obtain the actual
pooler host from the Connect dialog later; never construct or guess it. Disable
prepared statements using the eventual driver's equivalent of **`prepare:false`**.
Use the existing max-one connection/TLS/no-pipelining requirements below and
never rely on session-level SET state surviving transaction pooling.

The dedicated LOGIN receives only execution-only access to reviewed notification
runtime functions: **no financial table or function privileges**, no
`cap_sync_private` or `cap_notes_private` access, and no direct notification-table
access unless independently reviewed implementation evidence proves necessary.
It has no BYPASSRLS, SUPERUSER, CREATEDB, CREATEROLE or REPLICATION and no role
membership capable of reaching financial privileges. These restrictions concern
the LOGIN; the NOLOGIN function owner has only the internal privileges enumerated
below. No role or connection credential is created by this checkpoint.

`cap_notification_runtime` stays **NOLOGIN, NOINHERIT, NOBYPASSRLS** and gains
only the privilege needed as owner of constrained runtime definer functions:

* USAGE on private schema and a new non-Data-API schema `cap_notifications_runtime`.
* SELECT control, bindings, schedules, ledger; SELECT/INSERT/UPDATE a proposed
  `vapid_tokens` notification-only cache. No endpoint_owners privilege at all.
* Column UPDATE bindings: `state,generation,schedule_revision,updated_at`
  (retirement only inside functions). Never endpoint/p256dh/auth/owner updates.
* Column UPDATE ledger: state/attempt/claim/dispatch/retry/accepted/failure fields
  and new claim snapshot columns (section 7); no INSERT/DELETE/TRUNCATE. Manager
  publication already creates ledger entries. No pruning of protected receipts.
* Column UPDATE control: only `sender_run_token,sender_run_until,sender_last_started_at`
  proposed for overlap/rate control. No runtime grant to change kill switches,
  version allowlist or identities.
* SELECT/UPDATE RLS policies only for the listed tables/operations. Runtime
  policies intentionally span notification owners (sender is a server), never
  invoke spoofed user JWT claims. WITH CHECK prevents identity changes; function
  body predicates and column grants further restrict transitions. Control
  policy only singleton; token policy only allowlisted origins/versions.
* EXECUTE exactly required endpoint/key/timezone helpers and successor verifier
  (invoker/fixed path), no authenticated-owner management RPC. No CREATE/owner
  rights on tables/schemas. No membership in manager, writers, service_role,
  postgres, pg_read_all_data, auth admin, or arbitrary SET-capable groups.

New `cap_notification_sender_login`: LOGIN, NOINHERIT/NOBYPASSRLS/NOSUPERUSER/
NOCREATEDB/NOCREATEROLE/NOREPLICATION, unique strong rotating password, database
CONNECT, runtime-schema USAGE, EXECUTE on the seven named operations below
only. **No membership in runtime**, no SET ROLE, no table SELECT or private
schema USAGE. Definer functions check `session_user` is this login (or an
explicitly approved overlapping replacement login during rotation), reject all
other callers even if someone accidentally grants EXECUTE later. Do not trust
mutable custom GUC/JWT claims as database-login authentication.

Audit effective PUBLIC/default privileges on functions, schemas, sequences and
tables for BOTH roles, including every financial/auth/storage object. Inherit-
false is not proof of no PUBLIC access. A negative financial/management access
test is required before credentials can be supplied. No global financial
ACL/default-privilege rewrite is part of this design; unexpected access is a
blocking drift finding, not silently repaired here.

### Function security template

Seven uniquely named operations in the unexposed runtime schema:
`begin_run_v1`, `claim_v1`, `start_dispatch_v1`, `finalize_v1`, `recover_v1`,
`vapid_token_get_v1`, `vapid_token_put_v1`. No public REST wrappers.

Every function: runtime-owned, **SECURITY DEFINER**, fully schema-qualified
objects, fixed `search_path=pg_catalog`, `TimeZone=UTC`; volatile mutation
functions, no dynamic SQL, no caller-selected relations/owners/endpoints/copy.
Explicitly revoke all on each full signature from **PUBLIC, anon,
authenticated, service_role, manager, sender login** in the creating
transaction, then grant EXECUTE only to sender login (owner's implicit
privilege remains). Runtime owner is not an application login. Scoped global
default revoke for the new function-creator role may be added, but explicit
per-function revokes/postflight remain required; don't globally edit existing
application defaults. New helpers use SECURITY INVOKER, fixed path, owner
installer, EXECUTE runtime only (+ manager only if actually used by management).

Installer temporary ownership/membership grants must follow the reviewed V2
grantor-specific lifecycle and rollback proof; do not leave permanent SET
membership to install these functions. Successor verifier attests exact new
ACLs/policies/signatures and preserves all old financial negative checks.

## 7. Claim / dispatch / finalize contract (non-executable design)

### Smallest safe schema changes

Keep existing ledger textual states and PK. Existing columns do NOT retain the
generation/revisions claimed: schedules can be replaced in between two calls.
Add nullable immutable-per-attempt snapshot columns:
`claimed_generation bigint`, `claimed_schedule_revision bigint`,
`claimed_preference_revision bigint`, `claimed_vapid_key_version text`.
CHECKs require valid snapshots whenever claim_token is set. Bindings' endpoint
updates always advance generation, so no duplicate endpoint field is needed.
Token/time fields already model a lease; use `claimed_at + 60 seconds` rather
than adding another per-attempt lease column. Snapshot values come from joins,
not from the HTTP caller. Preserve accepted/unknown uniqueness across generation
changes, schedule deletion/republication and retries.

Control adds default-off runtime capability/dispatch flags, permitted sending
VAPID versions, and the three non-secret run-lease fields above. Keep the
existing background prohibition during dark installation; final activation
requires a separately reviewed amendment and truthful readiness contract. No
runtime function can turn dispatch on. Add only useful partial ledger recovery/
retry indexes after EXPLAIN locally. No financial indexes or data changes.

One additional private table `vapid_tokens` is justified for Apple JWT reuse
across Edge isolates (section 8). New indexes/constraints/policies are attested;
do not pretend the frozen five-table verifier already permits them.

### Operations

| Operation | Input | Output / atomic effects |
| --- | --- | --- |
| begin_run_v1 | `run_id uuid` generated by Edge | CAS singleton lease: one run globally for 45s, no new run within 60s of last start; `{ok,run_token,run_until}` or coarse `parked/busy/rate_limited`. No HTTP caller controls budget/versions |
| claim_v1 | `run_token uuid` | One eligible occurrence, not an unbounded batch. Returns opaque `claim_token`, `claim_until`, generation/revision/version snapshot and fixed expiry bounds; no endpoint/keys yet. Atomically queued/retry_wait -> claimed, attempts +1, snapshot/time/token set; max **3 attempts** despite foundation ceiling 10 |
| start_dispatch_v1 | `run_token,claim_token` | Full revalidation under locks, then claimed -> dispatch_started and timestamp, committed BEFORE HTTP. Returns ONLY claimed endpoint, p256dh, auth, exact key version, remaining TTL bound and token. Denied/replayed/expired/stale requests return no subscription material |
| finalize_v1 | `claim_token, result enum, retry_after_seconds nullable` | Token-CAS, idempotent finalization; returns `{ok,state}` only. Maps to existing states/failure_class. No arbitrary error text/body or caller-supplied timestamps/identities. Late finalization never overwrites a newer claim/binding generation |
| recover_v1 | `run_token` | Bounded recovery (<=100 rows), DB clock-based. Expired claimed lease -> queued/retry_wait only if no dispatch evidence and still eligible. Expired dispatch_started -> unknown/ambiguous terminal. Returns counts only |
| vapid_token_get_v1 | `run_token,origin,version` | Valid cached authorization OR a generation lease (opaque token, <=15s). Exact endpoint-origin/version allowlist, not an arbitrary URL; never caller-selected private key |
| vapid_token_put_v1 | `generation_token,authorization,expires_at` | CAS insert/replace only under generation lease; strict bounded header/claims shape, matching origin/version/public manifest and expiry <=24h; one replacement/hour unless expired. Returns boolean, never echo token |

`finalize` enum: `accepted`, `invalid_subscription`, `configuration`,
`temporary_rejection`, `ambiguous`, `expired`, `disabled`. Retries exhausted ->
retired/temporary_rejection. `accepted_at` is DB acceptance-record time, **not
device display time**. Existing last_confirmed_at stays NULL. No general
"send endpoint" or "finalize arbitrary binding" operation exists.

All token parameters are UUIDs, `origin`/`version` bounded text, authorization
bounded text <=2048 bytes, expires_at timestamptz, retry_after_seconds a nullable
nonnegative integer (bounded by remaining validity). Unknown enums/NULL required
arguments fail before mutation. Token lookup may return the authorization header
only to the authenticated execution-only DB caller, never the Edge HTTP caller.
CAS finalize preserves dispatch_started_at/attempt_count and the terminal receipt
required by existing CHECKs; it does not erase dispatch evidence on success.
An explicit retry_wait can clear old dispatch evidence only when a documented
non-acceptance is durably recorded, and a later claim gets a fresh token.

### Eligibility and locking

1. DB clock, kill switches and approved contract manifest must pass at claim
   AND start. Runtime selects only schedules + matching ledger + matching
   binding by **all** of `(user_id,binding_id,candidate_digest)`.
2. Binding pending; schedule protocol/engine/digest exact; generation,
   schedule_revision, preference_revision equal current binding; allowed exact
   VAPID version (not just syntactically v1..v999); sender manifest has its
   matching public/private key. Null expiration allowed, non-null must be later
   than DB clock. No call to any financial table.
3. `send_after <= clock`, `expires_at > clock`, `publication_valid_until > clock`,
   publication horizon/locale constraints intact. Only queued or due retry_wait,
   attempts <3, never accepted/unknown/retired/suppressed.
4. Select binding candidates in stable order with `FOR UPDATE SKIP LOCKED`,
   then lock schedule and ledger in consistent **binding -> schedule -> ledger**
   order shared with management operations; recheck predicates after locks.
   Update token/snapshot inside that same transaction. No unlocked SELECT-then-
   UPDATE pattern. Idempotent token replay does not hand out a second send permit.
5. start_dispatch repeats snapshot/lease/eligibility checks and locks, grants
   at most ONE dispatch permit per claim token. Unknown DB commit outcome on
   start => **do not send** and never replay for another permit. Only after a
   positive committed permit does Edge perform one HTTP request.
6. Retirement CAS must match claimed generation/version. 404/410 from an old
   endpoint must not retire a newly replaced binding. Current retirement sets
   retired, generation +1, schedule_revision +1, updated_at; queued work becomes
   suppressed/disabled when recovered. Keep endpoint_owners reservations and
   accepted/unknown ledger receipts. No automatic resubscribe or account move.

### Disable/rotation race: a hard distributed boundary

Claim/start prevents dispatch authorization AFTER a committed disable,
replacement or expiry. But a disable may commit AFTER start authorization and
BEFORE/AFTER the remote HTTP acceptance. No short SQL transaction can revoke
an already authorized network request. Do **not** promise absolute "no message
after disable" or recall from a push service. Linearization point is committed
start_dispatch; use minimal permit-to-fetch delay, 10s HTTP deadline, short TTL,
local unsubscribe and SW notification-only enabled/generation tombstone before
disable/sign-out. If that race is unacceptable, activation is blocked pending
a different reviewed user-facing guarantee; holding DB locks during HTTP still
cannot retract a remotely queued notification.

Frozen client caution: `reconcile()` captures identity but does not recheck it
before publishing its final state; beforeSignOut does not use the enrollment
Web Lock. Existing tests do not establish every delayed-result/disable race.
No client code is changed here. Add adversarial tests and separately authorize
any required client amendment before live activation; do not treat prior
architecture approval as proof of impossible distributed guarantees.

### Crash windows / conservative recovery

| Crash window | Result and recovery | Duplicate vs miss |
| --- | --- | --- |
| Before claim commit | No durable claim; another run can claim | Safe retry, no network |
| After claim, before start permit | 60s claim expires; recover only if no dispatch timestamp | Safe retry; token fencing rejects late worker |
| After committed start, before HTTP | Remains dispatch_started, becomes unknown/ambiguous after deadline | **Possible miss**, NO resend; cannot prove request wasn't sent |
| After remote acceptance, before finalize | Same unknown terminal; accepted is never inferred from absence of failure | Avoid duplicate; acceptance/display unproven locally |
| After explicit failure, before finalize | Without durable classification recover as unknown, not retry_wait | Possible miss, safer than unproven resend |
| After retry_wait committed | New token after backoff, full revalidation, <=3 attempts | Retry only documented explicit non-acceptance |
| After finalize accepted | Receipt remains terminal even across republish/restart | No application retry; not exactly-once OS display |

No lease recovery of `dispatch_started` can simply requeue it. Expired work is
suppressed/expired (failure_class expired), not another textual state. Never
clear ambiguous/accepted receipts to make a manual test work. Repeated payloads
can be coalesced by a tag but that is not proof of exactly-once presentation.

## 8. RFC behavior, token reuse and HTTP results

### Encryption / authentication

RFC8291: library generates fresh **ephemeral P-256 ECDH pair and 16-byte salt
per message**; imports browser p256dh, derives ECDH secret, mixes 16-byte auth
using HKDF-SHA256 and WebPush info, derives AES-128-GCM key/nonce, single record
with final 0x02 delimiter and aes128gcm content encoding. No compression,
financial payload, reusable ECDH private key, or VAPID signing-key reuse as ECDH.
All crypto comes from selected library/platform APIs.

RFC8292: ES256 (ECDSA P-256/SHA256); `aud = new URL(endpoint).origin` (no
path/query, never Cap URL); integer `exp` in future <=24h. Library uses 12h
which leaves clock-skew margin. Exact selected public key appears as `k` in
`Authorization: vapid t=<JWT>, k=<public point>`. Contact sub policy above.
VAPID JWT is not a Supabase JWT/API key; never interchange these auth domains.

Apple W8 says do not refresh JWT more than once/hour. Warm-isolate memory cache
alone is insufficient across invocations/regions. Proposed `vapid_tokens`
contains ONLY `origin,version,authorization,created_at,expires_at,generation_token,
generation_until` with composite PK `(origin,version)`, size/allowlist/time
CHECKs, forced RLS, runtime-only S/I/U and no browser/manager/service_role
access. Short-lived JWTs are bearer credentials: encrypted DB backups/access
control and no log/return-to-HTTP policies apply; private VAPID key is NOT there.
Single generation lease avoids concurrent refreshes; cache token for 12h,
refresh with >1h spacing and ~5min expiry margin. Lost response to put: re-read,
never immediately regenerate. Warm cache may accelerate, not replace DB cache.
Deletion/empty cache during a live window requires operator pause/drain before
regeneration to preserve reuse policy. Key selection is exact, never fallback.
No `SUPABASE_SECRET_KEYS` value is stored in this table.

### Outbound request

One POST to the complete stored capability URL, never a native FCM API. Repeat
canonical endpoint allowlist check immediately before fetch; reject redirects
(`redirect:error`), IP literals/private hosts, userinfo/ports/fragments,
non-HTTPS, unrecognized suffixes. Do not follow a Location/receipt URL. TLS
certificate validation/SNI enabled; Apple supports HTTP/1.1 as well as HTTP/2.
Prefer no extra proxy, no custom unverified CA, no retries by HTTP middleware.
Test DNS/SSRF defenses; new vendor endpoints require explicit allowlist review.

TTL = minimum of **300 seconds** and whole positive seconds remaining to
schedule/publication/browser-expiration (if known); subtract transit margin,
skip if <=0. Urgency normal, no high-priority financial copy. No Topic needed
initially; stable local SW tag coalesces display. No receipt subscription,
location URL persistence or encrypted body logging. Bounded 10s fetch deadline,
max 1 in-flight request/run and max 3 occurrences/run, stop after 35s, leaving
time before 45s run lease. Cap max 3 total attempts/occurrence; no immediate
in-process retry after any POST.

### Classifier (provider adapters, not blind status retry)

| Evidence | Durable result | Binding / operator / retry policy |
| --- | --- | --- |
| Documented acceptance (RFC/Mozilla/Apple 201; other documented 2xx) | accepted, accepted_at | No retry; means service accepted, not decrypted/displayed. Unexpected 2xx also terminal/no retry, flag protocol observation rather than resend |
| 404/410 from an allowlisted canonical endpoint | retired/invalid_subscription | Retire matching binding by CAS, stop work, preserve reservation. Apple BadPath 404 may be corruption/config: quarantine/alert, never retry same path; don't modify replacement binding |
| 401/403, BadJwtToken, VapidPkHashMismatch, bad public key | retired/configuration occurrence | Do NOT retire subscription automatically. Stop run/version, operator intervention, validate clocks/subject/key/audience; no automatic same-occurrence retry |
| 400/405/413/415, encryption/payload/TTL/header error | retired/configuration | Fix sender/data validation, stop affected run; never arbitrary smaller-body retry after unknown acceptance |
| Explicit 429 non-acceptance | retry_wait/temporary_rejection | Honor Retry-After, provider backoff; keep binding. <=3 attempts, within expiry; stop further sends to affected service in run |
| Explicit documented 503 rejection (e.g. Mozilla retry errno, Apple ServiceUnavailable/Shutdown) | retry_wait/temporary_rejection | Bounded retry only when provider semantics establish non-acceptance; unknown reason is ambiguous |
| 500/502/504 or bridge/upstream timeout without proof of non-acceptance | unknown/ambiguous | NO automatic retry. A gateway/bridge can fail after downstream acceptance; alert aggregate counts, keep binding |
| Fetch timeout/reset/abort, lost response, redirect, uncertain start commit | unknown/ambiguous (or no HTTP if no positive permit) | NO automatic retry; not safe to infer non-delivery from a network exception |
| Invalid point/auth on local pre-dispatch validation | retired/configuration (no dispatch) | Quarantine occurrence/binding for explicit repair, do not log data or repeatedly retry. Missing/wrong sender secret => fail whole run before claiming |
| Expired schedule/publication/known browser expiration | suppressed/expired | No send/retry. Known expired subscription may be retired under matching-generation CAS |
| Disable/stale snapshot | suppressed/disabled | No new send/retry; never transfer to another owner |

Provider JSON reason parsing is size-limited (<=2KiB) into a fixed allowlist;
never log/store response bodies/statusText/headers. WNS response details must
be verified with controlled 5B.6 traffic; until then unknown responses default
to terminal ambiguous/configuration, not generic 5xx retries.

Retry delay proposal: `max(valid Retry-After, min(900, 60*2^(attempt-1)))`
plus uniform nonnegative jitter up to 20% of that base; parse HTTP date or
seconds, reject malformed/negative values, never retry earlier than provider
asks. If provider asks beyond expiry, terminal expired. DB clamps inputs and
derives next_retry_at from its clock; max 3 attempts inclusive, no retries
past publication/claim eligibility. Global/per-service throttling and retry
age limits prevent a compromised caller from requesting an unbounded drain.

## 9. Edge endpoint security specification

Future function name: **`cap-notification-sender`**, in isolated sender project.

| Setting | Proposed requirement |
| --- | --- |
| verify_jwt | false; NOT public access authorization |
| Authentication | Plain-fetch `@supabase/server` named mode `secret:cap-push-invoke`, exact current stable patch pinned/locked at implementation; reject user/publishable/default/other-project keys, not secret:*; no privileged ctx client used against Cap |
| Method/content | POST only, application/json (optional charset=utf-8); reject CORS/browser Origin, no wildcard CORS; credentials not allowed in URL |
| Body | Exactly `{ "operation": "process-due-v1" }`; reject unknown keys, arrays, malformed JSON, query params; max 256 bytes streamed even if Content-Length omitted/false |
| Input boundary | NO endpoint, p256dh, auth, owner, binding, financial row, payload, dry-run bypass or caller-selected limit/version |
| Response | `{run_id, status, counts:{claimed,accepted,retry_wait,terminal,unknown}, duration_ms}`; coarse integer counts only, never subscription material/claim tokens/SQL details; Cache-Control no-store |
| Status codes | 200 completed/parked; 401 unauthorized; 405 method; 413 size; 415 type; 400 schema; 409 overlap; 429 run rate (Retry-After); 503 coarse configuration/storage unavailable |
| Overlap/rate | DB begin_run lease/fence plus >=60s spacing across regions; no in-memory-only lock; max 3 occurrences/one network request at a time |
| Budget | 35s application work, 10s per push, DB calls <=2s statement / <=500ms lock wait / bounded connection wait; stop new claims near deadline; no waitUntil background send after response |
| Database | Custom restricted `CAP_PUSH_DATABASE_URL`, shared transaction pooler, driver pool max=1/module instance, prepared statements disabled, no pipelining, encrypted with verified server certificate/hostname; never injected financial postgres URL |
| Session state | No session SET ROLE; no assumed state across transactions; SET LOCAL timeouts inside the same transaction if needed; functions have own search_path/UTC |

Exact driver/auth SDK patch pins are a future implementation gate (not guessed
in this audit); they must be reviewed and locked alongside the exact sender
library. No broad JWT shared signing secret, Management API token or legacy
service_role key is needed in runtime. Caller authentication, VAPID signing,
and database-login credentials are three distinct boundaries.

### Logs, instrumentation and recovery

Allow only `{run_id,counts,result_class,duration_ms,error_code}` with closed
code/class enums. No owner/binding/digest/claim ID, endpoint/keys, JWT/header,
VAPID private material, secret API key, full DB URL, response body, encrypted
payload bytes or thrown library/SQL objects. No console.error(error), tracing
of request/response bodies, raw SQL parameter logs or environment dump. Configure
platform/log drains/access retention and secret-header redaction **before**
using a real API key. Audit upstream access logs too: a code-level sanitizer
does not redact a gateway/database audit log automatically.

Supabase built-in admin credentials remain a risk in the host project; any
dependency RCE can steal that project's secrets. Isolation limits financial
blast radius, not VAPID abuse. Alert on configuration/ambiguous/retirement count
spikes, not payload identifiers. Operator kill switch first; rotate named
invoke key, restricted DB login (overlapping two login names then revoke old
CONNECT/EXECUTE and terminate old connections), and affected VAPID version
independently. No auto-repair of lost receipts after restore. Restored database
could forget accepted pushes: keep delivery disabled until reconciliation or
expire all pre-restore work conservatively. Reconstructing exactly-once history
from the push service is not available.

## 10. Payload, SW and Phase 5A coordination

### Empty vs versioned payload

Empty push is standards-possible and Apple documents omitting encoding on an
empty body. It saves encryption work but cannot carry protocol version,
generation fence or an expiry guard; selected convenience API is data-based.
Choose a **minimal versioned encrypted payload** instead for bounded parsing,
wrong-version rejection, delayed-delivery expiry and notification-only fence
checks. It is not arbitrary database title/body JSON.

Exact proposed allowlist (all fields required, no extras):

```text
{ protocol: "CAP_PUSH_V1", type: "reminder", version: 1,
  installation_id: UUID, binding_id: UUID, generation: positive safe integer,
  expires_at: integer Unix seconds }
```

Max 512 UTF-8 bytes pre-encryption. IDs are opaque notification-only routing
identifiers, never financial IDs, user ID, candidate_digest, endpoint or secret.
Sender constructs the object itself from the claim; schedule rows cannot
inject content. They still have metadata privacy cost; only inside ciphertext,
not logs/visible copy/tags. DB bigint exceeding JS safe range is rejected, not
rounded. No amount/balance/merchant/bill/subscription/card/account/category,
history, due totals, link, title/body or actions. No optional free text.

### Service worker (design only)

* Future `push` listener immediately attaches one async promise via
  `event.waitUntil()`. No `pushsubscriptionchange` handler required/introduced.
* Bounded parse of event.data; require exact object keys/types/protocol/version,
  valid IDs, sane expiry and positive safe generation. No evaluation/HTML,
  network fetch, financial IDB, or payload-supplied URL/assets/copy.
* Read only a **future reviewed notification-only** local delivery fence
  (installation/binding/generation/enabled). Current v1 local schema must not
  be silently extended: use a separately versioned new notification-only store
  or explicit schema amendment/normalization review. Write disabled tombstone
  BEFORE disable/sign-out; compare to prevent old-account/old-generation display.
  Missing/uncertain/expired/mismatching state fails closed. No prompt, subscribe,
  register, invalidate or auth refresh from push.
* Valid permitted push => `self.registration.showNotification` with compiled
  title **Cap reminder**, body **Open Cap to review your reminders.** Fixed
  same-origin cached icon/badge, tag **cap-background-reminder-v1**, renotify false,
  data only `{type:'cap-reminder',version:1}`. One stable generic tag intentionally
  coalesces multiple occurrences; no candidate/account ID in visible tag.
* Keep existing safe `notificationclick` behavior: close, focus scoped Cap
  window, safe center-open message, otherwise scope URL with fixed query flag.
  No financial action/deep link. The page's lock/auth gating remains authoritative.
* Malformed/stale/disabled pushes must not display arbitrary content. Failing
  closed can conflict with Apple's no-invisible-push rule; reject sends server-
  side first, bound TTL, unsubscribe on disable. Document possible permission
  revocation after a race/corruption; never advertise silent push as supported.
* Generic content is mandatory even when the local Phase 5A amount opt-in is ON.
  No background financial read to improve text. Accepted push != permission to
  bypass DND/OS settings; getNotifications/tag is not a durable receipt database.

### Preventing double OS presentation (required before activation)

Current `js/notifications.js` deliver() uses only its Phase 5A localStorage
history and owner Web Lock. It does not share server ledger/digests, so it can
present an occurrence also dispatched remotely. **Independent ledgers cannot
prove cross-channel deduplication.** Do not mark a server acceptance as a local
display receipt or rely on matching tag for correctness.

Recommended rollout decision: per origin/device, when an existing background
subscription or durable background-mode tombstone is present (including
unknown/stale/pending-disable), suppress **all Phase 5A automatic OS notifications**,
not just a category. Continue local in-app center/unread computation. Preserve
separate **Enable browser notifications** action and explicit local **Test**.
Check mode again immediately before Phase 5A present, under notification
coordination; enroll transition suppresses Phase 5A BEFORE subscription creation.
On removal do not auto-enable Phase 5A OS fallback until server invalidation,
unsubscribe and maximum outstanding TTL have drained; explicit user-approved
switch-back only. Missing coordination/storage => in-app only.

This is a required **future amendment to frozen client presentation behavior**,
not changed by this audit. If freeze means no later client changes at all,
sender activation is blocked. Phase 5B.4 must additionally avoid publishing
occurrences already attempted by Phase 5A during the transition; fail closed
rather than retroactively re-alert. No new financial baseline/outbox involvement.

## 11. Phase boundaries and future Cron/pg_net

| Phase | Scope, not silently absorbed here |
| --- | --- |
| 5B.3 | VAPID provisioning (separate ceremony approval), isolated sender, runtime claim/start/finalize/recovery boundary, Web Push encryption/authentication, service-worker push handling and Phase 5A duplicate suppression; development uses local/manual intercepted requests only and stays parked |
| 5B.4 | Client bounded schedule publication, digest/timezone/preference lifecycle, changed/paid/deleted source cancellation and publication lease renewal; add publish to browser only under this review |
| 5B.5 | Automatic periodic invocation, pg_cron/pg_net/Vault design and explicit enablement, monitoring/quota/rotation; not a new sender endpoint accepting endpoints/keys |
| 5B.6 | One explicitly approved owned-device live test, then controlled physical-platform certification; staged activation/copy/flag compatibility and rollback review |

**Final Cron-to-sender authentication is NOT approved by this audit checkpoint.**
The exact invocation/authentication mechanism remains a separate Phase 5B.5
security decision. The following is a candidate compatibility design only.

Future Cron could call POST **process due work**, same exact body, to isolated sender
project URL with its named `sb_secret_` key on `apikey`. No subscription/financial
material in HTTP body/SQL. No legacy service_role JWT in Authorization. Use a
fixed URL and no caller-directed destination. If Postgres needs invocation
credentials, use **Vault only for this invocation key/URL**, not VAPID private
key or Cap admin credentials. Separate approval/migration in 5B.5 must scope
Vault decrypted-view/function execution to a dedicated scheduler boundary.

Vault encrypts at rest; it does NOT protect the decrypted headers queued by
pg_net. S11 explicitly warns database LOGIN roles can read queued headers by
default. The new execution-only sender login is itself one such role unless
queue grants are hardened! Before enabling pg_net, audit/revoke effective PUBLIC
queue/response access where supported and regression-test every app/custom
role; never expose net schema via Data API. If the platform cannot enforce
that boundary, **do not place a project-admin sb_secret_ key in the queue**;
re-review an isolated external scheduler/scoped invocation credential instead.
Even the isolated-project key is admin for that project; do not call it scoped
just because named. No plaintext key in cron.job, SQL scripts, pg_stat_statements
or response bodies. Queue removal after dispatch is not secure log erasure.

Cron/pg_net are only wakeups; DB claims/receipts remain authoritative if an
invocation is duplicated, delayed or lost. Jobs don't prove delivery. Free
plan pause, CPU/time/connection/egress quotas and vendor throttles mean no
scheduled-delivery SLA. No extension, scheduler, Vault secret or Cron job is
created/enabled in this audit.

## 12. Proposed implementation file and SQL amendment map

**These are future paths/contracts, not files created by this task.**

| Future file | Scope |
| --- | --- |
| `supabase/functions/cap-notification-sender/index.ts` | Auth/body limits/run orchestration, no public send API |
| `supabase/functions/cap-notification-sender/{webpush,runtime,results}.ts` | Library adapter + token reuse, fixed SQL calls, coarse classifier |
| `supabase/functions/cap-notification-sender/deno.json`, `deno.lock` | Exact pins, frozen integrity, isolated host project build |
| `supabase/config.toml` | Only reviewed sender function auth configuration; no deploy/cron implicit hooks |
| `tools/notification-vapid-ceremony.*` | Future reviewed no-secret-output ceremony; never production values in source |
| public VAPID metadata module + manifest wiring | Future separately approved public-only config; frozen validator remains; do not provision during audit |
| `service-worker.js` | Future push listener/fence/click regressions, shell VERSION/CORE bump then (currently v369 untouched) |
| notification-only coordination module and `js/notifications.js` hook | Future approved local schema/suppression amendment, no financial stores |
| `tests/notification-sender-*`, local Edge tests | Intercepted crypto/HTTP tests, real PostgreSQL concurrency, browser SW tests |
| `docs/notifications-phase5b3.md` | Future implementation/activation runbook and results |

New SQL artifact proposed name `supabase_notifications_sender_5b3.sql`, only
after separate approval; never edit foundation/V1/V2. Its amendment map:

1. Hash/catalog/empty-runtime preflight and explicit installation guard;
   prove financial row/schema/ACL/RPC fingerprints unchanged.
2. Add claim snapshot columns/checks and bounded recovery/retry indexes.
3. Add default-off runtime flags, public version allowlist and run lease fields;
   retain background prohibition/parked behavior for dark install.
4. Add private `vapid_tokens` cache, RLS/FORCE RLS, indexes, strict grant matrix.
5. Restricted login provisioning as a separate secret ceremony (NO password
   literal in SQL artifact), runtime schema/functions/policies/column grants.
6. Successor catalog verifier explicitly enumerating manager vs runtime function
   classes and ACLs, validates tokens/snapshots/flags. Existing management
   `contract_ok()` must delegate to an exact reviewed successor or be explicitly
   amended with equivalent checks; no blanket bypass. Financial verifiers and
   owner management identities remain intact.
7. Transactional install privilege cleanup, rollback/drift tests and postflight.
   Readiness activation/version negotiation and background-control CHECK change
   are a **separate activation amendment** (not hidden in dark install).

No new sender SQL needs to amend null-expiration behavior or publish_v1 body.
Publication semantics remain a 5B.4 review. No default-privilege changes on
financial objects, extension installs, trigger network calls or scheduler SQL.

## 13. Future validation plan — NOT RUN / NOT CERTIFIED here

No tests that generate keys were run during this audit. Local research was
source/metadata review and a disposable SELECT proving PostgreSQL null logic.
Implementation suites below are a plan, not inherited PASS results from 5B.2B.

### Library / runtime compatibility

Use **ephemeral test-only** keys generated in a network-denied local process,
never Cap v1. No snapshots/printing/private fixtures committed; terminate process
and clear temporary test storage after test. Intercept ALL fetches; literal
vendor endpoints are only request-construction mocks, never real destinations.

| Test | Required proof |
| --- | --- |
| Serialization round trip | JWK d/raw point sizes/canonical encoding, import/export round trip, signature verifies matching public key |
| Client equality | Public bytes match applicationServerKey and `CapVapidPublic.validate`, lowercase SHA256 matches decoded bytes |
| JWT | Decode header/claims locally: alg ES256, signature verifies, aud origin for exact FCM/Mozilla/Apple/WNS fixtures, exp future <=24h (12h), approved HTTPS subject |
| Token reuse | Multiple runs/isolates use same cached header; concurrent generation single winner; no premature refresh; crash/lost put response; expiry/version separation |
| Encryption | RFC8291 known-answer/decryption interoperability, aes128gcm/single record/0x02, fresh salt/ECDH per message, ephemeral ECDH public != VAPID public |
| Vendor request | HTTPS POST full opaque endpoint, binary body/encoding, positive bounded TTL/urgency; exact origin audience; redirects fail; no OAuth native FCM/WNS/APNs credentials |
| Runtime | Real current Supabase CLI Edge image, import/bundle/CPU limits, WebCrypto + dependency uint8array/base64url behavior, no Node-only accidental imports, frozen lock |
| Interception | Any unmocked outbound network attempt fails test; mocked 201 does not claim device certification |

### Failure, security and database tests

Disposable **real PostgreSQL** for concurrent connections/locks/pooler behavior;
PGlite can supplement deterministic SQL but cannot certify concurrency.

| Case | Required result |
| --- | --- |
| Duplicate/concurrent sender invocations | One run lease, one claim/start permit/HTTP per occurrence; replay does not resend |
| Crash after claim | Lease recovery only without dispatch evidence; late token fenced |
| Crash before HTTP after start; crash after remote acceptance | unknown terminal, no replay or auto-requeue |
| Crash after failed HTTP before finalize | unknown terminal; don't reconstruct retry intent from memory |
| Stale generation, schedule revision, preference revision, publication replacement | claim/start deny; stale finalize can't retire replacement |
| Disabled/retired binding, VAPID not allowed/missing secret, expired schedule/publication/browser expiration | zero network; terminal suppression/configuration; null browser expiration still eligible if all other gates pass |
| Cross-owner / forged caller IDs | No arbitrary IDs accepted at invocation; composite joins/fenced tokens prevent mixup |
| 404/410 | Matching-generation retirement, reservation retained, replacement untouched |
| 401/403 | No invalid-subscription retirement/retry; operator configuration pause |
| 429 / Retry-After | Not before requested time + bounded jitter, max3, expiry enforced |
| 5xx/bridge timeout / network timeout | Unknown unless explicit documented rejection; no blind retry |
| Invalid endpoint, off-curve key, malformed auth, oversized response | Fail closed before dispatch where possible, no secret error content |
| Missing/wrong private key, mismatched public/private or fingerprint | Whole-run startup proof fails before claim/HTTP |
| Unauthorized/public/user/browser Edge caller, other/default secret key | 401 (or browser Origin rejection), no DB access; only named isolated-project key works |
| Oversized/chunked/malformed body, unknown operation/endpoint/body field | 413/400/415/405 before work, no arbitrary send |
| Token functions / PUBLIC defaults / temporary installer grants | Exact ACLs, only approved login, no leaked helper execution, rollback restores old state |
| Financial negative privilege | SELECT/mutate/schema access/financial RPC/SET ROLE denied for login and runtime, including effective PUBLIC paths; no financial baseline/outbox/exports touched |
| Pooler | Alternating transactions/connections cannot leak role/timezone/GUC; max1/prepare:false/no pipeline/TLS identity verified |
| Redaction | Seed canary fake secrets into every error path; none in logs, HTTP response, SQL logs, snapshots or traces |
| Kill switch / lost DB connection / restore | No new permits, no HTTP without positive start commit, pre-restore receipts not presumed safe |
| SW payloads | Valid only generic text; invalid/extra/empty/old protocol rejected, TTL/fence/account switch honored, no financial read/network/deep-link |
| Phase5A overlap | Visible tab + remote push, reload/offline/stale/pending-disable and mode-switch races never auto-fallback to a second channel; explicit Test/in-app center preserved |
| pg_net future negative grants | Login cannot read queue headers/Vault decrypted view; not an excuse to enable extensions in 5B.3 |

Also rerun frozen foundation/V1/6O SQL suites, 5B.2B A/B/RPC/transport suites,
notification/financial UI/offline/sync regressions, all JS/CJS/TS checks, manifest
and config parsing, diff/privacy gates at implementation time. Changes to
frozen client behavior or successor readiness require new explicit review.

## 14. Phase 5B.6 controlled live test and platform plan

First live test requires separate authorization: one operator-owned account,
one explicitly enrolled owned device, reviewed real v1 ceremony and secrets,
SW capable/generic mode installed, one bounded notification-only occurrence
published by the approved 5B.4 path. No arbitrary endpoint fixture or financial
mutation to manufacture eligibility. Cron OFF, manually invoke normal process-
due body once in an approved allowlisted test window. Record coarse server
acceptance and the operator's observed display/click separately, verify
generic text/auth gating, invalidate/unsubscribe/disable test window afterward.
Do not clear delivery receipts or send a second push just because first display
was absent. Never use an endpoint not owned/authorized by the project.

| Platform / case | Planned observation | 5B.3A status |
| --- | --- | --- |
| Windows Chrome | Explicit enroll, closed/foreground receive, safe click, remove | NOT TESTED |
| Windows Edge | Same, actual returned push provider/WNS request compatibility | NOT TESTED |
| Android Chrome | Install/tab context, OS lock screen, background/offline | NOT TESTED |
| iPhone Home Screen app | User gesture, generic visible push, Focus behavior | NOT TESTED |
| iPad Home Screen app | Same + installed identity/orientation | NOT TESTED |
| macOS Safari webpage | No incorrect Dock-install requirement, generic display | NOT TESTED |
| Firefox | Mozilla acceptance/display/quota and unsubscribe | NOT TESTED |
| iPhone/iPad Safari tab negative | No unsupported background enrollment/prompt path | NOT TESTED |
| Offline/reconnect within/beyond TTL | No stale display past expiry, no financial fetch | NOT TESTED |
| Permission denied/removed | No re-prompt, no inferred enrollment, 404/410 retirement | NOT TESTED |
| Subscription removal and master off | Invalidation, tombstone, TTL drain, no silent local fallback | NOT TESTED |
| v1 -> v2 overlap/retirement | Explicit Update path, no wrong-key send | NOT TESTED |
| Sign-out/account switch with delayed RPC/push | No cross-owner details/action; fence/unsubscribe races documented | NOT TESTED |
| DND/Focus/OS notifications disabled | Acceptance can occur with no visible alert; no duplicate resend | NOT TESTED |

Fake-PushManager Chrome tests are NOT a substitute for any row above.

## 15. Open questions / blockers for implementation approval

1. Isolated sender architecture is approved; verify Free project slots,
   egress/invocation quotas, access controls and no ambient financial credentials.
   Same-project hosting requires explicit acceptance of a larger threat model;
   it cannot be called strict financial isolation.
2. Approve the exact public HTTPS Cap contact URI and secure key ceremony/
   recovery custody. No subject/key/config provisioned here.
3. Approve the successor verifier/runtime privilege model, additional token
   cache/claim snapshot/control columns and temporary installer lifecycle.
4. Independently test selected 2.0.0 package in the current Edge image, audit
   transitive dependency/advisory/integrity state and freeze other driver/SDK
   exact versions. No library runtime compatibility certification yet.
5. Approve client schema/mode/tombstone/suppression amendments; audit frozen
   late-session-result/sign-out overlap behavior with adversarial tests. Current
   v1 records alone cannot supply all proposed SW freshness evidence.
6. Accept the start-dispatch linearization, ambiguous => miss tradeoff, generic
   coalescing and Apple's fail-closed/invisible-push tension. No absolute recall,
   exactly-once or delivery-after-disable guarantee can be promised.
7. Activation/readiness flags are structurally parked today, not just false
   values. Separate activation compatibility review must preserve enrollment
   cleanup and not strand installed cached clients. This audit does not authorize
   changing the frozen client or enabling background delivery.
8. Cron/Vault/pg_net queue confidentiality is a separate 5B.5 blocker; do not
   place any project-admin key in that queue until effective grants/logs pass.
9. 5B.4 source-edit/cancellation/publication staleness and Phase5A transition
   dedup require separate design, not a sender querying financial tables.

## 16. Audit exit status

Audit finalization changes only `docs/notifications-phase5b3-audit.md` and roadmap
wording in `docs/notifications-phase5b2.md`. No implementation, SQL artifact,
secret file or dependency was created. The checkpoint starts from HEAD and
origin/main `7db591a3bb1a04b7b9998b6f940627ac1443995e` (`0/0`); the final Git
checkpoint is documentation-only. Frozen implementation files are untouched;
service worker stays **cap-shell-v369**, **push handler absent**,
**pushsubscriptionchange handler absent**; production public VAPID config `{}`.

| Action | Performed |
| --- | --- |
| Production contacted/read/mutated | NO / NO / NO |
| VAPID production or ephemeral key generated | NO |
| Production secret created | NO |
| Sender implemented / Edge deployed | NO / NO |
| Background enabled / pg_cron enabled / pg_net enabled | NO / NO / NO |
| Real subscription / Web Push | NO / NO |
| Financial changes / Cloud Sync changes | NO / NO |
| Audit-finalization Git commit / push | Authorized for these two documents only |
| Manual deploy | NO |

**Phase 5B.3A audit = COMPLETE. Phase 5B.3 implementation = NOT STARTED.**
**STOP FOR REVIEW.**
