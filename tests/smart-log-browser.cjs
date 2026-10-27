/* Actual manual/Smart Log write-path parity on an isolated synthetic origin.
   No live config, auth, network, or database writes. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
if(!process.env.CAP_PLAYWRIGHT_PATH){console.log('SKIP Smart Log browser: set CAP_PLAYWRIGHT_PATH');process.exit(0)}
const {chromium}=require(process.env.CAP_PLAYWRIGHT_PATH),root=path.resolve(__dirname,'..');
let browser,server,passed=0;
async function test(name,fn){await fn();console.log('PASS '+name);passed++}
(async()=>{
 server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://fixture.invalid');
  if(['/supabase-config.js','/supabase-config.local.js'].includes(u.pathname)){res.setHeader('Content-Type','text/javascript');return res.end('window.CAP_SUPABASE_CONFIG={};')}
  const f=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));
  if(!f.startsWith(root+path.sep)){res.writeHead(403);return res.end()}
  fs.readFile(f,(err,b)=>{res.writeHead(err?404:200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'})[path.extname(f)]||'application/octet-stream','Cache-Control':'no-store'});res.end(err?'Missing':b)});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:390,height:844}});
 const external=[],errors=[];await context.route('**/*',r=>{if(new URL(r.request().url()).origin!==origin){external.push(r.request().url());return r.abort()}r.continue()});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 await page.waitForFunction(()=>window.CapCommandBar&&window.CapSmartLogParser&&!window.capLaunchActive);
 await page.evaluate(()=>{localStorage.setItem('cap_whats_new_seen_version',APP_VERSION);if(document.querySelector('.whats-new-overlay'))closeWhatsNew();document.querySelector('#cap-auth')?.remove()});await page.waitForTimeout(600);
 async function reset(){
  await page.evaluate(async()=>{await CapCommandBar.close();closeS()});await page.waitForTimeout(350);
  await page.evaluate(()=>{
   S.accts=[{id:1,name:'BDO Debit',bank:'BDO',type:'debit',img:'cash',bal:10000,g:['#123456','#234567']},{id:2,name:'Maya Wallet',bank:'Maya',type:'ewallet',bal:1000,g:['#123456','#234567']},{id:3,name:'MariBank Savings',bank:'MariBank',type:'debit',bal:5000,g:['#123456','#234567']},{id:4,name:'Maya Black Visa',bank:'Maya',type:'credit',l4:'4321',bal:0,lim:20000,stmt:24,due:13,g:['#123456','#234567']}];
   S.tx=[];S.pend=[];S.xfer=[];S.bills=[];S.goals=[];S.debts=[];S.cats=['Food','Groceries','Salary','Transport','Shopping','Entertainment','Other'].map((n,i)=>({id:i+1,n,i:'•'}));tab='Home';render();
   const originalSave=window.__originalSaveTx||window.saveTx;window.__originalSaveTx=originalSave;window.__saveCalls=0;window.saveTx=function(){window.__saveCalls++;return originalSave.apply(this,arguments)};
   const originalTransfer=window.__originalTransfer||window.accountTransferCommit;window.__originalTransfer=originalTransfer;window.__transferCalls=0;window.accountTransferCommit=function(){window.__transferCalls++;return originalTransfer.apply(this,arguments)};
  });await page.waitForTimeout(300);
 }
 const input=page.locator('#cap-command-input'),preview=page.locator('.sl-preview');
 const snap=()=>page.evaluate(async()=>JSON.stringify({S,sync:await CapOff.productionSyncSnapshot(),hold:localStorage.getItem(CapProductionSync.recoveryKey)}));
 const selectMode=async mode=>{await page.locator('.cb-mode').click();await page.getByRole('menuitemradio',{name:mode,exact:true}).click()};
 const chooseAccount=async(key,id)=>{
  await page.locator('#sl-'+key+' + .ps-btn').click();const name=await page.evaluate(id=>S.accts.find(a=>a.id===id).name,+id);
  await page.locator('.ps-pop[data-command-owner="cap-command-bar"]:not(.out)').getByRole('option',{name,exact:true}).click();
 };
 async function command(text,edit=true){await page.evaluate(()=>CapCommandBar.open());await page.waitForFunction(()=>CapCommandBar.getState().state==='open');await selectMode('Log');await input.fill(text);await input.press('Enter');await preview.waitFor({state:'visible'});if(edit&&await page.locator('.sl-summary').count())await page.getByRole('button',{name:'Edit Transaction',exact:true}).click()}
 const normalize=()=>page.evaluate(()=>({tx:S.tx.map(({id,ts,tm,_u,...t})=>t),pend:S.pend.map(({id,ts,tm,_u,...t})=>t),xfer:S.xfer.map(({id,ts,tm,_u,...t})=>t),balances:S.accts.map(a=>[a.id,a.bal])}));
 await reset();
 await test('valid Smart Log opens a read-only receipt with the exact original sentence and no editable controls',async()=>{
  const before=await snap(),sentence='Spent ₱450 at Jollibee using BDO yesterday';await command(sentence,false);
  assert.equal(await snap(),before);assert.equal(await page.evaluate(()=>window.__saveCalls),0);
  assert.equal(await page.locator('.sl-preview input,.sl-preview select,.sl-preview textarea').count(),0,'initial preview has no editable controls');
  assert.equal(await page.locator('[data-sl-pick]').count(),0);assert.equal(await page.locator('.sl-preview .ps-chev').count(),0);
  assert.equal(await page.locator('.sl-origin blockquote').innerText(),'“'+sentence+'”');
  assert.equal(await page.locator('.sl-merchant').innerText(),'Jollibee');assert.equal(await page.locator('.sl-amount').innerText(),'₱450.00');
  assert.equal(await page.locator('.sl-detail-type b').innerText(),'Expense');assert.equal(await page.locator('.sl-detail-category b').innerText(),'Food');
  assert.equal(await page.locator('.sl-brand-logo img').count(),1);assert.match(await page.locator('.sl-brand-logo img').getAttribute('src'),/media-784db5476c1a\.webp/);
  assert.equal(await page.locator('.sl-account-art .cc').count(),1);assert.match(await page.locator('.sl-account-meta').innerText(),/BDO Debit/);
  assert.equal(await page.locator('.sl-account button,.sl-account select,.sl-account input').count(),0,'receipt account is non-interactive');
  assert.match(await page.locator('.sl-when').innerText(),/Yesterday · [A-Z][a-z]+ \d{1,2}, \d{4}$/);assert.doesNotMatch(await page.locator('.sl-when').innerText(),/\d{1,2}:\d{2} (AM|PM)/);
  assert.match(await page.locator('.sl-detail-datetime').innerText(),/Date & Time\s+[A-Z][a-z]{2} \d{1,2}, \d{4} · \d{1,2}:\d{2} (AM|PM)/);
  assert.equal(await page.getByRole('button',{name:'Edit Transaction',exact:true}).count(),1);
  assert.match(await page.locator('.sl-confirm').innerText(),/Log ₱450\.00/);
 });
 await test('only explicit final confirmation calls original saveTx exactly once and clears the command',async()=>{
  await command('Spent ₱450 at Jollibee using BDO yesterday',false);await page.locator('.sl-confirm').click();await page.waitForFunction(()=>S.tx.length===1);
  assert.equal(await page.evaluate(()=>window.__saveCalls),1);assert.equal(await page.evaluate(()=>S.tx[0].amt),-450);assert.equal(await page.evaluate(()=>S.accts[0].bal),9550);
  assert.equal(await input.inputValue(),'');assert.equal(await preview.isVisible(),false);
 });
 await test('Edit Transaction opens the editor and Done Editing returns to an updated preview without saving',async()=>{
  await reset();await command('Jollibee 450 BDO',false);const before=await snap();
  await page.getByRole('button',{name:'Edit Transaction',exact:true}).click();
  assert.ok(await page.locator('.sl-preview input,.sl-preview select').count()>0);assert.equal(await page.locator('.sl-confirm').count(),0);
  assert.equal(await page.getByRole('button',{name:'Done Editing',exact:true}).count(),1);
  await page.locator('#sl-title').fill('Jollibee Ortigas');await page.locator('#sl-amount').fill('475');
  assert.equal(await snap(),before);assert.equal(await page.evaluate(()=>window.__saveCalls),0);
  await page.getByRole('button',{name:'Done Editing',exact:true}).click();
  assert.equal(await page.locator('.sl-preview input,.sl-preview select').count(),0);assert.equal(await page.locator('.sl-merchant').innerText(),'Jollibee Ortigas');
  assert.match(await page.locator('.sl-amount').innerText(),/₱475\.00/);assert.equal(await snap(),before);
  await page.locator('.sl-confirm').click();await page.waitForFunction(()=>S.tx.length===1);assert.equal(await page.evaluate(()=>S.tx[0].note),'Jollibee Ortigas');
 });
 await test('incomplete input stays a compact read-only preview with restrained missing fields',async()=>{
  await reset();await page.setViewportSize({width:390,height:844});await command('k',false);
  assert.equal(await page.locator('.sl-preview input,.sl-preview select').count(),0,'no editor is opened automatically');
  assert.equal(await page.locator('.sl-origin blockquote').innerText(),'“k”');
  assert.equal(await page.getByRole('button',{name:'Edit Transaction',exact:true}).count(),1);assert.equal(await page.locator('.sl-confirm').count(),0);
  assert.match(await page.locator('.sl-message').innerText(),/I need a little more information to log this\./);
  assert.deepEqual(await page.locator('.sl-missing li').allInnerTexts(),['Transaction Type','Amount','Account','Category']);
  assert.equal(await page.evaluate(()=>window.__saveCalls),0);
  await page.getByRole('button',{name:'Edit Transaction',exact:true}).click();assert.ok(await page.locator('.sl-preview input,.sl-preview select').count()>0);
 });
 await test('expense, income and transfer read-only previews use distinct, clear presentations',async()=>{
  await reset();await command('Spent 450 at Jollibee using BDO yesterday',false);
  assert.match(await page.locator('.sl-when').innerText(),/^Yesterday · [A-Z][a-z]+ \d{1,2}, \d{4}$/);
  assert.match(await page.locator('.sl-detail-datetime').innerText(),/Date & Time\s+[A-Z][a-z]{2} \d{1,2}, \d{4} · \d{1,2}:\d{2} (AM|PM)/);
  assert.equal(await page.locator('.sl-detail-description').count(),0,'empty description is omitted');
  await reset();await command('Salary 8000 to MariBank',false);
  assert.equal(await page.locator('.sl-amount').innerText(),'+₱8,000.00');assert.match(await page.locator('.sl-detail-type').innerText(),/Income/);
  assert.equal(await page.locator('.sl-detail-block .sl-info-label').first().innerText(),'Deposited To');assert.match(await page.locator('.sl-account-meta').innerText(),/MariBank Savings/);
  await reset();await command('Transfer 2000 from BDO to Maya Wallet',false);
  assert.equal(await page.locator('.sl-merchant').innerText(),'Transfer');assert.equal(await page.locator('.sl-amount').innerText(),'₱2,000.00');
  assert.deepEqual(await page.locator('.sl-route .sl-info-label').allInnerTexts(),['From','To']);
  assert.deepEqual(await page.locator('.sl-route .sl-account-meta b').allInnerTexts(),['BDO Debit','Maya Wallet']);
  assert.equal(await page.locator('.sl-route .ps-mini .cc').count(),2);assert.match(await page.locator('.sl-confirm').innerText(),/Transfer ₱2,000\.00/);
 });
 await test('merchant-aware category inference appears in the read-only preview and editor',async()=>{
  await reset();const before=await snap();await command('Spotify Premium 115 BDO',false);
  assert.equal(await page.locator('.sl-merchant').innerText(),'Spotify Premium');assert.equal(await page.locator('.sl-detail-type b').innerText(),'Expense');assert.equal(await page.locator('.sl-detail-category b').innerText(),'Entertainment');
  assert.equal(await page.locator('.sl-brand-logo svg').count(),1,'Spotify uses Cap inline brand artwork');
  assert.equal(await page.locator('.sl-brand-logo svg').getAttribute('class'),'bl bb');
  assert.equal(await page.locator('.sl-preview input,.sl-preview select').count(),0);assert.equal(await page.locator('.sl-confirm').isDisabled(),false);assert.equal(await snap(),before);
  await page.getByRole('button',{name:'Edit Transaction',exact:true}).click();
  assert.equal(await page.locator('#sl-category').inputValue(),'Entertainment');assert.equal(await page.evaluate(()=>window.__saveCalls),0);
  await page.getByRole('button',{name:'Done Editing',exact:true}).click();assert.equal(await page.locator('.sl-detail-type b').innerText(),'Expense');assert.equal(await page.locator('.sl-detail-category b').innerText(),'Entertainment');assert.equal(await snap(),before);
 });
 for(const [type,sentence,sign,cat] of [['expense','Jollibee 450 BDO',-1,'Food'],['income','Salary 8000 to MariBank',1,'Salary']])await test(type+': Smart Log and manual New Entry converge on identical saveTx records and balances',async()=>{
  await reset();const amount=type==='income'?8000:450,acct=type==='income'?3:1,title=type==='income'?'Salary':'Jollibee';
  await page.evaluate(({amount,acct,title,sign,cat})=>{openTx();for(const [id,v] of Object.entries({am:amount,ty:sign,ac:acct,ct:cat,dt:CapSmartLogParser.localDate(new Date()),nt:title,ds:''})){const e=document.getElementById(id);e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}))}saveTx()}, {amount,acct,title,sign,cat});
  const manual=await normalize();await reset();await command(sentence,false);await page.locator('.sl-confirm').click();await page.waitForFunction(()=>S.tx.length===1);assert.deepEqual(await normalize(),manual);assert.equal(await page.evaluate(()=>window.__saveCalls),1);
 });
 await test('transfer uses actual accountTransferCommit with identical records and no generic transaction',async()=>{
  await reset();await page.evaluate(()=>{accountTransferSheet(1);document.getElementById('account-transfer-to').value=2;document.getElementById('account-transfer-amount').value=2000;document.getElementById('account-transfer-note').value='Account Transfer';accountTransferCommit(1)});
  const manual=await normalize();await reset();await command('Transfer 2000 from BDO to Maya Wallet',false);await page.locator('.sl-confirm').click();await page.waitForFunction(()=>S.xfer.length===1);
  assert.deepEqual(await normalize(),manual);assert.equal(await page.evaluate(()=>window.__transferCalls),1);assert.equal(await page.evaluate(()=>S.tx.length),0);
  assert.match(await page.evaluate(()=>S.xfer[0].tm),/^\d{2}:\d{2}$/);
 });
 await test('manual deposit form records its editable time through the existing ledger path',async()=>{
  await reset();
  await page.evaluate(()=>{depositSheet(1);document.getElementById('account-deposit-from').value='0';document.getElementById('account-deposit-amount').value=100;document.getElementById('account-deposit-time').value='08:15';depositCommit(1)});
  assert.equal(await page.evaluate(()=>S.tx.length),1);assert.equal(await page.evaluate(()=>S.tx[0].tm),'08:15');assert.equal(await page.evaluate(()=>S.accts[0].bal),10100);
 });
 await test('required ambiguous/missing fields disable confirmation until explicitly corrected',async()=>{
  await reset();const before=await snap();await command('450 yesterday');
  assert.equal(await page.locator('.sl-confirm').count(),0,'editor never exposes the final write action');
  assert.equal(await page.locator('.sl-actions [data-sl-action="edit"]').innerText(),'Done Editing');
  await page.locator('#sl-type').selectOption('expense');await page.locator('#sl-title').fill('Lunch');await page.locator('#sl-category').selectOption('Food');await chooseAccount('account',1);
  assert.equal(await page.locator('.sl-confirm').count(),0,'editor never exposes the final write action');
  await page.getByRole('button',{name:'Done Editing',exact:true}).click();assert.equal(await page.locator('.sl-confirm').isDisabled(),false);assert.equal(await snap(),before);
  await input.fill('Groceries 450 Maya');await input.press('Enter');assert.equal(await preview.isVisible(),true);assert.equal(await page.locator('[data-sl-pick]').count(),0);
  assert.match(await page.locator('.sl-account-meta').innerText(),/Needs Review/);assert.match(await page.locator('.sl-account-meta').innerText(),/Maya/);
  assert.equal(await page.locator('.sl-confirm').isDisabled(),true);
  await page.getByRole('button',{name:'Edit Transaction',exact:true}).click();
  assert.equal(await page.locator('#sl-account').inputValue(),'');assert.match(await page.locator('#sl-account + .ps-btn').innerText(),/Maya/);
  assert.equal(await page.locator('#sl-account + .ps-btn .ps-mini .cc').count(),1,'ambiguous candidate is previewed safely');
  await chooseAccount('account',2);await page.getByRole('button',{name:'Done Editing',exact:true}).click();assert.equal(await page.locator('.sl-confirm').isDisabled(),false);
 });
 await test('multiple amount choices, every editable field, and invalid decimals remain review-only',async()=>{
  await reset();await command('Spent 450 500 at Jollibee using BDO');
  assert.equal(await page.locator('.sl-confirm').count(),0,'no Log action while editing');
  await page.locator('[data-sl-amount-choice]').selectOption('500');await page.locator('#sl-title').fill('Edited Lunch');await page.locator('#sl-description').fill('Team lunch');await page.locator('#sl-date').fill('2026-10-20');await chooseAccount('account',3);
  await page.locator('#sl-amount').fill('500.999');await page.getByRole('button',{name:'Done Editing',exact:true}).click();assert.equal(await page.locator('.sl-confirm').isDisabled(),true);
  await page.getByRole('button',{name:'Edit Transaction',exact:true}).click();await page.locator('#sl-amount').fill('500.50');
  await page.getByRole('button',{name:'Done Editing',exact:true}).click();assert.equal(await page.locator('.sl-confirm').isDisabled(),false);
  await page.locator('.sl-confirm').click();await page.waitForFunction(()=>S.tx.length===1);
  assert.deepEqual(await page.evaluate(()=>({note:S.tx[0].note,desc:S.tx[0].desc,d:S.tx[0].d,amt:S.tx[0].amt,acct:S.tx[0].acct})),{note:'Edited Lunch',desc:'Team lunch',d:'2026-10-20',amt:-500.5,acct:3});
 });
 await test('read-only preview is a spacious outlined receipt card with no manual-entry link',async()=>{
  await reset();const before=await snap();await command('Spotify Premium 115 BDO',false);
  assert.equal(await page.locator('.sl-ticket').count(),1,'transaction details are grouped in one inner receipt card');
  for(const sel of ['.sl-hero','.sl-detail-type','.sl-detail-category','.sl-detail-block','.sl-detail-datetime'])assert.equal(await page.locator('.sl-ticket '+sel).count(),1,sel+' sits inside the receipt card');
  assert.equal(await page.locator('.sl-ticket .sl-origin').count(),0,'logged-from stays outside the receipt card');
  assert.equal(await page.locator('.sl-ticket .sl-actions').count(),0,'actions stay outside the receipt card');
  assert.equal(await page.locator('.sl-receipt .sl-origin').count(),1);assert.equal(await page.locator('.sl-receipt .sl-brand-logo').count(),1);
  assert.equal(await page.locator('.sl-receipt .sl-merchant').innerText(),'Spotify Premium');assert.equal(await page.locator('.sl-detail-type b').innerText(),'Expense');assert.equal(await page.locator('.sl-detail-category b').innerText(),'Entertainment');
  assert.match(await page.locator('.sl-receipt .sl-when').innerText(),/[A-Z][a-z]+ \d{1,2}, \d{4}$/);assert.doesNotMatch(await page.locator('.sl-receipt .sl-when').innerText(),/\d{1,2}:\d{2} (AM|PM)/);
  assert.match(await page.locator('.sl-detail-datetime').innerText(),/Date & Time\s+[A-Z][a-z]{2} \d{1,2}, \d{4} · \d{1,2}:\d{2} (AM|PM)/);
  assert.equal(await page.locator('.sl-ticket > .sl-heading').count(),1,'preview title sits inside the receipt card');
  assert.equal(await page.locator('.sl-ticket-head h3').innerText(),'Transaction Preview');
  const headBox=await page.locator('.sl-ticket-head h3').boundingBox(),ticketBox=await page.locator('.sl-ticket').boundingBox();
  assert.ok(headBox.x>ticketBox.x&&headBox.y>ticketBox.y&&headBox.y-ticketBox.y<40,'preview title sits at the upper left of the receipt card');
  assert.equal(await page.locator('.sl-heading [data-sl-action]').count(),0,'preview heading has no dismiss button');assert.equal(await page.locator('.sl-heading button').count(),0);
  const receiptStyle=await page.locator('.sl-receipt').evaluate(e=>{const s=getComputedStyle(e);return{border:s.borderTopWidth,display:s.display,gap:parseFloat(s.rowGap)}});
  assert.equal(receiptStyle.border,'0px','receipt wrapper stays open inside the outlined preview card');assert.equal(receiptStyle.display,'grid');assert.ok(receiptStyle.gap>=14,'major groups have breathing room');
  const ticketStyle=await page.locator('.sl-ticket').evaluate(e=>{const s=getComputedStyle(e);return{border:s.borderTopWidth,borderColor:s.borderTopColor,radius:parseFloat(s.borderTopLeftRadius),padding:parseFloat(s.paddingTop),display:s.display,overflow:s.overflow}});
  assert.equal(ticketStyle.border,'1px','inner receipt card has a subtle outline');assert.notEqual(ticketStyle.borderColor,'rgba(0, 0, 0, 0)');
  assert.ok(ticketStyle.radius>=16,'inner receipt card has rounded corners');assert.ok(ticketStyle.padding>=15,'inner receipt card has generous padding');
  assert.equal(ticketStyle.display,'grid');assert.match(ticketStyle.overflow,/hidden/,'artwork stays clipped inside the receipt card');
  const card=await page.locator('.sl-preview').evaluate(e=>{const s=getComputedStyle(e);return{border:s.borderTopWidth,borderColor:s.borderTopColor,image:s.backgroundImage}});
  assert.equal(card.border,'1px','preview is an outlined card');assert.notEqual(card.borderColor,'rgba(0, 0, 0, 0)');assert.equal(card.image,'none','grid is localized, not painted over the whole card');
  const grid=page.locator('.sl-grid'),gridStyle=await grid.evaluate(e=>{const s=getComputedStyle(e);return{image:s.backgroundImage,size:s.backgroundSize,mask:s.maskImage,pointer:s.pointerEvents}});
  assert.equal(await grid.count(),1);assert.equal(await grid.getAttribute('aria-hidden'),'true');assert.match(gridStyle.image,/linear-gradient/);assert.match(gridStyle.size,/22px/);assert.match(gridStyle.mask,/radial-gradient/);assert.equal(gridStyle.pointer,'none');
  const receiptBox=await page.locator('.sl-ticket').boundingBox(),gridBox=await grid.boundingBox();
  assert.ok(gridBox.x+gridBox.width>receiptBox.x+receiptBox.width-20&&gridBox.y<receiptBox.y+receiptBox.height/2,'grid sits in the upper right');assert.ok(gridBox.width<receiptBox.width&&gridBox.height<receiptBox.height,'grid fades out before covering the card');
  assert.equal(await page.locator('.sl-receipt').getAttribute('data-sl-type'),'expense');
  const hero=await page.locator('.sl-hero').boundingBox(),amount=await page.locator('.sl-amount').boundingBox(),identity=await page.locator('.sl-identity').boundingBox();
  assert.ok(amount.y>=hero.y&&amount.y+amount.height<=hero.y+hero.height,'amount sits in the receipt hero');
  assert.ok(identity.x>=amount.x+amount.width,'merchant identity is on the right side');
  assert.ok(Math.abs(identity.x+identity.width-(hero.x+hero.width))<2,'merchant identity is right-aligned');
  const brand=await page.locator('.sl-brand').boundingBox(),merchant=await page.locator('.sl-merchant').boundingBox();
  assert.ok(Math.abs((brand.x+brand.width/2)-(merchant.x+merchant.width/2))<2,'logo is centered over the title');
  assert.equal(await page.locator('.sl-merchant').evaluate(e=>getComputedStyle(e).textAlign),'right','merchant text stays right-aligned');
  const when=await page.locator('.sl-when').boundingBox();
  const titleLift=(when.y+when.height)-(merchant.y+merchant.height);
  assert.ok(titleLift>=7&&titleLift<=14,'merchant title sits a little higher than the date line');
  assert.equal(await page.locator('.sl-meta').count(),0,'type and category moved out of the upper-right identity');
  const typeRow=await page.locator('.sl-detail-type').boundingBox(),categoryRow=await page.locator('.sl-detail-category').boundingBox(),accountRow=await page.locator('.sl-detail-block').boundingBox(),dtRow=await page.locator('.sl-detail-datetime').boundingBox();
  assert.ok(typeRow.y<categoryRow.y&&categoryRow.y<accountRow.y&&accountRow.y<dtRow.y,'details read Type, Category, Paid With, Date & Time');
  const rowLines=await page.evaluate(()=>['.sl-detail-type','.sl-detail-category','.sl-detail-block','.sl-detail-datetime'].map(s=>{const e=document.querySelector(s);return e&&getComputedStyle(e).borderTopWidth}));
  assert.deepEqual(rowLines,['0px','1px','1px','1px'],'receipt lines separate each detail row');
  assert.equal(await page.locator('.sl-ticket .sl-divider').count(),0,'no divider separates the date hero from Type');
  const cardBox=await page.locator('.sl-preview').boundingBox();assert.ok(brand.y-cardBox.y>=16,'logo has breathing room from the card edge');
  assert.equal(await page.locator('.sl-amount').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))>=34,true,'amount is visually prominent');
  const accent=await page.locator('.sl-amount').evaluate(e=>getComputedStyle(e).color);
  assert.equal(await page.locator('.sl-type-value').evaluate(e=>getComputedStyle(e).color),accent,'type value keeps the semantic accent');
  assert.equal(await page.locator('.sl-foil').count(),1);assert.equal(await page.locator('.sl-foil').getAttribute('aria-hidden'),'true');
  assert.equal(await page.locator('.sl-foil').evaluate(e=>getComputedStyle(e).pointerEvents),'none');
  assert.equal(await page.locator('.sl-manual-link,[data-sl-action="manual"]').count(),0);
  assert.equal(await page.getByRole('button',{name:'Open Manual Entry',exact:true}).count(),0);
  assert.equal(await page.locator('.sl-preview input,.sl-preview select,.sl-preview textarea').count(),0);assert.equal(await snap(),before);
 });
 await test('unknown merchants and broken local artwork fall back safely without inventing a logo',async()=>{
  await reset();await command('Zzyzx Nook 275 BDO',false);
  assert.equal(await page.locator('.sl-brand-logo').count(),0,'unknown merchant gets no brand logo');
  assert.equal(await page.locator('.sl-brand-generic svg').count(),1,'clean receipt glyph fallback');
  await reset();await command('Zzyzx coffee 275 BDO',false);
  assert.equal(await page.locator('.sl-brand-logo').count(),0,'unknown merchant still gets no invented logo');
  assert.equal(await page.locator('.sl-brand-category').count(),1,'known category provides the fallback icon');
  await reset();await command('Jollibee 450 BDO',false);assert.equal(await page.locator('.sl-brand-logo img').count(),1);
  await page.locator('.sl-brand-logo img').evaluate(e=>e.dispatchEvent(new Event('error',{bubbles:true})));
  assert.equal(await page.locator('.sl-brand-logo img').count(),0,'broken image removed');
  assert.equal(await page.locator('.sl-brand-generic svg').count(),1,'receipt glyph fallback replaces it');
  assert.equal(await page.evaluate(()=>window.__saveCalls),0);
 });
 await test('expense, income and transfer receipts keep distinct artwork and non-interactive accounts across themes',async()=>{
  await reset();await page.setViewportSize({width:390,height:844});
  for(const theme of ['light','dark','apple']){
   await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
   await command('Spent 450 at Jollibee using BDO',false);
   assert.equal(await page.locator('.sl-account .sl-account-art .cc').count(),1);
   assert.equal(await page.locator('.sl-account button,.sl-account select,.sl-account input,.sl-account [role="button"]').count(),0);
   const contrast=await page.locator('.sl-amount').evaluate(e=>getComputedStyle(e).color);assert.notEqual(contrast,'rgba(0, 0, 0, 0)');
   await reset();
  }
  await page.evaluate(()=>document.documentElement.removeAttribute('data-theme'));
  await reset();await command('Spent 450 at Jollibee using BDO',false);
  assert.equal(await page.locator('.sl-receipt').getAttribute('data-sl-type'),'expense');const expense=await page.locator('.sl-amount').evaluate(e=>getComputedStyle(e).color);
  assert.equal(await page.locator('.sl-type-value').evaluate(e=>getComputedStyle(e).color),expense,'expense type value is color-coded');
  const accountRight=await page.locator('.sl-account-meta').evaluate(e=>e.getBoundingClientRect().right),ticketRight=await page.locator('.sl-ticket').evaluate(e=>{const s=getComputedStyle(e);return e.getBoundingClientRect().right-parseFloat(s.paddingRight)-parseFloat(s.borderRightWidth)});
  assert.ok(Math.abs(ticketRight-accountRight)<2,'payment account value is right-aligned to the receipt content edge');
  await reset();await command('Salary 8000 to MariBank',false);
  assert.equal(await page.locator('.sl-receipt').getAttribute('data-sl-type'),'income');const income=await page.locator('.sl-amount').evaluate(e=>getComputedStyle(e).color);
  assert.notEqual(income,expense,'income and expense use different semantic accents');
  assert.equal(await page.locator('.sl-type-value').evaluate(e=>getComputedStyle(e).color),income,'income type value is color-coded');
  assert.equal(await page.locator('.sl-account .sl-account-art .cc').count(),1);
  await reset();await command('Transfer 2000 from BDO to Maya Wallet',false);
  assert.equal(await page.locator('.sl-receipt').getAttribute('data-sl-type'),'transfer');const transfer=await page.locator('.sl-amount').evaluate(e=>getComputedStyle(e).color);
  assert.ok(![expense,income].includes(transfer),'transfer uses its own semantic accent');
  assert.equal(await page.locator('.sl-type-value').evaluate(e=>getComputedStyle(e).color),transfer,'transfer type value is color-coded');
  assert.equal(await page.locator('.sl-detail-category').count(),0,'transfers omit a category row');
  assert.equal(await page.locator('.sl-route .sl-account-art .cc').count(),2);assert.equal(await page.locator('.sl-brand').count(),0,'transfers use account artwork instead of a fake merchant logo');
  const transferDate=await page.locator('.sl-when').boundingBox(),transferTitle=await page.locator('.sl-merchant').boundingBox();
  const transferLift=(transferDate.y+transferDate.height)-(transferTitle.y+transferTitle.height);
  assert.ok(transferLift>=7&&transferLift<=14,'transfer title sits a little higher than the date line');
 });
  await test('conflicting explicit times show Time Needs Review and reject forced stale confirmation with zero writes',async()=>{
   await reset();const before=await snap();await command('Jollibee 450 BDO at 2 PM at 4 PM',false);
   assert.match(await page.locator('.sl-detail-datetime').innerText(),/Time · Needs Review/);
   assert.ok((await page.locator('.sl-missing li').allInnerTexts()).includes('Time'));
   assert.equal(await page.locator('.sl-confirm').isDisabled(),true);
   await page.locator('.sl-confirm').evaluate(e=>{e.disabled=false;e.click()});
   assert.equal(await page.locator('.sl-confirm').isDisabled(),true);
   assert.equal(await page.evaluate(()=>window.__saveCalls),0);assert.equal(await page.evaluate(()=>window.__transferCalls),0);
   assert.equal(await snap(),before,'transactions, balances, outbox, baseline and recovery state unchanged');
   await page.getByRole('button',{name:'Edit Transaction',exact:true}).click();
   assert.equal(await page.locator('#sl-time').getAttribute('aria-invalid'),'true');
   assert.match(await page.locator('#sl-time').locator('..').innerText(),/Time needs confirmation/);
   await page.locator('#sl-time').dispatchEvent('input');
   await page.getByRole('button',{name:'Done Editing',exact:true}).click();
   assert.match(await page.locator('.sl-detail-datetime').innerText(),/Time · Needs Review/);
   assert.equal(await page.locator('.sl-confirm').isDisabled(),true);assert.equal(await snap(),before);
  });
  await test('Edit resolves conflicting time; mandatory read-only preview returns before final confirmation',async()=>{
   await reset();const before=await snap();await command('Jollibee 450 BDO at 2:00 PM at 4:00 PM',false);
   await page.getByRole('button',{name:'Edit Transaction',exact:true}).click();await page.locator('#sl-time').fill('16:00');
   assert.equal(await page.locator('#sl-time').getAttribute('aria-invalid'),'false');
   await page.locator('#sl-time').press('Enter');assert.equal(await snap(),before);
   await preview.evaluate(p=>{const b=document.createElement('button');b.dataset.slAction='confirm';p.appendChild(b);b.click();b.remove()});
   assert.equal(await page.evaluate(()=>window.__saveCalls),0,'injected confirmation cannot bypass editor review');assert.equal(await snap(),before);
   await page.getByRole('button',{name:'Done Editing',exact:true}).click();
   assert.equal(await page.locator('.sl-preview input,.sl-preview select').count(),0);
   assert.match(await page.locator('.sl-detail-datetime').innerText(),/4:00 PM/);
   assert.doesNotMatch(await preview.innerText(),/Needs Review/);assert.equal(await page.locator('.sl-confirm').isDisabled(),false);
   assert.equal(await snap(),before,'resolving and reviewing never saves');assert.equal(await page.evaluate(()=>window.__saveCalls),0);
  });
  await test('default local time and one explicit time remain confirmable without Enter writing',async()=>{
   await reset();const before=await snap();await command('Jollibee 450 BDO',false);
   assert.match(await page.locator('.sl-detail-datetime').innerText(),/\d{1,2}:\d{2} (AM|PM)/);assert.equal(await page.locator('.sl-confirm').isDisabled(),false);
   await input.fill('Jollibee 450 BDO at 2 PM');await input.press('Enter');await preview.waitFor({state:'visible'});
   assert.match(await page.locator('.sl-detail-datetime').innerText(),/2:00 PM/);assert.equal(await page.locator('.sl-confirm').isDisabled(),false);
   assert.equal(await snap(),before);assert.equal(await page.evaluate(()=>window.__saveCalls),0);
  });
  await test('editable time reaches the read-only preview, existing saveTx, details and the manual form',async()=>{
  await reset();await command('Jollibee 450 BDO',false);assert.match(await page.locator('.sl-detail-datetime').innerText(),/\d{1,2}:\d{2} (AM|PM)/);assert.doesNotMatch(await page.locator('.sl-when').innerText(),/\d{1,2}:\d{2} (AM|PM)/);
  await page.getByRole('button',{name:'Edit Transaction',exact:true}).click();assert.equal(await page.locator('#sl-time').inputValue(),await page.evaluate(()=>CapSmartLogParser.localTime(new Date())));
  await page.locator('#sl-time').fill('19:30');await page.getByRole('button',{name:'Done Editing',exact:true}).click();
  assert.match(await page.locator('.sl-detail-datetime').innerText(),/7:30 PM/);assert.equal(await page.evaluate(()=>S.tx.length),0);await page.locator('.sl-confirm').click();await page.waitForFunction(()=>S.tx.length===1);
  assert.equal(await page.evaluate(()=>S.tx[0].tm),'19:30');
  await page.evaluate(()=>closeS());await page.waitForTimeout(260);await page.evaluate(()=>txDetail(S.tx[0].id));assert.match(await page.locator('#sb').innerText(),/Time\s+7:30 PM/);
  await page.evaluate(()=>{closeS();openTx(S.tx[0].id)});assert.equal(await page.locator('#tt').inputValue(),'19:30');
  await page.locator('#tt').fill('06:05');await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>S.tx[0].tm==='06:05');
  assert.equal(await page.evaluate(()=>S.tx[0].tm),'06:05');
 });
 await test('goal allocation warnings still require the existing extra confirmation and cancel writes nothing',async()=>{
  await reset();await page.evaluate(()=>{S.goals=[{id:7,name:'Protected',accountId:1,saved:9900,target:10000}]});
  await command('Jollibee 450 BDO',false);await page.locator('.sl-confirm').click();await page.waitForSelector('#cfm.open');assert.equal(await page.evaluate(()=>S.tx.length),0);
  await page.locator('#cfm-no').click();await page.waitForTimeout(220);assert.equal(await page.evaluate(()=>S.tx.length),0);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForFunction(()=>CapCommandBar.getState().state==='open');
  await page.locator('.sl-confirm').click();await page.waitForSelector('#cfm.open');await page.locator('#cfm-ok').click();await page.waitForFunction(()=>S.tx.length===1);assert.equal(await page.evaluate(()=>S.accts[0].bal),9550);
 });
 await test('insufficient transfer funds use existing validation and do not create a record',async()=>{
  await reset();await command('Transfer 20000 from BDO to Maya Wallet',false);await page.locator('.sl-confirm').click();await page.waitForSelector('#sheet.open #account-transfer-amount');assert.equal(await page.evaluate(()=>S.xfer.length),0);assert.equal(await page.evaluate(()=>S.accts[0].bal),10000);
 });
 await test('ordinary PHP card spending uses existing fee/posting pathway, not card payment accounting',async()=>{
  await reset();await command('Spent 450 at Jollibee using Maya Black',false);await page.locator('.sl-confirm').click();await page.waitForFunction(()=>S.tx.length===1);assert.equal(await page.evaluate(()=>S.tx[0].acct),4);assert.equal(await page.evaluate(()=>S.xfer.length),0);assert.equal(await page.evaluate(()=>S.tx[0].pd),await page.evaluate(()=>CapSmartLogParser.localDate(new Date())));
 });
 await test('questions and specialized operations never expose a generic final Log action',async()=>{
  await reset();const before=await snap();for(const sentence of ['How much did I spend on food this month?','Show food expenses','Pay 450 electric bill BDO','Transfer 2000 from BDO to Maya Black']){
   await command(sentence,false);assert.equal(await page.locator('.sl-confirm').count(),0);assert.equal(await snap(),before);
  }
 });
 await test('Search stays inactive and cannot call the Smart Log parser, even for a valid log sentence',async()=>{
  await reset();await command('How much did I spend?',false);await page.getByRole('button',{name:'Switch to Search',exact:true}).click();assert.equal(await preview.isVisible(),false);
  await input.fill('Jollibee 450 BDO');const before=await snap();await input.press('Enter');assert.equal(await preview.isVisible(),false);assert.equal(await snap(),before);assert.match(await page.locator('.cb-status').innerText(),/future phase/);
 });
 await test('microphone transcript only fills input; one shared parser runs only on explicit submit',async()=>{
  await reset();await page.evaluate(()=>{window.SpeechRecognition=class{constructor(){window.__speech=this}start(){}abort(){}}});
  await page.evaluate(()=>CapCommandBar.open());await page.waitForFunction(()=>CapCommandBar.getState().state==='open');await selectMode('Log');await input.fill('');
  const before=await snap();await page.getByRole('button',{name:'Start Voice Input',exact:true}).click();await page.evaluate(()=>window.__speech.onresult({results:[[{transcript:'Jollibee 450 BDO'}]]}));
  assert.equal(await preview.isVisible(),false);assert.equal(await snap(),before);await input.press('Enter');assert.equal(await preview.isVisible(),true);assert.equal(await snap(),before);assert.equal(await page.locator('.sl-merchant').innerText(),'Jollibee');
 });
 await test('changing sentence invalidates the preview, stale/double confirmation cannot create duplicates',async()=>{
  await reset();await command('Jollibee 450 BDO',false);await input.fill('Jollibee 500 BDO');assert.equal(await preview.isVisible(),false);assert.equal(await page.evaluate(()=>S.tx.length),0);
  await input.press('Enter');await page.locator('.sl-confirm').evaluate(e=>{e.click();e.click()});await page.waitForFunction(()=>S.tx.length===1);assert.equal(await page.evaluate(()=>S.tx[0].amt),-500);assert.equal(await page.evaluate(()=>window.__saveCalls),1);
 });
 await test('account picker reuses Cap card artwork/grid in the editor and Escape only closes the picker',async()=>{
  await reset();await command('Jollibee 450 BDO');const before=await snap();assert.equal(await page.locator('.sl-submit').count(),0);
  await page.locator('#sl-account + .ps-btn').click();const pop=page.locator('.ps-pop[data-command-owner="cap-command-bar"]:not(.out)');
  assert.equal(await pop.locator('.ps-copt .cc').count(),4);assert.equal(await pop.locator('[aria-selected="true"]').getAttribute('aria-label'),'BDO Debit');
  assert.equal(await pop.evaluate(e=>getComputedStyle(e).backdropFilter),'none');
  await page.keyboard.press('Escape');assert.equal(await preview.isVisible(),true);assert.equal(await page.locator('#sl-account + .ps-btn').getAttribute('aria-expanded'),'false');
  await chooseAccount('account',3);assert.equal(await page.locator('#sl-account').inputValue(),'3');assert.equal(await snap(),before);
  await page.locator('#sl-account + .ps-btn').click();await page.keyboard.press('Tab');assert.equal(await preview.isVisible(),true);assert.equal(await page.locator('#sl-account + .ps-btn').getAttribute('aria-expanded'),'false');
 });
 await test('live account/category removal is revalidated before confirmation, without attempting a save',async()=>{
  await reset();await command('Jollibee 450 BDO',false);await page.evaluate(()=>{S.accts=S.accts.filter(a=>a.id!==1)});await page.locator('.sl-confirm').click();
  assert.equal(await page.evaluate(()=>window.__saveCalls),0);assert.equal(await page.locator('.sl-confirm').isDisabled(),true);
  await reset();await command('Jollibee 450 BDO',false);await page.evaluate(()=>{S.cats=S.cats.filter(c=>c.n!=='Food')});await page.locator('.sl-confirm').click();
  assert.equal(await page.evaluate(()=>window.__saveCalls),0);assert.equal(await page.locator('.sl-confirm').isDisabled(),true);
 });
 await test('transfer source/destination edits validate distinct accounts and use the existing note field',async()=>{
  await reset();await command('Transfer 2000 from BDO to Maya Wallet');await chooseAccount('from',3);await chooseAccount('to',3);assert.equal(await page.locator('.sl-confirm').count(),0);
  await chooseAccount('to',2);await page.locator('#sl-title').fill('Family');await page.locator('#sl-description').fill('Weekly support');await page.locator('#sl-amount').fill('399.50');
  await page.getByRole('button',{name:'Done Editing',exact:true}).click();assert.equal(await page.locator('.sl-confirm').isDisabled(),false);await page.locator('.sl-confirm').click();await page.waitForFunction(()=>S.xfer.length===1);
  assert.deepEqual(await page.evaluate(()=>({from:S.xfer[0].from,to:S.xfer[0].to,amt:S.xfer[0].amt,note:S.xfer[0].note})),{from:3,to:2,amt:399.5,note:'Family · Weekly support'});
 });
 await test('loaded Smart Log works with the browser offline and reduced motion enabled',async()=>{
  await reset();await context.setOffline(true);await page.emulateMedia({reducedMotion:'reduce'});const before=await snap();
  await command('Jollibee 450 BDO',false);assert.equal(await snap(),before);assert.equal(await preview.evaluate(e=>getComputedStyle(e).animationName),'none');
  assert.equal(await preview.evaluate(e=>getComputedStyle(e).overflowY),'auto');
  await page.locator('.sl-confirm').click();await page.waitForFunction(()=>S.tx.length===1);await context.setOffline(false);await page.emulateMedia({reducedMotion:'no-preference'});
 });
 for(const width of [320,390,768,1440])await test(width+'px preview fits the viewport, stays compact and uses real card artwork',async()=>{
  await reset();await page.setViewportSize({width,height:844});await command('Jollibee 450 BDO',false);
  const rect=await preview.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=width&&rect.y>=0&&rect.y+rect.height<=844);
  assert.ok(await page.locator('.sl-account-art .cc').count(),'read-only preview shows card artwork');assert.equal(await page.locator('.sl-submit').count(),0);
  assert.equal(await page.locator('.sl-preview input,.sl-preview select').count(),0);
  const shots=path.join(process.env.LOCALAPPDATA||process.env.TEMP,'Temp','opencode','smart-log-review');fs.mkdirSync(shots,{recursive:true});await page.waitForTimeout(700);await page.screenshot({path:path.join(shots,'preview-'+width+'.png')});
  await page.getByRole('button',{name:'Edit Transaction',exact:true}).click();assert.equal(await preview.evaluate(e=>getComputedStyle(e).overflowY),'auto');
  if(width===390){await page.locator('#sl-account + .ps-btn').click();await page.waitForTimeout(200);await page.screenshot({path:path.join(shots,'account-picker.png')});await page.keyboard.press('Escape')}
 });
 await test('unresolved account preview exposes working card picker',async()=>{
  await reset();await page.setViewportSize({width:390,height:844});await command('Spotify Premium 115');
  assert.equal(await page.locator('#sl-account').evaluate(e=>e.type),'hidden');assert.equal(await page.locator('select#sl-account').count(),0);
  await page.locator('#sl-account + .ps-btn').click();
  const pop=page.locator('.ps-pop[data-command-owner="cap-command-bar"]:not(.out)');await pop.waitFor({state:'visible'});
  assert.ok(await pop.locator('.ps-copt .cc').count()>=4);assert.equal(await pop.getAttribute('role'),'listbox');
  assert.match(await page.locator('#sl-account + .ps-btn').innerText(),/BDO Debit/);assert.equal(await page.locator('#sl-account + .ps-btn .ps-mini .cc').count(),1,'preview card is shown as soon as the picker opens');
  await page.screenshot({path:path.join(process.env.LOCALAPPDATA||process.env.TEMP,'Temp','opencode','smart-log-review','unresolved-account.png')});
  await page.keyboard.press('Escape');assert.equal(await page.locator('#sl-account + .ps-btn').getAttribute('aria-expanded'),'false');assert.equal(await preview.isVisible(),true);
  assert.match(await page.locator('#sl-account + .ps-btn').innerText(),/Choose account/);
  await chooseAccount('account',1);assert.match(await page.locator('#sl-account + .ps-btn').innerText(),/BDO Debit/);assert.equal(await page.locator('#sl-account + .ps-btn .ps-mini .cc').count(),1);assert.equal(await page.locator('#sl-account').inputValue(),'1');
 });
 await test('software-keyboard visual viewport keeps both preview and bar visible with editable internal scrolling',async()=>{
  await reset();await page.setViewportSize({width:390,height:844});await command('Jollibee 450 BDO');
  await page.evaluate(()=>{window.__realVV=window.visualViewport;const v=new EventTarget();Object.assign(v,{width:390,height:320,offsetTop:0,offsetLeft:0});Object.defineProperty(window,'visualViewport',{configurable:true,value:v});window.dispatchEvent(new Event('resize'))});
  await page.waitForTimeout(100);const r=await preview.boundingBox(),b=await page.locator('#cap-command-bar').boundingBox();
  assert.ok(r.y>=0&&r.y+r.height<=b.y&&b.y+b.height<=320);assert.ok(await preview.evaluate(e=>e.scrollHeight>e.clientHeight));
  await page.locator('#sl-description').scrollIntoViewIfNeeded();await page.locator('#sl-description').fill('Keyboard-safe draft');
  await page.evaluate(()=>{Object.defineProperty(window,'visualViewport',{configurable:true,value:window.__realVV});window.dispatchEvent(new Event('resize'))});
 });
 await test('no runtime errors or external network requests',()=>{assert.deepEqual(errors,[]);assert.deepEqual(external,[])});
 await context.close();console.log(`PASS: ${passed} Smart Log browser/financial write-path checks`);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r))});
