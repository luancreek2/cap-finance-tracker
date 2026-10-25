/* Executable fingerprint contract, not source-text verification. */
const assert=require('node:assert/strict');
const {fixture,clone}=require('./cloud-bootstrap.cjs');
(async()=>{
  const f=await fixture(),io=f.c.CapProductionSync.browserIO();
  const r=f.raw.records.find(r=>r.entity==='transactions').row;
  const hash=await io.hash('transactions',r),changed=clone(r);
  Object.assign(changed,{id:'other',user_id:'other',legacy_id:'other',metadata:{id:'other'},updated_at:'2030-01-01T00:00:00Z'});
  assert.equal(await io.hash('transactions',changed),hash);
  console.log('PASS identity, metadata and timestamps are excluded from content hash');
  changed.title='Changed semantic content';
  assert.notEqual(await io.hash('transactions',changed),hash);
  console.log('PASS semantic title change changes content hash');
  console.log('PASS: 2 executable fingerprint contract checks');
})().catch(e=>{console.error(e);process.exitCode=1;});
