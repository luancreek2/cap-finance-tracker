/* Target/opt-in guards for the real PostgreSQL snapshot/readiness harness.
   Static + invocation checks only; never starts Docker or a database. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateInvocation, validName, Session } = require('./manual/snapshot-readiness-races.cjs');
const source = fs.readFileSync(`${__dirname}/manual/snapshot-readiness-races.cjs`, 'utf8');
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; }
  catch (e) { e.message = name + ': ' + e.message; throw e; }
};
test('explicit disposable-docker opt-in is mandatory', () => {
  assert.throws(() => validateInvocation({}), /FRESH_DISPOSABLE_DOCKER_ONLY/);
  assert.throws(() => validateInvocation({ CAP_SNAPSHOT_RACE_ACK: 'YES' }), /FRESH_DISPOSABLE_DOCKER_ONLY/);
  assert.doesNotThrow(() => validateInvocation({ CAP_SNAPSHOT_RACE_ACK: 'CREATE_DISPOSABLE_DOCKER_ONLY' }));
});
test('database URL and existing-container targets are rejected', () => {
  assert.throws(() => validateInvocation({ CAP_SNAPSHOT_RACE_ACK: 'CREATE_DISPOSABLE_DOCKER_ONLY',
    CAP_SNAPSHOT_RACE_URL: 'postgres://production' }), /FRESH_DISPOSABLE_DOCKER_ONLY/);
  assert.throws(() => validateInvocation({ CAP_SNAPSHOT_RACE_ACK: 'CREATE_DISPOSABLE_DOCKER_ONLY',
    CAP_SNAPSHOT_RACE_CONTAINER: 'existing' }), /FRESH_DISPOSABLE_DOCKER_ONLY/);
});
test('only uniquely suffixed disposable names are accepted', () => {
  assert.equal(validName('cap-snapshot-lab-' + 'a'.repeat(12)), true);
  for (const value of ['cap-snapshot-lab-short', 'cap-snapshot-lab-' + 'A'.repeat(12),
    'cap-snapshot-lab-' + 'a'.repeat(13), 'postgres', 'cap-snapshot-lab-' + 'a'.repeat(12) + 'x']) {
    assert.equal(validName(value), false, value);
  }
  assert.throws(() => new Session('cap-snapshot-lab-short', 'cap_snapshot_' + 'a'.repeat(12)),
    /INVALID_DISPOSABLE_TARGET/);
  assert.throws(() => new Session('cap-snapshot-lab-' + 'a'.repeat(12), 'production'),
    /INVALID_DISPOSABLE_TARGET/);
});
test('cluster is network-none, tmpfs-only and has no host ports/volumes', () => {
  for (const token of ["'--network', 'none'", "'--tmpfs', '/var/lib/postgresql/data:rw'",
    "'postgres:17'", "POSTGRES_PASSWORD=", "HostConfig.NetworkMode, 'none'",
    "Object.keys(inspection.HostConfig.PortBindings || {}).length, 0",
    "m.Type === 'bind' || m.Type === 'volume'"]) assert.ok(source.includes(token), token);
  assert.equal(source.includes("'--publish'"), false);
  assert.equal(source.includes("'-p'"), false);
});
test('cleanup is restricted to the exact unique label', () => {
  assert.ok(source.includes("cap.snapshot-readiness-test=' + suffix"));
  assert.ok(source.includes("inspection.Config.Labels['cap.snapshot-readiness-test'] !== suffix"));
  assert.ok(source.includes("docker(['rm', '--force', name])"));
  assert.ok(source.includes("validName(name)"));
});
test('no ambient URL/container target is used as a database target', () => {
  assert.equal((source.match(/CAP_SNAPSHOT_RACE_URL/g) || []).length, 1);
  assert.equal((source.match(/CAP_SNAPSHOT_RACE_CONTAINER/g) || []).length, 1);
  assert.ok(!/psql[^\n]*CAP_SNAPSHOT_RACE_URL/.test(source));
  assert.ok(!/docker[^\n]*CAP_SNAPSHOT_RACE_CONTAINER/.test(source));
});
test('the real harness opens independent backends and checks read-only state', () => {
  assert.ok(source.includes("new Set(pids).size, 7"));
  assert.ok(source.includes("'REAL_SERVER_READ_ONLY'"));
  assert.ok(source.includes("'REAL_SERVER_CONCURRENT_WRITE_SNAPSHOT'"));
  assert.ok(source.includes('SNAPSHOT_SIDECAR_INCOMPLETE'));
  assert.ok(source.includes('SNAPSHOT_CONTRACT_NOT_VERIFIED'));
});
console.log(`PASS: ${passed} snapshot/readiness real-harness guards; no Docker or database started`);
