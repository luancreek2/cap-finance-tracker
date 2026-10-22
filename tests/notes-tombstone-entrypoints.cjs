/* Composition rehearsal of REAL app definitions in isolated VMs/fake IDB.
   Never boots a page, touches real localStorage, opens a network, or applies
   changes to the user's app. Guarded paths here are previews, NOT live wiring. */
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const fake = require(process.env.CAP_FAKE_IDB_PATH || 'fake-indexeddb');
const app = fs.readFileSync(`${__dirname}/../js/app.js`, 'utf8'), clone = x => JSON.parse(JSON.stringify(x));
const owner = 'owner-secret', id = '00000000-0000-4000-8000-000000000011', op = '00000000-0000-4000-8000-000000000021';
const initial = () => ({ _mt: 10, notes: [{ id: 1, t: 'title-secret', b: 'body-secret', d: '2026-10-20' }],
  accts: [{ id: 9, name: 'Synthetic account', type: 'debit', bal: 100 }], tx: [], pend: [], xfer: [], bills: [], goals: [], debts: [], budgets: {}, cur: 'PHP', customSettings: { retain: true } });
function financial(s) { return JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => !['_mt','notes','noteTombstones'].includes(k)))); }
function safe(r) {
  const { privateNotes, privateJson, ...diagnostic } = r;
  assert.ok(!/owner-secret|title-secret|body-secret|00000000-0000-4000-8000-000000000011/.test(JSON.stringify(diagnostic)));
}
async function fixture() {
  const f = { renders: 0, saves: 0, balanceApplies: 0, writes: 0, network: 0, downloads: [], owner, syncOff: true, storage: new Map() };
  const c = { crypto: webcrypto, TextEncoder, indexedDB: new fake.IDBFactory(), URLSearchParams, location: { search: '' },
    S: initial(), today: '2026-10-21', CATS: { Other: {} }, uid: () => 88,
    fetch: () => { f.network++; throw Error('No network in entrypoint rehearsal'); },
    localStorage: { getItem: k => f.storage.get(k) ?? null,
      setItem: (k,v) => { if (f.failPreBackup && k === 'pera_pre') throw Error('Injected backup failure'); f.writes++; f.storage.set(k,v); },
      removeItem: k => { f.writes++; f.storage.delete(k); } },
    render: () => { f.renders++; c.localStorage.setItem('pera', JSON.stringify(c.S)); },
    save: () => { f.saves++; c.localStorage.setItem('pera', JSON.stringify(c.S)); },
    bApply: (t, sign) => { f.balanceApplies++; c.S.accts.find(a => a.id === t.acct).bal += t.amt * sign; },
    $: () => ({ value: f.mode || 'merge' }), acct: id => c.S.accts.find(a => a.id === id),
    dl: (name, text, mime) => f.downloads.push({ name, text, mime }), closeS() {}, toast() {}, stGo() {},
  };
  c.window = c; vm.createContext(c);
  const offlineEnd = app.indexOf('  /* ---------- events ---------- */');
  const importStart = app.indexOf('function expJSON()'), importEnd = app.indexOf('function bindStaticEvents()', importStart);
  assert.ok(offlineEnd > 0 && importStart > offlineEnd && importEnd > importStart);
  // Test-only access to the actual private normalizer; source file unchanged.
  vm.runInContext(app.slice(0, offlineEnd) + 'window.__testNormalize = normalize;})();', c);
  vm.runInContext(app.slice(importStart, importEnd), c);
  for (const file of ['notes-tombstone-plan.js','notes-tombstone-local.js','notes-tombstone-compat.js','notes-tombstone-compat-apply.js'])
    vm.runInContext(fs.readFileSync(`${__dirname}/../js/${file}`, 'utf8'), c);
  f.c = c; f.compat = c.CapNotesTombstoneCompat; f.original = clone(c.S);
  const row = { id, user_id: owner, legacy_id: '1', title: c.S.notes[0].t, body: c.S.notes[0].b, note_date: c.S.notes[0].d };
  const fingerprint = createHash('sha256').update(JSON.stringify({ body: row.body, note_date: row.note_date, title: row.title })).digest('hex');
  const lifecycle = { version: 1, revision: 4, deleted_at: null, operation_id: null };
  f.evidence = { operationId: op, requestedAt: 20, localJson: JSON.stringify(c.S), snapshot: { version: 1, owner, syncOff: true, persisted: true,
    coverage: { complete: true, unrelatedUnchanged: true }, capabilities: { version: 'notes-lifecycle-v1', read: true, cas: true, bypassProtected: true },
    entries: [], checkpoints: { test: null, demo: null, pull: null, tombstone: null },
    baseline: { version: 2, user_id: owner, records: [{ entity: 'notes', localId: '1', supabase_id: id, user_id: owner, contentFingerprint: fingerprint, lifecycle }] },
    target: { entity: 'notes', localId: '1', supabase_id: id }, local: { kind: 'active', row: clone(row) }, cloud: { kind: 'row', row: clone(row), lifecycle: clone(lifecycle) } } };
  await c.CapOff.syncStore('syncmeta','put',f.evidence.snapshot.baseline,'baseline');
  await c.CapOff.syncStore('kv','put',{ json: JSON.stringify(c.S), mt: c.S._mt },'state');
  f.storage.set('pera', JSON.stringify(c.S));
  const request = c.indexedDB.open('cap-finance', 2);
  const db = await new Promise((resolve,reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  f.local = c.CapNotesTombstoneLocal.create({ database: db, planner: c.CapNotesTombstonePlan,
    getState: () => c.S, setState: s => { c.S = s; }, readLocalStorage: () => c.localStorage.getItem('pera'), writeLocalStorage: s => c.localStorage.setItem('pera',s),
    guard: uid => uid === f.owner && f.syncOff, withLock: async (name,run) => { assert.equal(name,'cap-controlled-notes-test'); return run(); } });
  f.action = { inspect: async () => clone(f.evidence), confirm: async () => true, readCloud: async () => clone(f.evidence.snapshot.cloud) };
  f.stage = async remote => {
    if (remote) f.evidence.snapshot.cloud.lifecycle = { version: 1, revision: 7, deleted_at: '2026-10-21T00:00:00.000Z', operation_id: 'remote-operation' };
    const p = await (remote ? f.local.previewRemote(f.evidence) : f.local.preview(f.evidence)); assert.equal(p.previewReady,true);
    const r = await (remote ? f.local.applyRemote(p.ticket,f.action) : f.local.stage(p.ticket,f.action)); assert.equal(r.verified,true);
    return clone(c.S);
  };
  f.rawImport = (incoming, mode) => { c.__plan = c.jsonPlan(JSON.stringify(incoming)); vm.runInContext('IMP = __plan;',c); f.mode = mode; c.impApply(); };
  f.previewImport = async (incoming, mode = 'merge') => {
    c.jsonPlan(JSON.stringify(incoming)); // Real legacy validation, no apply.
    // Preserve the ORIGINAL envelope: jsonPlan strips wrapper owner/version,
    // which must not bypass the lifecycle guard's independent validation.
    const r = await f.compat.planImport({ owner: f.owner, current: clone(c.S), incoming: clone(incoming), format: 'json', mode }); safe(r); return r;
  };
  f.prepareCompatApply = async incoming => {
    c.jsonPlan(JSON.stringify(incoming)); // Preserve original wrapper for the next guard.
    const evidence = { kind:'import',input:{owner:f.owner,current:clone(c.S),incoming:clone(incoming),format:'json',mode:'merge'},
      expectedLocalJson:JSON.stringify(c.S),expectedBaseline:await c.CapOff.syncStore('syncmeta','get','baseline'),
      operationId:'00000000-0000-4000-8000-000000000041',requestedAt:30,syncOff:true };
    const api = c.CapNotesTombstoneCompatApply.create({database:db,compat:f.compat,getState:()=>c.S,setState:s=>{c.S=s},
      readLocalStorage:()=>c.localStorage.getItem('pera'),writeLocalStorage:s=>c.localStorage.setItem('pera',s),
      guard:u=>u===f.owner&&f.syncOff,withLock:async(name,run)=>{assert.equal(name,'cap-controlled-notes-test');return run()}});
    return {api,evidence};
  };
  f.resetCounts = () => { f.renders = f.saves = f.balanceApplies = f.writes = 0; };
  return f;
}
let passed = 0;
async function test(label, run) { try { await run(); passed++; } catch (e) { e.message = label + ': ' + e.message; throw e; } }
function noApply(f) { assert.equal(f.renders,0); assert.equal(f.saves,0); assert.equal(f.balanceApplies,0); assert.equal(f.writes,0); assert.equal(f.network,0); }
(async () => {
  for (const remote of [false,true]) await test((remote ? 'remote apply' : 'local stage') + ' output passes compatibility inspection', async () => {
    const f = await fixture(), d = await f.stage(remote), r = await f.compat.inspect(d,owner); safe(r); assert.equal(r.valid,true); assert.equal(r.counts.tombstones,1);
    assert.equal(financial(d), financial(f.original)); assert.equal(f.network,0);
  });
  for (const remote of [false,true]) await test('real JSON export/parser round trip retains ' + (remote ? 'remote' : 'local') + ' evidence', async () => {
    const f = await fixture(), d = await f.stage(remote); f.resetCounts(); f.c.expJSON(); assert.equal(f.downloads.length,1);
    const file = f.downloads[0], parsed = f.c.jsonPlan(file.text);
    assert.equal(file.mime,'application/json'); assert.deepEqual(clone(parsed.d.noteTombstones),d.noteTombstones);
    const r = await f.compat.inspect(parsed.d,owner); safe(r); assert.equal(r.valid,true); noApply(f);
  });
  await test('actual normalizer preserves a valid sidecar without defaulting it away', async () => {
    const f = await fixture(), d = await f.stage(false), before = JSON.stringify(d); const normalized = f.c.__testNormalize(clone(d));
    assert.equal(JSON.stringify(normalized),before); assert.equal((await f.compat.inspect(normalized,owner)).valid,true);
  });
  await test('actual normalizer alone does not validate malformed deletion evidence', async () => {
    const f = await fixture(); const malformed = clone(f.original); malformed.notes=[]; malformed.noteTombstones={ wrong: true };
    const normalized = f.c.__testNormalize(malformed); assert.ok(normalized.noteTombstones.wrong);
    const r = await f.compat.inspect(normalized,owner); safe(r); assert.equal(r.valid,false);
  });
  await test('raw legacy replace can erase proof: regression fixture, not authorized behavior', async () => {
    const f = await fixture(); await f.stage(false); f.rawImport(f.original,'replace');
    assert.equal(f.c.S.noteTombstones,undefined); assert.equal(f.c.S.notes.length,1); assert.equal(f.network,0);
  });
  await test('raw legacy undo can erase proof: regression fixture, not authorized behavior', async () => {
    const f = await fixture(); await f.stage(false); f.storage.set('pera_pre',JSON.stringify(f.original)); f.c.impUndo();
    assert.equal(f.c.S.noteTombstones,undefined); assert.equal(f.c.S.notes.length,1); assert.equal(f.network,0);
  });
  await test('raw legacy importer swallows backup failure: verified-backup integration gate', async () => {
    const f = await fixture(); await f.stage(false); f.failPreBackup=true; f.rawImport(f.original,'replace');
    assert.equal(f.storage.has('pera_pre'),false); assert.equal(f.c.S.notes.length,1); assert.equal(f.network,0);
  });
  for (const mode of ['merge','replace','undo']) for (const remote of [false,true]) await test('real parser plus preview protects ' + mode + '/' + (remote ? 'remote' : 'local'), async () => {
    const f = await fixture(); const staged = await f.stage(remote); f.resetCounts(); const before = JSON.stringify(f.c.S), r = await f.previewImport(f.original,mode);
    assert.equal(r.previewReady,true); assert.equal(r.executable,false); assert.equal(r.privateNotes.notes.length,0);
    assert.deepEqual(clone(r.privateNotes.noteTombstones),staged.noteTombstones); assert.equal(JSON.stringify(f.c.S),before); noApply(f);
  });
  await test('actual JSON parser accepts foreign lifecycle data, compatibility refuses it', async () => {
    const f = await fixture(), d = await f.stage(true); d.noteTombstones[0].user_id='foreign';
    assert.ok(f.c.jsonPlan(JSON.stringify(d)).d.noteTombstones.length); f.resetCounts(); const r = await f.previewImport(d); assert.equal(r.previewReady,false); noApply(f);
  });
  await test('legacy parser unwrapping cannot bypass private backup owner checks', async () => {
    const f=await fixture(); await f.stage(false); f.resetCounts();
    const incoming={format:'cap-notes-lifecycle-backup-v1',owner:'foreign',data:clone(f.original)};
    assert.ok(f.c.jsonPlan(JSON.stringify(incoming)).d.accts);
    const r=await f.previewImport(incoming); assert.equal(r.previewReady,false); noApply(f);
  });
  await test('legacy parser unwrapping cannot bypass unknown wrapper/version checks', async () => {
    const f=await fixture(); await f.stage(false); f.resetCounts();
    for(const incoming of [{format:'unknown',data:clone(f.original)},{app:'cap-finance-tracker',version:'future',data:clone(f.original)}]) {
      assert.ok(f.c.jsonPlan(JSON.stringify(incoming)).d.accts); const r=await f.previewImport(incoming); assert.equal(r.previewReady,false);
    }
    noApply(f);
  });
  await test('real parser and compatibility accept a current owned private wrapper', async () => {
    const f=await fixture(); await f.stage(true); f.resetCounts();
    const exported=await f.compat.exportPrivate(clone(f.c.S),owner),r=await f.previewImport(JSON.parse(exported.privateJson));
    assert.equal(r.previewReady,true); assert.equal(r.privateNotes.noteTombstones.length,1); noApply(f);
  });
  await test('edited stale backup is blocked before any legacy apply or balance callback', async () => {
    const f = await fixture(); await f.stage(false); const d=clone(f.original); d.notes[0].b='edited after deletion'; f.resetCounts();
    const r = await f.previewImport(d,'replace'); assert.equal(r.classification,'CONFLICT'); noApply(f);
  });
  await test('real legacy merge erases baseline-only evidence; guarded proposal retains it', async () => {
    const f = await fixture(), base = await f.stage(false), a = clone(base), b = clone(base); delete a.noteTombstones; delete b.noteTombstones;
    const raw = f.c.CapOff.mergeDoc(base,a,b); assert.deepEqual(clone(raw.noteTombstones),[]);
    f.resetCounts(); const r = await f.compat.planMerge({ owner,base,local:a,remote:b }); safe(r); assert.equal(r.previewReady,true); assert.equal(r.privateNotes.noteTombstones.length,1); noApply(f);
  });
  await test('real edit-versus-delete merge creates coexistence; compatibility blocks instead', async () => {
    const f = await fixture(), base = clone(f.original), local = await f.stage(false), remote = clone(base); remote.notes[0].b='new remote edit'; remote.notes[0]._u=99;
    const raw = f.c.CapOff.mergeDoc(base,local,remote); assert.equal(raw.notes.length,1); assert.equal(raw.noteTombstones.length,1);
    f.resetCounts(); const r = await f.compat.planMerge({ owner,base,local,remote }); safe(r); assert.equal(r.classification,'CONFLICT'); assert.equal(r.privateNotes,undefined); noApply(f);
  });
  await test('real timestamp winner is not consumed as conflict authorization', async () => {
    const f = await fixture(), base=clone(f.original), local=clone(base), remote=clone(base); local.notes[0].b='local edit'; local.notes[0]._u=20; remote.notes[0].b='remote edit'; remote.notes[0]._u=100;
    const raw = f.c.CapOff.mergeDoc(base,local,remote); assert.equal(raw.notes[0].b,'remote edit');
    const r = await f.compat.planMerge({ owner,base,local,remote }); safe(r); assert.equal(r.classification,'CONFLICT'); noApply(f);
  });
  await test('actual CSV parser plus compatibility leaves notes, evidence, and balances untouched', async () => {
    const f = await fixture(); await f.stage(false); f.resetCounts(); const before=JSON.stringify(f.c.S);
    const parsed=f.c.csvPlan('date,amount,account,category,description\n2026-10-21,-1,Synthetic account,Other,Synthetic import'); assert.equal(parsed.ok.length,1);
    const r=await f.compat.planImport({owner,current:clone(f.c.S),incoming:clone(parsed),format:'csv',mode:'merge'}); safe(r);
    assert.equal(r.previewReady,true); assert.equal(r.privateNotes.accts,undefined); assert.equal(JSON.stringify(f.c.S),before); noApply(f);
  });
  await test('replace/undo omission of another active note blocks with existing tombstone retained', async () => {
    const f = await fixture(); await f.stage(true); f.c.S.notes.push({id:2,t:'Other',b:'Retain me',d:null}); f.resetCounts();
    for(const mode of ['replace','undo']) { const r=await f.previewImport({...clone(f.original),notes:[]},mode); assert.equal(r.classification,'MISSING_INTENT'); }
    assert.equal(f.c.S.notes.length,1); assert.equal(f.c.S.noteTombstones.length,1); noApply(f);
  });
  await test('full financial candidate is never returned as a guarded note proposal', async () => {
    const f = await fixture(); await f.stage(true); const d=clone(f.original); d.accts[0].bal=999; f.resetCounts();
    const r=await f.previewImport(d,'replace'); assert.equal(r.previewReady,true); assert.equal(r.privateNotes.accts,undefined);
    assert.equal(f.c.S.accts[0].bal,100); noApply(f);
  });
  await test('compatibility owner change prevents use of parser-approved sidecars', async () => {
    const f=await fixture(),d=await f.stage(false); f.owner='foreign'; f.resetCounts(); const r=await f.previewImport(d); assert.equal(r.previewReady,false); noApply(f);
  });
  await test('real parser plus atomic note-only adapter preserves acknowledged deletion and financial state',async()=>{
    const f=await fixture(),before=await f.stage(true),file=clone(f.original);file.notes.push({id:3,t:'New',b:'Synthetic addition',d:null});file.accts[0].bal=999;
    const {api,evidence}=await f.prepareCompatApply(file);f.resetCounts();const p=await api.preview(evidence);assert.equal(p.previewReady,true);
    const r=await api.apply(p.ticket,{inspect:async()=>clone(evidence),confirm:async()=>true});safe(r);assert.equal(r.verified,true);
    assert.deepEqual(clone(f.c.S.notes.map(n=>n.id)),[3]);assert.deepEqual(clone(f.c.S.noteTombstones),before.noteTombstones);
    assert.equal(financial(f.c.S),financial(before));assert.deepEqual(await f.c.CapOff.syncStore('syncmeta','get','baseline'),evidence.expectedBaseline);
    assert.equal(await f.c.CapOff.syncStore('syncmeta','get','manual-notes-tombstone-v1'),undefined);
    assert.equal(f.balanceApplies,0);assert.equal(f.renders,0);assert.equal(f.saves,0);assert.equal(f.network,0);
    f.c.expJSON();const parsed=f.c.jsonPlan(f.downloads[0].text);assert.equal((await f.compat.inspect(parsed.d,owner)).valid,true);
  });
  await test('pending local tombstone checkpoint blocks compatibility application without clearing it',async()=>{
    const f=await fixture();await f.stage(false);const checkpoint=clone(await f.c.CapOff.syncStore('syncmeta','get','manual-notes-tombstone-v1')),file=clone(f.original);
    file.notes.push({id:3,t:'New',b:'Synthetic addition',d:null});const{api,evidence}=await f.prepareCompatApply(file);f.resetCounts();const p=await api.preview(evidence);assert.equal(p.previewReady,true);
    let confirms=0;const r=await api.apply(p.ticket,{inspect:async()=>clone(evidence),confirm:async()=>{confirms++;return true}});safe(r);assert.equal(r.applied,false);assert.equal(confirms,0);
    assert.deepEqual(clone(await f.c.CapOff.syncStore('syncmeta','get','manual-notes-tombstone-v1')),checkpoint);noApply(f);
  });
  await test('atomic adapter retains original wrapper ownership after legacy parsing',async()=>{
    const f=await fixture();await f.stage(true);const file={format:'cap-notes-lifecycle-backup-v1',owner:'foreign',data:clone(f.original)};
    file.data.notes.push({id:3,t:'New',b:'Synthetic addition',d:null});const{api,evidence}=await f.prepareCompatApply(file);f.resetCounts();
    const r=await api.preview(evidence);safe(r);assert.equal(r.previewReady,false);noApply(f);
  });
  await test('live entry points and cached shell remain unwired', async () => {
    for(const file of ['index.html','service-worker.js','js/app.js']) assert.ok(!fs.readFileSync(`${__dirname}/../${file}`,'utf8').includes('CapNotesTombstoneCompat'));
  });
  console.log(`PASS: ${passed} real-definition tombstone entrypoint rehearsals; synthetic VM/fake IDB only`);
})().catch(error=>{console.error(error);process.exitCode=1});
