/* Fresh PG17 only. Exact non-superuser postgres creator grants, repaired Notes,
   full cutover and independent-backend races. Accepts NO existing DB target.
   ACK: CAP_ROLE_BOUNDARY_ACK=CREATE_DISPOSABLE_DOCKER_ONLY.
   Loopback-only ephemeral port for the external pg driver, tmpfs storage. */
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const {run}=require('../helpers/production-role-boundary-scenarios.cjs');
const f=require('../helpers/production-cutover-fixture.cjs');
const {transaction}=require('../helpers/transaction-create-fixture.cjs');
const validName=n=>/^cap-role-boundary-[a-f0-9]{12}$/.test(n);
function validateInvocation(env){
  if(env.CAP_ROLE_BOUNDARY_ACK!=='CREATE_DISPOSABLE_DOCKER_ONLY'
    ||env.CAP_ROLE_BOUNDARY_URL||env.CAP_ROLE_BOUNDARY_CONTAINER)throw Error('FRESH_DISPOSABLE_DOCKER_ONLY');
}
function docker(args){const r=spawnSync('docker',args,{encoding:'utf8',timeout:120000,windowsHide:true});
  if(r.error||r.status!==0)throw Error('DISPOSABLE_DOCKER_FAILED');return r.stdout.trim();}
async function main(env=process.env){
  validateInvocation(env);
  const {Client}=require(env.CAP_PG_PATH||'pg');
  const suffix=randomBytes(6).toString('hex'),name='cap-role-boundary-'+suffix;
  const database='cap_role_boundary_'+suffix,password='cap-role-boundary-test';
  let owned=false,stage='CREATE',checks=0,waits=0;const clients=[];
  try{
    docker(['create','--pull','never','--name',name,'--label','cap.role-boundary-test='+suffix,
      '--tmpfs','/var/lib/postgresql/data:rw','-p','127.0.0.1::5432',
      '-e','POSTGRES_PASSWORD='+password,'-e','POSTGRES_DB='+database,'postgres:17']);
    owned=true;docker(['start',name]);stage='WAIT_FOR_POSTGRES';
    const deadline=Date.now()+180000;
    for(;;){const r=spawnSync('docker',['exec',name,'psql','-X','-qAt','-U','postgres','-d',database,'-c','select 1'],
      {encoding:'utf8',timeout:10000,windowsHide:true});
      if(r.status===0&&r.stdout.trim()==='1')break;
      if(Date.now()>deadline)throw Error('POSTGRES_NOT_READY');await new Promise(r=>setTimeout(r,500));}
    const inspection=JSON.parse(docker(['inspect',name]))[0];
    assert.equal(inspection.Config.Labels['cap.role-boundary-test'],suffix);
    assert.ok(!inspection.Mounts.some(m=>['bind','volume'].includes(m.Type)));
    const bindings=inspection.NetworkSettings.Ports['5432/tcp'];
    assert.equal(bindings.length,1);assert.equal(bindings[0].HostIp,'127.0.0.1');
    assert.deepEqual(Object.keys(inspection.HostConfig.PortBindings),['5432/tcp']);
    const connect=async()=>{const c=new Client({host:'127.0.0.1',port:Number(bindings[0].HostPort),
      user:'postgres',password,database,connectionTimeoutMillis:10000});
      await c.connect();clients.push(c);return c;};
    const admin=await connect();
    const version=(await admin.query("select current_setting('server_version') v")).rows[0].v;
    assert.ok(version.startsWith('17.'));stage='NON_SUPERUSER_SCENARIOS';
    checks=await run({exec:sql=>admin.query(sql),query:(...args)=>admin.query(...args)});
    stage='CONCURRENT_REPAIRED_WRITERS';
    const a=await connect(),b=await connect();
    for(const c of [a,b])await c.query(`set role authenticated;set request.jwt.claim.sub='${f.ids.owner}';set lock_timeout='10s';`);
    const pids=await Promise.all([admin,a,b].map(async c=>(await c.query('select pg_backend_pid() v')).rows[0].v));
    assert.equal(new Set(pids).size,3);
    const overlap=async(first,second,rollback=false)=>{
      await a.query('begin');let pending;
      try{
        const winner=await first(a);
        pending=second(b);pending.catch(()=>{});
        const until=Date.now()+8000;
        for(;;){const n=(await admin.query('select cardinality(pg_blocking_pids($1)) v',[pids[2]])).rows[0].v;
          if(n){waits++;break;}if(Date.now()>until)throw Error('LOCK_WAIT_NOT_OBSERVED');
          await new Promise(r=>setTimeout(r,30));}
        await a.query(rollback?'rollback':'commit');return [winner,await pending];
      }finally{await a.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});}
    };
    const noteArgs=[f.uuid(71000),null,'create',
      {legacy_id:'creator-race',title:'Synthetic',body:'body',note_date:null},f.uuid(71001)];
    const note=(c,args)=>c.query('select public.cap_notes_change($1,$2,$3,$4,$5) v',args).then(r=>r.rows[0].v);
    let result=await overlap(c=>note(c,noteArgs),c=>note(c,noteArgs));
    assert.equal(result[0].status,'APPLIED');assert.equal(result[1].status,'ALREADY_APPLIED');checks++;
    const rollbackArgs=[f.uuid(71002),null,'create',noteArgs[3],f.uuid(71003)];
    result=await overlap(c=>note(c,rollbackArgs),c=>note(c,rollbackArgs),true);
    assert.equal(result[1].status,'APPLIED');checks++;
    await assert.rejects(note(b,[...noteArgs.slice(0,3),{...noteArgs[3],body:'changed'},noteArgs[4]]),
      e=>e.message==='OPERATION_REUSE_CONFLICT');checks++;
    const account=(await admin.query('select to_jsonb(a) v from public.accounts a where id=$1',[f.ids.cash])).rows[0].v;
    const tx=transaction(72000),op=f.uuid(72001);
    const create=c=>c.query('select public.cap_sync_transaction_create($1,$2,$3) v',[op,tx,account]).then(r=>r.rows[0].v);
    result=await overlap(create,create);
    assert.equal(result[0].status,'APPLIED');assert.equal(result[1].status,'ALREADY_APPLIED');checks++;
    assert.equal(Number((await admin.query('select balance v from public.accounts where id=$1',[f.ids.cash])).rows[0].v),95);
    await admin.query(`set role authenticated;set request.jwt.claim.sub='${f.ids.owner}'`);
    assert.equal((await admin.query('select public.cap_verify_production_sync_v1() v')).rows[0].v.ready,true);
    await admin.query('reset role');
    assert.equal((await admin.query(`select count(*)::int v from pg_auth_members
      where roleid in ('cap_notes_sidecar_writer'::regrole,'cap_transaction_writer'::regrole,'cap_sync_reader'::regrole)
        and member='postgres'::regrole and admin_option and not inherit_option and not set_option`)).rows[0].v,3);
    checks++;
    console.log(`PASS: ${checks} real PostgreSQL ${version} retained-membership/repair checks; ${waits} observed lock waits; fresh disposable cluster only`);
    return {checks,waits};
  }catch(_){throw Error('ROLE_BOUNDARY_TEST_FAILED_AT_'+stage);}
  finally{
    await Promise.allSettled(clients.map(c=>c.end()));
    if(owned){const i=JSON.parse(docker(['inspect',name]))[0];
      if(!validName(name)||i.Config.Labels['cap.role-boundary-test']!==suffix)throw Error('CLEANUP_GUARD');
      docker(['rm','--force',name]);}
  }
}
module.exports={validateInvocation,validName};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
