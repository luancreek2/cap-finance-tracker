/* REAL PostgreSQL 17 snapshot/readiness checks. Creates its OWN network-none,
   tmpfs-only Docker cluster; accepts no database URL/container target. Never
   uses a production connection, host port, app profile, baseline or outbox.
   Explicit opt-in: CAP_SNAPSHOT_RACE_ACK=CREATE_DISPOSABLE_DOCKER_ONLY. */
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const f = require('../helpers/production-snapshot-fixture.cjs');
const { transaction, callSql } = require('../helpers/transaction-create-fixture.cjs');
const ACK = 'CREATE_DISPOSABLE_DOCKER_ONLY';
const validName = n => /^cap-snapshot-lab-[a-f0-9]{12}$/.test(n);
function validateInvocation(env = process.env) {
  if (env.CAP_SNAPSHOT_RACE_ACK !== ACK || env.CAP_SNAPSHOT_RACE_URL || env.CAP_SNAPSHOT_RACE_CONTAINER)
    throw Error('FRESH_DISPOSABLE_DOCKER_ONLY');
}
function docker(args, options = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000, windowsHide: true, ...options });
  if (r.error || r.status !== 0) throw Error('DISPOSABLE_DOCKER_COMMAND_FAILED');
  return r.stdout.trim();
}
class Session {
  constructor(name, database) {
    if (!validName(name) || !/^cap_snapshot_[a-f0-9]{12}$/.test(database))
      throw Error('INVALID_DISPOSABLE_TARGET');
    this.buffer = ''; this.pending = null; this.closed = false;
    this.child = spawn('docker', ['exec', '-i', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
      '-U', 'postgres', '-d', database], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      while (this.buffer.includes('\n')) {
        const end = this.buffer.indexOf('\n'), line = this.buffer.slice(0, end).replace(/\r$/, '');
        this.buffer = this.buffer.slice(end + 1);
        if (!this.pending) continue;
        if (line === this.pending.marker) {
          const p = this.pending; this.pending = null; clearTimeout(p.timeout); p.resolve(p.rows.join('\n'));
        } else this.pending.rows.push(line);
      }
    });
    // Never print SQL/error bodies; only stage labels/fixed errors are reported.
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.fail());
    this.child.on('close', () => { this.closed = true; this.fail(); });
  }
  fail() {
    if (this.pending) { const p = this.pending; this.pending = null; clearTimeout(p.timeout); p.reject(Error('DISPOSABLE_SQL_SESSION_FAILED')); }
  }
  query(sql) {
    if (this.pending || this.closed) throw Error('DISPOSABLE_SESSION_NOT_IDLE');
    return new Promise((resolve, reject) => {
      const marker = 'CAP_DONE_' + randomBytes(10).toString('hex');
      const timeout = setTimeout(() => { this.fail(); this.child.kill(); }, 15000);
      this.pending = { resolve, reject, rows: [], marker, timeout };
      this.child.stdin.write(sql + '\n\\echo ' + marker + '\n');
    });
  }
  async json(sql) { return JSON.parse(await this.query(sql)); }
  async close() {
    if (this.closed) return;
    await new Promise(resolve => {
      const timeout = setTimeout(() => { this.child.kill(); resolve(); }, 2000);
      this.child.once('close', () => { clearTimeout(timeout); resolve(); });
      this.child.stdin.end('\\q\n');
    });
  }
}

async function main(env = process.env) {
  validateInvocation(env);
  const suffix = randomBytes(6).toString('hex');
  const name = 'cap-snapshot-lab-' + suffix, database = 'cap_snapshot_' + suffix;
  const label = 'cap.snapshot-readiness-test=' + suffix;
  let owned = false, stage = 'CREATE', checks = 0, iterations = 0;
  const sessions = [];
  try {
    try {
      docker(['create', '--pull', 'never', '--name', name, '--label', label, '--network', 'none',
        '--tmpfs', '/var/lib/postgresql/data:rw', '-e', 'POSTGRES_PASSWORD=' + randomBytes(24).toString('hex'),
        '-e', 'POSTGRES_DB=' + database, 'postgres:17'], { timeout: 60000 });
    } catch (_) {
      const created = JSON.parse(docker(['inspect', name]))[0];
      if (created.Config.Labels['cap.snapshot-readiness-test'] !== suffix)
        throw Error('DISPOSABLE_CREATION_FAILED');
    }
    owned = true; stage = 'START';
    try { docker(['start', name], { timeout: 60000 }); }
    catch (_) { if (!JSON.parse(docker(['inspect', name]))[0].State.Running) throw Error('DISPOSABLE_START_FAILED'); }
    stage = 'WAIT_FOR_FINAL_POSTGRES';
    const deadline = Date.now() + 180000;
    while (true) {
      const process = spawnSync('docker', ['exec', name, 'cat', '/proc/1/comm'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      const ready = spawnSync('docker', ['exec', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', database, '-c', 'select 1'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      if (process.status === 0 && process.stdout.trim() === 'postgres' && ready.status === 0 && ready.stdout.trim() === '1') break;
      if (Date.now() > deadline) throw Error('DISPOSABLE_POSTGRES_NOT_READY');
      await new Promise(r => setTimeout(r, 100));
    }
    stage = 'ISOLATION_INSPECTION';
    const inspection = JSON.parse(docker(['inspect', name]))[0];
    assert.equal(inspection.Config.Labels['cap.snapshot-readiness-test'], suffix);
    assert.equal(inspection.HostConfig.NetworkMode, 'none');
    assert.equal(Object.keys(inspection.HostConfig.PortBindings || {}).length, 0);
    assert.equal((inspection.Mounts || []).some(m => m.Type === 'bind' || m.Type === 'volume'), false);
    checks++;

    const open = async (owner = null) => {
      const s = new Session(name, database); sessions.push(s);
      await s.query("set statement_timeout='10s';set lock_timeout='8s';set idle_in_transaction_session_timeout='20s';set timezone='UTC';");
      if (owner === 'anon') await s.query('set role anon;');
      else if (owner) await s.query(`set role authenticated;set request.jwt.claim.sub='${owner}';`);
      return s;
    };
    stage = 'OPEN_ADMIN_SESSION';
    const admin = await open();
    const server = await admin.json("select json_build_object('version',current_setting('server_version'),'database',current_database());");
    assert.ok(server.version.startsWith('17.')); assert.equal(server.database, database); checks++;

    stage = 'FIXTURE_INSTALL';
    await admin.query(f.setupSql());
    await admin.query(f.transactionInstallSql);
    await admin.query(f.snapshotInstallSql);
    assert.equal(await admin.query("select bool_or(has_schema_privilege(rolname,'auth','USAGE')) from pg_roles where rolname in ('cap_notes_sidecar_writer','cap_transaction_writer','cap_sync_reader');"), 'f');
    await admin.query(f.lockdownSql());

    stage = 'OPEN_SESSIONS';
    const ownerA = await open(f.ids.owner), ownerB = await open(f.ids.owner);
    const snapA = await open(f.ids.owner), snapB = await open(f.ids.owner);
    const foreign = await open(f.ids.foreign), anon = await open('anon');
    const all = [admin, ownerA, ownerB, snapA, snapB, foreign, anon];
    const pids = await Promise.all(all.map(s => s.query('select pg_backend_pid();')));
    assert.equal(new Set(pids).size, 7); checks++;
    await admin.query(`
      create function public.fixture_bad_snapshot_call() returns jsonb
        language plpgsql security invoker set search_path=pg_catalog as $$
        declare r jsonb;
        begin
          execute 'select public.cap_sync_snapshot_v1($1)' into r using '{}'::jsonb;
          return r;
        exception when others then return jsonb_build_object('error',SQLSTATE,'message',SQLERRM); end $$;
      create function public.fixture_bad_readiness_call() returns jsonb
        language plpgsql security invoker set search_path=pg_catalog as $$
        declare r jsonb;
        begin
          execute 'select public.cap_verify_production_sync_v1($1)' into r using '{}'::jsonb;
          return r;
        exception when others then return jsonb_build_object('error',SQLSTATE,'message',SQLERRM); end $$;
      grant execute on function public.fixture_bad_snapshot_call() to authenticated;
      grant execute on function public.fixture_bad_readiness_call() to authenticated;
    `);

    const readiness = s => s.json('select public.fixture_readiness_call();');
    const snapshot = s => s.json('select public.fixture_snapshot_call();');
    const noteChange = (s, id, expected, action, desired, operation) => s.json(
      `select public.fixture_notes_change('${id}'::uuid,
        ${expected === null ? 'null' : `$cap$${JSON.stringify(expected)}$cap$::jsonb`},
        '${action}',
        ${desired === null ? 'null' : `$cap$${JSON.stringify(desired)}$cap$::jsonb`},
        '${operation}'::uuid);`);
    const expectReady = async (s = ownerA) => {
      const r = await readiness(s);
      assert.equal(r.ready, true, JSON.stringify(r.checks));
      assert.equal(r.private_sidecar, true); assert.equal(r.rpc_only_reads, true);
      assert.equal(r.legacy_lockout, true); assert.equal(r.writer_bypassrls, false);
      assert.equal(r.atomic_transaction_create, true); assert.equal(r.durable_operation_receipts, true);
      assert.deepEqual(Object.keys(r.checks).sort(), ['snapshot_contract', 'snapshot_read_access',
        'readiness_contract', 'transaction_create_contract', 'durable_receipts', 'notes_receipts',
        'notes_sidecar', 'rpc_only_reads', 'legacy_lockout', 'writer_privileges',
        'service_role_private'].sort());
      assert.deepEqual(r.contracts, { readiness: 'CAP_PRODUCTION_SYNC_READINESS_V1',
        snapshot: 'CAP_SYNC_SNAPSHOT_V1', transaction_create: 'CAP_TX_CREATE_CAS_RECEIPT_V1',
        notes_change: 'CAP_NOTES_SIDECAR_V1' });
      checks++; return r;
    };

    stage = 'REAL_SERVER_READINESS';
    await expectReady();
    await expectReady(foreign);
    assert.equal(await admin.query("select has_table_privilege('authenticated','public.accounts','SELECT');"), 'f');
    assert.equal(await admin.query("select has_table_privilege('authenticated','public.notes','UPDATE');"), 'f');
    assert.equal(await admin.query("select has_schema_privilege('authenticated','cap_notes_private','USAGE');"), 'f');
    assert.equal(await admin.query("select has_function_privilege('anon','public.cap_sync_snapshot_v1()','EXECUTE');"), 'f');
    checks++;

    stage = 'REAL_SERVER_SNAPSHOT_SHAPE';
    const ownerSnap = await snapshot(ownerA);
    assert.equal(ownerSnap.version, 'CAP_SYNC_SNAPSHOT_V1'); assert.equal(ownerSnap.owner, f.ids.owner);
    assert.equal(ownerSnap.complete, true); assert.equal(ownerSnap.record_count, 15);
    assert.equal(ownerSnap.records.length, 15);
    assert.deepEqual(ownerSnap.counts, { profiles: 1, user_preferences: 1, categories: 1, accounts: 3,
      goals: 1, debts: 1, bills: 1, account_statements: 1, transactions: 1, transfers: 1,
      bill_payments: 1, budgets: 1, notes: 1 });
    assert.equal(ownerSnap.records.length, Object.values(ownerSnap.counts).reduce((a, b) => a + b, 0));
    assert.ok(ownerSnap.records.every(r => r.entity === 'profiles'
      ? r.row.id === f.ids.owner : r.row.user_id === f.ids.owner));
    const foreignSnap = await snapshot(foreign);
    assert.equal(foreignSnap.owner, f.ids.foreign); assert.equal(foreignSnap.complete, true);
    assert.equal(foreignSnap.record_count, 5); assert.equal(foreignSnap.counts.notes, 1);
    assert.equal(foreignSnap.records.some(r => r.row.id === f.ids.note), false);
    checks++;

    stage = 'REAL_SERVER_UNAUTHORIZED_AND_MALFORMED';
    const anonSnap = await snapshot(anon), anonReady = await readiness(anon);
    assert.equal(anonSnap.error, '42501'); assert.equal(anonReady.error, '42501');
    const badSnap = await ownerA.json('select public.fixture_bad_snapshot_call();');
    const badReady = await ownerA.json('select public.fixture_bad_readiness_call();');
    assert.equal(badSnap.error, '42883'); assert.equal(badReady.error, '42883');
    checks++;

    stage = 'REAL_SERVER_READ_ONLY';
    const stateAll = () => admin.json(`select jsonb_build_object(
      'profiles',(select count(*) from public.profiles),
      'preferences',(select count(*) from public.user_preferences),
      'categories',(select count(*) from public.categories),
      'accounts',(select count(*) from public.accounts),
      'goals',(select count(*) from public.goals),
      'debts',(select count(*) from public.debts),
      'bills',(select count(*) from public.bills),
      'statements',(select count(*) from public.account_statements),
      'transactions',(select count(*) from public.transactions),
      'transfers',(select count(*) from public.transfers),
      'payments',(select count(*) from public.bill_payments),
      'budgets',(select count(*) from public.budgets),
      'notes',(select count(*) from public.notes),
      'lifecycle',(select count(*) from cap_notes_private.note_lifecycle),
      'operations',(select count(*) from cap_notes_private.operations),
      'receipts',(select count(*) from cap_sync_private.transaction_create_receipts));`);
    const before = await stateAll(); await readiness(ownerA); await snapshot(ownerA);
    assert.deepEqual(await stateAll(), before); checks++;

    stage = 'REAL_SERVER_NOTE_CREATE_EDIT_TOMBSTONE_SNAPSHOT';
    const createdNote = f.uuid(4000), createOp = f.uuid(4001), editOp = f.uuid(4002), deleteOp = f.uuid(4003);
    const createdContent = { legacy_id: 'snapshot-created', title: 'Snapshot created',
      body: 'created body', note_date: '2026-10-21' };
    const notesContract = await ownerA.json('select public.cap_verify_notes_lifecycle();');
    assert.equal(notesContract.contract_ready, true); assert.equal(notesContract.ready, false);
    assert.equal(notesContract.production_ready, false);
    assert.equal((await noteChange(ownerA, createdNote, null, 'create', createdContent, createOp)).status, 'APPLIED');
    const afterCreate = await snapshot(ownerA);
    assert.equal(afterCreate.record_count, 16); assert.equal(afterCreate.counts.notes, 2);
    const createdRecord = afterCreate.records.find(r => r.entity === 'notes' && r.row.id === createdNote);
    assert.ok(createdRecord); assert.equal(createdRecord.lifecycle.revision, 1);
    assert.equal(createdRecord.lifecycle.operation_id, createOp); assert.equal(createdRecord.lifecycle.deleted_at, null);
    assert.deepEqual(Object.fromEntries(['legacy_id', 'title', 'body', 'note_date']
      .map(k => [k, createdRecord.row[k]])), createdContent);
    const createdEnvelope = record => ({
      content: Object.fromEntries(['legacy_id', 'title', 'body', 'note_date'].map(k => [k, record.row[k]])),
      lifecycle: record.lifecycle
    });
    const editContent = { ...createdContent, body: 'edited body' };
    assert.equal((await noteChange(ownerA, createdNote, createdEnvelope(createdRecord), 'edit', editContent, editOp)).status, 'APPLIED');
    const afterEdit = await snapshot(ownerA);
    const editedRecord = afterEdit.records.find(r => r.entity === 'notes' && r.row.id === createdNote);
    assert.equal(editedRecord.row.body, 'edited body'); assert.equal(editedRecord.lifecycle.revision, 2);
    assert.equal(editedRecord.lifecycle.operation_id, editOp);
    assert.equal((await noteChange(ownerA, createdNote, createdEnvelope(editedRecord), 'tombstone', null, deleteOp)).status, 'APPLIED');
    const afterDelete = await snapshot(ownerA);
    const deletedRecord = afterDelete.records.find(r => r.entity === 'notes' && r.row.id === createdNote);
    assert.equal(deletedRecord.row.body, 'edited body'); assert.equal(deletedRecord.lifecycle.revision, 3);
    assert.match(deletedRecord.lifecycle.deleted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(deletedRecord.lifecycle.operation_id, deleteOp);
    const foreignAfterNotes = await snapshot(foreign);
    assert.equal(foreignAfterNotes.counts.notes, 1);
    assert.equal(foreignAfterNotes.records.some(r => r.entity === 'notes' && r.row.id === createdNote), false);
    await expectReady(); checks += 5;

    stage = 'REAL_SERVER_INCOMPLETE_SIDECAR';
    await admin.query(`delete from cap_notes_private.note_lifecycle where note_id='${f.ids.note}';`);
    const incomplete = await snapshot(ownerA);
    assert.equal(incomplete.message, 'SNAPSHOT_SIDECAR_INCOMPLETE');
    assert.equal((await readiness(ownerA)).ready, true);
    await admin.query(`insert into cap_notes_private.note_lifecycle(note_id,user_id,revision)
      values('${f.ids.note}','${f.ids.owner}',1);`);
    assert.equal((await snapshot(ownerA)).complete, true); checks++;

    stage = 'REAL_SERVER_CONTRACT_DRIFT';
    await admin.query('alter function public.cap_sync_snapshot_v1() security invoker;');
    const drift = await snapshot(ownerA);
    assert.equal(drift.message, 'SNAPSHOT_CONTRACT_NOT_VERIFIED');
    let drifted = await readiness(ownerA);
    assert.equal(drifted.ready, false); assert.equal(drifted.checks.snapshot_contract, false);
    await admin.query('alter function public.cap_sync_snapshot_v1() security definer;');
    await expectReady(); checks++;

    stage = 'REAL_SERVER_READER_ACCESS_DRIFT';
    await admin.query('revoke select on public.accounts from cap_sync_reader;');
    const denied = await snapshot(ownerA);
    assert.equal(denied.message, 'SNAPSHOT_CONTRACT_NOT_VERIFIED');
    drifted = await readiness(ownerA);
    assert.equal(drifted.ready, false); assert.equal(drifted.checks.snapshot_read_access, false);
    await admin.query('grant select on public.accounts to cap_sync_reader;');
    await expectReady(); checks++;

    stage = 'REAL_SERVER_CONCURRENT_WRITE_SNAPSHOT';
    // Slow the writer transaction just enough that snapshots start while the
    // atomic transaction is committing. A torn multi-statement read would show
    // a transaction without its exact account delta.
    await admin.query(`create function public.fixture_slow_tx() returns trigger
      language plpgsql set search_path=pg_catalog as $$begin perform pg_sleep(0.006);return new;end$$;
      create trigger fixture_slow_tx before insert on public.transactions
      for each row execute function public.fixture_slow_tx();`);
    let serial = 10000;
    const seed = async () => {
      const n = serial++, id = f.uuid(n);
      await admin.query(`insert into public.accounts(id,user_id,legacy_id,name,account_type,balance)
        values('${id}','${f.ids.owner}','${n}','Synthetic snapshot race account','cash',100);`);
      return { id, expected: await admin.json(`select to_jsonb(a) from public.accounts a where id='${id}';`) };
    };
    const checkSnapshot = (s, account) => {
      assert.equal(s.version, 'CAP_SYNC_SNAPSHOT_V1'); assert.equal(s.owner, f.ids.owner);
      assert.equal(s.complete, true); assert.equal(s.records.length, s.record_count);
      assert.equal(Object.keys(s.counts).length, 13);
      assert.equal(Object.values(s.counts).reduce((a, b) => a + b, 0), s.record_count);
      const rows = s.records.filter(r => r.entity === 'accounts' && r.row.id === account.id);
      const txs = s.records.filter(r => r.entity === 'transactions' && r.row.account_id === account.id);
      assert.equal(rows.length, 1);
      const balance = Number(rows[0].row.balance);
      if (balance === 100) assert.equal(txs.length, 0);
      else { assert.equal(balance, 95); assert.equal(txs.length, 1); assert.equal(Number(txs[0].row.amount), -5); }
      assert.equal(new Set(s.records.map(r => r.entity + ':' + (r.row.id || r.row.user_id))).size,
        s.records.length);
      checks++;
    };
    for (let i = 0; i < 24; i++) {
      const account = await seed(), op = f.uuid(serial++);
      const tx = transaction(serial++, { account_id: account.id });
      const [applied, first, second] = await Promise.all([
        ownerB.json(callSql(op, tx, account.expected)),
        snapshot(snapA), snapshot(snapB)
      ]);
      assert.equal(applied.status, 'APPLIED');
      checkSnapshot(first, account); checkSnapshot(second, account);
      const after = await admin.json(`select jsonb_build_object(
        'balance',(select balance from public.accounts where id='${account.id}'),
        'count',(select count(*) from public.transactions where account_id='${account.id}'),
        'receipts',(select count(*) from cap_sync_private.transaction_create_receipts where account_id='${account.id}'));`);
      assert.equal(Number(after.balance), 95); assert.equal(Number(after.count), 1);
      assert.equal(Number(after.receipts), 1); checks++;
      iterations++;
    }
    await expectReady();
    assert.equal((await snapshot(foreign)).records.some(r => r.entity === 'transactions'), false);
    checks++;

    console.log(`PASS: ${checks} real PostgreSQL 17 snapshot/readiness checks; ${iterations} concurrent write/snapshot iterations; fresh network-none Docker only`);
    return { checks, iterations };
  } catch (_) { throw Error('DISPOSABLE_SNAPSHOT_TEST_FAILED_AT_' + stage); }
  finally {
    await Promise.all(sessions.map(s => s.close().catch(() => {})));
    if (owned) {
      const inspection = JSON.parse(docker(['inspect', name]))[0];
      if (!validName(name) || inspection.Config.Labels['cap.snapshot-readiness-test'] !== suffix)
        throw Error('DISPOSABLE_CLEANUP_GUARD_FAILED');
      docker(['rm', '--force', name]);
    }
  }
}
module.exports = { validateInvocation, validName, Session };
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
