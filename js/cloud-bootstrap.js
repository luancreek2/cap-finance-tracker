/* Phase 6M: explicit, cloud-read-only device provisioning. Never a merge or sync cycle. */
(function () {
  'use strict';
  const ENTITIES = ['profiles','user_preferences','categories','accounts','goals','debts','bills',
    'account_statements','transactions','transfers','bill_payments','budgets','notes'];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const HEX = /^[0-9a-f]{64}$/i;
  const copy = x => JSON.parse(JSON.stringify(x));
  const fail = text => { throw Error(text); };
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  function stable(x) {
    if (Array.isArray(x)) return '['+x.map(stable).join(',')+']';
    if (object(x)) return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';
    return JSON.stringify(x);
  }
  function signature(raw) {
    return stable({owner:raw.owner,counts:raw.counts,records:raw.records.slice().sort((a,b)=>
      (a.entity+':'+(a.row.id||a.row.user_id)).localeCompare(b.entity+':'+(b.row.id||b.row.user_id)))});
  }
  function validateSnapshot(raw, owner) {
    if (!UUID.test(owner) || !object(raw) || raw.version!=='CAP_SYNC_SNAPSHOT_V1' || raw.complete!==true ||
        raw.owner!==owner || !Array.isArray(raw.records) || !Number.isSafeInteger(raw.record_count) ||
        raw.record_count!==raw.records.length || !raw.record_count || !object(raw.counts) ||
        Object.keys(raw.counts).length!==ENTITIES.length) fail('Incomplete or wrong-owner cloud snapshot');
    const counts=Object.fromEntries(ENTITIES.map(e=>[e,0])), seen=new Set();
    for (const r of raw.records) {
      if (!Object.hasOwn(counts,r.entity) || !object(r.row)) fail('Unknown snapshot entity');
      const row=r.row, id=row.id || (r.entity==='user_preferences' && row.user_id);
      if (!UUID.test(id) || (r.entity==='profiles'?row.id:row.user_id)!==owner || seen.has(r.entity+':'+id)) fail('Snapshot ownership/identity invalid');
      seen.add(r.entity+':'+id); counts[r.entity]++;
      if (r.entity==='notes') {
        const l=r.lifecycle;
        if (!l || l.version!==1 || !Number.isSafeInteger(l.revision) || l.revision<1 || l.deleted_at!==null ||
            !(l.operation_id===null || UUID.test(l.operation_id))) fail('Unsafe Notes lifecycle');
      }
    }
    for (const e of ENTITIES) if (!Number.isSafeInteger(raw.counts[e]) || raw.counts[e]!==counts[e]) fail('Cloud record counts invalid');
    if (counts.profiles!==1 || counts.user_preferences!==1 || !counts.accounts) fail('Cloud dataset is not provisionable');
    return raw;
  }
  // Categories alone may be the built-in defaults. Everything else must be empty/default.
  function assertFresh(state, defaults) {
    const emptyLists=['accts','tx','pend','xfer','bills','goals','debts'];
    for (const k of emptyLists) if (state[k]!==undefined && (!Array.isArray(state[k]) || state[k].length)) fail('Existing local data: '+k);
    if (state.notes && !(Array.isArray(state.notes) && !state.notes.length)) fail('Existing local Notes');
    if (state.budgets && (!object(state.budgets) || Object.keys(state.budgets).length)) fail('Existing local budgets');
    if (state.cats!==undefined && !Array.isArray(state.cats)) fail('Invalid local categories');
    if(new Set((state.cats||[]).map(c=>c.n)).size!==(state.cats||[]).length) fail('Duplicate local categories');
    for (const c of state.cats||[]) if (!(defaults||[]).some(d=>stable(c)===stable(d))) fail('Customized local categories');
    const allowed=new Set([...emptyLists,'notes','budgets','cats','_mt']);
    const settings={cur:'PHP',name:'',photo:null,nf:'us',neg:'sign',dec:0,theme:'auto',anim:1,rm:0,snd:1,hap:1,
      hide:0,logoChoice:'default',accountView:'all',accountSort:'manual',accountOrder:[]};
    for (const [k,v] of Object.entries(state)) {
      if (allowed.has(k)) continue;
      if (!Object.hasOwn(settings,k) || stable(v)!==stable(settings[k])) fail('Existing local user customization: '+k);
    }
  }
  function hydrate(raw, owner) {
    validateSnapshot(raw,owner);
    const rows=e=>raw.records.filter(r=>r.entity===e).map(r=>r.row);
    const localId=r=>{
      const s=String(r.legacy_id??''); const n=Number(s);
      if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n<1 || String(n)!==s) fail('Unsupported legacy ID: '+s);
      return n;
    };
    const maps={};
    for (const e of ['accounts','transactions','bills','goals','debts','transfers','notes'])
      maps[e]=new Map(rows(e).map(r=>[r.id,localId(r)]));
    const ref=(e,id)=>id==null?null:(maps[e].has(id)?maps[e].get(id):fail('Unmapped relationship: '+e));
    const categories=new Map(rows('categories').map(c=>[c.id,c.name]));
    const category=id=>id==null?'':(categories.has(id)?categories.get(id):fail('Unknown category'));
    const s={accts:[],tx:[],pend:[],xfer:[],bills:[],goals:[],debts:[],cats:[],budgets:{},notes:[]};
    for (const r of rows('categories')) {
      if (!r.name || ['__proto__','constructor','prototype'].includes(r.name)) fail('Unsafe category name');
      s.cats.push({id:r.legacy_id,n:r.name,i:r.emoji,l:r.logo_url,a:r.archived?1:0});
    }
    for (const r of rows('accounts')) {
      const a={id:localId(r),bank:r.bank,name:r.name,type:r.account_type,net:r.network,l4:r.last_four,bal:r.balance,
        lim:r.credit_limit,cardStatus:r.status,img:r.card_art,photo:r.photo_url,nickname:r.nickname,
        stmt:r.statement_day,due:r.due_day,dueN:r.due_days,minimumPayment:r.minimum_payment||{},
        fees:copy(r.fee_settings||{}),statementHistory:copy(r.statement_settings?.statementHistory||[]),
        g:['#334155','#64748b']};
      const interestKeys=['interestEnabled','interestRate','interestCalc','interestCreditFreq','interestOtherDays',
        'interestSimulation','goalInterestMode','interestGoalId'];
      for (const [k,v] of Object.entries(r.interest_settings||{})) {
        if(!interestKeys.includes(k)) fail('Unsupported account interest setting: '+k);
        a[k]=copy(v);
      }
      if (!['debit','credit','ewallet'].includes(a.type) || !Number.isFinite(a.bal)) fail('Invalid account');
      s.accts.push(a);
    }
    const statementMap=new Map();
    for (const r of rows('account_statements')) {
      const a=s.accts.find(a=>a.id===ref('accounts',r.account_id));
      if (!a || !object(r.metadata)) fail('Statement metadata unavailable');
      const st={...copy(r.metadata),st:r.statement_start,en:r.statement_end,opening:r.opening_balance,close:r.closing_balance,
        minimum:r.minimum_due,paid:r.paid_amount,c:{...(r.metadata.c||{}),st:r.statement_date,due:r.due_date}};
      const legacy=String(st.statementId||`${a.id}:${st.st||st.en||a.statementHistory.length}`);
      statementMap.set(r.id,legacy);
      const found=a.statementHistory.findIndex(x=>String(x.statementId||`${a.id}:${x.st||x.en||''}`)===legacy);
      if(found<0)a.statementHistory.push(st);else a.statementHistory[found]=st;
    }
    const statement=id=>id==null?null:(statementMap.get(id)||fail('Unknown statement'));
    for (const r of rows('transactions')) {
      const t={...copy(r.metadata||{}),id:localId(r),d:r.transaction_date,amt:r.amount,acct:ref('accounts',r.account_id),
        cat:category(r.category_id),note:r.title||'',desc:r.description||''};
      for (const [key,value] of [['pd',r.posting_date],['billId',ref('bills',r.bill_id)],
        ['parentId',ref('transactions',r.parent_transaction_id)],['statementId',statement(r.statement_id)]]) {
        if(value!=null)t[key]=value;else delete t[key];
      }
      if (!Number.isFinite(t.amt) || !t.acct || !['posted','pending'].includes(r.status)) fail('Invalid transaction');
      s[r.status==='pending'?'pend':'tx'].push(t);
    }
    for (const r of rows('bills')) s.bills.push({...copy(r.metadata||{}),id:localId(r),name:r.name,amt:r.amount,kind:r.kind,
      freq:r.frequency,start:r.start_date,due:r.due_day,logo:r.logo_url,subscriptionStatus:r.status,cancelledOn:r.cancelled_on,
      trialStartDate:r.trial_start,trialEndDate:r.trial_end,al:copy(r.alert_settings||[]),acct:ref('accounts',r.payment_account_id)});
    for (const r of rows('goals')) s.goals.push({id:localId(r),name:r.name,icon:r.icon,target:r.target_amount,saved:r.saved_amount,
      accountId:ref('accounts',r.account_id),targetDate:r.target_date,done:r.completed?1:0});
    for (const r of rows('debts')) s.debts.push({id:localId(r),who:r.person,note:r.note,amt:r.amount,dir:r.direction,due:r.due_date||''});
    for (const r of rows('budgets')) {
      const name=category(r.category_id);
      if (!name || Object.hasOwn(s.budgets,name)) fail('Ambiguous budget');
      s.budgets[name]=r.amount;
    }
    for (const r of rows('notes')) s.notes.push({id:localId(r),t:r.title,b:r.body,d:r.note_date});
    for (const r of rows('transfers')) s.xfer.push({...copy(r.metadata||{}),id:localId(r),from:ref('accounts',r.from_account_id),
      to:ref('accounts',r.to_account_id),goalId:ref('goals',r.goal_id),statementId:statement(r.statement_id),
      kind:r.transfer_type,amt:r.amount,d:r.transfer_date,note:r.note||''});
    for (const r of rows('bill_payments')) {
      if (r.transfer_id || r.status!=='paid') fail('Unsupported bill payment representation');
      const t=s.tx.find(t=>t.id===ref('transactions',r.transaction_id));
      if (!t || t.billId!==ref('bills',r.bill_id) || t.d!==r.paid_date || Math.abs(t.amt)!==r.amount) fail('Bill payment cannot round-trip');
      t.billDue=r.due_date;
    }
    const p=rows('profiles')[0], prefs=rows('user_preferences')[0];
    Object.assign(s,{name:p.display_name||'',photo:p.photo_url||null,cur:prefs.currency,nf:prefs.number_format,neg:prefs.negative_style,
      dec:prefs.show_decimals?1:0,theme:prefs.theme,anim:prefs.animations_enabled?1:0,rm:prefs.reduce_motion?1:0,
      snd:prefs.sound_enabled?1:0,hap:prefs.haptics_enabled?1:0,hide:prefs.hide_balances?1:0,logoChoice:prefs.logo_choice,
      accountView:prefs.account_view,accountSort:prefs.account_sort,accountOrder:copy(prefs.account_order||[])});
    return s;
  }
  function assertIdle(image) {
    const meta=new Map(image.syncmeta);
    if (meta.has('baseline') || meta.get('production-sync-v1')?.enabled || image.outbox.length || image.syncconflicts.length ||
        ['production-sync-journal-v1','cloud-bootstrap-pending-v1','controlled-notes-test-v1','demo-local-refresh-state-v1','manual-notes-pull-v1'].some(k=>meta.has(k))) fail('Device has baseline, pending operations or recovery state');
  }
  function createController(io) {
    let busy=false;
    return {async run() {
      if (busy) fail('Bootstrap already running');
      busy=true; let installed=false, cp;
      try {
        return await io.lock(async()=>{
          const before=await io.capture(); assertIdle(before.image); assertFresh(before.state,io.defaults());
          const stored=new Map(before.image.kv).get('state');
          if (stored) assertFresh(JSON.parse(stored.json),io.defaults());
          if (before.localStorageJson!==null && stable(JSON.parse(before.localStorageJson))!==stable(before.state)) fail('Local memory and storage differ');
          const user=await io.authenticate(); if (!UUID.test(user?.id)) fail('Authenticated owner required');
          const owner=user.id, generation=io.generation();
          const guard=()=>io.online() && io.owner()===owner && io.generation()===generation && !io.enabled() && io.unchanged(before);
          if (!guard()) fail('Device authentication/state changed');
          const ready=await io.readiness(); if (!ready.ok) fail('Production readiness not verified');
          const raw=validateSnapshot(await io.remote(owner),owner), initial=signature(raw);
          const candidate=hydrate(raw,owner);
          if(!candidate.cats.length) fail('Cloud has no categories; default insertion would change it');
          const verified=await io.verify(candidate,raw,owner);
          if (!guard()) fail('Device changed during validation');
          const latest=validateSnapshot(await io.remote(owner),owner);
          if (signature(latest)!==initial) fail('Cloud changed during bootstrap');
          if (!await io.confirm(raw.record_count)) return {cancelled:true};
          const final=validateSnapshot(await io.remote(owner),owner);
          if (signature(final)!==initial || !guard()) fail('Cloud or device changed before commit');
          cp=await io.install(before,candidate,verified.baseline,guard); installed=true;
          try {
            const persisted=await io.persisted();
            if (stable(persisted.state)!==stable(candidate) || stable(persisted.baseline)!==stable(verified.baseline) ||
                persisted.outbox || persisted.conflicts || persisted.enabled) fail('Persisted installation invalid');
            const post=validateSnapshot(await io.remote(owner),owner);
            if (signature(post)!==initial) fail('Cloud changed during installation');
            await io.verify(persisted.state,post,owner);
            if (io.owner()!==owner || io.generation()!==generation) fail('Authentication changed after installation');
            await io.finish(cp);
            installed=false;
            return {ok:true,records:raw.record_count,message:'Device ready — Cloud Sync can now be enabled'};
          } catch(e) { throw e; }
        });
      } catch(e) {
        if (installed) {
          try { await io.lock(()=>io.rollback(cp)); }
          catch(rollback) { fail('HARD FAILURE: bootstrap rollback failed; keep this device OFF. '+rollback.message); }
        }
        throw e;
      } finally { busy=false; }
    }};
  }
  async function verifyCandidate(state, raw, owner) {
    // Apply the same compatibility normalization used by rendering, but to the candidate only.
    // If this changes a synchronized cloud field, the round-trip checks below must refuse it.
    migrate(state);
    const prep=migrationPrepare(state);
    if(prep.blockingProblems.length) fail('Restored state has mapping problems');
    const p=buildSupabaseMigrationPlan(prep,owner,state), v=await CapSupabase.validateRealData(p);
    const expected=Object.fromEntries(ENTITIES.map(e=>[e,raw.records.filter(r=>r.entity===e).map(r=>r.row)]));
    for(const e of ENTITIES) {
      const sort=arr=>arr.slice().sort((a,b)=>String(a.id||a.user_id).localeCompare(String(b.id||b.user_id)));
      if(stable(sort(expected[e]))!==stable(sort(v.snapshot[e]||[]))) fail('Cloud changed during candidate verification');
    }
    if(!v.dataOk || v.missingCount || v.unexpectedCount || v.mismatchCount || v.foreignKeyErrorCount ||
        v.dryRun.wouldPush || v.dryRun.wouldPull || v.dryRun.conflicts) fail('Restored state failed validation');
    const records=await CapSync.recordFingerprints(p,v);
    const baseline={key:'baseline',version:2,user_id:owner,created_at:new Date().toISOString(),fingerprint:v.fingerprint,
      records:records.map(({cloudContentFingerprint,canonicalDiffs,...r})=>r)};
    const diag=CapSync.fingerprintDiagnostics(records,baseline);
    if(!diag.ok || records.length!==raw.record_count || records.some(r=>!UUID.test(r.supabase_id) || !HEX.test(r.contentFingerprint) ||
        r.contentFingerprint!==r.cloudContentFingerprint || r.user_id!==owner)) fail('Restored fingerprints or UUID mappings differ');
    const model={records:[...p.tables.flatMap(([entity,rows])=>rows.map(row=>({entity,row}))),
      {entity:'profiles',row:p.profile},{entity:'user_preferences',row:p.preferences}]};
    const plan=await CapProductionSync.plan({baseline,outbox:[],conflicts:[],recovery:[]},model,raw.records,CapSync.fingerprintRow);
    if(Object.values(plan).some(a=>a.length)) fail('Restored device would not enable with zero changes');
    return {baseline,validation:v};
  }
  function browserIO() {
    const memory=()=>JSON.stringify(S);
    return {
      lock:fn=>navigator.locks?navigator.locks.request('cap-controlled-notes-test',{mode:'exclusive'},fn):Promise.reject(Error('Safe device lock unavailable')),
      defaults:()=>CAT0.map(c=>({n:c.n,i:c.i})),
      capture:async()=>({image:await CapOff.bootstrapStorage('read'),state:copy(S),memoryJson:memory(),localStorageJson:localStorage.getItem('pera'),
        localSnapshot:await CapOff.localSnapshot()}),
      authenticate:()=>CapSupabase.currentUser(),owner:()=>CapSupabase.localIdentity(),generation:()=>CapSupabase.sessionGeneration(),
      online:()=>navigator.onLine!==false,enabled:()=>CapProductionSync.status().enabled,
      unchanged:b=>!window.CAP_BOOTSTRAP_HARD_FAILURE && memory()===b.memoryJson && localStorage.getItem('pera')===b.localStorageJson,
      readiness:()=>CapProductionRpc.readiness(),remote:owner=>CapProductionRpc.snapshot(owner),verify:verifyCandidate,
      confirm:n=>window.confirm('Set up this device from '+n+' cloud records?\n\nOnly this empty device will change. A local rollback copy is retained. Cloud Sync stays OFF.'),
      install:async(before,state,baseline,guard)=>{
        const cp=await CapOff.bootstrapStorage('install',{before:before.image,memoryJson:before.memoryJson,localStorageJson:before.localStorageJson,localSnapshot:before.localSnapshot,
          state:{json:JSON.stringify(state),mt:state._mt||0},baseline,backupKey:'cloud-bootstrap-backup:'+crypto.randomUUID()},guard);
        try { CapOff.installBootstrapState(cp.state.json,before.memoryJson); }
        catch(e) {
          try { await CapOff.recoverBootstrap(); }
          catch(rollback) { fail('HARD FAILURE: bootstrap rollback failed. '+rollback.message); }
          throw e;
        }
        return cp;
      },
      persisted:async()=>{
        const image=await CapOff.bootstrapStorage('read'),kv=new Map(image.kv),meta=new Map(image.syncmeta);
        const json=kv.get('state')?.json;
        if(json!==memory() || json!==localStorage.getItem('pera')) fail('Local persistence copies differ');
        return {state:JSON.parse(json),baseline:meta.get('baseline'),enabled:meta.get('production-sync-v1')?.enabled,
          outbox:image.outbox.length,conflicts:image.syncconflicts.length};
      },
      finish:cp=>CapOff.bootstrapStorage('finish',cp,()=>!CapProductionSync.status().enabled && memory()===cp.state.json && CapSupabase.localIdentity()===cp.baseline.user_id),
      rollback:()=>CapOff.recoverBootstrap()
    };
  }
  async function availability() {
    if(!CapSupabase.status().authenticated || navigator.onLine===false || CapProductionSync.status().enabled || window.CAP_BOOTSTRAP_HARD_FAILURE) return false;
    try { const image=await CapOff.bootstrapStorage('read'); assertIdle(image); assertFresh(S,CAT0.map(c=>({n:c.n,i:c.i}))); return true; }
    catch(_) { return false; }
  }
  const api={ENTITIES,validateSnapshot,signature,assertFresh,hydrate,assertIdle,createController,verifyCandidate,availability,
    settingsHtml:()=>'<div class="st-box st-col"><button type="button" class="btn s" id="cloud-bootstrap-button" disabled onclick="CapCloudBootstrap.run()">Set Up This Device From Cloud</button><small class="st-note" id="cloud-bootstrap-result">Available only on an empty, signed-in device with Cloud Sync OFF and no baseline or pending work.</small></div>',
    refresh:async()=>{
      const b=document.getElementById('cloud-bootstrap-button');
      if(b){
        b.disabled=!await availability();
      }else{
        setTimeout(()=>CapCloudBootstrap.refresh(),100);
      }
    },
    run:async()=>{
      const b=document.getElementById('cloud-bootstrap-button'),out=document.getElementById('cloud-bootstrap-result');
      if(b)b.disabled=true;
      try {
        const r=await controller.run();
        if(out)out.textContent=r.message||'Setup cancelled. Nothing changed.';
        return r;
      } catch(e) { if(out)out.textContent='Device setup stopped: '+e.message; return {ok:false,error:e.message}; }
      finally { await api.refresh(); }
    }};
  let controller;
  if(typeof module!=='undefined' && module.exports) module.exports=api;
  if(typeof window!=='undefined') {window.CapCloudBootstrap=api;controller=createController(browserIO());}
  // If Settings panel is already open when module loads, refresh button state
  if(typeof document!=='undefined' && document.getElementById('cloud-bootstrap-button')){
    CapCloudBootstrap.refresh();
  }
})();
