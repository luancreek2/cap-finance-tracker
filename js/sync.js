/* Phase 6A: dormant local-first sync engine. Automatic cloud sync is OFF. */
/* Developer test tools are hidden unless explicitly enabled: ?dev=1 enables, ?dev=0 disables. */
(function(){try{const p=new URLSearchParams(location.search);if(p.has('dev'))localStorage.setItem('cap_dev_tools',p.get('dev')==='0'?'0':'1')}catch(_){}})();
window.CAP_DEV_TOOLS=(()=>{try{return localStorage.getItem('cap_dev_tools')==='1'||new URLSearchParams(location.search).get('dev')==='1'}catch(_){return false}})();
(function(){
  const ORDER=['user_preferences','categories','accounts','goals','debts','bills','account_statements','transactions','transfers','bill_payments','budgets','notes'];
  const now=()=>new Date().toISOString(),id=()=>crypto.randomUUID();
  const excluded=new Set(['id','user_id','legacy_id','created_at','updated_at','metadata','local_updated_at','cloud_updated_at','contentFingerprint']),optionalUnset=new Set(['accounts.interest_settings.goalInterestMode','accounts.interest_settings.interestCalc','accounts.interest_settings.interestCreditFreq','accounts.interest_settings.interestEnabled','accounts.interest_settings.interestGoalId','accounts.interest_settings.interestOtherDays','accounts.interest_settings.interestRate','accounts.interest_settings.interestSimulation','profiles.display_name','profiles.photo_url']);
  const numericKeys=new Set(['amount','balance','credit_limit','target_amount','saved_amount','opening_balance','closing_balance','minimum_due','paid_amount','statement_day','due_day','due_days']);
  function canonical(v,key='',path=''){if(excluded.has(key))return undefined;if(v===undefined||v===null)return null;if(typeof v==='number')return Number.isFinite(v)?v:null;if(Array.isArray(v))return v.map(x=>canonical(x,'',path));if(typeof v==='object'){const o={},prefix=path?path+'.':'';const keys=new Set(Object.keys(v));optionalUnset.forEach(p=>{if(p.startsWith(prefix)){const leaf=p.slice(prefix.length);if(leaf&&!leaf.includes('.'))keys.add(leaf)}});[...keys].sort().forEach(k=>{const x=canonical(v[k],k,prefix+k);if(x!==undefined)o[k]=x});return o}if(numericKeys.has(key)&&v!==''&&!Number.isNaN(Number(v)))return Number(v);if(/(^d$|date|_at$)/i.test(key)&&/^\d{4}-\d{2}-\d{2}/.test(String(v))){const s=String(v);return s.length===10?s:new Date(s).toISOString()}return String(v)}
  async function contentFingerprint(value){const raw=JSON.stringify(canonical(value,'')),buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));return Array.from(new Uint8Array(buf)).map(x=>x.toString(16).padStart(2,'0')).join('')}
  function valueType(v){if(v===null)return'null';if(Array.isArray(v))return'array';return typeof v}
  function safeRepresentation(field,value){const sensitive=/(amount|balance|target|saved|minimum|limit|paid|rate|fee|value)/i.test(field);if(sensitive)return`<${valueType(value)}>`;if(value===undefined)return'<omitted>';try{const s=JSON.stringify(value);return s.length>120?s.slice(0,117)+'...':s}catch(_){return`<${valueType(value)}>`}}
  function mismatchDetails(a,b,path='',out=[]){const keys=new Set([...Object.keys(a||{}),...Object.keys(b||{})]);for(const k of keys){const p=path?path+'.'+k:k,x=a?.[k],y=b?.[k];if(x&&typeof x==='object'&&y&&typeof y==='object'&&!Array.isArray(x)&&!Array.isArray(y))mismatchDetails(x,y,p,out);else if(JSON.stringify(x)!==JSON.stringify(y)){const lt=valueType(x),ct=valueType(y),classification=(lt!==ct||x===undefined||y===undefined)?'NORMALIZATION DIFFERENCE':/(_id|account|category|bill|statement|goal|user)/i.test(p)?'SCHEMA/MAPPING DIFFERENCE':'POSSIBLE REAL DATA DIFFERENCE';out.push({field:p,localType:lt,cloudType:ct,localRepresentation:safeRepresentation(p,x),cloudRepresentation:safeRepresentation(p,y),normalization:'canonical ordering/null/numeric/date normalization applied',classification});}}return out}
  async function recordFingerprints(plan,validation){const out=[];for(const [entity,rows] of plan.tables){const cloud=new Map((validation.snapshot?.[entity]||[]).map(x=>[String(x.id),x]));for(const local of rows){const c=cloud.get(String(local.id));if(c){const owner=local.user_id,cloudOwner=c.user_id;if(!owner||owner!==plan.userId||!cloudOwner||cloudOwner!==plan.userId)throw Error('Ownership source mismatch for '+entity+' '+(local.legacy_id||local.id));const lc=canonical(local,'',entity),cc=canonical(c,'',entity);out.push({entity,localId:local.legacy_id||local.name||String(local.id),supabase_id:local.id,user_id:owner,local_updated_at:local.metadata?._u?new Date(local.metadata._u).toISOString():null,cloud_updated_at:c.updated_at||null,contentFingerprint:await contentFingerprint(lc),cloudContentFingerprint:await contentFingerprint(cc),canonicalDiffs:mismatchDetails(lc,cc)})}}}if(validation.snapshot?.profiles?.length){const sourceId=plan.profile?.id,cloudId=validation.snapshot.profiles[0]?.id;if(!sourceId||sourceId!==plan.userId||!cloudId||cloudId!==plan.userId)throw Error('Ownership source mismatch for profiles');const lc=canonical(plan.profile,'','profiles'),cc=canonical(validation.snapshot.profiles[0],'','profiles');out.push({entity:'profiles',localId:plan.userId,supabase_id:plan.userId,user_id:sourceId,local_updated_at:null,cloud_updated_at:validation.snapshot.profiles[0].updated_at||null,contentFingerprint:await contentFingerprint(lc),cloudContentFingerprint:await contentFingerprint(cc),canonicalDiffs:mismatchDetails(lc,cc)})}if(validation.snapshot?.user_preferences?.length){const sourceOwner=plan.preferences?.user_id,cloudOwner=validation.snapshot.user_preferences[0]?.user_id;if(!sourceOwner||sourceOwner!==plan.userId||!cloudOwner||cloudOwner!==plan.userId)throw Error('Ownership source mismatch for user_preferences');const lc=canonical(plan.preferences,'','user_preferences'),cc=canonical(validation.snapshot.user_preferences[0],'','user_preferences');out.push({entity:'user_preferences',localId:plan.userId,supabase_id:plan.userId,user_id:sourceOwner,local_updated_at:null,cloud_updated_at:validation.snapshot.user_preferences[0].updated_at||null,contentFingerprint:await contentFingerprint(lc),cloudContentFingerprint:await contentFingerprint(cc),canonicalDiffs:mismatchDetails(lc,cc)})}return out}
  function validLegacyId(v){return(typeof v==='number'&&Number.isFinite(v))||(typeof v==='string'&&v.trim()!==''&&v.trim()!=='[object Object]')}
  function canonicalRecordIdentity(record){const entity=String(record?.entity??'').trim(),rawLocalId=record?.localId,rawLegacyId=record?.legacy_id,raw=validLegacyId(rawLocalId)?rawLocalId:validLegacyId(rawLegacyId)?rawLegacyId:null,display=raw===null?'':String(raw);return{key:raw===null?'':entity+':'+display,entity,rawLocalId,rawLegacyId,stableId:raw===null?null:display,supabaseId:record?.supabase_id,userId:record?.user_id,userIdType:typeof record?.user_id,localIdType:typeof rawLocalId,legacyIdType:typeof rawLegacyId,supabaseIdType:typeof record?.supabase_id}}
  function fingerprintDiagnostics(records,baseline){const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,hex=/^[0-9a-f]{64}$/i,byIdentity=new Map(),byUuid=new Map(),missingFingerprints=[],malformedFingerprints=[],missingEntities=[],missingLocalIds=[],missingSupabaseUuids=[],canonicalMismatches=[];let valid=0;records.forEach(r=>{const info=canonicalRecordIdentity(r);if(!info.entity)missingEntities.push(info);if(!info.stableId)missingLocalIds.push(info);if(!r.supabase_id||!uuid.test(String(r.supabase_id)))missingSupabaseUuids.push(info);if(!r.contentFingerprint)missingFingerprints.push(info);else if(!hex.test(String(r.contentFingerprint)))malformedFingerprints.push(info);else valid++;if(info.key)byIdentity.set(info.key,(byIdentity.get(info.key)||0)+1);const uk=info.entity+':'+String(r.supabase_id||'');if(info.entity&&r.supabase_id)byUuid.set(uk,(byUuid.get(uk)||0)+1);if(r.contentFingerprint!==r.cloudContentFingerprint)canonicalMismatches.push(info)});const duplicateIdentities=[...byIdentity].filter(x=>x[1]>1).map(x=>x[0]),duplicateSupabaseUuids=[...byUuid].filter(x=>x[1]>1).map(x=>x[0]),baseInfo=(baseline.records||[]).map(canonicalRecordIdentity),localInfo=records.map(canonicalRecordIdentity),baseId=new Map(),localId=new Map();baseInfo.forEach((x,i)=>{if(x.key){if(!baseId.has(x.key))baseId.set(x.key,[]);baseId.get(x.key).push({info:x,index:i})}});localInfo.forEach((x,i)=>{if(x.key){if(!localId.has(x.key))localId.set(x.key,[]);localId.get(x.key).push({info:x,index:i})}});const baseUuid=new Map(),localUuid=new Map();baseInfo.forEach((x,i)=>{const k=x.entity+':'+String(x.supabaseId||'');if(x.entity&&uuid.test(String(x.supabaseId||''))){if(!baseUuid.has(k))baseUuid.set(k,[]);baseUuid.get(k).push({info:x,index:i})}});localInfo.forEach((x,i)=>{const k=x.entity+':'+String(x.supabaseId||'');if(x.entity&&uuid.test(String(x.supabaseId||''))){if(!localUuid.has(k))localUuid.set(k,[]);localUuid.get(k).push({info:x,index:i})}});const matchedLocal=new Set(),matchedBase=new Set(),ambiguous=[],matches=[];localInfo.forEach((l,i)=>{let candidates=l.key?localId.get(l.key)||[]:[];if(candidates.length===1){const b=candidates[0];if(b.info.entity===l.entity&&b.info.user_id===l.user_id){matchedLocal.add(i);matchedBase.add(b.index);matches.push({local:i,baseline:b.index,method:'local/legacy ID'})}else ambiguous.push({local:l,reason:'ownership mismatch'})}else if(candidates.length>1)ambiguous.push({local:l,reason:'duplicate local identity'});else{const k=l.entity+':'+String(l.supabaseId||''),bc=localUuid.get(k)||[],cc=baseUuid.get(k)||[];if(bc.length===1&&cc.length===1){const b=cc[0];if(b.info.user_id===l.user_id){matchedLocal.add(i);matchedBase.add(b.index);matches.push({local:i,baseline:b.index,method:'entity + Supabase UUID'})}else ambiguous.push({local:l,reason:'ownership mismatch'})}else if(bc.length||cc.length)ambiguous.push({local:l,reason:'ambiguous entity + UUID match'})}});const localWithoutBaseline=localInfo.filter((_,i)=>!matchedLocal.has(i)),baselineWithoutLocal=baseInfo.filter((_,i)=>!matchedBase.has(i)),uuidPairing=matches.filter(x=>x.method==='entity + Supabase UUID').length,checks={recordCountMatches:records.length===(baseline.records||[]).length,allFingerprintsValid:valid===records.length,noMissingFingerprints:!missingFingerprints.length,noMalformedFingerprints:!malformedFingerprints.length,noDuplicateIdentities:!duplicateIdentities.length,noDuplicateSupabaseUuids:!duplicateSupabaseUuids.length,noMissingEntities:!missingEntities.length,noMissingLocalIds:!missingLocalIds.length,noMissingSupabaseUuids:!missingSupabaseUuids.length,noLocalWithoutBaseline:!localWithoutBaseline.length,noBaselineWithoutLocal:!baselineWithoutLocal.length,noCanonicalMismatches:!canonicalMismatches.length,noAmbiguousMatches:!ambiguous.length,allRecordsMatched:matches.length===records.length&&matches.length===(baseline.records||[]).length};return{expected:(baseline.records||[]).length,generated:records.length,valid,missingFingerprints,malformedFingerprints,duplicateIdentities,duplicateSupabaseUuids,missingEntities,missingLocalIds,missingSupabaseUuids,localWithoutBaseline,baselineWithoutLocal,ambiguous,matchedByLocalId:matches.filter(x=>x.method==='local/legacy ID').length,matchedByUuidFallback:uuidPairing,uuidPairing,pairDiagnostics:matches.map(x=>({entity:localInfo[x.local].entity,localId:localInfo[x.local].stableId,supabaseId:localInfo[x.local].supabaseId,method:x.method,ownershipTypes:{local:localInfo[x.local].userIdType,baseline:baseInfo[x.baseline].userIdType}})),checks,failedChecks:Object.keys(checks).filter(k=>!checks[k]),canonicalMismatches,canonicalMismatchDetails:records.filter(r=>r.contentFingerprint!==r.cloudContentFingerprint).flatMap(r=>(r.canonicalDiffs||[]).map(d=>({...d,entity:r.entity,localId:r.localId,supabase_id:r.supabase_id}))),ok:Object.values(checks).every(Boolean)}}
  function meta(){return CapOff.syncStore('syncmeta','get','status').catch(()=>null)}
  async function putMeta(v){return CapOff.syncStore('syncmeta','put',{...(await meta()||{}),...v},'status')}
  async function queue(op){const authenticatedUser=await CapSupabase.currentUser();if(!authenticatedUser?.id)throw Error('No authenticated user');const u=authenticatedUser.id;if(op.user_id!==u)throw Error(`Queue user does not match authenticated user: operation=${op.user_id}, authenticated=${u}`);const record={id:id(),user_id:u,entity:op.entity,local_id:String(op.local_id),supabase_id:op.supabase_id||null,operation:op.operation,payload:op.payload||null,local_updated_at:op.local_updated_at||now(),queued_at:now(),retry_count:0,last_error:null};if(record.user_id!==authenticatedUser.id)throw Error(`Queue ownership assertion failed: operation=${record.user_id}, authenticated=${authenticatedUser.id}`);await CapOff.syncStore('outbox','put',record);return record}
  async function request(path,options){return CapSupabase.syncRequest(path,options)}
  async function applyOperation(op){const filter='id=eq.'+encodeURIComponent(op.supabase_id)+'&user_id=eq.'+encodeURIComponent(op.user_id);if(op.operation==='delete')return request('/rest/v1/'+op.entity+'?'+filter,{method:'DELETE',headers:{Prefer:'return=minimal'}});return request('/rest/v1/'+op.entity+'?on_conflict=id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify([op.payload])})}
  async function cleanupTestArtifacts(userId){
    const queued=await CapOff.syncStore('outbox','all').catch(()=>[]);for(const q of queued){const p=q.payload||{};if(q.user_id===userId&&q.entity==='accounts'&&(String(q.local_id).startsWith('phase6-test-')||p.legacy_id?.startsWith('phase6-test-')||p.name==='CAP SYNC ENGINE TEST'))await CapOff.syncStore('outbox','delete',q.id).catch(()=>{})}
    const conflicts=await CapOff.syncStore('syncconflicts','all').catch(()=>[]);for(const c of conflicts){const p=c.payload||{};if(c.user_id===userId&&(c.entity==='accounts'||p.legacy_id?.startsWith('phase6-test-')||p.name==='CAP SYNC ENGINE TEST'))await CapOff.syncStore('syncconflicts','delete',c.id).catch(()=>{})}
    const rows=await request('/rest/v1/accounts?select=id,legacy_id,name&user_id=eq.'+encodeURIComponent(userId)+'&legacy_id=like.'+encodeURIComponent('phase6-test-*'));for(const row of rows||[]){if(row.name==='CAP SYNC ENGINE TEST'||String(row.legacy_id||'').startsWith('phase6-test-'))await request('/rest/v1/accounts?id=eq.'+encodeURIComponent(row.id)+'&user_id=eq.'+encodeURIComponent(userId),{method:'DELETE',headers:{Prefer:'return=minimal'}})}
    await putMeta({last_test_at:null});
  }
  async function test(){
    const report=[],authenticatedUser=await CapSupabase.currentUser();if(!authenticatedUser?.id)throw Error('Authenticate before testing the sync engine');await cleanupTestArtifacts(authenticatedUser.id);report.push(['Failed test artifacts cleaned',true]);report.push(['Authenticated user resolved',true]);const u={userId:authenticatedUser.id};
    const aid=id(),base={id:aid,user_id:authenticatedUser.id,legacy_id:'phase6-test-'+aid,account_type:'cash',name:'CAP SYNC ENGINE TEST',balance:0,status:'Active'},updated={...base,nickname:'updated test'};let q1,q2,qOffline,deleted=false;
    try{
      report.push(['local test record creation',true]);if(base.user_id!==authenticatedUser.id)throw Error(`Queue user mismatch: operation=${base.user_id}, authenticated=${authenticatedUser.id}`);q1=await queue({entity:'accounts',local_id:aid,supabase_id:aid,operation:'upsert',payload:base,user_id:authenticatedUser.id});report.push(['Queue ownership matched',true]);report.push(['outbox creation',true]);
      await applyOperation(q1);report.push(['cloud upsert',true]);
      const first=await request('/rest/v1/accounts?select=id,name&id=eq.'+aid+'&user_id=eq.'+u.userId);if(first.length!==1||first[0].name!==base.name)throw Error('Cloud read-back mismatch');report.push(['cloud read-back',true]);
       q2=await queue({entity:'accounts',local_id:aid,supabase_id:aid,operation:'upsert',payload:updated,user_id:authenticatedUser.id});await applyOperation(q2);report.push(['local update → cloud update',true]);
       const offlinePayload={...updated,nickname:'offline retry'};qOffline=await queue({entity:'accounts',local_id:aid,supabase_id:aid,operation:'upsert',payload:offlinePayload,user_id:authenticatedUser.id});report.push(['simulated queued/offline change',true]);await applyOperation(qOffline);const retry=await request('/rest/v1/accounts?select=nickname&id=eq.'+aid+'&user_id=eq.'+u.userId);if(retry.length!==1||retry[0].nickname!==offlinePayload.nickname)throw Error('Queued retry read-back mismatch');report.push(['queued retry',true]);
      const localConflict={updated_at:'2026-01-02T00:00:00Z'},cloudConflict={updated_at:'2026-01-03T00:00:00Z'};if(!detectConflict(localConflict,cloudConflict,'2026-01-01T00:00:00Z'))throw Error('Conflict fixture was not detected');report.push(['conflict detection',true]);
       const tomb=await queue({entity:'accounts',local_id:aid,supabase_id:aid,operation:'delete',payload:null,user_id:authenticatedUser.id});if(!tomb||tomb.operation!=='delete')throw Error('Tombstone was not queued');await applyOperation(tomb);report.push(['deletion/tombstone propagation',true]);deleted=true;const gone=await request('/rest/v1/accounts?select=id&id=eq.'+aid+'&user_id=eq.'+u.userId);if(gone.length!==0)throw Error('Cloud deletion verification failed');report.push(['cloud deletion verification',true]);
      return{ok:true,report};
    }finally{
      if(!deleted){try{await request('/rest/v1/accounts?id=eq.'+aid+'&user_id=eq.'+u.userId,{method:'DELETE',headers:{Prefer:'return=minimal'}})}catch(_){} }
      for(const q of [q1,q2,qOffline])if(q)try{await CapOff.syncStore('outbox','delete',q.id)}catch(_){}
      try{await putMeta({last_test_at:now(),pending:0,conflicts:0})}catch(_){}
    }
  }
  function detectConflict(local,cloud,last){return local?.updated_at>last&&cloud?.updated_at>last&&local?.updated_at!==cloud?.updated_at}
  async function status(){const all=await CapOff.syncStore('outbox','all').catch(()=>[]),conf=await CapOff.syncStore('syncconflicts','all').catch(()=>[]),m=await meta();return{mode:'off',pending:all.length,conflicts:conf.length,lastSynced:m?.last_synced||null}}
  function localRecord(op){const id=String(op.local_id),s=typeof S==='undefined'?null:S;const lists={categories:s?.cats||[],accounts:s?.accts||[],transactions:[...(s?.tx||[]),...(s?.pend||[])],transfers:s?.xfer||[],bills:s?.bills||[],goals:s?.goals||[],debts:s?.debts||[],notes:Array.isArray(s?.notes)?s.notes:[]};if(op.entity==='budgets')return s?.budgets&&Object.prototype.hasOwnProperty.call(s.budgets,id)?{name:id,amount:s.budgets[id]}:null;if(op.entity==='user_preferences')return s||null;if(op.entity==='account_statements'){for(const a of lists.accounts)for(const x of a.statementHistory||[])if(String(x.statementId||`${a.id}:${x.st||x.en||''}`)===id)return x;return null}return(lists[op.entity]||[]).find(x=>String(x.id)===id)||null}
  async function inspectPendingOutbox(){const all=await CapOff.syncStore('outbox','all').catch(()=>[]),uid=CapSupabase.status().userId;if(!uid)throw Error('No authenticated user');const pending=all.filter(x=>x.user_id===uid&&!((x.payload?.legacy_id||'').startsWith('phase6-test-')));const results=[];for(const op of pending){const local=localRecord(op),table=op.entity,filter=op.supabase_id?'id=eq.'+encodeURIComponent(op.supabase_id):'legacy_id=eq.'+encodeURIComponent(op.local_id),rows=await CapSupabase.syncRequest('/rest/v1/'+table+'?select=*&user_id=eq.'+encodeURIComponent(uid)+'&'+filter).catch(e=>{throw Error(`Table: ${table}\nOperation: SELECT\nExact Supabase error: ${e.message}`)}),cloud=rows[0]||null,payload=op.payload||null,match=!!local&&!!cloud&&payload?Object.keys(payload).filter(k=>!['updated_at','created_at'].includes(k)).every(k=>String(payload[k]??'')===String(cloud[k]??'')):false,kind=op.operation==='delete'?'delete':cloud?'update':'insert';let recommendation=match?'SAFE TO DISCARD STALE OUTBOX ENTRY':local||cloud?'MUST PRESERVE AND SYNC LATER':'REQUIRES FURTHER INVESTIGATION';if(op.operation==='delete'&&!cloud)recommendation='SAFE TO DISCARD STALE OUTBOX ENTRY';results.push({operationId:op.id,userId:op.user_id,entity:table,operation:kind,rawOperation:op.operation,localId:op.local_id,supabaseId:op.supabase_id||null,queuedAt:op.queued_at,localExists:!!local,cloudExists:!!cloud,match,recommendation})}return{count:results.length,results}}
  async function discardPendingOutbox(operationId){
    let stage='starting';const log=s=>{stage=s;console.info('[Cap sync outbox discard]',s,operationId)};
    log('fetch exact outbox entry');const entry=await CapOff.syncStore('outbox','get',operationId),u=await CapSupabase.currentUser();
    if(!entry||!u?.id)throw Error('The inspected outbox entry or authenticated user is no longer available');
    const verify=async()=>{log('re-fetch and verify');const current=await CapOff.syncStore('outbox','get',operationId),local=current&&localRecord(current),filter=current?.supabase_id?'id=eq.'+encodeURIComponent(current.supabase_id):'legacy_id=eq.'+encodeURIComponent(current?.local_id||''),cloud=current?await CapSupabase.syncRequest('/rest/v1/accounts?select=id&user_id=eq.'+encodeURIComponent(u.id)+'&'+filter):[];return{current,local,cloud}};
    let v=await verify();if(!v.current||v.current.id!==operationId||v.current.user_id!==u.id||v.current.entity!=='accounts'||v.current.operation!=='delete'||v.local||v.cloud.length)throw Error('Verification changed; the outbox entry was not removed');
    log('await confirmation');if(!confirm('Discard this confirmed stale accounts/delete outbox operation? No financial or cloud record will be changed.'))return;
    v=await verify();if(!v.current||v.current.id!==operationId||v.current.user_id!==u.id||v.current.entity!=='accounts'||v.current.operation!=='delete'||v.local||v.cloud.length)throw Error('Verification changed after confirmation; the outbox entry was not removed');
    log('delete exact IndexedDB outbox entry');await CapOff.syncStore('outbox','delete',operationId);log('re-inspect outbox');const after=await inspectPendingOutbox(),out=document.getElementById('outbox-inspect-result');if(out)out.textContent=after.count?'Pending real-data outbox operations: '+after.count:'Pending real-data outbox operations: 0';
  }
  /* ---- Outbox planner (read-only) -----------------------------------------
     Classifies queued operations without applying, deleting, or draining
     anything. Execution belongs to a later phase and is refused here. */
  function outboxKey(op){return String(op.entity)+':'+String(op.local_id)}
  function orderIndex(entity){const i=ORDER.indexOf(entity);return i<0?ORDER.length:i}
  function supabaseIdFor(op,baseline){const r=(baseline?.records||[]).find(x=>x.entity===op.entity&&String(x.localId)===String(op.local_id));return r?String(r.supabase_id):null}
  function validateOutboxEntry(op,userId){
    const e=[];
    if(!op||typeof op!=='object')return['malformed entry'];
    if(op.user_id!==userId)e.push('ownership mismatch');
    if(!ORDER.includes(op.entity))e.push('unknown entity');
    if(!['upsert','delete'].includes(op.operation))e.push('unknown operation');
    if(!op.local_id&&op.local_id!==0)e.push('missing local id');
    if(op.operation==='upsert'&&(!op.payload||typeof op.payload!=='object'))e.push('missing payload');
    return e;
  }
  function cloudReader(userId){
    return (entity,{id,localId})=>{
      const filter=id?'id=eq.'+encodeURIComponent(id):'legacy_id=eq.'+encodeURIComponent(localId);
      return CapSupabase.syncRequest('/rest/v1/'+entity+'?select=*&user_id=eq.'+encodeURIComponent(userId)+'&'+filter).then(rows=>{
        if(!Array.isArray(rows)||rows.length>1)throw Error('Cloud response is not an exact record result');
        if(rows.length&&(rows[0].user_id!==userId||(id&&String(rows[0].id)!==String(id))))throw Error('Cloud response identity mismatch');
        return rows[0]||null;
      });
    };
  }
  function payloadMatches(payload,cloud){
    const norm=v=>v&&typeof v==='object'?JSON.stringify(v):String(v??'');
    return Object.keys(payload||{}).filter(k=>!['updated_at','created_at'].includes(k)).every(k=>norm(payload[k])===norm(cloud?.[k]));
  }
  /* Read-only three-way guard. A queued payload is not permission to overwrite
     cloud changes. Only an unchanged cloud baseline permits UPDATE/DELETE.
     Final atomic compare-and-write on the server is still required. */
  async function classifyQueuedChange(op,cloud,base){
    const fingerprint=v=>contentFingerprint(canonical(v,'',op.entity));
    if(op.operation==='delete'){
      if(!cloud)return {action:'ALREADY_DELETED',classification:'BOTH_DELETED'};
      if(!base)return {action:'BLOCKED',classification:'CONFLICT',reason:'Delete has no verified baseline'};
      if(await fingerprint(cloud)!==base.contentFingerprint)return {action:'BLOCKED',classification:'CONFLICT',reason:'Cloud changed since baseline; delete requires review'};
      return {action:'DELETE',classification:'LOCAL_DELETE'};
    }
    const local=await fingerprint(op.payload);
    if(!cloud){
      if(base)return {action:'BLOCKED',classification:local===base.contentFingerprint?'CLOUD_DELETE':'CONFLICT',reason:'Baseline record is absent in cloud; do not recreate without review'};
      return {action:'INSERT',classification:'NEW_LOCAL'};
    }
    const remote=await fingerprint(cloud);
    if(local===remote)return {action:'NOOP',classification:base&&local===base.contentFingerprint?'UNCHANGED':'CONVERGED'};
    if(!base)return {action:'BLOCKED',classification:'CONFLICT',reason:'Existing cloud record has no verified baseline'};
    if(remote===base.contentFingerprint)return {action:'UPDATE',classification:'PUSH'};
    return {action:'BLOCKED',classification:local===base.contentFingerprint?'PULL':'CONFLICT',reason:local===base.contentFingerprint?'Cloud-only change; pull required before pushing':'Both sides changed; conflict review required'};
  }
  async function planOutbox(entries,{userId,readCloud,baseline}={}){
    if(!userId)throw Error('An authenticated user is required to plan the outbox');
    if(typeof readCloud!=='function')throw Error('A cloud reader is required to plan the outbox');
    const blocked=[],valid=[];
    for(const op of entries||[]){
      const errors=validateOutboxEntry(op,userId);
      if(errors.length)blocked.push({key:outboxKey(op||{}),entity:op?.entity||'?',localId:op?.local_id||'?',action:'BLOCKED',reason:errors.join(', ')});
      else valid.push(op);
    }
    const latest=new Map(),sorted=valid.slice().sort((a,b)=>String(a.queued_at||'').localeCompare(String(b.queued_at||''))||String(a.id).localeCompare(String(b.id)));
    for(const op of sorted)latest.set(outboxKey(op),op);
    const coalesced=valid.length-latest.size;
    const ordered=[...latest.values()].sort((a,b)=>(orderIndex(a.entity)-orderIndex(b.entity))||String(a.queued_at||'').localeCompare(String(b.queued_at||''))||String(a.id).localeCompare(String(b.id)));
    const plan=[];
    for(const op of ordered){
      const key=outboxKey(op);
      let supabaseId=op.supabase_id?String(op.supabase_id):null;
      if(!supabaseId&&baseline)supabaseId=supabaseIdFor(op,baseline);
      if(!supabaseId){plan.push({key,entity:op.entity,localId:op.local_id,operation:op.operation,action:'BLOCKED',reason:'no Supabase id (baseline mapping missing)'});continue}
      const result={key,entity:op.entity,localId:op.local_id,operation:op.operation,supabaseId};
      const bases=(Array.isArray(baseline?.records)?baseline.records:[]).filter(r=>r.entity===op.entity&&String(r.supabase_id)===supabaseId);
      const base=bases[0];
      if(baseline&&(baseline.version!==2||baseline.user_id!==userId||!Array.isArray(baseline.records))||bases.length>1||base&&(base.user_id!==userId||String(base.localId)!==String(op.local_id)||!/^[0-9a-f]{64}$/i.test(base.contentFingerprint||''))){
        plan.push({...result,action:'BLOCKED',reason:'Baseline ownership, identity, or fingerprint is invalid'});continue;
      }
      if(op.operation==='upsert'&&(Array.isArray(op.payload)||String(op.payload.id)!==supabaseId||op.payload.user_id!==userId)){
        plan.push({...result,action:'BLOCKED',reason:'Payload identity or ownership is invalid'});continue;
      }
      let cloud;
      try{cloud=await readCloud(op.entity,{id:supabaseId,localId:op.local_id})}
      catch(e){plan.push({...result,action:'BLOCKED',reason:'BLOCKED — RECORD ABSENCE NOT PROVEN'});continue}
      if(cloud!==null&&(!cloud||typeof cloud!=='object'||Array.isArray(cloud)||String(cloud.id)!==supabaseId||cloud.user_id!==userId)){
        plan.push({...result,action:'BLOCKED',reason:'Cloud record identity or response shape is invalid'});continue;
      }
      plan.push({...result,...await classifyQueuedChange(op,cloud,base)});
    }
    const count=a=>plan.filter(x=>x.action===a).length;
    const summary={insert:count('INSERT'),update:count('UPDATE'),delete:count('DELETE'),noop:count('NOOP')+count('ALREADY_DELETED'),blocked:count('BLOCKED')+blocked.length,conflicts:plan.filter(x=>x.classification==='CONFLICT').length};
    return {entries:(entries||[]).length,coalesced,plan,blocked,summary,safe:summary.blocked===0};
  }
  async function processOutbox(options={}){
    if(options.dryRun===false)throw Error('Outbox execution is not implemented; only dry runs are allowed');
    const u=await CapSupabase.currentUser();if(!u?.id)throw Error('Authenticate before planning the outbox');
    const baseline=await CapOff.syncStore('syncmeta','get','baseline').catch(()=>null);
    const all=await CapOff.syncStore('outbox','all').catch(e=>{throw Error('Outbox read failed: '+e.message)});
    const isTest=x=>String(x.payload?.legacy_id||'').startsWith('phase6-test-')||String(x.local_id||'').startsWith('phase6-test-');
    const mine=all.filter(x=>x.user_id===u.id),others=all.length-mine.length,test=mine.filter(isTest),entries=mine.filter(x=>!test.includes(x));
    const readCloud=cloudReader(u.id);
    const result=await planOutbox(entries,{userId:u.id,readCloud,baseline});
    return {...result,ignoredTestArtifacts:test.length,ignoredOtherUsers:others,dryRun:true,applied:0,removed:0};
  }
  function noteContent(row){
    const fields=['legacy_id','title','body','note_date'];
    if(!row||typeof row!=='object'||Array.isArray(row)||fields.some(k=>!Object.prototype.hasOwnProperty.call(row,k))||
      typeof row.legacy_id!=='string'||!row.legacy_id.trim()||fields.slice(1).some(k=>row[k]!==null&&typeof row[k]!=='string')||
      row.note_date!==null&&!/^\d{4}-\d{2}-\d{2}$/.test(row.note_date))throw Error('Invalid complete note snapshot');
    if(Object.keys(row).some(k=>!['id','user_id','created_at','updated_at',...fields].includes(k)))throw Error('Unsupported note field');
    return Object.fromEntries(fields.map(k=>[k,row[k]]));
  }
  /* Safe, content-free comparison of two local notes snapshots. Sync metadata
     (_u/_mt) is reported separately from actual note content. */
  function notesSnapshotDiff(before,current){
    const strip=(k,v)=>(k==='_u'||k==='_mt')?undefined:v;
    const text=v=>JSON.stringify(v,strip),raw=v=>JSON.stringify(v);
    const result={same:raw(before)===raw(current),shape:'invalid',contentMatches:false,metadataOnly:false,orderChanged:false,beforeCount:null,currentCount:null,added:0,removed:0,contentChanged:0,changedFields:[],metadataFields:[]};
    if(typeof before==='string'&&typeof current==='string'){
      result.shape='text';result.contentMatches=before===current;result.same=result.contentMatches;return result;
    }
    if(Array.isArray(before)&&Array.isArray(current)){
      result.shape='list';result.beforeCount=before.length;result.currentCount=current.length;
      const idOf=n=>n&&typeof n==='object'&&!Array.isArray(n)&&n.id!==undefined&&n.id!==null?String(n.id):null;
      const bi=before.map(idOf),ci=current.map(idOf);
      if(bi.some(x=>x===null)||ci.some(x=>x===null)||new Set(bi).size!==bi.length||new Set(ci).size!==ci.length){result.shape='invalid';return result;}
      result.orderChanged=bi.join('\u0000')!==ci.join('\u0000');
      const bm=new Map(before.map((n,i)=>[bi[i],n])),cm=new Map(current.map((n,i)=>[ci[i],n]));
      result.added=[...cm.keys()].filter(k=>!bm.has(k)).length;
      result.removed=[...bm.keys()].filter(k=>!cm.has(k)).length;
      const fields=new Set(),meta=new Set();
      for(const [id,b] of bm){
        const c=cm.get(id);if(!c)continue;
        if(text(b)!==text(c))result.contentChanged++;
        for(const k of new Set([...Object.keys(b),...Object.keys(c)])){
          if(JSON.stringify(b[k])===JSON.stringify(c[k]))continue;
          if(k==='_u'||k==='_mt')meta.add(k);else fields.add(k);
        }
      }
      result.changedFields=[...fields].sort();result.metadataFields=[...meta].sort();
      result.contentMatches=result.added===0&&result.removed===0&&result.contentChanged===0&&!result.orderChanged;
      result.metadataOnly=result.contentMatches&&!result.same;
      return result;
    }
    if(before&&current&&typeof before==='object'&&typeof current==='object'&&!Array.isArray(before)&&!Array.isArray(current)){
      result.shape='object';result.contentMatches=text(before)===text(current);result.same=raw(before)===raw(current);result.metadataOnly=result.contentMatches&&!result.same;
      for(const k of new Set([...Object.keys(before),...Object.keys(current)]))if(JSON.stringify(before[k])!==JSON.stringify(current[k]))(k==='_u'||k==='_mt'?result.metadataFields:result.changedFields).push(k);
      result.changedFields.sort();result.metadataFields.sort();return result;
    }
    result.shape='mixed';return result;
  }
  const notePushBusy=new Set();
  /* Adapter-only rehearsal core: deliberately NO live transport/storage
     defaults and no button. A future explicit apply phase must supply them. */
  async function rehearseNotePush(operationId,io){
    const refused=reason=>({status:'REFUSED — NOTHING WRITTEN',reason,wrote:false,finalized:false});
    if(!operationId||!io||['currentUser','readState','readLocal','readCloud','ready','cas','finalize'].some(k=>typeof io[k]!=='function'))return refused('All explicit rehearsal adapters are required');
    if(notePushBusy.has(operationId))return refused('Operation is already running');
    notePushBusy.add(operationId);
    let wrote=false,rpcCalled=false,owner,entry,base,desired,localFingerprint;
    try{
      const user=await io.currentUser();owner=user?.id;
      if(!owner)return refused('Authentication required');
      const state=await io.readState();
      if(state?.baseline?.version!==2||state.baseline.user_id!==owner||!Array.isArray(state.baseline.records)||!Array.isArray(state.entries))return refused('Verified baseline and outbox required');
      const candidates=state.entries.filter(x=>x?.id===operationId);
      if(candidates.length!==1)return refused('Exact outbox entry required');
      entry=JSON.parse(JSON.stringify(candidates[0]));
      if(entry.entity!=='notes'||entry.operation!=='upsert'||entry.user_id!==owner||!entry.supabase_id||entry.payload?.id!==entry.supabase_id||entry.payload.user_id!==owner||String(entry.payload.legacy_id)!==String(entry.local_id))return refused('Only owned, explicitly mapped note upserts are supported');
      if(state.entries.filter(x=>x?.user_id===owner&&outboxKey(x)===outboxKey(entry)).length!==1)return refused('Multiple queued versions require review');
      desired=noteContent(entry.payload);
      localFingerprint=await contentFingerprint(canonical(entry.payload,'','notes'));
      const local=await io.readLocal(entry);
      if(local?.id!==entry.supabase_id||local.user_id!==owner||local.legacy_id!==entry.payload.legacy_id||await contentFingerprint(canonical(local,'','notes'))!==localFingerprint)return refused('Queued payload no longer matches local note');
      noteContent(local);
      const bases=state.baseline.records.filter(r=>r.entity==='notes'&&(r.supabase_id===entry.supabase_id||String(r.localId)===String(entry.local_id)));
      if(bases.length>1)return refused('Ambiguous note baseline');
      base=bases[0]?JSON.parse(JSON.stringify(bases[0])):null;
      let observed;
      const plan=await planOutbox([entry],{userId:owner,baseline:state.baseline,readCloud:async()=>{observed=await io.readCloud(entry);return observed;}});
      const item=plan.plan[0];
      if(!plan.safe||!item||!['INSERT','UPDATE','NOOP'].includes(item.action))return refused('Three-way comparison requires review');
      if(observed!==null&&observed.legacy_id!==entry.payload.legacy_id)return refused('Cloud note mapping changed');
      const expected=observed===null?null:noteContent(observed);
      if(await io.ready()!==true)return refused('Notes RPC readiness not verified');
      // Recheck mutable local/auth/queue state after asynchronous preflight.
      const unchanged=async()=>{
        const u=await io.currentUser(),s=await io.readState(),l=await io.readLocal(entry);
        if(u?.id!==owner||s?.baseline?.version!==2||s.baseline.user_id!==owner||!Array.isArray(s.entries)||!Array.isArray(s.baseline.records))return false;
        const queued=s.entries.filter(x=>x?.id===entry.id),sameKey=s.entries.filter(x=>x?.user_id===owner&&outboxKey(x)===outboxKey(entry));
        const b=s.baseline.records.filter(r=>r.entity==='notes'&&(r.supabase_id===entry.supabase_id||String(r.localId)===String(entry.local_id)));
        return queued.length===1&&sameKey.length===1&&JSON.stringify(queued[0])===JSON.stringify(entry)&&
          (base?b.length===1&&JSON.stringify(b[0])===JSON.stringify(base):b.length===0)&&l?.id===entry.supabase_id&&l.user_id===owner&&l.legacy_id===entry.payload.legacy_id&&await contentFingerprint(canonical(l,'','notes'))===localFingerprint;
      };
      if(!await unchanged())return refused('Local state changed during preflight');
      if(item.action!=='NOOP'){
        rpcCalled=true;
        let response;
        try{response=await io.cas({p_id:entry.supabase_id,p_expected:expected,p_desired:desired});}
        catch(_){return {status:'WRITE OUTCOME UNKNOWN — NOTHING FINALIZED',wrote:null,finalized:false};}
        const result=Array.isArray(response)?(response.length===1?response[0]:null):response;
        if(result?.status==='CONFLICT')return {status:'CONFLICT — NOTHING FINALIZED',wrote:false,finalized:false};
        if(!['APPLIED','ALREADY_APPLIED'].includes(result?.status))return {status:'WRITE OUTCOME UNKNOWN — NOTHING FINALIZED',wrote:null,finalized:false};
        wrote=result.status==='APPLIED';
      }
      let verified;
      try{
        verified=await io.readCloud(entry);
        if(verified?.id!==entry.supabase_id||verified.user_id!==owner||JSON.stringify(noteContent(verified))!==JSON.stringify(desired)||await contentFingerprint(canonical(verified,'','notes'))!==localFingerprint)throw Error('Cloud verification mismatch');
      }catch(_){return {status:wrote?'CLOUD WRITE OCCURRED — VERIFICATION FAILED':'DATA CONVERGENCE NOT VERIFIED',wrote,finalized:false};}
      try{
        if(!await unchanged())throw Error('Local state changed before acknowledgement');
        const nextRecord={...(base||{}),entity:'notes',localId:String(entry.local_id),supabase_id:entry.supabase_id,user_id:owner,
          contentFingerprint:localFingerprint,cloud_updated_at:verified.updated_at||null,last_operation_id:entry.id};
        const receipt={userId:owner,entry,expectedRecord:base,nextRecord};
        const acknowledgement=await io.finalize(receipt);
        if(acknowledgement?.committed!==true||acknowledgement.verified!==true){const error=Error('Acknowledgement not verified');error.committed=acknowledgement?.committed===true;throw error;}
      }catch(e){return {status:e?.committed===true?'LOCAL WRITE OCCURRED — VERIFICATION FAILED':'DATA CONVERGED — BASELINE UPDATE FAILED',wrote,finalized:false};}
      return {status:wrote?'APPLIED — VERIFIED AND FINALIZED':'ALREADY_APPLIED — VERIFIED AND FINALIZED',wrote,finalized:true};
    }catch(_){return rpcCalled?{status:'WRITE OUTCOME UNKNOWN — NOTHING FINALIZED',wrote:null,finalized:false}:refused('Read-only preflight could not complete');}
    finally{notePushBusy.delete(operationId)}
  }
  let controlledNotesBusy=false;
  async function controlledNoteRoundTrip(io){
    if(!io||['withLock','preflight','confirm','checkpoint','stage','push','verify','finish'].some(k=>typeof io[k]!=='function'))return {status:'BLOCKED — EXPLICIT TEST ADAPTERS REQUIRED',complete:false};
    if(controlledNotesBusy)return {status:'BLOCKED — TEST ALREADY RUNNING',complete:false};
    controlledNotesBusy=true;
    let checkpointed=false;
    try{
      return await io.withLock(async()=>{
        const first=await io.preflight();
        if(await io.confirm()!==true)return {status:'CANCELLED — NOTHING CHANGED',complete:false};
        const current=await io.preflight();
        if(first.ticket!==current.ticket)return {status:'BLOCKED — DATA CHANGED DURING CONFIRMATION',complete:false};
        checkpointed=true;await io.checkpoint(current);
        for(const phase of ['test','restore']){
          const operationId=await io.stage(current,phase);
          const result=await io.push(operationId);
          if(!result?.finalized)return {status:result?.status||'STOPPED — OPERATION NOT VERIFIED',complete:false,recoveryRequired:true};
        }
        if(await io.verify(current)!==true)return {status:'STOPPED — RESTORATION NOT VERIFIED',complete:false,recoveryRequired:true};
        await io.finish(current);
        return {status:'PASS — NOTE RESTORED; BOTH PUSHES VERIFIED',complete:true};
      });
    }catch(error){return {status:error?.localWrite===true?'LOCAL WRITE OCCURRED — VERIFICATION FAILED':checkpointed?'STOPPED — RECOVERY CHECK REQUIRED':'BLOCKED — PREFLIGHT OR LOCK UNAVAILABLE',complete:false,recoveryRequired:checkpointed};}
    finally{controlledNotesBusy=false}
  }
  const NOTES_TEST_KEY='controlled-notes-test-v1';
  const DEMO_REFRESH_KEY='demo-local-refresh-state-v1';
  /* Narrow cloud-to-local DEMO reconstruction. Unsupported collections block;
     a complete round-trip fingerprint comparison is mandatory before use. */
  function buildDemoRefreshCandidate(source,snapshot,owner){
    const copy=x=>JSON.parse(JSON.stringify(x)),candidate=copy(source);
    const tables=['categories','accounts','goals','debts','bills','account_statements','transactions','transfers','bill_payments','budgets','notes','user_preferences','profiles'];
    for(const table of tables){
      const rows=snapshot?.[table];
      if(!Array.isArray(rows)||rows.length>200||rows.some(r=>!r||typeof r!=='object'||(table==='profiles'?r.id:r.user_id)!==owner))throw Error('Incomplete or unowned demo snapshot');
      const keys=rows.map(r=>String(table==='user_preferences'?r.user_id:r.id));
      if(new Set(keys).size!==keys.length)throw Error('Ambiguous cloud identity');
    }
    if(snapshot.profiles.length!==1||snapshot.user_preferences.length!==1||snapshot.transfers.length||snapshot.account_statements.length||snapshot.bill_payments.length)throw Error('Unsupported demo snapshot');
    const localId=r=>{if(typeof r.legacy_id!=='string'||!r.legacy_id.trim())throw Error('Legacy identity missing');const n=Number(r.legacy_id);return Number.isSafeInteger(n)&&String(n)===r.legacy_id?n:r.legacy_id;};
    const numeric=v=>{if(v===null||v===''||!Number.isFinite(Number(v)))throw Error('Invalid numeric field');return Number(v);};
    const refs=Object.fromEntries(['accounts','bills','transactions'].map(t=>[t,new Map(snapshot[t].map(r=>[r.id,localId(r)]))]));
    const ref=(table,id)=>{if(id===null||id===undefined)return null;if(!refs[table].has(id))throw Error('Reference is not owned or available');return refs[table].get(id);};
    const categories=new Map(snapshot.categories.map(c=>[c.id,c.name]));
    const category=id=>{if(!categories.has(id))throw Error('Category reference unavailable');return categories.get(id);};
    const previous=new Map((source.accts||[]).map(a=>[String(a.id),a]));
    candidate.accts=snapshot.accounts.map(r=>({...(copy(previous.get(String(localId(r)))||{})),
      id:localId(r),name:r.name,type:r.account_type,bank:r.bank||'',nickname:r.nickname||'',net:r.network||'',l4:r.last_four||'',
      bal:numeric(r.balance),lim:r.credit_limit===null?null:numeric(r.credit_limit),cardStatus:r.status,img:r.card_art||'',photo:r.photo_url||'',
      stmt:r.statement_day,due:r.due_day,dueN:r.due_days,minimumPayment:copy(r.minimum_payment||{}),
      fees:copy(r.fee_settings||{}),statementHistory:copy(r.statement_settings?.statementHistory||[]),
      ...Object.fromEntries(['interestEnabled','interestRate','interestCalc','interestCreditFreq','interestOtherDays','interestSimulation','goalInterestMode','interestGoalId'].map(k=>[k,undefined])),
      ...copy(r.interest_settings||{})}));
    candidate.cats=snapshot.categories.map(r=>({...(r.legacy_id===r.name?{}:{id:localId(r)}),n:r.name,i:r.emoji||'',l:r.logo_url||'',a:r.archived?1:0}));
    candidate.bills=snapshot.bills.map(r=>({...(copy(r.metadata||{})),id:localId(r),name:r.name,amt:numeric(r.amount),acct:ref('accounts',r.payment_account_id),
      kind:r.kind,freq:r.frequency,start:r.start_date,due:r.due_day,logo:r.logo_url,subscriptionStatus:r.status,cancelledOn:r.cancelled_on,
      trialStartDate:r.trial_start,trialEndDate:r.trial_end,al:copy(r.alert_settings||[])}));
    candidate.goals=snapshot.goals.map(r=>({id:localId(r),name:r.name,icon:r.icon,target:numeric(r.target_amount),saved:numeric(r.saved_amount),accountId:ref('accounts',r.account_id),targetDate:r.target_date,done:r.completed?1:0}));
    candidate.debts=snapshot.debts.map(r=>({id:localId(r),who:r.person,note:r.note||'',amt:numeric(r.amount),dir:r.direction,due:r.due_date||''}));
    candidate.budgets=Object.fromEntries(snapshot.budgets.map(r=>[category(r.category_id),numeric(r.amount)]));
    candidate.tx=[];candidate.pend=[];candidate.xfer=[];
    for(const row of snapshot.transactions){
      if(!['posted','pending'].includes(row.status)||row.statement_id)throw Error('Unsupported transaction lifecycle');
      const accountId=ref('accounts',row.account_id);
      if(!row.metadata||typeof row.metadata!=='object'||Array.isArray(row.metadata)||String(row.metadata.id)!==String(row.legacy_id)||String(row.metadata.acct)!==String(accountId))throw Error('Transaction metadata identity unavailable');
      const t={...copy(row.metadata),id:localId(row),d:row.transaction_date,amt:numeric(row.amount),acct:accountId,cat:row.category_id===null?'':category(row.category_id),note:row.title||'',desc:row.description||'',pd:row.posting_date||''};
      delete t.billId;delete t.parentId;delete t.statementId;
      if(row.bill_id)t.billId=ref('bills',row.bill_id);if(row.parent_transaction_id)t.parentId=ref('transactions',row.parent_transaction_id);
      (row.status==='pending'?candidate.pend:candidate.tx).push(t);
    }
    candidate.notes=snapshot.notes.map(r=>({id:localId(r),t:r.title||'',b:r.body||'',d:r.note_date||''}));
    const prefs=snapshot.user_preferences[0],profile=snapshot.profiles[0];
    Object.assign(candidate,{name:profile.display_name||'',photo:profile.photo_url||'',cur:prefs.currency,nf:prefs.number_format,neg:prefs.negative_style,dec:prefs.show_decimals,
      theme:prefs.theme,anim:prefs.animations_enabled?1:0,rm:prefs.reduce_motion?1:0,snd:prefs.sound_enabled?1:0,hap:prefs.haptics_enabled?1:0,hide:prefs.hide_balances?1:0,
      logoChoice:prefs.logo_choice,accountView:prefs.account_view,accountSort:prefs.account_sort,accountOrder:copy(prefs.account_order||[])});
    return candidate;
  }
  async function readOwnedDemoSnapshot(owner){
    const snapshot={};
    for(const table of [...ORDER.filter(t=>t!=='user_preferences'),'user_preferences','profiles']){
      const singleton=table==='user_preferences'||table==='profiles',filter=table==='profiles'?'id':'user_id';
      const rows=[],seen=new Set();
      for(;;){
        const page=await CapSupabase.syncRequest('/rest/v1/'+table+'?select=*&'+filter+'=eq.'+encodeURIComponent(owner)+(singleton?'&limit=2':'&order=id.asc&limit=201&offset='+rows.length));
        if(!Array.isArray(page)||page.some(r=>!r||(table==='profiles'?r.id:r.user_id)!==owner))throw Error('Snapshot read incomplete');
        for(const row of page){const key=String(table==='profiles'?row.id:(row.id??row.user_id));if(seen.has(key))throw Error('Snapshot pagination repeated a record');seen.add(key)}
        rows.push(...page);if(rows.length>200)throw Error('Demo snapshot exceeds supported scope');
        // Continue to an explicit empty page: a server-side row cap may be
        // lower than the requested limit. A short page is not proof of EOF.
        if(singleton||page.length===0)break;
      }
      snapshot[table]=rows;
    }
    return snapshot;
  }
  function previewDemoCandidate(candidate){
    const previous=S;
    try{
      S=candidate;
      const prep=migrationPrepare();if(prep.blockingProblems.length)throw Error('Reconstructed local mapping blocked');
      if(S.accts.some(a=>{const e=balanceEffects(a.id);return !e||Math.abs(e.impliedAnchor)>.005||e.unknownKinds.length;}))throw Error('Cloud ledger does not explain balances');
      return buildSupabaseMigrationPlan(prep);
    }finally{S=previous;}
  }
  let localDemoRefreshBusy=false;
  async function refreshLocalDemo(io){
    if(!io||['withLock','preview','confirm','apply'].some(k=>typeof io[k]!=='function'))return {status:'BLOCKED — EXPLICIT REFRESH ADAPTERS REQUIRED',complete:false};
    if(localDemoRefreshBusy)return {status:'BLOCKED — REFRESH ALREADY RUNNING',complete:false};
    localDemoRefreshBusy=true;
    try{return await io.withLock(async()=>{
      const first=await io.preview();if(first.matches!==true)return {status:'BLOCKED — CANDIDATE DOES NOT MATCH CLOUD; NOTHING REPLACED',complete:false};
      if(await io.confirm()!==true)return {status:'CANCELLED — NOTHING CHANGED',complete:false};
      const second=await io.preview();
      if(second.matches!==true||first.ticket!==second.ticket)return {status:'BLOCKED — EVIDENCE CHANGED; NOTHING REPLACED',complete:false};
      const result=await io.apply(second);
      if(result?.committed!==true||result.verified!==true){const error=Error('Refresh not verified');error.committed=result?.committed===true;throw error;}
      return {status:'PASS — LOCAL DEMO REFRESHED; BASELINE VERIFIED; CLOUD UNCHANGED',complete:true,records:result.records};
    });}catch(error){return {status:error?.committed===true?'LOCAL WRITE OCCURRED — VERIFICATION FAILED':error?.backedUp===true?'STOPPED — BACKUP RETAINED; LOCAL STATE AND BASELINE NOT REPLACED':'BLOCKED — DEMO REFRESH COULD NOT BE VERIFIED',complete:false};}
    finally{localDemoRefreshBusy=false}
  }
  window.runCapLocalDemoRefresh=async()=>{
    const out=document.getElementById('controlled-notes-result');if(!out||!window.CAP_DEV_TOOLS)return;
    const report=text=>{out.style.whiteSpace='pre-line';out.textContent=text;};
    report('Read-only local demo refresh preview. No cloud writes will be made.');
    const result=await refreshLocalDemo({
      withLock:run=>{if(!navigator.locks?.request)throw Error('Cross-tab lock required');return navigator.locks.request('cap-controlled-notes-test',{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw Error('Another operation is active');return run();});},
      preview:async()=>{
        if(typeof claude!=='undefined'||!localStateIsCurrent()||(await status()).mode!=='off')throw Error('Local-only guard blocked');
        const user=await CapSupabase.currentUser(),owner=user?.id;if(!owner)throw Error('Authentication required');
        const baseline=await CapOff.syncStore('syncmeta','get','baseline'),queue=await CapOff.syncStore('outbox','all');
        if(baseline?.version!==2||baseline.user_id!==owner||!Array.isArray(baseline.records)||!Array.isArray(queue)||queue.length||await CapOff.syncStore('syncmeta','get',NOTES_TEST_KEY)||await CapOff.syncStore('syncmeta','get',DEMO_REFRESH_KEY))throw Error('Baseline, queue, or recovery guard blocked');
        const expectedLocalJson=JSON.stringify(S),snapshot=await readOwnedDemoSnapshot(owner),candidate=buildDemoRefreshCandidate(S,snapshot,owner),plan=previewDemoCandidate(candidate);
        const records=await recordFingerprints(plan,{snapshot}),expected=plan.tables.reduce((n,x)=>n+x[1].length,0)+2,cloudCount=Object.values(snapshot).reduce((n,rows)=>n+rows.length,0);
        const mismatches=records.filter(r=>r.contentFingerprint!==r.cloudContentFingerprint).length;
        const diagnostics=fingerprintDiagnostics(records,{records});
        const matches=records.length===expected&&expected===cloudCount&&mismatches===0&&diagnostics.ok;
        report('READ-ONLY DEMO REFRESH PREVIEW · candidate '+expected+' records · cloud '+cloudCount+' · fingerprint differences '+mismatches+' · mapping checks '+(diagnostics.ok?'passed':'BLOCKED')+' · ledger accounts for all balances. No values or identifiers displayed.');
        const cloudSignature=await contentFingerprint({snapshot:JSON.stringify(snapshot)}),ticket=await contentFingerprint({owner,expectedLocalJson,baseline:JSON.stringify(baseline),cloudSignature,candidate:JSON.stringify(candidate)});
        const nextBaseline={key:'baseline',version:2,user_id:owner,created_at:now(),fingerprint:cloudSignature,records:records.map(({cloudContentFingerprint,...r})=>r)};
        return {matches,ticket,userId:owner,expectedLocalJson,expectedBaseline:baseline,nextState:candidate,nextBaseline,cloudSignature};
      },
      confirm:()=>window.confirm('Refresh ONLY this browser’s DEMO data?\n\nA verified on-device backup of this browser’s current state, baseline, and balance anchors will be kept first. The demo collections and app preferences will then be reconstructed from your authenticated cloud snapshot, and the local baseline replaced ONLY after exact round-trip verification. Old local-only demo records will leave the active dataset but remain in the backup. Old balance anchors will be cleared.\n\nNo Supabase record or authentication session is changed. Cloud Sync stays OFF. Keep other app tabs closed/idle. Continue?'),
      apply:receipt=>CapOff.refreshVerifiedLocalDemo({...receipt,backupKey:'demo-local-refresh-backup:'+crypto.randomUUID()},
        ()=>CapSupabase.status().userId===receipt.userId&&typeof claude==='undefined',
        async()=>{const u=await CapSupabase.currentUser();if(u?.id!==receipt.userId)return false;const current=await readOwnedDemoSnapshot(receipt.userId);return await contentFingerprint({snapshot:JSON.stringify(current)})===receipt.cloudSignature;}),
    });
    out.textContent+='\n'+result.status+(result.complete?' · '+result.records+' verified records. Backup retained. Reload, then run the read-only blocker diagnostic.':' · Do not reset data or retry if a recovery checkpoint was created; send this status first.')+' · Cloud Sync remains OFF.';
  };
  async function notesTestBlockerSnapshot(){
    const u=await CapSupabase.currentUser();if(!u?.id)throw Error('Authentication required');
    const baseline=await CapOff.syncStore('syncmeta','get','baseline'),entries=await CapOff.syncStore('outbox','all'),checkpoint=await CapOff.syncStore('syncmeta','get',NOTES_TEST_KEY),refreshCheckpoint=await CapOff.syncStore('syncmeta','get',DEMO_REFRESH_KEY);
    if(!Array.isArray(entries))throw Error('Outbox read failed');
    const records=Array.isArray(baseline?.records)?baseline.records:[];
    const report={baselinePresent:!!baseline,baselineVersion:baseline?.version===2?2:'not verified',baselineRecords:records.length,baselineOwned:baseline?.user_id===u.id,outboxEntries:entries.length,recoveryCheckpoint:!!checkpoint,demoRefreshCheckpoint:!!refreshCheckpoint,queue:[],validation:null};
    for(const [index,op] of entries.entries()){
      const own=op?.user_id===u.id,entity=ORDER.includes(op?.entity)?op.entity:'unknown',operation=['upsert','delete'].includes(op?.operation)?op.operation:'unknown';
      const testHint=String(op?.payload?.legacy_id||'').startsWith('phase6-test-')||String(op?.local_id||'').startsWith('phase6-test-');
      // Recognize only the exact older account harness, not arbitrary records
      // with a test-like prefix. This is evidence for review, NOT deletion.
      const knownHarness=own&&entity==='accounts'&&operation==='upsert'&&op.supabase_id===op.local_id&&op.payload?.id===op.supabase_id&&op.payload.user_id===u.id&&op.payload.name==='CAP SYNC ENGINE TEST'&&op.payload.legacy_id==='phase6-test-'+op.local_id;
      const item={number:index+1,entity,operation,owned:own,testHint,knownHarness,localPresent:null,cloudPresence:'not checked',baselineReferences:null};
      if(knownHarness){
        item.localPresent=!!localRecord(op);
        item.baselineReferences=records.filter(r=>r.entity===entity&&(String(r.supabase_id)===String(op.supabase_id)||String(r.localId??r.legacy_id)===String(op.local_id))).length;
        try{item.cloudPresence=await cloudReader(u.id)(entity,{id:op.supabase_id})?'present':'verified absent';}
        catch(_){item.cloudPresence='BLOCKED — RECORD ABSENCE NOT PROVEN';}
      }
      item.cleanupReviewEligible=report.baselineOwned&&baseline?.version===2&&Array.isArray(baseline.records)&&!checkpoint&&!refreshCheckpoint&&knownHarness&&item.localPresent===false&&item.cloudPresence==='verified absent'&&item.baselineReferences===0;
      report.queue.push(item);
    }
    try{
      const prep=migrationPrepare();
      if(prep.blockingProblems.length){report.validation={blocked:true,localProblems:prep.blockingProblems.length};}
      else{
        const plan=buildSupabaseMigrationPlan(prep),v=await CapSupabase.validateRealData(plan),current=await recordFingerprints(plan,v);
        const base=new Map(records.map(r=>[r.entity+':'+r.supabase_id,r]));
        report.validation={missing:v.missingCount,unexpected:v.unexpectedCount,mismatches:v.mismatchCount,foreignKeys:v.foreignKeyErrorCount,currentRecords:current.length,withoutBaseline:current.filter(r=>!base.has(r.entity+':'+r.supabase_id)).length,baselineWithoutCurrent:records.filter(r=>!current.some(c=>c.entity===r.entity&&c.supabase_id===r.supabase_id)).length,baselineContentDifferences:current.filter(r=>base.has(r.entity+':'+r.supabase_id)&&base.get(r.entity+':'+r.supabase_id).contentFingerprint!==r.contentFingerprint).length};
      }
    }catch(_){report.validation={blocked:true,reason:'Read-only local/cloud comparison could not complete'};}
    return {report,owner:u.id,baseline,entries};
  }
  async function inspectNotesTestBlocker(){return (await notesTestBlockerSnapshot()).report;}
  let staleTestCleanupBusy=false;
  async function cleanupStaleTestOutbox(io){
    if(!io||['withLock','inspect','confirm','commit'].some(k=>typeof io[k]!=='function'))return {status:'BLOCKED — EXPLICIT CLEANUP ADAPTERS REQUIRED',removed:0};
    if(staleTestCleanupBusy)return {status:'BLOCKED — CLEANUP ALREADY RUNNING',removed:0};
    staleTestCleanupBusy=true;
    try{
      return await io.withLock(async()=>{
        const first=await io.inspect();
        if(first.entries?.length!==3)return {status:'BLOCKED — EXACTLY THREE VERIFIED STALE ENTRIES REQUIRED',removed:0};
        if(await io.confirm()!==true)return {status:'CANCELLED — NOTHING CHANGED',removed:0};
        const second=await io.inspect();
        if(second.entries?.length!==3||first.ticket!==second.ticket)return {status:'BLOCKED — CLEANUP EVIDENCE CHANGED; NOTHING REMOVED',removed:0};
        const result=await io.commit(second);
        if(result?.committed!==true||result.verified!==true||result.removed!==3){const error=Error('Cleanup not verified');error.committed=result?.committed===true;throw error;}
        return {status:'REMOVED 3 VERIFIED STALE TEST OUTBOX ENTRIES — BASELINE UNCHANGED',removed:3};
      });
    }catch(error){return {status:error?.committed===true?'LOCAL WRITE OCCURRED — VERIFICATION FAILED':'BLOCKED — CLEANUP VERIFICATION FAILED; NOTHING REMOVED',removed:error?.committed===true?null:0};}
    finally{staleTestCleanupBusy=false}
  }
  window.cleanupCapStaleTestOutbox=async()=>{
    const out=document.getElementById('controlled-notes-result');if(!out||!window.CAP_DEV_TOOLS)return;
    out.textContent='Rechecking exact stale test entries read-only…';
    const result=await cleanupStaleTestOutbox({
      withLock:run=>{
        if(!navigator.locks?.request)throw Error('Cross-tab lock unavailable');
        return navigator.locks.request('cap-controlled-notes-test',{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw Error('Another test is active');return run();});
      },
      inspect:async()=>{
        const snapshot=await notesTestBlockerSnapshot(),r=snapshot.report;
        const entries=snapshot.entries.filter((op,i)=>r.queue[i]?.cleanupReviewEligible).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
        out.textContent='READ-ONLY CLEANUP PREFLIGHT · baseline '+r.baselineRecords+' · outbox '+r.outboxEntries+' · verified eligible '+entries.length+' · recovery '+(r.recoveryCheckpoint?'present':'absent')+'. App-data mismatches are not resolved by this cleanup.';
        if(entries.length!==3||!r.baselineOwned||r.recoveryCheckpoint||r.demoRefreshCheckpoint||typeof claude!=='undefined'||(await status()).mode!=='off')throw Error('Cleanup scope not proven');
        const u=await CapSupabase.currentUser();if(u?.id!==snapshot.owner)throw Error('Ownership changed');
        const localAccounts=JSON.stringify(S.accts||[]);
        const ticket=await contentFingerprint({owner:snapshot.owner,baseline:JSON.stringify(snapshot.baseline),entries:JSON.stringify(entries),localAccounts});
        return {userId:snapshot.owner,entries,expectedBaseline:snapshot.baseline,localAccounts,ticket};
      },
      confirm:()=>window.confirm('Remove ONLY the 3 verified stale test-harness outbox entries?\n\nEach exact account-test entry has no local record, no visible owned cloud counterpart, and no baseline reference. This deletes local queue metadata only. No app or Supabase record will be changed; the baseline will not be reset or updated.\n\nThe separate local/cloud data mismatches will remain. Cloud Sync stays OFF.'),
      commit:receipt=>CapOff.discardVerifiedTestOutbox(receipt,()=>CapSupabase.status().userId===receipt.userId&&JSON.stringify(S.accts||[])===receipt.localAccounts&&receipt.entries.every(op=>!localRecord(op))),
    });
    out.textContent+='\n'+result.status+'\nCloud Sync remains OFF. Do not rerun the write test yet; the separate app-data differences still require reconciliation.';
  };
  window.inspectCapNotesTestBlocker=async()=>{
    const out=document.getElementById('controlled-notes-result');if(!out||!window.CAP_DEV_TOOLS)return;
    out.style.whiteSpace='pre-line';out.textContent='Inspecting test blocker read-only…';
    try{
      const r=await inspectNotesTestBlocker();
      const lines=['READ-ONLY NOTES-TEST DIAGNOSTIC','Baseline: '+r.baselineRecords+' records · version '+r.baselineVersion+' · ownership '+(r.baselineOwned?'verified':'BLOCKED'),'Outbox: '+r.outboxEntries+' · recovery checkpoint: '+(r.recoveryCheckpoint?'present':'absent')+' · demo-refresh checkpoint: '+(r.demoRefreshCheckpoint?'present':'absent')];
      for(const q of r.queue)lines.push('Entry '+q.number+' · '+q.entity+' / '+q.operation+' · ownership '+(q.owned?'verified':'BLOCKED')+' · test hint '+q.testHint+' · known harness '+q.knownHarness+' · local '+(q.localPresent===null?'not checked':q.localPresent?'present':'absent')+' · cloud '+q.cloudPresence+' · baseline references '+(q.baselineReferences??'not checked')+' · cleanup review eligible '+q.cleanupReviewEligible);
      const v=r.validation;
      lines.push(v?.blocked?'Validation BLOCKED — comparison incomplete.':'Comparison: current '+v.currentRecords+' · missing '+v.missing+' · unexpected '+v.unexpected+' · mismatches '+v.mismatches+' · foreign keys '+v.foreignKeys+' · without baseline '+v.withoutBaseline+' · baseline-only '+v.baselineWithoutCurrent+' · baseline content differences '+v.baselineContentDifferences);
      lines.push('Nothing was deleted, applied, reset, or baselined. Cleanup eligibility is not authorization. Cloud Sync remains OFF.');out.textContent=lines.join('\n');
      if(r.queue.filter(q=>q.cleanupReviewEligible).length===3){
        const button=document.createElement('button');button.type='button';button.className='btn s';button.textContent='Remove 3 verified stale test entries (confirm)';
        button.onclick=async()=>{button.disabled=true;try{await window.cleanupCapStaleTestOutbox();}finally{button.disabled=false}};out.appendChild(button);
      }
    }catch(_){out.textContent='BLOCKED — diagnostic could not complete. No data, baseline, or outbox entries were changed.';}
  };
  function currentNotePlan(){
    const prep=migrationPrepare();if(prep.blockingProblems.length)throw Error('Local mapping blocked');
    return buildSupabaseMigrationPlan(prep);
  }
  function noteFromPlan(localId){
    const rows=currentNotePlan().tables.find(x=>x[0]==='notes')?.[1]||[];
    const matches=rows.filter(r=>String(r.legacy_id)===String(localId));
    if(matches.length!==1)throw Error('Note mapping changed');return matches[0];
  }
  function notesFinancialSnapshot(){
    return JSON.stringify(Object.fromEntries(['accts','tx','pend','xfer','bills','goals','debts','budgets'].map(k=>[k,S[k]])));
  }
  function localStateIsCurrent(){
    try{return localStorage.getItem('pera')===JSON.stringify(S);}catch(_){return false;}
  }
  function controlledNotesAdapters(){
    let active=null;
    const report=message=>{const out=document.getElementById('controlled-notes-result');if(out)out.textContent=message;};
    const localGuard=entry=>{
      try{const row=noteFromPlan(entry.local_id);return localStateIsCurrent()&&CapSupabase.status().userId===entry.user_id&&row.id===entry.supabase_id&&row.user_id===entry.user_id&&JSON.stringify(noteContent(row))===JSON.stringify(noteContent(entry.payload));}catch(_){return false;}
    };
    const io={
      withLock:run=>{
        if(!navigator.locks?.request)throw Error('Cross-tab lock unavailable');
        return navigator.locks.request('cap-controlled-notes-test',{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw Error('Test active in another tab');return run();});
      },
      preflight:async()=>{
        report('READ-ONLY PREFLIGHT · Cloud Sync must remain OFF · no changes made yet.');
        if(!window.CAP_DEV_TOOLS||typeof claude!=='undefined'||(await status()).mode!=='off')throw Error('Developer/local-only preconditions failed');
        if(!localStateIsCurrent()){report('BLOCKED · Persisted local state differs from this tab. Reload and inspect other tabs before testing.');throw Error('Persisted local state changed');}
        if(await CapOff.syncStore('syncmeta','get',NOTES_TEST_KEY)){report('BLOCKED · An unresolved notes-test recovery checkpoint exists. Do not clear it or the outbox.');throw Error('Unresolved controlled test checkpoint');}
        if(await CapOff.syncStore('syncmeta','get',DEMO_REFRESH_KEY)){report('BLOCKED · An unresolved demo-refresh checkpoint exists. Inspect recovery before testing.');throw Error('Unresolved demo refresh');}
        const u=await CapSupabase.currentUser();if(!u?.id)throw Error('Authentication required');
        const baseline=await CapOff.syncStore('syncmeta','get','baseline'),entries=await CapOff.syncStore('outbox','all');
        report('READ-ONLY PREFLIGHT · Baseline records: '+(Array.isArray(baseline?.records)?baseline.records.length:'unavailable')+' · outbox: '+(Array.isArray(entries)?entries.length:'unavailable')+' · Cloud Sync OFF.');
        if(baseline?.version!==2||baseline.user_id!==u.id||!Array.isArray(baseline.records)||!Array.isArray(entries)||entries.length)throw Error('Clean owned baseline and empty outbox required');
        if(!await CapSupabase.refreshNotesRpcReadiness()){report('BLOCKED · Notes RPC metadata not verified. No write RPC was called.');throw Error('Notes RPC metadata not ready');}
        const plan=currentNotePlan(),validation=await CapSupabase.validateRealData(plan);
        report('READ-ONLY VALIDATION · Missing: '+validation.missingCount+' · unexpected: '+validation.unexpectedCount+' · mismatches: '+validation.mismatchCount+' · foreign-key errors: '+validation.foreignKeyErrorCount+' · no changes made.');
        if(!validation.dataOk)throw Error('Local/cloud validation blocked');
        const records=await recordFingerprints(plan,validation);
        const base=new Map(baseline.records.map(r=>[r.entity+':'+r.supabase_id,r]));
        if(records.length!==base.size||base.size!==baseline.records.length||records.some(r=>r.contentFingerprint!==r.cloudContentFingerprint||r.contentFingerprint!==base.get(r.entity+':'+r.supabase_id)?.contentFingerprint||base.get(r.entity+':'+r.supabase_id)?.user_id!==u.id||String(r.localId)!==String(base.get(r.entity+':'+r.supabase_id)?.localId)))throw Error('Baseline content or mapping differs');
        const rows=plan.tables.find(x=>x[0]==='notes')?.[1]||[];
        if(!rows.length)throw Error('Existing demo note required');
        const original=JSON.parse(JSON.stringify(rows[0]));noteContent(original);
        if(typeof original.body!=='string')throw Error('Text note required');
        const cloud=(validation.snapshot?.notes||[]).filter(n=>n.id===original.id);
        if(cloud.length!==1||cloud[0].user_id!==u.id||JSON.stringify(noteContent(cloud[0]))!==JSON.stringify(noteContent(original)))throw Error('Cloud note mapping differs');
        if(typeof S.notes!=='string'&&(!Array.isArray(S.notes)||S.notes.filter(n=>String(n.id)===String(original.legacy_id)&&typeof n.b==='string').length!==1))throw Error('Stable local text representation required');
        const originalLocal=JSON.stringify(S.notes),financial=notesFinancialSnapshot();
        const ticket=await contentFingerprint({owner:u.id,baseline:JSON.stringify(baseline),records:JSON.stringify(records),originalLocal,financial});
        report('PREFLIGHT PASSED · Local = baseline = cloud · outbox empty · notes RPC metadata verified. Awaiting explicit confirmation.');
        return {owner:u.id,original,originalLocal,financial,baseline,ticket};
      },
      confirm:()=>window.confirm('Controlled DEMO notes test — REAL CLOUD WRITES\n\nOnly proceed with demo/test data. This temporarily appends a test marker to one existing note, pushes and verifies it, then restores the original note through a second verified push. Local note state, two outbox operations, and their baseline acknowledgements will change. A recovery checkpoint is kept if interrupted.\n\nAccount balances and financial records will not be changed. Cloud Sync remains OFF. Keep other app tabs idle until finished.\n\nRun this test?'),
      checkpoint:async context=>{
        const checkpoint={id:crypto.randomUUID(),owner:context.owner,original:context.original,originalLocal:context.originalLocal,financial:context.financial,created_at:now(),phase:'prepared'};
        await CapOff.syncStore('syncmeta','put',checkpoint,NOTES_TEST_KEY);
        const read=await CapOff.syncStore('syncmeta','get',NOTES_TEST_KEY);
        if(JSON.stringify(read)!==JSON.stringify(checkpoint)){const error=Error('Checkpoint not verified');error.localWrite=true;throw error;}
        active=checkpoint;
      },
      stage:async(context,phase)=>{
        report(phase==='test'?'CONFIRMED · Preparing temporary note update.':'TEMPORARY PUSH VERIFIED · Preparing original-content restoration.');
        const u=await CapSupabase.currentUser(),stored=await CapOff.syncStore('syncmeta','get',NOTES_TEST_KEY);
        if(!active||u?.id!==active.owner||stored?.id!==active.id||(await CapOff.syncStore('outbox','all')).length||notesFinancialSnapshot()!==context.financial)throw Error('Test context changed');
        const before=noteFromPlan(context.original.legacy_id);
        const testPayload={...context.original,body:context.original.body+'\n[Cap atomic notes test]'};
        const expected=phase==='test'?context.original:testPayload,target=phase==='test'?testPayload:context.original;
        if(JSON.stringify(noteContent(before))!==JSON.stringify(noteContent(expected))||before.id!==context.original.id||before.user_id!==context.owner)throw Error('Note changed before staging');
        const entry={id:crypto.randomUUID(),entity:'notes',local_id:String(target.legacy_id),supabase_id:target.id,operation:'upsert',payload:target,user_id:context.owner,queued_at:now(),local_updated_at:now(),retry_count:0,last_error:null};
        active={...stored,phase,operationId:entry.id};
        await CapOff.syncStore('syncmeta','put',active,NOTES_TEST_KEY);
        await CapOff.syncStore('outbox','put',entry);
        if(JSON.stringify(await CapOff.syncStore('outbox','get',entry.id))!==JSON.stringify(entry)){const error=Error('Outbox staging not verified');error.localWrite=true;throw error;}
        // No await between the final local check, body-only edit, and save.
        if(!localGuard({...entry,payload:expected})||notesFinancialSnapshot()!==context.financial)throw Error('Local note changed before save');
        if(typeof S.notes==='string')S.notes=target.body;
        else {const notes=S.notes.filter(n=>String(n.id)===String(entry.local_id));if(notes.length!==1)throw Error('Local note ambiguous');notes[0].b=target.body;}
        try{save();if(!localGuard(entry)||notesFinancialSnapshot()!==context.financial)throw Error('Local note save not verified');}
        catch(_){const error=Error('Local note save not verified');error.localWrite=true;throw error;}
        return entry.id;
      },
      push:operationId=>rehearseNotePush(operationId,{
        currentUser:()=>CapSupabase.currentUser(),
        readState:async()=>({baseline:await CapOff.syncStore('syncmeta','get','baseline'),entries:await CapOff.syncStore('outbox','all')}),
        readLocal:entry=>noteFromPlan(entry.local_id),
        readCloud:entry=>cloudReader(entry.user_id)('notes',{id:entry.supabase_id,localId:entry.local_id}),
        ready:()=>CapSupabase.refreshNotesRpcReadiness(),
        cas:async args=>{
          const u=await CapSupabase.currentUser(),checkpoint=await CapOff.syncStore('syncmeta','get',NOTES_TEST_KEY);
          if(!active||!localStateIsCurrent()||u?.id!==active.owner||checkpoint?.id!==active.id||checkpoint.operationId!==active.operationId||args.p_id!==active.original.id||args.p_expected===null||!CapSupabase.notesRpcReady())throw Error('Controlled write authorization changed');
          return CapSupabase.syncRequest('/rest/v1/rpc/cap_sync_note_put',{method:'POST',body:JSON.stringify(args)});
        },
        finalize:receipt=>CapOff.finalizeVerifiedNotePush(receipt,()=>localGuard(receipt.entry)&&notesFinancialSnapshot()===active?.financial),
      }),
      verify:async context=>{
        const u=await CapSupabase.currentUser(),baseline=await CapOff.syncStore('syncmeta','get','baseline'),entries=await CapOff.syncStore('outbox','all');
        const local=noteFromPlan(context.original.legacy_id),remote=await cloudReader(context.owner)('notes',{id:context.original.id});
        const records=baseline?.records||[],target=records.filter(r=>r.entity==='notes'&&r.supabase_id===context.original.id);
        const originalFingerprint=await contentFingerprint(canonical(context.original,'','notes'));
        const unchanged=JSON.stringify(records.filter(r=>!(r.entity==='notes'&&r.supabase_id===context.original.id)))===JSON.stringify(context.baseline.records.filter(r=>!(r.entity==='notes'&&r.supabase_id===context.original.id)));
        // save() stamps changed local records with _u; that sync metadata is not
        // note content and must not make a verified restoration look failed.
        let notesRestored=false;try{notesRestored=notesSnapshotDiff(JSON.parse(context.originalLocal),S.notes).contentMatches;}catch(_){}
        return localStateIsCurrent()&&u?.id===context.owner&&baseline?.user_id===context.owner&&entries.length===0&&target.length===1&&target[0].contentFingerprint===originalFingerprint&&
          JSON.stringify(noteContent(local))===JSON.stringify(noteContent(context.original))&&JSON.stringify(noteContent(remote))===JSON.stringify(noteContent(context.original))&&
          notesRestored&&notesFinancialSnapshot()===context.financial&&unchanged&&(await status()).mode==='off';
      },
      finish:async()=>{
        const current=await CapOff.syncStore('syncmeta','get',NOTES_TEST_KEY);
        if(current?.id!==active?.id)throw Error('Recovery checkpoint changed');
        await CapOff.syncStore('syncmeta','delete',NOTES_TEST_KEY);
        if(await CapOff.syncStore('syncmeta','get',NOTES_TEST_KEY))throw Error('Checkpoint cleanup not verified');
        active=null;
      },
    };
    return io;
  }
  /* Read-only recovery classification for an interrupted controlled notes
     test. Pure and static: never displays note content, financial values, or
     identifiers, and never authorizes a write. */
  function notesRecoveryReport(x){
    const c=x||{},checks={
      checkpoint:c.checkpointPresent===true,
      checkpointOwned:c.checkpointOwned===true,
      baselineOwned:c.baselineOwned===true,
      outboxRead:c.outboxCount>=0,
      outboxEmpty:c.outboxCount===0,
      cloudRead:c.cloudRead||'not read',
      cloudOriginal:c.cloudOriginal===true,
      cloudTemporary:c.cloudTemporary===true,
      originalValid:c.originalValid===true,
      localOriginal:c.localOriginal===true,
      localNotesJson:c.localNotesJson===true,
      localNotesCanonical:c.localNotesCanonical===true,
      localNotesMetadataOnly:c.localNotesMetadataOnly===true,
      localSnapshotCompared:c.localSnapshotCompared===true,
      financialCompared:c.financialCompared===true,
      financialUnchanged:c.financialUnchanged===true,
      baselineCompared:c.baselineCompared===true,
      baselineOriginal:c.baselineOriginal===true,
      unrelatedBaselineCompared:c.unrelatedBaselineCompared===true,
      unrelatedBaselineUnchanged:c.unrelatedBaselineUnchanged===true,
      localStateCurrent:c.localStateCurrent===true,
      syncOff:c.syncOff===true
    };
    let status;
    if(!checks.checkpoint)status='BLOCKED — NO RECOVERY CHECKPOINT';
    else if(!checks.checkpointOwned)status='BLOCKED — CHECKPOINT OWNERSHIP UNPROVEN';
    else if(!checks.baselineOwned)status='BLOCKED — BASELINE OWNERSHIP UNPROVEN';
    else if(!checks.outboxRead)status='BLOCKED — OUTBOX NOT READ';
    else if(!checks.outboxEmpty)status='PENDING OPERATION REMAINS — DO NOT RETRY';
    else if(checks.cloudRead==='blocked'||checks.cloudRead==='not read')status='BLOCKED — CLOUD STATE NOT PROVEN';
    else if(checks.cloudRead==='absent')status='CLOUD NOTE ABSENT — RESTORE NOT PROVEN';
    else if(checks.cloudTemporary)status='CLOUD STILL TEMPORARY — RESTORE NOT APPLIED';
    else if(!checks.cloudOriginal)status='CLOUD CONTENT UNEXPECTED — REVIEW REQUIRED';
    else if(!checks.originalValid)status='BLOCKED — CHECKPOINT NOTE SNAPSHOT INVALID';
    else if(!checks.localSnapshotCompared)status='BLOCKED — LOCAL SNAPSHOT NOT COMPARED';
    else if(!checks.financialCompared)status='BLOCKED — FINANCIAL SNAPSHOT NOT COMPARED';
    else if(!checks.baselineCompared)status='BLOCKED — BASELINE NOTE RECORD NOT COMPARED';
    else if(!checks.localOriginal)status='CLOUD RESTORED — LOCAL NOTE DIFFERS';
    else if(!checks.localNotesJson&&!checks.localNotesMetadataOnly)status=checks.localNotesCanonical?'CLOUD RESTORED — LOCAL SNAPSHOT FORMAT DIFFERS':'CLOUD RESTORED — LOCAL NOTE SNAPSHOT DIFFERS';
    else if(!checks.financialUnchanged)status='CLOUD RESTORED — FINANCIAL SNAPSHOT DIFFERS';
    else if(!checks.baselineOriginal)status='CLOUD RESTORED — BASELINE RECORD DIFFERS';
    else if(checks.unrelatedBaselineCompared&&!checks.unrelatedBaselineUnchanged)status='CLOUD RESTORED — UNRELATED BASELINE DIFFERS';
    else if(!checks.localStateCurrent)status='CLOUD RESTORED — PERSISTED LOCAL STATE DIFFERS';
    else if(!checks.syncOff)status='CLOUD RESTORED — CLOUD SYNC MODE NOT OFF';
    else if(!checks.localNotesJson&&checks.localNotesMetadataOnly&&checks.unrelatedBaselineCompared)status='CONVERGED — NOTE/BASELINE/CLOUD RESTORED; LOCAL SYNC METADATA ONLY; CHECKPOINT REMAINS';
    else if(!checks.localNotesJson&&checks.localNotesMetadataOnly)status='CONVERGED — NOTE/BASELINE/CLOUD RESTORED; LOCAL SYNC METADATA ONLY; PREFLIGHT BASELINE NOT STORED; CHECKPOINT REMAINS';
    else if(!checks.unrelatedBaselineCompared)status='CONVERGED — NOTE/BASELINE/LOCAL/OUTBOX RESTORED; PREFLIGHT BASELINE NOT STORED; CHECKPOINT REMAINS';
    else status='CONVERGED — NOTE/BASELINE/LOCAL/OUTBOX RESTORED; CHECKPOINT REMAINS';
    const converged=status.startsWith('CONVERGED');
    return {status,checks,safeToCleanCheckpoint:status==='CONVERGED — NOTE/BASELINE/LOCAL/OUTBOX RESTORED; CHECKPOINT REMAINS',metadataOnlyConverged:converged&&status.includes('LOCAL SYNC METADATA ONLY'),limitedEvidence:converged&&status.includes('PREFLIGHT BASELINE NOT STORED')};
  }
  async function inspectNotesTestRecovery(){
    const u=await CapSupabase.currentUser(),owner=u?.id||null;
    const checkpoint=await CapOff.syncStore('syncmeta','get',NOTES_TEST_KEY);
    const baseline=await CapOff.syncStore('syncmeta','get','baseline');
    const entries=await CapOff.syncStore('outbox','all').catch(()=>null);
    const outboxCount=Array.isArray(entries)?entries.length:-1;
    const base={checkpointPresent:!!checkpoint,checkpointOwned:!!owner&&checkpoint?.owner===owner,baselineOwned:!!owner&&baseline?.user_id===owner,outboxCount};
    if(!checkpoint)return {...base,...notesRecoveryReport(base),phase:'absent',pendingMatches:0,financialDifferences:[],originalValid:false};
    const original=checkpoint.original;
    let originalValid=false;try{noteContent(original);originalValid=true}catch(_){}
    let cloudRead='not read',cloudOriginal=false,cloudTemporary=false;
    if(originalValid&&base.checkpointOwned){
      try{
        const cloud=await cloudReader(owner)('notes',{id:original.id,localId:original.legacy_id});
        if(cloud===null)cloudRead='absent';
        else{
          cloudRead='verified';const content=noteContent(cloud),expected=noteContent(original);
          cloudOriginal=JSON.stringify(content)===JSON.stringify(expected);
          if(typeof original.body==='string')cloudTemporary=JSON.stringify(content)===JSON.stringify(noteContent({...original,body:original.body+'\n[Cap atomic notes test]'}));
        }
      }catch(_){cloudRead='blocked'}
    }
    let localOriginal=false;
    if(originalValid&&base.checkpointOwned){try{localOriginal=JSON.stringify(noteContent(noteFromPlan(original.legacy_id)))===JSON.stringify(noteContent(original))}catch(_){}}
    let localNotesJson=false,localNotesCanonical=false,localNotesMetadataOnly=false,localNotesDiff=null,localSnapshotCompared=false;
    try{
      const before=JSON.parse(checkpoint.originalLocal);
      localSnapshotCompared=true;
      localNotesJson=JSON.stringify(S.notes)===checkpoint.originalLocal;
      localNotesDiff=notesSnapshotDiff(before,S.notes);
      localNotesCanonical=localNotesDiff.contentMatches;
      localNotesMetadataOnly=localNotesDiff.metadataOnly;
    }catch(_){}
    let financialCompared=false,financialUnchanged=false,financialDifferences=[];
    try{
      const before=JSON.parse(checkpoint.financial),now=JSON.parse(notesFinancialSnapshot());
      const keys=[...new Set([...Object.keys(before||{}),...Object.keys(now||{})])];
      financialDifferences=keys.filter(k=>JSON.stringify(before?.[k])!==JSON.stringify(now?.[k])).sort();
      financialCompared=true;financialUnchanged=financialDifferences.length===0;
    }catch(_){}
    let baselineCompared=false,baselineOriginal=false,unrelatedBaselineCompared=false,unrelatedBaselineUnchanged=false;
    if(originalValid&&Array.isArray(baseline?.records)){
      try{
        const target=baseline.records.filter(r=>r.entity==='notes'&&r.supabase_id===original.id),fingerprint=await contentFingerprint(canonical(original,'','notes'));
        baselineOriginal=target.length===1&&target[0].contentFingerprint===fingerprint;
        baselineCompared=true;
        if(Array.isArray(checkpoint.baseline?.records)){
          const without=rows=>rows.filter(r=>!(r.entity==='notes'&&r.supabase_id===original.id));
          unrelatedBaselineUnchanged=JSON.stringify(without(baseline.records))===JSON.stringify(without(checkpoint.baseline.records));
          unrelatedBaselineCompared=true;
        }
      }catch(_){}
    }
    let syncOff=false;try{syncOff=(await status()).mode==='off'}catch(_){}
    const input={...base,cloudRead,cloudOriginal,cloudTemporary,originalValid,localOriginal,localNotesJson,localNotesCanonical,localNotesMetadataOnly,localSnapshotCompared,financialCompared,financialUnchanged,baselineCompared,baselineOriginal,unrelatedBaselineCompared,unrelatedBaselineUnchanged,localStateCurrent:localStateIsCurrent(),syncOff};
    const report=notesRecoveryReport(input);
    return {...input,...report,phase:['prepared','test','restore'].includes(checkpoint.phase)?checkpoint.phase:'unknown',pendingMatches:Array.isArray(entries)&&checkpoint.operationId?entries.filter(e=>e?.id===checkpoint.operationId).length:0,financialDifferences,localNotesDiff};
  }
  window.inspectCapNotesTestRecovery=async()=>{
    const out=document.getElementById('controlled-notes-result');if(!out||!window.CAP_DEV_TOOLS)return;
    out.style.whiteSpace='pre-line';out.textContent='Inspecting notes-test recovery read-only…';
    try{
      const r=await inspectNotesTestRecovery(),c=r.checks,nd=r.localNotesDiff||{};
      const pending=r.outboxCount<0?'not read':r.outboxCount===0?'none':r.pendingMatches===1?'one exact entry':'other entries present';
      const cloud=!r.checkpointPresent?'not checked':c.cloudRead==='verified'?(c.cloudOriginal?'matches original':c.cloudTemporary?'matches temporary marker':'different content'):c.cloudRead==='absent'?'verified absent':c.cloudRead==='blocked'?'BLOCKED — READ NOT VERIFIED':'not read';
      const local=!r.checkpointPresent?'not checked':!c.originalValid?'not comparable':c.localOriginal?'matches original':'different content';
      const snapshot=!r.checkpointPresent?'not checked':!c.localSnapshotCompared?'not compared':c.localNotesJson?'matches':c.localNotesMetadataOnly?'differs (sync metadata only: '+((nd.metadataFields||[]).join(', ')||'metadata')+')':c.localNotesCanonical?'differs (format/order only)':nd.shape==='list'?'differs (content: '+(nd.contentChanged||0)+' changed · '+(nd.added||0)+' added · '+(nd.removed||0)+' removed'+(nd.changedFields?.length?'; fields: '+nd.changedFields.join(', '):'')+')':'differs (shape or text content)';
      const financial=!r.checkpointPresent?'not checked':!c.financialCompared?'not compared':c.financialUnchanged?'unchanged':'differs: '+(r.financialDifferences.length?r.financialDifferences.join(', '):'unknown field');
      const baseline=!r.checkpointPresent?'not checked':!c.baselineCompared?'not compared':c.baselineOriginal?'matches original':'differs';
      const other=!r.checkpointPresent?'not checked':!c.unrelatedBaselineCompared?'not stored in checkpoint':c.unrelatedBaselineUnchanged?'unchanged':'differs';
      const lines=['READ-ONLY NOTES-TEST RECOVERY','Checkpoint: '+(r.checkpointPresent?'present · phase '+r.phase+' · ownership '+(c.checkpointOwned?'verified':'BLOCKED'):'absent'),'Outbox: '+(r.outboxCount<0?'not read':r.outboxCount)+' · pending operation: '+pending,'Cloud note: '+cloud,'Local note: '+local,'Local note snapshot: '+snapshot,'Financial snapshot: '+financial,'Baseline note record: '+baseline,'Other baseline records: '+other,'Persisted local state: '+(r.checkpointPresent?(c.localStateCurrent?'current':'differs'):'not checked'),'Cloud Sync: '+(c.syncOff?'OFF':'not off'),'Classification: '+r.status,'No changes were made. Do not retry, reset, clear the outbox, or delete the checkpoint without explicit review.'];
      out.textContent=lines.join('\n');
    }catch(_){out.textContent='BLOCKED — recovery inspection could not complete. No data, baseline, or outbox entries were changed.';}
  };
  window.runCapControlledNotesTest=async()=>{
    const out=document.getElementById('controlled-notes-result');if(!out||!window.CAP_DEV_TOOLS)return;
    out.textContent='Starting read-only preflight. Nothing changes unless you confirm.';
    const result=await controlledNoteRoundTrip(controlledNotesAdapters());
    out.textContent+='\n'+result.status+(result.recoveryRequired?' · STOP: do not retry, reset, or clear the outbox; inspect the recovery checkpoint and pending operation.':'')+' · Cloud Sync remains OFF.';
  };
  /* Session-only review preferences. These are NOT resolutions and are never
     consumed by the executor. Each preference is bound to the exact queue,
     baseline, owner and canonical cloud snapshot, and rechecked on selection. */
  const reviewChoices=new Map(),reviewHandles=new Map(),reviewBusy=new Set();
  let reviewOwner=null,reviewGeneration=0;
  function conflictFields(op,cloud){
    if(op.operation==='delete'||cloud===null)return ['record presence'];
    const local=canonical(op.payload,'',op.entity),remote=canonical(cloud,'',op.entity);
    const allowed=new Set(('name title body description note_date amount balance credit_limit status account_type nickname bank network last_four transaction_date posting_date account_id category_id bill_id parent_transaction_id statement_id from_account_id to_account_id goal_id transaction_id transfer_id target_amount saved_amount target_date completed person direction due_date kind frequency payment_account_id start_date due_day logo_url legacy_id statement_start statement_end opening_balance closing_balance minimum_due paid_amount statement_day due_days card_art photo_url interest_settings fee_settings statement_settings minimum_payment alert_settings cancelled_on trial_start trial_end').split(' '));
    return [...new Set([...Object.keys(local),...Object.keys(remote)])].filter(k=>JSON.stringify(local[k])!==JSON.stringify(remote[k])).map(k=>allowed.has(k)?k:'other fields').filter((k,i,a)=>a.indexOf(k)===i).sort();
  }
  async function conflictSnapshot(){
    const u=await CapSupabase.currentUser();if(!u?.id)throw Error('Authentication required');
    const baseline=await CapOff.syncStore('syncmeta','get','baseline');
    const all=await CapOff.syncStore('outbox','all');
    if(!Array.isArray(all))throw Error('Outbox unavailable');
    const entries=all.filter(x=>x?.user_id===u.id&&!String(x.local_id||'').startsWith('phase6-test-')&&!String(x.payload?.legacy_id||'').startsWith('phase6-test-'));
    const observed=new Map(),reader=cloudReader(u.id);
    const planned=await planOutbox(entries,{userId:u.id,baseline,readCloud:async(entity,identity)=>{const row=await reader(entity,identity);observed.set(entity+':'+identity.id,row);return row;}});
    const latest=new Map();
    entries.slice().sort((a,b)=>String(a.queued_at||'').localeCompare(String(b.queued_at||''))||String(a.id).localeCompare(String(b.id))).forEach(op=>latest.set(outboxKey(op),op));
    const conflicts=[];
    for(const item of planned.plan.filter(x=>x.classification==='CONFLICT')){
      const op=latest.get(item.key),cloud=observed.get(item.entity+':'+item.supabaseId);
      const base=(baseline?.records||[]).find(x=>x.entity===item.entity&&String(x.supabase_id)===item.supabaseId);
      const signature=base?await contentFingerprint({owner:u.id,queued:JSON.stringify(op),baseline:JSON.stringify(base),cloud:cloud===null?null:await contentFingerprint(canonical(cloud,'',item.entity))}):null;
      conflicts.push({entity:item.entity,fields:conflictFields(op,cloud),localDeleted:op.operation==='delete',cloudDeleted:cloud===null,reviewable:!!signature,signature});
    }
    return {owner:u.id,conflicts,blocked:planned.summary.blocked};
  }
  async function inspectOutboxConflicts(){
    const generation=++reviewGeneration;
    const snapshot=await conflictSnapshot();
    if(generation!==reviewGeneration)throw Error('Review superseded');
    if(reviewOwner!==snapshot.owner){reviewChoices.clear();reviewOwner=snapshot.owner;}
    reviewHandles.clear();
    const conflicts=snapshot.conflicts.map((record,index)=>{
      const token=crypto.randomUUID();
      if(record.reviewable)reviewHandles.set(token,{signature:record.signature,owner:snapshot.owner});
      const {signature,...safe}=record;
      return {...safe,number:index+1,token,preference:reviewChoices.get(signature)||null};
    });
    return {conflicts,blocked:snapshot.blocked,reviewOnly:true};
  }
  async function chooseOutboxConflict(token,side){
    if(!['local','cloud'].includes(side))return {status:'INVALID CHOICE',recorded:false};
    const handle=reviewHandles.get(token);
    if(!handle)return {status:'STALE — REVIEW AGAIN',recorded:false};
    if(reviewBusy.has(token))return {status:'REVIEW IN PROGRESS',recorded:false};
    reviewBusy.add(token);
    try{
      const snapshot=await conflictSnapshot();
      const user=await CapSupabase.currentUser();
      if(snapshot.owner!==handle.owner||user?.id!==handle.owner||reviewHandles.get(token)!==handle||!snapshot.conflicts.some(x=>x.signature===handle.signature)){
        reviewHandles.delete(token);reviewChoices.delete(handle.signature);
        return {status:'STALE — REVIEW AGAIN',recorded:false};
      }
      reviewChoices.set(handle.signature,side);
      return {status:'PREFERENCE NOTED — NOT APPLIED',recorded:true,preference:side};
    }catch(_){reviewHandles.delete(token);reviewChoices.delete(handle.signature);return {status:'BLOCKED — RECHECK FAILED; NOTHING APPLIED',recorded:false};}
    finally{reviewBusy.delete(token)}
  }
  window.reviewCapOutboxConflicts=async()=>{
    const out=document.getElementById('outbox-plan-result');if(!out)return;
    out.textContent='Rechecking conflicts read-only…';
    try{
      const review=await inspectOutboxConflicts();
      out.textContent='CONFLICT REVIEW · '+review.conflicts.length+' conflicts · '+review.blocked+' blocked operations\nPreferences only: nothing is applied or synced. Choices last for this page session and expire when records change.\n';
      if(!review.conflicts.length){out.appendChild(document.createTextNode('No queued conflicts to review.'));return;}
      for(const record of review.conflicts){
        const box=document.createElement('div');
        const heading=document.createElement('p');heading.textContent='Record '+record.number+' · '+record.entity+' · differing fields: '+record.fields.join(', ');box.appendChild(heading);
        const status=document.createElement('span');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
        status.textContent=record.preference?'Preference: keep '+record.preference+' — not applied.':record.reviewable?'No preference selected.':'Blocked: a verified baseline is required before choosing.';
        if(record.reviewable)for(const side of ['local','cloud']){
          const button=document.createElement('button');button.type='button';button.className='btn s';
          button.textContent='Keep '+side+((side==='local'?record.localDeleted:record.cloudDeleted)?' (delete)':'');
          button.onclick=async()=>{button.disabled=true;try{const result=await chooseOutboxConflict(record.token,side);status.textContent=result.status+(result.recorded?' · keep '+side:'');}finally{button.disabled=false}};
          box.appendChild(button);
        }
        box.appendChild(status);out.appendChild(box);
      }
    }catch(_){out.textContent='Conflict review blocked: authentication, storage, or cloud verification could not complete. Nothing applied.';}
  };
  async function markOutboxFailure(entry,reason){
    try{await CapOff.syncStore('outbox','put',{...entry,retry_count:(entry.retry_count||0)+1,last_error:String(reason).slice(0,500)})}catch(_){}
  }
  const executingOutbox=new Set();
  async function executeOutboxOperation(operationId,{readCloud,write,userId}={}){
    if(!operationId)throw Error('An outbox operation id is required');
    if(executingOutbox.has(operationId))throw Error('That outbox operation is already executing');
    executingOutbox.add(operationId);
    try{
      const u=userId?{id:userId}:await CapSupabase.currentUser();
      if(!u?.id)throw Error('Authenticate before executing the outbox');
      const baseline=await CapOff.syncStore('syncmeta','get','baseline').catch(()=>null);
      const all=await CapOff.syncStore('outbox','all').catch(e=>{throw Error('Outbox read failed: '+e.message)});
      const entry=all.find(x=>x.id===operationId);
      if(!entry)throw Error('Outbox entry not found');
      const reader=readCloud||cloudReader(u.id),writer=write||(op=>applyOperation(op));
      const planned=await planOutbox([entry],{userId:u.id,readCloud:reader,baseline});
      const item=planned.plan[0];
      if(!item||item.action==='BLOCKED')return{status:'REFUSED — NOTHING WRITTEN',reason:planned.blocked[0]?.reason||item?.reason||'blocked',wrote:false,removed:false};
      // Client reads cannot prevent an edit racing with a subsequent write.
      // Keep the real transport restricted to disposable test operations until
      // server-side compare-and-write and baseline reconciliation are ready.
      if(!write&&!String(entry.local_id||'').startsWith('phase6-test-'))return{status:'REFUSED — NOTHING WRITTEN',reason:'Production execution is disabled pending atomic conflict checks and baseline reconciliation',wrote:false,removed:false};
      const supabaseId=item.supabaseId;
      if(entry.operation==='upsert'&&!entry.payload?.id)return{status:'REFUSED — NOTHING WRITTEN',reason:'payload has no id',wrote:false,removed:false};
      if(entry.operation==='upsert'&&String(entry.payload.id)!==String(supabaseId))return{status:'REFUSED — NOTHING WRITTEN',reason:'payload id does not match the resolved Supabase id',wrote:false,removed:false};
      if(entry.payload?.user_id&&entry.payload.user_id!==u.id)return{status:'REFUSED — NOTHING WRITTEN',reason:'payload ownership does not match the authenticated user',wrote:false,removed:false};
      if(item.action==='NOOP'||item.action==='ALREADY_DELETED'){
        try{await CapOff.syncStore('outbox','delete',entry.id);return{status:'ALREADY_APPLIED — VERIFIED',wrote:false,removed:true}}
        catch(e){return{status:'DATA CONVERGED — OUTBOX CLEANUP FAILED',wrote:false,removed:false,error:e?.message}}
      }
      const op={entity:entry.entity,local_id:entry.local_id,supabase_id:supabaseId,operation:entry.operation,payload:entry.payload,user_id:u.id};
      try{await writer(op)}
      catch(e){await markOutboxFailure(entry,'write failed: '+(e?.message||'unknown'));return{status:'WRITE FAILED — NOTHING VERIFIED',wrote:false,removed:false,error:e?.message}}
      let cloud;
      try{cloud=await reader(entry.entity,{id:supabaseId,localId:entry.local_id})}
      catch(e){await markOutboxFailure(entry,'verification read failed: '+(e?.message||'unknown'));return{status:'CLOUD WRITE OCCURRED — VERIFICATION FAILED',wrote:true,removed:false,error:e?.message}}
      const ok=entry.operation==='delete'?!cloud:payloadMatches(entry.payload,cloud);
      if(!ok){await markOutboxFailure(entry,'verification mismatch');return{status:'CLOUD WRITE OCCURRED — VERIFICATION FAILED',wrote:true,removed:false}}
      try{await CapOff.syncStore('outbox','delete',entry.id);return{status:'APPLIED — VERIFIED',wrote:true,removed:true}}
      catch(e){return{status:'DATA CONVERGED — OUTBOX CLEANUP FAILED',wrote:true,removed:false,error:e?.message}}
    }finally{executingOutbox.delete(operationId)}
  }
  function settingsHtml(){return `<div class="st-box st-col"><div class="st-r"><span class="f"><b>Cloud Sync: OFF</b><small>Local-first foundation is installed; automatic sync is disabled.</small></span><span class="st-pill" data-s="off"><i></i>Off</span></div><div class="st-note" id="sync-engine-status">Last synced: — · Pending changes: 0 · Conflicts: 0</div><button type="button" class="btn s" style="margin:0" onclick="testCapSyncEngine()">Test Sync Engine</button><small id="sync-engine-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="validateCapRealData()">Validate Real Data Sync</button><small id="real-sync-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="runCapSyncDryRunButton()">Run Sync Dry Run</button><small id="sync-dry-run-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="inspectCurrentSyncBaseline()">Inspect Current Baseline</button><small id="sync-baseline-inspect-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="initializeCapSyncBaseline()">Initialize Sync Baseline</button><small id="sync-baseline-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="diagnoseCapBaselineUpgrade()">Diagnose Baseline Upgrade</button><small id="sync-baseline-diagnostic-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="upgradeCapSyncBaseline()">Upgrade Sync Baseline</button><small id="sync-baseline-upgrade-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="inspectCapPendingOutbox()">Inspect Pending Outbox</button><small id="outbox-inspect-result" class="st-note"></small>${window.CAP_DEV_TOOLS?`<div class="st-grp eyebrow">Developer test tools</div><button type="button" class="btn s" style="margin:0" onclick="checkBalanceConsistency()">Check Balance Consistency</button><button type="button" class="btn s" style="margin:0" onclick="capCaptureAnchors()">Capture Balance Anchors</button><button type="button" class="btn s" style="margin:0" onclick="capCreateOpeningBalances()">Create Opening Balances</button><button type="button" class="btn s" style="margin:0" onclick="capToggleDerivedBalances()">Toggle Derived Balances</button><small id="balance-check-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="runCapOutboxPlanButton()">Plan Outbox (read-only)</button><small id="outbox-plan-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="tracePhase6JIdentifiers()">Trace Phase 6J Identifiers</button><small id="phase6j-trace-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="auditControlledWrite()">Audit Controlled Write</button><small id="controlled-write-audit-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="diagnosePhase6K4A()">Diagnose Phase 6K.4A</button><small id="phase6k4a-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="cleanupPhase6TestArtifact()">Clean Up Phase 6 Test Artifact</button><small id="phase6-test-cleanup-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="reconcileControlledBaseline()">Reconcile Controlled Baseline</button><small id="controlled-baseline-result" class="st-note"></small><button type="button" id="controlled-retry-test" class="btn s" style="margin:0" onclick="testControlledRetry()">Test Controlled Retry</button><small id="controlled-retry-result" class="st-note"></small><button type="button" id="controlled-write-test" class="btn s" style="margin:0" disabled onclick="testControlledWrite()">Test Controlled Write</button><small id="controlled-write-result" class="st-note"></small><button type="button" id="single-push-test" class="btn s" style="margin:0" disabled onclick="testSingleTransactionPush()">Test Single Record Push</button><small id="single-push-result" class="st-note"></small><button type="button" id="single-pull-test" class="btn s" style="margin:0" disabled onclick="testSingleTransactionPull()">Test Single Record Pull</button><small id="single-pull-result" class="st-note"></small><button type="button" id="single-local-delete-test" class="btn s" style="margin:0" disabled>Test Single Local Delete</button><button type="button" id="single-cloud-delete-test" class="btn s" style="margin:0" disabled>Test Single Cloud Delete</button><small id="delete-sync-result" class="st-note"></small><button type="button" id="single-conflict-inspect" class="btn s" style="margin:0" disabled onclick="inspectSingleConflict()">Inspect Single Conflict</button><small id="single-conflict-result" class="st-note"></small><button type="button" id="keep-local-conflict" class="btn s" style="margin:0" disabled onclick="resolveSingleConflict('local')">Keep Local</button><button type="button" id="keep-cloud-conflict" class="btn s" style="margin:0" disabled onclick="resolveSingleConflict('cloud')">Keep Cloud</button><small id="conflict-resolution-result" class="st-note"></small><button type="button" class="btn s" style="margin:0" onclick="diagnoseFailedSinglePull()">Diagnose Failed Pull</button><small id="failed-pull-result" class="st-note"></small>`:''}</div>`}
  window.CapSync={queue,status,settingsHtml,test,inspectPendingOutbox,discardPendingOutbox,recordFingerprints,fingerprintDiagnostics,contentFingerprint,planOutbox,processOutbox,executeOutboxOperation,inspectOutboxConflicts,chooseOutboxConflict,rehearseNotePush,controlledNoteRoundTrip,inspectNotesTestBlocker,cleanupStaleTestOutbox,buildDemoRefreshCandidate,refreshLocalDemo,notesRecoveryReport,notesSnapshotDiff,inspectNotesTestRecovery,ORDER};
  /* Read-only balance consistency report. Shows balances and drift on this
     device only; never writes. Gated behind ?dev=1 in the settings panel. */
  window.checkBalanceConsistency=()=>{
    const out=document.getElementById('balance-check-result');
    if(!out)return;
    try{
      const r=balanceConsistencyReport(),f=v=>esc(String(v));
      const lines=r.rows.map(x=>{
        const unk=x.unknownKinds.length?'<br><span class="m">unknown transfer kinds: '+f(x.unknownKinds.join(', '))+'</span>':'';
        const st=x.statement?'<br><span class="m">statement end '+f(x.statement.end)+' · close '+f(x.statement.close)+' · effects after '+f(x.statement.effectsAfter)+' · expected '+f(x.statement.expected)+' · delta '+f(x.statement.delta)+'</span>':'';
        return '<div><b>'+f(x.type)+' account '+f(x.id)+'</b><br>stored '+f(x.stored)+' · effects '+f(x.effects)+' · implied anchor '+f(x.impliedAnchor)
          +'<br><span class="m">transactions '+x.txCount+' ('+f(x.txEffects)+') · pending '+x.pendCount+' ('+f(x.pendEffects)+') · transfers '+x.xferCount+' ('+f(x.xferEffects)+')</span>'+unk+st+'</div>';
      }).join('<br>');
      const sh=balanceShadowReport();
      const derOn=(()=>{try{return localStorage.getItem('cap_derived_balance')!=='0'}catch(e){return true}})();
      let shadow;
      if(!sh.captured)shadow='<br><b>ANCHORS</b><br><span class="m">Not captured. Capture anchors to start drift detection.</span>';
      else{
        const bad=sh.drift.map(x=>'<div><b>'+f(x.type)+' account '+f(x.id)+'</b> · stored '+f(x.stored)+' · derived '+f(x.derived)+' · delta '+f(x.delta)+'</div>').join('');
        shadow='<br><b>ANCHORS</b> · captured '+f(sh.at)+' · drift '+sh.drift.length+' · missing '+sh.missing+' · stale '+sh.extra+' · derived '+(derOn?'ON':'OFF')+' · corrections '+((window.CAP_BALANCE_CORRECTIONS||[]).length)
          +'<br>'+(sh.drift.length?bad:'<span class="m">No drift: stored equals anchor + effects for all accounts.</span>')
          +'<br><span class="m">Anchors are local-only; never synced or exported.</span>';
      }
      const state='<br><b>DERIVED</b> '+(derOn?'ON':'OFF')+' · corrections '+((window.CAP_BALANCE_CORRECTIONS||[]).length);
      out.innerHTML='<b>BALANCE CONSISTENCY (read-only)</b><br>Accounts: '+r.accounts+' · unaccounted '+r.rows.filter(x=>Math.abs(x.impliedAnchor)>0.005).length+' · orphan transactions: '+r.orphanTransactions+' · orphan transfers: '+r.orphanTransfers+'<br>'+lines+shadow+state
        +'<br><span class="m">Derived = anchor + transactions + transfers. No data was changed.</span>';
      toast('Balance consistency report ready',true);
    }catch(e){out.textContent='Balance check failed: '+e.message;toast('Balance check failed')}
  };
  window.capCaptureAnchors=()=>{
    const prev=readBalanceAnchors();
    const run=()=>{
      const res=captureBalanceAnchors(true);
      if(!res.ok){toast('Could not capture balance anchors');return}
      checkBalanceConsistency();
      toast('Balance anchors captured',true);
    };
    if(prev)return confirmBox('Replace balance anchors?','Anchors were captured '+esc(String(prev.at))+'. Replacing them treats every current balance as correct from now on and hides drift that already exists.',run,'Replace anchors');
    run();
  };
  window.capCreateOpeningBalances=()=>{
    const rows=openingBalancePreview();
    if(!rows.length){checkBalanceConsistency();toast('Every account already reconciles');return}
    const total=rows.reduce((n,r)=>n+Math.abs(r.anchor),0);
    confirmBox('Create opening balances?',rows.length+' account'+(rows.length==1?'':'s')+' will get an opening entry totalling '+php(total)+'. Balances do not change; the entries make the ledger account for them.',()=>{
      const res=createOpeningBalances();
      checkBalanceConsistency();
      toast(res.created.length+' opening entr'+(res.created.length==1?'y':'ies')+' created',true);
    },'Create entries');
  };
  window.capToggleDerivedBalances=()=>{
    const off=(()=>{try{return localStorage.getItem('cap_derived_balance')==='0'}catch(e){return false}})();
    const go=()=>{try{localStorage.setItem('cap_derived_balance',off?'1':'0')}catch(e){};location.reload()};
    if(!off)return confirmBox('Turn off derived balances?','Balances will stop being recalculated from the ledger on save. Accounts keep their stored values, so drift will no longer self-correct.',go,'Turn off');
    go();
  };
  window.testCapSyncEngine=async()=>{const o=document.getElementById('sync-engine-result');if(o)o.textContent='Running disposable sync test…';try{const r=await test();if(o)o.textContent=r.report.map(x=>x[0]+' '+(x[1]?'✓':'✕')).join(' · ')+' · Existing data untouched ✓';toast('Sync engine test passed',true)}catch(e){if(o)o.textContent='Sync test failed: '+e.message;toast('Sync engine test failed')}};
  window.inspectCapPendingOutbox=async()=>{const o=document.getElementById('outbox-inspect-result');if(o)o.textContent='Inspecting outbox read-only…';try{const r=await inspectPendingOutbox();if(!r.count){if(o)o.textContent='Pending real-data outbox operations: 0';return}if(o)o.innerHTML=r.results.map(x=>`${x.entity} · ${x.operation} · local ${x.localId} · Supabase ${x.supabaseId||'not assigned'} · queued ${x.queuedAt} · local ${x.localExists?'exists':'missing'} · cloud ${x.cloudExists?'exists':'missing'} · match ${x.match?'yes':'no'} · <b>${x.recommendation}</b>${x.recommendation==='SAFE TO DISCARD STALE OUTBOX ENTRY'?` <button type="button" class="pill" onclick="discardCapPendingOutbox('${x.operationId}')">Discard this entry</button>`:''}`).join('<br>');}catch(e){if(o)o.textContent='Outbox inspection failed: '+e.message;toast('Outbox inspection failed')}};
  window.runCapSyncDryRunButton=async()=>{const o=document.getElementById('sync-dry-run-result');try{await runCapSyncDryRun()}catch(e){console.error('[Cap sync dry run] failed',e);if(o)o.textContent='Sync dry run failed: '+e.message;toast('Sync dry run failed')}};
  window.discardCapPendingOutbox=async operationId=>{const o=document.getElementById('outbox-inspect-result');try{await discardPendingOutbox(operationId)}catch(e){console.error('[Cap sync outbox discard] failed',e);if(o)o.textContent='Discard failed: '+e.message;toast('Discard failed')}};
  window.runCapOutboxPlanButton=async()=>{
    const o=document.getElementById('outbox-plan-result');
    if(o)o.textContent='Planning outbox read-only…';
    try{
      const r=await processOutbox({dryRun:true});
      const lines=[...r.plan,...r.blocked].slice(0,8).map((x,i)=>'Record '+(i+1)+' · '+(ORDER.includes(x.entity)?x.entity:'unknown entity')+' · '+x.action+(x.classification?' · '+x.classification:'')+(x.reason?' ('+x.reason+')':'')).join('\n');
      if(o){o.style.whiteSpace='pre-line';o.textContent='Outbox entries: '+r.entries+' · coalesced '+r.coalesced+' · insert '+r.summary.insert+' · update '+r.summary.update+' · delete '+r.summary.delete+' · no-op '+r.summary.noop+' · blocked '+r.summary.blocked+' · conflicts '+r.summary.conflicts+(r.ignoredTestArtifacts?' · ignored test artifacts '+r.ignoredTestArtifacts:'')+(r.ignoredOtherUsers?' · other users '+r.ignoredOtherUsers:'')+'\n'+(lines||'Nothing queued.')+'\nRead-only plan. No operation was applied or removed. No financial values or user identifiers displayed.';}
      if(o&&r.summary.conflicts){const button=document.createElement('button');button.type='button';button.className='btn s';button.textContent='Review conflicts (no changes applied)';button.onclick=window.reviewCapOutboxConflicts;o.appendChild(button);}
      if(o){
        const button=document.createElement('button'),result=document.createElement('span');
        button.type='button';button.className='btn s';button.textContent='Check atomic notes RPC (read-only)';result.setAttribute('role','status');result.setAttribute('aria-live','polite');
        button.onclick=async()=>{button.disabled=true;result.textContent='Checking metadata only…';try{const ready=await CapSupabase.refreshNotesRpcReadiness();result.textContent=ready?'Notes RPC metadata verified. Production writes remain locked.':'BLOCKED — notes RPC metadata is missing, unsafe, or could not be verified. No write RPC was called.';}catch(_){result.textContent='BLOCKED — readiness could not be verified. No write RPC was called.';}finally{button.disabled=false}};
        o.appendChild(button);o.appendChild(result);
      }
      if(o&&window.CAP_DEV_TOOLS){
        const button=document.createElement('button'),result=document.createElement('span');
        button.type='button';button.className='btn s';button.textContent='Controlled demo notes test (real writes)';
        result.id='controlled-notes-result';result.setAttribute('role','status');result.setAttribute('aria-live','polite');
        button.onclick=async()=>{button.disabled=true;try{await window.runCapControlledNotesTest();}finally{button.disabled=false}};
        const diagnostic=document.createElement('button');diagnostic.type='button';diagnostic.className='btn s';diagnostic.textContent='Inspect notes-test blocker (read-only)';diagnostic.onclick=window.inspectCapNotesTestBlocker;
        const recovery=document.createElement('button');recovery.type='button';recovery.className='btn s';recovery.textContent='Inspect notes-test recovery (read-only)';recovery.onclick=window.inspectCapNotesTestRecovery;
        o.appendChild(button);o.appendChild(diagnostic);o.appendChild(recovery);o.appendChild(result);
        const refresh=document.createElement('button');refresh.type='button';refresh.className='btn s';refresh.textContent='Refresh this browser’s demo (local only)';refresh.onclick=async()=>{refresh.disabled=true;try{await window.runCapLocalDemoRefresh();}finally{refresh.disabled=false}};o.appendChild(refresh);
      }
    }catch(e){if(o)o.textContent='Outbox plan blocked: authentication, storage, or cloud verification could not complete. No operation was applied or removed.';toast('Outbox plan failed')}
  };
})();
