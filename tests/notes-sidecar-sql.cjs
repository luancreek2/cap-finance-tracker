/* Disposable PostgreSQL WASM only. No Supabase connection or SQL deployment.
   Set CAP_PGLITE_PATH to an external @electric-sql/pglite install.
   This is isolated single-session coverage, NOT a live Supabase or concurrent
   PostgreSQL race test. Cloud Sync is never started or contacted. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const { PGlite } = require(process.env.CAP_PGLITE_PATH || '@electric-sql/pglite');
const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';
const id = '00000000-0000-4000-8000-000000000011', other = '00000000-0000-4000-8000-000000000012';
const foreign = '00000000-0000-4000-8000-000000000021', active = '00000000-0000-4000-8000-000000000022';
const absent = '00000000-0000-4000-8000-000000000099';
const content = { legacy_id: 'note-one', title: 'Note one', body: 'baseline', note_date: '2026-10-20' };
const second = { legacy_id: 'note-two', title: 'Note two', body: 'second', note_date: null };
const foreignContent = { legacy_id: 'note-foreign', title: 'Foreign', body: 'other owner', note_date: null };
const activeContent = { legacy_id: 'note-active', title: 'Active', body: 'active body', note_date: '2026-10-21' };
const sql = fs.readFileSync(`${__dirname}/sql/notes-sidecar-lab.sql`, 'utf8');
let passed = 0, nextOp = 100;
const op = () => '00000000-0000-4000-8000-' + String(nextOp++).padStart(12, '0');
const clone = x => JSON.parse(JSON.stringify(x));
const envelope = r => ({ content: r.content, lifecycle: r.lifecycle });
const contentOf = (legacyId, title, body, noteDate) => ({ legacy_id: legacyId, title, body, note_date: noteDate });
(async () => {
  const db = new PGlite();
  try {
    const table = fs.readFileSync(`${__dirname}/../supabase_schema.sql`, 'utf8').match(/create table public\.notes \([\s\S]*?\n\);/)[0];
    await db.exec(`create role authenticated; create role anon; create schema auth;
      create table auth.users(id uuid primary key); insert into auth.users values ('${a}'),('${b}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to authenticated,anon; ${table}
      create or replace function public.set_updated_at() returns trigger language plpgsql set search_path=public as $$begin new.updated_at=now(); return new; end$$;
      create trigger notes_updated_at before update on public.notes for each row execute function public.set_updated_at();
      alter table public.notes enable row level security;
      create policy own_rows on public.notes as permissive for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
      grant select,insert,update,delete on public.notes to authenticated;
      insert into public.notes(id,user_id,legacy_id,title,body,note_date) values
        ('${id}','${a}','${content.legacy_id}','${content.title}','${content.body}','${content.note_date}'),
        ('${other}','${a}','${second.legacy_id}','${second.title}','${second.body}',null),
        ('${foreign}','${b}','${foreignContent.legacy_id}','${foreignContent.title}','${foreignContent.body}',null),
        ('${active}','${a}','${activeContent.legacy_id}','${activeContent.title}','${activeContent.body}','${activeContent.note_date}');`);
    await db.exec(fs.readFileSync(`${__dirname}/../supabase_production_notes_rpc.sql`, 'utf8'));
    async function test(label, body) { try { await body(); passed++; } catch (e) { e.message = label + ': ' + e.message; throw e; } }
    const admin = () => db.exec('reset role');
    const user = async (uid = a, role = 'authenticated') => {
      await admin(); await db.exec(`set role ${role}`);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]);
    };
    const metadata = async () => (await db.query('select public.cap_verify_notes_lifecycle() as v')).rows[0].v;
    const read = async (noteId = id) => (await db.query('select public.cap_notes_read($1::uuid) as v', [noteId])).rows[0].v;
    const change = async (expected, action, desired = null, operation = op(), noteId = id) => (await db.query(
      'select public.cap_notes_change($1::uuid,$2::jsonb,$3::text,$4::jsonb,$5::uuid) as v',
      [noteId, expected === null ? null : JSON.stringify(expected), action, desired === null ? null : JSON.stringify(desired), operation])).rows[0].v;
    const backfill = async () => { await admin(); return (await db.query('select cap_notes_private.backfill_lifecycle() as v')).rows[0].v; };
    const guard = async () => { await admin(); return (await db.query('select cap_notes_private.rollback_guard() as v')).rows[0].v; };
    const snapshot = async () => {
      await admin();
      return JSON.stringify({
        notes: (await db.query('select * from public.notes order by id')).rows,
        lifecycle: (await db.query('select * from cap_notes_private.note_lifecycle order by note_id')).rows,
        operations: (await db.query('select * from cap_notes_private.operations order by user_id,operation_id')).rows
      });
    };
    const ledgerCount = async () => { await admin(); return Number((await db.query('select count(*) as n from cap_notes_private.operations')).rows[0].n); };

    await test('unguarded execution is rejected before schema creation', async () => {
      await assert.rejects(db.exec(sql), /ISOLATED_TESTS_ONLY/); await db.exec('rollback');
      assert.equal((await db.query("select to_regnamespace('cap_notes_private') as n")).rows[0].n, null);
    });

    await test('legacy phase remains ready and writes content before sidecar installation', async () => {
      await user();
      const legacy = (await db.query('select public.cap_verify_notes_rpc() as v')).rows[0].v;
      assert.equal(legacy.ready, true);
      const desired = { ...content, body: 'legacy edit' };
      assert.deepEqual((await db.query('select public.cap_sync_note_put($1::uuid,$2::jsonb,$3::jsonb) as v',
        [id, JSON.stringify(content), JSON.stringify(desired)])).rows[0].v, { status: 'APPLIED' });
      assert.equal((await db.query('select body from public.notes where id=$1', [id])).rows[0].body, 'legacy edit');
      assert.equal((await db.query('select public.cap_verify_notes_rpc() as v')).rows[0].v.ready, true);
    });

    await admin(); await db.exec("select set_config('cap.notes_sidecar_lab','isolated-tests-only',false)"); await db.exec(sql);

    await test('backfill creates exactly one revision-1 sidecar row per note without content changes', async () => {
      assert.deepEqual(await backfill(), { inserted: 4, missing: 0, orphans: 0 });
      await admin();
      assert.equal(Number((await db.query('select count(*) as n from cap_notes_private.note_lifecycle')).rows[0].n), 4);
      assert.equal(Number((await db.query('select count(*) as n from cap_notes_private.note_lifecycle where revision=1 and deleted_at is null and operation_id is null')).rows[0].n), 4);
      assert.equal((await db.query('select body from public.notes where id=$1', [id])).rows[0].body, 'legacy edit');
    });

    await test('a privileged hard delete is blocked by the sidecar foreign key', async () => {
      await admin(); await db.exec('begin');
      try { await assert.rejects(db.exec(`delete from public.notes where id='${active}'`), /foreign key/); }
      finally { await db.exec('rollback'); }
      assert.equal(Number((await db.query('select count(*) as n from public.notes where id=$1', [active])).rows[0].n), 1);
    });

    let preCutover;
    await test('the new reader works but the verifier refuses old grants and policies before cutover', async () => {
      await user(); preCutover = envelope(await read());
      assert.deepEqual(preCutover.content, { ...content, body: 'legacy edit' });
      assert.equal(preCutover.lifecycle.revision, 1);
      const m = await metadata();
      assert.equal(m.isolated_ready, false); assert.equal(m.legacy_lockout_ok, false);
      assert.equal(m.grants_ok, false); assert.equal(m.policies_ok, false); assert.equal(m.ready, false);
      await assert.rejects(change(preCutover, 'edit', { ...preCutover.content, body: 'blocked' }), /LIFECYCLE_CONTRACT_NOT_VERIFIED/);
    });

    await test('cutover removes direct note access and both legacy RPCs', async () => {
      await admin(); await db.exec(`revoke all on public.notes from authenticated, anon, public;
        drop policy if exists own_rows on public.notes;
        drop function if exists public.cap_sync_note_put(uuid,jsonb,jsonb);
        drop function if exists public.cap_verify_notes_rpc();`);
      assert.equal((await db.query("select to_regprocedure('public.cap_sync_note_put(uuid,jsonb,jsonb)') as v")).rows[0].v, null);
      assert.equal((await db.query("select to_regprocedure('public.cap_verify_notes_rpc()') as v")).rows[0].v, null);
      assert.equal((await db.query("select has_table_privilege('authenticated','public.notes','SELECT') as v")).rows[0].v, false);
    });

    await test('new verifier accepts the isolated sidecar contract but never production readiness', async () => {
      await user(); const m = await metadata();
      assert.equal(m.isolated_ready, true); assert.equal(m.ready, false); assert.equal(m.production_ready, false);
      assert.deepEqual(Object.keys(m).sort(), ['coverage_ok','functions_ok','grants_ok','isolated_ready','legacy_lockout_ok','policies_ok','production_ready','ready','rls_ok','roles_ok','tables_ok','version']);
      assert.equal(JSON.stringify(m).includes('legacy edit'), false); assert.equal(JSON.stringify(m).includes(id), false);
    });

    await test('reader retains exact content and explicit active lifecycle', async () => {
      const r = await read(); assert.deepEqual(envelope(r), preCutover);
      assert.deepEqual(Object.keys(r).sort(), ['content','lifecycle']);
    });

    let first = envelope(await read()), edited, editOperation = op();
    const desired = { ...first.content, body: 'first edit' };
    await test('versioned edit advances the sidecar and content together', async () => {
      assert.deepEqual(await change(first, 'edit', desired, editOperation), { status: 'APPLIED' });
      edited = envelope(await read());
      assert.equal(edited.lifecycle.revision, 2); assert.equal(edited.lifecycle.operation_id, editOperation); assert.deepEqual(edited.content, desired);
    });
    await test('rollback guard remains safe before any tombstone but reports operation evidence', async () => {
      const g = await guard(); assert.equal(g.safe_to_restore_legacy, true);
      assert.equal(g.tombstones_present, false); assert.equal(g.operations_present, true); assert.equal(g.production_ready, false);
    });
    await test('exact edit retry is idempotent', async () => {
      assert.deepEqual(await change(first, 'edit', desired, editOperation), { status: 'ALREADY_APPLIED' }); assert.deepEqual(envelope(await read()), edited);
    });
    await test('operation reuse with a different expected snapshot is rejected', async () => { await assert.rejects(change(edited, 'edit', desired, editOperation), /OPERATION_REUSE_CONFLICT/); });
    await test('operation reuse with different desired content is rejected', async () => { await assert.rejects(change(first, 'edit', content, editOperation), /OPERATION_REUSE_CONFLICT/); });
    await test('operation reuse on another note is rejected atomically', async () => {
      const original = envelope(await read(other)); await assert.rejects(change(original, 'edit', { ...original.content, body: 'hijack' }, editOperation, other), /OPERATION_REUSE_CONFLICT/);
      assert.deepEqual(envelope(await read(other)), original);
    });
    await test('stale expected content cannot overwrite a newer edit', async () => { assert.deepEqual(await change(first, 'edit', content), { status: 'CONFLICT' }); assert.deepEqual(envelope(await read()), edited); });
    await test('matching content with stale revision is still a conflict', async () => {
      const stale = clone(edited); stale.lifecycle.revision = 1; assert.deepEqual(await change(stale, 'tombstone'), { status: 'CONFLICT' });
    });

    let deleted, deleteOperation = op();
    await test('tombstone retains content and the row while advancing server lifecycle', async () => {
      assert.deepEqual(await change(edited, 'tombstone', null, deleteOperation), { status: 'APPLIED' }); deleted = envelope(await read());
      assert.deepEqual(deleted.content, desired); assert.equal(deleted.lifecycle.revision, 3); assert.equal(deleted.lifecycle.operation_id, deleteOperation);
      assert.match(deleted.lifecycle.deleted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      await admin(); assert.equal(Number((await db.query('select count(*) as n from public.notes where id=$1', [id])).rows[0].n), 1);
    });
    await test('exact tombstone retry is idempotent', async () => {
      assert.deepEqual(await change(edited, 'tombstone', null, deleteOperation), { status: 'ALREADY_APPLIED' }); assert.deepEqual(envelope(await read()), deleted);
    });
    await test('different delete operation is not silently acknowledged', async () => { assert.deepEqual(await change(edited, 'tombstone'), { status: 'CONFLICT' }); });
    await test('old edit retry after deletion cannot resurrect or report applied', async () => {
      assert.deepEqual(await change(first, 'edit', desired, editOperation), { status: 'CONFLICT' }); assert.deepEqual(envelope(await read()), deleted);
    });
    await test('even the exact deleted state cannot authorize restoration', async () => { assert.deepEqual(await change(deleted, 'edit', content), { status: 'CONFLICT' }); });
    await test('rollback guard blocks after a tombstone without mutating evidence', async () => {
      const g = await guard(); assert.equal(g.safe_to_restore_legacy, false);
      assert.equal(g.tombstones_present, true); assert.equal(g.operations_present, true);
      assert.match(g.action, /BLOCKED/);
    });
    await test('missing note is not inserted or inferred deleted', async () => {
      assert.equal(await read(absent), null); assert.deepEqual(await change(first, 'tombstone', null, op(), absent), { status: 'CONFLICT' }); assert.equal(await read(absent), null);
    });
    for (const action of ['restore','delete','purge','insert',null])
      await test('unsupported lifecycle action is refused', async () => { await assert.rejects(change(deleted, action), /INVALID_LIFECYCLE_REQUEST/); });
    const invalidEnvelopes = [null, {}, { ...first, user_id: a }, { content, lifecycle: {} },
      { content: null, lifecycle: first.lifecycle }, { content: { ...content, body: 5 }, lifecycle: first.lifecycle },
      { content: { ...content, note_date: '2026-02-30' }, lifecycle: first.lifecycle },
      { content, lifecycle: { ...first.lifecycle, revision: 1.5 } },
      { content, lifecycle: { ...first.lifecycle, revision: 9007199254740992 } },
      { content, lifecycle: { ...first.lifecycle, deleted_at: 'private-error', operation_id: 'private-error' } }];
    for (const bad of invalidEnvelopes)
      await test('invalid expected envelope fails without mutations', async () => { await assert.rejects(change(bad, 'tombstone')); assert.deepEqual(envelope(await read()), deleted); });
    await test('tombstone cannot replace retained content', async () => { await assert.rejects(change(edited, 'tombstone', content), /INVALID_DESIRED_CONTENT/); });
    await test('edit cannot change legacy identity', async () => { await assert.rejects(change(first, 'edit', { ...content, legacy_id: 'other' }), /IDENTITY_CHANGE_NOT_ALLOWED/); });

    await test('idempotent backfill does not alter revisions, tombstones, or receipts', async () => {
      const before = await snapshot(), count = await ledgerCount();
      assert.deepEqual(await backfill(), { inserted: 0, missing: 0, orphans: 0 });
      assert.equal(await snapshot(), before); assert.equal(await ledgerCount(), count);
      await user(); assert.deepEqual(envelope(await read()), deleted);
    });

    for (const statement of [
      'select * from public.notes',
      `update public.notes set body='direct' where id='${active}'`,
      `delete from public.notes where id='${active}'`,
      `truncate public.notes cascade`,
      `insert into public.notes(id,user_id,legacy_id,title,body) values('${absent}','${a}','x','x','x')`,
      'select * from cap_notes_private.note_lifecycle',
      'select * from cap_notes_private.operations',
      'update cap_notes_private.operations set result=\'{}\'::jsonb',
      'select cap_notes_private.backfill_lifecycle()',
      'select cap_notes_private.coverage_ok()',
      'select cap_notes_private.rollback_guard()',
      'create function cap_notes_private.evil() returns int language sql as \'select 1\''
    ]) await test('direct table/schema bypass is denied', async () => { await user(); await assert.rejects(db.exec(statement), /permission denied/); });
    await test('client cannot SET ROLE to the definer owner', async () => {
      await admin(); const originalSession = (await db.query('select session_user as name')).rows[0].name;
      await db.exec('set session authorization authenticated');
      try { await assert.rejects(db.exec('set role cap_notes_sidecar_writer'), /permission denied/); }
      finally { await db.exec('set session authorization "' + originalSession.replaceAll('"', '""') + '"'); await user(); }
    });

    await test('foreign records are hidden and writers cannot cross ownership', async () => {
      assert.equal(await read(foreign), null); assert.deepEqual(await change(deleted, 'tombstone', null, op(), foreign), { status: 'CONFLICT' });
      await user(b); assert.equal(await read(id), null); assert.deepEqual(await change(deleted, 'tombstone'), { status: 'CONFLICT' });
      assert.deepEqual((await read(foreign)).content, foreignContent); await user(); assert.deepEqual(envelope(await read()), deleted);
    });
    await test('anonymous execution is denied', async () => {
      await user(a, 'anon'); await assert.rejects(read(), /permission denied/); await assert.rejects(metadata(), /permission denied/); await assert.rejects(change(deleted, 'tombstone'), /permission denied/); await user();
    });
    await test('missing identity cannot write or verify', async () => {
      await user(''); await assert.rejects(change(deleted, 'tombstone'), /AUTH_REQUIRED/); await assert.rejects(metadata(), /AUTH_REQUIRED/); await user();
    });

    await test('empty text and null note date round-trip without invented values', async () => {
      const expected = envelope(await read(other));
      const empty = contentOf(second.legacy_id, '', '', null);
      assert.deepEqual(await change(expected, 'edit', empty, op(), other), { status: 'APPLIED' });
      assert.deepEqual(envelope(await read(other)).content, empty);
    });
    await test('deletion timestamp is canonical UTC regardless of session timezone', async () => {
      await db.exec("set timezone='Pacific/Honolulu'"); const expected = envelope(await read(other));
      await change(expected, 'tombstone', null, op(), other); const r = await read(other);
      assert.match(r.lifecycle.deleted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(Number.isFinite(Date.parse(r.lifecycle.deleted_at)), true); await db.exec("set timezone='UTC'");
    });

    await test('row-distorting trigger rolls note and sidecar back together', async () => {
      const expected = envelope(await read(active)), count = await ledgerCount(); await admin();
      await db.exec(`create function public.distort_note() returns trigger language plpgsql as $$begin new.body:='trigger changed'; return new; end$$;
        create trigger distort_note before update on public.notes for each row execute function public.distort_note()`);
      await user(); await assert.rejects(change(expected, 'edit', { ...expected.content, body: 'attempt' }, op(), active), /LIFECYCLE_WRITE_NOT_VERIFIED/);
      assert.deepEqual(envelope(await read(active)), expected); assert.equal(await ledgerCount(), count);
      await admin(); await db.exec('drop trigger distort_note on public.notes; drop function public.distort_note()'); await user();
    });
    await test('receipt-distorting trigger rolls note and sidecar back together', async () => {
      const expected = envelope(await read(active)), count = await ledgerCount(); await admin();
      await db.exec(`create function public.distort_receipt() returns trigger language plpgsql as $$begin new.expected:='{}'::jsonb; return new; end$$;
        create trigger distort_receipt before insert on cap_notes_private.operations for each row execute function public.distort_receipt()`);
      await user(); await assert.rejects(change(expected, 'edit', { ...expected.content, body: 'receipt attempt' }, op(), active), /OPERATION_RECEIPT_NOT_VERIFIED/);
      assert.deepEqual(envelope(await read(active)), expected); assert.equal(await ledgerCount(), count);
      await admin(); await db.exec('drop trigger distort_receipt on cap_notes_private.operations; drop function public.distort_receipt()'); await user();
    });

    const activeExpected = envelope(await read(active));
    async function unsafe(label, alter, restore) {
      await test(label + ' blocks verifier and writer', async () => {
        await admin(); await db.exec(alter); await user();
        assert.equal((await metadata()).isolated_ready, false);
        await assert.rejects(change(activeExpected, 'edit', { ...activeExpected.content, body: 'drift' }, op(), active), /LIFECYCLE_CONTRACT_NOT_VERIFIED/);
        await admin(); await db.exec(restore); await user();
        assert.equal((await metadata()).isolated_ready, true);
      });
    }
    await unsafe('direct client note UPDATE grant', 'grant update on public.notes to authenticated', 'revoke update on public.notes from authenticated');
    await unsafe('column-level client note UPDATE grant', 'grant update(body) on public.notes to authenticated', 'revoke update(body) on public.notes from authenticated');
    await unsafe('private lifecycle client grant', 'grant select on cap_notes_private.note_lifecycle to authenticated', 'revoke select on cap_notes_private.note_lifecycle from authenticated');
    await unsafe('writer role anonymous execute grant', 'grant execute on function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid) to anon', 'revoke execute on function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid) from anon');
    await unsafe('writer bypassrls', 'alter role cap_notes_sidecar_writer bypassrls', 'alter role cap_notes_sidecar_writer nobypassrls');
    await unsafe('writer login', 'alter role cap_notes_sidecar_writer login', 'alter role cap_notes_sidecar_writer nologin');
    await unsafe('writer role administration', 'alter role cap_notes_sidecar_writer createrole', 'alter role cap_notes_sidecar_writer nocreaterole');
    await unsafe('client writer-role membership', 'grant cap_notes_sidecar_writer to authenticated', 'revoke cap_notes_sidecar_writer from authenticated');
    await unsafe('additional broad policy', 'create policy broad on public.notes to authenticated using(true)', 'drop policy broad on public.notes');
    await unsafe('disabled FORCE RLS on sidecar', 'alter table cap_notes_private.note_lifecycle no force row level security', 'alter table cap_notes_private.note_lifecycle force row level security');
    await unsafe('missing writer UPDATE grant', 'revoke update on public.notes from cap_notes_sidecar_writer', 'grant update on public.notes to cap_notes_sidecar_writer');
    await unsafe('reader security mode drift', 'alter function public.cap_notes_read(uuid) security invoker', 'alter function public.cap_notes_read(uuid) security definer');
    await unsafe('unsafe verifier search_path', 'alter function public.cap_verify_notes_lifecycle() set search_path=public', 'alter function public.cap_verify_notes_lifecycle() set search_path=pg_catalog');
    await unsafe('writer function owner drift', 'alter function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid) owner to postgres', 'alter function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid) owner to cap_notes_sidecar_writer');
    await unsafe('extra public lifecycle overload', "create function public.cap_notes_read(uuid,text) returns jsonb language sql as $$select '{}'::jsonb$$", 'drop function public.cap_notes_read(uuid,text)');
    await unsafe('private backfill execute grant', 'grant execute on function cap_notes_private.backfill_lifecycle() to authenticated', 'revoke execute on function cap_notes_private.backfill_lifecycle() from authenticated');
    await unsafe('private coverage PUBLIC execute', 'grant execute on function cap_notes_private.coverage_ok() to public', 'revoke execute on function cap_notes_private.coverage_ok() from public');
    await unsafe('private rollback guard anonymous execute', 'grant execute on function cap_notes_private.rollback_guard() to anon', 'revoke execute on function cap_notes_private.rollback_guard() from anon');
    await test('restored legacy RPC blocks the contract until removed again', async () => {
      await admin(); await db.exec(fs.readFileSync(`${__dirname}/../supabase_production_notes_rpc.sql`, 'utf8')); await user();
      assert.equal((await metadata()).isolated_ready, false);
      await assert.rejects(change(activeExpected, 'edit', { ...activeExpected.content, body: 'legacy drift' }, op(), active), /LIFECYCLE_CONTRACT_NOT_VERIFIED/);
      await admin(); await db.exec('drop function public.cap_sync_note_put(uuid,jsonb,jsonb); drop function public.cap_verify_notes_rpc();'); await user();
      assert.equal((await metadata()).isolated_ready, true);
    });

    await test('revision overflow cannot lose its exact integer meaning', async () => {
      await admin(); await db.query('update cap_notes_private.note_lifecycle set revision=9007199254740991 where note_id=$1', [active]); await user();
      const expected = envelope(await read(active)); await assert.rejects(change(expected, 'tombstone', null, op(), active), /LIFECYCLE_REVISION_EXHAUSTED/);
      assert.deepEqual(envelope(await read(active)), expected);
    });
    await test('metadata calls leave content, sidecar rows, and receipts unchanged', async () => {
      const before = await snapshot(); await user(); await metadata(); await metadata();
      assert.equal(await snapshot(), before);
    });
    await test('reinstalling the lab does not reset content, revisions, tombstones, or receipts', async () => {
      const before = await snapshot(); await admin(); await db.exec(sql);
      assert.equal(await snapshot(), before); await user(); assert.equal((await metadata()).isolated_ready, true);
      assert.equal((await db.query("select has_table_privilege('authenticated','public.notes','SELECT') as v")).rows[0].v, false);
    });

    console.log(`PASS: ${passed} isolated notes sidecar SQL checks; no Supabase or concurrent-session claim`);
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
