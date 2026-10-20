# Atomic notes RPC: manual setup

Status (2026-10-20): installed manually by the user; the authenticated app's
live metadata verification passed. No live write-RPC test has been run.
Cloud Sync and production execution remain OFF/locked throughout this step.

## What to do

1. Open the SQL Editor for this app's Supabase **demo/test project**.
2. Review and run the entire `supabase_production_notes_rpc.sql` file.
   It defines two functions and their permissions in one transaction. It does
   not reset, seed, upload, update, or delete any app records.
3. Reply “SQL installed”. The next check is read-only metadata verification.
   Do not call `cap_sync_note_put` to test readiness.

Optional UI check after installation: refresh the app to pick up shell v298
(two reloads may be needed), then Privacy & Sync → developer tools →
**Plan Outbox (read-only)** → **Check atomic notes RPC (read-only)**.
This calls only `cap_verify_notes_rpc`. It may require signing in again.

If verification blocks, stop and inspect the schema/policies/permissions.
Do not weaken the verifier or add permissive policies to make it pass.
Equivalent custom policies intentionally require review. Metadata success
does **not** enable writes or prove multi-device production readiness.

## Scope

- `cap_sync_note_put(uuid,jsonb,jsonb)` uses SECURITY INVOKER and authenticated
  ownership from `auth.uid()`. It cannot take a user ID or table name as input.
- Both content snapshots must have exactly `legacy_id`, `title`, `body`,
  `note_date`. Expected SQL NULL means proven absence, not a failed query.
- A matching desired row is ALREADY_APPLIED. Otherwise, existing content must
  equal the expected snapshot under a row lock before updating. Missing rows
  cannot be recreated by stale updates. Insert collisions never overwrite.
- A failed content read-back raises an exception and rolls the write back.
- It returns statuses only, not user IDs or note contents. No financial tables
  or account balances are touched. Deletes are not supported in this pilot.
- `cap_verify_notes_rpc()` inspects only metadata: signature, invoker/security
  settings, version, execution ACLs, notes RLS, the known ownership policy,
  table grants, and whether the authenticated role can bypass RLS. It never
  calls the write function or selects app rows.
- General production transport remains locked. A narrow, explicitly confirmed
  two-update demo test is available in `NOTES_CONTROLLED_TEST.md`, but has not
  been run against user Supabase data. The pipeline and atomic local
  acknowledgement are rehearsed; applying conflict-review choices is pending.

## Verification performed locally

- `node tests/sync-outbox.cjs`: 49 checks.
- `node tests/notes-rpc-readiness.cjs`: 25 checks; no mutation RPC invocation.
- `tests/notes-rpc-sql.cjs`: 41 checks in isolated PostgreSQL WASM (PGlite),
  including real PL/pgSQL execution, RLS, stale edits, retries, unsafe ACLs and
  policies, and trigger-modified writes rolling back. No Supabase connection.
  This optional test needs an external PGlite installation; set
  `CAP_PGLITE_PATH` to that module directory, then run the script with Node.
- Readiness-button success/blocked states checked in light/dark themes on a
  disposable browser origin with simulated metadata responses.

Still required before production: two-session
PostgreSQL race tests (including direct table writers), client CAS transport,
verified read-back and per-operation baseline reconciliation, explicit apply
confirmation, and the full RLS/rollout review. None is implied by these tests.
