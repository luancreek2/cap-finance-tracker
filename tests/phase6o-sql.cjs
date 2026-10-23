/* Phase 6O SQL contract tests. Disposable PostgreSQL WASM only; no Supabase. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require(process.env.CAP_PGLITE_PATH||'@electric-sql/pglite');
const {ids,uuid,setupSql,installSql,transaction}=require('./helpers/transaction-create-fixture.cjs');
const raw=fs.readFileSync(`${__dirname}/../supabase_phase6o_transaction_update_delete.sql`,'utf8');
let passed=0;
const test=async(label,fn)=>{try{await fn();passed++;console.log('PASS '+label);}catch(e){e.message=label+': '+e.message;throw e;}};

(async()=>{
  const db=new PGlite();
  const admin=()=>db.exec('reset role');
  const as=async(owner=ids.owner,role='authenticated')=>{await admin();await db.exec(`set role ${role}`);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);};
  const row=async(table,id)=>(await db.query(`select to_jsonb(x) as v from public.${table} x where id=$1`,[id])).rows[0]?.v;
  const account=(id=ids.cash)=>row('accounts',id);
  const callCreate=(op,tx,expected)=>db.query('select public.cap_sync_transaction_create($1::uuid,$2::jsonb,$3::jsonb) as v',[op,tx,expected]).then(r=>r.rows[0].v);
  const callUpdate=(op,id,tx,expected,accounts)=>db.query('select public.cap_sync_transaction_update($1::uuid,$2::uuid,$3::jsonb,$4::jsonb,$5::jsonb) as v',[op,id,tx,expected,accounts]).then(r=>r.rows[0].v);
  const callDelete=(op,id,expected,accounts)=>db.query('select public.cap_sync_transaction_delete($1::uuid,$2::uuid,$3::jsonb,$4::jsonb) as v',[op,id,expected,accounts]).then(r=>r.rows[0].v);
  const receipt=async op=>{await admin();const r=(await db.query('select request from cap_sync_private.transaction_change_receipts where operation_id=$1',[op])).rows[0]?.request;await as();return r;};
  const grantState=async d=>(await d.query(`select
    has_table_privilege('authenticated','public.transactions','SELECT') as auth_select,
    has_any_column_privilege('authenticated','public.transactions','INSERT') as auth_insert,
    has_any_column_privilege('authenticated','public.transactions','UPDATE') as auth_update,
    has_table_privilege('authenticated','public.transactions','DELETE') as auth_delete,
    has_table_privilege('authenticated','public.transactions','TRUNCATE') as auth_truncate,
    has_any_column_privilege('anon','public.transactions','INSERT') as anon_insert,
    has_any_column_privilege('anon','public.transactions','UPDATE') as anon_update,
    has_table_privilege('anon','public.transactions','DELETE') as anon_delete,
    has_table_privilege('anon','public.transactions','TRUNCATE') as anon_truncate,
    has_table_privilege('cap_transaction_writer','public.transactions','INSERT') as writer_insert,
    has_any_column_privilege('cap_transaction_writer','public.transactions','UPDATE') as writer_update,
    has_table_privilege('cap_transaction_writer','public.transactions','DELETE') as writer_delete`)).rows[0];
  try{
    await test('migration is guarded, narrow and receipt-backed (static)',async()=>{
      assert.match(raw,/cap\.transaction_update_delete_install/);
      assert.match(raw,/TRANSACTION_UPDATE_DELETE_INSTALL_NOT_APPROVED/);
      assert.match(raw,/create table cap_sync_private\.transaction_change_receipts/);
      assert.match(raw,/enable row level security/);
      assert.match(raw,/force row level security/);
      assert.match(raw,/grant execute on function public\.cap_sync_transaction_update\([^)]*\) to authenticated/);
      assert.match(raw,/grant execute on function public\.cap_sync_transaction_delete\([^)]*\) to authenticated/);
      assert.doesNotMatch(raw,/grant\s+(update|delete)[^;]*public\.transactions\s+to\s+(anon|authenticated)/i);
      assert.doesNotMatch(raw,/to\s+(anon|authenticated)[^;]*public\.transactions/i);
      assert.match(raw,/revoke all on function public\.cap_sync_transaction_update\([^)]*\) from public, anon, authenticated/);
      assert.match(raw,/revoke insert, update, delete, truncate on public\.transactions/);
      assert.match(raw,/TRANSACTION_DIRECT_WRITE_CUTOVER_FAILED/);
      assert.match(raw,/PHASE6O_PERMISSION_CUTOVER_COMPLETE/);
      assert.match(raw,/'authenticated_update_denied'/);
      assert.match(raw,/'anon_insert_denied'/);
      assert.match(raw,/'update_public_execute_denied'/);
      assert.match(raw,/'receipt_direct_access_denied'/);
    });
    await test('temporary Supabase-compatible install grants are ordered and bounded (static)',async()=>{
      const firstOwner=raw.search(/alter function cap_sync_private\.cap_transaction_change_contract_ok\(\) owner to cap_transaction_writer/);
      const lastOwner=raw.lastIndexOf('alter function public.cap_verify_transaction_update_delete_v1() owner to cap_transaction_writer;');
      const boundary=raw.lastIndexOf('if not public.cap_role_boundary_ok(');
      const grantMembership=raw.indexOf("grant cap_transaction_writer to %I with admin false, inherit true, set true");
      const grantPublic=raw.indexOf('grant usage, create on schema public to cap_transaction_writer;');
      const grantPrivate=raw.indexOf('grant usage, create on schema cap_sync_private to cap_transaction_writer;');
      const revokePublic=raw.indexOf('revoke create on schema public from cap_transaction_writer;');
      const revokePrivate=raw.indexOf('revoke create on schema cap_sync_private from cap_transaction_writer;');
      const revokeMembership=raw.indexOf('revoke cap_transaction_writer from %I');
      assert.ok(firstOwner>0&&lastOwner>firstOwner&&boundary>lastOwner);
      assert.ok(grantMembership>0&&grantMembership<firstOwner);
      assert.ok(grantPublic>0&&grantPublic<firstOwner);
      assert.ok(grantPrivate>0&&grantPrivate<firstOwner);
      assert.ok(revokePublic>lastOwner&&revokePublic<boundary);
      assert.ok(revokePrivate>lastOwner&&revokePrivate<boundary);
      assert.ok(revokeMembership>lastOwner&&revokeMembership<boundary);
      assert.match(raw,/grant usage, create on schema cap_sync_private to cap_transaction_writer;/);
      assert.match(raw,/revoke create on schema cap_sync_private from cap_transaction_writer;/);
    });
    await db.exec(setupSql());
    await db.exec(installSql);
    await db.exec("set cap.transaction_update_delete_install='reviewed-draft-only';\n"+raw);

    await test('capability verifier is ready with exact contracts',async()=>{
      await as();
      const v=(await db.query('select public.cap_verify_transaction_update_delete_v1() as v')).rows[0].v;
      assert.equal(v.version,'CAP_TX_UPDATE_DELETE_READINESS_V1');
      assert.equal(v.ready,true);
      assert.equal(v.update_contract,'CAP_TX_UPDATE_CAS_RECEIPT_V1');
      assert.equal(v.delete_contract,'CAP_TX_DELETE_CAS_RECEIPT_V1');
      assert.equal(v.checks.create_receipt_delete_safe,true);
    });
    await test('permission cutover removes direct client writes and keeps writer/read paths',async()=>{
      const g=await grantState(db);
      assert.equal(g.auth_select,true);
      assert.equal(g.auth_insert,false);
      assert.equal(g.auth_update,false);
      assert.equal(g.auth_delete,false);
      assert.equal(g.auth_truncate,false);
      assert.equal(g.anon_insert,false);
      assert.equal(g.anon_update,false);
      assert.equal(g.anon_delete,false);
      assert.equal(g.anon_truncate,false);
      assert.equal(g.writer_insert,true);
      assert.equal(g.writer_update,true);
      assert.equal(g.writer_delete,true);
    });
    await test('temporary install privileges are absent from the committed state',async()=>{
      await admin();
      const r=(await db.query(`select
        has_schema_privilege('cap_transaction_writer','public','CREATE') as public_create,
        has_schema_privilege('cap_transaction_writer','cap_sync_private','CREATE') as private_create,
        exists(select 1 from pg_auth_members
          where roleid='cap_transaction_writer'::regrole and (inherit_option or set_option)) as temporary_membership`)).rows[0];
      assert.equal(r.public_create,false);
      assert.equal(r.private_create,false);
      assert.equal(r.temporary_membership,false);
    });
    await test('direct authenticated and anon transaction writes are denied',async()=>{
      const insert='insert into public.transactions (id,user_id,amount,transaction_date) values ($1,$2,-1,current_date)';
      await as();
      await assert.rejects(db.query(insert,[uuid(9001),ids.owner]),/permission denied/i);
      await assert.rejects(db.query('update public.transactions set amount=-1 where id=$1',[uuid(9002)]),/permission denied/i);
      await assert.rejects(db.query('delete from public.transactions where id=$1',[uuid(9003)]),/permission denied/i);
      await as(ids.owner,'anon');
      await assert.rejects(db.query(insert,[uuid(9004),ids.owner]),/permission denied/i);
      await assert.rejects(db.query('update public.transactions set amount=-1 where id=$1',[uuid(9005)]),/permission denied/i);
      await assert.rejects(db.query('delete from public.transactions where id=$1',[uuid(9006)]),/permission denied/i);
    });
    await test('verifier fails closed when a direct-write or execute bypass returns',async()=>{
      const verify=async()=>{await as();return (await db.query('select public.cap_verify_transaction_update_delete_v1() as v')).rows[0].v;};
      await admin();await db.exec('grant update on public.transactions to authenticated');
      let v=await verify();assert.equal(v.ready,false);assert.equal(v.checks.authenticated_update_denied,false);
      await admin();await db.exec('revoke update on public.transactions from authenticated');
      await db.exec('grant insert on public.transactions to anon');
      v=await verify();assert.equal(v.ready,false);assert.equal(v.checks.anon_insert_denied,false);
      await admin();await db.exec('revoke insert on public.transactions from anon');
      await db.exec('grant execute on function public.cap_sync_transaction_update(uuid,uuid,jsonb,jsonb,jsonb),public.cap_sync_transaction_delete(uuid,uuid,jsonb,jsonb) to anon');
      v=await verify();assert.equal(v.ready,false);assert.equal(v.checks.anon_update_execute,true);assert.equal(v.checks.anon_delete_execute,true);
      await admin();await db.exec('revoke execute on function public.cap_sync_transaction_update(uuid,uuid,jsonb,jsonb,jsonb),public.cap_sync_transaction_delete(uuid,uuid,jsonb,jsonb) from anon');
      await db.exec('grant execute on function public.cap_sync_transaction_update(uuid,uuid,jsonb,jsonb,jsonb) to public');
      v=await verify();assert.equal(v.ready,false);assert.equal(v.checks.update_public_execute_denied,false);
      await admin();await db.exec('revoke execute on function public.cap_sync_transaction_update(uuid,uuid,jsonb,jsonb,jsonb) from public');
      await db.exec('grant usage on schema cap_sync_private to authenticated;grant select on cap_sync_private.transaction_change_receipts to authenticated');
      v=await verify();assert.equal(v.ready,false);assert.equal(v.checks.receipt_direct_access_denied,false);
      await admin();await db.exec('revoke all on cap_sync_private.transaction_change_receipts from authenticated;revoke usage on schema cap_sync_private from authenticated');
      v=await verify();assert.equal(v.ready,true);
    });
    await test('anon cannot execute update or delete',async()=>{
      await as(ids.owner,'anon');
      await assert.rejects(db.query("select public.cap_sync_transaction_update($1::uuid,$2::uuid,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb)",[uuid(1),uuid(2)]),/permission denied/i);
      await assert.rejects(db.query("select public.cap_sync_transaction_delete($1::uuid,$2::uuid,'{}'::jsonb,'[]'::jsonb)",[uuid(1),uuid(2)]),/permission denied/i);
    });
    await test('authenticated cannot read change receipts',async()=>{
      await as();
      await assert.rejects(db.query('select * from cap_sync_private.transaction_change_receipts'),/permission denied/i);
    });

    const tx=transaction(3000,{amount:-5,title:'Original'});
    await test('create baseline transaction',async()=>{
      await as();
      const r=await callCreate(uuid(4000),tx,await account(ids.cash));
      assert.equal(r.status,'APPLIED');
      assert.equal(Number((await account(ids.cash)).balance),95);
    });
    await test('update amount applies the exact account delta',async()=>{
      await as();const beforeTx=await row('transactions',tx.id),beforeAccount=await account();
      const r=await callUpdate(uuid(4001),tx.id,{...tx,amount:-15,title:'Updated'},beforeTx,[beforeAccount]);
      assert.equal(r.status,'APPLIED');
      assert.equal(Number((await account()).balance),85);
      assert.equal(Number((await row('transactions',tx.id)).amount),-15);
    });
    await test('update replay is ALREADY_APPLIED and moves nothing',async()=>{
      const s=await receipt(uuid(4001));await as();
      const beforeTx=await row('transactions',tx.id),beforeAccount=await account();
      const r=await callUpdate(uuid(4001),s.transaction_id,s.transaction,s.expected_transaction,s.expected_accounts);
      assert.equal(r.status,'ALREADY_APPLIED');
      assert.deepEqual(await row('transactions',tx.id),beforeTx);
      assert.deepEqual(await account(),beforeAccount);
    });
    await test('stale expected transaction is CONFLICT and moves nothing',async()=>{
      await as();const beforeTx=await row('transactions',tx.id),beforeAccount=await account();
      const r=await callUpdate(uuid(4002),tx.id,{...tx,amount:-20},{...beforeTx,amount:-1},[beforeAccount]);
      assert.equal(r.status,'CONFLICT');
      assert.deepEqual(await row('transactions',tx.id),beforeTx);
      assert.deepEqual(await account(),beforeAccount);
    });
    await test('stale expected account is CONFLICT and moves nothing',async()=>{
      await as();const beforeTx=await row('transactions',tx.id),beforeAccount=await account();
      const r=await callUpdate(uuid(4003),tx.id,{...tx,amount:-20},beforeTx,[{...beforeAccount,balance:999}]);
      assert.equal(r.status,'CONFLICT');
      assert.deepEqual(await row('transactions',tx.id),beforeTx);
      assert.deepEqual(await account(),beforeAccount);
    });
    await test('metadata-only update needs no account CAS',async()=>{
      await as();const beforeTx=await row('transactions',tx.id),beforeAccount=await account();
      const r=await callUpdate(uuid(4004),tx.id,{...tx,amount:-15,title:'Renamed'},beforeTx,[]);
      assert.equal(r.status,'APPLIED');
      assert.equal((await row('transactions',tx.id)).title,'Renamed');
      assert.equal(Number((await account()).balance),85);
      assert.equal((await row('transactions',tx.id)).amount,-15);
    });
    await test('A debit -> B credit update restores A and applies B',async()=>{
      await as();const beforeTx=await row('transactions',tx.id),a=await account(ids.cash),b=await account(ids.savings);
      const r=await callUpdate(uuid(4005),tx.id,{...tx,amount:-15,account_id:ids.savings,title:'Moved',metadata:{acct:102}},beforeTx,[a,b]);
      assert.equal(r.status,'APPLIED');
      assert.equal(Number((await account(ids.cash)).balance),100);
      assert.equal(Number((await account(ids.savings)).balance),85);
      assert.equal((await row('transactions',tx.id)).account_id,ids.savings);
    });
    await test('delete reverses the account and removes the row',async()=>{
      await as();const beforeTx=await row('transactions',tx.id),b=await account(ids.savings);
      const r=await callDelete(uuid(4006),tx.id,beforeTx,[b]);
      assert.equal(r.status,'APPLIED');
      assert.equal(await row('transactions',tx.id),undefined);
      assert.equal(Number((await account(ids.savings)).balance),100);
    });
    await test('delete replay is ALREADY_APPLIED',async()=>{
      const s=await receipt(uuid(4006));await as();
      const r=await callDelete(uuid(4006),s.transaction_id,s.expected_transaction,s.expected_accounts);
      assert.equal(r.status,'ALREADY_APPLIED');
      assert.equal(await row('transactions',tx.id),undefined);
      assert.equal(Number((await account(ids.savings)).balance),100);
    });
    await test('delete of an already-gone transaction is CONFLICT',async()=>{
      const s=await receipt(uuid(4006));await as();
      const r=await callDelete(uuid(4007),tx.id,s.expected_transaction,s.expected_accounts);
      assert.equal(r.status,'CONFLICT');
    });
    await test('operation UUID is bound to the exact request',async()=>{
      const s=await receipt(uuid(4001));await as();
      await assert.rejects(callUpdate(uuid(4001),s.transaction_id,{...s.transaction,amount:-99},s.expected_transaction,s.expected_accounts),/OPERATION_REUSE_CONFLICT|TRANSACTION_UPDATE_FAILED/);
    });
    await test('credit charge create and delete reverse the signed effect',async()=>{
      const credit=transaction(3100,{account_id:ids.credit,amount:-100,title:'Credit charge'});
      await as();
      const created=await callCreate(uuid(4100),credit,await account(ids.credit));
      assert.equal(created.status,'APPLIED');
      assert.equal(Number((await account(ids.credit)).balance),200);
      const beforeTx=await row('transactions',credit.id),beforeAccount=await account(ids.credit);
      const deleted=await callDelete(uuid(4101),credit.id,beforeTx,[beforeAccount]);
      assert.equal(deleted.status,'APPLIED');
      assert.equal(await row('transactions',credit.id),undefined);
      assert.equal(Number((await account(ids.credit)).balance),100);
    });
    await test('failed install after revokes rolls back, then table/column/PUBLIC cutover succeeds',async()=>{
      const rb=new PGlite();
      try{
        await rb.exec(setupSql());await rb.exec(installSql);
        await rb.exec(`revoke insert,update,delete on public.transactions from authenticated;
          grant insert (amount),update (amount) on public.transactions to authenticated;
          grant update (amount) on public.transactions to anon;
          grant update on public.transactions to public;`);
        const before=await grantState(rb);
        const interrupted=raw.replace('-- PHASE6O_PERMISSION_CUTOVER_COMPLETE',()=>"do $$ begin raise exception 'INJECTED_PERMISSION_CUTOVER_FAILURE'; end $$;");
        await assert.rejects(rb.exec("set cap.transaction_update_delete_install='reviewed-draft-only';\n"+interrupted),/INJECTED_PERMISSION_CUTOVER_FAILURE/);
        await rb.exec('rollback');
        assert.deepEqual(await grantState(rb),before);
        assert.equal((await rb.query("select to_regclass('cap_sync_private.transaction_change_receipts') as v")).rows[0].v,null);
        assert.equal((await rb.query("select to_regprocedure('public.cap_verify_transaction_update_delete_v1()') as v")).rows[0].v,null);
        await rb.exec("set cap.transaction_update_delete_install='reviewed-draft-only';\n"+raw);
        const cut=await grantState(rb);
        assert.equal(cut.auth_select,true);
        assert.equal(cut.auth_insert,false);assert.equal(cut.auth_update,false);assert.equal(cut.auth_delete,false);
        assert.equal(cut.anon_insert,false);assert.equal(cut.anon_update,false);assert.equal(cut.anon_delete,false);
        assert.equal(cut.writer_insert,true);assert.equal(cut.writer_update,true);assert.equal(cut.writer_delete,true);
      }finally{await rb.close();}
    });
    await test('failed install after ownership transfers rolls back temporary grants, objects and restores the Phase 6N FK',async()=>{
      const rb=new PGlite();
      try{
        await rb.exec(setupSql());await rb.exec(installSql);
        const before=await grantState(rb);
        const marker='-- Remove every temporary install-only privilege before the boundary check.';
        assert.ok(raw.includes(marker));
        const interrupted=raw.replace(marker,()=>"do $$ begin raise exception 'INJECTED_OWNER_TRANSFER_FAILURE'; end $$;\n"+marker);
        await assert.rejects(rb.exec("set cap.transaction_update_delete_install='reviewed-draft-only';\n"+interrupted),/INJECTED_OWNER_TRANSFER_FAILURE/);
        await rb.exec('rollback');
        const r=(await rb.query(`select
          to_regclass('cap_sync_private.transaction_change_receipts') as change_table,
          to_regprocedure('public.cap_sync_transaction_update(uuid,uuid,jsonb,jsonb,jsonb)') as update_fn,
          to_regprocedure('public.cap_sync_transaction_delete(uuid,uuid,jsonb,jsonb)') as delete_fn,
          to_regprocedure('public.cap_verify_transaction_update_delete_v1()') as verify_fn,
          to_regprocedure('cap_sync_private.cap_transaction_change_contract_ok()') as contract_fn,
          has_schema_privilege('cap_transaction_writer','public','CREATE') as public_create,
          has_schema_privilege('cap_transaction_writer','cap_sync_private','CREATE') as private_create,
          has_any_column_privilege('cap_transaction_writer','public.transactions','UPDATE') as writer_update,
          has_table_privilege('cap_transaction_writer','public.transactions','DELETE') as writer_delete,
          exists(select 1 from pg_auth_members
            where roleid='cap_transaction_writer'::regrole and (inherit_option or set_option)) as temporary_membership,
          (select count(*) from pg_constraint
            where conrelid='cap_sync_private.transaction_create_receipts'::regclass
              and contype='f' and confrelid='public.transactions'::regclass
              and confdeltype='r') as restored_fk`)).rows[0];
        assert.equal(r.change_table,null);
        assert.equal(r.update_fn,null);
        assert.equal(r.delete_fn,null);
        assert.equal(r.verify_fn,null);
        assert.equal(r.contract_fn,null);
        assert.equal(r.public_create,false);
        assert.equal(r.private_create,false);
        assert.equal(r.writer_update,false);
        assert.equal(r.writer_delete,false);
        assert.equal(r.temporary_membership,false);
        assert.equal(Number(r.restored_fk),1);
        assert.deepEqual(await grantState(rb),before);
      }finally{await rb.close();}
    });
    console.log(`PASS: ${passed} isolated Phase 6O transaction update/delete SQL checks; disposable PGlite only, no concurrency claim`);
  }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
