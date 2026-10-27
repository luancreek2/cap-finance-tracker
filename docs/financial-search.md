# Advanced Financial Search

Search is a local, deterministic, read-only layer. It does not use a language
model, remote search, analytics, or a per-query cloud request.

## Boundary

- `financial-search-parser.js`: pure text → explainable query plan. Uses the
  existing Smart Log account resolver, money/date helpers and merchant catalog.
- `financial-search-engine.js`: detached projection of local `S`, filters,
  integer-cent aggregates and result models. No DOM, storage or writes.
- `financial-search.js` / `financial-search.css`: read-only presentation. Uses
  `CapCommandBar.dismissKeyboard()` and placement events; never positions a
  second keyboard-following bar and never calls the application's `render()`.

There is one fresh projection per explicit submission, not per keystroke. This
avoids stale indexes when local sync or forms change records in place. Result
rows render in batches of 40. Queries/results/drafts are not persisted.

## Money and records

- Posted transaction searches read `S.tx`, excluding opening records, future
  dates, pending IDs, duplicates and IDs represented by linked transfers.
- `pending` is explicit; these results do not enter posted expense/income/net
  aggregates. Positive/negative transaction amounts retain Cap's sign model.
- Account/goal transfers and card repayments read `S.xfer` separately. Linked
  payment IDs are deduplicated. They are never expense or income.
- Bill payments use actual posted transactions with `billId`, or Cap's existing
  legacy Bills/name/paidOn proximity match. Each transaction appears once.
- Subscription/bill/trial searches inspect definitions in `S.bills`. Dates mean
  the **next due/renewal event**, not every occurrence in a period. Schedules do
  not create spending. Subscription spending queries use actual bill-linked
  transaction history, not advertised recurring prices.
- Monthly equivalents use the existing weekly/biweekly/monthly/quarterly/yearly
  recurrence vocabulary and are explicitly approximate. Trials and one-time
  schedules are excluded.
- Statement searches use **stored closed snapshots** from account
  `statementHistory`. They never call `cSum()` (which may create snapshots and
  save). Explicitly linked repayments can reduce recorded principal. Legacy
  unlinked repayments or credits with uncertain allocation return clarification.
  Unbooked interest/fee estimates are not recomputed. Missing snapshots are not
  invented, and statement principal is never added to spending.
- Goals/debts are not separate query sources in this phase. Goal-transfer events
  can appear as transfers, without inferring income or expenses from definitions.

## Grammar and limitations

Relative periods use local calendar arithmetic. Weeks are Monday–Sunday and chips
say so. A month without a year uses the current local year. Supported explicit
dates are ISO `YYYY-MM-DD` or English `Month D[, YYYY]`; explicit ranges use
`from … to/through …` or `between … and …`.

Money comparisons support over/above/greater than, under/below/less than, at
least/most and inclusive between. Use one comparison/range per query. Currency
notation is the existing PHP grammar (`₱`, `P`, `PHP`, commas, cents, `k`).

Exact account names/aliases and unique partial account matches can resolve;
ambiguous names require a more specific query. Categories must exist locally.
Merchant identity uses the shared catalog, then existing local record titles.
Unknown residual words, conflicting filters and unsafe calculations fail closed.
No confidence percentages or AI fallback exist.

Result rows intentionally have no financial actions. There is no Financial
Health score, recommendations, budget advice or chart dashboard in this phase.

The existing optional microphone remains browser speech-to-text, with its
existing browser-service disclosure. Search adds no transcription service and
does not send the resulting financial query to any search/AI service.

## Validation scope

`tests/financial-search.cjs` covers pure plans, filters, aggregates, money and
record semantics. `tests/financial-search-browser.cjs` covers isolated browser
integration, storage/sync immutability, offline queries, responsive themes and
synthetic Visual Viewport sequences. Synthetic viewport tests do **not** certify
native OS keyboard behavior. The deferred Phase 2 extended Calendar/full-suite
campaign remains separate from Phase 3 targeted validation.
