/* Target/opt-in guards for the real PostgreSQL production notes-sidecar
   harness. Static + invocation checks only; never starts Docker or a database. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateTarget } = require('./manual/notes-sidecar-production-races.cjs');
const harness = fs.readFileSync(`${__dirname}/manual/notes-sidecar-production-races.cjs`, 'utf8');
const snapshotFixture = fs.readFileSync(`${__dirname}/helpers/production-snapshot-fixture.cjs`, 'utf8');
const readiness = fs.readFileSync(`${__dirname}/../supabase_production_snapshot_readiness.sql`, 'utf8');
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; }
  catch (e) { e.message = name + ': ' + e.message; throw e; }
};
const target = (database = 'cap_notes_prod_race_lab_' + 'a'.repeat(12)) =>
  `postgresql://postgres@127.0.0.1:5432/${database}`;
test('explicit disposable-local-cluster acknowledgement is mandatory', () => {
  assert.throws(() => validateTarget(target(), undefined), /DISPOSABLE_LOCAL_POSTGRES_REQUIRED/);
  assert.throws(() => validateTarget(target(), 'CREATE_DISPOSABLE_DOCKER_ONLY'), /DISPOSABLE_LOCAL_POSTGRES_REQUIRED/);
  assert.doesNotThrow(() => validateTarget(target(), 'DISPOSABLE_LOCAL_CLUSTER_ONLY'));
});
test('only loopback disposable database names are accepted', () => {
  for (const url of [
    `postgresql://postgres@example.com:5432/cap_notes_prod_race_lab_${'a'.repeat(12)}`,
    `postgresql://postgres@127.0.0.1:5432/production`,
    `postgresql://postgres@127.0.0.1:5432/cap_notes_prod_race_lab_short`,
    `postgresql://postgres@127.0.0.1:5432/cap_notes_prod_race_lab_${'a'.repeat(13)}`,
    `postgresql://postgres@127.0.0.1:5432/cap_notes_prod_race_lab_${'a'.repeat(12)}?sslmode=require`,
    `postgresql://postgres@127.0.0.1:5432/cap_notes_prod_race_lab_${'a'.repeat(12)}#fragment`
  ]) assert.throws(() => validateTarget(url, 'DISPOSABLE_LOCAL_CLUSTER_ONLY'), /DISPOSABLE_LOCAL_POSTGRES_REQUIRED/);
});
test('the harness rejects a non-fresh cluster before installing anything', () => {
  for (const token of ['EMPTY_CLUSTER_GUARD', 'FRESH_DISPOSABLE_CLUSTER_REQUIRED',
    "rolname in ('authenticated','anon','service_role','cap_notes_sidecar_writer')",
    "nspname in ('auth','cap_notes_private')"]) assert.ok(harness.includes(token), token);
  assert.ok(harness.indexOf('FRESH_DISPOSABLE_CLUSTER_REQUIRED') < harness.indexOf('PRODUCTION_NOTES_SETUP'));
});
test('the harness installs the guarded production draft, backfills and cuts over', () => {
  for (const token of ['f.setupSql()', 'f.notesInstallSql', 'f.backfillSql', 'f.cutoverSql()',
    'contract_ready', "'CAP_NOTES_SIDECAR_V1'", 'production_ready', 'ready, false']) assert.ok(harness.includes(token), token);
  assert.ok(harness.indexOf('f.notesInstallSql') < harness.indexOf('f.backfillSql'));
  assert.ok(harness.indexOf('f.backfillSql') < harness.indexOf('f.cutoverSql()'));
});
test('the harness exercises create, edit, tombstone, replay and lost responses', () => {
  for (const token of ['CREATE_CONFLICT_WINS', 'CREATE_EXACT_RETRY', 'CREATE_ROLLBACK_RELEASES',
    'EDIT_WINS_DELETE', 'DELETE_WINS_EDIT', 'EXACT_EDIT_RETRY', 'EXACT_DELETE_RETRY',
    'LOST_RESPONSE_AND_PAYLOAD_MISMATCH', 'OPERATION_REUSE_CONFLICT', 'ALREADY_APPLIED',
    'CONFLICT', 'FOREIGN_OWNER_ISOLATION']) assert.ok(harness.includes(token), token);
});
test('the harness observes real backend lock waits and direct-writer denial', () => {
  for (const token of ['pg_blocking_pids', 'observedLockWaits', 'Independent backends required',
    'DIRECT_WRITER_DENIED_DURING_LOCK', "e.code === '42501'",
    "select * from cap_notes_private.note_lifecycle"]) assert.ok(harness.includes(token), token);
  assert.ok(harness.includes('observedLockWaits >= 8'));
  assert.ok(harness.includes("new Set(pids).size, 3"));
});
test('the harness has no production, Supabase, host-port or data-reset target', () => {
  for (const token of ['CAP_NOTES_RACE_URL', 'CAP_NOTES_RACE_ACK', 'DISPOSABLE_LOCAL_CLUSTER_ONLY']) {
    assert.ok(harness.includes(token), token);
  }
  assert.equal(harness.includes('supabase.co'), false);
  assert.equal(harness.includes('SUPABASE'), false);
  assert.equal(harness.includes('DROP DATABASE'), false);
  assert.equal(harness.includes('drop database'), false);
  assert.equal(harness.includes('localStorage'), false);
  assert.equal(harness.includes('IndexedDB'), false);
  assert.equal(harness.includes('CAP_SUPABASE'), false);
});
test('the snapshot fixture installs the real notes draft, not a synthetic RPC', () => {
  assert.ok(snapshotFixture.includes('supabase_production_notes_sidecar.sql'));
  assert.ok(snapshotFixture.includes('notesDraft'));
  assert.ok(snapshotFixture.includes("set cap.notes_sidecar_install='reviewed-draft-only'"));
  assert.ok(snapshotFixture.includes('backfill_lifecycle'));
  assert.equal(snapshotFixture.includes('FIXTURE_ONLY'), false);
});
test('global readiness keeps the creation grants and full notes function contract', () => {
  assert.ok(readiness.includes("has_table_privilege(notes_writer_oid,'public.notes','INSERT')"));
  assert.ok(readiness.includes("has_table_privilege(notes_writer_oid,'cap_notes_private.note_lifecycle','INSERT')"));
  assert.ok(readiness.includes("not has_table_privilege(notes_writer_oid,'public.notes','DELETE,TRUNCATE,REFERENCES,TRIGGER')"));
  assert.ok(readiness.includes("not has_table_privilege(notes_writer_oid,'cap_notes_private.note_lifecycle','DELETE,TRUNCATE,REFERENCES,TRIGGER')"));
  assert.ok(readiness.includes('notes_read_contract'));
  assert.ok(readiness.includes('notes_verify_contract'));
  assert.ok(readiness.includes("and notes_change_contract and notes_read_contract and notes_verify_contract"));
  assert.ok(readiness.includes("and not has_table_privilege('authenticated','public.notes'"));
});
console.log(`PASS: ${passed} production notes-sidecar real-harness guards; no Docker or database started`);
