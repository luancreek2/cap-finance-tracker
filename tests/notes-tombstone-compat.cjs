/* Pure compatibility guard tests, synthetic data only. Never imports into S. */
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
let accesses = 0;
const c = { module: { exports: {} }, crypto: webcrypto, TextEncoder };
for (const k of ['window','document','navigator','fetch','localStorage','indexedDB','setTimeout'])
  Object.defineProperty(c, k, { get() { accesses++; throw Error('private-error'); } });
vm.createContext(c); vm.runInContext(fs.readFileSync(`${__dirname}/../js/notes-tombstone-compat.js`, 'utf8'), c);
const api = c.module.exports, clone = x => JSON.parse(JSON.stringify(x)), owner = 'owner-secret';
const cloudId = '00000000-0000-4000-8000-000000000011', op = '00000000-0000-4000-8000-000000000021';
const row = { id: cloudId, user_id: owner, legacy_id: '1', title: 'title-secret', body: 'body-secret', note_date: '2026-10-20' };
const fp = createHash('sha256').update(JSON.stringify({ body: row.body, note_date: row.note_date, title: row.title })).digest('hex');
const life = (revision = 4, deleted = false) => ({ version: 1, revision, deleted_at: deleted ? '2026-10-21T00:00:00.000Z' : null, operation_id: deleted ? op : null });
const state = () => ({ _mt: 1, notes: [{ id: 1, t: row.title, b: row.body, d: row.note_date, _u: 1 }],
  accts: [{ id: 9, label: 'financial-secret', bal: 100 }], tx: [], pend: [], budgets: {}, preference: 'keep' });
function deleted(remote = false) {
  const d = state(); d.notes = []; d.noteTombstones = [{ id: op, user_id: owner, localId: '1', supabase_id: cloudId,
    ...(remote ? { origin: 'cloud', original: clone(row), acknowledged: { contentFingerprint: fp, lifecycle: life(7, true) } } : {
      intent: { version: 1, operation_id: op, user_id: owner, localId: '1', supabase_id: cloudId, original: clone(row),
        expected: { contentFingerprint: fp, lifecycle: life() } }, acknowledged: null }), staged_at: '2026-10-21T00:00:00.000Z' }]; return d;
}
const mergeInput = () => ({ owner, base: state(), local: deleted(), remote: state() });
const importInput = () => ({ owner, current: deleted(), incoming: state(), format: 'json', mode: 'merge' });
function safe(r) {
  const { privateNotes, privateJson, ...diagnostic } = r;
  assert.ok(!/owner-secret|title-secret|body-secret|financial-secret|private-error|00000000-0000-4000-8000-000000000011/.test(JSON.stringify(diagnostic)));
  assert.equal(accesses, 0);
  if (Object.hasOwn(r, 'executable')) { assert.equal(r.executable, false); assert.equal(r.authorized, false); assert.equal(r.canRestore, false); assert.equal(r.canPurge, false); }
}
let passed = 0;
async function test(label, fn) { try { await fn(); passed++; } catch (e) { e.message = label + ': ' + e.message; throw e; } }
async function plan(kind, s, classification) {
  const before = JSON.stringify(s), r = await (kind === 'merge' ? api.planMerge(s) : api.planImport(s));
  safe(r); assert.equal(r.classification, classification); assert.equal(JSON.stringify(s), before);
  if (r.previewReady) {
    assert.equal(r.requiresConfirmation, true); assert.match(r.ticket, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(r.privateNotes).sort(), ['noteTombstones','notes']); assert.equal(r.privateNotes.accts, undefined);
  } else assert.equal(r.privateNotes, undefined);
  return r;
}
(async () => {
  await test('module has only pure previews, inspection, and private export', async () => {
    assert.deepEqual(Object.keys(api).sort(), ['exportPrivate','inspect','planImport','planMerge','review']);
    for (const file of ['index.html','service-worker.js']) assert.ok(!fs.readFileSync(`${__dirname}/../${file}`, 'utf8').includes('notes-tombstone-compat.js'));
  });
  for (const d of [state(), deleted(), deleted(true), { notes: 'legacy text' }, {}]) await test('supported shapes inspect without normalization', async () => {
    const before = JSON.stringify(d), r = await api.inspect(d, owner); safe(r); assert.equal(r.valid, true); assert.equal(JSON.stringify(d), before);
  });
  await test('an old empty/omitted sidecar does not erase local deletion evidence', async () => {
    const s = mergeInput(), r = await plan('merge', s, 'PREVIEW');
    assert.equal(r.privateNotes.notes.length, 0); assert.equal(r.privateNotes.noteTombstones.length, 1); assert.equal(r.counts.staleActiveSuppressed, 1);
  });
  await test('base tombstone survives omission on both other sides', async () => {
    const s = { owner, base: deleted(), local: { notes: [] }, remote: { notes: [] } }, r = await plan('merge', s, 'PREVIEW');
    assert.equal(r.privateNotes.noteTombstones.length, 1);
  });
  await test('remote-origin tombstone survives a stale active copy', async () => {
    const s = { owner, base: state(), local: state(), remote: deleted(true) }, r = await plan('merge', s, 'PREVIEW');
    assert.equal(r.privateNotes.noteTombstones[0].origin, 'cloud'); assert.equal(r.privateNotes.notes.length, 0);
  });
  await test('identical deletion evidence is not duplicated', async () => {
    const s = { owner, base: deleted(), local: deleted(), remote: deleted() }, r = await plan('merge', s, 'PREVIEW'); assert.equal(r.privateNotes.noteTombstones.length, 1);
  });
  for (const field of ['t','b','d']) await test('delete versus edit on ' + field + ' never timestamp-resolves', async () => {
    const s = mergeInput(); s.remote.notes[0][field] = field === 'd' ? '2026-10-22' : 'new edit'; s.remote.notes[0]._u = Number.MAX_SAFE_INTEGER;
    await plan('merge', s, 'CONFLICT');
  });
  await test('unknown note data is not discarded against a tombstone', async () => {
    const s = mergeInput(); s.remote.notes[0].attachment = 'private attachment'; await plan('merge', s, 'CONFLICT');
  });
  for (const [label, change] of [
    ['different operation', t => { t.id = '00000000-0000-4000-8000-000000000022'; t.intent.operation_id = t.id; }],
    ['changed local timestamp', t => { t.staged_at = '2026-10-22T00:00:00.000Z'; }],
    ['different expected revision', t => { t.intent.expected.lifecycle.revision++; }],
  ]) await test(label + ' evidence requires review instead of choosing newest', async () => {
    const s = { owner, base: deleted(), local: deleted(), remote: deleted() }; change(s.remote.noteTombstones[0]); await plan('merge', s, 'CONFLICT');
  });
  await test('pending versus acknowledged deletion is not silently upgraded by merge', async () => {
    const s = { owner, base: state(), local: deleted(), remote: deleted() };
    s.remote.noteTombstones[0].acknowledged = { contentFingerprint: fp, lifecycle: life(5, true) }; await plan('merge', s, 'CONFLICT');
  });
  await test('one-sided active edit remains a preview, preserving financial state', async () => {
    const s = { owner, base: state(), local: state(), remote: state() }; s.local.notes[0].b = 'local edit';
    const r = await plan('merge', s, 'PREVIEW'); assert.equal(r.privateNotes.notes[0].b, 'local edit');
    assert.equal(s.local.accts[0].bal, 100); assert.equal(r.privateNotes.accts, undefined);
  });
  await test('two-sided active edits conflict rather than selecting by timestamp', async () => {
    const s = { owner, base: state(), local: state(), remote: state() }; s.local.notes[0].b = 'local edit'; s.remote.notes[0].b = 'remote edit';
    s.remote.notes[0]._u = Number.MAX_SAFE_INTEGER; await plan('merge', s, 'CONFLICT');
  });
  await test('metadata-only timestamps do not create or resolve a content conflict', async () => {
    const s = { owner, base: state(), local: state(), remote: state() }; s.local.notes[0]._u = 2; s.remote.notes[0]._u = 100;
    const r = await plan('merge', s, 'PREVIEW'); assert.equal(r.privateNotes.notes[0]._u, 2);
  });
  for (const absent of ['local','remote','both']) await test(absent + ' omission is not deletion proof', async () => {
    const s = { owner, base: state(), local: state(), remote: state() }; if (absent !== 'remote') s.local.notes = []; if (absent !== 'local') s.remote.notes = [];
    await plan('merge', s, 'MISSING_INTENT');
  });
  await test('unrelated new active note is preserved in the private projection only', async () => {
    const s = mergeInput(); s.remote.notes.push({ id: 2, t: 'new', b: 'new content', d: null });
    const r = await plan('merge', s, 'PREVIEW'); assert.equal(r.privateNotes.notes.length, 1); assert.equal(r.privateNotes.notes[0].id, 2);
  });
  for (const mode of ['merge','replace','undo']) await test('old JSON ' + mode + ' cannot resurrect matching deleted content', async () => {
    const s = importInput(); s.mode = mode; const r = await plan('import', s, 'PREVIEW');
    assert.equal(r.privateNotes.notes.length, 0); assert.equal(r.privateNotes.noteTombstones.length, 1);
  });
  await test('old backup wrapper preserves existing deletion evidence', async () => {
    const s = importInput(); s.incoming = { app: 'cap-finance-tracker', version: '1.01', exported: '2026-10-21T00:00:00.000Z', data: state() };
    const r = await plan('import', s, 'PREVIEW'); assert.equal(r.privateNotes.noteTombstones.length, 1);
  });
  for (const mode of ['replace','undo']) await test(mode + ' cannot delete active notes by omission', async () => {
    const s = { ...importInput(), current: state(), incoming: { notes: [] }, mode }; await plan('import', s, 'MISSING_INTENT');
  });
  await test('JSON omission during merge leaves active notes alone', async () => {
    const s = { ...importInput(), current: state(), incoming: {} }, r = await plan('import', s, 'PREVIEW'); assert.equal(r.privateNotes.notes.length, 1);
  });
  await test('old replacement with only deletion evidence retained cannot clear it', async () => {
    const s = { ...importInput(), incoming: {}, mode: 'replace' }, r = await plan('import', s, 'PREVIEW'); assert.equal(r.privateNotes.noteTombstones.length, 1);
  });
  await test('CSV transaction-only import retains note projection exactly', async () => {
    const s = { ...importInput(), format: 'csv', incoming: { kind: 'csv', ok: [], bad: [], dup: 0 } }, r = await plan('import', s, 'PREVIEW');
    assert.deepEqual(clone(r.privateNotes), { notes: [], noteTombstones: s.current.noteTombstones });
  });
  for (const field of ['notes','noteTombstones']) await test('CSV cannot smuggle ' + field, async () => {
    const s = { ...importInput(), format: 'csv', incoming: { [field]: [] } }; await plan('import', s, 'BLOCKED');
  });
  for (const mode of ['replace','undo']) await test('CSV ' + mode + ' is not a lifecycle restore', async () => {
    await plan('import', { ...importInput(), format: 'csv', incoming: {}, mode }, 'BLOCKED');
  });
  await test('imported deletion proof cannot authorize a new deletion', async () => {
    const s = { ...importInput(), current: state(), incoming: deleted() }; await plan('import', s, 'IMPORTED_EVIDENCE');
  });
  for (const mutate of [s => { s.incoming.notes[0].b = 'new edit'; }, s => { s.incoming.notes[0].attachment = 'unknown'; }])
    await test('imported edited/unknown deleted content needs restoration review', async () => { const s = importInput(); mutate(s); await plan('import', s, 'CONFLICT'); });
  await test('active-note replacement with changed content cannot silently win', async () => {
    const s = { ...importInput(), current: state(), incoming: state(), mode: 'replace' }; s.incoming.notes[0].b = 'old body'; await plan('import', s, 'CONFLICT');
  });
  await test('private backup round-trip retains unknown app data and owner-bound tombstone', async () => {
    const d = deleted(true); d.customSettings = { keep: true }; const e = await api.exportPrivate(d, owner); safe(e);
    assert.equal(e.exported, true); const b = JSON.parse(e.privateJson); assert.deepEqual(b.data, d); assert.equal(b.owner, owner);
    const s = { ...importInput(), current: d, incoming: b }, r = await plan('import', s, 'PREVIEW'); assert.deepEqual(clone(r.privateNotes.noteTombstones), d.noteTombstones);
  });
  await test('foreign private backup wrapper is rejected even without tombstones', async () => {
    const e = await api.exportPrivate(state(), 'different-owner'), s = importInput(); s.incoming = JSON.parse(e.privateJson); await plan('import', s, 'BLOCKED');
  });
  for (const [label, mutate] of [
    ['null collection', d => { d.noteTombstones = null; }], ['object collection', d => { d.noteTombstones = {}; }],
    ['duplicate active IDs', d => { d = state(); d.notes.push({ ...d.notes[0], id: '1' }); return d; }],
    ['active/tombstone coexistence', d => { d.notes = state().notes; }],
    ['foreign owner', d => { d.noteTombstones[0].user_id = 'other'; }],
    ['bad operation identity', d => { d.noteTombstones[0].id = 'wrong'; }],
    ['changed original content', d => { d.noteTombstones[0].intent.original.body = 'changed'; }],
    ['unknown evidence field', d => { d.noteTombstones[0].restore = true; }],
    ['ambiguous local mapping', d => { d.noteTombstones.push(clone(d.noteTombstones[0])); }],
    ['invalid clock', d => { d.noteTombstones[0].staged_at = 'tomorrow'; }],
    ['unknown lifecycle version', d => { d.noteTombstones[0].intent.expected.lifecycle.version = 99; }],
    ['impossible original date', d => { d.noteTombstones[0].intent.original.note_date = '2026-02-30'; }],
    ['legacy notes with tombstone', d => { d.notes = 'legacy text'; }],
  ]) await test(label + ' fails without silently normalizing away proof', async () => {
    let d = deleted(); d = mutate(d) || d; const before = JSON.stringify(d), r = await api.inspect(d, owner); safe(r); assert.equal(r.valid, false);
    assert.equal(JSON.stringify(d), before); assert.equal((await api.exportPrivate(d, owner)).exported, false);
  });
  for (const [label, mutate] of [
    ['unknown backup format', s => { s.incoming = { format: 'unknown', data: state() }; }],
    ['unknown legacy version', s => { s.incoming = { app: 'cap-finance-tracker', version: 'future', data: state() }; }],
    ['unknown owner context', s => { s.owner = ''; }],
    ['unknown input field', s => { s.autoApply = true; }],
    ['wrong import format', s => { s.format = 'xml'; }],
  ]) await test(label + ' fails closed', async () => { const s = importInput(); mutate(s); await plan('import', s, 'BLOCKED'); });
  await test('legacy text stays untouched and requires separate migration review', async () => {
    const s = { ...importInput(), current: { notes: 'legacy text' } }; await plan('import', s, 'LEGACY_REVIEW');
    await plan('merge', { ...mergeInput(), base: { notes: 'legacy text' } }, 'LEGACY_REVIEW');
  });
  await test('fresh review remains non-executable', async () => {
    const s = mergeInput(), r = await api.planMerge(s), reviewed = await api.review('merge', s, r.ticket); safe(reviewed); assert.equal(reviewed.previewReady, true);
  });
  for (const kind of ['merge','import']) for (const field of ['owner','metadata','evidence']) await test(kind + ' ticket binds ' + field + ' changes', async () => {
    const s = kind === 'merge' ? mergeInput() : importInput(), r = await (kind === 'merge' ? api.planMerge(s) : api.planImport(s));
    if (field === 'owner') s.owner = 'other';
    else if (field === 'metadata') (kind === 'merge' ? s.local : s.current).preference = 'changed';
    else (kind === 'merge' ? s.local : s.current).noteTombstones[0].staged_at = '2026-10-22T00:00:00.000Z';
    const reviewed = await api.review(kind, s, r.ticket); safe(reviewed); assert.equal(reviewed.previewReady, false); assert.equal(reviewed.privateNotes, undefined);
  });
  await test('caller mutation cannot mix a ticket and a different input', async () => {
    const s = mergeInput(), before = clone(s), pending = api.planMerge(s); s.remote.notes[0].b = 'changed';
    const r = await pending, expected = await api.planMerge(before); safe(r); assert.equal(r.ticket, expected.ticket);
    assert.equal((await api.review('merge', s, r.ticket)).previewReady, false);
  });
  await test('equivalent key order keeps a ticket stable', async () => {
    const s = importInput(), r = await api.planImport(s), reordered = Object.fromEntries(Object.entries(s).reverse());
    assert.equal((await api.review('import', reordered, r.ticket)).previewReady, true);
  });
  await test('malformed/cyclic input never leaks raw errors', async () => {
    for (const input of [null, [], {}, undefined]) { safe(await api.planMerge(input)); safe(await api.planImport(input)); }
    const s = mergeInput(); s.loop = s; safe(await api.planMerge(s));
  });
  console.log(`PASS: ${passed} pure tombstone compatibility checks; no live normalization, import, merge, or writes`);
})().catch(error => { console.error(error); process.exitCode = 1; });
