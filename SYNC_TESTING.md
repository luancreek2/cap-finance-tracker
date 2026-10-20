# Sync Test Harness

Status: **dormant**. Automatic Cloud Sync is OFF. This document covers the
controlled verification harness only; it is not a production sync guide.

## Safety invariants

- Cloud Sync stays OFF before, during, and after every test.
- No write happens without an explicit confirmation.
- The local baseline is updated only after the winning side's writes verify.
- Fail closed: missing baseline, unverified RPC, changed candidates, unknown
  outcome, or unexpected diff aborts the operation.
- Diagnostics never print financial amounts or the user UUID.
- A query/RLS/network failure is never treated as record absence.

## Setup

1. Serve over HTTP: `npx --yes serve . -l 8000`.
2. Create `supabase-config.js` from `.env.example` (ignored by git; generate it
   per deployment).
3. Apply the SQL files in this order:
   - `supabase_schema.sql`
   - `supabase_permissions_patch.sql`
   - `supabase_phase6k2_transaction_rpc.sql`
   - `supabase_phase6k3_rpc_verifier.sql`
4. Open `http://localhost:8000/` and sign in.

## Developer tools

Phase 6 test buttons are hidden by default.

- Enable: `http://localhost:8000/?dev=1` (persists in `localStorage` as
  `cap_dev_tools=1`)
- Disable: `http://localhost:8000/?dev=0`

When enabled, a "Developer test tools" section appears in **Privacy & Sync**.

## Test order

| Phase | Action | Proves |
|---|---|---|
| 6D–6J | diagnose / dry run | classification, mapping, ownership, deletes |
| 6K.4 | Audit Controlled Write | RPC metadata, guards, candidate set |
| 6K.5 | Test Controlled Write | notes UPDATE + atomic transaction/account RPC |
| 6K.6 | Reconcile Controlled Baseline | baseline updated only after convergence |
| 6K.7 | Test Controlled Retry | identical notes PATCH + RPC returns `ALREADY_APPLIED` |
| 6J | Test Single Record Push/Pull, conflicts, deletes | per-record behaviours |

Run in that order. Each step re-validates from scratch.

## Failure markers

- `CLOUD WRITE OCCURRED — VERIFICATION FAILED`
- `LOCAL WRITE OCCURRED — VERIFICATION FAILED`
- `DATA CONVERGED — BASELINE UPDATE FAILED`
- `DELETE VERIFIED — BASELINE CLEANUP FAILED`
- `BLOCKED — RECORD ABSENCE NOT PROVEN`
- `CANDIDATES CHANGED DURING CONFIRMATION — ABORTED`

Treat every marker as a stop condition. Do not retry blindly; inspect the
reported stage and state first.

## Expected clean state

- Baseline: version 2, owned by the authenticated user, one record per
  plan row (`44` with the current data set).
- Dry run: `Would push 0`, `Would pull 0`, deletes/conflicts/blocked `0`,
  `Blocking reason: none (fully synchronized)`.
- Cloud Sync: OFF, pending outbox `0`.

## Retiring the harness

When the tests are no longer needed, run
`supabase_phase6k7_remove_test_rpcs.sql`. It drops the test RPC and verifier.
Afterwards `rpcReady()` is false and the controlled-write audit fails closed.

## Verification checklist after shell changes

- Online load, then offline reload in DevTools: app boots from cache.
- Light and dark themes: Privacy & Sync buttons legible, no overlap.
- `node --check` all `js/*.js`, plus `service-worker.js`.
- Bump `VERSION` in `service-worker.js` whenever a shell file changes.
