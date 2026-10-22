/* Synthetic memory only. Does not open the browser, app IndexedDB, Docker,
   Supabase, or any real-data file. node tests/sync-production.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const context = { crypto: webcrypto, TextEncoder, URLSearchParams, location: { search: '' },
  localStorage: { getItem: () => null }, document: {} };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(`${__dirname}/../js/sync.js`, 'utf8'), context);
vm.runInContext(fs.readFileSync(`${__dirname}/../js/sync-production.js`, 'utf8'), context);
const { createEngine, ready, validateSnapshot } = context.CapProductionSync;
const clone = x => JSON.parse(JSON.stringify(x));
const hash = context.CapSync.fingerprintRow;
const owner = 'synthetic-owner';
const entities = ['profiles', 'user_preferences', 'categories', 'accounts', 'goals', 'debts',
  'bills', 'account_statements', 'transactions', 'transfers', 'bill_payments', 'budgets', 'notes'];
const note = { entity: 'notes', localId: '1', lifecycle: { version: 1, revision: 1, deleted_at: null, operation_id: null },
  row: { id: 'note-1', user_id: owner, legacy_id: '1', title: 'Synthetic', body: 'base', note_date: null } };
const readyChecks = Object.fromEntries(['snapshot_contract', 'snapshot_read_access', 'readiness_contract',
  'transaction_create_contract', 'durable_receipts', 'notes_receipts', 'notes_sidecar',
  'rpc_only_reads', 'legacy_lockout', 'writer_privileges', 'service_role_private'].map(k => [k, true]));
const readyContracts = { readiness: 'CAP_PRODUCTION_SYNC_READINESS_V1', snapshot: 'CAP_SYNC_SNAPSHOT_V1',
  transaction_create: 'CAP_TX_CREATE_CAS_RECEIPT_V1', notes_change: 'CAP_NOTES_SIDECAR_V1' };
const readyReport = { version: 'CAP_PRODUCTION_SYNC_V1', ready: true, legacy_lockout: true,
  private_sidecar: true, rpc_only_reads: true, writer_bypassrls: false,
  atomic_transaction_create: true, durable_operation_receipts: true,
  checks: readyChecks, contracts: readyContracts };
const snapshotCounts = () => Object.fromEntries(entities.map(e => [e, e === 'notes' ? 1 : 0]));
const snapshotReport = () => ({ version: 'CAP_SYNC_SNAPSHOT_V1', owner, complete: true,
  record_count: 1, counts: snapshotCounts(), records: [clone(note)] });

async function fixture(records = [note]) {
  let sequence = 0, clock = Date.parse('2026-10-21T00:00:00Z'), chain = Promise.resolve();
  const f = { records: clone(records), remote: clone(records), online: true, generation: 1,
    owner, writes: 0, commits: 0, authReads: 0, readinessReads: 0, remoteReads: 0, receipts: [],
    report: clone(readyReport), throwAfterApply: false, mutateOnWrite: null, installFail: false };
  const baseline = { version: 2, user_id: owner, revision: 0, records: [] };
  for (const r of records) baseline.records.push({ entity: r.entity, localId: r.localId,
    supabase_id: r.row.id || r.row.user_id, user_id: owner, contentFingerprint: await hash(r.entity,r.row) });
  const json = () => JSON.stringify(f.records);
  f.s = { settings: null, baseline, journal: null, recovery: [null,null,null],
    state: { json: json(), mt: 0 }, outbox: [], conflicts: [] };
  const applied = new Map();
  f.io = {
    snapshot: async () => clone(f.s), localJson: json, localOwner: () => f.owner,
    sessionGeneration: () => f.generation, hash,
    model: () => ({ json: json(), mt: 0, records: clone(f.records) }),
    uuid: () => 'synthetic-op-' + (++sequence), now: () => new Date(clock).toISOString(), jitter: () => 0,
    online: () => f.online,
    authenticate: async () => { f.authReads++; return { id: f.owner }; },
    readiness: async () => { f.readinessReads++; return clone(f.report); },
    remote: async () => { f.remoteReads++; return clone(f.remote); },
    commit: async (expected,patch,guard) => {
      assert.equal(JSON.stringify(expected), JSON.stringify(f.s), 'compare-and-commit snapshot');
      assert.equal(guard(), true, 'local synchronous generation guard');
      f.commits++;
      for (const k of ['settings','baseline','journal','state']) if (Object.hasOwn(patch,k)) f.s[k] = clone(patch[k]);
      for (const e of patch.putEntries || []) { const i = f.s.outbox.findIndex(x=>x.id===e.id); if(i<0)f.s.outbox.push(clone(e));else f.s.outbox[i]=clone(e); }
      f.s.outbox = f.s.outbox.filter(e=>!(patch.removeEntries||[]).includes(e.id));
      f.s.conflicts.push(...clone(patch.putConflicts||[]));
      if (patch.receipt) f.receipts.push(clone(patch.receipt));
    },
    lock: fn => { const result = chain.then(fn); chain = result.catch(()=>{}); return result; },
    write: async group => {
      f.writes++;
      if (f.mutateOnWrite) await f.mutateOnWrite(group);
      if (applied.has(group.operationId)) return { status: 'ALREADY_APPLIED' };
      for (const item of group.items) {
        const i = f.remote.findIndex(r=>r.entity===item.local.entity&&(r.row.id||r.row.user_id)===(item.local.row.id||item.local.row.user_id));
        if (item.cloud && (i<0 || await hash(item.cloud.entity,f.remote[i].row)!==item.cloudHash)) return { status: 'CONFLICT' };
        if (!item.cloud && i>=0) return { status: 'CONFLICT' };
      }
      for (const item of group.items) {
        const i = f.remote.findIndex(r=>r.entity===item.local.entity&&r.row.id===item.local.row.id);
        const row = clone(item.local);
        if (i<0)f.remote.push(row);else f.remote[i]=row;
      }
      applied.set(group.operationId,true);
      if(f.throwAfterApply){f.throwAfterApply=false;throw Error('private backend details must not be logged');}
      return { status: 'APPLIED' };
    },
    pullModel: (model,items) => {
      const next = JSON.parse(model.json);
      for(const item of items){const i=next.findIndex(r=>r.entity===item.local.entity&&r.row.id===item.local.row.id);next[i]=clone(item.cloud);}
      return {json:JSON.stringify(next),mt:0};
    },
    installLocal: (next,expected) => {if(f.installFail)throw Error('synthetic install failure');assert.equal(json(),expected);f.records=JSON.parse(next);}
  };
  f.engine = createEngine(f.io);
  f.enable = async () => {await f.engine.boot();await f.engine.setEnabled(true);};
  f.advance = () => {clock += 3600000;};
  return f;
}

let passed = 0;
async function test(name,run){try{await run();passed++;}catch(e){e.message=name+': '+e.message;throw e;}}
(async()=>{
  await test('default OFF is strictly read-only',async()=>{
    const f=await fixture(),before=JSON.stringify(f.s);
    await f.engine.boot();await f.engine.cycle();
    assert.equal(f.engine.status().enabled,false);assert.equal(JSON.stringify(f.s),before);
    assert.equal(f.commits+f.authReads+f.remoteReads+f.readinessReads+f.writes,0);
  });
  await test('old verifier cannot enable production',async()=>{
    const f=await fixture();f.report={ready:true,version:'CAP_PHASE_6K2A_V1'};
    await assert.rejects(f.enable(),/SERVER_NOT_READY/);assert.equal(f.commits,0);assert.equal(f.writes,0);
    for(const flag of ['legacy_lockout','private_sidecar','rpc_only_reads','atomic_transaction_create','durable_operation_receipts'])assert.equal(ready({...readyReport,[flag]:false}),false);
    assert.equal(ready({...readyReport,writer_bypassrls:true}),false);
    assert.equal(ready({...readyReport,checks:{...readyChecks,legacy_lockout:false}}),false);
    assert.equal(ready({...readyReport,checks:{...readyChecks,extra:true}}),false);
    assert.equal(ready({...readyReport,contracts:{...readyContracts,snapshot:'OLD_SNAPSHOT'}}),false);
    const missing=clone(readyChecks);delete missing.notes_sidecar;
    assert.equal(ready({...readyReport,checks:missing}),false);
  });
  await test('snapshot metadata must prove every entity and exact count',async()=>{
    assert.equal(validateSnapshot(snapshotReport(),owner).length,1);
    for(const bad of [
      {...snapshotReport(),record_count:2},
      {...snapshotReport(),counts:{...snapshotCounts(),notes:0}},
      {...snapshotReport(),records:[]},
      {...snapshotReport(),owner:'other-owner'},
      {...snapshotReport(),counts:{...snapshotCounts(),extra:1}},
      {...snapshotReport(),counts:{...snapshotCounts(),accounts:1,notes:0}},
      {...snapshotReport(),records:[{...clone(note),row:{...clone(note.row),user_id:'foreign'}}]}
    ]) assert.throws(()=>validateSnapshot(bad,owner),/REMOTE_SNAPSHOT_INCOMPLETE|SNAPSHOT_OWNERSHIP_INVALID/);
  });
  await test('enable persists preference only; boot resumes without recreating baseline',async()=>{
    const f=await fixture(),b=JSON.stringify(f.s.baseline);await f.enable();
    assert.equal(f.s.settings.enabled,true);assert.equal(JSON.stringify(f.s.baseline),b);assert.equal(f.writes,0);
    const next=createEngine(f.io);await next.boot();assert.equal(next.status().enabled,true);
  });
  await test('offline edits are durable without network reads',async()=>{
    const f=await fixture();await f.enable();f.online=false;f.records[0].row.body='offline edit';
    const reads=f.authReads+f.readinessReads+f.remoteReads;await f.engine.cycle();
    assert.equal(f.s.outbox.length,1);assert.equal(f.s.state.json,JSON.stringify(f.records));
    assert.equal(f.authReads+f.readinessReads+f.remoteReads,reads);assert.equal(f.writes,0);
    await f.engine.cycle();assert.equal(f.s.outbox.length,1);
  });
  await test('reconnect pushes CAS and acknowledges exact entry atomically',async()=>{
    const f=await fixture();await f.enable();f.online=false;f.records[0].row.body='offline edit';await f.engine.cycle();
    f.online=true;await f.engine.cycle();assert.equal(f.writes,1);assert.equal(f.s.outbox.length,0);
    assert.equal(f.s.journal,null);assert.equal(f.s.baseline.records[0].contentFingerprint,await hash('notes',f.records[0].row));assert.equal(f.receipts.length,1);
  });
  await test('uncertain response replays same operation without duplicate effect',async()=>{
    const f=await fixture();await f.enable();f.records[0].row.body='uncertain';f.throwAfterApply=true;await f.engine.cycle();
    const id=f.s.journal.group.operationId;assert.equal(f.s.outbox.length,1);assert.equal(f.s.baseline.revision,0);
    assert.equal(f.engine.status().reason,'RECOVERABLE_FAILURE');f.advance();await f.engine.cycle();
    assert.equal(f.s.outbox.length,0);assert.equal(f.receipts[0].id,id);assert.equal(f.writes,2);
  });
  await test('simultaneous edits retain all versions and stop automatic writes',async()=>{
    const f=await fixture();await f.enable();f.records[0].row.body='local';f.remote[0].row.body='cloud';const b=JSON.stringify(f.s.baseline);
    await f.engine.cycle();assert.equal(f.writes,0);assert.equal(f.s.conflicts.length,1);assert.equal(f.s.outbox.length,1);
    assert.equal(JSON.stringify(f.s.baseline),b);assert.equal(f.s.conflicts[0].local.row.body,'local');assert.equal(f.s.conflicts[0].cloud.row.body,'cloud');
  });
  await test('server CAS rejection retains the journal, queue and baseline',async()=>{
    const f=await fixture();await f.enable();f.records[0].row.body='local';
    f.mutateOnWrite=()=>{f.remote[0].row.body='raced';};await f.engine.cycle();
    assert.equal(f.engine.status().reason,'SERVER_CONFLICT');assert.equal(f.s.outbox.length,1);assert.ok(f.s.journal);assert.equal(f.s.baseline.revision,0);
  });
  await test('verified note pull commits backup/local state/baseline together',async()=>{
    const f=await fixture();await f.enable();f.remote[0].row.body='remote edit';await f.engine.cycle();
    assert.equal(f.writes,0);assert.equal(f.records[0].row.body,'remote edit');assert.equal(f.s.journal,null);assert.equal(f.receipts[0].kind,'pull-backup');assert.equal(f.s.baseline.revision,1);
  });
  await test('interrupted local pull keeps a recovery journal and backup',async()=>{
    const f=await fixture();await f.enable();f.remote[0].row.body='remote edit';f.installFail=true;await f.engine.cycle();
    assert.equal(f.s.journal.kind,'local-pull');assert.equal(f.records[0].row.body,'base');assert.equal(f.receipts[0].kind,'pull-backup');
    f.advance();await f.engine.cycle();assert.equal(f.engine.status().reason,'LOCAL_PULL_RECOVERY_REQUIRED');assert.equal(f.writes,0);
  });
  await test('deletes and missing cloud records never become physical DELETEs',async()=>{
    for(const side of ['local','cloud']){const f=await fixture();await f.enable();if(side==='local')f.records=[];else f.remote=[];
      await f.engine.cycle();assert.equal(f.writes,0);assert.equal(f.s.baseline.revision,0);assert.equal(f.engine.status().reason,'PRESENCE_CHANGE_REQUIRES_REVIEW');}
  });
  await test('foreign account and missing baseline cannot enable',async()=>{
    const f=await fixture();f.owner='another-owner';await assert.rejects(f.enable(),/BASELINE_INVALID/);assert.equal(f.writes+f.commits,0);
    const g=await fixture();g.s.baseline=null;await assert.rejects(g.enable(),/BASELINE_INVALID/);assert.equal(g.commits,0);
  });
  await test('OFF works offline and does not clear queued work',async()=>{
    const f=await fixture();await f.enable();f.online=false;f.records[0].row.body='offline';await f.engine.cycle();
    const before=JSON.stringify([f.s.baseline,f.s.outbox]);await f.engine.setEnabled(false);await f.engine.cycle();
    assert.equal(f.s.settings.enabled,false);assert.equal(JSON.stringify([f.s.baseline,f.s.outbox]),before);assert.equal(f.writes,0);
  });
  await test('changing authentication during a write prevents acknowledgement',async()=>{
    const f=await fixture();await f.enable();f.records[0].row.body='edit';f.mutateOnWrite=()=>{f.generation++;};
    await f.engine.cycle();assert.equal(f.s.baseline.revision,0);assert.equal(f.s.outbox.length,1);assert.ok(f.s.journal);
  });
  await test('cross-tab pause cannot overwrite a newer local snapshot',async()=>{
    const f=await fixture();await f.enable();f.records[0].row.body='edit';f.engine.pause('OTHER_TAB_CHANGED');
    await f.engine.cycle();assert.equal(f.commits,1);assert.equal(f.writes,0);assert.equal(f.engine.status().reason,'OTHER_TAB_CHANGED');
  });
  await test('unsupported entity change is queued but never written',async()=>{
    const debt={entity:'debts',localId:'2',row:{id:'d',user_id:owner,legacy_id:'2',amount:1}};
    const f=await fixture([note,debt]);await f.enable();f.records[1].row.amount=2;f.records[0].row.body='edit';await f.engine.cycle();
    assert.equal(f.writes,0);assert.equal(f.s.outbox.length,2);assert.equal(f.engine.status().reason,'UNSUPPORTED_WRITE');
  });
  await test('atomic transaction group is not split into account upserts',async()=>{
    const account={entity:'accounts',localId:'2',row:{id:'a',user_id:owner,legacy_id:'2',account_type:'cash',balance:100}};
    const tx={entity:'transactions',localId:'3',row:{id:'tx',user_id:owner,legacy_id:'3',account_id:'a',amount:-5,status:'posted',metadata:{}}};
    const f=await fixture([account]);await f.enable();f.records[0].row.balance=95;f.records.push(tx);await f.engine.cycle();
    assert.equal(f.writes,1);assert.equal(f.receipts[0].records.length,2);assert.equal(f.s.baseline.records.length,2);assert.equal(f.s.outbox.length,0);
    await f.engine.cycle();assert.equal(f.writes,1);
  });
  await test('account dependency mismatch cannot write either row',async()=>{
    const account={entity:'accounts',localId:'2',row:{id:'a',user_id:owner,legacy_id:'2',account_type:'cash',balance:100}};
    const f=await fixture([account]);await f.enable();f.records[0].row.balance=90;f.records.push({entity:'transactions',localId:'3',row:{id:'tx',user_id:owner,account_id:'a',amount:-5,status:'posted'}});
    await f.engine.cycle();assert.equal(f.writes,0);assert.equal(f.engine.status().reason,'ACCOUNT_DEPENDENCY_CONFLICT');
  });
  await test('multiple offline versions retained in verified private receipt',async()=>{
    const f=await fixture();await f.enable();f.online=false;
    f.records[0].row.body='first';await f.engine.cycle();f.records[0].row.body='second';await f.engine.cycle();
    assert.equal(f.s.outbox.length,2);f.online=true;await f.engine.cycle();
    assert.equal(f.writes,1);assert.equal(f.s.outbox.length,0);assert.equal(f.receipts[0].entries.length,2);
  });
  await test('concurrent wakeups serialize into one cloud mutation',async()=>{
    const f=await fixture();await f.enable();f.records[0].row.body='edit';await Promise.all([f.engine.cycle(),f.engine.cycle(),f.engine.cycle()]);assert.equal(f.writes,1);
  });
  await test('an offline edit reverted to baseline is acknowledged without a cloud write',async()=>{
    const f=await fixture();await f.enable();f.online=false;f.records[0].row.body='temporary';await f.engine.cycle();
    f.records[0].row.body='base';await f.engine.cycle();assert.equal(f.s.outbox.length,2);
    f.online=true;await f.engine.cycle();assert.equal(f.writes,0);assert.equal(f.s.outbox.length,0);assert.equal(f.receipts[0].entries.length,2);
  });
  await test('new edits remain queued while a conflict pauses cloud work',async()=>{
    const f=await fixture();await f.enable();f.records[0].row.body='local';f.remote[0].row.body='cloud';await f.engine.cycle();
    f.records[0].row.body='another local version';await f.engine.cycle();assert.equal(f.s.outbox.length,2);assert.equal(f.writes,0);
  });
  await test('OFF during an in-flight request fences acknowledgement and retains evidence',async()=>{
    const f=await fixture();await f.enable();f.records[0].row.body='edit';let turningOff;
    f.mutateOnWrite=()=>{turningOff=f.engine.setEnabled(false);};await f.engine.cycle();await turningOff;
    assert.equal(f.s.settings.enabled,false);assert.equal(f.s.baseline.revision,0);assert.equal(f.s.outbox.length,1);assert.ok(f.s.journal);
  });
  await test('failed local acknowledgement never drops an applied operation',async()=>{
    const f=await fixture();await f.enable();f.records[0].row.body='edit';const original=f.io.commit;
    f.io.commit=async(s,p,g)=>{if(p.baseline)throw Error('synthetic storage failure');return original(s,p,g);};await f.engine.cycle();
    assert.equal(f.s.baseline.revision,0);assert.equal(f.s.outbox.length,1);assert.ok(f.s.journal);
    f.io.commit=original;f.advance();await f.engine.cycle();assert.equal(f.s.outbox.length,0);assert.equal(f.receipts.length,1);
  });
  await test('a tombstoned note is never treated as an ordinary active note',async()=>{
    const f=await fixture();await f.enable();f.remote[0].lifecycle.deleted_at='2026-10-21T00:00:00.000Z';
    await f.engine.cycle();assert.equal(f.writes,0);assert.equal(f.s.baseline.revision,0);assert.equal(f.engine.status().reason,'NOTE_LIFECYCLE_REQUIRES_REVIEW');
  });
  await test('two new transactions sharing an account cannot be split or double-counted',async()=>{
    const a={entity:'accounts',localId:'2',row:{id:'a',user_id:owner,account_type:'cash',balance:100}};
    const f=await fixture([a]);await f.enable();f.records[0].row.balance=90;
    for(const n of [3,4])f.records.push({entity:'transactions',localId:String(n),row:{id:'tx'+n,user_id:owner,account_id:'a',amount:-5,status:'posted'}});
    await f.engine.cycle();assert.equal(f.writes,0);assert.equal(f.s.outbox.length,3);assert.equal(f.engine.status().reason,'UNSUPPORTED_FINANCIAL_GROUP');
  });
  await test('foreign rows or incomplete snapshot failures cannot authorize writes',async()=>{
    const f=await fixture();await f.enable();f.records[0].row.body='edit';f.remote[0].row.user_id='other';await f.engine.cycle();
    assert.equal(f.writes,0);assert.equal(f.s.baseline.revision,0);assert.equal(f.engine.status().reason,'SNAPSHOT_OWNERSHIP_INVALID');
  });
  await test('a session/local edit changing during execution cannot be overwritten',async()=>{
    const f=await fixture();await f.enable();f.records[0].row.body='edit';f.mutateOnWrite=()=>{f.records[0].row.body='newer local';};
    await f.engine.cycle();assert.equal(f.records[0].row.body,'newer local');assert.equal(f.s.baseline.revision,0);assert.equal(f.s.outbox.length,1);assert.ok(f.s.journal);
  });
  await test('same-owner reenable resumes the retained offline queue',async()=>{
    const f=await fixture();await f.enable();f.online=false;f.records[0].row.body='queued';await f.engine.cycle();
    const id=f.s.outbox[0].id;await f.engine.setEnabled(false);f.online=true;await f.engine.setEnabled(true);await f.engine.cycle();
    assert.equal(f.writes,1);assert.equal(f.s.outbox.length,0);assert.equal(f.receipts[0].entries[0].id,id);
  });
  await test('same-owner reenable replays an OFF-mid-flight journal safely',async()=>{
    const f=await fixture();await f.enable();f.records[0].row.body='edit';let turningOff;
    f.mutateOnWrite=()=>{turningOff=f.engine.setEnabled(false);};await f.engine.cycle();await turningOff;
    const id=f.s.journal.group.operationId;f.mutateOnWrite=null;await f.engine.setEnabled(true);await f.engine.cycle();
    assert.equal(f.s.journal,null);assert.equal(f.s.outbox.length,0);assert.equal(f.receipts[0].id,id);
  });
  console.log(`PASS: ${passed} isolated production controller checks; no real data/network`);
})().catch(e=>{console.error(e);process.exitCode=1;});
