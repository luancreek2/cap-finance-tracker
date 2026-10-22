/* OPTIONAL REAL POSTGRES HARNESS — fresh disposable local cluster only.
   No Supabase endpoints, automatic package installs, app database resets, or
   cleanup DROP statements. See NOTES_LIFECYCLE_RACES.md before execution.
   Exercises the guarded production notes-sidecar draft and never deploys it. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const f = require('../helpers/production-notes-fixture.cjs');
const ACK = 'DISPOSABLE_LOCAL_CLUSTER_ONLY';
function validateTarget(connectionString, acknowledgement) {
  try {
    if (acknowledgement !== ACK || typeof connectionString !== 'string') throw Error();
    const u = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['127.0.0.1', '[::1]'].includes(u.hostname) ||
        !u.username || u.search || u.hash || !/^\/cap_notes_prod_race_lab_[0-9a-f]{12}$/.test(u.pathname) ||
        u.port && (!/^\d+$/.test(u.port) || Number(u.port) < 1 || Number(u.port) > 65535)) throw Error();
    return { connectionString, database: u.pathname.slice(1) };
  } catch (_) { throw Error('DISPOSABLE_LOCAL_POSTGRES_REQUIRED'); }
}
const base = { legacy_id: 'synthetic-production-race-note', title: 'Synthetic', body: 'baseline', note_date: '2026-10-21' };
const envelope = r => ({ content: r.content, lifecycle: r.lifecycle });
let serial = 1000;
const uuid = () => f.uuid(serial++);
async function main(env = process.env) {
  const target = validateTarget(env.CAP_NOTES_RACE_URL, env.CAP_NOTES_RACE_ACK);
  // Optional dependency stays external to this dependency-free static app.
  const { Client } = require(env.CAP_PG_PATH || 'pg');
  const clients = [], database = target.database;
  let stage = 'CONNECT', checks = 0, observedLockWaits = 0, connectionFailed = false;
  const connect = async () => {
    const c = new Client({ connectionString: target.connectionString, connectionTimeoutMillis: 5000,
      application_name: 'cap-notes-production-disposable-race-lab' });
    c.on('error', () => { connectionFailed = true; });
    clients.push(c); await c.connect();
    await c.query("set statement_timeout='8s'; set lock_timeout='6s'; set idle_in_transaction_session_timeout='15s'");
    return c;
  };
  try {
    const admin = await connect(); stage = 'EMPTY_CLUSTER_GUARD';
    const posture = (await admin.query(`select current_database() as db,
      (select rolsuper from pg_roles where rolname=current_user) as privileged,
      (select count(*)::int from pg_roles where rolname in ('authenticated','anon','service_role','cap_notes_sidecar_writer')) as reserved_roles,
      (select count(*)::int from pg_roles where rolname not like 'pg_%' and rolname not in (current_user,'postgres')) as extra_roles,
      (select count(*)::int from pg_database where not datistemplate and datname not in (current_database(),'postgres')) as extra_databases,
      (select count(*)::int from pg_namespace where nspname in ('auth','cap_notes_private')) as reserved_schemas,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname not like 'pg_%' and n.nspname<>'information_schema' and c.relkind in ('r','p','v','m','S','f')) as relations`)).rows[0];
    if (posture.db !== database || posture.privileged !== true || posture.reserved_roles !== 0 ||
        posture.extra_roles !== 0 || posture.extra_databases !== 0 || posture.reserved_schemas !== 0 || posture.relations !== 0)
      throw Error('FRESH_DISPOSABLE_CLUSTER_REQUIRED');

    stage = 'PRODUCTION_NOTES_SETUP';
    await admin.query(f.setupSql());
    // Reproduce the installed old dependency, then repair it in place before
    // exercising real overlapping writers. Managed auth USAGE stays denied.
    await admin.query(f.notesInstallSql.replaceAll('public.cap_request_uid','auth.uid')
      .replace('roles_ok := public.cap_request_identity_ok() and exists(', 'roles_ok := exists(')
      .replace('public.cap_role_boundary_ok(writer_oid)',
        'not exists(select 1 from pg_auth_members where roleid=writer_oid or member=writer_oid)'));
    await admin.query(`set role authenticated;set request.jwt.claim.sub='${f.ids.owner}'`);
    await assert.rejects(admin.query('select public.cap_verify_notes_lifecycle()'),
      e => e.code === '42501' && e.message.includes('schema auth'));
    await admin.query("reset role;set cap.notes_identity_repair='reviewed-draft-only'");
    await admin.query(fs.readFileSync(`${__dirname}/../../supabase_production_notes_identity_repair.sql`,'utf8'));
    assert.equal((await admin.query(`select count(*)::int v from pg_proc where oid in (
      'public.cap_notes_read(uuid)'::regprocedure,
      'public.cap_verify_notes_lifecycle()'::regprocedure,
      'public.cap_notes_change(uuid,jsonb,text,jsonb,uuid)'::regprocedure)
      and prosrc like '%auth.uid%'`)).rows[0].v, 0);
    assert.equal((await admin.query(
      "select public.cap_role_boundary_ok('cap_notes_sidecar_writer'::regrole) v")).rows[0].v, true);
    assert.equal((await admin.query("select has_schema_privilege('cap_notes_sidecar_writer','auth','USAGE') v")).rows[0].v, false);
    checks++;
    await admin.query(f.backfillSql);
    await admin.query(f.cutoverSql());

    const a = await connect(), b = await connect();
    for (const c of [a, b]) {
      await c.query('set role authenticated');
      await c.query("select set_config('request.jwt.claim.sub',$1,false)", [f.ids.owner]);
    }
    const pids = await Promise.all([admin, a, b].map(async c => (await c.query('select pg_backend_pid() as pid')).rows[0].pid));
    assert.equal(new Set(pids).size, 3, 'Independent backends required');
    const readiness = (await a.query('select public.cap_verify_notes_lifecycle() as v')).rows[0].v;
    assert.equal(readiness.version, 'CAP_NOTES_SIDECAR_V1');
    assert.equal(readiness.contract_ready, true); assert.equal(readiness.ready, false);
    assert.equal(readiness.production_ready, false); checks++;
    assert.equal((await admin.query("select has_table_privilege('authenticated','public.notes','SELECT') as v")).rows[0].v, false);
    assert.equal((await admin.query("select has_table_privilege('authenticated','public.notes','INSERT') as v")).rows[0].v, false);
    assert.equal((await admin.query("select has_table_privilege('authenticated','public.notes','UPDATE') as v")).rows[0].v, false);
    assert.equal((await admin.query("select has_table_privilege('cap_notes_sidecar_writer','public.notes','INSERT') as v")).rows[0].v, true);
    assert.equal((await admin.query("select has_table_privilege('cap_notes_sidecar_writer','public.notes','DELETE') as v")).rows[0].v, false);
    checks++;

    const read = async (c, id) => (await c.query('select public.cap_notes_read($1::uuid) as v', [id])).rows[0].v;
    const change = async (c, request) => (await c.query(
      'select public.cap_notes_change($1::uuid,$2::jsonb,$3::text,$4::jsonb,$5::uuid) as v',
      [request.id, request.expected === null ? null : JSON.stringify(request.expected),
        request.action, request.desired === null ? null : JSON.stringify(request.desired), request.operation])).rows[0].v;
    const seed = async () => {
      const id = uuid();
      await admin.query('insert into public.notes(id,user_id,legacy_id,title,body,note_date) values($1,$2,$3,$4,$5,$6)',
        [id, f.ids.owner, 'race-' + id.slice(-12), base.title, base.body, base.note_date]);
      await admin.query('insert into cap_notes_private.note_lifecycle(note_id,user_id,revision) values($1,$2,1)',
        [id, f.ids.owner]);
      return id;
    };
    async function observeBlocked(blockedPid, blockerPid) {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const waiting = (await admin.query('select $1::int = any(pg_blocking_pids($2::int)) as waiting',
          [blockerPid, blockedPid])).rows[0].waiting;
        if (waiting) return true;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return false;
    }

    async function contended(label, options = {}) {
      const { first = 'edit', second = 'tombstone', rollback = false, sameOperation = false,
        differentNote = false, expectedError = null } = options;
      stage = label;
      const firstId = await seed(), secondId = differentNote ? await seed() : firstId;
      const initialA = envelope(await read(a, firstId)), initialB = envelope(await read(b, secondId));
      const firstOp = uuid(), secondOp = sameOperation ? firstOp : uuid();
      const requestA = { id: firstId, expected: initialA, action: first,
        desired: first === 'edit' ? { ...base, legacy_id: initialA.content.legacy_id,
          title: initialA.content.title, note_date: initialA.content.note_date, body: 'edit-winner' } : null,
        operation: firstOp };
      const requestB = { id: secondId, expected: initialB, action: second,
        desired: second === 'edit' ? { ...base, legacy_id: initialB.content.legacy_id,
          title: initialB.content.title, note_date: initialB.content.note_date,
          body: sameOperation ? 'edit-winner' : 'edit-contender' } : null,
        operation: secondOp };
      let pending = null;
      try {
        await a.query('begin'); await b.query('begin');
        assert.equal((await change(a, requestA)).status, 'APPLIED');
        pending = change(b, requestB).then(value => ({ ok: true, value }), error => (
          { ok: false, code: error.code, message: error.message }));
        if (!differentNote) {
          const blocked = await observeBlocked(pids[2], pids[1]);
          assert.equal(blocked, true, 'A real backend lock wait must be observed');
          observedLockWaits++;
          assert.equal(Number((await admin.query('select revision from cap_notes_private.note_lifecycle where note_id=$1',
            [firstId])).rows[0].revision), 1);
        }
        await a.query(rollback ? 'rollback' : 'commit');
        const outcome = await pending;
        if (expectedError) {
          assert.equal(outcome.ok, false); assert.equal(outcome.code, expectedError);
          if (expectedError === 'P0001') assert.equal(outcome.message, 'OPERATION_REUSE_CONFLICT');
          await b.query('rollback');
        } else {
          assert.equal(outcome.ok, true);
          assert.equal(outcome.value.status, rollback ? 'APPLIED' : sameOperation ? 'ALREADY_APPLIED' : 'CONFLICT');
          await b.query('commit');
        }
        const afterA = envelope(await read(a, firstId));
        const winner = rollback ? second : first;
        assert.equal(afterA.lifecycle.revision, 2);
        assert.equal(afterA.lifecycle.deleted_at !== null, winner === 'tombstone');
        assert.equal(afterA.content.body, winner === 'tombstone' ? base.body : 'edit-winner');
        if (differentNote) {
          const afterB = envelope(await read(b, secondId));
          assert.deepEqual(afterB, initialB, 'Losing cross-note update must roll back');
          checks++;
        }
        const count = Number((await admin.query(
          'select count(*) as n from cap_notes_private.operations where note_id=any($1::uuid[])',
          [[firstId, secondId]])).rows[0].n);
        assert.equal(count, 1); checks++;
      } finally {
        await a.query('rollback').catch(() => {});
        if (pending) await pending;
        await b.query('rollback').catch(() => {});
      }
    }

    async function createContended(label, options = {}) {
      const { sameOperation = false, rollback = false } = options;
      stage = label;
      const id = uuid(), firstOp = uuid(), secondOp = sameOperation ? firstOp : uuid();
      const desired = { ...base, legacy_id: 'create-race-' + id.slice(-12), body: 'created-winner' };
      let pending = null;
      try {
        await a.query('begin'); await b.query('begin');
        assert.equal((await change(a, { id, expected: null, action: 'create', desired, operation: firstOp })).status, 'APPLIED');
        assert.equal(Number((await admin.query('select count(*) as n from public.notes where id=$1', [id])).rows[0].n), 0);
        pending = change(b, { id, expected: null, action: 'create', desired, operation: secondOp })
          .then(value => ({ ok: true, value }), error => ({ ok: false, code: error.code, message: error.message }));
        const blocked = await observeBlocked(pids[2], pids[1]);
        assert.equal(blocked, true, 'A real backend lock wait must be observed');
        observedLockWaits++;
        await a.query(rollback ? 'rollback' : 'commit');
        const outcome = await pending;
        assert.equal(outcome.ok, true);
        assert.equal(outcome.value.status, rollback ? 'APPLIED' : sameOperation ? 'ALREADY_APPLIED' : 'CONFLICT');
        await b.query('commit');
        const counts = (await admin.query(`select
          (select count(*)::int from public.notes where id=$1) notes,
          (select count(*)::int from cap_notes_private.note_lifecycle where note_id=$1) lifecycles,
          (select count(*)::int from cap_notes_private.operations where note_id=$1) receipts`, [id])).rows[0];
        assert.deepEqual(counts, { notes: 1, lifecycles: 1, receipts: 1 });
        const state = envelope(await read(a, id));
        assert.deepEqual(state.content, desired); assert.equal(state.lifecycle.revision, 1);
        checks++;
      } finally {
        await a.query('rollback').catch(() => {});
        if (pending) await pending;
        await b.query('rollback').catch(() => {});
      }
    }

    await contended('EDIT_WINS_DELETE');
    await contended('DELETE_WINS_EDIT', { first: 'tombstone', second: 'edit' });
    await contended('EXACT_DELETE_RETRY', { first: 'tombstone', second: 'tombstone', sameOperation: true });
    await contended('EXACT_EDIT_RETRY', { first: 'edit', second: 'edit', sameOperation: true });
    await contended('ROLLBACK_RELEASES_DELETE', { first: 'edit', second: 'tombstone', rollback: true });
    await contended('CROSS_NOTE_OPERATION_COLLISION', { first: 'edit', second: 'edit',
      sameOperation: true, differentNote: true, expectedError: 'P0001' });
    await createContended('CREATE_CONFLICT_WINS');
    await createContended('CREATE_EXACT_RETRY', { sameOperation: true });
    await createContended('CREATE_ROLLBACK_RELEASES', { rollback: true });

    stage = 'LOST_RESPONSE_AND_PAYLOAD_MISMATCH';
    const lostCreate = uuid(), lostOp = uuid(), lostDesired = { ...base, legacy_id: 'lost-create', body: 'lost' };
    assert.equal((await change(a, { id: lostCreate, expected: null, action: 'create',
      desired: lostDesired, operation: lostOp })).status, 'APPLIED');
    assert.equal((await change(a, { id: lostCreate, expected: null, action: 'create',
      desired: lostDesired, operation: lostOp })).status, 'ALREADY_APPLIED');
    const lostState = envelope(await read(a, lostCreate));
    const lostEditOp = uuid(), lostEdit = { ...lostDesired, body: 'lost edit' };
    assert.equal((await change(a, { id: lostCreate, expected: lostState, action: 'edit',
      desired: lostEdit, operation: lostEditOp })).status, 'APPLIED');
    const afterLostEdit = envelope(await read(a, lostCreate));
    assert.equal((await change(a, { id: lostCreate, expected: lostState, action: 'edit',
      desired: lostEdit, operation: lostEditOp })).status, 'ALREADY_APPLIED');
    let mismatch = null;
    try {
      await change(a, { id: lostCreate, expected: afterLostEdit, action: 'edit',
        desired: { ...lostEdit, body: 'payload mismatch' }, operation: lostEditOp });
    } catch (e) { mismatch = e; }
    assert.equal(mismatch && mismatch.message, 'OPERATION_REUSE_CONFLICT');
    assert.deepEqual(envelope(await read(a, lostCreate)), afterLostEdit);
    assert.equal((await change(a, { id: lostCreate, expected: null, action: 'create',
      desired: lostDesired, operation: lostOp })).status, 'CONFLICT');
    checks += 3;

    stage = 'DIRECT_WRITER_DENIED_DURING_LOCK';
    const directId = await seed(); await a.query('begin');
    try {
      await change(a, { id: directId, expected: envelope(await read(a, directId)),
        action: 'tombstone', operation: uuid() });
      await assert.rejects(b.query('update public.notes set body=$1 where id=$2', ['bypass', directId]), e => e.code === '42501');
      await assert.rejects(b.query('delete from public.notes where id=$1', [directId]), e => e.code === '42501');
      await assert.rejects(b.query('select * from cap_notes_private.note_lifecycle'), e => e.code === '42501');
      await a.query('commit');
      assert.equal((await read(b, directId)).lifecycle.revision, 2); checks++;
    } finally { await a.query('rollback').catch(() => {}); }

    stage = 'FOREIGN_OWNER_ISOLATION';
    const foreign = await connect();
    await foreign.query('set role authenticated');
    await foreign.query("select set_config('request.jwt.claim.sub',$1,false)", [f.ids.foreign]);
    assert.equal(await read(foreign, lostCreate), null);
    let foreignError = null;
    try {
      await change(foreign, { id: lostCreate, expected: afterLostEdit, action: 'tombstone', operation: uuid() });
    } catch (e) { foreignError = e; }
    assert.equal(foreignError, null, 'Foreign change must return CONFLICT, not expose an error');
    await foreign.end();
    checks++;

    assert.equal(connectionFailed, false, 'All backend connections must remain healthy');
    assert.ok(observedLockWaits >= 8, 'Every contention scenario must have observed a real backend wait');
    return { passed: true, checks, independentBackends: 3, observedLockWaits, realLockWaitsRequired: true,
      productionReady: false, status: 'DISPOSABLE POSTGRES PRODUCTION NOTES RACES PASSED — NOT PRODUCTION ENABLEMENT' };
  } catch (_) {
    throw Error('DISPOSABLE PRODUCTION NOTES RACE CHECK FAILED — ' + stage + '; REVIEW REQUIRED, NO AUTOMATIC RERUN');
  } finally { await Promise.allSettled(clients.map(c => c.end())); }
}
module.exports = { validateTarget, main };
if (require.main === module) main().then(report => console.log(JSON.stringify(report))).catch(() => {
  console.error('BLOCKED/FAILED — disposable production notes race harness did not complete; no production readiness claimed');
  process.exitCode = 1;
});
