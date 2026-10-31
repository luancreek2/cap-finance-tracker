/* Phase 2C real Chrome UI/IndexedDB; all remote traffic blocked. No real push. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
if(!process.env.CAP_PLAYWRIGHT_PATH){console.log('SKIP Phase 2C browser: set CAP_PLAYWRIGHT_PATH');process.exit(0);}
const {chromium}=require(process.env.CAP_PLAYWRIGHT_PATH),root=path.resolve(__dirname,'..');
 let browser,server,passed=0;const test=async(n,f)=>{await f();passed++;console.log('PASS '+n);};
const artifacts=process.env.CAP_UI_ARTIFACT_DIR;if(artifacts)fs.mkdirSync(artifacts,{recursive:true});
(async()=>{
 server=http.createServer((req,res)=>{const u=new URL(req.url,'http://fixture.invalid');if(['/supabase-config.js','/supabase-config.local.js'].includes(u.pathname)){res.setHeader('Content-Type','text/javascript');return res.end('window.CAP_SUPABASE_CONFIG={};');}const file=path.resolve(root,'.'+(u.pathname==='/'?'/index.html':decodeURIComponent(u.pathname)));if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}fs.readFile(file,(err,bytes)=>{res.writeHead(err?404:200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(err?'Missing':bytes);});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Manila'}),external=[],errors=[];
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(external.push(route.request().url()),route.abort()));
 await context.addInitScript(()=>{
   window.__dark={v2:0,subscribe:0,sender:0,permission:0};
   class FakeNotification{static permission='default';static async requestPermission(){__dark.permission++;FakeNotification.permission='granted';return 'granted';}constructor(){}close(){}}
   window.Notification=FakeNotification;
   if(navigator.serviceWorker)navigator.serviceWorker.getRegistration=async()=>({active:{},showNotification:async()=>{}});
   if(window.PushManager)PushManager.prototype.subscribe=async()=>{__dark.subscribe++;throw Error('Push creation forbidden');};
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>window.CapReminderUI&&!window.capLaunchActive);
 await page.evaluate(()=>{
   localStorage.setItem('cap_whats_new_seen_version',APP_VERSION);document.querySelector('#cap-auth')?.remove();document.querySelector('.whats-new-overlay')&&closeWhatsNew();
   const date=CapSmartLogParser.localDate(new Date()),shift=n=>CapFinancialSearchParser.shift(date,n);window.__fixtureDates={today:date,custom:shift(2),due:shift(3),later:shift(5)};
   S.accts=[{id:1,type:'debit',name:'Cash',bank:'Fixture',bal:5000,img:'cash',g:['#123456','#234567']}];S.tx=[];S.pend=[];S.xfer=[];S.goals=[];S.debts=[];S.budgets={};S.cats=[{n:'Bills',i:'🧾'}];
   S.bills=[{id:1,name:'Spotify Premium',kind:'subscription',amt:115,freq:'once',start:shift(3),acct:1,paidOn:[]},{id:2,name:'Meralco',kind:'bill',amt:3240,freq:'once',start:date,acct:1,paidOn:[]},{id:3,name:'Unknown Vendor',kind:'bill',amt:22,freq:'once',start:shift(-1),acct:1,paidOn:[]}];
   for(const name of ['notificationPublishV2','notificationReadinessV2','notificationReadbackV2'])CapProductionRpc[name]=async()=>{__dark.v2++;throw Error('Production V2 forbidden');};
   tab='Home';render();
 });
 const snapshot=()=>page.evaluate(async()=>JSON.stringify({S,baseline:await CapOff.syncStore('syncmeta','get','baseline'),outbox:await CapOff.syncStore('outbox','all')}));
 const original=await snapshot(),sheet=page.locator('#sb');
 const settings=async()=>{await page.evaluate(()=>CapReminderUI.settings());await sheet.getByRole('checkbox',{name:'Push Notifications',exact:true}).waitFor();};
 const item=async()=>{await page.evaluate(()=>CapReminderUI.openItem('subscription','1'));await sheet.getByRole('heading',{name:'Reminders',exact:true}).waitFor();};
 const openCenter=async()=>{await page.evaluate(()=>{CapNotifications.close();closeS();});await page.locator('#sheet').waitFor({state:'hidden'});await page.evaluate(()=>CapNotifications.open());await page.locator('#cap-notifications[open]').waitFor();};
 const add=async kind=>{await sheet.getByRole('button',{name:'+ Add Reminder',exact:true}).click();await sheet.getByRole('button',{name:kind==='relative'?'Relative Reminder':'Custom Date & Time',exact:false}).click();};
 const records=()=>page.evaluate(()=>CapReminderUI.items().find(i=>i.id==='1'&&i.source==='subscription'));
 await test('Settings sections, push row, disabled email and private amount default',async()=>{
   await settings();for(const text of ['Delivery','Reminders','Schedule','Privacy'])assert.ok((await sheet.innerText()).toLowerCase().includes(text.toLowerCase()));
   assert.equal(await sheet.getByRole('button',{name:/Email Notifications/}).isDisabled(),true);
   for(const label of ['Bills','Subscriptions','Credit Cards','Free Trials','Show Amounts'])assert.equal(await sheet.getByRole('checkbox',{name:label,exact:true}).count(),1);
   assert.equal(await sheet.getByRole('checkbox',{name:'Show Amounts',exact:true}).isChecked(),false);
   assert.match(await sheet.innerText(),/Background delivery is not active|In Cap only/);assert.equal(await page.evaluate(()=>__dark.permission),0);
 });
 await test('push preference and permission remain explicit and create no subscription',async()=>{
   await sheet.getByRole('checkbox',{name:'Push Notifications',exact:true}).check();await sheet.getByRole('button',{name:'Allow Notifications',exact:true}).waitFor();assert.equal(await page.evaluate(()=>__dark.permission),0);
   await sheet.getByRole('button',{name:'Allow Notifications',exact:true}).click();await page.waitForFunction(()=>__dark.permission===1);assert.equal(await page.evaluate(()=>__dark.subscribe),0);
 });
 await test('Default Reminder Time displays friendly 09:00 and persists a canonical edit',async()=>{
   await settings();assert.match(await sheet.getByRole('button',{name:/Default Reminder Time/}).innerText(),/9:00/);await sheet.getByRole('button',{name:/Default Reminder Time/}).click();await page.locator('#cn-default-time').fill('19:30');await sheet.getByRole('button',{name:'Save Time',exact:true}).click();await sheet.getByRole('button',{name:/Default Reminder Time/}).waitFor();assert.equal(await page.evaluate(async()=>(await CapNotificationSchedule.loadPolicy()).default_local_time),'19:30');
 });
 await test('Default Reminders preserves category-specific migration and supports multiple stages',async()=>{
   await sheet.getByRole('button',{name:/Default Reminders/}).click();await page.locator('#cn-default-category').selectOption('renew');
   const checks=sheet.locator('input[name="cn-stage"]');
   assert.deepEqual(await checks.evaluateAll(nodes=>nodes.filter(n=>n.checked).map(n=>Number(n.value))),[3]);
   await sheet.getByLabel('14 days before',{exact:true}).check();await sheet.getByLabel('7 days before',{exact:true}).check();await sheet.getByRole('button',{name:'Save Reminders',exact:true}).click();await sheet.getByRole('button',{name:/Default Reminders/}).waitFor();
   assert.deepEqual(await page.evaluate(async()=>(await CapNotificationSchedule.loadPolicy()).category_stages.renew),[14,7,3]);
 });
 await test('first setup creates real multiple Phase 2B reminder identities, not display rows',async()=>{
   await item();await sheet.getByRole('button',{name:'Set Up Reminders',exact:true}).click();await sheet.getByRole('button',{name:'+ Add Reminder',exact:true}).waitFor();await page.waitForFunction(()=>CapReminderUI.items().some(i=>i.id==='1'&&!i.review_required));
   const r=await records();assert.equal(r.reminders.length,3);assert.equal(r.plan.identity_version,2);assert.equal(r.review_required,false);assert.equal(r.plan.identity_blocked,false);
   assert.match(await sheet.innerText(),/Saved on this device/);assert.doesNotMatch(await sheet.innerText(),/Scheduled/);
 });
 let firstId,customId,customUTC;
 await test('relative editing retains reminder ID and supports custom override time',async()=>{
   firstId=(await records()).reminders[0].reminder_id;await sheet.locator(`[data-id="${firstId}"]`).click();await page.locator('#cn-reminder-lead').selectOption('5');await page.locator('#cn-time-source').selectOption('override');await page.locator('#cn-reminder-time').fill('08:15');await sheet.getByRole('button',{name:'Save Reminder',exact:true}).click();await sheet.getByRole('button',{name:'+ Add Reminder',exact:true}).waitFor();
   const r=(await records()).reminders.find(r=>r.reminder_id===firstId);assert.equal(r.days_before,5);assert.equal(r.override_local_time,'08:15');
 });
 await test('add custom date/time stores a fixed UTC instant and an opaque durable ID',async()=>{
   await add('custom');await page.locator('#cn-reminder-date').fill(await page.evaluate(()=>__fixtureDates.custom));await page.locator('#cn-reminder-time').fill('18:45');await sheet.getByRole('button',{name:'Save Reminder',exact:true}).click();await sheet.getByRole('button',{name:'+ Add Reminder',exact:true}).waitFor();
   const r=(await records()).reminders.find(r=>r.kind==='absolute');customId=r.reminder_id;customUTC=r.send_after;assert.equal(r.timezone,'Asia/Manila');assert.ok(r.send_after.endsWith('10:45:00Z'));
 });
 await test('custom edit retains its ID and changing default time never moves it',async()=>{
   await sheet.locator(`[data-id="${customId}"]`).click();await page.locator('#cn-reminder-time').fill('20:00');await sheet.getByRole('button',{name:'Save Reminder',exact:true}).click();await sheet.getByRole('button',{name:'+ Add Reminder',exact:true}).waitFor();customUTC=(await records()).reminders.find(r=>r.reminder_id===customId).send_after;
   await settings();await sheet.getByRole('button',{name:/Default Reminder Time/}).click();await page.locator('#cn-default-time').fill('09:00');await sheet.getByRole('button',{name:'Save Time',exact:true}).click();await sheet.getByRole('button',{name:/Default Reminder Time/}).waitFor();await item();assert.equal((await records()).reminders.find(r=>r.reminder_id===customId).send_after,customUTC);
 });
 await test('duplicate and past custom times show contextual validation',async()=>{
   await add('custom');await page.locator('#cn-reminder-date').fill('2020-01-01');await sheet.getByRole('button',{name:'Save Reminder',exact:true}).click();await page.waitForFunction(()=>document.getElementById('cn-editor-status').textContent.includes('future'));
   await page.locator('#cn-reminder-date').fill(await page.evaluate(()=>__fixtureDates.custom));await page.locator('#cn-reminder-time').fill('20:00');await sheet.getByRole('button',{name:'Save Reminder',exact:true}).click();await page.waitForFunction(()=>document.getElementById('cn-editor-status').textContent.includes('already uses'));
   await page.evaluate(()=>CapReminderUI.backToItem());
 });
 await test('delete then recreate uses a new reminder ID and durable tombstone',async()=>{
   await sheet.locator(`[data-id="${firstId}"]`).click();await sheet.getByRole('button',{name:'Delete Reminder',exact:true}).click();await sheet.getByRole('button',{name:'+ Add Reminder',exact:true}).waitFor();
   await add('relative');await page.locator('#cn-reminder-lead').selectOption('5');await sheet.getByRole('button',{name:'Save Reminder',exact:true}).click();await sheet.getByRole('button',{name:'+ Add Reminder',exact:true}).waitFor();
   assert.ok(!(await records()).reminders.some(r=>r.reminder_id===firstId));assert.equal(await page.evaluate(async id=>(await CapNotificationSchedule.loadIdentities('local')).occurrences.flatMap(o=>o.reminders).find(r=>r.reminder_id===id).state,firstId),'deleted');
 });
 await test('reminder operations leave financial records, balances, baseline and outbox untouched',async()=>assert.equal(await snapshot(),original));
 await test('reload preserves records and requires explicit same-occurrence review',async()=>{
   const old=(await records()).obligation_id;await page.reload();await page.waitForFunction(()=>CapReminderUI&&!capLaunchActive);await page.evaluate(()=>{document.querySelector('#cap-auth')?.remove();document.querySelector('.whats-new-overlay')&&closeWhatsNew();});
   // The synthetic financial fixture was never saved by reminder operations.
   // Restore that identical fixture explicitly for this reload test.
   await page.evaluate(state=>{Object.assign(S,state);tab='Home';render();},JSON.parse(original).S);await item();assert.match(await sheet.innerText(),/Action required/);await sheet.getByRole('button',{name:'Same outstanding item',exact:true}).click();await page.waitForFunction(()=>CapReminderUI.items().some(i=>i.id==='1'&&!i.review_required));assert.equal((await records()).obligation_id,old);assert.ok((await records()).reminders.some(r=>r.reminder_id===customId));
 });
 await test('financial date edit needs review; confirmed continuity preserves IDs and absolute UTC',async()=>{
   const old=(await records()).obligation_id;await page.evaluate(()=>S.bills.find(b=>b.id===1).start=window.__fixtureDates?.later||CapFinancialSearchParser.shift(CapSmartLogParser.localDate(new Date()),5));await item();assert.match(await sheet.innerText(),/Action required/);await sheet.getByRole('button',{name:'Same outstanding item',exact:true}).click();await page.waitForFunction(()=>CapReminderUI.items().some(i=>i.id==='1'&&!i.review_required));assert.equal((await records()).obligation_id,old);assert.equal((await records()).reminders.find(r=>r.reminder_id===customId).send_after,customUTC);
 });
 await test('center groups, local logos and clean amount privacy render correctly',async()=>{
   await openCenter();
   const center=page.locator('#cap-notifications');assert.ok(await center.locator('.cn-logo .bl').count()>0);assert.equal(await center.locator('.cn-logo img[src*="cap-"]').count(),0);assert.doesNotMatch(await center.locator('.cn-meta').allTextContents().then(a=>a.join('')),/₱|PHP|^\s*·/);
   assert.ok((await center.locator('.cn-group h3').allTextContents()).includes('Overdue'));assert.ok((await center.locator('.cn-group h3').allTextContents()).includes('Today'));
   await page.keyboard.press('Escape');await settings();await sheet.getByRole('checkbox',{name:'Show Amounts',exact:true}).check();await sheet.getByRole('checkbox',{name:'Show Amounts',exact:true}).waitFor();await openCenter();await page.waitForFunction(()=>document.querySelector('.cn-meta')?.textContent.includes('·'));assert.match((await center.locator('.cn-meta').allTextContents()).join(''),/PHP|₱/);
   if(artifacts){await center.evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));await page.screenshot({path:path.join(artifacts,'notification-center-mobile.png')});}
 });
 await test('read/unread and mark-all-read preserve notification and financial semantics',async()=>{
   const center=page.locator('#cap-notifications');await center.locator('.cn-expand').first().click();await page.waitForFunction(()=>document.querySelector('.cn-row[open]')?.querySelector('.cn-read-state>span').textContent==='Read');await center.getByRole('button',{name:'Mark all as read',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.cn-row.is-unread'));assert.ok(await center.locator('.cn-row').count()>0);
 });
 await test('desktop, tablets and phones fit with no horizontal overflow',async()=>{
   for(const [width,height]of [[320,568],[390,844],[430,932],[768,1024],[1024,768],[1440,900]]){
     await page.setViewportSize({width,height});await page.evaluate(()=>CapNotifications.open());const center=page.locator('#cap-notifications');await center.waitFor({state:'visible'});await center.evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));await page.waitForFunction(()=>parseFloat(document.getElementById('cap-notifications').style.width)===Math.min(460,innerWidth-24));const r=await center.boundingBox();assert.ok(r.x>=11&&r.x+r.width<=width-11&&r.y+r.height<=height);if(width<600)assert.equal(Math.round(r.width),width-24);else assert.ok(r.width<=460);
     assert.equal(await center.locator('.cn-scroll').evaluate(e=>e.scrollWidth<=e.clientWidth),true);await page.keyboard.press('Escape');await settings();assert.equal(await sheet.locator('.st-scroll').evaluate(e=>e.scrollWidth<=e.clientWidth),true);await page.evaluate(()=>closeS());await page.locator('#sheet').waitFor({state:'hidden'});
   }
 });
 await test('keyboard, Escape, switch labels, focus restoration and reduced motion',async()=>{
   await page.setViewportSize({width:390,height:844});await page.locator('#cap-notification-bell').focus();await page.keyboard.press('Enter');await page.locator('#cap-notifications[open]').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('#cap-notification-bell').evaluate(e=>e===document.activeElement),true);
   await settings();await page.keyboard.press('Tab');assert.equal(await sheet.evaluate(e=>e.contains(document.activeElement)),true);await page.keyboard.press('Escape');await page.locator('#sheet').waitFor({state:'hidden'});await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>CapNotifications.open());assert.equal(await page.locator('#cap-notifications').evaluate(e=>getComputedStyle(e).animationName),'none');await page.keyboard.press('Escape');
 });
 await test('all themes render readable notification surfaces and editors',async()=>{
   for(const theme of ['light','dark','apple','bluish-white']){await page.evaluate(t=>{localStorage.setItem('cap-appearance-theme',t);applyTheme();},theme);await settings();const colors=await sheet.evaluate(e=>({background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color}));assert.notEqual(colors.background,colors.color);if(artifacts&&['light','dark'].includes(theme))await page.screenshot({path:path.join(artifacts,'notification-settings-'+theme+'.png')});await page.evaluate(()=>closeS());await page.locator('#sheet').waitFor({state:'hidden'});}
 });
 await test('item detail keeps its existing fields and adds only a Reminders section',async()=>{
   await page.evaluate(()=>editBillSheet(1));await sheet.locator('.cn-item-reminders button').waitFor();assert.equal(await page.locator('#eb-n').inputValue(),'Spotify Premium');await sheet.locator('.cn-item-reminders button').click();await sheet.getByRole('button',{name:'+ Add Reminder',exact:true}).waitFor();assert.ok((await records()).reminders.length>0);
 });
 await test('Bills, Free Trials and stored Credit Cards use the same real editor',async()=>{
   await page.evaluate(()=>{const d=CapSmartLogParser.localDate(new Date()),shift=n=>CapFinancialSearchParser.shift(d,n),en=shift(-30);S.bills.push({id:4,name:'Minecraft',kind:'subscription',amt:100,freq:'monthly',start:shift(6),firstBillingDate:shift(6),trialEndDate:shift(6),isFreeTrial:true,paidOn:[]});S.accts.push({id:7,type:'credit',bank:'BDO',name:'BDO Visa',bal:100,lim:1000,stmt:Number(en.slice(8)),due:Number(shift(5).slice(8)),dueN:0,statementHistory:[{st:shift(-60),en,pv:shift(-61),due:shift(5),opening:0,balance:100,minimum:5,financeRate:0,cashAdvanceRate:0,latePaymentFee:{},limit:1000}]});});
   const before=await snapshot();
   for(const [source,id]of [['bill','2'],['trial','4'],['statement','7']]){await page.evaluate(([s,id])=>CapReminderUI.openItem(s,id),[source,id]);await sheet.getByRole('button',{name:'Set Up Reminders',exact:true}).click();await page.waitForFunction(([s,id])=>CapReminderUI.items().some(i=>i.source===s&&i.id===id&&!i.review_required),[source,id]);assert.match(await sheet.innerText(),/Saved on this device/);}
   assert.equal(await snapshot(),before);
 });
 await test('main notification content reuses Plan handlers for bills, subscriptions, trials and statements',async()=>{
   await page.evaluate(async()=>{await CapReminderUI.editor.defaults('local','trial',[7]);await CapReminderUI.refresh();window.__detailCalls=[];for(const key of ['upBillSheet','upCardSheet']){const fn=window[key];window[key]=function(id){__detailCalls.push([key,id]);return fn.apply(this,arguments);};}});
   const before=await snapshot();
   for(const [match,title,handler,id]of [['Meralco','Bill Details','upBillSheet',2],['Spotify','Subscription Details','upBillSheet',1],['Minecraft','Subscription Details','upBillSheet',4],['Credit card','Statement Details','upCardSheet',7]]){
     await openCenter();const row=page.locator('#cap-notifications .cn-row').filter({hasText:match}).first();await row.locator('.cn-source-main').click();await sheet.getByRole('heading',{name:title,exact:true,level:2}).waitFor();assert.deepEqual(await page.evaluate(()=>__detailCalls.at(-1)),[handler,id]);assert.equal(await page.locator('#cap-notifications').isVisible(),false);
     await page.evaluate(()=>closeS());await page.locator('#cap-notifications[open]').waitFor();assert.equal(await page.evaluate(()=>tab),'Home');assert.equal(await row.locator('.cn-source-main').evaluate(e=>e===document.activeElement),true);
   }
   assert.equal(await snapshot(),before);
 });
 await test('chevron expands only; compact summaries hide all amounts and technical disclaimers when privacy is off',async()=>{
   await page.evaluate(()=>CapNotifications.setPreference('showAmounts',false));await openCenter();const center=page.locator('#cap-notifications'),calls=await page.evaluate(()=>__detailCalls.length);
   for(const row of await center.locator('.cn-row').all()){await row.locator('.cn-expand').click();}
   assert.equal(await page.evaluate(()=>__detailCalls.length),calls);assert.equal(await page.locator('#sheet').isVisible(),false);assert.doesNotMatch(await center.innerText(),/read-only reminder|not a payment|₱|PHP|3,240|115\.00|100\.00|5\.00/);assert.doesNotMatch(await center.locator('.cn-detail').evaluateAll(nodes=>nodes.map(n=>n.textContent).join('')),/₱|PHP/);
   assert.match(await center.innerText(),/Free until/);assert.match(await center.innerText(),/Cash|BDO Visa/);assert.match(await center.innerText(),/Renews|Due/);
 });
 await test('keyboard separates source navigation from chevron expansion',async()=>{
   await openCenter();const row=page.locator('#cap-notifications .cn-row').filter({hasText:'Meralco'}).first();const count=await page.evaluate(()=>__detailCalls.length);await row.locator('.cn-expand').focus();await page.keyboard.press('Space');assert.equal(await row.evaluate(e=>e.open),true);assert.equal(await page.evaluate(()=>__detailCalls.length),count);
   await row.locator('.cn-source-main').focus();await page.keyboard.press('Enter');await sheet.getByRole('heading',{name:'Bill Details',exact:true,level:2}).waitFor();assert.equal(await page.evaluate(()=>__detailCalls.length),count+1);await page.evaluate(()=>closeS());await page.locator('#cap-notifications[open]').waitFor();
 });
 await test('expanded amounts and minimums come from local records only when opted in',async()=>{
   await page.evaluate(()=>CapNotifications.setPreference('showAmounts',true));await openCenter();const center=page.locator('#cap-notifications');for(const row of await center.locator('.cn-row').all()){if(!await row.evaluate(e=>e.open))await row.locator('.cn-expand').click();}
   assert.match(await center.locator('.cn-row').filter({hasText:'Meralco'}).innerText(),/3,240\.00/);assert.match(await center.locator('.cn-row').filter({hasText:'Credit card'}).innerText(),/Minimum/);assert.match(await center.locator('.cn-row').filter({hasText:'Spotify'}).innerText(),/115\.00/);
 });
 await test('Reminders and Dismiss never open a source popup; unresolved source never opens a similarly named item',async()=>{
   await openCenter();let center=page.locator('#cap-notifications'),calls=await page.evaluate(()=>__detailCalls.length),row=center.locator('.cn-row').filter({hasText:'Spotify'}).first();
   await page.evaluate(()=>{window.__removedSource=S.bills.find(b=>b.id===1);S.bills=S.bills.filter(b=>b.id!==1);S.bills.push({...__removedSource,id:999});});await row.locator('.cn-source-main').click();assert.match(await row.innerText(),/Source no longer available/);assert.equal(await page.evaluate(()=>__detailCalls.length),calls);
   const staleId=await row.getAttribute('data-reminder');await row.getByRole('button',{name:'Dismiss reminder',exact:true}).click();await page.waitForFunction(id=>![...document.querySelectorAll('#cap-notifications .cn-row')].some(r=>r.dataset.reminder===id),staleId);assert.equal(await page.evaluate(()=>__detailCalls.length),calls);
   await page.evaluate(()=>{S.bills=S.bills.filter(b=>b.id!==999);S.bills.push(__removedSource);});await openCenter();row=center.locator('.cn-row').filter({hasText:'Meralco'}).first();await row.locator('.cn-expand').click();await row.getByRole('button',{name:'Reminders',exact:true}).click();await sheet.getByRole('heading',{name:'Reminders',exact:true}).waitFor();assert.equal(await page.evaluate(()=>__detailCalls.length),calls);
 });
 await test('same source ID with a replaced object requires review rather than reviving identity',async()=>{
   await page.evaluate(()=>{const index=S.bills.findIndex(b=>b.id===1);S.bills[index]=JSON.parse(JSON.stringify(S.bills[index]));});await item();assert.match(await sheet.innerText(),/Action required/);assert.equal(await sheet.getByRole('button',{name:'+ Add Reminder',exact:true}).isDisabled(),true);
 });
 await test('offline and reconnect show no local/cloud access banner while unrelated toasts work',async()=>{
   await context.setOffline(true);await page.evaluate(()=>{dispatchEvent(new Event('offline'));toast('Reminder saved',true);});assert.equal(await page.locator('.toast').innerText(),'Reminder saved');assert.equal(await page.locator('#cap-local-auth-notice').count(),0);await context.setOffline(false);await page.evaluate(()=>dispatchEvent(new Event('online')));assert.equal(await page.locator('#cap-local-auth-notice').count(),0);
 });
 await test('in-app urgency colors cover every tier, retain text/expanded styling, and meet light/dark contrast',async()=>{
   await page.evaluate(async()=>{
     const today=CapSmartLogParser.localDate(new Date()),shift=n=>CapFinancialSearchParser.shift(today,n);
     for(const days of [-7,0,1,2,3,5,7,14,30])S.bills.push({id:800+days,name:'Urgency '+days,kind:'bill',amt:10,freq:'once',start:shift(days),paidOn:[],acct:1});
     await CapReminderUI.editor.defaults('local','bills',[14]);
     const d=CapReminderUI.descriptors().find(d=>d.id==='830');const item=await CapReminderUI.editor.review('local',d,'source',CapNotifications.preferences());await CapReminderUI.editor.saveReminder('local',item.obligation_id,d,{kind:'absolute',local_date:shift(1),local_time:'10:00'});await CapReminderUI.refresh();
   });
   const financial=await snapshot();
   for(const theme of ['light','dark']){
     await page.evaluate(t=>{localStorage.setItem('cap-appearance-theme',t);applyTheme();},theme);await openCenter();
     const colors=[];
     for(const [days,tier]of [[-7,'overdue'],[0,'today'],[1,'tomorrow'],[2,'soon'],[3,'soon'],[5,'week'],[7,'week'],[14,'early'],[30,'neutral']]){
       const row=page.locator('#cap-notifications .cn-row').filter({hasText:'Urgency '+days}).first();assert.equal(await row.getAttribute('data-timing-urgency'),tier);assert.ok((await row.locator('.cn-meta').innerText()).trim().length>0);const color=await row.locator('.cn-meta').evaluate(e=>getComputedStyle(e).color);colors.push(color);await row.locator('.cn-expand').click();assert.equal(await row.getAttribute('data-timing-urgency'),tier);assert.equal(await row.locator('.cn-meta').evaluate(e=>getComputedStyle(e).color),color);
       const contrast=await row.locator('.cn-meta').evaluate(e=>{
         const ctx=document.createElement('canvas').getContext('2d');const rgb=color=>{ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});};const luminance=c=>{const r=rgb(c);return .2126*r[0]+.7152*r[1]+.0722*r[2];};const a=luminance(getComputedStyle(e).color),b=luminance(getComputedStyle(e.closest('.cn-dialog')).backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
       });assert.ok(contrast>=4.5,theme+' '+tier+' contrast '+contrast);
     }
     assert.ok(new Set(colors).size>=7);await page.keyboard.press('Escape');
   }
   assert.equal(await snapshot(),financial);
 });
 await test('dark safety: zero V2 calls, PushSubscriptions, sender calls or external requests',async()=>{
   const calls=await page.evaluate(()=>__dark);assert.equal(calls.v2,0);assert.equal(calls.subscribe,0);assert.equal(calls.sender,0);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
 });
 console.log(`PASS: ${passed} Phase 2C notification UI browser checks`);
 await context.close();
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));});
