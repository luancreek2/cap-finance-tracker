/* Phase 2: Supabase Auth and read-only connection checks.
   This module never reads or uploads Cap financial state. */
(function(){
  const cfg=window.CAP_SUPABASE_CONFIG||{},KEY='cap_supabase_session';let session=null,rpcReadyState=false;
  let verifiedUser=null,localAccess=false,verification='signed-out',sessionRevision=0,bootPromise=null;
  // The complete production RPC surface of the shipped client. Nothing else
  // may reach Supabase: no table endpoint, no legacy write, no test RPC.
  const PRODUCTION_RPC_PATHS=['/rest/v1/rpc/cap_verify_production_sync_v1',
    '/rest/v1/rpc/cap_sync_snapshot_v1','/rest/v1/rpc/cap_sync_transaction_create',
    '/rest/v1/rpc/cap_notes_change','/rest/v1/rpc/cap_notes_read',
    '/rest/v1/rpc/cap_verify_notes_lifecycle'];
  const clean=v=>String(v||'').replace(/\/$/,'');
  const configured=()=>!!(cfg.url&&cfg.publishableKey);
  function readSession(){try{return JSON.parse(localStorage.getItem(KEY)||'null')}catch(_){return null}}
  const offline=()=>typeof navigator!=='undefined'&&navigator.onLine===false;
  const hasToken=s=>!!(s&&typeof s==='object'&&!Array.isArray(s)&&typeof s.access_token==='string'&&s.access_token);
  const cachedLocal=s=>hasToken(s)&&typeof s.user?.id==='string'&&!!s.user.id;
  function invalidate(state){
    verifiedUser=null;verification=state;rpcReadyState=false;
    notesRpcReadyState=false;notesRpcVerifierResult=null;++notesRpcCheck;
  }
  function notice(){
    const old=document.getElementById('cap-local-auth-notice');
    if(!localAccess||verifiedUser){if(old)old.remove();return;}
    if(old)return;
    document.body.insertAdjacentHTML('beforeend','<div id="cap-local-auth-notice" class="cap-local-auth-notice" role="status">Local access only · Cloud authentication is not verified. Cloud Sync stays OFF. Reconnect and reload to verify your session.</div>');
  }
  function writeSession(v){try{if(v)localStorage.setItem(KEY,JSON.stringify(v));else localStorage.removeItem(KEY)}catch(_){}session=v||null;++sessionRevision;localAccess=cachedLocal(session);invalidate(v?'unverified':'signed-out');if(!v)notice();window.CapProductionSync?.authChanged()}
  async function request(path,options={}){
    const auth=path.startsWith('/auth/v1/');
    // The shipped client is RPC-only. Direct table endpoints and every
    // legacy/test endpoint are refused here, before any request is made.
    if(!auth&&!PRODUCTION_RPC_PATHS.includes(path))throw Error('DIRECT_TABLE_ACCESS_DISABLED');
    if(offline()){invalidate('offline');notice();throw Error('Offline — cloud authentication is not verified');}
    if(!auth&&!verifiedUser)throw Error('Cloud access blocked — online authentication required');
    const revision=sessionRevision,h={'apikey':cfg.publishableKey,'Content-Type':'application/json',...(options.headers||{})};
    if(session?.access_token)h.Authorization='Bearer '+session.access_token;
    try{
      const r=await fetch(clean(cfg.url)+path,{...options,headers:h}),body=await r.text();let data=null;
      try{data=body?JSON.parse(body):null}catch(_){}
      if(!r.ok){const err=Error(data?.msg||data?.message||data?.error_description||body||('HTTP '+r.status));err.status=r.status;err.code=data?.code||data?.error_code||null;throw err}
      if(revision!==sessionRevision)throw Error('Session changed during request');
      return data;
    }catch(error){if(revision===sessionRevision){invalidate(offline()?'offline':'unverified');notice();}throw error}
  }
  async function user(){
    if(!configured()||!hasToken(session))throw Error('Online sign-in required');
    const revision=sessionRevision,u=await request('/auth/v1/user');
    if(revision!==sessionRevision||!u||typeof u.id!=='string'||!u.id||session.user?.id&&session.user.id!==u.id){invalidate('unverified');throw Error('Authenticated identity not proven');}
    // Only a successful, fresh server response establishes cloud identity.
    // Cached session.user is exclusively evidence for local offline access.
    if(!session.user?.id)writeSession({...session,user:u});
    const newlyVerified=!verifiedUser;verifiedUser=u;localAccess=true;verification='verified';notice();if(newlyVerified)window.CapProductionSync?.request('authenticated');return u;
  }
  const accessRejected=e=>e?.status===401||e?.status===403;
  const refreshRejected=e=>accessRejected(e)||e?.status===400&&['refresh_token_not_found','refresh_token_already_used','session_not_found','user_not_found','user_banned','invalid_credentials','invalid_grant'].includes(e.code);
  async function refresh(){
    if(!session?.refresh_token)throw Error('No saved refresh token');
    const revision=sessionRevision,s=await request('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:session.refresh_token})});
    if(revision!==sessionRevision||!hasToken(s)||typeof s.refresh_token!=='string'||!s.refresh_token||
      session.user?.id&&s.user?.id&&session.user.id!==s.user.id)throw Error('Refreshed session not proven');
    writeSession({...s,user:s.user||session.user});return s;
  }
  async function restore(){
    if(!configured())return;
    const saved=readSession();if(!hasToken(saved))return;
    session=saved;++sessionRevision;localAccess=cachedLocal(saved);invalidate('unverified');
    if(offline()){invalidate('offline');return;}
    try{await user();return;}catch(error){
      // Network/5xx/429 failures are not evidence that credentials were revoked.
      // Do not refresh or discard saved credentials on an ambiguous failure.
      if(!accessRejected(error))return;
      if(!session?.refresh_token){writeSession(null);return;}
    }
    try{await refresh();}catch(error){if(refreshRejected(error))writeSession(null);return;}
    try{await user();}catch(error){if(accessRejected(error))writeSession(null);}
  }
  function showError(text){const e=document.getElementById('cap-auth-error');if(e)e.textContent=text||''}
  function hideLogin(){const e=document.getElementById('cap-auth');if(e){e.classList.add('cap-auth-out');setTimeout(()=>e.remove(),260)}}
  function loginMarkup(){const logo=typeof capBrandLogo==='function'?capBrandLogo('default'):'<img src="assets/branding/cap-default.png" alt="">';return `<div id="cap-auth" class="cap-auth" role="dialog" aria-modal="true" aria-labelledby="cap-auth-title"><form class="cap-auth-card" onsubmit="event.preventDefault();CapSupabase.signIn()"><div class="cap-auth-logo">${logo}</div><h1 id="cap-auth-title">Welcome to Cap</h1><p class="m">Sign in to connect your personal cloud database.</p><label>Email<input id="cap-auth-email" type="email" autocomplete="username" required></label><label>Password<span class="cap-auth-pass"><input id="cap-auth-password" type="password" autocomplete="current-password" required><button type="button" aria-label="Show password" onclick="CapSupabase.togglePassword(this)">Show</button></span></label><div id="cap-auth-error" class="cap-auth-error" role="alert"></div><button id="cap-auth-submit" class="btn" type="submit">Sign In</button><small class="cap-auth-local">Your Cap data remains on this device. Cloud sync is not enabled.</small></form></div>`}
  async function signIn(){const button=document.getElementById('cap-auth-submit'),email=document.getElementById('cap-auth-email')?.value.trim(),password=document.getElementById('cap-auth-password')?.value;if(!configured())return showError('Supabase is not configured.');if(!email||!password)return showError('Enter your email and password.');button.disabled=true;button.textContent='Signing in…';showError('');try{const s=await request('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})});if(!hasToken(s))throw Error('Invalid session');writeSession(s);await restore();if(verifiedUser||localAccess){hideLogin();notice();}else showError('Sign-in could not be verified. Please try again online.');}catch(_){showError(offline()?'You are offline. Reconnect before signing in.':'Sign-in could not be verified. Check your connection and credentials.');}finally{button.disabled=false;button.textContent='Sign In'}}
  function togglePassword(button){const input=document.getElementById('cap-auth-password');if(!input)return;input.type=input.type==='password'?'text':'password';button.textContent=input.type==='password'?'Show':'Hide';button.setAttribute('aria-label',input.type==='password'?'Show password':'Hide password')}
  async function signOut(){const token=session?.access_token;writeSession(null);notice();try{if(token)await request('/auth/v1/logout',{method:'POST',headers:{Authorization:'Bearer '+token}});}catch(_){}location.reload()}
  async function testCurrent(){
    if(!configured())throw Error('Supabase URL and Publishable key are not configured');
    const u=await user();
    if(!u?.id)throw Error('No authenticated Supabase user');
    // Read-only: the production snapshot is the only cloud read path. There is
    // no production RPC that creates a profile row, so bootstrap is reported
    // as unsupported instead of writing to a table.
    const {rows}=await window.CapProductionRpc.snapshotRows(u.id);
    const own=rows.profiles||[];
    if(!Array.isArray(own)||own.length>1)throw Error('Authenticated, but your profile row is unavailable through the production snapshot');
    return{userId:u.id,email:u.email,ownProfile:own.length===1,otherRows:0,
      profileBootstrap:own.length===1?'PRESENT':'UNSUPPORTED_NO_PRODUCTION_RPC'};
  }
  async function testCloudDatabase(){
    const stages=[];
    const pass=(name,detail)=>stages.push({name,ok:true,detail:detail||''});
    const fail=(name,error)=>stages.push({name,ok:false,error:String(error?.message||error)});
    try{
      if(!configured())throw Error('Supabase URL and Publishable key are not configured');
      const u=await user();if(!u?.id)throw Error('No authenticated Supabase user');pass('Authenticated',u.id);
      const {rows}=await window.CapProductionRpc.snapshotRows(u.id);
      pass('Production snapshot read',String((rows.accounts||[]).length)+' accounts');
      fail('Create','No production RPC creates accounts');
      fail('Update','No production RPC updates accounts');
      fail('Delete','No production RPC deletes accounts');
      return{ok:false,stages,error:'Account CRUD has no production RPC adapter'};
    }catch(e){fail(stages.length?'Stopped':'Authentication',e);return{ok:false,stages,error:String(e?.message||e)}}
  }
  async function migratePlan(plan){
    // Direct table uploads are not part of the production contract. The
    // reviewed RPC surface has no bulk migration endpoint, so this path is
    // refused instead of writing tables directly.
    throw Error('DIRECT_MIGRATION_REMOVED - the production contract has no bulk upload RPC. Use the production RPC adapters.');
  }
  async function validateRealData(plan,options={}){
    if(!configured())throw Error('Supabase URL and Publishable key are not configured');
    const u=await user();if(!u?.id)throw Error('No authenticated Supabase user');if(plan.userId!==u.id)throw Error('Validation user does not match the authenticated user');
    // The production snapshot is the only cloud read path. The report shape is
    // unchanged: one table-keyed map of owner rows.
    const {rows}=await window.CapProductionRpc.snapshotRows(u.id);
    const actual={};
    for(const table of ['categories','accounts','goals','debts','bills','account_statements','transactions','transfers','bill_payments','budgets','notes','profiles','user_preferences'])
      actual[table]=(rows[table]||[]).map(r=>r.row);
    const missing=[],newLocalMissing=[],unexpected=[],unexpectedDetails=[],mismatches=[],mismatchDetails=[],fk=[],allowedNew=new Set(options.allowNew||[]);
    for(const [table,rows] of plan.tables){const expected=new Map(rows.map(x=>[String(x.id),x])),got=new Map((actual[table]||[]).map(x=>[String(x.id),x]));rows.forEach(x=>{if(!got.has(String(x.id))){const item={entity:table,localId:x.legacy_id||x.name||String(x.id),supabaseId:x.id,baselineMapping:allowedNew.has(table+':'+x.id)?'NO':'UNKNOWN',cloudCounterpart:'NO',newLocalRecord:allowedNew.has(table+':'+x.id)?'YES':'UNKNOWN'};if(allowedNew.has(table+':'+x.id))newLocalMissing.push(item);else missing.push(item)}});(actual[table]||[]).forEach(x=>{if(!expected.has(String(x.id))){unexpected.push(`${table} ${x.id}`);unexpectedDetails.push({entity:table,supabaseId:x.id})}})}
    const typeOf=v=>v===null?'null':v===undefined?'omitted':Array.isArray(v)?'array':typeof v;
    const compare=(table,fields)=>{const rows=plan.tables.find(x=>x[0]===table)?.[1]||[],got=new Map((actual[table]||[]).map(x=>[String(x.id),x]));rows.forEach(x=>{const y=got.get(String(x.id)),diff=fields.filter(f=>String(x?.[f]??'')!==String(y?.[f]??''));if(y&&diff.length){mismatches.push(`${table} ${x.legacy_id||x.name||x.id}`);diff.forEach(field=>mismatchDetails.push({entity:table,localId:x.legacy_id||x.name||String(x.id),supabaseId:x.id,field,localType:typeOf(x[field]),cloudType:typeOf(y[field]),normalization:'Phase 6B canonical comparison'}))}})};
    compare('accounts',['name','account_type','balance','credit_limit','status']);compare('transactions',['amount','transaction_date','posting_date','status','account_id','category_id','bill_id']);compare('bills',['name','amount','kind','frequency','payment_account_id']);compare('goals',['name','target_amount','saved_amount','account_id','target_date','completed']);compare('debts',['person','amount','direction','due_date']);compare('budgets',['amount','category_id']);compare('categories',['name','legacy_id']);
    const sets={accounts:new Set((actual.accounts||[]).map(x=>String(x.id))),categories:new Set((actual.categories||[]).map(x=>String(x.id))),bills:new Set((actual.bills||[]).map(x=>String(x.id))),goals:new Set((actual.goals||[]).map(x=>String(x.id))),transactions:new Set((actual.transactions||[]).map(x=>String(x.id))),transfers:new Set((actual.transfers||[]).map(x=>String(x.id))),account_statements:new Set((actual.account_statements||[]).map(x=>String(x.id)))};
    const refs={goals:[['account_id','accounts']],bills:[['payment_account_id','accounts']],transactions:[['account_id','accounts'],['category_id','categories'],['bill_id','bills'],['parent_transaction_id','transactions'],['statement_id','account_statements']],transfers:[['from_account_id','accounts'],['to_account_id','accounts'],['goal_id','goals'],['statement_id','account_statements']],bill_payments:[['bill_id','bills'],['transaction_id','transactions'],['transfer_id','transfers']],budgets:[['category_id','categories']]};
    Object.entries(refs).forEach(([table,fields])=>(actual[table]||[]).forEach(row=>fields.forEach(([field,target])=>{if(row[field]!=null&&!sets[target].has(String(row[field])))fk.push(`${table} ${row.id} → ${field} ${row[field]}`)})));
    const localTotal=(plan.tables.find(x=>x[0]==='accounts')?.[1]||[]).reduce((n,a)=>n+(Number(a.balance)||0),0),cloudTotal=(actual.accounts||[]).reduce((n,a)=>n+(Number(a.balance)||0),0);if(Math.abs(localTotal-cloudTotal)>.005)mismatches.push(`total account balance ${localTotal} vs ${cloudTotal}`);
    const baselineRecords=[];plan.tables.forEach(([table,rows])=>{const got=new Map((actual[table]||[]).map(x=>[String(x.id),x]));rows.forEach(local=>{const cloud=got.get(String(local.id));if(cloud)baselineRecords.push({entity:table,supabase_id:local.id,legacy_id:local.legacy_id||local.name||null,user_id:u.id,local_updated_at:local.metadata?._u?new Date(local.metadata._u).toISOString():null,cloud_updated_at:cloud.updated_at||null})})});if(actual.profiles?.length)baselineRecords.push({entity:'profiles',supabase_id:u.id,legacy_id:null,user_id:u.id,local_updated_at:null,cloud_updated_at:actual.profiles[0].updated_at||null});if(actual.user_preferences?.length)baselineRecords.push({entity:'user_preferences',supabase_id:u.id,legacy_id:null,user_id:u.id,local_updated_at:null,cloud_updated_at:actual.user_preferences[0].updated_at||null});
    const fingerprintCounts={local:Object.fromEntries(plan.tables.map(x=>[x[0],x[1].length])),cloud:Object.fromEntries(Object.entries(actual).map(([k,v])=>[k,v.length]))};
    const fingerprint=JSON.stringify({counts:fingerprintCounts,accounts:actual.accounts||[],categories:actual.categories||[],goals:actual.goals||[],debts:actual.debts||[],bills:actual.bills||[],transactions:actual.transactions||[],transfers:actual.transfers||[],bill_payments:actual.bill_payments||[],budgets:actual.budgets||[],account_statements:actual.account_statements||[],notes:actual.notes||[],preferences:actual.user_preferences||[]});
    const timestampRows=plan.tables.flatMap(x=>x[1]).filter(x=>x.metadata&&x.metadata._u);const dry={wouldPush:0,wouldPull:0,unchanged:Math.max(0,(plan.tables.reduce((n,x)=>n+x[1].length,0))-mismatches.length),conflicts:mismatches.length,missingMappings:missing.length+fk.length};
    const timestampReadiness={localTimestampRecords:timestampRows.length,cloudTimestampRecords:Object.values(actual).flat().filter(x=>x&&x.updated_at).length,baselineAvailable:false,ready:false,reason:'Local sync baseline has not been initialized; automatic sync must remain OFF.'};
    const report={missing,missingNewRecords:newLocalMissing,unexpected,unexpectedDetails,mismatches,mismatchDetails,fk,counts:{local:Object.fromEntries(plan.tables.map(x=>[x[0],x[1].length])),cloud:Object.fromEntries(Object.entries(actual).map(([k,v])=>[k,v.length]))},localTotal,cloudTotal,timestampReadiness,dryRun:dry,baselineRecords,fingerprint,snapshot:actual};
    report.missingCount=missing.length;report.newLocalMissingCount=newLocalMissing.length;report.unexpectedCount=unexpected.length;report.mismatchCount=mismatches.length;report.foreignKeyErrorCount=fk.length;report.dataOk=!missing.length&&!unexpected.length&&!mismatches.length&&!fk.length;report.ok=report.dataOk;report.baselineReady=timestampReadiness.ready;report.dryRunAvailable=timestampReadiness.ready;
    return report;
  }
  function status(){if(offline()&&verifiedUser)invalidate('offline');return{configured:configured(),authenticated:!!verifiedUser,userId:verifiedUser?.id||null,localAccess,verification}}
  function boot(){
    if(bootPromise)return bootPromise;
    bootPromise=(async()=>{
      document.body.insertAdjacentHTML('afterbegin',loginMarkup());await restore();
      if(verifiedUser||localAccess){hideLogin();notice();}
      else{const e=document.getElementById('cap-auth');if(e)e.classList.add('cap-auth-ready');if(!configured())showError('Add the Supabase URL and Publishable key to supabase-config.js.');else if(offline())showError('Reconnect to sign in. No saved local session is available.');}
    })();
    return bootPromise;
  }
  let rpcVerifierResult=null;
  async function refreshRpcReadiness(){
    try{
      // The production readiness contract. A legacy/test verifier is not a
      // substitute and is no longer called at all.
      const r=await window.CapProductionRpc.readiness();
      rpcVerifierResult={success:r.ok===true,response:r.raw,status:200,code:null,error:r.ok?null:(r.reason||'CONTRACT_NOT_VERIFIED')};
      rpcReadyState=r.ok===true;
    }catch(e){rpcVerifierResult={success:false,response:null,status:e?.status||null,code:e?.code||null,error:String(e?.message||e)};rpcReadyState=false;}
    return rpcReadyState;
  }
  const rpcVerifierStatus=()=>rpcVerifierResult;
  let notesRpcReadyState=false,notesRpcVerifierResult=null,notesRpcCheck=0;
  async function refreshNotesRpcReadiness(){
    const check=++notesRpcCheck;
    notesRpcReadyState=false;
    notesRpcVerifierResult=null;
    try{
      // Metadata-only notes contract check. The writer is never probed.
      const r=await window.CapProductionRpc.notesContract();
      if(check!==notesRpcCheck)return false;
      notesRpcReadyState=r.ok===true;
      notesRpcVerifierResult={checked:true,ready:notesRpcReadyState,version:r.raw?.version||null,reason:r.ok?null:(r.reason||'NOTES_CONTRACT_NOT_VERIFIED')};
    }catch(_){if(check!==notesRpcCheck)return false;notesRpcVerifierResult={checked:true,ready:false,blocked:true};}
    return notesRpcReadyState;
  }
  window.CapSupabase={configured,signIn,signOut,testCurrent,testCloudDatabase,migratePlan,validateRealData,currentUser:user,syncRequest:request,productionRpcPaths:PRODUCTION_RPC_PATHS,localIdentity:()=>cachedLocal(session)?session.user.id:null,sessionGeneration:()=>sessionRevision,rpcReady:()=>rpcReadyState,refreshRpcReadiness,rpcVerifierStatus,notesRpcReady:()=>notesRpcReadyState,refreshNotesRpcReadiness,notesRpcVerifierStatus:()=>notesRpcVerifierResult,togglePassword,status,boot};
  boot();
})();
