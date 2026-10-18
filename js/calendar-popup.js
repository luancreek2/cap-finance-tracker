/* Calendar event popover — deliberately separate from the full-screen sheet.
   It reads the existing evs() event stream, so the calendar remains the single
   source for transactions, bills, card due dates, statement dates, and payments. */
(function(){
  let CP=null,closeTimer=0;
  const $cp=s=>document.querySelector(s);
  const rm=()=>matchMedia('(prefers-reduced-motion:reduce)').matches||S.rm===1||S.anim===0;
  const dateLong=k=>new Date(k+'T00:00:00').toLocaleDateString('en-PH',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  const color=e=>({o:'#ff453a',i:'#30d158',s:'#ffd60a',u:'#ffd60a'}[e.c]||'var(--g)');
  const esc0=s=>typeof esc==='function'?esc(String(s==null?'':s)):String(s==null?'':s);
  const eventAt=(k,j)=>evs(k)[j];
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const tone=s=>/^(Posted|Paid|Recorded)$/.test(s)?'var(--g)':s==='Pending'?'var(--r)':'var(--yl)';
  const REPEAT='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
  /* The selected chip is cloned above the blur and scaled by FLOAT, so the
     card's arrow and the clone's bounds are laid out from the same box. */
  const FLOAT=1.12;
  function anchorBox(a,g){
    if(!a||typeof a.getBoundingClientRect!=='function')return null;
    const r=a.getBoundingClientRect();if(!r.width&&!r.height)return null;
    const f=g||FLOAT,w=r.width*f,h=r.height*f,cx=r.left+r.width/2,cy=r.top+r.height/2;
    return {left:cx-w/2,top:cy-h/2,width:w,height:h,right:cx+w/2,bottom:cy+h/2,cx,cy};
  }

  function resolve(k,j){
    const e=eventAt(k,j);if(!e)return null;
    const tx=e.kind==='tx',bill=e.kind==='bill',due=e.kind==='due',stmt=e.kind==='stmt',xfer=e.kind==='xfer';
    const o=tx?(S.tx.find(x=>x.id===e.id)||S.pend.find(x=>x.id===e.id)):bill?S.bills.find(x=>x.id===e.id):xfer?S.xfer.find(x=>x.id===e.id):acct(e.id);
    if(!o)return null;
    const ac=tx?acct(o.acct):xfer?acct(o.to):bill?acct(o.acct):o,accountMove=xfer&&o.kind==='account-transfer';
    const title=tx?(o.note||o.cat):bill?o.name:accountMove?'Account transfer':xfer?(ac.name+' payment'):due?(ac.name+' due'):(ac.name+' statement');
    const amount=tx?php(o.amt):bill?'−'+php(o.amt):xfer?php(o.amt):due?php(dueAmt(ac)):'';
    const amtTone=tx?(o.amt>0?'g':'r'):(bill||due)?'r':'';
    /* transactions show the account's mini card art beside the account line,
       matching the card tiles elsewhere in Cap (image-3 style) */
    const icon=tx?(cardLogo(ac)||ti(o)):bill?bIc(o):accountMove?'⇄':cardLogo(ac)||'💳';
    const freq=o&&o.freq||'monthly';
    const rep=bill?(freq==='once'?'One-time':`Repeats ${({weekly:'weekly',biweekly:'every 2 weeks',monthly:'monthly',quarterly:'quarterly',yearly:'yearly'})[freq]||'monthly'}`):(due||stmt?'Repeats monthly':'One-time');
    const status=tx?(S.pend.includes(o)?'Pending':o.d>today?'Planned':'Posted'):bill?(bPaid(o,k)?'Paid':'Scheduled'):xfer?'Recorded':due?'Upcoming':'Upcoming';
    /* the accent follows Cap's calendar language: the category colour for a
       transaction, yellow for bills/card dates, neutral for transfers */
    const col=tx?spendCol(o.cat):(bill||due||stmt?'var(--yl)':'var(--mut)');
    /* image-1 content order: the account/category line sits under the date */
    const meta=tx?[icon,ac.name+' · '+o.cat]
      :bill?[icon,(ac.name||'No account')+' · Bill']
      :xfer?[icon,accountMove?acct(o.from).name+' → '+ac.name:ac.name+' · Transfer']
      :due?[icon,'Credit card · Payment due']
      :[icon,'Credit card · Statement'];
    const tiles=[];
    if(tx){
      tiles.push({i:'🗓',l:'Calendar',v:o.cat,dot:col});
    }else if(bill){
      tiles.push({i:'🗓',l:'Calendar',v:'Bills',dot:'var(--yl)'});
      tiles.push({i:'🏷️',l:'Status',v:status,dot:tone(status)});
    }else if(xfer){
      tiles.push({i:'🗓',l:'Calendar',v:'Transfer',dot:'var(--mut)'});
      if(accountMove){tiles.push({i:'↗',l:'From',v:acct(o.from).name||'Account'});tiles.push({i:'↘',l:'To',v:ac.name||'Account'})}
      else tiles.push({i:'🏦',l:'Paid from',v:acct(o.from).name||'Outside this app'});
      tiles.push({i:'🏷️',l:'Status',v:'Recorded',dot:'var(--g)'});
    }else{
      tiles.push({i:'🗓',l:'Calendar',v:due?'Credit card due':'Credit card statement',dot:'var(--yl)'});
      tiles.push({i:'🏷️',l:'Status',v:'Upcoming',dot:'var(--yl)'});
    }
    return {k,j,e,o,tx,bill,due,stmt,xfer,ac,title,amount,amtTone,icon,rep,status,tiles,col,meta};
  }
  function tileHTML(t){
    return `<div class="cep-tile"><span class="cep-tile-ico${t.logo?' logo':''}">${t.i||''}</span><span class="cep-tile-label">${esc0(t.l)}</span><span class="cep-tile-value">${t.dot?`<i class="cep-dot" style="background:${t.dot}"></i>`:''}<span>${esc0(t.v)}</span></span></div>`;
  }
  const payDate=k=>typeof noteD==='function'?noteD(k):new Date(k+'T00:00:00').toLocaleDateString('en-PH',{month:'short',day:'numeric'});
  /* A logged bill payment and a card-payment transfer share the same payment
     details language. Unpaid bills/card dates keep the normal event view. */
  function paymentFor(d){
    if(!d)return null;
    if(d.tx){
      if(S.pend&&S.pend.includes(d.o))return null;
      const bill=typeof billForTx==='function'?billForTx(d.o):null;
      if(!bill)return null;
      const due=(typeof billDueShown==='function'?billDueShown(bill,d.o):'')||d.o.billDue||'';
      return {kind:'bill',bill,tx:d.o,title:bill.name,sub:'Bill Payment',icon:bIc(bill,'🧾'),
        amt:Math.abs(d.o.amt),due,paid:d.o.d,from:d.o.acct,fromName:d.o.acctName,note:d.o.desc||''};
    }
    if(d.xfer){
      const x=d.o;
      if(x.kind==='goal-transfer'||x.kind==='account-transfer')return null;
      const card=acct(x.to),from=acct(x.from);
      return {kind:'card',x,card,title:card&&card.id?card.name:'Card',sub:'Card Payment',
        icon:(card&&cardLogo(card))||'💳',amt:x.amt,due:x.due||'',paid:x.d,
        from:x.from,fromName:from&&from.id?from.name:'',note:x.note||'',cid:card&&card.id?card.id:x.to};
    }
    return null;
  }
  function timingHTML(n){
    if(n==null)return '';
    if(n===0)return '<span class="cep-pay-time on">✓ On time</span>';
    return `<span class="cep-pay-time ${n>0?'early':'late'}">${n>0?'↑':'↓'} ${Math.abs(n)} day${Math.abs(n)===1?'':'s'} ${n>0?'early':'late'}</span>`;
  }
  function paymentHTML(p){
    const n=payDiff(p.due,p.paid),
      rows=[['Paid on',payDate(p.paid)]];
    if(p.due)rows.push([p.kind==='card'?'Statement due':'Due date',payDate(p.due)]);
    rows.push([p.kind==='card'?'Paid from':'Paid with',p.from?paySrcHtml(p.from,p.fromName):esc0(p.fromName||'Outside this app')]);
    if(p.note)rows.push(['Note',esc0(p.note)]);
    const paymentId=p.kind==='card'?p.card.id:p.bill.id;
    const history=`<button class="ph-row" onclick="calendarPopupPaymentHistory()"><span>Payment history</span><span class="ph-n">${paymentHistoryCount(p.kind,paymentId)} ›</span></button>`;
    return `<div class="cep-pay">`+
      `<div class="cep-pay-head"><button class="cep-icon" aria-label="Close" onclick="closeCalendarEventPopup()">‹</button><h2>Payment details</h2></div>`+
      `<div class="cep-pay-hero"><div class="cep-pay-id"><span class="cep-pay-logo">${p.icon}</span><div><b>${esc0(p.title)}</b><small>${esc0(p.sub)}</small></div></div>`+
      `<div class="cep-pay-amtline"><span class="cep-pay-amt">${php(p.amt)}</span><span class="cep-pay-paid paid-chip"><svg class="paid-checkmark" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5"/></svg>Paid</span></div>`+
      (n==null?'':`<div class="cep-pay-times">${timingHTML(n)}</div>`)+`</div>`+
      `<div class="cep-pay-details">${rows.map(([l,v])=>`<div class="cep-pay-row"><span>${l}</span><b>${v}</b></div>`).join('')}</div>`+
      history+
      `<div class="cep-pay-actions"><button class="cep-pay-act unpaid" onclick="calendarPopupMarkUnpaid()">Mark as unpaid</button></div>`+
      `</div>`;
  }
  function detailHTML(d){
    const pay=paymentFor(d);if(pay)return paymentHTML(pay);
    const edit=d.tx?`calendarPopupEditTx(${d.o.id})`:d.bill?`calendarPopupEditBill(${d.o.id})`:d.xfer?`calendarPopupEditPayment(${d.o.id})`:`calendarPopupEditCardDate('${d.e.kind}',${d.o.id})`;
    return `<div class="cep-top"><button class="cep-icon" aria-label="Close" onclick="closeCalendarEventPopup()">✕</button><button class="cep-edit" onclick="${edit}">Edit</button></div>`+
      `<div class="cep-main" style="--cep-col:${d.col}"><span class="cep-accent"></span><div class="cep-copy">`+
      `<h2 class="cep-title"><span class="cep-title-run">${esc0(d.title)}</span></h2>`+
      `<p class="cep-date">${dateLong(d.k)}</p>`+
      `<p class="cep-meta-line"><span class="cep-meta-ico">${d.meta[0]||''}</span><span>${esc0(d.meta[1])}</span></p>`+
      `${d.amount?`<b class="cep-amount ${d.amtTone}">${d.amount}</b>`:''}`+
      (d.rep&&d.rep!=='One-time'?`<p class="cep-repeat">${REPEAT}<span>${esc0(d.rep)}</span></p>`:'')+
      (d.tx&&d.o.desc?`<p class="cep-note">${esc0(d.o.desc)}</p>`:'')+
      `</div></div>`+
      `<div class="cep-options"><p class="cep-options-h">Options</p>${d.tiles.map(tileHTML).join('')}</div>`+
      `<button class="cep-delete" onclick="calendarPopupDelete()">Delete Event</button>`;
  }
  /* Anchor the panel beside the selected event and keep the little arrow on
     the panel edge that faces it. Falls back below/above when space runs out. */
  function position(panel,anchor){
    const r=anchorBox(anchor),
      w=panel.offsetWidth||372,h=panel.offsetHeight||430,vw=innerWidth,vh=innerHeight,pad=14,gap=18;
    let left,top,side;
    if(r&&r.width){
      const fitsRight=r.right+gap+w<=vw-pad,fitsLeft=r.left-gap-w>=pad;
      if(fitsRight||fitsLeft){
        side=fitsRight?'right':'left';
        left=fitsRight?r.right+gap:r.left-gap-w;
        top=r.top+r.height/2-h*.34;
      }else{
        const below=r.bottom+gap,above=r.top-gap-h;
        side=below+h<=vh-pad?'below':'above';
        top=side==='below'?below:above;
        left=r.left+r.width/2-w/2;
      }
    }else{
      side='below';left=vw/2-w/2;top=vh*.18;
    }
    left=clamp(left,pad,vw-w-pad);top=clamp(top,pad,vh-h-pad);
    panel.style.left=left+'px';panel.style.top=top+'px';panel.dataset.side=side;
    const ax=r&&r.width?r.left+r.width/2:left+w/2,ay=r&&r.width?r.top+r.height/2:top;
    const axr=clamp(ax-left,38,w-38),ayr=clamp(ay-top,38,h-38);
    panel.style.setProperty('--cep-arrow',(side==='right'||side==='left'?ayr:axr)+'px');
    panel.style.setProperty('--cep-arrow-x',axr+'px');
    panel.style.setProperty('--cep-origin',side==='right'?`0px ${ayr}px`:side==='left'?`100% ${ayr}px`:side==='below'?`${axr}px 0px`:`${axr}px 100%`);
  }
  /* The colour the chip is actually sitting on: the first opaque surface up the
     tree. The floating copy paints it behind itself, because the chip's own
     fill — and its accent bar — are translucent. */
  function surfaceBehind(node){
    for(let n=node&&node.parentElement;n;n=n.parentElement){
      const c=getComputedStyle(n).backgroundColor;
      const v=(c.match(/[\d.]+/g)||[]).map(Number);
      if(v.length<4||v[3]>=0.95)return c;
    }
    return getComputedStyle(document.body).backgroundColor||'#fff';
  }
  /* Clone the tapped chip so it can float above the blurred calendar. The clone
     sits inside a wrapper that carries the calendar's surface colour, so the
     chip's translucent fill composites over that surface exactly as it does in
     place — never over the dim, which would shift its colour. */
  function makeFloat(anchor){
    if(!anchor||anchor.nodeType!==1)return null;
    const el=anchor.cloneNode(true),cs=getComputedStyle(anchor);
    el.classList.remove('cep-live','cal-hidden','sel');
    el.setAttribute('aria-hidden','true');
    el.removeAttribute('onclick');el.removeAttribute('id');
    ['display','alignItems','justifyContent','gap','paddingTop','paddingRight','paddingBottom','paddingLeft','borderRadius','backgroundColor','backgroundImage','color','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','whiteSpace','overflow','textOverflow','boxSizing','textAlign'].forEach(p=>{el.style[p]=cs[p]});
    /* wrap the label so a clipped one can run inside the floating pill */
    const clip=document.createElement('span'),run=document.createElement('span');
    clip.className='cep-float-clip';run.className='cep-float-run';
    while(el.firstChild)run.appendChild(el.firstChild);
    clip.appendChild(run);el.appendChild(clip);
    /* the plate: same box and corners as the chip, so only the chip's own
       translucent pixels pick it up */
    const wrap=document.createElement('span');
    wrap.className='cep-float';
    wrap.setAttribute('aria-hidden','true');
    wrap.style.background=surfaceBehind(anchor);
    wrap.style.borderRadius=cs.borderRadius;
    wrap.appendChild(el);
    return wrap;
  }
  function applyFloatMarquee(el){
    const clip=el&&el.querySelector('.cep-float-clip'),run=el&&el.querySelector('.cep-float-run');
    if(!clip||!run)return;
    run.classList.remove('fmq');clip.classList.remove('fmq');run.style.removeProperty('--mq-dur');run.style.removeProperty('--mq');
    const over=run.offsetWidth-clip.clientWidth;
    if(over>2&&!rm()){
      run.style.setProperty('--mq',(-over-4)+'px');
      run.style.setProperty('--mq-dur',Math.min(12,Math.max(5,over/22))+'s');
      run.classList.add('fmq');clip.classList.add('fmq');
    }
  }
  function placeFloat(el,anchor){
    if(!el||!anchor)return;
    const r=anchor.getBoundingClientRect();
    el.style.left=r.left+'px';el.style.top=r.top+'px';
    el.style.width=r.width+'px';el.style.height=r.height+'px';
  }
  /* Only titles that overflow the card get the running-sign treatment. */
  function applyMarquee(root){
    const t=root.querySelector('.cep-title'),run=t&&t.querySelector('.cep-title-run');
    if(!t||!run)return;
    t.classList.remove('mq');t.style.removeProperty('--mq-dur');run.style.removeProperty('--mq');
    const over=run.offsetWidth-t.clientWidth;
    if(over>3&&!rm()){
      run.style.setProperty('--mq',(-over-4)+'px');
      t.style.setProperty('--mq-dur',Math.min(14,Math.max(6,over/20))+'s');
      t.classList.add('mq');
    }
  }
  function cleanup(root){
    if(!root)return;
    clearTimeout(root._openTimer);
    if(root._reflow){removeEventListener('resize',root._reflow);document.removeEventListener('scroll',root._reflow,true);removeEventListener('scroll',root._reflow)}
    if(root._lock){document.body.style.overflow=root._lock.body;document.documentElement.style.overflow=root._lock.html;document.body.style.paddingRight=root._lock.padding}
    document.removeEventListener('keydown',root._key,true);
  }
  function mount(html,anchor){
    clearTimeout(closeTimer);
    const old=document.getElementById('calendar-event-popup');
    if(old){cleanup(old);old.remove();}
    const root=document.createElement('div');root.id='calendar-event-popup';root.className='cep-backdrop';
    root.innerHTML=`<div class="cep-dim" aria-hidden="true"></div><div class="cep-frost" aria-hidden="true"></div><section class="cep-panel" role="dialog" aria-modal="true" aria-label="Calendar event details"><div class="cep-view">${html}</div></section>`;
    root.addEventListener('pointerdown',e=>{if(e.target===root)closeCalendarEventPopup()});
    document.body.appendChild(root);const panel=root.querySelector('.cep-panel');
    const floater=makeFloat(anchor);
    if(floater){root.insertBefore(floater,panel);placeFloat(floater,anchor);applyFloatMarquee(floater);}
    position(panel,anchor);applyMarquee(root);
    const reflow=()=>{position(panel,anchor);if(floater){placeFloat(floater,anchor);applyFloatMarquee(floater)}applyMarquee(root)};
    addEventListener('resize',reflow);
    document.addEventListener('scroll',reflow,true);
    addEventListener('scroll',reflow,{passive:true});
    root._reflow=reflow;
    /* keep the page still while the card is open so the clear cut-out and the
       arrow stay locked to the tapped chip */
    root._lock={body:document.body.style.overflow,html:document.documentElement.style.overflow,padding:document.body.style.paddingRight};
    const bar=innerWidth-document.documentElement.clientWidth;
    document.documentElement.style.overflow='hidden';
    document.body.style.overflow='hidden';
    if(bar>0)document.body.style.paddingRight=bar+'px';
    const key=e=>{if(e.key==='Escape')closeCalendarEventPopup()};root._key=key;document.addEventListener('keydown',key,true);
    /* Flush the closed styles, then open in the same task. This animates
       reliably even when rAF/timers are throttled in a background tab. */
    void panel.offsetWidth;
    root.classList.add('open');
    root.querySelector('.cep-icon')?.focus({preventScroll:true});
  }
  window.calendarEventPopup=function(event,k,j){
    event?.preventDefault();event?.stopPropagation();const d=resolve(k,j);if(!d)return;
    CP={k,j,anchor:event?.currentTarget||event?.target};mount(detailHTML(d),CP.anchor);
  };
  window.closeCalendarEventPopup=function(immediate){
    const root=document.getElementById('calendar-event-popup');if(!root)return;cleanup(root);CP=null;
    if(immediate||rm()){root.remove();return}root.classList.add('closing');closeTimer=setTimeout(()=>root.remove(),220);
  };
  function swap(html){
    const root=document.getElementById('calendar-event-popup'),view=root&&root.querySelector('.cep-view');if(!view)return;
    const put=()=>{view.innerHTML=html;applyMarquee(root)};
    if(rm()){put();return}view.classList.add('out');setTimeout(()=>{put();view.classList.remove('out');view.classList.add('in');setTimeout(()=>view.classList.remove('in'),260)},145);
  }
  window.calendarPopupBack=function(){const d=CP&&resolve(CP.k,CP.j);if(d)swap(detailHTML(d));else closeCalendarEventPopup();};
  window.calendarPopupEditTx=function(id){
    /* Reuse Cap's complete transaction form (including credit-card fields), but
       host it inside the popover rather than navigating away to the sheet. */
    openTx(id);const source=document.getElementById('sv')||document.getElementById('sb');let html=source?source.innerHTML:'';closeS();
    html=html.replace(new RegExp(`onclick="saveTx\\(${id}[^)]*\\)"`),`onclick="calendarPopupSaveTx(${id})"`).replace(/onclick="closeS\(\)"/g,'onclick="calendarPopupBack()"');
    swap(`<div class="cep-form-head"><button class="cep-icon" aria-label="Back" onclick="calendarPopupBack()">‹</button><h2>Edit transaction</h2></div><div class="cep-form">${html}</div>`);
    setTimeout(()=>{try{txAcc()}catch(_){}});
  };
  window.calendarPopupSaveTx=function(id){closeCalendarEventPopup(true);saveTx(id);};
  window.calendarPopupEditBill=function(id){
    const b=S.bills.find(x=>x.id===id);if(!b)return;const d=b.start||bIso(nextDue(b));
    swap(`<div class="cep-form-head"><button class="cep-icon" aria-label="Back" onclick="calendarPopupBack()">‹</button><h2>Edit event</h2></div><div class="cep-form"><label>Name</label><input id="cep-b-name" value="${esc0(b.name)}"><label>Amount (${CS()})</label><input id="cep-b-amount" type="number" min="0" step=".01" inputmode="decimal" value="${b.amt}"><label>Due date</label><input id="cep-b-date" type="date" value="${d}"><label>Repeats</label><select id="cep-b-freq">${Object.keys(BF).map(f=>`<option value="${f}" ${f===(b.freq||'monthly')?'selected':''}>${esc0(BF[f])}</option>`).join('')}</select><label>Pay from</label><select id="cep-b-acct"><option value="0">Choose later</option>${S.accts.map(a=>`<option value="${a.id}" ${a.id==b.acct?'selected':''}>${esc0(a.name)}</option>`).join('')}</select><button class="btn" onclick="calendarPopupSaveBill(${id})">Save changes</button></div>`);
  };
  window.calendarPopupSaveBill=function(id){const b=S.bills.find(x=>x.id===id),name=$cp('#cep-b-name')?.value.trim(),amount=+($cp('#cep-b-amount')?.value),date=$cp('#cep-b-date')?.value,freq=$cp('#cep-b-freq')?.value;if(!b||!name||!(amount>=0)||!date)return toast('Complete the event details');b.name=name;b.amt=amount;b.acct=+$cp('#cep-b-acct')?.value||0;b.start=date;b.due=+date.slice(8,10);b.freq=freq;save();closeCalendarEventPopup(true);render();};
  window.calendarPopupEditCardDate=function(kind,id){const a=acct(id),day=kind==='due'?a.due:a.stmt,label=kind==='due'?'Due date':'Statement date';swap(`<div class="cep-form-head"><button class="cep-icon" aria-label="Back" onclick="calendarPopupBack()">‹</button><h2>Edit ${label.toLowerCase()}</h2></div><div class="cep-form"><label>${label}</label><select id="cep-card-day">${Array.from({length:31},(_,i)=>`<option value="${i+1}" ${i+1===day?'selected':''}>${i+1}</option>`).join('')}</select><button class="btn" onclick="calendarPopupSaveCardDate('${kind}',${id})">Save changes</button></div>`);};
  window.calendarPopupSaveCardDate=function(kind,id){const a=acct(id),day=+$cp('#cep-card-day')?.value;if(!a||!day)return;if(kind==='due'){a.due=day;a.dueN=day}else a.stmt=day;save();closeCalendarEventPopup(true);render();};
  window.calendarPopupEditPayment=function(id){const x=S.xfer.find(x=>x.id===id);if(!x)return;swap(`<div class="cep-form-head"><button class="cep-icon" aria-label="Back" onclick="calendarPopupBack()">‹</button><h2>Edit payment</h2></div><div class="cep-form"><label>Payment date</label><input id="cep-x-date" type="date" value="${x.d}"><label>Note</label><input id="cep-x-note" value="${esc0(x.note||'')}"><button class="btn" onclick="calendarPopupSavePayment(${id})">Save changes</button></div>`);};
  window.calendarPopupSavePayment=function(id){const x=S.xfer.find(x=>x.id===id),d=$cp('#cep-x-date')?.value;if(!x||!d)return;x.d=d;x.note=$cp('#cep-x-note')?.value.trim()||'';save();closeCalendarEventPopup(true);render();};
  window.calendarPopupMarkUnpaid=function(){
    const d=CP&&resolve(CP.k,CP.j),p=paymentFor(d);if(!p)return;
    if(p.kind==='card'){
      const x=p.x,card=p.card,src=acct(x.from);
      confirmBox('Mark this payment as unpaid?',(card&&card.name?card.name:'Card')+' · '+php(x.amt)+' · '+payDate(x.d),()=>{
        closeCalendarEventPopup(true);
        if(card&&card.id)card.bal+=x.amt;
        if(src&&src.id)src.bal+=x.amt;
        S.xfer=S.xfer.filter(z=>z.id!==x.id);
        save();render();toast('Marked as unpaid');
      },'Mark as unpaid');
    }else{
      const b=p.bill,t=p.tx;
      confirmBox('Mark this payment as unpaid?',b.name+' · '+php(Math.abs(t.amt))+' · '+payDate(t.d),()=>{
        closeCalendarEventPopup(true);
        if(typeof undoBillPayment==='function')undoBillPayment(b,t,t.billDue);
        save();render();toast('Bill marked unpaid');
      },'Mark as unpaid');
    }
  };
  window.calendarPopupPaymentHistory=function(){
    const d=CP&&resolve(CP.k,CP.j),p=paymentFor(d);if(!p)return;
    const kind=p.kind,id=p.kind==='card'?p.card.id:p.bill.id;
    const back=kind==='card'?`cardPayDetail(${p.x.id},${id})`:`payDetail(${p.tx.id})`;
    if(typeof openPaymentHistory==='function')openPaymentHistory(kind,id,back);
    else closeCalendarEventPopup(true);
  };
  window.calendarPopupDelete=function(){
    const d=CP&&resolve(CP.k,CP.j);if(!d)return;
    const title=d.title+' · '+dateLong(d.k);
    confirmBox('Delete Event',title,()=>{
      if(d.tx){closeCalendarEventPopup(true);delTx(d.o.id);return}
      if(d.bill)S.bills=S.bills.filter(b=>b.id!==d.o.id);
      else if(d.xfer){
        /* Card payments are linked transfers: remove the event and restore both
           account balances exactly like the existing Mark as unpaid action. */
        if(d.o.kind==='account-transfer'){
          const source=acct(d.o.from),dest=acct(d.o.to);
          if(source&&source.id)source.bal+=d.o.amt;
          if(dest&&dest.id)dest.bal-=d.o.amt;
        }else if(d.o.kind==='card-payment'||!d.o.kind){
          const card=acct(d.o.to),source=acct(d.o.from);
          if(card&&card.id)card.bal+=d.o.amt;
          if(source&&source.id)source.bal+=d.o.amt;
        }
        S.xfer=S.xfer.filter(x=>x.id!==d.o.id);
      }
      else if(d.due){d.o.due=0;d.o.dueN=0}else if(d.stmt)d.o.stmt=0;
      save();closeCalendarEventPopup(true);render();
    },'Delete Event');
  };
})();
