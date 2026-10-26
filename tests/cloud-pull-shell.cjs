/* Execute actual worker install/cache/offline script handlers, local bytes only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
(async()=>{
  const root=path.resolve(__dirname,'..'),events=new Map(),stored=new Map();let cacheName,install;
  const cache={add:async req=>{const file=path.join(root,req.url.replace(/^\.\//,''));stored.set(req.url,fs.readFileSync(file));},
    match:async req=>{const key=typeof req==='string'?req:'./'+new URL(req.url).pathname.slice(1);const b=stored.get(key);return b?{ok:true,text:async()=>b.toString()}:null;}};
  const c={URL,Request:class{constructor(url){this.url=url;}},Response:{error:()=>{throw Error('Unexpected cache miss');}},
    caches:{open:async name=>{cacheName=name;return cache;}},fetch:async()=>{throw Error('Offline');},
    self:{location:{origin:'https://synthetic.invalid'},skipWaiting:async()=>{},addEventListener:(n,fn)=>events.set(n,fn)}};
  vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(root,'service-worker.js'),'utf8'),c);
  events.get('install')({waitUntil:p=>{install=p;}});await install;assert.equal(cacheName,'cap-shell-v352');
  const html=stored.get('./index.html').toString();
  for(const name of ['cloud-to-local','cloud-bootstrap','sync-production']){
    const asset='./js/'+name+'.js';assert.ok(stored.has(asset));assert.ok(html.includes('src="'+asset.slice(2)+'"'));
    let response;events.get('fetch')({request:{method:'GET',url:'https://synthetic.invalid/'+asset.slice(2),destination:'script'},respondWith:p=>{response=p;}});
    const res=await response;assert.ok(res.ok);new vm.Script(await res.text(),{filename:asset});
  }
  assert.ok(html.indexOf('src="js/cloud-to-local.js"')<html.indexOf('src="js/cloud-bootstrap.js"'));
  assert.ok(html.indexOf('src="js/cloud-to-local.js"')<html.indexOf('src="js/sync-production.js"'));
  console.log('PASS: 5 Phase 6O shell cache/load checks; actual worker handlers, synthetic offline transport');
})().catch(e=>{console.error(e);process.exitCode=1;});
