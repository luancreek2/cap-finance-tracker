/* Managed-auth-denial regression and in-place Notes repair. Disposable PGlite
   only; no production connection, app storage, baseline or outbox. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require(process.env.CAP_PGLITE_PATH || '@electric-sql/pglite');
const notes = require('./helpers/production-notes-fixture.cjs');
const full = require('./helpers/production-cutover-fixture.cjs');
const repair = fs.readFileSync(`${__dirname}/../supabase_production_notes_identity_repair.sql`, 'utf8');
let checks = 0;
async function check(label, run) {
  try { await run(); checks++; } catch (e) { e.message = label + ': ' + e.message; throw e; }
}
const scalar = async (db, sql) => (await db.query(sql)).rows[0].v;
const user = (db, owner, role = 'authenticated') => db.exec(`reset role;set role ${role};
  set request.jwt.claim.sub='${owner}';set request.jwt.claims='';`);
const state = db => scalar(db, `select jsonb_build_object(
  'notes',(select jsonb_agg(to_jsonb(x) order by id) from public.notes x),
  'lifecycle',(select jsonb_agg(to_jsonb(x) order by note_id) from cap_notes_private.note_lifecycle x),
  'operations',(select jsonb_agg(to_jsonb(x) order by operation_id) from cap_notes_private.operations x)) v`);
(async () => {
  const db = new PGlite();
  try {
    await db.exec(notes.setupSql());
    // Model the installed old functions/policies, with EXECUTE on auth.uid()
    // but no schema USAGE. No managed object is changed by the repair.
    const old = notes.notesDraft.replaceAll('public.cap_request_uid', 'auth.uid')
      .replace('roles_ok := public.cap_request_identity_ok() and exists(', 'roles_ok := exists(');
    await db.exec(`set cap.notes_sidecar_install='reviewed-draft-only';${old}`);
    await db.exec(notes.backfillSql);
    const before = await state(db);
    const authAcl = await scalar(db, "select nspacl::text v from pg_namespace where nspname='auth'");
    await check('reproduces production: execute is true but auth usage false', async () => {
      assert.equal(await scalar(db, "select has_function_privilege('cap_notes_sidecar_writer','auth.uid()','EXECUTE') v"), true);
      assert.equal(await scalar(db, "select has_schema_privilege('cap_notes_sidecar_writer','auth','USAGE') v"), false);
      await user(db, notes.ids.owner);
      await assert.rejects(db.query('select public.cap_verify_notes_lifecycle()'), /permission denied for schema auth/);
      await db.exec('reset role');
    });
    await check('unguarded repair refuses without changing rows', async () => {
      await assert.rejects(db.exec(repair), /NOTES_IDENTITY_REPAIR_NOT_APPROVED/);
      await db.exec('rollback');
      assert.deepEqual(await state(db), before);
    });
    await check('repair failure after definition changes rolls back functions and policies', async () => {
      const injected = repair.replace(/commit;\s*$/, () => "do $$ begin raise exception 'REPAIR_ROLLBACK_TEST'; end $$;");
      await assert.rejects(db.exec(`set cap.notes_identity_repair='reviewed-draft-only';${injected}`), /REPAIR_ROLLBACK_TEST/);
      await db.exec('rollback');
      assert.ok(await scalar(db, "select prosrc like '%auth.uid%' v from pg_proc where oid='public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)'::regprocedure"));
      assert.equal(await scalar(db, `select count(*)::int v from pg_policy
        where polroles=array['cap_notes_sidecar_writer'::regrole::oid]
          and (coalesce(pg_get_expr(polqual,polrelid),'') like '%auth.uid%'
            or coalesce(pg_get_expr(polwithcheck,polrelid),'') like '%auth.uid%')`), 8);
      assert.equal(await scalar(db, "select count(*)::int v from pg_auth_members where roleid='cap_notes_sidecar_writer'::regrole"), 0);
      assert.deepEqual(await state(db), before);
    });
    await check('in-place repair retains all content lifecycle receipts and managed ACLs', async () => {
      await db.exec(`set cap.notes_identity_repair='reviewed-draft-only';${repair}`);
      assert.deepEqual(await state(db), before);
      assert.equal(await scalar(db, "select nspacl::text v from pg_namespace where nspname='auth'"), authAcl);
      assert.equal(await scalar(db, "select has_schema_privilege('cap_notes_sidecar_writer','auth','USAGE') v"), false);
      assert.equal(await scalar(db, "select count(*)::int v from pg_auth_members where roleid='cap_notes_sidecar_writer'::regrole or member='cap_notes_sidecar_writer'::regrole"), 0);
    });
    await db.exec(notes.cutoverSql());
    await check('repaired verifier checks exact new policies without auth access', async () => {
      await user(db, notes.ids.owner);
      const r = await scalar(db, 'select public.cap_verify_notes_lifecycle() v');
      assert.equal(r.contract_ready, true, JSON.stringify(r));
      assert.equal(r.ready, false); assert.equal(r.production_ready, false);
    });
    await check('repaired writer edit and exact replay preserve request binding', async () => {
      const expected = await scalar(db, `select public.cap_notes_read('${notes.ids.note}') v`);
      const args = [notes.ids.note, expected, 'edit', { ...notes.contents.note, body: 'repair synthetic edit' }, notes.uuid(800)];
      const call = () => db.query('select public.cap_notes_change($1,$2,$3,$4,$5) v', args);
      assert.equal((await call()).rows[0].v.status, 'APPLIED');
      assert.equal((await call()).rows[0].v.status, 'ALREADY_APPLIED');
      args[3] = { ...args[3], body: 'different request' };
      await assert.rejects(call(), /OPERATION_REUSE_CONFLICT/);
    });
    await check('repaired writer denies foreign read/write and unauthenticated caller', async () => {
      await user(db, notes.ids.foreign);
      assert.equal(await scalar(db, `select public.cap_notes_read('${notes.ids.note}') v`), null);
      const r = (await db.query('select public.cap_notes_change($1,null,$2,$3,$4) v',
        [notes.ids.note, 'create', notes.contents.note, notes.uuid(801)])).rows[0].v;
      assert.equal(r.status, 'CONFLICT');
      await user(db, '');
      await assert.rejects(db.query('select public.cap_verify_notes_lifecycle()'), /AUTH_REQUIRED/);
      await user(db, '', 'anon');
      await assert.rejects(db.query('select public.cap_verify_notes_lifecycle()'), /permission denied/);
      await db.exec('reset role');
    });
    await check('repair can rerun without resetting revisions or receipts', async () => {
      const saved = await state(db);
      await db.exec(repair);
      assert.deepEqual(await state(db), saved);
    });
  } finally { await db.close(); }

  const all = new PGlite();
  try {
    await all.exec(full.setupSql()); await all.exec(full.transactionInstallSql);
    await all.exec(full.snapshotInstallSql); await all.exec(full.cutoverSql);
    const roles = ['cap_notes_sidecar_writer', 'cap_transaction_writer', 'cap_sync_reader'];
    for (const role of roles) await check(role + ' works without managed schema access', async () => {
      assert.equal(await scalar(all, `select has_schema_privilege('${role}','auth','USAGE') v`), false);
      await all.exec(`set role ${role}`);
      await assert.rejects(all.query('select auth.uid()'), /permission denied for schema auth/);
      await all.exec('reset role');
    });
    await check('all readiness flags true with auth denied to every Cap role', async () => {
      await user(all, full.ids.owner);
      const r = await scalar(all, 'select public.cap_verify_production_sync_v1() v');
      assert.equal(r.ready, true, JSON.stringify(r)); assert.equal(Object.keys(r.checks).length, 11);
      assert.ok(Object.values(r.checks).every(v => v === true));
    });
    await check('JSON JWT claims establish identity without client user parameter', async () => {
      await all.exec(`set request.jwt.claim.sub='';set request.jwt.claims='{"sub":"${full.ids.foreign}","role":"authenticated"}';`);
      const s = await scalar(all, 'select public.cap_sync_snapshot_v1() v');
      assert.equal(s.owner, full.ids.foreign);
      assert.ok(s.records.every(r => (r.entity === 'profiles' ? r.row.id : r.row.user_id) === full.ids.foreign));
      await all.exec("set request.jwt.claims='{}'");
      await assert.rejects(all.query('select public.cap_sync_snapshot_v1()'), /AUTH_REQUIRED/);
      await all.exec("set request.jwt.claims='{\"sub\":\"not-a-uuid\"}'");
      await assert.rejects(all.query('select public.cap_sync_snapshot_v1()'), /SNAPSHOT_FAILED/);
      await all.exec('reset role');
    });
    await check('identity body drift fails global readiness closed', async () => {
      await all.exec("begin;create or replace function public.cap_request_uid() returns uuid language sql stable security invoker set search_path=pg_catalog as $$select null::uuid$$;");
      assert.equal(await scalar(all, 'select public.cap_request_identity_ok() v'), false);
      await all.exec('rollback');
    });
    await check('mixed deployment with a managed-auth policy fails readiness', async () => {
      await all.exec(`begin;alter policy transaction_writer_account_read on public.accounts
        using(user_id=auth.uid());`);
      await user(all, full.ids.owner);
      assert.equal((await scalar(all, 'select public.cap_verify_production_sync_v1() v')).ready, false);
      await all.exec('reset role;rollback');
    });
    await check('identity metadata or client execution grant drift fails closed', async () => {
      await all.exec('begin;grant execute on function public.cap_request_uid() to authenticated');
      await user(all, full.ids.owner);
      assert.equal((await scalar(all, 'select public.cap_verify_production_sync_v1() v')).ready, false);
      await all.exec('reset role;rollback');
    });
    await check('browser roles cannot call identity helper or checker', async () => {
      await user(all, full.ids.owner);
      await assert.rejects(all.query('select public.cap_request_uid()'), /permission denied/);
      await assert.rejects(all.query('select public.cap_request_identity_ok()'), /permission denied/);
    });
  } finally { await all.close(); }
  console.log(`PASS: ${checks} managed-auth-denial and in-place identity repair checks; isolated PGlite only`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
