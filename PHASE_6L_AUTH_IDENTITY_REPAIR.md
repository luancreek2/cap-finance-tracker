# Phase 6L managed Auth compatibility repair — prepared, not deployed

**Cloud Sync stays OFF.** The user reports Notes installed and one lifecycle
row backfilled successfully. Earlier documents saying *nothing is installed*
are superseded by that production observation. No production connection or SQL
execution was performed in preparing this repair.

## Root cause

The dedicated SECURITY DEFINER roles resolve and invoke `auth.uid()` in their
function bodies and RLS policies. Function EXECUTE is not sufficient: schema
USAGE is also required. The reported SQL Editor session cannot effectively grant
USAGE on the Supabase-managed `auth` schema. Installation success did not prove
effective privileges. The disposable fixtures previously failed to model this
restriction. This is an ACL dependency failure, not failed JWT validation.

## Second production blocker: retained PG16+ creator ADMIN membership

Creating a role as a non-superuser `CREATEROLE` role makes PostgreSQL 16+ add an
**ADMIN-only** membership of the new role in its creator. The grant is recorded
against the bootstrap superuser (oid 10), not against the creator:

```
roleid = cap_notes_sidecar_writer
member = postgres
admin_option = true, inherit_option = false, set_option = false
grantor = bootstrap superuser (oid 10, superuser)
```

Because the recorded grantor is not `postgres`, `REVOKE cap_notes_sidecar_writer
FROM postgres` executed by `postgres` only removes grants that `postgres` itself
issued. It reports success and changes nothing. In PG16+ `pg_auth_members` is
keyed by `(roleid, member, grantor)`, so this bootstrap row and the temporary
operational row created by an installer coexist; only the latter is removed on
cleanup. A superuser-issued membership is likewise attributed to the bootstrap
superuser.

This is expected PostgreSQL platform behaviour, not a Supabase ACL anomaly.
The previous repair preflight rejected **any** row in either direction, so it
correctly aborted with `NOTES_IDENTITY_REPAIR_UNSAFE_ROLE` rather than weakening
RLS or retrying the same `REVOKE`. The invariant, not the zero-row assumption,
was wrong.

### Required membership invariant

`public.cap_role_boundary_ok(oid)` (installed by the new guarded
`supabase_production_role_boundary.sql`) enforces both directions separately:

- **Outgoing:** a Cap role is a member of **no** role, at all, including
  ADMIN-only or otherwise inert memberships. No role grants it upward reach.
- **Incoming:** none, or exactly the bootstrap-issued ADMIN-only grant to the
  trusted public-table owner `postgres`, where the member is `postgres`,
  `admin_option` is true, `inherit_option` and `set_option` are false, the
  grantor is the bootstrap superuser (oid 10, still a superuser), the member has
  `CREATEROLE`, and that member owns every Cap public table.
- **No client path:** `authenticated`, `anon` and `service_role` must not be a
  member (directly or indirectly) of a Cap role **or of `postgres`**.

The role must also remain `NOLOGIN`, `NOINHERIT`, `NOSUPERUSER`, `NOBYPASSRLS`,
`NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`.

Why the retained grant is safe: it carries neither INHERIT nor SET, so
`postgres` cannot use the writer's privileges implicitly or through `SET ROLE`.
ADMIN OPTION only lets the already-trusted table owner re-grant the writer, and
that owner can already grant table access directly; the row creates no new
capability for it. Any grantor other than the bootstrap superuser is rejected,
and PostgreSQL records superuser-issued grants as bootstrap grants, so a
non-bootstrap ADMIN row is not an accepted state. Browser roles have no path to
`postgres`, the writer, or the grantor.

The helper is SQL STABLE **SECURITY INVOKER**, `search_path=pg_catalog`; only
the three Cap NOLOGIN roles receive EXECUTE, while PUBLIC/anon/authenticated/
service_role are denied. The Notes, transaction, snapshot/readiness and cutover
contracts all call this one helper instead of assuming zero membership rows.

## Replacement security boundary

`supabase_production_identity.sql` installs two **Cap-owned** public functions
(public schema placement is for name resolution, NOT public execution):

- `cap_request_uid()`: zero arguments, SQL STABLE **SECURITY INVOKER**,
  `search_path=pg_catalog`. Reads PostgREST's server-installed verified JWT `sub`
  (`request.jwt.claim.sub`, falling back to `request.jwt.claims->>'sub'`), and
  casts it to UUID. Missing identity yields NULL; invalid UUID/JSON fails.
  No managed Auth function/schema access and no elevation are involved.
- `cap_request_identity_ok()`: catalog-only validation of the exact identity
  source, signature, language, volatility, invoker mode, search path, owner,
  version and browser execution/schema-CREATE protections.

Only the three Cap NOLOGIN/NOINHERIT/NOSUPERUSER/NOBYPASSRLS roles receive
EXECUTE on the identity and role-boundary helpers from their installers.
PUBLIC/anon/authenticated/service_role receive no execution grant. No
private-schema privileges are widened. Managed Auth ownership, functions, ACLs
and foreign-key targets remain untouched.

The subject is **not** a function parameter or request-body user ID. PostgREST
must validate the JWT and establish claims before selecting `authenticated`.
Request settings are not cryptographically self-verifying: this architecture,
like Supabase's normal `auth.uid()` pattern, assumes a trusted gateway. Never
expose arbitrary SQL/`set_config` RPCs or database login credentials to browser
roles. Tests setting claims directly simulate that trusted gateway, not JWT
signature verification.

Every production function and dedicated-role policy now uses the same helper.
RLS, owner-qualified queries, expected-state CAS and immutable operation receipts
are unchanged. Notes `contract_ready`, transaction/snapshot runtime checks,
global readiness and cutover postflight all require the identity contract.
Global readiness rejects mixed old/new function and policy dependencies and
missing helper grants; it still returns exactly 11 checks and 4 contract versions.

## Exact repair plan for the installed Notes sidecar

**Review artifacts only. Do not run without separate production approval.**

1. Review/export current Cap definitions, policy definitions and effective ACLs
   for repair rollback evidence. Preserve existing lifecycle/receipt data. Reuse
   the already-completed restore verification; this work does not repeat it.
   A fresh pre-change backup/PITR checkpoint is a separate operational gate,
   not a claim that the earlier restore exercise failed or must be repeated.
2. **Current state: identity is already installed. Do not reinstall it.**
   As the same Cap object-owning `postgres` (the helper's owner), install the
   shared role boundary prerequisite after:
   `SET cap.role_boundary_install='reviewed-draft-only';`
   Run `supabase_production_role_boundary.sql` whole. It creates only
   `cap_role_boundary_ok(oid)` and its restricted grants; it changes no
   membership, no managed Auth object, no existing Cap object and no data.
3. Run the whole revised `supabase_production_notes_identity_repair.sql`, after:
   `SET cap.notes_identity_repair='reviewed-draft-only';`
   It validates the retained bootstrap row, installed V1 Notes
   owners/signatures/RLS and the identity/boundary prerequisites; temporarily
   obtains writer ownership membership, replaces only the identity calls,
   membership expectation and policy expressions in the three Notes functions,
   alters the eight writer policies, grants the three Cap helper executions and
   removes only the temporary operational membership. The bootstrap ADMIN row is
   deliberately retained. Owners, signatures, RPC comments/execution grants and
   data are retained. A rerun does not reset lifecycle revisions or receipts.
4. Verify: `cap_role_boundary_ok('cap_notes_sidecar_writer'::regrole)` is true,
   effective `auth` USAGE for the writer remains false, and exactly one inbound
   row remains (member `postgres`, `admin_option=true`,
   `inherit_option=false`, `set_option=false`, bootstrap grantor). In an
   authenticated request context, Notes no longer fails at `auth.uid()`.
   **Do not require `contract_ready:true` before cutover**: direct
   grants/legacy policies/RPCs intentionally still make it false. Neither Notes
   `ready` nor `production_ready` ever becomes true from this repair.
5. Transaction and snapshot installers require the identity **and** role-boundary
   prerequisites plus repaired Notes. Do not rerun the Notes first-install script
   or backfill existing rows to perform the repair. Do not drop schemas, roles or
   tables. Do not try to remove the bootstrap ADMIN row again.

Read-only pre-repair evidence query (no modification):

```sql
select r.rolname, r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolbypassrls,
       g.rolname as grantor, g.oid as grantor_oid, g.rolsuper as grantor_is_super,
       m.admin_option, m.inherit_option, m.set_option
from pg_auth_members m
join pg_roles r on r.oid = m.member
join pg_roles g on g.oid = m.grantor
where m.roleid = 'cap_notes_sidecar_writer'::regrole;
```

Expected: exactly one row, `grantor_oid = 10`, grantor superuser, member
`postgres`, ADMIN-only options. Also confirm the writer owns no outgoing
membership and that `authenticated`/`anon`/`service_role` cannot reach either
the writer or `postgres`.

The repair is one transaction. Failure rolls back definitions/policies/grants
and temporary membership, leaving all existing data intact. For a precommit
rehearsal, replace its final COMMIT with ROLLBACK in a reviewed copy. After commit,
prefer a forward correction; restoring the broken `auth` dependency is not a
working rollback. The separately committed identity prerequisite is inert if
the Notes repair fails; it performs no data write or Cloud Sync activation.

## Cutover and deployment consequences

The dependency order is now shared identity → shared role boundary → **repair
existing Notes** (or the revised Notes installer for an empty project) →
transaction → snapshot/readiness → separately approved security cutover. No
deployment is authorized here. The role boundary prerequisite is intentionally
separate so the already-installed identity helper is not reinstalled.

The previous “zero-breakage/no bridge required” deployment advice was incorrect:
cached old clients survive a PWA release, while the new snapshot/writer refuses
the pre-cutover ACL state. This identity repair does not solve that release
transition. A coordinated maintenance/update gate or separately reviewed bridge
that preserves lifecycle guarantees is still required before cutover; do not
leave legacy direct writers active after lifecycle writes begin.

The SQL is prepared for local PostgreSQL verification with **no auth schema
USAGE** for custom roles. Actual Supabase/PostgREST verification and separately
approved deployment/security/release gates still remain. No claim of Phase 6L
production readiness is made. There is **no financial or note data migration**;
only Cap-owned function, policy and execution-ACL changes are needed.

## Tests

`tests/production-identity-sql.cjs` reproduces function EXECUTE=true with
schema USAGE=false, the original 42501, guarded in-place repair, injected-failure
rollback, unchanged rows/managed ACLs, exact repaired verifier, edit/replay,
request-binding conflict, cross-user/unauthenticated denial, JSON claims, missing
and malformed claims, identity-body/ACL drift and global readiness.

`tests/production-role-boundary-sql.cjs` reproduces the exact PG16+ retained
creator ADMIN row under a genuine non-superuser `postgres` creator (bootstrap
renamed, oid 10 preserved), proves ordinary `REVOKE` leaves it in place, and then
covers the revised repair, injected-failure rollback, outward/inward/browser
membership rejection, temporary INHERIT/SET rejection, indirect browser paths,
missing-administrator fail-closed behaviour, superuser grant attribution, full
readiness, Notes replay and unauthenticated denial. `tests/manual/production-role-boundary-races.cjs` runs the same scenarios
plus Notes and transaction races on a fresh disposable PG17 cluster.

All production Notes/transaction/snapshot fixtures revoke PUBLIC Auth usage and
never grant auth usage to custom Cap roles. The real concurrency runners assert
the same restriction. The Notes runner recreates the old failure (including the
old zero-membership verifier) and repairs it before create/edit/tombstone races,
rollback and lost-response replay tests.

Verification results for this change:

- Full isolated suite: **49/49 passing**, including the new retained-membership/
  role-boundary suite (**27 checks**). The earlier identity/repair suite (**17
  checks**), Notes **89**, transaction **31**, snapshot/readiness **16** and
  cutover **12** isolated checks still pass.
- Real PostgreSQL **17.11**: retained-membership repair + Notes/transaction
  races + full cutover readiness **32 checks / 3 observed lock waits**; repaired
  Notes concurrency **18 checks / 8 waits**. Dedicated harnesses re-run after
  this change: transaction **18 / 11 waits**, snapshot **94 / 24 concurrent
  iterations**, cutover **31**. Every Cap role has effective auth USAGE=false in
  these runs.
- JS syntax and manifest/vercel JSON parsing passed. No client shell changes.
- Initial Docker create/startup failures occurred before completed test runs;
  final disposable runs passed. Fresh test containers were cleaned up; existing
  restore/race labs and backup files were not opened or modified.
