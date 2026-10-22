/* Isolated readiness-contract checks; no network, Supabase, or local storage
   writes: node tests/notes-rpc-readiness.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// The production notes contract reports its own version and contract flag.
const valid = {
  version: 'CAP_NOTES_SIDECAR_V1', contract_ready: true, roles_ok: true, tables_ok: true,
  rls_ok: true, policies_ok: true, grants_ok: true, functions_ok: true,
  legacy_lockout_ok: true, coverage_ok: true, ready: false, production_ready: false,
};
const ENTITIES = ['profiles', 'user_preferences', 'categories', 'accounts', 'goals', 'debts',
  'bills', 'account_statements', 'transactions', 'transfers', 'bill_payments', 'budgets', 'notes'];
const snapshotPayload = {
  version: 'CAP_SYNC_SNAPSHOT_V1', owner: 'fixture-owner', complete: true, record_count: 1,
  counts: Object.fromEntries(ENTITIES.map((e, i) => [e, i === 0 ? 1 : 0])),
  records: [{ entity: 'profiles', row: { id: 'fixture-owner', display_name: 'Demo profile', photo_url: null, created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z' } }],
};
const calls = [];
let payload = valid, fail = false, defer = null, snapshot = snapshotPayload;
const context = {
  CAP_SUPABASE_CONFIG: { url: 'https://fixture.invalid', publishableKey: 'test-only' },
  localStorage: { getItem: () => JSON.stringify({ access_token: 'fixture-token', refresh_token: 'fixture-refresh', user: { id: 'fixture-owner' } }) },
  setTimeout: fn => { fn(); },
  document: { body: { insertAdjacentHTML() {} }, getElementById: () => ({ remove() {}, classList: { add() {} } }) },
  fetch: async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return { ok: true, text: async () => JSON.stringify({ id: 'fixture-owner' }) };
    calls.push({ url, options });
    if (defer) return defer;
    if (fail) throw Error('private user identifier and financial value');
    if (url.endsWith('/rest/v1/rpc/cap_sync_snapshot_v1')) return { ok: true, text: async () => JSON.stringify(snapshot) };
    return { ok: true, text: async () => JSON.stringify(payload) };
  },
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/production-rpc.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/supabase.js'), 'utf8'), context);

(async () => {
  const api = context.CapSupabase;
  await api.boot();
  let passed = 0;
  assert.equal(api.notesRpcReady(), false);
  assert.equal(api.rpcReady(), false);
  assert.equal(calls.length, 0, 'Readiness getters and boot never invoke mutation RPCs'); passed++;
  assert.equal(await api.refreshNotesRpcReadiness(), true); passed++;
  for (const [key, value] of Object.entries(valid)) {
    payload = { ...valid, [key]: typeof value === 'boolean' ? !value : 'wrong-version' };
    assert.equal(await api.refreshNotesRpcReadiness(), false, key + ' must pass explicitly'); passed++;
  }
  payload = { ...valid, contract_ready: 'true' };
  assert.equal(await api.refreshNotesRpcReadiness(), false); passed++;
  for (const malformed of [null, [], [valid, valid], {}, 'ready']) {
    payload = malformed;
    assert.equal(await api.refreshNotesRpcReadiness(), false); passed++;
  }
  payload = [valid];
  assert.equal(await api.refreshNotesRpcReadiness(), true); passed++;
  fail = true;
  assert.equal(await api.refreshNotesRpcReadiness(), false);
  assert.equal(api.notesRpcReady(), false);
  assert.ok(!JSON.stringify(api.notesRpcVerifierStatus()).includes('private')); passed++;
  fail = false;
  await api.currentUser(); // A failed cloud read invalidates online verification.
  let release;
  defer = new Promise(resolve => { release = resolve; });
  const oldCheck = api.refreshNotesRpcReadiness();
  assert.equal(api.notesRpcReady(), false);
  defer = null; payload = { ...valid, rls_ok: false };
  assert.equal(await api.refreshNotesRpcReadiness(), false);
  release({ ok: true, text: async () => JSON.stringify(valid) });
  assert.equal(await oldCheck, false);
  assert.equal(api.notesRpcReady(), false, 'Older success cannot override a newer failed check'); passed++;
  assert.ok(calls.every(c => c.url.endsWith('/rest/v1/rpc/cap_verify_notes_lifecycle') && c.options.method === 'POST' && c.options.body === '{}'));
  assert.ok(!calls.some(c => c.url.includes('cap_sync_note_put') || c.url.includes('cap_verify_notes_rpc'))); passed++;
  // The production snapshot is the only cloud read path for validation.
  const tables = ENTITIES.filter(e => e !== 'profiles' && e !== 'user_preferences').map(t => [t, []]);
  const validation = await api.validateRealData({ userId: 'fixture-owner', tables, profile: { id: 'fixture-owner' }, preferences: { user_id: 'fixture-owner' } });
  assert.equal(validation.snapshot.profiles[0].display_name, 'Demo profile');
  assert.ok(calls.some(c => c.url.endsWith('/rest/v1/rpc/cap_sync_snapshot_v1')));
  assert.ok(calls.every(c => c.url.startsWith('https://fixture.invalid/auth/v1/') || c.url.endsWith('/rest/v1/rpc/cap_verify_notes_lifecycle') || c.url.endsWith('/rest/v1/rpc/cap_sync_snapshot_v1')));
  passed++;
  console.log(`PASS: ${passed} notes readiness checks; mutation RPC never called`);
})().catch(error => { console.error(error); process.exitCode = 1; });
