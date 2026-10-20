/* Atomic IndexedDB rehearsal for removing ONLY a verified notes-test recovery
   checkpoint. Uses an isolated fake database; never the app's real database.
   Install fake-indexeddb externally; set CAP_FAKE_IDB_PATH when needed.
   Run: node tests/notes-recovery-idb.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const fake = require(process.env.CAP_FAKE_IDB_PATH || 'fake-indexeddb');
const context = { indexedDB: new fake.IDBFactory(), crypto: webcrypto, TextEncoder, URLSearchParams,
  location: { search: '' }, localStorage: { getItem: () => null } };
context.window = context;
vm.createContext(context);
const app = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
vm.runInContext(app.slice(0, app.indexOf('  /* ---------- events ---------- */')) + '})();', context);
const off = context.CapOff;
const clone = x => JSON.parse(JSON.stringify(x));
const owner = 'fixture-owner';
const originalLocal = JSON.stringify([{ id: 1, t: 'Title', b: 'Body', d: '2026-10-20' }]);
const financial = JSON.stringify({ accts: [], tx: [], pend: [], xfer: [], bills: [], goals: [], debts: [], budgets: {} });
const checkpoint = { id: 'checkpoint-1', owner, original: { id: 'note-id', legacy_id: '1', title: 'Title', body: 'Body', note_date: '2026-10-20' },
  originalLocal, financial, created_at: '2026-10-20T00:00:00.000Z', phase: 'restore', operationId: 'op-1' };
const baseline = { version: 2, user_id: owner, fingerprint: 'fixture', records: [] };
const receipt = { userId: owner, checkpoint, expectedBaseline: baseline, expectedLocalNotes: originalLocal, expectedFinancial: financial };
let passed = 0;
const readCheckpoint = () => off.syncStore('syncmeta', 'get', 'controlled-notes-test-v1');
const readBaseline = () => off.syncStore('syncmeta', 'get', 'baseline');
const readQueue = () => off.syncStore('outbox', 'all');
async function reset() {
  await off.syncStore('syncmeta', 'clear'); await off.syncStore('outbox', 'clear');
  await off.syncStore('syncmeta', 'put', clone(baseline), 'baseline');
  await off.syncStore('syncmeta', 'put', clone(checkpoint), 'controlled-notes-test-v1');
}
async function unchanged() {
  assert.equal(JSON.stringify(await readBaseline()), JSON.stringify(baseline));
  assert.equal(JSON.stringify(await readCheckpoint()), JSON.stringify(checkpoint));
  assert.equal((await readQueue()).length, 0);
}
async function test(label, body) { await reset(); await body(); passed++; }

(async () => {
  await test('verified checkpoint removed only', async () => {
    const r = await off.discardVerifiedNotesRecoveryCheckpoint(receipt, () => true);
    assert.equal(r.committed, true); assert.equal(r.verified, true); assert.equal(r.removed, true);
    assert.equal(await readCheckpoint(), undefined);
    assert.equal(JSON.stringify(await readBaseline()), JSON.stringify(baseline));
    assert.equal((await readQueue()).length, 0);
  });
  await test('unrelated sync metadata preserved', async () => {
    await off.syncStore('syncmeta', 'put', { keep: true }, 'keep-me');
    await off.discardVerifiedNotesRecoveryCheckpoint(receipt, () => true);
    assert.equal(JSON.stringify(await off.syncStore('syncmeta', 'get', 'keep-me')), '{"keep":true}');
  });
  await test('second removal is rejected', async () => {
    await off.discardVerifiedNotesRecoveryCheckpoint(receipt, () => true);
    await assert.rejects(off.discardVerifiedNotesRecoveryCheckpoint(receipt, () => true));
    assert.equal(await readCheckpoint(), undefined);
    assert.equal(JSON.stringify(await readBaseline()), JSON.stringify(baseline));
  });
  for (const [label, change] of [
    ['wrong owner', { ...receipt, userId: 'other' }],
    ['wrong local notes', { ...receipt, expectedLocalNotes: '[]' }],
    ['wrong financial snapshot', { ...receipt, expectedFinancial: '{}' }],
    ['wrong baseline version', { ...receipt, expectedBaseline: { ...baseline, version: 1 } }],
    ['wrong baseline owner', { ...receipt, expectedBaseline: { ...baseline, user_id: 'other' } }],
    ['missing checkpoint', { ...receipt, checkpoint: null }],
    ['invalid checkpoint phase', { ...receipt, checkpoint: { ...checkpoint, phase: 'unknown' } }],
    ['missing original note', { ...receipt, checkpoint: { ...checkpoint, original: null } }],
  ]) await test(label, async () => {
    await assert.rejects(off.discardVerifiedNotesRecoveryCheckpoint(change, () => true));
    await unchanged();
  });
  await test('changed baseline blocks removal', async () => {
    await off.syncStore('syncmeta', 'put', { ...clone(baseline), revision: 1 }, 'baseline');
    await assert.rejects(off.discardVerifiedNotesRecoveryCheckpoint(receipt, () => true));
    assert.equal((await readCheckpoint()).id, checkpoint.id);
    assert.equal((await readQueue()).length, 0);
  });
  await test('changed checkpoint blocks removal', async () => {
    await off.syncStore('syncmeta', 'put', { ...clone(checkpoint), phase: 'test' }, 'controlled-notes-test-v1');
    await assert.rejects(off.discardVerifiedNotesRecoveryCheckpoint(receipt, () => true));
    assert.equal((await readCheckpoint()).phase, 'test');
    assert.equal(JSON.stringify(await readBaseline()), JSON.stringify(baseline));
  });
  await test('pending outbox blocks removal', async () => {
    await off.syncStore('outbox', 'put', { id: 'pending', entity: 'notes', user_id: owner });
    await assert.rejects(off.discardVerifiedNotesRecoveryCheckpoint(receipt, () => true));
    assert.equal((await readCheckpoint()).id, checkpoint.id);
    assert.equal((await readQueue()).length, 1);
  });
  await test('demo refresh checkpoint blocks removal', async () => {
    await off.syncStore('syncmeta', 'put', { phase: 'applied' }, 'demo-local-refresh-state-v1');
    await assert.rejects(off.discardVerifiedNotesRecoveryCheckpoint(receipt, () => true));
    assert.equal((await readCheckpoint()).id, checkpoint.id);
    assert.equal((await readQueue()).length, 0);
  });
  for (const guard of [undefined, () => false, () => Promise.resolve(true), () => { throw Error('local changed'); }]) await test('guard fails closed', async () => {
    await assert.rejects(off.discardVerifiedNotesRecoveryCheckpoint(receipt, guard));
    await unchanged();
  });
  await test('delete failure rolls back the checkpoint', async () => {
    const original = fake.IDBObjectStore.prototype.delete;
    fake.IDBObjectStore.prototype.delete = function (key) { if (this.name === 'syncmeta') throw Error('Injected delete failure'); return original.call(this, key); };
    try { await assert.rejects(off.discardVerifiedNotesRecoveryCheckpoint(receipt, () => true)); }
    finally { fake.IDBObjectStore.prototype.delete = original; }
    await unchanged();
  });
  await test('postcommit read failure is distinguishable', async () => {
    const original = fake.IDBDatabase.prototype.transaction;
    fake.IDBDatabase.prototype.transaction = function (stores, mode) { if (mode === 'readonly') throw Error('Injected verification failure'); return original.call(this, stores, mode); };
    try { await assert.rejects(off.discardVerifiedNotesRecoveryCheckpoint(receipt, () => true), error => error.committed === true && error.message === 'LOCAL WRITE OCCURRED — VERIFICATION FAILED'); }
    finally { fake.IDBDatabase.prototype.transaction = original; }
    assert.equal(await readCheckpoint(), undefined);
    assert.equal(JSON.stringify(await readBaseline()), JSON.stringify(baseline));
    assert.equal((await readQueue()).length, 0);
  });
  console.log(`PASS: ${passed} atomic notes recovery checkpoint checks; isolated database only`);
})().catch(error => { console.error(error); process.exit(1); });
