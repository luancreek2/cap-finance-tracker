/* Actual browser adapters, fake DOM/IDB only. No real browser or Supabase. */
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const fake = require(process.env.CAP_FAKE_IDB_PATH || 'fake-indexeddb');
(async()=>{
  const events = new Map(), storage = new Map();let network=0,timers=0;
  const c = { indexedDB:new fake.IDBFactory(),crypto:webcrypto,TextEncoder,URLSearchParams,
    location:{search:''},S:{notes:Array.from({length:47},(_,i)=>({id:i+1,t:'synthetic',b:'fixture',d:''}))},
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
    document:{hidden:false,getElementById:()=>null,addEventListener:(name,fn)=>events.set(name,fn)},
    addEventListener:(name,fn)=>events.set(name,fn),clearTimeout(){},setTimeout(){timers++;},setInterval(){},
    navigator:{onLine:true,serviceWorker:{addEventListener:(name,fn)=>events.set('sw:'+name,fn)}},
    CapSupabase:{localIdentity:()=>{throw Error('OFF must not inspect identity');},currentUser:async()=>{network++;throw Error('Forbidden network');}},
    confirm:()=>false };
  c.window=c;vm.createContext(c);
  const app=fs.readFileSync(`${__dirname}/../js/app.js`,'utf8');
  vm.runInContext(app.slice(0,app.indexOf('  /* ---------- events ---------- */'))+'})();',c);
  vm.runInContext(fs.readFileSync(`${__dirname}/../js/sync.js`,'utf8'),c);
  const baseline={version:2,user_id:'fixture-owner',records:Array.from({length:47},(_,i)=>({entity:'notes',localId:String(i+1),supabase_id:'fixture-'+i,contentFingerprint:'a'.repeat(64),user_id:'fixture-owner'}))};
  await c.CapOff.syncStore('syncmeta','put',baseline,'baseline');
  await c.CapOff.syncStore('kv','put',{json:JSON.stringify(c.S),mt:0},'state');
  storage.set('pera',JSON.stringify(c.S));
  const before=JSON.stringify(await c.CapOff.productionSyncSnapshot()),state=JSON.stringify(c.S);
  vm.runInContext(fs.readFileSync(`${__dirname}/../js/sync-production.js`,'utf8'),c);
  await events.get('DOMContentLoaded')();
  assert.equal(JSON.stringify(await c.CapOff.productionSyncSnapshot()),before);assert.equal(JSON.stringify(c.S),state);
  assert.equal(c.CapProductionSync.status().enabled,false);assert.equal(network,0);assert.equal(timers,0);
  for(const event of ['online','pageshow','visibilitychange'])events.get(event)();
  await c.CapOff.sync();assert.equal(network,0);assert.equal(timers,0);
  const html=c.CapSync.settingsHtml();assert.ok(html.includes('production-sync-toggle'));assert.ok(html.includes('role="switch"'));
  assert.ok(html.includes('Cloud Sync: OFF'));assert.ok(!html.includes('<b>Cloud Sync: OFF</b>'));
  await c.CapProductionSync.toggle();assert.equal(JSON.stringify(await c.CapOff.productionSyncSnapshot()),before);assert.equal(network,0);
  const sw=fs.readFileSync(`${__dirname}/../service-worker.js`,'utf8');assert.ok(sw.includes('./js/sync-production.js'));
  console.log('PASS: 5 production browser-wiring checks; 47 synthetic records untouched, OFF causes zero network/metadata mutations');
})().catch(e=>{console.error(e);process.exitCode=1;});
