/* Command Bar shell: no financial writes or parsing here. Mode submission is
   dispatched to separate adapters; manual entry continues to delegate to openTx(). */
(function(){
  'use strict';
  const modes=Object.freeze({log:{label:'Log',placeholder:'Log or search anything…'},search:{label:'Search',placeholder:'Search your finances…'}});
  const root=document.createElement('section');
  root.id='cap-command-bar';root.hidden=true;root.setAttribute('aria-label','Log or Search Command Bar');
  root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');
  root.innerHTML='<div class="cb-surface"></div><div class="cb-content"><button type="button" class="cb-manual" aria-label="Open Manual New Entry">＋</button><input id="cap-command-input" type="text" aria-label="Command text" placeholder="Log or search anything…" autocomplete="off" enterkeyhint="done" aria-describedby="cap-command-status"><button type="button" class="cb-mode" aria-label="Command mode: Log" aria-haspopup="menu" aria-expanded="false" aria-controls="cap-command-menu"><span class="cb-mode-label">Log</span><svg class="cb-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></button></div><span class="cb-morph-plus" aria-hidden="true" hidden>＋</span><div class="cb-menu" id="cap-command-menu" role="menu" aria-label="Command mode" hidden><button type="button" role="menuitemradio" aria-checked="true" data-mode="log" tabindex="-1">Log</button><button type="button" role="menuitemradio" aria-checked="false" data-mode="search" tabindex="-1">Search</button></div><p class="cb-status" id="cap-command-status" role="status" hidden></p>';
  const backdrop=document.createElement('div');backdrop.id='cap-command-backdrop';backdrop.hidden=true;backdrop.setAttribute('aria-hidden','true');
  document.body.append(backdrop,root);
  const surface=root.querySelector('.cb-surface'),content=root.querySelector('.cb-content'),input=root.querySelector('input'),manual=root.querySelector('.cb-manual'),selector=root.querySelector('.cb-mode'),menu=root.querySelector('.cb-menu'),ghost=root.querySelector('.cb-morph-plus'),status=root.querySelector('.cb-status');
  const modeIcons={log:'<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 8h6M9 12h6M9 16h4"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>'};
  const modeIcon=document.createElement('span');modeIcon.className='cb-option-icon cb-current-icon';modeIcon.setAttribute('aria-hidden','true');modeIcon.innerHTML='<svg viewBox="0 0 24 24">'+modeIcons.log+'</svg>';selector.prepend(modeIcon);
  menu.querySelectorAll('[data-mode]').forEach(button=>{
    const icon=document.createElement('span');icon.className='cb-option-icon';icon.setAttribute('aria-hidden','true');
    icon.innerHTML='<svg viewBox="0 0 24 24">'+modeIcons[button.dataset.mode]+'</svg>';
    button.insertBefore(icon,button.lastChild);
  });
  const mic=document.createElement('button');mic.type='button';mic.className='cb-mic';mic.setAttribute('aria-label','Start Voice Input');mic.setAttribute('aria-pressed','false');
  mic.title='Voice-to-text only. Your browser may use its speech service. Nothing is submitted.';
  mic.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4m-4 0h8"/></svg>';
  content.appendChild(mic);
  // Available to assistive technology and revealed on keyboard focus, without
  // adding another visible control to the requested compact input layout.
  const closeButton=document.createElement('button');closeButton.type='button';closeButton.className='cb-close';closeButton.setAttribute('aria-label','Close Command Bar');closeButton.textContent='×';root.appendChild(closeButton);
  let state='closed',mode='log',revision=0,animations=[],statusTimer=0,frame=0,recognition=null,voiceRevision=0;
  let focused=false,keyboard=false,baseline=innerHeight,layoutWidth=innerWidth,restBottom=null,placement=null,dismissal=null;
  const inertBefore=new Map();
  const trigger=()=>document.querySelector('#tabs .nav-action');
  const reduced=()=>matchMedia('(prefers-reduced-motion:reduce)').matches||document.documentElement.classList.contains('rm')||document.documentElement.classList.contains('noanim');
  const active=()=>state==='open'||state==='opening';
  const ownedPicker=()=>document.querySelector('.ps-pop[data-command-owner="cap-command-bar"]:not(.out)');
  const contains=target=>root.contains(target)||target.closest?.('[data-command-owner="cap-command-bar"]');
  function syncTrigger(){const t=trigger();if(t)t.setAttribute('aria-expanded',String(active()));}
  function setState(next){
    state=next;root.inert=!active();const blocking=active()||next==='closing';
    if(root.hidden&&frame){cancelAnimationFrame(frame);frame=0;}
    document.body.classList.toggle('command-bar-active',blocking);backdrop.hidden=!blocking;
    if(blocking){
      document.querySelectorAll('nav,#app,#settings-button,#pop').forEach(el=>{if(!inertBefore.has(el))inertBefore.set(el,el.inert);el.inert=true;});
    }else{inertBefore.forEach((was,el)=>{el.inert=was});inertBefore.clear();}
    syncTrigger();
  }
  function cancelAnimations(){animations.forEach(a=>a.cancel());animations=[];}
  function clearStatus(){clearTimeout(statusTimer);status.hidden=true;status.textContent='';}
  function announce(message,persistent=false){clearStatus();status.textContent=message;status.hidden=false;if(!persistent)statusTimer=setTimeout(clearStatus,5000);}
  function stopVoice(){
    ++voiceRevision;const old=recognition;recognition=null;
    mic.setAttribute('aria-pressed','false');mic.setAttribute('aria-label','Start Voice Input');
    if(old){old.onresult=old.onerror=old.onend=null;try{old.abort()}catch(_){}clearStatus();}
  }
  function startVoice(){
    if(!active())return;
    if(recognition){stopVoice();announce('Voice input stopped. Nothing was submitted.');return;}
    const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!Speech){announce('Voice input is unavailable in this browser. You can still type.');return;}
    closeMenu(false);const token=++voiceRevision,base=input.value.trimEnd();
    try{
      const speech=new Speech();recognition=speech;speech.lang=navigator.language||'en-PH';speech.interimResults=true;speech.continuous=false;
      mic.setAttribute('aria-pressed','true');mic.setAttribute('aria-label','Stop Voice Input');
      announce('Listening… Uses your browser’s speech service. Text only; nothing is submitted.',true);
      speech.onresult=e=>{
        if(token!==voiceRevision||!active())return;
        const parts=[];for(let i=0;i<e.results.length;i++)parts.push(e.results[i][0].transcript);
        const text=parts.join(' ').trim();
        input.value=(base?base+' ':'')+text;
        root.dispatchEvent(new CustomEvent('cap:command-change'));
      };
      speech.onerror=e=>{
        if(token!==voiceRevision)return;
        stopVoice();announce(e.error==='not-allowed'||e.error==='service-not-allowed'?'Microphone permission denied. You can still type.':e.error==='audio-capture'?'No microphone is available. You can still type.':e.error==='no-speech'?'No speech detected. Try again or type.':'Voice input could not continue. You can still type.');
      };
      speech.onend=()=>{if(token!==voiceRevision)return;stopVoice();announce('Voice input stopped. Review your text; nothing was submitted.');};
      speech.start();
    }catch(_){stopVoice();announce('Voice input is unavailable. You can still type.');}
  }
  function focus(el){try{el.focus({preventScroll:true})}catch(_){el.focus()}}
  const editable=el=>!!el?.matches?.('input:not([type="hidden"]),textarea,select,[contenteditable="true"]');
  function cancelDismissal(){
    if(!dismissal)return;
    const old=dismissal;dismissal=null;clearTimeout(old.quiet);clearTimeout(old.fallback);old.resolve(false);
  }
  function finishDismissal(){
    if(!dismissal)return;
    const old=dismissal;dismissal=null;clearTimeout(old.quiet);clearTimeout(old.fallback);schedulePosition();old.resolve(active()&&!focused);
  }
  function settled(){
    if(!dismissal)return;
    clearTimeout(dismissal.quiet);
    // Start the quiet window only once actual keyboard occlusion has gone.
    if(!keyboard)dismissal.quiet=setTimeout(finishDismissal,100);
  }
  function dismissKeyboard(){
    cancelDismissal();
    position();
    const hadKeyboard=keyboard||baseline-(window.visualViewport?.height??innerHeight)>12;
    if(root.contains(document.activeElement)&&editable(document.activeElement))document.activeElement.blur();
    focused=false;root.classList.remove('cb-focused');schedulePosition();
    if(!hadKeyboard)return Promise.resolve(active());
    return new Promise(resolve=>{
      // One compatibility sample, not a polling loop or permission to show over a keyboard.
      dismissal={resolve,quiet:0,fallback:setTimeout(()=>{position();if(!keyboard)finishDismissal();},450)};
    });
  }
  function position(){
    if(frame)cancelAnimationFrame(frame);
    frame=0;
    if(root.hidden)return;
    const vv=window.visualViewport,left=vv?vv.offsetLeft:0,top=vv?vv.offsetTop:0,width=vv?vv.width:innerWidth,height=vv?vv.height:innerHeight;
    const layoutHeight=Math.max(document.documentElement.clientHeight,innerHeight);
    if(Math.abs(innerWidth-layoutWidth)>80){layoutWidth=innerWidth;baseline=layoutHeight;restBottom=null;}
    if(!focused&&!keyboard)baseline=Math.max(baseline,layoutHeight,height);
    const shrink=Math.max(layoutHeight-height,baseline-height);
    // Focus is a style state, not proof of a software keyboard (iPad hardware keyboards).
    keyboard=(focused||keyboard||!!dismissal)&&shrink>80&&(!vv||!vv.scale||Math.abs(vv.scale-1)<.05);
    const safe=parseFloat(getComputedStyle(root).getPropertyValue('--cb-safe-bottom'))||0;
    const nav=!keyboard?document.querySelector('#tabs')?.getBoundingClientRect():null;
    if(!keyboard)restBottom=nav?nav.top-12:top+height-76-safe;
    const bottom=keyboard?top+height-12:Math.min(restBottom??top+height-76-safe,top+height-12-safe);
    const w=Math.min(focused?652:640,Math.max(0,width-(focused?24:32)));
    const x=Math.round(left+(width-w)/2),y=Math.round(Math.max(top+8,bottom-64));
    root.classList.toggle('cb-keyboard',keyboard||!!dismissal);
    root.style.width=w+'px';root.style.transform=`translate3d(${x}px,${y}px,0)`;
    const roomAbove=y-top;
    menu.style.bottom=roomAbove<116?'auto':'calc(100% + 8px)';menu.style.top=roomAbove<116?'calc(100% + 8px)':'auto';
    placement={top:y,visibleTop:top,visibleBottom:top+height,keyboard,focused};
    root.dispatchEvent(new CustomEvent('cap:command-position',{detail:placement}));
    settled();
  }
  function schedulePosition(){if(!root.hidden&&!frame)frame=requestAnimationFrame(position);}
  function closeMenu(restore){menu.hidden=true;selector.setAttribute('aria-expanded','false');if(restore)focus(selector);}
  function openMenu(){
    if(!active())return;
    stopVoice();clearStatus();menu.hidden=false;selector.setAttribute('aria-expanded','true');position();
    focus(menu.querySelector('[data-mode="'+mode+'"]'));
  }
  function setMode(next){
    if(!modes[next])return;
    stopVoice();mode=next;input.placeholder=modes[mode].placeholder;
    selector.setAttribute('aria-label','Command mode: '+modes[mode].label);
    const label=selector.querySelector('.cb-mode-label');label.textContent=modes[mode].label;
    modeIcon.innerHTML='<svg viewBox="0 0 24 24">'+modeIcons[mode]+'</svg>';
    if(!reduced()){
      label.classList.remove('cb-mode-label');void label.offsetWidth;label.classList.add('cb-mode-label');
      modeIcon.animate?.([{opacity:0},{opacity:1}],{duration:160,easing:'ease-out'});
    }
    menu.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.mode===mode)));
    root.dispatchEvent(new CustomEvent('cap:command-change'));
    closeMenu(false);clearStatus();focus(input);
  }
  function geometry(){
    const t=trigger()?.getBoundingClientRect(),r=root.getBoundingClientRect(),m=manual.getBoundingClientRect();
    const x=t?t.left+t.width/2:r.left+r.width/2,y=t?t.top+t.height/2:r.top+r.height/2;
    return {shell:{transform:`translate(${x-r.left-r.width/2}px,${y-r.top-r.height/2}px)`,clipPath:`inset(${Math.max(0,(64-(t?.height||44))/2)}px ${Math.max(0,(r.width-(t?.width||44))/2)}px round 32px)`},glyph:{transform:`translate(${x-m.left-m.width/2}px,${y-m.top-m.height/2}px)`}};
  }
  async function morph(opening,token,fresh=false){
    const g=geometry(),small=reduced(),duration=small?100:opening?420:260;
    const start={transform:getComputedStyle(surface).transform,clipPath:getComputedStyle(surface).clipPath},glyphStart={transform:getComputedStyle(ghost).transform},opacity=getComputedStyle(content).opacity,backdropOpacity=opening&&fresh?0:getComputedStyle(backdrop).opacity;
    cancelAnimations();ghost.hidden=small;manual.style.opacity=small?'':'0';
    const end={transform:'translate(0px,0px)',clipPath:'inset(0px 0px round 32px)'};
    if(typeof surface.animate!=='function'){return;}
    animations=[surface.animate(small?[{opacity:opening?0:1},{opacity:opening?1:0}]:[opening&&fresh?g.shell:start,opening?end:g.shell],{duration,easing:'cubic-bezier(.22,.8,.25,1)',fill:'both'}),
      content.animate([{opacity:opening&&fresh?0:opacity},{opacity:opening?1:0}],{duration:small?100:opening?190:110,delay:opening&&!small?180:0,fill:'both'}),
      backdrop.animate([{opacity:backdropOpacity},{opacity:opening?1:0}],{duration,easing:'ease-in-out',fill:'both'})];
    if(!small)animations.push(ghost.animate([opening&&fresh?g.glyph:glyphStart,opening?{transform:'translate(0px,0px)'}:g.glyph],{duration,easing:'cubic-bezier(.22,.8,.25,1)',fill:'both'}));
    await Promise.all(animations.map(a=>a.finished.catch(()=>{})));
    if(token!==revision)return;
  }
  async function open(){
    if(active())return;
    if(document.getElementById('sheet')?.classList.contains('open')||document.getElementById('lock')?.classList.contains('open'))return;
    const token=++revision,fresh=root.hidden;if(fresh)root.classList.remove('cb-positioned');root.hidden=false;setState('opening');closeMenu(false);clearStatus();position();
    await morph(true,token,fresh);if(token!==revision)return;
    cancelAnimations();ghost.hidden=true;manual.style.opacity='';root.classList.add('cb-positioned');setState('open');
    focus(root.querySelector('.sl-preview:not([hidden]) h3')||input);position();
  }
  async function close(options={}){
    if(state==='closed')return;
    const token=++revision;
    cancelDismissal();
    root.dispatchEvent(new CustomEvent('cap:command-close'));
    stopVoice();closeMenu(false);clearStatus();input.blur();
    if(state==='suspended'){setState('closed');root.hidden=true;return;}
    setState('closing');
    await morph(false,token);if(token!==revision)return;
    root.hidden=true;cancelAnimations();ghost.hidden=true;manual.style.opacity='';setState('closed');
    if(options.restoreFocus!==false&&trigger())focus(trigger());
  }
  function suspend(work){
    if(!active())return;
    ++revision;cancelDismissal();stopVoice();cancelAnimations();closeMenu(false);clearStatus();input.blur();root.hidden=true;setState('suspended');
    // The form, validation, save and transaction accounting remain entirely existing code.
    try{work()}catch(error){setState('closed');open();throw error;}
  }
  function manualEntry(){suspend(()=>window.openTx())}
  manual.addEventListener('click',manualEntry);
  closeButton.addEventListener('click',()=>close());
  mic.addEventListener('click',startVoice);
  backdrop.addEventListener('wheel',e=>e.preventDefault(),{passive:false});
  input.addEventListener('input',()=>{if(recognition)stopVoice();root.dispatchEvent(new CustomEvent('cap:command-change'))});
  selector.addEventListener('click',()=>menu.hidden?openMenu():closeMenu(true));
  selector.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();openMenu();}});
  menu.addEventListener('click',e=>{const b=e.target.closest('[data-mode]');if(b)setMode(b.dataset.mode)});
  menu.addEventListener('keydown',e=>{
    const buttons=[...menu.querySelectorAll('button')],i=buttons.indexOf(document.activeElement);
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();focus(buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]);}
    if(e.key==='Tab')closeMenu(false);
  });
  input.addEventListener('keydown',e=>{
    if(e.key!=='Enter'||e.isComposing)return;
    e.preventDefault();e.stopPropagation();stopVoice();closeMenu(false);clearStatus();
    submitCommand();
  });
  function submitCommand(){
    stopVoice();closeMenu(false);clearStatus();
    if(mode==='log'){
      announce('Review the draft before logging. Nothing was submitted.');
      root.dispatchEvent(new CustomEvent('cap:command-submit',{detail:{mode,text:input.value}}));
    }else{dismissKeyboard();announce('Financial search will be available in a future phase. Nothing was submitted.');}
  }
  document.addEventListener('keydown',e=>{
    const picker=ownedPicker();
    if(picker&&active()&&['Escape','Tab'].includes(e.key)){
      e.preventDefault();e.stopPropagation();const anchor=root.querySelector('.ps-btn[aria-expanded="true"]');
      picker.dispatchEvent(new Event('cap:overlay-dismiss'));focus(anchor||input);return;
    }
    if(e.key==='Tab'&&active()){
      if(!menu.hidden){e.preventDefault();closeMenu(false);focus(e.shiftKey?selector:mic);return;}
      const controls=[closeButton,...root.querySelectorAll('button,input,select,textarea')].filter((e,i,all)=>all.indexOf(e)===i&&!e.disabled&&!e.closest('[hidden]')&&e.getClientRects().length);
      const i=controls.indexOf(document.activeElement);
      e.preventDefault();focus(controls[(i+(e.shiftKey?-1:1)+controls.length)%controls.length]);
    }
    if(e.key!=='Escape'||!active())return;
    e.preventDefault();e.stopPropagation();if(recognition){stopVoice();announce('Voice input stopped. Nothing was submitted.');}else if(!menu.hidden)closeMenu(true);else{
      const event=new CustomEvent('cap:command-escape',{cancelable:true});if(root.dispatchEvent(event))close();
    }
  },true);
  document.addEventListener('pointerdown',e=>{
    if(!active()||contains(e.target))return;
    e.preventDefault();e.stopPropagation();close();
  },true);
  // Keyboard-activated navigation needs the same hand-off as pointer navigation.
  document.addEventListener('click',e=>{
    if((active()||state==='closing')&&!contains(e.target)){e.preventDefault();e.stopImmediatePropagation();if(active())close();}
  },true);
  document.addEventListener('focusin',e=>{if(active()&&!contains(e.target))focus(input);});
  root.addEventListener('focusin',e=>{
    if(!editable(e.target))return;
    cancelDismissal();focused=true;root.classList.add('cb-focused');schedulePosition();
    root.dispatchEvent(new CustomEvent('cap:command-edit-focus',{detail:{command:e.target===input}}));
  });
  root.addEventListener('focusout',()=>{
    // focusout precedes focusin when moving between owned editor controls.
    queueMicrotask(()=>{focused=contains(document.activeElement)&&editable(document.activeElement);root.classList.toggle('cb-focused',focused);schedulePosition();});
  });
  new MutationObserver(()=>{syncTrigger();if(active())schedulePosition()}).observe(document.getElementById('tabs'),{childList:true});
  new MutationObserver(()=>{
    const sheet=document.getElementById('sheet');
    if(state==='suspended'&&!sheet.classList.contains('open')){setState('closed');open();}
    else if(active()&&sheet.classList.contains('open'))close({restoreFocus:false});
  }).observe(document.getElementById('sheet'),{attributes:true,attributeFilter:['class']});
  new MutationObserver(()=>{if(document.getElementById('lock').classList.contains('open'))close({restoreFocus:false});}).observe(document.getElementById('lock'),{attributes:true,attributeFilter:['class']});
  addEventListener('resize',schedulePosition);
  addEventListener('orientationchange',()=>{restBottom=null;baseline=0;layoutWidth=0;schedulePosition();});
  window.visualViewport?.addEventListener('resize',schedulePosition);
  window.visualViewport?.addEventListener('scroll',schedulePosition);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopVoice()});
  window.CapCommandBar=Object.freeze({open,close,suspend,setMode,dismissKeyboard,submit:submitCommand,toggle:()=>active()?close():open(),getState:()=>({state,mode}),getPlacement:()=>placement});
})();
