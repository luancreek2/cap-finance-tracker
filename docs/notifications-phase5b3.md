# Phase 5B.3B — dark Web Push sender (actual Edge runtime checkpoint)

Starting HEAD/origin/main: `cc0c0de4bbf00970a0c3c9bf8ef2137c92726e2e`;
ahead/behind 0/0 and a clean tree verified before work. At the certification
review stop, all Phase 5B.3B files below were additive and uncommitted, with no
tracked modifications, commit, push, deploy, production contact or mutation.

Status: **actual Supabase Edge-runtime dark-handler certification PASS and
ACCEPTED at final review. Final isolated checkpoint regressions and security
gates PASS on the reviewed v369 snapshot. The earlier blocked attempts below
are historical and superseded by the isolated checkpoint record at the end.
Phase 5B.3C and the requested notification UI/scheduling redesign NOT STARTED.**

## Implementation clarifications

The historical Phase 5B.3A audit is intentionally **not rewritten**. The two
clarifications below supersede only the specific clauses named here.

### 1. Encrypted payload and `start_dispatch_v1` fields

Implementation review resolved the original payload contradiction as follows:

* The audit's exact seven-field encrypted payload is retained:
  `{ protocol: "CAP_PUSH_V1", type: "reminder", version: 1,
  installation_id: UUID, binding_id: UUID, generation: positive safe integer,
  expires_at: integer Unix seconds }`.
* All fields are required, no extras, maximum 512 serialized UTF-8 bytes.
* The previous 5B.3B prohibition on raw `binding_id` is superseded **only for
  encrypted payload/transient construction use**. Both identifiers are opaque
  notification-only fencing metadata, never financial or user identities.
* `start_dispatch_v1` is narrowly expanded to return `installation_id`,
  `binding_id`, `generation` and `expires_at` atomically from the same locked
  binding/schedule/claim snapshot as its committed dispatch permit. No HTTP
  caller fields or second unlocked identifier lookup are authorized.
* Identifiers cannot appear in logs, sender HTTP responses, visible copy, tags,
  URLs, public/VAPID metadata, financial stores, exports or localStorage. The
  previously approved notification-only IndexedDB binding record is unchanged.
* The sender constructs the payload. No arbitrary title/body, financial data,
  user ID, candidate digest, endpoint or key material is allowed in plaintext.

### 2. Schedule lifecycle locking (supersedes the direct schedule `FOR UPDATE` clause)

The Phase 5B.3A audit simultaneously specified:

1. runtime **SELECT-only** access to `cap_notifications_private.schedules`; and
2. direct `FOR UPDATE` locking of schedule rows in claim/start/recovery.

PostgreSQL 17 requires UPDATE privilege on at least one schedule column for
that row lock, in addition to SELECT. This was reproduced on a disposable local
PostgreSQL 17 cluster: a NOLOGIN/NOBYPASSRLS role with SELECT-only access got
SQLSTATE `42501` on `SELECT ... FOR UPDATE SKIP LOCKED`. SECURITY DEFINER
ownership by the same restricted runtime role does not bypass the privilege.

Implementation review **deliberately rejected** widening schedule privileges,
adding an UPDATE RLS policy, a dummy column, a lock-only helper, an advisory
lock, ownership changes or a bypass. Instead, the approved correction is:

```
binding FOR UPDATE
  -> schedule SELECT and full re-read/revalidation
  -> ledger FOR UPDATE
  -> claim/start/finalize/recovery transition
```

The schedule row is **never** locked `FOR UPDATE`. This is safe because every
frozen management path that can insert, delete, replace or semantically change a
binding's schedules (`cap_notifications_register_v1`,
`cap_notifications_publish_v1`, `cap_notifications_invalidate_v1`) acquires the
corresponding binding row `FOR UPDATE` first. While the runtime holds that
binding fence, those management paths cannot replace or delete the schedules it
revalidates.

**Management invariant:** any operation capable of inserting, deleting,
replacing or semantically changing a schedule for an existing binding MUST
first acquire that binding row `FOR UPDATE` in the same transaction. The frozen
management RPCs already satisfy it. This is an application/database-contract
invariant enforced by narrow privileges, the fixed reviewed function inventory,
the successor verifier, tests and future migration review. PostgreSQL itself
does not enforce it for arbitrary future SQL.

`docs/notifications-phase5b3-audit.md` remains byte-identical; this document
supersedes only its direct schedule-lock requirement.

## Implemented artifacts

* `supabase/functions/cap-notification-sender/index.ts` — POST-only endpoint,
  exact 256-byte `process-due-v1` body, named-secret auth, dark identity
  manifest, bounded run loop, TTL/deadline, positive-commit-only dispatch.
* `webpush.ts` — seven-field validator, endpoint allowlist/SSRF rejection,
  VAPID/JWT construction and local verification, RFC 8291 `aes128gcm`
  encryption adapter with `pad:false`, redirects refused.
* `results.ts` — closed HTTP classifier and bounded `Retry-After` parser.
* `runtime.ts` — exactly seven fixed RPC statements, Postgres.js pool `max:1`,
  `prepare:false`, `max_pipeline:1`, transaction pooler host/port/role checks,
  TLS verification, no host-project fallback or arbitrary SQL.
* `deno.json` / `deno.lock` — exact pins and frozen lock:
  `npm:@block65/webcrypto-web-push@2.0.0`, `npm:@supabase/server@1.9.2`,
  `npm:postgres@3.4.9`.
* `supabase/config.toml` — local review only, service-only `verify_jwt=false`.
* `supabase_notifications_sender_5b3.sql` — transactional DARK install artifact:
  parked roles/control, `vapid_tokens`, seven SECURITY DEFINER operations,
  explicit ACL revokes, binding-first schedule locking, catalog seal and
  successor verifier/postflight.
* Tests: `tests/notifications-sender-sql.cjs`,
  `tests/notification-webpush.cjs`, `tests/notification-sender.cjs`,
  `tests/notification-sender-edge.cjs` (Deno SDK unit only),
  `tests/helpers/{notification-sender-tests.ts,sender-pg.cjs,sender-deno.cjs}`.

The service worker remains `cap-shell-v369` with no `push` or
`pushsubscriptionchange` handler. `CapVapidPublic.current()` remains `{}`; the
public identity manifest remains empty.

## Post-certification regression reruns — results

All keys are ephemeral, in-memory test P-256 keys. Vendor network is denied: the
Deno suites run with no `--allow-net` and replace `fetch` with a rejecting
stub; the SQL suites use disposable loopback PostgreSQL 17 only.

| Suite | Result |
| --- | --- |
| Sender PostgreSQL 17 / role / ACL / concurrency / recovery / token suite | **31 PASS** |
| Web Push payload, key, JWT, RFC 8291 encryption, endpoint, redaction | **5 PASS** |
| Sender orchestration, classifier, request rejection, driver config, dark shell | **7 PASS** |
| Edge handler named-secret auth/redaction unit (Deno SDK, not Edge certification) | **1 PASS** |
| Deno `check --frozen --cached-only` on the function entrypoint | **PASS** |
| Frozen hashes, unguarded install rejection, dark install, postflight | **PASS** |
| Notifications unit / enrollment unit | 61 / 11 PASS |
| Notification enrollment browser / Notifications browser | 27 / 68 PASS |
| Notification foundation SQL / enrollment SQL / Phase 6O SQL (PGlite) | 69 / 21 / 23 PASS |
| Client RPC-only / cloud-pull / cloud bootstrap / sync production | 13 / 48 / 64 / 31 PASS |
| Offline auth / notes readiness / shell cache / UI / Upcoming | 42 / 25 / 5 / 15 / 20 PASS |
| Financial Health browser / local-development browser / Settings shell browser | 47 / 10 / 36 PASS |

All rows above were rerun after successful actual Edge dark-handler execution.
The sender SQL suite initially hit its existing 4-second statement timeout on
`pg_timezone_names` during host resource pressure; an unchanged full retry passed
31/31. Five PGlite/cloud suites initially had incorrect external tooling paths
(missing package entrypoint / `fake-indexeddb`); correcting only environment
paths to the existing `cap-notes-sql-test/node_modules` installation resolved them.
Enrollment browser startup initially exceeded its existing 10-second fixture
timeout; its unchanged full retry passed 27/27. No timeout, test assertion,
implementation, release allowlist or security contract was relaxed.
All app JS/test syntax and manifest/vercel JSON parsing also passed.

The SQL suite exercises unreachable transition algebra in an **unexposed, test-only
clone schema** (`sender_whitebox`) with the parked gate/version predicate
neutralized only inside that clone. The production artifact, its constraints
and all roles remain dark and NOLOGIN; nothing from the clone is installed or
deployed.

PostgreSQL proof of the binding fence includes real concurrent transactions:
runtime binding lock blocks `publish_v1`, `invalidate_v1` and `register_v1`
schedule mutation until rollback/commit; `SKIP LOCKED` skips a management-held
binding; schedule change/removal and generation/revision changes before the
fence are rejected after re-read; two concurrent claims/start permits yield one
winner; expired claim without dispatch evidence recovers only after full
revalidation; expired `dispatch_started` becomes terminal `unknown` and is
never requeued. Negative privilege proof confirms schedule SELECT succeeds,
while runtime schedule `FOR UPDATE`/UPDATE and sender-login schedule access fail
with `42501`.

Before final approval, `tests/cloud-pull-security.cjs` intentionally failed its
**release allowlist** assertion for the then-unapproved Phase 5B.3B files. Final
review explicitly authorized adding exactly these 16 reviewed artifact paths to
the existing list. No wildcard, assertion, credential scan, RPC list or financial
read-only check changed. The release-security gate now passes all four checks.

## Actual Supabase Edge Runtime certification — 2026-10-29

Docker recovered: daemon/server **29.9.2 / linux / x86_64**, Docker Desktop
running, docker-desktop WSL2 running. Supabase CLI **2.122.0**; installed
`start`, `init` and `functions serve` help inspected before their use. A minimal
CLI local stack and `supabase functions serve cap-notification-sender --env-file`
started the actual CLI-managed Edge container. Runtime reports
**supabase-edge-runtime-1.77.8 (compatible with Deno v2.1.4)**. Image:
`public.ecr.aws/supabase/edge-runtime:v1.77.8`; digest:
`sha256:178c041398a33ded8219344382d0672a90051d1babbf0af03425cafe20039a75`.
The existing mounted function and pinned dependencies load and execute without
source, dependency, lockfile or authentication changes. This is not Node/Deno
unit-test substitution. Bun was only the HTTP client on the Docker network.

### Local CLI named-secret injection limitation

CLI 2.122.0 filters `SUPABASE_*` from both `--env-file` and
`[edge_runtime.secrets]`. Its generated main-service router additionally replaces
the secret map with `{default: SUPABASE_INTERNAL_SECRET_KEY}`. The unmodified
CLI-served instance correctly rejected absent/invalid/internal/default,
publishable, anon and Bearer credentials with 401 and redacted bodies.

To exercise the existing **named**-secret contract, another actual `edge-runtime`
process ran **inside that same CLI-created container**, using the exact same
CLI-generated `/root/index.ts` router, mounted function, import map, cache and
working directory. Only the environment changed: internal secret/publishable
override variables unset; synthetic JSON maps exported from files; synthetic
`https://isolated.example.invalid` project URL; sender DB URL unset. Final test
port was 8093. This is a CLI-image/runtime environment workaround, not proof that
stock `functions serve --env-file` can configure named secret maps. A deployed
environment's key provisioning remains a later activation prerequisite.

An early client harness mistakenly sent the JSON map itself as the apikey;
correcting the client to send its inner key resolved that 401. The function and
approved authentication contract were not changed.

### Final in-runtime matrix: 7 PASS, 0 FAIL

| Invocation | Result |
| --- | --- |
| GET (boot/handler proof) | 405, `invalid_request` |
| POST without key | 401 |
| POST wrong key | 401 |
| POST publishable key | 401 |
| POST named key as Bearer rather than apikey | 401 |
| POST named apikey, no VAPID or sender DB config | 503, `configuration_or_runtime_unavailable` |
| Repeat authenticated dark invocation | Same redacted 503 |

Every response had `cache-control: no-store`, exactly
`run_id/status/counts/duration_ms`, zero counts, and no synthetic secret values.
Captured main-router/worker logs contained no secret values or raw sender errors.
Startup logged only serving/version information before explicit HTTP requests;
the function has no startup run loop, timer or background sender invocation.

The empty public identity manifest throws before VAPID/DB construction. This
certifies **missing VAPID fails closed in the shipped dark configuration**, not
configured cryptographic delivery. There is no DB construction or route to the
only Web Push fetch on this path. After the matrix, container TCP/TCP6 tables
showed listeners only (no established outbound connection); local DB sender
sessions and sender-login log matches were zero. These observations plus the
unchanged early-return control flow establish no push/DB operation for the
tested dark invocations; this is not a claim of packet-capture monitoring.
No real endpoint, subscription, VAPID key, production credential/project or
financial/Cloud Sync operation was supplied or invoked.

Host memory pressure caused harness interruptions during image download; no
Docker/WSL reset, reinstall or configuration change was performed. Extra runtime
instances were stopped, the CLI process and the two test containers were stopped,
generated `.temp`/`.branches` files removed, and temporary config restored exactly
to SHA-256 `E9EB40FAF471CDF158384B18B806C670098FB4FB60545011290986968D2AF7C9`.
Harness scripts/logs remain outside the repository under the user temp directory
`cap-5b3-edge`. Only this checkpoint document has a lasting certification edit.
A later read-only `docker ps` status query timed out after the regression run;
the earlier explicit stop command had already reported both local test
containers stopped. No reset/restart or host configuration change was attempted.

## Remaining activation limitations (not dark-certification substitutes)

* No real Supabase project, transaction pooler connection, Edge deployment,
  pg_cron/pg_net, VAPID key/secret/LOGIN, real subscription or Web Push send.
* The VAPID `sub` contact URI remains unresolved and is intentionally not
  committed; activation still requires an approved real Cap HTTPS contact URI.
  The selected library rejects an empty subject.
* No live FCM/Mozilla/Apple/WNS request was made; only request-construction and
  local decryption fixtures.
* Full production pooler GUC/role isolation, delivery under CPU/memory limits and
  configured Edge encryption/send behavior are not certified by dark-handler
  execution. Cryptographic interoperability remains local fixture evidence.
* No production financial/Cloud Sync/schema/RLS/trigger/RPC/role/baseline/
  outbox/export change was made.

## Dependency and security status

Registry recheck: `@block65/webcrypto-web-push@2.0.0`,
`@supabase/server@1.9.2`, `postgres@3.4.9`. OSV querybatch reported **no known
vulnerabilities** for these pins or the locked transitive packages
(`uint8array-extras@1.6.0`, `jose@6.2.13`, `@supabase/supabase-js@2.118.0`,
`@supabase/middleware@1.0.0`, `std-env@4.3.0`, `iceberg-js@0.8.1`, `tslib@2.8.1`).
The lockfile is frozen and no range/latest/Git/CDN/ORM/prepared-statement/
pipelining option is used. This is not a security certification.

## File hashes

| File | SHA-256 |
| --- | --- |
| `supabase_notifications_foundation.sql` (frozen) | `7126F10B3699F2A54B216A3045E92E5EF7CB3405C89BB25E80BCDB913BD9443B` |
| `supabase_notifications_enrollment_5b2a1.sql` (frozen) | `CB597A5D1D47A90EEFF8B5E336C68540CC0A98B86DFBFB7693B79BADFF2A3364` |
| `supabase_notifications_enrollment_5b2a1_v2.sql` (frozen) | `291AA08EBF3D867233235150DCCC5B038060E3DFC32D42C0B2DBB90FA6D444CA` |
| `supabase_notifications_sender_5b3.sql` | `97B1D63961F77DBA4348D38FD6B81F3D17D11EBB5DCB68817F65FAEADB01D3CB` |
| `service-worker.js` (unchanged, `cap-shell-v369`) | `1CEA0A7F348D7D3648FE84E390D29A38C3BF98EBCE8F598E3CAA618A9D1135AE` |
| `supabase/config.toml` (restored) | `E9EB40FAF471CDF158384B18B806C670098FB4FB60545011290986968D2AF7C9` |
| `supabase/functions/cap-notification-sender/index.ts` | `4F08525BAA8EA24297D8CDF342075B38CE187199522093D5BD75209753448FEA` |
| `supabase/functions/cap-notification-sender/runtime.ts` | `FD10EFBCD3B59AC565588BC81AEE158E75C72C1A70D30F79EFB8091FCA793780` |
| `supabase/functions/cap-notification-sender/results.ts` | `5678D80323ECC44C94091099A890D9F4E9FBD804F8235CFC5C9B2D93BE62F0D8` |
| `supabase/functions/cap-notification-sender/webpush.ts` | `72C5706F06BF73241B9DC9CB04498D5F163A6189CA77BDC59AC0DB34B896FB98` |
| `supabase/functions/cap-notification-sender/deno.json` | `6E649950EF65DC51C018059E35E796F0513ACCCFA5D30BDDE4ABAAAAF93BF4EE` |
| `supabase/functions/cap-notification-sender/deno.lock` | `6A035A16910E6BE25937D73FE83D6E3D7A35769A8B4812F8F6596650F0169D1C` |
| `tests/notification-sender-edge.cjs` | `D36D472E63FC3D07D41F0866C92146AA9920606316E372B501236447B37EC28E` |
| `tests/notification-sender.cjs` | `C165D379C410B6EE867A4BDF8FEB16659B54A99F03BBACEB8AF3F7890F93E495` |
| `tests/notification-webpush.cjs` | `A11E8FC9CAFBD2B3E38DAEB0AE08BC959A232E506950BC85974B75CFB13CA57C` |
| `tests/notifications-sender-sql.cjs` | `ABD9BD5A7179D1D1369D723C1F6886579A874498374B93603659DB3249255CAB` |
| `tests/helpers/notification-sender-tests.ts` | `9CA0010579E2E6A4608FAF428D533711AF6F8AD60BD7F2918F393192331B2C15` |
| `tests/helpers/sender-deno.cjs` | `E92272D00AF1C9868F99F676041D34235C8CB9A40995743FB2F0D570FF559A55` |
| `tests/helpers/sender-pg.cjs` | `3FA367140D5D2E0DD0A78D9233385228EAEC7B21CC67E47D2AF87EA81166FEB3` |
| `js/vapid-public.js` (unchanged) | `26E0635119E4E06DC87F6D7B941E54D536108F49A5552FD47F64EB433BE1E018` |

## Boundaries preserved

Production contacted/mutated: NO. Sender project created: NO. Production VAPID
key/secret/LOGIN: NO. Edge deployment: NO. Background enablement: NO.
Cron/pg_net: NO. Real subscription/Web Push: NO. Financial/Cloud Sync changes:
NO. Production deployment: NO. Phase 5B.3C: NOT STARTED. Final approval authorizes
only the repository checkpoint commit and normal existing-branch/origin push.

## Pre-approval Git snapshot

At the certification review stop, HEAD and local origin/main were both
`cc0c0de4bbf00970a0c3c9bf8ef2137c92726e2e`; ahead/behind 0/0.
Tracked modifications/staged files: none. All 16 Phase 5B.3B files remain
untracked: this document; `supabase/config.toml`; six function files listed in
the hash table; `supabase_notifications_sender_5b3.sql`; four sender test entry
files and three test helpers listed in the hash table. Generated CLI metadata
and test-secret files are no longer in the worktree. Independent scans using
the release test's credential patterns found zero matches across all 16 files;
the release-allowlist test was then unchanged and failed as expected.

**PHASE 5B.3B EDGE CERTIFICATION: PASS — READY FOR FINAL REVIEW**

## Final approval and checkpoint

The user accepted the actual Edge Runtime certification, including the CLI
named-secret environment workaround, specifically for the dark handler. This
does not claim configured production-delivery certification. The only test
change is the explicit 16-path approval in `tests/cloud-pull-security.cjs`.
All approved sender source, SQL, dependency pins, tests and protected files
remain byte-identical to their reviewed hashes above.

The established checkpoint workflow is a commit on `main` followed by a normal
push to `origin/main` (the remote-tracking reflog records earlier checkpoints
as `update by push`). Required commit message: `Complete Web Push sender
foundation`. No force push, deployment, SQL application, sender provisioning,
VAPID provisioning, cron/net activation or real push is authorized.

The notification UI/scheduling redesign is queued only and explicitly excluded
from this checkpoint task. STOP FOR REVIEW after checkpointing.

### Final approval regression attempt — BLOCKED / STOP FOR REVIEW

The approval run passed the release-security gate (4), Web Push (5), sender
orchestration (7), Edge/auth unit (1), notifications unit (61), enrollment unit
(11), foundation SQL (69), enrollment SQL (21), Phase 6O SQL (23), RPC-only (13),
cloud-pull (48), bootstrap (64), sync (31), offline auth (42), notes readiness
(25), shell (5), UI (15), Upcoming (20), and notifications browser (68).

Two required suites failed:

* Sender PostgreSQL: 10 checks passed, then `J/K/L/M/N runtime binding/ledger
  locks work; schedules SELECT only; sender has no direct access` failed during
  fixture `seed()` at `tests/notifications-sender-sql.cjs:123`, reading
  `pg_timezone_names`: `canceling statement due to statement timeout`. The
  existing statement timeout is 4 seconds. No security assertion established a
  regression, but this is a failed final gate, not a pass.
* Enrollment browser: B1-B3 passed, then fixture initialization for the next
  check timed out in `openFixture()` at
  `tests/notification-enrollment-browser.cjs:228`:
  `page.waitForFunction: Timeout 10000ms exceeded` (caller line 347).

Per the user's fail-and-stop instruction, no retry or timeout increase was
performed. The remaining batch and its active Financial Health browser test
were stopped. The final frozen Deno check, local-development browser and
Settings browser were not reached in this attempt; earlier passes above are
historical evidence only, not substituted for these final gates.

Independent verification before this run confirmed all 20 recorded hashes,
the frozen shell/no push listeners/dark VAPID, and zero credential-pattern or
privileged-JWT matches across the 17 proposed files. Only the 16 approved paths
were added to the release allowlist; all subsequent test logic is byte-identical
to HEAD. No stage, commit, push, deployment, production SQL, VAPID provisioning,
scheduling amendment, UI redesign or Phase 5B.3C work occurred.

**Historical result of that attempt: CHECKPOINT BLOCKED — STOP FOR REVIEW.**

### Controlled recovery and final isolated checkpoint — PASS

The user accepted unchanged controlled reruns of sender PostgreSQL (31/31) and
enrollment browser (27/27), with no test, fixture or timeout modifications. The
actual Edge Runtime certification remains accepted and was not repeated.

Concurrent notification work changed the primary checkout's UI and worker
through v370/v371/v372 and beyond. It is not part of Phase 5B.3B. An identified
repository session (`ses_e81ad5228ffdCXp7qEhJvn1tye`, "Remove logo outlines from
home sections") was interrupted during the initial isolation attempt. Its five
tracked paths were preserved in the path-scoped stash
`cb6861b3a93c57bf72d09fcb484368bd591b2afa`, named
`phase5b3-concurrent-notification-drift`:

* `css/notifications.css`
* `css/settings-shell.css`
* `js/notifications.js`
* `tests/notifications-browser.cjs`
* `service-worker.js`

The stash contains only those five paths; none of the 17 approved checkpoint
files. Additional exact-byte safety copies remain outside the repository. The
user then clarified that they are actively editing the notification design and
instructed this task to continue only the sender commit without touching their
work. No further interruption, restoration or overwrite of those live UI files
is part of this checkpoint. The stash remains available; it is not applied over
the user's continuing edits.

Final validation therefore used a separate detached temporary worktree at
`cc0c0de4bbf00970a0c3c9bf8ef2137c92726e2e`, with only the reviewed 16 phase
artifacts and the approved release-allowlist change copied in. The frozen SQL,
v369 worker and dark VAPID bytes were verified separately. Git checkout newline
conversion was disabled for the temporary checkout, not for the user's working
tree: an initial CRLF checkout broke the bootstrap fixture's exact LF source
substring. A corrected LF checkout matched the unchanged app source exactly.
An absent ignored generated shell config was supplied only in the sandbox as
`window.CAP_SUPABASE_CONFIG = {}`; it contains no credentials and is not staged.
No test source, fixture implementation, assertion, timeout or retry policy was
changed to resolve either sandbox setup issue.

Final results on that isolated snapshot:

| Suite | Result |
| --- | --- |
| Sender PostgreSQL / Web Push / sender orchestration / auth unit | 31 / 5 / 7 / 1 PASS |
| Notifications unit / enrollment unit | 61 / 11 PASS |
| Notifications browser / enrollment browser | 68 / 27 PASS |
| Foundation / enrollment / Phase 6O SQL | 69 / 21 / 23 PASS |
| RPC-only / cloud-pull / bootstrap / sync | 13 / 48 / 64 / 31 PASS |
| Offline auth / notes readiness / shell | 42 / 25 / 5 PASS |
| UI / Upcoming | 15 / 20 PASS |
| Financial Health / local-development / Settings browser | 47 / 10 / 36 PASS |
| Release security / frozen Deno / JS syntax / JSON parsing | 4 PASS / PASS / PASS / PASS |

After every suite and at the end, all 297 tracked/nonignored worktree file
hashes, modification times and Git status matched the isolated baseline. The
four frozen hashes match the inventory above. The final credential scan and
staged review cover exactly the 17 approved checkpoint files; no environment
file, test secret, temporary Supabase file, Docker metadata or concurrent UI
file belongs in the checkpoint. The primary checkout may continue to show the
user's uncommitted notification changes after the checkpoint; those changes and
their worker versions are neither approved nor certified by Phase 5B.3B.

Only commit `Complete Web Push sender foundation` and normal `origin/main` push
are authorized. No production deployment/SQL, VAPID provisioning, real push,
cron/net activation, Phase 5B.3C, scheduling amendment or redesign continuation
is performed by this checkpoint task.

**PHASE 5B.3B: COMPLETE / CHECKPOINTED / FROZEN**
