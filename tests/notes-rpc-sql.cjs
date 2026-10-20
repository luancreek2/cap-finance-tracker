/* Optional PostgreSQL-WASM integration rehearsal; no Supabase connection.
   Install @electric-sql/pglite outside the repo and point CAP_PGLITE_PATH at it.
   Run: node tests/notes-rpc-sql.cjs
   Two-session locking races still require a staging PostgreSQL deployment. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.CAP_PGLITE_PATH || '@electric-sql/pglite');
const userA = '00000000-0000-4000-8000-000000000001';
const userB = '00000000-0000-4000-8000-000000000002';
const noteId = '00000000-0000-4000-8000-000000000011';
const absentId = '00000000-0000-4000-8000-000000000012';
const note = { legacy_id: 'demo-note', title: 'Test', body: 'base', note_date: '2026-10-20' };
let passed = 0;

(async () => {
  const db = new PGlite();
  try {
    const schema = fs.readFileSync(path.join(__dirname, '../supabase_schema.sql'), 'utf8');
    const table = schema.match(/create table public\.notes \([\s\S]*?\n\);/)[0];
    await db.exec(`
      create role authenticated; create role anon;
      create schema auth;
      create table auth.users(id uuid primary key);
      insert into auth.users values ('${userA}'), ('${userB}');
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema public, auth to authenticated, anon;
      ${table}
      alter table public.notes enable row level security;
      create policy own_rows on public.notes as permissive for all to authenticated
        using (user_id = auth.uid()) with check (user_id = auth.uid());
      grant select,insert,update,delete on public.notes to authenticated;
    `);
    const sql = fs.readFileSync(path.join(__dirname, '../supabase_production_notes_rpc.sql'), 'utf8');
    await db.exec(sql);
    const asUser = async (id = userA, role = 'authenticated') => {
      await db.exec(`reset role; set role ${role};`);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    };
    const admin = () => db.exec('reset role');
    const put = async (expected, desired, id = noteId) => (await db.query(
      'select public.cap_sync_note_put($1::uuid,$2::jsonb,$3::jsonb) as result',
      [id, expected === null ? null : JSON.stringify(expected), desired === null ? null : JSON.stringify(desired)]
    )).rows[0].result;
    const metadata = async () => (await db.query('select public.cap_verify_notes_rpc() as result')).rows[0].result;
    const verify = (actual, expected, label) => { assert.equal(actual, expected, label); passed++; };
    const rows = async () => (await db.query('select id,user_id,legacy_id,title,body,note_date from public.notes order by id')).rows;
    await asUser();
    verify((await metadata()).ready, true, 'Expected repository RLS and ACLs pass metadata verification');
    verify((await put(null, note)).status, 'APPLIED', 'Insert');
    verify((await put(null, note)).status, 'ALREADY_APPLIED', 'Idempotent insert retry');
    const edited = { ...note, body: 'edited' };
    verify((await put(note, edited)).status, 'APPLIED', 'Compare-and-swap update');
    verify((await put(note, edited)).status, 'ALREADY_APPLIED', 'Idempotent update retry');
    verify((await put(note, { ...note, body: 'stale overwrite' })).status, 'CONFLICT', 'Stale expected content');
    verify((await rows())[0].body, 'edited', 'Conflict preserves winning data');
    verify((await put(null, { ...note, body: 'insert collision' })).status, 'CONFLICT', 'Insert cannot overwrite');
    verify((await put(note, edited, absentId)).status, 'CONFLICT', 'Missing row cannot be recreated by an update');
    verify((await rows()).length, 1, 'Missing update wrote nothing');
    const before = JSON.stringify(await rows());
    await metadata(); await metadata();
    verify(JSON.stringify(await rows()), before, 'Verifier never writes app rows');
    for (const bad of [null, { ...note, user_id: userA }, { ...note, id: noteId }, { ...note, body: 1 }, { ...note, legacy_id: '' }, { title: 'partial' }, { ...note, note_date: '2026-02-30' }, { ...note, note_date: 'October 20' }]) {
      await assert.rejects(put(edited, bad)); passed++;
    }
    await assert.rejects(put({ ...edited, user_id: userA }, note)); passed++;
    verify(JSON.stringify(await rows()), before, 'Invalid inputs leave all rows unchanged');
    await asUser(userB);
    verify((await rows()).length, 0, 'Cross-user SELECT blocked by RLS');
    verify((await put(null, note)).status, 'CONFLICT', 'Foreign UUID collision cannot overwrite');
    await asUser(userA);
    verify(JSON.stringify(await rows()), before, 'Foreign collision preserves owner data');
    await asUser('');
    await assert.rejects(put(null, note)); passed++;
    await assert.rejects(metadata()); passed++;
    await asUser(userA, 'anon');
    await assert.rejects(put(null, note)); passed++;
    await assert.rejects(metadata()); passed++;

    async function unsafe(change, restore, label) {
      await admin(); await db.exec(change); await asUser();
      verify((await metadata()).ready, false, label);
      await admin(); await db.exec(restore); await asUser();
      assert.equal((await metadata()).ready, true, label + ' restored');
    }
    await unsafe('grant execute on function public.cap_sync_note_put(uuid,jsonb,jsonb) to public',
      'revoke execute on function public.cap_sync_note_put(uuid,jsonb,jsonb) from public', 'Public EXECUTE blocks readiness');
    await unsafe('alter function public.cap_sync_note_put(uuid,jsonb,jsonb) security definer',
      'alter function public.cap_sync_note_put(uuid,jsonb,jsonb) security invoker', 'Definer mutation RPC blocks readiness');
    await unsafe('alter function public.cap_sync_note_put(uuid,jsonb,jsonb) set search_path = public',
      'alter function public.cap_sync_note_put(uuid,jsonb,jsonb) set search_path = pg_catalog', 'Unsafe search_path blocks readiness');
    await unsafe("comment on function public.cap_sync_note_put(uuid,jsonb,jsonb) is 'wrong'",
      "comment on function public.cap_sync_note_put(uuid,jsonb,jsonb) is 'CAP_NOTES_CAS_V1'", 'Version mismatch blocks readiness');
    await unsafe('alter table public.notes disable row level security',
      'alter table public.notes enable row level security', 'Disabled RLS blocks readiness');
    await unsafe('alter role authenticated bypassrls',
      'alter role authenticated nobypassrls', 'Bypass-RLS role blocks readiness');
    await unsafe('create policy broad on public.notes for all to authenticated using (true) with check (true)',
      'drop policy broad on public.notes', 'Additional permissive policy blocks readiness');
    await unsafe('grant select on public.notes to anon',
      'revoke select on public.notes from anon', 'Anonymous table privilege blocks readiness');

    await admin();
    await db.exec(`create function public.distort_note() returns trigger language plpgsql as $$
      begin new.body := 'trigger-changed'; return new; end; $$;
      create trigger distort before update on public.notes for each row execute function public.distort_note();`);
    await asUser();
    await assert.rejects(put(edited, { ...note, body: 'trigger test' }), /NOTE_WRITE_NOT_VERIFIED/); passed++;
    verify(JSON.stringify(await rows()), before, 'Verification failure rolls back trigger-modified update');
    await admin(); await db.exec('drop trigger distort on public.notes');
    await db.exec('create trigger distort before insert on public.notes for each row execute function public.distort_note()');
    await asUser();
    await assert.rejects(put(null, note, absentId), /NOTE_WRITE_NOT_VERIFIED/); passed++;
    verify((await rows()).length, 1, 'Verification failure rolls back trigger-modified insert');
    await admin(); await db.exec('drop trigger distort on public.notes');
    // Reinstallation changes definitions/ACLs only, never the app rows.
    await db.exec(sql); await asUser();
    verify(JSON.stringify(await rows()), before, 'Reinstallation leaves notes unchanged');
    console.log(`PASS: ${passed} notes SQL integration checks (isolated PostgreSQL WASM; no Supabase)`);
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
