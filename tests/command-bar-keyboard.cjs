/* Synthetic visualViewport sequences in a real browser. Not a native OS keyboard test. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
if(!process.env.CAP_PLAYWRIGHT_PATH){console.log('SKIP keyboard browser: set CAP_PLAYWRIGHT_PATH');process.exit(0)}
const {chromium}=require(process.env.CAP_PLAYWRIGHT_PATH),root=path.resolve(__dirname,'..');
let browser,server,passed=0;
async function test(name,fn){await fn();console.log('PASS '+name);passed++}
(async()=>{
 server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://fixture.invalid');
  if(['/supabase-config.js','/supabase-config.local.js'].includes(u.pathname)){res.setHeader('Content-Type','text/javascript');return res.end('window.CAP_SUPABASE_CONFIG={};')}
  const f=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
  if(!f.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
  fs.readFile(f,(err,b)=>{res.writeHead(err?404:200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'})[path.extname(f)]||'application/octet-stream'});res.end(err?'Missing':b)});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844}}),errors=[],external=[];
 await context.route('**/*',r=>{
  const url=new URL(r.request().url());
  if(url.origin!==origin){external.push(r.request().url());return r.abort()}
  if(url.pathname==='/js/smart-log-parser.js')return r.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(root,'js/smart-log-parser.js'),'utf8')+';(()=>{const original=window.CapSmartLogParser;window.__parses=0;window.CapSmartLogParser={...original,parse(...args){window.__parses++;return original.parse(...args)}}})();'});
  return r.continue();
 });
 await context.addInitScript(()=>{
  const vv=new EventTarget();Object.assign(vv,{width:innerWidth,height:innerHeight,offsetLeft:0,offsetTop:0,scale:1});
  Object.defineProperty(window,'visualViewport',{configurable:true,value:vv});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 await page.waitForFunction(()=>window.CapCommandBar&&window.CapSmartLogParser&&!window.capLaunchActive);
 await page.evaluate(()=>{
  localStorage.setItem('cap_whats_new_seen_version',APP_VERSION);if(document.querySelector('.whats-new-overlay'))closeWhatsNew();document.querySelector('#cap-auth')?.remove();
  S.accts=[{id:4,name:'Maya Black Visa',bank:'Maya',type:'credit',l4:'4321',bal:0,lim:20000,stmt:24,due:13,g:['#123456','#234567']}];
  S.tx=[];S.pend=[];S.xfer=[];S.bills=[];S.goals=[];S.debts=[];S.cats=['Food','Entertainment','Other'].map((n,i)=>({id:i+1,n,i:'•'}));tab='Home';render();
  window.__writes=0;for(const key of ['saveTx','accountTransferCommit']){const fn=window[key];window[key]=function(){window.__writes++;return fn.apply(this,arguments)}}
 });await page.waitForTimeout(600);
 const input=page.locator('#cap-command-input'),bar=page.locator('#cap-command-bar'),preview=page.locator('.sl-preview');
 const snapshot=()=>page.evaluate(()=>JSON.stringify(S));const before=await snapshot();
 const viewport=async props=>{await page.evaluate(props=>{Object.assign(visualViewport,props);visualViewport.dispatchEvent(new Event('resize'));visualViewport.dispatchEvent(new Event('scroll'));},props);await page.waitForTimeout(90)};
  const anchor=async()=>{
   // Wait for the latest viewport, not a still-aligned previous rotation frame.
   // Capture placement + DOMRect atomically so protocol latency cannot combine
   // a portrait placement with a landscape rectangle.
   const sample=await page.waitForFunction(()=>{
    const p=CapCommandBar.getPlacement(),r=document.querySelector('#cap-command-bar').getBoundingClientRect(),v=window.visualViewport;
    const bottom=v?v.offsetTop+v.height:innerHeight;
    return p.keyboard&&Math.abs(p.visibleBottom-bottom)<=1&&Math.abs(p.visibleBottom-r.bottom-12)<=2?{p,r:{x:r.x,y:r.y,width:r.width,height:r.height}}:false;
   });
   const {p,r}=await sample.jsonValue();await sample.dispose();
   assert.ok(p.keyboard);assert.ok(Math.abs(p.visibleBottom-(p.top+64)-12)<=1);assert.ok(Math.abs(p.visibleBottom-(r.y+r.height)-12)<=2,JSON.stringify({p,r}));
  };
  await page.evaluate(()=>CapCommandBar.open());await page.waitForFunction(()=>CapCommandBar.getState().state==='open');await page.waitForTimeout(260);
  await test('focus expands modestly; hardware keyboard focus does not imply occlusion',async()=>{
   const settledWidth=async focused=>{
    const sample=await page.waitForFunction(focused=>{const e=document.querySelector('#cap-command-bar'),r=e.getBoundingClientRect(),p=CapCommandBar.getPlacement();return !!p.focused===focused&&Math.abs(r.width-parseFloat(e.style.width))<.01&&!e.getAnimations().some(a=>a.playState==='running')?{x:r.x,y:r.y,width:r.width,height:r.height}:false},focused);
    const r=await sample.jsonValue();await sample.dispose();return r;
   };
   const focused=await settledWidth(true);assert.ok(await bar.evaluate(e=>e.classList.contains('cb-focused')));assert.equal(await page.evaluate(()=>CapCommandBar.getPlacement().keyboard),false);
   await input.blur();const unfocused=await settledWidth(false);assert.ok(focused.width>unfocused.width&&focused.width-unfocused.width<=12,JSON.stringify({focused,unfocused}));assert.ok(Math.abs(focused.y-unfocused.y)<2);
  await input.focus();
 });
 for(const [name,width,height,visible,offset] of [
  ['iPhone portrait',390,844,460,0],['iPhone tall keyboard',390,844,360,90],['iPhone landscape',844,390,210,0],
  ['iPad portrait',820,1180,700,0],['iPad landscape Safari pan',1180,820,450,70],
  ['Android phone',412,915,510,0],['Android tablet portrait',800,1280,780,0],['Android tablet landscape',1280,800,470,0]
 ])await test(name+': newest viewport geometry anchors the bar 12px above keyboard',async()=>{
  await page.setViewportSize({width,height});await viewport({width,height,offsetTop:0});
  await page.evaluate(()=>dispatchEvent(new Event('orientationchange')));await input.focus();
  await viewport({height:visible,offsetTop:offset});await anchor();
  await viewport({height,offsetTop:0});
 });
 await page.setViewportSize({width:390,height:844});await viewport({width:390,height:844,offsetTop:0});await page.evaluate(()=>dispatchEvent(new Event('orientationchange')));
 await test('Enter parses and blurs; receipt waits for keyboard expansion and never writes',async()=>{
  await input.fill('Maya Black Jollibee 1828');await viewport({height:440});await anchor();const parses=await page.evaluate(()=>__parses);await input.press('Enter');
  assert.equal(await page.evaluate(()=>__parses),parses+1,'parse happens once before deferred preview entry');
  assert.equal(await input.evaluate(e=>e===document.activeElement),false);assert.equal(await preview.isVisible(),false);
  await viewport({height:600});assert.equal(await preview.isVisible(),false);await anchor();
  await viewport({height:844});await preview.waitFor({state:'visible'});
  assert.equal(await page.locator('.sl-merchant').innerText(),'Jollibee');assert.equal(await page.locator('.sl-amount').innerText(),'₱1,828.00');
  assert.equal(await page.evaluate(()=>CapCommandBar.getPlacement().keyboard),false);assert.equal(await snapshot(),before);assert.equal(await page.evaluate(()=>__writes),0);
 });
 await test('Enter during early keyboard opening waits instead of flashing a cramped receipt',async()=>{
  await input.focus();await viewport({height:800});await input.press('Enter');assert.equal(await preview.isVisible(),false);
  await viewport({height:440});assert.equal(await preview.isVisible(),false);await viewport({height:844});await preview.waitFor({state:'visible'});
 });
 await test('refocusing yields receipt space, retains sentence and reuses focused keyboard anchor',async()=>{
  await input.focus();assert.equal(await preview.isVisible(),false);assert.equal(await input.inputValue(),'Maya Black Jollibee 1828');
  await viewport({height:440});await anchor();assert.ok(await bar.evaluate(e=>e.classList.contains('cb-focused')));
  await input.press('Enter');await viewport({height:844});await preview.waitFor({state:'visible'});
 });
 await test('Edit Transaction uses the same focus/viewport system; Done Editing dismisses before receipt',async()=>{
  await page.getByRole('button',{name:'Edit Transaction',exact:true}).click();await viewport({height:440});await anchor();
  assert.ok(await bar.evaluate(e=>e.classList.contains('cb-focused')));await page.locator('#sl-title').fill('Jollibee Dinner');
  await page.locator('#sl-account + .ps-btn').click();assert.equal(await page.locator('.ps-pop[data-command-owner="cap-command-bar"]:not(.out)').isVisible(),true);
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'Done Editing',exact:true}).click();
  assert.equal(await preview.isVisible(),false);await viewport({height:844});await preview.waitFor({state:'visible'});
  assert.equal(await page.locator('.sl-merchant').innerText(),'Jollibee Dinner');assert.equal(await snapshot(),before);
 });
 await test('rapid resize+scroll bursts coalesce to one positioning frame with newest geometry',async()=>{
  await input.focus();const count=await page.evaluate(async()=>{
   const root=document.querySelector('#cap-command-bar');let calls=0;const on=()=>calls++;root.addEventListener('cap:command-position',on);
   for(let i=0;i<200;i++){visualViewport.height=400+i%40;visualViewport.offsetTop=i%10;visualViewport.dispatchEvent(new Event('resize'));visualViewport.dispatchEvent(new Event('scroll'))}
   visualViewport.height=450;visualViewport.offsetTop=40;
   await new Promise(requestAnimationFrame);root.removeEventListener('cap:command-position',on);return calls;
  });assert.equal(count,1);await page.waitForTimeout(90);await anchor();
 });
 await test('refocus cancels pending Enter preview; a stale settle cannot reopen it',async()=>{
  await input.press('Enter');await input.focus();await viewport({height:844,offsetTop:0});await page.waitForTimeout(180);
  assert.equal(await preview.isVisible(),false);assert.equal(await input.inputValue(),'Maya Black Jollibee 1828');
  await input.press('Enter');await preview.waitFor({state:'visible'});
 });
 await test('compatibility fallback does not force a receipt into a still-occluded viewport',async()=>{
  await input.focus();await viewport({height:440});await input.press('Enter');await page.waitForTimeout(500);
  assert.equal(await preview.isVisible(),false);await viewport({height:844});await preview.waitFor({state:'visible'});
 });
 await test('rapid focus/blur leaves only the newest focused state',async()=>{
  await page.evaluate(()=>{const input=document.querySelector('#cap-command-input');for(let i=0;i<30;i++){input.focus({preventScroll:true});input.blur()}input.focus({preventScroll:true})});
  await viewport({height:440});await anchor();assert.ok(await bar.evaluate(e=>e.classList.contains('cb-focused')));
  await input.press('Enter');await viewport({height:844});await preview.waitFor({state:'visible'});assert.equal(await input.inputValue(),'Maya Black Jollibee 1828');
 });
 await test('rotation with keyboard and draft preserves text and clears old viewport anchors',async()=>{
  await input.focus();await viewport({height:440});await page.setViewportSize({width:844,height:390});
  await viewport({width:844,height:230,offsetTop:0});await page.evaluate(()=>dispatchEvent(new Event('orientationchange')));await page.waitForTimeout(90);await anchor();
  await page.setViewportSize({width:390,height:844});await viewport({width:390,height:440,offsetTop:0});await page.evaluate(()=>dispatchEvent(new Event('orientationchange')));await page.waitForTimeout(90);await anchor();
  assert.equal(await input.inputValue(),'Maya Black Jollibee 1828');await input.press('Enter');await viewport({height:844});await preview.waitFor({state:'visible'});
 });
 await test('Search shares keyboard dismissal but never invokes Smart Log',async()=>{
  const parses=await page.evaluate(()=>__parses);
  await page.evaluate(()=>CapCommandBar.setMode('search'));await viewport({height:440});await anchor();await input.press('Enter');assert.equal(await input.evaluate(e=>e===document.activeElement),false);
  await viewport({height:844});assert.equal(await preview.isVisible(),false);assert.equal(await page.evaluate(()=>__parses),parses);assert.equal(await snapshot(),before);
 });
 await test('reduced motion removes interpolation, not viewport positioning',async()=>{
  await page.emulateMedia({reducedMotion:'reduce'});await input.focus();await viewport({height:440});await anchor();
  assert.ok(await bar.evaluate(e=>getComputedStyle(e).transitionDuration.split(',').every(t=>parseFloat(t)<=.001)));await input.blur();await viewport({height:844});
 });
 await test('missing Visual Viewport falls back to resize geometry without a fixed keyboard height',async()=>{
  await page.evaluate(()=>{window.__testVV=visualViewport;Object.defineProperty(window,'visualViewport',{configurable:true,value:undefined})});
  await input.focus();await page.setViewportSize({width:390,height:440});await page.waitForTimeout(100);await anchor();
  await input.blur();await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100);
  await page.evaluate(()=>{Object.defineProperty(window,'visualViewport',{configurable:true,value:window.__testVV});dispatchEvent(new Event('resize'))});
 });
 await test('close cancels pending review and positioning cannot resurrect the bar',async()=>{
  await page.evaluate(()=>CapCommandBar.setMode('log'));await viewport({height:440});await input.press('Enter');await page.evaluate(()=>CapCommandBar.close());
  await viewport({height:844});await page.waitForTimeout(180);assert.equal(await bar.isVisible(),false);assert.equal(await preview.isVisible(),false);
  assert.equal(await snapshot(),before);assert.equal(await page.evaluate(()=>__writes),0);
 });
 await test('no runtime errors or external requests',()=>{assert.deepEqual(errors,[]);assert.deepEqual(external,[])});
 await context.close();console.log(`PASS: ${passed} Command Bar keyboard checks (synthetic viewport, real Chromium)`);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r))});
