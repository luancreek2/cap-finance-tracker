/* Cap Score: pure, local and read-only. Money is integer cents; ratios and
   scores use basis points. Search owns posted-event projection/aggregation.
   These are Cap heuristics, not credit/lending or professional ratings. */
(function(root,factory){const api=typeof module==='object'&&module.exports?factory(require('./financial-search-engine.js'),require('./smart-log-parser.js'),require('./financial-search-parser.js')):factory(root.CapFinancialSearchEngine,root.CapSmartLogParser,root.CapFinancialSearchParser);if(typeof module==='object'&&module.exports)module.exports=api;else root.CapFinancialHealthEngine=api;})(typeof window==='undefined'?globalThis:window,function(search,dates,query){
  'use strict';
  const FACTORS=Object.freeze([
    {id:'cashflow',name:'Savings / Cash Flow',weight:20},
    {id:'budget',name:'Budget Performance',weight:20},
    {id:'credit',name:'Credit Utilization',weight:20},
    {id:'obligations',name:'Upcoming Obligations',weight:15},
    {id:'debt',name:'Debt vs Available Cash',weight:15},
    {id:'emergency',name:'Emergency Fund Progress',weight:10}
  ].map(Object.freeze));
  const CURVES=Object.freeze({
    cashflow:Object.freeze([[-2000,0],[0,5000],[2000,10000]].map(Object.freeze)),
    budget:Object.freeze([[0,10000],[10000,0]].map(Object.freeze)),
    credit:Object.freeze([[0,10000],[3000,10000],[10000,0]].map(Object.freeze)),
    obligations:Object.freeze([[0,0],[10000,5000],[20000,10000]].map(Object.freeze)),
    debt:Object.freeze([[0,10000],[10000,5000],[20000,0]].map(Object.freeze)),
    emergency:Object.freeze([[0,0],[10000,10000]].map(Object.freeze))
  });
  const RULES=Object.freeze({minimumCoverage:60,minimumFactors:3,minimumActivitySpanDays:14,obligationDays:30,labels:Object.freeze([{min:80,label:'Strong'},{min:60,label:'Good'},{min:40,label:'Fair'},{min:0,label:'Needs Attention'}].map(Object.freeze))});
  const norm=query.norm,same=(a,b)=>a!=null&&b!=null&&String(a)===String(b);
  const day=s=>{const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d,12);};
  const sum=xs=>xs.reduce((a,b)=>{const n=a+b;if(!Number.isSafeInteger(n))throw Error('Amounts exceed the safe money range.');return n;},0);
  function money(v){if(v==null||v===''||!Number.isFinite(Number(v)))throw Error('A required amount is missing or invalid.');return search.cents(v);}
  function roundRatio(n,d){if(!Number.isSafeInteger(n)||!Number.isSafeInteger(d)||d<=0)throw Error('A ratio cannot be calculated safely.');const a=BigInt(n),b=BigInt(d),sign=a<0n?-1n:1n,result=sign*((sign*a+b/2n)/b);const value=Number(result);if(!Number.isSafeInteger(value))throw Error('A ratio exceeds the safe range.');return value;}
  function ratioBP(n,d){if(d<=0)throw Error('A positive denominator is required.');const a=BigInt(n)*10000n,b=BigInt(d),sign=a<0n?-1n:1n,result=sign*((sign*a+b/2n)/b),value=Number(result);if(!Number.isSafeInteger(value))throw Error('A ratio exceeds the safe range.');return value;}
  function curve(id,x){const points=CURVES[id];if(!Number.isSafeInteger(x))throw Error('Invalid metric.');if(x<=points[0][0])return points[0][1];for(let i=1;i<points.length;i++){const [a,sa]=points[i-1],[b,sb]=points[i];if(x<=b)return sa+roundRatio((x-a)*(sb-sa),b-a);}return points[points.length-1][1];}
  function period(today,offset=-1){if(!dates.validDate(today))throw Error('A valid local date is required.');const d=day(today),start=new Date(d.getFullYear(),d.getMonth()+offset,1,12),end=new Date(d.getFullYear(),d.getMonth()+offset+1,0,12);return {start:dates.localDate(start),end:dates.localDate(end),label:start.toLocaleDateString('en-PH',{month:'long',year:'numeric'})};}
  function activity(data,p){const rows=data.transactions.filter(t=>!t.pending&&t.date>=p.start&&t.date<=p.end&&t.date<=data.today),summary=search.aggregate(rows),days=[...new Set(rows.map(r=>r.date))].sort(),span=days.length?Math.round((day(days.at(-1))-day(days[0]))/864e5)+1:0;return {rows,summary,span,days:days.length};}
  function cashflow(data,p){if(!data)throw Error('Posted history could not be projected safely.');const a=activity(data,p),s=a.summary;if(!s.incomeCents||!s.expenseCents||a.span<RULES.minimumActivitySpanDays)throw Error('Needs posted income and expenses spanning at least 14 calendar days in this completed month.');const rateBP=ratioBP(s.netCents,s.incomeCents);return {scoreBP:curve('cashflow',rateBP),metric:{incomeCents:s.incomeCents,expenseCents:s.expenseCents,netCents:s.netCents,rateBP,activityDays:a.days,spanDays:a.span},reason:'Posted income minus posted expenses, divided by posted income. Transfers, pending activity, schedules and opening records are excluded.',rule:'−20% savings rate → 0; 0% → 50; +20% or higher → 100. Linear between points.'};}
  function liquid(state){
    const accounts=(state.accts||[]).filter(a=>['debit','ewallet'].includes(a.type));if(!accounts.length)throw Error('No liquid debit or e-wallet accounts are tracked.');
    const balances=accounts.map(a=>money(a.bal));
    const allocations=accounts.map(a=>sum((state.goals||[]).filter(g=>same(g.accountId,a.id)).map(g=>{const n=money(g.saved);if(n<0)throw Error('A goal allocation is invalid.');return n;})));
    if(allocations.some((n,i)=>n>0&&n>balances[i]))throw Error('Goal allocations exceed a linked account balance; available cash needs review.');
    return {balanceCents:sum(balances),allocatedCents:sum(allocations),availableCents:Math.max(0,sum(balances)-sum(allocations)),accounts:accounts.length};
  }
  function budget(state,data,p,categories){
    // S.budgets is a current category → amount map. Neither local nor cloud
    // records prove applicability to p. Never backdate today's configuration.
    throw Object.assign(Error('Cap stores current category limits, not effective months or historical budget snapshots. Budget performance for this completed month cannot be established. Today’s limits do not contribute to this score.'),{state:'Not Enough Historical Budget Data'});
  }
  function credit(state){const cards=(state.accts||[]).filter(a=>a.type==='credit');if(!cards.length)throw Error('No credit accounts are tracked; this is not a zero score.');const rows=cards.map(a=>{const limit=money(a.lim),balance=money(a.bal);if(limit<=0)throw Error('Every tracked credit card needs a valid positive limit.');return {id:a.id,name:a.name,limitCents:limit,usedCents:Math.max(0,balance)};});const usedCents=sum(rows.map(r=>r.usedCents)),limitCents=sum(rows.map(r=>r.limitCents)),utilizationBP=ratioBP(usedCents,limitCents);return {scoreBP:curve('credit',utilizationBP),metric:{usedCents,limitCents,remainingLimitCents:Math.max(0,limitCents-usedCents),utilizationBP,cards:rows.length,rows},reason:'Positive current credit balances are amounts owed. Prepaid negative balances count as zero used, not extra cash. Total used is divided by total limits, not an average of card percentages.',rule:'0–30% utilization → 100; then decreases linearly to 0 at 100% utilization. Above 100% → 0.'};}
  function outgoingDebts(state){const rows=(state.debts||[]).filter(d=>d.dir==='out'),cards=(state.accts||[]).filter(a=>a.type==='credit');return rows.map(d=>{const amount=money(d.amt);if(amount<0)throw Error('An outstanding IOU amount needs review.');const who=' '+norm(d.who)+' ';if(cards.some(a=>[a.name,a.nickname,a.bank].filter(Boolean).some(n=>norm(n).length>=3&&who.includes(' '+norm(n)+' '))))throw Error('An IOU may duplicate a tracked card liability. The debt model has no reliable linking field; review it before scoring.');return {id:d.id,title:d.who||'IOU',cents:amount,due:d.due||''};});}
  function debt(state){const cash=liquid(state),rows=outgoingDebts(state);if(!rows.length)throw Error('No outgoing IOUs are recorded. Absence is not proof of zero debt.');const debtCents=sum(rows.map(r=>r.cents));if(!cash.availableCents&&!debtCents)throw Error('No positive available cash for a debt ratio.');const debtBP=cash.availableCents?ratioBP(debtCents,cash.availableCents):null;return {scoreBP:debtBP==null?0:curve('debt',debtBP),metric:{...cash,debtCents,debtBP,count:rows.length,rows},reason:'Outstanding “I owe” IOUs only, compared with current liquid cash after all goal allocations. “Owed to me” is not cash. Card liabilities are analyzed separately under utilization, not added again here.',rule:'0% debt/cash → 100; 100% → 50; 200% or higher → 0. Positive debt with no available cash → 0.'};}
  function emergency(state){const goals=(state.goals||[]).filter(g=>norm(g.name)==='emergency fund');if(goals.length!==1)throw Error('Needs one uniquely named “Emergency Fund” goal linked to a real account. No other goal is reinterpreted.');const g=goals[0],a=(state.accts||[]).find(a=>same(a.id,g.accountId)&&['debit','ewallet'].includes(a.type));if(!a)throw Error('The Emergency Fund goal must be linked to a liquid account.');const savedCents=money(g.saved),targetCents=money(g.target),balanceCents=money(a.bal),allocatedCents=sum((state.goals||[]).filter(x=>same(x.accountId,a.id)).map(x=>{const n=money(x.saved);if(n<0)throw Error('A linked allocation needs review.');return n;}));if(savedCents<0||targetCents<=0||allocatedCents>balanceCents)throw Error('Emergency Fund target or backing allocations need review; progress is not invented.');const progressBP=ratioBP(savedCents,targetCents);return {scoreBP:curve('emergency',progressBP),metric:{goalId:g.id,goalName:g.name,accountName:a.name,savedCents,targetCents,balanceCents,allocatedCents,progressBP},reason:'Uses the saved allocation of the uniquely named Emergency Fund goal. All allocations must fit inside its linked account balance. The goal is not a second cash balance.',rule:'Saved allocation ÷ target × 100, bounded to 0–100.'};}
  function obligations(state,data,today){
    const cash=liquid(state),end=query.shift(today,RULES.obligationDays-1),rows=[],seen=new Set();if(!data)throw Error('Obligations could not be projected safely.');
    const push=r=>{if(!seen.has(r.key)){seen.add(r.key);rows.push(r);}};
    for(const b of state.bills||[]){
      if(['Cancelled','Expired'].includes(b.subscriptionStatus))continue;
      const a=(state.accts||[]).find(a=>same(a.id,b.acct));if(!a||!['debit','ewallet','credit'].includes(a.type))throw Error('A scheduled bill has no reliable payment account.');
      if(a.type==='credit')continue; // No immediate cash due; captured by card principal when billed.
      const amount=money(b.amt),freq=b.freq||'monthly';if(amount<0||!['once','weekly','biweekly','monthly','quarterly','yearly'].includes(freq)||(!dates.validDate(b.start)&&!(+b.due>=1&&+b.due<=31)))throw Error('A bill amount or schedule needs review.');
      const first=b.firstBillingDate||b.trialEndDate||b.start;if(b.isFreeTrial&&!dates.validDate(first))throw Error('A trial first-billing date is missing.');
      const isPaid=k=>(b.paidOn||[]).includes(k)||(freq==='monthly'&&b.paid===k.slice(0,7));
      const include=k=>{if(isPaid(k)||b.isFreeTrial&&k<first)return;push({key:'bill:'+b.id+':'+k,kind:'bill',id:b.id,title:b.name||'Bill',date:k,cents:amount});};
      const next=search.nextBill(b,today);if(next&&next<today)include(next); // One recorded oldest overdue event, not invented arrears.
      for(let i=0;i<RULES.obligationDays;i++){const key=query.shift(today,i);if(search.scheduled(b,key))include(key);}
    }
    const cards=(state.accts||[]).filter(a=>a.type==='credit');
    for(const a of cards){const owed=Math.max(0,money(a.bal));if(!owed)continue;
      const snapshots=data.statements.filter(s=>same(s.account,a.id)&&s.id.slice(-10)<=today).slice().sort((x,y)=>y.id.slice(-10).localeCompare(x.id.slice(-10))),latest=snapshots[0];
      if(!latest||latest.uncertain||!dates.validDate(latest.due))throw Error('An outstanding credit card needs a safely allocated stored statement and due date. Unbilled amounts and unbooked fees cannot be inferred.');
      money((a.statementHistory||[]).find(h=>h.en===latest.id.slice(-10))?.balance);
      const amount=Math.min(owed,latest.cents);if(amount&&latest.due<=end)push({key:'card:'+a.id,kind:'statement',id:a.id,title:a.name||'Card',date:latest.due,cents:amount});
    }
    for(const d of outgoingDebts(state))if(d.cents&&dates.validDate(d.due)&&d.due<=end)push({key:'debt:'+d.id,kind:'debt',id:d.id,title:d.title,date:d.due,cents:d.cents});
    if(!(state.bills||[]).length&&!cards.length&&!(state.debts||[]).some(d=>d.dir==='out'&&dates.validDate(d.due)))throw Error('No tracked obligation sources; absence is not proof of no obligations.');
    const totalCents=sum(rows.map(r=>r.cents));if(!totalCents)throw Error('No positive reliably identified dues in the next 30 days; no coverage ratio is scored.');const coverageBP=ratioBP(cash.availableCents,totalCents);
    return {scoreBP:curve('obligations',coverageBP),metric:{...cash,totalCents,coverageBP,start:today,end,count:rows.length,rows:rows.slice().sort((a,b)=>a.date.localeCompare(b.date))},reason:'Next 30 calendar days plus the identified overdue events. Includes liquid-account bills, supported first trial charges, latest stored card principal and dated outgoing IOUs. Credit-funded schedules are not added again; only the latest rolling statement is used. Unbooked fees and unbilled card charges are excluded.',rule:'0× available cash/dues → 0; 1× → 50; 2× or higher → 100. Linear between points.'};
  }
  function unavailable(def,reason,state='Not Enough Data'){return {...def,available:false,state,score:null,scoreBP:null,basePoints:null,metric:null,reason,rule:''};}
  function factor(def,fn){try{const r=fn();return {...def,...r,available:true,state:'Available',score:r.scoreBP/100,basePoints:roundRatio(r.scoreBP*def.weight,100)/100};}catch(error){return unavailable(def,error.message,error.state);}}
  function overall(factors){const available=factors.filter(f=>f.available),coverage=sum(available.map(f=>f.weight)),weighted=sum(available.map(f=>f.scoreBP*f.weight)),eligible=coverage>=RULES.minimumCoverage&&available.length>=RULES.minimumFactors&&available.some(f=>f.id==='cashflow');const score=eligible?roundRatio(weighted,coverage*100):null;return {score,label:score==null?'Building Your Cap Score':RULES.labels.find(l=>score>=l.min).label,coverage,availableFactors:available.length,availableWeight:coverage,earnedBasePoints:roundRatio(weighted,100)/100,numeric:eligible};}
  function calculate(state,options={}){
    const today=options.today;if(!dates.validDate(today))throw Error('Supply a valid local date.');const p=period(today),previous=period(today,-2),categories=options.categories||(state.cats||[]).map(c=>c.n);let data=null;try{data=search.snapshot(state,today,categories);}catch(_){}
    const jobs={cashflow:()=>cashflow(data,p),budget:()=>budget(state,data,p,categories),credit:()=>credit(state),obligations:()=>obligations(state,data,today),debt:()=>debt(state),emergency:()=>emergency(state)};
    const factors=FACTORS.map(def=>factor(def,jobs[def.id])),result=overall(factors);let comparison=null;
    try{const current=factors.find(f=>f.id==='cashflow'),past=cashflow(data,previous);if(current.available)comparison={factorId:'cashflow',previousPeriod:previous,currentPeriod:p,previousScore:past.scoreBP/100,currentScore:current.score,deltaPoints:(current.scoreBP-past.scoreBP)/100,previousRateBP:past.metric.rateBP,currentRateBP:current.metric.rateBP,explanation:'Cash-flow factor comparison only, not a change in the overall Cap Score. Historical account balances, budgets, IOUs and goal allocations are not reconstructed.'};}catch(_){}
    return {version:1,asOf:today,period:p,previousPeriod:previous,...result,factors,comparison,coverageExplanation:'Available weights are renormalized to 100. Missing data contributes neither zero nor full points. A numeric score requires 60% available weight, at least three factors, and posted income plus expenses spanning 14 calendar days in the completed month.',historyExplanation:'No historical overall Cap Score is invented or stored. Only comparable cash-flow factor periods can be derived from posted history.',disclaimer:'Cap Score is an internal indicator of your tracked data, not a credit score, lending score, professional rating, prediction or investment advice.'};
  }
  return Object.freeze({calculate,FACTORS,CURVES,RULES,curve,overall,period,liquid,ratioBP});
});
