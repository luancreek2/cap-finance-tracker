/* Note-only apply in synthetic VM/fake IDB. No real app or cloud wiring. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
const fake=require(process.env.CAP_FAKE_IDB_PATH||'fake-indexeddb');
let ambient=0;
function load(file){const c={module:{exports:{}},crypto:webcrypto,TextEncoder};
  for(const k of ['window','document','navigator','fetch','localStorage','indexedDB','setTimeout'])Object.defineProperty(c,k,{get(){ambient++;throw Error('private-error')}});
  vm.createContext(c);vm.runInContext(fs.readFileSync(`${__dirname}/../js/${file}`,'utf8'),c);return c.module.exports;
}
const compat=load('notes-tombstone-compat.js'),applyModule=load('notes-tombstone-compat-apply.js');
const clone=x=>JSON.parse(JSON.stringify(x)),owner='owner-secret',id='00000000-0000-4000-8000-000000000011',deletedId='00000000-0000-4000-8000-000000000012';
const operation='00000000-0000-4000-8000-000000000031',tombOp='00000000-0000-4000-8000-000000000032',KEY='manual-notes-tombstone-v1';
const hash=r=>createHash('sha256').update(JSON.stringify({body:r.body,note_date:r.note_date,title:r.title})).digest('hex');
function safe(r){const{privateJson,...p}=r;assert.ok(!/owner-secret|body-secret|removed-secret|financial-secret|private-error|00000000-0000-4000-8000-000000000011/.test(JSON.stringify(p)));assert.equal(ambient,0)}
async function fixture(kind='import'){
  const f={confirms:0,calls:0,consent:true,owner,syncOff:true,factory:new fake.IDBFactory()};
  const q=f.factory.open('isolated-note-compat-apply',1);q.onupgradeneeded=()=>{q.result.createObjectStore('kv');q.result.createObjectStore('syncmeta');q.result.createObjectStore('outbox',{keyPath:'id'})};
  f.db=await new Promise((res,rej)=>{q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)});
  f.store=(store,method,value,key)=>new Promise((res,rej)=>{const t=f.db.transaction(store,['get','getAll'].includes(method)?'readonly':'readwrite'),r=t.objectStore(store)[method](value,key);let out;r.onsuccess=()=>{out=r.result};t.oncomplete=()=>res(out);t.onabort=()=>rej(t.error);t.onerror=()=>rej(t.error)});
  const original={id:deletedId,user_id:owner,legacy_id:'2',title:'Removed',body:'removed-secret',note_date:null};
  const life={version:1,revision:7,deleted_at:'2026-10-21T00:00:00.000Z',operation_id:'remote-operation'};
  f.state={_mt:10,notes:[{id:1,t:'Title',b:'body-secret',d:'2026-10-20',_u:10}],noteTombstones:[{id:tombOp,user_id:owner,localId:'2',supabase_id:deletedId,origin:'cloud',original,
    acknowledged:{contentFingerprint:hash(original),lifecycle:life},staged_at:'2026-10-21T01:00:00.000Z'}],accts:[{id:9,bal:100,label:'financial-secret'}],tx:[],pend:[],xfer:[],bills:[],goals:[],debts:[],budgets:{},cur:'PHP',custom:{keep:true}};
  f.original=clone(f.state);f.json=JSON.stringify(f.state);f.ls=f.json;
  const active={title:'Title',body:'body-secret',note_date:'2026-10-20'};
  f.baseline={version:2,user_id:owner,records:[{entity:'notes',user_id:owner,localId:'1',supabase_id:id,contentFingerprint:hash(active)},
    {entity:'notes',user_id:owner,localId:'2',supabase_id:deletedId,contentFingerprint:hash(original),lifecycle:life}]};
  const incoming=clone(f.state);delete incoming.noteTombstones;incoming.accts[0].bal=999;
  incoming.notes.push({id:3,t:'New',b:'Synthetic import',d:null},{id:2,t:original.title,b:original.body,d:original.note_date});
  const input=kind==='import'?{owner,current:clone(f.state),incoming:{format:'cap-notes-lifecycle-backup-v1',owner,data:incoming},format:'json',mode:'merge'}:
    {owner,base:clone(f.state),local:clone(f.state),remote:clone(f.state)};
  if(kind==='merge')input.remote.notes[0].b='Remote edit';
  f.evidence={kind,input,expectedLocalJson:f.json,expectedBaseline:clone(f.baseline),operationId:operation,requestedAt:20,syncOff:true};
  await f.store('kv','put',{json:f.json,mt:10},'state');await f.store('syncmeta','put',clone(f.baseline),'baseline');
  f.adapters={database:f.db,compat,getState:()=>f.state,setState:s=>{if(f.failSet)throw Error('private-error');f.state=s},
    readLocalStorage:()=>f.ls,writeLocalStorage:s=>{if(f.failLs)throw Error('private-error');f.ls=s},guard:u=>u===f.owner&&f.syncOff,
    withLock:async(name,run)=>{assert.equal(name,'cap-controlled-notes-test');if(f.locked)throw Error('private-error');f.locked=true;try{return await run()}finally{f.locked=false}}};
  f.api=applyModule.create(f.adapters);f.action={inspect:async()=>{f.calls++;if(f.onInspect)await f.onInspect(f.calls);return clone(f.evidence)},confirm:async()=>{f.confirms++;if(f.onConfirm)await f.onConfirm();return f.consent}};
  f.run=async()=>{const p=await f.api.preview(f.evidence);assert.equal(p.previewReady,true);return f.api.apply(p.ticket,f.action)};
  f.cp=()=>f.store('syncmeta','get',KEY);f.base=()=>f.store('syncmeta','get','baseline');f.kv=()=>f.store('kv','get','state');
  f.backups=async()=>(await f.store('syncmeta','getAll')).filter(x=>x?.kind==='manual-note-compatibility-backup');return f;
}
let passed=0;
async function test(label,run){try{await run();passed++}catch(e){e.message=label+': '+e.message;throw e}}
async function untouched(f){assert.equal(JSON.stringify(f.state),f.json);assert.equal(f.ls,f.json);assert.equal((await f.kv()).json,f.json);assert.deepEqual(await f.base(),f.baseline)}
(async()=>{
  await test('module exports no cloud writer, full importer, restore, or purge',async()=>{const f=await fixture();assert.deepEqual(Object.keys(f.api).sort(),['apply','exportRecovery','inspectExport','inspectRecovery','preview']);
    for(const file of ['index.html','service-worker.js'])assert.ok(!fs.readFileSync(`${__dirname}/../${file}`,'utf8').includes('notes-tombstone-compat-apply.js'))});
  await test('preview leaves every store untouched',async()=>{const f=await fixture(),r=await f.api.preview(f.evidence);safe(r);assert.equal(r.previewReady,true);await untouched(f);assert.equal(await f.cp(),undefined);assert.equal((await f.backups()).length,0)});
  await test('cancellation never stages or backs up',async()=>{const f=await fixture();f.consent=false;const r=await f.run();safe(r);assert.match(r.status,/CANCELLED/);await untouched(f);assert.equal(await f.cp(),undefined);assert.equal((await f.backups()).length,0)});
  for(const kind of ['import','merge'])await test(kind+' applies only reviewed notes after verified backup',async()=>{
    const f=await fixture(kind);f.onInspect=async n=>{if(n===3){await untouched(f);assert.equal((await f.cp()).phase,'prepared');assert.equal((await f.backups()).length,1)}};
    const r=await f.run();safe(r);assert.equal(r.applied,true);assert.equal(r.verified,true);assert.equal(r.cloudWritten,false);assert.equal(r.baselineChanged,false);
    const nonNotes=s=>Object.fromEntries(Object.entries(s).filter(([k])=>!['_mt','notes'].includes(k)));
    assert.deepEqual(clone(nonNotes(f.state)),nonNotes(f.original));assert.equal(f.state.accts[0].bal,100);assert.equal(f.state._mt,20);
    assert.deepEqual(clone(f.state.noteTombstones),f.original.noteTombstones);assert.equal(JSON.stringify(f.state.noteTombstones),JSON.stringify(f.original.noteTombstones));assert.deepEqual(await f.base(),f.baseline);assert.equal((await f.store('outbox','getAll')).length,0);
    assert.equal(await f.cp(),undefined);assert.equal((await f.backups()).length,1);assert.equal(f.ls,JSON.stringify(f.state));assert.equal((await f.kv()).json,f.ls);
    if(kind==='import'){assert.deepEqual(clone(f.state.notes.map(n=>n.id)),[1,3]);assert.equal(f.state.notes.some(n=>n.id===2),false)}else assert.equal(f.state.notes[0].b,'Remote edit');
  });
  await test('no-op preview requests no confirmation or backup',async()=>{const f=await fixture();f.evidence.input.incoming={format:'cap-notes-lifecycle-backup-v1',owner,data:clone(f.state)};
    const r=await f.api.preview(f.evidence);safe(r);assert.equal(r.noChange,true);assert.equal(r.previewReady,false);assert.equal(r.ticket,undefined);await untouched(f);assert.equal((await f.backups()).length,0)});
  await test('old ticket cannot apply or acknowledge twice',async()=>{const f=await fixture(),p=await f.api.preview(f.evidence);await f.api.apply(p.ticket,f.action);const confirms=f.confirms,r=await f.api.apply(p.ticket,f.action);safe(r);assert.equal(r.applied,false);assert.equal(f.confirms,confirms);assert.equal((await f.backups()).length,1);assert.deepEqual(await f.base(),f.baseline)});
  for(const [name,change]of[
    ['owner change',f=>{f.owner='foreign'}],['sync enabled',f=>{f.syncOff=false}],['source body change',f=>{f.evidence.input.incoming.data.notes[0].b='edited'}],
    ['source financial change',f=>{f.evidence.input.incoming.data.accts[0].bal++}],['stale localStorage',f=>{f.ls='{}'}],['new local edit',f=>{f.state.notes[0].b='new';f.ls=JSON.stringify(f.state)}],
  ])await test(name+' during confirmation blocks before backup',async()=>{const f=await fixture();f.onConfirm=()=>change(f);const r=await f.run();safe(r);assert.equal(r.applied,false);assert.equal(await f.cp(),undefined);assert.equal((await f.backups()).length,0);assert.equal((await f.kv()).json,f.json)});
  await test('changed evidence after backup retains original state and recovery',async()=>{const f=await fixture();f.onInspect=n=>{if(n===3)f.evidence.input.incoming.data.notes.push({id:4,t:'Later',b:'Later',d:null})};
    const r=await f.run();safe(r);assert.match(r.status,/NOTES NOT REPLACED/);await untouched(f);assert.equal((await f.cp()).phase,'prepared');const report=await f.api.inspectRecovery();safe(report);assert.match(report.status,/NOT APPLIED/)});
  for(const key of [KEY,'controlled-notes-test-v1','demo-local-refresh-state-v1','manual-notes-pull-v1'])await test(key+' blocks and remains unchanged',async()=>{const f=await fixture();await f.store('syncmeta','put',{keep:true},key);const r=await f.run();safe(r);assert.equal(f.confirms,0);assert.deepEqual(await f.store('syncmeta','get',key),{keep:true});assert.equal((await f.backups()).length,0);await untouched(f)});
  await test('pending outbox blocks without removing it',async()=>{const f=await fixture();await f.store('outbox','put',{id:'pending'});const r=await f.run();safe(r);assert.equal(f.confirms,0);assert.equal((await f.store('outbox','getAll')).length,1);assert.equal(await f.cp(),undefined)});
  await test('baseline change blocks without reset',async()=>{const f=await fixture(),b=clone(f.baseline);b.revision=7;await f.store('syncmeta','put',b,'baseline');const r=await f.run();safe(r);assert.equal(f.confirms,0);assert.deepEqual(await f.base(),b);assert.equal(await f.cp(),undefined)});
  await test('backup failure aborts both backup and prepared checkpoint',async()=>{const f=await fixture(),add=fake.IDBObjectStore.prototype.add;fake.IDBObjectStore.prototype.add=function(v,k){if(k===KEY)throw Error('private-error');return add.call(this,v,k)};
    try{const r=await f.run();safe(r);assert.equal(r.applied,false)}finally{fake.IDBObjectStore.prototype.add=add}await untouched(f);assert.equal(await f.cp(),undefined);assert.equal((await f.backups()).length,0)});
  await test('failure between note state and applied checkpoint rolls state back',async()=>{const f=await fixture(),put=fake.IDBObjectStore.prototype.put;fake.IDBObjectStore.prototype.put=function(v,k){if(k===KEY&&v.phase==='applied')throw Error('private-error');return put.call(this,v,k)};
    try{const r=await f.run();safe(r);assert.match(r.status,/NOTES NOT REPLACED/)}finally{fake.IDBObjectStore.prototype.put=put}await untouched(f);assert.equal((await f.cp()).phase,'prepared')});
  for(const failure of ['failSet','failLs'])await test(failure+' after commit retains applied evidence',async()=>{const f=await fixture();f[failure]=true;const r=await f.run();safe(r);assert.equal(r.committed,true);assert.equal(r.checkpointRetained,true);assert.match(r.status,/APPLY COMMITTED/);assert.equal((await f.cp()).phase,'applied');assert.equal(JSON.parse((await f.kv()).json).notes.length,2);assert.deepEqual(await f.base(),f.baseline);const report=await f.api.inspectRecovery();safe(report);assert.match(report.status,/BLOCKED/)});
  await test('backup tampering stops replacement',async()=>{const f=await fixture();f.onInspect=async n=>{if(n===3){const cp=await f.cp(),backup=(await f.backups())[0];delete backup.desiredLocalJson;await f.store('syncmeta','put',backup,cp.backupKey)}};
    const r=await f.run();safe(r);assert.match(r.status,/NOTES NOT REPLACED/);await untouched(f);assert.equal((await f.api.exportRecovery()).exported,false)});
  await test('cleanup failure retains inspectable applied evidence',async()=>{const f=await fixture(),del=fake.IDBObjectStore.prototype.delete;fake.IDBObjectStore.prototype.delete=function(k){if(this.name==='syncmeta'&&k===KEY)throw Error('private-error');return del.call(this,k)};
    try{const r=await f.run();safe(r);assert.equal(r.committed,true);assert.equal(r.checkpointRetained,true)}finally{fake.IDBObjectStore.prototype.delete=del}
    const report=await f.api.inspectRecovery();safe(report);assert.match(report.status,/NOTE-ONLY DATA VERIFIED/);assert.equal(report.nonNoteStateUnchanged,true);assert.match(report.cloudEvidence,/NOT CHECKED/);
    const bundle=await f.api.exportRecovery();assert.equal(bundle.exported,true);assert.equal((await f.api.inspectExport(bundle.privateJson)).valid,true);
    f.owner='foreign';assert.equal((await f.api.exportRecovery()).exported,false);assert.equal((await f.api.inspectExport(bundle.privateJson)).valid,false);
  });
  await test('reopen preserves desired note state, tombstones, baseline, and backup',async()=>{const f=await fixture();await f.run();f.db.close();const q=f.factory.open('isolated-note-compat-apply',1);f.db=await new Promise(res=>{q.onsuccess=()=>res(q.result)});
    f.state=JSON.parse((await f.kv()).json);assert.equal(f.state.notes.length,2);assert.deepEqual(clone(f.state.noteTombstones),f.original.noteTombstones);assert.deepEqual(await f.base(),f.baseline);assert.equal(await f.cp(),undefined);assert.equal((await f.backups()).length,1)});
  await test('completed cleanup with failed read-back reports checkpoint absence accurately',async()=>{const f=await fixture(),del=fake.IDBObjectStore.prototype.delete,tx=fake.IDBDatabase.prototype.transaction;let deleted=false;
    fake.IDBObjectStore.prototype.delete=function(k){const r=del.call(this,k);if(k===KEY)deleted=true;return r};fake.IDBDatabase.prototype.transaction=function(stores,mode){if(deleted&&mode==='readonly')throw Error('private-error');return tx.call(this,stores,mode)};
    try{const r=await f.run();safe(r);assert.equal(r.committed,true);assert.equal(r.checkpointRetained,false);assert.equal(r.backupRetained,true)}finally{fake.IDBObjectStore.prototype.delete=del;fake.IDBDatabase.prototype.transaction=tx}assert.equal(await f.cp(),undefined);assert.equal((await f.backups()).length,1)});
  await test('parallel instances cannot both apply the same snapshot',async()=>{const f=await fixture(),second=applyModule.create(f.adapters),p=await f.api.preview(f.evidence),results=await Promise.all([f.api.apply(p.ticket,f.action),second.apply(p.ticket,f.action)]);results.forEach(safe);assert.equal(results.filter(r=>r.applied).length,1);assert.equal((await f.backups()).length,1)});
  await test('new remote deletion proof is not authority for compatibility apply',async()=>{const f=await fixture('merge');const remote=clone(f.state.noteTombstones[0]);remote.id='00000000-0000-4000-8000-000000000041';remote.localId='4';remote.supabase_id='00000000-0000-4000-8000-000000000014';remote.original.id=remote.supabase_id;remote.original.legacy_id='4';f.evidence.input.remote.noteTombstones.push(remote);
    const pure=await compat.planMerge(f.evidence.input);assert.equal(pure.previewReady,true);const r=await f.api.preview(f.evidence);safe(r);assert.equal(r.previewReady,false);await untouched(f)});
  for(const [label,change]of[
    ['false sync-off evidence',e=>{e.syncOff=false}],['unknown evidence field',e=>{e.autoApply=true}],
    ['foreign baseline owner',e=>{e.expectedBaseline.user_id='foreign'}],['duplicate baseline identity',e=>{e.expectedBaseline.records.push(clone(e.expectedBaseline.records[0]))}],
    ['null baseline mapping',e=>{e.expectedBaseline.records[0].localId=null}],['private wrapper owner drift',e=>{e.input.incoming.owner='foreign'}],
  ])await test(label+' fails preview without normalization or backup',async()=>{const f=await fixture();change(f.evidence);const r=await f.api.preview(f.evidence);safe(r);assert.equal(r.previewReady,false);assert.equal(await f.cp(),undefined);assert.equal((await f.backups()).length,0);await untouched(f)});
  await test('stale IDB-only state blocks before confirmation and is not reset',async()=>{const f=await fixture(),state={json:'{}',mt:99};await f.store('kv','put',state,'state');const r=await f.run();safe(r);assert.equal(f.confirms,0);assert.deepEqual(await f.kv(),state);assert.equal(await f.cp(),undefined)});
  await test('failed post-commit verification read keeps applied checkpoint',async()=>{const f=await fixture(),tx=fake.IDBDatabase.prototype.transaction;let committed=false;const set=f.adapters.setState;
    const api=applyModule.create({...f.adapters,setState:s=>{set(s);committed=true}});fake.IDBDatabase.prototype.transaction=function(stores,mode){if(committed&&mode==='readonly')throw Error('private-error');return tx.call(this,stores,mode)};
    try{const p=await api.preview(f.evidence),r=await api.apply(p.ticket,f.action);safe(r);assert.equal(r.committed,true);assert.equal(r.checkpointRetained,true)}finally{fake.IDBDatabase.prototype.transaction=tx}assert.equal((await f.cp()).phase,'applied');assert.equal((await f.backups()).length,1)});
  for(const guard of [()=>false,()=>Promise.resolve(true),()=>{throw Error('private-error')}])await test('owner guard must synchronously prove access',async()=>{const f=await fixture(),api=applyModule.create({...f.adapters,guard}),r=await api.preview(f.evidence);safe(r);assert.equal(r.previewReady,false);await untouched(f)});
  await test('unknown/foreign private bundles never import or restore data',async()=>{const f=await fixture();for(const text of ['{}','null','[]','{"format":"cap-note-tombstone-recovery-v1"}']){const r=await f.api.inspectExport(text);safe(r);assert.equal(r.valid,false)}await untouched(f)});
  await test('empty recovery inspector writes nothing',async()=>{const f=await fixture(),r=await f.api.inspectRecovery();safe(r);assert.equal(r.present,false);await untouched(f)});
  console.log(`PASS: ${passed} isolated atomic note-only compatibility apply checks; no financial or cloud writes`);
})().catch(e=>{console.error(e);process.exitCode=1});
