/* Smart Log V1: pure, local rules. The caller supplies a snapshot and local date.
   No DOM, clock, persistence, network, accounting, or execution in this module. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.CapSmartLogParser=api;})(typeof window==='undefined'?globalThis:window,function(root){
  'use strict';
  const merchants=(typeof module==='object'&&module.exports)?require('./smart-log-merchants.js'):root.CapSmartLogMerchants;
  const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const compact=s=>norm(s).replace(/ /g,'');
  const field=(value=null,state='missing',candidates=[],reason='')=>({value,state,candidates,reason});
  const words=s=>[...s.matchAll(/[\p{L}\p{N}]+/gu)].map(m=>({text:m[0],start:m.index,end:m.index+m[0].length}));
  const unique=xs=>[...new Set(xs)];
  function validDate(s){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(s||''))return false;
    const [y,m,d]=s.split('-').map(Number),x=new Date(y,m-1,d,12);
    return y>=1900&&y<=9999&&x.getFullYear()===y&&x.getMonth()===m-1&&x.getDate()===d;
  }
  function localDate(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
  function validTime(s){return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(s||''))}
  function localTime(d){return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
  function timeLabel(s){if(!validTime(s))return '';const [h,m]=s.split(':').map(Number),ap=h<12?'AM':'PM';return `${h%12||12}:${String(m).padStart(2,'0')} ${ap}`;}
  function amountValue(raw){
    const s=String(raw||'').trim().replace(/^(?:PHP|₱|P)\s*/i,'').replace(/\s+k$/i,'k');
    if(!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?k?$/i.test(s))return null;
    const n=Number(s.replace(/,/g,'').replace(/k$/i,''))*(/k$/i.test(s)?1000:1);
    return n>0&&Number.isFinite(n)&&Number.isSafeInteger(Math.round(n*100))?Math.round(n*100)/100:null;
  }
  function accountRank(query,a){
    const q=norm(query),c=compact(query);if(!q)return 0;
    if([a.name,a.nickname].some(s=>s&&compact(s)===c))return 3;
    const aliases=[a.bank,...(Array.isArray(a.aliases)?a.aliases:[])];
    if(aliases.some(s=>s&&compact(s)===c))return 2;
    if(c.length<3)return 0;
    const names=[a.name,a.nickname,a.bank].filter(Boolean).map(norm);
    if(names.some(s=>(' '+s+' ').includes(' '+q+' ')||compact(s).startsWith(c)))return 1;
    // Type-qualified bank shorthand (e.g. BDO debit) can disambiguate actual cards.
    const type=a.type==='credit'?'credit':a.type==='ewallet'?'ewallet wallet':'debit savings cash';
    const parts=q.split(' '),base=parts.filter(p=>!type.split(' ').includes(p)).join(' ');
    return base&&base!==q&&names.some(s=>(' '+s+' ').includes(' '+base+' '))?1:0;
  }
  function resolveAccount(query,accounts){
    const numbered=accounts.filter(a=>a.l4&&[a.name,a.bank,a.nickname].filter(Boolean).some(n=>compact(query)===compact(n+' '+a.l4)));
    if(numbered.length){const ids=numbered.map(a=>a.id);return ids.length===1?field(ids[0],'resolved',ids):field(null,'ambiguous',ids,'Account needs confirmation');}
    const ending=String(query).match(/\b(?:ending(?:\s+in)?|last\s*(?:four|4))\s*(\d{4})\b/i);
    const q=ending?query.replace(ending[0],''):query;
    const ranked=accounts.map(a=>({a,r:accountRank(q,a)})).filter(x=>x.r&&(!ending||String(x.a.l4)===ending[1]));
    const best=Math.max(0,...ranked.map(x=>x.r)),ids=unique(ranked.filter(x=>x.r===best).map(x=>x.a.id));
    return ids.length===1?field(ids[0],'resolved',ids):field(null,ids.length?'ambiguous':'missing',ids,'Account needs confirmation');
  }
  function mentions(text,accounts){
    const tokens=words(text),found=[];
    for(let i=0;i<tokens.length;i++)for(let j=i;j<Math.min(tokens.length,i+8);j++){
      const s=tokens[i].start,e=tokens[j].end,q=text.slice(s,e);
      // Do not extend a name match across an amount or structural token.
      if(j>i&&/\b(?:using|from|to|at|in|with|today|yesterday)\b/i.test(q))break;
      const r=resolveAccount(q,accounts);if(r.candidates.length)found.push({start:s,end:e,query:q,...r});
      for(const a of accounts)if(a.l4&&[a.name,a.bank,a.nickname].filter(Boolean).some(n=>compact(q)===compact(n+' '+a.l4)))found.push({start:s,end:e,query:q,...field(a.id,'resolved',[a.id])});
    }
    found.sort((a,b)=>(b.end-b.start)-(a.end-a.start)||a.start-b.start);
    const out=[];for(const f of found)if(!out.some(x=>f.start<x.end&&f.end>x.start))out.push(f);
    return out.sort((a,b)=>a.start-b.start);
  }
  const categoryRules=[
    [/\b(grocer(?:y|ies)|supermarket|puregold|savemore|s&r|landers)\b/i,['Groceries','Food']],
    [/\b(jollibee|mcdonalds?|mcdo|kfc|restaurant|coffee|starbucks|lunch|dinner|breakfast|food)\b/i,['Food','Dining','Dining Out','Restaurants']],
    [/\b(grab|angkas|taxi|jeep|bus|fare|transport)\b/i,['Transport','Transportation']],
    [/\b(salary|payroll|wages)\b/i,['Salary','Income']],
    [/\b(pharmacy|medicine|watsons|hospital)\b/i,['Health','Healthcare']],
  ];
  function categoryFor(title,type,categories,history){
    const allowed=new Set(categories),merchant=norm(title),matched=merchants?merchants.match(title):null;
    const family=new Set(matched&&merchants?merchants.aliasesFor(matched.rule):[]);
    const hits=history.filter(t=>{const note=norm(t.note);return note&&(note===merchant||family.has(note))&&!t.parentId&&!t.cardFee&&allowed.has(t.cat)&&(type==='income'?t.amt>0:t.amt<0)})
      .slice().sort((a,b)=>String(b.d||'').localeCompare(String(a.d||''))||(+b.ts||+b.id||0)-(+a.ts||+a.id||0));
    if(hits.length){
      const count=new Map();hits.forEach(t=>count.set(t.cat,(count.get(t.cat)||0)+1));
      const sorted=[...count].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
      const recent=hits.slice(0,3);
      if(sorted.length===1)return field(sorted[0][0],'inferred',[],'From merchant history');
      if(recent.length===3&&recent.every(t=>t.cat===recent[0].cat))return field(recent[0].cat,'inferred',[],'From recent consistent history');
      if(sorted[0][1]>=2&&sorted[0][1]>sorted[1][1]&&sorted[0][1]/hits.length>=2/3)return field(sorted[0][0],'inferred',[],'From consistent merchant history');
      return field(null,'ambiguous',sorted.map(x=>x[0]),'Category needs confirmation: conflicting merchant history');
    }
    // Known merchant families sit between reliable history and general keywords.
    // Ambiguous families (e.g. plain Grab) stop here instead of guessing.
    const suggestion=matched&&merchants?merchants.suggest(matched,title,categories):{state:'none'};
    if(suggestion.state==='resolved')return field(suggestion.value,'inferred',[],suggestion.reason);
    if(suggestion.state==='ambiguous')return field(null,'ambiguous',suggestion.candidates,suggestion.reason);
    for(const [pattern,names] of categoryRules)if(pattern.test(title)){
      const name=names.map(n=>categories.find(c=>norm(c)===norm(n))).find(Boolean);
      if(name)return field(name,'inferred',[],'From a local keyword rule');
    }
    return field(null,'missing',[],'Category needs confirmation');
  }
  const vocabulary=Object.freeze({expense:/\b(spent|paid|bought|purchase[d]?|expense)\b/i,income:/\b(received|earned|salary|income|deposit|payroll|wages)\b/i,transfer:/\b(transfer(?:red)?|move[d]?)\b/i});
  function parse(sentence,data={}){
    const original=String(sentence||'').trim(),accounts=data.accounts||[],categories=unique(data.categories||[]),history=data.history||[];
    const f={type:field(),amount:field(),title:field(),category:field(),account:field(),from:field(),to:field(),date:field(),time:field(),description:field('','resolved')};
    const draft={version:1,original,kind:'draft',fields:f,issues:[]};
    let text=original.slice(0,1000),work=text;
    const mask=(start,end)=>{work=work.slice(0,start)+' '.repeat(end-start)+work.slice(end)};
    const desc=/\b(?:description|desc|note)\s*:\s*(.*)$/i.exec(work);
    if(desc){f.description=field(desc[1].trim(),'resolved');mask(desc.index,work.length);text=work;}
    if(!original||original.length>1000){draft.issues.push('Enter a transaction sentence of up to 1,000 characters.');return draft;}
    if(/\?|^\s*(?:how|what|when|where|which|why|show|find|search|list|tell|compare|total|balance|did\s+i|do\s+i|can\s+i)\b/i.test(text)){
      draft.kind='query';draft.issues.push('This looks like a search.');return draft;
    }
    const knownBill=(data.bills||[]).some(b=>norm(b.name).length>=3&&(' '+norm(text)+' ').includes(' '+norm(b.name)+' '));
    const knownDebt=(data.debts||[]).some(d=>norm(d.who).length>=3&&(' '+norm(text)+' ').includes(' '+norm(d.who)+' '));
    const manualOnly=/\b(?:cash\s*advance|withdrawal|refund|installment|usd|eur|jpy|gbp|sgd|dollars?|euros?|yen)\b|[$€£¥]/i.test(text);
    if(manualOnly||/\b(?:bill|subscription|statement|credit\s*card\s*payment|card\s*payment|debt|repayment|loan\s*payment|goal\s*(?:contribution|withdrawal|allocation))s?\b/i.test(text)||knownBill||knownDebt&&/\b(?:pay|paid|repay|settle)\b/i.test(text)){
      draft.kind='specialized';draft.workflow=manualOnly?'manual':/card|statement/i.test(text)?'accounts':'plan';
      draft.issues.push(manualOnly?'Use Manual New Entry to review this operation and its accounting options.':'Use the existing bill, subscription, card payment, debt or goal workflow for this operation.');return draft;
    }
    // Consume explicit clock times before amounts/dates so "7:30" never becomes money.
    const times=[];
    for(const m of work.matchAll(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)){
      const h=+m[1],min=m[2]?+m[2]:0;if(h<1||h>12||min>59)continue;
      times.push(String(h%12+(/pm/i.test(m[3])?12:0)).padStart(2,'0')+':'+String(min).padStart(2,'0'));mask(m.index,m.index+m[0].length);
    }
    for(const m of work.matchAll(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/g)){
      times.push(String(+m[1]).padStart(2,'0')+':'+m[2]);mask(m.index,m.index+m[0].length);
    }
    for(const m of work.matchAll(/\b(?:noon|midnight)\b/gi)){
      times.push(/noon/i.test(m[0])?'12:00':'00:00');mask(m.index,m.index+m[0].length);
    }
    if(times.length){const values=unique(times);f.time=values.length===1?field(values[0],'resolved'):field(null,'ambiguous',values,'Time needs confirmation');}
    else if(validTime(data.nowTime))f.time=field(data.nowTime,'defaulted',[],'Current time');
    const types=Object.entries(vocabulary).filter(([,r])=>r.test(text)).map(([k])=>k);
    if(types.includes('transfer')&&types.length>1&&/\b(?:spent|paid|bought|purchased?|received|earned)\b/i.test(text))f.type=field(null,'ambiguous',types,'Type needs confirmation; review one operation at a time');
    else if(types.includes('transfer'))f.type=field('transfer','resolved');
    else if(types.length===1)f.type=field(types[0],'resolved');
    else if(types.length>1)f.type=field(null,'ambiguous',types,'Type needs confirmation');

    // Consume dates before looking for amounts, including malformed date-shaped text.
    const dates=[],dateSpans=[];
    const addDate=(match,value)=>{dates.push(value);dateSpans.push([match.index,match.index+match[0].length]);};
    for(const m of work.matchAll(/\b\d{4}-\d{1,2}-\d{1,2}\b/g)){
      const [y,mo,d]=m[0].split('-');addDate(m,`${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`);
    }
    for(const m of work.matchAll(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g)){
      const [a,b,y]=m[0].split('/').map(Number);let mo=null,d=null;
      if(a<=12&&b>12){mo=a;d=b}else if(a>12&&b<=12){mo=b;d=a}
      addDate(m,mo?`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`:null);
    }
    const months='Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
    const monthNum=s=>['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(s.slice(0,3).toLowerCase())+1;
    for(const m of work.matchAll(new RegExp('\\b('+months+')\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:[,]?\\s+(\\d{4}))?\\b','gi')))addDate(m,`${m[3]||String(data.today||'').slice(0,4)}-${String(monthNum(m[1])).padStart(2,'0')}-${m[2].padStart(2,'0')}`);
    for(const m of work.matchAll(new RegExp('\\b(\\d{1,2})\\s+('+months+')(?:[,]?\\s+(\\d{4}))?\\b','gi')))addDate(m,`${m[3]||String(data.today||'').slice(0,4)}-${String(monthNum(m[2])).padStart(2,'0')}-${m[1].padStart(2,'0')}`);
    for(const m of work.matchAll(/\b(today|yesterday)\b/gi)){
      let value=data.today;
      if(validDate(value)&&m[1].toLowerCase()==='yesterday'){const [y,mo,d]=value.split('-').map(Number);value=localDate(new Date(y,mo-1,d-1,12));}
      addDate(m,value);
    }
    dateSpans.forEach(([a,b])=>{const prefix=/\bon\s*$/i.exec(work.slice(0,a));mask(prefix?prefix.index:a,b)});
    if(dates.length){const values=unique(dates);f.date=values.length===1&&validDate(values[0])?field(values[0],'resolved'):field(null,'ambiguous',values.filter(validDate),'Date needs confirmation; use YYYY-MM-DD or Month D, YYYY.');}
    else f.date=validDate(data.today)?field(data.today,'defaulted',[],'Today (local calendar)'):field();
    for(const m of work.matchAll(/\b(?:\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?|\d{1,2}\/\d{1,2})\b/g)){
      mask(m.index,m.index+m[0].length);f.date=field(null,'ambiguous',[],'Choose a complete, unambiguous transaction date.');
    }
    // Account names/last-four references cannot contribute amount candidates.
    const found=mentions(work,accounts);
    found.forEach(m=>mask(m.start,m.end));
    const lastFour=[];
    for(const m of work.matchAll(/\b(?:ending(?:\s+in)?|last\s*(?:four|4)|card\s*(?:number|no\.?))\s*\d{4}\b/gi)){lastFour.push(m);mask(m.index,m.index+m[0].length);}
    for(const m of work.matchAll(/\b(?:year|during|in|for)\s+(?:19|20)\d{2}\b/gi)){mask(m.index,m.index+m[0].length);f.date=field(null,'ambiguous',[],'Choose a complete transaction date, not only a year.');}
    const amounts=[];
    for(const m of work.matchAll(/(?:₱\s*|\bPHP\s*|\bP\s*(?=\d))?(?:\d[\d,]*(?:\.\d+)?)(?:\s*k\b)?/gi)){
      const before=work[m.index-1]||'',after=work[m.index+m[0].length]||'';
      if(/[\p{L}\p{N}]/u.test(before)||/[\p{L}\p{N}]/u.test(after)||after==='%')continue;
      const value=before==='-'?null:amountValue(m[0]);amounts.push({value,raw:m[0],start:m.index});mask(before==='-'?m.index-1:m.index,m.index+m[0].length);
    }
    if(amounts.length===1&&amounts[0].value!=null)f.amount=field(amounts[0].value,'resolved');
    else if(amounts.length)f.amount=field(null,'ambiguous',unique(amounts.map(a=>a.value).filter(x=>x!=null)),'Amount needs confirmation; choose or edit an amount.');

    // Explicit categories outrank history and dictionary suggestions.
    const explicit=[];
    const merchantSpans=[...work.matchAll(/\bat\s+(.+?)(?=\b(?:using|from|to)\b|$)/gi)].map(m=>({start:m.index+3,end:m.index+m[0].length}));
    for(const cat of categories){
      const tokens=words(work);for(let i=0;i<tokens.length;i++)for(let j=i;j<Math.min(tokens.length,i+5);j++){
        const tagged=/\bcategory\s*[:=]?\s*$/i.exec(work.slice(0,tokens[i].start));
        const afterAmount=amounts.length&&tokens[i].start>amounts[0].start&&!merchantSpans.some(s=>tokens[i].start>=s.start&&tokens[j].end<=s.end);
        if((tagged||afterAmount)&&compact(work.slice(tokens[i].start,tokens[j].end))===compact(cat))explicit.push({cat,start:tagged?tagged.index:tokens[i].start,end:tokens[j].end});
      }
    }
    explicit.sort((a,b)=>(b.end-b.start)-(a.end-a.start));const selected=[];
    for(const m of explicit)if(!selected.some(s=>m.start<s.end&&m.end>s.start))selected.push(m);
    selected.forEach(m=>mask(m.start,m.end));const cats=unique(selected.map(x=>x.cat));
    if(cats.length===1)f.category=field(cats[0],'resolved',[],'Explicit category');else if(cats.length)f.category=field(null,'ambiguous',cats,'Category needs confirmation');

    // Resolve tagged phrases from text with amounts/dates/categories removed but
    // account names restored. Bare names are resolved by the same exact/alias/partial rules.
    let refs=work;found.forEach(m=>{refs=refs.slice(0,m.start)+text.slice(m.start,m.end)+refs.slice(m.end)});
    lastFour.forEach(m=>{refs=refs.slice(0,m.index)+m[0]+refs.slice(m.index+m[0].length)});
    const refsFound=[];
    const pattern=/\b(using|from|to|in|with)\s+(.+?)(?=\b(?:using|from|to|in|with|at|on)\b|$)/gi;
    for(const m of refs.matchAll(pattern)){
      const q=m[2].trim();if(!q)continue;
      const role=m[1].toLowerCase(),resolved=resolveAccount(q,accounts);
      if(['in','with'].includes(role)&&!resolved.candidates.length&&f.type.value!=='income')continue;
      refsFound.push({role,...resolved});mask(m.index,m.index+m[0].length);
    }
    const combine=list=>{
      if(!list.length)return field(null,'missing',[],'Account needs confirmation');
      const ids=unique(list.flatMap(m=>m.candidates)),resolved=list.every(m=>m.value!=null);
      return resolved&&ids.length===1?field(ids[0],'resolved',ids):field(null,ids.length?'ambiguous':'missing',ids,'Account needs confirmation');
    };
    if(f.type.value==='transfer'){
      f.from=combine(refsFound.filter(m=>m.role==='from'));f.to=combine(refsFound.filter(m=>m.role==='to'));
      if(f.from.value!=null&&f.from.value===f.to.value){f.to=field(null,'ambiguous',[],'Choose different source and destination accounts');}
      if([f.from,f.to].some(x=>accounts.find(a=>a.id===x.value)?.type==='credit')){
        draft.kind='specialized';draft.workflow='accounts';draft.issues.push('Use the existing credit-card payment workflow, not a generic transfer.');return draft;
      }
    }else f.account=combine(refsFound.length?refsFound:found);
    if(accounts.some(a=>a.type==='credit'&&(a.id===f.account.value||a.id===f.to.value))&&/\b(?:pay|paid|payment|settle|repay)\b/i.test(text)&&!/\bat\s+\p{L}/iu.test(text)){
      draft.kind='specialized';draft.workflow='accounts';draft.issues.push('Use the existing credit-card payment workflow.');return draft;
    }
    let title=work.trim().replace(/^(?:(?:i\s+)?(?:spent|paid|bought|purchased?|expense|received|earned|income|deposit|transfer(?:red)?|moved?)\b[\s,:;]*)+/i,'')
      .replace(/^(?:at|on|for|category)\b\s*/i,'').replace(/^[\s,:;–—-]+|[\s,:;–—-]+$/g,'').replace(/\s+/g,' ').trim();
    if(f.type.value==='transfer')title=title||'Account Transfer';
    if(!title&&cats.length===1)title=cats[0];
    if(title&&/[\p{L}]/u.test(title))f.title=field(title,'resolved');
    if(!types.length&&f.title.value&&f.amount.value&&(f.account.candidates.length||refsFound.length))f.type=field('expense','inferred',[],'Merchant + amount + account receipt pattern');
    if(f.type.value==='transfer')f.category=field(null,'not-applicable');
    else if(!cats.length)f.category=categoryFor(f.title.value,f.type.value,categories,history);
    for(const key of ['type','amount','title','date',...(f.type.value==='transfer'?['from','to']:['account','category'])])if(f[key].value==null)draft.issues.push(f[key].reason||key[0].toUpperCase()+key.slice(1)+' needs confirmation');
    return draft;
  }
  function validate(draft,data){
    const f=draft.fields||{},v=k=>f[k]?.value,errors=[];
    if(draft.kind!=='draft')return ['Use the appropriate existing workflow.'];
    if(!['expense','income','transfer'].includes(v('type')))errors.push('Choose a type');
    if(!(v('amount')>0)||!Number.isSafeInteger(Math.round(v('amount')*100))||Math.abs(v('amount')*100-Math.round(v('amount')*100))>0.00001)errors.push('Choose a positive amount with at most two decimal places');
    if(!String(v('title')||'').trim())errors.push('Enter a title');if(!validDate(v('date')))errors.push('Choose a valid date');
    if(v('time')&&!validTime(v('time')))errors.push('Choose a valid time');
    if(f.time?.state==='ambiguous')errors.push('Resolve Time in Edit Transaction');
    // Required unresolved states must not be bypassed by a stale candidate value.
    for(const key of ['type','amount','title','date',...(v('type')==='transfer'?['from','to']:['account','category'])]){
      if(v(key)!=null&&['ambiguous','missing'].includes(f[key]?.state))errors.push('Resolve '+key);
    }
    if(String(v('description')||'').length>300)errors.push('Description must be 300 characters or fewer');
    const account=id=>(data.accounts||[]).find(a=>String(a.id)===String(id));
    if(v('type')==='transfer'){
      const a=account(v('from')),b=account(v('to'));
      if(!a||!b||!['debit','ewallet'].includes(a.type)||!['debit','ewallet'].includes(b.type))errors.push('Choose source and destination debit or e-wallet accounts');
      if(a&&b&&a.id===b.id)errors.push('Choose different source and destination accounts');
      if([v('title'),v('description')].filter(Boolean).join(' · ').length>100)errors.push('Transfer title and description must total 100 characters or fewer');
    }else{
      if(!account(v('account')))errors.push('Choose account');
      if(!(data.categories||[]).includes(v('category')))errors.push('Choose category');
    }
    return errors;
  }
  return Object.freeze({parse,validate,resolveAccount,amountValue,validDate,localDate,validTime,localTime,timeLabel,vocabulary});
});
