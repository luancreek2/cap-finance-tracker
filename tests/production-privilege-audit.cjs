/* Read-only production privilege audit harness. Disposable PGlite only.
   No Supabase connection, no live SQL, no app data, no note content. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require(process.env.CAP_PGLITE_PATH || '@electric-sql/pglite');

const auditSql = fs.readFileSync(`${__dirname}/sql/production-privilege-audit.sql`, 'utf8');
const schemaSql = fs.readFileSync(`${__dirname}/../supabase_schema.sql`, 'utf8');
const notesRpcSql = fs.readFileSync(`${__dirname}/../supabase_production_notes_rpc.sql`, 'utf8');

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function auditReport(results) {
  const row = results
    .flatMap(result => result.rows || [])
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
  try {
    await test('audit SQL is read-only by construction', async () => {
      const stripped = stripComments(auditSql);
      assert.match(stripped, /begin\s+transaction\s+read\s+only/i);
      assert.match(stripped, /\bcommit\s*;/i);
      assert.doesNotMatch(stripped, /^\s*(insert|update|delete|alter|create|grant|revoke|drop|truncate|call|do|copy|vacuum|analyze|reindex|cluster|comment|set|reset)\b/im);
      assert.doesNotMatch(stripped, /\bfrom\s+public\.(notes|cap_)/i);
      assert.doesNotMatch(stripped, /\b(select|perform)\s+public\.cap_/i);
      assert.doesNotMatch(stripped, /\b(pg_read_file|pg_read_binary_file|dblink|lo_import|lo_export)\b/i);
    });

    await test('synthetic deployed schema matches the repository contract', async () => {
      await db.exec(`create role authenticated; create role anon; create role service_role;
        create schema auth;
        create table auth.users(id uuid primary key);
        create function auth.uid() returns uuid language sql stable
          as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
        grant usage on schema auth, public to authenticated, anon;`);
      const notesTable = schemaSql.match(/create table public\.notes \([\s\S]*?\n\);/)[0];
      await db.exec(notesTable);
      await db.exec(`alter table public.notes enable row level security;
        create policy own_rows on public.notes for all to authenticated
          using (user_id = auth.uid()) with check (user_id = auth.uid());
        grant select, insert, update, delete on public.notes to authenticated;`);
      await db.exec(notesRpcSql);
    });

    let report;
    await test('audit executes as one read-only catalog query', async () => {
      const results = await db.exec(auditSql);
      report = auditReport(results);
      assert.equal(report.audit, 'cap-production-privilege-audit');
      assert.equal(report.audit_version, 1);
      assert.equal(report.read_only, true);
      assert.equal(report.notes.exists, true);
      assert.equal(report.notes.rls_enabled, true);
      assert.equal(report.notes.force_rls, false);
      assert.equal(report.notes.lifecycle_column_count, 0);
      assert.deepEqual(report.notes.column_grants, []);
    });

    await test('current deployed direct-write posture is reported as blocking', async () => {
      const authenticated = report.notes.effective_privileges.find(row => row.role_name === 'authenticated');
      assert.deepEqual(
        { select: authenticated.can_select, insert: authenticated.can_insert, update: authenticated.can_update, delete: authenticated.can_delete },
        { select: true, insert: true, update: true, delete: true });
      const found = codes(report);
      for (const code of ['NOTES_AUTH_DELETE', 'NOTES_AUTH_INSERT_UPDATE', 'NOTES_FORCE_RLS_DISABLED',
        'NOTES_DESTRUCTIVE_POLICY', 'LEGACY_CAS_WRITE_PATH', 'LEGACY_VERIFIER_PRESENT',
        'NOTES_DIRECT_SELECT', 'LIFECYCLE_COLUMNS_ABSENT']) {
        assert.ok(found.includes(code), `missing expected finding ${code}`);
      }
      for (const code of ['NOTES_MISSING', 'NOTES_RLS_DISABLED', 'NOTES_ANON_ANY', 'NOTES_PUBLIC_ANY']) {
        assert.equal(found.includes(code), false, `unexpected finding ${code}`);
      }
      assert.equal(report.verdict.posture_ready_for_review, false);
      assert.equal(report.verdict.production_notes_lifecycle_ready, false);
      assert.equal(report.verdict.legacy_lockout_complete, false);
      assert.equal(report.finding_counts.critical >= 1, true);
      assert.equal(report.finding_counts.high >= 1, true);
    });

    await test('raw note content is not part of audit output', async () => {
      const serialized = JSON.stringify(report);
      assert.doesNotMatch(serialized, /"title"\s*:\s*"|"body"\s*:\s*"|"note_date"\s*:\s*"/);
      assert.equal(report.notes.columns.some(column => column.column_name === 'title'), true);
      assert.equal(report.notes.columns.some(column => column.column_name === 'deleted_at'), false);
    });

    await test('column-level write grants are detected even when table grants are later revoked', async () => {
      await db.exec('grant update(body) on public.notes to authenticated');
      const results = await db.exec(auditSql);
      const columnReport = auditReport(results);
      assert.ok(codes(columnReport).includes('NOTES_AUTH_COLUMN_WRITE_GRANT'));
      assert.deepEqual(columnReport.notes.column_grants.map(row => [row.column_name, row.grantee, row.privilege_type]),
        [['body', 'authenticated', 'UPDATE']]);
      await db.exec('revoke update(body) on public.notes from authenticated');
    });

    await test('client membership in a cap_* or privileged role is detected transitively', async () => {
      await db.exec('create role cap_audit_writer nologin noinherit bypassrls; grant cap_audit_writer to authenticated');
      try {
        const results = await db.exec(auditSql);
        const membershipReport = auditReport(results);
        const found = codes(membershipReport);
        assert.ok(found.includes('CLIENT_ELEVATED_MEMBERSHIP'));
        assert.ok(found.includes('CLIENT_TRANSITIVE_MEMBERSHIP'));
        assert.ok(membershipReport.privileged_roles.some(role => role.rolname === 'cap_audit_writer'));
      } finally {
        await db.exec('revoke cap_audit_writer from authenticated; drop role cap_audit_writer');
      }
    });

    await test('hardening simulation clears critical/high findings but never claims production readiness', async () => {
      await db.exec(`drop policy own_rows on public.notes;
        create policy own_rows on public.notes for select to authenticated using (user_id = auth.uid());
        revoke all on public.notes from authenticated;
        alter table public.notes force row level security;
        alter table public.notes add column deleted_at timestamptz;
        alter table public.notes add column revision bigint not null default 1;
        alter table public.notes add column operation_id uuid;
        drop function public.cap_sync_note_put(uuid, jsonb, jsonb);
        drop function public.cap_verify_notes_rpc();`);
      const results = await db.exec(auditSql);
      const hardened = auditReport(results);
      const found = codes(hardened);
      assert.equal(hardened.notes.force_rls, true);
      assert.equal(hardened.notes.lifecycle_column_count, 3);
      assert.equal(hardened.finding_counts.critical, 0);
      assert.equal(hardened.finding_counts.high, 0);
      assert.equal(found.includes('NOTES_AUTH_DELETE'), false);
      assert.equal(found.includes('NOTES_AUTH_INSERT_UPDATE'), false);
      assert.equal(found.includes('LEGACY_CAS_WRITE_PATH'), false);
      assert.equal(found.includes('LEGACY_VERIFIER_PRESENT'), false);
      assert.equal(found.includes('NOTES_DIRECT_SELECT'), false);
      assert.equal(hardened.verdict.posture_ready_for_review, true);
      assert.equal(hardened.verdict.legacy_lockout_complete, true);
      assert.equal(hardened.verdict.production_notes_lifecycle_ready, false);
      assert.match(hardened.verdict.reason, /cannot prove/i);

      await db.exec('drop policy own_rows on public.notes');
      const rpcOnly = auditReport(await db.exec(auditSql));
      assert.equal(rpcOnly.finding_counts.critical, 0);
      assert.equal(rpcOnly.finding_counts.high, 0);
      assert.equal(codes(rpcOnly).includes('NOTES_POLICY_DRIFT'), false);
    });

    console.log(`PASS: ${passed} read-only production privilege audit checks; disposable PGlite only`);
  } finally {
    await db.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
