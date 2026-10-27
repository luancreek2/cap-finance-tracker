/* Phase 5A reminder intelligence. Pure: explicit local date, no clock/DOM/IO.
   Search owns recurrence/status/stored-statement projection; never cSum/save. */
(function(root,factory){const api=typeof module==='object'&&module.exports?factory(require('./financial-search-engine.js'),require('./financial-search-parser.js'),require('./smart-log-parser.js')):factory(root.CapFinancialSearchEngine,root.CapFinancialSearchParser,root.CapSmartLogParser);if(typeof module==='object'&&module.exports)module.exports=api;else root.CapNotificationEngine=api;})(typeof window==='undefined'?globalThis:window,function(search,query,dates){
  'use strict';
  const VERSION=1,DAYS=Object.freeze([0,1,2,3,5,7,14]);
  const DEFAULTS=Object.freeze({on:false,bills:true,billsD:3,renew:true,renewD:3,trial:true,trialD:3,card:true,cardD:5,overdue:true,showAmounts:false});
  const same=(a,b)=>a!=null&&b!=null&&String(a)===String(b),day=k=>{const [y,m,d]=k.split('-').map(Number);return new Date(y,m-1,d,12);};
  function preferences(raw={}){if(!raw||typeof raw!=='object'||Array.isArray(raw))raw={};const p={};for(const [k,v] of Object.entries(DEFAULTS))p[k]=k.endsWith('D')?raw[k]!=null&&raw[k]!==''&&DAYS.includes(Number(raw[k]))?Number(raw[k]):v:raw[k]==null?v:raw[k]===true||raw[k]===1||raw[k]==='1';return p;}
  function safeLabel(value){return String(value||'Tracked item').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/(?:\d[ -]?){4,}/g,'••••').trim().slice(0,100)||'Tracked item';}
  function amount(v,signed=false){if(v==null||v===''||typeof v==='boolean'||!Number.isFinite(+v)||!signed&&+v<0)return null;try{return search.cents(v)}catch(_){return null;}}
  function copyText(category,stage,label,cents,p,currency){
    const suffix=stage==='overdue'?'is overdue':stage==='today'?(category==='trial'?'ends today':'is due today'):(category==='trial'?'ends soon':category==='renew'?'renews soon':'is due soon');
    const title=category==='card'?'Credit card payment '+suffix:label+' '+suffix;
    let body=category==='trial'?'Review the recorded trial end date in Cap. No payment has been recorded by this reminder.':category==='renew'?'Review your recorded renewal in Cap. This reminder is not a charge or payment.':'Review the recorded due item in Cap. Seeing this reminder does not mark it paid.';
    if(p.showAmounts&&cents!=null){try{body+=' Recorded amount: '+new Intl.NumberFormat('en-PH',{style:'currency',currency:/^[A-Z]{3}$/.test(currency||'')?currency:'PHP'}).format(cents/100)+'.';}catch(_){}}
    return {title,body};
  }
  function evaluate(state,options={}){
    const today=options.today,p=preferences(options.preferences);if(!dates.validDate(today))throw Error('A valid local calendar date is required.');
    const candidates=[],issues=[],seen=new Set();if(!p.on)return {version:VERSION,today,preferences:p,candidates,issues};
    let data;try{data=search.snapshot(state,today);}catch(_){return {version:VERSION,today,preferences:p,candidates,issues:['Some records could not be safely projected. No reminders were inferred.']};}
    function append(source,id,due,category,label,amountCents,occurrence=due){
      if(id==null||!dates.validDate(due)||!p[category])return;
      const daysUntil=Math.round((day(due)-day(today))/864e5),lead=p[category+'D'];let stage,eligibleDate,reminderType;
      if(daysUntil<0){if(!p.overdue||!['bills','card'].includes(category))return;stage='overdue';eligibleDate=query.shift(due,1);reminderType='overdue';}
      else if(daysUntil===0){stage='today';eligibleDate=due;reminderType=category==='trial'?'trial-ends-today':'due-today';}
      else{if(!lead||daysUntil>lead)return;stage='upcoming';eligibleDate=query.shift(due,-lead);reminderType='before-'+lead+'-days';}
      const key=['cap-reminder-v1',source,encodeURIComponent(String(id)),occurrence,due,reminderType].join(':');if(seen.has(key))return;seen.add(key);
      const clean=category==='card'?'Credit card':safeLabel(label),copy=copyText(category,stage,clean,amountCents,p,state.cur);
      candidates.push({version:VERSION,id:key,deduplicationKey:key,tag:key,sourceType:source,sourceId:String(id),category,reminderType,dueDate:due,eligibleDate,occurrence,daysUntil,urgency:stage,title:copy.title,body:copy.body,amountCents,brandLabel:clean,target:{area:'home',surface:'notifications'},actionable:true});
    }
    for(const b of state.bills||[]){
      if(b.id==null||['Cancelled','Expired'].includes(b.subscriptionStatus))continue;
      // Legacy/manual card-payment definitions may mirror a tracked card. The
      // stored statement is the sole card obligation source, not a second bill.
      if(b.cardId!=null&&(state.accts||[]).some(a=>a.type==='credit'&&same(a.id,b.cardId)))continue;
      const r=data.definitions.find(r=>same(r.id,b.id));if(!r||!r.active||!dates.validDate(r.date)||r.status==='paid')continue;
      const paid=(b.paidOn||[]).includes(r.date)||((b.freq||'monthly')==='monthly'&&b.paid===r.date.slice(0,7));if(paid)continue;
      if(!['once','weekly','biweekly','monthly','quarterly','yearly'].includes(b.freq||'monthly')){issues.push('A schedule has an unsupported recurrence.');continue;}
      append(r.trial?'trial':r.source,b.id,r.date,r.trial?'trial':r.source==='subscription'?'renew':'bills',b.name,amount(b.amt));
    }
    for(const a of (state.accts||[]).filter(a=>a.type==='credit')){
      const balance=amount(a.bal,true),owed=balance==null?null:Math.max(0,balance);if(owed===0)continue;
      const latest=data.statements.filter(s=>same(s.account,a.id)&&s.id.slice(-10)<=today).sort((a,b)=>b.id.slice(-10).localeCompare(a.id.slice(-10)))[0];
      const original=(a.statementHistory||[]).find(h=>h.en===latest?.id.slice(-10));
      if(owed==null||!latest||latest.uncertain||!dates.validDate(latest.due)||amount(original?.balance,true)==null){issues.push('A card needs an unambiguous stored statement, due date and current balance before reminders can be shown.');continue;}
      const remaining=Math.min(owed,latest.cents);if(remaining<=0)continue;
      append('statement',a.id,latest.due,'card','Credit card',remaining,latest.id.slice(-10));
    }
    const priority={overdue:0,today:1,upcoming:2};candidates.sort((a,b)=>priority[a.urgency]-priority[b.urgency]||a.dueDate.localeCompare(b.dueDate)||a.id.localeCompare(b.id));
    return {version:VERSION,today,preferences:p,candidates,issues:[...new Set(issues)]};
  }
  return Object.freeze({VERSION,DAYS,DEFAULTS,preferences,evaluate,safeLabel});
});
