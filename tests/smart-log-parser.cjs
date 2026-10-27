/* Deterministic Smart Log rules; no browser, credentials, writes or network. */
const assert=require('node:assert/strict'),p=require('../js/smart-log-parser');
const base={today:'2026-10-26',accounts:[
 {id:1,name:'BDO Debit',bank:'BDO',type:'debit',l4:'1234'},
 {id:2,name:'Maya Wallet',bank:'Maya',type:'ewallet',l4:'9876'},
 {id:3,name:'MariBank Savings',bank:'MariBank',type:'debit'}
],categories:['Food','Groceries','Salary','Transport','Shopping','Entertainment','Other'],history:[],bills:[],debts:[]};
const parse=(s,changes={})=>p.parse(s,{...base,...changes}),v=(d,k)=>d.fields[k].value;
let passed=0;
function test(name,fn){fn();console.log('PASS '+name);passed++}
for(const [sentence,type,amount,title,account,cat,date] of [
 ['Jollibee 450 using BDO','expense',450,'Jollibee',1,'Food','2026-10-26'],
 ['Spent ₱450 at Jollibee using BDO yesterday','expense',450,'Jollibee',1,'Food','2026-10-25'],
 ['Groceries 1,250 Maya','expense',1250,'Groceries',2,'Groceries','2026-10-26'],
 ['Salary 8000 to MariBank','income',8000,'Salary',3,'Salary','2026-10-26'],
 ['Received 5000 salary in BDO today','income',5000,'Salary',1,'Salary','2026-10-26'],
 ['Earned PHP 1,250.50 at Consulting using BDO','income',1250.5,'Consulting',1,null,'2026-10-26'],
])test(sentence,()=>{const d=parse(sentence);assert.equal(v(d,'type'),type);assert.equal(v(d,'amount'),amount);assert.equal(v(d,'title'),title);assert.equal(v(d,'account'),account);assert.equal(v(d,'category'),cat);assert.equal(v(d,'date'),date)});
test('transfer resolves both ends without expense/income accounting or invented category',()=>{
 const d=parse('Transfer 2000 from BDO to Maya');assert.equal(v(d,'type'),'transfer');assert.equal(v(d,'amount'),2000);assert.equal(v(d,'from'),1);assert.equal(v(d,'to'),2);assert.equal(v(d,'title'),'Account Transfer');assert.equal(v(d,'category'),null);assert.deepEqual(p.validate(d,base),[]);
});
for(const [s,n] of [['450',450],['450.50',450.5],['₱450',450],['P450',450],['PHP 450',450],['1,250',1250],['1,250.50',1250.5],['1k',1000],['1.5k',1500]])test('amount '+s,()=>{assert.equal(p.amountValue(s),n);assert.equal(v(parse('Jollibee '+s+' BDO'),'amount'),n)});
for(const s of ['0','-450','1,25','450.999','Infinity','NaN','9007199254740992'])test('invalid/unsafe amount '+s,()=>assert.equal(p.amountValue(s),null));
for(const [phrase,date] of [['today','2026-10-26'],['yesterday','2026-10-25'],['2026-10-25','2026-10-25'],['Oct 25, 2026','2026-10-25'],['25 October 2026','2026-10-25'],['Oct 25','2026-10-25'],['25 October','2026-10-25'],['10/25/2026','2026-10-25'],['25/10/2026','2026-10-25']])test('local date '+phrase,()=>{const d=parse('Jollibee 450 BDO '+phrase);assert.equal(v(d,'date'),date);assert.equal(v(d,'amount'),450);assert.equal(v(d,'title'),'Jollibee')});
test('yesterday uses local calendar arithmetic across month/year/leap boundaries',()=>{
 for(const [today,want] of [['2026-01-01','2025-12-31'],['2024-03-01','2024-02-29'],['2026-03-01','2026-02-28']])assert.equal(v(parse('Spent 450 at Jollibee BDO yesterday',{today}),'date'),want);
 assert.equal(p.localDate(new Date(2026,9,25,23,59)),'2026-10-25');
});
for(const date of ['2026-02-30','2026-13-01','10/11/2026','today yesterday'])test('invalid/ambiguous date blocks confirmation: '+date,()=>{const d=parse('Jollibee 450 BDO '+date);assert.equal(v(d,'date'),null);assert.equal(v(d,'amount'),450);assert.ok(p.validate(d,base).length)});
for(const [phrase,time] of [['at 7:30 PM','19:30'],['at 7:30 pm','19:30'],['19:30','19:30'],['at 12:00 AM','00:00'],['at 12:00 PM','12:00'],['noon','12:00'],['midnight','00:00']])test('local time '+phrase,()=>{const d=parse('Jollibee 450 BDO '+phrase);assert.equal(v(d,'time'),time);assert.equal(v(d,'amount'),450);assert.equal(v(d,'title'),'Jollibee')});
for(const phrase of ['at 2:00 PM at 4:00 PM','at 2 PM at 4 PM'])test('conflicting explicit times block confirmation: '+phrase,()=>{
 const d=parse('Jollibee 450 BDO '+phrase,{nowTime:'09:15'});
 assert.equal(d.fields.time.state,'ambiguous');assert.equal(v(d,'time'),null);
 assert.deepEqual(d.fields.time.candidates,['14:00','16:00']);assert.match(p.validate(d,base).join(' '),/Resolve Time/);
 d.fields.time.value='14:00';assert.match(p.validate(d,base).join(' '),/Resolve Time/,'stale value cannot override ambiguous state');
});
test('one explicitly selected valid time resolves ambiguity without changing other fields',()=>{
 const d=parse('Jollibee 450 BDO at 2 PM at 4 PM');
 d.fields.time={value:'16:00',state:'resolved',candidates:[],reason:''};
 assert.deepEqual(p.validate(d,base),[]);assert.equal(p.timeLabel(v(d,'time')),'4:00 PM');
});
test('no explicit time still defaults locally and optional missing time is not newly required',()=>{
 const d=parse('Jollibee 450 BDO',{nowTime:'09:15'});assert.equal(d.fields.time.state,'defaulted');assert.equal(v(d,'time'),'09:15');assert.deepEqual(p.validate(d,base),[]);
 const missing=parse('Jollibee 450 BDO');assert.equal(missing.fields.time.state,'missing');assert.deepEqual(p.validate(missing,base),[]);
});
test('one explicit time or repeated identical times remains confirmable',()=>{
 for(const phrase of ['at 2 PM','at 2 PM at 2 PM']){const d=parse('Jollibee 450 BDO '+phrase);assert.equal(d.fields.time.state,'resolved');assert.equal(v(d,'time'),'14:00');assert.deepEqual(p.validate(d,base),[])}
});
test('required ambiguous or missing states cannot be overridden by stale valid candidate values',()=>{
 for(const key of ['type','amount','title','date','account','category'])for(const state of ['ambiguous','missing']){const d=parse('Jollibee 450 BDO');d.fields[key].state=state;assert.ok(p.validate(d,base).length,key+' '+state)}
 for(const key of ['from','to']){const d=parse('Transfer 450 from BDO to Maya');d.fields[key].state='ambiguous';assert.ok(p.validate(d,base).length,key)}
});
test('defaulted clock time, local formatting and validation',()=>{
 const d=parse('Jollibee 450 BDO',{nowTime:'08:05'});assert.equal(v(d,'time'),'08:05');assert.equal(d.fields.time.state,'defaulted');
 assert.equal(p.localTime(new Date(2026,9,26,19,30)),'19:30');
 assert.equal(p.timeLabel('19:30'),'7:30 PM');assert.equal(p.timeLabel('00:00'),'12:00 AM');assert.equal(p.timeLabel('12:00'),'12:00 PM');
 assert.equal(p.validTime('23:59'),true);assert.equal(p.validTime('24:00'),false);assert.equal(p.validTime('7:30'),false);
 d.fields.time.value='25:00';assert.ok(p.validate(d,base).length);
});
test('clock times are never mistaken for amounts or titles',()=>{
 const d=parse('Jollibee at 19:30 BDO');assert.equal(v(d,'amount'),null);assert.equal(v(d,'time'),'19:30');assert.equal(v(d,'title'),'Jollibee');
 const two=parse('Jollibee 450 BDO at 7:30 PM and 8:00 PM');assert.equal(two.fields.time.state,'ambiguous');assert.deepEqual(two.fields.time.candidates,['19:30','20:00']);
});
test('year and account last-four context cannot become an amount',()=>{
 for(const s of ['Jollibee using BDO ending 1234 yesterday','Jollibee BDO in 2026'])assert.equal(v(parse(s),'amount'),null);
 const d=parse('Spent 450 at Jollibee using BDO ending 1234');assert.equal(v(d,'amount'),450);assert.equal(v(d,'account'),1);
 assert.equal(v(parse('Jollibee 450 BDO 1234'),'amount'),450);
});
test('partial dates, signed secondary amounts and spaced k/currency tokens fail safely or normalize explicitly',()=>{
 assert.equal(v(parse('Jollibee 1.5 k BDO'),'amount'),1500);assert.equal(v(parse('Jollibee P 450 BDO'),'amount'),450);
 for(const text of ['Jollibee 450 BDO 2026-10','Jollibee 450 BDO 10/11']){const d=parse(text);assert.equal(v(d,'date'),null);assert.equal(v(d,'amount'),450)}
 assert.equal(v(parse('Jollibee 450 -50 BDO'),'amount'),null);
});
test('explicit category outranks conflicting history and dictionary',()=>{
 const d=parse('Jollibee 450 Shopping BDO',{history:[{note:'Jollibee',cat:'Food',amt:-100,d:'2026-10-25'}]});assert.equal(v(d,'category'),'Shopping');assert.equal(d.fields.category.state,'resolved');assert.equal(v(d,'title'),'Jollibee');
});
test('merchant history is local, deterministic, category-valid and case normalized',()=>{
 const history=[{note:'JOLLIBEE',cat:'Shopping',amt:-100,d:'2026-10-25'}];const d=parse('Jollibee 450 BDO',{history});assert.equal(v(d,'category'),'Shopping');assert.match(d.fields.category.reason,/history/);
});
test('consistent history has a deterministic winner; recent consistent history can supersede older categories',()=>{
 const history=[{note:'Shop',cat:'Food',amt:-1,d:'2026-10-01'},{note:'Shop',cat:'Food',amt:-2,d:'2026-10-02'},{note:'Shop',cat:'Shopping',amt:-3,d:'2026-10-03'}];
 assert.equal(v(parse('Shop 450 BDO',{history}),'category'),'Food');
 history.push(...[4,5,6].map(i=>({note:'Shop',cat:'Other',amt:-i,d:'2026-10-0'+i})));assert.equal(v(parse('Shop 450 BDO',{history}),'category'),'Other');
});
test('conflicting history requires confirmation, never hides uncertainty behind a keyword rule',()=>{
 const history=[{note:'Jollibee',cat:'Food',amt:-1,d:'2026-10-01'},{note:'Jollibee',cat:'Shopping',amt:-2,d:'2026-10-02'}];const d=parse('Jollibee 450 BDO',{history});assert.equal(v(d,'category'),null);assert.equal(d.fields.category.state,'ambiguous');assert.deepEqual(d.fields.category.candidates,['Food','Shopping']);
});
test('keyword rules map only to categories actually present, unknown merchants require confirmation',()=>{
 const grab=parse('Grab 120 BDO');assert.equal(v(grab,'category'),null);assert.equal(grab.fields.category.state,'ambiguous');
 assert.equal(v(parse('Unknown Merchant 450 BDO'),'category'),null);
 assert.equal(v(parse('Jollibee 450 BDO',{categories:['Other']}),'category'),null);
});
const everyday={...base,accounts:[...base.accounts,{id:5,name:'BDO Everyday',bank:'BDO',type:'debit'}]};
const merchantParse=(s,changes={})=>p.parse(s,{...everyday,...changes});
for(const [sentence,category,title] of [
 ['Spotify Premium 115 BDO Everyday','Entertainment','Spotify Premium'],
 ['Netflix 249 BDO Everyday','Entertainment','Netflix'],
 ['Jollibee 450 BDO Everyday','Food','Jollibee'],
 ['Shopee 899 BDO Everyday','Shopping','Shopee'],
 ['spotify premium 115 bdo everyday','Entertainment','spotify premium'],
 ['SPOTIFY 115 BDO Everyday','Entertainment','SPOTIFY'],
 ['Disney Plus 149 BDO Everyday','Entertainment','Disney Plus'],
 ['YouTube Premium 249 BDO Everyday','Entertainment','YouTube Premium'],
 ['GrabFood 450 BDO Everyday','Food','GrabFood'],
 ['Angkas 120 BDO Everyday','Transport','Angkas'],
])test('merchant category rule: '+sentence,()=>{
 const d=merchantParse(sentence);assert.equal(v(d,'category'),category);assert.equal(v(d,'title'),title);assert.equal(v(d,'type'),'expense');assert.match(d.fields.category.reason,/merchant rule/i);
});
test('explicit category outranks a merchant rule',()=>{
 const d=merchantParse('Spotify Premium 115 Shopping BDO Everyday');assert.equal(v(d,'category'),'Shopping');assert.equal(d.fields.category.reason,'Explicit category');
});
test('reliable local history outranks a merchant rule, including merchant-family aliases',()=>{
 const history=[{note:'Spotify',cat:'Subscriptions',amt:-115,d:'2026-10-20'},{note:'Spotify',cat:'Subscriptions',amt:-115,d:'2026-10-21'}];
 const d=merchantParse('Spotify Premium 115 BDO Everyday',{categories:[...base.categories,'Subscriptions'],history});
 assert.equal(v(d,'category'),'Subscriptions');assert.match(d.fields.category.reason,/history/);
});
test('merchant rules never invent categories and fall back safely',()=>{
 const data={...everyday,categories:['Food','Groceries','Salary','Transport','Shopping','Other']};
 const d=p.parse('Spotify Premium 115 BDO Everyday',data);
 assert.equal(v(d,'category'),null);assert.equal(d.fields.category.state,'missing');assert.equal(data.categories.includes('Entertainment'),false);
});
test('ambiguous merchants need context or history instead of a blind category',()=>{
 const plain=merchantParse('Grab 120 BDO Everyday');
 assert.equal(v(plain,'category'),null);assert.equal(plain.fields.category.state,'ambiguous');assert.deepEqual(plain.fields.category.candidates,['Transport','Food']);
 assert.equal(v(merchantParse('Grab ride 250 BDO Everyday'),'category'),'Transport');
 assert.equal(v(merchantParse('GrabFood 450 BDO Everyday'),'category'),'Food');
});
test('merchant recognition does not alter or trigger existing subscription workflows',()=>{
 const bills=[{name:'Netflix',amount:249}];const data={...everyday,bills};
 const d=p.parse('Netflix 249 BDO Everyday',data);assert.equal(d.kind,'specialized');assert.deepEqual(data.bills,[{name:'Netflix',amount:249}]);
 const music=p.parse('Spotify Premium 115 BDO Everyday',everyday);assert.equal(music.kind,'draft');assert.deepEqual(everyday.bills,[]);
});
test('exact, normalized, alias and unique partial account matches',()=>{
 for(const [q,id] of [['BDO Debit',1],['bdo-debit',1],['BDO',1],['Maya',2],['Mari Bank',3],['maribank savings',3]])assert.equal(p.resolveAccount(q,base.accounts).value,id,q);
});
test('ambiguous accounts never select the first account or invent a new one',()=>{
 const accounts=[...base.accounts,{id:4,name:'Maya Black Visa',bank:'Maya',type:'credit',l4:'4321'}];
 const d=parse('Groceries 450 using Maya',{accounts});assert.equal(v(d,'account'),null);assert.deepEqual(d.fields.account.candidates,[2,4]);
 assert.equal(v(parse('Groceries 450 using Maya Black',{accounts}),'account'),4);
 assert.equal(v(parse('Groceries 450 using Atlantis'),'account'),null);
 assert.equal(p.resolveAccount('Maya ending 4321',accounts).value,4);
});
test('exact account name outranks partial matches',()=>{const accounts=[...base.accounts,{id:4,name:'Maya',type:'ewallet'}];assert.equal(p.resolveAccount('Maya',accounts).value,4)});
test('two plausible amounts require a choice even if one has a currency marker',()=>{
 for(const s of ['Jollibee 450 500 BDO','Spent PHP 450 and 500 at Jollibee BDO']){const d=parse(s);assert.equal(v(d,'amount'),null);assert.deepEqual(d.fields.amount.candidates,[450,500]);assert.ok(p.validate(d,base).length)}
});
test('incomplete sentence and conflicting type cues never silently create an expense',()=>{
 const d=parse('450 yesterday');assert.equal(v(d,'type'),null);assert.equal(v(d,'title'),null);assert.equal(v(d,'account'),null);assert.ok(p.validate(d,base).length);
 assert.equal(v(parse('Received and spent 450 Jollibee BDO'),'type'),null);
 assert.equal(v(parse('Transferred and spent 450 from BDO to Maya'),'type'),null);
});
for(const s of ['How much did I spend this month?','What is my BDO balance?','Show food expenses','Find Jollibee','List transfers'])test('query is never a transaction: '+s,()=>{const d=parse(s);assert.equal(d.kind,'query');assert.ok(p.validate(d,base).length)});
for(const s of ['Pay 450 electric bill using BDO','Subscription payment 450 BDO','Credit card payment 2000 from BDO','Settle statement 450 BDO','Debt repayment 450 BDO','Cash advance 450 BDO','Loan payment 450 BDO'])test('specialized operation is not generic: '+s,()=>{const d=parse(s);assert.equal(d.kind,'specialized');assert.ok(p.validate(d,base).length)});
test('known recurring bill and recorded debt payment names direct to existing workflows',()=>{
 assert.equal(parse('Netflix 450 BDO',{bills:[{name:'Netflix'}]}).kind,'specialized');
 assert.equal(parse('Paid Alex 450 BDO',{debts:[{who:'Alex'}]}).kind,'specialized');
});
test('credit-card transfer and same-account transfer are blocked; ordinary card spending remains supported',()=>{
 const accounts=[...base.accounts,{id:4,name:'Maya Black',bank:'Maya',type:'credit'}];
 assert.equal(parse('Transfer 450 from BDO to Maya Black',{accounts}).kind,'specialized');
 assert.equal(parse('Paid 450 Maya Black',{accounts}).kind,'specialized');
 assert.equal(parse('Paid 450 at Jollibee using Maya Black',{accounts}).kind,'draft');
 assert.ok(p.validate(parse('Transfer 450 from BDO to BDO'),base).length);
});
test('description is extracted only when explicitly supplied and cannot affect type/category parsing',()=>{
 const d=parse('Jollibee 450 BDO note: Salary? not a question about logging');assert.equal(v(d,'description'),'Salary? not a question about logging');assert.equal(v(d,'type'),'expense');assert.equal(v(d,'title'),'Jollibee');
 const clean=parse('Spent 450 at Big Happy Burger using BDO yesterday');assert.equal(v(clean,'title'),'Big Happy Burger');assert.equal(v(clean,'description'),'');
});
test('merchant words are not over-cleaned as structural prepositions or category labels',()=>{
 for(const merchant of ['Made In Manila','Coffee With Friends','Food Panda']){
  const d=parse('Spent 450 at '+merchant+' using BDO');assert.equal(v(d,'title'),merchant);
 }
 const d=parse('Food Panda 450 BDO',{history:[{note:'Food Panda',cat:'Shopping',amt:-100,d:'2026-10-25'}]});assert.equal(v(d,'category'),'Shopping');
});
test('foreign currency and specialized card options require the existing manual workflow',()=>{
 for(const s of ['Spent 450 USD at Jollibee using BDO','Cash advance 450 BDO','Refund 450 BDO']){
  const d=parse(s);assert.equal(d.kind,'specialized');assert.equal(d.workflow,'manual');assert.ok(p.validate(d,base).length);
 }
});
test('parser is pure and produces the same interpretation for typed and transcribed input',()=>{
 const data=JSON.parse(JSON.stringify(base));const freeze=o=>{Object.values(o).forEach(x=>{if(x&&typeof x==='object')freeze(x)});return Object.freeze(o)};freeze(data);
 const first=p.parse('Jollibee 450 BDO',data),second=p.parse('Jollibee 450 BDO',data);assert.deepEqual(first,second);assert.deepEqual(data,base);
});
test('confirmation revalidates account/category availability, amount precision, transfer endpoints and description length',()=>{
 const d=parse('Jollibee 450 BDO');assert.deepEqual(p.validate(d,base),[]);
 assert.ok(p.validate(d,{...base,accounts:[]}).length);assert.ok(p.validate(d,{...base,categories:[]}).length);
 d.fields.amount.value=450.999;assert.ok(p.validate(d,base).length);d.fields.amount.value=450;d.fields.description.value='x'.repeat(301);assert.ok(p.validate(d,base).length);
});
test('parser and UI adapter have no independent persistence, accounting, or network write implementation',()=>{
 const fs=require('node:fs'),source=fs.readFileSync(__dirname+'/../js/smart-log-parser.js','utf8'),ui=fs.readFileSync(__dirname+'/../js/smart-log.js','utf8'),merchants=fs.readFileSync(__dirname+'/../js/smart-log-merchants.js','utf8');
 assert.doesNotMatch(source,/\bfetch\s*\(|localStorage|indexedDB|CapSupabase|CapProductionSync|\bdocument\./);
 assert.doesNotMatch(merchants,/\bfetch\s*\(|localStorage|indexedDB|CapSupabase|CapProductionSync|\bdocument\.|saveTx|accountTransferCommit/);
 assert.doesNotMatch(ui,/\bfetch\s*\(|localStorage|indexedDB|CapSupabase|CapProductionSync|\bbApply\s*\(|\bsave\s*\(|S\.(?:tx|pend|xfer|accts)\s*=|S\.(?:tx|pend|xfer)\.push|\.bal\s*[-+]?=/);
 assert.match(ui,/if\(commit\)\{if\(d\.fields\.type\.value==='transfer'\)window\.accountTransferCommit\(d\.fields\.from\.value\);else window\.saveTx\(\)/);
});
console.log(`PASS: ${passed} deterministic Smart Log parser checks`);
