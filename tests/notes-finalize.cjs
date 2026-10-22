/* Optional IndexedDB transaction rehearsal, never the app's real database.
   Install fake-indexeddb externally; set CAP_FAKE_IDB_PATH to its module path.
   Run: node tests/notes-finalize.cjs */
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
// Load the actual offline-layer definitions, without booting UI/event hooks.
const app = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
vm.runInContext(app.slice(0, app.indexOf('  /* ---------- events ---------- */')) + '})();', context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/sync.js'), 'utf8'), context);
const off = context.CapOff, sync = context.CapSync;
const clone = x => JSON.parse(JSON.stringify(x));
const owner = 'fixture-owner', id = '00000000-0000-4000-8000-000000000011';
const old = { entity: 'notes', localId: '1', supabase_id: id, user_id: owner, contentFingerprint: 'a'.repeat(64) };
const unrelated = { ...old, localId: '2', supabase_id: id.replace(/11$/, '12') };
const payload = { id, user_id: owner, legacy_id: '1', title: 'Test', body: 'new', note_date: '2026-10-20' };
const entry = { id: 'op-1', entity: 'notes', local_id: '1', supabase_id: id, operation: 'upsert', user_id: owner, payload };
const next = { ...old, contentFingerprint: 'b'.repeat(64), last_operation_id: entry.id };
const receipt = { userId: owner, entry, expectedRecord: old, nextRecord: next };
let passed = 0;
const baseline = () => off.syncStore('syncmeta', 'get', 'baseline');
const queue = () => off.syncStore('outbox', 'all');
async function reset({ insert = false } = {}) {
  await off.syncStore('syncmeta', 'clear'); await off.syncStore('outbox', 'clear');
  await off.syncStore('syncmeta', 'put', { version: 2, user_id: owner, fingerprint: 'legacy-init-snapshot', records: insert ? [clone(unrelated)] : [clone(old), clone(unrelated)] }, 'baseline');
  await off.syncStore('outbox', 'put', clone(entry));
}
async function test(label, body) { await reset(); await body(); passed++; }

(async () => {
  await test('atomic acknowledgement', async () => {
    const r = await off.finalizeVerifiedNotePush(receipt, () => true);
    assert.equal(r.committed, true); assert.equal(r.verified, true);
    assert.equal((await queue()).length, 0);
    const b = await baseline();
    assert.equal(b.records.length, 2); assert.equal(b.revision, 1); assert.equal(b.aggregateFingerprintStale, true);
    assert.deepEqual(clone(b.records[0]), next); assert.deepEqual(clone(b.records[1]), unrelated);
    assert.equal(b.fingerprint, 'legacy-init-snapshot', 'Legacy whole-snapshot fingerprint is not claimed current');
  });
  await test('idempotent acknowledgement retry', async () => {
    await off.finalizeVerifiedNotePush(receipt, () => true);
    const r = await off.finalizeVerifiedNotePush(receipt, () => true);
    assert.equal(r.alreadyFinalized, true); assert.equal((await baseline()).revision, 1);
  });
  await test('double acknowledgement', async () => {
    await Promise.all([off.finalizeVerifiedNotePush(receipt, () => true), off.finalizeVerifiedNotePush(receipt, () => true)]);
    assert.equal((await baseline()).revision, 1); assert.equal((await queue()).length, 0);
  });
  await test('new note appended once', async () => {
    await reset({ insert: true });
    await off.finalizeVerifiedNotePush({ ...receipt, expectedRecord: null }, () => true);
    const b = await baseline(); assert.equal(b.records.length, 2); assert.deepEqual(clone(b.records[0]), unrelated);
  });
  for (const guard of [undefined, () => false, () => Promise.resolve(true), () => { throw Error('Local changed'); }]) await test('guard fails closed', async () => {
    await assert.rejects(off.finalizeVerifiedNotePush(receipt, guard));
    assert.deepEqual(clone((await baseline()).records[0]), old); assert.equal((await queue()).length, 1);
  });
  for (const change of [
    b => { b.records[0].contentFingerprint = 'c'.repeat(64); },
    b => { b.user_id = 'other'; },
    b => { b.records.push(clone(old)); },
    b => { b.records.push({ ...old, supabase_id: unrelated.supabase_id }); },
  ]) await test('stale or ambiguous baseline', async () => {
    const b = await baseline(); change(b); await off.syncStore('syncmeta', 'put', b, 'baseline');
    const before = JSON.stringify(await baseline());
    await assert.rejects(off.finalizeVerifiedNotePush(receipt, () => true));
    assert.equal(JSON.stringify(await baseline()), before); assert.equal((await queue()).length, 1);
  });
  await test('changed outbox retained', async () => {
    const changed = { ...clone(entry), retry_count: 2 }; await off.syncStore('outbox', 'put', changed);
    await assert.rejects(off.finalizeVerifiedNotePush(receipt, () => true));
    assert.deepEqual(clone((await baseline()).records[0]), old); assert.deepEqual(clone((await queue())[0]), changed);
  });
  await test('missing outbox is not successful acknowledgement', async () => {
    await off.syncStore('outbox', 'delete', entry.id);
    await assert.rejects(off.finalizeVerifiedNotePush(receipt, () => true));
    assert.deepEqual(clone((await baseline()).records[0]), old);
  });
  await test('unrelated baseline and queue edits preserved', async () => {
    const b = await baseline(); b.records[1].cloud_updated_at = 'unrelated-update';
    await off.syncStore('syncmeta', 'put', b, 'baseline');
    await off.syncStore('outbox', 'put', { ...entry, id: 'op-other', local_id: '2' });
    await off.finalizeVerifiedNotePush(receipt, () => true);
    assert.equal((await baseline()).records[1].cloud_updated_at, 'unrelated-update');
    assert.equal((await queue())[0].id, 'op-other');
  });
  await test('abort between baseline put and queue delete rolls back BOTH', async () => {
    const original = fake.IDBObjectStore.prototype.delete;
    fake.IDBObjectStore.prototype.delete = function (key) { if (this.name === 'outbox') throw Error('Injected cleanup failure'); return original.call(this, key); };
    try { await assert.rejects(off.finalizeVerifiedNotePush(receipt, () => true)); }
    finally { fake.IDBObjectStore.prototype.delete = original; }
    assert.deepEqual(clone((await baseline()).records[0]), old); assert.equal((await queue()).length, 1);
  });
  await test('postcommit read failure is distinguishable', async () => {
    const original = fake.IDBDatabase.prototype.transaction;
    fake.IDBDatabase.prototype.transaction = function (stores, mode) { if (mode === 'readonly') throw Error('Injected verification failure'); return original.call(this, stores, mode); };
    try { await assert.rejects(off.finalizeVerifiedNotePush(receipt, () => true), error => error.committed === true && error.message === 'LOCAL WRITE OCCURRED — VERIFICATION FAILED'); }
    finally { fake.IDBDatabase.prototype.transaction = original; }
    assert.deepEqual(clone((await baseline()).records[0]), next); assert.equal((await queue()).length, 0);
  });
  await test('pipeline connected to actual atomic IDB helper', async () => {
    let remote = { ...payload, body: 'old' }, writes = 0;
    const b = await baseline(); b.records[0].contentFingerprint = await sync.contentFingerprint(remote);
    await off.syncStore('syncmeta', 'put', b, 'baseline');
    const result = await sync.rehearseNotePush(entry.id, {
      currentUser: async () => ({ id: owner }),
      readState: async () => ({ baseline: await baseline(), entries: await queue() }),
      readLocal: async () => clone(payload),
      readCloud: async () => remote === null ? null : { row: clone(remote), lifecycle: { version: 1, revision: 1, deleted_at: null, operation_id: null } },
      ready: async () => true,
      cas: async args => { writes++; remote = { id, user_id: owner, ...clone(args.p_desired) }; return { status: 'APPLIED' }; },
      finalize: r => off.finalizeVerifiedNotePush(r, () => true),
    });
    assert.equal(result.finalized, true); assert.equal(writes, 1);
    assert.equal((await queue()).length, 0); assert.equal((await baseline()).records[0].contentFingerprint, await sync.contentFingerprint(remote));
  });
  console.log(`PASS: ${passed} atomic notes IndexedDB checks; isolated database only`);
})().catch(error => { console.error(error); process.exitCode = 1; });
