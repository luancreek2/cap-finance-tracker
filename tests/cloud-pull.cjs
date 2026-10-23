/* Phase 6N: real planner, browser mapper and atomic fake IndexedDB adapters.
   Synthetic 44-row fixture only. Transport rejects every cloud write. */
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {fixture,OWNER,clone}=require('./cloud-bootstrap.cjs');
let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const account=(f,id=1)=>f.raw.records.find(r=>r.entity==='accounts'&&r.row.legacy_id===String(id));
async function setup(){
  const f=await fixture();assert.equal((await f.run()).ok,true);
  f.io=f.c.CapProductionSync.browserIO();
  f.engine=f.c.CapProductionSync.createEngine(f.io);
  await f.engine.setEnabled(true);
  f.before=await f.io.snapshot();f.json=f.io.localJson();f.calls.length=0;
  f.add=(amount=-100,id=1,legacy=9001)=>{
    const state=clone(f.c.S),a=state.accts.find(a=>a.id===id);
    a.bal=Math.round((a.bal+(a.type==='credit'?-amount:amount))*100)/100;
    state.tx.push({id:legacy,d:'2026-10-23',amt:amount,cat:amount<0?'Food':'Salary',acct:id,note:'Synthetic receiving-device fixture'});
    const p=f.c.buildSupabaseMigrationPlan(f.c.migrationPrepare(state),OWNER,state);
    const tx=clone(p.tables.find(([e])=>e==='transactions')[1].find(t=>t.legacy_id===String(legacy)));
    f.raw.records.push({entity:'transactions',row:tx});account(f,id).row.balance=a.bal;
    f.raw.record_count++;f.raw.counts.transactions++;
    return tx;
  };
  f.plan=async()=>{const s=await f.io.snapshot();return f.c.CapProductionSync.plan(s,f.io.model(OWNER,s.baseline),f.raw.records,f.io.hash);};
  f.unchanged=async()=>{const s=await f.io.snapshot();assert.equal(f.io.localJson(),f.json);assert.equal(f.storage.get('pera'),f.json);assert.deepEqual(s.baseline,f.before.baseline);assert.equal(s.state.json,f.before.state.json);};
  return f;
}
async function refused(mutate){const f=await setup();const tx=f.add();await mutate(f,tx);
  if(f.io.localJson()!==f.json){f.json=f.io.localJson();f.storage.set('pera',f.json);f.before.state={json:f.json,mt:0};await f.c.CapOff.syncStore('kv','put',f.before.state,'state');}
  const p=await f.plan();assert.ok(!p.pulls.some(g=>g.kind==='transaction-pull'));await f.engine.cycle();await f.unchanged();}
(async()=>{
  await test('standalone production planner reproduction of original txKey TDZ',async()=>{
    // No browserIO/testing API dependency: this executes the same public plan()
    // entry point as the original crashing reproduction, with real UUIDs/hashes.
    const f=await fixture();assert.equal((await f.run()).ok,true);const s=await f.c.CapOff.productionSyncSnapshot();
    const before=clone(f.raw.records),state=clone(f.c.S);state.tx.push({id:9001,d:'2026-10-23',amt:-100,cat:'Food',acct:1,note:'Synthetic TDZ regression'});
    const p=f.c.buildSupabaseMigrationPlan(f.c.migrationPrepare(state),OWNER,state);
    const tx=p.tables.find(([e])=>e==='transactions')[1].find(r=>r.legacy_id==='9001');
    f.raw.records.push({entity:'transactions',row:tx});account(f).row.balance-=100;
    const result=await f.c.CapProductionSync.plan(s,{records:before},f.raw.records,f.c.CapSync.fingerprintRow);
    assert.equal(result.pulls[0]?.kind,'transaction-pull');assert.equal(result.pulls[0].items[0].base,null);assert.equal(result.blocked.length,0);
    // Negative control recreates the original inner const shadowing exactly.
    const source=fs.readFileSync(__dirname+'/../js/sync-production.js','utf8');
    const broken=source.replace('const txCloud = cloud.get(txKey);',"const txCloud = cloud.get(txKey); const txKey = 'transactions:' + txCloud.row.id;");
    assert.notEqual(broken,source);vm.runInContext(broken,f.c);
    await assert.rejects(()=>f.c.CapProductionSync.plan(s,{records:before},f.raw.records,f.c.CapSync.fingerprintRow),/Cannot access 'txKey' before initialization/);
  });
  await test('exact former txKey crash: real 44→45 pull, absent tx baseline, metadata-only account baseline',async()=>{
    const f=await setup(),tx=f.add();assert.equal(f.before.baseline.records.length,44);
    assert.ok(f.before.baseline.records.every(b=>!Object.hasOwn(b,'row')));
    const p=await f.plan();assert.equal(p.pulls.length,1);assert.equal(p.pulls[0].kind,'transaction-pull');
    assert.equal(p.pulls[0].items[0].base,null);assert.equal(p.pulls[0].items[0].local,null);assert.equal(p.blocked.length,0);
    await f.engine.cycle();assert.equal(f.engine.status().phase,'idle',f.engine.status().reason);
    const s=await f.io.snapshot();assert.equal(s.baseline.records.length,45);assert.equal(s.journal,null);
    assert.equal(f.c.S.tx.length,12);assert.equal(f.c.S.tx.filter(t=>t.id===9001).length,1);
    assert.equal(f.c.S.accts[0].bal,28349);assert.equal(f.c.S.accts.reduce((n,a)=>n+a.bal,0),44069);
    assert.equal(s.baseline.records.find(b=>b.supabase_id===tx.id).contentFingerprint,await f.io.hash('transactions',tx));
    assert.equal(s.baseline.records.find(b=>b.entity==='accounts'&&b.localId==='1').contentFingerprint,await f.io.hash('accounts',account(f).row));
    assert.ok(f.calls.every(p=>/cap_sync_snapshot_v1|cap_verify_production_sync_v1/.test(p)));
    assert.equal(Object.values(await f.plan()).flat().length,0);
    const json=f.io.localJson(),base=JSON.stringify(s.baseline);await f.engine.cycle();assert.equal(f.io.localJson(),json);assert.equal(JSON.stringify((await f.io.snapshot()).baseline),base);
    f.c.S=JSON.parse(f.storage.get('pera'));const reloaded=f.c.CapProductionSync.createEngine(f.c.CapProductionSync.browserIO());await reloaded.boot();await reloaded.cycle();
    assert.equal(reloaded.status().phase,'idle');assert.equal(f.io.localJson(),json);assert.equal(Object.values(await f.plan()).flat().length,0);
  });
  for(const [name,amount,id,balance] of [['ewallet expense',-100,2,3020],['debit deposit',100,1,28549],['credit purchase',-100,3,12700],['credit refund',100,3,12500]])
    await test(name+' uses actual Cap signed semantics',async()=>{const f=await setup();f.add(amount,id);await f.engine.cycle();assert.equal(f.engine.status().phase,'idle',f.engine.status().reason);assert.equal(f.c.S.accts.find(a=>a.id===id).bal,balance);});
  await test('transaction without account delta refuses',()=>refused(f=>{account(f).row.balance=28449;}));
  await test('incorrect delta refuses',()=>refused(f=>{account(f).row.balance--;}));
  await test('wrong account refuses',()=>refused((f,t)=>{t.account_id=account(f,2).row.id;}));
  await test('wrong owner rejects complete snapshot',async()=>{const f=await setup(),t=f.add();t.user_id='foreign-owner';await assert.rejects(f.plan);await f.engine.cycle();await f.unchanged();});
  await test('non-deterministic UUID refuses',()=>refused((f,t)=>{t.id='11111111-1111-5111-8111-111111111111';}));
  await test('invalid legacy identity refuses',()=>refused((f,t)=>{t.legacy_id='01';}));
  await test('changed cloud account legacy identity refuses',()=>refused(f=>{account(f).row.legacy_id='999';}));
  await test('inconsistent transaction metadata refuses',()=>refused((f,t)=>{t.metadata.acct=3;}));
  await test('non-balance account mutation refuses',()=>refused(f=>{account(f).row.name='Unrelated mutation';}));
  await test('unsupported transaction metadata refuses',()=>refused((f,t)=>{t.metadata.billDue='2026-10-23';}));
  await test('pending transaction remains unsupported',()=>refused((f,t)=>{t.status='pending';}));
  await test('bill-linked transaction remains unsupported',()=>refused((f,t)=>{t.bill_id=f.raw.records.find(r=>r.entity==='bills').row.id;}));
  await test('local account fingerprint divergence refuses',()=>refused(f=>{f.c.S.accts[0].bal--; }));
  await test('existing local tx different content refuses',()=>refused(f=>{f.c.S.tx.push({id:9001,d:'2026-10-23',amt:-1,cat:'Food',acct:1,note:'Local work'});}));
  await test('relevant valid outbox refuses',async()=>{
    const f=await setup();f.add();const row=f.io.model(OWNER,f.before.baseline).records.find(r=>r.entity==='accounts');
    await f.c.CapOff.syncStore('outbox','put',{id:'queued',source:'production-sync-v1',user_id:OWNER,entity:'accounts',record_key:'accounts:'+row.row.id,supabase_id:row.row.id,local_id:'1',operation:'upsert',sequence:1,payload:row.row,fingerprint:await f.io.hash('accounts',row.row)});
    assert.ok(!(await f.plan()).pulls.some(g=>g.kind==='transaction-pull'));await f.engine.cycle();await f.unchanged();
  });
  await test('existing conflict refuses',async()=>{const f=await setup();f.add();await f.c.CapOff.syncStore('syncconflicts','put',{id:'conflict',key:'accounts:'+account(f).row.id,status:'unresolved'});await assert.rejects(f.plan);await f.engine.cycle();await f.unchanged();});
  for(const entity of ['accounts','transactions','goals'])await test(entity+' edit remains unsupported',async()=>{
    const f=await setup();const r=f.raw.records.find(r=>r.entity===entity);if(entity==='accounts')r.row.balance--;else if(entity==='transactions')r.row.title='Edited';else r.row.name='Edited';await f.engine.cycle();await f.unchanged();assert.equal(f.engine.status().phase,'paused');
  });
  await test('transaction delete remains unsupported',async()=>{const f=await setup();f.raw.records.splice(f.raw.records.findIndex(r=>r.entity==='transactions'),1);f.raw.record_count--;f.raw.counts.transactions--;await f.engine.cycle();await f.unchanged();assert.equal(f.engine.status().phase,'paused');});
  await test('unrelated financial mutation cannot accompany a group',()=>refused(f=>{f.raw.records.find(r=>r.entity==='goals').row.name='Edited';}));
  await test('multiple independent groups fail closed (policy B)',async()=>{const f=await setup();f.add();f.add(-50,2,9002);assert.ok(!(await f.plan()).pulls.some(g=>g.kind==='transaction-pull'));await f.engine.cycle();await f.unchanged();});
  await test('two creates on same account fail closed',async()=>{const f=await setup();f.add();f.add(-50,1,9002);await f.engine.cycle();await f.unchanged();});
  await test('cloud mutation after planning aborts',async()=>{const f=await setup();f.add();const remote=f.io.remote;let reads=0;f.io.remote=async owner=>{if(++reads===2)account(f).row.balance--;return remote(owner);};await f.engine.cycle();await f.unchanged();assert.equal(f.engine.status().phase,'paused');});
  await test('local mutation after planning aborts without overwriting edit',async()=>{const f=await setup();f.add();const remote=f.io.remote;let reads=0;f.io.remote=async owner=>{if(++reads===2){f.c.S.accts[0].nickname='Concurrent';f.storage.set('pera',JSON.stringify(f.c.S));}return remote(owner);};await f.engine.cycle();assert.equal(f.c.S.accts[0].nickname,'Concurrent');assert.deepEqual((await f.io.snapshot()).baseline,f.before.baseline);});
  for(const stage of ['state','baseline','install','verify','finalize'])await test(stage+' failure restores exact local state and baseline',async()=>{
    const f=await setup();f.add();const commit=f.io.commit,install=f.io.installLocal,model=f.io.model;let fired=false;
    f.io.commit=async(s,p,g)=>{if(!fired&&((stage==='state'&&p.state&&p.journal)||(stage==='baseline'&&p.baseline&&p.journal)||(stage==='finalize'&&p.journal===null&&!p.state))){fired=true;throw Error('Injected persistence failure');}return commit(s,p,g);};
    f.io.installLocal=(...args)=>{if(stage==='install'){fired=true;throw Error('Injected localStorage failure');}install(...args);};
    f.io.model=(...args)=>{const m=model(...args);if(stage==='verify'&&f.c.S.tx.length===12){fired=true;m.records.find(r=>r.entity==='accounts').row.balance--;}return m;};
    await f.engine.cycle();assert.ok(fired,'failure injection must execute');await f.unchanged();assert.equal((await f.io.snapshot()).journal,null);
  });
  for(const stage of ['state','baseline'])await test('actual IndexedDB '+stage+' DataCloneError aborts entire transaction',async()=>{
    const f=await setup();f.add();const commit=f.io.commit;let fired=false;
    f.io.commit=(s,p,g)=>{if(p.journal&&p.state){fired=true;p[stage].uncloneable=()=>{};}return commit(s,p,g);};
    await f.engine.cycle();assert.ok(fired);await f.unchanged();assert.equal((await f.io.snapshot()).journal,null);
  });
  await test('actual localStorage setItem failure rolls back durable installation',async()=>{
    const f=await setup();f.add();const set=f.c.localStorage.setItem;let fired=false;
    f.c.localStorage.setItem=(k,v)=>{if(k==='pera'&&!fired){fired=true;throw Error('Injected quota failure');}return set(k,v);};
    await f.engine.cycle();assert.ok(fired);await f.unchanged();assert.equal((await f.io.snapshot()).journal,null);
  });
  await test('persisted edit inside commit window aborts atomic CAS',async()=>{
    const f=await setup();f.add();const commit=f.io.commit;let fired=false;
    f.io.commit=async(s,p,g)=>{if(p.journal&&p.state){fired=true;await f.c.CapOff.syncStore('kv','put',{json:f.json,mt:123},'state');}return commit(s,p,g);};
    await f.engine.cycle();assert.ok(fired);assert.deepEqual((await f.io.snapshot()).baseline,f.before.baseline);assert.equal(f.c.S.tx.length,11);
  });
  await test('authentication generation change aborts',async()=>{const f=await setup();f.add();const remote=f.io.remote;let n=0;f.io.remote=async o=>{if(++n===2)f.c.CapSupabase.sessionGeneration=()=>2;return remote(o);};await f.engine.cycle();await f.unchanged();});
  await test('rollback refuses concurrent third-value local edit and retains checkpoint',async()=>{
    const f=await setup();f.add();const remote=f.io.remote;f.io.remote=async o=>{if(f.c.S.tx.length===12){f.c.S.name='Concurrent work';f.storage.set('pera',JSON.stringify(f.c.S));throw Error('Interrupted verification');}return remote(o);};
    await f.engine.cycle();assert.equal(f.c.S.name,'Concurrent work');assert.equal(f.engine.status().reason,'LOCAL_PULL_RECOVERY_REQUIRED');assert.ok((await f.io.snapshot()).journal);
  });
  await test('crash after durable commit retains before-image and reload fails closed',async()=>{
    const f=await setup();f.add();const commit=f.io.commit;let fired=false;
    f.io.commit=async(s,p,g)=>{const r=await commit(s,p,g);if(p.journal&&p.state){fired=true;throw Error('Simulated process exit after IDB commit');}return r;};
    await f.engine.cycle();assert.ok(fired);const s=await f.io.snapshot();assert.ok(s.journal);assert.deepEqual(s.journal.beforeBaseline,f.before.baseline);
    const engine=f.c.CapProductionSync.createEngine(f.c.CapProductionSync.browserIO());f.calls.length=0;await engine.boot();await engine.cycle();
    assert.equal(engine.status().reason,'LOCAL_PULL_RECOVERY_REQUIRED');assert.equal(f.calls.length,0);assert.equal(f.c.S.tx.length,11);
  });
  await test('cloud mutation after installation rolls back',async()=>{const f=await setup();f.add();const remote=f.io.remote;f.io.remote=async owner=>{if(f.c.S.tx.length===12)account(f).row.balance--;return remote(owner);};await f.engine.cycle();await f.unchanged();});
  await test('Notes existing-record pull remains functional',async()=>{const f=await setup();f.raw.records.find(r=>r.entity==='notes').row.body='Synthetic cloud edit';await f.engine.cycle();assert.equal(f.engine.status().phase,'idle');assert.equal(f.c.S.notes[0].b,'Synthetic cloud edit');});
  await test('offline cycle does not read cloud',async()=>{const f=await setup();f.add();f.c.navigator.onLine=false;await f.engine.cycle();assert.equal(f.calls.length,0);await f.unchanged();});
  await test('sync OFF cycle does not read cloud',async()=>{const f=await setup();await f.engine.setEnabled(false);f.calls.length=0;f.add();await f.engine.cycle();assert.equal(f.calls.length,0);await f.unchanged();});
  await test('actual foreground/online/pageshow/SW/15-second triggers converge and pause safely',async()=>{
    const f=await setup(),events=new Map();let timer,pending,interval;
    f.c.document.addEventListener=(n,fn)=>events.set(n,fn);f.c.addEventListener=(n,fn)=>events.set(n,fn);
    f.c.document.getElementById=()=>null;f.c.document.hidden=false;
    f.c.navigator.serviceWorker={addEventListener:(n,fn)=>events.set('sw:'+n,fn)};
    f.c.setTimeout=(fn,ms)=>{assert.equal(ms,600);timer=fn;};f.c.clearTimeout=()=>{timer=null;};
    f.c.setInterval=(fn,ms)=>{assert.equal(ms,15000);interval=fn;};
    f.c.navigator.locks.request=(name,options,fn)=>{pending=fn();return pending;};
    vm.runInContext(fs.readFileSync(__dirname+'/../js/sync-production.js','utf8'),f.c);
    await events.get('DOMContentLoaded')();f.add();
    const flush=async()=>{if(timer){const fn=timer;timer=null;fn();await pending;}};
    await flush();assert.equal(f.c.S.tx.length,12);assert.equal(f.c.S.accts[0].bal,28349);
    for(const name of ['online','pageshow','visibilitychange']){events.get(name)();await flush();}
    events.get('sw:message')({data:{type:'cap-sync'}});await flush();interval();await flush();
    assert.equal(f.c.S.tx.length,12);assert.equal(f.c.CapProductionSync.status().phase,'idle');
    f.c.document.hidden=true;interval();assert.equal(timer,null);
    f.c.navigator.onLine=false;f.calls.length=0;events.get('online')();await flush();assert.equal(f.calls.length,0);
    await f.c.CapProductionSync.toggle(false);f.calls.length=0;events.get('pageshow')();assert.equal(timer,null);assert.equal(f.calls.length,0);
  });
  console.log('PASS: '+passed+' Phase 6N integration checks; real mapper/planner/storage; synthetic data only');
})().catch(e=>{console.error(e);process.exitCode=1;});
