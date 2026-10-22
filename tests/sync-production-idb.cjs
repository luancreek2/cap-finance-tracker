/* Disposable fake IndexedDB only; never opens the app's browser storage. */
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const fake = require(process.env.CAP_FAKE_IDB_PATH || 'fake-indexeddb');
const app = fs.readFileSync(`${__dirname}/../js/app.js`, 'utf8');
async function fixture() {
  const c = { indexedDB: new fake.IDBFactory(), window: null, clearTimeout() {}, localStorage: { getItem: () => null } };
  c.window = c; vm.createContext(c);
  vm.runInContext(app.slice(0, app.indexOf('  /* ---------- events ---------- */')) + '})();', c);
  return c.CapOff;
}
let passed = 0;
const test = async (label, fn) => {try{await fn();passed++;}catch(e){e.message=label+': '+e.message;throw e;}};
(async()=>{
  await test('empty read does not initialize state, settings or baseline',async()=>{
    const off=await fixture(),s=await off.productionSyncSnapshot();
    assert.equal(s.settings,null);assert.equal(s.baseline,null);assert.equal(s.state,null);
    assert.equal((await off.syncStore('syncmeta','all')).length,0);assert.equal(s.outbox.length,0);
  });
  await test('snapshot, queue and local state commit together',async()=>{
    const off=await fixture(),s=await off.productionSyncSnapshot();
    await off.productionSyncCommit(s,{settings:{owner:'synthetic',enabled:true},state:{json:'synthetic state'},putEntries:[{id:'a'},{id:'b'}]},()=>true);
    const next=await off.productionSyncSnapshot();assert.equal(next.settings.enabled,true);assert.equal(next.state.json,'synthetic state');assert.equal(next.outbox.length,2);
  });
  await test('stale expected snapshot cannot lose a newer outbox entry',async()=>{
    const off=await fixture(),s=await off.productionSyncSnapshot();await off.syncStore('outbox','put',{id:'newer'});
    await assert.rejects(off.productionSyncCommit(s,{removeEntries:['newer'],baseline:{version:99}},()=>true),/changed/);
    assert.equal((await off.productionSyncSnapshot()).baseline,null);assert.equal((await off.syncStore('outbox','all')).length,1);
  });
  await test('acknowledgement advances baseline and removes exact entry together',async()=>{
    const off=await fixture();await off.syncStore('outbox','put',{id:'a'});await off.syncStore('outbox','put',{id:'other'});
    await off.syncStore('syncmeta','put',{version:2,revision:0},'baseline');
    await off.syncStore('syncmeta','put',{operation:'a'},'production-sync-journal-v1');
    const s=await off.productionSyncSnapshot();await off.productionSyncCommit(s,{baseline:{version:2,revision:1},removeEntries:['a'],journal:null,receipt:{id:'a',entries:[{id:'a'}]}},()=>true);
    const after=await off.productionSyncSnapshot();assert.equal(after.baseline.revision,1);assert.equal(after.outbox.length,1);assert.equal(after.outbox[0].id,'other');assert.equal(after.journal,null);
    assert.equal((await off.syncStore('syncmeta','get','production-sync-receipt:a')).entries[0].id,'a');
  });
  await test('failed receipt insert rolls back baseline update and queue deletion',async()=>{
    const off=await fixture();await off.syncStore('outbox','put',{id:'a'});await off.syncStore('syncmeta','put',{id:'existing'},'production-sync-receipt:a');
    const s=await off.productionSyncSnapshot();await assert.rejects(off.productionSyncCommit(s,{baseline:{revision:1},removeEntries:['a'],receipt:{id:'a'}},()=>true));
    const after=await off.productionSyncSnapshot();assert.equal(after.baseline,null);assert.equal(after.outbox.length,1);
  });
  await test('false or asynchronous local guards cannot commit',async()=>{
    for(const guard of [()=>false,async()=>true]){const off=await fixture(),s=await off.productionSyncSnapshot();await assert.rejects(off.productionSyncCommit(s,{baseline:{revision:1}},guard),/changed/);assert.equal((await off.productionSyncSnapshot()).baseline,null);}
  });
  await test('recovery checkpoint appearing between snapshots aborts commit',async()=>{
    const off=await fixture(),s=await off.productionSyncSnapshot();await off.syncStore('syncmeta','put',{pending:true},'manual-notes-pull-v1');
    await assert.rejects(off.productionSyncCommit(s,{settings:{enabled:true}},()=>true),/changed/);assert.equal((await off.productionSyncSnapshot()).settings,null);
  });
  await test('turning OFF preserves baseline queue conflicts and journal',async()=>{
    const off=await fixture();await off.syncStore('outbox','put',{id:'a'});await off.syncStore('syncconflicts','put',{id:'c'});
    await off.syncStore('syncmeta','put',{pending:true},'production-sync-journal-v1');await off.syncStore('syncmeta','put',{revision:5},'baseline');
    const s=await off.productionSyncSnapshot();await off.productionSyncCommit(s,{settings:{enabled:false}},()=>true);
    const after=await off.productionSyncSnapshot();assert.equal(after.baseline.revision,5);assert.equal(after.outbox.length,1);assert.equal(after.conflicts.length,1);assert.equal(after.journal.pending,true);
  });
  console.log(`PASS: ${passed} production IndexedDB transaction checks; disposable fake IndexedDB only`);
})().catch(e=>{console.error(e);process.exitCode=1;});
