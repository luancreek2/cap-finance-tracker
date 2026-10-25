/* Real planner, mapper and SHA-256; disposable fake IndexedDB. No live IO. */
const assert=require('node:assert/strict');
const {fixture,OWNER,clone}=require('./cloud-bootstrap.cjs');
const OLD=1792670414989001,NEW=1792670414989004;
let passed=0,failed=0,calls=0;
async function test(name,fn){
  try{await fn();passed++;console.log('PASS '+name);}
  catch(e){failed++;console.log('FAIL '+name+': '+e.message);}
}
async function setup(combined=false){
  const f=await fixture();assert.equal((await f.run()).ok,true);
  const io=f.c.CapProductionSync.browserIO(),s=clone(await io.snapshot());
  const b=s.baseline.records.find(r=>r.entity==='transactions'&&String(r.localId)===String(OLD));
  assert.ok(b);assert.match(b.contentFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(b.supabase_id,'05c168d0-8bad-5347-9198-fdbe9784c835');
  assert.equal(f.raw.records.find(r=>r.row.id===b.supabase_id).row.title,'FINAL CLOUD SYNC TEST');
  f.c.S.tx=f.c.S.tx.filter(t=>t.id!==OLD);f.c.S.accts.find(a=>a.id===1).bal+=1;
  let sequence=0;
  const entry=async(r,kind,base=null)=>{
    const del=kind==='transaction-delete',id=r.supabase_id||r.row.id;
    return {id:'00000000-0000-4000-8000-'+String(++sequence).padStart(12,'0'),sequence,
      source:'production-sync-v1',user_id:OWNER,entity:r.entity,record_key:r.entity+':'+id,
      supabase_id:id,local_id:String(r.localId),operation:del?'delete':'upsert',kind,
      payload:del?null:clone(r.row),fingerprint:del?null:await io.hash(r.entity,r.row),
      expectedFingerprint:base?.contentFingerprint||null,queued_at:'2026-10-23T00:00:00.000Z',retry_count:0,last_error:null};
  };
  const d=await entry(b,'transaction-delete',b);
  const account=io.model(OWNER,s.baseline).records.find(r=>r.entity==='accounts'&&r.row.legacy_id==='1');
  s.outbox=[d,await entry(account,'account-balance',s.baseline.records.find(r=>r.supabase_id===account.row.id))];
  if(combined){
    f.c.S.tx.push({id:NEW,d:'2026-10-23',amt:-1,cat:'Food',acct:2,note:'Test'});
    f.c.S.accts.find(a=>a.id===2).bal-=1;
    const m=io.model(OWNER,s.baseline);
    s.outbox.push(await entry(m.records.find(r=>r.entity==='transactions'&&r.row.legacy_id===String(NEW)),'transaction-create'));
    s.outbox.push(await entry(m.records.find(r=>r.entity==='accounts'&&r.row.legacy_id==='2'),'account-balance'));
  }
  const model=clone(io.model(OWNER,s.baseline)),remote=clone(f.raw.records);
  const run=async()=>{
    calls++;const before=JSON.stringify({s,model,remote});
    try{return await f.c.CapProductionSync.plan(s,model,remote,io.hash);}
    finally{assert.equal(JSON.stringify({s,model,remote}),before,'planner must be pure');}
  };
  return {f,io,s,b,d,model,remote,run,key:d.record_key};
}
function pending(p,x){
  assert.equal(p.blocked.some(i=>i.key===x.key&&i.reason==='PRESENCE_CHANGE_REQUIRES_REVIEW'),false,'presence block');
  assert.equal(p.pushes.some(i=>i.key===x.key),false,'DELETE became ordinary push');
  const g=p.financial.find(g=>g.kind==='transaction-delete');
  assert.ok(g,'missing existing Phase 6O financial DELETE route');
  assert.equal(g.items[0].key,x.key);assert.equal(g.items[0].action,'delete');
  assert.equal(g.items[0].local,null);assert.equal(g.items.length,2);
  assert.equal(g.items[1].local.entity,'accounts');
}
async function rejected(x){
  let p;try{p=await x.run();}catch(e){assert.ok(e.code,'must reject with production validation error');return;}
  assert.equal(p.financial.some(g=>g.kind==='transaction-delete'),false,'invalid intent authorized DELETE plan');
  assert.equal(p.pushes.some(i=>i.key===x.key),false,'invalid intent became ordinary push');
  assert.ok([...p.blocked,...p.conflicts].some(i=>i.key===x.key),'must block/conflict');
}
module.exports={setup};
if(require.main===module)(async()=>{
  await test('01 valid pending DELETE uses Phase 6O financial route',async()=>{const x=await setup();pending(await x.run(),x);});
  const cases=[
    ['02 no queued delete',x=>{x.s.outbox=x.s.outbox.filter(e=>e!==x.d);}],
    ['03 wrong record_key',x=>{x.d.record_key='transactions:wrong';}],
    ['04 wrong supabase_id',x=>{x.d.supabase_id='00000000-0000-4000-8000-000000000099';}],
    ['05 wrong owner',x=>{x.d.user_id='another-owner';}],
    ['06 wrong operation',x=>{x.d.operation='upsert';}],
    ['07 wrong kind',x=>{x.d.kind='transaction-create';}],
    // Real capture sets fingerprint:null; expectedFingerprint contains the CAS hash.
    ['08 missing CAS fingerprint',x=>{delete x.d.expectedFingerprint;}],
    ['09 stale CAS fingerprint',x=>{x.d.expectedFingerprint='0'.repeat(64);}],
    ['10 baseline identity mismatch',x=>{x.b.localId='123';}],
    ['11 cloud identity mismatch',x=>{x.remote.find(r=>r.row.id===x.b.supabase_id).row.legacy_id='123';}],
    ['12 cloud content changed',x=>{x.remote.find(r=>r.row.id===x.b.supabase_id).row.title='Changed remotely';}],
    ['13 malformed delete',x=>{delete x.d.id;delete x.d.sequence;delete x.d.local_id;delete x.d.expectedFingerprint;}],
    ['14 delete for another transaction',x=>{const b=x.s.baseline.records.find(r=>r.entity==='transactions'&&r!==x.b);Object.assign(x.d,{record_key:'transactions:'+b.supabase_id,supabase_id:b.supabase_id,local_id:String(b.localId),expectedFingerprint:b.contentFingerprint});}],
    ['15 delete for non-transaction entity',x=>{x.d.entity='accounts';}],
    ['16 wrong local_id',x=>{x.d.local_id='123';}]
  ];
  for(const [name,mutate] of cases)await test(name+' fails closed',async()=>{const x=await setup();mutate(x);await rejected(x);});
  await test('17 post-ack absence converges without repeated deletion/reversal',async()=>{
    const x=await setup();x.s.baseline.records=x.s.baseline.records.filter(r=>r!==x.b);
    const remote=x.remote.filter(r=>!(r.entity==='transactions'&&r.row.id===x.b.supabase_id));
    const a=x.model.records.find(r=>r.entity==='accounts'&&r.row.legacy_id==='1');
    remote.find(r=>r.entity==='accounts'&&r.row.id===a.row.id).row=clone(a.row);
    x.s.baseline.records.find(r=>r.entity==='accounts'&&r.supabase_id===a.row.id).contentFingerprint=await x.io.hash('accounts',a.row);
    x.s.outbox=[];calls++;
    const p=await x.f.c.CapProductionSync.plan(x.s,x.model,remote,x.io.hash);
    for(const k of ['blocked','conflicts','pushes','pulls','financial','converged'])assert.equal(p[k].length,0,k);
  });
  await test('18 DELETE plus accounts plus subsequent Test CREATE remain independent',async()=>{
    const x=await setup(true),before=JSON.stringify(x.s.outbox),p=await x.run();
    const create=x.s.outbox.find(e=>e.kind==='transaction-create');assert.ok(create);
    assert.equal(create.payload.title,'Test');assert.ok(create.sequence>x.d.sequence);
    assert.equal(JSON.stringify(x.s.outbox),before);
    assert.ok(p.pushes.some(i=>i.key===create.record_key),'Test not independently plannable');
    pending(p,x);assert.equal(p.financial[0].items.some(i=>i.key===create.record_key),false);
  });
  await test('19 real SHA-256 does not authenticate outbox local_id',async()=>{
    const x=await setup(),row=x.remote.find(r=>r.row.id===x.b.supabase_id).row;
    const before=await x.io.hash('transactions',row);x.d.local_id='123';
    assert.equal(await x.io.hash('transactions',row),before);assert.equal(before,x.b.contentFingerprint);
    assert.equal(x.d.fingerprint,null);assert.equal(x.d.expectedFingerprint,before);
  });
  await test('20 real engine DELETE acknowledges only its group; CREATE remains eligible',async()=>{
    const x=await setup(true),{setup:engineFixture}=require('./cloud-transaction-update-delete.cjs');
    const f=await engineFixture();
    f.c.S=clone(x.f.c.S);f.persist();
    for(const e of x.s.outbox)await f.c.CapOff.syncStore('outbox','put',clone(e));
    const s=await f.snapshot();
    await f.c.CapOff.syncStore('syncmeta','put',{...s.settings,sequence:4},'production-sync-v1');
    const createEntries=JSON.stringify(x.s.outbox.slice(2));
    await f.engine.cycle();
    assert.equal(f.engine.status().phase,'idle',f.engine.status().reason);
    assert.equal(f.writes.length,1);assert.ok(f.writes[0].endsWith('cap_sync_transaction_delete'));
    assert.equal(f.applyCount,1);
    const after=await f.snapshot();
    assert.equal(after.baseline.records.some(r=>r.entity==='transactions'&&r.supabase_id===x.b.supabase_id),false);
    assert.equal(f.raw.records.some(r=>r.entity==='transactions'&&r.row.id===x.b.supabase_id),false);
    assert.equal(f.c.S.tx.some(r=>r.id===OLD),false);
    assert.equal(after.journal,null);assert.equal(JSON.stringify(after.outbox),createEntries);
    assert.equal(f.raw.records.find(r=>r.entity==='accounts'&&r.row.legacy_id==='1').row.balance,28450);
    const p=await f.c.CapProductionSync.plan(after,f.io.model(OWNER,after.baseline),f.raw.records,f.io.hash);
    calls++;assert.equal(p.blocked.length,0);assert.equal(p.financial.length,0);
    assert.equal(p.pushes.some(i=>i.key===x.key),false);
    assert.ok(p.pushes.some(i=>i.local?.row.title==='Test'));
    assert.equal(f.applyCount,1,'planning must not reverse balance twice');
    const request=f.c.CapSupabase.syncRequest;let creates=0;
    f.c.CapSupabase.syncRequest=async(path,opts={})=>{
      if(!path.endsWith('/cap_sync_transaction_create'))return request(path,opts);
      const body=JSON.parse(opts.body),tx=body.p_transaction;
      const account=f.raw.records.find(r=>r.entity==='accounts'&&r.row.id===tx.account_id);
      assert.equal(JSON.stringify(account.row),JSON.stringify(body.p_expected_account));
      assert.equal(tx.title,'Test');assert.equal(tx.amount,-1);
      assert.equal(f.raw.records.some(r=>r.entity==='transactions'&&r.row.id===tx.id),false);
      account.row.balance+=tx.amount;
      f.raw.records.push({entity:'transactions',row:clone(tx)});f.raw.record_count++;f.raw.counts.transactions++;
      creates++;return {status:'APPLIED'};
    };
    await f.engine.cycle();const complete=await f.snapshot();
    assert.equal(f.engine.status().phase,'idle',f.engine.status().reason);
    assert.equal(creates,1);assert.equal(complete.outbox.length,0);assert.equal(complete.journal,null);
    assert.ok(complete.baseline.records.some(r=>r.supabase_id===x.s.outbox[2].supabase_id));
    await f.engine.cycle();assert.equal(creates,1);assert.equal(f.applyCount,1);
    assert.equal(f.raw.records.find(r=>r.entity==='accounts'&&r.row.legacy_id==='1').row.balance,28450);
  });
  await test('21 server CAS conflict preserves baseline, CREATE and all queued entries',async()=>{
    const x=await setup(true),{setup:engineFixture}=require('./cloud-transaction-update-delete.cjs');
    const f=await engineFixture({forceConflict:true});f.c.S=clone(x.f.c.S);f.persist();
    for(const e of x.s.outbox)await f.c.CapOff.syncStore('outbox','put',clone(e));
    const s=await f.snapshot();
    await f.c.CapOff.syncStore('syncmeta','put',{...s.settings,sequence:4},'production-sync-v1');
    const before=await f.snapshot();await f.engine.cycle();const after=await f.snapshot();
    assert.equal(f.engine.status().reason,'SERVER_CONFLICT');assert.equal(f.applyCount,0);
    assert.equal(JSON.stringify(after.baseline),JSON.stringify(before.baseline));
    assert.equal(JSON.stringify(after.outbox),JSON.stringify(before.outbox));
    assert.ok(f.raw.records.some(r=>r.row.id===x.b.supabase_id));
    assert.equal(f.raw.records.find(r=>r.entity==='accounts'&&r.row.legacy_id==='1').row.balance,28449);
  });
  await test('22 shared-account aggregate balance is not guessed',async()=>{
    const x=await setup(true);x.f.c.S.tx.find(t=>t.id===NEW).acct=1;
    x.f.c.S.accts.find(a=>a.id===1).bal-=1;x.f.c.S.accts.find(a=>a.id===2).bal+=1;
    const model=clone(x.io.model(OWNER,x.s.baseline));x.model.records.splice(0,x.model.records.length,...model.records);
    const tx=x.model.records.find(r=>r.entity==='transactions'&&r.row.legacy_id===String(NEW));
    const a=x.model.records.find(r=>r.entity==='accounts'&&r.row.legacy_id==='1');
    for(const [e,r] of [[x.s.outbox[2],tx],[x.s.outbox[3],a]])Object.assign(e,{
      record_key:r.entity+':'+r.row.id,supabase_id:r.row.id,local_id:String(r.localId),
      payload:clone(r.row),fingerprint:await x.io.hash(r.entity,r.row)});
    await rejected(x);
  });
  await test('23 older valid DELETE cannot override a newer non-delete version',async()=>{
    const x=await setup();x.s.outbox.push({...clone(x.d),id:'00000000-0000-4000-8000-000000000099',sequence:5,operation:'upsert'});
    await rejected(x);
  });
  console.log(`SUMMARY: ${passed} passed, ${failed} failed, ${passed+failed} checks; ${calls} real planner calls`);
  if(!failed)console.log(`PASS: ${passed} planner execution checks`);
  if(failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
