/* Pure orchestration checks for checkpoint-only notes recovery finalization.
   No storage, network, DOM, or note content. node tests/notes-recovery-finalize.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const context = {
  crypto: webcrypto, TextEncoder, URLSearchParams,
  location: { search: '' },
  localStorage: { getItem: () => null },
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/sync.js'), 'utf8'), context);
const finalize = context.CapSync.finalizeNotesTestRecovery;
assert.equal(typeof finalize, 'function');

const receipt = { allowed: true, ticket: 'ticket-1', status: 'CONVERGED — TEST', receipt: { userId: 'owner', checkpoint: { id: 'checkpoint-1' } } };
const okCommit = async () => ({ committed: true, verified: true, removed: true });
function adapters(overrides = {}) {
  return {
    withLock: run => run(),
    inspect: async () => receipt,
    confirm: async () => true,
    commit: okCommit,
    verify: async () => true,
    ...overrides,
  };
}
let passed = 0;
async function test(label, body) {
  await body();
  passed++;
  assert.ok(!/fixture-owner-secret|note body|bank balance/.test(label));
}
const final = 'RECOVERY FINALIZED — CHECKPOINT REMOVED; NOTE/BASELINE/CLOUD VERIFIED';

(async () => {
  await test('verified finalization removes only the checkpoint', async () => {
    let commits = 0, inspects = 0, confirms = 0;
    const r = await finalize(adapters({
      inspect: async () => { inspects++; return receipt; },
      confirm: async () => { confirms++; return true; },
      commit: async second => { commits++; assert.equal(second.ticket, receipt.ticket); return okCommit(); },
    }));
    assert.equal(r.status, final); assert.equal(r.complete, true); assert.equal(r.removed, true);
    assert.equal(commits, 1); assert.equal(inspects, 2); assert.equal(confirms, 1);
  });
  await test('native cancellation retains the checkpoint', async () => {
    let commits = 0;
    const r = await finalize(adapters({ confirm: async () => false, commit: async () => { commits++; return okCommit(); } }));
    assert.equal(r.status, 'CANCELLED — CHECKPOINT RETAINED'); assert.equal(r.complete, false); assert.equal(commits, 0);
  });
  await test('not-ready evidence never prompts or commits', async () => {
    let confirms = 0, commits = 0;
    const r = await finalize(adapters({
      inspect: async () => ({ allowed: false, status: 'BLOCKED — RECOVERY NOT CONVERGED' }),
      confirm: async () => { confirms++; return true; }, commit: async () => { commits++; return okCommit(); },
    }));
    assert.equal(r.status, 'BLOCKED — RECOVERY NOT CONVERGED'); assert.equal(confirms, 0); assert.equal(commits, 0);
  });
  await test('second inspection that becomes not-ready aborts', async () => {
    let n = 0, commits = 0;
    const r = await finalize(adapters({
      inspect: async () => (++n === 1 ? receipt : { allowed: false, status: 'BLOCKED — EVIDENCE CHANGED' }),
      commit: async () => { commits++; return okCommit(); },
    }));
    assert.equal(r.status, 'BLOCKED — EVIDENCE CHANGED'); assert.equal(commits, 0);
  });
  await test('changed ticket aborts before commit', async () => {
    let n = 0, commits = 0;
    const r = await finalize(adapters({
      inspect: async () => (++n === 1 ? receipt : { ...receipt, ticket: 'ticket-2' }),
      commit: async () => { commits++; return okCommit(); },
    }));
    assert.equal(r.status, 'BLOCKED — RECOVERY EVIDENCE CHANGED; CHECKPOINT RETAINED'); assert.equal(commits, 0);
  });
  await test('pre-commit failure reports retained checkpoint', async () => {
    const r = await finalize(adapters({ commit: async () => { const e = Error('preconditions'); e.committed = false; throw e; } }));
    assert.equal(r.status, 'BLOCKED — CHECKPOINT RETAINED; FINALIZATION FAILED'); assert.equal(r.complete, false);
  });
  await test('post-commit failure is distinguishable', async () => {
    const r = await finalize(adapters({ commit: async () => { const e = Error('readback'); e.committed = true; throw e; } }));
    assert.equal(r.status, 'LOCAL WRITE OCCURRED — VERIFICATION FAILED'); assert.equal(r.complete, false);
  });
  await test('unverified commit result is not success', async () => {
    const r = await finalize(adapters({ commit: async () => ({ committed: true, verified: false, removed: true }) }));
    assert.equal(r.status, 'BLOCKED — CHECKPOINT RETAINED; FINALIZATION NOT VERIFIED'); assert.equal(r.complete, false);
  });
  await test('failed post-commit verification is not success', async () => {
    const r = await finalize(adapters({ verify: async () => false }));
    assert.equal(r.status, 'LOCAL WRITE OCCURRED — VERIFICATION FAILED'); assert.equal(r.complete, false);
  });
  await test('throwing post-commit verification is not success', async () => {
    const r = await finalize(adapters({ verify: async () => { throw Error('cloud read failed'); } }));
    assert.equal(r.status, 'LOCAL WRITE OCCURRED — VERIFICATION FAILED'); assert.equal(r.complete, false);
  });
  await test('confirmation failure aborts without commit', async () => {
    let commits = 0;
    const r = await finalize(adapters({ confirm: async () => { throw Error('dialog failed'); }, commit: async () => { commits++; return okCommit(); } }));
    assert.equal(r.status, 'BLOCKED — FINALIZATION DID NOT COMPLETE; CHECKPOINT RETAINED'); assert.equal(commits, 0);
  });
  await test('lock failure aborts without commit', async () => {
    let commits = 0;
    const r = await finalize(adapters({ withLock: () => { throw Error('lock unavailable'); }, commit: async () => { commits++; return okCommit(); } }));
    assert.equal(r.status, 'BLOCKED — FINALIZATION DID NOT COMPLETE; CHECKPOINT RETAINED'); assert.equal(commits, 0);
  });
  await test('missing adapters are rejected', async () => {
    const r = await finalize({ withLock: run => run(), inspect: async () => receipt });
    assert.equal(r.status, 'BLOCKED — EXPLICIT FINALIZER ADAPTERS REQUIRED'); assert.equal(r.complete, false);
  });
  await test('concurrent finalization is rejected', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = finalize(adapters({ inspect: async () => { await gate; return receipt; } }));
    await new Promise(resolve => setImmediate(resolve));
    const second = await finalize(adapters());
    assert.equal(second.status, 'BLOCKED — FINALIZATION ALREADY RUNNING');
    release();
    assert.equal((await first).status, final);
  });
  console.log(`PASS: ${passed} notes recovery finalization checks; no storage, network, or content`);
})().catch(error => { console.error(error); process.exit(1); });
