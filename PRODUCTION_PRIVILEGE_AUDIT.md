# Production privilege, role, and endpoint audit

Status: **static design audit only**. No live Supabase connection, SQL execution,
migration, grant change, RPC call, backup/restore, or cloud write was performed.
Cloud Sync remains **OFF**. This document does not authorize deployment.

## 1. Scope and evidence

Reviewed repository files:

- `supabase_schema.sql`
- `supabase_permissions_patch.sql`
- `supabase_production_notes_rpc.sql`
- `supabase_phase6k2_transaction_rpc.sql`
- `supabase_phase6k3_rpc_verifier.sql`
- `supabase_phase6k7_remove_test_rpcs.sql`
- `js/notes-manual.js`, `js/sync.js`, `js/supabase.js`
- `tests/sql/notes-lifecycle-lab.sql` (isolated target model, not deployed)

The live notes metadata verifier previously returned `ready: true` on
2026-10-20. That corroborates the deployed notes table, RLS policy, grants, and
the two notes RPCs at that time. It does **not** attest default privileges,
inherited role memberships, other `SECURITY DEFINER` endpoints, PostgREST
exposure, service-role key custody, triggers, extensions, or runtime behaviour.

The read-only catalog audit is `tests/sql/production-privilege-audit.sql`. It
opens `BEGIN TRANSACTION READ ONLY`, reads catalogs only, returns one JSON
document, and never selects note rows or content. `tests/production-privilege-audit.cjs`
runs it against a disposable PGlite copy of the deployed notes contract.

## 2. Current repository-derived posture

### Notes table

`public.notes` has `id`, `user_id`, `legacy_id`, `title`, `body`, `note_date`,
`created_at`, `updated_at`; a unique `(user_id, id)` constraint; RLS enabled;
one permissive `FOR ALL` policy for `authenticated` with
`user_id = auth.uid()`; and direct `SELECT, INSERT, UPDATE, DELETE` grants to
`authenticated`. `anon` and `PUBLIC` are revoked in the repository scripts.

The table owner is whichever privileged role ran the schema script (normally
`postgres`). The owner bypasses RLS unless `FORCE ROW LEVEL SECURITY` is set.
`service_role` also bypasses RLS by design.

### Notes endpoints

- `cap_sync_note_put(uuid,jsonb,jsonb)` — `SECURITY INVOKER`,
  `search_path=pg_catalog`, `EXECUTE` to `authenticated`, execute revoked from
  `PUBLIC`/`anon`. It compares and writes only `legacy_id`, `title`, `body`,
  `note_date`; it has no revision, deletion, or lifecycle CAS.
- `cap_verify_notes_rpc()` — `SECURITY DEFINER`, `search_path=pg_catalog`,
  metadata only, `EXECUTE` to `authenticated`. It asserts the **old** notes
  contract: direct `INSERT`/`UPDATE` grants, the single `FOR ALL` policy, and
  the legacy writer signature/version.
- Optional test endpoints: `cap_test_transaction_create(...)` and
  `cap_verify_transaction_rpc()`. They are not part of notes, but they widen the
  write surface and must be confirmed removed or retained deliberately.

### Client assumptions

- Notes pull reads `/rest/v1/notes?select=*&user_id=eq...&id=eq...`.
- Notes push calls `/rest/v1/rpc/cap_sync_note_put`.
- Readiness calls `/rest/v1/rpc/cap_verify_notes_rpc`.
- `canonical()` excludes only `id`, `user_id`, `legacy_id`, `created_at`,
  `updated_at`, `metadata`, `local_updated_at`, `cloud_updated_at`, and
  `contentFingerprint`. Any new column returned by `select=*` changes the
  content fingerprint unless it is projected out or excluded.

## 3. Findings

### Critical

| Code | Finding | Why it blocks lifecycle work |
| --- | --- | --- |
| `NOTES_AUTH_DELETE` | `authenticated` can directly `DELETE` note rows. | A tombstone can never be authoritative while a client can physically remove the row. A cached old client retains this capability. |
| `NOTES_AUTH_INSERT_UPDATE` | `authenticated` can directly `INSERT`/`UPDATE` note rows. | Bypasses lifecycle CAS, revision checks, operation receipts, and tombstone retention. |
| `NOTES_AUTH_COLUMN_WRITE_GRANT` | A column-level `UPDATE(body)`-style grant can reopen writes after a table-level revoke. | Table-level `REVOKE` alone is not proof of lockout. Column ACLs must be audited and revoked. |
| `NOTES_ANON_PUBLIC_COLUMN_GRANT` / `NOTES_ANON_ANY` / `NOTES_PUBLIC_ANY` | Any anonymous or `PUBLIC` note privilege. | Anonymous content access or mutation is unacceptable; `PUBLIC` execute/table defaults are a recurring PostgreSQL trap. |
| `DEFINER_PUBLIC_EXECUTE` / `DEFINER_ANON_EXECUTE` | A `SECURITY DEFINER` endpoint executable by `PUBLIC` or `anon`. | Definer rights can bypass RLS. Every definer function needs an explicit allowlist and revokes. |
| `CLIENT_OWNS_CAP_OBJECT` | `anon`/`authenticated` owns a Cap table or function. | Ownership defeats RLS and grants. |
| `CLIENT_ROLE_ELEVATED` / `CLIENT_ELEVATED_MEMBERSHIP` | A client role has `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, or membership in an administrative/`cap_*` role. | A client role must never inherit a privileged path. |
| `LAB_SCHEMA_INSTALLED` | `cap_notes_lab` exists in production. | The lab is disposable test machinery, not a deployment target. |

### High

| Code | Finding | Required decision |
| --- | --- | --- |
| `NOTES_FORCE_RLS_DISABLED` | Notes RLS is enabled but not forced. | The lifecycle writer must be a non-owner and the lifecycle tables must use `FORCE ROW LEVEL SECURITY`. |
| `NOTES_POLICY_DRIFT` / `NOTES_DESTRUCTIVE_POLICY` | The current policy is a permissive `FOR ALL`. | Replace with the minimum read capability. With direct reads revoked, the policy is inert; do not leave an unreviewed write-capable policy. |
| `LEGACY_CAS_WRITE_PATH` | `cap_sync_note_put` remains executable by `authenticated`. | Revoke or drop it at cutover. Keeping it preserves content-only writes. |
| `LEGACY_VERIFIER_PRESENT` | `cap_verify_notes_rpc` still attests the old contract. | It is useful as a **lockout signal** (it reports not-ready after hardening) but is not a lifecycle verifier. Drop/revoke it or replace it with a new versioned verifier. |
| `TEST_RPC_PRESENT` | Test transaction RPC/verifier is installed. | Confirm unused, then run the reviewed removal script or explicitly retain it outside notes scope. |
| `DEFINER_UNFIXED_SEARCH_PATH` | A definer function has no fixed `search_path`. | Set `search_path=pg_catalog`; schema-qualify every relation/function. |
| `CLIENT_DEFAULT_PRIVILEGES` | Default privileges grant future objects to client roles. | Revoke default privileges for the owning roles; verify `pg_default_acl` for `public` and any new schema. |
| `AUTH_SCHEMA_CREATE` / `ANON_SCHEMA_CREATE` | A client role can create objects in a reviewed schema. | Revoke `CREATE`; clients only need `USAGE` on the exposed schema. |
| `EXTENSION_IN_PUBLIC` | An extension is installed in `public`. | Supabase normally uses an `extensions` schema. Review function exposure and move only with a reviewed migration. |
| Fingerprint compatibility | Adding columns to `public.notes` changes old clients' `select=*` fingerprints. | Choose the sidecar design or explicitly lock out/project before adding columns. |

### Review

- `NOTES_DIRECT_SELECT` — decide whether `authenticated` may read raw note rows
  at all. A lifecycle reader RPC that returns an explicit envelope is safer than
  exposing tombstoned rows to old clients that do not understand `deleted_at`.
- `SERVICE_ROLE_PRESENT` — service role bypasses RLS by design. The audit cannot
  verify key custody; confirm the key is server-only, rotated after any exposure,
  and never bundled in the PWA.
- `UNEXPECTED_DEFINER_FUNCTION` — list every definer function for manual review.
  Comments and metadata are not a proof of function bodies.
- Triggers, extensions, ownership, and default ACLs are listed in the audit output
  for review; they are not automatically safe because a single check passed.

## 4. Target production posture

The lifecycle boundary must not depend on clients voluntarily using an RPC.
The server must remove the direct write capability.

1. `public.notes` remains content-only or is joined to a private lifecycle
   sidecar. Clients have **no direct table DML**.
2. A dedicated non-login, non-inheriting writer role owns the lifecycle writer
   function. It has no `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`,
   replication, schema ownership, or schema `CREATE`; it is not a member of a
   client role and clients are not members of it.
3. The writer is `SECURITY DEFINER`, `search_path=pg_catalog`, schema-qualified,
   takes the owner only from `auth.uid()`, and checks its own metadata posture on
   every call. A metadata drift returns a fixed failure before any mutation.
4. Lifecycle tables use `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, exact owner
   policies, and no client grants. The operation ledger is private: no client
   `SELECT`, export, or purge grant.
5. `authenticated` receives only `EXECUTE` on the reviewed reader, writer, and
   verifier functions. `anon` and `PUBLIC` receive nothing.
6. The reader returns an explicit `{ content, lifecycle }` envelope, including
   tombstoned rows only where the lifecycle flow requires it. A missing row is
   never deletion evidence.
7. The writer advances a server-owned revision exactly once per edit/tombstone,
   retains content on tombstone, generates `deleted_at` on the server, and binds
   an operation UUID to the exact expected snapshot/action/result. There is no
   insert, hard delete, restore, purge, or dynamic table name.
8. Every new function is explicitly `REVOKE ALL ... FROM PUBLIC, anon` before
   granting `authenticated`. Every new table/schema has explicit revokes and no
   inherited default privileges.
9. PostgREST exposure is explicit: only the intended schema(s) are exposed; new
   private schemas are not added to `pgrst.db_schemas`; no function is callable
   merely because it exists in `public`.
10. Old clients fail **closed**, not into a fallback direct-write path.

## 5. Design decision: sidecar versus in-table columns

### Preferred: private lifecycle sidecar

Keep `public.notes` content-only and add a private table such as
`public.note_lifecycle` (or a non-exposed schema) with:

- `note_id uuid primary key references public.notes(id) on delete restrict`
- `user_id uuid not null`
- `revision bigint not null default 1` with a JavaScript-safe integer check
- `deleted_at timestamptz null`
- `last_operation_id uuid null`
- server timestamps

Why:

- Old clients' `select=*` on `public.notes` does not gain new columns, so v2
  content fingerprints do not silently change.
- Tombstone metadata is not exposed by a broad notes `SELECT`.
- The content row is retained unchanged; hard deletion is blocked by the
  `on delete restrict` foreign key and by revoked grants.
- Rollback before any tombstone is written is simpler: drop the sidecar and
  restore the old grants/functions.
- The reader/writer RPC can join content and lifecycle behind one reviewed
  contract.

The sidecar must still be private: no client table grants, forced RLS, exact
policies, and writer-only access. A broad `SELECT` on `public.notes` must be
revoked or made lifecycle-aware; otherwise old clients see tombstoned content as
active. The safest target is RPC-only reads for `authenticated`.

### Alternative: lifecycle columns on `public.notes`

Only viable if **all** of the following are true:

- every client that can reach the project is updated to project explicit note
  fields (not `select=*`) and to understand `deleted_at`/`revision`/operation
  evidence;
- old cached clients are locked out server-side before the columns appear;
- the migration backfills revision 1 and null deletion/operation values without
  changing content;
- the policy/reader hides or envelopes tombstoned rows as intended;
- the v2 fingerprint projection is updated and tested against existing
  baselines before deployment.

Otherwise, adding columns is a silent fingerprint change and a tombstone
visibility bug. Do not choose this merely because it is fewer DDL statements.

**Recommendation:** sidecar first. It preserves the existing content row and v2
fingerprints while the lifecycle contract is proven. If the sidecar join proves
too costly, migrate to columns later with a separately reviewed compatibility
step. This recommendation is not an authorization to create the sidecar.

## 6. Migration design (not executable here)

All phases require separate explicit approval. The phases below are a design
sketch, not a script to paste into Supabase. The exact names, schema, RLS
expressions, and function bodies require review against the live catalog.

### Phase 0 — authorization and backup

- Confirm Cloud Sync OFF, outbox empty, no manual notes operation in progress,
  and no other privileged writer active.
- Take and verify a provider backup/restore point. Record aggregate row counts
  and a private integrity manifest; do not export note content to diagnostics.
- Save the current definitions of `public.notes`, its policy/grants, both notes
  RPCs, and the test RPCs for rollback.
- Freeze deployments and old-client manual notes operations for the window.

### Phase 1 — live read-only audit

Run `tests/sql/production-privilege-audit.sql` in a reviewed session and keep
the output private. Expect the current posture to report blockers. Resolve or
explicitly accept every critical/high finding before DDL. In particular verify:

- `pg_default_acl` and inherited memberships;
- all `SECURITY DEFINER` functions in `public`;
- `service_role` grants/key custody;
- PostgREST exposed schemas and extra search path;
- triggers/extensions/ownership;
- any column ACLs on `notes`.

### Phase 2 — add the private lifecycle structure

- Create the dedicated writer role and private sidecar/ledger.
- Enable and force RLS; add exact policies; revoke all client/`PUBLIC` access.
- Backfill one sidecar row per existing note with revision 1, null deletion,
  null operation. Do not change note content.
- Verify one-to-one coverage and no orphan/duplicate rows.
- Create the reader/writer/verifier functions with fixed `search_path`, explicit
  revokes, and `EXECUTE` only to `authenticated`.
- Do not revoke old grants yet; do not deploy the new client yet.

### Phase 3 — verify the new server contract

- Run the new metadata verifier; it must attest signature, owner, security mode,
  search path, forced RLS, exact policies, column/table grants, role membership,
  ledger privacy, and version.
- Prove negative cases on an isolated synthetic database: direct DML, column
  grants, `PUBLIC` execute, wrong owner, wrong policy, disabled force RLS,
  writer membership, unsafe search path, and drift all fail closed.
- Keep `production_ready: false` until live, separately authorized verification.

### Phase 4 — cut over and lock out old clients

Recommended order in one reviewed window:

1. Revoke `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, and `TRIGGER`
   on `public.notes` from `authenticated`, `anon`, and `PUBLIC`; revoke every
   column-level write grant too.
2. Revoke or drop `cap_sync_note_put`; revoke or drop the legacy
   `cap_verify_notes_rpc` (or replace it with a new versioned verifier).
3. Revoke direct `SELECT` if the target is RPC-only; otherwise make the policy
   lifecycle-aware before leaving it.
4. Confirm the old client fails closed: old readiness returns false/404/403 and
   direct `PATCH`/`DELETE` returns 403. It must not fall back to another writer.
5. Deploy the new client behind its own explicit readiness check. Cloud Sync
   remains OFF; no automatic sync starts.

The lockout is deliberate. There will be a period where old manual notes
operations cannot work. Do not shorten it by leaving a direct-write grant.

### Phase 5 — verification and observation

- Re-run the read-only audit: no critical/high findings; note that
  `production_notes_lifecycle_ready` remains false until a separate live
  verification is completed.
- Verify old-client denial and new-client readiness from a disposable origin.
- Verify aggregate counts, sidecar coverage, empty outbox, and unchanged
  financial tables.
- Monitor failed legacy calls and direct-write attempts; investigate, do not
  silently re-grant.

### Phase 6 — rollback

Define rollback per phase, because DDL is not symmetric once tombstones exist.

**Before Phase 4 (no new writes):**
- Drop the new functions/sidecar/role, restore saved old definitions/grants,
  verify the old verifier is ready, and confirm old manual notes work.
- No user content changed, so this is a clean abort.

**After Phase 4 but before any tombstone:**
- Restore old grants/functions from the saved definitions; drop the unused
  sidecar/role. Verify old readiness. The lockout window ends.
- Do not leave both old and new write paths active.

**After any tombstone:**
- Do **not** drop the sidecar, restore direct `DELETE`, or run a generic
  replace/merge that can resurrect deleted notes.
- Preserve tombstone/ledger evidence privately; keep deleted rows hidden from
  normal reads.
- Roll forward with a reviewed fix, or perform a separately approved archival
  migration that retains evidence. "Rollback" must not silently reactivate a
  deleted note or lose the operation receipt.
- If old clients must be restored temporarily, they must remain read-only or be
  blocked from note writes; restoring `cap_sync_note_put` reopens content-only
  writes.

### Phase 7 — production readiness is still separate

A clean audit and successful synthetic tests do not prove:

- real Supabase/PostgREST JWT, role inheritance, or connection-pooler behavior;
- provider default privileges and dashboard settings;
- backup restore fidelity;
- full deadlock/lock-order behavior across all paths;
- old-client cache behavior in the wild;
- financial-record sync, RLS for all other tables, or rollout.

Those require separate authorization and live verification. Cloud Sync stays OFF
until then.

## 7. Old-client lockout criteria

The lockout is server-side, not a UI warning.

- [ ] `authenticated` has no table or column `INSERT`/`UPDATE`/`DELETE`/
      `TRUNCATE`/`REFERENCES`/`TRIGGER` on `public.notes`.
- [ ] `anon`/`PUBLIC` have no note table or column privilege.
- [ ] The legacy writer is absent or not executable by `authenticated`.
- [ ] The legacy verifier is absent or reports not-ready; it cannot report ready
      against the old grants.
- [ ] Direct PostgREST `PATCH`/`DELETE`/`POST` to `notes` returns 403.
- [ ] A cached old client stops at readiness and does not fall back to a direct
      write.
- [ ] The new reader/writer/verifier are the only client-executable endpoints.
- [ ] `EXECUTE` is revoked from `PUBLIC`/`anon` on every new function.
- [ ] The writer role is not a member of `authenticated`, and `authenticated`
      is not a member of the writer role.
- [ ] The writer role is not the table owner, is not `BYPASSRLS`, and cannot
      create objects in the schema.
- [ ] Default privileges do not recreate client grants for future objects.

## 8. Decisions required before any live action

1. **Sidecar or in-table columns.** Recommendation: private sidecar.
2. **Reader exposure.** Recommendation: RPC-only reads for `authenticated`;
   no broad `SELECT` on tombstoned content.
3. **Lockout window.** Accept that old manual notes operations stop until the new
   client is deployed and verified.
4. **Test-only RPCs.** Confirm `cap_test_transaction_create` and
   `cap_verify_transaction_rpc` are unused, then remove them with the reviewed
   script; otherwise document why they remain.
5. **Service-role custody.** Confirm server-only key storage, rotation policy,
   and that no key is bundled in the PWA or logs.
6. **Backup/restore verification.** Approve a restore-point check before DDL.
7. **Live audit run.** Approve one read-only catalog audit against the real
   project and keep its output private.
8. **Migration window and rollback owner.** Name the reviewer/operator and the
   abort criteria.
9. **Tombstone/ledger retention.** Decide privacy, retention, and account
   deletion handling before any real tombstone is written.

## 9. Verification performed for this audit

`node tests/production-privilege-audit.cjs` passes **8** checks in disposable
PGlite:

- the audit SQL is read-only by construction (no DML/DDL, no note-content read,
  no RPC invocation);
- the synthetic deployed notes contract matches the repository;
- the audit reports the current direct `INSERT`/`UPDATE`/`DELETE`, old policy,
  legacy writer/verifier, direct select, and missing lifecycle columns;
- column-level `UPDATE(body)` is detected after a table-level path would be
  hidden;
- client membership in a `cap_*` role with `BYPASSRLS` is detected, including
  transitive membership, and is listed with other privileged roles;
- the audit never returns note content;
- a hardening simulation clears critical/high findings but still reports
  `production_notes_lifecycle_ready: false`, because catalog checks cannot prove
  live PostgREST/auth/rollback/race behavior.

A separate `tests/sql/notes-sidecar-lab.sql` /
`tests/notes-sidecar-sql.cjs` lab now passes **83** isolated PGlite checks for the
recommended sidecar shape. It rehearses content-only notes, a forced-RLS private
lifecycle/ledger, a dedicated writer owner, RPC-only reads, exact backfill, an
explicit cutover that removes direct grants and both legacy RPCs, old-client
denial, new edit/tombstone CAS, direct/column/schema/`SET ROLE` bypass denial,
metadata drift, restored-legacy-RPC blocking, and a tombstone-aware rollback
guard. A separate 5-check `tests/notes-sidecar-rollback-sql.cjs` rehearsal
covers the clean-abort path after cutover but before any tombstone. Both always
report `production_ready: false` and do not authorize or execute any live
migration.

No live SQL, grant, policy, function, note, baseline, outbox, financial record,
or cloud object was changed. The PostgreSQL race container was not reused, and
the completed tombstone race run was not repeated.

## 10. Non-actions

This audit does **not**:

- install the lifecycle lab or any production migration;
- add lifecycle columns or a sidecar to the live database;
- revoke grants, drop RPCs, or change RLS;
- wire Delete UI, import/undo, or automatic sync;
- create a baseline, clear site data, or touch the real note's trial markers;
- authorize a tombstone trial, financial sync, or rollout.

The next action is a user decision on the sidecar/reader/lockout design (now
rehearsed only in the isolated sidecar lab), followed by a separately authorized
live read-only audit. No live mutation is authorized by this document.
