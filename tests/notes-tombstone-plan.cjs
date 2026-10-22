/* Synthetic pure-planner checks. No app boot, persistence, or network. */
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const source = fs.readFileSync(`${__dirname}/../js/notes-tombstone-plan.js`, 'utf8');
const context = { module: { exports: {} }, crypto: webcrypto, TextEncoder };
let sideEffects = 0;
for (const name of ['window', 'document', 'localStorage', 'indexedDB', 'fetch', 'navigator', 'setTimeout']) {
  Object.defineProperty(context, name, { get() { sideEffects++; throw Error('Forbidden external access'); } });
}
vm.createContext(context); vm.runInContext(source, context);
const api = context.module.exports, clone = x => JSON.parse(JSON.stringify(x));
const owner = 'owner-secret', noteId = '00000000-0000-4000-8000-000000000011';
const contentHash = row => createHash('sha256').update(JSON.stringify({ body: row.body, note_date: row.note_date, title: row.title })).digest('hex');
const life = (revision = 4, deleted = false, operation_id = null) => ({ version: 1, revision,
  deleted_at: deleted ? '2026-10-21T00:00:00.000Z' : null, operation_id });
function fixture(kind = 'tombstone') {
  const row = { id: noteId, user_id: owner, legacy_id: '1', title: 'title-secret', body: 'body-secret', note_date: '2026-10-20' };
  const record = { entity: 'notes', user_id: owner, localId: '1', supabase_id: noteId, contentFingerprint: contentHash(row), lifecycle: life() };
  return { version: 1, owner, syncOff: true, persisted: true,
    capabilities: { version: 'notes-lifecycle-v1', read: true, cas: true, bypassProtected: true },
    coverage: { complete: true, unrelatedUnchanged: true }, entries: [], checkpoints: { test: null, demo: null, pull: null, tombstone: null },
    baseline: { version: 2, user_id: owner, records: [record, { entity: 'accounts', user_id: owner, localId: '2', supabase_id: 'account-secret', contentFingerprint: 'a'.repeat(64) }] },
    target: { entity: 'notes', localId: '1', supabase_id: noteId },
    local: kind === 'active' ? { kind, row: clone(row) } : kind === 'missing' ? { kind } : { kind,
      intent: { version: 1, operation_id: 'operation-secret', user_id: owner, localId: '1', supabase_id: noteId,
        original: clone(row), expected: { contentFingerprint: record.contentFingerprint, lifecycle: life() } }, acknowledged: null },
    cloud: { kind: 'row', row: clone(row), lifecycle: life() } };
}
function tombstone(s, operation = 'operation-secret', revision = 5) { s.cloud.lifecycle = life(revision, true, operation); return s; }
function safe(r) {
  assert.equal(r.executable, false); assert.equal(r.authorized, false); assert.equal(r.canRestore, false); assert.equal(r.canPurge, false);
  assert.ok(!/owner-secret|title-secret|body-secret|account-secret|operation-secret|00000000-0000-4000-8000-000000000011|private-error/.test(JSON.stringify(r)));
  assert.equal(sideEffects, 0);
}
let passed = 0;
async function test(label, fn) { try { await fn(); passed++; } catch (e) { e.message = label + ': ' + e.message; throw e; } }
async function decision(s, expected, preview = false) {
  const original = JSON.stringify(s), r = await api.plan(s); safe(r);
  assert.equal(r.classification, expected); assert.equal(r.previewReady, preview); assert.equal(JSON.stringify(s), original);
  if (preview) { assert.match(r.ticket, /^[0-9a-f]{64}$/); assert.equal(r.requiresConfirmation, true); }
  else assert.equal(r.ticket, undefined);
  return r;
}
(async () => {
  await test('exports only planning and review, not an executor', async () => {
    assert.deepEqual(Object.keys(api).sort(), ['plan', 'review']); assert.equal(Object.isFrozen(api), true); assert.equal(sideEffects, 0);
  });
  await test('planner is not wired into HTML or the cached app shell', async () => {
    for (const file of ['index.html', 'service-worker.js']) assert.ok(!fs.readFileSync(`${__dirname}/../${file}`, 'utf8').includes('notes-tombstone-plan.js'));
  });
  await test('active unchanged records have no deletion work', () => decision(fixture('active'), 'NOT_DELETION_WORK'));
  await test('explicit delete intent previews CAS but cannot execute', async () => {
    const r = await decision(fixture(), 'LOCAL_DELETE_INTENT', true); assert.equal(r.proposedAction, 'PREVIEW_CLOUD_TOMBSTONE');
  });
  await test('local absence is not intent', () => decision(fixture('missing'), 'BLOCKED'));
  await test('newer cloud edit conflicts with local deletion', async () => {
    const s = fixture(); s.cloud.row.body = 'new cloud body'; s.cloud.lifecycle.revision++;
    await decision(s, 'CONFLICT');
  });
  await test('same content with newer revision is an ABA conflict', async () => {
    const s = fixture(); s.cloud.lifecycle.revision += 2; await decision(s, 'CONFLICT');
  });
  await test('unchanged local note previews remote tombstone application', async () => {
    const r = await decision(tombstone(fixture('active'), 'remote-operation'), 'CLOUD_TOMBSTONE', true);
    assert.equal(r.proposedAction, 'PREVIEW_LOCAL_TOMBSTONE');
  });
  await test('local edit against remote tombstone conflicts', async () => {
    const s = tombstone(fixture('active')); s.local.row.body = 'local edit'; await decision(s, 'CONFLICT');
  });
  await test('remote edit then deletion also preserves both versions', async () => {
    const s = tombstone(fixture('active')); s.cloud.row.body = 'remote edit'; await decision(s, 'CONFLICT');
  });
  await test('matching operation tombstone previews acknowledgement only', async () => {
    const r = await decision(tombstone(fixture()), 'TOMBSTONE_CONVERGED', true); assert.equal(r.proposedAction, 'PREVIEW_ACKNOWLEDGEMENT');
  });
  await test('different tombstone operations cannot converge implicitly', () => decision(tombstone(fixture(), 'other-operation'), 'CONFLICT'));
  await test('matching operation cannot mask intervening revisions', () => decision(tombstone(fixture(), 'operation-secret', 7), 'CONFLICT'));
  await test('matching operation cannot mask changed content', async () => {
    const s = tombstone(fixture()); s.cloud.row.title = 'changed title'; await decision(s, 'CONFLICT');
  });
  await test('acknowledged tombstone is retained without purge', async () => {
    const s = tombstone(fixture()); s.baseline.records[0].lifecycle = clone(s.cloud.lifecycle);
    s.local.acknowledged = { lifecycle: clone(s.cloud.lifecycle), contentFingerprint: s.baseline.records[0].contentFingerprint };
    await decision(s, 'DELETION_ACKNOWLEDGED');
  });
  for (const [label, mutate, expected] of [
    ['acknowledged remote lifecycle after intervening revisions', () => {}, 'DELETION_ACKNOWLEDGED'],
    ['remote acknowledgement operation mismatch', s => { s.local.acknowledged.lifecycle.operation_id = 'wrong'; }, 'BLOCKED'],
    ['remote original content mismatch', s => { s.local.original.body = 'wrong'; }, 'BLOCKED'],
    ['remote original ownership mismatch', s => { s.local.original.user_id = 'wrong'; }, 'BLOCKED'],
    ['remote restoration is not implicit acknowledgement', s => { s.cloud.lifecycle = life(8); }, 'BLOCKED'],
  ]) await test(label, async () => {
    const s = tombstone(fixture('active'), 'remote-operation', 7);
    s.baseline.records[0].lifecycle = clone(s.cloud.lifecycle);
    s.local = { kind: 'remote-tombstone', original: clone(s.local.row),
      acknowledged: { contentFingerprint: s.baseline.records[0].contentFingerprint, lifecycle: clone(s.cloud.lifecycle) } };
    mutate(s); await decision(s, expected);
  });
  await test('active record cannot restore a deleted baseline', async () => {
    const s = tombstone(fixture('active')); s.baseline.records[0].lifecycle = clone(s.cloud.lifecycle); await decision(s, 'BLOCKED');
  });
  await test('deleted baseline without matching local acknowledgement blocks', async () => {
    const s = tombstone(fixture()); s.baseline.records[0].lifecycle = clone(s.cloud.lifecycle); await decision(s, 'BLOCKED');
  });
  await test('active content-only edits stay in the existing review flow', async () => {
    const s = fixture('active'); s.local.row.body = 'local edit'; s.cloud.row.body = 'remote edit'; s.cloud.lifecycle.revision++;
    await decision(s, 'NOT_DELETION_WORK');
  });
  for (const [label, mutate] of [
    ['missing owner', s => { s.owner = ''; }],
    ['owner mismatch', s => { s.baseline.user_id = 'other'; }],
    ['sync not OFF', s => { s.syncOff = false; }],
    ['truthy sync flag', s => { s.syncOff = 'true'; }],
    ['stale persistence', s => { s.persisted = false; }],
    ['incomplete coverage', s => { s.coverage.complete = false; }],
    ['unrelated differences', s => { s.coverage.unrelatedUnchanged = false; }],
    ['pending queue', s => { s.entries = [{ id: 'pending-secret' }]; }],
    ['missing queue evidence', s => { delete s.entries; }],
    ['missing recovery evidence', s => { delete s.checkpoints.pull; }],
    ['malformed recovery evidence', s => { s.checkpoints.test = false; }],
    ['unknown top-level field', s => { s.automatic = true; }],
    ['unknown snapshot version', s => { s.version = 2; }],
    ['missing capability', s => { delete s.capabilities; }],
    ['unsupported capability', s => { s.capabilities.version = 'legacy'; }],
    ['bypass protection absent', s => { s.capabilities.bypassProtected = false; }],
    ['reader not ready', s => { s.capabilities.read = false; }],
    ['writer not ready', s => { s.capabilities.cas = false; }],
    ['legacy baseline', s => { s.baseline.version = 1; }],
    ['unrelated baseline owner drift', s => { s.baseline.records[1].user_id = 'other'; }],
    ['duplicate mapping', s => { s.baseline.records.push(clone(s.baseline.records[0])); }],
    ['target UUID drift', s => { s.target.supabase_id = '00000000-0000-4000-8000-000000000012'; }],
    ['target local ID drift', s => { s.target.localId = 'other'; }],
    ['malformed target UUID', s => { s.target.supabase_id = 'not-a-uuid'; }],
    ['financial entity', s => { s.target.entity = 'accounts'; }],
    ['missing baseline lifecycle', s => { delete s.baseline.records[0].lifecycle; }],
    ['bad baseline content hash', s => { s.baseline.records[0].contentFingerprint = 'not-a-hash'; }],
    ['cloud ownership mismatch', s => { s.cloud.row.user_id = 'other'; }],
    ['cloud UUID mismatch', s => { s.cloud.row.id = 'other'; }],
    ['cloud legacy identity mismatch', s => { s.cloud.row.legacy_id = 'other'; }],
    ['unknown cloud content column', s => { s.cloud.row.deleted_at = null; }],
    ['missing cloud date', s => { delete s.cloud.row.note_date; }],
    ['impossible note date', s => { s.cloud.row.note_date = '2026-02-30'; }],
    ['null body', s => { s.cloud.row.body = null; }],
    ['unknown lifecycle version', s => { s.cloud.lifecycle.version = 2; }],
    ['zero revision', s => { s.cloud.lifecycle.revision = 0; }],
    ['fractional revision', s => { s.cloud.lifecycle.revision = 4.5; }],
    ['unsafe revision', s => { s.cloud.lifecycle.revision = Number.MAX_SAFE_INTEGER + 1; }],
    ['revision rollback', s => { s.cloud.lifecycle.revision--; }],
    ['changed content without revision', s => { s.cloud.row.body = 'changed'; }],
    ['changed lifecycle without revision', s => { s.cloud.lifecycle.operation_id = 'changed'; }],
    ['invalid deletion timestamp', s => { s.cloud.lifecycle = life(5, true, 'operation-secret'); s.cloud.lifecycle.deleted_at = '2026-02-30T00:00:00.000Z'; }],
    ['tombstone missing operation', s => { s.cloud.lifecycle = life(5, true, null); }],
    ['local tombstone unknown field', s => { s.local.restore = true; }],
    ['intent missing', s => { s.local.intent = null; }],
    ['intent owner mismatch', s => { s.local.intent.user_id = 'other'; }],
    ['intent ID mismatch', s => { s.local.intent.supabase_id = 'other'; }],
    ['original snapshot changed', s => { s.local.intent.original.body = 'changed'; }],
    ['intent lifecycle drift', s => { s.local.intent.expected.lifecycle.revision--; }],
    ['intent expected deletion', s => { s.local.intent.expected.lifecycle = life(3, true, 'old'); }],
    ['premature acknowledgement', s => { s.local.acknowledged = {}; }],
  ]) await test(label + ' fails closed', async () => { const s = fixture(); mutate(s); await decision(s, 'BLOCKED'); });
  for (const checkpoint of ['test', 'demo', 'pull', 'tombstone']) await test(checkpoint + ' recovery blocks', async () => {
    const s = fixture(); s.checkpoints[checkpoint] = {}; await decision(s, 'BLOCKED');
  });
  for (const kind of ['active', 'missing', 'tombstone']) for (const cloud of ['missing', 'unreadable']) {
    await test(kind + ' plus ' + cloud + ' never authorizes deletion', async () => {
      const s = fixture(kind); s.cloud = { kind: cloud }; await decision(s, 'BLOCKED');
    });
  }
  await test('missing local row with ad hoc intent is still not a staged tombstone', async () => {
    const s = fixture(); s.local.kind = 'missing'; await decision(s, 'BLOCKED');
  });
  await test('fresh ticket reviews but still cannot execute', async () => {
    const s = fixture(), p = await api.plan(s), r = await api.review(s, p.ticket); safe(r);
    assert.equal(r.previewReady, true); assert.equal(r.ticket, p.ticket);
  });
  for (const [label, mutate] of [
    ['cloud revision', s => { s.cloud.lifecycle.revision++; }],
    ['cloud updated_at', s => { s.cloud.row.updated_at = '2026-10-21T01:00:00.000Z'; }],
    ['operation identity', s => { s.local.intent.operation_id = 'new-operation'; }],
    ['baseline revision', s => { s.baseline.revision = 8; }],
    ['unrelated baseline evidence', s => { s.baseline.records[1].contentFingerprint = 'b'.repeat(64); }],
    ['pending queue', s => { s.entries.push({ id: 'pending' }); }],
  ]) await test('ticket detects changed ' + label, async () => {
    const s = fixture(), p = await api.plan(s); mutate(s);
    const r = await api.review(s, p.ticket); safe(r); assert.equal(r.previewReady, false); assert.match(r.status, /evidence changed/);
  });
  await test('key order does not invalidate equivalent evidence', async () => {
    const s = fixture(), p = await api.plan(s), shuffled = Object.fromEntries(Object.entries(s).reverse());
    const r = await api.review(shuffled, p.ticket); safe(r); assert.equal(r.previewReady, true);
  });
  await test('date-only content changes invalidate tickets and original snapshot proof', async () => {
    const s = fixture(), p = await api.plan(s); s.local.intent.original.note_date = '2026-10-21';
    const r = await api.review(s, p.ticket); safe(r); assert.equal(r.previewReady, false);
  });
  await test('caller mutation while hashing cannot alter the detached decision', async () => {
    const s = fixture(), original = clone(s), pending = api.plan(s); s.local.intent.operation_id = 'changed-after-call';
    const r = await pending, expected = await api.plan(original); safe(r); assert.equal(r.ticket, expected.ticket);
    assert.equal((await api.review(s, r.ticket)).previewReady, false);
  });
  for (const malformed of [undefined, null, [], {}, { owner }, { value: NaN }, { value: () => {} }]) {
    await test('malformed top-level evidence is redacted', async () => { const r = await api.plan(malformed); safe(r); assert.equal(r.classification, 'BLOCKED'); });
  }
  await test('cyclic and throwing evidence cannot leak raw errors', async () => {
    const s = fixture(); s.loop = s; safe(await api.plan(s));
    const t = {}; Object.defineProperty(t, 'owner', { enumerable: true, get() { throw Error('private-error'); } });
    const r = await api.plan(t); safe(r); assert.equal(r.classification, 'BLOCKED');
  });
  await test('invalid ticket never produces a preview', async () => {
    for (const ticket of [null, '', 'private-error', {}, 1]) { const r = await api.review(fixture(), ticket); safe(r); assert.equal(r.previewReady, false); }
  });
  await test('ticket hashing failure fails closed without a raw error', async () => {
    let digests = 0;
    const c = { module: { exports: {} }, TextEncoder, crypto: { subtle: { digest: async (...args) => {
      if (++digests === 3) throw Error('private-error');
      return webcrypto.subtle.digest(...args);
    } } } };
    vm.createContext(c); vm.runInContext(source, c);
    const r = await c.module.exports.plan(fixture()); safe(r); assert.equal(r.classification, 'BLOCKED'); assert.equal(r.previewReady, false);
    assert.equal(digests, 3);
  });
  console.log(`PASS: ${passed} pure tombstone-planner checks; zero storage, network, or app boot`);
})().catch(error => { console.error(error); process.exitCode = 1; });
