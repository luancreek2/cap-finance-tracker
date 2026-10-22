/* Harness target validation only. This does NOT run or simulate DB races. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const { validateTarget } = require('./manual/notes-lifecycle-races.cjs');
const ack = 'DISPOSABLE_LOCAL_CLUSTER_ONLY', local = 'postgresql://synthetic:secret@127.0.0.1:55432/cap_notes_race_lab_012345abcdef';
let passed = 0;
for (const [label, url, acknowledgement] of [
  ['loopback IPv4', local, ack],
  ['loopback IPv6', 'postgres://synthetic@[::1]/cap_notes_race_lab_abcdef012345', ack],
]) { assert.ok(validateTarget(url, acknowledgement).database.startsWith('cap_notes_race_lab_'), label); passed++; }
for (const [label, url, acknowledgement] of [
  ['no explicit acknowledgement', local, null], ['wrong acknowledgement', local, 'yes'],
  ['remote host', local.replace('127.0.0.1', 'example.com'), ack],
  ['Supabase hostname', local.replace('127.0.0.1', 'db.project.supabase.co'), ack],
  ['DNS loopback name not literal', local.replace('127.0.0.1', 'localhost'), ack],
  ['non-loopback IP', local.replace('127.0.0.1', '192.168.1.2'), ack],
  ['default postgres database', local.replace('cap_notes_race_lab_012345abcdef', 'postgres'), ack],
  ['app database', local.replace('cap_notes_race_lab_012345abcdef', 'cap-finance'), ack],
  ['unbounded lab name', local.replace('012345abcdef', 'test'), ack],
  ['query host override', local + '?host=example.com', ack],
  ['query options', local + '?options=-csearch_path=public', ack],
  ['fragment', local + '#private', ack], ['wrong protocol', local.replace('postgresql:', 'https:'), ack],
  ['missing URL', undefined, ack], ['missing username', local.replace('synthetic:secret@', ''), ack],
  ['encoded database slash', local.replace('012345abcdef', '012345abc%2fdef'), ack],
]) { assert.throws(() => validateTarget(url, acknowledgement), /^Error: DISPOSABLE_LOCAL_POSTGRES_REQUIRED$/, label); passed++; }
const source = fs.readFileSync(`${__dirname}/manual/notes-lifecycle-races.cjs`, 'utf8');
assert.ok(source.includes('pg_blocking_pids')); assert.ok(source.includes('new Set(pids).size, 3')); passed++;
assert.ok(!/drop\s+(database|schema|role|table)/i.test(source)); passed++;
assert.ok(source.includes('posture.extra_roles !== 0')); assert.ok(source.includes('posture.extra_databases !== 0')); passed++;
console.log(`PASS: ${passed} race-harness guard/static checks; this suite does not execute database races`);
