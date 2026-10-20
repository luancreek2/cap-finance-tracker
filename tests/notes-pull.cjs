/* Pure pull planning and confirmation tests. No network or storage. */
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const context = { crypto: webcrypto, TextEncoder, URLSearchParams, location: { search: '' }, localStorage: { getItem: () => null } };
context.window = context; vm.createContext(context);
for (const file of ['sync.js', 'notes-manual.js']) vm.runInContext(fs.readFileSync(`${__dirname}/../js/${file}`, 'utf8'), context);
const api = context.CapManualNotes, hash = context.CapSync.contentFingerprint, clone = x => JSON.parse(JSON.stringify(x));
const owner = 'owner-secret', original = { id: 'note-secret', user_id: owner, legacy_id: '1', title: 'title-secret', body: 'original-secret', note_date: '2026-10-20' };
const cloud = { ...original, body: 'cloud-secret' };
async function fixture() {
  const base = { entity: 'notes', localId: '1', supabase_id: original.id, user_id: owner, contentFingerprint: await hash(original) };
  const account = { entity: 'accounts', localId: '2', supabase_id: 'account-secret', user_id: owner, contentFingerprint: 'a'.repeat(64) };
  return { owner, syncOff: true, persisted: true, entries: [], recovery: null, refresh: null, pullRecovery: null,
    baseline: { version: 2, user_id: owner, records: [base, account] }, notes: [clone(original)],
    records: [{ ...base, cloudContentFingerprint: await hash(cloud) }, { ...account, cloudContentFingerprint: account.contentFingerprint }],
    validation: { missingCount: 0, unexpectedCount: 0, mismatchCount: 0, foreignKeyErrorCount: 0, snapshot: { notes: [clone(cloud)] } } };
}
let passed = 0;
async function test(label, body) { await body(); passed++; }
(async () => {
  await test('cloud-only existing note preview is pure', async () => {
    const s = await fixture(), before = JSON.stringify(s), r = await api.plan(s, 'pull');
    assert.equal(r.allowed, true); assert.equal(r.mode, 'pull'); assert.equal(r.action, 'PULL ONE EXISTING NOTE');
    assert.equal(JSON.stringify(r.fields), '["body"]'); assert.equal(JSON.stringify(s), before);
  });
  await test('all note text fields can be pulled', async () => {
    const s = await fixture(); s.validation.snapshot.notes[0] = { ...cloud, title: 'new', note_date: null };
    s.records[0].cloudContentFingerprint = await hash(s.validation.snapshot.notes[0]);
    const r = await api.plan(s, 'pull'); assert.equal(r.allowed, true); assert.equal(JSON.stringify(r.fields), '["title","body","note_date"]');
  });
  for (const [label, setup] of [
    ['no authentication', s => { s.owner = null; }], ['cloud sync not off', s => { s.syncOff = false; }],
    ['stale local state', s => { s.persisted = false; }], ['test recovery', s => { s.recovery = {}; }],
    ['demo recovery', s => { s.refresh = {}; }], ['pull recovery', s => { s.pullRecovery = {}; }],
    ['foreign baseline', s => { s.baseline.user_id = 'other'; }], ['old baseline', s => { s.baseline.version = 1; }],
    ['empty baseline', s => { s.baseline.records = []; }], ['duplicate baseline', s => { s.baseline.records.push(clone(s.baseline.records[0])); }],
    ['bad fingerprint', s => { s.records[0].cloudContentFingerprint = 'bad'; }],
    ['missing cloud note', s => { s.validation.missingCount = 1; }], ['unexpected row', s => { s.validation.unexpectedCount = 1; }],
    ['foreign key error', s => { s.validation.foreignKeyErrorCount = 1; }], ['unread queue', s => { s.entries = null; }],
    ['validator mismatch', s => { s.validation.mismatchCount = 1; }],
    ['pending note', s => { s.entries = [{ entity: 'notes' }]; }], ['pending financial operation', s => { s.entries = [{ entity: 'accounts' }]; }],
    ['local and cloud conflict', s => { s.records[0].contentFingerprint = 'b'.repeat(64); }],
    ['local financial change', s => { s.records[1].contentFingerprint = 'b'.repeat(64); }],
    ['unrelated cloud change', s => { s.records[1].cloudContentFingerprint = 'b'.repeat(64); }],
    ['mapping drift', s => { s.records[0].localId = 'other'; }], ['wrong cloud owner', s => { s.validation.snapshot.notes[0].user_id = 'other'; }],
    ['wrong legacy mapping', s => { s.validation.snapshot.notes[0].legacy_id = 'other'; }],
    ['duplicate cloud mapping', s => { s.validation.snapshot.notes.push(clone(cloud)); }],
    ['no exact cloud row', s => { s.validation.snapshot.notes = []; }], ['no local row', s => { s.notes = []; }],
    ['null title cannot round-trip', s => { s.validation.snapshot.notes[0].title = null; }],
    ['null body cannot round-trip', s => { s.validation.snapshot.notes[0].body = null; }],
    ['unknown fields', s => { s.validation.snapshot.notes[0].unsupported = 'secret'; }],
  ]) await test(label + ' blocks without mutation or leakage', async () => {
    const s = await fixture(); setup(s); const before = JSON.stringify(s), r = await api.plan(s, 'pull');
    assert.equal(r.allowed, false); assert.match(r.status, /BLOCKED|CONFLICT/); assert.equal(JSON.stringify(s), before);
    assert.ok(!/owner-secret|note-secret|title-secret|cloud-secret|original-secret/.test(JSON.stringify(r)));
  });
  await test('unchanged cloud has no apply action', async () => {
    const s = await fixture(); s.records[0].cloudContentFingerprint = s.records[0].contentFingerprint; s.validation.snapshot.notes = [original];
    const r = await api.plan(s, 'pull'); assert.equal(r.allowed, false); assert.match(r.status, /NO CLOUD NOTE CHANGE/);
  });
  await test('pull recovery also blocks push planner', async () => {
    const s = await fixture(); s.pullRecovery = {}; const r = await api.plan(s); assert.equal(r.allowed, false); assert.match(r.status, /recovery/);
  });
  const receipt = { allowed: true, ticket: 't', decision: { mode: 'pull' } };
  let commits, confirms;
  const io = (overrides = {}) => { commits = confirms = 0; return { withLock: run => run(), inspect: async () => receipt,
    confirm: async () => { confirms++; return true; }, pull: async () => { commits++; return { committed: true, verified: true }; }, ...overrides }; };
  await test('pull needs fresh preview and confirmation', async () => { const r = await api.run('pull', 't', io()); assert.equal(r.allowed, true); assert.match(r.status, /PULLED/); assert.equal(commits, 1); assert.equal(confirms, 1); });
  await test('cancellation performs no apply', async () => { const r = await api.run('pull', 't', io({ confirm: async () => false })); assert.equal(r.allowed, false); assert.equal(commits, 0); });
  await test('stale ticket never prompts', async () => { await api.run('pull', 'old', io()); assert.equal(commits + confirms, 0); });
  await test('changed confirmation evidence blocks apply', async () => { let n = 0; await api.run('pull', 't', io({ inspect: async () => ++n === 1 ? receipt : { ...receipt, ticket: 'changed' } })); assert.equal(commits, 0); });
  await test('backup-first failure is distinct', async () => {
    const r = await api.run('pull', 't', io({ pull: async () => { throw Object.assign(Error('private'), { backedUp: true }); } }));
    assert.match(r.status, /LOCAL DATA NOT REPLACED/); assert.equal(r.allowed, false); assert.ok(!r.status.includes('private'));
  });
  await test('postcommit failure is distinct', async () => {
    const r = await api.run('pull', 't', io({ pull: async () => { throw Object.assign(Error('private'), { committed: true }); } }));
    assert.match(r.status, /LOCAL WRITE OCCURRED/); assert.equal(r.allowed, false);
  });
  await test('lock failure never applies', async () => { await api.run('pull', 't', io({ withLock: () => { throw Error('unavailable'); } })); assert.equal(commits + confirms, 0); });
  await test('unverified adapter result cannot pass', async () => { const r = await api.run('pull', 't', io({ pull: async () => ({ committed: true, verified: false }) })); assert.equal(r.allowed, false); });
  console.log(`PASS: ${passed} note-pull planning/confirmation checks; no storage or network`);
})().catch(e => { console.error(e); process.exitCode = 1; });
