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
  'cap_verify_transaction_update_delete_v1', 'cap_notes_change', 'cap_notes_read', 'cap_verify_notes_lifecycle',
  'cap_notifications_register_v1', 'cap_notifications_invalidate_v1',
  'cap_notifications_summary_v1', 'cap_notifications_readiness_v1',
  'cap_notifications_readiness_v2', 'cap_notifications_publish_v2',
  'cap_notifications_schedule_readback_v2'];
const NOTIFICATION_RPCS = PRODUCTION_RPCS.filter(n => n.startsWith('cap_notifications_'));
const SYNCED_TABLES = ['profiles', 'user_preferences', 'categories', 'accounts', 'goals', 'debts',
  'bills', 'account_statements', 'transactions', 'transfers', 'bill_payments', 'budgets', 'notes'];
let passed = 0;
const test = async (label, fn) => {
  try { await fn(); passed++; }
  catch (e) { e.message = label + ': ' + e.message; throw e; }
};

function loadClient(options) {
  const calls = [];
  const storage = new Map();
  if (options?.session) storage.set('cap_supabase_session', JSON.stringify(options.session));
  const context = {
    crypto: webcrypto, TextEncoder, URLSearchParams, URL,
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

  await test('the transport allows only auth and the sixteen production RPCs', async () => {
    const { context, calls } = loadClient();
    assert.deepEqual(Array.from(context.CapSupabase.productionRpcPaths).sort(),
      PRODUCTION_RPCS.map(n => '/rest/v1/rpc/' + n).sort());
    assert.deepEqual(Array.from(context.CapSupabase.notificationRpcPaths).sort(),
      NOTIFICATION_RPCS.map(n => '/rest/v1/rpc/' + n).sort());
    for (const path of ['/rest/v1/notes?select=*', '/rest/v1/accounts?select=*', '/rest/v1/transactions',
      '/rest/v1/profiles', '/rest/v1/budgets?select=*', '/rest/v1/rpc/cap_notifications_publish_v1']) {
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

  await test('the notification wrappers accept only the reviewed enrollment contract', async () => {
    const { context } = loadClient();
    const seen = [];
    const installationId = '00000000-0000-4000-8000-0000000000a1';
    const bindingId = '00000000-0000-4000-8000-0000000000a2';
    const key = Buffer.alloc(65, 7).toString('base64url');
    const auth = Buffer.alloc(16, 9).toString('base64url');
    context.CapSupabase.syncRequest = async (url, options) => {
      seen.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('cap_notifications_register_v1')) {
        return { binding_id: bindingId, installation_id: installationId, generation: 1,
          schedule_revision: 0, state: 'pending' };
      }
      if (url.endsWith('cap_notifications_invalidate_v1')) {
        return { binding_id: bindingId, installation_id: installationId, generation: 2,
          schedule_revision: 0, state: 'disabled' };
      }
      if (url.endsWith('cap_notifications_summary_v1')) {
        return { protocol: 'CAP_PUSH_V1', background_enabled: false, bindings: [{ binding_id: bindingId,
          installation_id: installationId, generation: 1, schedule_revision: 0, preference_revision: 0,
          state: 'pending', created_at: '2026-10-28T00:00:00Z', updated_at: '2026-10-28T00:00:00Z',
          last_confirmed_at: null }] };
      }
      return { migration_id: 'CAP_NOTIFICATIONS_FOUNDATION_5B1_V1', protocol: 'CAP_PUSH_V1',
        engine_identity: 'cap-reminder-v1', digest_version: 'hmac-sha256-v1', foundation_ready: true,
        background_enabled: false, background_ready: false, runtime_parked: true };
    };
    const binding = await context.CapProductionRpc.notificationRegister({ installationId,
      expectedGeneration: 0, endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: key,
      auth, vapidKeyVersion: 'v1', browserExpiration: null });
    assert.equal(binding.binding_id, bindingId);
    assert.equal(seen[0].url, '/rest/v1/rpc/cap_notifications_register_v1');
    assert.equal(seen[0].body.p_installation_id, installationId);
    assert.equal(seen[0].body.p_expected_generation, 0);
    assert.equal(seen[0].body.p_protocol, 'CAP_PUSH_V1');
    assert.equal(seen[0].body.p_p256dh, key);
    const invalidated = await context.CapProductionRpc.notificationInvalidate({ bindingId, generation: 1,
      scheduleRevision: 0, disable: true });
    assert.equal(invalidated.state, 'disabled');
    assert.equal(seen[1].body.p_expected_revision, 0);
    assert.equal(seen[1].body.p_disable, true);
    assert.equal((await context.CapProductionRpc.notificationSummary()).ok, true);
    assert.equal((await context.CapProductionRpc.notificationReadiness()).ok, true);
    // The legacy v1 publish entrypoint stays unreachable. The Phase 2A v2
    // surface is wrapped but never driven by startup; the publisher is dark.
    assert.equal(context.CapProductionRpc.ALLOWED.includes('cap_notifications_publish_v1'), false);
    await assert.rejects(context.CapProductionRpc.call('cap_notifications_publish_v1', {}), /UNSUPPORTED_PRODUCTION_RPC/);
    assert.equal(context.CapProductionRpc.ALLOWED.includes('cap_notifications_publish_v2'), true);
    assert.equal(context.CapProductionRpc.ALLOWED.includes('cap_notifications_schedule_readback_v2'), true);
    assert.equal(context.CapProductionRpc.ALLOWED.includes('cap_notifications_readiness_v2'), true);
  });

  await test('notification wrappers reject malformed requests before the network', async () => {
    const { context } = loadClient();
    const calls = [];
    context.CapSupabase.syncRequest = async (url, options) => { calls.push(url); return {}; };
    const good = { installationId: '00000000-0000-4000-8000-0000000000b1', expectedGeneration: 0,
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'AAAA', auth: 'BBBB',
      vapidKeyVersion: 'v1', browserExpiration: null };
    await assert.rejects(context.CapProductionRpc.notificationRegister({ ...good, installationId: 'x' }),
      /INSTALLATION_ID_INVALID/);
    await assert.rejects(context.CapProductionRpc.notificationRegister({ ...good, expectedGeneration: -1 }),
      /NOTIFICATION_GENERATION_INVALID/);
    await assert.rejects(context.CapProductionRpc.notificationRegister({ ...good, endpoint: 'http://x.invalid' }),
      /NOTIFICATION_ENDPOINT_INVALID/);
    await assert.rejects(context.CapProductionRpc.notificationRegister({ ...good, p256dh: 'AAAA=' }),
      /NOTIFICATION_KEYS_INVALID/);
    await assert.rejects(context.CapProductionRpc.notificationRegister({ ...good, vapidKeyVersion: '1' }),
      /NOTIFICATION_VAPID_VERSION_INVALID/);
    await assert.rejects(context.CapProductionRpc.notificationRegister({ ...good, browserExpiration: 'later' }),
      /NOTIFICATION_EXPIRATION_INVALID/);
    await assert.rejects(context.CapProductionRpc.notificationInvalidate({ bindingId: good.installationId,
      generation: 1, scheduleRevision: 0, disable: false }), /NOTIFICATION_INVALIDATE_INVALID/);
    assert.deepEqual(calls, []);
  });

  await test('notification and generic application 4xx never invalidate a verified session', async () => {
    const { context } = loadClient({ session: { access_token: 'fixture', refresh_token: 'fixture-refresh',
      user: { id: 'owner-fixture' } } });
    await context.CapSupabase.boot();
    assert.equal(context.CapSupabase.status().authenticated, true);
    const reject4xx = async () => ({ ok: false, status: 400,
      text: async () => JSON.stringify({ message: 'NOTIFICATION_BINDING_CONFLICT' }) });
    context.fetch = reject4xx;
    await assert.rejects(context.CapSupabase.syncRequest('/rest/v1/rpc/cap_notifications_register_v1',
      { method: 'POST', body: '{}' }), /NOTIFICATION_BINDING_CONFLICT/);
    assert.equal(context.CapSupabase.status().authenticated, true, 'notification 4xx is not auth evidence');
    await assert.rejects(context.CapSupabase.syncRequest('/rest/v1/rpc/cap_sync_snapshot_v1',
      { method: 'POST', body: '{}' }), /NOTIFICATION_BINDING_CONFLICT/);
    assert.equal(context.CapSupabase.status().authenticated, true, 'generic application 4xx is not auth evidence');
    context.fetch = async () => ({ ok: false, status: 401,
      text: async () => JSON.stringify({ message: 'invalid jwt' }) });
    await assert.rejects(context.CapSupabase.syncRequest('/rest/v1/rpc/cap_sync_snapshot_v1',
      { method: 'POST', body: '{}' }), /invalid jwt/);
    assert.equal(context.CapSupabase.status().authenticated, true, 'data-path 401 alone is not auth evidence');
    await assert.rejects(context.CapSupabase.currentUser(), /invalid jwt/);
    assert.equal(context.CapSupabase.status().authenticated, false, 'only the auth-path rejection invalidates');
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

  await test('the Scheduling V2 wrappers use the exact Phase 2A signatures and no financial fields', async () => {
    const { context } = loadClient();
    const seen = [];
    const bindingId = '00000000-0000-4000-8000-0000000000f1';
    const entry = { candidate_digest: 'a'.repeat(64), obligation_digest: 'b'.repeat(64),
      time_basis: 'wall', eligible_local_date: '2026-11-01', local_time: '09:00',
      timezone: 'Asia/Manila', send_after: '2026-11-01T01:00:00Z', expires_at: '2026-11-01T16:00:00Z' };
    const occurrence = { ...entry, delivery_state: 'queued' };
    context.CapSupabase.syncRequest = async (url, options) => {
      seen.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('cap_notifications_readiness_v2')) {
        return { migration_id: 'CAP_NOTIFICATIONS_SCHEDULING_V2', scheduling_contract: 2, protocol: 'CAP_PUSH_V1',
          engine_identity: 'cap-reminder-v1', digest_version: 'hmac-sha256-v1', scheduling_ready: true,
          max_future_hours: 8760, max_delivery_hours: 24, local_midnight_ceiling: true,
          gap_policy: 'reject', fold_policy: 'later', background_enabled: false, background_ready: false,
          runtime_parked: true, dispatch_ready: false };
      }
      if (url.endsWith('cap_notifications_schedule_readback_v2')) {
        return { binding_id: bindingId, generation: 1, scheduling_contract: 2, state: 'pending',
          schedule_revision: 1, preference_revision: 1, notification_timezone: 'Asia/Manila',
          occurrences: [occurrence], dispatch_ready: false };
      }
      return { binding_id: bindingId, generation: 1, scheduling_contract: 2, schedule_revision: 1,
        preference_revision: 1, notification_timezone: 'Asia/Manila', accepted_at: '2026-10-30T00:00:00Z',
        entry_count: 1, occurrences: [occurrence], dispatch_ready: false };
    };
    assert.equal((await context.CapProductionRpc.notificationReadinessV2()).ok, true);
    const ack = await context.CapProductionRpc.notificationPublishV2({ bindingId, generation: 1,
      expectedRevision: 0, preferenceRevision: 1, timezone: 'Asia/Manila', entries: [entry] });
    assert.equal(ack.schedule_revision, 1);
    assert.deepEqual(seen[1].body, {
      p_binding_id: bindingId, p_generation: 1, p_expected_revision: 0, p_preference_revision: 1,
      p_protocol: 'CAP_PUSH_V1', p_engine_identity: 'cap-reminder-v1', p_digest_version: 'hmac-sha256-v1',
      p_timezone: 'Asia/Manila', p_entries: [entry] });
    const serialized = JSON.stringify(seen[1].body);
    for (const forbidden of ['merchant', 'amount', 'title', 'description', 'account', 'category', 'budget', 'notes']) {
      assert.equal(serialized.includes(forbidden), false, 'no financial field in the payload: ' + forbidden);
    }
    assert.equal((await context.CapProductionRpc.notificationReadbackV2({ bindingId, generation: 1 })).schedule_revision, 1);
    await assert.rejects(context.CapProductionRpc.notificationPublishV2({ bindingId, generation: 1,
      expectedRevision: 0, preferenceRevision: 1, timezone: 'Asia/Manila',
      entries: [{ ...entry, candidate_digest: 'not-hex' }] }), /NOTIFICATION_ENTRY_INVALID/);
    await assert.rejects(context.CapProductionRpc.notificationPublishV2({ bindingId, generation: 1,
      expectedRevision: 0, preferenceRevision: 1, timezone: 'Asia/Manila',
      entries: [{ ...entry, extra: 'x' }] }), /NOTIFICATION_ENTRY_INVALID/);
    await assert.rejects(context.CapProductionRpc.notificationPublishV2({ bindingId, generation: 1,
      expectedRevision: 0, preferenceRevision: 1, timezone: 'Asia/Manila',
      entries: [{ ...entry, time_basis: 'local' }] }), /NOTIFICATION_ENTRY_INVALID/);
    await assert.rejects(context.CapProductionRpc.notificationPublishV2({ bindingId, generation: 0,
      expectedRevision: 0, preferenceRevision: 1, timezone: 'Asia/Manila', entries: [entry] }), /NOTIFICATION_GENERATION_INVALID/);
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
