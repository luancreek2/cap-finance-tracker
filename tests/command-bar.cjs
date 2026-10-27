/* Phase 1 UI boundary plus isolated real-browser interaction checks. No live auth. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const source=read('js/command-bar.js'),css=read('css/command-bar.css'),html=read('index.html');
let passed=0,browser,server;
async function test(name,fn){await fn();console.log('PASS '+name);passed++;}
(async()=>{
 await test('UI module has no state/persistence/network/financial execution paths',()=>{
  assert.doesNotMatch(source,/\bS\s*[.\[]|localStorage|indexedDB|\bfetch\s*\(|\bsaveTx\s*\(|CapSupabase|CapProductionSync|\beval\s*\(/);
  assert.match(source,/window\.openTx\(\)/);
  assert.match(source,/e\.key!=='Enter'\|\|e\.isComposing/);
  assert.match(source,/e\.preventDefault\(\);e\.stopPropagation\(\)/);
  assert.match(source,/window\.visualViewport/);assert.match(source,/prefers-reduced-motion:reduce/);
  assert.match(css,/var\(--popup-surface\)/);
  assert.match(css,/#cap-command-backdrop[^}]*backdrop-filter:blur\(8px\)/);
  assert.match(css,/#cap-command-input:focus,#cap-command-input:focus-visible \{ outline:none/);
  assert.ok(html.indexOf('js/command-bar.js')>html.indexOf('js/settings-shell.js'));
  for(const asset of ['css/command-bar.css','js/command-bar.js'])assert.ok(read('service-worker.js').includes('./'+asset));
 });
 if(!process.env.CAP_PLAYWRIGHT_PATH){console.log('SKIP browser cases: set CAP_PLAYWRIGHT_PATH');return;}
 const {chromium}=require(process.env.CAP_PLAYWRIGHT_PATH);
 server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://fixture.invalid');
  if(['/supabase-config.js','/supabase-config.local.js'].includes(u.pathname)){res.setHeader('Content-Type','text/javascript');return res.end('window.CAP_SUPABASE_CONFIG={};');}
  const file=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  fs.readFile(file,(err,b)=>{res.writeHead(err?404:200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(err?'Missing':b)});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'no-preference'});
 const requests=[];await context.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin!==origin||/^\/(auth|rest)\//.test(u.pathname)){requests.push(u.pathname);return r.abort()}return r.continue()});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>window.CapCommandBar&&window.CapOverlays&&!window.capLaunchActive);
 await page.evaluate(()=>{
  localStorage.setItem('cap_whats_new_seen_version',APP_VERSION);if(document.querySelector('.whats-new-overlay'))closeWhatsNew();document.querySelector('#cap-auth')?.remove();
  S.accts=[{id:100,name:'Command Fixture Cash',type:'debit',bank:'Fixture',img:'cash',bal:1250,g:['#234567','#123456']}];S.tx=[];S.bills=[];tab='Home';render();
 });await page.waitForTimeout(800);requests.length=0;
 const bar=page.locator('#cap-command-bar'),input=page.locator('#cap-command-input');
 const state=()=>page.evaluate(()=>CapCommandBar.getState());
 const waitOpen=()=>page.waitForFunction(()=>CapCommandBar.getState().state==='open');
 const waitClosed=()=>page.waitForFunction(()=>CapCommandBar.getState().state==='closed');
 const open=async()=>{await page.locator('#tabs .nav-action').click();await waitOpen()};
 const close=async()=>{await page.evaluate(()=>CapCommandBar.close());await waitClosed()};
 const snapshot=()=>page.evaluate(async()=>JSON.stringify({S,sync:await CapOff.productionSyncSnapshot(),hold:localStorage.getItem(CapProductionSync.recoveryKey)}));
 const beforeNav=await page.locator('#tabs').boundingBox();
 await test('collapsed navigation remains five buttons with no separate Search tab',async()=>{
  assert.equal(await bar.isVisible(),false);assert.equal(await page.locator('#tabs button').count(),5);
  assert.deepEqual(await page.locator('#tabs button').evaluateAll(es=>es.map(e=>e.getAttribute('aria-label'))),['Home','Activity','Add transaction','Plan','Accounts']);
 });
  const before=await snapshot();
  // Observe real WAAPI keyframes when the animation is created. A protocol
  // round trip after click can outlive the 420ms morph on a loaded renderer;
  // getAnimations() then correctly returns no active animations.
  await page.evaluate(()=>{
   for(const e of document.querySelectorAll('.cb-surface,#cap-command-backdrop')){
    const animate=e.animate;
    e.__morphFrames=[];
    e.animate=function(...args){
     const animation=animate.apply(this,args);
     this.__morphFrames=animation.effect.getKeyframes();
     return animation;
    };
   }
  });
  await test('center + morphs from its actual bounds, defaults to Log, focuses after expansion',async()=>{
   await page.locator('.cb-surface').evaluate(e=>{e.__morphFrames=[]});
   await page.locator('#tabs .nav-action').click();
   const frames=await page.locator('.cb-surface').evaluate(e=>e.__morphFrames);
  assert.ok(frames.some(f=>f.clipPath&&f.clipPath!=='inset(0px 0px round 32px)'));
  await waitOpen();assert.equal((await state()).mode,'log');assert.equal(await input.getAttribute('placeholder'),'Log or search anything…');
  assert.equal(await input.evaluate(e=>e===document.activeElement),true);
  assert.equal(await page.locator('#sheet.open').count(),0);
  assert.equal(await page.locator('#tabs .on .nav-label').innerText(),'Home');
  assert.equal(await page.locator('#tabs .nav-action').getAttribute('aria-expanded'),'true');
  assert.deepEqual(await page.locator('#tabs').boundingBox(),beforeNav);
 });
 await test('Log/Search menu supports keyboard navigation, semantics, mode and placeholder changes',async()=>{
  await page.locator('.cb-mode').click();assert.equal(await page.getByRole('menu').isVisible(),true);
  assert.equal(await page.locator('.cb-menu .cb-option-icon svg').count(),2);
  assert.equal(await page.locator('.cb-check').count(),0);
  assert.equal(await page.locator('.cb-mode .cb-current-icon svg rect').count(),1);
  assert.equal(await page.locator('.cb-option-icon svg').evaluateAll(es=>es.every(e=>getComputedStyle(e).fill==='none')),true);
  assert.equal(await page.getByRole('menuitemradio',{name:'Log',exact:true}).getAttribute('aria-checked'),'true');
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  assert.equal((await state()).mode,'search');assert.equal(await input.getAttribute('placeholder'),'Search your finances…');
  assert.equal(await page.locator('.cb-mode .cb-current-icon svg circle').count(),1);
  await input.fill('coffee yesterday');
  await page.locator('.cb-mode').click();await page.getByRole('menuitemradio',{name:'Log',exact:true}).click();
   assert.equal(await input.inputValue(),'','Search text never overwrites the Log draft');assert.equal(await input.getAttribute('placeholder'),'Log or search anything…');
   await page.evaluate(()=>CapCommandBar.setMode('search'));assert.equal(await input.inputValue(),'coffee yesterday');await page.evaluate(()=>CapCommandBar.setMode('log'));
 });
 await test('typing and Enter in either mode never mutate records, balances, baseline, outbox or sync',async()=>{
  for(const mode of ['Log','Search']){
   await page.locator('.cb-mode').click();await page.getByRole('menuitemradio',{name:mode,exact:true}).click();
    await input.fill(mode==='Log'?'spent 500 on food from cash':'how much did I spend?');await input.press('Enter');
    if(mode==='Search')await page.locator('.fs-results').waitFor({state:'visible'});
   assert.match(await page.locator('.cb-status').innerText(),/Nothing was submitted/);
   assert.equal(await snapshot(),before);
  }
  assert.equal(requests.length,0);
 });
  await test('Escape dismisses menu, then Search results, then contracts bar and restores trigger focus',async()=>{
   await page.locator('.cb-mode').click();await page.keyboard.press('Escape');assert.equal(await page.getByRole('menu').isVisible(),false);assert.equal((await state()).state,'open');
   assert.equal(await page.locator('.fs-results').isVisible(),true);
   await page.keyboard.press('Escape');assert.equal(await page.locator('.fs-results').isVisible(),false);assert.equal((await state()).state,'open');
  await page.keyboard.press('Escape');await waitClosed();assert.equal(await bar.isVisible(),false);
  assert.equal(await page.locator('#tabs .nav-action').evaluate(e=>e===document.activeElement),true);
  assert.equal(await page.locator('#tabs .nav-action').getAttribute('aria-expanded'),'false');
 });
 await test('blurred backdrop blocks underlying controls and navigation; dismissal restores normal tabs',async()=>{
  await open();const heading=await page.locator('h1').first().boundingBox();await page.mouse.click(heading.x+10,heading.y+10);await waitClosed();
  for(const tab of ['Activity','Plan','Accounts','Home']){
   const previous=await page.locator('#tabs .on .nav-label').innerText();
   await open();const box=await page.getByRole('button',{name:tab,exact:true,includeHidden:true}).boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await waitClosed();
   assert.equal(await page.locator('#tabs .on .nav-label').innerText(),previous,'backdrop tap must not pass through');
   await page.getByRole('button',{name:tab,exact:true}).click();
   assert.equal(await page.locator('#tabs .on .nav-label').innerText(),tab);
  }
 });
  await test('shared backdrop fades with morph, keeps command sharp and traps focus away from inert background',async()=>{
   await page.locator('#cap-command-backdrop').evaluate(e=>{e.__morphFrames=[]});
   await page.locator('#tabs .nav-action').click();
   const frames=await page.locator('#cap-command-backdrop').evaluate(e=>e.__morphFrames);assert.ok(frames.some(f=>f.opacity===0||f.opacity==='0'));
  await waitOpen();
  assert.equal(await page.locator('#app').evaluate(e=>e.inert),true);assert.equal(await page.locator('nav').evaluate(e=>e.inert),true);
  assert.equal(await bar.getAttribute('aria-modal'),'true');
  assert.equal(await page.locator('.cb-surface').evaluate(e=>getComputedStyle(e).backdropFilter),'none');
  assert.equal(await page.locator('.cb-content').evaluate(e=>getComputedStyle(e).filter),'none');
  await page.locator('.cb-mic').focus();await page.keyboard.press('Tab');assert.equal(await page.getByRole('button',{name:'Close Command Bar',exact:true}).evaluate(e=>e===document.activeElement),true);
  await page.keyboard.press('Tab');assert.equal(await page.locator('.cb-manual').evaluate(e=>e===document.activeElement),true);
  await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');assert.equal(await page.locator('.cb-mic').evaluate(e=>e===document.activeElement),true);
  await close();assert.equal(await page.locator('#app').evaluate(e=>e.inert),false);assert.equal(await page.locator('#cap-command-backdrop').isVisible(),false);
 });
 await test('manual + calls the existing New Entry form exactly once and cancel resumes the draft',async()=>{
  await open();await input.fill('keep my command draft');
  await page.evaluate(()=>{const original=window.openTx;window.__manualCalls=0;window.openTx=function(){window.__manualCalls++;return original.apply(this,arguments)}});
  await page.getByRole('button',{name:'Open Manual New Entry',exact:true}).click();
  await page.waitForSelector('#sheet.open #am');assert.equal((await state()).state,'suspended');assert.equal(await bar.isVisible(),false);
  assert.equal(await page.evaluate(()=>window.__manualCalls),1);assert.equal(await page.locator('#sb h2').innerText(),'New entry');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await waitOpen();assert.equal(await input.inputValue(),'keep my command draft');
 });
 await test('existing manual Save remains the sole financial write path and resumes the bar',async()=>{
  const count=await page.evaluate(()=>S.tx.length);
  await page.getByRole('button',{name:'Open Manual New Entry',exact:true}).click();await page.waitForSelector('#sheet.open #am');
  await page.locator('#am').fill('12.50');await page.locator('#nt').fill('Manual command fixture');
  await page.getByRole('button',{name:'Save',exact:true}).click();await waitOpen();
  assert.equal(await page.evaluate(()=>S.tx.length),count+1);
  assert.equal(await page.evaluate(()=>S.tx.find(t=>t.note==='Manual command fixture').amt),-12.5);
  await close();
 });
 await test('rapid open/close/reopen leaves one bar and restores navigation',async()=>{
  await page.evaluate(()=>{CapCommandBar.open();CapCommandBar.close();CapCommandBar.open()});await waitOpen();
  assert.equal(await bar.count(),1);await close();assert.equal(await page.locator('body.command-bar-active').count(),0);
 });
 await test('voice in Log and Search fills text only, supports stopping and blocks stale transcripts',async()=>{
  await page.evaluate(()=>{
   window.SpeechRecognition=class {
    constructor(){window.__speech=this;this.aborted=false}
    start(){this.started=true}
    abort(){this.aborted=true}
   };
  });
  await open();const beforeVoice=await snapshot();
  for(const mode of ['Log','Search']){
   await page.locator('.cb-mode').click();await page.getByRole('menuitemradio',{name:mode,exact:true}).click();await input.fill('Draft');
   await page.getByRole('button',{name:'Start Voice Input',exact:true}).click();
   assert.equal(await page.locator('.cb-mic').getAttribute('aria-pressed'),'true');
   assert.match(await page.locator('.cb-status').innerText(),/Listening.*browser’s speech service/);
   await page.evaluate(()=>{window.__lateSpeech=window.__speech.onresult;window.__speech.onresult({results:[[{transcript:'spent 99 on lunch'}]]})});
   assert.equal(await input.inputValue(),'Draft spent 99 on lunch');assert.equal(await snapshot(),beforeVoice);
   await page.getByRole('button',{name:'Stop Voice Input',exact:true}).click();assert.equal(await page.evaluate(()=>window.__speech.aborted),true);
   await page.evaluate(()=>window.__lateSpeech({results:[[{transcript:'stale result'}]]}));assert.equal(await input.inputValue(),'Draft spent 99 on lunch');
  }
  await page.getByRole('button',{name:'Start Voice Input',exact:true}).click();await page.keyboard.press('Escape');
  assert.equal((await state()).state,'open');assert.equal(await page.locator('.cb-mic').getAttribute('aria-pressed'),'false');
  await page.getByRole('button',{name:'Start Voice Input',exact:true}).click();await close();
  assert.equal(await page.evaluate(()=>window.__speech.aborted),true);assert.equal(await snapshot(),beforeVoice);
 });
 await test('voice denial, missing mic, no speech, unsupported browsers and startup errors preserve typed entry',async()=>{
  await open();await input.fill('Keep typed draft');
  for(const [error,message] of [['not-allowed','permission denied'],['audio-capture','No microphone'],['no-speech','No speech detected'],['network','could not continue']]){
   await page.getByRole('button',{name:'Start Voice Input',exact:true}).click();await page.evaluate(error=>window.__speech.onerror({error}),error);
   assert.ok((await page.locator('.cb-status').innerText()).includes(message));assert.equal(await input.inputValue(),'Keep typed draft');
   assert.equal(await page.locator('.cb-mic').getAttribute('aria-pressed'),'false');
  }
  await page.evaluate(()=>{window.SpeechRecognition=undefined;window.webkitSpeechRecognition=undefined});
  await page.getByRole('button',{name:'Start Voice Input',exact:true}).click();assert.match(await page.locator('.cb-status').innerText(),/unavailable/);
  await page.evaluate(()=>{window.SpeechRecognition=class{start(){throw Error('unsupported')}abort(){}}});
  await page.getByRole('button',{name:'Start Voice Input',exact:true}).click();assert.match(await page.locator('.cb-status').innerText(),/unavailable/);
  await input.fill('Typing still works');assert.equal(await input.inputValue(),'Typing still works');
  assert.equal(await input.evaluate(e=>getComputedStyle(e).outlineStyle),'none');await close();
 });
 await test('OS Reduce Motion and both Cap flags use only restrained opacity transitions',async()=>{
  for(const flag of ['os','rm','noanim']){
   await page.emulateMedia({reducedMotion:flag==='os'?'reduce':'no-preference'});
   if(flag!=='os')await page.evaluate(f=>document.documentElement.classList.add(f),flag);
   const frames=await page.evaluate(()=>{CapCommandBar.open();return [...document.querySelector('.cb-surface').getAnimations()].flatMap(a=>a.effect.getKeyframes())});
   assert.ok(frames.length);assert.ok(frames.every(f=>!f.transform&&!f.clipPath));await waitOpen();await close();
   if(flag!=='os')await page.evaluate(f=>document.documentElement.classList.remove(f),flag);
  }
  await page.emulateMedia({reducedMotion:'no-preference'});
 });
 await test('visual viewport keyboard resize/scroll keeps input and mode menu visible',async()=>{
  await open();
  await page.evaluate(()=>{
   window.__realVV=window.visualViewport;const vv=new EventTarget();Object.assign(vv,{width:390,height:340,offsetTop:105,offsetLeft:0});
   Object.defineProperty(window,'visualViewport',{configurable:true,value:vv});vv.dispatchEvent(new Event('resize'));window.dispatchEvent(new Event('resize'));
  });await page.waitForTimeout(100);
  let r=await input.boundingBox();assert.ok(r.y>=105&&r.y+r.height<=445);
  await page.locator('.cb-mode').click();r=await page.locator('.cb-menu').boundingBox();assert.ok(r.y>=105&&r.y+r.height<=445);
  await page.keyboard.press('Escape');
  const previousY=(await input.boundingBox()).y;
  await page.evaluate(()=>{window.visualViewport.offsetTop=150;window.__realVV.dispatchEvent(new Event('scroll'))});await page.waitForTimeout(100);
  r=await input.boundingBox();assert.ok(r.y>=150&&r.y+r.height<=490);assert.ok(Math.abs(r.y-previousY-45)<1);
  await page.evaluate(()=>{Object.defineProperty(window,'visualViewport',{configurable:true,value:window.__realVV});window.dispatchEvent(new Event('resize'))});await close();
 });
 for(const width of [320,390,768,1440])for(const theme of ['light','dark','auto','apple'])await test(width+'px '+theme+': bar and dropdown fit, targets remain 44px, themed materials work',async()=>{
  await page.setViewportSize({width,height:900});await page.evaluate(t=>{localStorage.setItem('cap-appearance-theme',t);applyTheme()},theme);
  await open();const r=await bar.boundingBox();assert.ok(r.x>=0&&r.x+r.width<=width);
   const b=await page.locator('.cb-manual').boundingBox();
   // Translated DOMRects can round 44 CSS px to 43.99999999999997.
   assert.ok(b.width>=44-.001&&b.height>=44-.001,'manual target remains 44 CSS px');
   assert.ok(await page.locator('.cb-manual').evaluate(e=>parseFloat(getComputedStyle(e).width)>=44&&parseFloat(getComputedStyle(e).height)>=44));
  assert.ok(await input.evaluate(e=>e.clientWidth>=70));
  await page.locator('.cb-mode').click();const m=await page.locator('.cb-menu').boundingBox();assert.ok(m.x>=0&&m.x+m.width<=width);
  assert.equal(await page.locator('.cb-surface').evaluate(e=>getComputedStyle(e).backdropFilter),'none');
  assert.ok((await page.locator('#cap-command-backdrop').evaluate(e=>getComputedStyle(e).backdropFilter)).includes('blur'));
  await page.keyboard.press('Escape');
  if([390,768].includes(width)){
   const shots=path.join(process.env.LOCALAPPDATA||process.env.TEMP,'Temp','opencode','command-bar-review');fs.mkdirSync(shots,{recursive:true});
   await page.screenshot({path:path.join(shots,`command-${width}-${theme}.png`)});
   if(width===390&&theme==='apple'){
    await page.locator('.cb-mode').click();await page.waitForTimeout(220);await page.screenshot({path:path.join(shots,'command-menu.png')});await page.keyboard.press('Escape');
   }
  }
  await close();
 });
 await test('touch entry, mode selection and dismissal remain functional on a mobile context',async()=>{
  const mobile=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  await mobile.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const p=await mobile.newPage();await p.goto(origin);await p.waitForFunction(()=>window.CapCommandBar&&!window.capLaunchActive);
  await p.evaluate(()=>{localStorage.setItem('cap_whats_new_seen_version',APP_VERSION);if(document.querySelector('.whats-new-overlay'))closeWhatsNew();document.querySelector('#cap-auth')?.remove()});
  await p.waitForTimeout(800);
  await p.locator('#tabs .nav-action').tap();await p.waitForFunction(()=>CapCommandBar.getState().state==='open');
  await p.locator('.cb-mode').tap();await p.getByRole('menuitemradio',{name:'Search',exact:true}).tap();
  assert.equal(await p.locator('#cap-command-input').getAttribute('placeholder'),'Search your finances…');
  const heading=await p.locator('h1').first().boundingBox();await p.touchscreen.tap(heading.x+10,heading.y+10);await p.waitForFunction(()=>CapCommandBar.getState().state==='closed');await mobile.close();
 });
 await test('no runtime errors or cloud requests',()=>{assert.deepEqual(errors,[]);assert.equal(requests.length,0)});
 await context.close();console.log(`PASS: ${passed} Command Bar Phase 1 checks`);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r))});
