/* Configuration/environment checks with synthetic values only. Never reads the
   ignored local configuration, environment variables, or real browser storage. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),cp=require('node:child_process');
const fake=require(process.env.CAP_FAKE_IDB_PATH||'fake-indexeddb');
const root=require('node:path').resolve(__dirname,'..');
const source=fs.readFileSync(root+'/js/runtime-config.js','utf8');
let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name)};
function fixture(host='localhost',options={}){
  const scripts=[],badges=[],deleted=[],unregistered=[];let reloads=0,stops=0;
  const c={URL,Promise,Date,Object,JSON,atob:s=>Buffer.from(s,'base64').toString(),
    location:{hostname:host,href:'http://'+host+':8123/',reload:()=>reloads++},
    document:{write:s=>scripts.push(s),createElement:()=>({setAttribute(){}}),body:{appendChild:e=>badges.push(e)}},
    navigator:{},caches:{keys:async()=>['cap-shell-v325','unrelated-cache'],delete:async k=>deleted.push(k)},
    stop:()=>stops++};
  c.window=c;
  if(options.worker)c.navigator.serviceWorker={controller:{scriptURL:'http://'+host+':8123/service-worker.js'},getRegistrations:async()=>[
    {active:{scriptURL:'http://'+host+':8123/service-worker.js'},unregister:async()=>{unregistered.push('cap');return true}},
    {active:{scriptURL:'http://'+host+':8123/unrelated.js'},unregister:async()=>{unregistered.push('other');return true}}]};
  vm.createContext(c);vm.runInContext(source,c);
  return {c,scripts,badges,deleted,unregistered,reloads:()=>reloads,stops:()=>stops};
}
(async()=>{
  for(const host of ['localhost','127.0.0.1','[::1]'])await test(host+' selects only cache-busted local configuration',async()=>{
    const f=fixture(host);await f.c.CapEnvironment.ready;
    assert.equal(f.c.CapEnvironment.local,true);assert.match(f.scripts[0],/supabase-config\.local\.js\?local=\d+/);
    assert.equal(f.badges.length,0);assert.equal(f.c.CapEnvironment.databaseName,'cap-finance-local-preview');
    assert.equal(JSON.stringify(f.c.CapEnvironment.browserConfig()),'{}');
  });
  for(const host of ['cap.example','localhost.example','127.0.0.1.example'])await test(host+' retains generated production path without local indicator',async()=>{
    const f=fixture(host);assert.equal(f.c.CapEnvironment.local,false);
    assert.equal(f.scripts[0],'<script src="supabase-config.js"></script>');assert.equal(f.badges.length,0);
    assert.equal(f.c.CapEnvironment.databaseName,'cap-finance');assert.equal(f.deleted.length,0);
  });
  await test('missing and placeholder local configuration fails closed',async()=>{
    const f=fixture();f.c.CAP_SUPABASE_CONFIG={url:'PASTE_YOUR_SUPABASE_URL_HERE',publishableKey:'PASTE_YOUR_PUBLISHABLE_OR_ANON_KEY_HERE'};
    assert.equal(JSON.stringify(f.c.CapEnvironment.browserConfig()),'{}');
    f.c.CAP_SUPABASE_CONFIG=null;assert.equal(JSON.stringify(f.c.CapEnvironment.browserConfig()),'{}');
  });
  await test('browser-safe publishable configuration is accepted without logging or writing files',async()=>{
    const f=fixture();f.c.CAP_SUPABASE_CONFIG={url:'https://fixture.invalid/',publishableKey:'sb_publishable_fixture'};
    assert.equal(f.c.CapEnvironment.browserConfig().url,'https://fixture.invalid');
    assert.equal(f.c.CapEnvironment.browserConfig().publishableKey,'sb_publishable_fixture');
  });
  await test('legacy anon key is accepted, privileged or authenticated JWT roles are rejected',async()=>{
    const f=fixture();
    for(const role of ['anon','service_role','authenticated']){
      const key=['e30',Buffer.from(JSON.stringify({role})).toString('base64url'),'fixture'].join('.');
      f.c.CAP_SUPABASE_CONFIG={url:'https://fixture.invalid',publishableKey:key};
      assert.equal(!!f.c.CapEnvironment.browserConfig().url,role==='anon');
    }
  });
  await test('invalid origins and non-browser secrets are refused without echoing their values',async()=>{
    const f=fixture();
    for(const url of ['javascript:void(0)','https://user:pass@fixture.invalid','https://fixture.invalid/?key=x']){
      f.c.CAP_SUPABASE_CONFIG={url,publishableKey:'sb_publishable_fixture'};assert.equal(JSON.stringify(f.c.CapEnvironment.browserConfig()),'{}');
    }
    f.c.CAP_SUPABASE_CONFIG={url:'https://fixture.invalid',publishableKey:['sb','secret','fixture'].join('_')};
    assert.equal(JSON.stringify(f.c.CapEnvironment.browserConfig()),'{}');
  });
  await test('old local worker stops document startup, unregisters only Cap, and reloads once',async()=>{
    const f=fixture('localhost',{worker:true});await new Promise(r=>setImmediate(r));
    assert.equal(f.stops(),1);assert.equal(f.reloads(),1);assert.equal(f.scripts.length,0);
    assert.deepEqual(f.unregistered,['cap']);assert.deepEqual(f.deleted,['cap-shell-v325']);
  });
  await test('local worker cleanup never touches production-host caches',async()=>{
    const f=fixture('production.invalid',{worker:true});await f.c.CapEnvironment.ready;
    assert.equal(f.reloads(),0);assert.equal(f.stops(),0);assert.deepEqual(f.deleted,[]);assert.deepEqual(f.unregistered,[]);
  });
  await test('local file is ignored and untracked; no local contents are inspected',async()=>{
    cp.execFileSync('git',['check-ignore','--quiet','supabase-config.local.js'],{cwd:root});
    assert.equal(cp.execFileSync('git',['ls-files','--','supabase-config.local.js'],{cwd:root,encoding:'utf8'}).trim(),'');
    assert.doesNotMatch(cp.execFileSync('git',['diff','--name-only','HEAD'],{cwd:root,encoding:'utf8'}),/^supabase-config\.local\.js$/m);
  });
  await test('new local storage cannot inherit legacy enabled sync, and explicit local settings stay isolated',async()=>{
    const app=fs.readFileSync(root+'/js/app.js','utf8'),factory=new fake.IDBFactory();
    const make=local=>{
      const c={indexedDB:factory,clearTimeout(){},localStorage:{getItem:()=>null},CapEnvironment:{databaseName:local?'cap-finance-local-preview':'cap-finance'}};
      c.window=c;vm.createContext(c);vm.runInContext(app.slice(0,app.indexOf('  /* ---------- events ---------- */'))+'})();',c);return c.CapOff;
    };
    const old=make(false);await old.syncStore('syncmeta','put',{enabled:true,owner:'fixture'},'production-sync-v1');
    const preview=make(true),snapshot=await preview.productionSyncSnapshot();assert.equal(snapshot.settings,null);
    assert.equal(snapshot.baseline,null);assert.equal(snapshot.outbox.length,0);
    await preview.productionSyncCommit(snapshot,{settings:{enabled:true,owner:'local-fixture'}},()=>true);
    assert.equal((await make(true).productionSyncSnapshot()).settings.owner,'local-fixture');
    assert.equal((await old.productionSyncSnapshot()).settings.owner,'fixture');
  });
  await test('production build generator and RPC data path remain independent of the local file',async()=>{
    const generator=fs.readFileSync(root+'/scripts/generate-supabase-config.cjs','utf8');
    assert.doesNotMatch(generator,/supabase-config\.local/);
    assert.equal(JSON.parse(fs.readFileSync(root+'/vercel.json','utf8')).buildCommand,'node scripts/generate-supabase-config.cjs');
    const sw=fs.readFileSync(root+'/service-worker.js','utf8');assert.ok(sw.includes('./js/runtime-config.js'));
    assert.doesNotMatch(sw,/supabase-config\.local/);assert.match(sw,/if \(LOCAL_PREVIEW\) return;/);
    assert.doesNotMatch(fs.readFileSync(root+'/index.html','utf8'),/local-development-browser|ui-presentation-browser/);
  });
  console.log(`PASS: ${passed} local development environment checks; synthetic values only`);
})().catch(()=>{console.error('Local development environment check failed (configuration values suppressed).');process.exitCode=1});
