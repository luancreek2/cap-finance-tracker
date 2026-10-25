/* Phase 6O: real production planner, browser adapter, engine and fake IndexedDB.
   Synthetic fixtures only. No production access, commit, deploy or live test. */
const assert=require('node:assert/strict');
const {fixture,OWNER,clone}=require('./cloud-bootstrap.cjs');
const money=n=>Math.round(Number(n)*100)/100;
const effect=(type,amt)=>type==='credit'?-amt:Number(amt);
const keyOf=id=>'transactions:'+id;
let passed=0;
const test=async(name,fn)=>{try{await fn();passed++;console.log('PASS '+name);}catch(e){e.message=name+': '+e.message;throw e;}};

function localTx(f,id){return f.c.S.tx.find(t=>t.id===id);}
function localAcct(f,id){return f.c.S.accts.find(a=>a.id===id);}
function cloudTx(f,id){return f.raw.records.find(r=>r.entity==='transactions'&&r.row.legacy_id===String(id));}
function cloudAcct(f,id){return f.raw.records.find(r=>r.entity==='accounts'&&r.row.legacy_id===String(id));}
function editLocalTx(f,id,{amount,accountId,title}){
  const t=localTx(f,id);
  if(amount!==undefined)t.amt=amount;
  if(accountId!==undefined)t.acct=accountId;
  if(title!==undefined)t.note=title;
}
function editCloudTx(f,id,{amount,accountId,title}){
  const t=cloudTx(f,id).row;
  if(amount!==undefined){t.amount=amount;t.metadata.amt=amount;}
  if(accountId!==undefined){t.account_id=cloudAcct(f,accountId).row.id;t.metadata.acct=accountId;}
  if(title!==undefined){t.title=title;if(t.metadata.note!==undefined)t.metadata.note=title;}
}
function dropCloudTx(f,id){
  const i=f.raw.records.findIndex(r=>r.entity==='transactions'&&r.row.legacy_id===String(id));
  f.raw.records.splice(i,1);f.raw.record_count--;f.raw.counts.transactions--;
}
function exactUtcRows(value){
  const tx=value.records.find(r=>r.entity==='transactions'&&r.row.legacy_id==='2').row;
  tx.created_at='2026-10-20T07:08:30.123456+00:00';
  tx.updated_at='2026-10-22T12:00:17.654321+00:00';
  const acct=value.records.find(r=>r.entity==='accounts'&&r.row.legacy_id==='1').row;
  acct.updated_at='2026-10-22T12:00:18.000001+00:00';
}

async function setup(flags={},mutate=null){
  const f=await fixture(mutate?{mutate}:undefined);assert.equal((await f.run()).ok,true);
  f.io=f.c.CapProductionSync.browserIO();f.engine=f.c.CapProductionSync.createEngine(f.io);
  await f.engine.setEnabled(true);
  f.before=await f.io.snapshot();
  f.flags={...flags};f.writes=[];f.writeBodies=[];f.applied=new Map();f.applyCount=0;f.failWrites=flags.failWrites||0;f.failAfterApply=flags.failAfterApply||0;
  const base=f.c.CapSupabase.syncRequest;
  f.c.CapSupabase.syncRequest=async(path,opts={})=>{
    const body=opts.body?JSON.parse(opts.body):{};
    if(path==='/rest/v1/rpc/cap_verify_transaction_update_delete_v1'){
      return f.flags.capability===false
        ?{version:'CAP_TX_UPDATE_DELETE_READINESS_V1',ready:false}
        :{version:'CAP_TX_UPDATE_DELETE_READINESS_V1',ready:true,
          update_contract:'CAP_TX_UPDATE_CAS_RECEIPT_V1',delete_contract:'CAP_TX_DELETE_CAS_RECEIPT_V1'};
    }
    if(!path.includes('cap_sync_transaction_update')&&!path.includes('cap_sync_transaction_delete'))
      return base(path,opts);
    f.writes.push(path);f.writeBodies.push(clone(body));
    if(f.failWrites>0){f.failWrites--;throw Error('Injected network failure');}
    if(f.flags.forceConflict)return {status:'CONFLICT'};
    const previous=f.applied.get(body.p_operation_id);
    if(previous){
      if(JSON.stringify(previous.request)!==JSON.stringify(body))throw Error('OPERATION_REUSE_CONFLICT');
      return {...previous.result,status:'ALREADY_APPLIED'};
    }
    if(path.endsWith('cap_sync_transaction_update')){
      const tx=f.raw.records.find(r=>r.entity==='transactions'&&r.row.id===body.p_id);
      if(!tx||JSON.stringify(tx.row)!==JSON.stringify(body.p_expected_transaction))return {status:'CONFLICT'};
      for(const a of body.p_expected_accounts||[]){
        const cur=f.raw.records.find(r=>r.entity==='accounts'&&r.row.id===a.id);
        if(!cur||JSON.stringify(cur.row)!==JSON.stringify(a))return {status:'CONFLICT'};
      }
      const old=clone(tx.row),next=clone(body.p_transaction),oldAccount=cloudAcct(f,old.legacy_id);
      const oldRow=f.raw.records.find(r=>r.entity==='accounts'&&r.row.id===old.account_id);
      const newRow=f.raw.records.find(r=>r.entity==='accounts'&&r.row.id===next.account_id);
      if(old.account_id===next.account_id){
        oldRow.row.balance=money(oldRow.row.balance-effect(oldRow.row.account_type,old.amount)+effect(newRow.row.account_type,next.amount));
      }else{
        oldRow.row.balance=money(oldRow.row.balance-effect(oldRow.row.account_type,old.amount));
        newRow.row.balance=money(newRow.row.balance+effect(newRow.row.account_type,next.amount));
      }
      tx.row={...old,...next,updated_at:new Date().toISOString()};
      const result={status:'APPLIED',transaction:clone(tx.row),
        accounts:[clone(oldRow.row),...(old.account_id===next.account_id?[]:[clone(newRow.row)])]};
      f.applied.set(body.p_operation_id,{request:clone(body),result:clone(result)});f.applyCount++;
      if(f.failAfterApply>0){f.failAfterApply--;throw Error('Network dropped after commit');}
      return result;
    }
    const i=f.raw.records.findIndex(r=>r.entity==='transactions'&&r.row.id===body.p_id);
    if(i<0||JSON.stringify(f.raw.records[i].row)!==JSON.stringify(body.p_expected_transaction))return {status:'CONFLICT'};
    const old=clone(f.raw.records[i].row),acct=f.raw.records.find(r=>r.entity==='accounts'&&r.row.id===old.account_id);
    for(const a of body.p_expected_accounts||[]){
      const cur=f.raw.records.find(r=>r.entity==='accounts'&&r.row.id===a.id);
      if(!cur||JSON.stringify(cur.row)!==JSON.stringify(a))return {status:'CONFLICT'};
    }
    acct.row.balance=money(acct.row.balance-effect(acct.row.account_type,old.amount));
    f.raw.records.splice(i,1);f.raw.record_count--;f.raw.counts.transactions--;
    const result={status:'APPLIED',account:clone(acct.row)};
    f.applied.set(body.p_operation_id,{request:clone(body),result:clone(result)});f.applyCount++;
    if(f.failAfterApply>0){f.failAfterApply--;throw Error('Network dropped after commit');}
    return result;
  };
  f.plan=async()=>{
    const s=await f.io.snapshot(),model=f.io.model(OWNER,s.baseline);
    // Planner-only fixtures previously omitted capture. Local DELETE planning
    // now requires the exact intent that cycle() captures before planning.
    for(const b of s.baseline.records.filter(b=>b.entity==='transactions')){
      const k=keyOf(b.supabase_id);
      if(!model.records.some(r=>r.entity==='transactions'&&r.row.id===b.supabase_id)&&!s.outbox.some(e=>e.record_key===k))
        s.outbox.push({id:f.io.uuid(),source:'production-sync-v1',user_id:OWNER,sequence:s.outbox.length+1,
          entity:'transactions',record_key:k,supabase_id:b.supabase_id,local_id:String(b.localId),
          operation:'delete',kind:'transaction-delete',payload:null,fingerprint:null,expectedFingerprint:b.contentFingerprint});
    }
    return f.c.CapProductionSync.plan(s,model,f.raw.records,f.io.hash);
  };
  f.persist=()=>f.storage.set('pera',JSON.stringify(f.c.S));
  f.advance=()=>{f.io.now=()=>new Date(Date.now()+3600000).toISOString();};
  f.snapshot=()=>f.io.snapshot();
  return f;
}

module.exports={setup};
if(require.main===module)(async()=>{
  await test('update push amount down applies one atomic account delta',async()=>{
    const f=await setup();editLocalTx(f,2,{amount:-10});localAcct(f,1).bal=28441;f.persist();
    const p=await f.plan();assert.equal(p.financial.length,1);assert.equal(p.financial[0].kind,'transaction-update');
    assert.equal(p.financial[0].items.length,2);
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'idle');assert.equal(f.writes.length,1);
    assert.equal(localTx(f,2).amt,-10);assert.equal(localAcct(f,1).bal,28441);
    assert.equal(cloudTx(f,2).row.amount,-10);assert.equal(cloudAcct(f,1).row.balance,28441);
    assert.equal(s.outbox.length,0);assert.equal(s.journal,null);assert.equal(s.conflicts.length,0);
    assert.equal(s.baseline.records.length,44);assert.equal(f.applyCount,1);
  });
  await test('update RPC sends exact canonical UTC rows, never Date-normalized JSON',async()=>{
    const f=await setup({},exactUtcRows);exactUtcRows(f.raw);
    const tx=cloudTx(f,2).row,acct=cloudAcct(f,1).row;
    const expectedTx=JSON.stringify(tx),expectedAcct=JSON.stringify(acct);
    editLocalTx(f,2,{amount:-10});localAcct(f,1).bal=28441;f.persist();
    await f.engine.cycle();
    assert.equal(f.writes.length,1);
    const body=f.writeBodies[0];
    assert.equal(JSON.stringify(body.p_expected_transaction),expectedTx);
    assert.equal(JSON.stringify(body.p_expected_accounts),'['+expectedAcct+']');
    assert.equal(body.p_expected_transaction.created_at,'2026-10-20T07:08:30.123456+00:00');
    assert.equal(body.p_expected_transaction.updated_at,'2026-10-22T12:00:17.654321+00:00');
    assert.equal(body.p_expected_transaction.transaction_date,'2026-10-22');
    assert.equal(body.p_expected_accounts[0].updated_at,'2026-10-22T12:00:18.000001+00:00');
  });
  await test('delete RPC sends exact canonical UTC rows, never Date-normalized JSON',async()=>{
    const f=await setup({},exactUtcRows);exactUtcRows(f.raw);
    const tx=cloudTx(f,2).row,acct=cloudAcct(f,1).row;
    const expectedTx=JSON.stringify(tx),expectedAcct=JSON.stringify(acct);
    f.c.S.tx=f.c.S.tx.filter(t=>t.id!==2);localAcct(f,1).bal=28451;f.persist();
    await f.engine.cycle();
    assert.equal(f.writes.length,1);
    const body=f.writeBodies[0];
    assert.equal(JSON.stringify(body.p_expected_transaction),expectedTx);
    assert.equal(JSON.stringify(body.p_expected_accounts),'['+expectedAcct+']');
    assert.equal(body.p_expected_transaction.updated_at,'2026-10-22T12:00:17.654321+00:00');
    assert.equal(body.p_expected_transaction.transaction_date,'2026-10-22');
    assert.equal(body.p_expected_accounts[0].updated_at,'2026-10-22T12:00:18.000001+00:00');
  });
  await test('update push income amount increases the account',async()=>{
    const f=await setup();editLocalTx(f,1,{amount:36000,title:'Salary'});localAcct(f,1).bal=29449;f.persist();
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'idle');assert.equal(localTx(f,1).amt,36000);assert.equal(localAcct(f,1).bal,29449);
    assert.equal(cloudTx(f,1).row.amount,36000);assert.equal(cloudAcct(f,1).row.balance,29449);
    assert.equal(s.outbox.length,0);assert.equal(s.baseline.records.length,44);
  });
  await test('update push A debit -> B credit uses signed effects and moves both accounts',async()=>{
    const f=await setup();editLocalTx(f,2,{amount:-10,accountId:3});localAcct(f,1).bal=28451;localAcct(f,3).bal=12610;f.persist();
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'idle');assert.equal(localTx(f,2).acct,3);assert.equal(localTx(f,2).amt,-10);
    assert.equal(localAcct(f,1).bal,28451);assert.equal(localAcct(f,3).bal,12610);
    assert.equal(cloudTx(f,2).row.account_id,cloudAcct(f,3).row.id);
    assert.equal(cloudAcct(f,1).row.balance,28451);assert.equal(cloudAcct(f,3).row.balance,12610);
    assert.equal(s.outbox.length,0);assert.equal(s.baseline.records.length,44);
  });
  await test('metadata-only update needs no account CAS and keeps both balances',async()=>{
    const f=await setup();editLocalTx(f,2,{title:'Renamed'});f.persist();
    const p=await f.plan();assert.equal(p.financial.length,1);assert.equal(p.financial[0].items.length,1);
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'idle');assert.equal(localTx(f,2).note,'Renamed');
    assert.equal(localAcct(f,1).bal,28449);assert.equal(cloudAcct(f,1).row.balance,28449);
    assert.equal(cloudTx(f,2).row.title,'Renamed');assert.equal(s.outbox.length,0);assert.equal(s.baseline.records.length,44);
  });
  await test('delete push reverses the old effect and removes the cloud row',async()=>{
    const f=await setup();f.c.S.tx=f.c.S.tx.filter(t=>t.id!==2);localAcct(f,1).bal=28451;f.persist();
    const p=await f.plan();assert.equal(p.financial.length,1);assert.equal(p.financial[0].kind,'transaction-delete');
    assert.equal(p.financial[0].items[0].action,'delete');
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'idle');assert.equal(cloudTx(f,2),undefined);assert.equal(cloudAcct(f,1).row.balance,28451);
    assert.equal(localAcct(f,1).bal,28451);assert.equal(s.outbox.length,0);assert.equal(s.journal,null);
    assert.equal(s.baseline.records.length,43);
  });
  await test('cloud transaction update pulls the exact transaction and account atomically',async()=>{
    const f=await setup();editCloudTx(f,2,{amount:-10});cloudAcct(f,1).row.balance=28441;
    const before=JSON.stringify((await f.snapshot()).baseline);
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'idle');assert.equal(localTx(f,2).amt,-10);assert.equal(localAcct(f,1).bal,28441);
    assert.equal(s.journal,null);assert.equal(s.outbox.length,0);assert.equal(s.baseline.records.length,44);
    assert.notEqual(JSON.stringify(s.baseline),before);
    assert.equal(s.baseline.records.find(r=>r.entity==='transactions'&&r.supabase_id===cloudTx(f,2).row.id).contentFingerprint,
      await f.io.hash('transactions',f.io.model(OWNER,s.baseline).records.find(r=>r.entity==='transactions'&&r.row.id===cloudTx(f,2).row.id).row));
  });
  await test('cloud transaction delete pull removes the transaction and restores the account',async()=>{
    const f=await setup();dropCloudTx(f,2);cloudAcct(f,1).row.balance=28451;
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'idle');assert.equal(localTx(f,2),undefined);assert.equal(localAcct(f,1).bal,28451);
    assert.equal(s.journal,null);assert.equal(s.outbox.length,0);assert.equal(s.baseline.records.length,43);
    assert.equal(s.baseline.records.some(r=>r.entity==='transactions'&&r.supabase_id===cloudTx(f,2)?.row.id),false);
  });
  await test('local edit plus cloud edit is a recorded conflict, not last-write-wins',async()=>{
    const f=await setup();editLocalTx(f,2,{amount:-10});localAcct(f,1).bal=28441;f.persist();
    editCloudTx(f,2,{amount:-20});cloudAcct(f,1).row.balance=28429;
    const before=JSON.stringify((await f.snapshot()).baseline);
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'paused');assert.equal(f.engine.status().reason,'CONFLICT_REVIEW_REQUIRED');
    assert.equal(f.writes.length,0);assert.ok(s.conflicts.length>=1);
    assert.ok(s.conflicts.some(c=>c.key===keyOf(cloudTx(f,2).row.id)&&/LOCAL_AND_CLOUD/.test(c.reason)));
    assert.equal(JSON.stringify(s.baseline),before);
  });
  await test('local edit plus cloud delete is a recorded conflict',async()=>{
    const f=await setup();editLocalTx(f,2,{amount:-10});localAcct(f,1).bal=28441;f.persist();
    dropCloudTx(f,2);cloudAcct(f,1).row.balance=28451;
    const before=JSON.stringify((await f.snapshot()).baseline);
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'paused');assert.equal(f.writes.length,0);assert.ok(s.conflicts.length>=1);
    assert.equal(JSON.stringify(s.baseline),before);
  });
  await test('diverged affected account is a recorded conflict and writes nothing',async()=>{
    const f=await setup();editLocalTx(f,2,{amount:-10});localAcct(f,1).bal=28441;f.persist();
    cloudAcct(f,1).row.balance=28440;
    const before=JSON.stringify((await f.snapshot()).baseline);
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'paused');assert.equal(f.writes.length,0);assert.ok(s.conflicts.length>=1);
    assert.ok(s.conflicts.some(c=>/AFFECTED_ACCOUNT_DIVERGED|UNEXPECTED_ACCOUNT_CHANGE|LOCAL_AND_CLOUD/.test(c.reason)));
    assert.equal(JSON.stringify(s.baseline),before);
  });
  await test('metadata-only local edit plus independent account change is a conflict',async()=>{
    const f=await setup();editLocalTx(f,2,{title:'Renamed'});f.persist();cloudAcct(f,1).row.balance=28448;
    const before=JSON.stringify((await f.snapshot()).baseline);
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'paused');assert.equal(f.writes.length,0);assert.ok(s.conflicts.length>=1);
    assert.ok(s.conflicts.some(c=>/LOCAL_AND_CLOUD|UNEXPECTED_ACCOUNT_CHANGE/.test(c.reason)));
    assert.equal(JSON.stringify(s.baseline),before);
  });
  await test('unrelated cloud mutation cannot accompany a financial group',async()=>{
    const f=await setup();editCloudTx(f,2,{amount:-10});cloudAcct(f,1).row.balance=28441;
    f.raw.records.find(r=>r.entity==='goals').row.name='Edited';
    const before=JSON.stringify((await f.snapshot()).baseline);
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'paused');assert.equal(f.writes.length,0);
    assert.equal(JSON.stringify(s.baseline),before);assert.equal(localTx(f,2).amt,-2);
  });
  await test('two cloud transaction updates are Policy B blocked',async()=>{
    const f=await setup();editCloudTx(f,2,{amount:-10});editCloudTx(f,3,{amount:-10});
    cloudAcct(f,1).row.balance=28433;
    const before=JSON.stringify((await f.snapshot()).baseline);
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'paused');assert.equal(f.writes.length,0);
    assert.equal(JSON.stringify(s.baseline),before);assert.equal(localTx(f,2).amt,-2);assert.equal(localTx(f,3).amt,-3);
  });
  await test('pending local edit never enters the update path',async()=>{
    const f=await setup();localTx(f,2).amt=-10;localTx(f,2).status='pending';f.persist();
    const before=JSON.stringify((await f.snapshot()).baseline);
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'paused');assert.equal(f.writes.length,0);
    assert.equal(JSON.stringify(s.baseline),before);assert.notEqual(s.outbox.length,0);
  });
  await test('bill-linked local edit never enters the update path',async()=>{
    const f=await setup();editLocalTx(f,2,{amount:-10});localTx(f,2).billId=1;localAcct(f,1).bal=28441;f.persist();
    const before=JSON.stringify((await f.snapshot()).baseline);
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'paused');assert.equal(f.writes.length,0);
    assert.equal(JSON.stringify(s.baseline),before);assert.notEqual(s.outbox.length,0);
  });
  await test('missing 6O capability refuses the write before any journal or RPC',async()=>{
    const f=await setup({capability:false});editLocalTx(f,2,{amount:-10});localAcct(f,1).bal=28441;f.persist();
    const before=JSON.stringify((await f.snapshot()).baseline);
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'paused');assert.equal(f.engine.status().reason,'TRANSACTION_WRITE_CONTRACT_NOT_READY');
    assert.equal(f.writes.length,0);assert.equal(s.journal,null);assert.equal(JSON.stringify(s.baseline),before);
    assert.notEqual(s.outbox.length,0);
  });
  await test('server CAS conflict records inspectable data and retains the journal',async()=>{
    const f=await setup({forceConflict:true});editLocalTx(f,2,{amount:-10});localAcct(f,1).bal=28441;f.persist();
    const before=JSON.stringify((await f.snapshot()).baseline);
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'paused');assert.equal(f.engine.status().reason,'SERVER_CONFLICT');
    assert.ok(s.journal);assert.ok(s.conflicts.some(c=>c.kind==='server-cas-conflict'&&c.requiresFreshCloudReview===true));
    assert.equal(JSON.stringify(s.baseline),before);assert.equal(cloudTx(f,2).row.amount,-2);
  });
  await test('network rejection before commit retains the journal then retries once',async()=>{
    const f=await setup({failWrites:1});editLocalTx(f,2,{amount:-10});localAcct(f,1).bal=28441;f.persist();
    await f.engine.cycle();let s=await f.snapshot();
    assert.equal(f.engine.status().reason,'RECOVERABLE_FAILURE');assert.ok(s.journal);assert.equal(cloudTx(f,2).row.amount,-2);
    f.advance();await f.engine.cycle();s=await f.snapshot();
    assert.equal(f.engine.status().phase,'idle');assert.equal(s.journal,null);assert.equal(s.outbox.length,0);
    assert.equal(cloudTx(f,2).row.amount,-10);assert.equal(cloudAcct(f,1).row.balance,28441);assert.equal(f.applyCount,1);
  });
  await test('network drop after commit retries with ALREADY_APPLIED and never double-applies',async()=>{
    const f=await setup({failAfterApply:1});editLocalTx(f,2,{amount:-10});localAcct(f,1).bal=28441;f.persist();
    await f.engine.cycle();let s=await f.snapshot();
    assert.equal(f.engine.status().reason,'RECOVERABLE_FAILURE');assert.ok(s.journal);
    assert.equal(cloudTx(f,2).row.amount,-10);assert.equal(cloudAcct(f,1).row.balance,28441);assert.equal(f.applyCount,1);
    f.advance();await f.engine.cycle();s=await f.snapshot();
    assert.equal(f.engine.status().phase,'idle');assert.equal(s.journal,null);assert.equal(s.outbox.length,0);
    assert.equal(cloudTx(f,2).row.amount,-10);assert.equal(cloudAcct(f,1).row.balance,28441);assert.equal(f.applyCount,1);
  });
  await test('pull install failure rolls state, baseline and journal back to the before-image',async()=>{
    const f=await setup();editCloudTx(f,2,{amount:-10});cloudAcct(f,1).row.balance=28441;
    const before=await f.snapshot();const beforeJson=f.io.localJson();const install=f.io.installLocal;
    f.io.installLocal=(json,expected)=>{f.io.installLocal=install;throw Error('Injected install failure');};
    await f.engine.cycle();const s=await f.snapshot();
    assert.equal(f.engine.status().phase,'paused');assert.equal(f.engine.status().reason,'RECOVERABLE_FAILURE');
    assert.equal(f.io.localJson(),beforeJson);assert.equal(s.state.json,before.state.json);assert.equal(s.journal,null);
    assert.equal(JSON.stringify(s.baseline),JSON.stringify(before.baseline));
    assert.equal(localTx(f,2).amt,-2);assert.equal(localAcct(f,1).bal,28449);
  });
  console.log('PASS: '+passed+' Phase 6O transaction update/delete integration checks; real planner/browser adapter/engine, synthetic data only');
})().catch(error=>{console.error(error);process.exitCode=1;});
