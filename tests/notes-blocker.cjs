/* Read-only blocker diagnostics; no live browser storage or network.
   node tests/notes-blocker.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const owner = 'private-fixture-owner', id = '00000000-0000-4000-8000-000000000011';
const f = { entries: [], baseline: { version: 2, user_id: owner, records: [] }, cloud: [], checkpoint: null, mutations: 0, reads: 0 };
const out = { textContent: '', style: {} };
const context = { crypto: webcrypto, TextEncoder, URLSearchParams, location: { search: '' },
  localStorage: { getItem: k => k === 'cap_dev_tools' ? '1' : null },
  document: { getElementById: () => out }, S: { accts: [] },
  migrationPrepare: () => ({ blockingProblems: [] }),
  buildSupabaseMigrationPlan: () => ({ userId: owner, tables: [['accounts', []]] }),
  CapSupabase: {
    currentUser: async () => ({ id: owner }),
    syncRequest: async () => { f.reads++; if (f.readFails) throw Error(owner + ' financial-secret'); return f.cloud; },
    validateRealData: async () => ({ missingCount: 0, unexpectedCount: 0, mismatchCount: 0, foreignKeyErrorCount: 0, snapshot: { accounts: [] } }),
  },
  CapOff: { syncStore: async (store, op, key) => {
    if (op === 'all') return f.entries;
    if (op === 'get') return key === 'baseline' ? f.baseline : f.checkpoint;
    f.mutations++; throw Error('Diagnostic attempted a write');
  } },
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/sync.js'), 'utf8'), context);
const sample = () => ({ id: 'op', user_id: owner, entity: 'accounts', local_id: id, supabase_id: id, operation: 'upsert', payload: { id, user_id: owner, legacy_id: 'phase6-test-' + id, name: 'CAP SYNC ENGINE TEST', balance: 999 } });
let passed = 0;
(async () => {
  f.entries = [sample(), { ...sample(), id: 'op2' }, { ...sample(), id: 'op3' }];
  let r = await context.CapSync.inspectNotesTestBlocker();
  assert.equal(r.outboxEntries, 3); assert.ok(r.queue.every(q => q.cleanupReviewEligible)); assert.equal(f.reads, 3); passed++;
  assert.ok(!JSON.stringify(r).includes(owner)); assert.ok(!JSON.stringify(r).includes(id)); assert.ok(!JSON.stringify(r).includes('999')); passed++;
  f.entries = [sample()]; f.readFails = true;
  r = await context.CapSync.inspectNotesTestBlocker();
  assert.equal(r.queue[0].cleanupReviewEligible, false); assert.equal(r.queue[0].cloudPresence, 'BLOCKED — RECORD ABSENCE NOT PROVEN'); passed++;
  f.readFails = false; f.cloud = [{ id, user_id: owner }];
  assert.equal((await context.CapSync.inspectNotesTestBlocker()).queue[0].cleanupReviewEligible, false); passed++;
  f.cloud = []; context.S.accts = [{ id }];
  assert.equal((await context.CapSync.inspectNotesTestBlocker()).queue[0].cleanupReviewEligible, false); passed++;
  context.S.accts = []; f.baseline.records = [{ entity: 'accounts', localId: id, supabase_id: id }];
  assert.equal((await context.CapSync.inspectNotesTestBlocker()).queue[0].cleanupReviewEligible, false); passed++;
  f.baseline.records = []; f.entries[0].payload.name = 'User account with test prefix'; f.reads = 0;
  r = await context.CapSync.inspectNotesTestBlocker();
  assert.equal(r.queue[0].knownHarness, false); assert.equal(f.reads, 0); passed++;
  f.entries = [sample()]; f.baseline.user_id = 'different-owner';
  assert.equal((await context.CapSync.inspectNotesTestBlocker()).queue[0].cleanupReviewEligible, false); passed++;
  f.baseline.user_id = owner; f.checkpoint = { id: 'recovery' };
  assert.equal((await context.CapSync.inspectNotesTestBlocker()).queue[0].cleanupReviewEligible, false); passed++;
  await context.inspectCapNotesTestBlocker();
  assert.ok(out.textContent.includes('READ-ONLY NOTES-TEST DIAGNOSTIC'));
  assert.ok(out.textContent.includes('Nothing was deleted'));
  assert.ok(!out.textContent.includes(owner)); assert.equal(f.mutations, 0); passed++;
  console.log(`PASS: ${passed} notes blocker diagnostic checks; zero mutations`);
})().catch(error => { console.error(error); process.exitCode = 1; });
