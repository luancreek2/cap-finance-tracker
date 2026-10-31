/* Phase 5A controller: notification-only local metadata, conservative delivery,
   and read-only UI. Financial S, storage pera and all sync stores are untouched. */
(function(){
  'use strict';
  const engine=window.CapNotificationEngine,dates=window.CapSmartLogParser,app=document.getElementById('app');if(!engine||!dates||!app)return;
  const PREFIX='cap_notifications_v1:',MAX_HISTORY=1000,RETENTION_DAYS=120;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date=()=>dates.localDate(new Date()),human=k=>new Date(k+'T12:00:00').toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'});
  const icon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';
  const readIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 12 5 5L18 6m-6 10 9-9"/></svg>',moreIcon='<span class="cn-more-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></span>';
  const settingsButton=document.getElementById('settings-button'),settingsAnchor=document.createComment('Cap tab action anchor'),settingsLabel=settingsButton?.getAttribute('aria-label')||'Settings',gear=settingsButton?.querySelector('svg')?.cloneNode(true);
  if(settingsButton)settingsButton.before(settingsAnchor);if(gear){gear.removeAttribute('style');gear.setAttribute('aria-hidden','true');}
  const gearIcon=gear?.outerHTML||'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3 1 2h4l1-2 3 2-1 2 2 3 2 1v3l-2 1-2 3 1 2-3 1-1-2h-4l-1 2-3-1 1-2-2-3-2-1v-3l2-1 2-3-1-2Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const dialog=document.createElement('dialog');dialog.id='cap-notifications';dialog.className='cn-dialog';dialog.setAttribute('aria-labelledby','cn-title');document.body.appendChild(dialog);
  let model={candidates:[],issues:[]},returnFocus=null,queued=Promise.resolve(),refreshTimer=0,opening=false,storageWarning='',preferenceRevision=0;
  const pendingPreferences=new Map();
  const filters=Object.freeze([['all','All'],['bills','Bills'],['subscriptions','Subscriptions'],['cards','Cards']]),expandedRows=new Set();
  let selectedFilter='all',readingAll=false;
  const sourceRefs=new Map();let sourceReturn=null;
  // localIdentity is a cached read. Do not call Auth status(): that accessor
  // invalidates verification while offline and is not an analytical getter.
  function scope(){try{return String(window.CapSupabase?.localIdentity?.()||'local')}catch(_){return 'local'}}
  const key=owner=>PREFIX+encodeURIComponent(owner);
  function load(owner=scope()){
    let raw={};try{raw=JSON.parse(localStorage.getItem(key(owner))||'{}')||{}}catch(_){}
    const prefs=engine.preferences(raw.version===1?raw.preferences:{...(typeof S==='object'?S.notif:{}),showAmounts:false,overdue:true});
    const history=Object.create(null);if(raw.version===1&&raw.history&&typeof raw.history==='object')for(const [id,r] of Object.entries(raw.history)){if(!id.startsWith('cap-reminder-v1:')||id.length>600||!r||!dates.validDate(r.day))continue;history[id]={day:r.day,seen:!!r.seen,dismissed:!!r.dismissed,attempted:!!r.attempted,delivered:!!r.delivered,retryAfter:Number.isFinite(r.retryAfter)?r.retryAfter:0};}
    return {version:1,preferences:prefs,history};
  }
  function store(data,owner){
    if(owner!==scope())return false;
    // Keep a still-unpaid overdue occurrence protected even while a category or
    // the master is off; toggling preferences must not erase its delivery claim.
    const all=engine.evaluate(S,{today:date(),preferences:{...engine.DEFAULTS,on:true}});
    const active=new Set([...model.candidates,...all.candidates].map(c=>c.id)),cutoff=CapFinancialSearchParser.shift(date(),-RETENTION_DAYS);
    if(all.issues.length)for(const id of Object.keys(data.history))if(id.endsWith(':overdue'))active.add(id);
    const records=Object.entries(data.history).filter(([id,r])=>r.day>=cutoff||active.has(id)).sort((a,b)=>a[1].day.localeCompare(b[1].day)||a[0].localeCompare(b[0]));
    while(records.length>MAX_HISTORY){const i=records.findIndex(([id])=>!active.has(id));if(i<0){storageWarning='Reminder history is full. Automatic presentation is paused rather than risking duplicates.';return false;}records.splice(i,1);}
    data.history=Object.fromEntries(records);
    try{localStorage.setItem(key(owner),JSON.stringify(data));storageWarning='';return true}catch(_){storageWarning='Notification preferences or history could not be saved on this device. Automatic reminders will not be shown without a saved claim.';return false;}
  }
  function lock(owner,fn){return navigator.locks?.request?navigator.locks.request('cap-notifications:'+owner,()=>owner===scope()?fn():false):Promise.resolve(owner===scope()?fn():false);}
  async function mutate(fn){const owner=scope();try{return await lock(owner,()=>{const d=load(owner);fn(d);return store(d,owner)})}catch(_){storageWarning='Notification metadata could not be coordinated on this device. No financial data was changed.';return false;}}
  function preferences(){return engine.preferences({...load().preferences,...Object.fromEntries([...pendingPreferences].map(([k,v])=>[k,v.value]))});}
  function capabilities(){
    let permission='unsupported';try{if(isSecureContext&&typeof window.Notification==='function')permission=Notification.permission;}catch(_){}
    return {permission,supported:permission!=='unsupported',serviceWorker:!!navigator.serviceWorker,showNotification:typeof window.ServiceWorkerRegistration!=='undefined'&&typeof ServiceWorkerRegistration.prototype.showNotification==='function',crossTabLock:!!navigator.locks?.request,standalone:matchMedia('(display-mode: standalone)').matches||navigator.standalone===true};
  }
  const permissionLabel=()=>({default:'Not Requested',granted:'Allowed',denied:'Blocked',unsupported:'Unsupported'}[capabilities().permission]||'Unsupported');
  function allowedToPresent(){return !document.hidden&&!opening&&!dialog.open&&!window.capLaunchActive&&window._unlocked!==0&&!document.querySelector('#cap-auth');}
  function calculate(){return engine.evaluate(S,{today:date(),preferences:preferences()});}
  function calculateCenter(){return window.CapReminderUI?.centerModel(preferences())||engine.evaluate(S,{today:date(),preferences:preferences()});}
  function localLogo(c){
    const b=c.category==='card'?(S.accts||[]).find(a=>String(a.id)===c.sourceId):(S.bills||[]).find(b=>String(b.id)===c.sourceId),src=String(b?.logo||'');
    if(!/^assets\/(icons|branding)\/cap-/i.test(src)&&((/^assets\/(media|branding|icons)\/[\w./-]+$/.test(src)&&!src.split('/').includes('..'))||/^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(src)))return `<img src="${esc(src)}" alt="">`;
    if(c.category==='card'&&typeof cardLogo==='function'&&b){const logo=cardLogo(b);if(logo)return logo;}
    const brand=typeof bnd==='function'?bnd(c.brandLabel):'';if(brand)return brand;
    const category=(S.cats||[]).find(cat=>cat.n===b?.cat)?.i;
    return `<span aria-hidden="true">${esc(category||engine.safeLabel(c.brandLabel).charAt(0).toUpperCase()||'🧾')}</span>`;
  }
  function rows(){const history=load().history;return model.candidates.filter(c=>!history[c.id]?.dismissed);}
  function bell(){
    let actions=document.getElementById('cap-home-actions');
    const activeTab=typeof tab==='undefined'?'':tab;
    if(!['Home','Activity','Plan','Accounts'].includes(activeTab)||!app.firstElementChild){if(dialog.open){returnFocus=null;dialog.close();}if(settingsButton&&settingsAnchor.isConnected){settingsAnchor.after(settingsButton);settingsButton.classList.remove('cn-home-more');settingsButton.setAttribute('aria-label',settingsLabel);settingsButton.removeAttribute('title');settingsButton.querySelector('.cn-more-glyph')?.remove();}actions?.remove();return;}
    if(actions&&actions.dataset.tab!==activeTab&&dialog.open){returnFocus=null;dialog.close();}
    // Reuse the original action-pair hooks and buttons across all main tabs.
    if(!actions){actions=document.createElement('div');actions.id='cap-home-actions';actions.className='cn-home-actions';actions.setAttribute('role','group');document.body.appendChild(actions);}
    actions.dataset.tab=activeTab;actions.setAttribute('aria-label',activeTab+' actions');
    let button=actions.querySelector('#cap-notification-bell');
    if(!button){button=document.createElement('button');button.id='cap-notification-bell';button.type='button';button.className='cn-bell';button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls',dialog.id);button.title='Notifications';button.innerHTML=icon+'<span class="cn-dot" aria-hidden="true"></span>';button.addEventListener('click',()=>dialog.open?dialog.close():open());actions.appendChild(button);}
    if(settingsButton){settingsButton.classList.add('cn-home-more');settingsButton.setAttribute('aria-label',activeTab+' actions and Settings');settingsButton.title=activeTab+' actions and Settings';if(!settingsButton.querySelector('.cn-more-glyph'))settingsButton.insertAdjacentHTML('beforeend',moreIcon);if(settingsButton.parentNode!==actions)actions.appendChild(settingsButton);}
    const h=load().history,count=rows().filter(c=>!h[c.id]?.seen).length;button.classList.toggle('cn-has-new',count>0);button.setAttribute('aria-expanded',String(dialog.open));button.setAttribute('aria-label',count?'Notifications, '+count+' unseen reminders':'Notifications');
  }
  function filteredRows(){return rows().filter(c=>selectedFilter==='all'||selectedFilter==='bills'&&c.category==='bills'||selectedFilter==='subscriptions'&&['renew','trial'].includes(c.category)||selectedFilter==='cards'&&c.category==='card');}
  const timing=c=>c.daysUntil<0?Math.abs(c.daysUntil)+'d overdue':c.daysUntil===0?'Today':c.daysUntil===1?'Tomorrow':'In '+c.daysUntil+'d';
  function sourceRecord(c){
    const list=c.sourceType==='statement'?(S.accts||[]):(S.bills||[]),matches=list.filter(r=>String(r.id)===c.sourceId);
    const record=matches.length===1?matches[0]:null,bound=sourceRefs.get(c.id);
    if(!record||bound&&bound!==record)return null;
    if(c.sourceType==='statement'){
      const statements=(record.statementHistory||[]).filter(s=>s.en===c.occurrence&&s.due===c.dueDate);
      if(record.type!=='credit'||statements.length!==1)return null;
    }
    return record;
  }
  function sourceSummary(c,p){
    const record=sourceRecord(c);if(!record)return '<p class="cn-summary-primary">Source no longer available</p>';
    const money=value=>{if(!p.showAmounts||!Number.isFinite(value))return '';try{return new Intl.NumberFormat(undefined,{style:'currency',currency:S.cur||'PHP'}).format(value);}catch(_){return '';}};
    const amount=money(c.amountCents==null?NaN:c.amountCents/100),account=(S.accts||[]).find(a=>String(a.id)===String(record.acct));
    const accountName=account?engine.safeLabel(account.nickname||account.name):'';
    const frequency={once:'One-time',weekly:'Weekly',biweekly:'Every 2 weeks',monthly:'Monthly',quarterly:'Quarterly',yearly:'Yearly'}[record.freq]||'';
    let primary=[],secondary=[];
    if(c.category==='trial'){
      primary=['Free until '+human(c.dueDate)];const price=money(Number.isFinite(record.priceAfterTrial)?record.priceAfterTrial:record.amt);
      if(price)secondary.push('Then '+price+(frequency?' · '+frequency.toLowerCase():''));
      if(accountName)secondary.push(accountName);
    }else if(c.category==='card'){
      const statement=record.statementHistory.find(s=>s.en===c.occurrence&&s.due===c.dueDate);
      primary=[amount?amount+' due':'', 'Due '+human(c.dueDate)];secondary=[engine.safeLabel(record.nickname||record.name)];
      const minimum=money(statement.minimum);if(minimum)secondary.push('Minimum '+minimum);
    }else{
      primary=[amount,(c.category==='renew'?'Renews ':'Due ')+human(c.dueDate)];secondary=[accountName];
      if(c.category==='renew'){if(frequency)secondary.push(frequency);}
      else{const paid=(record.paidOn||[]).includes(c.dueDate)||record.paid===c.dueDate.slice(0,7);secondary.push(paid?'Paid':c.daysUntil<0?Math.abs(c.daysUntil)+' day'+(c.daysUntil===-1?'':'s')+' overdue':c.daysUntil===0?'Due today':'Upcoming');}
    }
    return `<p class="cn-summary-primary">${esc(primary.filter(Boolean).join(' · '))}</p>${secondary.filter(Boolean).length?`<p class="cn-summary-secondary">${esc(secondary.filter(Boolean).join(' · '))}</p>`:''}`;
  }
  function openSource(candidate,row){
    const record=sourceRecord(candidate);
    let safe=!!record;
    if(safe&&candidate.sourceType==='statement'){
      // Plan's exact handler selects the first closed cycle. Require that stored cycle
      // BEFORE calling it; never generate a financial snapshot from Notifications.
      const selected=typeof cardCycles==='function'?cardCycles(record)[1]:null;
      safe=!!(record.stmt&&selected?.snapshot&&selected.en===candidate.occurrence&&selected.due===candidate.dueDate);
      if(safe)for(const a of (S.accts||[]).filter(a=>a.type==='credit'&&a.stmt&&(a.due||a.dueN)))if(!cardCycles(a)[1]?.snapshot)safe=false;
    }
    if(!safe){row.open=true;const message=row.querySelector('.cn-summary-primary');message.textContent='Source no longer available';message.setAttribute('role','status');row.querySelector('.cn-summary-secondary')?.remove();const edit=row.querySelector('[data-edit-source]');if(edit)edit.disabled=true;return;}
    const handler=candidate.sourceType==='statement'?window.upCardSheet:window.upBillSheet;if(typeof handler!=='function')return;
    sourceReturn={scroll:dialog.querySelector('.cn-scroll').scrollTop,filter:selectedFilter,tab:typeof tab==='undefined'?null:tab,row:candidate.id};
    markRead([candidate.id]);returnFocus=null;dialog.close();handler(record.id);
  }
  function content(){
    const list=filteredRows(),groups=[['overdue','Overdue'],['today','Today'],['upcoming','Upcoming']],p=preferences(),history=load().history;
    const sections=groups.map(([group,title])=>{const members=list.filter(c=>c.urgency===group);return members.length?`<section class="cn-group" data-group="${group}"><h3>${title}</h3>${members.map(c=>{
      const unread=!history[c.id]?.seen,ui=window.CapReminderUI,copy=ui?.copy(c.category,c.brandLabel,c.daysUntil,['bills','card'].includes(c.category)&&c.urgency==='overdue')||{title:c.title,body:c.body};
      const time=c.daysUntil===0?'Today':c.daysUntil===1?'Tomorrow':c.daysUntil<0?timing(c):human(c.dueDate);
      let amount='';if(p.showAmounts&&c.amountCents!=null)try{amount=new Intl.NumberFormat(undefined,{style:'currency',currency:S.cur||'PHP'}).format(c.amountCents/100);}catch(_){}
      const item=ui?.items().find(i=>i.id===c.sourceId&&i.source===c.sourceType),state=ui?ui.itemState(item):'';
      const raw=(c.sourceType==='statement'?S.accts:S.bills||[]).filter(r=>String(r.id)===c.sourceId);if(raw.length===1&&!sourceRefs.has(c.id))sourceRefs.set(c.id,raw[0]);
      return `<details class="cn-row${unread?' is-unread':''}" data-reminder="${esc(c.id)}"><summary tabindex="-1"><button type="button" class="cn-source-main" aria-label="Open ${esc(copy.title)}"><span class="cn-logo">${localLogo(c)}</span><span class="cn-copy"><b>${esc(copy.title)}</b><small class="cn-meta"><span>${esc([amount,time].filter(Boolean).join(' · '))}</span></small><span class="cn-support">${esc(copy.body)}</span></span></button><button type="button" class="cn-row-rail cn-expand" aria-label="Expand ${esc(c.brandLabel)} reminder" aria-expanded="false"><span class="cn-timing">${esc(timing(c))}</span><span class="cn-read-state"><i class="cn-unread-dot" aria-hidden="true"${unread?'':' hidden'}></i><span>${unread?'Unread':'Read'}</span></span><span class="cn-chevron" aria-hidden="true">⌄</span></button></summary><div class="cn-detail">${sourceSummary(c,p)}${ui?`<p class="cn-local-state">${esc(state)}</p><button type="button" class="cn-dismiss" data-edit-source="${esc(c.sourceType)}" data-edit-id="${esc(c.sourceId)}">Reminders</button>`:''}<button type="button" class="cn-dismiss" data-dismiss="${esc(c.id)}">Dismiss reminder</button></div></details>`;
    }).join('')}</section>`:''}).join('');
    return `<header class="cn-header"><h2 id="cn-title" tabindex="-1">Notifications</h2><div class="cn-header-actions"><button type="button" class="cn-icon-button cn-read-all" aria-label="Mark all as read" title="Mark all as read">${readIcon}</button><button type="button" class="cn-icon-button cn-settings" aria-label="Notification settings" title="Notification settings">${gearIcon}</button></div></header><div class="cn-filter-bar" role="group" aria-label="Filter notifications">${filters.map(([key,label])=>`<button type="button" class="cn-filter" data-filter="${key}" aria-pressed="${selectedFilter===key}">${label}</button>`).join('')}</div><div class="cn-scroll"><div class="cn-list" id="cn-list">${sections||`<div class="cn-empty">${icon}<h3>${!p.on?'Reminders are off':selectedFilter==='all'?"You’re all caught up":'No reminders in this view'}</h3><p>${!p.on?'Enable Notifications in Settings to see reminders for your tracked items.':selectedFilter==='all'?'Current reminders will appear here when recorded items reach your reminder window.':'Your other current reminders remain available under All.'}</p></div>`}</div>${model.issues.length?`<p class="cn-note">${model.issues.map(esc).join(' ')}</p>`:''}<p class="cn-note cn-storage-status" role="status">${esc(storageWarning)}</p><p class="cn-note">Reading or dismissing a reminder never marks it paid.</p></div>`;
  }
  function updateReadPresentation(){const history=load().history;for(const row of dialog.querySelectorAll('.cn-row')){const unread=!history[row.dataset.reminder]?.seen;row.classList.toggle('is-unread',unread);row.querySelector('.cn-unread-dot').hidden=!unread;row.querySelector('.cn-read-state>span').textContent=unread?'Unread':'Read';}const status=dialog.querySelector('.cn-storage-status');if(status)status.textContent=storageWarning;bell();}
  async function markRead(ids){const ok=await mutate(d=>{for(const id of ids)if(!d.history[id]?.dismissed)d.history[id]={...d.history[id],day:date(),seen:true}});if(dialog.open)updateReadPresentation();else bell();return ok;}
  async function markAllRead(){if(readingAll)return;readingAll=true;const button=dialog.querySelector('.cn-read-all');button?.setAttribute('aria-busy','true');try{model=calculateCenter();const history=load().history;const ids=rows().filter(c=>!history[c.id]?.seen).map(c=>c.id);if(ids.length)await markRead(ids);else updateReadPresentation();}finally{readingAll=false;button?.removeAttribute('aria-busy');}}
  function paint(){
    // A focus/evaluate repaint can land between opening a row and its async
    // toggle event. Capture the visible state before replacing the markup.
    for(const row of dialog.querySelectorAll('.cn-row[open]'))expandedRows.add(row.dataset.reminder);
    const scroll=dialog.querySelector('.cn-scroll')?.scrollTop||0,focus=document.activeElement,focused=focus?.dataset.dismiss,focusSelector=focus?.classList.contains('cn-expand')?'.cn-expand':focus?.classList.contains('cn-source-main')?'.cn-source-main':null,focusedRow=(focus?.tagName==='SUMMARY'||focusSelector)?focus.closest('.cn-row')?.dataset.reminder:null,focusedFilter=focus?.dataset.filter,focusedHeader=focus?.closest('.cn-header-actions')?focus.classList.contains('cn-read-all')?'.cn-read-all':'.cn-settings':null;
    dialog.innerHTML=content();for(const e of dialog.querySelectorAll('details')){const c=model.candidates.find(c=>c.id===e.dataset.reminder),n=c?.daysUntil;e.dataset.urgency=c?.category==='trial'?'t':n<0?'o':n<=3?'r':n<=7?'y':'n';if(expandedRows.has(e.dataset.reminder))e.open=true;e.addEventListener('toggle',()=>{if(e.open){expandedRows.add(e.dataset.reminder);if(!load().history[e.dataset.reminder]?.seen)markRead([e.dataset.reminder]);}else expandedRows.delete(e.dataset.reminder)});if(focusedRow===e.dataset.reminder)e.querySelector(focusSelector||'summary').focus({preventScroll:true});}dialog.querySelector('.cn-scroll').scrollTop=scroll;
    for(const row of dialog.querySelectorAll('.cn-row')){
      const c=model.candidates.find(c=>c.id===row.dataset.reminder),expand=row.querySelector('.cn-expand');
      row.dataset.timingUrgency=window.CapReminderUI?.urgency(c.daysUntil)||'neutral';
      expand.setAttribute('aria-expanded',String(row.open));
      row.addEventListener('toggle',()=>{expand.setAttribute('aria-expanded',String(row.open));expand.setAttribute('aria-label',(row.open?'Collapse ':'Expand ')+c.brandLabel+' reminder');});
      expand.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();const next=!row.open;if(next)expandedRows.add(row.dataset.reminder);else expandedRows.delete(row.dataset.reminder);row.open=next;});
      row.querySelector('.cn-source-main').addEventListener('click',event=>{event.preventDefault();event.stopPropagation();openSource(c,row);});
      for(const action of row.querySelectorAll('.cn-detail button'))action.addEventListener('click',event=>event.stopPropagation());
    }
    dialog.querySelector('.cn-settings').addEventListener('click',()=>{returnFocus=null;dialog.close();stGo('notif')});
    dialog.querySelector('.cn-read-all').addEventListener('click',markAllRead);if(focusedHeader)dialog.querySelector(focusedHeader).focus({preventScroll:true});
    for(const b of dialog.querySelectorAll('[data-filter]')){b.addEventListener('click',()=>{selectedFilter=b.dataset.filter;paint();dialog.querySelector(`[data-filter="${selectedFilter}"]`).focus({preventScroll:true});});b.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const i=filters.findIndex(([key])=>key===selectedFilter),next=e.key==='Home'?0:e.key==='End'?filters.length-1:(i+(e.key==='ArrowRight'?1:-1)+filters.length)%filters.length;selectedFilter=filters[next][0];paint();dialog.querySelector(`[data-filter="${selectedFilter}"]`).focus({preventScroll:true});});if(focusedFilter===b.dataset.filter)b.focus({preventScroll:true});}
    for(const img of dialog.querySelectorAll('.cn-logo img')){const fallback=()=>{if(img.parentNode)img.parentNode.innerHTML=icon};img.addEventListener('error',fallback,{once:true});if(img.complete&&!img.naturalWidth)fallback();}
    for(const button of dialog.querySelectorAll('[data-edit-source]'))button.addEventListener('click',()=>{const row=button.closest('.cn-row'),candidate=model.candidates.find(c=>c.id===row.dataset.reminder);if(!sourceRecord(candidate)){row.open=true;row.querySelector('.cn-summary-primary').textContent='Source no longer available';button.disabled=true;return;}returnFocus=null;dialog.close();window.CapReminderUI?.openItem(button.dataset.editSource,button.dataset.editId);});
    for(const b of dialog.querySelectorAll('[data-dismiss]')){b.addEventListener('click',async()=>{await mutate(d=>{d.history[b.dataset.dismiss]={...d.history[b.dataset.dismiss],day:date(),seen:true,dismissed:true}});await evaluate(false);dialog.querySelector('#cn-title')?.focus({preventScroll:true});});if(focused===b.dataset.dismiss)b.focus({preventScroll:true});}
  }
  async function open(resume=false){
    if(opening||dialog.open||window._unlocked===0||document.querySelector('#cap-auth,#sheet.open,#cap-financial-health[open]')||['open','opening'].includes(window.CapCommandBar?.getState().state))return;
    opening=true;returnFocus=document.activeElement;
    try{try{await window.CapReminderUI?.refresh();}catch(_){storageWarning='Reminder editing is unavailable on this device.';}model=calculateCenter();if(!resume){selectedFilter='all';expandedRows.clear();for(const row of dialog.querySelectorAll('.cn-row[open]'))row.open=false;sourceRefs.clear();}paint();dialog.show();position();dialog.querySelector('#cn-title').focus({preventScroll:true});bell();}finally{opening=false;}
  }
  function position(){
    if(!dialog.open)return;
    const bell=document.getElementById('cap-notification-bell'),anchor=bell?.getBoundingClientRect()||settingsButton?.getBoundingClientRect(),v=window.visualViewport;
    const left=v?.offsetLeft||0,top=v?.offsetTop||0,width=v?.width||innerWidth,height=v?.height||innerHeight,margin=12;
    const w=Math.min(460,width-margin*2),y=Math.max(top+margin,Math.min((anchor?.bottom||top+52)+8,top+height-180));
    dialog.style.width=w+'px';dialog.style.left=Math.max(left+margin,Math.min((anchor?.right||left+width-margin)-w,left+width-w-margin))+'px';dialog.style.top=y+'px';dialog.style.maxHeight=Math.max(80,Math.min(height*.7,top+height-y-margin-parseFloat(getComputedStyle(dialog).getPropertyValue('--cn-safe-bottom')||0)))+'px';
  }
  dialog.addEventListener('close',()=>{if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});returnFocus=null;bell();});
  document.addEventListener('pointerdown',e=>{if(dialog.open&&!dialog.contains(e.target)&&!e.target.closest('#cap-notification-bell')){if(e.target.closest('button,a,input,select,textarea,[tabindex]'))returnFocus=null;dialog.close();}},true);
  document.addEventListener('keydown',e=>{if(dialog.open&&e.key==='Escape'){e.preventDefault();e.stopPropagation();dialog.close();}},true);
  window.addEventListener('resize',position);window.addEventListener('scroll',position,{passive:true});window.visualViewport?.addEventListener('resize',position);window.visualViewport?.addEventListener('scroll',position);
  const detailSheet=document.getElementById('sheet');if(detailSheet)new MutationObserver(()=>{
    if(!sourceReturn||document.querySelector('#sheet.open'))return;
    const returning=sourceReturn;sourceReturn=null;if(returning.tab!==(typeof tab==='undefined'?null:tab))return;
    selectedFilter=returning.filter;
    open(true).then(()=>{if(!dialog.open)return;dialog.querySelector('.cn-scroll').scrollTop=returning.scroll;[...dialog.querySelectorAll('.cn-row')].find(r=>r.dataset.reminder===returning.row)?.querySelector('.cn-source-main').focus({preventScroll:true});});
  }).observe(detailSheet,{attributes:true,attributeFilter:['class']});
  async function present(title,body,tag,test=false,resolve){
    if(capabilities().permission!=='granted')return false;
    try{const registration=navigator.serviceWorker?await navigator.serviceWorker.getRegistration():null;
      if(resolve){const current=resolve();if(!current)return false;title=current.title;body=current.body;}
      if(capabilities().permission!=='granted'||!test&&!allowedToPresent())return false;
      const options={body,tag,renotify:false,icon:new URL('assets/icons/cap-192.png',document.baseURI).href,badge:new URL('assets/icons/cap-48.png',document.baseURI).href,data:{type:test?'cap-notification-test':'cap-reminder',version:1}};
      if(registration?.active&&typeof registration.showNotification==='function'){await registration.showNotification(title,options);return true;}
      const notification=new Notification(title,options);notification.onclick=()=>{notification.close();window.focus();if(allowedToPresent())open()};return true;
    }catch(_){return false;}
  }
  async function deliver(){
    // Without a cross-tab lock we deliberately keep automatic delivery in-app.
    // Explicit Test still works. Never trade duplicate safety for a fake guarantee.
    if(!allowedToPresent()||capabilities().permission!=='granted'||!navigator.locks?.request)return;
    const owner=scope();await lock(owner,async()=>{let count=0;for(const candidate of calculate().candidates){
      if(count>=5||!allowedToPresent()||owner!==scope())break;
      // Resolve fresh source status AND privacy copy immediately before display.
      const fresh=calculate(),c=fresh.candidates.find(c=>c.id===candidate.id);if(!c)continue;model=fresh;
      const d=load(owner),r=d.history[c.id];if(r?.seen||r?.dismissed||r?.delivered||r?.attempted||r?.retryAfter>Date.now())continue;
      d.history[c.id]={...r,day:date(),attempted:true};if(!store(d,owner))break;
      const ok=await present(c.title,c.body,c.tag,false,()=>owner===scope()?calculate().candidates.find(current=>current.id===c.id):null);count++;
      const updated=load(owner);updated.history[c.id]={...updated.history[c.id],day:date(),attempted:ok,delivered:ok,retryAfter:ok?0:Date.now()+300000};store(updated,owner);
    }});
  }
  function evaluate(delivery=true){
    try{model=calculateCenter();bell();if(dialog.open)paint();}catch(_){model={candidates:[],issues:['These records could not be evaluated safely.']};bell();if(dialog.open)paint();}
    if(delivery){queued=queued.catch(()=>{}).then(deliver).catch(()=>{storageWarning='Automatic browser reminders could not coordinate delivery. The in-app center remains available.';});return queued;}return Promise.resolve();
  }
  function schedule(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>evaluate(),80);}
  function settings(){
    if(window.CapReminderUI)return window.CapReminderUI.settings();
    stStart();const p=preferences(),cap=capabilities(),status=permissionLabel();
    const select=(k,label)=>`<select class="st-sel" aria-label="${label}" onchange="stNotifSet('${k}',this.value)">${engine.DAYS.map(d=>`<option value="${d}"${p[k]===d?' selected':''}>${d===0?'Due day only':d+' day'+(d===1?'':'s')+' before + due day'}</option>`).join('')}</select>`;
    const fields=[['bills','Bills','One-off and recurring bills','billsD'],['renew','Subscriptions','Recorded renewals','renewD'],['trial','Free Trials','Recorded trial end / first billing date','trialD'],['card','Credit Cards','Safely allocated stored statements','cardD']];
    const background=window.CapNotificationEnrollment?.settingsMarkup?.()||'';
    const reason=cap.permission==='denied'?'Your browser has blocked notifications. Cap will not ask again; change site permissions yourself if you want browser reminders.':cap.permission==='unsupported'?'Browser notification presentation is unavailable here. The in-app center still works.':cap.permission==='granted'?'Browser permission is allowed. Your device or operating system may still limit presentation.':'Browser permission has not been requested.';
    stSheet(stHead('Notifications','openSettings()')+`<div class="st-box">${stSw('Notifications','Get reminders for bills, subscriptions, trials and card due dates.',p.on,'stNotifMaster(this.checked)')}</div><div class="cn-permission"><b>Browser / PWA · ${status}</b><p>${reason}</p><p>Browser reminders may show merchant names on your lock screen. Amounts are hidden unless you explicitly enable them below.</p>${p.on&&cap.permission==='default'?'<button type="button" class="pill" onclick="CapNotifications.requestPermission()">Enable browser notifications</button>':''}${!cap.crossTabLock?'<p>Automatic browser delivery needs cross-tab coordination unavailable here. In-app reminders and an explicit permitted test remain available.</p>':''}</div>${background}<div class="st-grp eyebrow">Reminder timing</div><div class="st-box">${fields.map(([k,label,description,timing])=>stSw(label,description,p[k],`stNotifSet('${k}',this.checked)`)+stSel(label+' timing',select(timing,label+' timing'))).join('')}${stSw('Overdue Reminders','Recorded overdue bills and card payments',p.overdue,"stNotifSet('overdue',this.checked)")}</div><div class="st-grp eyebrow">Lock-screen privacy</div><div class="st-box">${stSw('Show amounts in notifications','Off by default. Uses only authoritative recorded amounts.',p.showAmounts,"stNotifSet('showAmounts',this.checked)")}</div><p class="st-note">Only notification preferences and minimal reminder history are stored on this device. Seeing or dismissing a reminder does not mark it paid.</p><button type="button" class="btn s" onclick="stNotifTest()">Test Notification</button><p class="st-note cn-settings-limit">Phase 5A does not guarantee scheduled notification delivery while Cap is completely closed. Reliable background push delivery is deferred to Phase 5B.</p>`,'set-notif',stKeep);
  }
  async function setPreference(k,v){
    if(!Object.hasOwn(engine.DEFAULTS,k))return;const revision=++preferenceRevision,value=engine.preferences({...preferences(),[k]:v})[k];pendingPreferences.set(k,{value,revision});
    const ok=await mutate(d=>{d.preferences=engine.preferences({...d.preferences,[k]:value})});if(pendingPreferences.get(k)?.revision===revision)pendingPreferences.delete(k);
    if(!ok){toast(storageWarning);return;}await evaluate();if(document.querySelector('#sheet.open:not(.closing)')&&(!window.CapReminderUI||document.getElementById('sb')?.dataset.settingsPage==='set-notif'))settings();
  }
  async function requestPermission(){
    const cap=capabilities();if(!preferences().on||cap.permission!=='default'){toast(cap.permission==='denied'?'Notifications are blocked in your browser.':cap.permission==='granted'?'Notification permission is already allowed.':'Browser notifications are unavailable.');return;}
    if(navigator.userActivation&&!navigator.userActivation.isActive){toast('Use Enable browser notifications in Settings.');return;}
    try{await Notification.requestPermission();}catch(_){}settings();await evaluate();
  }
  async function test(){const cap=capabilities();if(cap.permission!=='granted'){toast(cap.permission==='default'?'Enable browser notifications explicitly in Notification Settings first.':cap.permission==='denied'?'Notifications are blocked in your browser.':'This environment cannot present browser notifications.');return false;}
    const ok=await present('Cap notifications are ready',"You'll receive reminders based on your notification settings.",'cap-test-v1',true);toast(ok?'Test notification sent. Your device controls whether it is displayed.':'Could not present a notification. Check browser/PWA support and device settings.',ok);return ok;}
  new MutationObserver(schedule).observe(app,{childList:true});window.addEventListener('focus',schedule);document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule()});document.addEventListener('cap:launch-complete',schedule);
  window.addEventListener('storage',e=>{if(e.key===key(scope()))evaluate(false)});
  if(navigator.serviceWorker)navigator.serviceWorker.addEventListener('message',e=>{if(e.data?.type==='cap-notification-open'&&e.origin===location.origin){if(allowedToPresent())open()}});
  let fromNotification=false;try{const u=new URL(location.href);fromNotification=u.searchParams.get('cap-notifications')==='1';if(fromNotification){u.searchParams.delete('cap-notifications');history.replaceState(null,'',u)}}catch(_){}
  window.CapNotifications=Object.freeze({preferences,capabilities,evaluate,open,close:()=>dialog.open&&dialog.close(),settings,setPreference,requestPermission,test,settingsLabel:()=>!preferences().on?'Off':capabilities().permission==='granted'?'Allowed':'In app'});
  evaluate(false);if(fromNotification){const attempt=()=>{if(allowedToPresent())open()};window.capLaunchActive?document.addEventListener('cap:launch-complete',attempt,{once:true}):attempt();}
})();
