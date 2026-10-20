/* Optional backup-first local demo storage tests. External fake-indexeddb;
   set CAP_FAKE_IDB_PATH, then node tests/demo-refresh-idb.cjs. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const fake = require(process.env.CAP_FAKE_IDB_PATH || 'fake-indexeddb');
const clone = x => JSON.parse(JSON.stringify(x));
const owner = 'fixture-owner', backupKey = 'demo-local-refresh-backup:fixture';
const oldState = { accts: [], tx: [], pend: [], notes: 'old demo', _mt: 1 };
const newState = { accts: [], tx: [], pend: [], notes: 'new demo', _mt: 1 };
const oldBaseline = { version: 2, user_id: owner, fingerprint: 'old', records: [] };
const nextBaseline = { version: 2, user_id: owner, fingerprint: 'new', records: [{ entity: 'notes', user_id: owner, localId: '1', supabase_id: 'fixture-note', contentFingerprint: 'a'.repeat(64) }] };
let state, allowed, failLS;
const ls = new Map();
const context = { indexedDB: new fake.IDBFactory(), localStorage: {
  getItem: k => ls.get(k) ?? null,
  setItem: (k, v) => { if (failLS && k === 'pera') throw Error('Quota'); ls.set(k, v); },
  removeItem: k => ls.delete(k),
} };
context.window = context; vm.createContext(context);
const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
vm.runInContext(source.slice(0, source.indexOf('  /* ---------- events ---------- */')) + '})();', context);
const off = context.CapOff;
off.init({ get: () => state, set: s => { state = s; } });
const receipt = () => ({ userId: owner, expectedLocalJson: JSON.stringify(oldState), expectedBaseline: clone(oldBaseline), nextState: clone(newState), nextBaseline: clone(nextBaseline), backupKey });
const get = key => off.syncStore('syncmeta', 'get', key);
const run = (cloud = async () => true) => off.refreshVerifiedLocalDemo(receipt(), () => allowed, cloud);
let passed = 0;
async function reset() {
  state = clone(oldState); allowed = true; failLS = false; ls.clear();
  ls.set('pera', JSON.stringify(state)); ls.set('cap_balance_anchors_v1', 'old-anchors'); ls.set('cap_derived_balance', '0'); ls.set('cap_supabase_session', 'untouched-auth');
  await off.syncStore('syncmeta', 'clear'); await off.syncStore('outbox', 'clear');
  await off.syncStore('syncmeta', 'put', clone(oldBaseline), 'baseline');
  const d = await new Promise((resolve, reject) => { const r = context.indexedDB.open('cap-finance', 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  await new Promise((resolve, reject) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put({ json: JSON.stringify(oldState), mt: 1 }, 'state'); t.oncomplete = resolve; t.onabort = reject; }); d.close();
}
async function test(fn) { await reset(); await fn(); passed++; }
(async () => {
  await test(async () => {
    let checked = false;
    const r = await run(async () => { checked = true; assert.ok(await get(backupKey), 'Backup must be committed before rechecking cloud'); assert.deepEqual(clone(await get('baseline')), oldBaseline); assert.deepEqual(clone(state), oldState); return true; });
    assert.equal(checked, true); assert.equal(r.verified, true); assert.equal(r.records, 1);
    assert.equal(state.notes, 'new demo'); assert.equal(JSON.parse(ls.get('pera')).notes, 'new demo'); assert.ok(state._mt > oldState._mt);
    assert.deepEqual(clone(await get('baseline')), nextBaseline); assert.equal(await get('demo-local-refresh-state-v1'), undefined);
    const b = await get(backupKey); assert.equal(b.localJson, JSON.stringify(oldState)); assert.deepEqual(clone(b.baseline), oldBaseline);
    assert.equal(b.anchors, 'old-anchors'); assert.equal(b.derivedFlag, '0'); assert.equal(ls.has('cap_balance_anchors_v1'), false);
    assert.equal(ls.get('cap_derived_balance'), '0'); assert.equal(ls.get('cap_supabase_session'), 'untouched-auth');
  });
  await test(async () => {
    await assert.rejects(run(async () => false), error => error.backedUp === true && error.committed === false);
    assert.deepEqual(clone(state), oldState); assert.deepEqual(clone(await get('baseline')), oldBaseline); assert.ok(await get(backupKey));
  });
  await test(async () => { allowed = false; await assert.rejects(run()); assert.equal(await get(backupKey), undefined); });
  await test(async () => { await assert.rejects(run(async () => { ls.set('cap_balance_anchors_v1', 'new-user-anchors'); return true; })); assert.equal(ls.get('cap_balance_anchors_v1'), 'new-user-anchors'); assert.deepEqual(clone(await get('baseline')), oldBaseline); });
  await test(async () => { ls.set('pera', 'another-tab-state'); await assert.rejects(run()); assert.equal(await get(backupKey), undefined); });
  await test(async () => { await off.syncStore('outbox', 'put', { id: 'pending' }); await assert.rejects(run()); assert.equal(await get(backupKey), undefined); });
  for (const key of ['controlled-notes-test-v1', 'demo-local-refresh-state-v1']) await test(async () => { await off.syncStore('syncmeta', 'put', { recovery: true }, key); await assert.rejects(run()); assert.equal(await get(backupKey), undefined); });
  await test(async () => { await off.syncStore('syncmeta', 'put', { retained: 'older-backup' }, backupKey); await assert.rejects(run()); assert.equal((await get(backupKey)).retained, 'older-backup'); });
  await test(async () => {
    await assert.rejects(run(async () => { state.notes = 'new local edit'; ls.set('pera', JSON.stringify(state)); return true; }));
    assert.equal(state.notes, 'new local edit'); assert.deepEqual(clone(await get('baseline')), oldBaseline);
  });
  await test(async () => {
    await assert.rejects(run(async () => { await off.syncStore('outbox', 'put', { id: 'arrived-after-backup' }); return true; }));
    assert.deepEqual(clone(await get('baseline')), oldBaseline); assert.deepEqual(clone(state), oldState);
  });
  await test(async () => {
    const original = fake.IDBObjectStore.prototype.put;
    fake.IDBObjectStore.prototype.put = function (value, key) { if (this.name === 'syncmeta' && key === 'baseline' && value.fingerprint === 'new') throw Error('Injected baseline write failure'); return original.call(this, value, key); };
    try { await assert.rejects(run(), error => error.backedUp === true && error.committed === false); } finally { fake.IDBObjectStore.prototype.put = original; }
    assert.deepEqual(clone(await get('baseline')), oldBaseline); assert.deepEqual(clone(state), oldState); assert.ok(await get(backupKey));
    assert.equal((await off.localSnapshot()).indexeddb.state.json, JSON.stringify(oldState), 'State put must roll back with baseline put');
  });
  await test(async () => {
    failLS = true; await assert.rejects(run(), error => error.committed === true && error.message === 'LOCAL WRITE OCCURRED — VERIFICATION FAILED');
    assert.deepEqual(clone(await get('baseline')), nextBaseline); assert.equal((await get('demo-local-refresh-state-v1')).phase, 'applied'); assert.ok(await get(backupKey));
  });
  await test(async () => {
    const original = fake.IDBObjectStore.prototype.delete;
    fake.IDBObjectStore.prototype.delete = function (key) { if (key === 'demo-local-refresh-state-v1') throw Error('Injected checkpoint cleanup failure'); return original.call(this, key); };
    try { await assert.rejects(run(), error => error.committed === true); } finally { fake.IDBObjectStore.prototype.delete = original; }
    assert.equal(state.notes, 'new demo'); assert.ok(await get(backupKey)); assert.equal((await get('demo-local-refresh-state-v1')).phase, 'applied');
  });
  await test(async () => { const r = receipt(); r.nextBaseline.user_id = 'other'; await assert.rejects(off.refreshVerifiedLocalDemo(r, () => true, async () => true)); assert.equal(await get(backupKey), undefined); });
  console.log(`PASS: ${passed} backup-first demo IndexedDB checks; isolated database only`);
})().catch(error => { console.error(error); process.exitCode = 1; });
