/* Pure conflict-resolution planning and confirmation checks. Synthetic rows
   only; no storage or network. */
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const context = { crypto: webcrypto, TextEncoder, URLSearchParams, location: { search: '' }, localStorage: { getItem: () => null } };
context.window = context; vm.createContext(context);
for (const file of ['sync.js', 'notes-manual.js']) vm.runInContext(fs.readFileSync(`${__dirname}/../js/${file}`, 'utf8'), context);
const api = context.CapManualNotes, hash = context.CapSync.contentFingerprint, clone = x => JSON.parse(JSON.stringify(x));
const owner = 'owner-secret', id = 'resolution-note-secret';
const base = { id, user_id: owner, legacy_id: '1', title: 'title-secret', body: 'baseline-secret', note_date: '2026-10-20' };
const local = { ...base, body: 'local-secret' }, cloud = { ...base, body: 'cloud-secret' };
async function fixture(changes = {}) {
  const localRow = { ...local }, cloudRow = { ...cloud };
  if (changes.local) Object.assign(localRow, changes.local);
  if (changes.cloud) Object.assign(cloudRow, changes.cloud);
  const record = { entity: 'notes', localId: '1', supabase_id: id, user_id: owner, contentFingerprint: await hash(base) };
  const account = { entity: 'accounts', localId: '2', supabase_id: 'account-secret', user_id: owner, contentFingerprint: 'a'.repeat(64) };
  return { owner, syncOff: true, persisted: true, entries: changes.entries || [], recovery: changes.recovery || null,
    refresh: null, pullRecovery: changes.pullRecovery || null,
    baseline: { version: 2, user_id: owner, records: [record, account] }, notes: [localRow],
    records: [{ ...record, contentFingerprint: await hash(localRow), cloudContentFingerprint: await hash(cloudRow) }, { ...account, cloudContentFingerprint: account.contentFingerprint }],
    validation: { missingCount: 0, unexpectedCount: 0, mismatchCount: 0, foreignKeyErrorCount: 0, snapshot: { notes: [cloudRow] } } };
}
let passed = 0;
async function test(label, body) { await body(); passed++; }
function noContentInStatus(r) {
  assert.ok(!/owner-secret|resolution-note-secret|title-secret|baseline-secret|local-secret|cloud-secret|account-secret/.test(JSON.stringify({ status: r.status, action: r.action, fields: r.fields })));
}
(async () => {
  await test('one divergent note conflict is previewable without mutation', async () => {
    const s = await fixture(), before = JSON.stringify(s), r = await api.plan(s, 'resolve');
    assert.equal(r.allowed, true); assert.equal(r.mode, 'resolve'); assert.equal(r.status, 'CONFLICT — resolution preview ready');
    assert.equal(r.action, 'REVIEW ONE NOTE CONFLICT'); assert.equal(JSON.stringify(r.fields), '["body"]');
    assert.equal(r.local.body, 'local-secret'); assert.equal(r.cloud.body, 'cloud-secret'); assert.equal(r.record.contentFingerprint, await hash(base));
    assert.equal(r.canKeepCloud, true); assert.equal(r.canKeepLocal, true); assert.equal(JSON.stringify(s), before); noContentInStatus(r);
  });
  await test('multiple differing fields are reported by name', async () => {
    const s = await fixture({ local: { title: 'local-title', note_date: '2026-10-21' }, cloud: { title: 'cloud-title', note_date: '2026-10-22' } });
    const r = await api.plan(s, 'resolve'); assert.equal(r.allowed, true); assert.equal(JSON.stringify(r.fields), '["title","body","note_date"]');
  });
  await test('agreement has no resolution action', async () => {
    const s = await fixture({ local: { body: base.body }, cloud: { body: base.body } }); s.notes[0] = clone(base);
    s.records[0].contentFingerprint = await hash(base); s.records[0].cloudContentFingerprint = await hash(base);
    const r = await api.plan(s, 'resolve'); assert.equal(r.allowed, false); assert.match(r.status, /NO CONFLICT TO RESOLVE/);
  });
  for (const [label, setup, status] of [
    ['local-only change', async (s, bf) => { s.validation.snapshot.notes[0] = clone(base); s.records[0].cloudContentFingerprint = bf; }, /local-only change/],
    ['cloud-only change', async (s, bf) => { s.notes[0] = clone(base); s.records[0].contentFingerprint = bf; }, /cloud-only change/],
    ['pending outbox', s => { s.entries = [{ entity: 'notes' }]; }, /pending operations/],
    ['test recovery', s => { s.recovery = {}; }, /recovery/],
    ['pull recovery', s => { s.pullRecovery = {}; }, /recovery/],
    ['unrelated local change', s => { s.records[1].contentFingerprint = 'b'.repeat(64); }, /exactly one|unrelated/],
    ['unrelated cloud change', s => { s.records[1].cloudContentFingerprint = 'b'.repeat(64); }, /exactly one|unrelated/],
    ['mapping drift', s => { s.records[0].localId = 'other'; }, /mapping|coverage|ownership/],
    ['wrong cloud owner', s => { s.validation.snapshot.notes[0].user_id = 'other'; }, /mapping|ownership|complete/],
    ['bad local fingerprint', s => { s.records[0].contentFingerprint = 'b'.repeat(64); }, /conflict content|mapping/],
    ['null title cannot round-trip', s => { s.validation.snapshot.notes[0].title = null; }, /conflict content|complete/],
    ['duplicate cloud mapping', s => { s.validation.snapshot.notes.push(clone(cloud)); }, /mapping/],
    ['stale persisted state', s => { s.persisted = false; }, /authentication|persistence/],
    ['cloud sync not off', s => { s.syncOff = false; }, /authentication|Cloud Sync/],
    ['validator mismatch', s => { s.validation.mismatchCount = 1; }, /mismatch/],
  ]) await test(label + ' blocks resolution', async () => {
    const s = await fixture(); await setup(s, await hash(base));
    const before = JSON.stringify(s), r = await api.plan(s, 'resolve');
    assert.equal(r.allowed, false); assert.match(r.status, status); assert.equal(JSON.stringify(s), before); noContentInStatus(r);
  });
  const receipt = { allowed: true, ticket: 't', decision: { mode: 'resolve', local: { legacy_id: '1' }, cloud: { id } } };
  let commits, confirms;
  const io = (overrides = {}) => { commits = confirms = 0; return { withLock: run => run(), inspect: async () => receipt,
    confirm: async () => { confirms++; return true; }, resolve: async () => { commits++; return { committed: true, verified: true }; }, ...overrides }; };
  await test('resolution needs fresh preview and confirmation', async () => {
    const r = await api.run('resolve', 't', io()); assert.equal(r.allowed, true); assert.match(r.status, /RESOLVED — CLOUD VERSION KEPT/);
    assert.equal(commits, 1); assert.equal(confirms, 1);
  });
  await test('keep-local success status is surfaced', async () => {
    const r = await api.run('resolve', 't', io({ resolve: async () => { commits++; return { committed: true, verified: true, status: 'RESOLVED — LOCAL VERSION KEPT; CLOUD OVERWRITTEN; LOCAL BACKUP RETAINED' }; } }));
    assert.equal(r.allowed, true); assert.match(r.status, /RESOLVED — LOCAL VERSION KEPT; CLOUD OVERWRITTEN/); assert.equal(commits, 1);
  });
  await test('cancellation performs no resolution', async () => { const r = await api.run('resolve', 't', io({ confirm: async () => false })); assert.equal(r.allowed, false); assert.equal(commits, 0); });
  await test('stale ticket never prompts', async () => { await api.run('resolve', 'old', io()); assert.equal(commits + confirms, 0); });
  await test('changed evidence blocks resolution', async () => {
    let n = 0; await api.run('resolve', 't', io({ inspect: async () => ++n === 1 ? receipt : { ...receipt, ticket: 'changed' } })); assert.equal(commits, 0);
  });
  await test('backup-first failure is distinct and redacted', async () => {
    const r = await api.run('resolve', 't', io({ resolve: async () => { throw Object.assign(Error('private'), { backedUp: true }); } }));
    assert.match(r.status, /RESOLUTION BACKUP\/CHECKPOINT RETAINED/); assert.equal(r.allowed, false); assert.ok(!r.status.includes('private'));
  });
  await test('postcommit failure is distinct', async () => {
    const r = await api.run('resolve', 't', io({ resolve: async () => { throw Object.assign(Error('private'), { committed: true }); } }));
    assert.match(r.status, /LOCAL WRITE OCCURRED — RESOLUTION/); assert.equal(r.allowed, false);
  });
  await test('cloud-written failure is distinct and redacted', async () => {
    const status = 'CLOUD WRITE OCCURRED — RESOLUTION VERIFICATION FAILED; INSPECT NOTE-PULL RECOVERY';
    const r = await api.run('resolve', 't', io({ resolve: async () => { throw Object.assign(Error('private'), { status }); } }));
    assert.equal(r.status, status); assert.equal(r.allowed, false); assert.ok(!r.status.includes('private'));
  });
  await test('unknown cloud outcome is distinct and redacted', async () => {
    const status = 'CLOUD WRITE OUTCOME UNKNOWN — INSPECT NOTE-PULL RECOVERY BEFORE ANY RETRY';
    const r = await api.run('resolve', 't', io({ resolve: async () => { throw Object.assign(Error('private'), { status }); } }));
    assert.equal(r.status, status); assert.equal(r.allowed, false); assert.ok(!r.status.includes('private'));
  });
  await test('unverified resolution cannot pass', async () => {
    const r = await api.run('resolve', 't', io({ resolve: async () => ({ committed: true, verified: false }) })); assert.equal(r.allowed, false);
  });
  await test('lock failure never applies', async () => {
    await api.run('resolve', 't', io({ withLock: () => { throw Error('unavailable'); } })); assert.equal(commits + confirms, 0);
  });
  console.log(`PASS: ${passed} conflict-resolution planning/confirmation checks; no storage or network`);
})().catch(error => { console.error(error); process.exitCode = 1; });
