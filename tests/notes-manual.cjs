/* Pure manual notes planning/confirmation tests. No database or network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const context = { crypto: webcrypto, TextEncoder, URLSearchParams, location: { search: '' }, localStorage: { getItem: () => null } };
context.window = context; vm.createContext(context);
for (const file of ['sync.js', 'notes-manual.js']) vm.runInContext(fs.readFileSync(`${__dirname}/../js/${file}`, 'utf8'), context);
const api = context.CapManualNotes, hash = context.CapSync.contentFingerprint;
const clone = x => JSON.parse(JSON.stringify(x));
const owner = 'owner-secret', id = 'note-secret', old = { id, user_id: owner, legacy_id: '1', title: 'title-secret', body: 'old-secret', note_date: '2026-10-20' };
const desired = { ...old, body: 'desired-secret' };
let passed = 0;
async function fixture() {
  const base = { entity: 'notes', supabase_id: id, localId: '1', user_id: owner, contentFingerprint: await hash(old) };
  const unrelated = { entity: 'accounts', supabase_id: 'account', localId: '2', user_id: owner, contentFingerprint: 'a'.repeat(64) };
  return { owner, syncOff: true, persisted: true, recovery: null, refresh: null,
    baseline: { version: 2, user_id: owner, records: [base, unrelated] }, entries: [], notes: [clone(desired)],
    records: [{ ...base, contentFingerprint: await hash(desired), cloudContentFingerprint: base.contentFingerprint }, { ...unrelated, cloudContentFingerprint: unrelated.contentFingerprint }],
    validation: { missingCount: 0, unexpectedCount: 0, foreignKeyErrorCount: 0, mismatchCount: 0, snapshot: { notes: [clone(old)] } } };
}
function queued(s) {
  s.entries = [{ id: 'op-secret', source: 'manual-notes-v1', entity: 'notes', operation: 'upsert', user_id: owner, supabase_id: id, local_id: '1', payload: clone(desired), manual_original: clone(old) }];
}
async function test(label, body) { await body(); passed++; }
async function refusal(label, setup, pattern = /BLOCKED|CONFLICT|NO NOTE EDIT/) {
  await test(label, async () => {
    const s = await fixture(); await setup(s); const before = JSON.stringify(s), result = await api.plan(s);
    assert.equal(result.allowed, false, label); assert.match(result.status, pattern); assert.equal(JSON.stringify(s), before);
    assert.ok(!/owner-secret|title-secret|desired-secret|old-secret|note-secret/.test(JSON.stringify(result)));
  });
}
(async () => {
  await test('mapped edit read-only preview', async () => {
    const s = await fixture(), before = JSON.stringify(s), r = await api.plan(s);
    assert.equal(r.allowed, true); assert.equal(r.mode, 'queue'); assert.equal(r.action, 'UPDATE ONE EXISTING NOTE');
    assert.equal(JSON.stringify(r.fields), '["body"]'); assert.equal(JSON.stringify(s), before);
  });
  await test('pending edit supports push preview', async () => {
    const s = await fixture(); queued(s); const r = await api.plan(s); assert.equal(r.allowed, true); assert.equal(r.mode, 'push');
  });
  await test('lost response convergence acknowledges without replay', async () => {
    const s = await fixture(); queued(s); s.validation.snapshot.notes = [clone(desired)]; s.records[0].cloudContentFingerprint = await hash(desired);
    const r = await api.plan(s); assert.equal(r.allowed, true); assert.equal(r.action, 'ACKNOWLEDGE ONLY');
  });
  for (const [label, setup] of [
    ['sync not off', s => { s.syncOff = false; }], ['stale local state', s => { s.persisted = false; }],
    ['authentication missing', s => { s.owner = null; }], ['checkpoint present', s => { s.recovery = {}; }],
    ['demo recovery present', s => { s.refresh = {}; }], ['foreign baseline', s => { s.baseline.user_id = 'other'; }],
    ['invalid baseline version', s => { s.baseline.version = 1; }], ['invalid record owner', s => { s.baseline.records[1].user_id = 'other'; }],
    ['malformed fingerprint', s => { s.baseline.records[0].contentFingerprint = 'bad'; }],
    ['duplicate baseline', s => { s.baseline.records.push(clone(s.baseline.records[0])); }],
    ['duplicate records', s => { s.records[1] = clone(s.records[0]); }],
    ['missing record', s => { s.validation.missingCount = 1; }], ['unexpected cloud row', s => { s.validation.unexpectedCount = 1; }],
    ['foreign key error', s => { s.validation.foreignKeyErrorCount = 1; }], ['failed validation', s => { s.validation = null; }],
    ['unrelated financial edit', s => { s.records[1].contentFingerprint = 'b'.repeat(64); }],
    ['unrelated cloud edit', s => { s.records[1].cloudContentFingerprint = 'b'.repeat(64); }],
    ['mapping drift', s => { s.records[0].localId = 'other'; }], ['unmapped new note', s => { s.records[0].supabase_id = 'new'; }],
    ['wrong entity', s => { s.records[0].entity = 'transactions'; }], ['multiple pending', s => { queued(s); s.entries.push(clone(s.entries[0])); }],
    ['other queued operation', s => { queued(s); s.entries[0].source = 'other'; }],
    ['pending deletion', s => { queued(s); s.entries[0].operation = 'delete'; }],
    ['edited again after queue', s => { queued(s); s.entries[0].payload.body = 'stale'; }],
    ['wrong queued mapping', s => { queued(s); s.entries[0].local_id = 'other'; }],
    ['foreign original', s => { queued(s); s.entries[0].manual_original.user_id = 'other'; }],
    ['stale original evidence', s => { queued(s); s.entries[0].manual_original.body = 'different'; }],
    ['cloud changed', s => { s.records[0].cloudContentFingerprint = 'c'.repeat(64); }],
    ['missing cloud result', s => { s.validation.snapshot.notes = []; }],
    ['duplicate cloud result', s => { s.validation.snapshot.notes.push(clone(old)); }],
    ['unsupported cloud fields', s => { s.validation.snapshot.notes[0].extra = 'secret'; }],
    ['cloud ownership mismatch', s => { s.validation.snapshot.notes[0].user_id = 'other'; }],
    ['no pending original', s => { queued(s); delete s.entries[0].manual_original; }],
  ]) await refusal(label, setup);
  await refusal('unchanged note', s => { s.notes = [clone(old)]; s.records[0].contentFingerprint = s.baseline.records[0].contentFingerprint; });
  await refusal('unqueued convergence requires review', async s => { s.records[0].cloudContentFingerprint = await hash(desired); s.validation.snapshot.notes = [clone(desired)]; });
  let stages, pushes, confirms, reads;
  const receipt = { allowed: true, ticket: 'preview-1', decision: { mode: 'queue' } };
  function io(overrides = {}) {
    stages = pushes = confirms = reads = 0;
    return { withLock: run => run(), inspect: async () => { reads++; return receipt; },
      confirm: async () => { confirms++; return true; }, stage: async () => { stages++; return { committed: true, verified: true }; },
      push: async () => { pushes++; return { status: 'APPLIED — VERIFIED AND FINALIZED', finalized: true }; }, ...overrides };
  }
  await test('queue requires two identical reads and consent', async () => { const r = await api.run('queue', 'preview-1', io()); assert.equal(r.allowed, true); assert.equal(stages, 1); assert.equal(pushes, 0); assert.equal(reads, 2); assert.equal(confirms, 1); });
  await test('push uses separate consent', async () => { const r = await api.run('push', 'preview-1', io({ inspect: async () => ({ ...receipt, decision: { mode: 'push' } }) })); assert.equal(r.allowed, true); assert.equal(pushes, 1); assert.equal(stages, 0); });
  await test('cancellation changes nothing', async () => { const r = await api.run('queue', 'preview-1', io({ confirm: async () => false })); assert.equal(r.allowed, false); assert.equal(stages + pushes, 0); });
  await test('stale preview never prompts', async () => { await api.run('queue', 'wrong', io()); assert.equal(confirms + stages + pushes, 0); });
  await test('changed confirmation evidence blocks', async () => { let n = 0; await api.run('queue', 'preview-1', io({ inspect: async () => (++n === 1 ? receipt : { ...receipt, ticket: 'other' }) })); assert.equal(stages + pushes, 0); });
  await test('failed staging does not push', async () => { const r = await api.run('queue', 'preview-1', io({ stage: async () => { throw Error('private secret'); } })); assert.equal(r.allowed, false); assert.match(r.status, /STOPPED/); assert.equal(pushes, 0); assert.ok(!r.status.includes('secret')); });
  await test('lock failure does not stage', async () => { const r = await api.run('queue', 'preview-1', io({ withLock: () => { throw Error('private'); } })); assert.equal(r.allowed, false); assert.equal(stages + pushes, 0); });
  await test('no automatic retry after failed push', async () => { const r = await api.run('push', 'preview-1', io({ inspect: async () => ({ ...receipt, decision: { mode: 'push' } }), push: async () => { pushes++; return { status: 'WRITE OUTCOME UNKNOWN — NOTHING FINALIZED', finalized: false }; } })); assert.equal(r.allowed, false); assert.equal(pushes, 1); });
  console.log(`PASS: ${passed} manual notes planning/confirmation checks; simulated data only`);
})().catch(e => { console.error(e); process.exitCode = 1; });
