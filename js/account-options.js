/* Account presentation preferences are additive; sorting never changes balances. */
let accountSelecting=false,accountSelected=new Set();
function accountSorted(accounts){
  const order=S.accountOrder||[],sort=accountSelecting?'manual':S.accountSort||'manual';
  const rank=a=>{const i=order.map(String).indexOf(String(a.id));return i<0?order.length+S.accts.indexOf(a):i};
  const recent=a=>Math.max(0,...S.tx.filter(t=>String(t.acct)===String(a.id)).map(t=>Date.parse(t.d)||0),...(S.xfer||[]).filter(t=>String(t.from)===String(a.id)||String(t.to)===String(a.id)).map(t=>Date.parse(t.d)||0));
  return [...accounts].sort((a,b)=>(sort==='name'?String(a.nickname||a.name).localeCompare(String(b.nickname||b.name)):sort==='balance'?(+b.bal||0)-(+a.bal||0):sort==='recent'?recent(b)-recent(a):rank(a)-rank(b))||S.accts.indexOf(a)-S.accts.indexOf(b));
}
function accountOptionsHeader(){
  const ico={
    check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.2 12.4l2.6 2.6 5-5.6"/></svg>',
    grid:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/></svg>',
    list:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="3.2" height="3.2" rx=".8"/><rect x="3" y="10.4" width="3.2" height="3.2" rx=".8"/><rect x="3" y="15.8" width="3.2" height="3.2" rx=".8"/><path d="M10.5 6.6h10M10.5 12h10M10.5 17.4h10"/></svg>'
  };
  const row=(label,icon,action,on)=>`<button type="button" role="menuitemradio" aria-checked="${on}" onclick="${action}"><span class="ao-check">${on?'✓':''}</span><span class="ao-icon" aria-hidden="true">${icon}</span><span>${label}</span></button>`;
  return `<div class="account-heading"><h1>Accounts</h1><button id="account-options-button" class="pill account-options-button" aria-label="Account view and sorting" aria-haspopup="menu" aria-expanded="false" onclick="toggleAccountOptions()">⋯</button><div id="account-options-menu" class="account-options-menu" role="menu" aria-label="Account options" hidden><button role="menuitem" onclick="accountSelectStart()"><span class="ao-check"></span><span class="ao-icon" aria-hidden="true">${ico.check}</span><span>Select</span></button><div role="separator"></div>${row('Grid',ico.grid,"accountChooseView('all')",S.accountView!=='carousel')}${row('Carousel',ico.list,"accountChooseView('carousel')",S.accountView==='carousel')}<div role="separator"></div><p>Sort by…</p>${[['recent','Recent'],['name','Name'],['balance','Balance'],['manual','Manual']].map(([key,label])=>row(label,'',`accountChooseSort('${key}')`,(S.accountSort||'manual')===key)).join('')}</div></div>`;
}
function toggleAccountOptions(){const menu=document.getElementById('account-options-menu');if(!menu)return;menu.hidden=!menu.hidden;document.getElementById('account-options-button').setAttribute('aria-expanded',String(!menu.hidden));if(!menu.hidden)menu.querySelector('button').focus()}
function closeAccountOptions(focus=false){const menu=document.getElementById('account-options-menu');if(menu)menu.hidden=true;const btn=document.getElementById('account-options-button');if(btn){btn.setAttribute('aria-expanded','false');if(focus)btn.focus()}}
function accountChooseView(view){accountSelecting=false;accountSelected.clear();accountViewSelect(view);document.getElementById('account-options-button')?.focus()}
function accountChooseSort(sort){S.accountSort=sort;accountSelecting=false;accountSelected.clear();render();document.getElementById('account-options-button')?.focus()}
function accountSelectStart(){accountSelecting=true;accountSelected.clear();render()}
function accountSelectEnd(){accountSelecting=false;accountSelected.clear();render()}
function accountSelectCard(id,checked){
  if(checked)accountSelected.add(String(id));else accountSelected.delete(String(id));
  const allBtn=document.querySelector('.account-select-all'),total=(S.accts||[]).length,all=total>0&&accountSelected.size===total;
  if(allBtn){allBtn.textContent=all?'Deselect all':'Select All';allBtn.setAttribute('aria-pressed',String(all))}
}
function accountSelectAllToggle(){const total=(S.accts||[]).length;if(total&&accountSelected.size===total)accountSelected.clear();else (S.accts||[]).forEach(a=>accountSelected.add(String(a.id)));render()}
function accountSelectionBar(){
  if(!accountSelecting)return '';
  const total=(S.accts||[]).length,all=total>0&&accountSelected.size===total;
  return `<div class="account-selection-bar">${accountSelectAllButton(all)}<button type="button" class="account-select-confirm" aria-label="Finish selecting" onclick="accountSelectEnd()">✓</button></div>
<small class="account-selection-hint">Tap cards to select them, then drag to reorder. Selected cards move together, and changes save automatically.</small>`;
}
function accountSelectAllButton(all){return `<button type="button" class="pill account-select-all" aria-pressed="${all}" onclick="accountSelectAllToggle()">${all?'Deselect all':'Select All'}</button>`}
function accountSelectableCard(a){return `<label class="account-select-card" data-account-id="${a.id}"><input type="checkbox" ${accountSelected.has(String(a.id))?'checked':''} onchange="accountSelectCard('${a.id}',this.checked)" aria-label="${esc(a.nickname||a.name)}"><span class="account-select-art">${cardH(a,0)}<span class="account-select-circle" aria-hidden="true"></span></span><span class="account-select-name">${esc(a.nickname||a.name)}</span></label>`}
/* Drag-to-reorder: only selected cards move, and only inside their own group.
   The dragged card follows the pointer while its neighbours glide aside (FLIP). */
let accountDrag=null,accountDragSuppress=0;
const ACCOUNT_DRAG_SLOP=6;
function accountDragTarget(drag,x,y){
  for(const el of drag.group.children){
    if(drag.block.includes(el))continue;
    const r=el.getBoundingClientRect();
    if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom)return el;
  }
  return null;
}
function accountDragReorder(drag,target){
  const group=drag.group,block=drag.block,current=[...group.children];
  const rect=target.getBoundingClientRect();
  const before=drag.lastPointerX<rect.left+rect.width/2;
  const remaining=current.filter(el=>!block.includes(el));
  const ref=before?target:remaining[remaining.indexOf(target)+1]||null;
  const next=[...remaining];
  if(ref)next.splice(next.indexOf(ref),0,...block);else next.push(...block);
  if(next.length===current.length&&next.every((el,i)=>el===current[i]))return;
  const prev=new Map(current.map(el=>[el,el.getBoundingClientRect()]));
  next.forEach(el=>group.appendChild(el));
  const after=new Map([...group.children].map(el=>[el,el.getBoundingClientRect()]));
  for(const [el,r] of prev){
    if(el===drag.card)continue;
    const nr=after.get(el);if(!nr)continue;
    const dx=r.left-nr.left,dy=r.top-nr.top;
    if(Math.abs(dx)<1&&Math.abs(dy)<1)continue;
    el.style.transition='none';
    el.style.transform=`translate3d(${dx}px,${dy}px,0)`;
    void el.offsetWidth;
    el.style.transition='transform .22s cubic-bezier(.2,.8,.2,1)';
    el.style.transform='';
    clearTimeout(el._accountGlide);
    el._accountGlide=setTimeout(()=>{el.style.transition='';el.style.transform=''},260);
  }
}
function accountDragMove(e){
  const drag=accountDrag;
  if(!drag||e.pointerId!==drag.pointerId)return;
  drag.lastPointerX=e.clientX;drag.lastPointerY=e.clientY;
  if(!drag.started){
    if(Math.max(Math.abs(e.clientX-drag.startX),Math.abs(e.clientY-drag.startY))<ACCOUNT_DRAG_SLOP)return;
    drag.started=true;
    drag.card.classList.add('dragging');
    drag.block.forEach(el=>{if(el!==drag.card)el.classList.add('block-moving')});
    drag.art=drag.card.querySelector('.account-select-art');
    if(drag.art){drag.art.style.transform='translateY(-8px) scale(1.06)';drag.art.style.filter='drop-shadow(0 26px 42px #000000b3)'}
    try{drag.card.setPointerCapture(e.pointerId)}catch(_){}
    const r=drag.card.getBoundingClientRect();
    drag.grabDX=r.left-drag.startX;drag.grabDY=r.top-drag.startY;
  }
  e.preventDefault();
  const r=drag.card.getBoundingClientRect();
  drag.tx=(e.clientX+drag.grabDX)-(r.left-drag.tx);
  drag.ty=(e.clientY+drag.grabDY)-(r.top-drag.ty);
  drag.card.style.transform=`translate3d(${drag.tx}px,${drag.ty}px,0)`;
  const target=accountDragTarget(drag,e.clientX,e.clientY);
  if(target)accountDragReorder(drag,target);
}
function accountDragEnd(e){
  const drag=accountDrag;
  if(!drag||(e&&e.pointerId!==drag.pointerId))return;
  accountDrag=null;
  if(!drag.started)return;
  try{drag.card.releasePointerCapture(drag.pointerId)}catch(_){}
  drag.card.style.transition='transform .24s cubic-bezier(.2,.8,.2,1)';
  drag.card.style.transform='';
  if(drag.art){drag.art.style.transform='';drag.art.style.filter=''}
  drag.block.forEach(el=>el.classList.remove('block-moving'));
  accountDragSuppress=performance.now()+600;
  const order=[...document.querySelectorAll('.account-select-card')].map(c=>Number(c.dataset.accountId)).filter(n=>!Number.isNaN(n));
  if(order.length){S.accountOrder=order;S.accountSort='manual';try{save()}catch(_){}}
  setTimeout(()=>{drag.card.classList.remove('dragging');drag.card.style.transition=''},280);
}
document.addEventListener('pointerdown',e=>{
  if(!accountSelecting||accountDrag||e.button>0||e.isPrimary===false)return;
  const card=e.target&&e.target.closest?e.target.closest('.account-select-card'):null;
  if(!card)return;
  const input=card.querySelector('input');
  if(!input||!input.checked)return;
  const group=card.parentElement;
  if(!group||!group.classList.contains('cards'))return;
  const block=[...group.children].filter(el=>el.classList.contains('account-select-card')&&el.querySelector('input')&&el.querySelector('input').checked);
  accountDrag={card,group,block:block.length?block:[card],pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,lastPointerX:e.clientX,lastPointerY:e.clientY,tx:0,ty:0,grabDX:0,grabDY:0,started:false,art:null};
});
window.addEventListener('pointermove',accountDragMove,{passive:false});
window.addEventListener('pointerup',accountDragEnd);
window.addEventListener('pointercancel',accountDragEnd);
/* A drag must never also toggle the card it started on. */
document.addEventListener('click',e=>{
  if(!accountDragSuppress||performance.now()>accountDragSuppress)return;
  const card=e.target&&e.target.closest?e.target.closest('.account-select-card'):null;
  if(!card)return;
  e.stopImmediatePropagation();e.preventDefault();accountDragSuppress=0;
},true);
document.addEventListener('pointerdown',e=>{if(!e.target.closest('.account-heading'))closeAccountOptions()});
document.addEventListener('keydown',e=>{
  const menu=document.getElementById('account-options-menu');if(!menu||menu.hidden)return;
  if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closeAccountOptions(true)}
  else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const buttons=[...menu.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus()}
},true);
document.addEventListener('focusin',e=>{if(!e.target.closest('.account-heading'))closeAccountOptions()});
