/* Execute the actual production read adapter, mapper, validator, planner and
   CapOff exports against disposable fake IndexedDB. No invented CapOff APIs. */
const assert=require('node:assert/strict');
const {fixture,OWNER,clone}=require('./cloud-bootstrap.cjs');
const OLD_LOCAL=1792670414989001,OLD_CLOUD=1792670414989002,OLD_BOTH=1792670414989003,NEW=1792670414989004;
const idKey=r=>r.entity+':'+(r.supabase_id||r.row?.id||r.row?.user_id);
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}

async function presenceFixture(){
  const f=await fixture({production:s=>{
    s.tx.push({id:OLD_CLOUD,d:'2026-10-22',amt:-1,cat:'Food',acct:2,note:'PHASE 6N DEVICE TEST'});
    s.tx.push({id:OLD_BOTH,d:'2026-10-22',amt:-1,cat:'Food',acct:2,note:'DELETE SYNC TEST'});
  }});
  const boot=await f.run();assert.equal(boot.ok,true,boot.error);
  const c=f.c;
  c.S.tx=c.S.tx.filter(t=>![OLD_CLOUD,OLD_BOTH].includes(t.id));
  f.raw.records=f.raw.records.filter(r=>r.entity!=='transactions'||![String(OLD_LOCAL),String(OLD_BOTH)].includes(r.row.legacy_id));
  f.raw.record_count=f.raw.records.length;
  for(const e of Object.keys(f.raw.counts))f.raw.counts[e]=f.raw.records.filter(r=>r.entity===e).length;
  c.S.tx.push({id:NEW,d:'2026-10-23',amt:-1,cat:'Food',acct:2,note:'Test'});
  c.S.accts.find(a=>a.id===2).bal-=1;
  const initial=await c.CapOff.productionSyncSnapshot(),io=c.CapProductionSync.browserIO();
  const model=io.model(OWNER,initial.baseline);
  const tx=model.records.find(r=>r.entity==='transactions'&&r.row.legacy_id===String(NEW));
  const account=model.records.find(r=>r.entity==='accounts'&&r.row.legacy_id==='2');
  const old=n=>initial.baseline.records.find(r=>r.entity==='transactions'&&r.localId===String(n));
  const entries=[];
  for(const [i,r] of [tx,account,old(OLD_CLOUD),old(OLD_BOTH)].entries()){
    const deleted=i>1,entity=r.entity,stable=r.supabase_id||r.row.id;
    entries.push({id:'00000000-0000-4000-8000-'+String(8000+i).padStart(12,'0'),source:'production-sync-v1',user_id:OWNER,
      sequence:i+1,entity,record_key:entity+':'+stable,supabase_id:stable,local_id:deleted?r.localId:r.localId,
      operation:deleted?'delete':'upsert',kind:deleted?'transaction-delete':i===0?'transaction-create':'account-balance',
      payload:deleted?null:clone(r.row),fingerprint:deleted?null:await io.hash(entity,r.row),
      expectedFingerprint:deleted?r.contentFingerprint:null,queued_at:'2026-10-23T00:00:00.000Z',retry_count:0,last_error:null});
  }
  for(const e of entries)await c.CapOff.syncStore('outbox','put',e);
  // OFF fixture metadata prevents an automatic cycle in browser tests. The
  // paused runtime view below is a read-only mock, not an engine state change.
  await c.CapOff.syncStore('syncmeta','put',{version:1,owner:OWNER,enabled:false,sequence:4},'production-sync-v1');
  await c.CapOff.syncStore('kv','put',{json:JSON.stringify(c.S),mt:c.S._mt||0},'state');
  f.storage.set('pera',JSON.stringify(c.S));
  c.CapProductionSync.status=()=>({enabled:true,phase:'paused',pending:4,conflicts:0,reason:'PRESENCE_CHANGE_REQUIRES_REVIEW'});
  return {...f,io,entries,old,newId:tx.row.id};
}
module.exports={presenceFixture,OWNER,clone,idKey,OLD_LOCAL,OLD_CLOUD,OLD_BOTH,NEW};

if(require.main===module)(async()=>{
  await test('real CapOff API has the production snapshot reader but no invented diagnostic APIs',async()=>{
    const {c}=await presenceFixture();
    assert.equal(typeof c.CapOff.productionSyncSnapshot,'function');assert.equal(typeof c.CapOff.syncStore,'function');
    for(const name of ['snapshot','model','validateSnapshot'])assert.equal(c.CapOff[name],undefined,name);
    const io=c.CapProductionSync.browserIO();
    for(const name of ['snapshot','model','remote','hash'])assert.equal(typeof io[name],'function',name);
    assert.equal(typeof c.CapProductionSync.plan,'function');assert.equal(typeof c.CapProductionSync.validateSnapshot,'function');
    assert.equal(typeof c.CapProductionSync.inspectSyncPresence,'function');
  });
  await test('await inspectSyncPresence completes with four exact outbox records and three presence classes',async()=>{
    const f=await presenceFixture(),{c}=f;
    const before=JSON.stringify(await c.CapOff.productionSyncSnapshot()),memory=JSON.stringify(c.S),storage=JSON.stringify([...f.storage]);
    const raw=JSON.stringify(f.raw),snapshot=c.CapOff.productionSyncSnapshot;let reads=0,writes=0;
    c.CapOff.productionSyncSnapshot=()=>{reads++;return snapshot()};
    const deny=()=>{writes++;throw Error('Forbidden diagnostic mutation')};
    for(const name of ['productionSyncCommit','syncStore','persist','stamp','sync','requestSync','installBootstrapState','recoverBootstrap'])c.CapOff[name]=deny;
    for(const name of ['request','toggle','pause','authChanged'])c.CapProductionSync[name]=deny;
    c.CapSupabase.currentUser=deny;
    f.calls.length=0;
    const report=await c.CapProductionSync.inspectSyncPresence();
    assert.equal(report.error,undefined);assert.equal(reads,1);assert.equal(writes,0);
    assert.deepEqual(f.calls,['/rest/v1/rpc/cap_sync_snapshot_v1']);
    assert.equal(report.syncState.phase,'paused');assert.equal(report.syncState.reason,'PRESENCE_CHANGE_REQUIRES_REVIEW');
    assert.equal(report.syncState.outboxCount,4);assert.equal(report.syncState.baselineVersion,2);assert.equal(report.syncState.journal,'none');
    assert.equal(report.outbox.length,4);assert.deepEqual(report.outbox.map(e=>e.id),f.entries.map(e=>e.id));
    assert.equal(report.outbox[0].title,'Test');assert.equal(report.outbox[0].amount,-1);assert.equal(report.outbox[0].supabase_id,f.newId);
    assert.equal(report.outbox[1].kind,'account-balance');assert.equal(report.outbox[2].operation,'delete');
    assert.equal(report.blocked.length,3);assert.equal(report.planner.blocked,3);
    const byId=n=>report.blocked.find(b=>b.localId===String(n));
    assert.equal(byId(OLD_LOCAL).title,'FINAL CLOUD SYNC TEST');assert.equal(byId(OLD_LOCAL).local,'present');assert.equal(byId(OLD_LOCAL).cloud,'absent');
    assert.equal(byId(OLD_CLOUD).title,'PHASE 6N DEVICE TEST');assert.equal(byId(OLD_CLOUD).local,'absent');assert.equal(byId(OLD_CLOUD).cloud,'present');
    assert.equal(byId(OLD_BOTH).local,'absent');assert.equal(byId(OLD_BOTH).cloud,'absent');
    assert.equal(byId(OLD_BOTH).title,''); // Baseline stores fingerprints, not historical labels. Never invent one.
    assert.equal(report.phase6oDeleteAudit.locallyDeletedCloudPresent.length,1);
    assert.equal(report.phase6oDeleteAudit.locallyPresentCloudDeleted.length,1);
    assert.equal(report.phase6oDeleteAudit.missingBothRetainedByBaseline.length,1);
    for(const name of ['PHASE 6N DEVICE TEST','FINAL CLOUD SYNC TEST','DELETE SYNC TEST','Test'])assert.ok(Array.isArray(report.testLabelMatches[name]));
    assert.ok(report.testLabelMatches['PHASE 6N DEVICE TEST'].some(m=>m.blocked));
    assert.ok(report.testLabelMatches.Test.some(m=>m.source==='outbox'&&m.supabaseId===f.newId));
    assert.equal(JSON.stringify(await snapshot()),before);assert.equal(JSON.stringify(c.S),memory);
    assert.equal(JSON.stringify([...f.storage]),storage);assert.equal(JSON.stringify(f.raw),raw);
    // Compare report counts with the actual unchanged planner, not a mocked planner.
    const s=await snapshot(),remote=c.CapProductionSync.validateSnapshot(clone(f.raw),OWNER);
    const plan=await c.CapProductionSync.plan(s,f.io.model(OWNER,s.baseline),remote,f.io.hash);
    for(const name of ['pushes','pulls','blocked','conflicts','financial','converged'])assert.equal(report.planner[name],plan[name].length);
  });
  await test('all actual diagnostic IndexedDB transactions are readonly',async()=>{
    const {c}=await presenceFixture(),db=await new Promise((resolve,reject)=>{const q=c.indexedDB.open('cap-finance');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
    const prototype=Object.getPrototypeOf(db),original=prototype.transaction,modes=[];
    prototype.transaction=function(stores,mode,...rest){modes.push(mode||'readonly');assert.equal(mode||'readonly','readonly');return original.call(this,stores,mode,...rest)};
    try{await c.CapProductionSync.inspectSyncPresence();assert.ok(modes.length>0);assert.ok(modes.every(m=>m==='readonly'))}
    finally{prototype.transaction=original;db.close()}
  });
  await test('missing owner and missing baseline return bounded errors without cloud reads or initialization',async()=>{
    const {c,calls}=await presenceFixture();calls.length=0;
    c.CapOff.productionSyncSnapshot=async()=>({settings:null});
    assert.equal((await c.CapProductionSync.inspectSyncPresence()).error,'No sync owner');
    c.CapOff.productionSyncSnapshot=async()=>({settings:{owner:OWNER},baseline:null});
    assert.equal((await c.CapProductionSync.inspectSyncPresence()).error,'Baseline missing or corrupt');assert.equal(calls.length,0);
  });
  await test('malformed and foreign canonical snapshots fail through the real validator without writes',async()=>{
    for(const mutate of [raw=>({...raw,complete:false}),raw=>({...raw,owner:'foreign-owner'})]){
      const {c,raw}=await presenceFixture(),before=JSON.stringify(await c.CapOff.productionSyncSnapshot());
      c.CapSupabase.syncRequest=async()=>mutate(clone(raw));
      await assert.rejects(c.CapProductionSync.inspectSyncPresence(),/REMOTE_SNAPSHOT_INCOMPLETE/);
      assert.equal(JSON.stringify(await c.CapOff.productionSyncSnapshot()),before);
    }
  });
  console.log(`PASS: ${passed} executed diagnostic read-path checks; real adapters, mapper, validator, planner and readonly IDB`);
})().catch(e=>{console.error(e);process.exitCode=1});
