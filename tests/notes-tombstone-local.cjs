/* Backup-first local staging in a disposable fake IDB; no app or cloud boot. */
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const fake = require(process.env.CAP_FAKE_IDB_PATH || 'fake-indexeddb');
let externalAccess = 0;
function load(file) {
  const c = { module: { exports: {} }, crypto: webcrypto, TextEncoder };
  for (const name of ['window', 'document', 'fetch', 'navigator', 'localStorage', 'indexedDB', 'setTimeout'])
    Object.defineProperty(c, name, { get() { externalAccess++; throw Error('Forbidden ambient access'); } });
  vm.createContext(c); vm.runInContext(fs.readFileSync(`${__dirname}/../js/${file}`, 'utf8'), c); return c.module.exports;
}
const planner = load('notes-tombstone-plan.js'), local = load('notes-tombstone-local.js');
const clone = x => JSON.parse(JSON.stringify(x)), checkpointKey = 'manual-notes-tombstone-v1';
const owner = 'owner-secret', noteId = '00000000-0000-4000-8000-000000000011', operationId = '00000000-0000-4000-8000-000000000021';
const hash = r => createHash('sha256').update(JSON.stringify({ body: r.body, note_date: r.note_date, title: r.title })).digest('hex');
const lifecycle = () => ({ version: 1, revision: 4, deleted_at: null, operation_id: null });
function safe(report) {
  assert.ok(!/owner-secret|body-secret|title-secret|financial-secret|private-error|00000000-0000-4000-8000-000000000011/.test(JSON.stringify(report)));
  assert.equal(externalAccess, 0);
}
async function fixture() {
  const f = { calls: 0, confirms: 0, consent: true, activeOwner: owner, syncOff: true };
  f.factory = new fake.IDBFactory();
  const request = f.factory.open('isolated-tombstone-stage', 1);
  request.onupgradeneeded = () => { request.result.createObjectStore('kv'); request.result.createObjectStore('syncmeta'); request.result.createObjectStore('outbox', { keyPath: 'id' }); };
  f.db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  f.store = (store, method, value, key) => new Promise((resolve, reject) => {
    const t = f.db.transaction(store, method === 'get' || method === 'getAll' ? 'readonly' : 'readwrite'), q = t.objectStore(store)[method](value, key);
    let result; q.onsuccess = () => { result = q.result; }; t.oncomplete = () => resolve(result); t.onabort = () => reject(t.error); t.onerror = () => reject(t.error);
  });
  f.state = { _mt: 10, notes: [{ id: 1, t: 'title-secret', b: 'body-secret', d: '2026-10-20', custom: 'retained' },
    { id: 2, t: 'Unrelated note', b: 'unrelated', d: null }], accts: [{ id: 3, bal: 125, label: 'financial-secret' }],
    tx: [], pend: [], xfer: [], bills: [], goals: [], debts: [], budgets: {}, preference: 'retained' };
  f.originalJson = JSON.stringify(f.state); f.ls = f.originalJson;
  const row = { id: noteId, user_id: owner, legacy_id: '1', title: 'title-secret', body: 'body-secret', note_date: '2026-10-20' };
  const baseline = { version: 2, user_id: owner, records: [{ entity: 'notes', localId: '1', supabase_id: noteId, user_id: owner, contentFingerprint: hash(row), lifecycle: lifecycle() },
    { entity: 'accounts', localId: '3', supabase_id: 'account-secret', user_id: owner, contentFingerprint: 'a'.repeat(64) }] };
  f.evidence = { operationId, requestedAt: 20, localJson: f.originalJson, snapshot: { version: 1, owner, syncOff: true, persisted: true,
    capabilities: { version: 'notes-lifecycle-v1', read: true, cas: true, bypassProtected: true },
    coverage: { complete: true, unrelatedUnchanged: true }, entries: [], checkpoints: { test: null, demo: null, pull: null, tombstone: null }, baseline,
    target: { entity: 'notes', localId: '1', supabase_id: noteId }, local: { kind: 'active', row: clone(row) }, cloud: { kind: 'row', row: clone(row), lifecycle: lifecycle() } } };
  await f.store('kv', 'put', { json: f.originalJson, mt: 10 }, 'state'); await f.store('syncmeta', 'put', clone(baseline), 'baseline');
  f.adapters = { database: f.db, planner, getState: () => f.state,
    setState: value => { if (f.failSet) throw Error('private-error'); f.state = value; },
    readLocalStorage: () => { if (f.failReadLs) throw Error('private-error'); return f.ls; },
    writeLocalStorage: value => { if (f.failWriteLs) throw Error('private-error'); f.ls = value; },
    guard: user => f.activeOwner === user && f.syncOff === true,
    withLock: async (name, run) => { assert.equal(name, 'cap-controlled-notes-test'); if (f.lockHeld) throw Error('private-error'); f.lockHeld = true; try { return await run(); } finally { f.lockHeld = false; } } };
  f.api = local.create(f.adapters);
  f.action = { inspect: async () => { f.calls++; if (f.onInspect) await f.onInspect(f.calls); return clone(f.evidence); },
    confirm: async () => { f.confirms++; if (f.onConfirm) await f.onConfirm(); return f.consent; },
    readCloud: async () => { f.cloudReads = (f.cloudReads || 0) + 1; if (f.onCloudRead) await f.onCloudRead(); return clone(f.evidence.snapshot.cloud); } };
  f.preview = () => f.api.preview(f.evidence);
  f.stage = async () => { const p = await f.preview(); assert.equal(p.previewReady, true); return f.api.stage(p.ticket, f.action); };
  f.remote = () => { f.evidence.snapshot.cloud.lifecycle = { version: 1, revision: 7, deleted_at: '2026-10-21T00:00:00.000Z', operation_id: 'remote-operation-secret' }; };
  f.applyRemote = async () => { const p = await f.api.previewRemote(f.evidence); assert.equal(p.previewReady, true); return f.api.applyRemote(p.ticket, f.action); };
  f.cp = () => f.store('syncmeta', 'get', checkpointKey);
  f.base = () => f.store('syncmeta', 'get', 'baseline');
  f.kv = () => f.store('kv', 'get', 'state');
  f.backups = async () => (await f.store('syncmeta', 'getAll')).filter(x => x?.kind === 'manual-note-tombstone-backup');
  return f;
}
let passed = 0;
async function test(label, run) { try { await run(); passed++; } catch (e) { e.message = label + ': ' + e.message; throw e; } }
async function unchanged(f) {
  assert.equal(JSON.stringify(f.state), f.originalJson); assert.equal(f.ls, f.originalJson); assert.equal((await f.kv()).json, f.originalJson);
  assert.deepEqual(await f.base(), f.evidence.snapshot.baseline); assert.equal((await f.store('outbox', 'getAll')).length, 0);
}
(async () => {
  await test('prototype exports no cloud writer or restoration API', async () => {
    const f = await fixture(); assert.deepEqual(Object.keys(f.api).sort(), ['applyRemote', 'exportRecovery', 'inspectExport', 'inspectRecovery', 'preview', 'previewRemote', 'stage']);
    for (const file of ['index.html', 'service-worker.js']) assert.ok(!fs.readFileSync(`${__dirname}/../${file}`, 'utf8').includes('notes-tombstone-local.js'));
  });
  await test('preview is read-only and redacted', async () => {
    const f = await fixture(), r = await f.preview(); safe(r); assert.equal(r.previewReady, true);
    await unchanged(f); assert.equal(await f.cp(), undefined); assert.equal((await f.backups()).length, 0); assert.equal(f.confirms, 0);
  });
  await test('cancellation creates no backup or checkpoint', async () => {
    const f = await fixture(); f.consent = false; const r = await f.stage(); safe(r); assert.match(r.status, /CANCELLED/);
    await unchanged(f); assert.equal(await f.cp(), undefined); assert.equal((await f.backups()).length, 0);
  });
  await test('verified backup precedes removal; state and checkpoint commit together', async () => {
    const f = await fixture(); f.onInspect = async n => { if (n === 3) {
      await unchanged(f); assert.equal((await f.cp()).phase, 'prepared'); const backups = await f.backups();
      assert.equal(backups.length, 1); assert.equal(backups[0].expectedLocalJson, f.originalJson); assert.deepEqual(backups[0].originalCloud, f.evidence.snapshot.cloud);
    } };
    const r = await f.stage(); safe(r); assert.equal(r.staged, true); assert.equal(r.verified, true); assert.equal(r.cloudWritten, false);
    assert.equal(f.confirms, 1); assert.equal(f.state.notes.length, 1); assert.equal(f.state.notes[0].id, 2);
    assert.equal(f.state.noteTombstones.length, 1); const tomb = f.state.noteTombstones[0];
    assert.equal(tomb.intent.original.body, 'body-secret'); assert.equal(tomb.intent.operation_id, operationId); assert.equal(tomb.acknowledged, null);
    assert.equal(f.state._mt, 20); assert.equal((await f.cp()).phase, 'local-staged'); assert.equal((await f.backups()).length, 1);
    assert.equal(f.ls, JSON.stringify(f.state)); assert.equal((await f.kv()).json, f.ls);
    assert.deepEqual(await f.base(), f.evidence.snapshot.baseline); assert.deepEqual(clone(f.state.accts), JSON.parse(f.originalJson).accts);
    assert.equal((await f.store('outbox', 'getAll')).length, 0);
    const report = await f.api.inspectRecovery(); safe(report); assert.match(report.status, /LOCAL STAGE VERIFIED/); assert.match(report.cloudEvidence, /NOT CHECKED/);
  });
  await test('database reopen and adapter replacement preserve tombstone, backup, and recovery', async () => {
    const f = await fixture(); await f.stage(); f.db.close();
    const request = f.factory.open('isolated-tombstone-stage', 1);
    f.db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    f.state = JSON.parse((await f.kv()).json); f.ls = JSON.stringify(f.state);
    const reloaded = local.create({ ...f.adapters, database: f.db }), report = await reloaded.inspectRecovery(); safe(report);
    assert.match(report.status, /LOCAL STAGE VERIFIED/); assert.equal((await f.backups()).length, 1); assert.equal(f.state.noteTombstones.length, 1);
  });
  await test('private export round trip validates without import or restore', async () => {
    const f = await fixture(); await f.stage(); const before = JSON.stringify(f.state), bundle = await f.api.exportRecovery();
    assert.equal(bundle.exported, true); assert.ok(bundle.privateJson.includes('body-secret'));
    const r = await f.api.inspectExport(bundle.privateJson); safe(r); assert.equal(r.valid, true); assert.match(r.status, /NO IMPORT OR RESTORE/);
    assert.equal(JSON.stringify(f.state), before);
  });
  for (const [label, change] of [
    ['old content-only JSON', () => ({ notes: [] })],
    ['missing original cloud', b => { delete b.backup.originalCloud; return b; }],
    ['changed desired state', b => { b.checkpoint.nextLocalJson = '{}'; return b; }],
    ['unknown format', b => { b.format = 'old'; return b; }],
    ['old prototype checkpoint version', b => { b.checkpoint.version = 1; return b; }],
  ]) await test(label + ' cannot be imported as lifecycle evidence', async () => {
    const f = await fixture(); await f.stage(); const bundle = await f.api.exportRecovery(), before = JSON.stringify(f.state);
    const report = await f.api.inspectExport(JSON.stringify(change(JSON.parse(bundle.privateJson)))); safe(report); assert.equal(report.valid, false);
    assert.equal(JSON.stringify(f.state), before);
  });
  await test('owner switch blocks inspection and private export', async () => {
    const f = await fixture(); await f.stage(); const bundle = await f.api.exportRecovery(); f.activeOwner = 'another-owner';
    safe(await f.api.inspectRecovery()); assert.match((await f.api.inspectRecovery()).status, /BLOCKED/);
    const r = await f.api.exportRecovery(); safe(r); assert.equal(r.exported, false); assert.equal(r.privateJson, undefined);
    assert.equal((await f.api.inspectExport(bundle.privateJson)).valid, false);
  });
  for (const [label, mutate] of [
    ['changed body', f => { f.state.notes[0].b = 'new'; f.ls = JSON.stringify(f.state); }],
    ['sync enabled', f => { f.syncOff = false; }],
    ['owner switched', f => { f.activeOwner = 'another'; }],
    ['localStorage stale', f => { f.ls = '{}'; }],
  ]) await test(label + ' during confirmation prevents staging', async () => {
    const f = await fixture(); f.onConfirm = () => mutate(f); const r = await f.stage(); safe(r); assert.equal(r.staged, false);
    assert.equal(await f.cp(), undefined); assert.equal((await f.backups()).length, 0); assert.equal((await f.kv()).json, f.originalJson);
  });
  await test('cloud evidence changes after backup: original and prepared checkpoint retained', async () => {
    const f = await fixture(); f.onInspect = n => { if (n === 3) f.evidence.snapshot.cloud.lifecycle.revision++; };
    const r = await f.stage(); safe(r); assert.match(r.status, /BACKUP\/CHECKPOINT RETAINED/); await unchanged(f);
    assert.equal((await f.cp()).phase, 'prepared'); assert.equal((await f.backups()).length, 1);
    assert.match((await f.api.inspectRecovery()).status, /NOT STAGED/);
  });
  await test('backup staging abort rolls back checkpoint and backup together', async () => {
    const f = await fixture(), original = fake.IDBObjectStore.prototype.add;
    fake.IDBObjectStore.prototype.add = function (v, k) { if (k === checkpointKey) throw Error('private-error'); return original.call(this, v, k); };
    try { const r = await f.stage(); safe(r); assert.equal(r.staged, false); } finally { fake.IDBObjectStore.prototype.add = original; }
    await unchanged(f); assert.equal(await f.cp(), undefined); assert.equal((await f.backups()).length, 0);
  });
  await test('failure between state and checkpoint rolls state back', async () => {
    const f = await fixture(), original = fake.IDBObjectStore.prototype.put;
    fake.IDBObjectStore.prototype.put = function (v, k) { if (k === checkpointKey && v.phase === 'local-staged') throw Error('private-error'); return original.call(this, v, k); };
    try { const r = await f.stage(); safe(r); assert.match(r.status, /LOCAL NOTE NOT REMOVED/); } finally { fake.IDBObjectStore.prototype.put = original; }
    await unchanged(f); assert.equal((await f.cp()).phase, 'prepared');
  });
  for (const failure of ['failSet', 'failWriteLs']) await test(failure + ' after commit retains durable staged recovery', async () => {
    const f = await fixture(); f[failure] = true; const r = await f.stage(); safe(r); assert.equal(r.committed, true);
    assert.match(r.status, /LOCAL STAGE COMMITTED/); assert.equal((await f.cp()).phase, 'local-staged');
    assert.equal(JSON.parse((await f.kv()).json).notes.length, 1); assert.equal((await f.backups()).length, 1);
    assert.deepEqual(await f.base(), f.evidence.snapshot.baseline); assert.match((await f.api.inspectRecovery()).status, /BLOCKED/);
  });
  await test('tampered backup prevents state replacement', async () => {
    const f = await fixture(); f.onInspect = async n => { if (n === 3) { const cp = await f.cp(), backup = (await f.backups())[0]; delete backup.originalCloud; await f.store('syncmeta', 'put', backup, cp.backupKey); } };
    const r = await f.stage(); safe(r); assert.match(r.status, /LOCAL NOTE NOT REMOVED/); await unchanged(f);
    assert.equal((await f.api.inspectRecovery()).backupVerified, false); assert.equal((await f.api.exportRecovery()).exported, false);
  });
  await test('post-commit read failure is never reported as an untouched note', async () => {
    const f = await fixture(), original = fake.IDBDatabase.prototype.transaction; let committed = false;
    const set = f.adapters.setState;
    const api = local.create({ ...f.adapters, setState: value => { set(value); committed = true; } });
    fake.IDBDatabase.prototype.transaction = function (stores, mode) {
      if (committed && mode === 'readonly') throw Error('private-error'); return original.call(this, stores, mode);
    };
    try {
      const p = await api.preview(f.evidence), r = await api.stage(p.ticket, f.action); safe(r);
      assert.equal(r.committed, true); assert.match(r.status, /LOCAL STAGE COMMITTED/);
    } finally { fake.IDBDatabase.prototype.transaction = original; }
    assert.equal((await f.cp()).phase, 'local-staged'); assert.equal((await f.backups()).length, 1);
  });
  await test('prepared checkpoint survives a failed final evidence read', async () => {
    const f = await fixture(); f.onInspect = n => { if (n === 3) throw Error('private-error'); };
    const r = await f.stage(); safe(r); assert.match(r.status, /LOCAL NOTE NOT REMOVED/); await unchanged(f);
    assert.equal((await f.cp()).phase, 'prepared'); assert.equal((await f.backups()).length, 1);
  });
  await test('pending outbox preserved and blocked before confirmation', async () => {
    const f = await fixture(); await f.store('outbox', 'put', { id: 'pending-secret' }); const r = await f.stage(); safe(r);
    assert.equal(f.confirms, 0); assert.equal((await f.store('outbox', 'getAll')).length, 1); assert.equal(await f.cp(), undefined);
  });
  for (const key of [checkpointKey, 'manual-notes-pull-v1', 'controlled-notes-test-v1', 'demo-local-refresh-state-v1']) {
    await test('existing ' + key + ' preserved', async () => {
      const f = await fixture(); await f.store('syncmeta', 'put', { retained: true }, key); const r = await f.stage(); safe(r);
      assert.equal(f.confirms, 0); assert.deepEqual(await f.store('syncmeta', 'get', key), { retained: true }); assert.equal((await f.backups()).length, 0);
    });
  }
  await test('baseline drift blocks with no implicit reset', async () => {
    const f = await fixture(), b = clone(f.evidence.snapshot.baseline); b.revision = 99; await f.store('syncmeta', 'put', b, 'baseline');
    const r = await f.stage(); safe(r); assert.equal(f.confirms, 0); assert.deepEqual(await f.base(), b); assert.equal(await f.cp(), undefined);
  });
  await test('two adapter instances cannot stage the same note twice', async () => {
    const f = await fixture(), second = local.create(f.adapters), p = await f.preview();
    const results = await Promise.all([f.api.stage(p.ticket, f.action), second.stage(p.ticket, f.action)]);
    results.forEach(safe); assert.equal(results.filter(r => r.staged).length, 1); assert.equal(f.state.noteTombstones.length, 1); assert.equal((await f.backups()).length, 1);
  });
  await test('stale preview ticket never prompts', async () => {
    const f = await fixture(), r = await f.api.stage('a'.repeat(64), f.action); safe(r); assert.equal(f.confirms, 0); await unchanged(f);
  });
  for (const guard of [() => false, () => Promise.resolve(true), () => { throw Error('private-error'); }]) {
    await test('synchronous guard fails closed', async () => { const f = await fixture(), api = local.create({ ...f.adapters, guard });
      const r = await api.preview(f.evidence); safe(r); assert.equal(r.previewReady, false); await unchanged(f); });
  }
  await test('recovery with foreign edits cannot report verified', async () => {
    const f = await fixture(); await f.stage(); f.state.accts[0].bal++; f.ls = JSON.stringify(f.state);
    await f.store('kv', 'put', { json: f.ls, mt: f.state._mt }, 'state');
    const r = await f.api.inspectRecovery(); safe(r); assert.equal(r.unrelatedStateUnchanged, false); assert.match(r.status, /BLOCKED/);
  });
  await test('empty inspector performs no writes', async () => {
    const f = await fixture(), r = await f.api.inspectRecovery(); safe(r); assert.equal(r.present, false); await unchanged(f);
  });
  await test('existing or malformed tombstone collections block new stage', async () => {
    for (const tombstones of [null, {}, [{ id: 'existing' }]]) {
      const f = await fixture(), e = clone(f.evidence), state = JSON.parse(e.localJson); state.noteTombstones = tombstones; e.localJson = JSON.stringify(state);
      f.state = state; f.ls = e.localJson; const r = await f.api.preview(e); safe(r); assert.equal(r.previewReady, false); assert.equal(await f.cp(), undefined);
    }
  });
  await test('remote preview reads only and does not stage intent', async () => {
    const f = await fixture(); f.remote(); const r = await f.api.previewRemote(f.evidence); safe(r);
    assert.equal(r.previewReady, true); await unchanged(f); assert.equal(await f.cp(), undefined); assert.equal((await f.backups()).length, 0);
  });
  await test('remote cancellation keeps active note and baseline untouched', async () => {
    const f = await fixture(); f.remote(); f.consent = false; const r = await f.applyRemote(); safe(r);
    assert.match(r.status, /CANCELLED/); await unchanged(f); assert.equal((await f.backups()).length, 0); assert.equal(await f.cp(), undefined);
  });
  await test('remote apply commits note, retained evidence, and one baseline acknowledgement', async () => {
    const f = await fixture(); f.remote(); f.onInspect = async n => { if (n === 3) { await unchanged(f); assert.equal((await f.cp()).phase, 'prepared'); assert.equal((await f.backups()).length, 1); } };
    const r = await f.applyRemote(); safe(r); assert.equal(r.applied, true); assert.equal(r.cloudWritten, false); assert.equal(r.verified, true);
    assert.equal(f.state.notes.length, 1); const tomb = f.state.noteTombstones[0];
    assert.equal(tomb.origin, 'cloud'); assert.equal(tomb.intent, undefined); assert.equal(tomb.original.body, 'body-secret');
    assert.deepEqual(clone(tomb.acknowledged.lifecycle), f.evidence.snapshot.cloud.lifecycle);
    const b = await f.base(); assert.equal(b.revision, 1); assert.equal(b.records[0].contentFingerprint, f.evidence.snapshot.baseline.records[0].contentFingerprint);
    assert.deepEqual(b.records[0].lifecycle, f.evidence.snapshot.cloud.lifecycle); assert.deepEqual(b.records[1], f.evidence.snapshot.baseline.records[1]);
    assert.equal(await f.cp(), undefined); assert.equal((await f.backups()).length, 1); assert.equal((await f.store('outbox', 'getAll')).length, 0);
    assert.deepEqual(clone(f.state.accts), JSON.parse(f.originalJson).accts); assert.equal(f.ls, (await f.kv()).json); assert.equal(f.cloudReads, 1);
    const s = clone(f.evidence.snapshot); s.baseline = b; s.local = { kind: 'remote-tombstone', original: tomb.original, acknowledged: tomb.acknowledged };
    const agreed = await planner.plan(s); safe(agreed); assert.equal(agreed.classification, 'DELETION_ACKNOWLEDGED');
  });
  for (const [label, mutate] of [
    ['local edit', f => { f.evidence.snapshot.local.row.body = 'new'; f.state.notes[0].b = 'new'; f.evidence.localJson = JSON.stringify(f.state); f.ls = f.evidence.localJson; }],
    ['missing cloud', f => { f.evidence.snapshot.cloud = { kind: 'missing' }; }],
    ['unreadable cloud', f => { f.evidence.snapshot.cloud = { kind: 'unreadable' }; }],
    ['active cloud', f => { f.evidence.snapshot.cloud.lifecycle = lifecycle(); }],
    ['cloud title changed', f => { f.evidence.snapshot.cloud.row.title = 'new'; }],
  ]) await test(label + ' blocks remote application preview', async () => {
    const f = await fixture(); f.remote(); mutate(f); const r = await f.api.previewRemote(f.evidence); safe(r);
    assert.equal(r.previewReady, false); assert.equal(await f.cp(), undefined); assert.equal((await f.backups()).length, 0);
  });
  await test('remote evidence change during confirmation stops before backup', async () => {
    const f = await fixture(); f.remote(); f.onConfirm = () => { f.evidence.snapshot.cloud.lifecycle.revision++; };
    const r = await f.applyRemote(); safe(r); assert.equal(r.applied, undefined); await unchanged(f); assert.equal(await f.cp(), undefined);
  });
  await test('remote evidence change after backup retains prepared state', async () => {
    const f = await fixture(); f.remote(); f.onInspect = n => { if (n === 3) f.evidence.snapshot.cloud.lifecycle.revision++; };
    const r = await f.applyRemote(); safe(r); assert.match(r.status, /LOCAL NOTE NOT REMOVED/); await unchanged(f); assert.equal((await f.cp()).phase, 'prepared');
  });
  await test('remote baseline put failure rolls local state back too', async () => {
    const f = await fixture(); f.remote(); const put = fake.IDBObjectStore.prototype.put;
    fake.IDBObjectStore.prototype.put = function (v, k) { if (this.name === 'syncmeta' && k === 'baseline') throw Error('private-error'); return put.call(this, v, k); };
    try { const r = await f.applyRemote(); safe(r); assert.match(r.status, /LOCAL NOTE NOT REMOVED/); } finally { fake.IDBObjectStore.prototype.put = put; }
    await unchanged(f); assert.equal((await f.cp()).phase, 'prepared');
  });
  for (const failure of ['failSet', 'failWriteLs']) await test('remote ' + failure + ' retains applied recovery', async () => {
    const f = await fixture(); f.remote(); f[failure] = true; const r = await f.applyRemote(); safe(r);
    assert.equal(r.committed, true); assert.match(r.status, /LOCAL TOMBSTONE APPLIED/); assert.equal((await f.cp()).phase, 'applied');
    assert.equal((await f.base()).revision, 1); assert.equal(JSON.parse((await f.kv()).json).notes.length, 1);
    const report = await f.api.inspectRecovery({ readCloud: f.action.readCloud }); safe(report); assert.match(report.status, /BLOCKED/);
  });
  await test('post-apply cloud read failure retains data and checkpoint, without retry', async () => {
    const f = await fixture(); f.remote(); f.onCloudRead = () => { throw Error('private-error'); };
    const r = await f.applyRemote(); safe(r); assert.equal(r.committed, true); assert.equal(f.cloudReads, 1); assert.equal((await f.cp()).phase, 'applied');
    assert.equal((await f.base()).revision, 1); const report = await f.api.inspectRecovery(); safe(report); assert.match(report.cloudEvidence, /NOT PROVEN/); assert.match(report.status, /BLOCKED/);
  });
  await test('post-apply cloud divergence never cleans up or claims convergence', async () => {
    const f = await fixture(); f.remote(); f.onCloudRead = () => { f.evidence.snapshot.cloud.lifecycle.revision++; };
    const r = await f.applyRemote(); safe(r); assert.equal(r.committed, true); assert.equal((await f.cp()).phase, 'applied');
    f.onCloudRead = null; const report = await f.api.inspectRecovery({ readCloud: f.action.readCloud }); safe(report); assert.match(report.status, /BLOCKED/); assert.match(report.cloudEvidence, /DIFFERS/);
  });
  await test('remote cleanup failure is inspectable but never automatically cleaned up', async () => {
    const f = await fixture(); f.remote(); const del = fake.IDBObjectStore.prototype.delete;
    fake.IDBObjectStore.prototype.delete = function (k) { if (this.name === 'syncmeta' && k === checkpointKey) throw Error('private-error'); return del.call(this, k); };
    try { const r = await f.applyRemote(); safe(r); assert.equal(r.committed, true); assert.equal(r.checkpointRetained, true); } finally { fake.IDBObjectStore.prototype.delete = del; }
    assert.equal((await f.cp()).phase, 'applied'); const report = await f.api.inspectRecovery({ readCloud: f.action.readCloud }); safe(report);
    assert.match(report.status, /REMOTE TOMBSTONE DATA VERIFIED/); assert.equal((await f.cp()).phase, 'applied');
    const bundle = await f.api.exportRecovery(); assert.equal(bundle.exported, true); assert.equal((await f.api.inspectExport(bundle.privateJson)).valid, true);
  });
  await test('remote staged database survives reopen with acknowledgement and backup', async () => {
    const f = await fixture(); f.remote(); await f.applyRemote(); f.db.close(); const q = f.factory.open('isolated-tombstone-stage', 1);
    f.db = await new Promise(resolve => { q.onsuccess = () => resolve(q.result); });
    f.state = JSON.parse((await f.kv()).json); assert.equal(f.state.noteTombstones[0].origin, 'cloud');
    assert.equal((await f.base()).records[0].lifecycle.deleted_at, f.evidence.snapshot.cloud.lifecycle.deleted_at);
    assert.equal((await f.backups()).length, 1); assert.equal(await f.cp(), undefined);
  });
  await test('remote apply requires an explicit cloud reader and cannot consume a staging ticket', async () => {
    const f = await fixture(), p = await f.preview(); f.remote();
    const wrong = await f.api.applyRemote(p.ticket, f.action); safe(wrong); assert.equal(f.confirms, 0); assert.equal(await f.cp(), undefined);
    const remote = await f.api.previewRemote(f.evidence), action = { ...f.action }; delete action.readCloud;
    safe(await f.api.applyRemote(remote.ticket, action)); assert.equal(f.confirms, 0); assert.equal(await f.cp(), undefined);
  });
  await test('recovery refuses local drift occurring during cloud inspection', async () => {
    const f = await fixture(); f.remote(); f.onCloudRead = () => { throw Error('private-error'); }; await f.applyRemote();
    f.onCloudRead = async () => { const b = await f.base(); b.revision++; await f.store('syncmeta', 'put', b, 'baseline'); };
    const report = await f.api.inspectRecovery({ readCloud: f.action.readCloud }); safe(report); assert.match(report.status, /BLOCKED/);
  });
  await test('completed remote operation cannot be replayed to acknowledge twice', async () => {
    const f = await fixture(); f.remote(); const p = await f.api.previewRemote(f.evidence); await f.api.applyRemote(p.ticket, f.action);
    const confirms = f.confirms, r = await f.api.applyRemote(p.ticket, f.action); safe(r);
    assert.equal(r.applied, undefined); assert.equal((await f.base()).revision, 1); assert.equal(f.confirms, confirms); assert.equal((await f.backups()).length, 1);
  });
  await test('failed read-back after cleanup reports checkpoint absence accurately', async () => {
    const f = await fixture(); f.remote(); const del = fake.IDBObjectStore.prototype.delete, tx = fake.IDBDatabase.prototype.transaction;
    let deleted = false;
    fake.IDBObjectStore.prototype.delete = function (key) { const result = del.call(this, key); if (key === checkpointKey) deleted = true; return result; };
    fake.IDBDatabase.prototype.transaction = function (stores, mode) { if (deleted && mode === 'readonly') throw Error('private-error'); return tx.call(this, stores, mode); };
    try {
      const r = await f.applyRemote(); safe(r); assert.equal(r.committed, true); assert.equal(r.checkpointRetained, false); assert.equal(r.backupRetained, true);
    } finally { fake.IDBObjectStore.prototype.delete = del; fake.IDBDatabase.prototype.transaction = tx; }
    assert.equal(await f.cp(), undefined); assert.equal((await f.backups()).length, 1); assert.equal((await f.base()).revision, 1);
  });
  assert.equal(externalAccess, 0);
  console.log(`PASS: ${passed} isolated local/remote tombstone persistence checks; no cloud writer or app wiring`);
})().catch(error => { console.error(error); process.exitCode = 1; });
