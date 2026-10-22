/* Disposable PostgreSQL WASM only. No Supabase connection or SQL deployment.
   Set CAP_PGLITE_PATH to an external @electric-sql/pglite install.
   This is single-session coverage, NOT a concurrent PostgreSQL race test. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const { PGlite } = require(process.env.CAP_PGLITE_PATH || '@electric-sql/pglite');
const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';
const id = '00000000-0000-4000-8000-000000000011', other = '00000000-0000-4000-8000-000000000012';
const foreign = '00000000-0000-4000-8000-000000000021', absent = '00000000-0000-4000-8000-000000000099';
const clockNote = '00000000-0000-4000-8000-000000000013';
const content = { legacy_id: 'synthetic-note', title: 'Synthetic', body: 'baseline', note_date: '2026-10-20' };
const sql = fs.readFileSync(`${__dirname}/sql/notes-lifecycle-lab.sql`, 'utf8');
let passed = 0, nextOp = 100;
const op = () => '00000000-0000-4000-8000-' + String(nextOp++).padStart(12, '0');
const clone = x => JSON.parse(JSON.stringify(x));
(async () => {
  const db = new PGlite();
  try {
    const table = fs.readFileSync(`${__dirname}/../supabase_schema.sql`, 'utf8').match(/create table public\.notes \([\s\S]*?\n\);/)[0];
    await db.exec(`create role authenticated; create role anon; create schema auth;
      create table auth.users(id uuid primary key); insert into auth.users values ('${a}'),('${b}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to authenticated,anon; ${table}
      alter table public.notes enable row level security;
      create policy own_rows on public.notes to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
      grant select,insert,update,delete on public.notes to authenticated;
      insert into public.notes(id,user_id,legacy_id,title,body) values ('${id}','${a}','sentinel','Sentinel','untouched');`);
    await db.exec(fs.readFileSync(`${__dirname}/../supabase_production_notes_rpc.sql`, 'utf8'));
    async function test(label, body) { try { await body(); passed++; } catch (e) { e.message = label + ': ' + e.message; throw e; } }
    const admin = () => db.exec('reset role');
    const user = async (uid = a, role = 'authenticated') => { await admin(); await db.exec(`set role ${role}`); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]); };
    const metadata = async () => (await db.query('select cap_notes_lab.verify_contract() as v')).rows[0].v;
    const read = async (noteId = id) => (await db.query('select cap_notes_lab.note_read($1::uuid) as v', [noteId])).rows[0].v;
    const envelope = r => ({ content: Object.fromEntries(['legacy_id', 'title', 'body', 'note_date'].map(k => [k, r.row[k]])), lifecycle: r.lifecycle });
    const change = async (expected, action, desired = null, operation = op(), noteId = id) => (await db.query(
      'select cap_notes_lab.note_change($1::uuid,$2::jsonb,$3::text,$4::jsonb,$5::uuid) as v',
      [noteId, expected === null ? null : JSON.stringify(expected), action, desired === null ? null : JSON.stringify(desired), operation])).rows[0].v;
    const snapshot = async () => { await admin(); return JSON.stringify((await db.query('select * from cap_notes_lab.notes order by id')).rows); };
    const ledgerCount = async () => { await admin(); return Number((await db.query('select count(*) as n from cap_notes_lab.operations')).rows[0].n); };

    await test('unguarded execution is rejected before schema creation', async () => {
      await assert.rejects(db.exec(sql), /ISOLATED_TESTS_ONLY/); await db.exec('rollback');
      assert.equal((await db.query("select to_regnamespace('cap_notes_lab') as n")).rows[0].n, null);
    });
    await db.exec("select set_config('cap.notes_lifecycle_lab','isolated-tests-only',false)"); await db.exec(sql);
    await test('lab does not modify public notes or legacy RPC readiness', async () => {
      await user(); assert.equal((await db.query('select public.cap_verify_notes_rpc() as v')).rows[0].v.ready, true);
      assert.equal((await db.query('select body from public.notes where id=$1', [id])).rows[0].body, 'untouched');
      assert.equal((await db.query("select count(*) as n from information_schema.columns where table_schema='public' and table_name='notes' and column_name='deleted_at'")).rows[0].n, 0);
    });
    await admin();
    for (const [noteId, owner] of [[id, a], [other, a], [foreign, b], [clockNote, a]]) {
      await db.query('insert into cap_notes_lab.notes(id,user_id,legacy_id,title,body,note_date) values($1,$2,$3,$4,$5,$6)',
        [noteId, owner, content.legacy_id, content.title, content.body, content.note_date]);
    }
    await user();
    await test('metadata accepts isolated ACL/RLS contract but never production readiness', async () => {
      const m = await metadata(); assert.equal(m.isolated_ready, true); assert.equal(m.ready, false); assert.equal(m.production_ready, false);
      assert.deepEqual(Object.keys(m).sort(), ['functions_ok','grants_ok','isolated_ready','policies_ok','production_ready','ready','rls_ok','roles_ok','version']);
    });
    await test('reader retains exact content and explicit active lifecycle', async () => {
      const r = await read(); assert.deepEqual(envelope(r).content, content); assert.equal(r.lifecycle.revision, 1); assert.equal(r.lifecycle.deleted_at, null);
      assert.deepEqual(Object.keys(r).sort(), ['lifecycle','row']);
    });
    let first = envelope(await read()), edited, editOperation = op();
    const desired = { ...content, body: 'edited' };
    await test('versioned edit increments revision and emits statuses only', async () => {
      assert.deepEqual(await change(first, 'edit', desired, editOperation), { status: 'APPLIED' });
      edited = envelope(await read()); assert.equal(edited.lifecycle.revision, 2); assert.equal(edited.lifecycle.operation_id, editOperation); assert.deepEqual(edited.content, desired);
    });
    await test('exact edit retry is idempotent', async () => {
      assert.deepEqual(await change(first, 'edit', desired, editOperation), { status: 'ALREADY_APPLIED' }); assert.deepEqual(envelope(await read()), edited);
    });
    await test('operation reuse with a different expected snapshot is rejected', async () => { await assert.rejects(change(edited, 'edit', desired, editOperation), /OPERATION_REUSE_CONFLICT/); });
    await test('operation reuse with different desired content is rejected', async () => { await assert.rejects(change(first, 'edit', content, editOperation), /OPERATION_REUSE_CONFLICT/); });
    await test('operation reuse on another note is rejected atomically', async () => {
      const original = envelope(await read(other)); await assert.rejects(change(original, 'edit', desired, editOperation, other), /OPERATION_REUSE_CONFLICT/); assert.deepEqual(envelope(await read(other)), original);
    });
    await test('stale expected content cannot overwrite a newer edit', async () => { assert.deepEqual(await change(first, 'edit', content), { status: 'CONFLICT' }); assert.deepEqual(envelope(await read()), edited); });
    await test('matching content with stale revision is still a conflict', async () => {
      const stale = clone(edited); stale.lifecycle.revision = 1; assert.deepEqual(await change(stale, 'tombstone'), { status: 'CONFLICT' });
    });
    let deleted, deleteOperation = op();
    await test('tombstone retains content and row while advancing server lifecycle', async () => {
      assert.deepEqual(await change(edited, 'tombstone', null, deleteOperation), { status: 'APPLIED' }); deleted = envelope(await read());
      assert.deepEqual(deleted.content, desired); assert.equal(deleted.lifecycle.revision, 3); assert.equal(deleted.lifecycle.operation_id, deleteOperation);
      assert.match(deleted.lifecycle.deleted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal((await db.query('select count(*) as n from cap_notes_lab.notes where id=$1', [id])).rows[0].n, 1);
    });
    await test('exact tombstone retry is idempotent', async () => { assert.deepEqual(await change(edited, 'tombstone', null, deleteOperation), { status: 'ALREADY_APPLIED' }); assert.deepEqual(envelope(await read()), deleted); });
    await test('different delete operation is not silently acknowledged', async () => { assert.deepEqual(await change(edited, 'tombstone'), { status: 'CONFLICT' }); });
    await test('old edit retry after deletion cannot resurrect or report applied', async () => { assert.deepEqual(await change(first, 'edit', desired, editOperation), { status: 'CONFLICT' }); assert.deepEqual(envelope(await read()), deleted); });
    await test('even exact deleted state cannot authorize restoration', async () => { assert.deepEqual(await change(deleted, 'edit', content), { status: 'CONFLICT' }); });
    await test('missing note is not inserted or inferred deleted', async () => { assert.equal(await read(absent), null); assert.deepEqual(await change(first, 'tombstone', null, op(), absent), { status: 'CONFLICT' }); assert.equal(await read(absent), null); });
    for (const action of ['restore','delete','purge','insert',null]) await test('unsupported lifecycle action is refused', async () => { await assert.rejects(change(deleted, action)); });
    for (const bad of [null, {}, { ...first, user_id: a }, { content, lifecycle: {} },
      { content: null, lifecycle: first.lifecycle }, { content: { ...content, body: 5 }, lifecycle: first.lifecycle },
      { content: { ...content, note_date: '2026-02-30' }, lifecycle: first.lifecycle },
      { content, lifecycle: { ...first.lifecycle, revision: 1.5 } },
      { content, lifecycle: { ...first.lifecycle, revision: 9007199254740992 } },
      { content, lifecycle: { ...first.lifecycle, deleted_at: 'private-error', operation_id: 'private-error' } }]) {
      await test('invalid expected envelope fails without mutations', async () => { await assert.rejects(change(bad, 'tombstone')); assert.deepEqual(envelope(await read()), deleted); });
    }
    await test('tombstone cannot replace retained content', async () => { await assert.rejects(change(edited, 'tombstone', content), /INVALID_DESIRED_CONTENT/); });
    await test('edit cannot change legacy identity', async () => { await assert.rejects(change(first, 'edit', { ...content, legacy_id: 'other' }), /IDENTITY_CHANGE_NOT_ALLOWED/); });
    for (const statement of [
      `update cap_notes_lab.notes set body='direct' where id='${other}'`,
      `update cap_notes_lab.notes set deleted_at=null where id='${id}'`,
      `delete from cap_notes_lab.notes where id='${id}'`,
      `truncate cap_notes_lab.notes cascade`,
      `insert into cap_notes_lab.notes(id,user_id,legacy_id,title,body) values('${absent}','${a}','x','x','x')`,
      `select * from cap_notes_lab.operations`,
      `create function cap_notes_lab.evil() returns int language sql as 'select 1'`,
    ]) await test('direct table/schema bypass is denied', async () => { await assert.rejects(db.exec(statement), /permission denied/); });
    await test('client cannot SET ROLE to the definer owner', async () => {
      await admin(); const originalSession = (await db.query('select session_user as name')).rows[0].name;
      await db.exec('set session authorization authenticated');
      try { await assert.rejects(db.exec('set role cap_notes_lab_writer'), /permission denied/); }
      finally { await db.exec('set session authorization "' + originalSession.replaceAll('"', '""') + '"'); await user(); }
    });
    await test('foreign records are hidden and writers cannot cross ownership', async () => {
      assert.equal(await read(foreign), null); assert.deepEqual(await change(first, 'tombstone', null, op(), foreign), { status: 'CONFLICT' });
      await user(b); assert.equal(await read(), null); assert.deepEqual(await change(deleted, 'tombstone'), { status: 'CONFLICT' });
      assert.notEqual(await read(foreign), null); await user(); assert.deepEqual(envelope(await read()), deleted);
    });
    await test('anonymous execution is denied', async () => { await user(a, 'anon'); await assert.rejects(read()); await assert.rejects(metadata()); await assert.rejects(change(first, 'tombstone')); await user(); });
    await test('missing identity cannot write or verify', async () => { await user(''); await assert.rejects(change(first, 'tombstone'), /AUTH_REQUIRED/); await assert.rejects(metadata(), /AUTH_REQUIRED/); await user(); });
    async function unsafe(label, alter, restore) {
      await test(label + ' blocks verifier and writer', async () => {
        await admin(); await db.exec(alter); await user(); assert.equal((await metadata()).isolated_ready, false);
        await assert.rejects(change(edited, 'tombstone'), /LIFECYCLE_CONTRACT_NOT_VERIFIED/);
        await admin(); await db.exec(restore); await user(); assert.equal((await metadata()).isolated_ready, true);
      });
    }
    await unsafe('direct client UPDATE grant', 'grant update on cap_notes_lab.notes to authenticated', 'revoke update on cap_notes_lab.notes from authenticated');
    await unsafe('column-level client UPDATE grant', 'grant update(body) on cap_notes_lab.notes to authenticated', 'revoke update(body) on cap_notes_lab.notes from authenticated');
    await unsafe('PUBLIC write grant', 'grant update on cap_notes_lab.notes to public', 'revoke update on cap_notes_lab.notes from public');
    await unsafe('anonymous column SELECT grant', 'grant usage on schema cap_notes_lab to anon; grant select(body) on cap_notes_lab.notes to anon', 'revoke select(body) on cap_notes_lab.notes from anon; revoke usage on schema cap_notes_lab from anon');
    await unsafe('ledger read grant', 'grant select on cap_notes_lab.operations to authenticated', 'revoke select on cap_notes_lab.operations from authenticated');
    await unsafe('ledger column-level read grant', 'grant select(result) on cap_notes_lab.operations to authenticated', 'revoke select(result) on cap_notes_lab.operations from authenticated');
    await unsafe('missing writer UPDATE grant', 'revoke update on cap_notes_lab.notes from cap_notes_lab_writer', 'grant update on cap_notes_lab.notes to cap_notes_lab_writer');
    await unsafe('disabled FORCE RLS', 'alter table cap_notes_lab.notes no force row level security', 'alter table cap_notes_lab.notes force row level security');
    await unsafe('writer bypassrls', 'alter role cap_notes_lab_writer bypassrls', 'alter role cap_notes_lab_writer nobypassrls');
    await unsafe('writer schema CREATE', 'grant create on schema cap_notes_lab to cap_notes_lab_writer', 'revoke create on schema cap_notes_lab from cap_notes_lab_writer');
    await unsafe('writer role administration', 'alter role cap_notes_lab_writer createrole', 'alter role cap_notes_lab_writer nocreaterole');
    await unsafe('client role administration', 'alter role authenticated createrole', 'alter role authenticated nocreaterole');
    await unsafe('client writer-role membership', 'grant cap_notes_lab_writer to authenticated', 'revoke cap_notes_lab_writer from authenticated');
    await unsafe('additional broad policy', 'create policy broad on cap_notes_lab.notes to authenticated using(true)', 'drop policy broad on cap_notes_lab.notes');
    await unsafe('PUBLIC RPC execute', 'grant execute on function cap_notes_lab.note_change(uuid,jsonb,text,jsonb,uuid) to public', 'revoke execute on function cap_notes_lab.note_change(uuid,jsonb,text,jsonb,uuid) from public');
    await unsafe('unsafe writer search_path', 'alter function cap_notes_lab.note_change(uuid,jsonb,text,jsonb,uuid) set search_path=public', 'alter function cap_notes_lab.note_change(uuid,jsonb,text,jsonb,uuid) set search_path=pg_catalog');
    await unsafe('reader security mode drift', 'alter function cap_notes_lab.note_read(uuid) security definer', 'alter function cap_notes_lab.note_read(uuid) security invoker');
    await test('real edit/revert ABA cycle cannot authorize a stale tombstone', async () => {
      const original = envelope(await read(other)); await change(original, 'edit', { ...content, body: 'intermediate' }, op(), other);
      const intermediate = envelope(await read(other)); await change(intermediate, 'edit', content, op(), other);
      const reverted = envelope(await read(other)); assert.deepEqual(reverted.content, original.content); assert.equal(reverted.lifecycle.revision, original.lifecycle.revision + 2);
      assert.deepEqual(await change(original, 'tombstone', null, op(), other), { status: 'CONFLICT' });
    });
    await test('empty text and null note date round-trip without invented values', async () => {
      const expected = envelope(await read(clockNote)), desired = { ...content, title: '', body: '', note_date: null };
      assert.deepEqual(await change(expected, 'edit', desired, op(), clockNote), { status: 'APPLIED' }); assert.deepEqual(envelope(await read(clockNote)).content, desired);
    });
    await test('deletion timestamp is canonical UTC regardless of session timezone', async () => {
      await db.exec("set timezone='Pacific/Honolulu'"); const expected = envelope(await read(clockNote));
      await change(expected, 'tombstone', null, op(), clockNote); const r = await read(clockNote);
      assert.match(r.lifecycle.deleted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(Number.isFinite(Date.parse(r.lifecycle.deleted_at)), true); await db.exec("set timezone='UTC'");
    });
    await test('row-distorting trigger rolls note and ledger back together', async () => {
      const expected = envelope(await read(other)), count = await ledgerCount(); await admin();
      await db.exec(`create function cap_notes_lab.distort() returns trigger language plpgsql as $$begin new.body:='trigger changed'; return new; end$$;
        create trigger distort before update on cap_notes_lab.notes for each row execute function cap_notes_lab.distort()`);
      await user(); await assert.rejects(change(expected, 'tombstone', null, op(), other), /LIFECYCLE_WRITE_NOT_VERIFIED/);
      assert.deepEqual(envelope(await read(other)), expected); assert.equal(await ledgerCount(), count);
      await admin(); await db.exec('drop trigger distort on cap_notes_lab.notes'); await user();
    });
    await test('receipt-distorting trigger rolls the note mutation back too', async () => {
      const expected = envelope(await read(other)), count = await ledgerCount(); await admin();
      await db.exec(`create function cap_notes_lab.distort_receipt() returns trigger language plpgsql as $$begin new.expected:='{}'::jsonb; return new; end$$;
        create trigger distort_receipt before insert on cap_notes_lab.operations for each row execute function cap_notes_lab.distort_receipt()`);
      await user(); await assert.rejects(change(expected, 'tombstone', null, op(), other), /OPERATION_RECEIPT_NOT_VERIFIED/);
      assert.deepEqual(envelope(await read(other)), expected); assert.equal(await ledgerCount(), count);
      await admin(); await db.exec('drop trigger distort_receipt on cap_notes_lab.operations'); await user();
    });
    await test('revision overflow cannot lose its exact integer meaning', async () => {
      await admin(); await db.query('update cap_notes_lab.notes set revision=9007199254740991 where id=$1', [other]); await user();
      const expected = envelope(await read(other)); await assert.rejects(change(expected, 'tombstone', null, op(), other), /LIFECYCLE_REVISION_EXHAUSTED/);
      assert.deepEqual(envelope(await read(other)), expected);
    });
    await test('metadata calls leave notes and operation receipts unchanged', async () => {
      const before = await snapshot(), count = await ledgerCount(); await user(); await metadata(); await metadata();
      assert.equal(await snapshot(), before); assert.equal(await ledgerCount(), count); await user();
    });
    await test('reinstalling the lab does not reset rows, revisions, or operation history', async () => {
      const before = await snapshot(), count = await ledgerCount(); await admin(); await db.exec(sql);
      assert.equal(await snapshot(), before); assert.equal(await ledgerCount(), count); await user(); assert.equal((await metadata()).isolated_ready, true);
      assert.equal((await db.query('select body from public.notes where id=$1', [id])).rows[0].body, 'untouched');
    });
    console.log(`PASS: ${passed} isolated notes lifecycle SQL checks; no Supabase or concurrent-session claim`);
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
