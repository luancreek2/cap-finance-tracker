# Phase 5A — Notifications Foundation

**Phase 5A does not guarantee scheduled notification delivery while Cap is
completely closed. Reliable background push delivery is deferred to Phase 5B.**

Cap evaluates reminders while running, including startup and return to foreground.
Browser/OS suppression, suspension, focus modes and permission settings can prevent
or delay display. There is no server scheduler, push subscription, VAPID, cron,
Edge Function or new cloud schema in this phase.

## Architecture

`notification-engine.js` is a pure CommonJS/browser module:

`financial state + explicit local today + preferences → versioned candidates`

It reuses Financial Search's read-only snapshot/definition/statement projection,
which already owns date recurrence and paid/status interpretation. It never calls
`cSum()`, `cardCycles()` or `outstandingCardStatements()`; those existing app paths
can generate/save statements. No second transaction or Upcoming ledger is added.

`notifications.js` owns notification-only local preferences/history, duplicate
coordination, the Home bell, Notification Center, Settings and delivery adapter.
The app's old notification globals are small compatibility bridges. The existing
open-app three-minute poll calls the new bridge; no second recurring scheduler
is installed. Startup/launch completion, Home replacement, app focus and visibility
events also coalesce lightweight reevaluation. An 80ms UI debounce is not a
future-notification scheduler. Hidden/locked/auth-overlay pages do not automatically
present reminders. Evaluation does not request authentication or network access.

The old scanner's financial `S.notif` writes, amount-first copy, daily dedup keys,
budget/low-balance types and statement-generating calls are no longer active.
Legacy settings may be read for compatible defaults but are never migrated or
written back. Existing legacy fields/backup data are not removed.

## Types, defaults and recurrence

| Category | Default advance window | Due day | Overdue |
|---|---:|---|---|
| Bills (one-off or recurring) | 3 local days | Yes | Yes, if recorded unpaid |
| Subscriptions | 3 local days | Yes | No speculative overdue-renewal type |
| Free Trials | 3 local days | Trial end / recorded first-billing anchor | Never a trial overdue-charge claim |
| Credit Cards | 5 local days | Safely established stored principal | Yes, if safely established unpaid |

Master Notifications is **off by default**. Categories and Overdue Reminders are
enabled by default when the master is enabled. Timing options are 0, 1, 2, 3, 5,
7 or 14 local days. Zero means due day only; other options include both advance
and due-day stages. Each occurrence has only its current stage, never simultaneous
due-today and overdue candidates. Overdue is one reminder per occurrence, not a
daily alarm. Category toggles and the separate overdue toggle both apply.

The pre-reminder remains eligible from its advance date until the due day so an
open app can catch up once. Recurrence uses the existing current/next occurrence,
month-end clamping and paid marks (`paidOn`, monthly `paid`). It does not invent
infinite schedules or missing historical weekly arrears. Cancelled/expired records
are excluded. Trials use the same trial/first-billing interpretation as Upcoming;
a trial reminder is not a financial charge. A deleted or paid source disappears
on reevaluation. Editing a date yields the corresponding new occurrence identity.

### Credit safety

Only the latest stored closed statement per card is considered. Safely linked
repayments reduce its principal, and principal is capped by current positive owed
balance. Zero/prepaid cards and fully satisfied principal are excluded. Future
snapshots are ignored; older rolling statement balances are not summed again.
Missing dates/balances/snapshots, legacy unlinked payments and uncertain credits
fail closed. Unbilled amounts and unbooked fees are never estimated. A manual bill
mirroring a tracked credit account is suppressed in favor of the statement source.
This may mean a tracked card has no reminder until reliable stored data exists.

## Candidate contract (version 1)

Each candidate has `id`, `deduplicationKey`, stable browser `tag`, `sourceType`,
`sourceId`, category, reminder type, `dueDate`, `eligibleDate`, occurrence identity,
days until due, urgency, title/body, optional authoritative integer `amountCents`,
safe brand label and safe Home/notification-center target. Dates are local ISO
calendar keys, not UTC timestamps. Human-readable formatting is presentation only.

Identity:

`cap-reminder-v1:<source>:<encoded local ID>:<occurrence>:<due date>:<stage>`

Stages are `before-N-days`, `due-today`, `trial-ends-today` and `overdue`.
For cards, occurrence also identifies the stored statement end date. Identities
do not use randomness, record amounts, rendering time, theme or daily scan count.
Future recurrence and a different configured lead stage have distinct identities.

This JSON-friendly contract, privacy copy, preferences and rules can be reused by
a future push delivery adapter. Phase 5B must supply the user's local calendar day
and preserve the same versioned occurrence semantics; it is not implemented here.

## Permission and capability behavior

No prompt runs at page load, first launch, sign-in, opening Settings, enabling the
in-app master, reevaluation or Test Notification. Enabling the master only enables
local reminders. Settings explains lock-screen content, then offers **Enable
browser notifications**. Only that explicit user action requests browser permission.
Where available, the actual user-activation API is checked as well.

Status is **Not Requested**, **Allowed**, **Blocked** or **Unsupported**. Denial is
respected and does not produce repeated prompts. Browser permission changes remain
the user's choice. Unsupported environments retain the in-app center.

Detection uses a secure context, actual Notification API/permission, service-worker
availability, `showNotification`, registration/active-worker availability and
standalone display state. There are no hardcoded iPhone/Safari support assumptions.
An active registration's `showNotification` is preferred; an available window
Notification constructor is a fallback. Constructor/presentation failures are
reported rather than interpreted as successful reminders. OS display itself cannot
be verified from a resolved presentation API call.

**Test Notification** sends fixed, non-financial copy through this same adapter:
“Cap notifications are ready” / “You'll receive reminders based on your
notification settings.” It does not request permission, alter source due-state,
or enter normal delivery history. Its separate stable tag is `cap-test-v1`.

## Privacy

**Show amounts in notifications is off by default**, including for legacy users.
Merchant/trial names may appear on a lock screen; Settings explicitly explains
this. Card notification copy is generic and does not include account/card names.
Long digit sequences in other source labels are redacted. Full card/account numbers,
source IDs, balances, income, net worth and debt totals are never added to copy.
User-authored names may still contain personal text; users should name items with
their own lock-screen privacy needs in mind.

Opt-in adds only a valid authoritative recorded amount to the body, not the title.
Unknown/unsafe values are omitted, not estimated. Copy is rederived immediately
before delivery so pending work does not reuse stale amount-privacy preferences.
No reminder titles, bodies, amounts or account names are persisted in delivery
history or sent to analytics/remote services.

The center only uses existing local brand artwork or permitted local/uploaded
image sources, with a neutral fallback on image failure. It does not fetch remote
logos. Browser notifications use existing local Cap icons.

## Minimal local metadata and duplicate safety

One device-local key per cached local identity:

`cap_notifications_v1:<encoded cached local user ID or local>`

The value is `{version:1, preferences, history}`. Each history entry is keyed by
the stable reminder identity and stores only its local day, seen/dismissed,
attempted/delivered flags and optional failed-delivery retry timestamp. It does not
write `pera`, financial IndexedDB, baseline, outbox or cloud preferences. The cached
identity reader is pure; Notifications deliberately does not call the Auth status
accessor, which can invalidate verification when offline.

All writes cooperate through the same owner-scoped **Web Lock** where supported.
Automatic browser presentation requires this lock so two Cap tabs cannot race to
present the same logical reminder. Without Web Locks, the center/preferences and
explicit Test remain available, but automatic browser presentation stays disabled.
The feature does not weaken its real capability checks for automation.

A claim is saved **before** presenting; success records delivery. Seen or dismissed
items are acknowledged and not automatically re-presented. Stable tags with
`renotify:false` provide a further browser-level replacement guard. A crash between
claim and result can leave an uncertain attempted reminder suppressed: this is an
intentional at-most-once bias, not a false claim that the OS displayed it. Rejected
presentation records no success and backs off five minutes between running-app
evaluations. No timer promises to wake the app to perform that retry.

At most five reminders are presented per evaluation to avoid flooding. History
prunes obsolete records older than 120 local days and is capped at 1,000 entries.
Still-active overdue records are protected even while master/categories are off;
ambiguous overdue sources are conservatively retained. If all capacity is occupied
by protected records, new automatic presentation pauses instead of dropping claims
and risking duplicates. Storage failures likewise fail closed, while the center
remains readable. Clearing site data or restoring previously pruned historical
data can reset deduplication; this is device-local metadata, not synced history.

## Center, seen state and clicks

A restrained horizontal **bell / ⋮** Home action pair reuses the existing Settings
button/handler; its original gear is restored outside Home. The bell opens a
nonmodal native-dialog tray anchored 8px below its actual geometry, clamped to the
visual viewport. Desktop/iPad width is 460px; phones use 12px side margins. Height
is capped at 70% of the available viewport and bottom clearance. Home remains
interactive, unscaled, unblurred and undimmed; there is no modal backdrop. Resizing,
orientation/visual-viewport changes and scrolling reposition the tray.

The header has outline **Mark all as read** and **Notification settings** controls;
the gear opens the existing settings surface, never an embedded duplicate form.
Header and **All / Bills / Subscriptions / Cards** filters stay above the single
vertical feed scroller. Trials belong under Subscriptions. Filter state is temporary
and resets to All on open. Only populated **Overdue**, **Today**, **Upcoming** groups
are shown. Local logos have no painted tile or outline, and long titles wrap.

Opening does not mark reminders seen. Expanding one marks only that reminder seen;
**Mark all as read** acknowledges all current non-dismissed reminders across filters.
Rows remain available and delivery/attempt/retry/dismissed flags are preserved.
Only existing notification metadata is written. A tiny bell indicator and accessible
unseen count update immediately. Row unread dots/title weight distinguish new items;
read status remains accessible without a repeated visible “Read” label. Timing uses
the existing Needs Attention urgency tiers: deep red overdue, red 0–3 days, amber
4–7 days, later neutral; trials keep their neutral heads-up treatment. Timing words
remain present so color is not the only indication. Dismissal hides only that
occurrence/stage; future recurrence is separate. No read/dismiss operation marks a
source paid, complete or cancelled.

Rows expand read-only reminder details with timing and source category. There are
no one-tap financial actions. The service worker focuses a same-origin, same-scope
Cap window and sends a center-open message, or opens Cap with a fixed center query.
Notification-supplied URLs are ignored. This deliberately conservative fallback
avoids statement-generating card views and fragile accounting deep links. Locked
or auth-overlay pages do not reveal the center automatically; normal access gates
remain in control. No auth/session or financial state is changed by click handling.

The five existing themes, phone/tablet layouts, visible focus, keyboard expansion,
Escape dismissal, focus restoration and reduced motion are supported. The tray is
not a focus trap: Home remains available. Bell-toggle, outside pointer interaction
and context navigation dismiss it; outside actionable targets retain their own
focus. Opening animates subtly from the upper-right (opacity/4px/0.98 scale), with
no bounce. Existing Home logo treatment and Financial Health are untouched.

## Offline and validation scope

Notification rules, center, preferences, deduplication and supported local Test
presentation work without per-evaluation Supabase calls. New assets are in offline
CORE after their existing dependencies. Shell invalidation is exactly once:
**cap-shell-v367 → cap-shell-v368**. Navigation/network-first behavior and financial
background-sync handlers are preserved; no push handler or scheduler is added.

Pure tests cover types, settings, boundaries/time zones, stable identities, card
ambiguity, double-count guards, privacy and frozen-state immutability. They execute
the actual service-worker click handler against safe/unsafe window/URL fixtures.
Browser tests mock Notification presentation/permission APIs explicitly while
running the actual capability gates, local metadata, Web Locks and UI. They verify
permission UX, denial, deduplication, read-only snapshots, themes/layout, failure
paths, seen/dismissed behavior and an actual service-worker offline reload.
Read-only checks include both empty sync metadata and nonempty synthetic baseline
and outbox entries; the cross-tab controller fixture deliberately excludes the
unrelated app startup save so this check does not ignore persistence timestamps.

Passing mocked browser tests is not native iPhone/iPad/Android lock-screen delivery
certification. Installation requirements and browser/OS background limitations
vary; actual capabilities and failures are surfaced rather than guessed.
