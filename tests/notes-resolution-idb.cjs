/* Conflict-resolution UI and atomic IndexedDB checks. Isolated fake database
   and mocked cloud transport only. CAP_FAKE_IDB_PATH may point to an external install. */
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const fake = require(process.env.CAP_FAKE_IDB_PATH || 'fake-indexeddb');
const clone = x => JSON.parse(JSON.stringify(x));
const app = fs.readFileSync(`${__dirname}/../js/app.js`, 'utf8'), sync = fs.readFileSync(`${__dirname}/../js/sync.js`, 'utf8'), manual = fs.readFileSync(`${__dirname}/../js/notes-manual.js`, 'utf8');
const owner = 'owner-secret', id = '00000000-0000-4000-8000-000000000011', checkpointKey = 'manual-notes-pull-v1';
class Element {
  constructor() { this.children = []; this.style = {}; this._text = ''; this.disabled = false; }
  set textContent(s) { this._text = s; this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute() {}
}
async function fixture() {
  const f = { cloudWrites: 0, reads: 0, exactReads: 0, consents: 0, consent: true };
  const storage = new Map(), S = { _mt: 1, notes: [{ id: 1, t: 'title-secret', b: 'original-secret', d: '2026-10-20', _u: 1, custom: 'keep' }],
    accts: [{ id: 2, bal: 10 }], tx: [], pend: [], xfer: [], bills: [], goals: [], debts: [], budgets: {}, preference: 'keep' };
  const row = () => ({ id, user_id: owner, legacy_id: '1', title: c.S.notes[0].t, body: c.S.notes[0].b, note_date: c.S.notes[0].d });
  const account = () => ({ id: 'account', user_id: owner, legacy_id: '2', balance: c.S.accts[0].bal });
  const profile = { id: owner }, preferences = { user_id: owner, currency: 'PHP' };
  const c = { indexedDB: new fake.IDBFactory(), crypto: webcrypto, TextEncoder, URLSearchParams, location: { search: '' }, S,
    clearTimeout() {}, document: { createElement: () => new Element() },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => { if (f.failLocalStorage && k === 'pera') throw Error('Storage denied'); storage.set(k, v); } },
    navigator: { locks: { request: async (name, options, callback) => { assert.equal(name, 'cap-controlled-notes-test'); return callback(f.locked ? null : {}); } } },
    migrationPrepare: () => ({ blockingProblems: [] }),
    buildSupabaseMigrationPlan: () => ({ userId: owner, tables: [['notes', [row()]], ['accounts', [account()]]], profile, preferences }),
    confirm: () => { f.consents++; if (f.onConfirm) f.onConfirm(); return f.consent; },
  };
  c.window = c; storage.set('cap_dev_tools', '1'); vm.createContext(c);
  vm.runInContext(app.slice(0, app.indexOf('  /* ---------- events ---------- */')) + '})();', c);
  vm.runInContext(sync, c); vm.runInContext(manual, c);
  c.CapOff.init({ get: () => c.S, set: value => { if (f.failSet) throw Error('Set failed'); c.S = value; } });
  f.cloud = clone(row()); f.originalCloud = clone(f.cloud); f.cloudAccount = clone(account());
  f.cas = async args => {
    f.cloudWrites++;
    if (f.onCas) await f.onCas();
    if (f.failWrite) throw Error('private write error');
    const same = (row, expected) => !!row && !!expected && row.legacy_id === expected.legacy_id && row.title === expected.title &&
      row.body === expected.body && row.note_date === expected.note_date;
    if (same(f.cloud, args.p_desired)) return { status: 'ALREADY_APPLIED' };
    if (!same(f.cloud, args.p_expected)) return { status: 'CONFLICT' };
    f.cloud = { ...f.cloud, legacy_id: args.p_desired.legacy_id, title: args.p_desired.title, body: args.p_desired.body,
      note_date: args.p_desired.note_date, updated_at: '2026-10-20T12:00:00.000Z' };
    return { status: 'APPLIED' };
  };
  c.CapProductionRpc = {
    readNoteRecord: async (ownerId, selector) => {
      f.exactReads++; if (f.onExactRead) await f.onExactRead();
      if (f.failRead) throw Error('private read error');
      if (f.absent) return null;
      return { row: clone(f.cloud), lifecycle: { version: 1, revision: 1, deleted_at: null, operation_id: null } };
    },
    changeNote: async opts => {
      if (!opts || !opts.desired) { f.cloudWrites++; throw Error('Forbidden cloud mutation'); }
      return f.cas({ p_id: opts.id, p_expected: opts.expected ? opts.expected.content : null, p_desired: opts.desired });
    },
    createTransaction: async () => { f.cloudWrites++; throw Error('Forbidden cloud mutation'); },
  };
  c.CapSupabase = {
    currentUser: async () => { if (f.authFails) throw Error('private auth error'); return { id: owner }; }, status: () => ({ userId: owner }),
    notesRpcReady: () => true, refreshNotesRpcReadiness: async () => { if (f.onReadiness) await f.onReadiness(); return true; },
    validateRealData: async () => {
      f.reads++; if (f.failRead) throw Error('private cloud error');
      const result = { missingCount: 0, unexpectedCount: 0, mismatchCount: 0, foreignKeyErrorCount: 0,
        snapshot: { notes: [clone(f.cloud)], accounts: [clone(f.cloudAccount)], profiles: [profile], user_preferences: [preferences] } };
      if (f.mutateValidation) f.mutateValidation(result); return result;
    },
    syncRequest: async () => { f.cloudWrites++; throw Error('DIRECT_TABLE_ACCESS_DISABLED'); },
  };
  const p = c.buildSupabaseMigrationPlan(), validation = await c.CapSupabase.validateRealData(p);
  const records = await c.CapSync.recordFingerprints(p, validation);
  f.baseline = { version: 2, user_id: owner, records: clone(records).map(({ cloudContentFingerprint, canonicalDiffs, ...r }) => r) };
  await c.CapOff.syncStore('syncmeta', 'put', clone(f.baseline), 'baseline');
  storage.set('pera', JSON.stringify(S)); await c.CapOff.syncStore('kv', 'put', { json: JSON.stringify(S), mt: 1 }, 'state');
  f.originalJson = JSON.stringify(S); f.cloud.body = 'cloud-conflict';
  f.c = c; f.off = c.CapOff; f.storage = storage;
  f.base = () => f.off.syncStore('syncmeta', 'get', 'baseline'); f.queue = () => f.off.syncStore('outbox', 'all'); f.checkpoint = () => f.off.syncStore('syncmeta', 'get', checkpointKey);
  f.kv = () => f.off.syncStore('kv', 'get', 'state');
  f.persist = async () => { storage.set('pera', JSON.stringify(c.S)); await f.off.syncStore('kv', 'put', { json: JSON.stringify(c.S), mt: c.S._mt || 0 }, 'state'); };
  f.parent = new Element(); c.CapManualNotes.mount(f.parent);
  f.find = text => [...f.parent.children].findIndex(x => x.textContent === text);
  f.review = async () => { const i = f.find('Review note conflict (read-only)'); assert.ok(i >= 0); await f.parent.children[i].onclick(); return f.parent.children[i + 1]; };
  f.action = async text => {
    const out = [...f.parent.children].find(x => x.children.some(y => y.textContent === text));
    assert.ok(out, 'review panel or action not mounted: ' + text);
    const button = out.children.find(y => y.textContent === text); assert.ok(button, 'action button not found: ' + text);
    await button.onclick(); return out.textContent;
  };
  f.keepCloud = () => f.action('Keep cloud version (confirm)');
  f.keepLocal = () => f.action('Keep this browser’s version (overwrite cloud, confirm)');
  f.direct = async (guard = () => true, verify = async () => true, patch = {}) => {
    const expectedRecord = clone(f.baseline.records[0]);
    return f.off.applyVerifiedNoteResolution({ userId: owner, expectedLocalJson: f.conflictJson, expectedBaseline: clone(f.baseline), expectedRecord,
      expectedLocalFingerprint: await c.CapSync.contentFingerprint(f.localRow), local: clone(f.localRow), cloud: clone(f.cloud),
      nextRecord: { ...expectedRecord, contentFingerprint: await c.CapSync.contentFingerprint(f.cloud), cloud_updated_at: f.cloud.updated_at || null, last_resolution_id: 'fixture-resolution' },
      backupKey: 'manual-notes-pull-backup:resolution-direct', ...patch }, guard, verify);
  };
  f.directLocal = async (guard = () => true, read = async () => clone(f.cloud), write = f.cas, patch = {}) => {
    const expectedRecord = clone(f.baseline.records[0]);
    return f.off.applyVerifiedNoteLocalOverwrite({ userId: owner, expectedLocalJson: f.conflictJson, expectedBaseline: clone(f.baseline), expectedRecord,
      expectedLocalFingerprint: await c.CapSync.contentFingerprint(f.localRow), local: clone(f.localRow), cloud: clone(f.cloud),
      nextRecord: { ...expectedRecord, contentFingerprint: await c.CapSync.contentFingerprint(f.localRow), last_resolution_id: 'fixture-local' },
      backupKey: 'manual-notes-pull-backup:local-direct', ...patch }, guard, read, write);
  };
  // Create the conflict after the baseline: local edit plus cloud edit.
  c.S.notes[0].b = 'local-conflict'; c.S._mt++; await f.persist();
  f.conflictJson = JSON.stringify(c.S); const plan = c.buildSupabaseMigrationPlan();
  f.localRow = clone(plan.tables.find(t => t[0] === 'notes')[1][0]);
  return f;
}
let passed = 0;
async function test(label, body) { await body(); passed++; }
async function unchangedConflict(f) {
  assert.equal(JSON.stringify(f.c.S), f.conflictJson); assert.equal(f.storage.get('pera'), f.conflictJson);
  assert.equal((await f.kv()).json, f.conflictJson); assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline));
  assert.equal((await f.queue()).length, 0); assert.equal(f.cloudWrites, 0);
}
(async () => {
  await test('review shows both versions without writes or action', async () => {
    const f = await fixture(), out = await f.review();
    assert.match(out.textContent, /CONFLICT — resolution preview ready/);
    assert.match(out.textContent, /THIS BROWSER VERSION[\s\S]*local-conflict/);
    assert.match(out.textContent, /CLOUD VERSION[\s\S]*cloud-conflict/);
    assert.match(out.textContent, /Fields differing: body/);
    assert.equal(out.children.length, 2); assert.equal(out.children[0].textContent, 'Keep cloud version (confirm)');
    assert.equal(out.children[0].disabled, false); assert.equal(out.children[1].textContent, 'Keep this browser’s version (overwrite cloud, confirm)');
    assert.equal(out.children[1].disabled, false);
    assert.ok(!/owner-secret|00000000-0000-4000-8000-000000000011/.test(out.textContent));
    await unchangedConflict(f); assert.equal(await f.checkpoint(), undefined); assert.equal(f.consents, 0);
    assert.equal((await f.off.syncStore('syncmeta', 'all')).filter(x => (x.kind || '').includes('resolution') || (x.kind || '').includes('pull-backup')).length, 0);
  });
  await test('cancel keeps the local conflict and creates nothing', async () => {
    const f = await fixture(); f.consent = false; await f.review(); const text = await f.keepCloud();
    assert.match(text, /CANCELLED/); await unchangedConflict(f); assert.equal(await f.checkpoint(), undefined);
  });
  await test('keep cloud applies local note + baseline and retains backup', async () => {
    const f = await fixture(); await f.review(); const text = await f.keepCloud();
    assert.match(text, /RESOLVED — CLOUD VERSION KEPT; LOCAL BACKUP RETAINED/);
    assert.equal(f.c.S.notes[0].b, 'cloud-conflict'); assert.equal(f.c.S.notes[0].t, 'title-secret'); assert.equal(f.c.S.notes[0].custom, 'keep');
    const expected = JSON.parse(f.conflictJson); expected.notes[0].b = 'cloud-conflict'; expected._mt = f.c.S._mt;
    assert.equal(JSON.stringify(f.c.S), JSON.stringify(expected)); assert.equal(f.storage.get('pera'), JSON.stringify(expected)); assert.equal((await f.kv()).json, JSON.stringify(expected));
    const b = await f.base(); assert.equal(b.revision, 1); assert.equal(b.records[0].contentFingerprint, await f.c.CapSync.contentFingerprint(f.cloud));
    assert.equal(JSON.stringify(b.records.slice(1)), JSON.stringify(f.baseline.records.slice(1))); assert.equal((await f.queue()).length, 0);
    assert.equal(await f.checkpoint(), undefined); assert.equal(f.cloudWrites, 0);
    const backups = (await f.off.syncStore('syncmeta', 'all')).filter(x => x.kind === 'manual-note-resolution-backup');
    assert.equal(backups.length, 1); assert.equal(backups[0].localJson, f.conflictJson); assert.equal(JSON.stringify(backups[0].baseline), JSON.stringify(f.baseline));
    const noConflict = await f.c.CapManualNotes.inspect('resolve'); assert.equal(noConflict.allowed, false); assert.match(noConflict.status, /NO CONFLICT TO RESOLVE/);
  });
  await test('review after keep cloud reports no conflict', async () => {
    const f = await fixture(); await f.review(); await f.keepCloud(); const out = await f.review();
    assert.match(out.textContent, /NO CONFLICT TO RESOLVE/); assert.equal(out.children.length, 0);
  });
  await test('keep local overwrites cloud, keeps local state, and updates baseline', async () => {
    const f = await fixture(), originalCloud = clone(f.cloud); await f.review(); const text = await f.keepLocal();
    assert.match(text, /RESOLVED — LOCAL VERSION KEPT; CLOUD OVERWRITTEN; LOCAL BACKUP RETAINED/);
    assert.equal(f.cloud.body, 'local-conflict'); assert.equal(f.cloud.title, 'title-secret'); assert.equal(f.cloud.note_date, '2026-10-20');
    assert.equal(f.cloud.updated_at, '2026-10-20T12:00:00.000Z'); assert.equal(f.cloudWrites, 1);
    assert.equal(JSON.stringify(f.c.S), f.conflictJson); assert.equal(f.storage.get('pera'), f.conflictJson); assert.equal((await f.kv()).json, f.conflictJson);
    const b = await f.base(); assert.equal(b.revision, 1); assert.equal(b.records[0].contentFingerprint, await f.c.CapSync.contentFingerprint(f.localRow));
    assert.equal(b.records[0].cloud_updated_at, f.cloud.updated_at); assert.match(b.records[0].last_resolution_id, /^[0-9a-f-]{36}$/);
    assert.equal(JSON.stringify(b.records.slice(1)), JSON.stringify(f.baseline.records.slice(1)));
    assert.equal(await f.checkpoint(), undefined); assert.equal((await f.queue()).length, 0);
    const backups = (await f.off.syncStore('syncmeta', 'all')).filter(x => x.kind === 'manual-note-resolution-backup');
    assert.equal(backups.length, 1); assert.equal(backups[0].localJson, f.conflictJson); assert.equal(JSON.stringify(backups[0].baseline), JSON.stringify(f.baseline));
    assert.equal(backups[0].mode, 'conflict-local'); assert.deepEqual(backups[0].expectedCloud, originalCloud);
    const noConflict = await f.c.CapManualNotes.inspect('resolve'); assert.match(noConflict.status, /NO CONFLICT TO RESOLVE/);
    const pull = await f.c.CapManualNotes.inspect('pull'); assert.match(pull.status, /NO CLOUD NOTE CHANGE TO PULL/);
  });
  await test('cancel keep local creates nothing', async () => {
    const f = await fixture(); f.consent = false; await f.review(); const text = await f.keepLocal();
    assert.match(text, /CANCELLED/); await unchangedConflict(f); assert.equal(await f.checkpoint(), undefined);
    assert.equal((await f.off.syncStore('syncmeta', 'all')).filter(x => x.kind === 'manual-note-resolution-backup').length, 0);
  });
  await test('local change during RPC readiness prevents the CAS request', async () => {
    const f = await fixture(); await f.review();
    f.onReadiness = async () => { f.c.S.notes[0].b = 'changed-during-readiness'; await f.persist(); };
    const text = await f.keepLocal(); assert.match(text, /OUTCOME UNKNOWN|STOPPED/);
    assert.equal(f.cloudWrites, 0); assert.equal(f.cloud.body, 'cloud-conflict');
    assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline)); assert.equal((await f.checkpoint()).phase, 'prepared');
  });
  await test('local-overwrite recovery rejects a missing losing cloud backup', async () => {
    const f = await fixture(); await f.review(); f.failWrite = true; await f.keepLocal();
    const cp = await f.checkpoint(), backup = await f.off.syncStore('syncmeta', 'get', cp.backupKey);
    delete backup.expectedCloud; await f.off.syncStore('syncmeta', 'put', backup, cp.backupKey);
    const report = await f.c.CapManualNotes.inspectPullRecovery(); assert.equal(report.backupVerified, false); assert.match(report.status, /BLOCKED/);
  });
  await test('cloud changed after local-overwrite backup retains original and recovery evidence', async () => {
    const f = await fixture(); await f.review(); let n = 0; f.onExactRead = async () => { if (++n === 2) f.cloud.body = 'changed-after-backup'; };
    const text = await f.keepLocal();
    assert.match(text, /STOPPED — RESOLUTION BACKUP\/CHECKPOINT RETAINED; CLOUD NOT OVERWRITTEN/);
    assert.equal(f.cloudWrites, 0); await unchangedConflict(f); assert.equal((await f.checkpoint()).phase, 'prepared');
    const r = await f.c.CapManualNotes.inspectPullRecovery(); assert.equal(r.mode, 'conflict-local');
    assert.equal(r.local, 'matches original and desired'); assert.equal(r.cloud, 'different content'); assert.match(r.status, /BLOCKED/);
  });
  await test('local-overwrite CAS conflict retains original state', async () => {
    const f = await fixture(); await f.review(); f.onCas = async () => { f.cloud.body = 'changed-during-cas'; };
    const text = await f.keepLocal();
    assert.match(text, /STOPPED — RESOLUTION BACKUP\/CHECKPOINT RETAINED; CLOUD NOT OVERWRITTEN/);
    assert.equal(f.cloudWrites, 1); assert.equal(f.cloud.body, 'changed-during-cas');
    assert.equal(JSON.stringify(f.c.S), f.conflictJson); assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline));
    assert.equal((await f.checkpoint()).phase, 'prepared');
  });
  await test('local-overwrite cloud success with baseline failure retains cloud-written recovery', async () => {
    const f = await fixture(); await f.review(); const original = fake.IDBObjectStore.prototype.put;
    fake.IDBObjectStore.prototype.put = function (value, key) { if (this.name === 'syncmeta' && key === 'baseline') throw Error('Injected failure'); return original.call(this, value, key); };
    let text;
    try { text = await f.keepLocal(); } finally { fake.IDBObjectStore.prototype.put = original; }
    assert.match(text, /CLOUD WRITE OCCURRED — RESOLUTION VERIFICATION FAILED/);
    assert.equal(f.cloud.body, 'local-conflict'); assert.equal(f.cloudWrites, 1);
    assert.equal(JSON.stringify(f.c.S), f.conflictJson); assert.equal(f.storage.get('pera'), f.conflictJson);
    assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline));
    const cp = await f.checkpoint(); assert.equal(cp.phase, 'cloud-written'); assert.equal(cp.mode, 'conflict-local'); assert.ok(cp.nextBaseline);
    const r = await f.c.CapManualNotes.inspectPullRecovery(); assert.match(r.status, /LOCAL OVERWRITE CLOUD WRITTEN — BASELINE NOT UPDATED/);
    assert.equal(r.cloud, 'matches desired cloud snapshot'); assert.equal(r.baseline, 'matches original'); assert.equal(r.local, 'matches original and desired');
  });
  await test('unknown local-overwrite cloud outcome is reported without retry', async () => {
    const f = await fixture(); await f.review(); f.onCas = async () => { f.failRead = true; }; f.failWrite = true;
    const text = await f.keepLocal(); assert.match(text, /CLOUD WRITE OUTCOME UNKNOWN/);
    assert.equal(f.cloudWrites, 1); assert.equal((await f.checkpoint()).phase, 'prepared');
    assert.equal(JSON.stringify(f.c.S), f.conflictJson); assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline));
  });
  await test('lost CAS response is reconciled by a read without a second CAS', async () => {
    const f = await fixture(); await f.review();
    f.onCas = async () => { f.cloud = { ...f.cloud, ...clone(f.localRow) }; }; f.failWrite = true;
    assert.match(await f.keepLocal(), /RESOLVED — LOCAL VERSION KEPT/);
    assert.equal(f.cloudWrites, 1); assert.equal((await f.base()).revision, 1); assert.equal(await f.checkpoint(), undefined);
    assert.equal(JSON.stringify(f.c.S), f.conflictJson);
  });
  await test('already-applied CAS response acknowledges once without retry', async () => {
    const f = await fixture(); await f.review();
    f.onCas = async () => { f.cloud = { ...f.cloud, ...clone(f.localRow) }; };
    assert.match(await f.keepLocal(), /RESOLVED — LOCAL VERSION KEPT/);
    assert.equal(f.cloudWrites, 1); assert.equal((await f.base()).revision, 1); assert.equal(await f.checkpoint(), undefined);
    assert.equal((await f.queue()).length, 0);
  });
  await test('APPLIED followed by an unreadable cloud retains the original baseline', async () => {
    const f = await fixture(); await f.review();
    f.onExactRead = async () => { if (f.cloudWrites >= 1) f.failRead = true; };
    assert.match(await f.keepLocal(), /CLOUD WRITE OCCURRED — RESOLUTION VERIFICATION FAILED/);
    assert.equal(f.cloudWrites, 1); assert.equal(f.cloud.body, 'local-conflict');
    assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline)); assert.equal((await f.checkpoint()).phase, 'prepared');
    const report = await f.c.CapManualNotes.inspectPullRecovery(); assert.match(report.cloud, /NOT PROVEN/); assert.match(report.status, /BLOCKED/);
  });
  await test('cloud checkpoint write failure retains prepared evidence after CAS', async () => {
    const f = await fixture(); await f.review(); const original = fake.IDBObjectStore.prototype.put;
    fake.IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'syncmeta' && key === checkpointKey && value.phase === 'cloud-written') throw Error('Injected checkpoint failure');
      return original.call(this, value, key);
    };
    try { assert.match(await f.keepLocal(), /CLOUD WRITE OCCURRED/); } finally { fake.IDBObjectStore.prototype.put = original; }
    assert.equal(f.cloudWrites, 1); assert.equal((await f.checkpoint()).phase, 'prepared');
    assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline));
    const report = await f.c.CapManualNotes.inspectPullRecovery();
    assert.equal(report.backupVerified, true); assert.match(report.status, /CLOUD WRITTEN — BASELINE NOT UPDATED/);
  });
  await test('keep-local cleanup failure retains the applied checkpoint and both versions', async () => {
    const f = await fixture(), originalCloud = clone(f.cloud); await f.review(); const original = fake.IDBObjectStore.prototype.delete;
    fake.IDBObjectStore.prototype.delete = function (key) {
      if (this.name === 'syncmeta' && key === checkpointKey) throw Error('Injected cleanup failure');
      return original.call(this, key);
    };
    try { assert.match(await f.keepLocal(), /CLOUD AND LOCAL WRITES OCCURRED/); } finally { fake.IDBObjectStore.prototype.delete = original; }
    const cp = await f.checkpoint(), backup = await f.off.syncStore('syncmeta', 'get', cp.backupKey);
    assert.equal(cp.phase, 'applied'); assert.equal(backup.localJson, f.conflictJson); assert.deepEqual(backup.expectedCloud, originalCloud);
    assert.equal(f.cloudWrites, 1); assert.equal((await f.base()).revision, 1);
    assert.match((await f.c.CapManualNotes.inspectPullRecovery()).status, /LOCAL OVERWRITE DATA VERIFIED/);
    const review = await f.review(); assert.match(review.textContent, /unresolved recovery checkpoint/); assert.equal(review.children.length, 0);
    f.cloud = originalCloud;
    const changedReport = await f.c.CapManualNotes.inspectPullRecovery(); assert.match(changedReport.status, /BLOCKED/);
    assert.ok(!changedReport.status.includes('DATA VERIFIED'));
  });
  await test('keep-local confirmation with changed cloud evidence creates no backup', async () => {
    const f = await fixture(); await f.review(); f.onConfirm = () => { f.cloud.body = 'changed-during-confirmation'; };
    assert.match(await f.keepLocal(), /evidence changed during confirmation/);
    await unchangedConflict(f); assert.equal(await f.checkpoint(), undefined);
    assert.equal((await f.off.syncStore('syncmeta', 'all')).filter(x => x.kind === 'manual-note-resolution-backup').length, 0);
  });
  await test('local-overwrite guard fails closed before backup', async () => {
    const f = await fixture(); await assert.rejects(f.directLocal(() => false));
    await unchangedConflict(f); assert.equal(await f.checkpoint(), undefined); assert.equal(f.cloudWrites, 0);
  });
  await test('local-overwrite cloud read failure blocks before backup', async () => {
    const f = await fixture(); await assert.rejects(f.directLocal(() => true, async () => { throw Error('private read error'); }));
    await unchangedConflict(f); assert.equal(await f.checkpoint(), undefined);
  });
  await test('local-overwrite missing cloud field is rejected before backup', async () => {
    const f = await fixture(), cloud = clone(f.cloud); delete cloud.note_date;
    await assert.rejects(f.directLocal(() => true, async () => cloud)); await unchangedConflict(f); assert.equal(await f.checkpoint(), undefined);
  });
  await test('evidence changed during confirmation blocks before backup', async () => {
    const f = await fixture(); await f.review(); f.onConfirm = () => { f.cloud.body = 'changed-again'; };
    assert.match(await f.keepCloud(), /BLOCKED/); await unchangedConflict(f); assert.equal(await f.checkpoint(), undefined);
    assert.equal((await f.off.syncStore('syncmeta', 'all')).filter(x => x.kind === 'manual-note-resolution-backup').length, 0);
  });
  await test('cloud changed after backup retains original and recovery evidence', async () => {
    const f = await fixture(); await f.review(); f.onExactRead = () => { f.cloud.body = 'changed-after-backup'; };
    assert.match(await f.keepCloud(), /LOCAL DATA NOT REPLACED/); await unchangedConflict(f);
    assert.equal((await f.checkpoint()).phase, 'prepared'); assert.equal((await f.checkpoint()).kind, 'manual-note-resolution');
    const r = await f.c.CapManualNotes.inspectPullRecovery(); assert.equal(r.present, true); assert.equal(r.local, 'matches original'); assert.equal(r.cloud, 'different content');
  });
  await test('failed exact read never proves cloud absence', async () => {
    const f = await fixture(); await f.review(); f.onExactRead = () => { f.failRead = true; };
    assert.match(await f.keepCloud(), /LOCAL DATA NOT REPLACED/); await unchangedConflict(f);
    const r = await f.c.CapManualNotes.inspectPullRecovery(); assert.match(r.cloud, /NOT PROVEN/); assert.equal(r.backupVerified, true);
  });
  await test('localStorage failure after commit retains applied resolution', async () => {
    const f = await fixture(); await f.review(); f.failLocalStorage = true;
    assert.match(await f.keepCloud(), /LOCAL WRITE OCCURRED — RESOLUTION/); assert.equal((await f.checkpoint()).phase, 'applied');
    assert.equal(JSON.parse((await f.kv()).json).notes[0].b, 'cloud-conflict'); assert.equal(f.storage.get('pera'), f.conflictJson);
    assert.equal((await f.base()).revision, 1); assert.equal(f.cloudWrites, 0);
  });
  await test('in-memory apply failure keeps IDB and baseline together', async () => {
    const f = await fixture(); await f.review(); f.failSet = true;
    assert.match(await f.keepCloud(), /LOCAL WRITE OCCURRED — RESOLUTION/); assert.equal((await f.checkpoint()).phase, 'applied');
    assert.equal(JSON.parse((await f.kv()).json).notes[0].b, 'cloud-conflict'); assert.equal((await f.base()).revision, 1);
    assert.equal(JSON.stringify(f.c.S), f.conflictJson); assert.equal(f.storage.get('pera'), f.conflictJson);
  });
  await test('failure between state and baseline rolls both back', async () => {
    const f = await fixture(); await f.review(); const original = fake.IDBObjectStore.prototype.put;
    fake.IDBObjectStore.prototype.put = function (value, key) { if (this.name === 'syncmeta' && key === 'baseline') throw Error('Injected failure'); return original.call(this, value, key); };
    try { assert.match(await f.keepCloud(), /LOCAL DATA NOT REPLACED/); } finally { fake.IDBObjectStore.prototype.put = original; }
    await unchangedConflict(f); assert.equal((await f.checkpoint()).phase, 'prepared');
  });
  await test('backup/checkpoint staging failure leaves original state', async () => {
    const f = await fixture(); await f.review(); const original = fake.IDBObjectStore.prototype.add;
    fake.IDBObjectStore.prototype.add = function (value, key) { if (key === checkpointKey) throw Error('Injected failure'); return original.call(this, value, key); };
    try { assert.match(await f.keepCloud(), /STOPPED/); } finally { fake.IDBObjectStore.prototype.add = original; }
    await unchangedConflict(f); assert.equal(await f.checkpoint(), undefined);
    assert.equal((await f.off.syncStore('syncmeta', 'all')).filter(x => x.kind === 'manual-note-resolution-backup').length, 0);
  });
  await test('checkpoint delete failure preserves applied recovery', async () => {
    const f = await fixture(); await f.review(); const original = fake.IDBObjectStore.prototype.delete;
    fake.IDBObjectStore.prototype.delete = function (key) { if (key === checkpointKey) throw Error('Injected failure'); return original.call(this, key); };
    try { assert.match(await f.keepCloud(), /LOCAL WRITE OCCURRED — RESOLUTION/); } finally { fake.IDBObjectStore.prototype.delete = original; }
    assert.equal((await f.checkpoint()).phase, 'applied'); const r = await f.c.CapManualNotes.inspectPullRecovery(); assert.match(r.status, /RESOLUTION DATA VERIFIED/);
  });
  for (const guard of [() => false, () => Promise.resolve(true), () => { throw Error('changed'); }]) await test('resolution guard fails closed', async () => {
    const f = await fixture(); await assert.rejects(f.direct(guard)); await unchangedConflict(f); assert.equal(await f.checkpoint(), undefined);
  });
  await test('changed baseline is rejected before apply', async () => {
    const f = await fixture(); await f.off.syncStore('syncmeta', 'put', { ...f.baseline, revision: 100 }, 'baseline');
    await assert.rejects(f.direct()); assert.equal((await f.kv()).json, f.conflictJson); assert.equal(await f.checkpoint(), undefined);
  });
  await test('pending operation blocks resolution apply', async () => {
    const f = await fixture(); await f.off.syncStore('outbox', 'put', { id: 'pending' });
    await assert.rejects(f.direct()); assert.equal(JSON.stringify(f.c.S), f.conflictJson); assert.equal(f.storage.get('pera'), f.conflictJson);
    assert.equal((await f.kv()).json, f.conflictJson); assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline));
    assert.equal(f.cloudWrites, 0); assert.equal((await f.queue()).length, 1); assert.equal(await f.checkpoint(), undefined);
  });
  await test('existing recovery checkpoint blocks resolution apply', async () => {
    const f = await fixture(); await f.off.syncStore('syncmeta', 'put', { owner }, checkpointKey);
    await assert.rejects(f.direct()); await unchangedConflict(f); assert.equal((await f.checkpoint()).owner, owner);
  });
  await test('missing cloud field is rejected before backup', async () => {
    const f = await fixture(), cloud = clone(f.cloud); delete cloud.note_date;
    await assert.rejects(f.direct(() => true, async () => true, { cloud })); await unchangedConflict(f); assert.equal(await f.checkpoint(), undefined);
  });
  await test('wrong next fingerprint cannot acknowledge different content', async () => {
    const f = await fixture(); await assert.rejects(f.direct(() => true, async () => true,
      { nextRecord: { ...f.baseline.records[0], contentFingerprint: 'b'.repeat(64), cloud_updated_at: null, last_resolution_id: 'x' } }));
    await unchangedConflict(f); assert.equal(await f.checkpoint(), undefined);
  });
  await test('resolution cannot apply unchanged or already-converged content', async () => {
    const f = await fixture(), localRow = clone(f.localRow);
    await assert.rejects(f.direct(() => true, async () => true, { expectedLocalFingerprint: await f.c.CapSync.contentFingerprint(f.originalCloud || { title: 'title-secret', body: 'original-secret', note_date: '2026-10-20' }) }));
    await assert.rejects(f.direct(() => true, async () => true, { local: { ...localRow, body: 'cloud-conflict' }, expectedLocalFingerprint: await f.c.CapSync.contentFingerprint(f.cloud) }));
    await unchangedConflict(f); assert.equal(await f.checkpoint(), undefined);
  });
  await test('unrelated local financial change blocks review', async () => {
    const f = await fixture(); f.c.S.accts[0].bal++; await f.persist(); const before = JSON.stringify(f.c.S); const out = await f.review();
    assert.match(out.textContent, /BLOCKED|exactly one/); assert.equal(out.children.length, 0); assert.equal(JSON.stringify(f.c.S), before);
    assert.equal((await f.queue()).length, 0); assert.equal(await f.checkpoint(), undefined); assert.equal(f.cloudWrites, 0);
  });
  console.log(`PASS: ${passed} conflict-resolution UI/atomic IndexedDB checks; mocked cloud transport only`);
})().catch(error => { console.error(error); process.exitCode = 1; });
