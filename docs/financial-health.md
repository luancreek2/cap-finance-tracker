# Financial Health / Cap Score — version 1

Cap Score is an internal, deterministic indicator of **tracked Cap data**. It is
not a credit score, lending score, professional rating, success prediction or
investment advice. Thresholds below are Cap heuristics, not universal truths.
No AI, analytics or remote analysis is used.

## Architecture and read-only boundary

`financial-health-engine.js` consumes the existing Search snapshot, aggregate,
category grouping and recurrence utilities. It adds metrics/scoring, not a second
transaction ledger. `financial-health.js` renders a compact Home button and a
full-page native modal with one primary scroll container and factor disclosures.
It does not call application `render()`
(which saves), `cSum()` (which can generate/save statements), or financial sheets.
Home mounting observes replacement of `#app` children without wrapping/reordering
the existing render chain. Opening details refreshes from current local data.

No records, preferences, score history, baseline, outbox or cloud state are
written. No score configuration or emergency-goal selector is persisted.

## Period and data coverage

Activity uses the **latest completed local calendar month**. This avoids giving a
high cash-flow/budget score simply because the current month has just begun.
Balances, goal allocations, IOUs and the next-30-day window are **current as of
today**, not reconstructed month-end values. The UI labels both periods.

Each factor has a fixed base weight, availability state, metric, 0–100 factor
score, earned base points, explanation and rule. Missing/unsafe/not-applicable
data is **Not Enough Data**, never an automatic zero or full score.

Data coverage is the sum of available base weights (out of 100), **not** an
estimate of how complete someone's ledger is, and not an AI confidence value.
A numeric Cap Score requires ALL of:

1. At least **60%** available weight.
2. At least **three** available factors.
3. Available Savings / Cash Flow: positive posted income and positive posted
   expenses, with transaction dates spanning at least **14 inclusive calendar
   days** inside the completed month.

Otherwise the UI says **Building Your Cap Score**. Available factor measurements
remain inspectable. Budget Performance is unavailable until the model can prove
historical applicability: current limits are not historical budget truth.
Coverage is therefore currently capped at **80%**. The minimum rules themselves
are unchanged; given the remaining weights, meeting 60% currently needs at least
four available factors.

## Exact six factors and curves

All curves are continuous, piecewise linear and clamped at their endpoints.
Money uses safe integer cents. Ratios use basis points (100 = 1%). BigInt integer
division rounds to nearest, with exact halves away from zero. Factor scores use
0–10,000 basis points (0–100.00 displayed points). Unsafe inputs/totals exclude
the affected factor rather than yielding NaN, Infinity or invented precision.

| Factor | Weight | Metric → 0–100 factor score |
|---|---:|---|
| Savings / Cash Flow | 20 | `(posted income − posted expenses) / income`. −20% or below → 0; 0% → 50; +20% or above → 100. Linear between. |
| Budget Performance | 20 | **Not Enough Historical Budget Data**. No effective period or historical limits exist in the current model. Weight excluded. The original overrun curve remains reserved in the engine but is not applied to today's limits. |
| Credit Utilization | 20 | `sum(max(0, current credit balance))/sum(credit limits)`. 0–30% → 100; linear decline to 0 at 100%; above 100% → 0. |
| Upcoming Obligations | 15 | `available liquid cash / reliably identified dues`. 0× → 0; 1× → 50; 2× or above → 100. |
| Debt vs Available Cash | 15 | `outstanding outgoing IOUs / available liquid cash`. 0% → 100; 100% → 50; 200% or above → 0. Positive IOUs with zero cash → 0; zero/zero unavailable. |
| Emergency Fund Progress | 10 | `backed goal saved allocation / goal target × 100`, bounded 0–100. |

### Overall score

Let `w` be a factor's base weight and `s` its score basis points.

`Cap Score = round(sum(s × w) / (sum(available w) × 100))`

Equivalently, earned base points divided by available base weight, normalized to
100. Example: 48 earned base points from 60 available weight → 80/100, not 48.
Unavailable weights do not enter either numerator or denominator. Contributions
are shown as **base points / base weight**, separately from metrics/percentages.
Only the final overall value is rounded to a whole point; display rounding of
individual contributions is not used to calculate it.

Labels: **80–100 Strong**, **60–79 Good**, **40–59 Fair**, **0–39 Needs Attention**.

## Model-specific rules

### Posted cash flow and budgets

Search's authoritative projection excludes pending, future, opening and
transfer-linked transaction representations; totals come from its aggregate.
Transfers/card repayments are not income/expenses. Recurring definitions,
unpaid schedules and statement principal are not posted spending.

Budgets are Cap's current `S.budgets[category]` monthly limits. Inspection of
`cards.js` budget editing, local normalization, JSON/export mappings and cloud
budget projection confirms category plus amount only: no effective month, start
date, period identity or historical snapshot establishes applicability to a
completed month. Thus **Not Enough Historical Budget Data** always excludes the
20-point budget weight in the current model. No current-budget descriptive
calculation is mixed into Health. Changing today's limits cannot rewrite any
completed-period result. Unknown ad hoc metadata is not accepted as a new schema.
No history, schema, migration or sync protocol is created to enable this factor.

### Credit and liquid cash

Positive credit `bal` is owed; negative/prepaid balances mean zero used and are
not liquid cash. Every tracked credit card needs a valid positive `lim` and
valid balance; a missing limit does not silently remove that liability.

Liquid cash is the sum of authoritative debit/e-wallet balances minus **all**
linked goal saved allocations, floored at zero. Goal money is already in those
accounts and is never added as another balance. Negative cash balances offset
positive ones. Missing balances, invalid allocations or allocations exceeding a
linked balance make cash-based factors unavailable instead of fabricating funds.

### Upcoming obligations

Window: today through **today + 29 local days**, inclusive, plus the one oldest
overdue occurrence identified by the existing next-due utility per bill. No
unrecorded historical arrears are invented.

- Liquid-account bills/subscriptions: all unpaid schedule occurrences in that
  window using Search's recurrence rules and existing paid marks.
- Trial: no charge before the recorded first billing date; its supported first
  charge is a future obligation only. Cancelled/expired schedules are excluded.
- Credit-funded schedules: excluded from immediate liquid-cash dues, rather
  than counting them again alongside card principal.
- Cards: latest stored closed statement per card only; linked repayments use
  Search's projection. Older rolling balances are **not** added again. Principal
  is capped by current positive owed balance. Missing/ambiguous snapshots or
  due dates on an outstanding card make the factor unavailable. Unbilled charges
  and unbooked interest/fees are not estimated.
- Dated outgoing IOUs: actual remaining `amt` due in/overdue before the window's
  end. Incoming receivables are not cash or obligations.
- Each bill/date, card and IOU identity is counted once. Unknown schedules,
  payment accounts or possible IOU/card duplicates fail closed. No positive
  reliably identified dues means unavailable, not automatic full points.

This is coverage of **identified recorded dues**, not a promise that every future
liability is known or that future income will arrive.

### Debt and emergency funds

`S.debts` uses `dir:'out'` for “I owe” and remaining `amt` after repayments.
Only these IOUs enter this ratio; credit liabilities are scored separately under
utilization, not added again. No outgoing records is insufficient data, not
proof of zero debt. If an outgoing IOU's lender name matches a tracked credit
name/nickname/bank, the model lacks a reliable relationship field: affected debt
and obligation scoring is withheld rather than guessed/double-counted.

Emergency Fund requires exactly one goal whose normalized name is exactly
**Emergency Fund**, a positive target, a nonnegative saved allocation and a real
linked debit/e-wallet account. All goal allocations on that account must be
backed by its balance. An unlinked/demo goal is not treated as extra cash.
No goal is renamed or automatically reinterpreted. Duplicate names, missing
links or inconsistent backing make the factor unavailable.

## Changes and history

The previous completed month's cash-flow factor can be derived from posted
history with the same income/expense/span rule. The UI shows its actual savings
rate and **factor-point change**, explicitly **not an overall Cap Score delta**.

There are no historical snapshots for account cash/limits, budget configuration,
IOUs or goal allocations. Those factor deltas and an overall prior score are
therefore not invented. Without comparable cash-flow history, the UI shows a
neutral first-score state. No history is persisted and no cloud schema is added.

## Limitations and verification

Only tracked data is analyzed. Account/IOU/goal completeness is not provable.
No forecasts of income, estimated card fees, unbilled principal schedules,
advice, notifications, PDFs or professional-risk claims are added.

Pure tests cover weights, curves, periods, missing data, normalization, model
semantics, overflow and immutability. Browser tests cover Home/details,
disclosures, focus, themes/layout, offline calculation, storage/baseline/outbox
immutability and no external requests. Existing targeted regressions protect
Search, Smart Log, Command Bar and cloud/accounting boundaries. The separate
deferred Phase 2 extended certification campaign remains pending.

## Premium redesign and Bluish White appearance

The user-supplied Claude prototype and target screenshots are visual references,
not an embedded demo or alternate financial implementation. Adapted concepts:
1120px centered page, radial cool illumination, spacious translucent hero, faint
decorative rings, 260-degree partial arc with endpoint, status pill, large score,
two-column factor grid and single-column phone layout. There is no iframe, preview
slider, score editing, suggestion count, fabricated advice or financial-plan CTA.
“Explore your factors” only scrolls/focuses the factor heading.

The second user-supplied compact summary concept is adapted into the native Home
button: 70px ring (59px on phones), stronger Cap Score/status hierarchy, actual
factor-count/coverage metadata, static blue dot, quiet shine and “View details”
label on wider screens. Its demonstration scores, invented coverage, alternate
labels and continuously pulsing dot are not used. Enter/Space activate the real
Health dialog; all effects obey Cap and device reduced-motion preferences.
The page header uses the user's final wording: **FINANCIAL HEALTH** above
**Your Cap Score**; the wider composition remains distinct from the old modal.

The engine result is calculated once per open. SVG geometry is derived once from
that result. CSS animates the arc entrance and number opacity/transform without
changing the score, rerunning calculations or using a continuous drawing loop.
Main card factor scores are rounded for presentation; precise scores, real raw
metrics, weights, formulas and periods remain in each expanded disclosure.
Historical comparisons remain cash-flow-factor-only, not overall score changes.
Dates are presented with local human-readable formatting.

The full-page native dialog retains accessible naming, focus containment,
Escape/close and focus restoration. One `.fh-body` scrolls header, hero, factors
and explanations together. At 700px and below, hero and cards become single
column; larger layouts use two columns. No large live blur layers are added.
Reduced-motion media and existing Cap motion preferences suppress all motion.
Score-band warmth is limited to small status accents, not the page background.

**Bluish White** is a fifth, always-bright theme, separate from Apple Theme.
It uses the existing `cap-appearance-theme` localStorage key and shared tokens;
it never writes `S.theme`, financial state or cloud preferences. Auto and Apple
still follow the device; Dark and Light retain their explicit behavior.

Core palette:
- Background `#F5F8FC`; white primary surfaces `#FFFFFF`.
- Primary text `#172033`; secondary text `#657287` (slightly darker than the
  reference's `#7D8798` for small-text legibility).
- Accent `#3977F6`; strong/link blue `#2861D2`; pale selection `#E9F0FF`.
- Dividers `#E2E9F3`; navigation white at 92% opacity with no material blur.
- Health surfaces white at 72% opacity; subtle shadow `#3044690C`.
- Success `#23764E`; muted coral `#B44E4D`; warm amber `#95651F`.

Dark adapts the same composition to existing dark tokens with blue `#79A4FF`.
Apple uses its own popup surface/primary palette and keeps its existing material
behavior elsewhere. Bluish White remains bright even with a dark OS preference.
Shared tokens cover Home, Settings, navigation, common popups, Command Bar,
Smart Log, Search and Health without changing their behavioral implementations.

The worker needs a new shell key even though assets were already cached:
installed clients would otherwise keep v365 responses. This revision bumps once
to **cap-shell-v366**; navigation/cache strategy and dependency order are unchanged.

## Combined checkpoint: Home logo presentation

The user's intentional `home-bill-list` classes scope the existing bare-logo
treatment to Home's **Needs attention** and **Coming up** lists. The icon cell
keeps its 44px alignment footprint but no longer paints a background, border,
rounded tile or shadow. Image corners are not clipped; local branding, uploaded
transparent images, card artwork and fallback glyphs retain their existing sizes.
Bill row markup, handlers, amount/status/date calculations and payment behavior
are otherwise unchanged. Both lists share the original Plan Upcoming treatment.

The user-approved final shell is **cap-shell-v367**, retaining the single further
cache invalidation for this Home styling change. No additional bump is made.
