/* Local financial query grammar. Pure: the caller supplies today's local date
   and account/category/name vocabulary. No IO, execution or financial writes. */
(function(root,factory){const api=typeof module==='object'&&module.exports?factory(require('./smart-log-parser.js'),require('./smart-log-merchants.js')):factory(root.CapSmartLogParser,root.CapSmartLogMerchants);if(typeof module==='object'&&module.exports)module.exports=api;else root.CapFinancialSearchParser=api;})(typeof window==='undefined'?globalThis:window,function(log,merchants){
  'use strict';
  const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthPattern=months.map(m=>m.slice(0,3)+'(?:'+m.slice(3)+')?').join('|');
  const date=d=>log.localDate(d),day=s=>{const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d,12);};
  const shift=(s,n)=>{const d=day(s);d.setDate(d.getDate()+n);return date(d);};
  function parse(input,data={}){
    const original=String(input||'').trim(),p={version:1,original,state:'ready',source:'transactions',type:null,category:null,merchant:null,account:null,from:null,to:null,date:null,amount:null,status:null,pending:false,sort:'newest',metric:'total',chips:[],issues:[]};
    let work=original.toLowerCase().replace(/[’']/g,'');
    const issue=s=>{p.state='clarify';p.issues.push(s);};
    const take=(re,fn)=>{work=work.replace(re,(...args)=>{fn?.(...args);return ' ';});};
    if(!original||original.length>500){p.state='unknown';p.issues=['Enter a financial search of up to 500 characters.'];return p;}
    if(!log.validDate(data.today)){issue('A valid local date is required.');return p;}
    const now=day(data.today),year=now.getFullYear(),month=now.getMonth(),ranges=[];
    const range=(start,end,label)=>{if(!log.validDate(start)||!log.validDate(end)||start>end)issue('Choose a valid date range.');else ranges.push({start,end,label});};
    const monthRange=(m,y,label)=>range(date(new Date(y,m,1,12)),date(new Date(y,m+1,0,12)),label);
    const endpoint=s=>{
      s=s.trim().replace(/^(?:on\s+)/,'');
      if(log.validDate(s))return s;
      const m=new RegExp('^('+monthPattern+')\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?$','i').exec(s);
      return m?`${m[3]||year}-${String(months.findIndex(x=>x.startsWith(m[1].slice(0,3)))+1).padStart(2,'0')}-${m[2].padStart(2,'0')}`:null;
    };
    const ep='(?:\\d{4}-\\d{2}-\\d{2}|(?:'+monthPattern+')\\s+\\d{1,2}(?:,?\\s+\\d{4})?)';
    take(new RegExp('\\b(?:from|between)\\s+('+ep+')\\s+(?:to|through|and)\\s+('+ep+')\\b','g'),(_,a,b)=>range(endpoint(a),endpoint(b),a+' – '+b));
    take(/\b(today|yesterday|this week|last week|this month|last month|this year|last year)\b/g,phrase=>{
      if(phrase==='today'||phrase==='yesterday'){const d=shift(data.today,phrase==='today'?0:-1);range(d,d,phrase);}
      else if(phrase.endsWith('week')){const start=shift(data.today,-((now.getDay()+6)%7)-(phrase==='last week'?7:0));range(start,shift(start,6),phrase+' · Mon–Sun');}
      else if(phrase.endsWith('month'))monthRange(month-(phrase==='last month'?1:0),year,phrase);
      else{const y=year-(phrase==='last year'?1:0);range(y+'-01-01',y+'-12-31',phrase);}
    });
    take(/\b\d{4}-\d{1,2}-\d{1,2}\b/g,s=>range(s,s,s));
    take(new RegExp('\\b('+monthPattern+')\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b(?!\\d)','g'),(s,m,d,y)=>{const value=endpoint(s);range(value,value,s);});
    take(new RegExp('\\b('+monthPattern+')(?:\\s+(\\d{4}))?\\b','g'),(s,m,y)=>monthRange(months.findIndex(x=>x.startsWith(m.slice(0,3))),+(y||year),s+(y?'':' '+year)));
    if(ranges.length){const first=ranges[0];if(ranges.some(r=>r.start!==first.start||r.end!==first.end))issue('Use one date range per search.');p.date=first;}
    const money='(?:₱\\s*|\\bPHP\\s*|\\bP\\s*(?=\\d))?\\d[\\d,]*(?:\\.\\d+)?(?:\\s*k\\b)?';
    const amounts=[];
    take(new RegExp('\\bbetween\\s+('+money+')\\s+and\\s+('+money+')','gi'),(_,a,b)=>{const min=log.amountValue(a),max=log.amountValue(b);if(min==null||max==null||min>max)issue('Choose a valid amount range.');else amounts.push({min,max,minInclusive:true,maxInclusive:true});});
    take(new RegExp('\\b(over|above|greater than|under|below|less than|at least|at most)\\s+('+money+')','gi'),(_,op,raw)=>{const n=log.amountValue(raw);if(n==null)issue('Choose a valid positive amount.');else{const low=['over','above','greater than','at least'].includes(op);amounts.push(low?{min:n,minInclusive:op==='at least'}:{max:n,maxInclusive:op==='at most'});}});
    if(amounts.length>1)issue('Use one amount comparison or between range.');p.amount=amounts[0]||null;
    if(/\b(?:largest|biggest|highest)\b/.test(work)){p.sort='largest';p.metric='largest';take(/\b(?:largest|biggest|highest)\b/g);}
    if(/\bhow many\b/.test(work)){p.metric='count';take(/\bhow many\b/g);}
    const subscriptions=/\bsubscriptions?\b/.test(work),bills=/\bbills?\b/.test(work),trials=/\b(?:free )?trials?\b/.test(work),statements=/\bstatements?\b/.test(work),cardPayments=/\b(?:credit )?card payments?\b/.test(work);
    const expense=/\b(?:expenses?|spent|spend|spending|eat|ate)\b/.test(work),income=/\b(?:income|received|earned|salary)\b/.test(work),transfer=/\btransfers?\b/.test(work),payments=/\bpayments?|paid\b/.test(work)&&!/\bunpaid\b/.test(work);
    if(cardPayments)p.source='card-payments';else if(statements)p.source='statements';else if(trials)p.source='trials';else if(subscriptions&&!expense&&!payments)p.source='subscriptions';else if(bills&&!payments&&!expense)p.source='bills';else if((bills||subscriptions)&&(payments||expense))p.source='bill-payments';
    if(subscriptions&&(expense||payments))p.billKind='subscription';
    if(transfer){if(p.source!=='transactions')issue('Search one financial record type at a time.');p.source='transfers';}
    if(expense&&income)issue('Choose expenses or income, not both.');p.type=expense?'expense':income?'income':null;
    if(p.type&&p.source!=='transactions'&&p.source!=='bill-payments')issue('Spending and income filters apply to actual transactions, not schedules or transfers.');
    if(p.source==='bill-payments')p.type='expense';
    p.pending=/\bpending\b/.test(work);if(p.pending&&p.source!=='transactions')issue('Pending applies only to transactions.');
    if(/\b(?:unpaid|late|overdue|active|ending soon|paid)\b/.test(work)){
      p.status=/\bunpaid\b/.test(work)?'unpaid':/\blate|overdue\b/.test(work)?'late':/\bending soon\b/.test(work)?'ending':/\bactive\b/.test(work)?'active':'paid';
      if(p.source==='transactions'&&p.status!=='paid')issue('Use a bill, subscription, trial or statement search for that status.');
    }
    if(p.source==='trials'&&p.status==='ending'&&!p.date)p.date={start:data.today,end:shift(data.today,7),label:'Next 7 days'};
    // Remove only grammar, then resolve exact user vocabulary. Unknown residual
    // terms are not silently ignored: a partial interpretation is not an answer.
    take(/\b(?:credit card payments?|card payments?|free trials?|trials?|statements?|subscriptions?|bills?|transfers?|transactions?|expenses?|income|money received|received|earned|spent|spend|spending|payments?|unpaid|overdue|late|active|ending soon|pending|posted|paid)\b/g);
    const resolve=(q,key)=>{const r=log.resolveAccount(q,data.accounts||[]);if(r.state!=='resolved'){issue(r.state==='ambiguous'?'Choose one account for “'+q+'”: '+r.candidates.map(id=>(data.accounts||[]).find(a=>a.id===id)?.name).join(', '):'No saved account matches “'+q+'”.');}else{if(p[key]!=null&&String(p[key])!==String(r.value))issue('Choose one '+key+' account.');p[key]=r.value;}};
    const accountNames=(data.accounts||[]).flatMap(a=>[a.name,a.nickname,a.bank,...(a.aliases||[])].filter(Boolean)).sort((a,b)=>b.length-a.length);
    // Tagged accounts are resolved after dates and money have been consumed.
    take(/\b(using|from|to|with)\s+(.+?)(?=\b(?:using|from|to|with)\b|$)/g,(_,role,q)=>{
      q=q.trim().replace(/[?.,]+$/,'').trim();if(!q)return;
      resolve(q,p.source==='transfers'?(role==='to'?'to':'from'):'account');
    });
    const consumePhrase=(phrase,fn)=>{const target=norm(phrase),tokens=[...work.matchAll(/[a-z0-9]+/g)];for(let i=0;i<tokens.length;i++)for(let j=tokens.length-1;j>=i;j--){const a=tokens[i].index,b=tokens[j].index+tokens[j][0].length;if(norm(work.slice(a,b))===target){fn();work=work.slice(0,a)+' '.repeat(b-a)+work.slice(b);return true;}}return false;};
    for(const name of accountNames)consumePhrase(name,()=>resolve(name,'account'));
    const matched=merchants.match(work);
    if(matched){p.merchant={id:matched.rule.id,text:matched.rule.aliases[0]};consumePhrase(matched.alias,()=>{});}
    for(const cat of [...(data.categories||[])].sort((a,b)=>b.length-a.length))consumePhrase(cat,()=>{if(p.category&&p.category!==cat)issue('Choose one category.');p.category=cat;});
    // Existing local titles permit unknown-to-the-dictionary merchants/bills,
    // without adding another merchant dictionary or guessing new schema.
    const names=[...new Set(data.names||[])].filter(n=>norm(n).length>=2).sort((a,b)=>b.length-a.length);
    if(!p.merchant)for(const name of names)if(consumePhrase(name,()=>{p.merchant={id:null,text:name};}))break;
    if(!p.type&&p.source==='transactions'&&(p.category||p.merchant)&&!/\btransactions?\b/i.test(original))p.type=p.category&&norm(p.category)==='salary'?'income':'expense';
    take(/\b(?:how much|what was|what were|what did|did i|do i|my|me|i|show|find|list|all|the|total|amount|of|on|at|in|for|during|this|using|transactions|times|eat|ate|did|was|is|are|please|due)\b/g);
    const leftover=norm(work);
    if(leftover)issue('I couldn’t match “'+leftover+'”. Try a saved merchant/category, a date range or an amount filter.');
    const meaningful=p.source!=='transactions'||p.type||p.category||p.merchant||p.account!=null||p.date||p.amount||p.pending||/\btransactions?\b/.test(original.toLowerCase());
    if(!meaningful&&p.state==='ready'){p.state='unknown';p.issues=['I couldn’t match that search yet.'];}
    p.chips=[p.source==='transactions'?(p.type==='expense'?'Expense':p.type==='income'?'Income':'Transactions'):p.source.replace(/-/g,' '),p.pending?'Pending only':p.source==='transactions'?'Posted only':null,p.category,p.merchant?.text,
      ...['account','from','to'].filter(k=>p[k]!=null).map(k=>(k==='account'?'':k+' ')+(data.accounts||[]).find(a=>String(a.id)===String(p[k]))?.name),p.date?.label,p.status,
      p.amount?(p.amount.min!=null&&p.amount.max!=null?`${p.amount.min} – ${p.amount.max}`:p.amount.min!=null?`${p.amount.minInclusive?'≥':'>'} ₱${p.amount.min}`:`${p.amount.maxInclusive?'≤':'<'} ₱${p.amount.max}`):null,p.sort==='largest'?'Largest first':null].filter(Boolean);
    return p;
  }
  return Object.freeze({parse,norm,shift});
});
