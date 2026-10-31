/* Phase 2C notification-only UI. Existing sheet, theme, focus and motion system.
   No enrollment, publisher, OS presentation, financial mutation or network IO. */
(function(){
  'use strict';
  const api=window.CapReminderEditor,scheduler=window.CapNotificationSchedule,legacy=window.CapNotifications;
  if(!api||!scheduler||!legacy)return;
  const editor=api.create(),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const owner=()=>String(window.CapSupabase?.localIdentity?.()||'local');
  const today=()=>CapSmartLogParser.localDate(new Date());
  const labels={bills:'Bills',renew:'Subscriptions',card:'Credit Cards',trial:'Free Trials'};
  const stateLabels={SAVED_LOCAL:'Saved on this device',PENDING_SYNC:'Pending',SCHEDULED:'Scheduled',CHANGE_PENDING:'Change pending',CANCELLATION_PENDING:'Cancellation pending',OUTSIDE_RANGE:'Outside scheduling range',ACTION_REQUIRED:'Action required',DELIVERY_UNCERTAIN:'Delivery uncertain',EXPIRED:'Expired',SENT:'Sent'};
  let cachedPolicy=null,cachedItems=[],selected=null,selectedCategory='bills',loadSequence=0,uiSequence=0,activeOwner=owner();
  const prettyDate=value=>scheduler.validDateKey(value)?new Date(value+'T12:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'Choose a date';
  const friendly=api.friendlyTime;
  function descriptors(){
    const snapshot=CapFinancialSearchEngine.snapshot(S,today()),result=[];
    for(const row of snapshot.definitions.filter(r=>r.active&&r.status!=='paid'&&scheduler.validDateKey(r.date))){
      const source=row.trial?'trial':row.source,category=row.trial?'trial':row.source==='subscription'?'renew':'bills';
      result.push({source,id:String(row.id),category,due_date:row.date,title:CapNotificationEngine.safeLabel(row.title),cycle_context:'',proven_overdue:row.status==='late',incarnation:(S.bills||[]).find(b=>String(b.id)===String(row.id))});
    }
    for(const account of (S.accts||[]).filter(a=>a.type==='credit'&&Number(a.bal)>0)){
      const row=snapshot.statements.filter(s=>String(s.account)===String(account.id)&&s.id.slice(-10)<=today()).sort((a,b)=>b.id.localeCompare(a.id))[0];
      if(!row||row.uncertain||row.cents<=0||!scheduler.validDateKey(row.due))continue;
      result.push({source:'statement',id:String(account.id),category:'card',due_date:row.due,title:CapNotificationEngine.safeLabel(account.bank||account.name||'Credit card'),cycle_context:row.id,proven_overdue:row.status==='late',incarnation:account});
    }
    return result;
  }
  const findDescriptor=(source,id)=>{const matches=descriptors().filter(d=>d.source===source&&d.id===String(id));return matches.length===1?matches[0]:null;};
  function currentItem(){return selected&&cachedItems.find(i=>!i.closed&&i.source===selected.source&&i.id===selected.id);}
  async function refresh(){
    const sequence=++loadSequence,scope=owner();
    if(scope!==activeOwner){activeOwner=scope;editor.forget();selected=null;cachedItems=[];}
    const {policy}=await scheduler.ensurePolicy(legacy.preferences());
    const items=await editor.items(scope,descriptors());
    if(sequence!==loadSequence||scope!==owner())return;
    cachedPolicy=policy;cachedItems=items;
  }
  function section(title,html){return `<div class="st-grp eyebrow">${title}</div><div class="st-box cn-settings-group">${html}</div>`;}
  function row(label,value,action,extra=''){return `<button type="button" class="cn-setting-row" ${action?`data-action="${action}"`:''} ${extra}><span>${label}</span><span class="cn-setting-value">${value}${action?' <span aria-hidden="true">›</span>':''}</span></button>`;}
  function mount(title,html,page,back){
    ++uiSequence;
    stStart();stSheet(stHead(title,back||'stGo(\'notif\')')+`<div class="cn-editor-content">${html}<p id="cn-editor-status" class="st-note" role="status" aria-live="polite"></p></div>`,page,0);
    const root=document.getElementById('sb');
    // One shared handler on the stable sheet; remove before rebinding.
    root.removeEventListener('click',dispatch);root.addEventListener('click',dispatch);
  }
  function status(message){const node=document.getElementById('cn-editor-status');if(node)node.textContent=message;else toast(message);}
  function explain(error){return ({NOTIFICATION_LOCAL_TIME_GAP:"That time isn’t available on this date. Choose another time.",REMINDER_PAST:'Choose a future date and time.',REMINDER_DUPLICATE:'A reminder already uses that time.',REMINDER_INVALID:'Choose a valid date, time and reminder.',REVIEW_REQUIRED:'Review this item before changing its reminders.',COORDINATION_UNAVAILABLE:'Editing is unavailable on this device.',STORAGE_UNAVAILABLE:'Could not save on this device.'})[error?.code]||'Could not save this change. Please try again.';}
  async function settings(){
    const sequence=++uiSequence;
    try{await refresh();if(sequence!==uiSequence)return;
      const p=legacy.preferences(),cap=legacy.capabilities();
      const permission=cap.permission==='denied'?'Blocked — change notification permission in device settings.':cap.permission==='unsupported'?'Unavailable here. Reminders stay in Cap.':cap.permission==='granted'?'Allowed while Cap is open. Background delivery is not active.':'In Cap only. Allow notifications to show reminders while Cap is open.';
      mount('Notifications',section('Delivery',stSw('Push Notifications','While Cap is open',p.on,"stNotifSet('on',this.checked)")+row('Email Notifications','Coming Soon',null,'disabled aria-disabled="true"'))+
        `<div class="cn-permission"><p>${esc(permission)}</p>${p.on&&cap.permission==='default'?'<button type="button" class="pill" data-action="permission">Allow Notifications</button>':''}</div>`+
        section('Reminders',Object.entries(labels).map(([k,label])=>stSw(label,'',p[k],`stNotifSet('${k}',this.checked)`)).join(''))+
        section('Schedule',row('Default Reminder Time',friendly(cachedPolicy.default_local_time),'default-time')+row('Default Reminders','Edit','defaults'))+
        section('Privacy',stSw('Show Amounts','',p.showAmounts,"stNotifSet('showAmounts',this.checked)"))+
        '<button type="button" class="btn s cn-test" data-action="test">Test Notification</button>','set-notif','openSettings()');
    }catch(e){toast(explain(e));}
  }
  function defaultTime(){mount('Default Reminder Time',`<label class="cn-field" for="cn-default-time">Time<input id="cn-default-time" type="time" required value="${cachedPolicy.default_local_time}"></label><p class="st-note">Used by reminders set to Default. Custom reminders stay unchanged.</p><button class="btn" type="button" data-action="save-default-time">Save Time</button>`,'set-notif-time');}
  function defaults(){
    const stages=cachedPolicy.category_stages[selectedCategory]||cachedPolicy.default_stages;
    mount('Default Reminders',`<label class="cn-field" for="cn-default-category">For<select id="cn-default-category">${Object.entries(labels).map(([k,l])=>`<option value="${k}" ${k===selectedCategory?'selected':''}>${l}</option>`).join('')}</select></label>`+
      section('Remind me',scheduler.LEAD_DAYS.map(d=>`<label class="cn-stage"><span>${esc(api.leadLabel(d,selectedCategory))}</span><input type="checkbox" name="cn-stage" value="${d}" ${stages.includes(d)?'checked':''}></label>`).join(''))+
      '<p class="st-note">Applies to items using default reminders. Individually edited reminders stay unchanged.</p><button type="button" class="btn" data-action="save-defaults">Save Reminders</button>','set-notif-defaults');
    document.getElementById('cn-default-category').addEventListener('change',event=>{selectedCategory=event.target.value;defaults();});
  }
  function itemState(item){if(!item||item.review_required||item.plan?.identity_blocked)return 'Action required';return item.plan?.outside.length?'Outside scheduling range':'Saved on this device';}
  function reminderLabel(r,item){
    return r.kind==='absolute'?`Custom <span>${prettyDate(r.local_date)} · ${friendly(r.local_time)}</span>`:`${esc(api.leadLabel(r.days_before,item.category))} <span>${r.time_source==='override'?friendly(r.override_local_time):'Default · '+friendly(cachedPolicy.default_local_time)}</span>`;
  }
  async function openItem(source,id){
    const descriptor=findDescriptor(source,id);if(!descriptor)return toast('No outstanding recorded occurrence is available.');
    selected=descriptor;await refresh();paintItem();
  }
  function paintItem(){
    if(!selected)return;
    const item=currentItem(),needs=!item||item.review_required;
    const review=needs?`<p class="st-note">${item?'Confirm whether this is the same outstanding item before changing reminders.':'Set up reminders for this recorded occurrence.'}</p><div class="cn-review">${item?'<button type="button" class="btn s" data-action="review-same">Same outstanding item</button><button type="button" class="btn s" data-action="review-cycle">Next occurrence</button>':''}<button type="button" class="btn s" data-action="review-source">${item?'Recreated item':'Set Up Reminders'}</button></div>`:'';
    mount('Reminders',`<p class="cn-item-title">${esc(selected.title)}</p><p class="st-note">${prettyDate(selected.due_date)} · ${itemState(item)}</p>${review}`+
      (item?section('Reminders',item.reminders.map(r=>`<button type="button" class="cn-reminder-row" data-action="edit-reminder" data-id="${esc(r.reminder_id)}" ${needs?'disabled':''}>${reminderLabel(r,item)}<span aria-hidden="true">›</span></button>`).join('')||'<p class="st-note">No reminders</p>'):'')+
      `<button type="button" class="btn s" data-action="add-reminder" ${needs?'disabled':''}>+ Add Reminder</button>`,'set-notif-item');
  }
  function chooseKind(){mount('Add Reminder',section('Choose a reminder',row('Relative Reminder','Before the due date','add-relative')+row('Custom Date &amp; Time','Exact date and time','add-custom')),'set-notif-add',"CapReminderUI.backToItem()");}
  function editReminder(id,kind){
    const item=currentItem(),r=item?.reminders.find(r=>r.reminder_id===id)||{kind:kind||'relative',days_before:3,time_source:'inherit',local_date:selected.due_date,local_time:cachedPolicy.default_local_time};
    if(!item||item.review_required)return paintItem();
    const fields=r.kind==='absolute'?`<label class="cn-field" for="cn-reminder-date">Date<input id="cn-reminder-date" type="date" required value="${r.local_date}"></label><label class="cn-field" for="cn-reminder-time">Time<input id="cn-reminder-time" type="time" required value="${r.local_time}"></label><p class="st-note">This exact reminder stays fixed when you travel or the due date changes.</p>`:
      `<label class="cn-field" for="cn-reminder-lead">Reminder<select id="cn-reminder-lead">${scheduler.LEAD_DAYS.map(d=>`<option value="${d}" ${r.days_before===d?'selected':''}>${esc(api.leadLabel(d,item.category))}</option>`).join('')}</select></label><label class="cn-field" for="cn-time-source">Time<select id="cn-time-source"><option value="inherit" ${r.time_source==='inherit'?'selected':''}>Use Default Time · ${friendly(cachedPolicy.default_local_time)}</option><option value="override" ${r.time_source==='override'?'selected':''}>Custom Time</option></select></label><label class="cn-field" id="cn-override-field" for="cn-reminder-time" ${r.time_source!=='override'?'hidden':''}>Custom Time<input id="cn-reminder-time" type="time" value="${r.override_local_time||cachedPolicy.default_local_time}"></label>`;
    mount(r.kind==='absolute'?'Custom Reminder':'Relative Reminder',fields+`<button type="button" class="btn" data-action="save-reminder" data-kind="${r.kind}" data-id="${id||''}">Save Reminder</button>${id?`<button type="button" class="btn s cn-delete" data-action="delete-reminder" data-id="${esc(id)}">Delete Reminder</button>`:''}`,'set-notif-reminder',"CapReminderUI.backToItem()");
    document.getElementById('cn-time-source')?.addEventListener('change',e=>{document.getElementById('cn-override-field').hidden=e.target.value!=='override';});
  }
  let busy=false;
  async function dispatch(event){
    const button=event.target.closest('[data-action]');if(!button||!document.getElementById('sb').contains(button)||busy)return;
    const action=button.dataset.action,scope=owner();
    if(!['permission','test'].includes(action))event.preventDefault();
    try{
      if(action==='default-time')return defaultTime();if(action==='defaults')return defaults();
      if(action==='permission')return legacy.requestPermission();if(action==='test')return legacy.test();
      if(action==='add-reminder')return chooseKind();if(action==='add-relative')return editReminder(null,'relative');if(action==='add-custom')return editReminder(null,'absolute');if(action==='edit-reminder')return editReminder(button.dataset.id);
      busy=true;button.disabled=true;button.setAttribute('aria-busy','true');
      if(action==='save-default-time'){
        const time=document.getElementById('cn-default-time').value;if(!scheduler.validLocalTime(time))throw Object.assign(Error(),{code:'REMINDER_INVALID'});
        await editor.defaultTime(scope,time);await refresh();return settings();
      }
      if(action==='save-defaults'){
        await editor.defaults(scope,selectedCategory,[...document.querySelectorAll('input[name="cn-stage"]:checked')].map(e=>Number(e.value)));await refresh();return settings();
      }
      const fresh=selected&&findDescriptor(selected.source,selected.id);
      if(!fresh)throw Object.assign(Error(),{code:'REVIEW_REQUIRED'});
      if(action.startsWith('review-'))await editor.review(scope,fresh,action.slice(7),legacy.preferences());
      else if(action==='save-reminder'){
        const kind=button.dataset.kind,raw=kind==='absolute'?{kind,local_date:document.getElementById('cn-reminder-date').value,local_time:document.getElementById('cn-reminder-time').value}:{kind,days_before:Number(document.getElementById('cn-reminder-lead').value),time_source:document.getElementById('cn-time-source').value,override_local_time:document.getElementById('cn-reminder-time').value};
        const result=await editor.saveReminder(scope,currentItem().obligation_id,fresh,raw,button.dataset.id||null);
        if(result.custom_won)toast('Custom reminder kept instead of the matching relative reminder.');
      }else if(action==='delete-reminder')await editor.remove(scope,currentItem().obligation_id,fresh,button.dataset.id);
      if(scope!==owner())return;
      selected=fresh;await refresh();paintItem();legacy.evaluate(false);
    }catch(e){status(explain(e));}finally{busy=false;if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy');}}
  }
  // Nonvisual integration: append a single Reminders action to existing item
  // sheets after their own navigation finishes. Never wrap financial saves.
  let detail=null;
  for(const [name,type,selector] of [['editBillSheet','bill','#eb-n'],['upBillSheet','bill','.up-sheet'],['cardPayInfo','statement','.cc-latest-summary'],['upCardSheet','statement','.up-sheet']]){
    const original=window[name];if(typeof original!=='function')continue;
    window[name]=function(id){detail={type,id,selector};const result=original.apply(this,arguments);queueMicrotask(inject);return result;};
  }
  function inject(){
    const sb=document.getElementById('sb');if(!detail||!sb||sb.querySelector('.cn-item-reminders'))return;
    if(!sb.querySelector(detail.selector))return;
    const d=descriptors().find(d=>d.id===String(detail.id)&&(detail.type==='statement'?d.source==='statement':d.source!=='statement'));
    if(!d)return;
    const block=document.createElement('div');block.className='cn-item-reminders';block.innerHTML='<div class="eyebrow">Reminders</div><button type="button" class="ph-row"><span>Reminders</span><span aria-hidden="true">›</span></button>';
    block.querySelector('button').addEventListener('click',()=>openItem(d.source,d.id));
    const marker=sb.querySelector('.logo-row')||sb.querySelector(detail.selector);if(marker)marker.after(block);else sb.append(block);
  }
  new MutationObserver(inject).observe(document.getElementById('sb'),{childList:true,subtree:true});
  function centerPolicy(preferences){
    const p={...preferences};if(cachedPolicy)for(const category of scheduler.CATEGORIES){
      const stages=cachedPolicy.category_stages[category]||[];
      const individual=cachedItems.filter(i=>i.category===category&&!i.closed).flatMap(i=>i.reminders.filter(r=>r.kind==='relative').map(r=>r.days_before));
      if(stages.length||individual.length)p[category+'D']=Math.max(...stages,...individual);else p[category+'D']=0;
    }return p;
  }
  function centerModel(preferences){
    const model=CapNotificationEngine.evaluate(S,{today:today(),preferences:centerPolicy(preferences)});
    if(!cachedPolicy)return model;
    model.candidates=model.candidates.filter(c=>{
      if(c.daysUntil<=0)return true;
      const item=cachedItems.find(i=>!i.closed&&i.source===c.sourceType&&i.id===c.sourceId);
      const stages=item?item.reminders.filter(r=>r.kind==='relative').map(r=>r.days_before):cachedPolicy.category_stages[c.category]||[];
      return stages.length&&c.daysUntil<=Math.max(...stages)||!!item?.plan?.entries.some(e=>e.kind==='absolute');
    });
    // A custom reminder can be relevant even when its financial due date is well
    // beyond the default lead window. Add only a proven, still-outstanding source
    // from the read-only projection; do not invent a second financial projection.
    if(preferences.on){
      const snapshot=CapFinancialSearchEngine.snapshot(S,today());
      for(const item of cachedItems.filter(i=>!i.review_required&&preferences[i.category]&&i.plan?.entries.some(e=>e.kind==='absolute'))){
        if(model.candidates.some(c=>c.sourceType===item.source&&c.sourceId===item.id))continue;
        const d=findDescriptor(item.source,item.id);if(!d)continue;
        const row=item.source==='statement'?snapshot.statements.find(r=>r.id===d.cycle_context):snapshot.definitions.find(r=>String(r.id)===item.id);
        const days=Math.round((new Date(d.due_date+'T12:00:00')-new Date(today()+'T12:00:00'))/864e5);
        model.candidates.push({id:'cap-reminder-v1:local:'+item.obligation_id,sourceType:item.source,sourceId:item.id,category:item.category,brandLabel:d.title,
          dueDate:d.due_date,eligibleDate:today(),occurrence:item.source==='statement'?d.cycle_context.slice(-10):d.due_date,daysUntil:days,urgency:days<0?'overdue':days===0?'today':'upcoming',amountCents:row?.cents??null,title:d.title,body:''});
      }
    }
    return model;
  }
  window.CapReminderUI=Object.freeze({settings,openItem,refresh,backToItem:paintItem,editor,descriptors,centerPolicy,centerModel,
    policy:()=>cachedPolicy,items:()=>activeOwner===owner()?cachedItems:[],stateLabel:s=>stateLabels[s]||'Saved on this device',itemState,
    copy:api.copy,friendlyTime:friendly,urgency:api.urgency});
  const originalClose=window.closeS;
  window.closeS=function(){++uiSequence;return originalClose.apply(this,arguments);};
  // No automatic identity creation/review, permission, enrollment or publication.
  refresh().then(()=>legacy.evaluate(false)).catch(()=>{});
  window.addEventListener('focus',()=>refresh().then(()=>legacy.evaluate(false)).catch(()=>{}));
  window.addEventListener('storage',()=>{editor.forget();refresh().catch(()=>{});});
})();
