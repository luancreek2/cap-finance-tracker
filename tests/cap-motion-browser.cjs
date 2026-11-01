/* Isolated synthetic origin; no production config or external IO. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
if(!process.env.CAP_PLAYWRIGHT_PATH){console.log('SKIP: motion browser checks need CAP_PLAYWRIGHT_PATH');process.exit(0)}
const pw=require(process.env.CAP_PLAYWRIGHT_PATH),root=path.resolve(__dirname,'..');
let server,browser,passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
(async()=>{
  server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://fixture.invalid');
    if(['/supabase-config.js','/supabase-config.local.js'].includes(u.pathname)){res.setHeader('Content-Type','text/javascript');return res.end('window.CAP_SUPABASE_CONFIG={};')}
    const file=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
    fs.readFile(file,(err,b)=>{res.writeHead(err?404:200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.mp3':'audio/mpeg'})[path.extname(file)]||'application/octet-stream'});res.end(err?'Missing':b)});
  });
  await new Promise(r=>server.listen(0,'0.0.0.0',r));
  const origin='http://127.0.0.1:'+server.address().port;
  const engines=[['Chrome',pw.chromium,{channel:'chrome'}]];
  if(fs.existsSync(pw.webkit.executablePath()))engines.push(['WebKit',pw.webkit,{}]);
  else console.log('SKIP: WebKit binary unavailable');
  for(const [name,engine,opts] of engines){
    browser=await engine.launch({...opts,headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'no-preference'});
    await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
    const page=await context.newPage(),errors=[],consoleErrors=[];page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
    await page.goto(origin);await page.waitForFunction(()=>window.CapMotion&&window.CapCommandBar&&!window.capLaunchActive);
    assert.equal(await page.evaluate(()=>CapMotion.ready),true);
    await page.evaluate(()=>{localStorage.setItem('cap_whats_new_seen_version',APP_VERSION);document.querySelector('#whats-new-overlay')?.remove();document.querySelector('#cap-auth')?.remove();S.anim=1;S.rm=0;applyMotion();});
    await page.waitForTimeout(400);
    await test(name+' finite Anime cue, repeated tap replacement and exact final text/styles',async()=>{
      const result=await page.evaluate(async()=>{
        const el=document.createElement('div');el.id='motion-test';el.textContent='₱450.00';document.body.append(el);
        for(let i=0;i<20;i++)CapMotion.reveal(el);
        const active=CapMotion.activeCount(),text=el.textContent;
        const deadline=performance.now()+3000;
        while(CapMotion.activeCount()&&performance.now()<deadline)await new Promise(r=>setTimeout(r,30));
        return {active,text,final:el.textContent,jobs:CapMotion.activeCount(),opacity:el.style.opacity,transform:el.style.transform};
      });
      assert.equal(result.active,1);assert.equal(result.jobs,0,JSON.stringify({result,errors}));assert.equal(result.text,result.final);assert.equal(result.opacity,'');assert.equal(result.transform,'');
    });
    await test(name+' detached DOM, hidden parent, pagehide and simultaneous cancellation',async()=>{
      const result=await page.evaluate(async()=>{
        const host=document.createElement('div');host.innerHTML='<i></i><i></i>';document.body.append(host);
        [...host.children].forEach(el=>CapMotion.reveal(el));const simultaneous=CapMotion.activeCount();
        host.remove();await Promise.resolve();const detached=CapMotion.activeCount();
        document.body.append(host);CapMotion.reveal(host.firstChild);host.hidden=true;await Promise.resolve();const hidden=CapMotion.activeCount();
        host.hidden=false;CapMotion.reveal(host.firstChild);dispatchEvent(new Event('pagehide'));const pagehide=CapMotion.activeCount();host.remove();return {simultaneous,detached,hidden,pagehide};
      });
      assert.deepEqual(result,{simultaneous:2,detached:0,hidden:0,pagehide:0});
    });
    await test(name+' OS/in-app reduced motion, including preference change mid-run',async()=>{
      for(const flag of ['rm','noanim']){
        assert.equal(await page.evaluate(async flag=>{const el=document.querySelector('#motion-test');CapMotion.reveal(el);document.documentElement.classList.add(flag);await Promise.resolve();const n=CapMotion.activeCount();CapMotion.reveal(el);const after=CapMotion.activeCount();document.documentElement.classList.remove(flag);return n+after;},flag),0);
      }
      await page.evaluate(()=>CapMotion.reveal(document.querySelector('#motion-test')));
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.waitForFunction(()=>CapMotion.reduced()&&CapMotion.activeCount()===0);
      assert.equal(await page.evaluate(()=>{CapMotion.reveal(document.querySelector('#motion-test'));return CapMotion.activeCount()}),0);
      await page.emulateMedia({reducedMotion:'no-preference'});
      await page.waitForFunction(()=>!CapMotion.reduced());
    });
    await test(name+' background visibility settles without replaying its cue',async()=>{
      assert.equal(await page.evaluate(()=>{
        const el=document.querySelector('#motion-test');CapMotion.reveal(el);
        Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));
        const n=CapMotion.activeCount();delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));return n+CapMotion.activeCount();
      }),0);
    });
    if(name==='Chrome')await test('Chrome 6x CPU slowdown: replacement/removal settles without stale jobs',async()=>{
      const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:6});
      await page.evaluate(()=>{const el=document.querySelector('#motion-test');for(let i=0;i<8;i++)CapMotion.reveal(el);});
      await page.waitForFunction(()=>CapMotion.activeCount()===0,{},{timeout:5000});
      await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await cdp.detach();
    });
    await test(name+' sheet close/reopen invalidates navigation work and scroll hold',async()=>{
      await page.evaluate(()=>{openS('<b>first</b>');navS('<b>stale</b>','old');closeS();openS('<b id="new-sheet">latest</b>');});
      await page.waitForTimeout(650);
      const result=await page.evaluate(()=>({text:document.querySelector('#sv').textContent,open:document.querySelector('#sheet').classList.contains('open'),busy:window._navBusy,classes:document.querySelector('#sb').className,opacity:document.querySelector('#sv').style.opacity}));
      assert.equal(result.text,'latest');assert.equal(result.open,true);assert.equal(result.busy,0);assert.doesNotMatch(result.classes,/sv-transitioning/);assert.equal(result.opacity,'');
      await page.evaluate(()=>{closeS();navS('<b id="nav-reopen">reopened by navigation</b>','new');});
      await page.waitForTimeout(450);
      assert.equal(await page.locator('#nav-reopen').isVisible(),true);
      assert.equal(await page.locator('#sheet').evaluate(el=>el.classList.contains('open')&&!el.classList.contains('closing')),true);
      await page.evaluate(()=>closeS());await page.waitForTimeout(250);
    });
    await test(name+' flying card completion cannot close a newer sheet',async()=>{
      await page.evaluate(()=>{S.accts=[{id:990,name:'Fixture Credit',bank:'Fixture',type:'credit',bal:450,lim:5000,g:['#123456','#234567']}];tab='Accounts';render();});
      await page.evaluate(()=>acctMenu(990));await page.waitForFunction(()=>!document.querySelector('.cardfx-fly,.cardfx-txt'));
      await page.evaluate(()=>{window.__replacementEntries=0;document.querySelector('#sb').addEventListener('animationstart',e=>{if(e.target.id==='sb')window.__replacementEntries++});closeS();openS('<h2 id="replacement">Replacement</h2>');});
      await page.waitForFunction(()=>!document.querySelector('.cardfx-fly,.cardfx-txt'));
      await page.waitForFunction(()=>getComputedStyle(document.querySelector('#sb')).opacity==='1');
      await page.waitForTimeout(350);
      assert.equal(await page.locator('#replacement').isVisible(),true);
      assert.equal(await page.locator('#sheet').evaluate(el=>el.classList.contains('open')),true);
      assert.equal(await page.locator('.cardfx-fly,.cardfx-txt').count(),0);
      assert.equal(await page.locator('#sb').evaluate(el=>getComputedStyle(el).opacity),'1');
      assert.ok(await page.evaluate(()=>window.__replacementEntries)<=1,'old flight restarted the new view entrance');
      await page.evaluate(()=>closeS());await page.waitForTimeout(250);
    });
    await test(name+' overlapping delayed Home counts leave one exact final value',async()=>{
      await page.evaluate(()=>{tab='Home';S.hide=0;applyHide();render();for(let i=0;i<8;i++)animateNetBalance();});
      await page.waitForTimeout(1600);
      const result=await page.evaluate(()=>{const el=document.querySelector('#chv');return {text:el.textContent,final:php(+el.dataset.chBalance),raf:el._countRaf,timer:el._countTimer}});
      assert.equal(result.text,result.final);assert.equal(result.raf,0);assert.equal(result.timer,0);
    });
    await test(name+' cancelled setup cannot reveal again and rejects repeated opening',async()=>{
      await page.evaluate(()=>{const card={bank:'Fixture',name:'Test Card',type:'debit',g:['#123456','#234567']};beginAccountSetup(card);beginAccountSetup(card);cancelAccountSetup();cancelAccountSetup();});
      assert.equal(await page.locator('.acct-setup-overlay').count(),1);
      await page.waitForFunction(()=>!document.querySelector('.acct-setup-overlay'));
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(()=>ACCT_SETUP),null);
      assert.equal(await page.locator('.acct-setup-panel.visible').count(),0);
    });
    await test(name+' rapid calendar edit/back uses latest content; close cancels swap',async()=>{
      await page.evaluate(()=>{
        S.tx=[{id:991,d:today,amt:-50,cat:'Food',note:'Fixture calendar',acct:990}];S.pend=[];
        const j=evs(today).findIndex(e=>e.kind==='tx'&&e.id===991);if(j<0)throw Error('Missing fixture event');
        calendarEventPopup(null,today,j);calendarPopupEditTx(991);calendarPopupBack();
      });
      await page.waitForTimeout(500);
      assert.equal(await page.locator('.cep-form').count(),0);
      await page.evaluate(()=>{calendarPopupEditTx(991);closeCalendarEventPopup();closeCalendarEventPopup();});
      await page.waitForFunction(()=>!document.querySelector('#calendar-event-popup'));
      assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
    });
    for(const scheme of ['light','dark'])await test(name+' Smart Log receipt/edit/review continuity ('+scheme+')',async()=>{
      await page.emulateMedia({colorScheme:scheme});
      await page.evaluate(()=>{S.accts=[{id:1,name:'BDO Debit',bank:'BDO',type:'debit',img:'cash',bal:5000,g:['#123456','#234567']}];});
      await page.evaluate(()=>CapCommandBar.open());await page.waitForFunction(()=>CapCommandBar.getState().state==='open');
      await page.locator('#cap-command-input').fill('Spent 450 at Jollibee using BDO yesterday');await page.locator('#cap-command-input').press('Enter');
      await page.locator('.sl-summary').waitFor({state:'visible'});
      assert.equal(await page.locator('.sl-amount').innerText(),'₱450.00');
      await page.getByRole('button',{name:'Edit Transaction',exact:true}).click();
      await page.getByRole('button',{name:'Done Editing',exact:true}).click();
      await page.locator('.sl-summary').waitFor({state:'visible'});
      await page.evaluate(()=>CapCommandBar.close());await page.waitForTimeout(400);
      assert.equal(await page.evaluate(()=>CapMotion.activeCount()),0);
    });
    await test(name+' no application runtime or console errors',()=>{assert.deepEqual(errors,[]);assert.deepEqual(consoleErrors,[])});
    await test(name+' failed Anime import leaves controls and final content usable',async()=>{
      const fallback=await browser.newContext();await fallback.route('**/anime.esm.min.js',r=>r.abort());
      await fallback.route('**/supabase-config*.js',r=>r.fulfill({contentType:'text/javascript',body:'window.CAP_SUPABASE_CONFIG={};'}));
      const p=await fallback.newPage();await p.goto(origin);await p.waitForFunction(()=>window.CapMotion&&window.CapCommandBar&&!window.capLaunchActive);
      assert.equal(await p.evaluate(()=>CapMotion.ready),false);
      assert.equal(await p.evaluate(()=>{const el=document.createElement('p');el.textContent='Final';document.body.append(el);CapMotion.reveal(el);openS('<b>Usable</b>');return el.textContent+':'+CapMotion.activeCount()}),'Final:0');
      assert.equal(await p.locator('#sv').innerText(),'Usable');await fallback.close();
    });
    await context.close();await browser.close();browser=null;
  }
  // 127.0.0.2 is a trustworthy loopback origin, but not the SW's localhost bypass.
  browser=await pw.chromium.launch({channel:'chrome',headless:true});
  const offline=await browser.newContext(),page=await offline.newPage(),offlineOrigin='http://127.0.0.2:'+server.address().port;
  await test('production-mode shell online → offline reload includes Anime ES module',async()=>{
    await page.goto(offlineOrigin);await page.waitForFunction(()=>window.CapMotion&&!window.capLaunchActive);
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.reload();await page.waitForFunction(()=>navigator.serviceWorker.controller&&window.CapMotion);
    assert.equal(await page.evaluate(()=>CapMotion.ready),true);
    await offline.setOffline(true);await page.reload();await page.waitForFunction(()=>window.CapMotion&&window.CapCommandBar);
    assert.equal(await page.evaluate(()=>CapMotion.ready),true);
    assert.equal(await page.evaluate(async()=>{const cache=await caches.open('cap-shell-v377');return !!await cache.match('./assets/vendor/animejs/anime.esm.min.js')}),true);
  });
  await offline.close();console.log('PASS '+passed+' motion browser cases');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r))});
