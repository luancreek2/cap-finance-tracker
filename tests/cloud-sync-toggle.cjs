/* UI/controller integration with synthetic data, fake DOM/IDB and mocked RPCs.
   Never loads the live app profile or contacts Supabase. */
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const fake = require(process.env.CAP_FAKE_IDB_PATH || 'fake-indexeddb');
const app = fs.readFileSync(`${__dirname}/../js/app.js`,'utf8');
const clone = x => JSON.parse(JSON.stringify(x));
const owner = 'synthetic-toggle-owner';
const readyChecks = Object.fromEntries(['snapshot_contract','snapshot_read_access','readiness_contract',
  'transaction_create_contract','durable_receipts','notes_receipts','notes_sidecar',
  'rpc_only_reads','legacy_lockout','writer_privileges','service_role_private'].map(k=>[k,true]));
const readyContracts = { readiness:'CAP_PRODUCTION_SYNC_READINESS_V1',snapshot:'CAP_SYNC_SNAPSHOT_V1',
  transaction_create:'CAP_TX_CREATE_CAS_RECEIPT_V1',notes_change:'CAP_NOTES_SIDECAR_V1' };
const ready = { version:'CAP_PRODUCTION_SYNC_V1',ready:true,legacy_lockout:true,private_sidecar:true,
  rpc_only_reads:true,writer_bypassrls:false,atomic_transaction_create:true,durable_operation_receipts:true,
  checks:readyChecks,contracts:readyContracts };
async function fixture() {
  const events=new Map(),storage=new Map();
  const element=()=>({checked:false,disabled:false,textContent:'',attributes:{},setAttribute(k,v){this.attributes[k]=v;}});
  const elements=Object.fromEntries(['production-sync-toggle','production-sync-status','production-sync-label'].map(k=>[k,element()]));
  const f={consent:false,report:{...ready,ready:false},rpcCalls:[],mutationCalls:0,authCalls:0,authenticated:true,session:1,consents:0};
  const c={ indexedDB:new fake.IDBFactory(),crypto:webcrypto,TextEncoder,URLSearchParams,location:{search:''},
    S:{notes:Array.from({length:47},(_,i)=>({id:i+1,t:'Synthetic',b:'Fixture',d:'2026-10-21'}))},
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
    document:{hidden:false,getElementById:k=>elements[k]||null,addEventListener:(name,fn)=>events.set(name,fn)},
    addEventListener:(name,fn)=>events.set(name,fn),clearTimeout(){},setTimeout(){},setInterval(){},
    navigator:{onLine:true,locks:{request:async(name,options,fn)=>fn()},serviceWorker:{addEventListener(){}}},
    confirm:()=>{f.consents++;return f.consent;},
    migrationPrepare:()=>({blockingProblems:[]}) };
  c.window=c;vm.createContext(c);
  vm.runInContext(app.slice(0,app.indexOf('  /* ---------- events ---------- */'))+'})();',c);
  vm.runInContext(fs.readFileSync(`${__dirname}/../js/sync.js`,'utf8'),c);
  const rows=c.S.notes.map(n=>({entity:'notes',row:{id:'note-'+n.id,user_id:owner,legacy_id:String(n.id),title:n.t,body:n.b,note_date:n.d},
    lifecycle:{version:1,revision:1,deleted_at:null,operation_id:null}}));
  const baseline={version:2,user_id:owner,records:[]};
  for(const r of rows)baseline.records.push({entity:'notes',localId:r.row.legacy_id,supabase_id:r.row.id,user_id:owner,contentFingerprint:await c.CapSync.fingerprintRow('notes',r.row)});
  c.buildSupabaseMigrationPlan=()=>({tables:[['notes',clone(rows.map(r=>r.row))]],profile:{id:owner},preferences:{user_id:owner}});
  // The actual browser mapper includes singletons, so seed those as well.
  rows.push({entity:'profiles',row:{id:owner}},{entity:'user_preferences',row:{user_id:owner}});
  for(const r of rows.slice(-2))baseline.records.push({entity:r.entity,localId:owner,supabase_id:owner,user_id:owner,contentFingerprint:await c.CapSync.fingerprintRow(r.entity,r.row)});
  c.buildSupabaseMigrationPlan=()=>({tables:[['notes',clone(rows.filter(r=>r.entity==='notes').map(r=>r.row))]],profile:{id:owner},preferences:{user_id:owner}});
  c.CapSupabase={localIdentity:()=>owner,sessionGeneration:()=>f.session,status:()=>({authenticated:f.authenticated}),
    currentUser:async()=>{f.authCalls++;if(f.authError)throw f.authError;return{id:owner};},
    syncRequest:async(path)=>{
      f.rpcCalls.push(path);
      if(path.endsWith('/cap_verify_production_sync_v1')){if(f.readyError)throw f.readyError;if(f.waitReady)await f.waitReady;return f.report;}
      if(path.endsWith('/cap_sync_snapshot_v1'))return{version:'CAP_SYNC_SNAPSHOT_V1',owner,complete:true,
        record_count:49,counts:{profiles:1,user_preferences:1,categories:0,accounts:0,goals:0,debts:0,
          bills:0,account_statements:0,transactions:0,transfers:0,bill_payments:0,budgets:0,notes:47},
        records:clone(rows)};
      f.mutationCalls++;throw Error('Forbidden mutation RPC');
    }};
  await c.CapOff.syncStore('syncmeta','put',baseline,'baseline');
  await c.CapOff.syncStore('kv','put',{json:JSON.stringify(c.S),mt:0},'state');
  storage.set('pera',JSON.stringify(c.S));
  vm.runInContext(fs.readFileSync(`${__dirname}/../js/sync-production.js`,'utf8'),c);
  await events.get('DOMContentLoaded')();
  return Object.assign(f,{c,elements,storage,events,baseline,rows,
    snapshot:()=>c.CapOff.productionSyncSnapshot(),
    click:async checked=>{elements['production-sync-toggle'].checked=checked;await c.CapProductionSync.toggle(checked);}});
}
let passed=0;
async function test(label,fn){try{await fn();passed++;}catch(e){e.message=label+': '+e.message;throw e;}}
(async()=>{
  await test('native switch markup uses only minimal reference design',async()=>{
    const f=await fixture(),html=f.c.CapSync.settingsHtml();
    for(const s of ['type="checkbox"','role="switch"','aria-label="Cloud Sync"','aria-describedby="production-sync-status"','cloud-toggle-minimal','cloud-toggle-knob','aria-hidden="true"'])assert.ok(html.includes(s),s);
    assert.ok(!/Cloud Storage|Day\/Night|toggle-container|cloud-toggle-alt|Turn ON/.test(html));
    assert.equal(f.elements['production-sync-toggle'].checked,false);assert.equal(f.elements['production-sync-label'].textContent,'Cloud Sync: OFF');
  });
  await test('OFF boot is read-only and preserves the synthetic dataset',async()=>{
    const f=await fixture();assert.equal(f.authCalls,0);assert.equal(f.rpcCalls.length,0);assert.equal(f.mutationCalls,0);
    assert.equal(f.c.S.notes.length,47);assert.equal(f.storage.get('pera'),JSON.stringify(f.c.S));assert.equal((await f.snapshot()).settings,null);
  });
  await test('cancelled activation restores OFF without storage or network changes',async()=>{
    const f=await fixture(),before=JSON.stringify(await f.snapshot());await f.click(true);
    assert.equal(f.elements['production-sync-toggle'].checked,false);assert.equal(f.authCalls,0);assert.equal(JSON.stringify(await f.snapshot()),before);
  });
  await test('unready production engine leaves OFF with a specific reason',async()=>{
    const f=await fixture(),before=JSON.stringify(await f.snapshot()),local=JSON.stringify(f.c.S);f.consent=true;await f.click(true);
    assert.equal(f.elements['production-sync-toggle'].checked,false);assert.equal(f.c.CapProductionSync.status().enabled,false);
    assert.match(f.elements['production-sync-status'].textContent,/production.*readiness/i);
    assert.match(f.c.CapSync.settingsHtml(),/production.*readiness/i);
    assert.equal(JSON.stringify(await f.snapshot()),before);assert.equal(JSON.stringify(f.c.S),local);assert.equal(f.mutationCalls,0);
  });
  await test('missing production RPC displays availability reason, not private backend text',async()=>{
    const f=await fixture();f.consent=true;f.readyError={status:404,code:'PGRST202',message:'private contents'};await f.click(true);
    assert.match(f.elements['production-sync-status'].textContent,/production RPC is not available/);assert.ok(!f.elements['production-sync-status'].textContent.includes('private contents'));assert.equal(f.mutationCalls,0);
  });
  await test('baseline failure stays OFF and cannot recreate the baseline',async()=>{
    const f=await fixture();await f.c.CapOff.syncStore('syncmeta','put',{version:1},'baseline');const before=JSON.stringify(await f.snapshot());f.consent=true;await f.click(true);
    assert.match(f.elements['production-sync-status'].textContent,/baseline could not be verified/i);assert.equal(JSON.stringify(await f.snapshot()),before);assert.equal(f.rpcCalls.length,0);
  });
  await test('busy toggle stays visually OFF and suppresses double activation',async()=>{
    const f=await fixture();f.consent=true;let finish;f.waitReady=new Promise(resolve=>{finish=resolve;});
    const attempt=f.click(true);while(f.rpcCalls.length===0)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.elements['production-sync-toggle'].disabled,true);assert.equal(f.elements['production-sync-toggle'].checked,false);
    await f.click(true);assert.equal(f.consents,1);finish();await attempt;assert.equal(f.elements['production-sync-toggle'].disabled,false);assert.equal(f.mutationCalls,0);
  });
  await test('synthetic ready engine accepts switch; OFF persists without clearing metadata',async()=>{
    const f=await fixture();f.consent=true;f.report=ready;const before=await f.snapshot();await f.click(true);
    assert.equal(f.elements['production-sync-toggle'].checked,true);assert.equal(f.elements['production-sync-label'].textContent,'Cloud Sync: ON');assert.equal((await f.snapshot()).settings.enabled,true);
    vm.runInContext(fs.readFileSync(`${__dirname}/../js/sync-production.js`,'utf8'),f.c);
    await f.events.get('DOMContentLoaded')();assert.equal(f.elements['production-sync-toggle'].checked,true);
    f.c.navigator.onLine=false;await f.click(false);const after=await f.snapshot();
    assert.equal(f.elements['production-sync-toggle'].checked,false);assert.equal(after.settings.enabled,false);
    assert.equal(JSON.stringify(after.baseline),JSON.stringify(before.baseline));assert.equal(JSON.stringify(after.outbox),JSON.stringify(before.outbox));assert.equal(f.mutationCalls,0);
    assert.equal(f.storage.get('pera'),JSON.stringify(f.c.S));assert.equal(f.c.S.notes.length,47);
    await f.events.get('DOMContentLoaded')();assert.equal(f.elements['production-sync-toggle'].checked,false);
  });
  await test('style is scoped, fixed-size, keyboard-visible and reduced-motion aware',async()=>{
    const css=fs.readFileSync(`${__dirname}/../css/cloud-sync.css`,'utf8');
    for(const term of ['width: 70px','height: 36px','translateX(34px)','place-items: center',':focus-visible','prefers-reduced-motion','data-theme="dark"','html.noanim','html.rm'])assert.ok(css.includes(term),term);
    assert.ok(!/display:\s*none|@keyframes|linear-gradient|transition:\s*all/.test(css));
    assert.ok(fs.readFileSync(`${__dirname}/../index.html`,'utf8').includes('css/cloud-sync.css'));
    assert.ok(fs.readFileSync(`${__dirname}/../service-worker.js`,'utf8').includes('./css/cloud-sync.css'));
  });
  console.log(`PASS: ${passed} isolated minimal Cloud Sync toggle checks; zero production calls or real-data changes`);
})().catch(e=>{console.error(e);process.exitCode=1;});
