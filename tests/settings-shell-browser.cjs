/* Settings UI only, synthetic local data and blocked external transport. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
if(!process.env.CAP_PLAYWRIGHT_PATH){console.log('SKIP: Settings browser checks require CAP_PLAYWRIGHT_PATH');process.exit(0);}
const {chromium}=require(process.env.CAP_PLAYWRIGHT_PATH),root=path.resolve(__dirname,'..'),shots=path.join(process.env.LOCALAPPDATA,'Temp','opencode','settings-review');
let browser,server,passed=0,external=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
(async()=>{
  fs.mkdirSync(shots,{recursive:true});
  server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://fixture.invalid');
    if(['/supabase-config.js','/supabase-config.local.js'].includes(u.pathname)){res.setHeader('Content-Type','text/javascript');return res.end('window.CAP_SUPABASE_CONFIG={};');}
    const file=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
    fs.readFile(file,(e,b)=>{res.writeHead(e?404:200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(e?'Missing':b);});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:768,height:1024},reducedMotion:'reduce'});
  await context.route('**/*',r=>{if(new URL(r.request().url()).origin===origin)return r.continue();external++;return r.abort();});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  async function boot(){await page.goto(origin);await page.waitForFunction(()=>window.StShell&&window.CapOverlays&&!window.capLaunchActive);await page.evaluate(()=>{localStorage.setItem('cap_whats_new_seen_version',APP_VERSION);if(document.querySelector('.whats-new-overlay'))closeWhatsNew();document.querySelector('#cap-auth')?.remove();});await page.waitForTimeout(300);}
  await boot();
  const box=()=>page.locator('#sb').boundingBox();
  const open=()=>page.evaluate(()=>openSettings());
  const go=k=>page.evaluate(k=>stGo(k),k);
  const before=await page.evaluate(async()=>{const {state,...sync}=await CapOff.productionSyncSnapshot();return JSON.stringify({accts:S.accts,tx:S.tx,bills:S.bills,pend:S.pend,xfer:S.xfer,goals:S.goals,debts:S.debts,sync});});
  const pages=['profile','appearance','numbers','categories','notif','sounds','backup','files','privacy','security','about','reset'];
  for(const [width,height] of [[320,740],[360,780],[390,844],[768,1024],[1024,768],[1440,900]])for(const theme of ['light','dark','auto','apple']){
    await test(`${width}x${height} ${theme}: every page and return shares one shell`,async()=>{
      await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme==='dark'?'dark':'light',reducedMotion:'reduce'});
      await page.evaluate(t=>{localStorage.setItem('cap-appearance-theme',t);applyTheme();openSettings();window.__settingsFrame=document.querySelector('#sv');},theme);
      const main=await box();assert.ok(main.x>=11&&main.y>=11&&main.x+main.width<=width-11&&main.y+main.height<=height-11);
      const dock=await page.locator('#tabs').boundingBox();assert.ok(main.y+main.height<=dock.y-10,'Settings overlaps bottom navigation');assert.equal(await page.locator('#tabs').isVisible(),true);
      if(width>=768)assert.equal(main.width,560);
      assert.ok(main.height<=620);
      for(const key of pages){await go(key);const child=await box();assert.deepEqual(child,main,key+' resized');assert.equal(await page.evaluate(()=>window.__settingsFrame===document.querySelector('#sv')),true);await open();assert.deepEqual(await box(),main,'return resized');}
      await page.evaluate(()=>stCatEdit(0));assert.deepEqual(await box(),main,'category editor resized');await page.evaluate(()=>stPin());assert.deepEqual(await box(),main,'passcode resized');await open();
      const layout=await page.locator('#sb').evaluate(e=>({font:getComputedStyle(e).fontFamily,overflow:getComputedStyle(e).overflowY,bodyOverflow:getComputedStyle(document.body).overflow,header:e.querySelector('.st-hd').getBoundingClientRect().toJSON(),scroll:e.querySelector('.st-scroll').getBoundingClientRect().toJSON(),material:getComputedStyle(e).backdropFilter,layers:[...e.querySelectorAll('*')].filter(n=>getComputedStyle(n).backdropFilter!=='none').length}));
      assert.equal(layout.overflow,'hidden');assert.equal(layout.bodyOverflow,'hidden');assert.equal(layout.layers,0);assert.ok(layout.font.includes('Segoe UI'));assert.ok(!layout.font.includes('SF Pro'));assert.ok(layout.scroll.top>=layout.header.bottom-1);
      assert.equal(layout.material==='none',theme!=='apple');
      const contrast=await page.locator('#sb').evaluate(e=>{
        const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');
        const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3);};
        const lum=color=>rgb(color).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
        return [...e.querySelectorAll('.st-t,.st-v')].map(n=>{const a=lum(getComputedStyle(n).color),b=lum(getComputedStyle(n.closest('.st-g')).backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);});
      });assert.ok(contrast.every(r=>r>=4.5),'grouped text contrast below 4.5:1');
      if(theme==='apple')await page.screenshot({path:path.join(shots,`settings-${width}.png`)});
    });
  }
  await test('profile placeholder is neutral; all five main groups share surfaces and preserve routes',async()=>{
    await page.setViewportSize({width:768,height:1024});await open();
    assert.equal(await page.locator('.st-profile-card .st-person svg').count(),1);assert.equal(await page.locator('.st-profile-card').innerText(),'Your Name\nAdd your name');
    const groups=await page.locator('.st-scroll>.st-grp').allTextContents();assert.deepEqual(groups,['Preferences','Notifications & Feedback','Data','Privacy','About']);
    assert.equal(await page.locator('.st-scroll>.st-g').count(),5);
    for(const label of ['Appearance','Currency & Numbers','Categories','Notifications','Sounds & Haptics','Backup & Restore','Import & Export','Privacy & Sync','Security','About Cap'])assert.ok(await page.getByRole('button',{name:new RegExp(label.replace('&','&'))}).count(),label);
    assert.ok((await page.locator('.st-scroll').innerText()).includes('App Version'));
    assert.equal(await page.getByText('Developer Options',{exact:true}).count(),0);
  });
  await test('long main and child content scroll inside a stationary shell/header; Back restores position',async()=>{
    await page.setViewportSize({width:390,height:844});await open();const main=await box();
    const scroll=await page.locator('.st-scroll').evaluate(e=>{e.scrollTop=e.scrollHeight;return {top:e.scrollTop,header:document.querySelector('.st-hd').getBoundingClientRect().toJSON()};});assert.ok(scroll.top>0);
    await page.getByRole('button',{name:/Privacy & Sync/}).click();assert.deepEqual(await box(),main);
    assert.equal(await page.locator('.st-scroll').evaluate(e=>e.scrollTop),0);
    await go('notif');const child=await page.locator('.st-scroll').evaluate(e=>{e.scrollTop=e.scrollHeight;return e.scrollTop;});assert.ok(child>0);assert.deepEqual(await box(),main);
    await page.getByRole('button',{name:'Back',exact:true}).click();assert.equal(await page.locator('.st-scroll').evaluate(e=>e.scrollTop),scroll.top);
    assert.deepEqual(await page.locator('.st-hd').evaluate(e=>e.getBoundingClientRect().toJSON()),scroll.header);
  });
  await test('Developer Options occurs once, only inside Privacy & Sync, and retains persistence/gates',async()=>{
    await go('privacy');const old=await page.evaluate(()=>({s:JSON.stringify(S),gate:window.CAP_DEV_TOOLS}));
    const input=page.locator('input[onchange^="setDeveloperOptions"]');assert.equal(await input.count(),1);assert.equal(await input.isChecked(),false);
    await input.check();assert.equal(await page.evaluate(()=>developerOptionsEnabled()),true);
    assert.equal(await page.getByRole('button',{name:'Test Supabase Connection',exact:true}).count(),1);
    assert.equal(await page.evaluate(()=>JSON.stringify(S)),old.s);assert.equal(await page.evaluate(()=>window.CAP_DEV_TOOLS),old.gate);
    await input.uncheck();assert.equal(await page.evaluate(()=>developerOptionsEnabled()),false);assert.equal(await page.getByRole('button',{name:'Test Supabase Connection',exact:true}).count(),0);
    await open();assert.equal(await page.getByText('Developer Options',{exact:true}).count(),0);
  });
  await test('profile name uses existing save behavior, long names fit and card reflects edits',async()=>{
    await go('profile');await page.locator('#st-name').fill('Nabi with a particularly long surname');
    assert.equal(await page.locator('#st-profile-name').textContent(),'Nabi with a particularly long surname');await open();
    assert.equal(await page.locator('.st-profile-copy b').textContent(),'Nabi with a particularly long surname');
    assert.equal(await page.locator('.st-profile-card').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    await boot();await open();assert.equal(await page.locator('.st-profile-copy b').textContent(),'Nabi with a particularly long surname');
  });
  await test('import/restore preview substeps keep the fixed frame without submitting an import',async()=>{
    await go('files');const original=await box();
    await page.evaluate(()=>{IMP={kind:'csv',ok:[],dup:0,bad:[]};impPrev();});
    assert.deepEqual(await box(),original);assert.equal(await page.locator('#st-title').textContent(),'Import transactions');
    assert.equal(await page.getByRole('button',{name:'Confirm import',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'Back',exact:true}).click();assert.deepEqual(await box(),original);assert.equal(await page.locator('#st-title').textContent(),'Import & Export');await page.evaluate(()=>{IMP=null;});
  });
  await test('Add/Change/Remove Photo use local storage only, survive reload, and share a circular crop',async()=>{
    const original=await page.evaluate(()=>JSON.stringify({s:S,photo:S.photo}));
    async function upload(color){const data=await page.evaluate(color=>{const c=document.createElement('canvas');c.width=120;c.height=80;c.getContext('2d').fillStyle=color;c.getContext('2d').fillRect(0,0,120,80);return c.toDataURL('image/png').split(',')[1];},color);await page.locator('#st-photo-file').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from(data,'base64')});await page.waitForFunction(()=>!!document.querySelector('.st-profile-editor img'));}
    await go('profile');assert.equal(await page.getByRole('button',{name:'Add Photo',exact:true}).count(),1);await upload('#336699');
    const first=await page.locator('.st-av img').getAttribute('src');assert.equal(await page.getByRole('button',{name:'Change Photo',exact:true}).count(),1);
    const style=await page.locator('.st-av').evaluate(e=>({radius:getComputedStyle(e).borderRadius,fit:getComputedStyle(e.querySelector('img')).objectFit}));assert.equal(style.radius,'50%');assert.equal(style.fit,'cover');
    await open();assert.equal(await page.locator('.st-profile-card img').getAttribute('src'),first);await boot();await open();assert.equal(await page.locator('.st-profile-card img').getAttribute('src'),first);
    await go('profile');await upload('#aa5522');await page.waitForFunction(first=>document.querySelector('.st-av img').src!==first,first);
    await page.getByRole('button',{name:'Remove Photo',exact:true}).click();assert.equal(await page.locator('.st-person').count(),1);await open();assert.equal(await page.locator('.st-profile-card img').count(),0);
    assert.equal(await page.evaluate(()=>JSON.stringify({s:S,photo:S.photo})),original);
  });
  await test('forward/back animate content only; shell, header, backdrop and frame stay stationary',async()=>{
    await page.emulateMedia({reducedMotion:'no-preference'});await open();await page.waitForTimeout(350);const main=await box();
    for(const direction of ['forward','back']){
      await page.evaluate(dir=>dir==='forward'?stGo('profile'):openSettings(),direction);
      const a=await page.evaluate(()=>({panel:document.querySelector('#sb').getAnimations().filter(a=>a.playState==='running').length,backdrop:document.querySelector('#sheet').getAnimations().filter(a=>a.playState==='running').length,content:document.querySelector('.st-scroll:not(.st-exit)').getAnimations().map(a=>a.effect.getKeyframes()),out:!!document.querySelector('.st-exit')}));
      assert.equal(a.panel,0);assert.equal(a.backdrop,0);assert.equal(a.out,true);assert.ok(a.content.length);assert.ok(a.content[0][0].transform.includes(direction==='forward'?'24px':'-24px'));
      assert.deepEqual(await box(),main);await page.waitForTimeout(260);assert.equal(await page.locator('.st-exit').count(),0);
    }
    await go('appearance');await go('privacy');await open();await page.waitForTimeout(260);assert.equal(await page.locator('.st-exit').count(),0);assert.deepEqual(await box(),main);
  });
  await test('keyboard focus trap, Done/Escape closing and opener focus return',async()=>{
    await page.evaluate(()=>closeS());await page.waitForTimeout(250);await page.locator('#settings-button').click();await page.waitForTimeout(350);
    await page.getByRole('button',{name:'Done',exact:true}).focus();await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(()=>document.querySelector('#sb').contains(document.activeElement)),true);
    await page.keyboard.press('Escape');await page.waitForTimeout(260);assert.equal(await page.locator('#sheet').evaluate(e=>e.classList.contains('open')),false);assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-button');
    await page.locator('#settings-button').click();await page.waitForTimeout(320);await page.getByRole('button',{name:'Done',exact:true}).click();await page.waitForTimeout(250);assert.equal(await page.locator('#sheet').evaluate(e=>e.classList.contains('open')),false);
  });
  await test('open/close have restrained animations; reduced motion has no slides',async()=>{
    await open();assert.equal(await page.locator('#sb').evaluate(e=>getComputedStyle(e).animationName),'stPanelIn');await page.waitForTimeout(320);
    await page.evaluate(()=>closeS());assert.equal(await page.locator('#sb').evaluate(e=>getComputedStyle(e).animationName),'stPanelOut');await page.waitForTimeout(250);
    await page.emulateMedia({reducedMotion:'reduce'});await open();await go('profile');assert.equal(await page.locator('#sb').evaluate(e=>getComputedStyle(e).animationName),'none');assert.equal(await page.locator('.st-exit').count(),0);
    await page.evaluate(()=>document.documentElement.classList.add('rm'));await open();assert.equal(await page.locator('.st-exit').count(),0);await page.evaluate(()=>document.documentElement.classList.remove('rm'));
  });
  await test('appearance previews, logo and motion controls remain available and settings touch targets fit',async()=>{
    await go('appearance');assert.equal(await page.locator('.theme-choice').count(),5);assert.equal(await page.locator('.cap-logo-choices button').count(),2);
    for(const label of ['Animations','Reduce Motion'])assert.ok((await page.locator('.st-scroll').innerText()).includes(label));
    for(const theme of ['light','dark','auto','apple','bluish-white']){await page.locator(`[data-theme-choice="${theme}"]`).click();assert.equal(await page.locator(`[data-theme-choice="${theme}"]`).getAttribute('aria-pressed'),'true');}
    await open();assert.equal(await page.locator('.st-row[onclick]').evaluateAll(es=>es.every(e=>e.getBoundingClientRect().height>=44)),true);
    await go('profile');assert.equal(await page.locator('.st-photo-actions button').evaluateAll(es=>es.every(e=>e.getBoundingClientRect().height>=44)),true);
  });
  await test('review screenshots include short and long child pages in light and dark Apple material',async()=>{
    await page.setViewportSize({width:768,height:1024});
    for(const scheme of ['light','dark']){
      await page.emulateMedia({colorScheme:scheme,reducedMotion:'reduce'});await page.evaluate(()=>{localStorage.setItem('cap-appearance-theme','apple');applyTheme();});
      for(const key of ['home','profile','appearance','privacy','notif']){await go(key);await page.screenshot({path:path.join(shots,key+'-'+scheme+'.png')});}
    }
  });
  await test('inspection preserves financial records, sync metadata and transport isolation',async()=>{
    // Name edits deliberately persist S/state. Compare all financial collections
    // and every sync metadata store, not the edited profile's state envelope.
    const after=await page.evaluate(async()=>{const {state,...sync}=await CapOff.productionSyncSnapshot();return JSON.stringify({accts:S.accts,tx:S.tx,bills:S.bills,pend:S.pend,xfer:S.xfer,goals:S.goals,debts:S.debts,sync});});
    assert.equal(after,before);assert.equal(external,0);assert.deepEqual(errors,[]);
  });
  await context.close();console.log(`PASS: ${passed} Settings shell/profile/navigation checks`);console.log('Screenshots: '+shots);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));});
