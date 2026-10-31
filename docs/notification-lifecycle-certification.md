# Phase 5B.3E — isolated lifecycle certification

**Remote delivery BLOCKED. No browser is certified by this harness or its automated tests.**
This is test infrastructure, not the Phase 5B.3D production barrier. A successful
challenge is a diagnostic result and always has `promotionAllowed:false` and
`lifecycleInvariantEstablished:false`. There is no promotion implementation.

## Start safely

Run from the repository root:

```powershell
node tests/lifecycle-lab/server.cjs
```

Open the printed random-port `/lab/` URL in a disposable browser profile. The
server serves an explicit lab-only route map, **not** the repository root. Never
serve these fixtures from the production origin; never point the Cap app at this
server. The server has no proxy, SQL, credentials, RPC, sender, production files,
or generic filesystem route. Do not use the normal app development server.

The page refuses foreign/unproven workers and unknown persistent state. Protocol
`cap-lifecycle-isolation/2` permits only exact server-issued provenance markers and
worker proofs, not an arbitrary lab-looking name or script path. Database-name
enumeration is required; if unavailable the page stops rather than inferring an
empty store. It never opens those databases. A refusal is a STOP, not permission
to clear unfamiliar production state. Do not unregister an unfamiliar worker.
Static copies without the dedicated server cannot pass setup.

All diagnostic events are in page/worker/server memory. The only persistent
writes are two small provenance markers, one each in localStorage/sessionStorage;
there are no IndexedDB or CacheStorage writes. Server records survive browser/PWA
termination **only while the server process remains running**. Export before
stopping it. Use a stable origin/port for a physical device run; changing port
creates a different origin and invalidates restart comparisons.

## Safety boundaries

* No production scripts, actual legacy Cap enrollment code, or notification
  storage are loaded. The legacy fixture only emits `synthetic-legacy-code-executed`;
  it does not sign out a real user or write notification state.
* No push event handler, subscription, permission request, presentation,
  notification RPC, enrollment, enabled fence or eligible binding is implemented.
* Page **and worker** install non-writable guards against subscription creation,
  permission requests, notification constructors/presentation, IndexedDB open/delete,
  general Web Storage mutation, and CacheStorage open/delete. A narrowly retained
  native Storage setter can initialize only the two exact protocol markers after
  admission. Guard installation failure stops execution. These are defense in
  depth, not an XSS security boundary.
* Server-side route isolation and a fresh dedicated origin are the primary boundary.
  CSP allows only this origin's resources/connections; RPC paths return 404.
* `/away` is a deliberately inert HTML document outside SW scope. It contains no
  script or storage operations, is logged by census, and is the **only audited
  exclusion** from challenge participation. Any other enumerable window participates.
* Worker scope is `/lab/`; bare-worker experiments still serve the lab worker.
  They do not request the production `/service-worker.js`.
* `skipWaiting` and `clients.claim` checkboxes change only synthetic lab-worker
  behavior. No production shell/version/cache/manifest is changed.

## Controls and interpretation

1. **Change served revision** snapshots the current lab skip/claim settings and
   changes worker bytes. Changing a checkbox alone does not change server settings.
2. **Register fresh UUID worker** registers
   `/lab/service-worker.js?cap_worker_instance=<UUID>` with scope `/lab/`.
3. **Update active registration** calls `registration.update()` using its current URL.
4. **Register bare legacy URL** uses `/lab/service-worker.js`. It may supersede a
   waiting UUID worker; the identifier is not a capability or authorization.
5. **Probe / census** records all visible client IDs, URLs, visibility and control
   classification. Control is computed relative to the *queried worker*, not every
   worker in the registration. A waiting worker is not the active page controller.
6. **Diagnostic challenge** uses per-client MessagePorts, a fresh attempt UUID,
   256-bit nonce, worker identity, synthetic activation, and capability identifiers
   from 5B.3D. Responses have a two-second monotonic deadline; attempt has a five-
   second deadline. Duplicate, missing, malformed, changed/new/disappeared client
   responses fail. There is no enrollment lock or production barrier implementation.
7. **Race a pre-opened legacy navigation** opens inert `/away`, waits for it to
   load, and requests navigation at the selected phase. Each command is serialized
   and correlated with a unique barrier ID. Navigation request and commit are
   different events. A late document may execute even after a successful diagnostic
   final census. The marker never writes authority.
8. **Execute synthetic old lifecycle action** records that this old fixture still
   executes. This is an execution witness, not a real notification lifecycle test.

The activation identity `synthetic:<instance>:revision-<n>` is **not a durable
activation-instance journal**. Worker `boot_id` changes on global restart. URL
instance identity should persist through worker termination; revision and instance
may change independently. Reinstalling an identical URL need not yield a distinct
synthetic activation identity. Do not infer the 5B.3D journal invariant from it.

## Evidence/export

Use **Export JSON**, **Copy report**, or open `/__lab/report` on the dedicated
server. Copy falls back to selectable report text when clipboard access fails.
Record browser and OS versions manually as well as the collected user-agent.

Record fields include source-local sequence, server receipt sequence, wall-clock
and monotonic diagnostics, page token, client ID when discovered, URL, display mode,
visibility, controller URL, worker instance/revision/state/boot, synthetic activation,
challenge result/barrier, navigation, pageshow/pagehide and persisted status.

`source_sequence` orders events only within its source/page token/worker boot.
`server_sequence` orders receipt, **not cross-process causality**. Wall-clock
timestamps never decide ordering or compatibility. Use messages, barrier IDs and
navigation tokens to relate traces. Early page events may arrive after later logs.
`dropped_records` reports the bounded server log's truncation; `log_failures` reports
page transport failure. No event after force-quit is not evidence of destruction.
Worker termination can also lose diagnostics. Mark such runs INCONCLUSIVE.

For each case record PASS/FAIL/INCONCLUSIVE as an **observation**, then separately
document whether its required browser assumption is established. Empty census,
successful challenge and absence of a log do not establish absence of legacy code.

## Common manual matrix (all targets)

Use fresh contexts/origins for independent cases. Export each case. Keep exact
skip/claim settings in notes, and repeat with claim both false and true.

| Case | Steps / evidence required |
| --- | --- |
| Waiting/live | First revision: skip OFF, claim ON; register and confirm controlled. Change revision with skip OFF; register/update. Keep tab open: capture installed/waiting and old controller. |
| Reload/navigation | Reload and navigate within `/lab/` while waiting. Record whether the replacement stays waiting. Keep a second controlled window alive during separate runs. |
| Multiple/hidden | Open two controlled windows; background one; close foreground then last controlled window. Use a separate `/away` observer or exported server report; a new controlled observer could itself block activation. |
| First/uncontrolled | First registration with claim OFF; page remains uncontrolled. Probe with includeUncontrolled; execute old fixture action. Then replace while an uncontrolled window remains. |
| Controlled BFCache | Establish baseline same token + pageshow `persisted:true` via `/away` and Back. Repeat with worker replacement while away. Observe replacement activation before Back, token, persisted, controller and available not-restored reasons. Test Forward too. |
| Uncontrolled BFCache | Legacy fixture starts before registration, enters history via `/away`. Other window installs then replaces worker with claim OFF; repeat with claim ON. Back: determine same old token/execution, control, and whether census saw it before restore. |
| Challenges | Compatible, legacy, malformed, missing, duplicate; disappearing popup; navigating client; hidden client; multiple windows; no response/timeouts. Success must always retain promotion false. |
| Navigation races | Run all five phases. Correlate marker barrier ID and old-code witness. Record whether the incompatible client appears before/after final census, marker, and final observation. Repeat rapidly. |
| Instance identity | Probe before/after worker stop in DevTools. URL instance same, boot different? Change revision with same URL; register fresh UUID; unregister/reinstall; reuse identical URL via console in the lab only; competing callers including bare URL. |
| Bare caller | Attempt while UUID worker active and a controlled window stays alive, then after closing clients. Note waiting-worker replacement separately from active-worker replacement. No identity may qualify for delivery. |

## Physical Safari/iPadOS — REQUIRED

**PHYSICAL SAFARI/IPADOS CERTIFICATION REQUIRED.** Headless Chromium and WebKit
automation are not substitutes for Safari standalone behavior.

### Dedicated trusted HTTPS, not deployment

Use a separate local/LAN lab origin and a trusted certificate whose SAN matches
that hostname/IP. Supply your own lab certificate and key, outside the repository:

```powershell
node tests/lifecycle-lab/server.cjs --host 0.0.0.0 --port 8443 --cert "C:\lab-certs\cert.pem" --key "C:\lab-certs\key.pem"
```

Open `https://<certificate-host>:8443/lab/` on the device. The printed wildcard bind
address is not the device URL. Trust the lab CA through the device's approved
process; never disable browser TLS/security checks. Do not expose the server to
the public internet or use a production hostname/certificate. Non-loopback HTTP
is refused. This infrastructure does not generate certificates or modify trust.

### A. Standalone PWA

1. Record device, OS, Safari version, storage/browser settings and run ID. Open
   the lab in Safari, Add to Home Screen, launch **Lifecycle Lab** (not Cap).
   Verify collected display mode is standalone; record if not detectable.
2. Run the common matrix. Inspect whether Safari and standalone actually share
   service-worker/storage context—do not assume they do. Probe both.
3. Set old fixture mode; record a manual `before-background` note. Background the
   app, lock device, leave suspended, resume; capture persisted/token/boot/controller.
   Repeat short and long intervals; elapsed time is a test condition, not an ordering rule.
4. Keep the lab server alive. Change served revision from another device/browser
   via its lab controls. That affects served bytes, **not** the suspended app's
   registration. To prove replacement while suspended, use remote Web Inspector
   attached to that same PWA registration to request `registration.update()`, or
   observe an actual browser-triggered update. Capture worker activation logs from
   that instance before resuming. If unavailable, mark this subcase INCONCLUSIVE.
5. Resume old app and execute synthetic old action. Compare page token, persisted,
   instance/revision, and controller. Repeat claim OFF/ON and no-skip replacement.
6. Record `before-force-quit`; swipe away app; relaunch. Repeat with process
   termination and device restart where practical. Token continuity distinguishes
   preserved JS from a new page; missing last events are not proof of process death.
7. Test airplane-mode suspension/relaunch as an observation. The harness has no
   offline cache, so a network-dependent relaunch may fail; do not call that safe
   lifecycle behavior or change production caching to make it pass.
8. Export server and surviving page reports. Attach screen recording/Inspector
   trace where available. Label OS-unobservable suspension/termination INCONCLUSIVE.

### B. Safari browser tab

Run the common matrix separately in Safari tabs, including multiple tabs,
backgrounding, Back/Forward, uncontrolled first-load history and tab restoration
after force-quitting Safari. Do not infer its results from standalone, or vice versa.

### Other targets

* **Chromium desktop:** disposable profile, BFCache baseline required. Playwright
  must remove its default `--disable-back-forward-cache` argument. DevTools can
  affect behavior; repeat important history cases with it closed.
* **Chromium Android:** physical device, tab background/discard, app switching,
  screen lock and installed standalone runs. Record Android/browser versions and
  low-memory conditions; desktop results are not Android certification.
* **Firefox desktop:** fresh profile; run history/control matrix. Missing APIs or
  instrumentation means unsupported/inconclusive, never inferred success.

## Automated checks

Dependency-free protocol/server/safety tests:

```powershell
node --test tests/lifecycle-lab.test.cjs
```

Real Chrome, using an **existing external** Playwright installation:

```powershell
$env:CAP_PLAYWRIGHT_PATH = 'C:\path\to\node_modules\playwright-core'
$env:CAP_LIFECYCLE_REPORT = 'C:\path\outside-repo\lifecycle-evidence.json'
node tests/lifecycle-lab-browser.cjs
```

The runner creates a random-port server and disposable profiles, enables BFCache,
and never loads Cap. Browser capability failure is a failed/inconclusive run, not
a reason to weaken guards. Negative API tests call sealed guard stubs that throw
before platform permission/subscription/presentation APIs can execute. It closes
its server/browser afterward. Reports are opt-in and overwrite the specified output.

## Decision

GO for physical evidence collection on this isolated harness. NO-GO for production
authorization, packaging or remote delivery. Particularly investigate uncontrolled
history restoration and documents arriving after the final census: no census or
synthetic marker proves the mixed-version lifecycle invariant.

## Initial automated Chromium observations

Environment: Windows, headless Chrome **156.0.8078.74**, disposable contexts,
loopback lab server, BFCache explicitly enabled. These are observations, not
browser certification or production Cap execution. Dependency-free checks: **20
passed**. Real-browser scenarios: **13 passed**. Syntax checks passed for the new
JavaScript. Server evidence: **558 records, 0 truncated** in the recorded run.

* Live controlled windows blocked no-skip replacement, including reload and
  navigation while another controlled window remained. Replacement activated
  after the last controlled window closed.
* Uncontrolled windows were enumerable, could execute the old fixture, and
  could navigate while another controlled window kept replacement waiting.
* Controlled BFCache baseline restored the same token. After replacement the
  document reloaded with a new token. This run exposed only `masked` as its
  not-restored reason: do not claim a specific eviction reason from this trace.
* **An uncontrolled BFCache legacy fixture restored the same token, with
  `pageshow.persisted:true`, after first registration AND replacement with claim
  OFF. It remained uncontrolled and executed its old fixture code.** This is a
  counterexample to assuming controlled-document eviction protects every document.
* Navigation requested before/during census was detected as a new client in
  this run. Navigation after final census, at the marker phase, and after the
  marker yielded `diagnosticCompatibility:true` followed by legacy-fixture
  execution. Every result still had `promotionAllowed:false`. A successful
  finite census does not exclude future incompatible execution.
* Worker stop/restart preserved URL instance identity and changed boot identity.
  Bare-URL and multiple-page callers could replace a waiting UUID worker. With
  lab skip/claim enabled, bare replacement also became active. No caller gained
  authority; no authorization machinery exists.
* Page and worker negative API probes threw before real operations. No database,
  Web Storage entries or cache was created. Foreign-worker and missing-guard
  cases refused initialization.
* Headless windows remained `visible` even after `bringToFront`; **genuine hidden
  window behavior was not established**. Physical background/suspension and
  standalone behavior remain untested. The claim-ON uncontrolled-history variant
  remains a manual matrix item, not a result inferred from claim OFF.

These counts and zero-Web-Storage observations describe the original v1 run,
before the self-isolation amendment below, not the current v2 marker model.

The raw JSON is exported outside the repository via `CAP_LIFECYCLE_REPORT`.
It includes individual barrier IDs, responses, client snapshots and lifecycle
events. Re-run to generate a report on another machine; sequence IDs and tokens
are run-specific and not expected to be byte-identical.

## Phase 5B.3F self-isolation amendment (protocol v2)

### Diagnosis and limits

The original `NONEMPTY_ORIGIN_STOP` combined Web Storage lengths and cache names
without distinguishing provenance or identifying the offending category. Worker
admission also checked paths only. That is insufficient for repeatable, auditable
multi-load certification. However, v1 did not deliberately create application
storage/cache entries: the reported Safari error **does not establish which entry
was present or that it was safe**. Native SW script storage is not ordinarily an
application-created CacheStorage cache. No unknown Safari entry is retrospectively
whitelisted. The new `isolation-inventory` diagnostic names keys/caches/databases
without exporting stored values, and refusal includes a specific category.

### Allowed state

* Exactly `cap-lifecycle-lab:local:v2` in localStorage and
  `cap-lifecycle-lab:session:v2` in sessionStorage. Values must byte-match the
  dedicated server's marker for that area/origin/current server run. Each carries
  protocol, run UUID, canonical origin, area and random token. Missing markers
  are created only after the rest of isolation succeeds; mismatches are never
  overwritten. All generic Web Storage writes remain blocked.
* Registered/controlling workers must have exact same-origin `/lab/` scope and
  `/lab/service-worker.js` URL, and answer a fresh MessagePort nonce challenge.
  Protocol, server run, exact URL, revision and a proof embedded in server-issued
  worker bytes must match the server's issuance registry. Active, waiting,
  installing and still-controlling unregistered worker objects are checked.
  Bare URLs are recognized only when issued by this lab run; they still confer
  no delivery authority. Proof is stable per script URL/revision within the run.
* No IndexedDB database or application CacheStorage cache is expected or created
  by v2. Every such name, including a lab-looking prefix, still stops admission.
* A changed worker set during admission stops the attempt. A reload can retry
  once the lab's transitions settle; do not silently ignore a replacement.

This is provenance consistency for an isolated honest fixture, not cryptographic
attestation against malicious same-origin code. Existing push/permission/
presentation/production-storage guards and route isolation remain necessary.

Reload and BFCache restoration recheck provenance. A server restart changes its
run and deliberately rejects earlier markers/workers. Reuse the same live server
for a complete scenario; do not erase state between its reloads. For a new run
or the one-time v1-to-v2 change, use a fresh dedicated origin/port instead of
automatically adopting older state. Export old evidence before stopping a server.

### Exact physical Safari regression retest

1. Keep the existing trusted lab certificate. Start the updated server at a fresh
   unused port (for example 8444); certificates identify the hostname/IP, not the
   port. If needed, narrowly permit that port for the iPad in Windows Firewall.
   Never alter the production origin. Do not reuse the old v1 worker as v2 proof.
2. On iPad open `https://<lab-IP>:8444/lab/`. Require ready and an inventory with
   only the two exact v2 markers; no database/cache. Keep this server process alive.
3. Leave skip and claim OFF; click **Change served revision**, then **Register
   fresh UUID worker**. Wait for active, probe, and record uncontrolled status.
4. Reload. Require ready, controls enabled, same worker instance, controlled
   status, and unchanged marker values. Reload twice more without clearing data.
5. Open another same-origin lab tab. Require ready and run a census/challenge.
6. With a controlled tab remaining, change revision/register B with skip OFF.
   Require waiting B and active A; reload one tab and require continued admission.
7. Run baseline Back/Forward, then controlled and uncontrolled replacement history
   cases from the matrix. Record tokens/persisted flags; provenance admission must
   not be mistaken for proof of lifecycle exclusion.
8. Repeat from Add to Home Screen using this v2 origin and verify display mode.
   Do not assume the Safari tab and installed app share a registration partition.
9. Export JSON after each subcase. If STOP persists, preserve the exact STOP code
   and `isolation-inventory` keys/cache/database names from on-page diagnostics and
   `/__lab/report`; do not delete data or whitelist the entry to force PASS.

Automated v2 results are reported separately from physical certification. Physical
Safari verification of this amendment remains REQUIRED; no Safari PASS is claimed.

V2 verification: **33/33** dependency-free tests and **23/23** real Chrome
156.0.8078.74 scenarios passed. Coverage includes the exact no-claim first
registration followed by a controlled reload and repeated reload, unchanged own
markers, BFCache/replacement workflows, unknown/production-like inventories,
same-path forged worker proofs, server-run mismatch and all delivery-operation
guards. Cache/database contamination browser cases mock inventory responses rather
than opening production-named stores. Raw evidence was exported outside the
repository to `cap-lifecycle-isolation-v2-evidence.json` in the session temp area.
These results do not reproduce or certify the original physical Safari failure.

## Physical Safari / iPadOS Certification Results

Device/browser:
- iPadOS Safari
- Safari 27.2
- Physical device testing over trusted local HTTPS
- Lifecycle isolation protocol: `cap-lifecycle-isolation/2`

Overall physical result:
- PASS for the tested Safari lifecycle behaviors.
- These observations are diagnostic evidence only and do not authorize remote notification delivery.
- `promotionAllowed` remained `false` throughout testing.
- Production delivery remains BLOCKED pending the separate production authorization/barrier phase.

### Safari browser — first registration, claim OFF

Observed:
- Fresh page initially had no service-worker controller.
- First worker installed and activated with `clients.claim` OFF.
- The existing page remained uncontrolled.
- After normal navigation/reload, the page became controlled.
- Repeated reloads remained controlled and isolated correctly.

Result: PASS.

### Safari browser — no-skip replacement

With an existing controlled revision-2 worker:
- A revision-3 replacement worker installed while old controlled clients remained open.
- The replacement did not take over those controlled clients prematurely.
- The old active worker continued serving the existing controlled page.
- After the old controlled-client lifecycle ended across Safari/device lifecycle boundaries, the replacement became active.

Result: PASS for no-skip replacement behavior.

### Safari browser — controlled BFCache

A controlled lab page navigated outside worker scope and returned using browser Back.

Observed:
- Same page token restored.
- Same client survived.
- `pagehide.persisted: true`.
- `pageshow.persisted: true`.
- Page remained controlled.
- Existing worker identity/revision remained consistent.
- `promotionAllowed: false`.

A second Forward/Back cycle reproduced the same behavior.

Result: PASS.

### Standalone PWA / Add to Home Screen

The standalone app used a separate Safari storage/service-worker context on this device.

Observed:
- First standalone launch was uncontrolled with no inherited Safari-browser worker.
- First standalone worker installed and activated with claim OFF while the existing standalone document remained uncontrolled.
- Closing and relaunching the standalone app produced a controlled document.
- Short lock/suspend/resume preserved the same page/client with persisted lifecycle events.
- Longer suspension reproduced the same preserved-page behavior.
- Force quit/relaunch produced a fresh controlled document.
- Full device restart produced a fresh controlled standalone document.
- Airplane-mode relaunch failed because the diagnostic harness intentionally has no offline application cache. Normal operation resumed after network restoration.

Result: PASS for the tested standalone lifecycle cases.

Standalone worker replacement while the app was suspended through the exact same PWA registration could not be independently forced with the available physical-device controls.

Result for that specific subcase: INCONCLUSIVE.

This INCONCLUSIVE subcase must not be interpreted as a safety failure or as evidence that replacement is safe while suspended.

### Safari uncontrolled BFCache — claim OFF

Fresh origin: port 8445.

Original legacy-style page token:

`260f4fa6-5d71-4a25-99d1-bcbd869f8c51`

Before service-worker registration:
- Page was uncontrolled.
- Synthetic legacy lifecycle code executed.
- Page then entered history/BFCache through navigation outside worker scope.

A second Safari tab installed revision-2 worker:

`21657ffa-c44b-4e21-9104-bccb56f68ac5`

with:
- `skipWaiting: false`
- `clients.claim: false`

The original page was restored using Back.

Observed:
- Same original page token returned.
- `pagehide.persisted: true`.
- `pageshow.persisted: true`.
- Restored page remained `controlled: false`.
- Controller remained `null`.
- Revision-2 worker was active concurrently.
- `promotionAllowed: false`.

After restoration, the same legacy-style page successfully executed:

`synthetic-legacy-code-executed`

again while the revision-2 worker already existed.

Result: CRITICAL BEHAVIOR CONFIRMED.

Physical Safari therefore demonstrates that an uncontrolled pre-amendment/legacy page can survive BFCache restoration and continue executing old lifecycle code after a newer service worker exists.

Production safety MUST NOT depend on service-worker installation or activation eliminating old uncontrolled documents.

### Safari uncontrolled BFCache — clients.claim ON

A revision-3 worker was then registered:

`6c2933a9-506a-487e-9d71-b23a787595fb`

with:
- `skipWaiting: false`
- `clients.claim: true`

Observed:
- Previous revision-2 worker became redundant.
- Revision-3 worker activated.
- Both open Safari lab clients became controlled by revision 3.
- The original BFCache-restored legacy document retained the same page token:
  `260f4fa6-5d71-4a25-99d1-bcbd869f8c51`
- That document received `controllerchange` without being replaced by a new document.
- It became `controlled: true` by revision 3.

After being claimed by the new worker, the same old restored document again executed:

`synthetic-legacy-code-executed`

with:
- `stateWritten: false`
- revision 3 controlling the page
- `promotionAllowed: false`

Result: CRITICAL BEHAVIOR CONFIRMED.

`clients.claim()` changes service-worker control but does not replace or invalidate the already-running page JavaScript.

Therefore:

**A page becoming controlled by a new receiver-capable service worker does not prove that the page itself understands the new delivery fence, `delivery_eligible`, disable-first behavior, or tombstone transitions.**

Production authorization MUST treat old-page execution as independently possible even when that old page is controlled by the newest service worker.

### Physical Safari conclusion

The physical Safari/iPadOS tests confirm the core mixed-version threat model.

Specifically:

1. Legacy/uncontrolled documents can survive BFCache.
2. Those documents can execute old lifecycle code after a newer worker becomes active.
3. `clients.claim()` can attach a new worker to the old document.
4. Claiming the document does not replace its JavaScript execution environment.
5. Old code can continue executing after the document becomes controlled by the new worker.
6. Worker ownership, worker revision, client census, finite challenges, BFCache assumptions, and control status alone are insufficient as a production authorization boundary.

Accordingly, future notification delivery must remain fail-closed until the production mixed-version barrier explicitly prevents pre-amendment pages from bypassing:
- delivery-fence
- `delivery_eligible`
- disable-first transitions
- required tombstone transitions

Remote delivery remains BLOCKED.

The lifecycle harness itself never authorizes production delivery and continues to report:

`promotionAllowed: false`
