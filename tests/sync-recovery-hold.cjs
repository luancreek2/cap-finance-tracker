/* Real production event wiring, storage gate, planner and engine. Synthetic IO only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {setup:queueFixture}=require('./sync-planner-presence-execution.cjs');
const {setup:engineFixture}=require('./cloud-transaction-update-delete.cjs');
const {OWNER,clone}=require('./cloud-bootstrap.cjs');
const KEY='cap-sync-recovery-phase6o-v1',source=fs.readFileSync(__dirname+'/../js/sync-production.js','utf8');
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
async function fixture(released=false){
  const q=await queueFixture(true),f=await engineFixture();f.c.S=clone(q.f.c.S);f.persist();
  const request=f.c.CapSupabase.syncRequest;f.creates=0;
  f.c.CapSupabase.syncRequest=async(path,opts={})=>{
    if(!path.endsWith('/cap_sync_transaction_create'))return request(path,opts);
    const body=JSON.parse(opts.body),tx=body.p_transaction;
    const account=f.raw.records.find(r=>r.entity==='accounts'&&r.row.id===tx.account_id);
    assert.equal(JSON.stringify(account.row),JSON.stringify(body.p_expected_account));
    assert.equal(f.raw.records.some(r=>r.entity==='transactions'&&r.row.id===tx.id),false);
    account.row.balance+=tx.amount;f.raw.records.push({entity:'transactions',row:clone(tx)});
    f.raw.record_count++;f.raw.counts.transactions++;f.creates++;return {status:'APPLIED'};
  };
  for(const e of q.s.outbox)await f.c.CapOff.syncStore('outbox','put',clone(e));
  const s=await f.snapshot();
  await f.c.CapOff.syncStore('syncmeta','put',{...s.settings,sequence:4},'production-sync-v1');
  if(!released)f.storage.delete(KEY);
  const win=new Map(),doc=new Map(),sw=new Map(),timeouts=new Map(),intervals=[];
  f.c.document.getElementById=()=>null;
  let n=0;
  f.c.addEventListener=(name,fn)=>win.set(name,fn);
  f.c.document.addEventListener=(name,fn)=>doc.set(name,fn);
  f.c.navigator.serviceWorker={addEventListener:(name,fn)=>sw.set(name,fn)};
  f.c.setTimeout=fn=>{timeouts.set(++n,fn);return n;};f.c.clearTimeout=id=>timeouts.delete(id);
  f.c.setInterval=(fn,ms)=>{assert.equal(ms,15000);intervals.push(fn);};
  f.c.developerOptionsEnabled=()=>true;f.c.confirm=()=>true;
  const load=async()=>{timeouts.clear();intervals.length=0;vm.runInContext(source,f.c);await doc.get('DOMContentLoaded')();};
  const flush=async()=>{const work=[...timeouts.values()];timeouts.clear();for(const fn of work)await fn();};
  const hold=()=>f.storage.set(KEY,JSON.stringify({version:1,owner:OWNER,state:'held'}));
  const before=clone(await f.snapshot());await load();
  const unchanged=async()=>{
    const after=await f.snapshot();
    for(const k of ['outbox','baseline','journal','state'])assert.equal(JSON.stringify(after[k]),JSON.stringify(before[k]),k);
    assert.equal(f.writes.length,0);assert.equal(f.applyCount,0);assert.equal(f.creates,0);
  };
  return Object.assign(f,{win,doc,sw,intervals,timeouts,flush,hold,load,unchanged,before});
}
(async()=>{
  const events=[['A boot',()=>{}],['B online',f=>f.win.get('online')()],['C pageshow',f=>f.win.get('pageshow')()],
    ['D visibility',f=>f.doc.get('visibilitychange')()],['E service-worker message',f=>f.sw.get('message')({data:{type:'cap-sync'}})],
    ['F visible 15-second timer',f=>f.intervals.at(-1)()]];
  for(const [name,trigger] of events)await test(name+' while held: no sends or financial-state mutations',async()=>{
    const f=await fixture();trigger(f);await f.flush();await f.unchanged();assert.equal(f.timeouts.size,0);
  });
  await test('G durable hold survives module reload and new engine',async()=>{
    const f=await fixture();f.hold();await f.load();await f.flush();
    const engine=f.c.CapProductionSync.createEngine(f.c.CapProductionSync.browserIO());await engine.cycle();
    assert.equal(engine.status().reason,'RECOVERY_HOLD');await f.unchanged();
  });
  await test('H missing, malformed, foreign-owner and unreadable gate fail closed',async()=>{
    for(const value of [null,'not-json',JSON.stringify({version:1,owner:'foreign',state:'released'}),'unreadable']){
      const f=await fixture();if(value!==null)f.storage.set(KEY,value);
      if(value==='unreadable'){const read=f.c.localStorage.getItem;f.c.localStorage.getItem=k=>{if(k===KEY)throw Error('Storage unavailable');return read(k);};}
      f.c.CapProductionSync.request();await f.flush();await f.engine.cycle();await f.unchanged();
    }
  });
  await test('I scheduled request cannot send after a hold activates',async()=>{
    const f=await fixture(true);assert.equal(f.timeouts.size,1);f.hold();await f.flush();await f.unchanged();
  });
  await test('J valid DELETE and account reversal are not sent while held',async()=>{
    const f=await fixture();await f.engine.cycle();await f.unchanged();
    assert.ok(f.before.outbox.some(e=>e.kind==='transaction-delete'));
  });
  await test('K Test CREATE remains preserved while held',async()=>{
    const f=await fixture();await f.engine.cycle();await f.unchanged();
    assert.equal(f.before.outbox.find(e=>e.kind==='transaction-create').payload.title,'Test');
  });
  await test('L resume requires Developer Options, confirmation and durable verified release',async()=>{
    const f=await fixture();f.c.developerOptionsEnabled=()=>false;
    assert.equal(await f.c.CapProductionSync.resumeHeldSync(),false);assert.equal(f.storage.has(KEY),false);
    f.c.developerOptionsEnabled=()=>true;let message='';f.c.confirm=m=>{message=m;return false;};
    assert.equal(await f.c.CapProductionSync.resumeHeldSync(),false);assert.match(message,/Queued cloud operations/);
    await f.unchanged();assert.equal(f.storage.has(KEY),false);
    f.c.confirm=()=>true;assert.equal(await f.c.CapProductionSync.resumeHeldSync(),true);
    assert.deepEqual(JSON.parse(f.storage.get(KEY)),{version:1,owner:OWNER,state:'released'});
    assert.equal(f.writes.length,0,'resume schedules; does not bypass engine');
  });
  await test('M explicit resume uses the preserved Phase 6O DELETE/ack path',async()=>{
    const f=await fixture();assert.equal(await f.c.CapProductionSync.resumeHeldSync(),true);await f.flush();
    assert.equal(f.writes.length,1);assert.ok(f.writes[0].endsWith('/cap_sync_transaction_delete'));
    const after=await f.snapshot();assert.equal(after.outbox.length,2);
    assert.ok(after.outbox.some(e=>e.kind==='transaction-create'));assert.equal(after.journal,null);
  });
  await test('N release survives reload; future automatic events schedule normally',async()=>{
    const f=await fixture();await f.c.CapProductionSync.resumeHeldSync();await f.load();
    assert.equal(f.c.CapProductionSync.recoveryHeld(),false);
    f.win.get('online')();assert.equal(f.timeouts.size,1);await f.flush();assert.equal(f.writes.length,1);
    f.intervals.at(-1)();await f.flush();assert.equal(f.creates,1);
    assert.equal((await f.snapshot()).outbox.length,0);
    f.win.get('pageshow')();await f.flush();assert.equal(f.creates,1);assert.equal(f.applyCount,1);
  });
  await test('O hold activated during pre-send capability check prevents dispatch',async()=>{
    const f=await fixture(true);f.io.capabilities=async()=>{f.hold();return true;};
    await f.engine.cycle();assert.equal(f.writes.length,0);
    const after=await f.snapshot();assert.equal(JSON.stringify(after.baseline),JSON.stringify(f.before.baseline));
    assert.equal(JSON.stringify(after.outbox),JSON.stringify(f.before.outbox));
  });
  await test('P hold before acknowledgement preserves journal, baseline and all queued work',async()=>{
    const f=await fixture(true),remote=f.io.remote;
    f.io.remote=async owner=>{const r=await remote(owner);if(f.writes.length)f.hold();return r;};
    await f.engine.cycle();const after=await f.snapshot();
    assert.equal(f.writes.length,1,'RPC dispatched before activation cannot be recalled');
    assert.equal(JSON.stringify(after.baseline),JSON.stringify(f.before.baseline));
    assert.equal(JSON.stringify(after.outbox),JSON.stringify(f.before.outbox));assert.ok(after.journal);
  });
  await test('Q failed release persistence does not enable execution',async()=>{
    const f=await fixture(),write=f.c.localStorage.setItem;
    f.c.localStorage.setItem=(k,v)=>{if(k===KEY)throw Error('Storage write refused');return write(k,v);};
    await assert.rejects(f.c.CapProductionSync.resumeHeldSync());
    assert.equal(f.c.CapProductionSync.recoveryHeld(),true);await f.engine.cycle();await f.unchanged();
  });
  await test('R direct browser transport rejects every write kind while held',async()=>{
    const f=await fixture();
    for(const kind of ['transaction-create','transaction-update','transaction-delete','note-update'])
      assert.throws(()=>f.io.write({kind}),e=>e.code==='RECOVERY_HOLD');
    await f.unchanged();
  });
  console.log(`PASS: ${passed} persistent recovery hold execution checks`);
})().catch(e=>{console.error(e);process.exitCode=1;});
