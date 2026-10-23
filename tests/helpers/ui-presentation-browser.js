/* Run only on the isolated localhost:8059 UI fixture server with Supabase
   configuration removed. Not loaded by index.html or the offline shell.
   await runCapUiBrowserChecks() in Chromium; may also run in sized iframes. */
window.runCapUiBrowserChecks=async function(theme){
  if(location.hostname!=='localhost'||location.port!=='8059'||CapSupabase.configured()||localStorage.getItem('cap_supabase_session'))throw Error('ISOLATED_UI_FIXTURE_REQUIRED');
  const results=[],wait=ms=>new Promise(r=>setTimeout(r,ms)),assert=(ok,msg)=>{if(!ok)throw Error(msg)};
  const test=async(name,fn)=>{try{await fn();results.push({name,pass:true})}catch(e){results.push({name,pass:false,error:e.message})}};
  // Let the actual launch lifecycle finish, and dismiss release notes through
  // their handler so their capture-phase keyboard listener cannot leak.
  localStorage.setItem('cap_whats_new_seen_version',APP_VERSION);
  if(window.capLaunchActive)await new Promise(r=>document.addEventListener('cap:launch-complete',r,{once:true}));
  if(document.querySelector('.whats-new-overlay')){closeWhatsNew();await wait(280)}
  // Fixture-only: inspect local UI without signing into any service.
  document.querySelector('#cap-auth')?.remove();
  S.accts=[{id:100,name:'UI fixture Cash',bank:'UI fixture',type:'debit',img:'cash',bal:100,g:['#234567','#123456']},
    {id:101,name:'UI fixture Credit',bank:'UI fixture',type:'credit',bal:10,lim:100,l4:'1234',stmt:15,due:5,g:['#234567','#123456']}];
  if(theme)S.theme=theme;
  tab='Accounts';render();await wait(250);
  localStorage.removeItem('cap_developer_options');
  const before=JSON.stringify(S),syncBefore=JSON.stringify(await CapOff.productionSyncSnapshot());
  const diagnostics=['Test Supabase Connection','Test Cloud Database','Validate Real Data Sync','Run Sync Dry Run','Inspect Current Baseline','Initialize Sync Baseline','Diagnose Baseline Upgrade','Upgrade Sync Baseline','Inspect Pending Outbox','Prepare Cloud Migration','Migrate Data to Supabase'];
  await test('default OFF hides every technical control but preserves normal Cloud Sync UI',async()=>{
    stPrivacy();await wait(550);
    assert(!developerOptionsEnabled(),'default is not OFF');
    const text=document.querySelector('#sb').innerText;
    diagnostics.forEach(t=>assert(!text.includes(t),'visible diagnostic: '+t));
    assert(document.querySelector('#production-sync-toggle'),'normal toggle missing');
    assert(document.querySelector('#production-sync-status'),'normal status missing');
    assert(document.querySelector('#cloud-bootstrap-button'),'device setup missing');
  });
  await test('existing toggle reveals existing controls once, without enabling backend test capabilities',async()=>{
    const capability=window.CAP_DEV_TOOLS;
    openSettings();await wait(550);
    const input=document.querySelector('[onchange="setDeveloperOptions(this)"]');assert(input,'toggle missing');input.click();
    assert(developerOptionsEnabled(),'toggle did not persist');assert(window.CAP_DEV_TOOLS===capability,'changed capability gate');
    stPrivacy();await wait(550);
    diagnostics.forEach(t=>assert([...document.querySelectorAll('#sb button')].filter(b=>b.textContent.trim()===t).length===1,'missing/duplicate diagnostic: '+t));
  });
  await test('turning OFF again preserves all financial state and sync metadata',async()=>{
    setDeveloperOptions({checked:false});stPrivacy();await wait(550);
    assert(JSON.stringify(S)===before,'financial state changed');
    assert(JSON.stringify(await CapOff.productionSyncSnapshot())===syncBefore,'sync metadata changed');
    assert(CapProductionSync.status().enabled===false,'sync enabled');
  });
  closeS();await wait(250);
  tab='Accounts';render();document.querySelector('#app .cc').scrollIntoView({block:'center'});
  const sampleTransition=async(opening)=>{
    let samples=0,flyFrames=0;const deadline=performance.now()+1500;
    const check=()=>{
      const source=document.querySelector('#app .cc[onclick="acctMenu(100)"]'),dest=document.querySelector('#sb .cc.detail'),fly=document.querySelector('.cardfx-fly');
      const visible=e=>e&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none'&&+getComputedStyle(e).opacity>0;
      const sheet=document.querySelector('#sheet'),sheetVisible=sheet.classList.contains('open');
      assert(visible(fly)||(sheetVisible&&visible(dest))||visible(source),'both card representations invisible');
      if(fly){flyFrames++;assert(+getComputedStyle(fly).zIndex>+getComputedStyle(sheet).zIndex,'flyer below modal');}
      samples++;
    };
    check();
    while(document.querySelector('.cardfx-fly')&&performance.now()<deadline){await new Promise(requestAnimationFrame);check()}
    assert(!document.querySelector('.cardfx-fly'),'stuck transition');assert(flyFrames>0,'flying transition did not run');
    assert(!document.querySelector('.cardfx-txt'),'orphan text ghost');
    if(opening)assert(getComputedStyle(document.querySelector('#sb .cc.detail')).visibility==='visible','destination hidden');
    else assert(getComputedStyle(document.querySelector('#app .cc')).visibility==='visible','source hidden');
    return samples;
  };
  await test('opening has a visible card every sampled animation frame',async()=>{acctMenu(100);await sampleTransition(true)});
  await test('closing has a visible card every sampled animation frame and restores source',async()=>{closeS();await sampleTransition(false)});
  await test('rapid open/open/close/close cannot replace destination or leave hidden cards',async()=>{
    for(let n=0;n<3;n++){
      acctMenu(100);const card=document.querySelector('#sb .cc.detail');acctMenu(101);
      assert(document.querySelector('#sb .cc.detail')===card,'rerendered during flight');
      closeS();closeS();await wait(950);
      assert(!document.querySelector('.cardfx-fly,.cardfx-txt'),'orphan flyer');
      assert(!document.querySelector('#sheet').classList.contains('open'),'stuck modal');
      assert(!document.querySelector('#cardfx-hide').textContent,'hidden source rule leaked');
    }
  });
  await test('in-app reduced motion skips flyers and never hides source',async()=>{
    document.documentElement.classList.add('rm');acctMenu(100);
    assert(!document.querySelector('.cardfx-fly'),'reduced motion flew');closeS();await wait(240);
    document.documentElement.classList.remove('rm');
    assert(!document.querySelector('#cardfx-hide').textContent,'hidden rule leaked');
  });
  const showPicker=async()=>{
    // Actual transaction entry form; do not submit it.
    openTx();await wait(600);
    const b=document.querySelector('#sb .ps-btn');assert(b,'transaction picker missing');b.click();await wait(200);
    return {b,p:document.querySelector('#cap-overlays .ps-pop:not(.out)')};
  };
  await test('transaction picker is portaled, above modal and hit-testable outside rounded bounds',async()=>{
    const {p}=await showPicker();assert(p,'portal missing');
    assert(!document.querySelector('#sb').contains(p),'inside clipped modal');
    assert(+getComputedStyle(p.parentElement).zIndex>+getComputedStyle(document.querySelector('#sheet')).zIndex,'below modal');
    const r=p.getBoundingClientRect();assert(r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1,'viewport clipped');
    assert(document.elementFromPoint(r.left+20,r.top+20)?.closest('.ps-pop')===p,'menu not hit-testable');
  });
  await test('picker follows its field during scroll and remains keyboard/touch usable',async()=>{
    const p=document.querySelector('#cap-overlays .ps-pop:not(.out)'),b=document.querySelector('#sb .ps-btn'),sb=document.querySelector('#sb');
    assert(p&&b,'picker missing');
    sb.scrollTop=35;await wait(60);
    const r=b.getBoundingClientRect(),m=p.getBoundingClientRect();
    assert(Math.abs(m.left-Math.max(12,Math.min(r.left,innerWidth-m.width-12)))<2,'lost anchor');
    assert(getComputedStyle(p).touchAction==='pan-y','touch scrolling missing');
    p.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(180);
    assert(!document.querySelector('.ps-pop'),'Escape did not close');
    assert(document.activeElement===b,'focus not restored');
  });
  await test('picker still dispatches exactly one native select change',async()=>{
    const b=document.querySelector('#sb .ps-btn'),s=b.previousElementSibling;let changes=0;
    s.addEventListener('change',()=>changes++);b.click();await wait(190);
    document.querySelector('#cap-overlays [role=option]')?.click();await wait(190);
    assert(changes===1,'change count '+changes);assert(!document.querySelector('.ps-pop'),'menu remained');
  });
  await test('account grid picker stays inside the viewport and preserves its native change handler',async()=>{
    const s=document.querySelector('#ac'),b=s.nextElementSibling;b.click();await wait(200);
    const p=document.querySelector('#cap-overlays .ps-pop.grid:not(.out)');assert(p,'account grid missing');
    const r=p.getBoundingClientRect();assert(r.left>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,'account grid clipped');
    p.querySelector('[data-i="1"]').click();await wait(180);
    assert(s.value==='101','account value unchanged');assert(document.querySelector('#ccf').style.display==='block','native account handler did not run');
    b.click();await wait(190);document.querySelector('#cap-overlays [data-i="0"]').click();await wait(180);
  });
  await test('critical confirmations are above a modal-owned picker',async()=>{
    const b=document.querySelector('#sb .ps-btn');b.click();await wait(190);
    confirmBox('UI fixture','No action will run',()=>{},'Confirm');await wait(50);
    assert(+getComputedStyle(document.querySelector('#cfm')).zIndex>+getComputedStyle(document.querySelector('#cap-overlays')).zIndex,'confirmation below picker');
    document.querySelector('#cfm-no').click();await wait(210);closeS();await wait(240);
  });
  await test('navigating away removes orphan pickers',async()=>{
    await showPicker();openS('<h2>UI fixture next view</h2>');await wait(220);
    assert(!document.querySelector('.ps-pop'),'orphan picker');closeS();await wait(250);
  });
  await test('card options menu shares the unclipped overlay host',async()=>{
    acctMenu(100);await wait(600);kebab();await wait(60);
    assert(document.querySelector('#cap-overlays #km.open'),'card menu not portaled');kebab(1);
    assert(document.querySelector('#sb #km'),'card menu not restored');closeS();await wait(440);
  });
  await test('existing local transaction create/edit/delete handlers retain their balance effects',async()=>{
    openTx();await wait(550);
    document.querySelector('#am').value='5';document.querySelector('#nt').value='UI synthetic transaction';saveTx();await wait(280);
    const tx=S.tx.find(t=>t.note==='UI synthetic transaction');assert(tx&&S.accts[0].bal===95,'create changed');
    openTx(tx.id);await wait(550);document.querySelector('#am').value='7';saveTx(tx.id);await wait(280);
    assert(S.accts[0].bal===93,'edit changed');delTx(tx.id);await wait(300);
    assert(!S.tx.some(t=>t.id===tx.id)&&S.accts[0].bal===100,'delete changed');
    assert(CapProductionSync.status().enabled===false,'sync enabled');
  });
  return {viewport:[innerWidth,innerHeight],theme:document.documentElement.dataset.theme||'auto',passed:results.filter(r=>r.pass).length,total:results.length,results};
};
