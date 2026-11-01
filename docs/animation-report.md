# Cap animation integration report

Completed implementation and focused motion verification: 2026-11-01. No commit, push or deployment performed. Baseline findings were recorded before implementation in [animation-audit.md](animation-audit.md).

## 1. Dependency and deployment

- Installed **Anime.js 4.5.0**, the npm stable version returned during this task; exact dependency pin and npm lockfile.
- Cap had no package manager manifest or app bundler. Added minimal npm dependency management without an application build step. `npm ci --ignore-scripts` restores dependencies; `npm run vendor:anime` reproducibly copies the official browser ES module and MIT license.
- Browser loads **one** local ES module via `js/cap-motion.js`. No CDN, UMD/global second engine, or second runtime copy. The installed `node_modules` copy is not referenced by HTML/browser code.
- Vendored module is 118,678 bytes uncompressed. The complete official ESM bundle avoids introducing a bundler or a fragile manually selected module graph; future bundle-size optimization is optional.
- Preserved `vercel.json` and its runtime-config generation build command. Static serving works without `node_modules` or generating the vendor module at deployment because the vendor files are included in the change set.
- Added bridge/module to offline CORE and bumped shell **v376 → v377**. Navigation/network/API policy and notification receiver code were not changed. Production-mode shell online→offline reload successfully imported Anime.js from cache on an isolated trustworthy loopback origin (`127.0.0.2`, outside the intentional localhost bypass).

## 2. Files added

- `package.json`, `package-lock.json`
- `scripts/vendor-anime.cjs`
- `assets/vendor/animejs/anime.esm.min.js`
- `assets/vendor/animejs/LICENSE.md`
- `js/cap-motion.js`
- `.opencode/skills/cap-animation/SKILL.md`
- `docs/animation-audit.md`, `docs/animation-report.md`
- `tests/cap-motion.cjs`, `tests/cap-motion-browser.cjs`

## 3. Files modified by this task

- `.gitignore` — ignore installed packages, retain vendored browser asset.
- `index.html` — load optional bridge, preserve classic-script initialization order.
- `service-worker.js` — VERSION and two CORE paths only.
- `js/animations.js` — sheet lifecycle reset, delayed counter ownership, PTR settle ownership/idempotent initializer/reduced-motion fallback.
- `js/app.js` — only `navS` presentation lifecycle guards and in-app reduced-motion handling.
- `js/cards.js` — setup presentation callback ownership/cancellation, flying-card handoff ownership and owned close-fade cancellation. No account-save or financial calculation changes.
- `js/calendar-popup.js` — nested presentation swap cancellation/revisions; idempotent popup cleanup.
- `js/smart-log.js` — cancel scoped presentation on hide/render; managed child receipt/review cue.
- `css/animations.css` — calm shell/confirmation motion, finite passive feedback, targeted accessibility overrides.

Other `.opencode` content, untracked notification SQL/tests, `docs/notification-authorization-foundation.md`, and concurrent `js/notification-enrollment.js` edits are **not this task's changes**. They were not reverted or edited. No notification, authentication, sync, migration, storage or transaction/payment execution implementation was modified by this task.

## 4. Reusable skill

**`.opencode/skills/cap-animation/SKILL.md`** is discoverable as `cap-animation`. It covers audit/debugging, selective new-motion decisions, timings/easing, entrances/exits, shells/cards/navigation, micro-interactions, loading/results, interruption/cancellation/cleanup, DOM/state/transform ownership, reduced motion, mobile Safari/iOS/iPad, Android/Capacitor, offline PWA deployment, performance and verification.

## 5. Existing systems discovered and retained

CSS transitions/keyframes; native Web Animations API; rAF counters, gesture physics and positioning; timed presentation state machines. See the surface-by-surface inventory for locations and decisions.

**No GSAP was present**, so none was removed or migrated. Existing transform-based card flight/text handoff, 3D flips, carousel inertia, bottom navigation glyphs, calendar gestures, command-bar morph, Settings transitions, financial feedback and CSS micro-interactions remain in their existing engines. No Cappy/mascot hooks were found.

## 6–7. Findings and fixes

The audit registers 12 findings/risks, not 12 independently reproduced defects. Nine received targeted changes:

| Audit ID | Fix | Verification |
| --- | --- | --- |
| A1 | Invalidate sheet navigation timer/rAF writes; clear busy/height/scroll-hold/classes at ownership changes; treat navigation into a closing sheet as a fresh open; honor in-app reduced flags before interrupted commit | Rapid navigate/close/reopen keeps only latest view, no stuck busy/opacity |
| A2 | A departing card can always clean its own ghosts, but cannot close a replacement sheet; cancel only its own fade, not all new shell animations | Replacement remains visible/open; no ghosts; entrance not restarted by old completion |
| A3 | Track and cancel delayed balance starts and rAF together; disconnected checks; exact final values if privacy/reduced/hidden changes during playback; tolerate absent delta node | Repeated starts settle to exact formatted value with timer/rAF handles cleared |
| A4 | Revisioned/owned popup swap timers; cancel at close/replacement; clear close timer and restore scroll lock only once | Rapid edit/back latest view, double close, no detached swap revival |
| A5 | Own and cancel PTR settle timer when a new eligible gesture takes over; initializer guard prevents duplicate PTR listeners/indicator | Source-reviewed lifecycle fix; actual repeated-touch gesture still needs device verification |
| A6 | Replace untracked Smart Log parent WAAPI cue with managed Anime child cue | Rapid edit/review/close, no stale managed jobs or parent-engine collision |
| A7 | Guard setup frame/timers/focus with captured state and connection; cancel on exit; reject duplicate setup and repeated cancellation | Immediate cancel never flips/reveals again; one setup overlay only |
| A9 | Passive financial-status motion settles; paid/transfer checks end fully drawn instead of repeatedly disappearing; simplify terminal confirmation | CSS final state reviewed; no additional payment execution paths |
| A11 | Targeted OS/in-app reduced-motion rules for generic shell, popups, long-press and PTR; adapter reacts to changing preferences | Chrome/WebKit OS + in-app preference tests; other existing effects retain their own fallbacks |

A2 testing also revealed a subtle flash cause: removing `.cardfx` at an old flight's completion could restart the newer sheet's CSS entrance. Replacement now takes shell-class ownership immediately when it opens.

## 8. Existing animations improved

- Generic sheet: 500ms/44px/7% scale entrance becomes 280ms/12px/1.5%; exit uses 8px/1.5% rather than 24px/4%. Closer to existing Settings timing, without moving/redesigning layout.
- Backdrop fades opacity without interpolating blur. Removed permanent `will-change` from the generic sheet container.
- Terminal check: short 240ms small-scale entrance rather than a full rotation and exaggerated overshoot. Existing payment status, chime, timing and financial flow remain unchanged; decorative terminal glow loop removed.
- Passive chart/status arrows, timing chips, overdue and paid badges play once rather than indefinitely. Paid and transfer marks settle fully visible; active loading spinners remain active only under existing loading states.
- Existing counts and nested views retain their visual behavior with safer interruption/cleanup.

## 9–10. New animation and UX rationale

**One new motion opportunity implemented:** when Smart Log produces its receipt after keyboard dismissal, the completed review content settles in over 180ms (4px, opacity .72→1). The same managed cue replaces the existing editor/review WAAPI cue for continuity.

Why: it connects submission to the resulting review surface and distinguishes new content without animating financial digits or delaying confirmation. Final labels/amounts are already correct. The parent keeps its existing CSS entrance; Anime owns a dedicated child only. New motion fails open if import is unavailable, is not queued late, and does not run under reduced motion, hidden documents or detached/hidden targets.

## 11–12. Intentionally not added / engines retained

No additional financial counters, staged merchant/category/amount recognition, pretend parsing spinner, confetti, money trails, overdue shakes, animated empty states, mascot loops, blanket list staggering, whole-page slides or new privacy-value fades. Existing confirmation/navigation/card cues already explain those actions; more motion would compete with financial information or create ambiguity.

No GSAP existed. Good native WAAPI/CSS/rAF behavior was retained for geometry, gestures and established interactions. The only engine substitution is the small untracked Smart Log swap cue, justified by shared cancellation and child ownership.

## 13–14. Performance and accessibility

- New effect uses transform/opacity, is finite and has one active instance per target.
- Cleanup on replacement, removal, hidden ancestry, pagehide, visibility change and motion preference changes; completion reverts owned inline styles to CSS final truth.
- No new permanent rAF loop, layout measurement loop, amount interpolation or blur animation.
- Fewer decorative loops/shadow/filter redraws; no measured claim of universal 60fps. Chrome 6× CPU-throttled cue replacement settled without stale managed instances.
- OS reduced motion and both in-app motion flags are supported. Financial data and controls are usable without Anime.js; import-failure tests pass. Privacy masking remains immediate and pre-paint behavior unchanged.

## 15–16. Tests and results

Tests run on isolated fake-config HTTP origins and synthetic data, never against live financial/cloud/notification services. No existing test was edited to hide a failure.

### Passed

- `npm install --ignore-scripts`: exact dependency installed; npm reported zero vulnerabilities.
- `npm run vendor:anime`; `tests/cap-motion.cjs`: vendor bytes match installed package, pin/lock/license, single import, presentation boundary, CORE files exist, skill metadata.
- `tests/cap-motion-browser.cjs`: **28 cases**, Chrome + WebKit, including rapid replay, removal/hidden target/pagehide, changing reduced-motion preferences, simulated background visibility, Chrome 6× CPU slowdown, nested sheet ownership, card replacement/no-restart handoff, overlapping Home counts, setup cancel, popup edit/back/close, Smart Log light/dark continuity, import failure and production-mode offline reload. Primary contexts also check application runtime and console errors.
- Existing `nav-icon-motion`, `calendar-navigation`, `calendar-inertia`, `command-bar`, `command-bar-keyboard`, `smart-log-browser`.
- Existing `hero-balance-browser` (**88 numeral/layout checks**), `financial-search-browser` (**30 checks**), `notification-reminder-ui-browser` (**29 checks**).
- Existing `notifications`, `notification-schedule` (**44 compiler checks**), `notification-publisher`, `notification-reminders`, `notification-delivery` (**83 delivery-fence/receiver checks**).
- Existing `sync-outbox`, `sync-production`, `sync-production-idb` (**8 checks**), `cloud-transaction-update-delete` (**22 checks**), `client-rpc-only`, `transaction-create-race-guards`, `local-development` (**15 checks**), `smart-log-parser` (**99 checks**).
- Syntax checks of `js/*.js`, service worker, vendor script and new test scripts; JSON parsing of manifest, Vercel config, package manifest and lockfile; `git diff --check`.

### Existing tests not green

- `settings-shell-browser`: `notif resized`, actual 660px vs expected 556px at 320px viewport. **Reproduced identically on an untouched HEAD archive** in an isolated temporary directory. Not repaired because it is outside this animation change.
- `ui-presentation`: earlier behavioral checks pass, then obsolete hard-coded `cap-shell-v369` assertion fails (baseline was already v376).
- `upcoming-presentation`, `cloud-pull-shell`, `notification-enrollment`: hard-coded v376 assertions fail after the required v377 bump. The enrollment suite passed its initial state-machine/privacy/RPC boundary assertions before that shell pin. Tests were left unchanged.
- `financial-health-browser`: its first **46 behavioral/layout/state-preservation checks pass**, then the offline subtest explicitly looks in obsolete `cap-shell-v369` and fails. Its title also pins that historical version.
- `notifications-browser`: its first **69 behavior/layout/state-preservation checks pass**, then the offline subtest explicitly opens `cap-shell-v376` and fails. `notification-delivery-browser` passes the first **4 actual-worker/fence checks**, then asserts cache key v376 and fails.
- `local-development-browser`: its initial login/session/profile/local-worker cleanup checks pass; its final production-selector/offline section fails with diagnostics intentionally suppressed by the existing test. That section contains a hard-coded v376 cache assertion, but the suppressed failure was not independently localized further. No credential logging or test suppression override was introduced.
- `cloud-pull-security`: fixed historical release-file allowlist rejects newly added animation/dependency/skill files and unrelated concurrent files. Not changed to broaden release authorization.
- Four IndexedDB-dependent suites initially failed because the optional external fake-indexeddb path was not supplied; reran with `CAP_FAKE_IDB_PATH`, and delivery, production IDB, transaction update/delete and local-development all passed.
- One foreground rerun of the expanded motion suite hit the shell's 120s execution limit while other browser suites ran; a subsequent unrestricted background run completed all 28 cases, including runtime/console checks. The final extra closing-sheet navigation branch also has a passing isolated VM regression in `tests/cap-motion.cjs`.

The regression suite is therefore **not entirely green**. Passing targeted motion/behavior checks do not erase the failures above. The real-device matrix and Vercel deployment are not claimed tested.

## 17–18. Remaining risks and recommendations

- Real iPhone/iPad/Android/Capacitor hardware, native app suspension/resume/back navigation and installed-home-screen behavior still require manual verification. WebKit and synthetic visibility/pagehide events are not equivalent to OS suspension. No native-device smoothness guarantee.
- Actual rapid repeated touch/trackpad PTR gestures need device verification; sync/refresh data work was deliberately not changed. No automated new payment execution was introduced; existing payment timing remains.
- Existing setup flight still interpolates layout geometry; sheet height resizing and some command/calendar geometry are deliberate retained exceptions. A transform-only setup flight is a separate future improvement, not a mass migration.
- A8: selected-day `once` animationend listeners can survive cancelled animations despite the existing visual fallback; scope their cleanup in a focused calendar follow-up.
- A12: transaction deletion schedules existing financial work after row exit, so duplicate deletion requests deserve a separate guarded financial-action audit. No accounting/deletion logic was changed here.
- Existing startup/resume financial count-ups, older unowned success/transfer presentation timers and mixed CSS cascade overrides remain. Do not extend those patterns; audit them individually before future changes.
- Progress-from-previous-state could improve savings/budget updates, but needs a render-safe identity/value cache first. No reset-from-zero effect was added.
- Review version-pinned tests and release allowlists in a separately authorized test-maintenance change. Do not downgrade the service-worker version to satisfy stale tests.
- Re-run relevant notification tests after concurrent notification work settles; this report covers the observed workspace during execution, not a frozen release artifact.

No commit or push has been made. Review the report and device-test limitations before release.
