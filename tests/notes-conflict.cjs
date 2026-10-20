/* Pure conflict-protection checks. Synthetic rows only; no storage or network. */
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const context = { crypto: webcrypto, TextEncoder, URLSearchParams, location: { search: '' }, localStorage: { getItem: () => null } };
context.window = context; vm.createContext(context);
for (const file of ['sync.js', 'notes-manual.js']) vm.runInContext(fs.readFileSync(`${__dirname}/../js/${file}`, 'utf8'), context);
const api = context.CapManualNotes, hash = context.CapSync.contentFingerprint, clone = x => JSON.parse(JSON.stringify(x));
const owner = 'owner-secret', id = 'conflict-note-secret';
const base = { id, user_id: owner, legacy_id: '1', title: 'title-secret', body: 'baseline-secret', note_date: '2026-10-20' };
const local = { ...base, body: 'local-secret' }, cloud = { ...base, body: 'cloud-secret' };
async function fixture(changes = {}) {
  const localRow = { ...local }, cloudRow = { ...cloud };
  if (changes.local) Object.assign(localRow, changes.local);
  if (changes.cloud) Object.assign(cloudRow, changes.cloud);
  const record = { entity: 'notes', localId: '1', supabase_id: id, user_id: owner, contentFingerprint: await hash(base) };
  const account = { entity: 'accounts', localId: '2', supabase_id: 'account-secret', user_id: owner, contentFingerprint: 'a'.repeat(64) };
  const pending = { id: 'operation-secret', source: 'manual-notes-v1', entity: 'notes', operation: 'upsert', user_id: owner,
    local_id: '1', supabase_id: id, payload: clone(localRow), manual_original: clone(base) };
  return { owner, syncOff: true, persisted: true, entries: changes.entries || [], recovery: changes.recovery || null,
    refresh: null, pullRecovery: changes.pullRecovery || null,
    baseline: { version: 2, user_id: owner, records: [record, account] }, notes: [localRow], pending,
    records: [{ ...record, contentFingerprint: await hash(localRow), cloudContentFingerprint: await hash(cloudRow) }, { ...account, cloudContentFingerprint: account.contentFingerprint }],
    validation: { missingCount: 0, unexpectedCount: 0, mismatchCount: 0, foreignKeyErrorCount: 0, snapshot: { notes: [cloudRow] } } };
}
let passed = 0;
async function test(label, body) { await body(); passed++; }
function noLeak(value) {
  const text = JSON.stringify(value);
  assert.ok(!/owner-secret|conflict-note-secret|title-secret|baseline-secret|local-secret|cloud-secret|account-secret|operation-secret/.test(text));
}
(async () => {
  await test('simultaneous body edits are a conflict and nothing is overwritten', async () => {
    const s = await fixture(), before = JSON.stringify(s), r = await api.plan(s, 'pull');
    assert.equal(r.allowed, false); assert.equal(r.conflict, true); assert.equal(r.status, 'CONFLICT — local and cloud changed; nothing overwritten');
    assert.equal(JSON.stringify(r.fields), '["body"]'); assert.equal(JSON.stringify(s), before); noLeak(r);
  });
  await test('multiple differing fields are named without values', async () => {
    const s = await fixture({ local: { title: 'local-title', note_date: '2026-10-21' }, cloud: { title: 'cloud-title', note_date: '2026-10-22' } });
    const r = await api.plan(s, 'pull'); assert.equal(r.conflict, true); assert.equal(JSON.stringify(r.fields), '["title","body","note_date"]'); noLeak(r);
  });
  await test('same field changed to different values still conflicts', async () => {
    const s = await fixture({ local: { title: 'local-title' }, cloud: { title: 'cloud-title' } });
    const r = await api.plan(s, 'pull'); assert.equal(r.allowed, false); assert.equal(r.conflict, true); assert.ok(r.fields.includes('title')); noLeak(r);
  });
  await test('local-only edit is blocked without being called a conflict', async () => {
    const s = await fixture({ cloud: { body: base.body } });
    const r = await api.plan(s, 'pull'); assert.equal(r.allowed, false); assert.match(r.status, /local edits/); assert.notEqual(r.conflict, true); noLeak(r);
  });
  await test('cloud-only edit still previews as a pull', async () => {
    const s = await fixture(); s.notes = [clone(base)]; s.records[0].contentFingerprint = await hash(base);
    const r = await api.plan(s, 'pull'); assert.equal(r.allowed, true); assert.equal(r.mode, 'pull'); assert.equal(JSON.stringify(r.fields), '["body"]');
    assert.equal(r.status, 'CLOUD NOTE CHANGE — pull preview ready');
  });
  await test('both sides reaching identical content is not mislabelled as a conflict', async () => {
    const s = await fixture({ local: { body: 'same-secret' }, cloud: { body: 'same-secret' } });
    const r = await api.plan(s, 'pull'); assert.equal(r.allowed, false); assert.notEqual(r.conflict, true); assert.match(r.status, /already match/); noLeak(r);
  });
  await test('pending outbox blocks before conflict inspection', async () => {
    const s = await fixture(); s.entries = [{ entity: 'notes' }];
    const r = await api.plan(s, 'pull'); assert.equal(r.allowed, false); assert.match(r.status, /pending operations/); assert.notEqual(r.conflict, true); noLeak(r);
  });
  await test('recovery checkpoint blocks before conflict inspection', async () => {
    const s = await fixture({ recovery: {} }); const r = await api.plan(s, 'pull');
    assert.equal(r.allowed, false); assert.match(r.status, /recovery/); assert.notEqual(r.conflict, true); noLeak(r);
  });
  await test('conflict plus local financial change remains blocked', async () => {
    const s = await fixture(); s.records[1].contentFingerprint = 'b'.repeat(64);
    const r = await api.plan(s, 'pull'); assert.equal(r.allowed, false); noLeak(r);
  });
  await test('push planner refuses a cloud-changed pending note', async () => {
    const s = await fixture(); s.entries = [s.pending];
    const before = JSON.stringify(s), r = await api.plan(s, 'push');
    assert.equal(r.allowed, false); assert.equal(r.conflict, true); assert.match(r.status, /cloud note changed/); assert.equal(JSON.stringify(r.fields), '["body"]');
    assert.equal(JSON.stringify(s), before); noLeak(r);
  });
  await test('push planner reports no conflict when the cloud still matches baseline', async () => {
    const s = await fixture(); s.entries = [s.pending]; s.validation.snapshot.notes[0] = clone(base); s.records[0].cloudContentFingerprint = await hash(base);
    const r = await api.plan(s, 'push'); assert.equal(r.allowed, true); assert.equal(r.mode, 'push'); assert.equal(r.status, 'PENDING NOTE — preview ready');
  });
  await test('push planner blocks unrelated cloud changes with field names only', async () => {
    const s = await fixture(); s.entries = [s.pending]; s.records[1].cloudContentFingerprint = 'b'.repeat(64);
    const r = await api.plan(s, 'push'); assert.equal(r.allowed, false); assert.match(r.status, /unrelated/); noLeak(r);
  });
  await test('synthetic self-check passes without touching storage or network', async () => {
    const first = await api.selfCheck(), second = await api.selfCheck();
    assert.equal(first.passed, true); assert.equal(first.pullBlocked, true); assert.equal(first.pushBlocked, true);
    assert.equal(first.cloudOnly, true); assert.equal(first.resolutionPreview, true); assert.equal(first.unchanged, true); assert.equal(second.passed, true);
    assert.equal(JSON.stringify(first), JSON.stringify(second)); noLeak(first);
  });
  console.log(`PASS: ${passed} conflict-protection planning checks; no storage or network`);
})().catch(error => { console.error(error); process.exitCode = 1; });
