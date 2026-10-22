/* Disposable PostgreSQL WASM only. No Supabase connection or SQL deployment.
   Set CAP_PGLITE_PATH to an external @electric-sql/pglite install.
   Isolated single-session coverage of the guarded production notes-sidecar
   draft, including creation, lifecycle, replay and rollback. Real concurrent
   PostgreSQL coverage is tests/manual/notes-sidecar-production-races.cjs. */
const assert = require('node:assert/strict');
const { PGlite } = require(process.env.CAP_PGLITE_PATH || '@electric-sql/pglite');
const f = require('./helpers/production-notes-fixture.cjs');
const a = f.ids.owner, b = f.ids.foreign, id = f.ids.note, other = f.ids.other;
const foreign = f.ids.foreignNote, absent = f.ids.absent;
const content = f.contents.note, second = f.contents.other, foreignContent = f.contents.foreign;
let passed = 0, nextOp = 100;
const op = () => f.uuid(nextOp++);
const clone = x => JSON.parse(JSON.stringify(x));
const envelope = r => ({ content: r.content, lifecycle: r.lifecycle });
const contentOf = (legacyId, title, body, noteDate) => ({ legacy_id: legacyId, title, body, note_date: noteDate });
(async () => {
  const db = new PGlite();
  try {
    await db.exec(f.setupSql());
    const test = async (label, body) => {
      try { await body(); passed++; }
      catch (e) { e.message = label + ': ' + e.message; throw e; }
    };
    const admin = () => db.exec('reset role');
    const user = async (uid = a, role = 'authenticated') => {
      await admin(); await db.exec(`set role ${role}`);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]);
    };
    const metadata = async () => (await db.query('select public.cap_verify_notes_lifecycle() as v')).rows[0].v;
    const read = async (noteId = id) => (await db.query('select public.cap_notes_read($1::uuid) as v', [noteId])).rows[0].v;
    const change = async (expected, action, desired = null, operation = op(), noteId = id) => (await db.query(
      'select public.cap_notes_change($1::uuid,$2::jsonb,$3::text,$4::jsonb,$5::uuid) as v',
      [noteId, expected === null ? null : JSON.stringify(expected), action,
        desired === null ? null : JSON.stringify(desired), operation])).rows[0].v;
    const backfill = async () => { await admin(); return (await db.query('select cap_notes_private.backfill_lifecycle() as v')).rows[0].v; };
    const guard = async () => { await admin(); return (await db.query('select cap_notes_private.rollback_guard() as v')).rows[0].v; };
    const state = async () => {
      await admin();
      return JSON.stringify({
        notes: (await db.query('select * from public.notes order by id')).rows,
        lifecycle: (await db.query('select * from cap_notes_private.note_lifecycle order by note_id')).rows,
        operations: (await db.query('select * from cap_notes_private.operations order by user_id,operation_id')).rows
      });
    };
    const ledgerCount = async () => { await admin(); return Number((await db.query('select count(*) as n from cap_notes_private.operations')).rows[0].n); };

    await test('unguarded production installation is rejected before schema creation', async () => {
      await assert.rejects(db.exec(f.notesDraft), /NOTES_SIDECAR_INSTALL_NOT_APPROVED/);
      await db.exec('rollback');
      assert.equal((await db.query("select to_regnamespace('cap_notes_private') as n")).rows[0].n, null);
    });

    await test('the legacy notes pilot is installed only to prove lockout', async () => {
      await db.exec(f.legacyInstallSql);
      assert.notEqual((await db.query("select to_regprocedure('public.cap_sync_note_put(uuid,jsonb,jsonb)') as v")).rows[0].v, null);
    });

    await db.exec(f.notesInstallSql);
    await test('backfill creates one revision-1 row per note and never changes content', async () => {
      assert.deepEqual(await backfill(), { inserted: 3, missing: 0, orphans: 0 });
      await admin();
      assert.equal(Number((await db.query('select count(*) as n from cap_notes_private.note_lifecycle')).rows[0].n), 3);
      assert.equal(Number((await db.query("select count(*) as n from cap_notes_private.note_lifecycle where revision=1 and deleted_at is null and operation_id is null")).rows[0].n), 3);
      assert.equal((await db.query('select body from public.notes where id=$1', [id])).rows[0].body, content.body);
    });

    await test('a hard delete is blocked by the lifecycle foreign key', async () => {
      await admin(); await db.exec('begin');
      try { await assert.rejects(db.exec(`delete from public.notes where id='${id}'`), /foreign key/); }
      finally { await db.exec('rollback'); }
      assert.equal(Number((await db.query('select count(*) as n from public.notes where id=$1', [id])).rows[0].n), 1);
    });

    await test('pre-cutover reader works but the contract refuses old grants, policies and RPCs', async () => {
      await user(); const r = envelope(await read());
      assert.deepEqual(r.content, content); assert.equal(r.lifecycle.revision, 1);
      const m = await metadata();
      assert.equal(m.version, 'CAP_NOTES_SIDECAR_V1');
      assert.equal(m.roles_ok, true); assert.equal(m.tables_ok, true); assert.equal(m.rls_ok, true);
      assert.equal(m.coverage_ok, true); assert.equal(m.functions_ok, true);
      assert.equal(m.grants_ok, false); assert.equal(m.policies_ok, false);
      assert.equal(m.legacy_lockout_ok, false); assert.equal(m.contract_ready, false);
      assert.equal(m.ready, false); assert.equal(m.production_ready, false);
      await assert.rejects(change(r, 'edit', { ...r.content, body: 'blocked' }), /NOTES_CONTRACT_NOT_READY/);
      await assert.rejects(change(null, 'create', { ...content, legacy_id: 'blocked-create' }), /NOTES_CONTRACT_NOT_READY/);
    });

    await test('cutover removes direct note access and both legacy RPCs', async () => {
      await admin(); await db.exec(f.cutoverSql());
      assert.equal((await db.query("select to_regprocedure('public.cap_sync_note_put(uuid,jsonb,jsonb)') as v")).rows[0].v, null);
      assert.equal((await db.query("select to_regprocedure('public.cap_verify_notes_rpc()') as v")).rows[0].v, null);
      assert.equal((await db.query("select has_table_privilege('authenticated','public.notes','SELECT') as v")).rows[0].v, false);
    });

    await test('the cut-over notes contract is ready, but never claims global production readiness', async () => {
      await user(); const m = await metadata();
      assert.deepEqual(Object.keys(m).sort(), ['contract_ready', 'coverage_ok', 'functions_ok', 'grants_ok',
        'legacy_lockout_ok', 'policies_ok', 'production_ready', 'ready', 'rls_ok', 'roles_ok', 'tables_ok', 'version']);
      assert.equal(m.contract_ready, true); assert.equal(m.ready, false); assert.equal(m.production_ready, false);
      assert.equal(JSON.stringify(m).includes(content.body), false); assert.equal(JSON.stringify(m).includes(id), false);
    });

    let createdExpected, createDesired = contentOf('note-created', 'Created', 'new', '2026-10-21');
    const created = absent, createOperation = op();
    await test('creation atomically inserts the note, revision-1 lifecycle and private receipt', async () => {
      assert.deepEqual(await change(null, 'create', createDesired, createOperation, created), { status: 'APPLIED' });
      createdExpected = envelope(await read(created));
      assert.deepEqual(createdExpected.content, createDesired);
      assert.equal(createdExpected.lifecycle.revision, 1);
      assert.equal(createdExpected.lifecycle.operation_id, createOperation);
      await admin();
      assert.equal(Number((await db.query('select count(*) as n from public.notes where id=$1 and user_id=$2', [created, a])).rows[0].n), 1);
      assert.equal(Number((await db.query('select count(*) as n from cap_notes_private.operations where user_id=$1 and operation_id=$2 and action=$3', [a, createOperation, 'create'])).rows[0].n), 1);
    });

    await test('exact creation retry is idempotent and does not add a revision', async () => {
      const before = await state();
      assert.deepEqual(await change(null, 'create', createDesired, createOperation, created), { status: 'ALREADY_APPLIED' });
      assert.equal(await state(), before); assert.deepEqual(envelope(await read(created)), createdExpected);
    });

    await test('creation cannot overwrite an existing owned note with a different operation', async () => {
      assert.deepEqual(await change(null, 'create', { ...createDesired, body: 'overwrite' }, op(), created), { status: 'CONFLICT' });
      assert.deepEqual(envelope(await read(created)), createdExpected);
    });
    await test('creation cannot overwrite an existing foreign note or leak its content', async () => {
      assert.deepEqual(await change(null, 'create', { ...foreignContent, body: 'hijack' }, op(), foreign), { status: 'CONFLICT' });
      await user(b); assert.deepEqual(envelope(await read(foreign)).content, foreignContent);
      await user(a); assert.equal(await read(foreign), null);
    });
    await test('creation rejects an expected snapshot, missing desired content or malformed fields', async () => {
      await assert.rejects(change(createdExpected, 'create', createDesired), /INVALID_EXPECTED/);
      await assert.rejects(change(null, 'create', null), /INVALID_DESIRED_CONTENT/);
      await assert.rejects(change(null, 'create', { ...createDesired, extra: true }), /INVALID_NOTE_CONTENT/);
      await assert.rejects(change(null, 'create', contentOf('', 'Title', 'Body', null)), /INVALID_NOTE_CONTENT/);
      await assert.rejects(change(null, 'create', contentOf('bad-date', 'Title', 'Body', '2026-02-30')), /INVALID_/);
    });
    await test('creation rejects null identity or operation IDs and unsupported actions', async () => {
      await assert.rejects(change(null, 'create', createDesired, null, f.uuid(900)), /INVALID_LIFECYCLE_REQUEST/);
      await assert.rejects(db.query('select public.cap_notes_change(null,$1::jsonb,$2::text,$3::jsonb,$4::uuid) as v',
        [null, 'create', JSON.stringify(createDesired), op()]), /INVALID_LIFECYCLE_REQUEST/);
      await assert.rejects(change(null, 'restore', createDesired), /INVALID_LIFECYCLE_REQUEST/);
    });
    await test('a second owner can create its own note without cross-owner visibility', async () => {
      const foreignCreated = f.uuid(301), desired = contentOf('foreign-created', 'Foreign created', 'foreign', null);
      await user(b); assert.deepEqual(await change(null, 'create', desired, op(), foreignCreated), { status: 'APPLIED' });
      assert.deepEqual(envelope(await read(foreignCreated)).content, desired);
      await user(a); assert.equal(await read(foreignCreated), null);
      assert.deepEqual(await change(createdExpected, 'edit', { ...createdExpected.content, body: 'cross' }, op(), foreignCreated), { status: 'CONFLICT' });
    });
    const activeNote = f.uuid(307);
    await test('a second live note remains available for rollback and drift checks', async () => {
      const desired = contentOf('active-note', 'Active note', 'active', '2026-10-21');
      assert.deepEqual(await change(null, 'create', desired, op(), activeNote), { status: 'APPLIED' });
      assert.deepEqual(envelope(await read(activeNote)).content, desired);
    });

    let first = createdExpected, editOperation = op();
    const firstDesired = { ...first.content, body: 'first edit' };
    let edited;
    await test('versioned edit advances note content and lifecycle together', async () => {
      assert.deepEqual(await change(first, 'edit', firstDesired, editOperation, created), { status: 'APPLIED' });
      edited = envelope(await read(created));
      assert.equal(edited.lifecycle.revision, 2); assert.equal(edited.lifecycle.operation_id, editOperation);
      assert.deepEqual(edited.content, firstDesired);
    });
    await test('rollback guard remains safe before any tombstone but reports operation evidence', async () => {
      const g = await guard(); assert.equal(g.safe_to_restore_legacy, true);
      assert.equal(g.tombstones_present, false); assert.equal(g.operations_present, true);
      assert.equal(g.production_ready, false);
    });
    await test('exact edit retry is idempotent', async () => {
      assert.deepEqual(await change(first, 'edit', firstDesired, editOperation, created), { status: 'ALREADY_APPLIED' });
      assert.deepEqual(envelope(await read(created)), edited);
    });
    await test('operation receipt binds note, action, expected and desired payloads', async () => {
      await assert.rejects(change(edited, 'edit', firstDesired, editOperation, created), /OPERATION_REUSE_CONFLICT/);
      await assert.rejects(change(first, 'edit', { ...firstDesired, body: 'different' }, editOperation, created), /OPERATION_REUSE_CONFLICT/);
      await assert.rejects(change(first, 'tombstone', null, editOperation, created), /OPERATION_REUSE_CONFLICT/);
      await assert.rejects(change(first, 'edit', firstDesired, editOperation, id), /OPERATION_REUSE_CONFLICT/);
      await assert.rejects(change(null, 'create', createDesired, createOperation, f.uuid(302)), /OPERATION_REUSE_CONFLICT/);
      assert.deepEqual(envelope(await read(created)), edited);
    });
    await test('stale expected content cannot overwrite a newer edit', async () => {
      assert.deepEqual(await change(first, 'edit', { ...first.content, body: 'stale' }, op(), created), { status: 'CONFLICT' });
      assert.deepEqual(envelope(await read(created)), edited);
    });
    await test('matching content with stale revision is still a conflict', async () => {
      const stale = clone(edited); stale.lifecycle.revision = 1;
      assert.deepEqual(await change(stale, 'tombstone', null, op(), created), { status: 'CONFLICT' });
    });

    let deleted, deleteOperation = op();
    await test('tombstone retains content and the row while advancing server lifecycle', async () => {
      assert.deepEqual(await change(edited, 'tombstone', null, deleteOperation, created), { status: 'APPLIED' });
      deleted = envelope(await read(created));
      assert.deepEqual(deleted.content, firstDesired); assert.equal(deleted.lifecycle.revision, 3);
      assert.equal(deleted.lifecycle.operation_id, deleteOperation);
      assert.match(deleted.lifecycle.deleted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      await admin(); assert.equal(Number((await db.query('select count(*) as n from public.notes where id=$1', [created])).rows[0].n), 1);
    });
    await test('exact tombstone retry is idempotent', async () => {
      assert.deepEqual(await change(edited, 'tombstone', null, deleteOperation, created), { status: 'ALREADY_APPLIED' });
      assert.deepEqual(envelope(await read(created)), deleted);
    });
    await test('a different delete operation is not silently acknowledged', async () => {
      assert.deepEqual(await change(edited, 'tombstone', null, op(), created), { status: 'CONFLICT' });
    });
    await test('old edit retry after deletion cannot resurrect or report applied', async () => {
      assert.deepEqual(await change(first, 'edit', firstDesired, editOperation, created), { status: 'CONFLICT' });
      assert.deepEqual(envelope(await read(created)), deleted);
    });
    await test('the exact deleted state cannot authorize restoration', async () => {
      assert.deepEqual(await change(deleted, 'edit', { ...deleted.content, body: 'restore' }, op(), created), { status: 'CONFLICT' });
    });
    await test('rollback guard blocks after a tombstone without mutating evidence', async () => {
      const g = await guard(); assert.equal(g.safe_to_restore_legacy, false);
      assert.equal(g.tombstones_present, true); assert.equal(g.operations_present, true);
      assert.match(g.action, /BLOCKED/);
    });

    await test('a missing note is not inserted or inferred deleted', async () => {
      assert.equal(await read(f.uuid(303)), null);
      assert.deepEqual(await change(first, 'tombstone', null, op(), f.uuid(303)), { status: 'CONFLICT' });
      assert.equal(await read(f.uuid(303)), null);
    });

    const live = envelope(await read(id));
    await test('the baseline note edits and tombstones independently', async () => {
      const operation = op(), desired = { ...live.content, body: 'baseline edit' };
      assert.deepEqual(await change(live, 'edit', desired, operation), { status: 'APPLIED' });
      const afterEdit = envelope(await read(id)); assert.equal(afterEdit.lifecycle.revision, 2);
      assert.deepEqual(await change(afterEdit, 'tombstone', null, op()), { status: 'APPLIED' });
      assert.equal((await read(id)).lifecycle.revision, 3);
    });

    const otherLive = envelope(await read(other));
    await test('empty text and null note date round-trip without invented values', async () => {
      const desired = contentOf(second.legacy_id, '', '', null);
      assert.deepEqual(await change(otherLive, 'edit', desired, op(), other), { status: 'APPLIED' });
      assert.deepEqual(envelope(await read(other)).content, desired);
    });
    await test('deletion timestamp is canonical UTC regardless of session timezone', async () => {
      await db.exec("set timezone='Pacific/Honolulu'");
      const expected = envelope(await read(other));
      await change(expected, 'tombstone', null, op(), other);
      const r = await read(other);
      assert.match(r.lifecycle.deleted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(Number.isFinite(Date.parse(r.lifecycle.deleted_at)), true);
      await db.exec("set timezone='UTC'");
    });

    await test('idempotent backfill does not alter revisions, tombstones, receipts or content', async () => {
      const before = await state(), count = await ledgerCount();
      assert.deepEqual(await backfill(), { inserted: 0, missing: 0, orphans: 0 });
      assert.equal(await state(), before); assert.equal(await ledgerCount(), count);
    });

    for (const statement of [
      'select * from public.notes',
      `update public.notes set body='direct' where id='${id}'`,
      `delete from public.notes where id='${id}'`,
      'truncate public.notes cascade',
      `insert into public.notes(id,user_id,legacy_id,title,body) values('${f.uuid(304)}','${a}','x','x','x')`,
      'select * from cap_notes_private.note_lifecycle',
      'select * from cap_notes_private.operations',
      "update cap_notes_private.operations set result='{}'::jsonb",
      'select cap_notes_private.backfill_lifecycle()',
      'select cap_notes_private.coverage_ok()',
      'select cap_notes_private.rollback_guard()',
      "create function cap_notes_private.evil() returns int language sql as 'select 1'"
    ]) await test('direct table/schema bypass is denied', async () => {
      await user(); await assert.rejects(db.exec(statement), /permission denied/);
    });
    await test('client cannot SET ROLE to the definer owner', async () => {
      await admin(); const originalSession = (await db.query('select session_user as name')).rows[0].name;
      await db.exec('set session authorization authenticated');
      try { await assert.rejects(db.exec('set role cap_notes_sidecar_writer'), /permission denied/); }
      finally { await db.exec('set session authorization "' + originalSession.replaceAll('"', '""') + '"'); await user(); }
    });

    await test('foreign records are hidden and writers cannot cross ownership', async () => {
      assert.equal(await read(foreign), null);
      assert.deepEqual(await change(deleted, 'tombstone', null, op(), foreign), { status: 'CONFLICT' });
      await user(b); assert.equal(await read(created), null);
      assert.deepEqual(await change(deleted, 'tombstone', null, op(), created), { status: 'CONFLICT' });
      await user(a);
    });
    await test('anonymous execution is denied', async () => {
      await user(a, 'anon');
      await assert.rejects(read(), /permission denied/);
      await assert.rejects(metadata(), /permission denied/);
      await assert.rejects(change(deleted, 'tombstone', null, op(), created), /permission denied/);
      await user();
    });
    await test('missing identity cannot write or verify', async () => {
      await user('');
      await assert.rejects(change(deleted, 'tombstone', null, op(), created), /AUTH_REQUIRED/);
      await assert.rejects(metadata(), /AUTH_REQUIRED/);
      await user();
    });

    await test('unsupported lifecycle actions are refused without mutation', async () => {
      const before = await state();
      for (const action of ['restore', 'delete', 'purge', 'insert', null])
        await assert.rejects(change(live, action), /INVALID_LIFECYCLE_REQUEST/);
      assert.equal(await state(), before);
    });
    const liveExpected = envelope(await read(id));
    const invalidEnvelopes = [null, {}, { ...liveExpected, user_id: a }, { content, lifecycle: {} },
      { content: null, lifecycle: liveExpected.lifecycle },
      { content: { ...content, body: 5 }, lifecycle: liveExpected.lifecycle },
      { content: { ...content, note_date: '2026-02-30' }, lifecycle: liveExpected.lifecycle },
      { content, lifecycle: { ...liveExpected.lifecycle, revision: 1.5 } },
      { content, lifecycle: { ...liveExpected.lifecycle, revision: 9007199254740992 } },
      { content, lifecycle: { ...liveExpected.lifecycle, deleted_at: 'private-error', operation_id: 'private-error' } }];
    for (const bad of invalidEnvelopes)
      await test('invalid expected envelope fails without mutation', async () => {
        const before = await state();
        await assert.rejects(change(bad, 'tombstone', null, op(), id));
        assert.equal(await state(), before);
      });
    await test('tombstone cannot replace retained content', async () => {
      await assert.rejects(change(liveExpected, 'tombstone', content, op(), id), /INVALID_DESIRED_CONTENT/);
    });
    await test('edit cannot change legacy identity', async () => {
      await assert.rejects(change(liveExpected, 'edit', { ...content, legacy_id: 'other' }, op(), id), /IDENTITY_CHANGE_NOT_ALLOWED/);
    });

    await test('row-distorting trigger rolls note, lifecycle and receipt back together', async () => {
      const expected = envelope(await read(activeNote)), count = await ledgerCount(); await admin();
      await db.exec(`create function public.distort_note() returns trigger language plpgsql as $$begin new.body:='trigger changed'; return new; end$$;
        create trigger distort_note before update on public.notes for each row execute function public.distort_note()`);
      await user();
      await assert.rejects(change(expected, 'edit', { ...expected.content, body: 'attempt' }, op(), activeNote), /LIFECYCLE_WRITE_NOT_VERIFIED/);
      assert.deepEqual(envelope(await read(activeNote)), expected); assert.equal(await ledgerCount(), count);
      await admin(); await db.exec('drop trigger distort_note on public.notes; drop function public.distort_note()'); await user();
    });
    await test('receipt-distorting trigger rolls note, lifecycle and receipt back together', async () => {
      const expected = envelope(await read(activeNote)), count = await ledgerCount(); await admin();
      await db.exec(`create function public.distort_receipt() returns trigger language plpgsql as $$begin new.expected:='{}'::jsonb; return new; end$$;
        create trigger distort_receipt before insert on cap_notes_private.operations for each row execute function public.distort_receipt()`);
      await user();
      await assert.rejects(change(expected, 'edit', { ...expected.content, body: 'receipt attempt' }, op(), activeNote), /OPERATION_RECEIPT_NOT_VERIFIED/);
      assert.deepEqual(envelope(await read(activeNote)), expected); assert.equal(await ledgerCount(), count);
      await admin(); await db.exec('drop trigger distort_receipt on cap_notes_private.operations; drop function public.distort_receipt()'); await user();
    });

    const activeExpected = envelope(await read(activeNote));
    async function unsafe(label, alter, restore) {
      await test(label + ' blocks verifier and writer', async () => {
        await admin(); await db.exec(alter); await user();
        assert.equal((await metadata()).contract_ready, false);
        await assert.rejects(change(activeExpected, 'edit', { ...activeExpected.content, body: 'drift' }, op(), activeNote), /NOTES_CONTRACT_NOT_READY/);
        await admin(); await db.exec(restore); await user();
        assert.equal((await metadata()).contract_ready, true);
      });
    }
    await unsafe('direct client note UPDATE grant', 'grant update on public.notes to authenticated', 'revoke update on public.notes from authenticated');
    await unsafe('column-level client note UPDATE grant', 'grant update(body) on public.notes to authenticated', 'revoke update(body) on public.notes from authenticated');
    await unsafe('private lifecycle client grant', 'grant select on cap_notes_private.note_lifecycle to authenticated', 'revoke select on cap_notes_private.note_lifecycle from authenticated');
    await unsafe('writer function anonymous execute grant', 'grant execute on function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid) to anon', 'revoke execute on function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid) from anon');
    await unsafe('writer bypassrls', 'alter role cap_notes_sidecar_writer bypassrls', 'alter role cap_notes_sidecar_writer nobypassrls');
    await unsafe('writer login', 'alter role cap_notes_sidecar_writer login', 'alter role cap_notes_sidecar_writer nologin');
    await unsafe('writer role administration', 'alter role cap_notes_sidecar_writer createrole', 'alter role cap_notes_sidecar_writer nocreaterole');
    await unsafe('client writer-role membership', 'grant cap_notes_sidecar_writer to authenticated', 'revoke cap_notes_sidecar_writer from authenticated');
    await unsafe('additional broad policy', 'create policy broad on public.notes to authenticated using(true)', 'drop policy broad on public.notes');
    await unsafe('disabled FORCE RLS on sidecar', 'alter table cap_notes_private.note_lifecycle no force row level security', 'alter table cap_notes_private.note_lifecycle force row level security');
    await unsafe('missing writer UPDATE grant', 'revoke update on public.notes from cap_notes_sidecar_writer', 'grant update on public.notes to cap_notes_sidecar_writer');
    await unsafe('missing writer INSERT grant', 'revoke insert on public.notes from cap_notes_sidecar_writer', 'grant insert on public.notes to cap_notes_sidecar_writer');
    await unsafe('missing lifecycle INSERT grant', 'revoke insert on cap_notes_private.note_lifecycle from cap_notes_sidecar_writer', 'grant insert on cap_notes_private.note_lifecycle to cap_notes_sidecar_writer');
    await unsafe('reader security mode drift', 'alter function public.cap_notes_read(uuid) security invoker', 'alter function public.cap_notes_read(uuid) security definer');
    await unsafe('unsafe verifier search_path', 'alter function public.cap_verify_notes_lifecycle() set search_path=public', 'alter function public.cap_verify_notes_lifecycle() set search_path=pg_catalog');
    await unsafe('writer function owner drift', 'alter function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid) owner to postgres', 'alter function public.cap_notes_change(uuid,jsonb,text,jsonb,uuid) owner to cap_notes_sidecar_writer');
    await unsafe('extra public lifecycle overload', "create function public.cap_notes_read(uuid,text) returns jsonb language sql as $$select '{}'::jsonb$$", 'drop function public.cap_notes_read(uuid,text)');
    await unsafe('private backfill execute grant', 'grant execute on function cap_notes_private.backfill_lifecycle() to authenticated', 'revoke execute on function cap_notes_private.backfill_lifecycle() from authenticated');
    await unsafe('private coverage PUBLIC execute', 'grant execute on function cap_notes_private.coverage_ok() to public', 'revoke execute on function cap_notes_private.coverage_ok() from public');
    await unsafe('private rollback guard anonymous execute', 'grant execute on function cap_notes_private.rollback_guard() to anon', 'revoke execute on function cap_notes_private.rollback_guard() from anon');
    await unsafe('service_role private schema usage', 'grant usage on schema cap_notes_private to service_role', 'revoke all on schema cap_notes_private from service_role');
    await test('restored legacy RPC blocks the contract until removed again', async () => {
      await admin(); await db.exec(f.legacyInstallSql); await user();
      assert.equal((await metadata()).contract_ready, false);
      await assert.rejects(change(activeExpected, 'edit', { ...activeExpected.content, body: 'legacy drift' }, op(), activeNote), /NOTES_CONTRACT_NOT_READY/);
      await admin(); await db.exec('drop function public.cap_sync_note_put(uuid,jsonb,jsonb); drop function public.cap_verify_notes_rpc();'); await user();
      assert.equal((await metadata()).contract_ready, true);
    });

    await test('creation cannot proceed when coverage is broken', async () => {
      const coverageNote = f.uuid(305);
      await user(); assert.deepEqual(await change(null, 'create',
        contentOf('coverage-note', 'Coverage note', 'covered', null), op(), coverageNote), { status: 'APPLIED' });
      await admin(); await db.query('delete from cap_notes_private.note_lifecycle where note_id=$1', [coverageNote]);
      await user();
      assert.equal((await metadata()).contract_ready, false);
      await assert.rejects(change(null, 'create', contentOf('coverage-gap', 'Gap', 'gap', null), op(), f.uuid(308)), /NOTES_CONTRACT_NOT_READY/);
      await admin(); assert.deepEqual((await db.query('select cap_notes_private.backfill_lifecycle() as v')).rows[0].v,
        { inserted: 1, missing: 0, orphans: 0 }); await user();
      assert.equal((await metadata()).contract_ready, true);
      assert.deepEqual(envelope(await read(coverageNote)).content,
        contentOf('coverage-note', 'Coverage note', 'covered', null));
    });
    await test('revision overflow cannot lose its exact integer meaning', async () => {
      const overflow = f.uuid(306), desired = contentOf('overflow', 'Overflow', 'max', null);
      await user(); assert.deepEqual(await change(null, 'create', desired, op(), overflow), { status: 'APPLIED' });
      await admin(); await db.query('update cap_notes_private.note_lifecycle set revision=9007199254740991 where note_id=$1', [overflow]); await user();
      const expected = envelope(await read(overflow));
      await assert.rejects(change(expected, 'tombstone', null, op(), overflow), /LIFECYCLE_REVISION_EXHAUSTED/);
      assert.deepEqual(envelope(await read(overflow)), expected);
    });
    await test('metadata calls leave content, sidecar rows, and receipts unchanged', async () => {
      const before = await state(); await user(); await metadata(); await metadata();
      assert.equal(await state(), before);
    });
    await test('reinstalling the first-install draft is refused without changing state', async () => {
      const before = await state(); await admin();
      await assert.rejects(db.exec(f.notesInstallSql), /NOTES_SIDECAR_TARGET_NOT_EMPTY/);
      await db.exec('rollback');
      assert.equal(await state(), before);
      await user(); assert.equal((await metadata()).contract_ready, true);
      assert.equal((await db.query("select has_table_privilege('authenticated','public.notes','SELECT') as v")).rows[0].v, false);
    });

    console.log(`PASS: ${passed} isolated production notes-sidecar SQL checks; no Supabase or concurrent-session claim`);
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
