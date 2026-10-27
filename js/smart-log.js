/* Smart Log UI and form adapter. The parser only builds drafts. Confirmation
   uses the ACTUAL existing manual forms and save functions, never a second ledger. */
(function(){
  'use strict';
  const parser=window.CapSmartLogParser,bar=window.CapCommandBar,root=document.getElementById('cap-command-bar'),input=document.getElementById('cap-command-input');
  if(!parser||!bar||!root)return;
  const panel=document.createElement('section');panel.className='sl-preview';panel.hidden=true;panel.setAttribute('aria-label','Transaction Preview');root.appendChild(panel);
  let draft=null,busy=false,session=null,editing=false,picker=null,pickerAnchor=null,pickerDetach=null,pickerOutside=null,pickerKey=null,sourceText='';
  let reviewRevision=0;
  const CHEV='<svg class="ps-chev" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
  const CARDS='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="15" height="11" rx="2.5" transform="rotate(-8 3 7)"/><rect x="7" y="9" width="14" height="11" rx="2.5"/></svg>';
  const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTHS_LONG=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const value=k=>draft?.fields[k]?.value;
  const active=()=>['open','opening'].includes(bar.getState().state)&&bar.getState().mode==='log';
  function data(){return{today:parser.localDate(new Date()),nowTime:parser.localTime(new Date()),accounts:S.accts,categories:catNames(),history:S.tx,bills:S.bills,debts:S.debts};}
  function place(){
    const layout=bar.getPlacement(),vv=window.visualViewport,top=layout?.visibleTop??vv?.offsetTop??0,available=Math.max(48,(layout?.top??root.getBoundingClientRect().top)-top-12);
    panel.style.maxHeight=available+'px';
    // Keep the focused editor field inside its own scroller, never scroll the page.
    const field=document.activeElement;
    if(editing&&!panel.hidden&&panel.contains(field)&&field.matches('input,select,textarea')){
      const p=panel.getBoundingClientRect(),f=field.getBoundingClientRect();
      if(f.bottom>p.bottom-12)panel.scrollTop+=f.bottom-p.bottom+12;
      else if(f.top<p.top+12)panel.scrollTop-=p.top+12-f.top;
    }
  }
  function eligibleAccounts(){const transfer=value('type')==='transfer';return data().accounts.filter(a=>!transfer||['debit','ewallet'].includes(a.type));}
  function previousDate(iso){const [y,m,d]=iso.split('-').map(Number);return parser.localDate(new Date(y,m-1,d-1,12));}
  function dateInfo(iso){
    if(!iso||!parser.validDate(iso))return null;
    const [y,m,d]=iso.split('-').map(Number),today=data().today;
    const relative=iso===today?'Today':iso===previousDate(today)?'Yesterday':'';
    return {relative,full:`${MONTHS[m-1]} ${d}, ${y}`,long:`${MONTHS_LONG[m-1]} ${d}, ${y}`};
  }
  function typeName(){return value('type')==='income'?'Income':value('type')==='transfer'?'Transfer':value('type')==='expense'?'Expense':'';}
  function missingFields(){
    const f=draft.fields,out=[];
    if(f.type.value==null)out.push('Transaction Type');
    if(f.amount.value==null)out.push('Amount');
    if(!f.title.value)out.push('Title');
    if(f.type.value==='transfer'){
      if(f.from.value==null)out.push('Source Account');
      if(f.to.value==null)out.push('Destination Account');
    }else{
      if(f.account.value==null)out.push('Account');
      if(f.category.value==null)out.push('Category');
    }
    if(f.date.value==null)out.push('Date');
    if(f.time.state==='ambiguous')out.push('Time');
    return out;
  }
  const RECEIPT='<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h14v22l-3-2-4 2-4-2-3 2V5Z"/><path d="M13 11h6M13 15h6M13 19h4"/></svg>';
  /* Original soft ribbon foil, echoing a premium paper receipt without copying
     the reference composition. Theme-aware because it paints with currentColor. */
  const FOIL='<svg viewBox="0 0 240 172" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="sl-foil-a" x1="76" y1="4" x2="222" y2="158" gradientUnits="userSpaceOnUse"><stop stop-color="currentColor" stop-opacity=".16"/><stop offset=".55" stop-color="currentColor" stop-opacity=".05"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient><linearGradient id="sl-foil-b" x1="112" y1="0" x2="240" y2="130" gradientUnits="userSpaceOnUse"><stop stop-color="currentColor" stop-opacity=".1"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><path d="M240 0H154c-7 19 4 33 25 39 26 7 40 22 35 41-4 16 5 28 26 33V0Z" fill="url(#sl-foil-a)"/><path d="M240 22c-27 0-48 8-63 22-13 12-9 24 9 30 19 7 25 18 17 31-6 10-1 19 14 24" stroke="currentColor" stroke-opacity=".13" stroke-width="1.4" stroke-linecap="round"/><path d="M240 53c-21 2-36 9-46 19-9 9-6 17 7 22 12 4 16 12 11 21" stroke="currentColor" stroke-opacity=".1" stroke-width="1.1" stroke-linecap="round"/><path d="M136 0c-5 18 5 30 24 35" stroke="url(#sl-foil-b)" stroke-width="1.2" stroke-linecap="round"/><path d="M180 0c-14 28-9 49 15 62" stroke="currentColor" stroke-opacity=".06" stroke-width=".9" stroke-linecap="round"/></svg>';
  const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  function customLogo(title){
    if(typeof S==='undefined'||!title)return '';
    const n=norm(title),bills=S.bills||[];
    const bill=bills.find(b=>b.logo&&b.name&&norm(b.name)===n)||bills.find(b=>b.logo&&b.name&&norm(b.name).length>=3&&(' '+n+' ').includes(' '+norm(b.name)+' '));
    return bill?`<img src="${esc(bill.logo)}" alt="">`:'';
  }
  function logoMarkup(title,type,category){
    if(type==='transfer')return '';
    const custom=customLogo(title);
    if(custom)return `<span class="sl-brand-art sl-brand-logo">${custom}</span>`;
    const identity=window.CapSmartLogMerchants?.identity?.(title);
    let art='';
    if(typeof xb==='function')for(const name of [identity?.canonical,title]){if(!name)continue;art=xb(name);if(art)break}
    if(art)return `<span class="sl-brand-art sl-brand-logo">${art}</span>`;
    if(category&&typeof ci==='function')return `<span class="sl-brand-art sl-brand-category">${ci(category)}</span>`;
    return `<span class="sl-brand-art sl-brand-generic" aria-hidden="true">${RECEIPT}</span>`;
  }
  function accountInfo(key,label){
    const a=data().accounts.find(x=>String(x.id)===String(value(key)));
    const candidates=(draft.fields[key].candidates||[]).map(id=>data().accounts.find(x=>String(x.id)===String(id))).filter(Boolean);
    return `<div class="sl-account sl-account-row${a?'':' sl-needs'}">${label?`<span class="sl-info-label">${esc(label)}</span>`:''}<div class="sl-account-line">${a?`<span class="ps-mini sl-account-art" aria-hidden="true"><span class="pick">${cardH(a,false,false)}</span></span>`:`<span class="sl-card-empty" aria-hidden="true">${CARDS}</span>`}<span class="sl-account-meta"><b>${a?esc(a.name):'Needs Review'}</b>${a&&a.l4?`<small>&bull;&bull;&bull;&bull; ${esc(a.l4)}</small>`:''}${!a&&candidates.length?`<small>${candidates.map(x=>esc(x.name)).join(' &middot; ')}</small>`:''}</span></div></div>`;
  }
  function readPreview(message){
    const type=value('type'),title=value('title'),amount=value('amount'),category=value('category'),date=dateInfo(value('date')),time=parser.timeLabel(value('time')),description=value('description'),missing=missingFields();
    const heading=type==='transfer'&&(!title||title==='Account Transfer')?'Transfer':title;
    const amountText=amount!=null?(type==='income'?'+':'')+php(amount):'';
    const brand=logoMarkup(heading,type,category);
    const typeValue=type?`<b class="sl-type-value">${esc(typeName())}</b>`:'<b class="sl-needs">Needs Review</b>';
    const categoryRow=type==='transfer'?'':`<div class="sl-detail-row sl-detail-category"><span class="sl-info-label">Category</span>${category?`<b>${esc(category)}</b>`:'<b class="sl-needs">Needs Review</b>'}</div>`;
    const when=date?`${date.relative?`${esc(date.relative)} &middot; `:''}${esc(date.long)}`:'';
    const timeNeedsReview=draft.fields.time.state==='ambiguous';
    const dateTime=[date?date.full:(time?'Needs Review':''),timeNeedsReview?'Time · Needs Review':time].filter(Boolean).join(' · ');
    return {
      missing,
      markup:`<div class="sl-summary sl-read"><div class="sl-receipt" data-sl-type="${esc(type||'unknown')}"><div class="sl-ticket">`
        +`<div class="sl-heading sl-ticket-head"><h3 tabindex="-1">Transaction Preview</h3></div>`
        +(message?`<p class="sl-message">${esc(message)}</p>`:'')
        +`<span class="sl-grid" aria-hidden="true"></span><span class="sl-foil" aria-hidden="true">${FOIL}</span>`
        +`<div class="sl-hero"><div class="sl-amount-wrap">${amountText?`<div class="sl-amount">${esc(amountText)}</div>`:`<div class="sl-amount sl-needs">Amount needed</div>`}</div>`
        +`<div class="sl-identity"><div class="sl-id-head">${brand?`<div class="sl-brand">${brand}</div>`:''}<b class="sl-merchant${heading?'':' sl-needs'}">${heading?esc(heading):'Transaction'}</b></div></div>`
        +`<div class="sl-when">${when||'<span class="sl-needs">Needs Review</span>'}</div></div>`
        +`<div class="sl-details">`
        +`<div class="sl-detail-row sl-detail-type"><span class="sl-info-label">Type</span>${typeValue}</div>`
        +categoryRow
        +(type==='transfer'?`<div class="sl-route">${accountInfo('from','From')}<span class="sl-route-arrow" aria-hidden="true">&darr;</span>${accountInfo('to','To')}</div>`:`<div class="sl-detail-block">${accountInfo('account',type==='income'?'Deposited To':'Paid With')}</div>`)
        +`<div class="sl-detail-row sl-detail-datetime"><span class="sl-info-label">Date &amp; Time</span><b class="${date&&!timeNeedsReview?'':'sl-needs'}">${dateTime?esc(dateTime):'Needs Review'}</b></div>`
        +(description?`<div class="sl-detail-row sl-detail-description"><span class="sl-info-label">Description</span><p>${esc(description)}</p></div>`:'')
        +`</div>`
        +(missing.length?`<div class="sl-missing"><span class="sl-info-label">Missing</span><ul>${missing.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:'')
        +`</div>`
        +`<div class="sl-origin"><span class="sl-info-label">Logged from</span><blockquote>&ldquo;${esc(sourceText||draft.original)}&rdquo;</blockquote></div>`
        +`</div></div>`
    };
  }
  function triggerBody(key,label){
    const candidates=draft.fields[key].candidates||[];
    const a=data().accounts.find(x=>String(x.id)===String(value(key)))
      ||candidates.map(id=>data().accounts.find(x=>String(x.id)===String(id))).find(Boolean);
    return a?`<span class="ps-mini" aria-hidden="true"><span class="pick">${cardH(a,false,false)}</span></span><span class="ps-t">${esc(a.name)}</span>`
      :`<span class="sl-pick-empty" aria-hidden="true">${CARDS}</span><span class="ps-t">Choose ${esc(label.toLowerCase())}</span>`;
  }
  function accountControl(key,label){
    const f=draft.fields[key],selected=data().accounts.find(a=>String(a.id)===String(f.value));
    return `<label class="sl-field sl-field-wide"><span>${esc(label)}</span><input type="hidden" id="sl-${key}" data-sl-field="${key}" value="${selected?esc(selected.id):''}"><button type="button" class="ps-btn sl-cardpick" data-sl-pick="${key}" aria-haspopup="listbox" aria-expanded="false" aria-label="Choose ${esc(label)}">${triggerBody(key,label)}${CHEV}</button>${f.reason?`<small>${esc(f.reason)}</small>`:''}</label>`;
  }
  function refreshTrigger(key){
    if(!draft)return;
    const b=panel.querySelector(`[data-sl-pick="${key}"]`);if(!b)return;
    const input=panel.querySelector(`#sl-${key}`),a=data().accounts.find(x=>String(x.id)===String(value(key)));
    b.innerHTML=triggerBody(key,key==='from'?'Source':key==='to'?'Destination':'Account')+CHEV;
    if(input)input.value=a?String(a.id):'';
    b.setAttribute('aria-invalid',String(value(key)==null||value(key)===''));
  }
  function previewTrigger(key,id){
    const b=panel.querySelector(`[data-sl-pick="${key}"]`),a=data().accounts.find(x=>String(x.id)===String(id));if(!b||!a)return;
    b.innerHTML=`<span class="ps-mini" aria-hidden="true"><span class="pick">${cardH(a,false,false)}</span></span><span class="ps-t">${esc(a.name)}</span>${CHEV}`;
  }
  function closePicker(refocus){
    if(!picker)return;
    const p=picker,b=pickerAnchor,release=pickerDetach,key=pickerKey;
    picker=null;pickerAnchor=null;pickerDetach=null;pickerKey=null;
    if(pickerOutside){document.removeEventListener('pointerdown',pickerOutside,true);pickerOutside=null}
    release?.();p.remove();
    if(key)refreshTrigger(key);
    if(b?.isConnected){b.setAttribute('aria-expanded','false');if(refocus)b.focus({preventScroll:true})}
  }
  function openPicker(key){
    closePicker(false);
    const b=panel.querySelector(`[data-sl-pick="${key}"]`);if(!b)return;
    const list=eligibleAccounts(),selected=value(key),candidates=(draft.fields[key].candidates||[]).map(String),p=document.createElement('div');
    p.className='ps-pop grid';p.setAttribute('role','listbox');p.dataset.commandOwner='cap-command-bar';
    p.innerHTML=list.length?list.map(a=>{const on=String(a.id)===String(selected),candidate=!on&&candidates.includes(String(a.id));return `<div class="ps-copt${on?' on':''}${candidate?' candidate':''}" role="option" tabindex="0" aria-selected="${on}" aria-label="${esc(a.name)}" data-account-id="${esc(a.id)}"><div class="pick">${cardH(a,false,false)}</div><span class="ps-cap">${esc(a.name)}${a.l4?' •• '+esc(a.l4):''}</span></div>`}).join('')
      :'<p class="sl-message">No accounts available.</p>';
    document.body.appendChild(p);
    picker=p;pickerAnchor=b;pickerKey=key;b.setAttribute('aria-expanded','true');
    pickerDetach=window.CapOverlays?.attach(p,b,420)||null;
    pickerOutside=e=>{if(!p.contains(e.target)&&e.target!==b&&!b.contains(e.target))closePicker(false)};
    document.addEventListener('pointerdown',pickerOutside,true);
    const preview=option=>{if(option?.dataset.accountId)previewTrigger(key,option.dataset.accountId)};
    const choose=option=>{const id=option.dataset.accountId;closePicker(false);setField(key,id);panel.querySelector(`[data-sl-pick="${key}"]`)?.focus({preventScroll:true})};
    p.addEventListener('click',e=>{const option=e.target.closest('[data-account-id]');if(option)choose(option)});
    p.addEventListener('focusin',e=>preview(e.target.closest('[data-account-id]')));
    p.addEventListener('pointerover',e=>preview(e.target.closest('[data-account-id]')));
    p.addEventListener('cap:overlay-dismiss',()=>closePicker(true));
    p.addEventListener('keydown',e=>{
      const options=[...p.querySelectorAll('[role=option]')],i=options.indexOf(document.activeElement);
      if(e.key==='ArrowDown'){e.preventDefault();options[Math.min(options.length-1,i+2)]?.focus()}
      else if(e.key==='ArrowUp'){e.preventDefault();options[Math.max(0,i-2)]?.focus()}
      else if(e.key==='ArrowRight'){e.preventDefault();options[Math.min(options.length-1,i+1)]?.focus()}
      else if(e.key==='ArrowLeft'){e.preventDefault();options[Math.max(0,i-1)]?.focus()}
      else if((e.key==='Enter'||e.key===' ')&&document.activeElement.dataset.accountId){e.preventDefault();choose(document.activeElement)}
      else if(e.key==='Escape'||e.key==='Tab'){e.preventDefault();closePicker(true)}
    });
    (p.querySelector('.on')||p.querySelector('.candidate')||p.querySelector('[role=option]'))?.focus({preventScroll:true});
    preview(p.querySelector('.on')||p.querySelector('.candidate')||p.querySelector('[role=option]'));
  }
  function dismissPicker(){closePicker(false);}
  function hide(){++reviewRevision;dismissPicker();panel.hidden=true;sourceText='';}
  function invalidate(){hide();draft=null;}
  function options(items,current,placeholder){return '<option value=""'+(!items.some(([id])=>String(id)===String(current))?' selected':'')+'>'+esc(placeholder)+'</option>'+items.map(([id,label])=>`<option value="${esc(id)}"${String(id)===String(current)?' selected':''}>${esc(label)}</option>`).join('');}
  function control(key,label,kind='text',items){
    const f=draft.fields[key],missing=key!=='description'&&(f.value==null||f.value===''||f.state==='ambiguous');
    const attrs=`id="sl-${key}" data-sl-field="${key}" aria-label="${label}" aria-invalid="${missing}"`;
    const list=items?options(items,f.value,'Choose '+label.toLowerCase()):'';
    const element=items?`<select ${attrs}>${['account','from','to'].includes(key)?list.replace('<option value=""','<option value="" disabled'):list}</select>`:`<input ${attrs} type="${kind}"${kind==='number'?' min="0.01" step="0.01" inputmode="decimal"':''} value="${esc(f.value)}">`;
    return `<label class="sl-field"><span>${esc(label)}</span>${element}${f.reason?`<small>${esc(f.reason)}</small>`:''}</label>`;
  }
  function render(){
    if(!draft)return;
    dismissPicker();
    const d=data(),f=draft.fields;
    if(draft.kind!=='draft'){
      panel.innerHTML=`<div class="sl-heading"><h3 tabindex="-1">${draft.kind==='query'?'This Looks Like a Search':'Use an Existing Workflow'}</h3><button type="button" data-sl-action="back" aria-label="Back to Command">×</button></div><p class="sl-message">${esc(draft.issues.join(' '))}</p><div class="sl-actions">${draft.kind==='query'?'<button type="button" data-sl-action="search">Switch to Search</button>':'<button type="button" data-sl-action="workflow">Open Existing Workflow</button>'}</div>`;
    }else{
      const errors=parser.validate(draft,d),amounts=f.amount.candidates||[],message=editing?'Update the draft, then review it again before logging.':errors.length?'I need a little more information to log this.':'',preview=readPreview(message);
      const editor=`<div class="sl-fields">`
        +control('title','Title')+control('type','Type','text',[['expense','Expense'],['income','Income'],['transfer','Transfer']])
        +control('amount','Amount','number')+(amounts.length>1?`<label class="sl-field"><span>Amount Needs Confirmation</span><select data-sl-amount-choice>${options(amounts.map(n=>[n,php(n)]),null,'Choose an amount')}</select></label>`:'')
        +control('date','Date','date')+control('time','Time','time')
        +(value('type')==='transfer'?accountControl('from','Source')+accountControl('to','Destination'):control('category','Category','text',d.categories.map(c=>[c,c]))+accountControl('account','Account'))
        +control('description','Description')+`</div><p class="sl-errors" role="status"></p>`;
      const amount=value('amount'),verb=value('type')==='transfer'?'Transfer':'Log';
      const footer=editing
        ?`<div class="sl-actions"><button type="button" data-sl-action="edit">Done Editing</button></div>`
        :`<div class="sl-actions"><button type="button" data-sl-action="edit">Edit Transaction</button>${amount>0?`<button type="button" class="sl-confirm" data-sl-action="confirm"${errors.length?' disabled':''}>${verb} ${esc(php(amount))}</button>`:''}</div>`;
      panel.innerHTML=(editing?`<div class="sl-heading"><h3 tabindex="-1">Transaction Preview</h3></div><p class="sl-message">${message}</p>`:'')
        +(editing?editor:preview.markup)+footer;
      updateValidity();
    }
    panel.hidden=false;place();
  }
  function updateValidity(){
    if(!draft||draft.kind!=='draft')return;
    const errors=parser.validate(draft,data()),button=panel.querySelector('.sl-confirm');
    if(button){button.disabled=busy||!!errors.length;button.textContent=(value('type')==='transfer'?'Transfer ':'Log ')+php(value('amount')||0);}
    const errorLine=panel.querySelector('.sl-errors');if(errorLine)errorLine.textContent=errors.join(' · ');
    panel.querySelectorAll('[data-sl-field]').forEach(e=>{const f=draft.fields[e.dataset.slField];e.setAttribute('aria-invalid',String(e.dataset.slField!=='description'&&(f.value==null||f.value===''||f.state==='ambiguous')));const hint=e.parentElement.querySelector('small');if(hint){hint.textContent=f.reason||'';hint.hidden=!f.reason}});
    panel.querySelectorAll('[data-sl-pick]').forEach(b=>{const f=draft.fields[b.dataset.slPick];b.setAttribute('aria-invalid',String(f.value==null||f.value===''));const hint=b.parentElement.querySelector('small');if(hint){hint.textContent=f.reason||'';hint.hidden=!f.reason}});
  }
  function reduceMotion(){return matchMedia('(prefers-reduced-motion:reduce)').matches||document.documentElement.classList.contains('rm')||document.documentElement.classList.contains('noanim')}
  function animateSwap(){
    if(reduceMotion())return;
    try{panel.animate([{opacity:.72,transform:'translateY(5px)'},{opacity:1,transform:'none'}],{duration:180,easing:'cubic-bezier(.22,.75,.28,1)'})}catch(_){}
  }
  async function submitText(text){
    if(!active()||busy)return;
    const token=++reviewRevision;
    sourceText=text;draft=parser.parse(text,data());editing=false;dismissPicker();panel.hidden=true;
    if(!await bar.dismissKeyboard()||token!==reviewRevision||!active())return;
    render();
    // Focus the preview, not a keyboard field that could cover it on mobile.
    panel.querySelector('h3')?.focus({preventScroll:true});
  }
  function setField(key,newValue){
    if(!draft||draft.kind!=='draft')return;
    if(key==='time'&&draft.fields.time.state==='ambiguous'&&!parser.validTime(newValue)){updateValidity();return;}
    if(['account','from','to'].includes(key))newValue=data().accounts.find(a=>String(a.id)===String(newValue))?.id??null;
    if(key==='amount')newValue=newValue===''?null:Number(newValue);
    draft.fields[key]={value:newValue||null,state:'resolved',candidates:[],reason:''};
    if(key==='description'&&!newValue)draft.fields[key].value='';
    if(key==='type'){render();panel.querySelector('#sl-type')?.focus({preventScroll:true});}else{updateValidity();refreshTrigger(key);}
  }
  // Form controls are filled through their normal change events, keeping Cap's
  // existing picker labels and account-dependent posting controls in sync.
  function put(id,v){const e=document.getElementById(id);if(!e)throw Error('Existing entry form is unavailable');e.value=v==null?'':String(v);e.dispatchEvent(new Event('change',{bubbles:true}));}
  function prefill(d){
    const f=d.fields,v=k=>f[k]?.value;
    if(v('type')==='transfer'){
      const from=S.accts.find(a=>a.id===v('from')&&['debit','ewallet'].includes(a.type));
      if(!from)throw Error('Choose a source account in the preview first');
      window.accountTransferSheet(from.id);
      if(v('to')!=null)put('account-transfer-to',v('to'));
      if(v('amount')!=null)put('account-transfer-amount',v('amount'));
      if(v('date'))put('account-transfer-date',v('date'));
      if(parser.validTime(v('time')))put('account-transfer-time',v('time'));
      put('account-transfer-note',[v('title'),v('description')].filter(Boolean).join(' · '));
    }else{
      window.openTx();
      if(v('type'))put('ty',v('type')==='income'?1:-1);
      if(v('amount')!=null)put('am',v('amount'));
      if(v('account')!=null)put('ac',v('account'));
      if(v('category'))put('ct',v('category'));
      if(v('date')){put('dt',v('date'));put('pdt',v('date'));}
      if(parser.validTime(v('time')))put('tt',v('time'));
      if(v('title'))put('nt',v('title'));
      if(v('description'))put('ds',v('description'));
    }
  }
  function checkSaved(){
    if(!session)return;
    const s=session,f=s.draft.fields,v=k=>f[k]?.value;
    let record;
    if(v('type')==='transfer'){
      const amount=+(document.getElementById('account-transfer-amount')?.value||v('amount'));
      record=S.xfer.find(x=>!s.ids.has(x.id)&&x.kind==='account-transfer'&&x.from===v('from')&&x.to===v('to')&&Math.abs(x.amt-amount)<.00001);
    }else{
      const account=+(document.getElementById('ac')?.value||v('account')),amount=+(document.getElementById('am')?.value||v('amount'));
      record=[...S.tx,...S.pend].find(t=>!s.ids.has(t.id)&&!t.parentId&&t.acct===account&&Math.abs(Math.abs(t.amt)-amount)<.00001);
    }
    if(record){session=null;busy=false;draft=null;input.value='';hide();bar.close({restoreFocus:false});return;}
    if(!document.getElementById('sheet').classList.contains('open')){session=null;busy=false;updateValidity();}
  }
  function launch(commit){
    if(!draft||draft.kind!=='draft'||busy||!active()||editing)return;
    if(commit&&(parser.validate(draft,data()).length||input.value.trim()!==draft.original)){updateValidity();return;}
    busy=true;updateValidity();
    const d=JSON.parse(JSON.stringify(draft));
    session={draft:d,ids:new Set([...S.tx,...S.pend,...S.xfer].map(x=>x.id))};
    try{
      bar.suspend(()=>{
        prefill(d);
        // This is the ONLY Smart Log execution boundary. Both functions are the
        // original manual save handlers, including their extra confirmations.
        if(commit){if(d.fields.type.value==='transfer')window.accountTransferCommit(d.fields.from.value);else window.saveTx();}
      });
      checkSaved();
    }catch(error){session=null;busy=false;updateValidity();toast(error.message);}
  }
  panel.addEventListener('input',e=>{const key=e.target.dataset.slField;if(key)setField(key,e.target.value)});
  panel.addEventListener('change',e=>{const key=e.target.dataset.slField;if(key)setField(key,e.target.value);if(e.target.hasAttribute('data-sl-amount-choice')){setField('amount',e.target.value);panel.querySelector('#sl-amount').value=e.target.value}});
  panel.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.target.closest('button')){e.preventDefault();e.stopPropagation();}});
  panel.addEventListener('click',async e=>{
    const trigger=e.target.closest('[data-sl-pick]');
    if(trigger){picker&&pickerAnchor===trigger?closePicker(true):openPicker(trigger.dataset.slPick);return}
    const action=e.target.closest('[data-sl-action]')?.dataset.slAction;
    if(action==='back'){hide();input.focus({preventScroll:true})}
    if(action==='edit'){
      if(editing){
        const token=++reviewRevision;panel.hidden=true;
        if(!await bar.dismissKeyboard()||token!==reviewRevision||!active())return;
        editing=false;render();animateSwap();panel.querySelector('h3')?.focus({preventScroll:true});
      }else{++reviewRevision;editing=true;render();animateSwap();panel.querySelector('input')?.focus({preventScroll:true})}
    }
    if(action==='confirm')launch(true);
    if(action==='search'){invalidate();bar.setMode('search')}
    if(action==='workflow'){
      const workflow=draft.workflow||'plan';
      if(workflow==='manual'){bar.suspend(()=>window.openTx());return;}
      await bar.close({restoreFocus:false});document.querySelector('#tabs .nav-tab-'+workflow)?.click();
    }
  });
  panel.addEventListener('error',e=>{const img=e.target;if(img?.tagName==='IMG'&&img.closest('.sl-brand')){const art=img.closest('.sl-brand-art');img.remove();if(art)art.outerHTML=`<span class="sl-brand-art sl-brand-generic" aria-hidden="true">${RECEIPT}</span>`}},true);
  root.addEventListener('cap:command-submit',e=>{if(e.detail.mode==='log')submitText(e.detail.text)});
  root.addEventListener('cap:command-change',invalidate);
  root.addEventListener('cap:command-close',hide);
  root.addEventListener('cap:command-edit-focus',e=>{if(e.detail.command){++reviewRevision;dismissPicker();panel.hidden=true;}});
  root.addEventListener('cap:command-position',place);
  root.addEventListener('cap:command-escape',e=>{if(!panel.hidden){e.preventDefault();hide();input.focus({preventScroll:true})}});
  new MutationObserver(checkSaved).observe(document.getElementById('sheet'),{attributes:true,childList:true,subtree:true,attributeFilter:['class']});
})();
