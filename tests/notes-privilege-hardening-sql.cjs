/* Disposable PGlite only. No Supabase connection, live SQL, or app data.
   Exercises the prepared pre-migration hardening, platform default-ACL, and
   cutover lockout scripts against a synthetic deployed notes contract. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require(process.env.CAP_PGLITE_PATH || '@electric-sql/pglite');

const hardening = fs.readFileSync(`${__dirname}/../supabase_notes_privilege_hardening.sql`, 'utf8');
const platformAcl = fs.readFileSync(`${__dirname}/../supabase_notes_platform_default_acl.sql`, 'utf8');
const lockout = fs.readFileSync(`${__dirname}/../supabase_notes_legacy_lockout.sql`, 'utf8');
const notesRpc = fs.readFileSync(`${__dirname}/../supabase_production_notes_rpc.sql`, 'utf8');
const auditSql = fs.readFileSync(`${__dirname}/sql/production-privilege-audit.sql`, 'utf8');

const UID = '00000000-0000-4000-8000-000000000001';
const NOTE = '00000000-0000-4000-8000-000000000011';
const expected = { legacy_id: 'hardening-note', title: 'Synthetic', body: 'before', note_date: '2026-10-21' };

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function auditReport(results) {
  const row = results.flatMap(result => result.rows || [])
    .find(candidate => candidate.production_privilege_audit !== undefined);
  assert.ok(row, 'audit must return production_privilege_audit');
  const raw = row.production_privilege_audit;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function codes(report) {
  return report.findings.map(finding => finding.code);
}

(async () => {
  const db = new PGlite();
  let passed = 0;
  const test = async (label, run) => {
    try {
      await run();
      passed++;
    } catch (error) {
      error.message = `${label}: ${error.message}`;
      throw error;
    }
  };
  const as = async (role, sub = '') => {
    await db.exec('reset role');
    await db.exec(`set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [sub]);
  };
  const asPostgres = () => db.exec('reset role');
  const audit = async () => auditReport(await db.exec(auditSql));
  const hasTable = async (role, privilege, table = 'public.notes') =>
    (await db.query('select has_table_privilege($1,$2,$3) as v', [role, table, privilege])).rows[0].v;
  const hasFunction = async (role, signature) =>
    (await db.query('select has_function_privilege($1,$2,$3) as v', [role, signature, 'EXECUTE'])).rows[0].v;

  try {
    await test('hardening and lockout scripts are guarded and separated', async () => {
      const h = stripComments(hardening);
      const p = stripComments(platformAcl);
      const l = stripComments(lockout);
      assert.match(h, /cap\.hardening_approved/);
      assert.match(p, /cap\.platform_acl_approved/);
      assert.match(l, /cap\.lockout_approved/);
      assert.doesNotMatch(h, /drop\s+policy\s+(if\s+exists\s+)?own_rows/i);
      assert.doesNotMatch(h, /drop\s+function\s+(if\s+exists\s+)?public\.cap_sync_note_put/i);
      assert.doesNotMatch(h, /drop\s+function\s+(if\s+exists\s+)?public\.cap_verify_notes_rpc/i);
      assert.match(l, /drop\s+policy\s+if\s+exists\s+own_rows/i);
      assert.match(l, /drop\s+function\s+if\s+exists\s+public\.cap_sync_note_put/i);
      assert.match(l, /drop\s+function\s+if\s+exists\s+public\.cap_verify_notes_rpc/i);
      for (const sql of [h, p, l]) {
        assert.doesNotMatch(sql, /\b(insert\s+into|update\s+public\.|delete\s+from|truncate\s+table|merge\s+into)\b/i);
      }
    });

    await test('synthetic production posture is assembled', async () => {
      await db.exec(`
        create role anon;
        create role authenticated;
        create role service_role bypassrls;
        create role supabase_admin superuser login;
        create role supabase_etl_admin bypassrls;
        create schema auth;
        create table auth.users(id uuid primary key);
        create function auth.uid() returns uuid language sql stable
          as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
        grant usage on schema auth, public to authenticated, anon;
        grant usage on schema public to service_role;

        create table public.notes (
          id uuid primary key default gen_random_uuid(),
          user_id uuid not null references auth.users(id) on delete cascade,
          legacy_id text,
          title text,
          body text,
          note_date date,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique (user_id, id)
        );
        create function public.set_updated_at() returns trigger language plpgsql
          set search_path = public as $$
          begin new.updated_at = now(); return new; end $$;
        create trigger notes_updated_at before update on public.notes
          for each row execute function public.set_updated_at();
        alter table public.notes enable row level security;
        create policy own_rows on public.notes as permissive for all to authenticated
          using (user_id = auth.uid()) with check (user_id = auth.uid());
        grant select, insert, update, delete on public.notes to authenticated;
        grant truncate, references, trigger on public.notes to anon, authenticated;

        create function public.rls_auto_enable() returns void language plpgsql
          security definer set search_path = pg_catalog as $$ begin end $$;
        create function public.cap_test_transaction_create(
          p_transaction_id uuid, p_legacy_id text, p_account_id uuid, p_category_id uuid,
          p_bill_id uuid, p_amount numeric, p_transaction_date date, p_posting_date date,
          p_status text, p_title text, p_description text, p_metadata jsonb default '{}'::jsonb
        ) returns jsonb language sql security invoker set search_path = public as $$ select '{}'::jsonb $$;
        comment on function public.cap_test_transaction_create(uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb)
          is 'CAP_PHASE_6K2A_V1';
        revoke all on function public.cap_test_transaction_create(uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb) from public, anon;
        grant execute on function public.cap_test_transaction_create(uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb) to authenticated;
        create function public.cap_verify_transaction_rpc() returns jsonb language sql
          security definer set search_path = pg_catalog as $$ select '{}'::jsonb $$;
        revoke all on function public.cap_verify_transaction_rpc() from public, anon;
        grant execute on function public.cap_verify_transaction_rpc() to authenticated;

        alter default privileges for role postgres in schema public
          grant all on tables to anon, authenticated;
        alter default privileges for role postgres in schema public
          grant all on sequences to anon, authenticated;
        alter default privileges for role postgres in schema public
          grant all on functions to anon, authenticated;
        alter default privileges for role postgres in schema public
          grant all on types to anon, authenticated;
        alter default privileges for role supabase_admin in schema public
          grant all on tables to anon, authenticated;
        alter default privileges for role supabase_admin in schema public
          grant all on sequences to anon, authenticated;
        alter default privileges for role supabase_admin in schema public
          grant all on functions to anon, authenticated;
        alter default privileges for role supabase_admin in schema public
          grant all on types to anon, authenticated;

        insert into auth.users(id) values ('${UID}');
        insert into public.notes(id,user_id,legacy_id,title,body,note_date)
          values ('${NOTE}','${UID}','${expected.legacy_id}','${expected.title}','${expected.body}','${expected.note_date}');
      `);
      await db.exec(notesRpc);

      const report = await audit();
      const found = codes(report);
      for (const code of ['NOTES_ANON_ANY', 'NOTES_AUTH_DELETE', 'NOTES_AUTH_TRUNCATE',
        'DEFINER_PUBLIC_EXECUTE', 'DEFINER_ANON_EXECUTE', 'TEST_RPC_PRESENT',
        'CLIENT_DEFAULT_PRIVILEGES', 'PUBLIC_DEFAULT_PRIVILEGES', 'UNEXPECTED_PRIVILEGED_ROLE']) {
        assert.ok(found.includes(code), `missing baseline finding ${code}`);
      }
      assert.equal(report.notes.force_rls, false);
      assert.equal(await hasFunction('anon', 'public.rls_auto_enable()'), true);
    });

    await test('hardening refuses to run without the session guard', async () => {
      await assert.rejects(db.exec(hardening), /HARDENING_NOT_APPROVED/);
      await db.exec('rollback');
    });

    await test('app-level hardening applies cleanly', async () => {
      await db.exec("select set_config('cap.hardening_approved','privilege-hardening-only',false)");
      await db.exec(hardening);
    });

    let hardened;
    await test('hardening clears the requested direct and PUBLIC findings while preserving the current app path', async () => {
      hardened = await audit();
      const found = codes(hardened);
      for (const code of ['NOTES_ANON_ANY', 'NOTES_AUTH_DELETE', 'NOTES_AUTH_TRUNCATE',
        'DEFINER_PUBLIC_EXECUTE', 'DEFINER_ANON_EXECUTE', 'TEST_RPC_PRESENT',
        'NOTES_FORCE_RLS_DISABLED']) {
        assert.equal(found.includes(code), false, `unexpected finding ${code}`);
      }
      assert.equal(await hasTable('anon', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false);
      assert.equal(await hasTable('authenticated', 'SELECT'), true);
      assert.equal(await hasTable('authenticated', 'INSERT'), true);
      assert.equal(await hasTable('authenticated', 'UPDATE'), true);
      assert.equal(await hasTable('authenticated', 'DELETE'), false);
      assert.equal(await hasTable('authenticated', 'TRUNCATE'), false);
      assert.equal(await hasTable('authenticated', 'REFERENCES'), false);
      assert.equal(await hasTable('authenticated', 'TRIGGER'), false);
      assert.equal(await hasFunction('anon', 'public.rls_auto_enable()'), false);
      assert.equal(await hasFunction('authenticated', 'public.rls_auto_enable()'), false);
      assert.equal(await hasFunction('anon', 'public.set_updated_at()'), false);
      assert.equal(await hasFunction('authenticated', 'public.set_updated_at()'), false);
      assert.equal((await db.query("select relforcerowsecurity as v from pg_class where oid='public.notes'::regclass")).rows[0].v, true);
    });

    await test('the current notes reader/edit path still works after app-level hardening', async () => {
      await as('authenticated', UID);
      const verify = (await db.query('select public.cap_verify_notes_rpc() as v')).rows[0].v;
      assert.equal(verify.ready, true);
      assert.equal(verify.version, 'CAP_NOTES_CAS_V1');

      const selected = await db.query('select body from public.notes where id=$1', [NOTE]);
      assert.equal(selected.rows[0].body, 'before');
      const before = (await db.query('select updated_at from public.notes where id=$1', [NOTE])).rows[0].updated_at;
      const applied = (await db.query(
        'select public.cap_sync_note_put($1::uuid,$2::jsonb,$3::jsonb) as v',
        [NOTE, expected, { ...expected, body: 'after' }]
      )).rows[0].v;
      assert.deepEqual(applied, { status: 'APPLIED' });
      const after = await db.query('select body, updated_at from public.notes where id=$1', [NOTE]);
      assert.equal(after.rows[0].body, 'after');
      assert.ok(after.rows[0].updated_at >= before);

      await db.exec("update public.notes set title='Direct edit' where id='" + NOTE + "'");
      assert.equal((await db.query('select title from public.notes where id=$1', [NOTE])).rows[0].title, 'Direct edit');
    });

    await test('hardening removes direct delete and truncate paths', async () => {
      await as('authenticated', UID);
      await assert.rejects(db.exec(`delete from public.notes where id='${NOTE}'`), /permission denied|row-level security/i);
      await assert.rejects(db.exec('truncate public.notes'), /permission denied|must be owner/i);
    });

    await test('anon has no direct note path after hardening', async () => {
      await as('anon');
      await assert.rejects(db.exec('select * from public.notes'), /permission denied|row-level security/i);
      await assert.rejects(db.exec('truncate public.notes'), /permission denied|must be owner/i);
    });

    await test('postgres-owned future objects no longer inherit client grants', async () => {
      await asPostgres();
      await db.exec('create table public.probe_postgres(id int)');
      assert.equal(await hasTable('anon', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER', 'public.probe_postgres'), false);
      assert.equal(await hasTable('authenticated', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER', 'public.probe_postgres'), false);
      // PGlite does not persist the PostgreSQL default-ACL revocation for the
      // implicit PUBLIC EXECUTE on functions. The audit's pg_default_acl checks
      // still cover the prepared script; verify the function probe in a real
      // PostgreSQL review if required.
      await db.exec('drop table public.probe_postgres');
    });

    await test('platform default-ACL script refuses a non-superuser/non-member session', async () => {
      await as('authenticated', UID);
      await db.exec("select set_config('cap.platform_acl_approved','platform-admin-review',false)");
      await assert.rejects(db.exec(platformAcl), /PLATFORM_ACL_BLOCKED/);
      await db.exec('rollback');
      await asPostgres();
      assert.equal(await hasFunction('anon', 'public.rls_auto_enable()'), false);
    });

    await test('platform default-ACL script runs in a superuser disposable session', async () => {
      await db.exec("select set_config('cap.platform_acl_approved','platform-admin-review',false)");
      await db.exec(platformAcl);
      const report = await audit();
      const found = codes(report);
      assert.equal(found.includes('CLIENT_DEFAULT_PRIVILEGES'), false);
      assert.equal(found.includes('PUBLIC_DEFAULT_PRIVILEGES'), false);
      assert.ok(found.includes('NOTES_AUTH_INSERT_UPDATE'));
      assert.ok(found.includes('NOTES_DESTRUCTIVE_POLICY'));
      assert.ok(found.includes('LEGACY_CAS_WRITE_PATH'));
      assert.ok(found.includes('LEGACY_VERIFIER_PRESENT'));
      assert.ok(found.includes('UNEXPECTED_PRIVILEGED_ROLE'));
      assert.ok(found.includes('UNEXPECTED_DEFINER_FUNCTION'));
    });

    await test('lockout script refuses to run without the cutover guard', async () => {
      await assert.rejects(db.exec(lockout), /LOCKOUT_NOT_APPROVED/);
      await db.exec('rollback');
    });

    await test('cutover lockout removes all direct access and legacy/test endpoints', async () => {
      await db.exec("select set_config('cap.lockout_approved','cutover-window-only',false)");
      await db.exec(lockout);
      const report = await audit();
      const found = codes(report);
      assert.equal(report.finding_counts.critical, 0);
      assert.ok(found.includes('UNEXPECTED_PRIVILEGED_ROLE'), 'platform role review must remain visible');
      for (const code of ['NOTES_AUTH_INSERT_UPDATE', 'NOTES_AUTH_DELETE', 'NOTES_AUTH_TRUNCATE',
        'NOTES_ANON_ANY', 'NOTES_FORCE_RLS_DISABLED', 'NOTES_DESTRUCTIVE_POLICY',
        'LEGACY_CAS_WRITE_PATH', 'LEGACY_VERIFIER_PRESENT', 'TEST_RPC_PRESENT',
        'NOTES_DIRECT_SELECT']) {
        assert.equal(found.includes(code), false, `unexpected finding ${code}`);
      }
      assert.equal(report.verdict.legacy_lockout_complete, true);
      assert.equal(report.verdict.production_notes_lifecycle_ready, false);
      assert.equal((await db.query("select to_regprocedure('public.cap_sync_note_put(uuid,jsonb,jsonb)') as v")).rows[0].v, null);
      assert.equal((await db.query("select to_regprocedure('public.cap_verify_notes_rpc()') as v")).rows[0].v, null);
      assert.equal((await db.query("select to_regprocedure('public.cap_test_transaction_create(uuid,text,uuid,uuid,uuid,numeric,date,date,text,text,text,jsonb)') as v")).rows[0].v, null);
      assert.equal((await db.query("select count(*) as n from pg_policies where schemaname='public' and tablename='notes'")).rows[0].n, 0);
      assert.equal((await db.query("select relforcerowsecurity as v from pg_class where oid='public.notes'::regclass")).rows[0].v, true);
      assert.equal(await hasTable('authenticated', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false);
      assert.equal(await hasTable('anon', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false);
    });

    await test('old clients fail closed after lockout', async () => {
      await as('authenticated', UID);
      await assert.rejects(db.exec('select * from public.notes'), /permission denied|row-level security/i);
      await assert.rejects(db.exec(`update public.notes set body='nope' where id='${NOTE}'`), /permission denied|row-level security/i);
      await as('anon');
      await assert.rejects(db.exec('select * from public.notes'), /permission denied|row-level security/i);
      await asPostgres();
      assert.equal((await db.query('select count(*) as n from public.notes where id=$1', [NOTE])).rows[0].n, 1);
    });

    console.log(`PASS: ${passed} isolated notes privilege-hardening/lockout checks; disposable PGlite only`);
  } finally {
    await db.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
