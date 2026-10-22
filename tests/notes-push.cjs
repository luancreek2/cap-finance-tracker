/* Adapter-only pipeline regression checks. No network or browser storage:
   node tests/notes-push.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const context = { crypto: webcrypto, TextEncoder, URLSearchParams,
  location: { search: '' }, localStorage: { getItem: () => null } };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/sync.js'), 'utf8'), context);
const sync = context.CapSync, clone = x => JSON.parse(JSON.stringify(x));
const owner = 'fixture-owner', id = '00000000-0000-4000-8000-000000000011';
const content = r => Object.fromEntries(['legacy_id', 'title', 'body', 'note_date'].map(k => [k, r[k]]));
let checks = 0;
async function fixture({ insert = false, noop = false } = {}) {
  const row = { id, user_id: owner, legacy_id: '1', title: 'Test', body: 'old', note_date: '2026-10-20' };
  const desired = { ...row, body: noop ? 'old' : 'new' };
  const record = { entity: 'notes', localId: '1', supabase_id: id, user_id: owner, contentFingerprint: await sync.contentFingerprint(row) };
  const other = { ...record, localId: '2', supabase_id: id.replace(/11$/, '12') };
  const entry = { id: 'op-1', user_id: owner, entity: 'notes', local_id: '1', supabase_id: id, operation: 'upsert', payload: desired };
  const f = { owner, cloud: insert ? null : row, local: clone(desired), entries: [clone(entry)],
    baseline: { version: 2, user_id: owner, fingerprint: 'legacy-snapshot', records: insert ? [other] : [record, other] },
    calls: { cas: 0, finalize: 0, reads: 0 } };
  f.io = {
    currentUser: async () => ({ id: f.owner }),
    readState: async () => clone({ baseline: f.baseline, entries: f.entries }),
    readLocal: async () => clone(f.local),
    readCloud: async () => { f.calls.reads++; if (f.cloud === null) return null;
      return { row: clone(f.cloud), lifecycle: { version: 1, revision: 1, deleted_at: null, operation_id: null } }; },
    ready: async () => true,
    cas: async args => {
      f.calls.cas++;
      assert.equal(args.p_id, id);
      assert.deepEqual(clone(args.p_desired), content(desired));
      assert.ok(['create', 'edit'].includes(args.p_action), 'Action must be create or edit');
      if (args.p_action === 'edit') assert.ok(args.p_expected && args.p_expected.content && args.p_expected.lifecycle, 'Expected content and lifecycle envelope');
      else assert.equal(args.p_expected, null, 'A create must not carry an expected state');
      assert.equal(args.p_operation_id, 'op-1');
      const now = f.cloud === null ? null : content(f.cloud);
      const expected = args.p_expected === null ? null : args.p_expected.content;
      if (JSON.stringify(now) !== JSON.stringify(expected)) return { status: 'CONFLICT' };
      f.cloud = { id, user_id: owner, ...clone(args.p_desired), updated_at: '2026-10-20T01:00:00Z' };
      return { status: 'APPLIED' };
    },
    finalize: async receipt => {
      f.calls.finalize++;
      assert.ok(f.calls.reads >= 2, 'Read-back must precede acknowledgement');
      assert.equal(receipt.nextRecord.contentFingerprint, await sync.contentFingerprint(f.cloud));
      const index = f.baseline.records.findIndex(r => r.supabase_id === id);
      if (index < 0) f.baseline.records.push(clone(receipt.nextRecord));
      else f.baseline.records[index] = clone(receipt.nextRecord);
      f.entries = f.entries.filter(x => x.id !== receipt.entry.id);
      return { committed: true, verified: true };
    },
  };
  f.run = () => sync.rehearseNotePush('op-1', f.io);
  return f;
}
async function test(label, fn) { await fn(); checks++; }

(async () => {
  await test('no live defaults', async () => assert.equal((await sync.rehearseNotePush('op-1')).wrote, false));
  for (const insert of [false, true]) await test(insert ? 'insert' : 'update', async () => {
    const f = await fixture({ insert }), other = clone(f.baseline.records.at(-1));
    const result = await f.run();
    assert.equal(result.status, 'APPLIED — VERIFIED AND FINALIZED');
    assert.equal(f.entries.length, 0); assert.equal(f.calls.cas, 1); assert.equal(f.calls.finalize, 1);
    assert.equal(f.baseline.records.filter(r => r.supabase_id === id).length, 1);
    assert.deepEqual(f.baseline.records.find(r => r.supabase_id === other.supabase_id), other);
  });
  await test('already converged', async () => {
    const f = await fixture({ noop: true }), r = await f.run();
    assert.equal(r.status, 'ALREADY_APPLIED — VERIFIED AND FINALIZED'); assert.equal(f.calls.cas, 0);
  });
  for (const [label, mutate] of [
    ['conflict', f => { f.cloud.body = 'cloud-edit'; }],
    ['cloud deletion', f => { f.cloud = null; }],
    ['foreign user', f => { f.owner = 'other'; }],
    ['stale queued payload', f => { f.local.body = 'newer'; }],
    ['foreign local row', f => { f.local.user_id = 'other'; }],
    ['changed local mapping', f => { f.local.legacy_id = 'other'; }],
    ['changed cloud mapping', f => { f.cloud.legacy_id = 'other'; }],
    ['duplicate queued versions', f => { f.entries.push({ ...f.entries[0], id: 'op-2' }); }],
    ['wrong entity', f => { f.entries[0].entity = 'accounts'; }],
    ['deletion unsupported', f => { f.entries[0].operation = 'delete'; }],
    ['missing baseline', f => { f.baseline = null; }],
    ['partial payload', f => { delete f.entries[0].payload.note_date; }],
    ['unknown payload field', f => { f.entries[0].payload.extra = 'no'; }],
    ['invalid note date shape', f => { f.entries[0].payload.note_date = 'October 20'; }],
  ]) await test(label, async () => {
    const f = await fixture(); mutate(f); const result = await f.run();
    assert.equal(result.finalized, false, label); assert.equal(f.calls.cas, 0, label); assert.equal(f.calls.finalize, 0, label);
  });
  await test('readiness false', async () => {
    const f = await fixture(); f.io.ready = async () => false;
    assert.equal((await f.run()).wrote, false); assert.equal(f.calls.cas, 0);
  });
  await test('local changes while preflight waits', async () => {
    const f = await fixture(); f.io.ready = async () => { f.local.body = 'changed'; return true; };
    assert.equal((await f.run()).wrote, false); assert.equal(f.calls.cas, 0);
  });
  await test('CAS rejects cloud race', async () => {
    const f = await fixture(); f.io.ready = async () => { f.cloud.body = 'racing-edit'; return true; };
    assert.equal((await f.run()).status, 'CONFLICT — NOTHING FINALIZED'); assert.equal(f.calls.finalize, 0);
    assert.equal(f.cloud.body, 'racing-edit');
  });
  await test('unreadable cloud is not absence', async () => {
    const f = await fixture(); f.io.readCloud = async () => { throw Error('sensitive message'); };
    const r = await f.run(); assert.equal(r.wrote, false); assert.equal(f.calls.cas, 0); assert.ok(!JSON.stringify(r).includes('sensitive'));
  });
  for (const response of [{}, { status: 'UNKNOWN' }, [{ status: 'APPLIED' }, { status: 'APPLIED' }]]) await test('ambiguous receipt', async () => {
    const f = await fixture(); f.io.cas = async () => response;
    const r = await f.run(); assert.equal(r.wrote, null); assert.equal(r.finalized, false); assert.equal(f.calls.finalize, 0);
  });
  await test('lost RPC response then safe retry', async () => {
    const f = await fixture(), cas = f.io.cas;
    f.io.cas = async args => { await cas(args); throw Error('response lost'); };
    assert.equal((await f.run()).status, 'WRITE OUTCOME UNKNOWN — NOTHING FINALIZED');
    assert.equal(f.entries.length, 1); assert.equal(f.calls.finalize, 0);
    f.io.cas = cas;
    assert.equal((await f.run()).status, 'ALREADY_APPLIED — VERIFIED AND FINALIZED');
    assert.equal(f.calls.cas, 1, 'Retry must not reapply the write');
  });
  for (const failRead of [false, true]) await test('failed post-write verification', async () => {
    const f = await fixture(), read = f.io.readCloud;
    f.io.readCloud = async () => { if (f.calls.cas) { if (failRead) throw Error('read failed');
      return { row: { ...f.cloud, body: 'wrong' }, lifecycle: { version: 1, revision: 1, deleted_at: null, operation_id: null } }; } return read(); };
    assert.equal((await f.run()).status, 'CLOUD WRITE OCCURRED — VERIFICATION FAILED');
    assert.equal(f.calls.finalize, 0); assert.equal(f.entries.length, 1);
  });
  await test('local changes after write', async () => {
    const f = await fixture(), cas = f.io.cas;
    f.io.cas = async args => { const r = await cas(args); f.local.body = 'edited again'; return r; };
    assert.equal((await f.run()).status, 'DATA CONVERGED — BASELINE UPDATE FAILED'); assert.equal(f.calls.finalize, 0);
  });
  await test('acknowledgement abort then retry', async () => {
    const f = await fixture(), finish = f.io.finalize;
    f.io.finalize = async () => { throw Error('transaction aborted'); };
    assert.equal((await f.run()).status, 'DATA CONVERGED — BASELINE UPDATE FAILED'); assert.equal(f.entries.length, 1);
    f.io.finalize = finish;
    assert.equal((await f.run()).finalized, true); assert.equal(f.calls.cas, 1);
  });
  await test('committed local transaction but verification failed', async () => {
    const f = await fixture(); f.io.finalize = async () => ({ committed: true, verified: false });
    assert.equal((await f.run()).status, 'LOCAL WRITE OCCURRED — VERIFICATION FAILED');
  });
  await test('per-operation double execution rejected', async () => {
    const f = await fixture(); const results = await Promise.all([f.run(), f.run()]);
    assert.equal(results.filter(r => r.finalized).length, 1); assert.equal(f.calls.cas, 1);
  });
  console.log(`PASS: ${checks} notes push pipeline checks; isolated adapters only`);
})().catch(error => { console.error(error); process.exitCode = 1; });
