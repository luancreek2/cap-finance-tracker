/* Optional real-browser config/Auth transport checks. Disposable HTTP server and
   browser profiles only. Never reads ignored configuration or real credentials.
   CAP_PLAYWRIGHT_PATH points to an external playwright-core installation. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
if(!process.env.CAP_PLAYWRIGHT_PATH){console.log('SKIP: browser checks require CAP_PLAYWRIGHT_PATH (no production requests made)');process.exit(0)}
const {chromium}=require(process.env.CAP_PLAYWRIGHT_PATH),root=path.resolve(__dirname,'..');
let mode='valid',origin,passed=0,server,browser;const requests=[];
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.mp3':'audio/mpeg'};
const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name)};
const json=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
(async()=>{
  server=http.createServer((req,res)=>{
    const u=new URL(req.url,origin);requests.push({path:u.pathname,method:req.method});
    if(u.pathname==='/supabase-config.local.js'){
      if(mode==='missing'){res.writeHead(404);return res.end()}
      const config=mode==='invalid'?{url:'PASTE_YOUR_SUPABASE_URL_HERE',publishableKey:'PASTE_YOUR_PUBLISHABLE_OR_ANON_KEY_HERE'}:{url:origin,publishableKey:'sb_publishable_fixture'};
      res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});return res.end('window.CAP_SUPABASE_CONFIG='+JSON.stringify(config)+';');
    }
    if(u.pathname==='/supabase-config.js'){
      res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});return res.end('window.CAP_SUPABASE_CONFIG={url:"https://fixture.invalid",publishableKey:"sb_publishable_fixture"};');
    }
    if(u.pathname==='/auth/v1/token'){
      let data='';req.on('data',b=>data+=b);req.on('end',()=>{
        const body=JSON.parse(data||'{}');
        if(body.email!=='fixture@example.invalid'||body.password!=='test')return json(res,400,{message:'Invalid credentials'});
        return json(res,200,{access_token:'local-a',refresh_token:'local-r',user:{id:'00000000-0000-4000-8000-000000000099',email:'fixture@example.invalid'}});
      });return;
    }
    if(u.pathname==='/auth/v1/user')return json(res,req.headers.authorization==='Bearer local-a'?200:401,
      req.headers.authorization==='Bearer local-a'?{id:'00000000-0000-4000-8000-000000000099',email:'fixture@example.invalid'}:{message:'Authentication required'});
    if(u.pathname.startsWith('/rest/'))return json(res,405,{message:'Fixture refuses all financial API access'});
    if(u.pathname==='/old-cap-worker.js'){
      // Register under the real Cap script name via the mode below instead.
      res.writeHead(404);return res.end();
    }
    if(u.pathname==='/service-worker.js'&&mode==='old-worker'){
      res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});
      return res.end("self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));");
    }
    const file=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
    fs.readFile(file,(error,data)=>{res.writeHead(error?404:200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(error?'Missing':data)});
  });
  await new Promise(r=>server.listen(0,'0.0.0.0',r));origin='http://localhost:'+server.address().port;
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-proxy-server','--host-resolver-rules=MAP cap-preview.localhost 127.0.0.1']});
  const context=await browser.newContext();
  await context.route('**/*',route=>['localhost','127.0.0.1','cap-preview.localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  const page=await context.newPage();
  const load=async()=>{await page.goto(origin);await page.waitForFunction(()=>window.CapSupabase&&window.CapProductionSync);await page.evaluate(()=>CapSupabase.boot())};
  await test('missing local config displays normal login with local filename, never generated config',async()=>{
    mode='missing';requests.length=0;await load();assert.equal(await page.evaluate(()=>CapSupabase.configured()),false);
    assert.ok((await page.locator('#cap-auth-error').textContent()).includes('supabase-config.local.js'));
    assert.ok(requests.some(r=>r.path==='/supabase-config.local.js'));assert.ok(!requests.some(r=>r.path==='/supabase-config.js'));
  });
  await test('placeholder config stays unconfigured without a fallback or authenticated state',async()=>{
    mode='invalid';await load();assert.equal(await page.evaluate(()=>CapSupabase.status().authenticated),false);
    assert.equal(await page.evaluate(()=>CapSupabase.configured()),false);
  });
  await test('local config initializes the normal Auth client without a LOCAL badge',async()=>{
    mode='valid';await load();assert.equal(await page.evaluate(()=>CapSupabase.configured()),true);
    assert.equal(await page.locator('.cap-local-indicator').count(),0);assert.equal(await page.locator('#cap-auth').count(),1);
    assert.equal(await page.evaluate(()=>developerOptionsEnabled()),false);
  });
  await test('incorrect login is rejected by the existing Auth path',async()=>{
    await page.locator('#cap-auth-email').fill('fixture@example.invalid');await page.locator('#cap-auth-password').fill('bad');
    await page.evaluate(()=>CapSupabase.signIn());assert.equal(await page.evaluate(()=>CapSupabase.status().authenticated),false);
  });
  await test('normal login verifies session with server /user and reveals the authenticated Cap UI',async()=>{
    requests.length=0;await page.locator('#cap-auth-password').fill('test');await page.evaluate(()=>CapSupabase.signIn());
    await page.locator('#cap-auth').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>CapSupabase.status().authenticated),true);
    assert.ok(requests.some(r=>r.path==='/auth/v1/token'&&r.method==='POST'));assert.ok(requests.some(r=>r.path==='/auth/v1/user'));
    assert.ok(await page.locator('#app').isVisible());assert.ok(!requests.some(r=>r.path.startsWith('/rest/')));
    assert.equal(await page.evaluate(()=>CapProductionSync.status().enabled),false);
  });
  await test('Your Profile alone shows red Sign Out and a read-only email disclosure without extra requests',async()=>{
    await page.waitForFunction(()=>window.StShell&&!window.capLaunchActive);
    await page.evaluate(()=>{if(document.querySelector('.whats-new-overlay'))closeWhatsNew()});
    await page.evaluate(()=>{localStorage.setItem('cap-appearance-theme','apple');applyTheme();openSettings();});assert.equal(await page.getByRole('button',{name:'Sign Out',exact:true}).count(),0);
    const start=requests.length;await page.getByRole('button',{name:'Your Profile',exact:true}).click();
    const button=page.getByRole('button',{name:'Sign Out',exact:true});assert.equal(await button.count(),1);
    const style=await button.evaluate(e=>({color:getComputedStyle(e).color,boxed:!!e.closest('.st-box'),shadow:getComputedStyle(e).boxShadow,handler:e.getAttribute('onclick')}));
    const rgb=style.color.match(/[\d.]+/g).map(Number);assert.ok(rgb[0]>rgb[1]&&rgb[0]>rgb[2]);assert.equal(style.boxed,false);assert.equal(style.shadow,'none');assert.equal(style.handler,'CapSupabase.signOut()');
    assert.equal(await page.locator('.st-email-disclosure').getAttribute('open'),null);await page.locator('.st-email-disclosure summary').click();
    assert.equal(await page.locator('.st-email-value').textContent(),'fixture@example.invalid');assert.equal(await page.locator('.st-email-value input').count(),0);
    assert.equal(requests.length,start);
    await button.scrollIntoViewIfNeeded();await page.waitForTimeout(250);
    const review=path.join(process.env.LOCALAPPDATA,'Temp','opencode','settings-review');fs.mkdirSync(review,{recursive:true});await page.screenshot({path:path.join(review,'profile-account.png')});
    await page.evaluate(()=>stPrivacy());assert.equal(await page.getByRole('button',{name:'Sign Out',exact:true}).count(),0);await page.evaluate(()=>closeS());
  });
  await test('session restoration remains real authentication, with sync and Developer Options OFF after reload',async()=>{
    await load();assert.equal(await page.evaluate(()=>CapSupabase.status().authenticated),true);
    assert.equal(await page.evaluate(()=>CapProductionSync.status().enabled),false);
    assert.equal(await page.evaluate(()=>developerOptionsEnabled()),false);
    const s=await page.evaluate(()=>CapOff.productionSyncSnapshot());assert.equal(s.settings,null);assert.equal(s.baseline,null);
  });
  await test('local previews register no worker or configuration cache',async()=>{
    assert.equal(await page.evaluate(async()=>(await navigator.serviceWorker.getRegistrations()).length),0);
    assert.equal(await page.evaluate(async()=>(await caches.keys()).filter(k=>k.startsWith('cap-shell-')).length),0);
  });
  await test('an older controlling Cap worker is removed and local preview reloads safely',async()=>{
    mode='old-worker';await page.evaluate(async()=>{await navigator.serviceWorker.register('/service-worker.js');await navigator.serviceWorker.ready});
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);mode='valid';requests.length=0;
    await page.goto(origin);await page.waitForFunction(()=>window.CapSupabase?.status().authenticated===true);
    assert.equal(await page.evaluate(async()=>(await navigator.serviceWorker.getRegistrations()).length),0);
    assert.equal(await page.evaluate(()=>CapProductionSync.status().enabled),false);
    assert.ok(!requests.some(r=>r.path.startsWith('/rest/')));
  });
  await test('production-selector host retains generated config and offline shell without a LOCAL badge',async()=>{
    requests.length=0;const prod=await context.newPage();
    await prod.goto('http://cap-preview.localhost:'+server.address().port+'/');await prod.waitForFunction(()=>window.CapSupabase);
    assert.equal(await prod.evaluate(()=>CapEnvironment.local),false);assert.equal(await prod.evaluate(()=>CapSupabase.configured()),true);
    assert.equal(await prod.locator('.cap-local-indicator').count(),0);
    assert.ok(requests.some(r=>r.path==='/supabase-config.js'));assert.ok(!requests.some(r=>r.path==='/supabase-config.local.js'));
    await prod.evaluate(()=>navigator.serviceWorker.ready);await prod.reload();await prod.waitForFunction(()=>!!navigator.serviceWorker.controller);
    await context.setOffline(true);await prod.reload();
    assert.equal(await prod.evaluate(()=>CapSupabase.configured()),true);assert.equal(await prod.locator('.cap-local-indicator').count(),0);
    assert.ok(await prod.evaluate(async()=>(await caches.keys()).includes('cap-shell-v367')));
    assert.equal(await prod.evaluate(()=>typeof CapSmartLogParser?.parse),'function');
    await prod.waitForFunction(()=>window.StShell&&window.CapOverlays&&!window.capLaunchActive);
    const offlineSettings=await prod.evaluate(()=>{
      if(document.querySelector('.whats-new-overlay'))closeWhatsNew();
      document.querySelector('#cap-auth')?.remove();openSettings();
      const before=[document.getElementById('sb').offsetWidth,document.getElementById('sb').offsetHeight];
      stGo('profile');return {before,after:[document.getElementById('sb').offsetWidth,document.getElementById('sb').offsetHeight],title:document.getElementById('st-title').textContent};
    });
    assert.deepEqual(offlineSettings.before,offlineSettings.after);assert.equal(offlineSettings.title,'Your Profile');
    await context.setOffline(false);await prod.close();
  });
  await context.close();console.log(`PASS: ${passed} isolated local configuration/browser Auth checks; mocked HTTP Auth, no live Supabase`);
})().catch(()=>{console.error('Local browser verification failed (all configuration/credentials suppressed).');process.exitCode=1}).finally(async()=>{
  if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));
});
