# Optional two-session notes lifecycle races — disposable run passed

Status (2026-10-21): **real disposable PostgreSQL run passed** after the user
installed Docker Desktop, enabled its Linux engine, and explicitly authorized
one local PostgreSQL test container. The earlier missing-runtime blocker is
resolved. These results are separate from the single-session PGlite tests.

No real Cap database, Supabase endpoint, local app state, or live SQL deployment
was touched. Cloud Sync remains OFF. Overall progress is still an estimate,
roughly **85–88%**, with substantial integration/financial/rollout gates left.

## Measured result (2026-10-21)

The harness completed once against PostgreSQL **16.15** in a fresh Docker
container, published only on `127.0.0.1:55432`. Data lives in a temporary memory
filesystem; no host/app data is mounted. The external `pg` driver was installed
under the approved temporary tool directory, not added to the app.

Redacted result:

```json
{
  "passed": true,
  "checks": 10,
  "independentBackends": 3,
  "observedLockWaits": 8,
  "realLockWaitsRequired": true,
  "productionReady": false
}
```

This covers one isolated-readiness check plus the nine cases below. Every one
of the eight contention scenarios observed a real backend lock wait; the direct
writer case verified permission denial instead of waiting for row access.
The container remained running/healthy for inspection. No reset, DROP, purge,
rollback of completed results, or automatic rerun followed success.

A server restart interrupted setup but not the actual race run. Inspection
found the original container and a loadable driver, so neither was recreated;
the harness ran only after confirming PostgreSQL accepted connections. Local
connection metadata and the redacted result are retained outside the repository;
do not publish credentials or the private connection file. Stopping this tmpfs
container discards its synthetic database; it is not a backup of app data.

## Cases exercised by the harness

`tests/manual/notes-lifecycle-races.cjs` uses the optional Node `pg` driver with
three independent PostgreSQL backends: a privileged setup/observer connection
and two authenticated test sessions. It runs only the separate-schema draft
from `tests/sql/notes-lifecycle-lab.sql`, not a public-table migration.

Each contention case must observe the second backend blocked by the first via
`pg_blocking_pids`. Sleep timing alone or sequential requests cannot count as
race evidence. The first operation remains uncommitted while this wait and
observer-visible original revision are checked.

Passed cases:

1. Edit commits while stale delete waits: deletion conflicts, edit remains.
2. Tombstone commits while stale edit waits: edit conflicts, deletion remains.
3. Identical tombstone retries: one revision/receipt, second already applied.
4. Identical edit retries: one revision/receipt, second already applied.
5. First edit rolls back: waiting valid delete applies from the original state.
6. Different notes reuse one operation ID: ledger uniqueness contention rejects
   the second statement and rolls its tentative note update back.
7. REPEATABLE READ with a pinned older snapshot: stale contender aborts with
   serialization failure; no automatic retry.
8. SERIALIZABLE with a pinned older snapshot: same fail-closed expectation.
9. Direct UPDATE/DELETE attempts while the valid writer holds a lock: client
   permission denial, not a hard-delete or CAS bypass.

The harness also checks isolated-only readiness, distinct backend IDs, retained
content, lifecycle revision/state, exact operation-receipt counts, and healthy
connections. Statements, lock waits, and idle transactions have explicit time
limits. Pending errors are handled immediately; the blocking transaction is
released before closing a failed contender. Failures do not automatically rerun
the writer or erase test evidence.

This run does not prove every multi-row deadlock, Supabase/PostgREST deployment, RLS default,
service-role path, network failure, or old-client compatibility scenario.

## Mandatory target guards

Before setup, require all of:

- Explicit `CAP_NOTES_RACE_ACK=DISPOSABLE_LOCAL_CLUSTER_ONLY`.
- A PostgreSQL URL with a literal loopback host (`127.0.0.1` or `[::1]`) and an
  explicit username. DNS hostnames, remote/Supabase hosts, URL query overrides,
  fragments, and non-PostgreSQL protocols are rejected.
- Database name `cap_notes_race_lab_` followed by exactly 12 hexadecimal digits.
  `postgres`, `cap-finance`, and ordinary app database names are not accepted.
- The connected database name must match, with a privileged setup account.
- No existing authenticated/anon/lab-writer roles or auth/lab schemas; no user
  relations in the target database; no extra custom cluster roles or databases.
  This must be a **fresh dedicated cluster**, not just an empty database inside
  a shared server. Setup creates cluster-level roles, so database-only isolation
  is insufficient.

The runner creates neither databases nor containers. It contains no DROP/reset
or broad-delete cleanup. A rerun on the already-populated cluster is deliberately
refused: inspect evidence and provision another fresh disposable cluster rather
than using an app reset as a workaround.

## Prerequisites / future execution

Do not run this in the Supabase SQL editor, against a shared local cluster, or
with production credentials. Do not paste credentials/connection strings into
chat or commit them. Docker was installed by the user; the test driver is external
to the repository. The existing populated test cluster must not be reused for a
fresh run by bypassing guards or deleting evidence.

When a fresh disposable local PostgreSQL runtime has been provided:

1. Provision a dedicated cluster with no mounted app/production data. Create its
   only non-template database using the guarded lab naming convention. Use
   throwaway local credentials and a loopback-bound port.
2. Install `pg` outside this repository in the approved temporary tool directory
   or another explicitly selected external test directory; do not add an app
   package manifest/dependency or install it automatically from the runner.
3. Set `CAP_PG_PATH` to that package directory, `CAP_NOTES_RACE_URL` to the fresh
   local database URL, and the exact acknowledgement above in the shell running
   the test. These environment variables are not read by the Cap app.
4. Run `node tests/manual/notes-lifecycle-races.cjs` once. Keep only its redacted
   result or fixed failure status. The runner does not print URLs, credentials,
   note content, identifiers, or raw PostgreSQL DETAIL errors.
5. If blocked/failed, preserve the disposable cluster and inspect the harness
   before another attempt. No live cleanup or migration is authorized.

The runtime blocker is resolved. Next are lifecycle-safe client integration,
merge/import/export compatibility, and a production privilege/migration audit.
The local test authorization is not authorization to change Supabase. No real
note needs editing or deleting.

## Checks completed without PostgreSQL

`tests/notes-lifecycle-race-guards.cjs`: **21 target/static checks**, covering
allowed literal loopback lab URLs, explicit acknowledgement, refused remote/app
targets and URL overrides, independent-backend/lock-observation requirements,
fresh-cluster checks, and absence of destructive cleanup statements.

These tests do not import a PostgreSQL driver, connect, or simulate successful
races. Their output explicitly says they do not run actual PostgreSQL races;
the separate measured run above supplies that evidence.
The standard isolated suite count is now 26; the optional real race runner lives
under `tests/manual/` and is not silently skipped/countable as a passing race.
