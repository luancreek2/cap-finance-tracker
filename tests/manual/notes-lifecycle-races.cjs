/* OPTIONAL REAL POSTGRES HARNESS — fresh disposable local cluster only.
   No Supabase endpoints, automatic package installs, app database resets, or
   cleanup DROP statements. See NOTES_LIFECYCLE_RACES.md before execution. */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const ACK = 'DISPOSABLE_LOCAL_CLUSTER_ONLY';
function validateTarget(connectionString, acknowledgement) {
  try {
    if (acknowledgement !== ACK || typeof connectionString !== 'string') throw Error();
    const u = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['127.0.0.1', '[::1]'].includes(u.hostname) ||
        !u.username || u.search || u.hash || !/^\/cap_notes_race_lab_[0-9a-f]{12}$/.test(u.pathname) ||
        u.port && (!/^\d+$/.test(u.port) || Number(u.port) < 1 || Number(u.port) > 65535)) throw Error();
    return { connectionString, database: u.pathname.slice(1) };
  } catch (_) { throw Error('DISPOSABLE_LOCAL_POSTGRES_REQUIRED'); }
}
const ids = { a: '00000000-0000-4000-8000-000000000001', b: '00000000-0000-4000-8000-000000000002' };
const base = { legacy_id: 'synthetic-race-note', title: 'Synthetic', body: 'baseline', note_date: '2026-10-21' };
let serial = 100;
const uuid = () => '00000000-0000-4000-8000-' + String(serial++).padStart(12, '0');
const envelope = r => ({ content: Object.fromEntries(['legacy_id', 'title', 'body', 'note_date'].map(k => [k, r.row[k]])), lifecycle: r.lifecycle });
async function main(env = process.env) {
  const target = validateTarget(env.CAP_NOTES_RACE_URL, env.CAP_NOTES_RACE_ACK);
  // Optional dependency stays external to this dependency-free static app.
  const { Client } = require(env.CAP_PG_PATH || 'pg');
  const clients = [], database = target.database; let stage = 'CONNECT', checks = 0, observedLockWaits = 0, connectionFailed = false;
  const connect = async () => {
    const c = new Client({ connectionString: target.connectionString, connectionTimeoutMillis: 5000,
      application_name: 'cap-notes-disposable-race-lab' });
    c.on('error', () => { connectionFailed = true; }); // Do not emit raw driver errors/credentials.
    clients.push(c); await c.connect();
    await c.query("set statement_timeout='8s'; set lock_timeout='6s'; set idle_in_transaction_session_timeout='15s'");
    return c;
  };
  try {
    const admin = await connect(); stage = 'EMPTY_CLUSTER_GUARD';
    const posture = (await admin.query(`select current_database() as db,
      (select rolsuper from pg_roles where rolname=current_user) as privileged,
      (select count(*)::int from pg_roles where rolname in ('authenticated','anon','cap_notes_lab_writer')) as reserved_roles,
      (select count(*)::int from pg_roles where rolname not like 'pg_%' and rolname not in (current_user,'postgres')) as extra_roles,
      (select count(*)::int from pg_database where not datistemplate and datname not in (current_database(),'postgres')) as extra_databases,
      (select count(*)::int from pg_namespace where nspname in ('auth','cap_notes_lab')) as reserved_schemas,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname not like 'pg_%' and n.nspname<>'information_schema' and c.relkind in ('r','p','v','m','S','f')) as relations`)).rows[0];
    if (posture.db !== database || posture.privileged !== true || posture.reserved_roles !== 0 ||
        posture.extra_roles !== 0 || posture.extra_databases !== 0 || posture.reserved_schemas !== 0 || posture.relations !== 0)
      throw Error('FRESH_DISPOSABLE_CLUSTER_REQUIRED');
    stage = 'LAB_SETUP';
    await admin.query(`create role authenticated; create role anon; create schema auth;
      create table auth.users(id uuid primary key); insert into auth.users values ('${ids.a}'),('${ids.b}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to authenticated,anon;
      select set_config('cap.notes_lifecycle_lab','isolated-tests-only',false)`);
    await admin.query(fs.readFileSync(path.join(__dirname, '../sql/notes-lifecycle-lab.sql'), 'utf8'));
    const a = await connect(), b = await connect();
    for (const c of [a, b]) {
      await c.query('set role authenticated'); await c.query("select set_config('request.jwt.claim.sub',$1,false)", [ids.a]);
    }
    const pids = await Promise.all([admin, a, b].map(async c => (await c.query('select pg_backend_pid() as pid')).rows[0].pid));
    assert.equal(new Set(pids).size, 3, 'Independent backends required');
    const readiness = (await a.query('select cap_notes_lab.verify_contract() as v')).rows[0].v;
    assert.equal(readiness.isolated_ready, true); assert.equal(readiness.ready, false); checks++;
    const read = async (c, id) => (await c.query('select cap_notes_lab.note_read($1::uuid) as v', [id])).rows[0].v;
    const change = async (c, request) => (await c.query(
      'select cap_notes_lab.note_change($1::uuid,$2::jsonb,$3::text,$4::jsonb,$5::uuid) as v',
      [request.id, JSON.stringify(request.expected), request.action, request.desired ? JSON.stringify(request.desired) : null, request.operation])).rows[0].v;
    const seed = async () => {
      const id = uuid(); await admin.query('insert into cap_notes_lab.notes(id,user_id,legacy_id,title,body,note_date) values($1,$2,$3,$4,$5,$6)',
        [id, ids.a, base.legacy_id, base.title, base.body, base.note_date]); return id;
    };
    async function contended(label, { first = 'edit', second = 'tombstone', rollback = false, sameOperation = false,
      differentNote = false, isolation = 'READ COMMITTED', expectedError = null } = {}) {
      stage = label;
      const firstId = await seed(), secondId = differentNote ? await seed() : firstId;
      const initialA = envelope(await read(a, firstId)), initialB = envelope(await read(b, secondId));
      const firstOp = uuid(), secondOp = sameOperation ? firstOp : uuid();
      const requestA = { id: firstId, expected: initialA, action: first, desired: first === 'edit' ? { ...base, body: 'edit-winner' } : null, operation: firstOp };
      const requestB = { id: secondId, expected: initialB, action: second, desired: second === 'edit' ? { ...base, body: sameOperation ? 'edit-winner' : 'edit-contender' } : null, operation: secondOp };
      let pending = null;
      try {
        await a.query('begin'); await b.query('begin isolation level ' + isolation);
        if (isolation !== 'READ COMMITTED') await read(b, secondId); // Pin a real older snapshot.
        assert.equal((await change(a, requestA)).status, 'APPLIED');
        let settled = false;
        pending = change(b, requestB).then(value => { settled = true; return { ok: true, value }; }, error => {
          settled = true; return { ok: false, code: error.code, fixedReuse: error.message === 'OPERATION_REUSE_CONFLICT' };
        });
        const deadline = Date.now() + 4000; let blocked = false;
        while (Date.now() < deadline && !settled) {
          blocked = (await admin.query('select $1::int = any(pg_blocking_pids($2::int)) as waiting', [pids[1], pids[2]])).rows[0].waiting;
          if (blocked) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(blocked, true, 'A real backend lock wait must be observed');
        observedLockWaits++;
        // Observer must not see A's uncommitted update or B's tentative update.
        assert.equal(Number((await admin.query('select revision from cap_notes_lab.notes where id=$1', [firstId])).rows[0].revision), 1);
        await a.query(rollback ? 'rollback' : 'commit');
        const outcome = await pending;
        if (expectedError) {
          assert.equal(outcome.ok, false); assert.equal(outcome.code, expectedError);
          if (expectedError === 'P0001') assert.equal(outcome.fixedReuse, true);
          await b.query('rollback');
        } else {
          assert.equal(outcome.ok, true);
          assert.equal(outcome.value.status, rollback ? 'APPLIED' : sameOperation ? 'ALREADY_APPLIED' : 'CONFLICT');
          await b.query('commit');
        }
        const afterA = envelope(await read(a, firstId)), afterB = envelope(await read(b, secondId));
        const winner = rollback ? second : first;
        assert.equal(afterA.lifecycle.revision, 2);
        assert.equal(afterA.lifecycle.deleted_at !== null, winner === 'tombstone');
        assert.equal(afterA.content.body, winner === 'tombstone' ? base.body : 'edit-winner');
        if (differentNote) assert.deepEqual(afterB, initialB, 'Losing cross-note update must roll back');
        const count = Number((await admin.query('select count(*) as n from cap_notes_lab.operations where note_id=any($1::uuid[])', [[firstId, secondId]])).rows[0].n);
        assert.equal(count, 1); checks++;
      } finally {
        // Release the blocker first. Every pending query has an attached error
        // handler and server timeout, preventing unhandled rejection/hung locks.
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
    await contended('CROSS_NOTE_OPERATION_COLLISION', { first: 'edit', second: 'edit', sameOperation: true, differentNote: true, expectedError: 'P0001' });
    await contended('REPEATABLE_READ_ABORTS_STALE_SNAPSHOT', { first: 'tombstone', second: 'edit', isolation: 'REPEATABLE READ', expectedError: '40001' });
    await contended('SERIALIZABLE_ABORTS_STALE_SNAPSHOT', { first: 'tombstone', second: 'edit', isolation: 'SERIALIZABLE', expectedError: '40001' });
    stage = 'DIRECT_WRITER_DENIED_DURING_LOCK';
    const id = await seed(); await a.query('begin');
    try {
      await change(a, { id, expected: envelope(await read(a, id)), action: 'tombstone', operation: uuid() });
      await assert.rejects(b.query('update cap_notes_lab.notes set body=$1 where id=$2', ['bypass', id]), e => e.code === '42501');
      await assert.rejects(b.query('delete from cap_notes_lab.notes where id=$1', [id]), e => e.code === '42501');
      await a.query('commit'); assert.equal((await read(b, id)).lifecycle.revision, 2); checks++;
    } finally { await a.query('rollback').catch(() => {}); }
    assert.equal(connectionFailed, false, 'All backend connections must remain healthy');
    assert.equal(observedLockWaits, 8, 'Every contention scenario must have observed a real backend wait');
    return { passed: true, checks, independentBackends: 3, observedLockWaits, realLockWaitsRequired: true,
      productionReady: false, status: 'DISPOSABLE POSTGRES RACES PASSED — NOT PRODUCTION ENABLEMENT' };
  } catch (_) {
    // Never emit connection strings, credentials, raw SQL errors, row content,
    // user/record UUIDs, or PostgreSQL DETAIL fields.
    throw Error('DISPOSABLE RACE CHECK FAILED — ' + stage + '; REVIEW REQUIRED, NO AUTOMATIC RERUN');
  } finally { await Promise.allSettled(clients.map(c => c.end())); }
}
module.exports = { validateTarget, main };
if (require.main === module) main().then(report => console.log(JSON.stringify(report))).catch(() => {
  console.error('BLOCKED/FAILED — disposable race harness did not complete; no production readiness claimed'); process.exitCode = 1;
});
