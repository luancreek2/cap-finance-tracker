/* Disposable PostgreSQL WASM only. No Supabase connection or SQL deployment.
   Rehearses rollback AFTER cutover but BEFORE any tombstone/edit receipt.
   Set CAP_PGLITE_PATH to an external @electric-sql/pglite install. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const { PGlite } = require(process.env.CAP_PGLITE_PATH || '@electric-sql/pglite');
const a = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000011';
const content = { legacy_id: 'rollback-note', title: 'Rollback', body: 'baseline', note_date: '2026-10-21' };
const sql = fs.readFileSync(`${__dirname}/sql/notes-sidecar-lab.sql`, 'utf8');
const legacySql = fs.readFileSync(`${__dirname}/../supabase_production_notes_rpc.sql`, 'utf8');
let passed = 0;
(async () => {
  const db = new PGlite();
  try {
    const table = fs.readFileSync(`${__dirname}/../supabase_schema.sql`, 'utf8').match(/create table public\.notes \([\s\S]*?\n\);/)[0];
    await db.exec(`create role authenticated; create role anon; create schema auth;
      create table auth.users(id uuid primary key); insert into auth.users values ('${a}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to authenticated,anon; ${table}
      create or replace function public.set_updated_at() returns trigger language plpgsql set search_path=public as $$begin new.updated_at=now(); return new; end$$;
      create trigger notes_updated_at before update on public.notes for each row execute function public.set_updated_at();
      alter table public.notes enable row level security;
      create policy own_rows on public.notes as permissive for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
      grant select,insert,update,delete on public.notes to authenticated;
      insert into public.notes(id,user_id,legacy_id,title,body,note_date) values
        ('${id}','${a}','${content.legacy_id}','${content.title}','${content.body}','${content.note_date}');`);
    await db.exec(legacySql);
    async function test(label, body) { try { await body(); passed++; } catch (e) { e.message = label + ': ' + e.message; throw e; } }
    const admin = () => db.exec('reset role');
    const user = async () => { await admin(); await db.exec('set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [a]); };
    const readRow = async () => { await admin(); return (await db.query('select body from public.notes where id=$1', [id])).rows[0]; };

    await test('legacy contract is ready before the sidecar rehearsal', async () => {
      await user(); assert.equal((await db.query('select public.cap_verify_notes_rpc() as v')).rows[0].v.ready, true);
    });
    await admin(); await db.exec("select set_config('cap.notes_sidecar_lab','isolated-tests-only',false)"); await db.exec(sql);
    await test('sidecar install and backfill add no tombstone or operation evidence', async () => {
      await admin(); assert.deepEqual((await db.query('select cap_notes_private.backfill_lifecycle() as v')).rows[0].v, { inserted: 1, missing: 0, orphans: 0 });
      assert.deepEqual((await db.query('select cap_notes_private.rollback_guard() as v')).rows[0].v.safe_to_restore_legacy, true);
    });
    await test('cutover locks out the legacy path', async () => {
      await admin(); await db.exec(`revoke all on public.notes from authenticated, anon, public;
        drop policy if exists own_rows on public.notes;
        drop function if exists public.cap_sync_note_put(uuid,jsonb,jsonb);
        drop function if exists public.cap_verify_notes_rpc();`);
      await user();
      assert.equal((await db.query("select to_regprocedure('public.cap_sync_note_put(uuid,jsonb,jsonb)') as v")).rows[0].v, null);
      assert.equal((await db.query("select has_table_privilege('authenticated','public.notes','SELECT') as v")).rows[0].v, false);
    });
    await test('rollback before any tombstone restores the exact old grants, policy, and RPCs', async () => {
      await admin(); await db.exec(`alter table public.notes no force row level security;
        drop policy if exists sidecar_notes_read on public.notes;
        drop policy if exists sidecar_notes_write on public.notes;
        create policy own_rows on public.notes as permissive for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
        grant select,insert,update,delete on public.notes to authenticated;
        drop function if exists public.cap_notes_change(uuid,jsonb,text,jsonb,uuid);
        drop function if exists public.cap_notes_read(uuid);
        drop function if exists public.cap_verify_notes_lifecycle();
        drop schema if exists cap_notes_private cascade;
        revoke all on public.notes from cap_notes_sidecar_writer;
        revoke all on schema auth from cap_notes_sidecar_writer;
        revoke execute on function auth.uid() from cap_notes_sidecar_writer;
        drop role if exists cap_notes_sidecar_writer;`);
      await db.exec(legacySql);
      await user();
      const m = (await db.query('select public.cap_verify_notes_rpc() as v')).rows[0].v;
      assert.equal(m.ready, true); assert.equal(m.version, 'CAP_NOTES_CAS_V1');
      assert.equal((await db.query("select to_regnamespace('cap_notes_private') as v")).rows[0].v, null);
      assert.equal((await db.query("select to_regclass('cap_notes_private.note_lifecycle') as v")).rows[0].v, null);
      assert.equal((await db.query("select count(*) as n from pg_roles where rolname='cap_notes_sidecar_writer'")).rows[0].n, 0);
      assert.equal((await db.query("select to_regprocedure('public.cap_notes_read(uuid)') as v")).rows[0].v, null);
    });
    await test('old content-only CAS works again after rollback', async () => {
      await user();
      const desired = { ...content, body: 'rolled back edit' };
      assert.deepEqual((await db.query('select public.cap_sync_note_put($1::uuid,$2::jsonb,$3::jsonb) as v',
        [id, JSON.stringify(content), JSON.stringify(desired)])).rows[0].v, { status: 'APPLIED' });
      assert.equal((await readRow()).body, 'rolled back edit');
      assert.equal((await db.query('select count(*) as n from public.notes where id=$1', [id])).rows[0].n, 1);
    });
    console.log(`PASS: ${passed} isolated sidecar rollback checks; no Supabase or content-export claim`);
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
