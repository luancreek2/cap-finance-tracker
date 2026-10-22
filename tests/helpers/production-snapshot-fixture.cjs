/* Shared synthetic PostgreSQL fixture for snapshot/readiness contract tests.
   Extracts repository table definitions and seeds synthetic rows only. It does
   not read, write or represent production data. */
const fs = require('node:fs');
const schema = fs.readFileSync(`${__dirname}/../../supabase_schema.sql`, 'utf8');
const identitySql = fs.readFileSync(`${__dirname}/../../supabase_production_identity.sql`, 'utf8');
const boundarySql = fs.readFileSync(`${__dirname}/../../supabase_production_role_boundary.sql`, 'utf8');
const transactionDraft = fs.readFileSync(`${__dirname}/../../supabase_production_transaction_create.sql`, 'utf8');
const notesDraft = fs.readFileSync(`${__dirname}/../../supabase_production_notes_sidecar.sql`, 'utf8');
const snapshotDraft = fs.readFileSync(`${__dirname}/../../supabase_production_snapshot_readiness.sql`, 'utf8');
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ids = {
  owner: uuid(1), foreign: uuid(2), category: uuid(10), foreignCategory: uuid(11),
  cash: uuid(100), credit: uuid(101), savings: uuid(102), foreignAccount: uuid(105),
  goal: uuid(200), debt: uuid(201), bill: uuid(202), statement: uuid(203),
  transaction: uuid(204), transfer: uuid(205), payment: uuid(206), budget: uuid(207),
  note: uuid(208), foreignNote: uuid(209)
};
const publicTables = ['profiles', 'user_preferences', 'categories', 'accounts', 'goals', 'debts',
  'bills', 'account_statements', 'transactions', 'transfers', 'bill_payments', 'budgets', 'notes'];
function tableSql() {
  return publicTables.map(name => {
    const match = schema.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw Error('SCHEMA_FIXTURE_MISSING_' + name);
    return match[0];
  }).join('\n');
}
function setupSql() {
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
    ${tableSql()}
    create function public.set_updated_at() returns trigger language plpgsql set search_path=pg_catalog as $$
      begin new.updated_at=clock_timestamp(); return new; end $$;
    ${publicTables.map(name => `create trigger ${name}_updated_at before update on public.${name}
      for each row execute function public.set_updated_at();`).join('\n')}
    ${publicTables.filter(name => name !== 'profiles').map(name => `alter table public.${name}
      enable row level security;
      create policy own_rows on public.${name} for all to authenticated using(user_id=auth.uid())
        with check(user_id=auth.uid());
      grant select,insert,update,delete on public.${name} to authenticated;`).join('\n')}
    alter table public.profiles enable row level security;
    create policy profiles_own on public.profiles for all to authenticated
      using(id=auth.uid()) with check(id=auth.uid());
    grant select,insert,update,delete on public.profiles to authenticated;

    -- Install the prepared production notes-sidecar draft instead of a
    -- synthetic stand-in. Installation does not cut over direct grants.
    set cap.notes_sidecar_install='reviewed-draft-only';
    ${notesDraft}

    insert into public.profiles(id,display_name) values
      ('${ids.owner}','Synthetic owner'),('${ids.foreign}','Synthetic foreign');
    insert into public.user_preferences(user_id) values ('${ids.owner}'),('${ids.foreign}');
    insert into public.categories(id,user_id,legacy_id,name) values
      ('${ids.category}','${ids.owner}','category-local','Synthetic category'),
      ('${ids.foreignCategory}','${ids.foreign}','foreign-category','Foreign fixture category');
    insert into public.accounts(id,user_id,legacy_id,name,account_type,balance) values
      ('${ids.cash}','${ids.owner}','100','Synthetic cash','cash',100),
      ('${ids.credit}','${ids.owner}','101','Synthetic credit','credit',100),
      ('${ids.savings}','${ids.owner}','102','Synthetic savings','savings',100),
      ('${ids.foreignAccount}','${ids.foreign}','105','Foreign fixture account','cash',100);
    insert into public.goals(id,user_id,account_id,legacy_id,name,target_amount,saved_amount) values
      ('${ids.goal}','${ids.owner}','${ids.cash}','200','Synthetic goal',1000,100);
    insert into public.debts(id,user_id,legacy_id,person,amount,direction) values
      ('${ids.debt}','${ids.owner}','201','Synthetic person',10,'in');
    insert into public.bills(id,user_id,payment_account_id,legacy_id,name,kind,amount,frequency) values
      ('${ids.bill}','${ids.owner}','${ids.cash}','202','Synthetic bill','bill',10,'monthly');
    insert into public.account_statements(id,user_id,account_id,statement_start,statement_end,
      statement_date,due_date,opening_balance,closing_balance) values
      ('${ids.statement}','${ids.owner}','${ids.credit}','2026-09-01','2026-09-30',
       '2026-09-30','2026-10-15',100,110);
    insert into public.transactions(id,user_id,account_id,category_id,legacy_id,amount,
      transaction_date,status,title,metadata) values
      ('${ids.transaction}','${ids.owner}','${ids.cash}','${ids.category}','204',-5,
       '2026-10-21','posted','Synthetic transaction','{}');
    insert into public.transfers(id,user_id,from_account_id,to_account_id,legacy_id,transfer_type,
      amount,transfer_date) values
      ('${ids.transfer}','${ids.owner}','${ids.cash}','${ids.savings}','205','account-transfer',1,'2026-10-21');
    insert into public.bill_payments(id,user_id,bill_id,transaction_id,amount,status) values
      ('${ids.payment}','${ids.owner}','${ids.bill}','${ids.transaction}',10,'scheduled');
    insert into public.budgets(id,user_id,category_id,amount) values
      ('${ids.budget}','${ids.owner}','${ids.category}',100);
    insert into public.notes(id,user_id,legacy_id,title,body,note_date) values
      ('${ids.note}','${ids.owner}','208','Synthetic note','Synthetic body','2026-10-21'),
      ('${ids.foreignNote}','${ids.foreign}','209','Foreign note','Foreign body','2026-10-21');
    select cap_notes_private.backfill_lifecycle();

    create function public.fixture_snapshot_call() returns jsonb
      language plpgsql security invoker set search_path=pg_catalog as $$
      begin return public.cap_sync_snapshot_v1();
      exception when others then return jsonb_build_object('error',SQLSTATE,'message',SQLERRM); end $$;
    create function public.fixture_readiness_call() returns jsonb
      language plpgsql security invoker set search_path=pg_catalog as $$
      begin return public.cap_verify_production_sync_v1();
      exception when others then return jsonb_build_object('error',SQLSTATE,'message',SQLERRM); end $$;
    revoke all on function public.fixture_snapshot_call() from public;
    revoke all on function public.fixture_readiness_call() from public;
    grant execute on function public.fixture_snapshot_call() to authenticated,anon;
    grant execute on function public.fixture_readiness_call() to authenticated,anon;
    create function public.fixture_transaction_call(op uuid,tx jsonb,expected jsonb) returns jsonb
      language plpgsql security invoker set search_path=pg_catalog as $$
      begin return public.cap_sync_transaction_create(op,tx,expected);
      exception when others then return jsonb_build_object('error',SQLSTATE,'message',SQLERRM); end $$;
    revoke all on function public.fixture_transaction_call(uuid,jsonb,jsonb) from public;
    grant execute on function public.fixture_transaction_call(uuid,jsonb,jsonb) to authenticated;
    create function public.fixture_notes_change(p_id uuid,p_expected jsonb,p_action text,
      p_desired jsonb,p_operation_id uuid) returns jsonb
      language plpgsql security invoker set search_path=pg_catalog as $$
      begin return public.cap_notes_change(p_id,p_expected,p_action,p_desired,p_operation_id);
      exception when others then return jsonb_build_object('error',SQLSTATE,'message',SQLERRM); end $$;
    revoke all on function public.fixture_notes_change(uuid,jsonb,text,jsonb,uuid) from public;
    grant execute on function public.fixture_notes_change(uuid,jsonb,text,jsonb,uuid) to authenticated,anon;
  `;
}
function lockdownSql() {
  return `
    reset role;
    drop policy if exists profiles_own on public.profiles;
    do $$ declare t text; begin
      foreach t in array array['${publicTables.filter(n => n !== 'profiles').join("','")}'] loop
        execute format('drop policy if exists own_rows on public.%I',t);
      end loop;
    end $$;
    revoke all on table ${publicTables.map(n => 'public.' + n).join(',')}
      from anon,authenticated,public;
    revoke all on table cap_notes_private.note_lifecycle,cap_notes_private.operations
      from anon,authenticated,service_role,public;
    revoke all on table cap_sync_private.transaction_create_receipts
      from anon,authenticated,service_role,public;
    revoke all on schema cap_notes_private from anon,authenticated,service_role,public;
    revoke all on schema cap_sync_private from anon,authenticated,service_role,public;
  `;
}
const transactionInstallSql = `set cap.transaction_create_install='reviewed-draft-only';\n${transactionDraft}`;
const snapshotInstallSql = `set cap.snapshot_readiness_install='reviewed-draft-only';\n${snapshotDraft}`;
module.exports = {
  ids, uuid, publicTables, setupSql, lockdownSql, transactionInstallSql, snapshotInstallSql,
  transactionDraft, notesDraft, snapshotDraft
};
