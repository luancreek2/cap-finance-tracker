/* Actual index.html loading order, classic scripts, real CapOff/mapper/planner
   and UI button. Disposable browser/HTTP fixtures only; no real Supabase. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
if(!process.env.CAP_PLAYWRIGHT_PATH){console.log('SKIP: diagnostic browser execution requires CAP_PLAYWRIGHT_PATH');process.exit(0)}
const {chromium}=require(process.env.CAP_PLAYWRIGHT_PATH);
const {presenceFixture,OWNER,clone,OLD_LOCAL,OLD_CLOUD,OLD_BOTH}=require('./sync-presence-diagnostic-execution.cjs');
const root=path.resolve(__dirname,'..'),types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.mp3':'audio/mpeg'};
let browser,server,passed=0,raw;const rpcCalls=[];
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
(async()=>{
  const f=await presenceFixture();raw=clone(f.raw);
  const snapshot=clone(await f.c.CapOff.productionSyncSnapshot());
  server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://fixture.invalid');
    // Never read the ignored configuration from disk.
    if(['/supabase-config.local.js','/supabase-config.js'].includes(u.pathname)){
      res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});
      return res.end('window.CAP_SUPABASE_CONFIG={url:location.origin,publishableKey:"sb_publishable_fixture"};');
    }
    if(u.pathname==='/auth/v1/token')return json(res,200,{access_token:'local-a',refresh_token:'local-r',user:{id:OWNER}});
    if(u.pathname==='/auth/v1/user')return json(res,req.headers.authorization==='Bearer local-a'?200:401,
      req.headers.authorization==='Bearer local-a'?{id:OWNER}:{message:'Auth required'});
    if(u.pathname.startsWith('/rest/')){
      rpcCalls.push(u.pathname);
      if(u.pathname==='/rest/v1/rpc/cap_sync_snapshot_v1'&&req.method==='POST'&&req.headers.authorization==='Bearer local-a')return json(res,200,raw);
      return json(res,405,{message:'Fixture refuses all other data endpoints'});
    }
    const file=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
    fs.readFile(file,(error,data)=>{res.writeHead(error?404:200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(error?'Missing':data)});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();await page.goto(origin);
  await page.waitForFunction(()=>window.CapProductionSync&&window.CapOverlays);
  await page.evaluate(()=>{localStorage.setItem('cap_whats_new_seen_version',APP_VERSION);if(document.querySelector('.whats-new-overlay'))closeWhatsNew()});
  await page.locator('#cap-auth-email').fill('fixture@example.invalid');await page.locator('#cap-auth-password').fill('test');
  await page.evaluate(()=>CapSupabase.signIn());await page.locator('#cap-auth').waitFor({state:'detached'});
  await page.waitForFunction(()=>!window.capLaunchActive);
  // Seed only disposable fixture state BEFORE write monitoring starts. No sync
  // enable, cycle, capture, retry or recovery is invoked, even in this fixture.
  await page.evaluate(async({snapshot})=>{
    S=JSON.parse(snapshot.state.json);localStorage.setItem('pera',JSON.stringify(S));CapOff.resetProductionTracking();
    const db=await new Promise((resolve,reject)=>{const q=indexedDB.open(CapEnvironment.databaseName);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
    await new Promise((resolve,reject)=>{
      const t=db.transaction(['kv','syncmeta','outbox','syncconflicts'],'readwrite'),m=t.objectStore('syncmeta');
      m.put(snapshot.settings,'production-sync-v1');m.put(snapshot.baseline,'baseline');
      t.objectStore('kv').put(snapshot.state,'state');for(const e of snapshot.outbox)t.objectStore('outbox').put(e);
      t.oncomplete=resolve;t.onerror=()=>reject(t.error);
    });db.close();openSettings();
  },{snapshot});
  await test('production-loaded global exposes the diagnostic and only actual CapOff APIs',async()=>{
    const api=await page.evaluate(()=>({diagnostic:typeof CapProductionSync.inspectSyncPresence,snapshot:typeof CapOff.productionSyncSnapshot,
      fakeSnapshot:typeof CapOff.snapshot,fakeModel:typeof CapOff.model,fakeValidator:typeof CapOff.validateSnapshot,
      store:typeof CapOff.syncStore,plan:typeof CapProductionSync.plan,remote:typeof CapProductionSync.browserIO().remote}));
    assert.deepEqual(api,{diagnostic:'function',snapshot:'function',fakeSnapshot:'undefined',fakeModel:'undefined',fakeValidator:'undefined',store:'function',plan:'function',remote:'function'});
    await page.evaluate(()=>stPrivacy());await page.locator('#cloud-bootstrap-button').waitFor();
    assert.equal(await page.getByRole('button',{name:'Inspect Sync Presence',exact:true}).count(),0);
    await page.evaluate(()=>openSettings());
    await page.locator('[onchange="setDeveloperOptions(this)"]').check();
    await page.evaluate(()=>stPrivacy());await page.getByRole('button',{name:'Inspect Sync Presence',exact:true}).waitFor();
    await page.evaluate(()=>CapCloudBootstrap.refresh());
  });
  await page.evaluate(async()=>{
    const before=await CapOff.productionSyncSnapshot();
    window.__presenceAudit={before:JSON.stringify(before),memory:JSON.stringify(S),pera:localStorage.getItem('pera'),mutations:0,modes:[],requests:[]};
    const a=window.__presenceAudit,deny=()=>{a.mutations++;throw Error('Forbidden diagnostic write')};
    const transaction=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(stores,mode,...rest){a.modes.push(mode||'readonly');if(mode&&mode!=='readonly')return deny();return transaction.call(this,stores,mode,...rest)};
    for(const name of ['add','put','delete','clear'])IDBObjectStore.prototype[name]=deny;
    for(const name of ['setItem','removeItem','clear'])Storage.prototype[name]=deny;
    for(const name of ['productionSyncCommit','syncStore','persist','stamp','sync','requestSync','recoverBootstrap','installBootstrapState'])CapOff[name]=deny;
    for(const name of ['toggle','request','pause','authChanged'])CapProductionSync[name]=deny;
    CapSupabase.currentUser=deny;
    const read=CapSupabase.syncRequest;
    CapSupabase.syncRequest=(name,options)=>{a.requests.push(name);if(name!=='/rest/v1/rpc/cap_sync_snapshot_v1')return deny();return read(name,options)};
  });
  rpcCalls.length=0;
  await test('await CapProductionSync.inspectSyncPresence executes the entire real read path with no writes',async()=>{
    const report=await page.evaluate(()=>CapProductionSync.inspectSyncPresence());
    assert.equal(report.error,undefined);assert.equal(report.outbox.length,4);assert.equal(report.blocked.length,3);
    assert.equal(report.syncState.phase,'off');assert.equal(report.syncState.outboxCount,4);
    assert.equal(report.outbox[0].title,'Test');assert.equal(report.outbox[0].supabase_id,f.newId);
    assert.equal(report.phase6oDeleteAudit.locallyDeletedCloudPresent.length,1);
    assert.equal(report.phase6oDeleteAudit.locallyPresentCloudDeleted.length,1);
    assert.equal(report.phase6oDeleteAudit.missingBothRetainedByBaseline.length,1);
    assert.deepEqual(rpcCalls,['/rest/v1/rpc/cap_sync_snapshot_v1']);
  });
  await test('actual iPad-sized Developer Options button renders the complete diagnostic without writes',async()=>{
    await page.getByRole('button',{name:'Inspect Sync Presence',exact:true}).click();
    await page.locator('#sync-presence-result pre').waitFor();
    const text=await page.locator('#sync-presence-result').textContent();
    for(const value of ['Outbox (4)','Blocked presence records (3)','PHASE 6N DEVICE TEST','FINAL CLOUD SYNC TEST',f.newId,
      f.old(OLD_LOCAL).supabase_id,f.old(OLD_CLOUD).supabase_id,f.old(OLD_BOTH).supabase_id,
      'Missing locally, present in cloud (1)','Present locally, missing in cloud (1)','Missing both, retained by baseline (1)'])assert.ok(text.includes(value),value);
    assert.deepEqual(rpcCalls,['/rest/v1/rpc/cap_sync_snapshot_v1','/rest/v1/rpc/cap_sync_snapshot_v1']);
    const a=await page.evaluate(async()=>({mutations:__presenceAudit.mutations,modes:__presenceAudit.modes,
      storageSame:JSON.stringify(await CapOff.productionSyncSnapshot())===__presenceAudit.before,
      memorySame:JSON.stringify(S)===__presenceAudit.memory,peraSame:localStorage.getItem('pera')===__presenceAudit.pera,
      enabled:CapProductionSync.status().enabled}));
    assert.equal(a.mutations,0);assert.ok(a.modes.length>0&&a.modes.every(m=>m==='readonly'));
    assert.equal(a.storageSame,true);assert.equal(a.memorySame,true);assert.equal(a.peraSame,true);assert.equal(a.enabled,false);
  });
  await test('bad canonical snapshot reports a bounded validation error and still performs zero writes',async()=>{
    raw={...raw,complete:false};await page.evaluate(()=>inspectSyncPresence());
    assert.ok((await page.locator('#sync-presence-result').textContent()).includes('REMOTE_SNAPSHOT_INCOMPLETE'));
    assert.equal(await page.evaluate(()=>__presenceAudit.mutations),0);
  });
  await context.close();console.log(`PASS: ${passed} production-style diagnostic browser execution checks; no write APIs or storage mutations`);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r))});
