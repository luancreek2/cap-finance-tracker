/* Single-session dependency-ordered production cutover checks; disposable
   PostgreSQL WASM. Real PostgreSQL 17 coverage is the manual harness. No
   Supabase, browser profile, financial data, baseline or outbox is touched. */
const assert = require('node:assert/strict');
const { PGlite } = require(process.env.CAP_PGLITE_PATH || '@electric-sql/pglite');
const f = require('./helpers/production-cutover-fixture.cjs');
const txf = require('./helpers/transaction-create-fixture.cjs');
const CHECK_KEYS = ['snapshot_contract', 'snapshot_read_access', 'readiness_contract',
  'transaction_create_contract', 'durable_receipts', 'notes_receipts', 'notes_sidecar',
  'rpc_only_reads', 'legacy_lockout', 'writer_privileges', 'service_role_private'];
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
  const readiness = async () =>
    (await db.query('select public.cap_verify_production_sync_v1() as v')).rows[0].v;
  const snapshot = async () =>
    (await db.query('select public.cap_sync_snapshot_v1() as v')).rows[0].v;
  const appState = async () => {
    await admin();
    const out = {};
    for (const table of f.publicTables) {
      out[table] = (await db.query(`select count(*)::int n,
        coalesce(md5(string_agg(to_jsonb(x)::text,'|' order by to_jsonb(x)::text)),'') h
        from public.${table} x`)).rows[0];
    }
    return out;
  };
  const expectReady = async () => {
    const r = await readiness();
    assert.equal(r.version, 'CAP_PRODUCTION_SYNC_V1');
    assert.equal(r.ready, true, JSON.stringify(r.checks));
    assert.equal(r.legacy_lockout, true);
    assert.equal(r.private_sidecar, true);
    assert.equal(r.rpc_only_reads, true);
    assert.equal(r.writer_bypassrls, false);
    assert.equal(r.atomic_transaction_create, true);
    assert.equal(r.durable_operation_receipts, true);
    assert.deepEqual(Object.keys(r.checks).sort(), CHECK_KEYS.slice().sort());
    assert.ok(Object.values(r.checks).every(v => v === true));
    assert.deepEqual(r.contracts, {
      readiness: 'CAP_PRODUCTION_SYNC_READINESS_V1',
      snapshot: 'CAP_SYNC_SNAPSHOT_V1',
      transaction_create: 'CAP_TX_CREATE_CAS_RECEIPT_V1',
      notes_change: 'CAP_NOTES_SIDECAR_V1'
    });
    return r;
  };
  try {
    await db.exec(f.setupSql());

    await test('cutover guard refuses an unapproved execution and rolls back', async () => {
      await assert.rejects(db.exec(f.cutoverDraft), /PRODUCTION_CUTOVER_NOT_APPROVED/);
      await db.exec('rollback');
      await as();
      assert.equal((await db.query('select count(*)::int n from public.notes')).rows[0].n, 1);
    });

    await admin();
    await db.exec(f.transactionInstallSql);

    await test('cutover aborts before revocation when the snapshot dependency is missing', async () => {
      await assert.rejects(db.exec(f.cutoverSql), /PRODUCTION_CUTOVER_DEPENDENCIES_REQUIRED/);
      await db.exec('rollback');
      await as();
      assert.equal((await db.query('select count(*)::int n from public.notes')).rows[0].n, 1);
    });

    await admin();
    await db.exec(f.snapshotInstallSql);
    await admin();
    await db.query('delete from cap_notes_private.note_lifecycle');

    await test('contract-version drift fails closed before any cutover mutation', async () => {
      await db.exec("comment on function public.cap_sync_transaction_create(uuid,jsonb,jsonb) is 'DRIFT';");
      await assert.rejects(db.exec(f.cutoverSql), /PRODUCTION_CUTOVER_CONTRACT_VERSION_MISMATCH/);
      await db.exec('rollback');
      await db.exec("comment on function public.cap_sync_transaction_create(uuid,jsonb,jsonb) is 'CAP_TX_CREATE_CAS_RECEIPT_V1';");
      await as();
      assert.equal((await db.query('select count(*)::int n from public.notes')).rows[0].n, 1);
    });

    await test('a platform-owned helper that clients can still execute fails closed', async () => {
      await admin();
      await db.exec('create role platform_helper_owner;');
      await db.exec('grant create on schema public to platform_helper_owner;');
      await db.exec('alter function public.set_updated_at() owner to platform_helper_owner;');
      await db.exec('grant execute on function public.set_updated_at() to authenticated;');
      await assert.rejects(db.exec(f.cutoverSql),
        /PRODUCTION_CUTOVER_PLATFORM_FUNCTION_OWNERSHIP_REQUIRED/);
      await db.exec('rollback');
      await db.exec('revoke execute on function public.set_updated_at() from authenticated;');
      await db.exec('alter function public.set_updated_at() owner to postgres;');
      await db.exec('revoke create on schema public from platform_helper_owner;');
      await db.exec('drop role platform_helper_owner;');
      await as();
      assert.equal((await db.query('select count(*)::int n from public.notes')).rows[0].n, 1);
    });

    await test('pre-cutover readiness is false while direct client access remains', async () => {
      await as();
      const r = await readiness();
      assert.equal(r.ready, false);
      assert.equal(r.checks.rpc_only_reads, false);
      assert.equal(r.checks.notes_sidecar, false);
      assert.equal(r.checks.snapshot_contract, true);
      assert.equal(r.checks.transaction_create_contract, true);
      assert.equal(r.checks.durable_receipts, true);
    });

    await test('a failure after backfill and revokes rolls the whole cutover back', async () => {
      await admin();
      const before = await appState();
      const failingDraft = f.cutoverSql.replace(/commit;\s*$/, '') +
        "\ndo $$ begin raise exception 'CUTOVER_TEST_ROLLBACK'; end $$;";
      await db.exec('begin;');
      await assert.rejects(db.exec(failingDraft), /CUTOVER_TEST_ROLLBACK/);
      await db.exec('rollback');
      await admin();
      assert.equal((await db.query('select count(*)::int n from cap_notes_private.note_lifecycle')).rows[0].n, 0);
      assert.deepEqual(await appState(), before);
      await as();
      assert.equal((await db.query('select count(*)::int n from public.notes')).rows[0].n, 1);
    });

    const beforeCutover = await appState();
    await test('dependency-ordered cutover backfills notes and applies all security changes', async () => {
      await db.exec(f.cutoverSql);
      await admin();
      assert.equal((await db.query('select count(*)::int n from cap_notes_private.note_lifecycle')).rows[0].n, 2);
      assert.deepEqual(await appState(), beforeCutover);
    });

    await test('final readiness and notes verifier both derive the exact contracts', async () => {
      await as();
      await expectReady();
      const notes = (await db.query('select public.cap_verify_notes_lifecycle() as v')).rows[0].v;
      assert.equal(notes.version, 'CAP_NOTES_SIDECAR_V1');
      assert.equal(notes.contract_ready, true, JSON.stringify(notes));
      assert.equal(notes.ready, false);
      assert.equal(notes.production_ready, false);
    });

    await test('old clients lose every direct table, column, private-schema and legacy path', async () => {
      await as();
      for (const sql of [
        'select count(*) from public.notes',
        'select count(*) from public.accounts',
        'insert into public.notes(id,user_id,legacy_id,title,body) values(gen_random_uuid(),auth.uid(),\'x\',\'x\',\'x\')',
        'update public.accounts set balance=0',
        'delete from public.transactions',
        'select count(*) from cap_notes_private.note_lifecycle',
        'select count(*) from cap_notes_private.operations',
        'select count(*) from cap_sync_private.transaction_create_receipts'
      ]) await assert.rejects(db.query(sql), /permission denied/i);
      await assert.rejects(db.query('select public.cap_verify_notes_rpc()'), /does not exist/i);
      await assert.rejects(db.query('select public.cap_verify_transaction_rpc()'), /does not exist/i);
      await asAnon();
      await assert.rejects(db.query('select public.cap_sync_snapshot_v1()'), /permission denied/i);
      await assert.rejects(db.query('select public.cap_verify_production_sync_v1()'), /permission denied/i);
      await assert.rejects(db.query('select count(*) from public.notes'), /permission denied/i);
      await admin();
      const legacy = await db.query(`select
        to_regprocedure('public.cap_sync_note_put(uuid,jsonb,jsonb)') is null as note_put,
        to_regprocedure('public.cap_verify_notes_rpc()') is null as note_verify,
        to_regprocedure('public.cap_verify_transaction_rpc()') is null as tx_verify,
        not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname like 'cap\\_test\\_%') as test_rpcs`);
      assert.deepEqual(legacy.rows[0], { note_put: true, note_verify: true,
        tx_verify: true, test_rpcs: true });
    });

    await test('only the six reviewed RPCs remain reachable to authenticated clients', async () => {
      await as();
      const rpc = await db.query(`select
        has_function_privilege('authenticated','public.cap_notes_read(uuid)','EXECUTE') as notes_read,
        has_function_privilege('authenticated','public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)','EXECUTE') as notes_change,
        has_function_privilege('authenticated','public.cap_verify_notes_lifecycle()','EXECUTE') as notes_verify,
        has_function_privilege('authenticated','public.cap_sync_transaction_create(uuid,jsonb,jsonb)','EXECUTE') as tx_create,
        has_function_privilege('authenticated','public.cap_sync_snapshot_v1()','EXECUTE') as snapshot,
        has_function_privilege('authenticated','public.cap_verify_production_sync_v1()','EXECUTE') as readiness`);
      assert.ok(Object.values(rpc.rows[0]).every(v => v === true));
      const s = await snapshot();
      assert.equal(s.version, 'CAP_SYNC_SNAPSHOT_V1');
      assert.equal(s.record_count, 15);
    });

    await test('notes create and transaction create still work through RPC-only access', async () => {
      const noteId = f.uuid(4000), noteOp = f.uuid(4001);
      const content = { legacy_id: 'cutover-note', title: 'Cutover note',
        body: 'created after cutover', note_date: '2026-10-21' };
      await as();
      const changed = (await db.query(
        'select public.cap_notes_change($1::uuid,$2::jsonb,$3,$4::jsonb,$5::uuid) as v',
        [noteId, null, 'create', content, noteOp])).rows[0].v;
      assert.equal(changed.status, 'APPLIED');

      await admin();
      const expected = (await db.query(
        'select to_jsonb(a) as v from public.accounts a where id=$1', [f.ids.cash])).rows[0].v;
      const tx = txf.transaction(5000, { account_id: f.ids.cash });
      const txOp = f.uuid(5001);
      await as();
      const applied = (await db.query(
        'select public.cap_sync_transaction_create($1::uuid,$2::jsonb,$3::jsonb) as v',
        [txOp, tx, expected])).rows[0].v;
      assert.equal(applied.status, 'APPLIED');
      assert.equal(applied.transaction_id, tx.id);

      await admin();
      const after = await db.query(`select
        (select balance from public.accounts where id=$1) as balance,
        (select count(*)::int from cap_sync_private.transaction_create_receipts
          where operation_id=$2) as receipts`, [f.ids.cash, txOp]);
      assert.equal(Number(after.rows[0].balance), 95);
      assert.equal(after.rows[0].receipts, 1);

      await as();
      const s = await snapshot();
      assert.equal(s.counts.notes, 2);
      assert.equal(s.counts.transactions, 2);
      assert.equal(s.record_count, 17);
    });

    await test('the cutover is rerunnable without weakening the final contract', async () => {
      await admin();
      await db.exec(f.cutoverSql);
      await as();
      await expectReady();
      await assert.rejects(db.query('select count(*) from public.notes'), /permission denied/i);
      await admin();
      assert.equal((await db.query('select count(*)::int n from public.notes')).rows[0].n, 3);
    });
  } finally {
    await db.close();
  }
  console.log(`PASS: ${passed} isolated production-cutover SQL checks; synthetic PGlite only, no concurrency claim`);
})().catch(e => { console.error(process.env.CAP_CUTOVER_DEBUG ? e.stack : e.message); process.exitCode = 1; });
