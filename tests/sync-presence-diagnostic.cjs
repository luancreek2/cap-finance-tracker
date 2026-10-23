/* Verify the Sync Presence diagnostic is properly exported on the production
   CapProductionSync object. Static checks only; no network or credentials. */
const assert=require('node:assert/strict'),fs=require('node:fs');
const read=p=>fs.readFileSync(`${__dirname}/../${p}`,'utf8');
const app=read('js/app.js'),sync=read('js/sync-production.js');
let passed=0;
const test=async(name,fn)=>{try{await fn();passed++;console.log('PASS '+name);}catch(e){e.message=name+': '+e.message;throw e;}};
(async()=>{
  // Static check: sync-production.js exports inspectSyncPresence on the api object
  await test('sync-production.js exports inspectSyncPresence on api',()=>{
    assert.match(sync,/api\.inspectSyncPresence\s*=\s*inspectSyncPresence/);
    assert.ok(sync.includes('inspectSyncPresence') && sync.includes('const api ='));
  });
  // Static check: app.js wires the UI button correctly
  await test('app.js wires Inspect Sync Presence button correctly',()=>{
    assert.match(app,/onclick="inspectSyncPresence\(\)"/);
    assert.match(app,/Inspect Sync Presence/);
    assert.match(app,/function inspectSyncPresence\(\)/);
  });
  await test('diagnostic reuses only the existing production read adapter',()=>{
    const diagnostic=sync.slice(sync.indexOf('  async function inspectSyncPresence()'),sync.indexOf('  api.inspectSyncPresence ='));
    assert.match(diagnostic,/const io = browserIO\(\)/);
    for(const name of ['snapshot','model','remote'])assert.ok(diagnostic.includes('io.'+name+'('));
    assert.doesNotMatch(diagnostic,/CapOff\.(snapshot|model|validateSnapshot|syncStore)\(/);
    assert.doesNotMatch(diagnostic,/io\.(commit|write|authenticate|installLocal|rollbackLocal)\(/);
  });
  console.log(`PASS: ${passed} sync presence diagnostic wiring checks`);
})().catch(e=>{console.error(e);process.exitCode=1;});
