/* Actual manual UI adapters + atomic staging/acknowledgement, isolated fake
   IndexedDB and simulated cloud only. Set CAP_FAKE_IDB_PATH externally. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const fake = require(process.env.CAP_FAKE_IDB_PATH || 'fake-indexeddb');
const clone = x => JSON.parse(JSON.stringify(x));
const app = fs.readFileSync(`${__dirname}/../js/app.js`, 'utf8');
const sync = fs.readFileSync(`${__dirname}/../js/sync.js`, 'utf8');
const manual = fs.readFileSync(`${__dirname}/../js/notes-manual.js`, 'utf8');
class Element {
  constructor() { this.children = []; this._text = ''; this.style = {}; }
  set textContent(s) { this._text = s; this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute() {}
}
const owner = 'fixture-owner-secret', id = '00000000-0000-4000-8000-000000000011';
async function fixture() {
  const f = { writes: 0, reads: 0, consents: 0, consent: true, locked: false, ready: true, secrets: ['fixture-owner-secret', 'title-secret', 'old-secret', 'desired-secret'] };
  const storage = new Map([['cap_dev_tools', '1']]);
  const S = { notes: [{ id: 1, t: 'title-secret', b: 'old-secret', d: '2026-10-20' }], accts: [{ id: 2, bal: 10 }], tx: [], pend: [], xfer: [], bills: [], goals: [], debts: [], budgets: {} };
  const note = () => ({ id, user_id: f.owner || owner, legacy_id: '1', title: context.S.notes[0].t, body: context.S.notes[0].b, note_date: context.S.notes[0].d });
  const account = () => ({ id: 'account-id', user_id: f.owner || owner, legacy_id: '2', balance: context.S.accts[0].bal });
  const profile = { id: owner, display_name: 'name' }, prefs = { user_id: owner, currency: 'PHP' };
  const context = { indexedDB: new fake.IDBFactory(), crypto: webcrypto, TextEncoder, URLSearchParams, location: { search: '' }, S,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    document: { createElement: () => new Element() },
    navigator: { locks: { request: async (name, options, callback) => { assert.equal(name, 'cap-controlled-notes-test'); return callback(f.locked ? null : {}); } } },
    migrationPrepare: () => ({ blockingProblems: [] }),
    buildSupabaseMigrationPlan: () => ({ userId: f.owner || owner, tables: [['notes', [note()]], ['accounts', [account()]]], profile, preferences: prefs }),
    confirm: () => { f.consents++; if (f.onConfirm) f.onConfirm(); return f.consent; },
  };
  context.window = context; vm.createContext(context);
  vm.runInContext(app.slice(0, app.indexOf('  /* ---------- events ---------- */')) + '})();', context);
  vm.runInContext(sync, context); vm.runInContext(manual, context);
  f.cloud = note(); f.cloudAccount = account();
  const snapshot = () => ({ notes: [clone(f.cloud)], accounts: [clone(f.cloudAccount)], profiles: [profile], user_preferences: [prefs] });
  context.CapSupabase = {
    status: () => ({ userId: f.owner || owner }), currentUser: async () => ({ id: f.owner || owner }),
    refreshNotesRpcReadiness: async () => { if (f.onReady) await f.onReady(); return f.ready; }, notesRpcReady: () => f.ready,
    validateRealData: async () => {
      f.reads++;
      if (f.failRead) throw Error('private sensitive error');
      const result = { missingCount: 0, unexpectedCount: 0, foreignKeyErrorCount: 0, mismatchCount: 0, snapshot: snapshot() };
      if (f.mutateValidation) f.mutateValidation(result);
      return result;
    },
    syncRequest: async (url, options) => {
      if (!options) { f.reads++; if (f.failRead) throw Error('private secret read failed'); return f.absent ? [] : [clone(f.cloud)]; }
      assert.equal(url, '/rest/v1/rpc/cap_sync_note_put'); assert.equal(options.method, 'POST');
      assert.ok(f.consents >= 2, 'Queue consent and separate cloud consent required');
      const args = JSON.parse(options.body); assert.notEqual(args.p_expected, null); assert.equal(args.p_id, id);
      if (f.raceCloud) f.cloud.body = 'remote-user-edit';
      const pick = r => Object.fromEntries(['legacy_id', 'title', 'body', 'note_date'].map(k => [k, r[k]]));
      if (JSON.stringify(pick(f.cloud)) !== JSON.stringify(args.p_expected)) return { status: 'CONFLICT' };
      f.writes++; f.cloud = { id, user_id: owner, ...clone(args.p_desired) };
      if (f.onWrite) f.onWrite();
      if (f.lostResponse) throw Error('private lost response');
      return { status: 'APPLIED' };
    },
  };
  const off = context.CapOff;
  const p = context.buildSupabaseMigrationPlan(), records = await context.CapSync.recordFingerprints(p, { snapshot: snapshot() });
  f.baseline = { version: 2, user_id: owner, records: clone(records).map(({ cloudContentFingerprint, canonicalDiffs, ...r }) => r) };
  await off.syncStore('syncmeta', 'put', clone(f.baseline), 'baseline');
  context.S.notes[0].b = 'desired-secret';
  f.persist = () => storage.set('pera', JSON.stringify(context.S)); f.persist();
  f.context = context; f.off = off; f.queue = () => off.syncStore('outbox', 'all'); f.base = () => off.syncStore('syncmeta', 'get', 'baseline');
  f.parent = new Element(); context.CapManualNotes.mount(f.parent);
  f.preview = async () => { await f.parent.children[0].onclick(); return f.parent.children[1]; };
  f.action = async () => { const out = f.parent.children[1]; assert.equal(out.children.length, 1, out.textContent); await out.children[0].onclick(); return out.textContent; };
  f.stage = async () => { await f.preview(); assert.match(await f.action(), /QUEUED LOCALLY/); };
  f.redacted = text => { for (const secret of f.secrets) assert.ok(!text.includes(secret), 'No secret in diagnostic'); };
  return f;
}
let passed = 0;
async function test(label, body) { await body(); passed++; }
(async () => {
  await test('preview is read-only and redacted', async () => {
    const f = await fixture(), state = JSON.stringify(f.context.S); const out = await f.preview();
    assert.match(out.textContent, /LOCAL NOTE EDIT/); f.redacted(out.textContent);
    assert.equal((await f.queue()).length, 0); assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline));
    assert.equal(JSON.stringify(f.context.S), state); assert.equal(f.writes + f.consents, 0);
  });
  await test('queue then push is one write with exact acknowledgement', async () => {
    const f = await fixture(), state = JSON.stringify(f.context.S); await f.stage();
    assert.equal(f.writes, 0); assert.equal((await f.queue()).length, 1); assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline));
    await f.preview(); const text = await f.action(); assert.match(text, /APPLIED — VERIFIED AND FINALIZED/); f.redacted(text);
    assert.equal(f.writes, 1); assert.equal((await f.queue()).length, 0); assert.equal(f.cloud.body, 'desired-secret');
    const base = await f.base(); assert.equal(base.revision, 1); assert.equal(base.records.length, f.baseline.records.length);
    assert.equal(JSON.stringify(base.records.slice(1)), JSON.stringify(f.baseline.records.slice(1))); assert.equal(JSON.stringify(f.context.S), state);
  });
  await test('pending queue survives simulated reload without background writes', async () => {
    const f = await fixture(); await f.stage(); const before = JSON.stringify(await f.queue());
    f.context.S = JSON.parse(f.context.localStorage.getItem('pera')); vm.runInContext(manual, f.context);
    assert.equal(f.writes, 0); assert.equal(JSON.stringify(await f.queue()), before);
    const r = await f.context.CapManualNotes.inspect(); assert.equal(r.decision.mode, 'push');
  });
  await test('cancel queue does not mutate', async () => { const f = await fixture(); f.consent = false; await f.preview(); assert.match(await f.action(), /CANCELLED/); assert.equal((await f.queue()).length, 0); assert.equal(f.writes, 0); });
  await test('cancel push preserves queue', async () => { const f = await fixture(); await f.stage(); const before = JSON.stringify(await f.queue()); f.consent = false; await f.preview(); assert.match(await f.action(), /CANCELLED/); assert.equal(JSON.stringify(await f.queue()), before); assert.equal(f.writes, 0); });
  await test('edited during queue confirmation is not staged', async () => { const f = await fixture(); await f.preview(); f.onConfirm = () => { f.context.S.notes[0].b = 'edit-again'; f.persist(); }; assert.match(await f.action(), /BLOCKED/); assert.equal((await f.queue()).length, 0); });
  await test('cloud race is rejected by CAS without acknowledgement', async () => { const f = await fixture(); await f.stage(); await f.preview(); f.raceCloud = true; assert.match(await f.action(), /CONFLICT/); assert.equal(f.writes, 0); assert.equal((await f.queue()).length, 1); assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline)); });
  await test('lost response retains pending; separately confirmed retry acknowledges only', async () => {
    const f = await fixture(); await f.stage(); await f.preview(); f.lostResponse = true;
    assert.match(await f.action(), /WRITE OUTCOME UNKNOWN/); assert.equal(f.writes, 1); assert.equal((await f.queue()).length, 1);
    f.lostResponse = false; const out = await f.preview(); assert.match(out.textContent, /ACKNOWLEDGE ONLY/);
    assert.match(await f.action(), /ALREADY_APPLIED — VERIFIED AND FINALIZED/); assert.equal(f.writes, 1); assert.equal((await f.queue()).length, 0);
  });
  await test('local edit after cloud write prevents acknowledgement', async () => { const f = await fixture(); await f.stage(); await f.preview(); f.onWrite = () => { f.context.S.notes[0].b = 'new-edit'; f.persist(); }; assert.match(await f.action(), /BASELINE UPDATE FAILED/); assert.equal((await f.queue()).length, 1); assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline)); });
  for (const [label, setup] of [
    ['recovery checkpoint', async f => f.off.syncStore('syncmeta', 'put', { id: 'checkpoint' }, 'controlled-notes-test-v1')],
    ['demo checkpoint', async f => f.off.syncStore('syncmeta', 'put', { id: 'checkpoint' }, 'demo-local-refresh-state-v1')],
    ['unrelated pending', async f => f.off.syncStore('outbox', 'put', { id: 'other' })],
    ['stale tab', f => { f.context.localStorage.setItem('pera', 'other'); }],
    ['financial changes', f => { f.context.S.accts[0].bal++; f.persist(); }],
    ['missing profile', f => { f.mutateValidation = v => { v.snapshot.profiles = []; }; }],
    ['duplicate profile', f => { f.mutateValidation = v => { v.snapshot.profiles.push(v.snapshot.profiles[0]); }; }],
    ['cloud read fails', f => { f.failRead = true; }],
  ]) await test(label + ' blocks redacted preview', async () => { const f = await fixture(); await setup(f); const out = await f.preview(); assert.match(out.textContent, /BLOCKED/); assert.equal(out.children.length, 0); f.redacted(out.textContent); assert.equal(f.writes, 0); });
  await test('locked action does not queue', async () => { const f = await fixture(); await f.preview(); f.locked = true; assert.match(await f.action(), /BLOCKED/); assert.equal((await f.queue()).length, 0); });
  await test('RPC readiness false retains queue', async () => { const f = await fixture(); await f.stage(); await f.preview(); f.ready = false; assert.match(await f.action(), /REFUSED/); assert.equal((await f.queue()).length, 1); assert.equal(f.writes, 0); });
  await test('checkpoint appearing during RPC readiness blocks transport', async () => { const f = await fixture(); await f.stage(); await f.preview(); f.onReady = () => f.off.syncStore('syncmeta', 'put', { id: 'new' }, 'controlled-notes-test-v1'); assert.match(await f.action(), /REFUSED/); assert.equal((await f.queue()).length, 1); assert.equal(f.writes, 0); });
  await test('empty exact cloud read is blocked and never recreated', async () => { const f = await fixture(); await f.stage(); await f.preview(); f.absent = true; assert.match(await f.action(), /REFUSED/); assert.equal(f.writes, 0); assert.equal((await f.queue()).length, 1); });
  await test('atomic staging guard false retains empty outbox', async () => {
    const f = await fixture(); await f.stage(); const entry = (await f.queue())[0]; await f.off.syncStore('outbox', 'delete', entry.id);
    await assert.rejects(f.off.stageVerifiedManualNote({ userId: owner, entry, expectedBaseline: f.baseline }, () => false)); assert.equal((await f.queue()).length, 0);
  });
  await test('atomic staging rejects promise guard', async () => {
    const f = await fixture(); await f.stage(); const entry = (await f.queue())[0]; await f.off.syncStore('outbox', 'delete', entry.id);
    await assert.rejects(f.off.stageVerifiedManualNote({ userId: owner, entry, expectedBaseline: f.baseline }, () => Promise.resolve(true))); assert.equal((await f.queue()).length, 0);
  });
  await test('staging postcommit failure is distinguishable and never pushes', async () => {
    const f = await fixture(); await f.preview();
    const original = fake.IDBDatabase.prototype.transaction;
    fake.IDBDatabase.prototype.transaction = function (stores, mode) { if (mode === 'readonly') throw Error('Readback failure'); return original.call(this, stores, mode); };
    try { assert.match(await f.action(), /STOPPED/); } finally { fake.IDBDatabase.prototype.transaction = original; }
    assert.equal(f.writes, 0); assert.equal((await f.queue()).length, 1); assert.equal(JSON.stringify(await f.base()), JSON.stringify(f.baseline));
  });
  console.log(`PASS: ${passed} manual notes UI/IndexedDB checks; isolated database and mocked cloud only`);
})().catch(e => { console.error(e); process.exitCode = 1; });
