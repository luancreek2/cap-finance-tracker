/* Plan › Upcoming presentation contracts. Static source checks plus a tiny VM
   run of the pure helpers. No browser, network, storage or financial writes. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const app=read('js/app.js'),cards=read('js/cards.js'),css=read('css/styles.css'),
  anim=read('css/animations.css'),sw=read('service-worker.js');
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name)}

const rows=cards.slice(cards.indexOf('function upcomingBillRow'),cards.indexOf('function cardStatementRow'));
const cardRow=cards.slice(cards.indexOf('function cardStatementRow'),cards.indexOf('function planOld'));
const billSheet=app.slice(app.indexOf('function upBillSheet'),app.indexOf('function upCardSheet'));
const cardSheet=app.slice(app.indexOf('function upCardSheet'),app.indexOf('function cardPayDetail'));
const helpers=app.slice(app.indexOf('function upWhenTxt'),app.indexOf('function upBillSheet'));
const method=app.slice(app.indexOf('function upMethodHtml'),app.indexOf('/* urgency tiers'));

test('every Upcoming bill, trial and statement row opens a summary on one tap',()=>{
  assert.equal((rows.match(/onclick="upBillSheet\(\$\{b\.id\}\)"/g)||[]).length,3);
  assert.match(rows,/class="row trial urg-\$\{urgOf\(trialLeft\(b\)\)\}"[\s\S]*onclick="upBillSheet/);
  assert.match(rows,/class="row urg-\$\{urgency\}"[\s\S]*onclick="upBillSheet/);
  assert.match(cardRow,/data-bcard="\$\{a\.id\}"/);
  assert.match(cardRow,/onclick="upCardSheet\(\$\{a\.id\}\)"/);
  assert.match(cardRow,/Tap for statement details/);
});

test('Pay and ⋮ stay independent controls and never open the summary',()=>{
  assert.equal((rows.match(/event\.stopPropagation\(\);payBill/g)||[]).length,2);
  assert.equal((rows.match(/event\.stopPropagation\(\);editBillSheet/g)||[]).length,3);
  assert.match(cardRow,/event\.stopPropagation\(\);payCard\(\$\{a\.id\},1\)/);
  assert.match(cardRow,/event\.stopPropagation\(\);cardPayInfo\(\$\{a\.id\}\)/);
});

test('free trials show the trial label, post-trial price and a mini payment logo',()=>{
  assert.match(rows,/trialLabel\(b\)/);
  assert.match(rows,/after trial/);
  assert.match(rows,/Renews \$\{en\}/);
  assert.match(rows,/after trial · Renews \$\{en\}<\/small><small class="up-sub">\$\{upMethodHtml\(b\)\}/);
  const trialRow=rows.slice(0,rows.indexOf('if (subGone(b))'));
  assert.doesNotMatch(trialRow,/<b class="m">/,'no duplicate post-trial price at the right');
  assert.match(rows,/upMethodHtml\(b\)/);
  assert.match(method,/cardLogo\(a\)/);
  assert.match(method,/class="up-method"/);
  assert.match(method,/Choose payment account/);
  assert.doesNotMatch(rows,/billAcct\(/);
});

test('Upcoming unpaid bills reuse Home urgency tiers and live date refresh, paid bills stay neutral',()=>{
  assert.match(rows,/urgency = paid \? "n" : urgOf\(days\(b\)\)/);
  assert.match(rows,/paid \? "" : `data-due="\$\{bIso\(nextDue\(b\)\)\}"`/);
  assert.match(rows,/paid \? "" : "du-status"/);
  assert.match(rows,/<b class="du">/);
  assert.match(cardRow,/urgency = urgOf\(n\)/);
  const tier=app.slice(app.indexOf('const urgOf='),app.indexOf('const urgTxt='));
  const ctx=vm.createContext({});vm.runInContext(tier+';this.tier=urgOf',ctx);
  for(const [n,u] of [[-5,'o'],[-1,'o'],[0,'r'],[3,'r'],[4,'y'],[7,'y'],[8,'n'],[30,'n']])assert.equal(ctx.tier(n),u);
});

test('Upcoming treats logos as presentation only: no box, ring or baked background',()=>{
  assert.match(css,/\.up-list \.row>\.ico,\s*\.home-bill-list \.row>\.ico \{ background:none; border:0; border-radius:0; box-shadow:none; \}/);
  assert.match(css,/\.up-list \.row\.trial>\.ico,\s*\.home-bill-list \.row\.trial>\.ico \{ background:none; box-shadow:none; \}/);
  assert.match(css,/\.up-list \.row>\.ico \.ci,\s*\.home-bill-list \.row>\.ico \.ci \{ border-radius:0; \}/);
  assert.match(css,/\.up-list \.row>\.ico \.xcl,\s*\.home-bill-list \.row>\.ico \.xcl \{ filter:none; \}/);
  assert.match(css,/#sb \.up-hero \.ico \{ background:none; border:0; border-radius:0; box-shadow:none; \}/);
  assert.match(css,/\.up-method \.xcl \{ width:24px; height:15\.6px; flex:none;/);
});

test('ChatGPT and Minecraft use local, offline-cached artwork with no remote URL',()=>{
  for(const f of ['assets/branding/chatgpt.svg','assets/branding/minecraft.svg']){
    assert.ok(fs.existsSync(path.join(root,f)),f+' exists');
    assert.match(read(f),/<svg[\s>]/i);
  }
  assert.match(app,/\{r:'chatgpt\|openai',s:'<img class="ci lg oai-mark" alt="" src="assets\/branding\/chatgpt\.svg">'\}/);
  assert.match(app,/\{r:'minecraft',s:'<img class="ci lg" alt="" src="assets\/branding\/minecraft\.svg">'\}/);
  assert.doesNotMatch(app,/cdn\.simpleicons|api\.iconify|simple-icons\.org/);
  assert.match(sw,/cap-shell-v369/);
  assert.match(sw,/\.\/assets\/branding\/chatgpt\.svg/);
  assert.match(sw,/\.\/assets\/branding\/minecraft\.svg/);
});

test('the OpenAI mark inverts only on dark surfaces',()=>{
  assert.match(css,/@media\(prefers-color-scheme:dark\) \{ :root:not\(\[data-theme="light"\]\) \.oai-mark \{ filter:invert\(1\); \} \}/);
  assert.match(css,/:root\[data-theme="dark"\] \.oai-mark \{ filter:invert\(1\); \}/);
});

test('bill details cover status, dates, amount, method, timing and history',()=>{
  for(const label of ['Status','Trial End Date','First Charge Amount','Auto-Renewal',
    'Next Renewal','Due Date','Billing Frequency','Category','Billing Details','Renewal & Billing',
    'Default Payment Account','Latest Payment','Last Payment','Paid From','Payment Timing','Payment History'])
    assert.ok(billSheet.includes(label),label);
  assert.match(billSheet,/billPayments\(b\)/);
  assert.match(billSheet,/payDiff\(last\.due,last\.d\)/);
  assert.match(billSheet,/upPaymentTiming\(tm\)/);
  assert.doesNotMatch(billSheet,/R\('(Amount|Price|Time Until Due|Time Until Renewal)'/);
  assert.match(billSheet,/'Subscription Details':'Bill Details'/);
  assert.match(billSheet,/billHistory\(\$\{b\.id\}/);
  assert.match(billSheet,/payBill\(\$\{b\.id\}\)/);
  assert.match(billSheet,/editBillSheet\(\$\{b\.id\}\)/);
  assert.match(billSheet,/activeTrial\?php\(0\):php\(b\.amt\)/);
});

test('credit-card statement details cover period, due, paid-from, timing and history',()=>{
  for(const label of ['Statement Balance','Remaining Due','Status','Statement Period','Statement Date',
    'Due Date','Minimum Due','Paid to Date','Paid On','Paid From','Payment Timing','Payment History',
    'Balance Summary','Statement Schedule','Payment Summary','Statement Details'])
    assert.ok(cardSheet.includes(label),label);
  assert.match(cardSheet,/outstandingCardStatements\(\)/);
  assert.match(cardSheet,/estimateStatement\(a,latest\)/);
  assert.match(cardSheet,/cardPaymentHistory\(\$\{a\.id\}/);
  assert.match(cardSheet,/payCard\(\$\{a\.id\},1\)/);
  assert.match(cardSheet,/undoCardPay\(\$\{last\.id\},\$\{a\.id\}\)/);
  assert.doesNotMatch(cardSheet,/R\('(Remaining Due|Time Left)'/);
});

test('the summary sheets reuse the shared transition and add no records',()=>{
  for(const source of [billSheet,cardSheet]){
    assert.match(source,/navS\(/);
    assert.doesNotMatch(source,/S\.(tx|xfer|bills|accts)\.push/);
    assert.doesNotMatch(source,/S\.(tx|xfer|bills|accts)\s*=/);
    assert.doesNotMatch(source,/\bsave\(|\brender\(|localStorage|fetch\(|CapProductionSync|CapSupabase/);
  }
  assert.match(anim,/#sheet\.open>#sb\{animation:capSheetIn/);
  assert.match(css,/prefers-reduced-motion:reduce\)\{#sheet\.open,#sheet\.open>#sb/);
  assert.match(css,/:root\[data-theme="apple"\] :is\(#sheet>#sb/);
});

test('Plan slices Upcoming on the up-list marker and keeps the add-bill action',()=>{
  assert.match(cards,/<div class="card up-list"><h2>Bills &amp; Subscriptions<\/h2>/);
  assert.match(app,/'<div class="card up-list"><h2>Bills'/);
  assert.match(cards,/＋ Add bill/);
});

test('pure countdown and payment-method helpers render the expected copy',()=>{
  const c=vm.createContext({S:{accts:[{id:7,name:'Maya Black Visa Platinum'}]},esc:s=>String(s),cardLogo:a=>`<svg data-card="${a.id}"></svg>`});
  vm.runInContext(helpers+method,c);
  assert.equal(c.upWhenTxt(null),'—');
  assert.equal(c.upWhenTxt(-3),'3 days overdue');
  assert.equal(c.upWhenTxt(-1),'1 day overdue');
  assert.equal(c.upWhenTxt(0),'Today');
  assert.equal(c.upWhenTxt(1),'Tomorrow');
  assert.equal(c.upWhenTxt(22),'In 22 days');
  assert.equal(c.upMethodHtml({acct:7}),'<span class="up-method"><svg data-card="7"></svg><span>Maya Black Visa Platinum</span></span>');
  assert.equal(c.upMethodHtml({acct:99}),'<span class="up-method none">＋ Choose payment account</span>');
});

// Exercise the actual presentation functions over recorded-data fixtures.
const c=vm.createContext({S:{bills:[],accts:[{id:7,name:'Default Card'},{id:8,name:'Actual Payment Account'}]},
  today:'2026-10-26',BF:{monthly:'Every month',once:'Once'},esc:s=>String(s),
  php:n=>'₱'+Number(n).toFixed(2),bv:s=>s,noteD:s=>s||'—',
  bDt:s=>new Date(s+'T00:00:00Z'),bIso:s=>s,nextDue:b=>b.dueDate,
  subFirstBill:b=>b.firstBillingDate,isTrial:b=>!!b.isFreeTrial,
  subStatus:b=>b.subscriptionStatus==='Cancelled'?'cancelled':b.subscriptionStatus==='Expired'?'expired':b.isFreeTrial&&b.firstBillingDate>='2026-10-26'?'trial':'active',
  billKind:b=>b.kind||'bill',paidNow:b=>!!b.paid,
  billPayments:b=>b.payments||[],subFreqTail:b=>b.freq==='once'?'':'/month',
  bIc:()=>'<svg data-logo="bill"></svg>',cardLogo:()=>'<svg data-logo="card"></svg>',
  paySrcHtml:(id,fallback)=>'<span class="psrc"><svg></svg><span>'+({7:'Default Card',8:'Actual Payment Account'}[id]||fallback||'External payment source')+'</span></span>',
  payDiff:(due,d)=>due&&d?Math.round((new Date(due)-new Date(d))/864e5):null,
  payTimingClass:n=>n<0?'tm-late':'tm-ok',trialLabel:()=>'',paymentHistoryCount:()=>2,
  urgOf:n=>n<0?'o':n<=3?'r':n<=7?'y':'n',
  cardPayInfo:()=>{},navS:html=>{c.html=html}});
c.days=b=>Math.round((new Date(b.dueDate)-new Date(c.today))/864e5);
c.subGone=b=>['cancelled','expired'].includes(c.subStatus(b));c.inTrial=b=>c.subStatus(b)==='trial';
vm.runInContext(helpers+billSheet+cardSheet,c);
const groups=()=>[...c.html.matchAll(/<h3 class="up-section-title">([^<]*)<\/h3>/g)].map(m=>m[1]);
const showBill=patch=>{c.S.bills=[{id:1,name:'Cloud Plus',amt:119,freq:'monthly',acct:7,dueDate:'2026-11-02',...patch}];c.upBillSheet(1)};
test('bill groups retain actual latest payment and Title Case labels, with no duplicate amount/countdown',()=>{
  showBill({payments:[{d:'2026-10-25',due:'2026-10-26',amt:119,acct:8}]});
  assert.deepEqual(groups(),['Billing Details','Schedule','Latest Payment']);
  assert.match(c.html,/<h2>Bill Details<\/h2>/);assert.match(c.html,/1 Day Early/);
  assert.match(c.html,/Paid From<\/span><b>[^]*Actual Payment Account/);
  assert.doesNotMatch(c.html,/>Amount<\/span>|Time Until Due/);
  const before=JSON.stringify(c.S);c.upBillSheet(1);assert.equal(JSON.stringify(c.S),before);
});
test('active subscription hero includes interval and renewal badge; no-payment card never invents paid-from',()=>{
  showBill({kind:'subscription'});
  assert.deepEqual(groups(),['Subscription Details','Renewal & Billing','Latest Payment']);
  assert.match(c.html,/<h2>Subscription Details<\/h2>/);assert.match(c.html,/up-interval">\/month/);
  assert.match(c.html,/Renews in 7 days/);assert.match(c.html,/No payments yet/);
  assert.doesNotMatch(c.html,/Paid From|Payment Timing|Time Until Renewal|>Price<\/span>/);
});
test('trial differentiates free price from scheduled first charge and retains default mini logo',()=>{
  showBill({kind:'subscription',isFreeTrial:1,firstBillingDate:'2026-11-17',trialStartDate:'2026-10-18',trialEndDate:'2026-11-17'});
  assert.match(c.html,/Trial ends in 22 days/);assert.match(c.html,/>Free Trial<\/b>/);
  assert.match(c.html,/pd-v">₱0.00/);assert.match(c.html,/₱119.00\/month after trial/);
  assert.match(c.html,/First Charge Amount<\/span><b>₱119.00/);
  assert.match(c.html,/Default Payment Account<\/span><b><span class="psrc"><svg>/);
  assert.match(c.html,/First Charge Date/);assert.match(c.html,/No payments yet/);
});
test('cancelled and non-renewing trials never imply a scheduled charge',()=>{
  for(const patch of [{subscriptionStatus:'Cancelled',cancelledOn:'2026-10-24'},{freq:'once'}]){
    showBill({kind:'subscription',isFreeTrial:1,firstBillingDate:'2026-11-17',...patch});
    assert.match(c.html,/Not Scheduled/);assert.match(c.html,/Auto-Renewal<\/span><b><span class="m">Off/);
    assert.doesNotMatch(c.html,/First Charge Date/);
  }
});
test('free-trial countdowns and sheet badges reuse urgency tiers without changing trial status',()=>{
  assert.match(rows,/data-due="\$\{subFirstBill\(b\)\}" data-trial="1" data-trial-urgency="1"/);
  assert.match(rows,/class="tr-b du"/);
  for(const [days,tier] of [[0,'r'],[1,'r'],[3,'r'],[4,'y'],[7,'y'],[8,'n'],[22,'n']]){
    const d=new Date('2026-10-26T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);
    showBill({kind:'subscription',isFreeTrial:1,firstBillingDate:d.toISOString().slice(0,10)});
    assert.ok(c.html.includes('up-trial-'+tier));assert.match(c.html,/>Free Trial<\/b>/);
  }
  for(const [tier,color] of [['r','r'],['y','uy'],['o','ud']])
    assert.ok(css.includes(`.chip.up-trial-${tier} { color:var(--${color}); }`));
});
test('live urgency refresh preserves free-trial copy and leaves Home trial treatment unchanged',()=>{
  const makeRow=urgent=>{const classes=new Set(['urg-n']);return{classes,hasAttribute:k=>k==='data-trial'||urgent&&k==='data-trial-urgency',getAttribute:()=> '2026-10-29',classList:{toggle:(k,on)=>on?classes.add(k):classes.delete(k)},querySelector:()=>null}};
  const upcoming=makeRow(true),home=makeRow(false),ctx=vm.createContext({today:'2026-10-26',bDt:s=>new Date(s),urgOf:c.urgOf,trialTxt:n=>'Free Trial · '+n+' days left',document:{querySelectorAll:()=>[upcoming,home]}});
  vm.runInContext(app.slice(app.indexOf('function refreshUrgency()'),app.indexOf('/* the calendar day can change')),ctx);
  ctx.refreshUrgency();assert.ok(upcoming.classes.has('urg-r'));assert.ok(home.classes.has('urg-t'));
  assert.equal(upcoming.classes.has('urg-t'),false);
});
test('paid and overdue bills retain their statuses and correctly dated timing',()=>{
  showBill({paid:true,payments:[{d:'2026-10-26',due:'2026-10-26',amt:119,acct:8}]});
  assert.match(c.html,/On Time/);assert.doesNotMatch(c.html,/onclick="payBill/);
  showBill({dueDate:'2026-10-20',payments:[{d:'2026-10-23',due:'2026-10-20',amt:119,acct:8}]});
  assert.match(c.html,/Overdue/);assert.match(c.html,/3 Days Late/);assert.match(c.html,/onclick="payBill/);
});
test('partial, paid and overdue statements retain calculations/actions across all three groups',()=>{
  c.S.accts.push({id:9,name:'Statement Card',stmt:24});
  for(const [remaining,status,paid] of [[800,'Unpaid',200],[0,'Paid',1000],[800,'Overdue',200]]){
    const statement={c:{st:'2026-09-25',en:'2026-10-24',due:status==='Overdue'?'2026-10-20':'2026-11-13'},close:1000,minimum:50,paid,pay:[{x:{id:99,d:'2026-10-26',from:8}}]};
    c.outstandingCardStatements=()=>remaining?[{a:c.S.accts[2],statement,due:statement.c.due}]:[];
    c.cSum=()=>statement;c.estimateStatement=()=>({remaining,status,interest:10,fees:5});
    const before=JSON.stringify(c.S);c.upCardSheet(9);assert.equal(JSON.stringify(c.S),before);
    assert.deepEqual(groups(),['Balance Summary','Statement Schedule','Payment Summary']);
    assert.match(c.html,/<h2>Statement Details<\/h2>/);
    assert.match(c.html,/up-amount-label">Remaining Due/);
    assert.doesNotMatch(c.html,/Remaining Due<\/span>|Time Left/);
    assert.match(c.html,/Actual Payment Account/);assert.match(c.html,/Estimated Interest|Estimated Fees/);
    assert.match(c.html,/undoCardPay\(99,9\)/);
    assert.equal(c.html.includes('onclick="payCard'),remaining>0);
    assert.ok(c.html.includes(status));
  }
});
console.log(`\n${passed} Upcoming presentation checks passed`);
