/* REAL PostgreSQL 17 dependency-ordered production cutover checks. Creates its
   OWN network-none, tmpfs-only Docker cluster; accepts no database URL or
   container target. Never uses a production connection, host port, app profile,
   baseline or outbox.
   Explicit opt-in: CAP_CUTOVER_RACE_ACK=CREATE_DISPOSABLE_DOCKER_ONLY. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const f = require('../helpers/production-cutover-fixture.cjs');
const txf = require('../helpers/transaction-create-fixture.cjs');
const ACK = 'CREATE_DISPOSABLE_DOCKER_ONLY';
const validName = n => /^cap-cutover-lab-[a-f0-9]{12}$/.test(n);
const validDatabase = n => /^cap_cutover_[a-f0-9]{12}$/.test(n);
function validateInvocation(env = process.env) {
  if (env.CAP_CUTOVER_RACE_ACK !== ACK || env.CAP_CUTOVER_RACE_URL || env.CAP_CUTOVER_RACE_CONTAINER)
    throw Error('FRESH_DISPOSABLE_DOCKER_ONLY');
}
function docker(args, options = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000, windowsHide: true, ...options });
  if (r.error || r.status !== 0) throw Error('DISPOSABLE_DOCKER_COMMAND_FAILED');
  return r.stdout.trim();
}
class Session {
  constructor(name, database) {
    if (!validName(name) || !validDatabase(database)) throw Error('INVALID_DISPOSABLE_TARGET');
    this.buffer = ''; this.pending = null; this.closed = false; this.stderr = '';
    this.child = spawn('docker', ['exec', '-i', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
      '-U', 'postgres', '-d', database], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
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
    // Server messages are captured but never printed: only fixed error codes
    // are asserted, so no SQL body, row value or financial detail can leak.
    this.child.stderr.on('data', chunk => {
      if (this.stderr.length < 65536) this.stderr += chunk;
    });
    this.child.on('error', () => this.fail());
    this.child.on('close', () => { this.closed = true; this.fail(); });
  }
  fail() {
    if (this.pending) {
      const p = this.pending; this.pending = null; clearTimeout(p.timeout);
      p.reject(Error('DISPOSABLE_SQL_SESSION_FAILED'));
    }
  }
  hasFixedToken(token) {
    return this.stderr.toUpperCase().includes(String(token).toUpperCase());
  }
  query(sql) {
    if (this.pending || this.closed) throw Error('DISPOSABLE_SESSION_NOT_IDLE');
    return new Promise((resolve, reject) => {
      const marker = 'CAP_DONE_' + randomBytes(10).toString('hex');
      const timeout = setTimeout(() => { this.fail(); this.child.kill(); }, 30000);
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
  const name = 'cap-cutover-lab-' + suffix, database = 'cap_cutover_' + suffix;
  const label = 'cap.production-cutover-test=' + suffix;
  let owned = false, stage = 'CREATE', checks = 0;
  const sessions = [];
  const open = async (owner = null, container = name) => {
    const s = new Session(container, database); sessions.push(s);
    await s.query("set statement_timeout='30s';set lock_timeout='10s';set idle_in_transaction_session_timeout='30s';set timezone='UTC';");
    if (owner === 'anon') await s.query('set role anon;');
    else if (owner) await s.query(`set role authenticated;set request.jwt.claim.sub='${owner}';`);
    return s;
  };
  const expectFailure = async (sql, token) => {
    const s = await open();
    let failed = false;
    try { await s.query(sql); }
    catch (_) { failed = true; }
    assert.equal(failed, true, 'EXPECTED_SQL_FAILURE');
    assert.equal(s.hasFixedToken(token), true, 'EXPECTED_FIXED_ERROR_CODE');
    await s.close();
    checks++;
  };
  try {
    try {
      docker(['create', '--pull', 'never', '--name', name, '--label', label, '--network', 'none',
        '--tmpfs', '/var/lib/postgresql/data:rw', '-e', 'POSTGRES_PASSWORD=' + randomBytes(24).toString('hex'),
        '-e', 'POSTGRES_DB=' + database, 'postgres:17'], { timeout: 60000 });
    } catch (_) {
      const created = JSON.parse(docker(['inspect', name]))[0];
      if (created.Config.Labels['cap.production-cutover-test'] !== suffix)
        throw Error('DISPOSABLE_CREATION_FAILED');
    }
    owned = true; stage = 'START';
    try { docker(['start', name], { timeout: 60000 }); }
    catch (_) { if (!JSON.parse(docker(['inspect', name]))[0].State.Running) throw Error('DISPOSABLE_START_FAILED'); }
    stage = 'WAIT_FOR_FINAL_POSTGRES';
    // Wait with psql, not pg_isready: initdb briefly runs a temporary server
    // that does not know the target database yet.
    const deadline = Date.now() + 180000;
    while (true) {
      const ready = spawnSync('docker', ['exec', name, 'psql', '-X', '-qAt', '-U', 'postgres',
        '-d', database, '-c', 'select 1'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      if (ready.status === 0 && ready.stdout.trim() === '1') break;
      if (Date.now() > deadline) throw Error('DISPOSABLE_POSTGRES_NOT_READY');
      await new Promise(r => setTimeout(r, 500));
    }
    stage = 'ISOLATION_INSPECTION';
    const inspection = JSON.parse(docker(['inspect', name]))[0];
    assert.equal(inspection.Config.Labels['cap.production-cutover-test'], suffix);
    assert.equal(inspection.HostConfig.NetworkMode, 'none');
    assert.equal(Object.keys(inspection.HostConfig.PortBindings || {}).length, 0);
    assert.equal((inspection.Mounts || []).some(m => m.Type === 'bind' || m.Type === 'volume'), false);
    checks++;

    const admin = await open();
    stage = 'SERVER_VERSION';
    const server = await admin.json("select json_build_object('version',current_setting('server_version'),'database',current_database());");
    assert.ok(server.version.startsWith('17.')); assert.equal(server.database, database); checks++;

    stage = 'NOTES_SIDECAR_INSTALL';
    // The fixture installs the real prepared notes sidecar draft and seeds
    // synthetic rows only, then the lifecycle rows are removed so the cutover
    // has to backfill them itself.
    await admin.query(f.setupSql());
    await admin.query('delete from cap_notes_private.note_lifecycle;');
    checks++;

    stage = 'CUTOVER_GUARD_FAILURE';
    await expectFailure(f.cutoverDraft, 'PRODUCTION_CUTOVER_NOT_APPROVED');

    stage = 'CUTOVER_DEPENDENCY_FAILURE';
    await expectFailure(f.cutoverSql, 'PRODUCTION_CUTOVER_DEPENDENCIES_REQUIRED');

    stage = 'TRANSACTION_AND_SNAPSHOT_INSTALL';
    await admin.query(f.transactionInstallSql);
    await admin.query(f.snapshotInstallSql);
    assert.equal(await admin.query("select bool_or(has_schema_privilege(rolname,'auth','USAGE')) from pg_roles where rolname in ('cap_notes_sidecar_writer','cap_transaction_writer','cap_sync_reader');"), 'f');
    checks++;

    stage = 'PRE_CUTOVER_STATE';
    const owner = await open(f.ids.owner), foreign = await open(f.ids.foreign), anon = await open('anon');
    const readiness = s => s.json('select public.cap_verify_production_sync_v1();');
    const pre = await readiness(owner);
    assert.equal(pre.ready, false);
    assert.equal(pre.checks.rpc_only_reads, false);
    assert.equal(pre.checks.notes_sidecar, false);
    assert.equal(pre.checks.snapshot_contract, true);
    assert.equal((await owner.query('select count(*) from public.notes;')), '1');
    assert.equal((await admin.query("select count(*) from pg_policy p where exists(select 1 from pg_roles r where r.rolname in ('anon','authenticated') and r.oid=any(p.polroles));")), '13');
    checks++;

    stage = 'CUTOVER_ROLLBACK_ON_FAILURE';
    const failingCutover = f.cutoverSql.replace(/commit;\s*$/, '') +
      "\ndo $$ begin raise exception 'CUTOVER_TEST_ROLLBACK'; end $$;";
    await expectFailure(failingCutover, 'CUTOVER_TEST_ROLLBACK');
    assert.equal((await admin.query('select count(*) from cap_notes_private.note_lifecycle;')), '0');
    assert.equal((await admin.query("select has_table_privilege('authenticated','public.notes','SELECT');")), 't');
    assert.equal((await admin.query("select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname='notes' and p.polname='own_rows';")), '1');
    checks++;

    stage = 'APP_ROW_INVARIANT_BEFORE_CUTOVER';
    const appState = async () => admin.json(`select jsonb_build_object(
      'notes',(select count(*) from public.notes),
      'accounts',(select count(*) from public.accounts),
      'transactions',(select count(*) from public.transactions),
      'lifecycle',(select count(*) from cap_notes_private.note_lifecycle),
      'operations',(select count(*) from cap_notes_private.operations),
      'receipts',(select count(*) from cap_sync_private.transaction_create_receipts));`);
    const beforeCutover = await appState();
    assert.equal(beforeCutover.lifecycle, 0);
    checks++;

    stage = 'FULL_ORDER_CUTOVER';
    await admin.query(f.cutoverSql);
    checks++;

    stage = 'POST_CUTOVER_BACKFILL';
    const afterCutover = await appState();
    assert.equal(afterCutover.lifecycle, 2);
    assert.equal(afterCutover.notes, beforeCutover.notes);
    assert.equal(afterCutover.accounts, beforeCutover.accounts);
    assert.equal(afterCutover.transactions, beforeCutover.transactions);
    assert.equal(afterCutover.operations, 0);
    assert.equal(afterCutover.receipts, 0);
    checks++;

    stage = 'POST_CUTOVER_READINESS';
    const post = await readiness(owner);
    assert.equal(post.ready, true, JSON.stringify(post.checks));
    assert.equal(post.legacy_lockout, true);
    assert.equal(post.private_sidecar, true);
    assert.equal(post.rpc_only_reads, true);
    assert.equal(post.writer_bypassrls, false);
    assert.equal(post.atomic_transaction_create, true);
    assert.equal(post.durable_operation_receipts, true);
    assert.deepEqual(Object.keys(post.checks).sort(), ['snapshot_contract', 'snapshot_read_access',
      'readiness_contract', 'transaction_create_contract', 'durable_receipts', 'notes_receipts',
      'notes_sidecar', 'rpc_only_reads', 'legacy_lockout', 'writer_privileges',
      'service_role_private'].sort());
    assert.deepEqual(post.contracts, { readiness: 'CAP_PRODUCTION_SYNC_READINESS_V1',
      snapshot: 'CAP_SYNC_SNAPSHOT_V1', transaction_create: 'CAP_TX_CREATE_CAS_RECEIPT_V1',
      notes_change: 'CAP_NOTES_SIDECAR_V1' });
    const notesContract = await owner.json('select public.cap_verify_notes_lifecycle();');
    assert.equal(notesContract.contract_ready, true, JSON.stringify(notesContract));
    assert.equal(notesContract.ready, false);
    assert.equal(notesContract.production_ready, false);
    assert.equal((await readiness(foreign)).ready, true);
    checks++;

    stage = 'POST_CUTOVER_DIRECT_ACCESS_REVOKED';
    assert.equal((await admin.query("select has_table_privilege('authenticated','public.notes','SELECT');")), 'f');
    assert.equal((await admin.query("select has_table_privilege('authenticated','public.accounts','UPDATE');")), 'f');
    assert.equal((await admin.query("select has_table_privilege('anon','public.transactions','SELECT');")), 'f');
    assert.equal((await admin.query("select has_schema_privilege('authenticated','cap_notes_private','USAGE');")), 'f');
    assert.equal((await admin.query("select has_schema_privilege('authenticated','cap_sync_private','USAGE');")), 'f');
    assert.equal((await admin.query("select has_table_privilege('service_role','cap_notes_private.note_lifecycle','SELECT');")), 'f');
    assert.equal((await admin.query("select count(*) from pg_class c, lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.relname in ('notes','accounts','transactions') and a.grantee=0;")), '0');
    assert.equal((await admin.query("select count(*) from pg_policy p where 0=any(p.polroles) or exists(select 1 from pg_roles r where r.rolname in ('anon','authenticated') and r.oid=any(p.polroles));")), '0');
    assert.equal((await admin.query("select to_regprocedure('public.cap_sync_note_put(uuid,jsonb,jsonb)') is null and to_regprocedure('public.cap_verify_notes_rpc()') is null and to_regprocedure('public.cap_verify_transaction_rpc()') is null;")), 't');
    assert.equal((await admin.query("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'cap\\_test\\_%';")), '0');
    checks++;

    stage = 'OLD_CLIENT_BYPASS_DENIED';
    // Each denied path runs in its own short-lived session so the fixed error
    // code is observed directly instead of inferring it from a dead session.
    const denied = async (role, sql, token) => {
      const s = await open(role);
      let failed = false;
      try { await s.query(sql); } catch (_) { failed = true; }
      assert.equal(failed, true, 'OLD_CLIENT_PATH_MUST_FAIL');
      assert.equal(s.hasFixedToken(token), true, 'OLD_CLIENT_ERROR_CODE');
      await s.close();
      checks++;
    };
    await denied(f.ids.owner, 'select count(*) from public.notes;', 'permission denied');
    await denied(f.ids.owner, "insert into public.notes(id,user_id,legacy_id,title,body) values('11111111-1111-4111-8111-111111111111','" + f.ids.owner + "','x','x','x');", 'permission denied');
    await denied(f.ids.owner, 'update public.accounts set balance=0;', 'permission denied');
    await denied(f.ids.owner, 'delete from public.transactions;', 'permission denied');
    await denied(f.ids.owner, 'select count(*) from cap_notes_private.note_lifecycle;', 'permission denied');
    await denied(f.ids.owner, 'select count(*) from cap_notes_private.operations;', 'permission denied');
    await denied(f.ids.owner, 'select count(*) from cap_sync_private.transaction_create_receipts;', 'permission denied');
    await denied(f.ids.owner, 'select public.cap_sync_note_put(null,null,null);', 'does not exist');
    await denied(f.ids.owner, 'select public.cap_verify_notes_rpc();', 'does not exist');
    await denied(f.ids.owner, 'select public.cap_verify_transaction_rpc();', 'does not exist');
    await denied('anon', 'select public.cap_sync_snapshot_v1();', 'permission denied');
    await denied('anon', 'select public.cap_verify_production_sync_v1();', 'permission denied');
    await denied('anon', 'select public.cap_notes_read(null);', 'permission denied');
    await denied('anon', 'select count(*) from public.notes;', 'permission denied');

    stage = 'REVIEWED_RPCS_STILL_WORK';
    const snap = await owner.json('select public.cap_sync_snapshot_v1();');
    assert.equal(snap.version, 'CAP_SYNC_SNAPSHOT_V1');
    assert.equal(snap.owner, f.ids.owner);
    assert.equal(snap.complete, true);
    assert.equal(snap.record_count, 15);
    const read = await owner.json("select public.cap_notes_read('" + f.ids.note + "'::uuid);");
    assert.equal(read.content.legacy_id, '208');
    const created = await owner.json(`select public.cap_notes_change(
      '${f.uuid(7000)}'::uuid,null,'create',
      '{"legacy_id":"cutover-created","title":"Cutover created","body":"after cutover","note_date":"2026-10-21"}'::jsonb,
      '${f.uuid(7001)}'::uuid);`);
    assert.equal(created.status, 'APPLIED');
    const expected = await admin.json("select to_jsonb(a) from public.accounts a where id='" + f.ids.cash + "';");
    const tx = txf.transaction(8000, { account_id: f.ids.cash });
    const applied = await owner.json(`select public.cap_sync_transaction_create(
      '${f.uuid(8001)}'::uuid,'${JSON.stringify(tx).replace(/'/g, "''")}'::jsonb,
      '${JSON.stringify(expected).replace(/'/g, "''")}'::jsonb);`);
    assert.equal(applied.status, 'APPLIED');
    assert.equal(Number(await admin.json("select balance from public.accounts where id='" + f.ids.cash + "';")), 95);
    assert.equal(Number(await admin.json('select count(*) from cap_sync_private.transaction_create_receipts;')), 1);
    assert.equal((await readiness(owner)).ready, true);
    checks++;

    stage = 'CUTOVER_RERUN_IS_SAFE';
    await admin.query(f.cutoverSql);
    assert.equal((await readiness(owner)).ready, true);
    await denied(f.ids.owner, 'select count(*) from public.notes;', 'permission denied');
    assert.equal(Number(await admin.json('select count(*) from cap_notes_private.note_lifecycle;')), 3);
    checks++;

    console.log(`PASS: ${checks} real PostgreSQL 17 production-cutover checks; full dependency order, rollback and old-client bypass denial; fresh network-none Docker only`);
    return { checks };
  } catch (e) {
    throw Error('DISPOSABLE_CUTOVER_TEST_FAILED_AT_' + stage +
      (process.env.CAP_CUTOVER_DEBUG ? ':' + e.message : ''));
  }
  finally {
    await Promise.all(sessions.map(s => s.close().catch(() => {})));
    if (owned) {
      const inspection = JSON.parse(docker(['inspect', name]))[0];
      if (!validName(name) || inspection.Config.Labels['cap.production-cutover-test'] !== suffix)
        throw Error('DISPOSABLE_CLEANUP_GUARD_FAILED');
      docker(['rm', '--force', name]);
    }
  }
}
module.exports = { validateInvocation, validName, Session };
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
