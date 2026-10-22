/* Shared synthetic SQL fixture. Extracts table definitions, never saved data. */
const fs = require('node:fs');
const schema = fs.readFileSync(`${__dirname}/../../supabase_schema.sql`,'utf8');
const identitySql = fs.readFileSync(`${__dirname}/../../supabase_production_identity.sql`,'utf8');
const boundarySql = fs.readFileSync(`${__dirname}/../../supabase_production_role_boundary.sql`,'utf8');
const draft = fs.readFileSync(`${__dirname}/../../supabase_production_transaction_create.sql`,'utf8');
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12,'0');
const ids = { owner:uuid(1), foreign:uuid(2), category:uuid(10), foreignCategory:uuid(11),
  cash:uuid(100), credit:uuid(101), savings:uuid(102), debit:uuid(103), ewallet:uuid(104), foreignAccount:uuid(105) };
function setupSql() {
  const names=['categories','accounts','bills','account_statements','transactions'];
  const tables=names.map(name=>{
    const match=schema.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`));
    if(!match)throw Error('SCHEMA_FIXTURE_MISSING');return match[0];
  }).join('\n');
  return `
    create role anon; create role authenticated; create role service_role bypassrls;
    revoke create on schema public from public;
    create schema auth; revoke all on schema auth from public;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${ids.owner}'),('${ids.foreign}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated;
    set cap.request_identity_install='reviewed-draft-only';
    ${identitySql}
    set cap.role_boundary_install='reviewed-draft-only';
    ${boundarySql}
    ${tables}
    create function public.set_updated_at() returns trigger language plpgsql set search_path=pg_catalog as $$
      begin new.updated_at=clock_timestamp(); return new; end $$;
    create trigger accounts_updated_at before update on public.accounts for each row execute function public.set_updated_at();
    create trigger transactions_updated_at before update on public.transactions for each row execute function public.set_updated_at();
    ${names.map(name=>`alter table public.${name} enable row level security;
      create policy own_rows on public.${name} for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
      grant select,insert,update,delete on public.${name} to authenticated;`).join('\n')}
    insert into public.categories(id,user_id,legacy_id,name) values
      ('${ids.category}','${ids.owner}','category-local','Synthetic category'),
      ('${ids.foreignCategory}','${ids.foreign}','foreign-category','Foreign fixture category');
    ${['cash','credit','savings','debit','ewallet'].map((type,i)=>`insert into public.accounts(id,user_id,legacy_id,name,account_type,balance)
      values('${ids[type]}','${ids.owner}','${100+i}','Synthetic ${type}','${type}',100);`).join('\n')}
    insert into public.accounts(id,user_id,legacy_id,name,account_type,balance)
      values('${ids.foreignAccount}','${ids.foreign}','105','Foreign fixture account','cash',100);
    -- Test-only wrapper captures fixed errors inside a subtransaction, allowing
    -- race sessions to stay alive after a deliberate rollback/error outcome.
    create function public.fixture_transaction_call(op uuid, tx jsonb, expected jsonb) returns jsonb
      language plpgsql security invoker set search_path=pg_catalog as $$
      begin return public.cap_sync_transaction_create(op,tx,expected);
      exception when others then return jsonb_build_object('error',SQLSTATE,'message',SQLERRM); end $$;
    revoke all on function public.fixture_transaction_call(uuid,jsonb,jsonb) from public;
    grant execute on function public.fixture_transaction_call(uuid,jsonb,jsonb) to authenticated;
  `;
}
function transaction(n, patch={}) {
  return { id:uuid(n),user_id:ids.owner,account_id:ids.cash,category_id:ids.category,
    bill_id:null,parent_transaction_id:null,statement_id:null,legacy_id:String(n),amount:-5,
    transaction_date:'2026-10-21',posting_date:null,status:'posted',title:'Synthetic transaction',description:null,metadata:{},...patch };
}
const installSql = `set cap.transaction_create_install='reviewed-draft-only';\n${draft}`;
const literal = value => "'"+JSON.stringify(value).replace(/'/g,"''")+"'::jsonb";
function callSql(op,tx,expected) {
  return `select public.fixture_transaction_call('${op}'::uuid,${literal(tx)},${literal(expected)});`;
}
module.exports={ids,uuid,draft,setupSql,installSql,transaction,callSql};
