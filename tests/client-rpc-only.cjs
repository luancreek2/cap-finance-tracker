/* RPC-only client contract checks. Static scan of the shipped bundle plus
   transport/adapter behaviour in an isolated context. No Supabase, no browser
   profile, no local financial data, no baseline or outbox writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

const LEGACY = ['cap_sync_note_put', 'cap_test_transaction_create', 'cap_verify_notes_rpc', 'cap_verify_transaction_rpc'];
const PRODUCTION_RPCS = ['cap_verify_production_sync_v1', 'cap_sync_snapshot_v1',
  'cap_sync_transaction_create', 'cap_sync_transaction_update', 'cap_sync_transaction_delete',
  'cap_verify_transaction_update_delete_v1', 'cap_notes_change', 'cap_notes_read', 'cap_verify_notes_lifecycle'];
const SYNCED_TABLES = ['profiles', 'user_preferences', 'categories', 'accounts', 'goals', 'debts',
  'bills', 'account_statements', 'transactions', 'transfers', 'bill_payments', 'budgets', 'notes'];
let passed = 0;
const test = async (label, fn) => {
  try { await fn(); passed++; }
  catch (e) { e.message = label + ': ' + e.message; throw e; }
};

function loadClient() {
  const calls = [];
  const storage = new Map();
  const context = {
    crypto: webcrypto, TextEncoder, URLSearchParams,
    CAP_SUPABASE_CONFIG: { url: 'https://fixture.invalid', publishableKey: 'fixture-key' },
    navigator: { get onLine() { return true; } },
    location: { reload() {}, search: '' },
    localStorage: {
      getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k)
    },
    setTimeout: fn => { fn(); return 0; },
    document: { body: { insertAdjacentHTML() {} }, getElementById: () => ({ remove() {}, classList: { add() {} } }) },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/auth/v1/user')) return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'owner-fixture' }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({}) };
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/production-rpc.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/supabase.js'), 'utf8'), context);
  return { context, calls, storage };
}

(async () => {
  await test('no shipped script references a legacy or test endpoint', async () => {
    const dir = path.join(__dirname, '../js');
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const name of LEGACY) {
        assert.equal(source.includes(name), false, file + ' must not reference ' + name);
      }
    }
  });

  await test('no shipped script calls a direct table endpoint', async () => {
    const dir = path.join(__dirname, '../js');
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      const direct = source.match(/\/rest\/v1\/(?!rpc)[a-z_]+/g) || [];
      assert.deepEqual(direct, [], file + ' must not address a table endpoint');
      for (const table of SYNCED_TABLES) {
        assert.equal(new RegExp("'/rest/v1/" + table).test(source), false, file + ' must not address ' + table);
      }
    }
  });

  await test('the transport allows only auth and the nine production RPCs', async () => {
    const { context, calls } = loadClient();
    assert.deepEqual(Array.from(context.CapSupabase.productionRpcPaths).sort(),
      PRODUCTION_RPCS.map(n => '/rest/v1/rpc/' + n).sort());
    for (const path of ['/rest/v1/notes?select=*', '/rest/v1/accounts?select=*', '/rest/v1/transactions',
      '/rest/v1/profiles', '/rest/v1/budgets?select=*']) {
      await assert.rejects(context.CapSupabase.syncRequest(path), /DIRECT_TABLE_ACCESS_DISABLED/);
    }
    for (const name of LEGACY) {
      await assert.rejects(context.CapSupabase.syncRequest('/rest/v1/rpc/' + name, { method: 'POST', body: '{}' }),
        /DIRECT_TABLE_ACCESS_DISABLED/);
    }
    assert.equal(calls.length, 0, 'A refused path never reaches the network');
  });

  await test('the production module refuses any endpoint outside the reviewed set', async () => {
    const { context } = loadClient();
    assert.deepEqual(Array.from(context.CapProductionRpc.ALLOWED).sort(), PRODUCTION_RPCS.slice().sort());
    await assert.rejects(context.CapProductionRpc.call('cap_sync_note_put', {}), /UNSUPPORTED_PRODUCTION_RPC/);
    await assert.rejects(context.CapProductionRpc.call('cap_test_transaction_create', {}), /UNSUPPORTED_PRODUCTION_RPC/);
    await assert.rejects(context.CapProductionRpc.call('anything_else', {}), /UNSUPPORTED_PRODUCTION_RPC/);
  });

  await test('the notes contract and readiness checks require the exact server flags', async () => {
    const { context } = loadClient();
    assert.equal(context.CapProductionRpc.ready({ version: 'CAP_PRODUCTION_SYNC_V1', ready: true }), false);
    const valid = {
      version: 'CAP_PRODUCTION_SYNC_V1', ready: true, legacy_lockout: true, private_sidecar: true,
      rpc_only_reads: true, writer_bypassrls: false, atomic_transaction_create: true,
      durable_operation_receipts: true,
      checks: Object.fromEntries(context.CapProductionRpc.READINESS_CHECKS.map(k => [k, true])),
      contracts: { ...context.CapProductionRpc.CONTRACTS }
    };
    assert.equal(context.CapProductionRpc.ready(valid), true);
    for (const key of context.CapProductionRpc.READINESS_CHECKS) {
      const drifted = { ...valid, checks: { ...valid.checks, [key]: false } };
      assert.equal(context.CapProductionRpc.ready(drifted), false, key + ' must be required');
    }
    for (const key of Object.keys(valid.contracts)) {
      const drifted = { ...valid, contracts: { ...valid.contracts, [key]: 'wrong' } };
      assert.equal(context.CapProductionRpc.ready(drifted), false, key + ' must be required');
    }
  });

  await test('a snapshot that is not complete or owner-scoped is refused', async () => {
    const { context } = loadClient();
    const counts = Object.fromEntries(SYNCED_TABLES.map((e, i) => [e, i === 0 ? 1 : 0]));
    const base = { version: 'CAP_SYNC_SNAPSHOT_V1', owner: 'owner-fixture', complete: true, record_count: 1,
      counts, records: [{ entity: 'profiles', row: { id: 'owner-fixture' } }] };
    context.CapSupabase.syncRequest = async () => base;
    const snapshot = await context.CapProductionRpc.snapshot('owner-fixture');
    assert.equal(snapshot.complete, true);
    await assert.rejects(context.CapProductionRpc.snapshot('other-owner'), /REMOTE_SNAPSHOT_OWNER_MISMATCH/);
    context.CapSupabase.syncRequest = async () => ({ ...base, complete: false });
    await assert.rejects(context.CapProductionRpc.snapshot('owner-fixture'), /REMOTE_SNAPSHOT_INCOMPLETE/);
    context.CapSupabase.syncRequest = async () => ({ ...base, record_count: 2 });
    await assert.rejects(context.CapProductionRpc.snapshot('owner-fixture'), /REMOTE_SNAPSHOT_INCOMPLETE/);
  });

  await test('note writes carry the lifecycle envelope and a stable operation id', async () => {
    const { context } = loadClient();
    const seen = [];
    context.CapSupabase.syncRequest = async (url, options) => {
      seen.push({ url, body: JSON.parse(options.body) });
      return { status: 'APPLIED' };
    };
    const id = '00000000-0000-4000-8000-0000000000aa';
    const operationId = '00000000-0000-4000-8000-0000000000bb';
    const content = { legacy_id: 'n1', title: 'T', body: 'B', note_date: '2026-10-20' };
    await context.CapProductionRpc.changeNote({ id, action: 'edit',
      expected: { content, lifecycle: { version: 1, revision: 2, deleted_at: null, operation_id: null } },
      desired: content, operationId });
    assert.equal(seen[0].url, '/rest/v1/rpc/cap_notes_change');
    assert.equal(seen[0].body.p_action, 'edit');
    assert.equal(seen[0].body.p_operation_id, operationId);
    assert.equal(seen[0].body.p_expected.lifecycle.revision, 2);
    assert.equal(seen[0].body.p_expected.content.legacy_id, 'n1');
    await context.CapProductionRpc.changeNote({ id, action: 'create', expected: null, desired: content, operationId });
    assert.equal(seen[1].body.p_expected, null);
    await context.CapProductionRpc.changeNote({ id, action: 'tombstone',
      expected: { content, lifecycle: { version: 1, revision: 2, deleted_at: null, operation_id: null } },
      desired: null, operationId });
    assert.equal(seen[2].body.p_desired, null);
    await assert.rejects(context.CapProductionRpc.changeNote({ id, action: 'delete', desired: content, operationId }),
      /NOTE_ACTION_UNSUPPORTED/);
    await assert.rejects(context.CapProductionRpc.changeNote({ id, action: 'edit', desired: content, operationId: 'not-a-uuid' }),
      /OPERATION_ID_REQUIRED/);
  });

  await test('the transaction write uses the reviewed create contract', async () => {
    const { context } = loadClient();
    const seen = [];
    context.CapSupabase.syncRequest = async (url, options) => {
      seen.push({ url, body: JSON.parse(options.body) });
      return { status: 'APPLIED' };
    };
    const operationId = '00000000-0000-4000-8000-0000000000cc';
    const transaction = { id: '00000000-0000-4000-8000-0000000000dd', user_id: 'owner-fixture' };
    const account = { id: '00000000-0000-4000-8000-0000000000ee', user_id: 'owner-fixture', balance: 100 };
    await context.CapProductionRpc.createTransaction({ operationId, transaction, expectedAccount: account });
    assert.equal(seen[0].url, '/rest/v1/rpc/cap_sync_transaction_create');
    assert.equal(seen[0].body.p_operation_id, operationId);
    assert.deepEqual(seen[0].body.p_transaction, transaction);
    assert.deepEqual(seen[0].body.p_expected_account, account);
    await assert.rejects(context.CapProductionRpc.createTransaction({ operationId: 'bad', transaction, expectedAccount: account }),
      /OPERATION_ID_REQUIRED/);
  });

  await test('operations without a production adapter fail closed with a fixed code', async () => {
    const { context } = loadClient();
    const error = context.CapProductionRpc.unsupported('transaction-update');
    assert.equal(error.code, 'UNSUPPORTED_OPERATION:transaction-update');
    assert.match(error.message, /^UNSUPPORTED_OPERATION:/);
  });

  await test('the shipped bundle keeps Cloud Sync OFF and never touches local data', async () => {
    const { context, calls, storage } = loadClient();
    await context.CapSupabase.boot();
    const source = fs.readFileSync(path.join(__dirname, '../js/sync-production.js'), 'utf8');
    assert.ok(source.includes('const SOURCE = \'production-sync-v1\''));
    assert.equal(fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8').includes('cap-shell-v319'), false);
    assert.deepEqual(calls.filter(c => c.url.includes('/rest/v1/')).map(c => c.url), []);
    assert.deepEqual(Array.from(storage.keys()).filter(k => k !== 'cap_supabase_session'), []);
  });

  console.log(`PASS: ${passed} RPC-only client checks; static bundle scan and isolated transport only`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
