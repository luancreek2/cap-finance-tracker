/* Target/opt-in guards for the real PostgreSQL production cutover harness and
   the prepared cutover SQL. Static + invocation checks only; never starts
   Docker, never opens a database and never touches a real project. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateInvocation, validName, Session } = require('./manual/production-cutover-races.cjs');
const harness = fs.readFileSync(`${__dirname}/manual/production-cutover-races.cjs`, 'utf8');
const cutover = fs.readFileSync(`${__dirname}/../supabase_production_cutover.sql`, 'utf8');
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; }
  catch (e) { e.message = name + ': ' + e.message; throw e; }
};
test('explicit disposable-docker opt-in is mandatory', () => {
  assert.throws(() => validateInvocation({}), /FRESH_DISPOSABLE_DOCKER_ONLY/);
  assert.throws(() => validateInvocation({ CAP_CUTOVER_RACE_ACK: 'YES' }), /FRESH_DISPOSABLE_DOCKER_ONLY/);
  assert.doesNotThrow(() => validateInvocation({ CAP_CUTOVER_RACE_ACK: 'CREATE_DISPOSABLE_DOCKER_ONLY' }));
});
test('database URL and existing-container targets are rejected', () => {
  assert.throws(() => validateInvocation({ CAP_CUTOVER_RACE_ACK: 'CREATE_DISPOSABLE_DOCKER_ONLY',
    CAP_CUTOVER_RACE_URL: 'postgres://production' }), /FRESH_DISPOSABLE_DOCKER_ONLY/);
  assert.throws(() => validateInvocation({ CAP_CUTOVER_RACE_ACK: 'CREATE_DISPOSABLE_DOCKER_ONLY',
    CAP_CUTOVER_RACE_CONTAINER: 'existing' }), /FRESH_DISPOSABLE_DOCKER_ONLY/);
});
test('only uniquely suffixed disposable names are accepted', () => {
  assert.equal(validName('cap-cutover-lab-' + 'a'.repeat(12)), true);
  for (const value of ['cap-cutover-lab-short', 'cap-cutover-lab-' + 'A'.repeat(12),
    'cap-cutover-lab-' + 'a'.repeat(13), 'postgres', 'cap-cutover-lab-' + 'a'.repeat(12) + 'x']) {
    assert.equal(validName(value), false, value);
  }
  assert.throws(() => new Session('cap-cutover-lab-short', 'cap_cutover_' + 'a'.repeat(12)),
    /INVALID_DISPOSABLE_TARGET/);
  assert.throws(() => new Session('cap-cutover-lab-' + 'a'.repeat(12), 'production'),
    /INVALID_DISPOSABLE_TARGET/);
});
test('cluster is network-none, tmpfs-only and has no host ports/volumes', () => {
  for (const token of ["'--network', 'none'", "'--tmpfs', '/var/lib/postgresql/data:rw'",
    "'postgres:17'", 'POSTGRES_PASSWORD=', "HostConfig.NetworkMode, 'none'",
    "Object.keys(inspection.HostConfig.PortBindings || {}).length, 0",
    "m.Type === 'bind' || m.Type === 'volume'"]) assert.ok(harness.includes(token), token);
  assert.equal(harness.includes("'--publish'"), false);
  assert.equal(harness.includes("'-p'"), false);
});
test('cleanup is restricted to the exact unique label', () => {
  assert.ok(harness.includes("cap.production-cutover-test=' + suffix"));
  assert.ok(harness.includes("inspection.Config.Labels['cap.production-cutover-test'] !== suffix"));
  assert.ok(harness.includes("docker(['rm', '--force', name])"));
  assert.ok(harness.includes("validName(name)"));
});
test('no ambient URL/container target is used as a database target', () => {
  assert.equal((harness.match(/CAP_CUTOVER_RACE_URL/g) || []).length, 1);
  assert.equal((harness.match(/CAP_CUTOVER_RACE_CONTAINER/g) || []).length, 1);
  assert.ok(!/psql[^\n]*CAP_CUTOVER_RACE_URL/.test(harness));
  assert.ok(!/docker[^\n]*CAP_CUTOVER_RACE_CONTAINER/.test(harness));
});
test('the harness installs the full dependency order before the cutover', () => {
  for (const token of ['f.setupSql()', 'f.transactionInstallSql', 'f.snapshotInstallSql',
    'f.cutoverSql', 'PRODUCTION_CUTOVER_NOT_APPROVED', 'PRODUCTION_CUTOVER_DEPENDENCIES_REQUIRED',
    'CUTOVER_TEST_ROLLBACK']) assert.ok(harness.includes(token), token);
  assert.ok(harness.indexOf('f.setupSql()') < harness.indexOf('f.transactionInstallSql'));
  assert.ok(harness.indexOf('f.transactionInstallSql') < harness.indexOf('f.snapshotInstallSql'));
  assert.ok(harness.indexOf('f.snapshotInstallSql') < harness.indexOf("stage = 'FULL_ORDER_CUTOVER'"));
});
test('the harness proves rollback and old-client bypass denial', () => {
  for (const token of ["'CUTOVER_ROLLBACK_ON_FAILURE'", "'OLD_CLIENT_BYPASS_DENIED'",
    "'permission denied'", "'does not exist'", "'REVIEWED_RPCS_STILL_WORK'",
    "'CUTOVER_RERUN_IS_SAFE'"]) assert.ok(harness.includes(token), token);
});
test('the cutover draft is guarded, transactional and fail-closed', () => {
  for (const token of ["SET cap.production_cutover = 'reviewed-draft-only';",
    'PRODUCTION_CUTOVER_NOT_APPROVED', 'PRODUCTION_CUTOVER_DEPENDENCIES_REQUIRED',
    'PRODUCTION_CUTOVER_CONTRACT_VERSION_MISMATCH', 'PRODUCTION_CUTOVER_TABLE_OWNERSHIP_REQUIRED',
    'PRODUCTION_CUTOVER_PRIVATE_RLS_REQUIRED', 'PRODUCTION_CUTOVER_NOTES_COVERAGE_FAILED',
    'PRODUCTION_CUTOVER_LEGACY_FUNCTION_OWNERSHIP_REQUIRED',
    'PRODUCTION_CUTOVER_PLATFORM_FUNCTION_OWNERSHIP_REQUIRED',
    'PRODUCTION_CUTOVER_POSTFLIGHT_FAILED']) assert.ok(cutover.includes(token), token);
  assert.ok(cutover.trimStart().startsWith('-- Phase 6L DRAFT'));
  assert.ok(cutover.includes('NOT authorized for production deployment'));
  assert.ok(cutover.trimEnd().endsWith('commit;'));
  assert.equal((cutover.match(/^begin;$/gm) || []).length, 1);
});
test('the cutover draft removes client access, legacy RPCs and forces RLS', () => {
  for (const token of ['revoke all on table public.profiles', 'revoke all (%I) on table',
    'drop policy %I on %s', 'alter table public.notes force row level security',
    'alter table cap_notes_private.note_lifecycle force row level security',
    'drop function if exists public.cap_sync_note_put', 'drop function if exists public.cap_test_transaction_create',
    'cap_notes_private.backfill_lifecycle()', 'cap_notes_private.coverage_ok()',
    'cap_verify_production_sync_v1()', 'cap_sync_snapshot_v1()',
    'cap_sync_transaction_create(uuid,jsonb,jsonb)', 'cap_notes_change(uuid,jsonb,text,jsonb,uuid)'])
    assert.ok(cutover.includes(token), token);
  assert.ok(cutover.indexOf('backfill_lifecycle()') < cutover.indexOf('revoke all on table public.profiles'));
  assert.ok(cutover.indexOf('revoke all on table public.profiles') < cutover.indexOf('PRODUCTION_CUTOVER_POSTFLIGHT_FAILED'));
});
test('the cutover draft never writes an application row', () => {
  for (const forbidden of [/insert into public\./i, /update public\./i, /delete from public\./i,
    /truncate /i, /drop table /i, /drop schema /i, /drop role /i])
    assert.equal(forbidden.test(cutover), false, String(forbidden));
  assert.ok(cutover.includes('It does not insert, update or delete any application row.'));
});
console.log(`PASS: ${passed} production-cutover real-harness and SQL guards; no Docker or database started`);
