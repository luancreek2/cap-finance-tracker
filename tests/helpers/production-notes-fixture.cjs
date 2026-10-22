/* Shared synthetic PostgreSQL fixture for the production notes-sidecar draft.
   Extracts the repository notes table definition and seeds synthetic rows. It
   never reads, writes or represents production data. */
const fs = require('node:fs');
const schema = fs.readFileSync(`${__dirname}/../../supabase_schema.sql`, 'utf8');
const identitySql = fs.readFileSync(`${__dirname}/../../supabase_production_identity.sql`, 'utf8');
const boundarySql = fs.readFileSync(`${__dirname}/../../supabase_production_role_boundary.sql`, 'utf8');
const notesDraft = fs.readFileSync(`${__dirname}/../../supabase_production_notes_sidecar.sql`, 'utf8');
const legacyDraft = fs.readFileSync(`${__dirname}/../../supabase_production_notes_rpc.sql`, 'utf8');
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ids = {
  owner: uuid(1), foreign: uuid(2), note: uuid(11), other: uuid(12),
  foreignNote: uuid(21), absent: uuid(99)
};
const contents = {
  note: { legacy_id: 'note-one', title: 'Note one', body: 'baseline', note_date: '2026-10-20' },
  other: { legacy_id: 'note-two', title: 'Note two', body: 'second', note_date: null },
  foreign: { legacy_id: 'note-foreign', title: 'Foreign', body: 'other owner', note_date: null }
};
const notesInstallSql = `set cap.notes_sidecar_install='reviewed-draft-only';\n${notesDraft}`;
const legacyInstallSql = legacyDraft;

function setupSql() {
  const table = schema.match(/create table public\.notes \([\s\S]*?\n\);/)[0];
  return `
    create role anon; create role authenticated; create role service_role bypassrls;
    revoke create on schema public from public;
    create schema auth;
    revoke all on schema auth from public;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${ids.owner}'),('${ids.foreign}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated;
    set cap.request_identity_install='reviewed-draft-only';
    ${identitySql}
    set cap.role_boundary_install='reviewed-draft-only';
    ${boundarySql}
    ${table}
    create function public.set_updated_at() returns trigger language plpgsql
      set search_path=pg_catalog as $$
      begin new.updated_at=clock_timestamp(); return new; end $$;
    create trigger notes_updated_at before update on public.notes
      for each row execute function public.set_updated_at();
    alter table public.notes enable row level security;
    create policy own_rows on public.notes for all to authenticated
      using(user_id=auth.uid()) with check(user_id=auth.uid());
    grant select,insert,update,delete on public.notes to authenticated;
    insert into public.notes(id,user_id,legacy_id,title,body,note_date) values
      ('${ids.note}','${ids.owner}','${contents.note.legacy_id}',
        '${contents.note.title}','${contents.note.body}','${contents.note.note_date}'),
      ('${ids.other}','${ids.owner}','${contents.other.legacy_id}',
        '${contents.other.title}','${contents.other.body}',null),
      ('${ids.foreignNote}','${ids.foreign}','${contents.foreign.legacy_id}',
        '${contents.foreign.title}','${contents.foreign.body}',null);
  `;
}
const backfillSql = 'select cap_notes_private.backfill_lifecycle();';
function cutoverSql() {
  return `
    reset role;
    revoke all on public.notes from authenticated,anon,public;
    drop policy if exists own_rows on public.notes;
    drop function if exists public.cap_sync_note_put(uuid,jsonb,jsonb);
    drop function if exists public.cap_verify_notes_rpc();
    revoke all on schema cap_notes_private from service_role,public,anon,authenticated;
    revoke all on cap_notes_private.note_lifecycle,cap_notes_private.operations
      from service_role,public,anon,authenticated;
  `;
}
function wrappersSql() {
  return `
    create function public.fixture_notes_read(p_id uuid) returns jsonb
      language plpgsql security invoker set search_path=pg_catalog as $$
      begin return public.cap_notes_read(p_id);
      exception when others then return jsonb_build_object('error',SQLSTATE,'message',SQLERRM); end $$;
    create function public.fixture_notes_change(p_id uuid,p_expected jsonb,p_action text,
      p_desired jsonb,p_operation uuid) returns jsonb
      language plpgsql security invoker set search_path=pg_catalog as $$
      begin return public.cap_notes_change(p_id,p_expected,p_action,p_desired,p_operation);
      exception when others then return jsonb_build_object('error',SQLSTATE,'message',SQLERRM); end $$;
    create function public.fixture_notes_verify() returns jsonb
      language plpgsql security invoker set search_path=pg_catalog as $$
      begin return public.cap_verify_notes_lifecycle();
      exception when others then return jsonb_build_object('error',SQLSTATE,'message',SQLERRM); end $$;
    revoke all on function public.fixture_notes_read(uuid) from public;
    revoke all on function public.fixture_notes_change(uuid,jsonb,text,jsonb,uuid) from public;
    revoke all on function public.fixture_notes_verify() from public;
    grant execute on function public.fixture_notes_read(uuid) to authenticated,anon;
    grant execute on function public.fixture_notes_change(uuid,jsonb,text,jsonb,uuid) to authenticated,anon;
    grant execute on function public.fixture_notes_verify() to authenticated,anon;
  `;
}
module.exports = {
  ids, uuid, contents, setupSql, notesInstallSql, legacyInstallSql,
  backfillSql, cutoverSql, wrappersSql, notesDraft, legacyDraft, identitySql
};
