/* Actual UI/filter/action paths on an isolated HTTP origin. Synthetic records
   only. No financial action is submitted; all external requests are blocked. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),zlib=require('node:zlib');
if(!process.env.CAP_PLAYWRIGHT_PATH){console.log('SKIP: liquid UI checks require CAP_PLAYWRIGHT_PATH');process.exit(0);}
const {chromium}=require(process.env.CAP_PLAYWRIGHT_PATH),root=path.resolve(__dirname,'..');
const shots=path.join(process.env.LOCALAPPDATA||process.env.TEMP,'Temp','opencode','apple-liquid-review');
let browser,server,passed=0,external=0;
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.mp3':'audio/mpeg'};
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
const pause=p=>p.waitForTimeout(280);
function pixel(png){let i=8,data=[];while(i<png.length){const n=png.readUInt32BE(i),kind=png.toString('ascii',i+4,i+8);if(kind==='IDAT')data.push(png.subarray(i+8,i+8+n));i+=12+n;}return [...zlib.inflateSync(Buffer.concat(data)).subarray(1,4)];}
(async()=>{
  fs.mkdirSync(shots,{recursive:true});
  server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://fixture.invalid');
    if(['/supabase-config.js','/supabase-config.local.js'].includes(u.pathname)){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end('window.CAP_SUPABASE_CONFIG={};');}
    if(u.pathname.startsWith('/rest/')||u.pathname.startsWith('/auth/')){external++;res.writeHead(403);return res.end();}
    const file=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
    fs.readFile(file,(e,b)=>{res.writeHead(e?404:200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(e?'Missing':b);});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({reducedMotion:'reduce',viewport:{width:390,height:844}});
  await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const page=await context.newPage();await page.goto(origin);
  await page.waitForFunction(()=>window.CapOverlays&&window.CapProductionSync&&!window.capLaunchActive);
  await page.evaluate(()=>{localStorage.setItem('cap_whats_new_seen_version',APP_VERSION);if(document.querySelector('.whats-new-overlay'))closeWhatsNew();document.querySelector('#cap-auth')?.remove();});await pause(page);
  await page.evaluate(()=>{
    const date=n=>{const d=new Date(today+'T12:00:00');d.setDate(d.getDate()+n);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
    const future=date(3),past=date(-1);
    S.accts=[{id:100,name:'Fixture Debit',bank:'Fixture',type:'debit',bal:5000,img:'cash',g:['#234567','#123456']},{id:101,name:'Fixture Wallet',bank:'Fixture',type:'ewallet',bal:1000,g:['#234567','#123456']},{id:102,name:'Fixture Credit',bank:'Fixture',type:'credit',bal:200,lim:1000,stmt:+future.slice(8),due:+future.slice(8),g:['#234567','#123456']}];
    S.tx=[{id:501,d:past,amt:-12.5,cat:'Food',acct:100,note:'Posted expense'},{id:502,d:past,amt:1100,cat:'Salary',acct:100,note:'Posted income'},{id:503,d:past,amt:25,cat:'Other',acct:100,note:'Outside deposit'},{id:504,d:future,amt:-3,cat:'Food',acct:100,note:'Future-dated posted'}];
    S.pend=[{id:601,d:future,amt:-7,cat:'Food',acct:100,note:'Scheduled pending'}];
    S.xfer=[{id:801,d:past,amt:100,from:100,to:101,kind:'account-transfer',note:'Linked transfer'},{id:802,d:past,amt:20,from:100,to:102,note:'Linked card payment'},{id:803,d:past,amt:30,from:100,to:100,kind:'goal-transfer',goalId:901,direction:'in'}];
    S.goals=[{id:901,name:'Fixture goal',icon:'🎯',accountId:100,saved:30,target:100}];
    S.bills=[{id:701,name:'Scheduled fixture bill',amt:15,due:+future.slice(8),start:future,freq:'monthly',acct:100,paid:''}];
    // Prime the existing statement lifecycle during synthetic fixture setup,
    // before the immutable comparison baseline (the financial code is frozen).
    dueAmt(acct(102));
    localStorage.setItem('cap-appearance-theme','apple');tab='Activity';scopeClear();filt='All';render();
  });await pause(page);
  const snapshot=()=>page.evaluate(async()=>JSON.stringify({S,baseline:(await CapOff.productionSyncSnapshot()).baseline,outbox:(await CapOff.productionSyncSnapshot()).outbox,hold:localStorage.getItem(CapProductionSync.recoveryKey)}));
  const before=await snapshot();
  const ids=()=>page.locator('#app .row[data-tx],#app .row[data-xfer]').evaluateAll(es=>es.map(e=>+(e.dataset.tx||e.dataset.xfer)));
  await test('All is posted-only, including persisted transfers/payments and future-dated posted records',async()=>{
    assert.deepEqual((await ids()).sort((a,b)=>a-b),[501,502,503,504,801,802,803]);
    assert.equal(await page.locator('#app .row').filter({hasText:'Scheduled fixture bill'}).count(),0);
  });
  for(const [filter,expected] of [['Expenses',[501,504]],['Income',[502,503]],['Transfers',[801,802,803]]])await test(filter+' contains only its posted record types',async()=>{
    await page.evaluate(f=>setFilt(f),filter);await pause(page);assert.deepEqual((await ids()).sort((a,b)=>a-b),expected);
  });
  await test('Upcoming contains pending/scheduled obligations, never future-dated posted transactions',async()=>{
    await page.evaluate(()=>setFilt('Upcoming'));await pause(page);assert.deepEqual(await ids(),[601]);
    assert.ok(await page.locator('#app .row').filter({hasText:'Scheduled fixture bill'}).count());
  });
  await test('calendar still retains obligations and filter changes do not mutate records',async()=>{
    assert.equal(await page.evaluate(()=>evs(S.pend[0].d).some(e=>e.kind==='bill'&&e.id===701)),true);
    assert.equal(await snapshot(),before);
  });
  await page.evaluate(()=>setFilt('All'));await pause(page);
  for(const [kind,id,title] of [['tx',501,'expense'],['tx',502,'income'],['tx',503,'deposit'],['xfer',801,'transfer'],['xfer',802,'card payment'],['xfer',803,'goal transfer']])await test(title+' uses the common action affordance with safe capabilities',async()=>{
    const button=page.locator(`[data-${kind}="${id}"] .activity-actions`).first();assert.equal(await button.count(),1);
    await button.evaluate(e=>e.scrollIntoView({block:'center'}));await button.click();await pause(page);
    const menu=page.locator('.activity-action-menu');assert.equal(await menu.getByRole('button',{name:'View details',exact:true}).count(),1);
    assert.equal(await menu.getByRole('button',{name:'Edit transaction',exact:true}).count(),kind==='tx'?1:0);
    assert.equal(await menu.getByRole('button',{name:'Delete entry',exact:true}).count(),kind==='tx'?1:0);
    await menu.getByRole('button',{name:'View details',exact:true}).click();await pause(page);
    const text=await page.locator('#sb').innerText();assert.ok(text.includes(kind==='tx'?'Payment details':id===801?'Transfer details':id===802?'Card Payment':'Fixture goal'));
    await page.evaluate(()=>closeS());await pause(page);assert.equal(await snapshot(),before);
  });
  await test('ordinary transaction edit and delete use existing handlers and confirmation',async()=>{
    await page.evaluate(()=>activityRecordActions('tx',501));await pause(page);
    await page.getByRole('button',{name:'Edit transaction',exact:true}).click();await pause(page);assert.equal(await page.locator('#am').inputValue(),'12.5');
    await page.evaluate(()=>closeS());await pause(page);await page.evaluate(()=>activityRecordActions('tx',501));await pause(page);
    await page.getByRole('button',{name:'Delete entry',exact:true}).click();await pause(page);
    assert.ok(await page.locator('#cfm.open').count());await page.locator('#cfm-no').click();await pause(page);await page.evaluate(()=>closeS());await pause(page);
    assert.equal(await snapshot(),before);
  });
  await test('four visual previews select and persist with an accessible non-color indicator',async()=>{
    await page.evaluate(()=>stGo('appearance'));await pause(page);
    assert.equal(await page.locator('.theme-choice .theme-preview').count(),4);
    for(const [key,label] of [['light','Light'],['dark','Dark'],['auto','Auto'],['apple','Apple Theme']]){
      await page.getByRole('button',{name:label,exact:true}).click();await pause(page);
      assert.equal(await page.evaluate(()=>localStorage.getItem('cap-appearance-theme')),key);
      const selected=page.locator('.theme-choice[aria-pressed="true"]');assert.equal(await selected.count(),1);
      assert.equal(await selected.getAttribute('data-theme-choice'),key);
      assert.equal(await selected.locator('.theme-choice-check').evaluate(e=>getComputedStyle(e).visibility),'visible');
    }
    assert.equal(await snapshot(),before);
  });
  const sizes=[[320,740],[390,844],[768,1024],[1024,768],[1440,900]];
  for(const colorScheme of ['light','dark'])for(const [width,height] of sizes){
    const label=width+'x'+height+' Apple '+colorScheme;
    await page.setViewportSize({width,height});await page.emulateMedia({colorScheme});await page.evaluate(()=>{closeS();tab='Activity';setFilt('All');});await pause(page);
    await test(label+': row amount / action alignment and touch targets',async()=>{
      const rows=await page.locator('#app .row[data-tx],#app .row[data-xfer]').evaluateAll(es=>es.map(e=>{const b=e.querySelector('.activity-actions'),a=e.querySelector(':scope>b'),r=e.getBoundingClientRect();return {row:r.toJSON(),button:b?.getBoundingClientRect().toJSON(),amount:a?.getBoundingClientRect().toJSON()};}));
      assert.equal(rows.length,7);for(const r of rows){assert.ok(r.button&&r.amount);assert.ok(r.button.width>=44&&r.button.height>=44);assert.ok(r.amount.right<=r.button.left+1&&r.button.right<=r.row.right+1);}
    });
    await test(label+': nav has one low-opacity blur layer and integrated selection/+ control',async()=>{
      const a=await page.locator('#tabs').evaluate(e=>{const c=getComputedStyle(e),p=getComputedStyle(e,'::before'),s=getComputedStyle(e.querySelector('.on'));return {bg:c.backgroundColor,blur:c.backdropFilter,webkit:c.webkitBackdropFilter,pointer:p.pointerEvents,pseudo:p.backdropFilter,selected:s.backgroundColor,foreground:s.color,child:[...e.querySelectorAll('*')].every(n=>!getComputedStyle(n).backdropFilter||getComputedStyle(n).backdropFilter==='none'),plus:getComputedStyle(e.querySelector('.nav-action-plus')).backgroundColor,rect:e.getBoundingClientRect().toJSON()};});
      assert.match(a.bg,colorScheme==='dark'?/0\.28\)/:/0\.22\)/);assert.match(a.blur,/blur\(14px\).*saturate/);if(a.webkit)assert.equal(a.webkit,a.blur);assert.equal(a.pointer,'none');assert.equal(a.pseudo,'none');assert.equal(a.child,true);assert.equal(a.plus,'rgba(0, 0, 0, 0)');assert.ok(a.rect.left>=0&&a.rect.right<=width);
      assert.ok(fs.readFileSync(path.join(root,'css/styles.css'),'utf8').includes('-webkit-backdrop-filter:var(--nav-material)'));
      assert.equal(a.foreground,colorScheme==='dark'?'rgb(28, 28, 30)':'rgb(255, 255, 255)');
    });
    await test(label+': rendered nav pixels respond visibly to background content',async()=>{
      await page.evaluate(()=>{const d=document.createElement('div');d.id='glass-fixture';d.style.cssText='position:fixed;inset:0;z-index:49;background:rgb(255,0,0);pointer-events:none';document.body.append(d);});
      const r=await page.locator('#tabs').boundingBox(),clip={x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+4),width:1,height:1};
      const red=pixel(await page.screenshot({clip,scale:'css'}));await page.evaluate(()=>document.querySelector('#glass-fixture').style.background='rgb(0,0,255)');
      const blue=pixel(await page.screenshot({clip,scale:'css'}));assert.ok(red.reduce((s,v,i)=>s+Math.abs(v-blue[i]),0)>200,JSON.stringify({red,blue}));
      await page.evaluate(()=>document.querySelector('#glass-fixture').remove());
    });
    await test(label+': Apple entry modal has one glass surface and opaque readable fields',async()=>{
      await page.evaluate(()=>openTx());await pause(page);
      const a=await page.evaluate(()=>{const s=getComputedStyle(document.querySelector('#sb')),field=getComputedStyle(document.querySelector('#am')),scrim=getComputedStyle(document.querySelector('#sheet'));return {bg:s.backgroundColor,blur:s.backdropFilter,webkit:s.webkitBackdropFilter,field:field.backgroundColor,fieldBlur:field.backdropFilter,scrim:scrim.backdropFilter};});
      assert.match(a.bg,/rgba\(/);assert.match(a.blur,/blur\(18px\)/);if(a.webkit)assert.equal(a.webkit,a.blur);assert.equal(a.fieldBlur,'none');assert.equal(a.scrim,'none');assert.ok(!a.field.startsWith('rgba('));
      assert.ok(fs.readFileSync(path.join(root,'css/styles.css'),'utf8').includes('-webkit-backdrop-filter:var(--popup-material)'));
    });
    await test(label+': dropdown / confirmation preserve portal layering and hit targets',async()=>{
      await page.locator('#sb .ps-btn').first().click();await pause(page);
      const a=await page.evaluate(()=>{const p=document.querySelector('#cap-overlays .ps-pop:not(.out)'),r=p.getBoundingClientRect();return {host:+getComputedStyle(p.parentElement).zIndex,modal:+getComputedStyle(document.querySelector('#sheet')).zIndex,hit:document.elementFromPoint(r.x+20,r.y+20)?.closest('.ps-pop')===p,blur:getComputedStyle(p).backdropFilter};});
      assert.ok(a.host>a.modal&&a.hit);assert.match(a.blur,/blur\(18px\)/);
      await page.evaluate(()=>confirmBox('Fixture confirmation','No financial action will run',()=>{},'Confirm'));await pause(page);
      assert.equal(await page.evaluate(()=>+getComputedStyle(document.querySelector('#cfm')).zIndex>+getComputedStyle(document.querySelector('#cap-overlays')).zIndex),true);
      await page.locator('#cfm-no').click();await page.keyboard.press('Escape');await page.evaluate(()=>closeS());await pause(page);
    });
    await test(label+': theme previews are keyboard accessible and fit the window',async()=>{
      await page.evaluate(()=>stGo('appearance'));await pause(page);await page.keyboard.press('Tab');await page.getByRole('button',{name:'Apple Theme',exact:true}).focus();
      const a=await page.getByRole('button',{name:'Apple Theme',exact:true}).evaluate(e=>({outline:getComputedStyle(e).outlineStyle,r:e.getBoundingClientRect().toJSON()}));
      assert.equal(a.outline,'solid');assert.ok(a.r.width>=44&&a.r.height>=44&&a.r.right<=width);
      const compact=await page.locator('.appearance-themes').evaluate(e=>({gap:getComputedStyle(e).gap,choices:[...e.querySelectorAll('.theme-choice')].map(c=>({padding:getComputedStyle(c).padding,font:getComputedStyle(c.querySelector('.theme-choice-name')).fontSize,preview:c.querySelector('.theme-preview').getBoundingClientRect().height}))}));
      assert.equal(compact.gap,'8px');
      for(const c of compact.choices){assert.equal(c.padding,'6px');assert.equal(c.font,'13px');assert.equal(c.preview,64);}
      await page.screenshot({path:path.join(shots,`appearance-${width}-${colorScheme}.png`)});await page.evaluate(()=>closeS());await pause(page);
    });
  }
  await test('non-Apple Light/Dark/Auto retain non-glass modal styling',async()=>{
    for(const theme of ['light','dark','auto']){
      await page.evaluate(t=>{setTheme(t);},theme);await page.evaluate(()=>openTx());await pause(page);
      assert.equal(await page.locator('#sb').evaluate(e=>getComputedStyle(e).backdropFilter),'none');await page.evaluate(()=>closeS());await pause(page);
    }
  });
  await test('Apple glass fallback is opaque without backdrop support',async()=>{
    await page.evaluate(()=>{setTheme('apple');for(const sheet of document.styleSheets)for(let i=sheet.cssRules.length-1;i>=0;i--){const r=sheet.cssRules[i];if(r instanceof CSSSupportsRule&&r.conditionText.includes('backdrop-filter'))sheet.deleteRule(i);}openTx();});await pause(page);
    for(const selector of ['#tabs','#sb']){const a=await page.locator(selector).evaluate(e=>({bg:getComputedStyle(e).backgroundColor,blur:getComputedStyle(e).backdropFilter}));assert.equal(a.blur,'none');assert.ok(!a.bg.startsWith('rgba('),selector+' '+a.bg);}
  });
  await test('all UI/filter/menu inspection preserves linked records, balances, IDs, queue and hold',async()=>{assert.equal(await snapshot(),before);assert.equal(external,0);assert.equal(await page.evaluate(()=>CapProductionSync.status().enabled),false);});
  await context.close();console.log('Screenshots: '+shots);console.log(`PASS: ${passed} liquid glass / preview / Activity execution checks`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));});
