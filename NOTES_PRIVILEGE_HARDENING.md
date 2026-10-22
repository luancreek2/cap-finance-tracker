# Notes privilege hardening (prepared, not executed)

Status: **prepared and isolated-test validated only**. No production SQL, DDL,
grant/revoke, RPC call, backup/restore, migration, backfill, cutover, or cloud
write was performed. Cloud Sync remains **OFF**. This document is not an
authorization to deploy.

## 1. Why there are three scripts

The requested findings split into three different risk/authority classes:

| Script | When it may run | What it is |
| --- | --- | --- |
| `supabase_notes_privilege_hardening.sql` | After backup verification and approval, before sidecar work | Safe app-level hardening that keeps the current notes SELECT/INSERT/UPDATE path usable. |
| `supabase_notes_platform_default_acl.sql` | With a superuser/platform-admin session | Fixes the `supabase_admin`-owned default ACLs. The normal `postgres` SQL Editor role cannot alter them. |
| `supabase_notes_legacy_lockout.sql` | **Only in the approved cutover window** | Server-side old-client lockout: removes direct notes access, drops `own_rows`, and drops the legacy/test RPCs. It intentionally makes the old notes path fail closed. |

The lockout script is prepared and tested but **must not run as pre-migration
hardening**. Dropping the legacy notes RPCs or revoking direct notes access is a
cutover, not a safe pre-migration change.

All three scripts are transaction-wrapped and require an explicit session guard.
If the guard is missing, they abort before changing anything.

## 2. Backup/restore verification gate

Do this before running any of the scripts.

1. **Stop writes for the check.** Keep Cloud Sync OFF, finish/abort manual notes
   operations, confirm no outbox work, and avoid other privileged writers.
2. **Find the provider backup.** Open the Supabase Dashboard and look for
   `Project Settings -> Database -> Backups` (some dashboard versions expose it
   as `Database -> Backups`). Confirm:
   - scheduled backup/daily backup availability and retention;
   - Point-in-Time Recovery (PITR) availability, if your plan has it;
   - the latest restorable timestamp is **after** the last known note/financial
     write and before any hardening DDL;
   - a restore action is actually available (for example, restore to a new
     project or branch), not merely a backup listed.
3. **If there is no provider backup/PITR**, stop. Take a logical dump with the
   Supabase CLI or `pg_dump`, keep it private, and restore it into a disposable
   PostgreSQL/Supabase target. A dump file that has never been restored is not a
   verified restore point.
4. **Capture a private aggregate manifest.** Counts only; do not export note
   content, financial values, user IDs, or record UUIDs. Run in a reviewed
   read-only session:

   ```sql
   select 'profiles' as table_name, count(*) as row_count from public.profiles
   union all select 'user_preferences', count(*) from public.user_preferences
   union all select 'categories', count(*) from public.categories
   union all select 'accounts', count(*) from public.accounts
   union all select 'goals', count(*) from public.goals
   union all select 'debts', count(*) from public.debts
   union all select 'bills', count(*) from public.bills
   union all select 'account_statements', count(*) from public.account_statements
   union all select 'transactions', count(*) from public.transactions
   union all select 'transfers', count(*) from public.transfers
   union all select 'bill_payments', count(*) from public.bill_payments
   union all select 'budgets', count(*) from public.budgets
   union all select 'notes', count(*) from public.notes
   order by table_name;

   select count(*) as notes_count, max(updated_at) as latest_note_update
   from public.notes;
   ```

5. **Prove the restore.** Preferred: use the provider's restore-to-new-project
   or branch feature at the chosen backup/PITR timestamp. Do not restore over
   production. If the provider cannot do that, restore a logical dump into a
   disposable local PostgreSQL target. Keep credentials and the dump private.
6. **Compare.** Every restored table count must match the manifest. Inspect the
   restored `public.notes` table, policy, grants, and functions via catalogs.
   Record the backup/PITR timestamp, restore target, and result privately.
7. **Rollback evidence.** Keep the verified backup/PITR point, the manifest, and
   a private schema/function/grant snapshot. If post-hardening verification
   fails, restore the point or reverse the saved grants/functions. A provider
   restore rolls back all data after the point; do not let writes occur during
   the window.

**Gate:** do not run any hardening script until a restore has actually been
tested and the aggregate counts match. A listed backup alone is not sufficient.

## 3. Script 1 — app-level pre-migration hardening

File: `supabase_notes_privilege_hardening.sql`

Guard: `cap.hardening_approved = 'privilege-hardening-only'`.

This script intentionally preserves the current notes app path:

- keeps `SELECT`, `INSERT`, and `UPDATE` on `public.notes` for `authenticated`;
- keeps the `own_rows` policy;
- keeps `cap_sync_note_put` and `cap_verify_notes_rpc`;
- does not create/backfill the sidecar or change note rows.

It makes these changes:

1. `REVOKE ALL ON public.notes FROM anon, PUBLIC`, including column-level
   revokes.
2. `REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.notes FROM
   authenticated`; column-level `REFERENCES` is also revoked. The app does not
   delete notes, so this does not remove the current read/edit path.
3. `ALTER TABLE public.notes FORCE ROW LEVEL SECURITY`.
4. Revokes `EXECUTE` on `public.rls_auto_enable()` and
   `public.set_updated_at()` from `PUBLIC`, `anon`, and `authenticated`.
   Existing triggers continue to work because trigger execution does not require
   the invoking client to hold `EXECUTE` on the trigger function.
5. Drops `public.cap_test_transaction_create(...)` and
   `public.cap_verify_transaction_rpc()`. This removes no rows.
6. Revokes future `postgres`-owned default ACLs in `public` for tables,
   sequences, functions, and types from `anon`, `authenticated`, and `PUBLIC`.
7. Emits a review notice if `supabase_admin`-owned default ACLs are present.

Expected audit effect: clears anon/PUBLIC note access, authenticated
DELETE/TRUNCATE, force-RLS, PUBLIC/anon definer execute, and test-RPC findings.
It intentionally leaves `NOTES_AUTH_INSERT_UPDATE`, `NOTES_DESTRUCTIVE_POLICY`,
both legacy-RPC findings, and platform role/default-ACL findings for the later
scripts/decisions. The old verifier should remain `ready: true` after this
script.

## 4. Script 2 — platform default ACLs

File: `supabase_notes_platform_default_acl.sql`

Guard: `cap.platform_acl_approved = 'platform-admin-review'`.

This only changes `supabase_admin` default privileges in `public` for tables,
sequences, functions, and types, revoking `anon`, `authenticated`, and `PUBLIC`.
It does not read or change rows.

**Manual blocker:** the normal Supabase SQL Editor runs as `postgres`. The live
catalog shows `postgres` is not a superuser and is not a member of
`supabase_admin`, so this script will abort with `PLATFORM_ACL_BLOCKED`. Do not
try to bypass it with `SET ROLE`. Use one of these paths:

- a SQL session actually running as `supabase_admin` or another superuser, if
  your platform access provides one; or
- a Supabase Support/platform-admin request to apply the same default-ACL
  revokes.

Until this is done, the audit can continue to report
`CLIENT_DEFAULT_PRIVILEGES` / `PUBLIC_DEFAULT_PRIVILEGES` for the
`supabase_admin`-owned defaults. Treat that as an open high finding, not as
completed hardening. Do not create new `public` objects as `supabase_admin` in
the meantime.

## 5. Script 3 — cutover lockout (not pre-migration)

File: `supabase_notes_legacy_lockout.sql`

Guard: `cap.lockout_approved = 'cutover-window-only'`.

This is the server-side old-client lockout. It:

- revokes all direct table and column privileges on `public.notes` from `anon`,
  `authenticated`, and `PUBLIC`;
- drops the `own_rows` policy;
- keeps `FORCE ROW LEVEL SECURITY`;
- drops `cap_sync_note_put(uuid,jsonb,jsonb)` and `cap_verify_notes_rpc()`;
- idempotently drops the test RPCs;
- keeps `rls_auto_enable()`/`set_updated_at()` non-executable by clients.

It does **not** create the private sidecar, backfill lifecycle rows, migrate
content, enable Cloud Sync, or change financial tables. It makes old notes clients
fail closed. Run it only with the approved sidecar/new reader cutover, not now.

For the full Phase 6L production order this script is superseded by the unified,
dependency-ordered `supabase_production_cutover.sql` (guard
`cap.production_cutover`), which backfills the notes lifecycle, removes every
`authenticated`/`anon`/`PUBLIC` table, column and policy path on all 13
synchronized tables, drops the legacy notes and test RPCs, forces RLS on the
private sidecar and ends with a fail-closed catalog postflight. It is prepared
and tested only (11 PGlite checks, 11 target/opt-in guards, 31 real PostgreSQL 17
checks). Use one or the other in the approved window, never both. See
`PHASE_6L_SNAPSHOT_READINESS.md`.

After this script the app-level notes path is intentionally unavailable until the
new reader is deployed. The audit should show `legacy_lockout_complete: true`, but
`production_notes_lifecycle_ready` remains false because the sidecar/reader is
not part of this work.

## 6. Findings intentionally left for later

- `UNEXPECTED_PRIVILEGED_ROLE` for platform roles such as
  `supabase_etl_admin` / `supabase_read_only_user`: do not drop these blindly.
  Confirm custody or explicitly accept/update the audit allowlist.
- `SERVICE_ROLE_PRESENT`: service role bypasses RLS by design. Confirm the key is
  server-only, rotated after any exposure, and never bundled in the PWA. These
  scripts do not change `service_role` table privileges.
- `UNEXPECTED_DEFINER_FUNCTION` for `rls_auto_enable()`: client execute is
  revoked, but the function is not dropped. Check `pg_event_trigger` first. If
  the platform confirms it is unused, a separate reviewed drop can be approved.
- `LIFECYCLE_COLUMNS_ABSENT`, `NOTES_TRIGGERS_PRESENT`, and direct-read/realtime
  review: these belong to the sidecar/reader work, not this hardening script.
- `NOTES_AUTH_INSERT_UPDATE`, `NOTES_DESTRUCTIVE_POLICY`, and both legacy notes
  RPC findings remain after Script 1 by design; Script 3 clears them at cutover.

## 7. Manual Dashboard/platform checklist

- [ ] Verify provider backup/PITR and **test a restore** (Section 2).
- [ ] Confirm the latest restore point is after the last write and before DDL.
- [ ] Check the SQL Editor's active role. Script 2 requires
      `supabase_admin`/superuser; the normal `postgres` session will block.
- [ ] Review API exposed schemas (`Project Settings -> API`): keep only intended
      schemas; remove unused `graphql`/`graphql_public` exposure deliberately.
- [ ] Review Auth anonymous sign-ins and providers; disable anonymous sign-in if
      the app does not use it.
- [ ] Review `service_role` key custody and rotation. It must never be in the PWA
      or browser logs.
- [ ] Check Database Webhooks, Edge Functions, and Cron for callers of
      `cap_sync_note_put`, `cap_verify_notes_rpc`,
      `cap_test_transaction_create`, or `cap_verify_transaction_rpc`. Script 1
      drops the test RPCs; Script 3 drops the legacy notes RPCs.
- [ ] Check Realtime/Replication: if `public.notes` is published, decide whether
      it is still needed before the RPC-only/lockout phases.
- [ ] Review `pg_event_trigger` for `rls_auto_enable` before any optional drop.
- [ ] Review platform privileged roles and service-role custody; do not drop
      platform roles without a separate approval.
- [ ] Keep Cloud Sync OFF and do not deploy a new client as part of this
      hardening phase.
- [ ] Re-run the read-only audit after each approved step; keep output private.
- [ ] Take/verify a new restore point after Script 1 before Script 3.

## 8. Validation performed

- `tests/notes-privilege-hardening-sql.cjs` — **14 checks**, disposable PGlite:
  guards, app-level hardening, old notes path still usable, delete/truncate/anon
  denial, force RLS, trigger behavior after execute revokes, default table ACLs,
  platform guard, audit expectations, lockout, and old-client fail-closed.
- `tests/production-privilege-audit.cjs` — 8 checks.
- `tests/notes-sidecar-sql.cjs` — 83 checks.
- `tests/notes-sidecar-rollback-sql.cjs` — 5 checks.
- `tests/notes-lifecycle-sql.cjs` — 70 checks.
- `node --check` for all `js/*.js`, `service-worker.js`, and JSON parse for
  `manifest.json`/`vercel.json`.

PGlite note: it does not model the implicit `PUBLIC EXECUTE` default for future
functions, so the functional probe for future function default ACLs must be
confirmed by the production audit/`pg_default_acl` after Script 1. Table default
ACL behavior is covered.

No production note content, financial values, user IDs, or record UUIDs were used
in diagnostics; the test data is synthetic.
