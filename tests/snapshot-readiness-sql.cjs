/* Single-session snapshot/readiness contract tests; disposable PostgreSQL WASM.
   Real overlapping-session snapshot consistency is tests/manual/snapshot-readiness-races.cjs.
   No Supabase, browser profile, financial data, baseline or outbox is touched. */
const assert = require('node:assert/strict');
const { PGlite } = require(process.env.CAP_PGLITE_PATH || '@electric-sql/pglite');
const f = require('./helpers/production-snapshot-fixture.cjs');
const CHECK_KEYS = ['snapshot_contract', 'snapshot_read_access', 'readiness_contract',
  'transaction_create_contract', 'durable_receipts', 'notes_receipts', 'notes_sidecar',
  'rpc_only_reads', 'legacy_lockout', 'writer_privileges', 'service_role_private'];
const CONTRACTS = {
  readiness: 'CAP_PRODUCTION_SYNC_READINESS_V1',
  snapshot: 'CAP_SYNC_SNAPSHOT_V1',
  transaction_create: 'CAP_TX_CREATE_CAS_RECEIPT_V1',
  notes_change: 'CAP_NOTES_SIDECAR_V1'
};
const allTables = [...f.publicTables.map(n => 'public.' + n),
  'cap_notes_private.note_lifecycle', 'cap_notes_private.operations',
  'cap_sync_private.transaction_create_receipts'];
let passed = 0;
const test = async (label, fn) => {
  try { await fn(); passed++; }
  catch (e) { e.message = label + ': ' + e.message; throw e; }
};
(async () => {
  const db = new PGlite();
  const admin = () => db.exec('reset role');
  const as = async (owner = f.ids.owner, role = 'authenticated') => {
    await admin();
    await db.exec(`set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  };
  const asAnon = async () => { await admin(); await db.exec('set role anon'); };
  const snapshot = async () =>
    (await db.query('select public.cap_sync_snapshot_v1() as v')).rows[0].v;
  const readiness = async () =>
    (await db.query('select public.cap_verify_production_sync_v1() as v')).rows[0].v;
  const state = async () => {
    await admin();
    const out = {};
    for (const table of allTables) {
      out[table] = (await db.query(`select count(*)::int n,
        coalesce(md5(string_agg(to_jsonb(x)::text,'|' order by to_jsonb(x)::text)),'') h
        from ${table} x`)).rows[0];
    }
    return out;
  };
  const expectReady = async () => {
    const r = await readiness();
    assert.equal(r.ready, true, JSON.stringify(r.checks));
    assert.equal(r.legacy_lockout, true);
    assert.equal(r.private_sidecar, true);
    assert.equal(r.rpc_only_reads, true);
    assert.equal(r.writer_bypassrls, false);
    assert.equal(r.atomic_transaction_create, true);
    assert.equal(r.durable_operation_receipts, true);
    return r;
  };
  try {
    await db.exec(f.setupSql());

    await test('snapshot installer guard rejects an unapproved execution', async () => {
      await assert.rejects(db.exec(f.snapshotDraft), /SNAPSHOT_INSTALL_NOT_APPROVED/);
      await db.exec('rollback');
      assert.equal((await db.query("select count(*)::int n from pg_roles where rolname='cap_sync_reader'")).rows[0].n, 0);
    });

    await db.exec(f.transactionInstallSql);
    await db.exec(f.snapshotInstallSql);

    await test('pre-cutover readiness is false because direct client access remains', async () => {
      await as();
      const r = await readiness();
      assert.equal(r.version, 'CAP_PRODUCTION_SYNC_V1');
      assert.equal(r.ready, false);
      assert.equal(r.checks.rpc_only_reads, false);
      assert.equal(r.checks.notes_sidecar, false);
      assert.equal(r.checks.snapshot_contract, true);
      assert.equal(r.checks.transaction_create_contract, true);
      assert.equal(r.checks.durable_receipts, true);
      assert.deepEqual(Object.keys(r.checks).sort(), CHECK_KEYS.slice().sort());
      assert.deepEqual(r.contracts, CONTRACTS);
    });

    await db.exec(f.lockdownSql());

    await test('fully locked-down readiness is derived from exact contracts', async () => {
      await as();
      const r = await expectReady();
      assert.deepEqual(Object.keys(r.checks).sort(), CHECK_KEYS.slice().sort());
      assert.ok(Object.values(r.checks).every(v => v === true));
      assert.deepEqual(r.contracts, CONTRACTS);
    });

    await test('snapshot returns every owner entity, singleton and empty collection', async () => {
      await as();
      const s = await snapshot();
      assert.equal(s.version, 'CAP_SYNC_SNAPSHOT_V1');
      assert.equal(s.owner, f.ids.owner);
      assert.equal(s.complete, true);
      assert.equal(s.record_count, 15);
      assert.equal(s.records.length, s.record_count);
      assert.deepEqual(Object.keys(s.counts).sort(), f.publicTables.slice().sort());
      assert.deepEqual(s.counts, {
        profiles: 1, user_preferences: 1, categories: 1, accounts: 3, goals: 1, debts: 1,
        bills: 1, account_statements: 1, transactions: 1, transfers: 1, bill_payments: 1,
        budgets: 1, notes: 1
      });
      assert.ok(s.records.every(r => r.entity === 'profiles'
        ? r.row.id === f.ids.owner : r.row.user_id === f.ids.owner));
      const keys = s.records.map(r => r.entity + ':' + (r.row.id || r.row.user_id));
      assert.equal(new Set(keys).size, keys.length);
      const note = s.records.find(r => r.entity === 'notes');
      assert.equal(note.row.id, f.ids.note);
      assert.deepEqual(note.lifecycle, { version: 1, revision: 1, deleted_at: null, operation_id: null });
      assert.equal(s.records.some(r => r.row.id === f.ids.foreignNote
        || r.row.id === f.ids.foreignAccount), false);
    });

    await test('snapshot is owner-scoped and includes zero-count entities', async () => {
      await as(f.ids.foreign);
      const s = await snapshot();
      assert.equal(s.owner, f.ids.foreign);
      assert.equal(s.complete, true);
      assert.equal(s.record_count, 5);
      assert.deepEqual(s.counts, {
        profiles: 1, user_preferences: 1, categories: 1, accounts: 1, goals: 0, debts: 0,
        bills: 0, account_statements: 0, transactions: 0, transfers: 0, bill_payments: 0,
        budgets: 0, notes: 1
      });
      assert.ok(s.records.every(r => r.entity === 'profiles'
        ? r.row.id === f.ids.foreign : r.row.user_id === f.ids.foreign));
      assert.equal(s.records.some(r => r.row.id === f.ids.note
        || r.row.id === f.ids.cash), false);
    });

    await test('snapshot includes the exact lifecycle envelope, including a tombstone', async () => {
      await admin();
      await db.query(`update cap_notes_private.note_lifecycle set deleted_at=$1,operation_id=$2
        where note_id=$3`, ['2026-10-21T00:00:00.000Z', f.uuid(999), f.ids.note]);
      await as();
      const s = await snapshot();
      const note = s.records.find(r => r.entity === 'notes');
      assert.deepEqual(note.lifecycle, { version: 1, revision: 1,
        deleted_at: '2026-10-21T00:00:00.000Z', operation_id: f.uuid(999) });
      await admin();
      await db.query(`update cap_notes_private.note_lifecycle set deleted_at=null,operation_id=null
        where note_id=$1`, [f.ids.note]);
    });

    await test('authentication is required and anon cannot execute either RPC', async () => {
      await as('', 'authenticated');
      await assert.rejects(snapshot(), /AUTH_REQUIRED/);
      await assert.rejects(readiness(), /AUTH_REQUIRED/);
      await asAnon();
      await assert.rejects(snapshot(), /permission denied/);
      await assert.rejects(readiness(), /permission denied/);
    });

    await test('malformed RPC invocations are rejected, not coerced', async () => {
      await as();
      await assert.rejects(db.query('select public.cap_sync_snapshot_v1($1::jsonb)', [{}]),
        /does not exist|function/i);
      await assert.rejects(db.query('select public.cap_verify_production_sync_v1($1::jsonb)', [{}]),
        /does not exist|function/i);
    });

    await test('snapshot and readiness are read-only', async () => {
      const before = await state();
      await as();
      await snapshot();
      await readiness();
      assert.deepEqual(await state(), before);
    });

    await test('an incomplete notes sidecar rejects the whole snapshot', async () => {
      await admin();
      await db.query('delete from cap_notes_private.note_lifecycle where note_id=$1', [f.ids.note]);
      await as();
      await assert.rejects(snapshot(), /SNAPSHOT_SIDECAR_INCOMPLETE/);
      assert.equal((await readiness()).ready, true);
      await admin();
      await db.query(`insert into cap_notes_private.note_lifecycle(note_id,user_id,revision)
        values($1,$2,1)`, [f.ids.note, f.ids.owner]);
    });

    await test('runtime contract drift fails the snapshot closed', async () => {
      await admin();
      await db.exec('alter function public.cap_sync_snapshot_v1() security invoker');
      await as();
      await assert.rejects(snapshot(), /SNAPSHOT_CONTRACT_NOT_VERIFIED/);
      const r = await readiness();
      assert.equal(r.ready, false);
      assert.equal(r.checks.snapshot_contract, false);
      await admin();
      await db.exec('alter function public.cap_sync_snapshot_v1() security definer');
      await as();
      await expectReady();
    });

    await test('missing reader access or disabled RLS fails both checks', async () => {
      await admin();
      await db.exec('revoke select on public.accounts from cap_sync_reader');
      await as();
      let r = await readiness();
      assert.equal(r.ready, false);
      assert.equal(r.checks.snapshot_read_access, false);
      await assert.rejects(snapshot(), /SNAPSHOT_CONTRACT_NOT_VERIFIED/);
      await admin();
      await db.exec('grant select on public.accounts to cap_sync_reader');
      await db.exec('alter table public.accounts disable row level security');
      await as();
      r = await readiness();
      assert.equal(r.ready, false);
      assert.equal(r.checks.snapshot_read_access, false);
      await assert.rejects(snapshot(), /SNAPSHOT_CONTRACT_NOT_VERIFIED/);
      await admin();
      await db.exec('alter table public.accounts enable row level security');
      await as();
      await expectReady();
    });

    await test('each readiness failure condition is reported independently', async () => {
      const mutations = [
        ['rpc_only_reads', async () => {
          await db.exec('grant select on public.accounts to authenticated');
          return async () => { await db.exec('revoke select on public.accounts from authenticated'); };
        }],
        ['legacy_lockout', async () => {
          await db.exec("create function public.cap_test_legacy() returns void language sql as 'select'");
          await db.exec('grant execute on function public.cap_test_legacy() to authenticated');
          return async () => { await db.exec('drop function public.cap_test_legacy()'); };
        }],
        ['snapshot_contract', async () => {
          await db.exec('alter function public.cap_sync_snapshot_v1() set search_path=public');
          return async () => { await db.exec('alter function public.cap_sync_snapshot_v1() set search_path=pg_catalog'); };
        }],
        ['readiness_contract', async () => {
          await db.exec('alter function public.cap_verify_production_sync_v1() set search_path=public');
          return async () => { await db.exec('alter function public.cap_verify_production_sync_v1() set search_path=pg_catalog'); };
        }],
        ['transaction_create_contract', async () => {
          await db.exec('alter function public.cap_sync_transaction_create(uuid,jsonb,jsonb) security invoker');
          return async () => { await db.exec('alter function public.cap_sync_transaction_create(uuid,jsonb,jsonb) security definer'); };
        }],
        ['durable_receipts', async () => {
          await db.exec('alter table cap_sync_private.transaction_create_receipts no force row level security');
          return async () => { await db.exec('alter table cap_sync_private.transaction_create_receipts force row level security'); };
        }],
        ['notes_receipts', async () => {
          await db.exec('revoke insert on cap_notes_private.operations from cap_notes_sidecar_writer');
          return async () => { await db.exec('grant insert on cap_notes_private.operations to cap_notes_sidecar_writer'); };
        }],
        ['notes_sidecar', async () => {
          await db.exec('alter function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid) security invoker');
          return async () => { await db.exec('alter function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid) security definer'); };
        }],
        ['writer_privileges', async () => {
          await db.exec('alter role cap_sync_reader inherit');
          return async () => { await db.exec('alter role cap_sync_reader noinherit'); };
        }],
        ['service_role_private', async () => {
          await db.exec('grant usage on schema cap_notes_private to service_role');
          return async () => { await db.exec('revoke usage on schema cap_notes_private from service_role'); };
        }]
      ];
      for (const [name, mutate] of mutations) {
        await admin();
        const restore = await mutate();
        await as();
        const r = await readiness();
        assert.equal(r.ready, false, name);
        assert.equal(r.checks[name], false, name);
        await admin();
        await restore();
        await as();
        await expectReady();
      }
    });

    await test('readiness does not read note content even when the snapshot is incomplete', async () => {
      await admin();
      await db.exec('revoke select on public.notes from cap_sync_reader');
      await as();
      const r = await readiness();
      assert.equal(r.ready, false);
      assert.equal(r.checks.snapshot_read_access, false);
      assert.deepEqual(Object.keys(r.checks).sort(), CHECK_KEYS.slice().sort());
      await admin();
      await db.exec('grant select on public.notes to cap_sync_reader');
      await as();
      await expectReady();
    });

    await test('first-install guard never overwrites an existing contract', async () => {
      await admin();
      await assert.rejects(db.exec(f.snapshotInstallSql), /SNAPSHOT_INSTALL_TARGET_NOT_EMPTY/);
      await db.exec('rollback');
    });

    await test('a readiness call cannot mutate private or public state', async () => {
      const before = await state();
      await as();
      await readiness();
      await as(f.ids.foreign);
      await readiness();
      assert.deepEqual(await state(), before);
    });

    console.log(`PASS: ${passed} isolated snapshot/readiness SQL checks; synthetic PGlite only, no concurrency claim`);
  } finally { await db.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
