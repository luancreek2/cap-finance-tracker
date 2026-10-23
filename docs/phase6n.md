# Phase 6N — conservative cloud transaction pulls

Local implementation and synthetic testing only. No production access, commit,
push, deployment, or live two-device test is part of this change.

## Supported group and proofs

One new posted transaction (absent locally and in baseline) plus one existing
account (present locally, in baseline, and in cloud). The local account must
hash to the baseline fingerprint; its values, **not a nonexistent baseline row**,
prove the old balance. The cloud account must change only balance, by the exact
signed transaction delta. Debit/e-wallet: add signed amount. Credit: subtract
signed amount. Install the authoritative cloud balance, never replay transaction
business logic. Require deterministic numeric legacy-ID/UUID mapping, owner,
account/category relationships and simple transaction metadata.

Policy B: refuse multiple financial groups, including non-overlapping groups.
Any other changed record, queue entry, conflict, or pending recovery blocks the
financial pull. Existing Notes updates retain their separate pull behavior.
Transaction edits/deletes, pending transitions, bill-linked transactions, fees,
transfers, account-only edits and other financial entities are unsupported.

## Installation and recovery

Repeated full cloud snapshots must agree. Re-prove against a fresh local model;
the actual IndexedDB commit compares the entire persisted before-image and checks
memory/localStorage. State + advanced account fingerprint + new transaction
baseline entry + durable before-image journal are one IndexedDB transaction.
Rebuild canonical records before and after installation and verify every cloud
fingerprint. Clear the journal only after persistence and cloud re-verification.

Runtime failures roll back old state/baseline. If rollback encounters concurrent
third-value local work or another storage failure, preserve the journal and halt
with `LOCAL_PULL_RECOVERY_REQUIRED`; never overwrite concurrent work. A crash
with a pending journal likewise blocks automatic sync on reload. Automatic crash
recovery is deliberately not implemented: the retained before-image requires
reviewed recovery. IndexedDB and localStorage are not a single native transaction.

Use existing online/pageshow/visibility/service-worker messages and 15-second
visible cycle; no Realtime or increased polling. No new RPC or cloud-write path.

## Verification

`tests/cloud-pull.cjs` executes the real production planner, browser adapter,
shared Phase 6M mapper, real forward mapping and fake IndexedDB transactions.
It bootstraps the synthetic 44-record/11-transaction fixture with balances
28,449 / 3,120 / 12,600 (44,169 total), then proves convergence to 45 records.
Every mutation transport is forbidden. Failure injections include actual IDB
DataCloneError and localStorage quota failure, not only mock controller errors.

`tests/cloud-pull-shell.cjs` executes the actual worker install and offline script
cache handlers with local bytes, checks v323 and module load order, and parses
cached JavaScript. This is an isolated worker simulation, not a real-browser
offline/reload or installed-device validation.

`tests/cloud-pull-security.cjs` is a fresh scoped filename/credential-pattern and
RPC-boundary check, not a comprehensive secret-scanner or penetration audit.
Full regressions must include these persistent tests, not only the old 1,514.
