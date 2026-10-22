/* Unwired note-only compatibility apply prototype. Explicit isolated adapters
   only: no database open/upgrade, app boot, financial importer, or cloud writer.
   Live integration still requires coherent schema/import/reset/recovery gates. */
(function (root) {
  'use strict';
  const VERSION = 1, KEY = 'manual-notes-tombstone-v1', PREFIX = 'manual-notes-compat-backup:';
  const LOCK = 'cap-controlled-notes-test', OTHER = ['controlled-notes-test-v1','demo-local-refresh-state-v1','manual-notes-pull-v1'];
  const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
  const hex = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  function canonical(x) {
    if (x === null || ['string','boolean'].includes(typeof x)) return x;
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (Array.isArray(x)) return x.map(canonical);
    if (!object(x) || Object.prototype.toString.call(x) !== '[object Object]') throw Error();
    return Object.fromEntries(Object.keys(x).sort().map(k => [k,canonical(x[k])]));
  }
  const json = x => JSON.stringify(canonical(x)), eq = (a,b) => json(a) === json(b), copy = x => JSON.parse(json(x));
  const clone = x => JSON.parse(JSON.stringify(x));
  const status = text => ({ status: text, applied: false, verified: false, cloudWritten: false });
  function create(io) {
    if (!io?.database || !io.compat || ['planImport','planMerge'].some(k => typeof io.compat[k] !== 'function') ||
        ['getState','setState','readLocalStorage','writeLocalStorage','guard','withLock'].some(k => typeof io[k] !== 'function'))
      throw Error('Explicit isolated note-only adapters required');
    let busy = false;
    const owned = owner => io.guard(owner) === true;
    const current = (owner, expected) => owned(owner) && JSON.stringify(io.getState()) === expected && io.readLocalStorage() === expected;
    async function build(input) {
      const e = copy(input);
      if (!object(e) || Object.keys(e).sort().join(',') !== 'expectedBaseline,expectedLocalJson,input,kind,operationId,requestedAt,syncOff' ||
          !['merge','import'].includes(e.kind) || e.syncOff !== true || !uuid(e.operationId) || typeof e.expectedLocalJson !== 'string' ||
          !Number.isSafeInteger(e.requestedAt) || e.requestedAt < 1) throw Error();
      const original = JSON.parse(e.expectedLocalJson), source = e.kind === 'import' ? e.input.current : e.input.local;
      const owner = e.input.owner, baseline = e.expectedBaseline;
      if (!object(original) || !eq(source,original) || !Number.isSafeInteger(original._mt) || original._mt < 0 || original._mt >= Number.MAX_SAFE_INTEGER ||
          !owner || baseline?.version !== 2 || baseline.user_id !== owner || !Array.isArray(baseline.records) || !baseline.records.length ||
          baseline.records.some(r => !object(r) || r.user_id !== owner || typeof r.entity !== 'string' || !r.entity.trim() ||
            typeof r.supabase_id !== 'string' || !r.supabase_id.trim() ||
            !(typeof r.localId === 'string' && r.localId.trim() || Number.isSafeInteger(r.localId) && r.localId >= 0) || !hex(r.contentFingerprint)) ||
          new Set(baseline.records.map(r => json([r.entity,r.supabase_id]))).size !== baseline.records.length ||
          new Set(baseline.records.map(r => json([r.entity,String(r.localId)]))).size !== baseline.records.length) throw Error();
      const p = await (e.kind === 'import' ? io.compat.planImport(e.input) : io.compat.planMerge(e.input));
      if (p.previewReady !== true || p.executable !== false || p.authorized !== false || !hex(p.ticket) ||
          !object(p.privateNotes) || Object.keys(p.privateNotes).sort().join(',') !== 'noteTombstones,notes') throw Error();
      const candidate = p.privateNotes;
      // Compatibility application is not a lifecycle authority: no new,
      // changed, or removed tombstones, and no deletion of current active IDs.
      if (!Array.isArray(original.notes) || !Array.isArray(candidate.notes) || !Array.isArray(candidate.noteTombstones) ||
          !eq(candidate.noteTombstones, original.noteTombstones ?? []) ||
          original.notes.some(n => !candidate.notes.some(c => String(c.id) === String(n.id)))) throw Error();
      const next = clone(original); next.notes = clone(candidate.notes);
      // The projection was checked above; retain the original sidecar verbatim
      // rather than rewriting equivalent evidence with a new key order.
      const noChange = eq(original,next);
      if (!noChange) next._mt = Math.max(original._mt + 1,e.requestedAt);
      const created = new Date(e.requestedAt).toISOString();
      const bytes = await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(json({ version: VERSION, evidence: e, proposalTicket: p.ticket })));
      const ticket = Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
      const cp = { version: VERSION, kind: 'manual-note-compatibility-apply', owner, operationId: e.operationId,
        backupKey: PREFIX + e.operationId, created_at: created, phase: 'prepared', evidence: e, nextLocalJson: JSON.stringify(next), ticket };
      return { cp, original, next, noChange, ticket };
    }
    const backupFor = cp => ({ version: VERSION, kind: 'manual-note-compatibility-backup', owner: cp.owner,
      operationId: cp.operationId, evidence: cp.evidence, desiredLocalJson: cp.nextLocalJson, ticket: cp.ticket });
    function transaction(mode,key,work) {
      return new Promise((resolve,reject)=>{
        let t, failure;
        try {
          t=io.database.transaction(['kv','syncmeta','outbox'],mode); const m=t.objectStore('syncmeta');
          const requests=[m.get('baseline'),m.get(KEY),...OTHER.map(k=>m.get(k)),t.objectStore('outbox').getAll(),t.objectStore('kv').get('state'),m.get(key)];
          const values=[]; let pending=requests.length;
          requests.forEach((q,i)=>{q.onsuccess=()=>{values[i]=q.result;if(--pending)return;
            try{work(t,values)}catch(_){failure=Error('Note-only apply evidence changed');t.abort()}
          }});
          t.oncomplete=()=>resolve(values);t.onabort=()=>reject(failure||Error('Note-only transaction aborted'));
          t.onerror=()=>{failure=Error('Note-only transaction failed')};
        }catch(_){if(t)try{t.abort()}catch(_){}reject(Error('Note-only transaction unavailable'))}
      });
    }
    function verify(values,cp,phase,expected,backupRequired) {
      const [baseline,active,test,demo,pull,entries,state,backup]=values;
      if (!eq(baseline,cp.evidence.expectedBaseline)||test||demo||pull||entries.length||state?.json!==expected||
          !current(cp.owner,expected)||(phase===null||phase==='complete'?!!active:!eq(active,{...cp,phase}))||
          (backupRequired?!eq(backup,backupFor(cp)):!!backup)) throw Error();
    }
    async function preview(input) {
      try {
        const b=await build(input);if(!current(b.cp.owner,b.cp.evidence.expectedLocalJson))throw Error();
        return {...status(b.noChange?'NO NOTE CHANGE — current notes and deletion evidence already match':'PREVIEW ONLY — confirmed note-only local apply requires a verified backup'),
          previewReady:!b.noChange,noChange:b.noChange,...(!b.noChange?{ticket:b.ticket,requiresConfirmation:true}:{})};
      }catch(_){return {...status('BLOCKED — note-only compatibility apply not proven'),previewReady:false}}
    }
    async function apply(ticket,action) {
      if(busy||!hex(ticket)||!action||typeof action.inspect!=='function'||typeof action.confirm!=='function')
        return status('BLOCKED — fresh note-only preview and explicit confirmation required');
      busy=true;let backedUp=false,committed=false,cleaned=false;
      try {
        return await io.withLock(LOCK,async()=>{
          const first=await build(await action.inspect());
          if(first.noChange||first.ticket!==ticket||!current(first.cp.owner,first.cp.evidence.expectedLocalJson))throw Error();
          await transaction('readonly',first.cp.backupKey,(_,v)=>verify(v,first.cp,null,first.cp.evidence.expectedLocalJson,false));
          if(await action.confirm()!==true)return status('CANCELLED — no note-only changes made');
          const b=await build(await action.inspect()),cp=b.cp,expected=cp.evidence.expectedLocalJson;
          if(b.noChange||b.ticket!==ticket||!current(cp.owner,expected))throw Error();
          await transaction('readwrite',cp.backupKey,(t,v)=>{verify(v,cp,null,expected,false);
            t.objectStore('syncmeta').add(backupFor(cp),cp.backupKey);t.objectStore('syncmeta').add(cp,KEY)});
          backedUp=true;
          await transaction('readonly',cp.backupKey,(_,v)=>verify(v,cp,'prepared',expected,true));
          const fresh=await build(await action.inspect());if(fresh.ticket!==ticket)throw Error();
          await transaction('readwrite',cp.backupKey,(t,v)=>{verify(v,cp,'prepared',expected,true);
            t.objectStore('kv').put({json:cp.nextLocalJson,mt:b.next._mt},'state');t.objectStore('syncmeta').put({...cp,phase:'applied'},KEY)});
          committed=true;if(!current(cp.owner,expected))throw Error();
          io.setState(clone(b.next));io.writeLocalStorage(cp.nextLocalJson);
          await transaction('readonly',cp.backupKey,(_,v)=>verify(v,cp,'applied',cp.nextLocalJson,true));
          await transaction('readwrite',cp.backupKey,(t,v)=>{verify(v,cp,'applied',cp.nextLocalJson,true);t.objectStore('syncmeta').delete(KEY)});
          cleaned=true;
          await transaction('readonly',cp.backupKey,(_,v)=>verify(v,cp,'complete',cp.nextLocalJson,true));
          return {status:'NOTE-ONLY LOCAL APPLY VERIFIED — BACKUP RETAINED; NO CLOUD WRITE',applied:true,verified:true,committed:true,
            cloudWritten:false,baselineChanged:false,outboxChanged:false,checkpointRetained:false,backupRetained:true};
        });
      }catch(_){return {...status(committed?'NOTE-ONLY APPLY COMMITTED — VERIFICATION INCOMPLETE; INSPECT RECOVERY':
        backedUp?'STOPPED — COMPATIBILITY BACKUP/CHECKPOINT RETAINED; NOTES NOT REPLACED':'BLOCKED — NOTE-ONLY APPLY NOT STARTED'),
        committed,backupRetained:backedUp,checkpointRetained:backedUp&&!cleaned};
      }finally{busy=false}
    }
    async function readCheckpoint() {
      return new Promise((resolve,reject)=>{try{const t=io.database.transaction('syncmeta','readonly'),q=t.objectStore('syncmeta').get(KEY);
        q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(Error());t.onabort=()=>reject(Error());
      }catch(_){reject(Error())}});
    }
    async function validateBundle(cp,backup) {
      if(cp?.version!==VERSION||cp.kind!=='manual-note-compatibility-apply'||!owned(cp.owner)||!['prepared','applied'].includes(cp.phase))throw Error();
      const b=await build(cp.evidence);
      if(b.noChange||!eq(cp,{...b.cp,phase:cp.phase})||!eq(backup,backupFor(cp)))throw Error();return b;
    }
    async function inspectRecovery() {
      try {
        const cp=await readCheckpoint();if(!cp)return {present:false,status:'NO NOTE-ONLY COMPATIBILITY RECOVERY CHECKPOINT'};
        if(!owned(cp.owner)||!uuid(cp.operationId)||cp.backupKey!==PREFIX+cp.operationId)throw Error();
        const values=await transaction('readonly',cp.backupKey,()=>{}),[baseline,active,test,demo,pull,entries,state,backup]=values;
        const b=await validateBundle(cp,backup),memory=JSON.stringify(io.getState()),ls=io.readLocalStorage();
        const nonNote=x=>Object.fromEntries(Object.entries(x).filter(([k])=>!['_mt','notes'].includes(k)));
        const report={present:true,phase:cp.phase,backupVerified:true,baselineUnchanged:eq(baseline,cp.evidence.expectedBaseline),
          outboxEmpty:entries.length===0,otherRecoveryAbsent:!test&&!demo&&!pull,
          persistenceAgrees:state?.json===memory&&memory===ls,indexeddbOriginal:state?.json===cp.evidence.expectedLocalJson,
          indexeddbDesired:state?.json===cp.nextLocalJson,nonNoteStateUnchanged:eq(nonNote(JSON.parse(state.json)),nonNote(b.original)),
          cloudEvidence:'NOT CHECKED — local-only compatibility action'};
        await transaction('readonly',cp.backupKey,(_,latest)=>{
          const unchanged=values.every((v,i)=>v===undefined?latest[i]===undefined:latest[i]!==undefined&&eq(v,latest[i]));
          if(!unchanged||!current(cp.owner,state.json))throw Error();
        });
        const clean=owned(cp.owner)&&eq(active,cp)&&report.baselineUnchanged&&report.outboxEmpty&&report.otherRecoveryAbsent&&report.persistenceAgrees&&report.nonNoteStateUnchanged;
        report.status=clean&&cp.phase==='applied'&&report.indexeddbDesired?'NOTE-ONLY DATA VERIFIED — CHECKPOINT RETAINED; REVIEW REQUIRED':
          clean&&cp.phase==='prepared'&&report.indexeddbOriginal?'NOT APPLIED — BACKUP RETAINED; REVIEW REQUIRED':'BLOCKED — NOTE-ONLY RECOVERY REQUIRES REVIEW';
        return report;
      }catch(_){return {present:true,backupVerified:false,status:'BLOCKED — NOTE-ONLY COMPATIBILITY RECOVERY NOT PROVEN'}}
    }
    async function exportRecovery() {
      try {
        const cp=await readCheckpoint();if(!cp||!owned(cp.owner)||cp.backupKey!==PREFIX+cp.operationId)throw Error();
        const values=await transaction('readonly',cp.backupKey,()=>{}),backup=values[7];await validateBundle(cp,backup);
        if(!eq(values[1],cp)||!owned(cp.owner))throw Error();
        return {exported:true,privateJson:JSON.stringify({format:'cap-note-compat-recovery-v1',checkpoint:cp,backup})};
      }catch(_){return {exported:false,status:'BLOCKED — PRIVATE NOTE-ONLY RECOVERY EXPORT NOT VERIFIED'}}
    }
    async function inspectExport(privateJson) {
      try {
        const b=JSON.parse(privateJson);if(!object(b)||Object.keys(b).sort().join(',')!=='backup,checkpoint,format'||b.format!=='cap-note-compat-recovery-v1')throw Error();
        await validateBundle(b.checkpoint,b.backup);if(!owned(b.checkpoint.owner))throw Error();
        return {valid:true,status:'PRIVATE NOTE-ONLY BUNDLE VERIFIED — NO IMPORT OR RESTORE PERFORMED'};
      }catch(_){return {valid:false,status:'BLOCKED — PRIVATE NOTE-ONLY BUNDLE INVALID OR NOT OWNED'}}
    }
    return Object.freeze({preview,apply,inspectRecovery,exportRecovery,inspectExport});
  }
  const api=Object.freeze({create});
  if(typeof module==='object'&&module.exports)module.exports=api;else root.CapNotesTombstoneCompatApply=api;
})(globalThis);
