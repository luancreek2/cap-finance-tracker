# Production Sync Plan (proposal)

Status: **not started**. Cloud Sync remains OFF until every item below is done.

Decisions already made:

- **Balance model:** derive balances from transactions (single source of truth).
- **Conflict policy:** prompt per conflict, keep local or keep cloud.
- **Deletions:** tombstone on delete, purge only after both sides agree (see below).

## 1. Balance derivation (highest risk)

Today `bal` is a stored number mutated by `bApply` and by transfers, card
payments, fees, interest, deposits, goal moves, and CSV import
(`js/transactions.js`, `js/cards.js`, `js/app.js`, `js/calendar-popup.js`).
Any missed path drifts permanently.

Phased migration:

1. **Add a pure deriver.** `derivedBalance(accountId)` computes
   `anchor + posted transactions + transfers`, using the same sign rules as
   `bApply` (`credit` accounts invert the sign). Pending transactions are
   excluded until posted.
2. **Anchor.** Account creation writes an `opening_balance` anchor (migration:
   `anchor = current stored balance - sum(existing effects)`). This preserves
   current values exactly; drift is not corrected silently.
3. **Report-only check.** Compare stored vs derived for every account and show
   the difference in a read-only diagnostic. No behaviour change.
4. **Fix drift sources.** Any account where stored != derived is investigated
   against statement history before anything is rewritten.
5. **Flip reads.** UI reads derived values; the stored value becomes a cache
   refreshed after each mutation, then is dropped once stable.

Covered by tests: posting a pending transaction, deleting a transaction,
editing an amount, card payment, account transfer, goal move, deposit, interest
credit, cash-advance/foreign fee, CSV import adjustment.

**Verified 2026-10-20** on disposable origins across 19 write paths (add/edit/
delete transaction, internal and external deposit, card payment and its
deletion, pending then posted, goal move, cash-advance fee, interest credit,
simulated interest, CSV import, JSON merge). Two defects were found and fixed:
`postOk` re-applied the effect already applied at save, and CSV/JSON imports
inserted pending credit rows without applying them, so such rows never reached
the balance.

Known divergence: CSV import with "Apply imported rows to account balances"
unchecked records transactions without moving balances. Derived balances cannot
represent that state, so the option must be removed or redefined before reads
are flipped.

**Shadow mode (dev-only, 2026-10-20):** anchors are captured on demand and stored
in `localStorage` under `cap_balance_anchors_v1`, outside `S`, so they are never
synced or exported. `balanceShadowReport()` compares stored against
anchor + effects and lists drift. Verified: five mutations (income, transfer,
card payment, pending then posted) kept drift at 0; an injected +75 was detected
as one drifting account; the capture guard refused to overwrite existing anchors;
anchors and drift survived a reload. Production still needs anchors inside the
synced account record, with an explicit field and mapping.

## 2. Outbox and push/pull worker

- Enqueue per changed record: `{entity, localId, op, payloadFingerprint, ts}`.
- Process sequentially; group dependent writes atomically on the server
  (transaction + account delta today; derived balances should remove the need
  for a dependent account write entirely).
- Idempotency: stable `legacy_id` + full-payload comparison; retries must be
  safe (`ALREADY_APPLIED` semantics).
- Backoff with a cap; surface a per-record error state instead of retrying
  forever.
- No processing unless the user has enabled sync.

## 3. Conflict handling

- Three-way compare against the baseline (already implemented).
- Divergence opens a resolution prompt with the differing fields only,
  keep local / keep cloud.
- Resolutions are recorded so the same conflict is not re-prompted.

## 4. Deletions

- Local delete: write a tombstone (`deleted_at`) locally, push it.
- Cloud delete: tombstone in cloud; the other device observes it.
- Purge only when both sides agree and the tombstone is older than a retention
  window. Never infer deletion from a failed read.

## 5. Server side

- Replace `cap_test_transaction_create` with production RPCs (SECURITY INVOKER,
  ownership checks, advisory locks on the record UUID).
- Review RLS per table with an explicit matrix (select/insert/update/delete,
  own rows only). Verify no table is readable across users.
- Retire test objects once the harness is no longer needed
  (`supabase_phase6k7_remove_test_rpcs.sql`).

## 6. Enablement and rollout

- Explicit user toggle, default OFF, with a clear description.
- First enable runs a dry run and requires zero differences before pushing.
- Background sync via the existing service worker sync event.
- Kill switch: disabling sync stops the worker without touching data.
- Back up (JSON export) before the first real sync.

## 7. Testing

- Reuse the controlled harness against the production code path in dry-run mode.
- Multi-device test: two browsers, same account, one record each direction.
- Failure drills: offline mid-push, RLS denial, expired token, conflict, delete.
- Offline shell and light/dark checks after each shell change.

## Open items

- Statement history semantics under derived balances (opening/closing values
  are currently stored, not computed).
- Credit-account "owed" display vs. derived sign convention.
- Retention window for tombstones.
- Whether `accounts.balance` is dropped or kept as a cache long term.
