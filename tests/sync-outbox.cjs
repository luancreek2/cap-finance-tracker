/* Dependency-free, isolated regression checks. No browser, disk data, or
   network writes: node tests/sync-outbox.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const owner = 'test-owner-not-for-display';
const recordId = '00000000-0000-4000-8000-000000000001';
const baseRow = { id: recordId, user_id: owner, legacy_id: '1', body: 'base' };
const output = { textContent: '', style: {} };
let baseline, entry, cloud, mutations = 0, writes = 0;
const context = {
  crypto: webcrypto, TextEncoder, URLSearchParams,
  location: { search: '' }, localStorage: { getItem: () => null },
  document: { getElementById: () => output }, toast() {},
  CapSupabase: {
    currentUser: async () => ({ id: owner }),
    syncRequest: async () => cloud === null ? [] : [cloud],
  },
  CapOff: { syncStore: async (store, op) => {
    if (op === 'get') return baseline;
    if (op === 'all') return entry ? [entry] : [];
    mutations++;
    throw Error('Unexpected storage mutation during a blocked operation');
  } },
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../js/sync.js'), 'utf8'), context);
const sync = context.CapSync;
const fingerprint = row => sync.contentFingerprint(row);
const op = (payload = baseRow, operation = 'upsert') => ({
  id: 'operation-1', user_id: owner, entity: 'notes', local_id: '1',
  supabase_id: recordId, operation, payload, queued_at: '2026-10-20T00:00:00Z',
});
let passed = 0;
async function check(label, operation, remote, expected, classification, b = baseline) {
  const before = JSON.stringify({ operation, remote, b });
  const r = await sync.planOutbox([operation], { userId: owner, baseline: b, readCloud: async () => remote });
  assert.equal(r.plan[0]?.action, expected, label);
  if (classification) assert.equal(r.plan[0].classification, classification, label);
  assert.equal(JSON.stringify({ operation, remote, b }), before, 'Planner must not mutate inputs');
  passed++;
  return r;
}

(async () => {
  baseline = { version: 2, user_id: owner, records: [{
    entity: 'notes', localId: '1', supabase_id: recordId, user_id: owner,
    contentFingerprint: await fingerprint(baseRow),
  }] };
  const local = { ...baseRow, body: 'local-edit' };
  const remote = { ...baseRow, body: 'cloud-edit' };
  await check('unchanged', op(), baseRow, 'NOOP', 'UNCHANGED');
  await check('local change only', op(local), baseRow, 'UPDATE', 'PUSH');
  await check('cloud change only', op(), remote, 'BLOCKED', 'PULL');
  await check('both changed', op(local), remote, 'BLOCKED', 'CONFLICT');
  await check('both converged', op(local), local, 'NOOP', 'CONVERGED');
  await check('cloud deletion', op(), null, 'BLOCKED', 'CLOUD_DELETE');
  await check('cloud deletion versus local edit', op(local), null, 'BLOCKED', 'CONFLICT');
  await check('local deletion', op(null, 'delete'), baseRow, 'DELETE', 'LOCAL_DELETE');
  await check('delete versus cloud edit', op(null, 'delete'), remote, 'BLOCKED', 'CONFLICT');
  await check('both deleted', op(null, 'delete'), null, 'ALREADY_DELETED', 'BOTH_DELETED');
  await check('new local record', op(), null, 'INSERT', 'NEW_LOCAL', null);
  await check('unmapped cloud collision', op(local), baseRow, 'BLOCKED', 'CONFLICT', null);
  await check('unmapped deletion', op(null, 'delete'), baseRow, 'BLOCKED', 'CONFLICT', null);
  await check('unmapped converged record', op(), baseRow, 'NOOP', 'CONVERGED', null);
  await check('foreign baseline', op(), baseRow, 'BLOCKED', null, { ...baseline, user_id: 'other' });
  await check('corrupt baseline records', op(), baseRow, 'BLOCKED', null, { ...baseline, records: {} });
  await check('duplicate baseline', op(), baseRow, 'BLOCKED', null, { ...baseline, records: [...baseline.records, ...baseline.records] });
  await check('invalid fingerprint', op(), baseRow, 'BLOCKED', null, { ...baseline, records: [{ ...baseline.records[0], contentFingerprint: 'invalid' }] });
  await check('foreign baseline record', op(), baseRow, 'BLOCKED', null, { ...baseline, records: [{ ...baseline.records[0], user_id: 'other' }] });
  await check('wrong baseline local identity', op(), baseRow, 'BLOCKED', null, { ...baseline, records: [{ ...baseline.records[0], localId: 'different' }] });
  await check('foreign payload', op({ ...baseRow, user_id: 'other' }), baseRow, 'BLOCKED');
  await check('wrong payload identity', op({ ...baseRow, id: 'other' }), baseRow, 'BLOCKED');
  await check('undefined response is not absence', op(), undefined, 'BLOCKED');
  await check('array response is not absence', op(), [], 'BLOCKED');
  await check('foreign cloud record', op(), { ...baseRow, user_id: 'other' }, 'BLOCKED');
  await check('wrong cloud identity', op(), { ...baseRow, id: 'other' }, 'BLOCKED');
  await check('metadata timestamp is ignored', op(), { ...baseRow, updated_at: '2026-10-20' }, 'NOOP', 'UNCHANGED');
  await check('object key order is ignored', op(), { body: 'base', legacy_id: '1', user_id: owner, id: recordId }, 'NOOP', 'UNCHANGED');
  const failed = await sync.planOutbox([op()], { userId: owner, baseline, readCloud: async () => { throw Error(owner + ' secret financial value'); } });
  assert.equal(failed.plan[0].reason, 'BLOCKED — RECORD ABSENCE NOT PROVEN');
  assert.ok(!JSON.stringify(failed).includes('secret financial value'));
  passed++;

  entry = op(local); cloud = remote;
  const result = await sync.executeOutboxOperation(entry.id, { userId: owner, readCloud: async () => cloud, write: async () => { writes++; } });
  assert.equal(result.status, 'REFUSED — NOTHING WRITTEN');
  assert.equal(result.removed, false);
  assert.equal(writes, 0); assert.equal(mutations, 0);
  passed++;
  await context.runCapOutboxPlanButton();
  assert.ok(output.textContent.includes('CONFLICT'));
  assert.ok(!output.textContent.includes(owner));
  assert.ok(!output.textContent.includes('local-edit'));
  assert.ok(!output.textContent.includes('cloud-edit'));
  passed++;
  cloud = baseRow;
  const locked = await sync.executeOutboxOperation(entry.id);
  assert.equal(locked.status, 'REFUSED — NOTHING WRITTEN');
  assert.ok(locked.reason.includes('Production execution is disabled'));
  assert.equal(mutations, 0);
  passed++;
  console.log(`PASS: ${passed} outbox conflict checks; zero network or storage writes`);
})().catch(error => { console.error(error); process.exitCode = 1; });
