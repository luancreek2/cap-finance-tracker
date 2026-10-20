/* Pull UI + backup/apply transactions. Isolated fake IndexedDB and mocked
   cloud GETs only. CAP_FAKE_IDB_PATH may point to an external installation. */
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const fake = require(process.env.CAP_FAKE_IDB_PATH || 'fake-indexeddb');
const clone = x => JSON.parse(JSON.stringify(x));
const app = fs.readFileSync(`${__dirname}/../js/app.js`, 'utf8'), sync = fs.readFileSync(`${__dirname}/../js/sync.js`, 'utf8'), manual = fs.readFileSync(`${__dirname}/../js/notes-manual.js`, 'utf8');
const owner = 'owner-secret', id = '00000000-0000-4000-8000-000000000011', checkpointKey = 'manual-notes-pull-v1';
class Element {
  constructor() { this.children = []; this.style = {}; this._text = ''; }
  set textContent(s) { this._text = s; this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute() {}
}
async function fixture() {
  const f = { cloudWrites: 0, reads: 0, exactReads: 0, consents: 0, consent: true };
  const storage = new Map(), S = { _mt: 1, notes: [{ id: 1, t: 'title-secret', b: 'original-secret', d: '2026-10-20', _u: 1, custom: 'keep' }],
    accts: [{ id: 2, bal: 10 }], tx: [], pend: [], xfer: [], bills: [], goals: [], debts: [], budgets: {}, preference: 'keep' };
  const row = () => ({ id, user_id: f.owner || owner, legacy_id: '1', title: c.S.notes[0].t, body: c.S.notes[0].b, note_date: c.S.notes[0].d });
  const account = () => ({ id: 'account', user_id: f.owner || owner, legacy_id: '2', balance: c.S.accts[0].bal });
  const profile = { id: owner }, preferences = { user_id: owner, currency: 'PHP' };
  const c = { indexedDB: new fake.IDBFactory(), crypto: webcrypto, TextEncoder, URLSearchParams, location: { search: '' }, S,
    clearTimeout() {}, document: { createElement: () => new Element() },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => { if (f.failLocalStorage && k === 'pera') throw Error('Storage denied'); storage.set(k, v); } },
    navigator: { locks: { request: async (name, options, callback) => { assert.equal(name, 'cap-controlled-notes-test'); return callback(f.locked ? null : {}); } } },
    migrationPrepare: () => ({ blockingProblems: [] }),
    buildSupabaseMigrationPlan: () => ({ userId: f.owner || owner, tables: [['notes', [row()]], ['accounts', [account()]]], profile, preferences }),
    confirm: () => { f.consents++; if (f.onConfirm) f.onConfirm(); return f.consent; },
  };
  c.window = c; storage.set('cap_dev_tools', '1'); vm.createContext(c);
  vm.runInContext(app.slice(0, app.indexOf('  /* ---------- events ---------- */')) + '})();', c);
  vm.runInContext(sync, c); vm.runInContext(manual, c);
  c.CapOff.init({ get: () => c.S, set: value => { if (f.failSet) throw Error('Set failed'); c.S = value; } });
  f.cloud = clone(row()); f.originalCloud = clone(f.cloud); f.cloudAccount = clone(account());
  c.CapSupabase = {
    currentUser: async () => { if (f.authFails) throw Error('private auth error'); return { id: f.owner || owner }; }, status: () => ({ userId: f.owner || owner }),
    validateRealData: async () => {
      f.reads++; if (f.failRead) throw Error('private cloud error');
      const result = { missingCount: 0, unexpectedCount: 0, mismatchCount: 0, foreignKeyErrorCount: 0,
        snapshot: { notes: [clone(f.cloud)], accounts: [clone(f.cloudAccount)], profiles: [profile], user_preferences: [preferences] } };
      if (f.mutateValidation) f.mutateValidation(result); return result;
    },
    syncRequest: async (url, options) => {
      if (options) { f.cloudWrites++; throw Error('Forbidden cloud mutation'); }
      f.exactReads++; if (f.onExactRead) await f.onExactRead();
      if (f.failRead) throw Error('private read error');
      return f.absent ? [] : [clone(f.cloud)];
    },
  };
  const p = c.buildSupabaseMigrationPlan(), validation = await c.CapSupabase.validateRealData(p);
  const records = await c.CapSync.recordFingerprints(p, validation);
  f.baseline = { version: 2, user_id: owner, records: clone(records).map(({ cloudContentFingerprint, canonicalDiffs, ...r }) => r) };
  await c.CapOff.syncStore('syncmeta', 'put', clone(f.baseline), 'baseline');
  storage.set('pera', JSON.stringify(S)); await c.CapOff.syncStore('kv', 'put', { json: JSON.stringify(S), mt: 1 }, 'state');
  f.originalJson = JSON.stringify(S); f.cloud.body = 'cloud-secret';
  f.c = c; f.off = c.CapOff; f.storage = storage;
  f.base = () => f.off.syncStore('syncmeta', 'get', 'baseline'); f.queue = () => f.off.syncStore('outbox', 'all'); f.checkpoint = () => f.off.syncStore('syncmeta', 'get', checkpointKey);
  f.kv = () => f.off.syncStore('kv', 'get', 'state');
  f.persist = async () => { storage.set('pera', JSON.stringify(c.S)); await f.off.syncStore('kv', 'put', { json: JSON.stringify(c.S), mt: c.S._mt || 0 }, 'state'); };
  f.parent = new Element(); c.CapManualNotes.mount(f.parent);
  f.preview = async () => { await f.parent.children[2].onclick(); return f.parent.children[3]; };
  f.action = async () => { const out = f.parent.children[3]; assert.equal(out.children.length, 1, out.textContent); await out.children[0].onclick(); return out.textContent; };
  f.direct = async (guard = () => true, verify = async () => true, patch = {}) => {
    const expectedRecord = clone(f.baseline.records[0]);
    return f.off.applyVerifiedNotePull({ userId: owner, expectedLocalJson: f.originalJson, expectedBaseline: clone(f.baseline), expectedRecord,
      nextRecord: { ...expectedRecord, contentFingerprint: await c.CapSync.contentFingerprint(f.cloud), last_pull_id: 'fixture-pull' },
      cloud: clone(f.cloud), backupKey: 'manual-notes-pull-backup:direct', ...patch }, guard, verify);
  };
  f.redacted = text => assert.ok(!/owner-secret|title-secret|cloud-secret|original-secret/.test(text));
  return f;
}
let passed = 0;
async function test(label, body) { await body(); passed++; }
async function unchanged(f) { assert.equal(JSON.stringify(f.c.S), f.originalJson); assert.equal(f.storage.get('pera'), f.originalJson); assert.equal((await f.kv()).json, f.originalJson); assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline)); }
(async () => {
  await test('preview performs no writes and redacts data', async () => {
    const f = await fixture(), out = await f.preview(); assert.match(out.textContent, /CLOUD NOTE CHANGE/); f.redacted(out.textContent);
    await unchanged(f); assert.equal(await f.checkpoint(), undefined); assert.equal(f.cloudWrites, 0); assert.equal(f.consents, 0);
  });
  await test('confirmed pull commits local note and baseline, keeps backup, and survives reload', async () => {
    const f = await fixture(); await f.preview(); const result = await f.action(); assert.match(result, /PULLED — VERIFIED AND FINALIZED/); f.redacted(result);
    assert.equal(f.cloudWrites, 0); assert.equal(f.c.S.notes[0].b, 'cloud-secret'); assert.equal(f.c.S.notes[0].custom, 'keep'); assert.equal(f.c.S.notes[0]._u, 1);
    const expected = JSON.parse(f.originalJson); expected.notes[0].b = 'cloud-secret'; expected._mt = f.c.S._mt;
    assert.equal(JSON.stringify(f.c.S), JSON.stringify(expected)); assert.equal(f.storage.get('pera'), JSON.stringify(expected)); assert.equal((await f.kv()).json, JSON.stringify(expected));
    const b = await f.base(); assert.equal(b.revision, 1); assert.equal(b.records.length, f.baseline.records.length);
    assert.equal(JSON.stringify(b.records.slice(1)), JSON.stringify(f.baseline.records.slice(1))); assert.equal((await f.queue()).length, 0); assert.equal(await f.checkpoint(), undefined);
    const meta = await f.off.syncStore('syncmeta', 'all'), backups = meta.filter(x => x.kind === 'manual-note-pull-backup');
    assert.equal(backups.length, 1); assert.equal(backups[0].localJson, f.originalJson); assert.equal(JSON.stringify(backups[0].baseline), JSON.stringify(f.baseline));
    f.c.S = JSON.parse(f.storage.get('pera')); vm.runInContext(manual, f.c);
    const r = await f.c.CapManualNotes.inspect('pull'); assert.equal(r.allowed, false); assert.match(r.status, /NO CLOUD NOTE CHANGE/);
  });
  await test('cancel has no backup or mutation', async () => { const f = await fixture(); f.consent = false; await f.preview(); assert.match(await f.action(), /CANCELLED/); await unchanged(f); assert.equal(await f.checkpoint(), undefined); assert.equal(f.cloudWrites, 0); });
  for (const [label, setup] of [
    ['pending outbox', f => f.off.syncStore('outbox', 'put', { id: 'pending', entity: 'notes' })],
    ['test checkpoint', f => f.off.syncStore('syncmeta', 'put', { id: 'x' }, 'controlled-notes-test-v1')],
    ['demo checkpoint', f => f.off.syncStore('syncmeta', 'put', { id: 'x' }, 'demo-local-refresh-state-v1')],
    ['pull checkpoint', f => f.off.syncStore('syncmeta', 'put', { id: 'x' }, checkpointKey)],
    ['local edit', async f => { f.c.S.notes[0].b = 'user-edit'; await f.persist(); }],
    ['local financial edit', async f => { f.c.S.accts[0].bal++; await f.persist(); }],
    ['cloud financial edit', f => { f.cloudAccount.balance++; }],
    ['stale localStorage', f => f.storage.set('pera', '{}')],
    ['stale IndexedDB', f => f.off.syncStore('kv', 'put', { json: '{}' }, 'state')],
    ['unverified auth', f => { f.authFails = true; }],
    ['failed cloud read', f => { f.failRead = true; }],
    ['cloud note deletion', f => { f.mutateValidation = v => { v.missingCount = 1; v.snapshot.notes = []; }; }],
    ['missing profile', f => { f.mutateValidation = v => { v.snapshot.profiles = []; }; }],
    ['changed owner', f => { f.owner = 'other'; }],
    ['unsupported null title', f => { f.cloud.title = null; }],
  ]) await test(label + ' blocks preview', async () => {
    const f = await fixture(); await setup(f); const b = JSON.stringify(await f.base()), state = JSON.stringify(f.c.S), out = await f.preview();
    assert.match(out.textContent, /BLOCKED|CONFLICT/); assert.equal(out.children.length, 0); f.redacted(out.textContent);
    assert.equal(JSON.stringify(await f.base()), b); assert.equal(JSON.stringify(f.c.S), state); assert.equal(f.cloudWrites, 0);
  });
  await test('cloud changes during confirmation block before backup', async () => { const f = await fixture(); await f.preview(); f.onConfirm = () => { f.cloud.body = 'changed-again'; }; assert.match(await f.action(), /BLOCKED/); await unchanged(f); assert.equal(await f.checkpoint(), undefined); });
  await test('locked action does not apply', async () => { const f = await fixture(); await f.preview(); f.locked = true; assert.match(await f.action(), /BLOCKED/); await unchanged(f); });
  await test('cloud changes after backup retain original and recovery evidence', async () => {
    const f = await fixture(); await f.preview(); f.onExactRead = () => { f.cloud.body = 'changed-after-backup'; };
    assert.match(await f.action(), /LOCAL DATA NOT REPLACED/); await unchanged(f); assert.equal((await f.checkpoint()).phase, 'prepared');
    assert.equal(f.cloudWrites, 0); const r = await f.c.CapManualNotes.inspectPullRecovery(); assert.equal(r.present, true); assert.equal(r.local, 'matches original'); assert.equal(r.cloud, 'different content'); f.redacted(JSON.stringify(r));
  });
  await test('failed exact read never proves absence', async () => {
    const f = await fixture(); await f.preview(); f.absent = true;
    assert.match(await f.action(), /LOCAL DATA NOT REPLACED/); await unchanged(f);
    const r = await f.c.CapManualNotes.inspectPullRecovery(); assert.match(r.cloud, /NOT PROVEN/); assert.equal(r.backupVerified, true);
  });
  await test('localStorage failure after IDB commit retains applied checkpoint', async () => {
    const f = await fixture(); await f.preview(); f.failLocalStorage = true;
    assert.match(await f.action(), /LOCAL WRITE OCCURRED/); assert.equal((await f.checkpoint()).phase, 'applied'); assert.equal(JSON.parse((await f.kv()).json).notes[0].b, 'cloud-secret');
    assert.equal(f.storage.get('pera'), f.originalJson); assert.equal((await f.base()).revision, 1); assert.equal(f.cloudWrites, 0);
  });
  await test('in-memory apply failure keeps IDB state and baseline together', async () => {
    const f = await fixture(); await f.preview(); f.failSet = true;
    assert.match(await f.action(), /LOCAL WRITE OCCURRED/); assert.equal((await f.checkpoint()).phase, 'applied'); assert.equal((await f.base()).revision, 1);
    assert.equal(JSON.parse((await f.kv()).json).notes[0].b, 'cloud-secret'); assert.equal(JSON.stringify(f.c.S), f.originalJson);
  });
  await test('failure between state and baseline puts rolls both back', async () => {
    const f = await fixture(); await f.preview(); const original = fake.IDBObjectStore.prototype.put;
    fake.IDBObjectStore.prototype.put = function (value, key) { if (this.name === 'syncmeta' && key === 'baseline') throw Error('Injected failure'); return original.call(this, value, key); };
    try { assert.match(await f.action(), /LOCAL DATA NOT REPLACED/); } finally { fake.IDBObjectStore.prototype.put = original; }
    await unchanged(f); assert.equal((await f.checkpoint()).phase, 'prepared');
  });
  await test('backup/checkpoint staging aborts together', async () => {
    const f = await fixture(); await f.preview(); const original = fake.IDBObjectStore.prototype.add;
    fake.IDBObjectStore.prototype.add = function (value, key) { if (key === checkpointKey) throw Error('Injected failure'); return original.call(this, value, key); };
    try { assert.match(await f.action(), /STOPPED/); } finally { fake.IDBObjectStore.prototype.add = original; }
    await unchanged(f); assert.equal(await f.checkpoint(), undefined); assert.equal((await f.off.syncStore('syncmeta', 'all')).filter(x => x.kind === 'manual-note-pull-backup').length, 0);
  });
  await test('postcommit cloud race retains checkpoint and blocks retries', async () => {
    const f = await fixture(); await f.preview(); f.onExactRead = () => { if (f.exactReads === 2) f.cloud.body = 'newer-cloud'; };
    assert.match(await f.action(), /LOCAL WRITE OCCURRED/); assert.equal((await f.checkpoint()).phase, 'applied');
    const r = await f.c.CapManualNotes.inspect('pull'); assert.equal(r.allowed, false); assert.match(r.status, /recovery/); assert.equal(f.cloudWrites, 0);
  });
  await test('checkpoint delete failure preserves applied recovery', async () => {
    const f = await fixture(); await f.preview(); const original = fake.IDBObjectStore.prototype.delete;
    fake.IDBObjectStore.prototype.delete = function (key) { if (key === checkpointKey) throw Error('Injected failure'); return original.call(this, key); };
    try { assert.match(await f.action(), /LOCAL WRITE OCCURRED/); } finally { fake.IDBObjectStore.prototype.delete = original; }
    assert.equal((await f.checkpoint()).phase, 'applied'); const r = await f.c.CapManualNotes.inspectPullRecovery(); assert.match(r.status, /PULL DATA VERIFIED/); f.redacted(JSON.stringify(r));
  });
  await test('pull recovery inspector is read-only and reports absence safely', async () => {
    const f = await fixture(); const r = await f.c.CapManualNotes.inspectPullRecovery(); assert.equal(r.present, false); assert.match(r.status, /NO NOTE-PULL/); await unchanged(f);
    await f.parent.children[4].onclick(); assert.match(f.parent.children[5].textContent, /READ-ONLY NOTE-PULL/); f.redacted(f.parent.children[5].textContent);
  });
  for (const guard of [() => false, () => Promise.resolve(true), () => { throw Error('changed'); }]) await test('atomic guard fails closed', async () => {
    const f = await fixture(); await assert.rejects(f.direct(guard)); await unchanged(f); assert.equal(await f.checkpoint(), undefined);
  });
  await test('direct transaction rejects changed baseline', async () => {
    const f = await fixture(); await f.off.syncStore('syncmeta', 'put', { ...f.baseline, revision: 100 }, 'baseline');
    await assert.rejects(f.direct()); assert.equal((await f.base()).revision, 100); assert.equal(await f.checkpoint(), undefined); assert.equal((await f.kv()).json, f.originalJson);
  });
  await test('direct transaction preserves pending operation', async () => {
    const f = await fixture(); await f.off.syncStore('outbox', 'put', { id: 'pending' });
    await assert.rejects(f.direct()); await unchanged(f); assert.equal((await f.queue()).length, 1); assert.equal(await f.checkpoint(), undefined);
  });
  await test('direct transaction blocks an existing pull checkpoint', async () => {
    const f = await fixture(); await f.off.syncStore('syncmeta', 'put', { owner }, checkpointKey);
    await assert.rejects(f.direct()); await unchanged(f); assert.equal((await f.checkpoint()).owner, owner);
  });
  await test('backup read-back failure retains original state', async () => {
    const f = await fixture(), original = fake.IDBDatabase.prototype.transaction;
    fake.IDBDatabase.prototype.transaction = function (stores, mode) { if (mode === 'readonly') throw Error('Readback failed'); return original.call(this, stores, mode); };
    try { await assert.rejects(f.direct(), e => e.backedUp === true && e.committed === false); } finally { fake.IDBDatabase.prototype.transaction = original; }
    await unchanged(f); assert.equal((await f.checkpoint()).phase, 'prepared');
  });
  await test('truthy but unverified cloud evidence never applies', async () => {
    const f = await fixture(); await assert.rejects(f.direct(() => true, async () => ({})), e => e.backedUp === true && e.committed === false);
    await unchanged(f); assert.equal((await f.checkpoint()).phase, 'prepared');
  });
  await test('missing cloud field is rejected before any backup', async () => {
    const f = await fixture(), cloud = clone(f.cloud); delete cloud.note_date;
    await assert.rejects(f.direct(() => true, async () => true, { cloud })); await unchanged(f); assert.equal(await f.checkpoint(), undefined);
  });
  await test('wrong next fingerprint cannot acknowledge different content', async () => {
    const f = await fixture(); await assert.rejects(f.direct(() => true, async () => true, { nextRecord: { ...f.baseline.records[0], contentFingerprint: 'b'.repeat(64), last_pull_id: 'x' } }));
    await unchanged(f); assert.equal(await f.checkpoint(), undefined);
  });
  await test('pull recovery blocks manual local queue staging', async () => {
    const f = await fixture(); await f.off.syncStore('syncmeta', 'put', { owner }, checkpointKey);
    const entry = { id: 'op', source: 'manual-notes-v1', entity: 'notes', operation: 'upsert', user_id: owner, local_id: '1', supabase_id: id,
      payload: clone(f.cloud), manual_original: clone(f.originalCloud) };
    await assert.rejects(f.off.stageVerifiedManualNote({ userId: owner, entry, expectedBaseline: f.baseline }, () => true));
    assert.equal((await f.queue()).length, 0); await unchanged(f);
  });
  await test('pull recovery blocks atomic note acknowledgement', async () => {
    const f = await fixture(); await f.off.syncStore('syncmeta', 'put', { owner }, checkpointKey);
    const entry = { id: 'pending-note', entity: 'notes', operation: 'upsert', user_id: owner, local_id: '1', supabase_id: id, payload: clone(f.cloud) };
    await f.off.syncStore('outbox', 'put', entry);
    const expectedRecord = f.baseline.records[0], nextRecord = { ...expectedRecord, contentFingerprint: await f.c.CapSync.contentFingerprint(f.cloud), last_operation_id: entry.id };
    await assert.rejects(f.off.finalizeVerifiedNotePush({ userId: owner, entry, expectedRecord, nextRecord }, () => true));
    await unchanged(f); assert.equal((await f.queue()).length, 1);
  });
  await test('pull recovery blocks demo refresh before backup', async () => {
    const f = await fixture(); await f.off.syncStore('syncmeta', 'put', { owner }, checkpointKey);
    await assert.rejects(f.off.refreshVerifiedLocalDemo({ userId: owner, expectedLocalJson: f.originalJson, expectedBaseline: f.baseline,
      nextState: JSON.parse(f.originalJson), nextBaseline: f.baseline, backupKey: 'demo-local-refresh-backup:fixture' }, () => true, async () => true));
    await unchanged(f); assert.equal(await f.off.syncStore('syncmeta', 'get', 'demo-local-refresh-backup:fixture'), undefined);
  });
  await test('pull recovery blocks marker-test checkpoint cleanup', async () => {
    const f = await fixture(); await f.off.syncStore('syncmeta', 'put', { owner }, checkpointKey);
    const state = JSON.parse(f.originalJson), financial = JSON.stringify(Object.fromEntries(['accts','tx','pend','xfer','bills','goals','debts','budgets'].map(k => [k, state[k]])));
    const checkpoint = { id: 'marker', owner, phase: 'restore', original: f.originalCloud, originalLocal: JSON.stringify(state.notes), financial };
    await f.off.syncStore('syncmeta', 'put', checkpoint, 'controlled-notes-test-v1');
    await assert.rejects(f.off.discardVerifiedNotesRecoveryCheckpoint({ userId: owner, checkpoint, expectedBaseline: f.baseline,
      expectedLocalNotes: checkpoint.originalLocal, expectedFinancial: financial }, () => true));
    await unchanged(f); assert.equal((await f.off.syncStore('syncmeta', 'get', 'controlled-notes-test-v1')).id, 'marker');
  });
  await test('pull recovery blocks stale-outbox cleanup', async () => {
    const f = await fixture(); await f.off.syncStore('syncmeta', 'put', { owner }, checkpointKey);
    const entries = [1, 2, 3].map(n => ({ id: 'op-' + n, user_id: owner, entity: 'accounts', operation: 'upsert', local_id: 'test-' + n, supabase_id: 'test-' + n,
      payload: { id: 'test-' + n, user_id: owner, name: 'CAP SYNC ENGINE TEST', legacy_id: 'phase6-test-test-' + n } }));
    for (const entry of entries) await f.off.syncStore('outbox', 'put', entry);
    await assert.rejects(f.off.discardVerifiedTestOutbox({ userId: owner, entries, expectedBaseline: f.baseline }, () => true));
    await unchanged(f); assert.equal((await f.queue()).length, 3);
  });
  await test('simultaneous local/cloud edit is blocked with no action or writes', async () => {
    const f = await fixture(); f.c.S.notes[0].b = 'user-edit'; f.c.S._mt++; await f.persist(); f.cloud.body = 'cloud-conflict';
    const baseline = JSON.stringify(await f.base()), persisted = JSON.stringify(f.c.S);
    const out = await f.preview();
    assert.match(out.textContent, /CONFLICT — local and cloud changed/);
    assert.match(out.textContent, /Fields with different local\/cloud values: body/);
    assert.match(out.textContent, /Both versions are preserved/);
    assert.equal(out.children.length, 0);
    assert.ok(!/owner-secret|title-secret|cloud-conflict|original-secret|user-edit/.test(out.textContent));
    assert.equal(JSON.stringify(f.c.S), persisted); assert.equal(f.storage.get('pera'), persisted);
    assert.equal((await f.kv()).json, persisted); assert.equal(JSON.stringify(await f.base()), baseline);
    assert.equal(await f.checkpoint(), undefined); assert.equal((await f.queue()).length, 0);
    assert.equal((await f.off.syncStore('syncmeta', 'all')).filter(x => x.kind === 'manual-note-pull-backup').length, 0);
    assert.equal(f.cloudWrites, 0); assert.equal(f.exactReads, 0); assert.equal(f.consents, 0);
  });
  await test('the same conflict blocks the push preview and preserves pending-free state', async () => {
    const f = await fixture(); f.c.S.notes[0].b = 'user-edit'; f.c.S._mt++; await f.persist(); f.cloud.body = 'cloud-conflict';
    await f.parent.children[0].onclick(); const out = f.parent.children[1];
    assert.match(out.textContent, /CONFLICT — cloud note changed/); assert.match(out.textContent, /body/);
    assert.equal(out.children.length, 0); assert.equal(f.cloudWrites, 0); assert.equal(f.consents, 0);
    assert.equal(await f.checkpoint(), undefined); assert.equal((await f.queue()).length, 0);
  });
  await test('a retained pull backup is untouched by conflict previews', async () => {
    const f = await fixture(); const backup = { kind: 'manual-note-pull-backup', owner, localJson: f.originalJson, baseline: clone(f.baseline) };
    await f.off.syncStore('syncmeta', 'put', backup, 'manual-notes-pull-backup:existing');
    f.c.S.notes[0].b = 'user-edit'; f.c.S._mt++; await f.persist(); f.cloud.body = 'cloud-conflict';
    const out = await f.preview(); assert.match(out.textContent, /CONFLICT/);
    assert.equal(JSON.stringify(await f.off.syncStore('syncmeta', 'get', 'manual-notes-pull-backup:existing')), JSON.stringify(backup));
    assert.equal(await f.checkpoint(), undefined); assert.equal(f.cloudWrites, 0);
  });
  await test('conflict remains blocked after reload and still offers no action', async () => {
    const f = await fixture(); f.c.S.notes[0].b = 'user-edit'; f.c.S._mt++; await f.persist(); f.cloud.body = 'cloud-conflict';
    await f.preview(); vm.runInContext(manual, f.c);
    const r = await f.c.CapManualNotes.inspect('pull'); assert.equal(r.allowed, false); assert.equal(r.conflict, true);
    assert.match(r.status, /CONFLICT/); assert.equal(JSON.stringify(r.fields), '["body"]');
    assert.equal(f.cloudWrites, 0); assert.equal((await f.queue()).length, 0); assert.equal(await f.checkpoint(), undefined);
  });
  await test('recovery checkpoint blocks a conflict before comparison', async () => {
    const f = await fixture(); f.c.S.notes[0].b = 'user-edit'; f.c.S._mt++; await f.persist(); f.cloud.body = 'cloud-conflict';
    await f.off.syncStore('syncmeta', 'put', { owner }, checkpointKey);
    const out = await f.preview(); assert.match(out.textContent, /recovery checkpoint/); assert.notEqual(out.textContent.includes('CONFLICT'), true);
    assert.equal(out.children.length, 0); assert.equal(f.cloudWrites, 0);
  });
  await test('read-only conflict self-check button passes without side effects', async () => {
    const f = await fixture(); const baseline = JSON.stringify(await f.base()), state = JSON.stringify(f.c.S);
    await f.parent.children[6].onclick(); const text = f.parent.children[7].textContent;
    assert.match(text, /READ-ONLY CONFLICT SELF-CHECK/); assert.match(text, /PASS — simultaneous/); assert.match(text, /PASS — synthetic/);
    assert.ok(!/owner-secret|title-secret|cloud-secret|original-secret/.test(text));
    assert.equal(JSON.stringify(await f.base()), baseline); assert.equal(JSON.stringify(f.c.S), state);
    assert.equal(f.cloudWrites, 0); assert.equal(f.consents, 0); assert.equal(await f.checkpoint(), undefined);
  });
  console.log(`PASS: ${passed} note-pull/conflict UI/atomic IndexedDB checks; mocked cloud GETs only`);
})().catch(e => { console.error(e); process.exitCode = 1; });
