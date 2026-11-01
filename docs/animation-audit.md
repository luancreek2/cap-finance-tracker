# Cap motion audit — 2026-10-31

## Baseline inventory (recorded before implementation)

The repository is a classic-script static PWA, not a bundled application. No package manifest/lockfile or package manager exists. Vercel only runs the runtime-config generator. Contrary to the older AGENTS notes, `tests/` contains Node and opt-in Playwright tests. Existing untracked `.opencode/` content and notification SQL/tests belong to other work and must be preserved.

| Surface / files | Existing ownership and motion | Decision |
| --- | --- | --- |
| `css/styles.css`, `css/animations.css`; `js/animations.js` | CSS transitions, duplicate page/sheet/toast keyframes and overrides; page entry, row insert/remove, buttons, menus, chart draw, progress bars | Keep functioning CSS; do not mass migrate |
| `js/animations.js` lines 18–107 | rAF balance/stat/hover counts; delayed starts, resume replay | Repair overlapping delayed starts; preserve exact formatting/privacy |
| `js/animations.js` lines 109–181; `js/app.js` `navS` | CSS sheet backdrop/container entry/exit, inline view transforms/opacity and measured height interpolation; scroll-hold rAF | Repair cancelled navigation state; keep stable shell |
| `js/cards.js` `initCardAnimations`; `css/animations.css` `.cardfx-*` | Native WAAPI flying-card/text overlays, tilt, source visibility handoff; rAF available-credit/balance count and WAAPI ghosts | Keep compositor-based handoff; inspect stale completion ownership |
| `js/app.js` `flipAccountCard`; `css/styles.css` `.acct-flip*` | CSS 3D front/back flip, long-press, transitionend with timeout fallback | Keep separate wrapper ownership |
| `js/cards.js` `beginAccountSetup` / cancel / finish | CSS card flight using left/top/width/height, delayed flip/form reveal; completion flight | Layout-heavy, delayed-cancel race; candidate targeted fix, not migration |
| `js/account-carousel.js`, `css/account-carousel.css` | Pointer tracking, inertial rAF, transform-only recycled cards; tilt, ResizeObserver + AbortController cleanup | Good cleanup; retain |
| `js/account-options.js`, `css/account-options.css` | Selection, checkmark, drag reorder FLIP transforms, short menu entry | Retain |
| `js/app.js` `bvToggle`; `css/styles.css` privacy rules | Immediate root privacy class, eye SVG transitions; pre-paint masking in HTML | Keep privacy immediate; never fade exposed amounts |
| `js/app.js` `playNavIcon`; `css/styles.css` nav keyframes | One-shot selected icon, stationary labels/navigation chrome | Good, retain |
| `js/transactions.js` long-press / confirm / deletion | CSS press/pop, confirmation open/close, 260ms row exit before existing deletion | Preserve transaction timing/logic; delayed double-delete is a separate financial-action risk |
| `js/animations.js` `initPullToRefresh` | Dynamically injected CSS spinner, gesture rAF, app/indicator transforms, asynchronous refresh | Stale settle timer can clear a new gesture; reduced flag captured but unused |
| `js/animations.js` payment feedback; `js/cards.js` transfer feedback | CSS dots/spin/draw/ripple/glow, timed terminal; transfer WAAPI coins/card pulses | Already communicates result; no additional payment engine/logic |
| `js/command-bar.js`, `css/command-bar.css` | WAAPI surface/clip/glyph/backdrop morph; revision tokens/cancellation; keyboard placement rAF | Good interruption model; retain |
| `js/smart-log.js`, `css/smart-log.css` | CSS preview entry plus untracked WAAPI editor/review swap; receipt itself appears immediately | Use managed child entry/swap cue, avoid parent CSS collision |
| `js/financial-search.js`, `css/financial-search.css` | CSS results entry, same command-bar continuity | Retain; no result-by-result stagger |
| `js/activity-scope.js`, `css/activity-scope.css`; `js/app.js` calendars | Month/day stages, CSS/rAF inertia, selected-day pop, scroll timelines, tooltip positioning loop | Complex working gesture system; retain existing calendar tests |
| `js/calendar-popup.js`, `css/calendar-popup.css` | CSS anchored float/panel/backdrop transitions, marquee, timer-based nested form swaps; scroll/resize listeners | Repair stale swap callbacks and repeated-close cleanup |
| `js/settings-shell.js`, `css/settings-shell.css` | WAAPI outgoing inert clone/incoming content; CSS shell; explicit cancellation/scroll preservation | Good scoped behavior; retain |
| `js/financial-health.js`, `css/financial-health.css` | CSS dialog/factor entry, SVG gauge reveal | Retain |
| `js/brand.js`, `css/brand.css`; What's New in `js/app.js` | Launch logo/rings/dots and fade; release-panel stagger; CSS auth entry/exit | Out of scope for redesign; retain |
| `css/offline-auth.css`, `css/cloud-sync.css`, `js/supabase.js` | Lock/auth/cloud-switch CSS feedback | Preserve authentication/sync behavior |
| `css/notifications.css`, notification JS | Tray/detail entry, disclosure height/color transitions | Inventory only; notification system untouched |
| `css/spending.css`, spending functions in `js/app.js` | Chart/bar entry, filters/indicator, draggable range inertia/snap | Retain |

No GSAP, Anime.js, Cappy, or mascot hooks were found in active JS/CSS/HTML. No engine needs removal. CSS, WAAPI, rAF and timers coexist; their presence alone is not a bug. Duplicate `.pg`, `pgIn`, sheet and toast definitions in `animations.css` are cascade overrides, not simultaneous engines, and are left intact pending a separate cascade cleanup.

## Suspected defects / risk register

Static findings below are risks, not claims of device reproduction. H = high, M = medium, L = low.

| ID / severity | Component, file, animation, trigger | Expected vs actual/risky behavior | Root cause / proposed fix |
| --- | --- | --- | --- |
| A1 / H | Sheet navigator, `animations.js` open/close + `app.js` navS; navigate → close → open | New sheet should be fully settled; `_navBusy`, old resize/scroll-hold or queued rAF can style the next view | Incomplete lifecycle reset. Cancel timers/rAF, invalidate view writes, clear navigation classes on open/close |
| A2 / H | Flying card, `cards.js`; close → unrelated openS during flight | Old close must not hide newer sheet | Completion operates on permanent shell without ownership check. Capture the view identity; cleanup own ghosts always, mutate shell only if still owned |
| A3 / M | Home counters, `animations.js`; repeated render/resume before delayed count begins | One latest run, exact final amount; untracked delayed `begin` can create multiple rAF chains | Track and clear delay and rAF together; check connection and current privacy/reduced state during run |
| A4 / M | Calendar popup `swap`, `calendar-popup.js`; edit/back rapid taps or close | Latest view wins; old timer can overwrite newer form or detached content | Untracked nested timers. Revision + owned timers, invalidate in cleanup |
| A5 / M | Pull refresh `settle`, `animations.js`; a second short pull within 420ms | New pull remains in control; old settle clears its transform | Unowned settle timeout. Cancel at next eligible gesture; reduced-motion CSS fallback |
| A6 / M | Smart Log swap, `smart-log.js`; repeated edit/review/close | Single short transition; untracked WAAPI instances stack on same parent as CSS | Move cue to new child, track cancellation through shared motion adapter |
| A7 / M | Account setup, `cards.js`; cancel during opening | Cancelled card must not flip/reveal again | Delayed reveal reads global state without run identity. Guard opening callbacks with state identity/closing flag; reject duplicate setup |
| A8 / L | Activity selected day `activity-scope.js`; repeated pop | Fallback removes class, but once animationend listeners can accumulate until a future event | Existing timeout handles visual state, listener cleanup could be scoped separately |
| A9 / M | Paid/transfer chips, chart sweep, balance arrows, payment detail timing, overdue pulse `animations.css`; reading financial data | Feedback should settle; many decorative infinite loops compete with reading and paint blur/shadows | Limit passive decorative loops to one cycle; exact completed checkmarks must remain visible |
| A10 / M | Setup flight, sheet resize, command position, legend max-width/margin | Avoid per-frame layout where possible | Known geometry morph tradeoffs. Retain measured sheet resize; recommend transform-only setup flight separately |
| A11 / M | Generic sheet and pull refresh reduced motion | OS/in-app settings should suppress motion; generic shell rules rely on incomplete broad fallbacks and injected PTR CSS ignores flags | Add narrowly scoped overrides for affected elements; no global transform resets (break centering/3D layout) |
| A12 / M | Financial deletion delayed exit `transactions.js` | Repeated request must not apply accounting twice | Financial action scheduled after animation; report only here, do not alter financial logic in this task |

Z-index is already centralized with layer variables; anchored overlays portal outside transformed ancestors. Card ghosts intentionally sit above the modal. Do not add a transform to permanent shells or move their stacking contexts. Visibility hides source cards during handoff; opacity-only closing must not undo this. Detached WAAPI work and global callbacks merit testing even where eventual promises remove ghosts.

## New motion opportunities and decision

Implement only a short child-content cue when a Smart Log receipt is produced after keyboard dismissal, and reuse it for edit/review continuity. Action → immediate parsed result → stable review. Financial labels/amounts are final before motion starts; no fake loading, count-up, sequential recognition, staggered fields or delay to confirmation.

Keep existing transaction insertion, payment confirmation, transfer feedback, account flight/flip, navigation glyph, filters and privacy feedback. Do not add confetti, overdue shake, empty-state loops, mascot, whole-page slides, monetary trails, fresh counters or progress-from-zero. Savings/budget previous-state progress is a future recommendation requiring a render-safe identity/value cache, not an animation on every render. Prefer a future error focus cue only if existing validation proves insufficient.

## Verification plan

Isolated fake-config browser origin (no live financial/cloud/notification traffic): open/close, open-close-open, double/rapid taps, card flight replaced by another view, nested popup navigation/close, Smart Log parse/edit/review, detached target cleanup, simultaneous cues, OS + in-app reduced motion, light/dark and phone/tablet widths. Exercise visibility/pagehide events and CPU throttling; distinguish simulation from actual PWA suspension. Check offline shell on a non-localhost secure origin because this repository deliberately unregisters service workers on localhost. Run syntax/JSON checks and relevant existing Node/Playwright suites; do not silently count skipped tests as passes.
