/* Read-only projections, filters and integer-cent aggregations. No app globals,
   storage, clock, DOM, network or write handlers. Reusable by future summaries. */
(function(root,factory){const api=typeof module==='object'&&module.exports?factory(require('./financial-search-parser.js'),require('./smart-log-merchants.js'),require('./smart-log-parser.js')):factory(root.CapFinancialSearchParser,root.CapSmartLogMerchants,root.CapSmartLogParser);if(typeof module==='object'&&module.exports)module.exports=api;else root.CapFinancialSearchEngine=api;})(typeof window==='undefined'?globalThis:window,function(parser,merchants,dates){
  'use strict';
  const norm=parser.norm,same=(a,b)=>a!=null&&b!=null&&String(a)===String(b),copy=x=>JSON.parse(JSON.stringify(x));
  function cents(v){const n=Number(v);if(!Number.isFinite(n)||!Number.isSafeInteger(Math.round(n*100)))throw Error('An amount is outside the supported money range.');return Math.round(n*100);}
  function add(a,b){const n=a+b;if(!Number.isSafeInteger(n))throw Error('The total is outside the supported money range.');return n;}
  const day=s=>{const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d,12);};
  function subscriptionStatus(b,today){if(!b.isFreeTrial)return 'active';if(b.subscriptionStatus==='Cancelled')return 'cancelled';if(b.subscriptionStatus==='Expired')return 'expired';const first=b.firstBillingDate||b.trialEndDate||b.start;return first&&today<=first?'trial':'active';}
  const billKind=b=>['bill','subscription'].includes(String(b.kind||'').toLowerCase())?b.kind.toLowerCase():b.isFreeTrial||b.subscriptionStatus||['entertainment','subscription','subscriptions'].includes(norm(b.cat))?'subscription':'bill';
  function scheduled(b,key){
    const f=b.freq||'monthly',d=day(key),s=dates.validDate(b.start)?day(b.start):null;
    if(!s)return +b.due===d.getDate();if(key<b.start)return false;
    if(f==='once')return key===b.start;
    if(f==='weekly'||f==='biweekly')return Math.round((d-s)/864e5)%(f==='weekly'?7:14)===0;
    const mm=(d.getFullYear()-s.getFullYear())*12+d.getMonth()-s.getMonth(),last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
    return d.getDate()===Math.min(s.getDate(),last)&&(f==='yearly'?mm%12===0:f==='quarterly'?mm%3===0:true);
  }
  const paid=(b,key)=>(b.paidOn||[]).includes(key)||((b.freq||'monthly')==='monthly'&&b.paid===key.slice(0,7));
  function nextBill(b,today){
    if(dates.validDate(b.nd))return b.nd;
    if(subscriptionStatus(b,today)==='trial'){const f=b.firstBillingDate||b.trialEndDate||b.start;if(dates.validDate(f)&&!paid(b,f))return f;}
    const d=day(today),freq=b.freq||'monthly';let start=['weekly','biweekly'].includes(freq)?today:dates.localDate(new Date(d.getFullYear(),d.getMonth(),1,12));
    if(freq==='once'&&dates.validDate(b.start))start=b.start;
    for(let i=0;i<800;i++){const key=parser.shift(start,i);if(scheduled(b,key)&&!paid(b,key))return key;}
    return dates.validDate(b.start)?b.start:null;
  }
  // Match existing bill history: explicit billId first, conservative legacy
  // Bills/name + paidOn proximity fallback. Each transaction is projected once.
  function billFor(t,bills){if(t.billId!=null)return bills.find(b=>same(t.billId,b.id));return bills.find(b=>t.cat==='Bills'&&t.note===b.name&&(b.paidOn||[]).some(k=>dates.validDate(k)&&dates.validDate(t.d)&&Math.abs(day(k)-day(t.d))<=40*864e5));}
  function snapshot(state,today,categories){
    if(!dates.validDate(today))throw Error('A valid local date is required.');
    const s=copy({accts:state.accts||[],tx:state.tx||[],pend:state.pend||[],xfer:state.xfer||[],bills:state.bills||[],cats:state.cats||[]});
    const accounts=s.accts.map(a=>({id:a.id,name:a.name,nickname:a.nickname,bank:a.bank,type:a.type,l4:a.l4,aliases:a.aliases||[]}));
    const cats=categories||s.cats.filter(c=>!c.a).map(c=>c.n),pendingIds=new Set(s.pend.map(t=>String(t.id))),transferIds=new Set(s.xfer.flatMap(x=>[x.id,x.linkId,x.paymentId].filter(v=>v!=null).map(String)));
    const seen=new Set(),transactions=[];
    for(const [list,pending] of [[s.tx,false],[s.pend,true]])for(const t of list){
      const key=String(t.id);if(seen.has(key)||t.opening||transferIds.has(key)||(!pending&&pendingIds.has(key))||!dates.validDate(t.d)||!Number.isFinite(+t.amt)||!+t.amt)continue;
      seen.add(key);const b=billFor(t,s.bills),a=accounts.find(a=>same(a.id,t.acct));
      transactions.push({id:t.id,source:'transaction',date:t.d,time:t.tm||'',cents:cents(Math.abs(+t.amt)),signedCents:cents(t.amt),type:+t.amt<0?'expense':'income',category:t.cat||'',title:t.note||t.cat||'Transaction',description:t.desc||'',account:t.acct,accountName:a?.name||t.acctName||'Unknown account',pending,billId:b?.id,billKind:b?billKind(b):null,due:t.billDue||'',ts:+t.ts||0});
    }
    const seenX=new Set(),transfers=[];
    for(const x of s.xfer){const identity=String(x.linkId??x.paymentId??x.id);if(seenX.has(identity)||!dates.validDate(x.d)||!(+x.amt>0))continue;seenX.add(identity);
      const from=accounts.find(a=>same(a.id,x.from)),to=accounts.find(a=>same(a.id,x.to)),kind=x.kind||(to?.type==='credit'?'card-payment':'account-transfer');
      if(!['account-transfer','goal-transfer','card-payment'].includes(kind))continue;
      transfers.push({id:x.id,source:kind,date:x.d,cents:cents(x.amt),signedCents:0,type:kind,category:kind==='card-payment'?'Card payment':'Transfer',title:kind==='card-payment'?(to?.name||'Card')+' payment':kind==='goal-transfer'?'Goal transfer':'Account transfer',description:x.note||'',from:x.from,to:x.to,account:x.from,accountName:(from?.name||'Unknown account')+' → '+(to?.name||'Unknown account'),statementId:x.statementId||'',due:x.due||'',pending:false});
    }
    const definitions=s.bills.map(b=>{const status=subscriptionStatus(b,today),first=b.firstBillingDate||b.trialEndDate||b.start||'',due=nextBill(b,today),gone=['cancelled','expired'].includes(status),a=accounts.find(a=>same(a.id,b.acct));
      return {id:b.id,source:billKind(b),title:b.name||'Bill',category:b.cat||'Bills',cents:cents(Math.max(0,+b.amt||0)),signedCents:0,account:b.acct,accountName:a?.name||'No account selected',date:status==='trial'?first:due,status:gone?status:status==='trial'?'trial':due&&paid(b,due)?'paid':due&&due<today?'late':'unpaid',active:!gone&&!(b.freq==='once'&&b.start&&paid(b,b.start)),trial:!!b.isFreeTrial&&status==='trial',frequency:b.freq||'monthly',description:'Scheduled definition · not recorded spending',pending:false};
    });
    const statements=[];
    // Stored closed snapshots only. Never call cSum/cardCycles: cSum can save.
    // Explicit statement-linked repayments support principal summaries. Legacy
    // payment/refund windows fail closed; unbooked fees are never recalculated.
    for(const a of s.accts.filter(a=>a.type==='credit')){
      const hist=(Array.isArray(a.statementHistory)?a.statementHistory:[]).filter(h=>dates.validDate(h.en)&&Number.isFinite(+h.balance)).slice().sort((x,y)=>y.en.localeCompare(x.en));
      const known=new Set();for(let i=0;i<hist.length;i++){const h=hist[i],key=`${a.id}:${h.en}`;if(known.has(key))continue;known.add(key);const until=i===0?today:hist[i-1].en;
        const pays=transfers.filter(x=>x.source==='card-payment'&&same(x.to,a.id)&&x.date<=today&&(x.statementId?x.statementId===key:x.date>h.en&&x.date<=until));
        const credits=transactions.filter(t=>same(t.account,a.id)&&!t.pending&&t.type==='income'&&t.date>h.en&&t.date<=until);
        // Missing generated cycles make legacy unlinked payment/refund windows
        // unsafe to attribute. Do not invent statement status from that data.
        const uncertain=credits.length>0||transfers.some(x=>x.source==='card-payment'&&same(x.to,a.id)&&!x.statementId&&x.date>h.en&&x.date<=today);
        const paidCents=pays.reduce((n,x)=>add(n,x.cents),0),remaining=Math.max(0,cents(h.balance)-paidCents);
        statements.push({id:key,source:'statement',title:a.name||'Credit card',category:'Recorded statement',date:h.due||h.en,due:h.due||'',cents:remaining,signedCents:0,paidCents,uncertain,account:a.id,accountName:a.name,description:'Recorded statement principal · excludes unbooked fees/interest',status:uncertain?'unknown':remaining===0?'paid':h.due&&h.due<today?'late':'unpaid',pending:false});
      }
    }
    return {today,accounts,categories:[...cats],names:[...new Set([...transactions.map(t=>t.title),...s.bills.map(b=>b.name)].filter(Boolean))],transactions,transfers,definitions,statements};
  }
  function matches(row,p){
    if(p.date&&(!dates.validDate(row.date)||row.date<p.date.start||row.date>p.date.end))return false;
    if(p.type&&row.type!==p.type)return false;
    if(p.category&&norm(row.category)!==norm(p.category))return false;
    if(p.account!=null&&!same(row.account,p.account)&&!same(row.from,p.account)&&!same(row.to,p.account))return false;
    if(p.from!=null&&!same(row.from,p.from)||p.to!=null&&!same(row.to,p.to))return false;
    if(p.merchant){const id=merchants.identity(row.title);if(p.merchant.id?id?.id!==p.merchant.id:!(' '+norm(row.title)+' ').includes(' '+norm(p.merchant.text)+' '))return false;}
    if(p.amount){const {min,max,minInclusive,maxInclusive}=p.amount;if(min!=null&&(row.cents<cents(min)||!minInclusive&&row.cents===cents(min)))return false;if(max!=null&&(row.cents>cents(max)||!maxInclusive&&row.cents===cents(max)))return false;}
    if(p.status==='late'&&row.status!=='late'&&!(row.due&&row.date>row.due&&['card-payment','transaction'].includes(row.source)))return false;
    if(p.status==='unpaid'&&!['unpaid','late'].includes(row.status))return false;
    if(p.status==='paid'&&row.status!=='paid'&&!['transaction','card-payment'].includes(row.source))return false;
    if(p.status==='active'&&!row.active)return false;if(p.status==='ending'&&!row.trial)return false;
    if(p.billKind&&row.billKind!==p.billKind)return false;
    return true;
  }
  function group(rows,key){const map=new Map();for(const r of rows){const label=key(r)||'Other',g=map.get(label)||{label,cents:0,count:0};g.cents=add(g.cents,r.cents);g.count++;map.set(label,g);}return [...map.values()].sort((a,b)=>b.cents-a.cents||a.label.localeCompare(b.label));}
  function aggregate(rows){
    let totalCents=0,expenseCents=0,incomeCents=0,transferCents=0,largest=null;
    for(const r of rows){totalCents=add(totalCents,r.cents);if(r.source==='transaction'&&!r.pending){if(r.type==='expense')expenseCents=add(expenseCents,r.cents);if(r.type==='income')incomeCents=add(incomeCents,r.cents);}if(['account-transfer','goal-transfer'].includes(r.source))transferCents=add(transferCents,r.cents);if(!largest||r.cents>largest.cents)largest=r;}
    const payments=rows.filter(r=>!r.pending&&['transaction','card-payment'].includes(r.source));
    return {count:rows.length,totalCents,expenseCents,incomeCents,netCents:add(incomeCents,-expenseCents),transferCents,averageCents:rows.length?Math.round(totalCents/rows.length):0,largest,byCategory:group(rows,r=>r.category),byAccount:group(rows,r=>r.accountName),byMerchant:group(rows,r=>merchants.identity(r.title)?.canonical||r.title),paymentPerformance:{early:payments.filter(r=>r.due&&r.date<r.due).length,onTime:payments.filter(r=>r.due&&r.date===r.due).length,late:payments.filter(r=>r.due&&r.date>r.due).length}};
  }
  function monthlyCost(rows){let total=0,unsupported=0;for(const r of rows){if(!r.active||r.trial)continue;const factor={weekly:52/12,biweekly:26/12,monthly:1,quarterly:1/3,yearly:1/12}[r.frequency];if(factor==null){unsupported++;continue;}total=add(total,Math.round(r.cents*factor));}return {cents:total,unsupported,label:'Approximate monthly equivalent · schedule, not spending'};}
  function search(plan,data){
    if(plan.state!=='ready')return {state:plan.state,plan,rows:[],summary:null};
    let rows;
    switch(plan.source){case 'transfers':rows=data.transfers.filter(r=>r.source==='account-transfer'||r.source==='goal-transfer');break;case 'card-payments':rows=data.transfers.filter(r=>r.source==='card-payment');break;case 'bills':rows=data.definitions.filter(r=>r.source==='bill'&&r.active&&!r.trial);break;case 'subscriptions':rows=data.definitions.filter(r=>r.source==='subscription'&&r.active&&!r.trial);break;case 'trials':rows=data.definitions.filter(r=>r.trial);break;case 'statements':rows=data.statements;break;case 'bill-payments':rows=data.transactions.filter(r=>r.billId!=null&&!r.pending&&r.date<=data.today);break;default:rows=data.transactions.filter(r=>r.pending===!!plan.pending&&r.date<=data.today);}
    if(plan.source==='statements'&&rows.some(r=>r.uncertain&&matches(r,{...plan,status:null,amount:null}))){return {state:'clarify',plan:{...plan,state:'clarify',issues:['Legacy card payments or credits cannot be safely allocated from the stored snapshots. Review the existing card statement view.']},rows:[],summary:null};}
    rows=rows.filter(r=>(!['transfers','card-payments'].includes(plan.source)||r.date<=data.today)&&matches(r,plan)).slice().sort((a,b)=>plan.sort==='largest'?b.cents-a.cents||b.date.localeCompare(a.date):String(b.date||'').localeCompare(String(a.date||''))||(b.ts||0)-(a.ts||0)||String(b.id).localeCompare(String(a.id)));
    return {state:'ready',plan,rows,summary:aggregate(rows),monthly:plan.source==='subscriptions'?monthlyCost(rows):null,notes:plan.source==='statements'?['Stored statement snapshots only. Remaining principal excludes unbooked interest and fees.']:['bills','subscriptions','trials'].includes(plan.source)?['Schedules are not actual spending. Dates refer to the next recorded or calculated due/renewal event.']:plan.pending?['Pending transactions only; excluded from posted-spending totals.']:['Posted records only. Transfers and card repayments are not spending or income.']};
  }
  return Object.freeze({snapshot,search,matches,aggregate,group,monthlyCost,cents,scheduled,nextBill,subscriptionStatus});
});
