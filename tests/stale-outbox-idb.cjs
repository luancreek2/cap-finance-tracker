/* Optional atomic queue-only cleanup tests. External fake-indexeddb required;
   set CAP_FAKE_IDB_PATH, then node tests/stale-outbox-idb.cjs. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const fake = require(process.env.CAP_FAKE_IDB_PATH || 'fake-indexeddb');
const context = { indexedDB: new fake.IDBFactory() }; context.window = context;
vm.createContext(context);
const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
vm.runInContext(source.slice(0, source.indexOf('  /* ---------- events ---------- */')) + '})();', context);
const off = context.CapOff, clone = x => JSON.parse(JSON.stringify(x));
const owner = 'fixture-owner', recordId = '00000000-0000-4000-8000-000000000011';
const entries = [1, 2, 3].map(n => ({ id: 'stale-' + n, user_id: owner, entity: 'accounts', operation: 'upsert', local_id: recordId, supabase_id: recordId,
  payload: { id: recordId, user_id: owner, name: 'CAP SYNC ENGINE TEST', legacy_id: 'phase6-test-' + recordId } }));
const baseline = { version: 2, user_id: owner, records: [{ entity: 'notes', localId: 'unrelated', supabase_id: 'unrelated-id', contentFingerprint: 'a'.repeat(64) }] };
const unrelated = { id: 'real-operation', entity: 'notes', user_id: owner, local_id: 'unrelated' };
const receipt = () => ({ userId: owner, entries: clone(entries), expectedBaseline: clone(baseline) });
const readBase = () => off.syncStore('syncmeta', 'get', 'baseline');
const readQueue = () => off.syncStore('outbox', 'all');
let passed = 0;
async function reset() { await off.syncStore('syncmeta', 'clear'); await off.syncStore('outbox', 'clear'); await off.syncStore('syncmeta', 'put', clone(baseline), 'baseline'); for (const op of [...entries, unrelated]) await off.syncStore('outbox', 'put', clone(op)); }
async function test(fn) { await reset(); await fn(); passed++; }
(async () => {
  await test(async () => {
    const original = fake.IDBObjectStore.prototype.put;
    fake.IDBObjectStore.prototype.put = function () { throw Error('Cleanup must never write baseline or app data'); };
    let result; try { result = await off.discardVerifiedTestOutbox(receipt(), () => true); } finally { fake.IDBObjectStore.prototype.put = original; }
    assert.equal(result.removed, 3); assert.equal(result.verified, true);
    assert.deepEqual(clone(await readBase()), baseline); assert.deepEqual(clone(await readQueue()), [unrelated]);
  });
  for (const guard of [undefined, () => false, () => Promise.resolve(true), () => { throw Error('Local record appeared'); }]) await test(async () => {
    await assert.rejects(off.discardVerifiedTestOutbox(receipt(), guard)); assert.equal((await readQueue()).length, 4); assert.deepEqual(clone(await readBase()), baseline);
  });
  await test(async () => {
    const changed = { ...entries[1], retry_count: 1 }; await off.syncStore('outbox', 'put', changed);
    await assert.rejects(off.discardVerifiedTestOutbox(receipt(), () => true)); assert.equal((await readQueue()).length, 4);
  });
  await test(async () => {
    await off.syncStore('outbox', 'delete', entries[1].id);
    await assert.rejects(off.discardVerifiedTestOutbox(receipt(), () => true)); assert.equal((await readQueue()).length, 3);
  });
  await test(async () => {
    await off.syncStore('syncmeta', 'put', { id: 'recovery' }, 'controlled-notes-test-v1');
    await assert.rejects(off.discardVerifiedTestOutbox(receipt(), () => true)); assert.equal((await readQueue()).length, 4);
  });
  await test(async () => {
    const b = { ...baseline, revision: 1 }; await off.syncStore('syncmeta', 'put', b, 'baseline');
    await assert.rejects(off.discardVerifiedTestOutbox(receipt(), () => true)); assert.deepEqual(clone(await readBase()), b);
  });
  await test(async () => {
    const b = clone(baseline); b.records.push({ entity: 'accounts', localId: recordId, supabase_id: recordId }); await off.syncStore('syncmeta', 'put', b, 'baseline');
    await assert.rejects(off.discardVerifiedTestOutbox({ ...receipt(), expectedBaseline: b }, () => true)); assert.equal((await readQueue()).length, 4);
  });
  for (const mutate of [r => { r.entries.pop(); }, r => { r.entries.push(clone(entries[0])); }, r => { r.entries[0].payload.name = 'Not a harness record'; }, r => { r.entries[0].user_id = 'other'; }, r => { r.entries[1].id = r.entries[0].id; }]) await test(async () => {
    const r = receipt(); mutate(r); await assert.rejects(off.discardVerifiedTestOutbox(r, () => true)); assert.equal((await readQueue()).length, 4);
  });
  await test(async () => {
    const original = fake.IDBObjectStore.prototype.delete; let calls = 0;
    fake.IDBObjectStore.prototype.delete = function (key) { if (this.name === 'outbox' && ++calls === 2) throw Error('Injected second-delete failure'); return original.call(this, key); };
    try { await assert.rejects(off.discardVerifiedTestOutbox(receipt(), () => true)); } finally { fake.IDBObjectStore.prototype.delete = original; }
    assert.equal((await readQueue()).length, 4, 'All three deletions must roll back together'); assert.deepEqual(clone(await readBase()), baseline);
  });
  await test(async () => {
    const original = fake.IDBDatabase.prototype.transaction;
    fake.IDBDatabase.prototype.transaction = function (stores, mode) { if (mode === 'readonly') throw Error('Injected read-back failure'); return original.call(this, stores, mode); };
    try { await assert.rejects(off.discardVerifiedTestOutbox(receipt(), () => true), error => error.committed === true); } finally { fake.IDBDatabase.prototype.transaction = original; }
    assert.deepEqual(clone(await readQueue()), [unrelated]); assert.deepEqual(clone(await readBase()), baseline);
  });
  console.log(`PASS: ${passed} atomic stale-outbox IndexedDB checks; isolated database only`);
})().catch(error => { console.error(error); process.exitCode = 1; });
