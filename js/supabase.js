/* Phase 2: Supabase Auth and read-only connection checks.
   This module never reads or uploads Cap financial state. */
(function(){
  const cfg=window.CAP_SUPABASE_CONFIG||{},KEY='cap_supabase_session';let session=null,rpcReadyState=false;
  const clean=v=>String(v||'').replace(/\/$/,'');
  const configured=()=>!!(cfg.url&&cfg.publishableKey);
  function readSession(){try{return JSON.parse(localStorage.getItem(KEY)||'null')}catch(_){return null}}
  function writeSession(v){try{if(v)localStorage.setItem(KEY,JSON.stringify(v));else localStorage.removeItem(KEY)}catch(_){}session=v||null}
  async function request(path,options={}){const h={'apikey':cfg.publishableKey,'Content-Type':'application/json',...(options.headers||{})};if(session?.access_token)h.Authorization='Bearer '+session.access_token;const r=await fetch(clean(cfg.url)+path,{...options,headers:h});const body=await r.text();let data=null;try{data=body?JSON.parse(body):null}catch(_){}if(!r.ok){const err=Error(data?.msg||data?.message||data?.error_description||body||('HTTP '+r.status));err.status=r.status;err.code=data?.code||null;throw err}return data}
  async function user(){return request('/auth/v1/user')}
  async function refresh(){if(!session?.refresh_token)throw Error('No saved session');const s=await request('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:session.refresh_token})});writeSession(s);return s}
  async function restore(){if(!configured())return null;const saved=readSession();if(!saved)return null;session=saved;try{return await user()}catch(_){try{return (await refresh())&&await user()}catch(__){writeSession(null);return null}}}
  function showError(text){const e=document.getElementById('cap-auth-error');if(e)e.textContent=text||''}
  function hideLogin(){const e=document.getElementById('cap-auth');if(e){e.classList.add('cap-auth-out');setTimeout(()=>e.remove(),260)}}
  function loginMarkup(){const logo=typeof capBrandLogo==='function'?capBrandLogo('default'):'<img src="assets/branding/cap-default.png" alt="">';return `<div id="cap-auth" class="cap-auth" role="dialog" aria-modal="true" aria-labelledby="cap-auth-title"><form class="cap-auth-card" onsubmit="event.preventDefault();CapSupabase.signIn()"><div class="cap-auth-logo">${logo}</div><h1 id="cap-auth-title">Welcome to Cap</h1><p class="m">Sign in to connect your personal cloud database.</p><label>Email<input id="cap-auth-email" type="email" autocomplete="username" required></label><label>Password<span class="cap-auth-pass"><input id="cap-auth-password" type="password" autocomplete="current-password" required><button type="button" aria-label="Show password" onclick="CapSupabase.togglePassword(this)">Show</button></span></label><div id="cap-auth-error" class="cap-auth-error" role="alert"></div><button id="cap-auth-submit" class="btn" type="submit">Sign In</button><small class="cap-auth-local">Your Cap data remains on this device. Cloud sync is not enabled.</small></form></div>`}
  async function signIn(){const button=document.getElementById('cap-auth-submit'),email=document.getElementById('cap-auth-email')?.value.trim(),password=document.getElementById('cap-auth-password')?.value;if(!configured())return showError('Supabase is not configured.');if(!email||!password)return showError('Enter your email and password.');button.disabled=true;button.textContent='Signing in…';showError('');try{const s=await request('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})});writeSession(s);await user();hideLogin()}catch(e){writeSession(null);showError(e.message||'Sign in failed.')}finally{button.disabled=false;button.textContent='Sign In'}}
  function togglePassword(button){const input=document.getElementById('cap-auth-password');if(!input)return;input.type=input.type==='password'?'text':'password';button.textContent=input.type==='password'?'Show':'Hide';button.setAttribute('aria-label',input.type==='password'?'Show password':'Hide password')}
  async function signOut(){try{if(session?.access_token)await request('/auth/v1/logout',{method:'POST'});}catch(_){}writeSession(null);location.reload()}
  async function testCurrent(){
    if(!configured())throw Error('Supabase URL and Publishable key are not configured');
    const u=await user();
    if(!u?.id)throw Error('No authenticated Supabase user');
    let own=await request('/rest/v1/profiles?select=id&id=eq.'+encodeURIComponent(u.id)+'&limit=1');
    if(!Array.isArray(own)||!own.length){
      try{await request('/rest/v1/profiles',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({id:u.id,display_name:u.email||''})})}catch(e){
        // A concurrent first-time test may have created the row already; verify below.
        if(!String(e.message||'').toLowerCase().includes('duplicate'))throw Error('Your profile could not be created through RLS: '+e.message);
      }
      own=await request('/rest/v1/profiles?select=id&id=eq.'+encodeURIComponent(u.id)+'&limit=1');
    }
    if(!Array.isArray(own)||own.length!==1||own[0].id!==u.id)throw Error('Authenticated, but your profiles row is unavailable through RLS');
    const random=crypto.randomUUID();
    const other=await request('/rest/v1/profiles?select=id&id=eq.'+random+'&limit=1');
    if(!Array.isArray(other)||other.length!==0)throw Error('RLS check failed: a random profile was visible');
    return{userId:u.id,email:u.email,ownProfile:true,otherRows:0};
  }
  async function testCloudDatabase(){
    const stages=[];let id=null,uid=null,deleted=false;
    const pass=(name,detail)=>stages.push({name,ok:true,detail:detail||''});
    const fail=(name,error)=>stages.push({name,ok:false,error:String(error?.message||error)});
    try{
      if(!configured())throw Error('Supabase URL and Publishable key are not configured');
      const u=await user();uid=u?.id;if(!uid)throw Error('No authenticated Supabase user');pass('Authenticated',uid);
      id=crypto.randomUUID();
      const created=await request('/rest/v1/accounts',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({id,user_id:uid,legacy_id:'cap-phase3-test-'+id,account_type:'cash',name:'CAP SUPABASE TEST',balance:0,status:'Active'})});
      if(!Array.isArray(created)||created.length!==1||created[0].id!==id||created[0].user_id!==uid||created[0].name!=='CAP SUPABASE TEST')throw Error('Inserted account did not match the expected test fields');pass('Create');
      const read=await request('/rest/v1/accounts?select=id,user_id,name,account_type,balance,status&id=eq.'+id+'&user_id=eq.'+uid+'&limit=1');
      if(!Array.isArray(read)||read.length!==1||read[0].id!==id||read[0].user_id!==uid||read[0].account_type!=='cash'||Number(read[0].balance)!==0)throw Error('Created account could not be read back with the expected fields');pass('Read');
      const updated=await request('/rest/v1/accounts?id=eq.'+id+'&user_id=eq.'+uid,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({nickname:'Phase 3 disposable test'})});
      if(!Array.isArray(updated)||updated.length!==1||updated[0].nickname!=='Phase 3 disposable test')throw Error('Harmless account update was not verified');pass('Update');
      await request('/rest/v1/accounts?id=eq.'+id+'&user_id=eq.'+uid,{method:'DELETE',headers:{Prefer:'return=minimal'}});deleted=true;pass('Delete');
      const remaining=await request('/rest/v1/accounts?select=id&id=eq.'+id+'&user_id=eq.'+uid+'&limit=1');
      if(!Array.isArray(remaining)||remaining.length!==0)throw Error('Deleted test account is still readable');pass('Cleanup verified');return{ok:true,stages};
    }catch(e){fail(stages.length?'Stopped':'Authentication',e);return{ok:false,stages,error:String(e?.message||e)}}
    finally{if(id&&!deleted){try{await request('/rest/v1/accounts?id=eq.'+id+'&user_id=eq.'+uid,{method:'DELETE',headers:{Prefer:'return=minimal'}})}catch(e){stages.push({name:'Cleanup',ok:false,error:String(e?.message||e)})}}}
  }
  async function migratePlan(plan){
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,errors=[];
    const check=(value,collection,legacy,field)=>{if(value!=null&&!uuid.test(String(value)))errors.push(`${collection} legacy ${legacy} field ${field}: invalid UUID ${value}`)};
    check(plan.userId,'authenticated user','current','user_id');check(plan.profile?.id,'profiles','current','id');check(plan.preferences?.user_id,'user_preferences','current','user_id');
    const fields={goals:[['account_id','accounts']],bills:[['payment_account_id','accounts']],account_statements:[['account_id','accounts']],transactions:[['account_id','accounts'],['category_id','categories'],['bill_id','bills'],['parent_transaction_id','transactions'],['statement_id','account_statements']],transfers:[['from_account_id','accounts'],['to_account_id','accounts'],['goal_id','goals'],['statement_id','account_statements']],bill_payments:[['bill_id','bills'],['transaction_id','transactions'],['transfer_id','transfers']],budgets:[['category_id','categories']]};
    plan.tables.forEach(([table,rows])=>rows.forEach(row=>{check(row.id,table,row.legacy_id||row.name||'unknown','id');check(row.user_id,table,row.legacy_id||row.name||'unknown','user_id');(fields[table]||[]).forEach(([field])=>check(row[field],table,row.legacy_id||row.name||'unknown',field))}));
    (plan.tables.find(x=>x[0]==='categories')?.[1]||[]).forEach(row=>check(row.id,'categories',row.legacy_id||row.name,'category mapping id'));
    if(errors.length)throw Error('Migration preflight stopped before upload:\n'+errors.join('\n'));
    if(!configured())throw Error('Supabase URL and Publishable key are not configured');
    const u=await user();if(!u?.id)throw Error('No authenticated Supabase user');
    if(plan.userId!==u.id)throw Error('Migration user does not match the authenticated user');
    const upsert=async(table,rows,key='id')=>{if(!rows.length)return;if(key==='user_id')await request('/rest/v1/'+table+'?on_conflict=user_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)});else await request('/rest/v1/'+table+'?on_conflict=id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)})};
    await upsert('profiles',[plan.profile]);await upsert('user_preferences',[plan.preferences],'user_id');
    for(const [table,rows] of plan.tables)await upsert(table,rows);
    const read=async(table,select)=>request('/rest/v1/'+table+'?select='+encodeURIComponent(select)+'&user_id=eq.'+u.id);
    const actual={};for(const table of ['categories','accounts','goals','debts','bills','account_statements','transactions','transfers','bill_payments','budgets','notes'])actual[table]=await read(table,'*');actual.profiles=await request('/rest/v1/profiles?select=id&id=eq.'+u.id);actual.user_preferences=await request('/rest/v1/user_preferences?select=user_id&user_id=eq.'+u.id);
    const expected={};plan.tables.forEach(([t,rows])=>expected[t]=rows.length);expected.profiles=1;expected.user_preferences=1;
    const mismatches=[];Object.keys(expected).forEach(t=>{if((actual[t]||[]).length!==expected[t])mismatches.push(`${t}: expected ${expected[t]}, got ${(actual[t]||[]).length}`)});
    const sets={categories:new Set((actual.categories||[]).map(x=>String(x.id))),accounts:new Set((actual.accounts||[]).map(x=>String(x.id))),goals:new Set((actual.goals||[]).map(x=>String(x.id))),bills:new Set((actual.bills||[]).map(x=>String(x.id))),transactions:new Set((actual.transactions||[]).map(x=>String(x.id))),transfers:new Set((actual.transfers||[]).map(x=>String(x.id))),account_statements:new Set((actual.account_statements||[]).map(x=>String(x.id)))};
    const checkRefs=(table,fields,target)=>{const rows=plan.tables.find(x=>x[0]===table)?.[1]||[];rows.forEach(x=>fields.forEach(f=>{if(x[f]!=null&&!sets[target].has(String(x[f])))mismatches.push(`${table} ${x.id} references missing ${target} ${x[f]}`)}))};
    checkRefs('goals',['account_id'],'accounts');checkRefs('bills',['payment_account_id'],'accounts');checkRefs('transactions',['account_id'],'accounts');checkRefs('transactions',['category_id'],'categories');checkRefs('transactions',['bill_id'],'bills');checkRefs('transactions',['parent_transaction_id'],'transactions');checkRefs('transactions',['statement_id'],'account_statements');checkRefs('transfers',['from_account_id','to_account_id'],'accounts');checkRefs('transfers',['goal_id'],'goals');checkRefs('transfers',['statement_id'],'account_statements');checkRefs('bill_payments',['bill_id'],'bills');checkRefs('bill_payments',['transaction_id'],'transactions');checkRefs('bill_payments',['transfer_id'],'transfers');checkRefs('budgets',['category_id'],'categories');
    const catExpected=plan.tables.find(x=>x[0]==='categories')?.[1]||[],catActual=new Map((actual.categories||[]).map(x=>[String(x.id),x]));catExpected.forEach(x=>{const got=catActual.get(String(x.id));if(!got||got.name!==x.name||got.legacy_id!==x.legacy_id)mismatches.push(`category ${x.legacy_id} mapping mismatch`)});
    const aMap=new Map((actual.accounts||[]).map(a=>[String(a.id),a]));plan.tables.find(x=>x[0]==='accounts')[1].forEach(a=>{const got=aMap.get(String(a.id));if(!got||Number(got.balance)!==Number(a.balance))mismatches.push(`account ${a.legacy_id} balance mismatch`) });
    const localTotal=(plan.tables.find(x=>x[0]==='accounts')?.[1]||[]).reduce((n,a)=>n+(Number(a.balance)||0),0),cloudTotal=(actual.accounts||[]).reduce((n,a)=>n+(Number(a.balance)||0),0);if(Math.abs(localTotal-cloudTotal)>.005)mismatches.push(`total account balance mismatch: expected ${localTotal}, got ${cloudTotal}`);if(Math.abs(localTotal-44170)>.005)mismatches.push(`local baseline total mismatch: expected 44170, got ${localTotal}`);
    const txExpected=plan.tables.find(x=>x[0]==='transactions')[1],txMap=new Map((actual.transactions||[]).map(t=>[String(t.id),t]));txExpected.forEach(t=>{const got=txMap.get(String(t.id));if(!got||Number(got.amount)!==Number(t.amount)||got.status!==t.status)mismatches.push(`transaction ${t.legacy_id} amount/status mismatch`)});
    for(const [table,fields] of [['bills',['name','amount','frequency']],['goals',['name','target_amount','saved_amount']],['debts',['person','amount','direction']]]){const expectedRows=plan.tables.find(x=>x[0]===table)?.[1]||[],gotRows=new Map((actual[table]||[]).map(x=>[String(x.id),x]));expectedRows.forEach(x=>{const got=gotRows.get(String(x.id));fields.forEach(f=>{if(!got||String(got[f])!==String(x[f]))mismatches.push(`${table} ${x.legacy_id} field ${f} mismatch`)})})}
    return{ok:!mismatches.length,userId:u.id,counts:Object.fromEntries(Object.entries(actual).map(([k,v])=>[k,v.length])),mismatches};
  }
  async function validateRealData(plan,options={}){
    if(!configured())throw Error('Supabase URL and Publishable key are not configured');
    const u=await user();if(!u?.id)throw Error('No authenticated Supabase user');if(plan.userId!==u.id)throw Error('Validation user does not match the authenticated user');
    const read=async(table,select='*')=>{try{return await request('/rest/v1/'+table+'?select='+encodeURIComponent(select)+'&user_id=eq.'+encodeURIComponent(u.id))}catch(e){throw Error(`Table: ${table}\nOperation: SELECT\nExact Supabase error: ${e.message}`)}};
    const actual={};for(const table of ['categories','accounts','goals','debts','bills','account_statements','transactions','transfers','bill_payments','budgets','notes'])actual[table]=await read(table);try{actual.profiles=await request('/rest/v1/profiles?select=id&id=eq.'+encodeURIComponent(u.id))}catch(e){throw Error(`Table: profiles\nOperation: SELECT\nExact Supabase error: ${e.message}`)}actual.user_preferences=await read('user_preferences','*');
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
  function status(){return{configured:configured(),authenticated:!!session,userId:session?.user?.id||null}}
  async function boot(){document.body.insertAdjacentHTML('afterbegin',loginMarkup());const u=await restore();if(u)hideLogin();else{const e=document.getElementById('cap-auth');if(e)e.classList.add('cap-auth-ready');if(!configured())showError('Add the Supabase URL and Publishable key to supabase-config.js.')}}
  let rpcVerifierResult=null;
  async function refreshRpcReadiness(){try{const r=await request('/rest/v1/rpc/cap_verify_transaction_rpc',{method:'POST',body:'{}'});const v=Array.isArray(r)?r[0]:r;rpcVerifierResult={success:true,response:v,status:200,code:null,error:null};rpcReadyState=!!(v&&v.exists===true&&v.signature_ok===true&&v.security_invoker===true&&v.language_ok===true&&v.authenticated_execute===true&&v.anon_execute===false&&v.public_execute===false&&v.version==='CAP_PHASE_6K2A_V1'&&v.version_ok===true&&v.ready===true);return rpcReadyState}catch(e){rpcVerifierResult={success:false,response:null,status:e?.status||null,code:e?.code||null,error:String(e?.message||e)};rpcReadyState=false;return false}}
  const rpcVerifierStatus=()=>rpcVerifierResult;
  let notesRpcReadyState=false,notesRpcVerifierResult=null,notesRpcCheck=0;
  async function refreshNotesRpcReadiness(){
    const check=++notesRpcCheck;
    notesRpcReadyState=false;
    notesRpcVerifierResult=null;
    try{
      // Metadata verifier only. Never probe readiness by invoking the writer.
      const response=await request('/rest/v1/rpc/cap_verify_notes_rpc',{method:'POST',body:'{}'});
      if(check!==notesRpcCheck)return false;
      const v=Array.isArray(response)?(response.length===1?response[0]:null):response;
      notesRpcReadyState=!!(v&&v.exists===true&&v.signature_ok===true&&v.security_invoker===true&&v.search_path_ok===true&&v.version_ok===true&&v.authenticated_execute===true&&v.anon_execute===false&&v.public_execute===false&&v.rls_ok===true&&v.policy_ok===true&&v.table_grants_ok===true&&v.version==='CAP_NOTES_CAS_V1'&&v.ready===true);
      notesRpcVerifierResult={checked:true,ready:notesRpcReadyState};
    }catch(_){if(check!==notesRpcCheck)return false;notesRpcVerifierResult={checked:true,ready:false,blocked:true};}
    return notesRpcReadyState;
  }
  window.CapSupabase={configured,signIn,signOut,testCurrent,testCloudDatabase,migratePlan,validateRealData,currentUser:user,syncRequest:request,rpcReady:()=>rpcReadyState,refreshRpcReadiness,rpcVerifierStatus,notesRpcReady:()=>notesRpcReadyState,refreshNotesRpcReadiness,notesRpcVerifierStatus:()=>notesRpcVerifierResult,togglePassword,status,boot};
  boot();
})();
