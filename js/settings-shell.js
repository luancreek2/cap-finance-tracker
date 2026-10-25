/* Settings-only presentation adapter. Reuses #sheet/#sb and every existing
   page renderer/action. No settings, records or sync metadata are written here. */
(function(){
  'use strict';
  const scrolls=new Map(),history=[];
  let current='',animations=[],exit=null,returnFocus=null,closeTimer=0,mountOpening=false,auxParent='files';
  const reduce=()=>matchMedia('(prefers-reduced-motion:reduce)').matches||document.documentElement.matches('.rm,.noanim');
  const active=()=>document.querySelector('#sheet.st.open');
  function settle(){animations.forEach(a=>a.cancel());animations=[];if(exit)exit.remove();exit=null;}
  function mount(html,key,keep){
    const sh=document.getElementById('sheet'),sb=document.getElementById('sb');
    const wasOpen=!!active()&&!sh.classList.contains('closing');
    clearTimeout(closeTimer);settle();
    const old=sb.querySelector('.st-scroll'),previous=current;
    const focused=document.activeElement,focusId=focused&&focused.id,focusChange=focused&&focused.getAttribute('onchange');
    let back=false,same=wasOpen&&key===current,outgoing=null;
    if(wasOpen){
      if(old)scrolls.set(current,old.scrollTop);
      const at=history.indexOf(key);
      back=at>=0&&key!==current;
      if(back)history.splice(at+1);else if(!same)history.push(key);
      if(!same&&old&&!reduce()){
        outgoing=old.cloneNode(true);outgoing.className='st-scroll st-exit';outgoing.inert=true;outgoing.setAttribute('aria-hidden','true');
        outgoing.querySelectorAll('[id]').forEach(e=>e.removeAttribute('id'));
        // The departing frame is paint-only, not a second set of live controls.
        outgoing.querySelectorAll('*').forEach(e=>[...e.attributes].filter(a=>a.name.startsWith('on')).forEach(a=>e.removeAttribute(a.name)));
      }
    }else{
      scrolls.clear();history.splice(0,history.length,key);returnFocus=document.activeElement;
      window._svKey=key;mountOpening=true;try{openS('')}finally{mountOpening=false;}
    }
    clearTimeout(window._nt);clearTimeout(window._nr);window._navBusy=0;
    svSettle(sb);sh.classList.add('st');sh.classList.remove('closing');
    const template=document.createElement('template');template.innerHTML=html;
    const header=template.content.querySelector('.st-hd');
    if(header){header.remove();header.querySelector('h2').id='st-title';header.querySelector('h2').tabIndex=-1;}
    let sv=sb.querySelector('#sv');if(!sv){sv=document.createElement('div');sv.id='sv';sb.replaceChildren(sv);}
    // #sv is the permanent frame; only its header and content are replaced.
    const viewport=document.createElement('div');viewport.className='st-viewport';
    const content=document.createElement('div');content.className='st-scroll';content.tabIndex=0;content.setAttribute('role','region');content.setAttribute('aria-label','Settings content');
    content.append(template.content);viewport.append(content);
    sv.replaceChildren(...(header?[header,viewport]:[viewport]));
    sb.setAttribute('role','dialog');sb.setAttribute('aria-modal','true');sb.setAttribute('aria-labelledby','st-title');
    current=key;sb.dataset.settingsPage=key;
    content.scrollTop=(back||same||keep)?scrolls.get(key)||0:0;
    if(window.psEnhance)window.psEnhance();
    if(outgoing){
      viewport.append(outgoing);outgoing.scrollTop=scrolls.get(previous)||0;exit=outgoing;
      const options={duration:220,easing:'cubic-bezier(.22,.75,.28,1)'};
      animations=[outgoing.animate([{opacity:1,transform:'none'},{opacity:0,transform:`translateX(${back?20:-20}px)`}],options),content.animate([{opacity:0,transform:`translateX(${back?-24:24}px)`},{opacity:1,transform:'none'}],options)];
      const oldExit=outgoing;animations[0].finished.then(()=>{oldExit.remove();if(exit===oldExit)exit=null}).catch(()=>{});
    }
    // Refreshes retain the focused control when possible; navigation announces title.
    const title=sb.querySelector('#st-title');if(title&&!same)title.focus({preventScroll:true});
    if(same){const replacement=focusId?document.getElementById(focusId):focusChange?[...content.querySelectorAll('[onchange]')].find(e=>e.getAttribute('onchange')===focusChange):null;if(replacement)replacement.focus({preventScroll:true});}
  }
  // Existing import/restore preview renderers call openS directly. Keep those
  // UI substeps in this same frame without changing parsing/confirmation/apply.
  const originalOpen=window.openS;
  window.openS=function(html){
    if(active()&&!mountOpening){
      if(current!=='set-aux')auxParent=current.replace(/^set-/,'');
      const template=document.createElement('template');template.innerHTML=html;
      const heading=template.content.querySelector('h2'),title=heading?heading.textContent:'Settings';if(heading)heading.remove();
      mount(stHead(esc(title),auxParent==='pin'?'stPin()':`stGo('${auxParent}')`)+template.innerHTML,'set-aux',0);return;
    }
    const sb=document.getElementById('sb');
    if(sb.dataset.settingsPage){sb.removeAttribute('role');sb.removeAttribute('aria-modal');sb.removeAttribute('aria-labelledby');delete sb.dataset.settingsPage;}
    return originalOpen.apply(this,arguments);
  };
  const originalClose=window.closeS;
  window.closeS=function(){
    if(active()){
      settle();const target=returnFocus;
      closeTimer=setTimeout(()=>{if(!document.querySelector('#sheet.open')){
        const sb=document.getElementById('sb');sb.removeAttribute('role');sb.removeAttribute('aria-modal');sb.removeAttribute('aria-labelledby');
        if(target&&target.isConnected)target.focus({preventScroll:true});
      }},220);
    }
    return originalClose.apply(this,arguments);
  };
  document.addEventListener('keydown',e=>{
    if(!active()||document.querySelector('#cfm,#whats-new-overlay,.ps-pop:not(.out)'))return;
    const sb=document.getElementById('sb');
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closeS();}
    if(e.key==='Tab'){
      const controls=[...sb.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea,summary,[href],[tabindex="0"]')].filter(n=>n.getClientRects().length&&!n.closest('[inert]'));
      const first=controls[0],last=controls[controls.length-1];if(!first)return;
      if(e.shiftKey&&(document.activeElement===first||!controls.includes(document.activeElement))){e.preventDefault();last.focus({preventScroll:true});}
      else if(!e.shiftKey&&(document.activeElement===last||!sb.contains(document.activeElement))){e.preventDefault();first.focus({preventScroll:true});}
    }
  },true);
  window.StShell={mount};
})();
