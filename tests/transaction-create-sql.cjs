/* Single-session contract/rollback tests, disposable PostgreSQL WASM only.
   Real overlapping-session tests are tests/manual/transaction-create-races.cjs. */
const assert = require('node:assert/strict');
const {PGlite}=require(process.env.CAP_PGLITE_PATH || '@electric-sql/pglite');
const {ids,uuid,draft,setupSql,installSql,transaction}=require('./helpers/transaction-create-fixture.cjs');
let passed=0;
const test=async(label,fn)=>{try{await fn();passed++;}catch(e){e.message=label+': '+e.message;throw e;}};
(async()=>{
  const db=new PGlite();
  const admin=()=>db.exec('reset role');
  const as=async(owner=ids.owner,role='authenticated')=>{await admin();await db.exec(`set role ${role}`);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);};
  const account=async(id=ids.cash)=>(await db.query('select to_jsonb(a) as v from public.accounts a where id=$1',[id])).rows[0]?.v;
  const call=async(op,tx,expected)=>(await db.query('select public.cap_sync_transaction_create($1::uuid,$2::jsonb,$3::jsonb) as v',[op,tx,expected])).rows[0].v;
  const state=async()=>{await admin();return (await db.query(`select jsonb_build_object(
    'accounts',(select jsonb_agg(to_jsonb(a) order by id) from public.accounts a),
    'transactions',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.transactions t),
    'receipts',(select coalesce(jsonb_agg(to_jsonb(r) order by operation_id),'[]') from cap_sync_private.transaction_create_receipts r)) as v`)).rows[0].v;};
  try{
    await db.exec(setupSql());
    await test('draft installation guard rolls back before changing schema',async()=>{
      await assert.rejects(db.exec(draft),/TRANSACTION_INSTALL_NOT_APPROVED/);await db.exec('rollback');
      assert.equal((await db.query("select to_regnamespace('cap_sync_private') as v")).rows[0].v,null);
    });
    await db.exec(installSql);
    await test('installer grants are removed and runtime writer is nonprivileged',async()=>{
      const p=(await db.query(`select rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,
        exists(select 1 from pg_auth_members where roleid=r.oid or member=r.oid) as memberships,
        has_schema_privilege(r.oid,'public','CREATE') as schema_create
        from pg_roles r where rolname='cap_transaction_writer'`)).rows[0];
      assert.ok(Object.values(p).every(v=>v===false));
      assert.equal((await db.query("select relforcerowsecurity from pg_class where oid='cap_sync_private.transaction_create_receipts'::regclass")).rows[0].relforcerowsecurity,true);
      for(const role of ['anon','authenticated','service_role']){
        assert.equal((await db.query("select has_schema_privilege($1,'cap_sync_private','USAGE') as v",[role])).rows[0].v,false);
        assert.equal((await db.query("select has_table_privilege($1,'cap_sync_private.transaction_create_receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as v",[role])).rows[0].v,false);
      }
    });
    await test('simple transaction insert and cash delta are atomic',async()=>{
      await as();const expected=await account(),tx=transaction(1000),r=await call(uuid(2000),tx,expected);
      assert.equal(r.status,'APPLIED');assert.equal(r.receipt_version,1);assert.equal(Number(r.account.balance),95);
      assert.equal(r.transaction.id,tx.id);assert.equal(Number((await account()).balance),95);
    });
    await test('lost-response replay happens before stale expected account comparison',async()=>{
      const s=await state(),receipt=s.receipts[0];await as();
      const before=await state();await as();const r=await call(receipt.operation_id,receipt.request.transaction,receipt.request.expected_account);
      assert.equal(r.status,'ALREADY_APPLIED');assert.deepEqual(await state(),before);
    });
    await test('operation UUID binds transaction body and expected account',async()=>{
      const s=await state(),r=s.receipts[0],before=await state();
      for(const [tx,a] of [[{...r.request.transaction,amount:-6},r.request.expected_account],
        [r.request.transaction,{...r.request.expected_account,balance:99}],
        [{...r.request.transaction,id:uuid(1001)},r.request.expected_account],
        [{...r.request.transaction,metadata:{_u:1}},r.request.expected_account]]){
        await as();await assert.rejects(call(r.operation_id,tx,a),/OPERATION_REUSE_CONFLICT/);
      }
      assert.deepEqual(await state(),before);
    });
    await test('a different operation UUID cannot reapply an existing transaction',async()=>{
      const s=await state(),receipt=s.receipts[0];await as();const expected=await account();
      assert.equal((await call(uuid(2001),receipt.request.transaction,expected)).status,'CONFLICT');
      assert.equal(Number((await account()).balance),95);
    });
    await test('changing operation and transaction UUIDs cannot duplicate the same legacy transaction',async()=>{
      const s=await state(),r=s.receipts.find(r=>r.outcome==='APPLIED');await as();const a=await account();
      assert.equal((await call(uuid(2009),{...r.request.transaction,id:uuid(1009)},a)).status,'CONFLICT');
      assert.equal(Number((await account()).balance),Number(a.balance));
    });
    await test('account CAS includes non-balance fields and timestamps',async()=>{
      await as();const expected=await account();await admin();await db.query("update public.accounts set nickname='changed' where id=$1",[ids.cash]);
      await as();const op=uuid(2002),tx=transaction(1002);assert.equal((await call(op,tx,expected)).status,'CONFLICT');
      const s=await state();assert.equal(s.transactions.some(t=>t.id===tx.id),false);
      await as();const fresh=await account();await assert.rejects(call(op,tx,fresh),/OPERATION_REUSE_CONFLICT/);
      assert.equal((await call(op,tx,expected)).status,'CONFLICT');
    });
    await test('an updated_at-only race cannot pass exact account CAS',async()=>{
      await as();const expected=await account();await admin();await db.query('update public.accounts set balance=balance where id=$1',[ids.cash]);
      await as();const fresh=await account(),withoutTime=x=>{const v={...x};delete v.updated_at;return v;};
      assert.deepEqual(withoutTime(fresh),withoutTime(expected));assert.notEqual(fresh.updated_at,expected.updated_at);
      assert.equal((await call(uuid(2010),transaction(1010),expected)).status,'CONFLICT');assert.deepEqual(await account(),fresh);
    });
    for(const type of ['credit','savings','debit','ewallet'])await test(`${type} uses verified signed delta algorithm`,async()=>{
      await as();const n=1100+passed,tx=transaction(n,{account_id:ids[type],amount:-10});
      const r=await call(uuid(n+1000),tx,await account(ids[type]));assert.equal(r.status,'APPLIED');
      assert.equal(Number(r.account.balance),type==='credit'?110:90);
    });
    await test('positive cash and credit amounts preserve existing sign rules',async()=>{
      for(const type of ['cash','credit']){await as();const a=await account(ids[type]),n=1200+(type==='cash'?0:1);
        const r=await call(uuid(n+1000),transaction(n,{account_id:ids[type],amount:2.35}),a);
        assert.equal(Number(r.account.balance),Number(a.balance)+(type==='credit'?-2.35:2.35));}
    });
    await test('malformed and unsupported payloads never mutate any row or receipt',async()=>{
      const before=await state();await as();const a=await account(),t=transaction(1300),missing={...t};delete missing.description;
      const invalid=[null,[],{},missing,{...t,unknown:true},{...t,user_id:ids.foreign},{...t,id:'not-a-uuid'},
        {...t,account_id:null},{...t,amount:0},{...t,amount:'5'},{...t,amount:0.001},{...t,amount:null},
        {...t,transaction_date:'2026-02-30'},{...t,transaction_date:'2026-1-01'},{...t,posting_date:'2026-10-20'},
        {...t,status:'pending'},{...t,bill_id:uuid(999)},{...t,parent_transaction_id:uuid(999)},
        {...t,statement_id:uuid(999)},{...t,metadata:[]},{...t,metadata:{opening:true}},
        {...t,metadata:{feeActual:true}},{...t,metadata:{amt:9}},{...t,metadata:{note:'different'}},
        {...t,metadata:{id:false}},{...t,metadata:{ts:'not-a-number'}},{...t,metadata:{_u:-1}}];
      for(const bad of invalid)await assert.rejects(call(uuid(2300),bad,a));
      for(const bad of [null,[],{...a,balance:'95'},{...a,user_id:ids.foreign},{...a,id:ids.credit},{...a,unknown:true}])await assert.rejects(call(uuid(2300),t,bad));
      await assert.rejects(call(null,t,a),/OPERATION_ID_REQUIRED/);await assert.rejects(call('00000000-0000-0000-0000-000000000000',t,a),/OPERATION_ID_REQUIRED/);
      assert.deepEqual(await state(),before);
    });
    await test('legitimate mapped metadata is preserved and validated against relationships',async()=>{
      await as();const a=await account(),t=transaction(1301,{metadata:{id:1301,ts:1,d:'2026-10-21',pd:'',amt:-5,cat:'Synthetic category',acct:100,note:'Synthetic transaction',desc:'',_u:2}});
      assert.equal((await call(uuid(2301),t,a)).status,'APPLIED');
      const before=await state();await as();const next=await account();
      for(const metadata of [{acct:101},{cat:'wrong category'},{id:1301,ts:1.5},{d:'2026-10-22'}])await assert.rejects(call(uuid(2302),transaction(1302,{metadata}),next));
      assert.deepEqual(await state(),before);
    });
    await test('explicitly uncategorized simple transaction is supported',async()=>{
      await as();const r=await call(uuid(2303),transaction(1303,{category_id:null}),await account());
      assert.equal(r.status,'APPLIED');assert.equal(r.transaction.category_id,null);
    });
    await test('foreign/missing account and category are rejected by owner and FK checks',async()=>{
      const before=await state();await as();const a=await account();
      for(const cat of [ids.foreignCategory,uuid(9999)])await assert.rejects(call(uuid(2400),transaction(1400,{category_id:cat}),a),/CATEGORY_OWNERSHIP_FAILED/);
      await admin();const foreign=await account(ids.foreignAccount);await as();
      await assert.rejects(call(uuid(2400),transaction(1400,{account_id:ids.foreignAccount}),foreign),/INVALID_EXPECTED_ACCOUNT/);
      await assert.rejects(call(uuid(2400),transaction(1400,{account_id:ids.foreignAccount}),{...foreign,user_id:ids.owner}),/ACCOUNT_OWNERSHIP_FAILED/);
      assert.deepEqual(await state(),before);
    });
    await test('another user cannot replay or read an owner receipt',async()=>{
      const s=await state(),r=s.receipts.find(r=>r.outcome==='APPLIED');await as(ids.foreign);
      await assert.rejects(call(r.operation_id,r.request.transaction,r.request.expected_account),/TRANSACTION_OWNERSHIP_FAILED/);
      await assert.rejects(db.query('select * from cap_sync_private.transaction_create_receipts'),/permission denied/);
      await as('', 'authenticated');await assert.rejects(call(uuid(2500),transaction(1500),r.request.expected_account),/AUTH_REQUIRED/);
      await as(ids.owner,'anon');await assert.rejects(call(uuid(2500),transaction(1500),r.request.expected_account),/permission denied/);
      assert.deepEqual(await state(),s);
    });
    await test('unreceipted foreign UUID collision is a fixed conflict, never adoption',async()=>{
      await admin();const t=transaction(1501);await db.query(`insert into public.transactions(id,user_id,account_id,amount,transaction_date,status)
        values($1,$2,$3,1,'2026-10-21','posted')`,[t.id,ids.foreign,ids.foreignAccount]);
      await as();const a=await account();assert.equal((await call(uuid(2501),t,a)).status,'CONFLICT');
      assert.equal(Number((await account()).balance),Number(a.balance));
    });
    await test('outer rollback erases insert, balance effect and receipt; same operation can retry',async()=>{
      await as();const a=await account(),t=transaction(1600),op=uuid(2600),before=await state();await as();await db.exec('begin');
      assert.equal((await call(op,t,a)).status,'APPLIED');await db.exec('rollback');assert.deepEqual(await state(),before);
      await as();assert.equal((await call(op,t,a)).status,'APPLIED');
    });
    await test('post-write account corruption rolls back the whole RPC',async()=>{
      await admin();await db.exec(`create function public.fixture_distort_account() returns trigger language plpgsql as $$begin new.balance=new.balance+1;return new;end$$;
        create trigger fixture_distort before update on public.accounts for each row execute function public.fixture_distort_account();`);
      const before=await state();await as();const a=await account();await assert.rejects(call(uuid(2700),transaction(1700),a),/ACCOUNT_WRITE_NOT_VERIFIED/);
      assert.deepEqual(await state(),before);await db.exec('drop trigger fixture_distort on public.accounts');
    });
    await test('transaction corruption rolls back insert, dependent delta and receipt',async()=>{
      await admin();await db.exec(`create function public.fixture_distort_transaction() returns trigger language plpgsql as $$begin new.amount=new.amount+1;return new;end$$;
        create trigger fixture_distort before insert on public.transactions for each row execute function public.fixture_distort_transaction();`);
      const before=await state();await as();await assert.rejects(call(uuid(2701),transaction(1701),await account()),/TRANSACTION_WRITE_NOT_VERIFIED/);
      assert.deepEqual(await state(),before);await db.exec('drop trigger fixture_distort on public.transactions');
    });
    await test('a failed receipt insert rolls back financial effects',async()=>{
      await admin();await db.exec("alter table cap_sync_private.transaction_create_receipts add constraint fixture_reject check(false) not valid");
      const before=await state();await as();await assert.rejects(call(uuid(2702),transaction(1702),await account()));
      assert.deepEqual(await state(),before);await db.exec('alter table cap_sync_private.transaction_create_receipts drop constraint fixture_reject');
    });
    await test('unexpected trigger error bodies are redacted and rollback is complete',async()=>{
      await admin();await db.exec(`create function public.fixture_private_error() returns trigger language plpgsql as $$begin raise exception 'fixture_private_value';end$$;
        create trigger fixture_private_error before insert on public.transactions for each row execute function public.fixture_private_error();`);
      const before=await state();await as();await assert.rejects(call(uuid(2704),transaction(1704),await account()),e=>e.message==='TRANSACTION_CREATE_FAILED'&&!String(e.detail||'').includes('fixture_private_value'));
      assert.deepEqual(await state(),before);await db.exec('drop trigger fixture_private_error on public.transactions');
    });
    await test('amount overflow rolls back the insert and leaves no receipt',async()=>{
      await admin();await db.query('update public.accounts set balance=9999999999999999.99 where id=$1',[ids.ewallet]);const before=await state();await as();
      // Keep the extreme numeric snapshot in PostgreSQL rather than round-trip
      // it through a JavaScript Number (which would correctly fail CAS first).
      await assert.rejects(db.query(`select public.cap_sync_transaction_create($1::uuid,$2::jsonb,
        (select to_jsonb(a) from public.accounts a where id=$3))`,
        [uuid(2703),transaction(1703,{account_id:ids.ewallet,amount:1}),ids.ewallet]),/AMOUNT_OUT_OF_RANGE/);
      assert.deepEqual(await state(),before);
    });
    await test('unsupported isolation fails before a receipt or balance change',async()=>{
      const before=await state();await as();const a=await account();await db.exec('begin isolation level repeatable read');
      await assert.rejects(call(uuid(2800),transaction(1800),a),/UNSUPPORTED_ISOLATION/);await db.exec('rollback');assert.deepEqual(await state(),before);
    });
    await test('receipt retention prevents physical transaction deletion',async()=>{
      const s=await state(),r=s.receipts.find(r=>r.outcome==='APPLIED');await as();
      await assert.rejects(db.query('delete from public.transactions where id=$1',[r.transaction_id]),/foreign key|RELATIONSHIP/i);
      assert.deepEqual(await state(),s);
    });
    await test('writer cannot mutate/purge receipts or create schema objects',async()=>{
      await admin();await db.exec('set role cap_transaction_writer');
      for(const sql of ['delete from cap_sync_private.transaction_create_receipts',
        "update cap_sync_private.transaction_create_receipts set outcome='CONFLICT'",'truncate cap_sync_private.transaction_create_receipts',
        'create table cap_sync_private.forbidden(id int)'])await assert.rejects(db.exec(sql),/permission denied|must be owner/);
      await admin();
    });
    await test('metadata/privilege drift fails closed at runtime',async()=>{
      for(const [change,restore] of [
        ['alter role cap_transaction_writer bypassrls','alter role cap_transaction_writer nobypassrls'],
        ['grant cap_transaction_writer to authenticated','revoke cap_transaction_writer from authenticated'],
        ['grant usage on schema cap_sync_private to authenticated','revoke usage on schema cap_sync_private from authenticated'],
        ['grant select on cap_sync_private.transaction_create_receipts to authenticated','revoke select on cap_sync_private.transaction_create_receipts from authenticated'],
        ['alter table cap_sync_private.transaction_create_receipts no force row level security','alter table cap_sync_private.transaction_create_receipts force row level security'],
        ['alter table public.accounts disable row level security','alter table public.accounts enable row level security'],
        ['grant execute on function public.cap_sync_transaction_create(uuid,jsonb,jsonb) to public','revoke execute on function public.cap_sync_transaction_create(uuid,jsonb,jsonb) from public']]){
        await admin();await db.exec(change);await as();const a=await account();await assert.rejects(call(uuid(2900),transaction(1900),a),/TRANSACTION_CONTRACT_NOT_VERIFIED/);
        await admin();await db.exec(restore);
      }
    });
    await test('first-install guard never overwrites an existing contract',async()=>{
      await admin();await assert.rejects(db.exec(installSql),/TRANSACTION_INSTALL_TARGET_NOT_EMPTY/);await db.exec('rollback');
    });
    console.log(`PASS: ${passed} isolated transaction-create SQL checks; synthetic PGlite only, no concurrency claim`);
  }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
