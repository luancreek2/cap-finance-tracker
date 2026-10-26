/* Real browser activation/replay checks. Isolated origin; no live auth/cloud. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
if(!process.env.CAP_PLAYWRIGHT_PATH){console.log('SKIP: nav icon checks require CAP_PLAYWRIGHT_PATH');process.exit(0);}
const {chromium}=require(process.env.CAP_PLAYWRIGHT_PATH),root=path.resolve(__dirname,'..');
let browser,server,passed=0;
async function test(name,fn){await fn();console.log('PASS '+name);passed++;}
(async()=>{
  server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://fixture.invalid');
    if(['/supabase-config.js','/supabase-config.local.js'].includes(u.pathname)){res.setHeader('Content-Type','text/javascript');return res.end('window.CAP_SUPABASE_CONFIG={};');}
    const file=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
    fs.readFile(file,(err,b)=>{res.writeHead(err?404:200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(err?'Missing':b);});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'no-preference'});
  await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const page=await context.newPage();await page.goto(origin);
  await page.waitForFunction(()=>window.CapOverlays&&window.CapProductionSync&&!window.capLaunchActive);
  await page.evaluate(()=>{localStorage.setItem('cap_whats_new_seen_version',APP_VERSION);if(document.querySelector('.whats-new-overlay'))closeWhatsNew();document.querySelector('#cap-auth')?.remove();localStorage.setItem('cap-appearance-theme','apple');tab='Home';render();});
  await page.waitForTimeout(800);
  const glass=()=>page.locator('#tabs').evaluate(e=>{const s=getComputedStyle(e);return [s.backgroundColor,s.backdropFilter,s.borderRadius,s.boxShadow,e.getBoundingClientRect().toJSON()];});
  const before=await glass();
  const icons=[['Home','.nav-icon','navHomeLift'],['Activity','.nav-heartbeat','navHeartbeatDraw'],['Plan','.nav-paper','navPaperTurn'],['Accounts','.nav-wallet-card','navCardPeek']];
  for(const [tab,part,name] of icons){
    await test(tab+' animates only its icon once and keeps its active label',async()=>{
      const button=page.getByRole('button',{name:tab,exact:true});await button.click();
      assert.equal(await button.locator(part).evaluate(e=>getComputedStyle(e).animationName),name);
      assert.equal(await button.evaluate(e=>getComputedStyle(e).animationName),'none');
      assert.equal(await button.locator('.nav-label').innerText(),tab);
      assert.equal(await page.locator('#tabs button:not(.on) .nav-icon').evaluateAll(es=>es.every(e=>!e.getAnimations({subtree:true}).length)),true);
      const label=await button.locator('.nav-label').evaluate(e=>({opacity:getComputedStyle(e).opacity,rect:e.getBoundingClientRect().toJSON()}));
      await page.waitForTimeout(800);
      assert.equal(await button.locator(part).evaluate(e=>e.getAnimations().length),0);
      assert.equal(await button.locator('.nav-label').evaluate(e=>getComputedStyle(e).opacity),'1');
      assert.ok(label.rect.width>0);
      assert.deepEqual(await glass(),before);
    });
  }
  await test('active-tab reclick replays; ordinary render does not replay',async()=>{
    await page.getByRole('button',{name:'Accounts',exact:true}).click();
    assert.ok(await page.locator('#tabs .nav-wallet-card').evaluate(e=>e.getAnimations().length));
    await page.evaluate(()=>render());
    assert.equal(await page.locator('#tabs .nav-icon').evaluateAll(es=>es.some(e=>e.getAnimations({subtree:true}).length)),false);
  });
  await test('rapid tab changes leave only the final icon playing',async()=>{
    await page.evaluate(()=>{for(const t of ['Home','Activity','Plan','Accounts'])document.querySelector('#tabs .nav-tab-'+t.toLowerCase()).click();});
    assert.equal(await page.locator('#tabs .on .nav-label').innerText(),'Accounts');
    assert.equal(await page.locator('#tabs button:not(.on) .nav-icon').evaluateAll(es=>es.some(e=>e.getAnimations({subtree:true}).length)),false);
  });
  await test('Add animates only the plus glyph without changing active tab',async()=>{
    await page.getByRole('button',{name:'Add transaction',exact:true}).click();
    assert.equal(await page.locator('.nav-plus-glyph').evaluate(e=>getComputedStyle(e).animationName),'navAddPop');
    assert.equal(await page.locator('#tabs .on .nav-label').innerText(),'Accounts');
    assert.equal(await page.locator('.nav-action-plus').evaluate(e=>getComputedStyle(e).animationName),'none');
    await page.evaluate(()=>CapCommandBar.close());await page.waitForTimeout(800);
  });
  await test('OS reduced motion and both in-app motion flags suppress every icon',async()=>{
    for(const mode of ['os','rm','noanim']){
      await page.emulateMedia({reducedMotion:mode==='os'?'reduce':'no-preference'});
      for(const [tab,part] of icons){
        await page.getByRole('button',{name:tab,exact:true}).click();
        if(mode!=='os')await page.evaluate(m=>{document.documentElement.classList.add(m);playNavIcon(tab);},mode);
        assert.equal(await page.locator('#tabs .on').locator(part).evaluate(e=>getComputedStyle(e).animationName),'none');
        if(mode!=='os')await page.evaluate(m=>document.documentElement.classList.remove(m),mode);
      }
    }
  });
  for(const scheme of ['light','dark'])for(const theme of ['light','dark','auto','apple'])await test(theme+' / OS '+scheme+': active icons fill with contrasting details; inactive icons outline',async()=>{
    await page.emulateMedia({colorScheme:scheme,reducedMotion:'reduce'});
    await page.evaluate(t=>{localStorage.setItem('cap-appearance-theme',t);tab='Home';render();},theme);
    for(const name of ['Home','Plan','Accounts']){
      await page.getByRole('button',{name,exact:true}).click();
      const a=await page.locator('#tabs button.on').evaluate(e=>{
        const body=e.querySelector('.nav-house,.nav-paper-body,.nav-wallet-body'),detail=e.querySelector('.nav-icon-detail'),s=getComputedStyle(e);
        return {fill:getComputedStyle(body).fill,detail:getComputedStyle(detail).stroke,foreground:s.color,background:s.backgroundColor};
      });
      assert.equal(a.fill,a.foreground);assert.equal(a.detail,a.background);assert.notEqual(a.fill,a.detail);
      const rgb=s=>s.match(/[\d.]+/g).map(Number),fg=rgb(a.fill),detail=rgb(a.detail),alpha=detail[3]??1;
      const lum=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      const l1=lum(fg),l2=lum(detail.slice(0,3).map((v,i)=>v*alpha+fg[i]*(1-alpha)));
      assert.ok((Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)>=3,'interior contrast '+JSON.stringify(a));
      assert.equal(await page.locator('#tabs button:not(.on) :is(.nav-house,.nav-paper-body,.nav-wallet-body,.nav-wallet-card)').evaluateAll(es=>es.every(e=>getComputedStyle(e).fill==='none')),true);
      assert.equal(await page.locator('#tabs button:not(.on) .nav-icon-detail').evaluateAll(es=>es.every(e=>getComputedStyle(e).stroke===getComputedStyle(e.closest('button')).color)),true);
      if(theme==='apple'){
        const dir=path.join(process.env.LOCALAPPDATA||process.env.TEMP,'Temp','opencode','nav-filled-review');fs.mkdirSync(dir,{recursive:true});
        await page.locator('#tabs').screenshot({path:path.join(dir,name.toLowerCase()+'-'+scheme+'.png')});
      }
    }
    assert.equal(await page.locator('#tabs .nav-house').getAttribute('d'),'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
  });
  await page.emulateMedia({reducedMotion:'no-preference'});
  for(const width of [320,390,768])await test(width+'px compact previews fit and retain all four choices',async()=>{
    await page.setViewportSize({width,height:844});await page.evaluate(()=>stGo('appearance'));await page.waitForTimeout(400);
    const a=await page.locator('.theme-choice').evaluateAll(es=>es.map(e=>({r:e.getBoundingClientRect().toJSON(),height:parseFloat(getComputedStyle(e.querySelector('.theme-preview')).height),padding:getComputedStyle(e).padding,font:getComputedStyle(e.querySelector('.theme-choice-name')).fontSize})));
    assert.equal(a.length,4);for(const c of a){assert.equal(c.height,64);assert.equal(c.padding,'6px');assert.equal(c.font,'13px');assert.ok(c.r.left>=0&&c.r.right<=width);}
    await page.evaluate(()=>closeS());await page.waitForTimeout(300);
  });
  await context.close();console.log('PASS: '+passed+' nav animation / compact appearance checks');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));});
