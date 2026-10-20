/* Controlled live-bridge tests with simulated cloud, local state and storage.
   Never calls Supabase or a real browser database: node tests/notes-controlled.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
const owner = 'fixture-owner-secret', id = '00000000-0000-4000-8000-000000000011';
const key = 'controlled-notes-test-v1';
const pick = row => Object.fromEntries(['legacy_id', 'title', 'body', 'note_date'].map(k => [k, row[k]]));
let passed = 0;
async function fixture({ stringNotes = false } = {}) {
  const f = { owner, consent: true, ready: true, lock: true, writes: 0, saves: 0, finalizes: 0, confirms: 0, mutations: 0,
    meta: new Map(), queue: new Map(), output: { textContent: '' } };
  const S = { notes: stringNotes ? 'original-secret' : [{ id: 1, t: 'Demo', b: 'original-secret', d: '2026-10-20' }], accts: [], tx: [], pend: [], xfer: [], bills: [], goals: [], debts: [], budgets: {} };
  const row = () => ({ id, user_id: f.owner, legacy_id: '1', title: stringNotes ? 'Notes' : S.notes[0].t, body: stringNotes ? S.notes : S.notes[0].b, note_date: '2026-10-20' });
  f.cloud = clone(row()); f.original = clone(row()); f.originalLocal = JSON.stringify(S.notes);
  const context = { crypto: webcrypto, TextEncoder, URLSearchParams, S,
    location: { search: '' }, localStorage: { getItem: k => k === 'cap_dev_tools' ? '1' : k === 'pera' ? (f.staleLocal ? 'different-tab-state' : JSON.stringify(S)) : null },
    document: { getElementById: () => f.output },
    navigator: { locks: { request: async (name, options, callback) => { assert.equal(options.ifAvailable, true); return callback(f.lock ? {} : null); } } },
    migrationPrepare: () => ({ blockingProblems: [] }),
    buildSupabaseMigrationPlan: () => ({ userId: f.owner, tables: [['notes', [row()]]] }),
    save: () => { f.saves++; if (f.breakSave) throw Error('private save error'); if (f.stampOnSave && Array.isArray(S.notes) && S.notes[0]) S.notes[0]._u = 1000 + f.saves; },
    confirm: () => { f.confirms++; if (f.changeDuringConsent) f.cloud.body = 'changed-remotely'; return f.consent; },
    CapOff: {
      syncStore: async (store, op, value, recordKey) => {
        const map = store === 'outbox' ? f.queue : f.meta;
        if (op === 'get') return clone(map.get(value));
        if (op === 'all') return store === 'syncconflicts' ? [] : [...map.values()].map(clone);
        f.mutations++;
        if (op === 'put') {
          if (f.failCheckpoint && recordKey === key) throw Error('private checkpoint error');
          if (f.failQueue && store === 'outbox') throw Error('private queue error');
          map.set(store === 'outbox' ? value.id : recordKey, clone(value));
        } else if (op === 'delete') {
          if (f.failCleanup && value === key) throw Error('private cleanup error');
          map.delete(value);
        } else throw Error('Unexpected fixture operation');
      },
      finalizeVerifiedNotePush: async (receipt, guard) => {
        if (f.failFinalizeAt === f.finalizes + 1) throw Error('private finalization error');
        assert.equal(guard(), true);
        const baseline = f.meta.get('baseline');
        assert.deepEqual(baseline.records[0], clone(receipt.expectedRecord));
        assert.deepEqual(f.queue.get(receipt.entry.id), clone(receipt.entry));
        baseline.records[0] = clone(receipt.nextRecord); baseline.revision = (baseline.revision || 0) + 1;
        f.queue.delete(receipt.entry.id); f.finalizes++;
        if (f.editAfterFirst && f.finalizes === 1) S.notes[0].b = 'new-user-edit';
        return { committed: true, verified: true };
      },
    },
    CapSupabase: {
      currentUser: async () => ({ id: f.owner }), status: () => ({ userId: f.owner }),
      refreshNotesRpcReadiness: async () => f.ready, notesRpcReady: () => f.ready,
      validateRealData: async plan => {
        const equal = JSON.stringify(pick(plan.tables[0][1][0])) === JSON.stringify(pick(f.cloud));
        return { dataOk: equal, missingCount: 0, unexpectedCount: 0, mismatchCount: equal ? 0 : 1, foreignKeyErrorCount: 0, snapshot: { notes: [clone(f.cloud)] } };
      },
      syncRequest: async (url, options) => {
        if (!options) { assert.ok(url.startsWith('/rest/v1/notes?select=')); return [clone(f.cloud)]; }
        assert.equal(url, '/rest/v1/rpc/cap_sync_note_put'); assert.equal(options.method, 'POST');
        assert.ok(f.confirms > 0 && f.consent && f.meta.has(key), 'No mutation before consent/checkpoint');
        const args = JSON.parse(options.body); assert.equal(args.p_id, id); assert.notEqual(args.p_expected, null);
        if (f.raceOnRpc) f.cloud.body = 'new-remote-edit';
        if (f.failRestore && f.writes === 1) throw Error('private lost restore response');
        if (JSON.stringify(pick(f.cloud)) !== JSON.stringify(args.p_expected)) return { status: 'CONFLICT' };
        f.cloud = { id, user_id: owner, ...clone(args.p_desired) }; f.writes++;
        if (f.loseResponse) throw Error('private response lost');
        return { status: 'APPLIED' };
      },
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/sync.js'), 'utf8'), context);
  f.meta.set('baseline', { version: 2, user_id: owner, fingerprint: 'fixture', records: [{ entity: 'notes', localId: '1', supabase_id: id, user_id: owner, contentFingerprint: await context.CapSync.contentFingerprint(f.cloud) }] });
  f.context = context; f.run = () => context.runCapControlledNotesTest();
  return f;
}
async function test(label, body) { await body(); passed++; }

(async () => {
  for (const stringNotes of [false, true]) await test('round trip restores original representation', async () => {
    const f = await fixture({ stringNotes }); await f.run();
    assert.ok(f.output.textContent.includes('PASS — NOTE RESTORED'));
    assert.equal(f.writes, 2); assert.equal(f.finalizes, 2); assert.equal(f.queue.size, 0); assert.equal(f.meta.has(key), false);
    assert.deepEqual(pick(f.cloud), pick(f.original)); assert.equal(JSON.stringify(f.context.S.notes), f.originalLocal);
    assert.equal(f.meta.get('baseline').records.length, 1); assert.equal(f.meta.get('baseline').revision, 2);
    assert.ok(!f.output.textContent.includes(owner)); assert.ok(!f.output.textContent.includes('original-secret'));
  });
  await test('round trip ignores expected local sync metadata', async () => {
    const f = await fixture(); f.stampOnSave = true; await f.run();
    assert.ok(f.output.textContent.includes('PASS — NOTE RESTORED'));
    assert.equal(f.writes, 2); assert.equal(f.saves, 2); assert.equal(f.context.S.notes[0]._u, 1002);
    assert.notEqual(JSON.stringify(f.context.S.notes), f.originalLocal);
    assert.equal(f.meta.has(key), false); assert.equal(f.meta.get('baseline').records.length, 1);
  });
  await test('cancel leaves everything untouched', async () => {
    const f = await fixture(); f.consent = false; await f.run();
    assert.ok(f.output.textContent.includes('CANCELLED')); assert.equal(f.mutations, 0); assert.equal(f.writes, 0); assert.equal(f.saves, 0);
  });
  for (const [label, setup] of [
    ['unavailable lock', f => { f.lock = false; }],
    ['stale persisted local state', f => { f.staleLocal = true; }],
    ['unsafe readiness', f => { f.ready = false; }],
    ['unresolved checkpoint', f => { f.meta.set(key, { id: 'old' }); }],
    ['pending outbox', f => { f.queue.set('other', { id: 'other' }); }],
    ['foreign baseline', f => { f.meta.get('baseline').user_id = 'other'; }],
    ['baseline content mismatch', f => { f.meta.get('baseline').records[0].contentFingerprint = 'a'.repeat(64); }],
    ['baseline mapping mismatch', f => { f.meta.get('baseline').records[0].localId = 'different'; }],
    ['cloud/local differences', f => { f.cloud.body = 'remote-edit'; }],
    ['data changes during consent', f => { f.changeDuringConsent = true; }],
  ]) await test(label, async () => {
    const f = await fixture(); setup(f); await f.run();
    assert.equal(f.mutations, 0); assert.equal(f.writes, 0); assert.equal(f.saves, 0);
    assert.ok(f.output.textContent.includes('BLOCKED'));
    if (label === 'cloud/local differences') assert.ok(f.output.textContent.includes('mismatches: 1'), 'Diagnostics must remain before failure status');
  });
  for (const [label, setup] of [
    ['checkpoint failure', f => { f.failCheckpoint = true; }],
    ['queue failure', f => { f.failQueue = true; }],
    ['local save failure', f => { f.breakSave = true; }],
    ['racing cloud edit', f => { f.raceOnRpc = true; }],
    ['lost first response', f => { f.loseResponse = true; }],
    ['failed first finalization', f => { f.failFinalizeAt = 1; }],
    ['failed restore transport', f => { f.failRestore = true; }],
    ['new local edit before restoration', f => { f.editAfterFirst = true; }],
    ['checkpoint cleanup failure', f => { f.failCleanup = true; }],
  ]) await test(label, async () => {
    const f = await fixture(); setup(f); await f.run();
    assert.ok(!f.output.textContent.includes('PASS — NOTE RESTORED'));
    assert.ok(f.output.textContent.includes('STOP: do not retry'));
    assert.ok(!f.output.textContent.includes('private'));
    if (label !== 'checkpoint failure') assert.equal(f.meta.has(key), true);
    assert.ok(f.writes <= 2);
    if (label === 'racing cloud edit') { assert.equal(f.cloud.body, 'new-remote-edit'); assert.equal(f.writes, 0); }
    if (label === 'failed restore transport') { assert.equal(f.writes, 1); assert.equal(f.queue.size, 1); }
    if (label === 'new local edit before restoration') assert.equal(f.context.S.notes[0].b, 'new-user-edit');
  });
  await test('checkpoint blocks a second test, not silently discarded', async () => {
    const f = await fixture(); f.loseResponse = true; await f.run();
    const before = f.writes; f.loseResponse = false; await f.run(); assert.equal(f.writes, before); assert.ok(f.meta.has(key));
  });
  assert.equal((await (await fixture()).context.CapSync.controlledNoteRoundTrip()).complete, false); passed++;
  console.log(`PASS: ${passed} controlled notes bridge checks; simulated cloud and storage only`);
})().catch(error => { console.error(error); process.exitCode = 1; });
