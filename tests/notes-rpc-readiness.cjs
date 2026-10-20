/* Isolated readiness-contract checks; no network, Supabase, or local storage
   writes: node tests/notes-rpc-readiness.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const valid = {
  exists: true, signature_ok: true, security_invoker: true, search_path_ok: true,
  version_ok: true, authenticated_execute: true, anon_execute: false,
  public_execute: false, rls_ok: true, policy_ok: true, table_grants_ok: true,
  version: 'CAP_NOTES_CAS_V1', ready: true,
};
const calls = [];
let payload = valid, fail = false, defer = null;
const context = {
  CAP_SUPABASE_CONFIG: { url: 'https://fixture.invalid', publishableKey: 'test-only' },
  localStorage: { getItem: () => null },
  document: { body: { insertAdjacentHTML() {} }, getElementById: () => ({ classList: { add() {} } }) },
  fetch: async (url, options) => {
    calls.push({ url, options });
    if (defer) return defer;
    if (fail) throw Error('private user identifier and financial value');
    return { ok: true, text: async () => JSON.stringify(payload) };
  },
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/supabase.js'), 'utf8'), context);

(async () => {
  const api = context.CapSupabase;
  let passed = 0;
  assert.equal(api.notesRpcReady(), false);
  assert.equal(api.rpcReady(), false);
  assert.equal(calls.length, 0, 'Readiness getters and boot never invoke mutation RPCs'); passed++;
  assert.equal(await api.refreshNotesRpcReadiness(), true); passed++;
  for (const [key, value] of Object.entries(valid)) {
    payload = { ...valid, [key]: typeof value === 'boolean' ? !value : 'wrong-version' };
    assert.equal(await api.refreshNotesRpcReadiness(), false, key + ' must pass explicitly'); passed++;
  }
  payload = { ...valid, ready: 'true' };
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
  let release;
  defer = new Promise(resolve => { release = resolve; });
  const oldCheck = api.refreshNotesRpcReadiness();
  assert.equal(api.notesRpcReady(), false);
  defer = null; payload = { ...valid, rls_ok: false };
  assert.equal(await api.refreshNotesRpcReadiness(), false);
  release({ ok: true, text: async () => JSON.stringify(valid) });
  assert.equal(await oldCheck, false);
  assert.equal(api.notesRpcReady(), false, 'Older success cannot override a newer failed check'); passed++;
  assert.ok(calls.every(c => c.url.endsWith('/rest/v1/rpc/cap_verify_notes_rpc') && c.options.method === 'POST' && c.options.body === '{}'));
  assert.ok(!calls.some(c => c.url.includes('cap_sync_note_put'))); passed++;
  console.log(`PASS: ${passed} notes readiness checks; mutation RPC never called`);
})().catch(error => { console.error(error); process.exitCode = 1; });
