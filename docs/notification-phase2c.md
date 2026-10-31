# Phase 2C — Local notification editors and presentation

Local implementation only. The Phase 2B publisher, service worker, Phase 2A SQL,
Edge sender, encrypted seven-field payload, financial writers and Cloud Sync
remain unchanged. No production V2 RPC, SQL application, PushSubscription, real
push, Cron, pg_net, deployment, commit or push is part of this phase.

## Presentation

Notification Settings reuses `StShell`, `stSheet`, existing switches and theme
tokens. Sections: Delivery (foreground/local Push Notifications; disabled Email
Notifications / Coming Soon), Reminders (four categories), Schedule (default
time and category-specific default stages), Privacy (Show Amounts). Permission
requests remain explicit; no enrollment control is invoked.

The existing anchored Notification Center, shared bell/action pair, temporal
groups, filters, read-all, dismiss, Escape and focus restoration remain in place.
Rows prioritize local merchant/card artwork, then existing brand/category/initial
fallbacks, with amount/timing and restrained urgency copy. Amounts default off;
metadata uses a filtered join so no orphan separator is shown. Rich data stays
in-app, not in the remote payload. The Phase 5A foreground OS delivery path is
not retimed by this UI work.

### Source details and dropdown controls

The main content is a semantic button that invokes the **existing Plan handler**:
`upBillSheet(id)` for bills/subscriptions/free trials, `upCardSheet(id)` for
credit-card statements. No financial detail markup/logic is duplicated. The
chevron is a separate keyboard-operable expand/collapse button; Reminders and
Dismiss are independent actions. Detail close restores the Notification Center,
filter, scroll and originating focus without changing the active tab.

Resolution uses the local source type/id and the exact record object captured
for that row, not its title. Deleted/replaced/ambiguous records are refused. A
statement must also match the stored cycle/date that Plan's handler would select;
if opening Plan would generate a missing financial snapshot, the notification
refuses instead of creating financial data. The dropdown reports Source no
longer available while retaining dismissal. Compact summaries read only existing
amount/date/account/frequency/trial/minimum fields. Amounts and minimums are not
rendered anywhere in the notification DOM/accessibility text when privacy is off.
The old technical read-only disclaimer is removed, with no replacement warning.

### In-app urgency accents

An independent presentation classifier maps days to overdue, today, tomorrow,
2–3 days, 4–7 days, 8–14 days and neutral. Notification timing text and a small
dot use dark-red/red/orange/amber/soft-yellow/blue-gray/neutral families; expanded
summary has a thin subdued accent. Action buttons remain neutral. Theme colors
blend toward the theme's foreground to preserve contrast; textual timing remains
visible. Light/dark contrast and every tier are tested. This classifier never
changes financial status, schedule timing, OS notifications or remote payloads.

## Local editor adapter

`js/notification-reminders.js` delegates all identity creation, tombstones,
calendar/timezone/DST math, expiry, horizon and collision checks to the unchanged
Phase 2B module. It does not introduce another scheduling formula or database.
`scheduling.editor:<owner>` in the existing `cap-notifications` / `state` store
holds local source associations and reminder parameters. Existing policy and
identity APIs remain authoritative. Writes use a per-owner Web Lock; without
coordination they fail closed. Financial state is only projected/read.

`js/notification-reminder-ui.js` uses existing item sheets and the existing
Settings frame. Native date/time inputs are consistent with Cap's financial
date editors; the older monthly day-of-month picker is deliberately not used
for absolute date selection. Controls have visible labels, native keyboard
support, 44px targets, scrolling, shared focus management and reduced motion.

Relative reminders use inherited/override time and keep their ID on edits.
Absolute reminders retain their accepted timezone and fixed UTC instant, even
after travel or a financial date correction. Invalid/gap/past/duplicate input is
rejected before allocating a new identity. A custom/relative exact collision
keeps the custom and durably tombstones the relative; duplicate customs reject.

## Explicit continuity review (user-approved decision)

The financial model does not expose immutable source-incarnation/cycle tokens.
No adapter can prove continuity from a source ID or a date alone. Therefore no
source is auto-enrolled in the mapping. First setup is explicit. After reload,
or when the projected occurrence/date changes, the editor shows Action required
and asks the user to choose:

* **Same outstanding item** — explicit evidence to retain the mapped IDs.
* **Next occurrence** — close the old occurrence and allocate a new cycle.
* **Recreated item** — close the old source incarnation and allocate a new one.

Unreviewed associations are not compiled as confirmed local schedules. There is
no fabricated remote acknowledgment. Default changes affect inherited local
configuration; individually edited rules remain independent. Deleted reminders
retain durable Phase 2B tombstones and equivalent recreation gets a fresh ID.

## Silent local/cloud access (presentation-only amendment)

`js/supabase.js` retains every authentication/sync safety transition and caller
of `notice()`. That function now only removes a stale `cap-local-auth-notice`;
it never creates the automatic local/cloud-access banner, toast or replacement.
Online unverified access, offline use, Cloud Sync OFF, reload and reconnect all
remain silent. Settings status and the general Cap toast presenter are intact.
`tests/offline-auth.cjs` covers all these states and the real unrelated toast
presenter, while retaining the session/storage/network safety assertions.

## Release gate amendment

Exactly five paths were added to `tests/cloud-pull-security.cjs`:

* `js/notification-reminders.js`
* `js/notification-reminder-ui.js`
* `tests/notification-reminders.cjs`
* `tests/notification-reminder-ui-browser.cjs`
* `docs/notification-phase2c.md`

No wildcard, directory exemption, credential exemption or assertion removal.

## Verification notes

The Phase 2C unit suite covers the adapter with the real Phase 2B compiler and
identity reducer, including failed-write recovery. Its browser suite uses real
Chrome/IndexedDB and the real existing Plan detail handlers. It checks all four
source types, explicit continuity review, edit/delete/reload identities, account
and amount privacy, independent pointer/keyboard actions, contrast across every
urgency tier, responsive layouts/themes, financial-state preservation and zero
V2/push/sender/external calls. Offline-auth checks retain their original session,
storage and network assertions, changing only the obsolete banner expectations.

The existing `tests/notifications-browser.cjs` suite was updated only where Phase
2C deliberately superseded its UI expectations: Settings section/copy, the
independent chevron action, compact source summaries replacing the technical
disclaimer, merchant artwork on financial rows, and the card row label. It still
runs all 70 original delivery, storage, permission, worker, offline, responsive
and financial-read-only checks. Historical v369/v375 assertions and the Phase 2A
exact-byte allowlist comparison remain unchanged and documented. Frozen SQL is
tested using the same isolated Phase 2A checkpoint method as Phase 2B.

## Release packaging (v376)

The separate release commit advances `cap-shell-v375` to `cap-shell-v376` and
adds exactly four CORE scripts: `notification-schedule.js` (compiler/identity),
`notification-publisher.js` (dark client), `notification-reminders.js` (local
editor adapter), and `notification-reminder-ui.js` (settings/item UI). Each is
loaded by index.html and required for a complete offline runtime. Existing
index/CSS/notifications/production-RPC/Supabase assets were already CORE and
receive refreshed bytes through the new cache namespace; no duplicate entries
or media additions are needed.

Architecture is unchanged: mandatory CORE fetches use cache reload at install,
media remains best-effort, skipWaiting/clients.claim activate the completed
cache, old cap-shell caches are deleted, navigation is network-first with a
three-second cached-index fallback, and script/style/media requests use
stale-while-revalidate. Same-origin GET scoping and API bypass remain intact.
Localhost preview still unregisters and bypasses worker caching. Notification
click behavior, background-sync page wakeup, and all runtime handlers are
unchanged. There is no push receiver, subscription-change handler, scheduler,
IndexedDB logic, VAPID logic or publication path in the worker.

The v369 checks in Upcoming presentation, enrollment A8, and the sender test's
shared TypeScript fixture all read the current checkout worker, not a frozen
artifact. They are current-version assertions and now expect v376; sender
production TypeScript is untouched. The same classification applies to the
local-development browser and cloud-pull-shell checks discovered during the
broad regression. No security checks were removed. The frozen Phase 2A SQL
suite's v375 raw-byte/hash assertion remains historical and is NOT modified.

The notification browser suite now exercises both fresh v376/offline loading
and an actual v375-to-v376 upgrade using the origin checkpoint's old shell
bytes. It checks controller takeover, old-cache removal, new-module boot,
offline Settings/Center, and exactly two explicit reloads (no update loop).
The old open document is not forcibly reloaded: this preserves Cap's existing
lifecycle. The first explicit navigation after takeover boots the new shell.

This release packages already-reviewed local clients only. Remote publication
remains off, VAPID remains unconfigured, and SQL/sender/payload/financial/Cloud
Sync/auth/RLS contracts are unchanged. Browser/API tests use isolated synthetic
fixtures; local SQL uses disposable loopback databases, never production.

The frozen Phase 2A scheduling certification was repeated at origin checkpoint
`75ed833` with its exact original raw v375 worker bytes: all 38 checks passed
on local PostgreSQL 17.6. No frozen tests/SQL were edited; the temporary detached
worktree was removed. This is local certification, not production-minor
compatibility certification or permission to activate the remote runtime.

Release regression: adapter 17, Phase 2C browser 29, notification browser 71,
engine 61, offline-auth 44, compiler 44, publisher 25, scheduling browser 14,
RPC-only 14, release security 4, enrollment unit 11/browser 27, Web Push 5,
sender Deno 7/Edge 1, Upcoming 20, shell cache 5, local development unit 15/
browser 10, financial Search 60/Health 73, production sync 31/wiring 5/IDB 8,
outbox 49, sync toggle 9, cloud pull 48/bootstrap 64, foundation SQL 69,
enrollment SQL 21/real PG amendment 18, frozen scheduling SQL 38, sender SQL 31
all passed. JavaScript syntax (142 files) and both JSON configs passed.
Initial harness issues (missing external fake IndexedDB path, slow initdb,
browser process timeout, missing explicit loopback database URL) were resolved
outside product code. The sender SQL suite's known short-statement timeout
under parallel load passed in isolation without changing SQL or assertions.
The first Web Push run also completed successfully on isolated rerun. Current
v369 cache expectations were updated, not treated as passing unchanged.
