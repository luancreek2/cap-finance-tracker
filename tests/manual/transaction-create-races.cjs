/* REAL PostgreSQL 17 races. Creates its OWN network-isolated, tmpfs Docker
   cluster; accepts no database URL/container target. Never uses existing labs.
   Explicit opt-in: CAP_TRANSACTION_RACE_ACK=CREATE_DISPOSABLE_DOCKER_ONLY.
   No npm dependency, no production connection, no host ports, no app storage. */
const assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const {ids,uuid,setupSql,installSql,transaction,callSql}=require('../helpers/transaction-create-fixture.cjs');
const ACK='CREATE_DISPOSABLE_DOCKER_ONLY';
const validName=n=>/^cap-tx-create-lab-[a-f0-9]{12}$/.test(n);
function validateInvocation(env=process.env){
  if(env.CAP_TRANSACTION_RACE_ACK!==ACK || env.CAP_TRANSACTION_RACE_URL || env.CAP_TRANSACTION_RACE_CONTAINER)
    throw Error('FRESH_DISPOSABLE_DOCKER_ONLY');
}
function docker(args,options={}){
  const r=spawnSync('docker',args,{encoding:'utf8',timeout:30000,windowsHide:true,...options});
  if(r.error||r.status!==0)throw Error('DISPOSABLE_DOCKER_COMMAND_FAILED');
  return r.stdout.trim();
}
class Session{
  constructor(name,database){
    if(!validName(name)||!/^cap_tx_create_[a-f0-9]{12}$/.test(database))throw Error('INVALID_DISPOSABLE_TARGET');
    this.buffer='';this.pending=null;this.closed=false;
    this.child=spawn('docker',['exec','-i',name,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],
      {stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>{
      this.buffer+=chunk;
      while(this.buffer.includes('\n')){
        const end=this.buffer.indexOf('\n'),line=this.buffer.slice(0,end).replace(/\r$/,'');this.buffer=this.buffer.slice(end+1);
        if(!this.pending)continue;
        if(line===this.pending.marker){const p=this.pending;this.pending=null;clearTimeout(p.timeout);p.resolve(p.rows.join('\n'));}
        else this.pending.rows.push(line);
      }
    });
    // Never print SQL/error bodies; only stage labels/fixed errors are reported.
    this.child.stderr.on('data',()=>{});
    this.child.on('error',()=>this.fail());this.child.on('close',()=>{this.closed=true;this.fail();});
  }
  fail(){if(this.pending){const p=this.pending;this.pending=null;clearTimeout(p.timeout);p.reject(Error('DISPOSABLE_SQL_SESSION_FAILED'));}}
  query(sql){
    if(this.pending||this.closed)throw Error('DISPOSABLE_SESSION_NOT_IDLE');
    return new Promise((resolve,reject)=>{
      const marker='CAP_DONE_'+randomBytes(10).toString('hex');
      const timeout=setTimeout(()=>{this.fail();this.child.kill();},15000);
      this.pending={resolve,reject,rows:[],marker,timeout};
      this.child.stdin.write(sql+'\n\\echo '+marker+'\n');
    });
  }
  async json(sql){return JSON.parse(await this.query(sql));}
  async close(){if(this.closed)return;await new Promise(resolve=>{const timeout=setTimeout(()=>{this.child.kill();resolve();},2000);
    this.child.once('close',()=>{clearTimeout(timeout);resolve();});this.child.stdin.end('\\q\n');});}
}

async function main(env=process.env){
  validateInvocation(env);
  const suffix=randomBytes(6).toString('hex'),name='cap-tx-create-lab-'+suffix,database='cap_tx_create_'+suffix;
  const label='cap.transaction-create-test='+suffix;let owned=false,stage='CREATE',checks=0,waits=0;
  const sessions=[];
  try{
    // Separate create/start so ownership can be established even if Docker
    // Desktop's CLI times out after successfully launching a container.
    try { docker(['create','--pull','never','--name',name,'--label',label,'--network','none',
      '--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_PASSWORD='+randomBytes(24).toString('hex'),
      '-e','POSTGRES_DB='+database,'postgres:17'],{timeout:120000}); }
    catch (_) {
      const created=JSON.parse(docker(['inspect',name]))[0];
      if(created.Config.Labels['cap.transaction-create-test']!==suffix)throw Error('DISPOSABLE_CREATION_FAILED');
    }
    owned=true;stage='START';
    try { docker(['start',name],{timeout:120000}); }
    catch (_) { if(!JSON.parse(docker(['inspect',name]))[0].State.Running)throw Error('DISPOSABLE_START_FAILED'); }
    stage='WAIT_FOR_FINAL_POSTGRES';
    const deadline=Date.now()+180000;
    while(true){
      // Require a real query against the target database and the final PID 1,
      // never initdb's temporary server, before opening persistent sessions.
      const process=spawnSync('docker',['exec',name,'cat','/proc/1/comm'],{encoding:'utf8',timeout:3000,windowsHide:true});
      const r=spawnSync('docker',['exec',name,'psql','-X','-qAt','-U','postgres','-d',database,'-c','select 1'],{encoding:'utf8',timeout:10000,windowsHide:true});
       if(process.status===0&&process.stdout.trim()==='postgres'&&r.status===0&&r.stdout.trim()==='1')break;
      if(Date.now()>deadline)throw Error('DISPOSABLE_POSTGRES_NOT_READY');await new Promise(r=>setTimeout(r,100));}
    stage='ISOLATION_INSPECTION';
    const inspection=JSON.parse(docker(['inspect',name]))[0];
    assert.equal(inspection.Config.Labels['cap.transaction-create-test'],suffix);
    assert.equal(inspection.HostConfig.NetworkMode,'none');
    assert.equal(Object.keys(inspection.HostConfig.PortBindings||{}).length,0);
    assert.equal((inspection.Mounts||[]).some(m=>m.Type==='bind'||m.Type==='volume'),false);
    const open=async(owner=null)=>{
      const s=new Session(name,database);sessions.push(s);
      await s.query("set statement_timeout='8s';set lock_timeout='6s';set idle_in_transaction_session_timeout='20s';set timezone='UTC';");
      if(owner)await s.query(`set role authenticated;set request.jwt.claim.sub='${owner}';`);
      return s;
    };
    stage='OPEN_ADMIN_SESSION';const admin=await open();stage='FIXTURE_INSTALL';
    await admin.query(setupSql());await admin.query(installSql);
    assert.equal(await admin.query("select has_schema_privilege('cap_transaction_writer','auth','USAGE');"),'f');
    const a=await open(ids.owner),b=await open(ids.owner);
    const pid=async s=>Number(await s.query('select pg_backend_pid();'));
    const pids=await Promise.all([admin,a,b].map(pid));assert.equal(new Set(pids).size,3);checks++;
    const server=await admin.json("select json_build_object('version',current_setting('server_version'),'database',current_database());");
    assert.ok(server.version.startsWith('17.'));assert.equal(server.database,database);
    stage='REAL_SERVER_CONTRACT_PRIVACY';
    const posture=await admin.json(`select jsonb_build_object(
      'auth_exec',has_function_privilege('authenticated','public.cap_sync_transaction_create(uuid,jsonb,jsonb)','EXECUTE'),
      'anon_exec',has_function_privilege('anon','public.cap_sync_transaction_create(uuid,jsonb,jsonb)','EXECUTE'),
      'auth_private',has_schema_privilege('authenticated','cap_sync_private','USAGE'),
      'writer_bypass',(select rolbypassrls or rolsuper or rolcanlogin from pg_roles where rolname='cap_transaction_writer'),
      'forced_rls',(select relforcerowsecurity from pg_class where oid='cap_sync_private.transaction_create_receipts'::regclass));`);
    assert.deepEqual(posture,{auth_exec:true,anon_exec:false,auth_private:false,writer_bypass:false,forced_rls:true});checks++;
    let serial=10000;
    const seed=async(type='cash')=>{
      const n=serial++,id=uuid(n);await admin.query(`insert into public.accounts(id,user_id,legacy_id,name,account_type,balance)
        values('${id}','${ids.owner}','${n}','Synthetic race account','${type}',100);`);
      return {id,expected:await admin.json(`select to_jsonb(a) from public.accounts a where id='${id}';`)};
    };
    const state=async(accountIds)=>admin.json(`select jsonb_build_object(
      'accounts',(select jsonb_agg(to_jsonb(a) order by id) from public.accounts a where id=any(array[${accountIds.map(id=>"'"+id+"'::uuid").join(',')}])),
      'transactions',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.transactions t where account_id=any(array[${accountIds.map(id=>"'"+id+"'::uuid").join(',')}])),
      'receipts',(select coalesce(jsonb_agg(to_jsonb(r) order by operation_id),'[]') from cap_sync_private.transaction_create_receipts r where account_id=any(array[${accountIds.map(id=>"'"+id+"'::uuid").join(',')}])));`);
    async function waitForBlock(observer,blocker,waiter){
      const end=Date.now()+4000;let found=false;
      while(Date.now()<end){const r=await observer.json(`select json_build_object('waiting',${blocker}=any(pg_blocking_pids(${waiter})));`);
        if(r.waiting){found=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
      assert.equal(found,true,'Actual PostgreSQL backend lock wait required');waits++;
    }
    async function race(label,{sameOperation=false,sameTransaction=false,sameLegacy=false,mismatch=false,rollback=false,otherAccount=false}={}){
      stage=label;const account=await seed(),second=otherAccount?await seed():account;
      const opA=uuid(serial++),opB=sameOperation?opA:uuid(serial++);
      const txA=transaction(serial++,{account_id:account.id});
      const txB={...txA,id:sameTransaction||sameOperation&&!otherAccount?txA.id:uuid(serial++),
        account_id:second.id,amount:mismatch?-7:txA.amount};
      if(txB.id!==txA.id&&!sameLegacy)txB.legacy_id=String(serial++);
      let pending;
      try{
        await a.query('begin;');await b.query('begin;');
        assert.equal((await a.json(callSql(opA,txA,account.expected))).status,'APPLIED');
        pending=b.json(callSql(opB,txB,second.expected)).then(value=>({value}),()=>({failed:true}));
        await waitForBlock(admin,pids[1],pids[2]);
        const invisible=await state([account.id,second.id]);
        assert.equal(invisible.transactions.length,0);assert.equal(invisible.receipts.length,0);
        assert.ok(invisible.accounts.every(x=>Number(x.balance)===100));
        await a.query(rollback?'rollback;':'commit;');
        const result=await pending;assert.equal(result.failed,undefined);
        if(rollback)assert.equal(result.value.status,'APPLIED');
        else if(sameOperation&&(mismatch||otherAccount))assert.equal(result.value.message,'OPERATION_REUSE_CONFLICT');
        else if(sameOperation)assert.equal(result.value.status,'ALREADY_APPLIED');
        else assert.equal(result.value.status,'CONFLICT');
        await b.query('commit;');
        const after=await state([account.id,second.id]);
        assert.equal(after.transactions.length,1);assert.equal(after.receipts.filter(r=>r.outcome==='APPLIED').length,1);
        assert.equal(after.receipts.length,!rollback&&!sameOperation?2:1);
        const target=rollback?second.id:account.id;
        assert.equal(Number(after.accounts.find(x=>x.id===target).balance),95);
        if(otherAccount)assert.equal(Number(after.accounts.find(x=>x.id!==target).balance),100);
        checks++;
      }finally{
        await a.query('rollback;').catch(()=>{});if(pending)await pending;
        await b.query('rollback;').catch(()=>{});
      }
    }
    await race('SAME_OPERATION_EXACT_REPLAY',{sameOperation:true});
    await race('SAME_OPERATION_PAYLOAD_MISMATCH',{sameOperation:true,mismatch:true});
    await race('DIFFERENT_OPERATIONS_SAME_TRANSACTION',{sameTransaction:true});
    await race('DIFFERENT_TRANSACTIONS_SAME_ACCOUNT');
    await race('ROLLBACK_RELEASES_EXACT_RETRY',{sameOperation:true,rollback:true});
    await race('ROLLBACK_RELEASES_OTHER_TRANSACTION',{rollback:true});
    await race('OPERATION_REUSE_DIFFERENT_RESOURCE',{sameOperation:true,otherAccount:true});
    await race('DIFFERENT_IDS_SAME_LEGACY',{sameLegacy:true,otherAccount:true});

    stage='RAW_ACCOUNT_WRITE_WINS_CAS';
    {
      const account=await seed(),op=uuid(serial++),tx=transaction(serial++,{account_id:account.id});let pending;
      try{
        await admin.query('begin;');await admin.query(`update public.accounts set balance=101 where id='${account.id}';`);
        pending=a.json(callSql(op,tx,account.expected)).then(value=>({value}),()=>({failed:true}));
        await waitForBlock(admin,pids[0],pids[1]);await admin.query('commit;');
        const r=await pending;assert.equal(r.value.status,'CONFLICT');
        const after=await state([account.id]);assert.equal(after.transactions.length,0);assert.equal(Number(after.accounts[0].balance),101);
        assert.equal(after.receipts.length,1);assert.equal(after.receipts[0].outcome,'CONFLICT');checks++;
      }finally{await admin.query('rollback;').catch(()=>{});if(pending)await pending;}
    }
    stage='CATEGORY_DELETION_RACE';
    {
      const account=await seed(),cat=uuid(serial++),op=uuid(serial++),tx=transaction(serial++,{account_id:account.id,category_id:cat});let pending;
      await admin.query(`insert into public.categories(id,user_id,legacy_id,name) values('${cat}','${ids.owner}','${serial}','Race fixture category');`);
      try{
        await admin.query('begin;');await admin.query(`delete from public.categories where id='${cat}';`);
        pending=a.json(callSql(op,tx,account.expected)).then(value=>({value}),()=>({failed:true}));
        await waitForBlock(admin,pids[0],pids[1]);await admin.query('commit;');
        const r=await pending;assert.equal(r.value.message,'RELATIONSHIP_CHANGED');
        const after=await state([account.id]);assert.equal(after.transactions.length,0);assert.equal(after.receipts.length,0);
        assert.equal(Number(after.accounts[0].balance),100);checks++;
      }finally{await admin.query('rollback;').catch(()=>{});if(pending)await pending;}
    }
    stage='FOREIGN_RAW_INSERT_UUID_COLLISION';
    {
      const account=await seed(),op=uuid(serial++),tx=transaction(serial++,{account_id:account.id});let pending;
      try{
        await admin.query('begin;');
        await admin.query(`insert into public.transactions(id,user_id,account_id,amount,transaction_date,status)
          values('${tx.id}','${ids.foreign}','${ids.foreignAccount}',-5,'2026-10-21','posted');`);
        pending=a.json(callSql(op,tx,account.expected)).then(value=>({value}),()=>({failed:true}));
        await waitForBlock(admin,pids[0],pids[1]);await admin.query('commit;');
        const r=await pending;assert.equal(r.value.status,'CONFLICT');
        const after=await state([account.id]);assert.equal(after.transactions.length,0);assert.equal(after.receipts.length,1);
        assert.equal(after.receipts[0].outcome,'CONFLICT');assert.equal(Number(after.accounts[0].balance),100);checks++;
      }finally{await admin.query('rollback;').catch(()=>{});if(pending)await pending;}
    }
    stage='LOST_APPLICATION_REPLY_RETRY';
    {
      const account=await seed(),op=uuid(serial++),tx=transaction(serial++,{account_id:account.id});
      // Autocommit completes on the server; deliberately discard the successful
      // reply at the application boundary. Retry from an independent backend.
      await a.json(callSql(op,tx,account.expected));
      const committed=await state([account.id]);
      assert.equal((await b.json(callSql(op,tx,account.expected))).status,'ALREADY_APPLIED');
      assert.deepEqual(await state([account.id]),committed);checks++;
      stage='REPLAY_AFTER_LATER_ACCOUNT_CHANGE';
      await admin.query(`update public.accounts set balance=123 where id='${account.id}';`);
      const later=await state([account.id]),result=await b.json(callSql(op,tx,account.expected));
      assert.equal(result.status,'ALREADY_APPLIED');assert.equal(Number(result.account.balance),95);
      assert.deepEqual(await state([account.id]),later);checks++;
    }
    stage='REAL_SERVER_RECEIPT_FAILURE_ROLLBACK';
    {
      const account=await seed(),op=uuid(serial++),tx=transaction(serial++,{account_id:account.id});
      await admin.query('alter table cap_sync_private.transaction_create_receipts add constraint fixture_reject check(false) not valid;');
      const before=await state([account.id]),r=await a.json(callSql(op,tx,account.expected));assert.equal(r.message,'TRANSACTION_CONSTRAINT_FAILED');
      assert.deepEqual(await state([account.id]),before);
      await admin.query('alter table cap_sync_private.transaction_create_receipts drop constraint fixture_reject;');
      assert.equal((await a.json(callSql(op,tx,account.expected))).status,'APPLIED');checks++;
    }
    stage='REAL_SERVER_CREDIT_IDEMPOTENCY';
    {
      const account=await seed('credit'),op=uuid(serial++),tx=transaction(serial++,{account_id:account.id,amount:-2.35});
      const r=await a.json(callSql(op,tx,account.expected));assert.equal(r.status,'APPLIED');assert.equal(Number(r.account.balance),102.35);
      const before=await state([account.id]);assert.equal((await b.json(callSql(op,tx,account.expected))).status,'ALREADY_APPLIED');
      assert.deepEqual(await state([account.id]),before);checks++;
    }
    stage='REAL_SERVER_POST_WRITE_VERIFICATION_ROLLBACK';
    {
      const account=await seed(),op=uuid(serial++),tx=transaction(serial++,{account_id:account.id});
      await admin.query(`create function public.fixture_bad_balance() returns trigger language plpgsql as $$begin new.balance=new.balance+1;return new;end$$;
        create trigger fixture_bad_balance before update on public.accounts for each row execute function public.fixture_bad_balance();`);
      const before=await state([account.id]),r=await a.json(callSql(op,tx,account.expected));
      assert.equal(r.message,'ACCOUNT_WRITE_NOT_VERIFIED');assert.deepEqual(await state([account.id]),before);
      await admin.query('drop trigger fixture_bad_balance on public.accounts;');checks++;
    }
    console.log(`PASS: ${checks} real PostgreSQL 17 transaction-create checks; ${waits} observed backend lock waits; fresh network-none Docker only`);
    return {checks,waits};
  }catch(_){throw Error('DISPOSABLE_TRANSACTION_TEST_FAILED_AT_'+stage);}
  finally{
    await Promise.all(sessions.map(s=>s.close().catch(()=>{})));
    if(owned){
      // Cleanup only the exact newly-created, uniquely-labelled container.
      const inspection=JSON.parse(docker(['inspect',name]))[0];
      if(!validName(name)||inspection.Config.Labels['cap.transaction-create-test']!==suffix)throw Error('DISPOSABLE_CLEANUP_GUARD_FAILED');
      docker(['rm','--force',name]);
    }
  }
}
module.exports={validateInvocation,validName};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
