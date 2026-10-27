/* Read-only Search surface. All model projection/filtering/money calculations
   belong to the pure engine. Never opens existing editable financial sheets. */
(function(){
  'use strict';
  const parser=window.CapFinancialSearchParser,engine=window.CapFinancialSearchEngine,bar=window.CapCommandBar,root=document.getElementById('cap-command-bar'),input=document.getElementById('cap-command-input');
  if(!parser||!engine||!bar||!root)return;
  const panel=document.createElement('section');panel.className='fs-results';panel.hidden=true;panel.setAttribute('aria-label','Financial Search Results');root.appendChild(panel);
  let revision=0,model=null,shown=40;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=n=>php(n/100),active=()=>['open','opening'].includes(bar.getState().state)&&bar.getState().mode==='search';
  function place(){const p=bar.getPlacement();if(p)panel.style.maxHeight=Math.max(48,p.top-p.visibleTop-12)+'px';}
  function hide(){++revision;panel.hidden=true;model=null;}
  function artwork(row){
    const identity=window.CapSmartLogMerchants?.identity(row.title),art=typeof xb==='function'?xb(identity?.canonical||row.title):'';
    if(art)return art;
    return typeof ci==='function'&&row.category?ci(row.category):'<span aria-hidden="true">⌕</span>';
  }
  function rowHtml(row){
    const sign=row.source==='transaction'?(row.type==='expense'?'−':'+'):'';
    return `<li class="fs-row"><span class="fs-art" aria-hidden="true">${artwork(row)}</span><div class="fs-row-main"><b>${esc(row.title)}</b><small>${esc([row.category,row.accountName].filter(Boolean).join(' · '))}</small><small>${esc(row.date||'Date not recorded')}${row.status?' · '+esc(row.status):''}${row.pending?' · Pending':''}</small></div><strong class="${row.source==='transaction'?(row.type==='expense'?'fs-expense':'fs-income'):''}">${sign}${esc(money(row.cents))}</strong></li>`;
  }
  function render(){
    if(!model)return;
    const p=model.plan,s=model.summary,schedule=['bills','subscriptions','trials','statements'].includes(p.source);
    const label=p.source==='transfers'?'Transferred':p.source==='card-payments'?'Card payments':p.source==='bill-payments'?'Recorded bill payments':p.source==='statements'?'Recorded principal remaining':p.source==='trials'?'Free trials':p.source==='subscriptions'?'Scheduled subscriptions':p.source==='bills'?'Scheduled bills':p.type==='expense'?'Spent':p.type==='income'?'Received':'Transaction volume';
    const head=`<header class="fs-head"><div><span class="fs-eyebrow">LOCAL · READ ONLY</span><h3 tabindex="-1">Financial Search</h3></div><button type="button" data-fs-action="dismiss" aria-label="Dismiss Search Results">×</button></header><p class="fs-query">${esc(p.original)}</p><div class="fs-chips" aria-label="Search interpretation">${p.chips.map(c=>`<span>${esc(c)}</span>`).join('')}</div>`;
    if(model.state!=='ready'){
      panel.innerHTML=head+`<div class="fs-empty"><h4>${model.state==='unknown'?'I couldn’t match that search yet.':'Let’s clarify that search'}</h4>${p.issues.map(i=>`<p>${esc(i)}</p>`).join('')}<p class="fs-help">Try “Food this month”, “Jollibee this year” or “Show unpaid bills”.</p></div>`;
    }else if(!s.count){panel.innerHTML=head+`<div class="fs-empty"><h4>No matching ${schedule?'records':'transactions'}</h4><p>Nothing in your local data matches these filters.</p></div>`+(model.notes||[]).map(n=>`<p class="fs-note">${esc(n)}</p>`).join('');}
    else{
      const headline=p.metric==='count'||p.source==='trials'?String(s.count):money(p.metric==='largest'?s.largest.cents:s.totalCents);
      panel.innerHTML=head+`<div class="fs-summary"><div class="fs-total">${esc(headline)}</div><p>${p.metric==='largest'?'Largest · ':''}${esc(label)}${p.date?' · '+esc(p.date.label):' · All recorded dates'}</p><div class="fs-stats"><span><b>${s.count}</b> ${schedule?'records':'events'}</span>${!schedule?`<span>Average <b>${esc(money(s.averageCents))}</b></span><span>Largest <b>${esc(money(s.largest.cents))}</b></span>`:''}</div></div>`
        +(model.monthly?`<p class="fs-note"><b>${esc(money(model.monthly.cents))}/month</b> · ${esc(model.monthly.label)}${model.monthly.unsupported?' · One-time schedules excluded':''}</p>`:'')
        +`<ul class="fs-list">${model.rows.slice(0,shown).map(rowHtml).join('')}</ul>`
        +(s.count>shown?`<button type="button" class="fs-more" data-fs-action="more">Show more · ${s.count-shown} remaining</button>`:'')
        +(model.notes||[]).map(n=>`<p class="fs-note">${esc(n)}</p>`).join('');
    }
    panel.hidden=false;place();
  }
  async function submit(text){
    if(!active())return;
    const token=++revision;panel.hidden=true;shown=40;
    try{
      // One detached projection per explicit submit: never render/save the app,
      // never retain a stale index after sync or in-place local record edits.
      const data=engine.snapshot(S,CapSmartLogParser.localDate(new Date()),catNames());
      const plan=parser.parse(text,data),result=engine.search(plan,data);
      if(!await bar.dismissKeyboard()||token!==revision||!active())return;
      model=result;render();panel.querySelector('h3')?.focus({preventScroll:true});
    }catch(_){
      if(!await bar.dismissKeyboard()||token!==revision||!active())return;
      model={state:'clarify',plan:{original:text,chips:[],issues:['This search could not be calculated safely. Narrow the filters and try again.']}};render();
    }
  }
  panel.addEventListener('click',e=>{const action=e.target.closest('[data-fs-action]')?.dataset.fsAction;if(action==='dismiss'){hide();input.focus({preventScroll:true});}if(action==='more'){shown+=40;render();}});
  panel.addEventListener('error',e=>{if(e.target?.tagName==='IMG')e.target.replaceWith(Object.assign(document.createElement('span'),{textContent:'⌕'}));},true);
  root.addEventListener('cap:command-submit',e=>{if(e.detail.mode==='search')submit(e.detail.text);});
  root.addEventListener('cap:command-change',hide);
  root.addEventListener('cap:command-close',hide);
  root.addEventListener('cap:command-edit-focus',e=>{if(e.detail.command)hide();});
  root.addEventListener('cap:command-position',place);
  root.addEventListener('cap:command-escape',e=>{if(!panel.hidden){e.preventDefault();hide();input.focus({preventScroll:true});}});
})();
