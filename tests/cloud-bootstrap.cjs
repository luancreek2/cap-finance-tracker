/* Phase 6M: actual mapping, fingerprint, RPC and IndexedDB adapters; synthetic data only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const fake=require(process.env.CAP_FAKE_IDB_PATH||'fake-indexeddb');
const app=fs.readFileSync(__dirname+'/../js/app.js','utf8');
const cards=fs.readFileSync(__dirname+'/../js/cards.js','utf8');
const source=n=>fs.readFileSync(__dirname+'/../js/'+n,'utf8');
const OWNER='a47663ef-f3ae-4b78-856c-692d7a9aa975';
const clone=x=>JSON.parse(JSON.stringify(x));
const DEFAULTS=['Food','Groceries','Transport','Bills','Shopping','Health','Entertainment','Salary','Interest Earned','Other']
  .map((n,i)=>({n,i:['🍜','🛒','🚕','💡','🛍️','💊','🎬','💰','🏦','📦'][i]}));
const empty=()=>({accts:[],tx:[],pend:[],xfer:[],bills:[],goals:[],debts:[],budgets:{},notes:[],cats:clone(DEFAULTS),cur:'PHP'});
let passed=0;
const test=async(name,fn)=>{try{await fn();passed++;console.log('PASS '+name);}catch(e){e.message=name+': '+e.message;throw e;}};

function productionState(){
  const s=empty();
  s.accts=[{id:1,name:'BDO Debit',bank:'BDO',type:'debit',bal:28449,net:'visa',l4:'4821',img:'bdomc'},
    {id:2,name:'GCash Visa Card',bank:'GCash',type:'ewallet',bal:3120,net:'visa',l4:'0937',img:'gcashg'},
    {id:3,name:'UnionBank Credit',bank:'UnionBank',type:'credit',bal:12600,net:'visa',l4:'7704'}];
  s.tx=Array.from({length:10},(_,i)=>({id:i+1,d:'2026-10-22',amt:i?-(i+1):35000,cat:i?'Food':'Salary',acct:1,note:'Synthetic '+(i+1)}));
  s.tx.push({id:1792670414989001,ts:1792670414989,_u:1792670414990,d:'2026-10-22',amt:-1,cat:'Food',acct:1,
    note:'FINAL CLOUD SYNC TEST',desc:'Final automatic sync verification'});
  s.bills=Array.from({length:4},(_,i)=>({id:i+1,name:'Synthetic bill '+i,amt:100+i,due:i+1,paid:''}));
  s.goals=Array.from({length:3},(_,i)=>({id:i+1,name:'Synthetic goal '+i,target:10000,saved:500,icon:'🛟'}));
  s.debts=Array.from({length:3},(_,i)=>({id:i+1,who:'Synthetic person '+i,note:'Fixture',amt:200,dir:'out',due:''}));
  s.budgets=Object.fromEntries(DEFAULTS.slice(0,7).map(c=>[c.n,1000]));
  s.notes=[{id:1,t:'Notes',b:'Goals:\n- Emergency fund ₱100,000\n- Pay off UnionBank card',d:'2026-10-22'}];
  return s;
}
async function fixture(options={}){
  const storage=new Map(),elements=new Map();
  // Existing sync suites explicitly model a device whose recovery was approved.
  storage.set('cap-sync-recovery-phase6o-v1',JSON.stringify({version:1,owner:OWNER,state:'released'}));
  const c={crypto:webcrypto,TextEncoder,URLSearchParams,indexedDB:new fake.IDBFactory(),structuredClone,
    S:clone(options.state||empty()),CAT0:clone(DEFAULTS),location:{search:''},navigator:{onLine:true,locks:{request:async(n,o,fn)=>fn()}},
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
    document:{getElementById:k=>{if(!elements.has(k))elements.set(k,{textContent:'',disabled:true});return elements.get(k);}},
    confirm:()=>true,clearTimeout(){},setTimeout(){},console};
  c.window=c;vm.createContext(c);
  vm.runInContext(app.slice(0,app.indexOf('  /* ---------- events ---------- */'))+'})();',c);
  c.CapOff.init({get:()=>c.S,set:s=>{c.S=s;}});
  // Real forward mapping, accepting an explicit candidate rather than global S.
  vm.runInContext(app.slice(app.indexOf('function migrationStableUuid'),app.indexOf('async function migrateCapData')),c);
  vm.runInContext(app.slice(app.indexOf('function migrate(state'),app.indexOf('/* Readable previews for the Settings choices')),c);
  vm.runInContext(cards.slice(cards.indexOf('function billTxMatches'),cards.indexOf('/* Which due-date entry')),c);
  c.bDt=d=>new Date(d+'T00:00:00');
  c.billDueKeyFor=(b,t)=>t.billDue||'';
  c.CapSupabase={status:()=>({authenticated:true,userId:OWNER}),localIdentity:()=>OWNER,sessionGeneration:()=>1,currentUser:async()=>({id:OWNER})};
  vm.runInContext(source('sync.js'),c);
  vm.runInContext(source('sync-production.js'),c);
  c.CapProductionSync.status=()=>({enabled:false,phase:'off'});
  vm.runInContext(source('production-rpc.js'),c);
  vm.runInContext(source('cloud-to-local.js'),c);
  const sup=source('supabase.js');
  vm.runInContext('const configured=()=>true; const user=async()=>({id:"'+OWNER+'"});'+sup.slice(sup.indexOf('  async function validateRealData'),sup.indexOf('  function status()'))+';CapSupabase.validateRealData=validateRealData;',c);
  const production=productionState();if(options.production)options.production(production);
  const prep=c.migrationPrepare(production),plan=c.buildSupabaseMigrationPlan(prep,OWNER,production);
  const records=plan.tables.flatMap(([entity,rows])=>rows.map(row=>({entity,row:clone({...row,created_at:'2026-10-20T07:08:30Z',updated_at:'2026-10-22T12:00:17Z'})})))
    .concat([{entity:'profiles',row:plan.profile},{entity:'user_preferences',row:plan.preferences}]);
  for(const r of records)if(r.entity==='notes')r.lifecycle={version:1,revision:2,deleted_at:null,operation_id:null};
  const raw={version:'CAP_SYNC_SNAPSHOT_V1',complete:true,owner:OWNER,record_count:records.length,
    counts:Object.fromEntries(c.CapProductionRpc.ENTITIES.map(e=>[e,records.filter(r=>r.entity===e).length])),records};
  const checks=c.CapProductionRpc.READINESS_CHECKS,contracts=c.CapProductionRpc.CONTRACTS;
  const readiness={version:'CAP_PRODUCTION_SYNC_V1',ready:true,legacy_lockout:true,private_sidecar:true,rpc_only_reads:true,
    writer_bypassrls:false,atomic_transaction_create:true,durable_operation_receipts:true,
    checks:Object.fromEntries(checks.map(k=>[k,true])),contracts};
  const calls=[];let reads=0;
  c.CapSupabase.syncRequest=async(path,opts)=>{
    calls.push(path);
    if(path==='/rest/v1/rpc/cap_verify_production_sync_v1')return clone(options.readiness===false?{}:readiness);
    if(path==='/rest/v1/rpc/cap_sync_snapshot_v1'){
      reads++;
      let value=clone(raw);if(options.mutate)value=options.mutate(value,reads)||value;
      return value;
    }
    throw Error('Forbidden cloud write: '+path);
  };
  vm.runInContext(source('cloud-bootstrap.js'),c);
  storage.set('pera',JSON.stringify(c.S));
  await c.CapOff.syncStore('kv','put',{json:JSON.stringify(c.S),mt:0},'state');
  const before=JSON.stringify(await c.CapOff.bootstrapStorage('read')),memory=JSON.stringify(c.S);
  return {c,raw,production,calls,storage,before,memory,reads:()=>reads,
    run:()=>c.CapCloudBootstrap.run(),image:()=>c.CapOff.bootstrapStorage('read'),
    unchanged:async()=>{const now=await c.CapOff.bootstrapStorage('read');
      now.kv=now.kv.filter(([k])=>!String(k).startsWith('cloud-bootstrap-backup:'));
      assert.equal(JSON.stringify(now),before);assert.equal(JSON.stringify(c.S),memory);assert.equal(storage.get('pera'),memory);}};
}
const row=(f,e)=>f.raw.records.find(r=>r.entity===e).row;
module.exports={fixture,productionState,OWNER,clone};
if(require.main===module)(async()=>{
  await test('fresh Device B: real adapters restore production-compatible 44 rows',async()=>{
    const f=await fixture(),r=await f.run();assert.equal(r.ok,true,r.error);assert.equal(r.records,44);assert.equal(r.message,'Device ready — Cloud Sync can now be enabled');
    assert.equal(f.c.S.tx.length,11);assert.equal(f.c.S.accts[0].bal,28449);
  });
  await test('direct v2 baseline: 44/44 owned valid fingerprints and unique mappings',async()=>{
    const f=await fixture();assert.equal((await f.run()).ok,true);const meta=new Map((await f.image()).syncmeta),b=meta.get('baseline');
    assert.equal(b.version,2);assert.equal(b.records.length,44);assert.equal(new Set(b.records.map(r=>r.entity+':'+r.localId)).size,44);
    assert.equal(new Set(b.records.map(r=>r.entity+':'+r.supabase_id)).size,44);
    assert.ok(b.records.every(r=>r.user_id===OWNER&&r.localId!=null&&/^[a-f0-9]{64}$/.test(r.contentFingerprint)));
  });
  await test('persisted localStorage and IDB equal memory; zero queues; OFF; rollback receipt retained',async()=>{
    const f=await fixture();assert.equal((await f.run()).ok,true);const image=await f.image(),meta=new Map(image.syncmeta),kv=new Map(image.kv);
    assert.equal(kv.get('state').json,JSON.stringify(f.c.S));assert.equal(f.storage.get('pera'),JSON.stringify(f.c.S));
    assert.equal(meta.get('production-sync-v1').enabled,false);assert.equal(image.outbox.length,0);assert.equal(image.syncconflicts.length,0);
    assert.ok([...kv.keys()].some(k=>k.startsWith('cloud-bootstrap-backup:')));assert.ok(!meta.has('cloud-bootstrap-pending-v1'));
  });
  await test('no cloud write RPC invoked (only snapshot/readiness)',async()=>{
    const f=await fixture();await f.run();assert.ok(f.calls.length>2);assert.ok(f.calls.every(p=>/cap_sync_snapshot_v1$|cap_verify_production_sync_v1$/.test(p)));
  });
  for(const key of ['accts','tx','pend','xfer','bills','goals','debts','notes'])await test('existing local '+key+' refuses with zero cloud requests',async()=>{
    const s=empty();s[key]=[{id:123}];const f=await fixture({state:s});assert.equal((await f.run()).ok,false);assert.equal(f.calls.length,0);await f.unchanged();
  });
  for(const key of ['budgets','name','theme','customUserData'])await test('existing customization '+key+' refuses',async()=>{
    const s=empty();s[key]=key==='budgets'?{Food:50}:'custom';const f=await fixture({state:s});assert.equal((await f.run()).ok,false);await f.unchanged();
  });
  await test('default categories only accepted',async()=>{const f=await fixture();assert.equal((await f.run()).ok,true);});
  await test('custom category refused',async()=>{const s=empty();s.cats.push({n:'Custom',i:'x'});const f=await fixture({state:s});assert.equal((await f.run()).ok,false);await f.unchanged();});
  for(const [name,mutate] of [
    ['incomplete snapshot',r=>{r.complete=false;}],['wrong snapshot owner',r=>{r.owner='bad';}],
    ['wrong row owner',r=>{r.records[0].row.user_id='bad';}],['wrong record count',r=>{r.record_count++;}],
    ['wrong entity count',r=>{r.counts.accounts++;}],['invalid Notes lifecycle',r=>{r.records.find(x=>x.entity==='notes').lifecycle.revision=0;}],
    ['tombstoned Notes',r=>{r.records.find(x=>x.entity==='notes').lifecycle.deleted_at='2026-10-22';}],
    ['empty cloud',r=>{r.records=[];r.record_count=0;r.counts=Object.fromEntries(Object.keys(r.counts).map(k=>[k,0]));}],
    ['unreproducible UUID',r=>{r.records.find(x=>x.entity==='debts').row.id='11111111-1111-5111-8111-111111111111';}],
    ['unsupported legacy ID',r=>{r.records.find(x=>x.entity==='accounts').row.legacy_id='uuid-like';}]
  ])await test(name+' refuses unchanged',async()=>{const f=await fixture({mutate:(r)=>{mutate(r);return r;}});assert.equal((await f.run()).ok,false);await f.unchanged();});
  await test('invalid readiness refuses unchanged',async()=>{const f=await fixture({readiness:false});assert.equal((await f.run()).ok,false);await f.unchanged();});
  await test('cloud change during validation refuses before commit',async()=>{
    const f=await fixture({mutate:(r,n)=>{if(n>=2)r.records.find(x=>x.entity==='accounts').row.balance++;return r;}});
    assert.equal((await f.run()).ok,false);await f.unchanged();
  });
  await test('cloud change after install rolls back',async()=>{
    const f=await fixture({mutate:(r,n)=>{if(n>=5)r.records.find(x=>x.entity==='accounts').row.balance++;return r;}});
    const r=await f.run();assert.equal(r.ok,false);await f.unchanged();
  });
  await test('accounts/balances/card settings restored',async()=>{
    const f=await fixture();await f.run();assert.deepEqual(Array.from(f.c.S.accts,a=>a.bal),[28449,3120,12600]);
    assert.equal(f.c.S.accts.reduce((n,a)=>n+a.bal,0),44169);assert.equal(f.c.S.accts[0].l4,'4821');assert.equal(f.c.S.accts[0].net,'visa');
  });
  await test('transaction metadata, stable ID, title, description and timestamp restored',async()=>{
    const f=await fixture();await f.run();const t=f.c.S.tx.find(t=>t.id===1792670414989001);
    assert.equal(t.ts,1792670414989);assert.equal(t._u,1792670414990);assert.equal(t.note,'FINAL CLOUD SYNC TEST');
    assert.equal(t.desc,'Final automatic sync verification');assert.equal(t.amt,-1);assert.equal(t.cat,'Food');assert.equal(t.acct,1);
  });
  await test('Notes restored as stable array, not date-relative string',async()=>{
    const f=await fixture();await f.run();assert.equal(f.c.S.notes[0].d,'2026-10-22');assert.equal(f.c.S.notes[0].b,f.production.notes[0].b);
  });
  for(const [local,entity,count] of [['bills','bills',4],['goals','goals',3],['debts','debts',3],['cats','categories',10]])
    await test(entity+' restores and round-trips canonically',async()=>{const f=await fixture();await f.run();assert.equal(f.c.S[local].length,count);});
  await test('budgets and empty transfers/statements/payments restored',async()=>{
    const f=await fixture();await f.run();assert.equal(Object.keys(f.c.S.budgets).length,7);assert.equal(f.c.S.xfer.length,0);assert.ok(f.c.S.accts.every(a=>!a.statementHistory.length));
  });
  await test('profile/preferences restored',async()=>{const f=await fixture();await f.run();assert.equal(f.c.S.cur,'PHP');assert.equal(f.c.S.nf,'us');assert.equal(f.c.S.anim,1);assert.equal(f.c.S.hide,0);});
  await test('0/0/0/0 validation and zero production plan after restore',async()=>{
    const f=await fixture();await f.run();const verified=await f.c.CapCloudBootstrap.verifyCandidate(f.c.S,f.raw,OWNER);
    const v=verified.validation;assert.equal(v.missingCount+v.unexpectedCount+v.mismatchCount+v.foreignKeyErrorCount,0);
    assert.equal(v.dryRun.wouldPush+v.dryRun.wouldPull+v.dryRun.conflicts,0);
  });
  await test('IDs reproduce every existing Supabase mapping',async()=>{
    const f=await fixture();await f.run();const p=f.c.buildSupabaseMigrationPlan(f.c.migrationPrepare(f.c.S),OWNER,f.c.S);
    const local=new Set(p.tables.flatMap(([e,rs])=>rs.map(r=>e+':'+r.id)));
    for(const r of f.raw.records.filter(r=>!['profiles','user_preferences'].includes(r.entity)))assert.ok(local.has(r.entity+':'+r.row.id));
  });
  for(const mode of ['state','baseline'])await test('atomic IDB '+mode+' write failure leaves before image',async()=>{
    const f=await fixture(),original=f.c.CapOff.bootstrapStorage;
    f.c.CapOff.bootstrapStorage=async(action,payload,guard)=>{
      if(action==='install'){payload=clone(payload);if(mode==='state')payload.state.bad=()=>{};else payload.baseline.bad=()=>{};}
      return original(action,payload,guard);
    };
    assert.equal((await f.run()).ok,false);await f.unchanged();
  });
  await test('localStorage installation failure rolls back durable state/baseline',async()=>{
    const f=await fixture(),set=f.c.localStorage.setItem;let failed=false;
    f.c.localStorage.setItem=(k,v)=>{if(k==='pera'&&!failed){failed=true;throw Error('disk full');}set(k,v);};
    assert.equal((await f.run()).ok,false);await f.unchanged();
  });
  await test('post-install persistent verification failure rolls back',async()=>{
    const f=await fixture(),original=f.c.CapOff.bootstrapStorage;let installed=false,failed=false;
    f.c.CapOff.bootstrapStorage=async(action,payload,guard)=>{
      if(action==='read'&&installed&&!failed){failed=true;throw Error('simulated post-install read failure');}
      const result=await original(action,payload,guard);if(action==='install')installed=true;return result;
    };
    assert.equal((await f.run()).ok,false);await f.unchanged();
  });
  await test('crash checkpoint recovery restores state and metadata',async()=>{
    const f=await fixture(),image=await f.image();const candidate=f.c.CapCloudBootstrap.hydrate(f.raw,OWNER);
    const {baseline}=await f.c.CapCloudBootstrap.verifyCandidate(candidate,f.raw,OWNER);
    await f.c.CapOff.bootstrapStorage('install',{before:image,memoryJson:f.memory,localStorageJson:f.memory,
      state:{json:JSON.stringify(candidate),mt:0},baseline,backupKey:'cloud-bootstrap-backup:crash'},()=>true);
    await f.c.CapOff.recoverBootstrap();await f.unchanged();
  });
  await test('existing baseline/outbox/conflicts/recovery refused',async()=>{
    for(const [store,key,value] of [['syncmeta','baseline',{version:2}],['outbox',null,{id:'pending'}],
      ['syncconflicts',null,{id:'conflict'}],['syncmeta','manual-notes-pull-v1',{}]]){
      const f=await fixture();await f.c.CapOff.syncStore(store,'put',value,key||undefined);
      assert.equal((await f.run()).ok,false);assert.equal(f.calls.length,0);
    }
  });
  await test('UI unavailable offline/signed out/ON; no settings writes',async()=>{
    const f=await fixture();assert.equal(await f.c.CapCloudBootstrap.availability(),true);
    f.c.navigator.onLine=false;assert.equal(await f.c.CapCloudBootstrap.availability(),false);
    f.c.navigator.onLine=true;f.c.CapProductionSync.status=()=>({enabled:true});assert.equal(await f.c.CapCloudBootstrap.availability(),false);
    f.c.CapProductionSync.status=()=>({enabled:false});f.c.CapSupabase.status=()=>({authenticated:false});assert.equal(await f.c.CapCloudBootstrap.availability(),false);
    await f.unchanged();
  });
  await test('genuinely absent localStorage and IDB install successfully',async()=>{
    const f=await fixture();f.storage.delete('pera');await f.c.CapOff.syncStore('kv','delete','state');
    assert.equal((await f.run()).ok,true);
  });
  await test('nonempty transfers round-trip with foreign-key IDs',async()=>{
    const f=await fixture({production:s=>{s.xfer.push({id:101,from:1,to:2,kind:'account-transfer',amt:25,d:'2026-10-22',note:'Fixture transfer'});}});
    const r=await f.run();assert.equal(r.ok,true,r.error);assert.equal(f.c.S.xfer.length,1);assert.equal(f.c.S.xfer[0].from,1);assert.equal(f.c.S.xfer[0].to,2);
  });
  await test('nonempty statement metadata/normalized columns round-trip',async()=>{
    const f=await fixture({production:s=>{s.accts[2].statementHistory=[{statementId:'3:2026-09-01',st:'2026-09-01',en:'2026-09-30',
      c:{st:'2026-09-30',due:'2026-10-20'},opening:100,close:200,minimum:50,paid:0}];s.tx[2].statementId='3:2026-09-01';}});
    const r=await f.run();assert.equal(r.ok,true,r.error);assert.equal(f.c.S.accts[2].statementHistory[0].statementId,'3:2026-09-01');
    assert.equal(f.c.S.tx[2].statementId,'3:2026-09-01');
  });
  await test('nonempty paid bill rows restored through linked payment transaction',async()=>{
    const f=await fixture({production:s=>{Object.assign(s.tx[1],{billId:1,billDue:'2026-10-20',amt:-100,cat:'Bills',note:'Synthetic bill 0'});}});
    const r=await f.run();assert.equal(r.ok,true,r.error);assert.equal(f.c.S.tx[1].billId,1);assert.equal(f.c.S.tx[1].billDue,'2026-10-20');
  });
  await test('rich account settings and profile preferences round-trip',async()=>{
    const f=await fixture({production:s=>{
      Object.assign(s.accts[0],{minimumPayment:{mode:'fixed',value:50},interestEnabled:true,interestRate:3,fees:{annualFee:{value:10}},nickname:'Fixture card'});
      Object.assign(s,{name:'Synthetic User',theme:'dark',nf:'eu',dec:1,rm:1,snd:0,hap:0,hide:1,accountOrder:[3,1,2]});
    }});
    const r=await f.run();assert.equal(r.ok,true,r.error);assert.equal(f.c.S.accts[0].interestRate,3);assert.equal(f.c.S.accts[0].minimumPayment.value,50);
    assert.equal(f.c.S.name,'Synthetic User');assert.equal(f.c.S.theme,'dark');assert.equal(f.c.S.nf,'eu');
  });
  await test('unsupported transfer-backed bill payment refuses rather than dropping it',async()=>{
    const f=await fixture({mutate:r=>{
      const id='11111111-1111-5111-8111-111111111111';
      r.records.push({entity:'bill_payments',row:{id,user_id:OWNER,status:'paid',transfer_id:id}});r.counts.bill_payments++;r.record_count++;return r;
    }});assert.equal((await f.run()).ok,false);await f.unchanged();
  });
  await test('cloud mutation at confirmation refuses without commit',async()=>{
    const f=await fixture();f.c.confirm=()=>{row(f,'accounts').balance++;return true;};
    assert.equal((await f.run()).ok,false);await f.unchanged();
  });
  await test('owner generation changes at confirmation refuse',async()=>{
    const f=await fixture();let generation=1;f.c.CapSupabase.sessionGeneration=()=>generation;
    f.c.confirm=()=>{generation++;return true;};assert.equal((await f.run()).ok,false);await f.unchanged();
  });
  await test('cancel confirmation preserves everything',async()=>{
    const f=await fixture();f.c.confirm=()=>false;assert.equal((await f.run()).cancelled,true);await f.unchanged();
  });
  await test('rollback failure is prominent and retains checkpoint for recovery',async()=>{
    const f=await fixture(),original=f.c.CapOff.installBootstrapState;
    f.c.CapOff.installBootstrapState=(json,expected)=>{original(json,expected);throw Error('install failed');};
    f.c.CapOff.recoverBootstrap=async()=>{throw Error('simulated disk failure');};
    const r=await f.run();assert.equal(r.ok,false);assert.match(r.error,/HARD FAILURE/);
    assert.ok(new Map((await f.image()).syncmeta).has('cloud-bootstrap-pending-v1'));
  });
  await test('new installs do not invoke seed; legacy saved datasets are not rewritten',async()=>{
    assert.match(app,/S = S \|\| \{accts:\[\],tx:\[\]/);assert.ok(!app.includes('S = S || seed()'));
    assert.match(app,/const hadSavedCapState = !!S/);
  });
  await test('actual startup state construction is empty on fresh storage',async()=>{
    const code=app.slice(app.indexOf('      try {\n        S = JSON.parse(localStorage.getItem("pera")'),app.indexOf('      const save = () =>'));
    const c={S:null,localStorage:{getItem:()=>null}};vm.createContext(c);vm.runInContext(code,c);
    assert.equal(c.S.accts.length,0);assert.equal(c.S.tx.length,0);assert.equal(c.S.goals.length,0);assert.equal(c.S.debts.length,0);
    const existing=productionState(),old=JSON.stringify(existing);const other={S:null,localStorage:{getItem:()=>old}};
    vm.createContext(other);vm.runInContext(code,other);assert.equal(JSON.stringify(other.S),old);
  });
  await test('concurrent local edits prevent commit instead of being overwritten',async()=>{
    const f=await fixture();f.c.confirm=()=>{f.c.S.name='Concurrent edit';return true;};
    assert.equal((await f.run()).ok,false);assert.equal(f.c.S.name,'Concurrent edit');assert.ok(!new Map((await f.image()).syncmeta).has('baseline'));
  });
  await test('unrelated storage written after install is retained; rollback fails closed',async()=>{
    const f=await fixture(),original=f.c.CapOff.installBootstrapState;
    f.c.CapOff.installBootstrapState=(json,expected)=>{original(json,expected);f.storage.set('pera','{"concurrent":"edit"}');throw Error('installation interrupted');};
    const result=await f.run();assert.equal(result.ok,false);assert.match(result.error,/HARD FAILURE/);
    assert.equal(f.storage.get('pera'),' {"concurrent":"edit"}'.trim());assert.ok(new Map((await f.image()).syncmeta).has('cloud-bootstrap-pending-v1'));
  });
  await test('render compatibility normalization cannot silently change cloud account fields',async()=>{
    const f=await fixture({production:s=>{delete s.accts[1].net;delete s.accts[1].img;}});
    assert.equal((await f.run()).ok,false);await f.unchanged();
  });
  if(process.env.CAP_BOOTSTRAP_SNAPSHOT_PATH)await test('external saved production snapshot compatibility (offline only)',async()=>{
    const external=JSON.parse(fs.readFileSync(process.env.CAP_BOOTSTRAP_SNAPSHOT_PATH,'utf8')).snapshot;
    const f=await fixture({mutate:()=>clone(external)}),r=await f.run();assert.equal(r.ok,true,r.error);assert.equal(r.records,external.record_count);
  });
  console.log(`PASS: ${passed} Phase 6M cloud bootstrap checks; synthetic fixtures; no production access`);
})().catch(e=>{console.error(e);process.exitCode=1;});
