/* Isolated localhost browser, synthetic records, no authentication or cloud IO.
   Screenshots are review artifacts outside the repository, never app assets. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
if(!process.env.CAP_PLAYWRIGHT_PATH){console.log('SKIP: Apple browser checks require CAP_PLAYWRIGHT_PATH');process.exit(0);}
const {chromium}=require(process.env.CAP_PLAYWRIGHT_PATH);
const root=path.resolve(__dirname,'..'),shots=path.join(process.env.LOCALAPPDATA||process.env.TEMP,'Temp','opencode','apple-theme-review');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.mp3':'audio/mpeg'};
let browser,server,passed=0,financialRequests=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
async function settle(page){await page.waitForTimeout(550);}
async function ready(page){
  await page.waitForFunction(()=>window.CapProductionSync&&window.CapOverlays&&typeof appearanceTheme==='function');
  await page.waitForFunction(()=>!window.capLaunchActive);
  await page.evaluate(()=>{localStorage.setItem('cap_whats_new_seen_version',APP_VERSION);if(document.querySelector('.whats-new-overlay'))closeWhatsNew();document.querySelector('#cap-auth')?.remove();});
  await settle(page);
}
(async()=>{
  fs.mkdirSync(shots,{recursive:true});
  server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://fixture.invalid');
    if(['/supabase-config.js','/supabase-config.local.js'].includes(u.pathname)){
      res.writeHead(200,{'Content-Type':'text/javascript'});return res.end('window.CAP_SUPABASE_CONFIG={};');
    }
    if(u.pathname.startsWith('/rest/')||u.pathname.startsWith('/auth/')){financialRequests++;res.writeHead(403);return res.end();}
    const file=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
    fs.readFile(file,(e,b)=>{res.writeHead(e?404:200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(e?'Missing':b);});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext();
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();await page.goto(origin);await ready(page);
  await page.evaluate(()=>{
    S.accts=[{id:100,name:'Design fixture Cash',bank:'Fixture',type:'debit',img:'cash',bal:1250,g:['#234567','#123456']},
      {id:101,name:'Design fixture Credit',bank:'Fixture',type:'credit',bal:125,lim:1000,l4:'1234',stmt:15,due:5,g:['#234567','#123456']}];
    S.tx=[{id:500,d:new Date().toISOString().slice(0,10),amt:-12.5,cat:'Food',acct:100,note:'Design fixture expense'}];
    tab='Home';render();
  });await settle(page);
  await test('Apple Theme and all existing theme choices are available',async()=>{
    await page.evaluate(()=>stGo('appearance'));await settle(page);
    for(const label of ['Light','Dark','Auto','Apple Theme'])assert.equal(await page.getByRole('button',{name:label,exact:true}).count(),1);
  });
  await test('selecting Apple changes only presentation, not financial/sync/hold state',async()=>{
    const snap=()=>page.evaluate(async()=>JSON.stringify({S,s:await CapOff.productionSyncSnapshot(),hold:localStorage.getItem(CapProductionSync.recoveryKey)}));
    const before=await snap();await page.getByRole('button',{name:'Apple Theme',exact:true}).click();await settle(page);
    assert.equal(await page.evaluate(()=>appearanceTheme()),'apple');assert.equal(await snap(),before);
    assert.equal(await page.getByRole('button',{name:'Apple Theme',exact:true}).getAttribute('aria-pressed'),'true');
  });
  await test('Apple persists after reload',async()=>{await page.reload();await ready(page);assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'apple');});
  await test('Apple persists after closing and reopening a browser context',async()=>{
    const state=await context.storageState(),reopened=await browser.newContext({storageState:state});
    await reopened.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
    const p=await reopened.newPage();await p.goto(origin);await ready(p);assert.equal(await p.evaluate(()=>appearanceTheme()),'apple');await reopened.close();
  });
  const sizes=[[390,844,'phone'],[768,1024,'tablet-portrait'],[1024,768,'tablet-landscape'],[1440,900,'desktop'],[360,780,'narrow'],[320,740,'small']];
  for(const colorScheme of ['light','dark'])for(const [width,height,name] of sizes){
    const tag=name+' '+colorScheme;
    await page.setViewportSize({width,height});await page.emulateMedia({colorScheme});
    await page.evaluate(()=>{closeS();tab='Home';render();});await settle(page);
    await test(tag+': capsule/touch targets fit viewport and clear content safe area',async()=>{
      const a=await page.evaluate(()=>{
        const n=document.querySelector('#tabs'),r=n.getBoundingClientRect(),b=[...n.children].map(e=>{const r=e.getBoundingClientRect();return {l:r.left,r:r.right,w:r.width,h:r.height};});
        return {l:r.left,r:r.right,t:r.top,b:r.bottom,vh:innerHeight,vw:innerWidth,targets:b,padding:parseFloat(getComputedStyle(document.body).paddingBottom)};
      });
      assert.ok(a.l>=0&&a.r<=width&&a.b<=height&&a.t>0);assert.equal(a.targets.length,5);
      for(const b of a.targets)assert.ok(b.w>=44&&b.h>=44&&b.l>=a.l&&b.r<=a.r,JSON.stringify(b));
      assert.ok(a.padding>=112&&a.vh-a.t<a.padding);
    });
    await test(tag+': one translucent blur layer, opaque content and original Cap type',async()=>{
      const a=await page.evaluate(()=>{
        const n=document.querySelector('#tabs'),c=getComputedStyle(n),card=document.querySelector('.card');
        return {bg:c.backgroundColor,blur:c.backdropFilter||c.webkitBackdropFilter,children:[...n.querySelectorAll('*')].every(e=>{const s=getComputedStyle(e);return (!s.backdropFilter||s.backdropFilter==='none')&&(!s.webkitBackdropFilter||s.webkitBackdropFilter==='none');}),
          font:getComputedStyle(document.body).fontFamily,card:card?getComputedStyle(card).backgroundColor:null};
      });
      assert.match(a.bg,/rgba\(/);assert.match(a.blur,/blur\(14px\)/);assert.equal(a.children,true);
      assert.match(a.font,/-apple-system/);assert.match(a.font,/"Segoe UI"/);assert.match(a.font,/Inter/);assert.match(a.font,/Roboto/);assert.doesNotMatch(a.font,/SF Pro|BlinkMacSystemFont/);
      if(a.card)assert.ok(!a.card.startsWith('rgba('),a.card);
    });
    await test(tag+': text and semantic financial colors retain AA contrast',async()=>{
      const pairs=await page.evaluate(()=>{
        const probe=document.createElement('span');document.body.append(probe);
        const resolved=t=>{probe.style.color='var('+t+')';return getComputedStyle(probe).color;};
        const bg=resolved('--color-surface'),pairs=['--color-text-primary','--color-text-secondary','--color-success','--color-danger','--color-link'].map(t=>[t,resolved(t),bg]);probe.remove();return pairs;
      });
      const lum=s=>{const rgb=s.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
      for(const [token,fg,bg] of pairs){const a=lum(fg),b=lum(bg);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,token+' '+fg+' on '+bg);}
    });
    for(const section of ['home','activity','plan','accounts'])await test(tag+': '+section+' selected icon/text and navigation preserved',async()=>{
      await page.locator('#tabs .nav-tab-'+section).click();await settle(page);
      assert.equal(await page.locator('#tabs button.on').count(),1);
      assert.ok(await page.locator('#tabs .nav-tab-'+section).evaluate(e=>e.classList.contains('on')));
      assert.ok(await page.locator('#tabs button.on .nav-icon svg').count());
      const label=await page.locator('#tabs button.on .nav-label').evaluate(e=>({text:e.textContent,opacity:getComputedStyle(e).opacity,width:e.getBoundingClientRect().width,scroll:e.scrollWidth}));
      assert.ok(label.text&&label.opacity==='1'&&label.width>0);assert.ok(label.scroll<=label.width+1,'selected label clipped');
    });
    await page.evaluate(()=>{tab='Home';render();});await settle(page);
    await page.screenshot({path:path.join(shots,name+'-'+colorScheme+'.png'),fullPage:false});
  }
  await test('center + command bar delegates manual entry with correctly layered dropdown',async()=>{
    await page.locator('#tabs .nav-action').click();await settle(page);
    await page.getByRole('button',{name:'Open Manual New Entry',exact:true}).click();await settle(page);
    assert.ok(await page.locator('#sb #am').count());
    await page.locator('#sb .ps-btn').first().click();await page.waitForTimeout(220);
    assert.equal(await page.locator('#cap-overlays .ps-pop:not(.out)').count(),1);
    await page.keyboard.press('Escape');await page.evaluate(()=>closeS());await settle(page);
    await page.evaluate(()=>CapCommandBar.close());await settle(page);
  });
  await test('transaction edit modal, menu and long press still open',async()=>{
    await page.evaluate(()=>{tab='Activity';render();});await settle(page);
    const row=page.locator('.row[data-tx="500"]').first();await row.scrollIntoViewIfNeeded();
    const box=await row.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.waitForTimeout(650);await page.mouse.up();await settle(page);
    assert.ok(await page.locator('#sb').innerText().then(t=>t.includes('Design fixture expense')));
    await page.evaluate(()=>closeS());await settle(page);
    const dots=page.locator('.row[data-tx="500"] .dots').first();
    await dots.evaluate(e=>e.scrollIntoView({block:'center',inline:'nearest'}));await settle(page);
    await dots.click();await settle(page);
    await page.getByRole('button',{name:'Edit transaction',exact:true}).click();await settle(page);
    assert.equal(await page.locator('#am').inputValue(),'12.5');
    await page.evaluate(()=>closeS());await settle(page);
  });
  await test('calendar event popup opens/closes and legend remains labelled',async()=>{
    await page.evaluate(()=>{tab='Activity';render();});await settle(page);
    assert.ok(await page.locator('#calwrap .ap').count());
    await page.evaluate(()=>document.querySelector('#calwrap .ap').click());await settle(page);
    assert.ok(await page.locator('#calendar-event-popup').count());
    await page.evaluate(()=>closeCalendarEventPopup(true));
    assert.equal(await page.locator('.cal-legend-item[data-cal-kind="b"]').getAttribute('aria-pressed'),'true');
  });
  await test('keyboard focus is visible; reduced motion removes nav transitions',async()=>{
    await page.emulateMedia({reducedMotion:'reduce'});await page.keyboard.press('Tab');await page.locator('#tabs .nav-tab-home').focus();
    const c=await page.locator('#tabs .nav-tab-home').evaluate(e=>({outline:getComputedStyle(e).outlineStyle,duration:getComputedStyle(e).transitionDuration,animation:getComputedStyle(e).animationName}));
    assert.equal(c.outline,'solid');assert.equal(c.duration,'0s');assert.equal(c.animation,'none');
  });
  await test('without the optional backdrop enhancement the nav has an opaque fallback',async()=>{
    await page.evaluate(()=>{for(const sheet of document.styleSheets)for(let i=sheet.cssRules.length-1;i>=0;i--){const r=sheet.cssRules[i];if(r instanceof CSSSupportsRule&&r.conditionText.includes('backdrop-filter')&&[...r.cssRules].some(x=>x.selectorText?.includes('#tabs')))sheet.deleteRule(i);}});
    const c=await page.locator('#tabs').evaluate(e=>({bg:getComputedStyle(e).backgroundColor,blur:getComputedStyle(e).backdropFilter}));
    assert.ok(!c.bg.startsWith('rgba('),c.bg);assert.equal(c.blur,'none');
  });
  await page.reload();await ready(page);
  await test('existing light/dark/auto colors remain available',async()=>{
    // Final cascade in the pre-Apple stylesheet, not its superseded first :root.
    const light={'--bg':'#fff','--card':'#f5f5f7','--tx':'#111','--mut':'#777','--line':'#e4e4e7','--g':'#16a34a','--r':'#e11d48','--ac':'#111','--ac-t':'#fff','--gl':'#f5f5f7','--bgi':'#fff'};
    const dark={'--bg':'#000','--card':'#121215','--tx':'#f5f5f7','--mut':'#9a9aa3','--line':'#26262b','--g':'#4ade80','--r':'#fb7185','--ac':'#fff','--ac-t':'#111','--gl':'linear-gradient(160deg, #1a1a1f, #0e0e10)','--bgi':'radial-gradient(90% 55% at 50% 0%, #222228, #000 75%)'};
    for(const t of ['light','dark','auto']){
      await page.evaluate(t=>setTheme(t),t);
      const actual=await page.evaluate(keys=>Object.fromEntries(keys.map(k=>[k,getComputedStyle(document.documentElement).getPropertyValue(k).trim()])),Object.keys(light));
      const systemDark=await page.evaluate(()=>matchMedia('(prefers-color-scheme:dark)').matches);
      assert.deepEqual(actual,t==='dark'||t==='auto'&&systemDark?dark:light,t+' palette differs from pre-Apple stylesheet');
    }
    await page.evaluate(()=>setTheme('auto'));assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-theme')),false);
  });
  await test('Developer Options/Privacy & Sync remain present and sync stays OFF',async()=>{
    await page.evaluate(()=>{openSettings();});await settle(page);assert.equal(await page.locator('[onchange^="setDeveloperOptions(this)"]').count(),0);
    await page.evaluate(()=>stPrivacy());await settle(page);assert.equal(await page.locator('[onchange^="setDeveloperOptions(this)"]').count(),1);assert.ok(await page.locator('#production-sync-toggle').count());
    assert.equal(await page.evaluate(()=>CapProductionSync.status().enabled),false);assert.equal(financialRequests,0);
  });
  await context.close();console.log('Screenshots: '+shots);console.log(`PASS: ${passed} Apple theme responsive/browser checks`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));});
