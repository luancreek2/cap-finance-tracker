/* Confirmation/revalidation controller, entirely simulated.
   node tests/stale-outbox-cleanup.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const context = { crypto: webcrypto, TextEncoder, URLSearchParams, location: { search: '' }, localStorage: { getItem: () => null } };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/sync.js'), 'utf8'), context);
let passed = 0;
const run = context.CapSync.cleanupStaleTestOutbox;
function fixture() {
  const f = { reads: 0, commits: 0, confirmed: false };
  f.io = {
    withLock: callback => callback(),
    inspect: async () => { f.reads++; return { entries: [{ id: 'one' }, { id: 'two' }, { id: 'three' }], ticket: 'same-verified-snapshot' }; },
    confirm: async () => { f.confirmed = true; return true; },
    commit: async () => { assert.ok(f.confirmed); assert.equal(f.reads, 2); f.commits++; return { committed: true, verified: true, removed: 3 }; },
  };
  return f;
}
async function test(fn) { await fn(); passed++; }
(async () => {
  await test(async () => { const f = fixture(), r = await run(f.io); assert.equal(r.removed, 3); assert.equal(f.commits, 1); });
  await test(async () => { const f = fixture(); f.io.confirm = async () => false; const r = await run(f.io); assert.equal(r.removed, 0); assert.ok(r.status.includes('CANCELLED')); assert.equal(f.commits, 0); });
  for (const count of [0, 2, 4]) await test(async () => { const f = fixture(); f.io.inspect = async () => ({ entries: Array(count).fill({}), ticket: 'same' }); assert.equal((await run(f.io)).removed, 0); assert.equal(f.confirmed, false); assert.equal(f.commits, 0); });
  await test(async () => { const f = fixture(); f.io.inspect = async () => ({ entries: [{}, {}, {}], ticket: 'revision-' + ++f.reads }); assert.equal((await run(f.io)).removed, 0); assert.equal(f.commits, 0); });
  await test(async () => { const f = fixture(); f.io.inspect = async () => ({ entries: ++f.reads === 1 ? [{}, {}, {}] : [], ticket: 'same' }); assert.equal((await run(f.io)).removed, 0); assert.equal(f.commits, 0); });
  await test(async () => { const f = fixture(); f.io.withLock = async () => { throw Error('private lock error'); }; const r = await run(f.io); assert.equal(r.removed, 0); assert.equal(f.confirmed, false); assert.ok(!r.status.includes('private')); });
  await test(async () => { const f = fixture(); f.io.inspect = async () => { throw Error('private cloud error'); }; assert.equal((await run(f.io)).removed, 0); assert.equal(f.commits, 0); });
  await test(async () => { const f = fixture(); f.io.commit = async () => { throw Error('Aborted transaction'); }; assert.equal((await run(f.io)).removed, 0); });
  await test(async () => { const f = fixture(); f.io.commit = async () => ({ committed: true, verified: false, removed: 3 }); const r = await run(f.io); assert.equal(r.status, 'LOCAL WRITE OCCURRED — VERIFICATION FAILED'); assert.equal(r.removed, null); });
  await test(async () => { const f = fixture(), results = await Promise.all([run(f.io), run(f.io)]); assert.equal(results.filter(r => r.removed === 3).length, 1); assert.equal(f.commits, 1); });
  await test(async () => assert.equal((await run()).removed, 0));
  console.log(`PASS: ${passed} confirmed stale-outbox cleanup checks; simulated adapters only`);
})().catch(error => { console.error(error); process.exitCode = 1; });
