// Local-only, in-memory test keys. Deno tests run with NO --allow-net.
import assert from "node:assert/strict";
import { authorization, decode, encode, endpoint, fingerprint, payload, request, validateIdentity, verifyAuthorization,
  type Identity, type Payload, type Subscription } from "../../supabase/functions/cap-notification-sender/webpush.ts";
import { constructPayload, handler, processDue, validateRequest, PUBLIC_IDENTITIES } from "../../supabase/functions/cap-notification-sender/index.ts";
import { classify, retryAfter } from "../../supabase/functions/cap-notification-sender/results.ts";
import { databaseUrl, DATABASE_OPTIONS, type Operation, type Runtime } from "../../supabase/functions/cap-notification-sender/runtime.ts";

globalThis.fetch = () => Promise.reject(Error("UNMOCKED_NETWORK_FORBIDDEN"));
const id = () => crypto.randomUUID();
const example = (): Payload => ({ protocol: "CAP_PUSH_V1", type: "reminder", version: 1,
  installation_id: id(), binding_id: id(), generation: 1, expires_at: Math.floor(Date.now()/1000)+300 });
async function material(): Promise<{ identity: Identity; sub: Subscription; receiver: CryptoKeyPair }> {
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", vapid.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey));
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return { identity: { version: "v1", publicKey: encode(raw), privateKey: jwk.d!, fingerprint: await fingerprint(raw), subject: "https://contact.example.invalid/cap" },
    sub: { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-only", keys: {
      p256dh: encode(new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey))), auth: encode(crypto.getRandomValues(new Uint8Array(16))) } }, receiver };
}

Deno.test("webpush exact seven-field payload and bounds", () => {
  const p=example(); assert.ok(payload(p).length<=512);
  assert.deepEqual(Object.keys(JSON.parse(new TextDecoder().decode(payload(p)))).sort(),
    ["protocol","type","version","installation_id","binding_id","generation","expires_at"].sort());
  for(const key of Object.keys(p)){const x={...p} as Record<string,unknown>;delete x[key];assert.throws(()=>payload(x),/SENDER_VALIDATION_FAILED/)}
  for(const patch of [{extra:true},{protocol:"other"},{type:"payment"},{version:2},{installation_id:"invalid"},{binding_id:"invalid"},
    {generation:0},{generation:-1},{generation:Number.MAX_SAFE_INTEGER+1},{expires_at:1.5},{binding_id:"x".repeat(600)},
    {amount:12},{title:"injected"},{candidate_digest:"x"},{user_id:id()}]) assert.throws(()=>payload({...p,...patch}),/SENDER_VALIDATION_FAILED/);
  assert.ok(payload({...p,generation:Number.MAX_SAFE_INTEGER}).length<=512);
});
Deno.test("webpush private/public serialization and exact client fingerprint contract",async()=>{
  const m=await material();await validateIdentity(m.identity);assert.ok(decode(m.identity.privateKey,32).length===32);assert.ok(decode(m.identity.publicKey,65)[0]===4);
  assert.ok(await fingerprint(decode(m.identity.publicKey,65))===m.identity.fingerprint);
  const source=await Deno.readTextFile(new URL('../../js/vapid-public.js',import.meta.url));
  // Execute the actual frozen client validator without a browser or a key file.
  const w={} as {CapVapidPublic:{validate:(c:unknown)=>Promise<{ok:boolean}>}};
  new Function('window','crypto',source)(w,crypto);
  assert.ok((await w.CapVapidPublic.validate({version:'v1',publicKey:m.identity.publicKey,fingerprint:m.identity.fingerprint,createdAt:new Date().toISOString()})).ok);
  const other=await material();await assert.rejects(validateIdentity({...m.identity,privateKey:other.identity.privateKey}));
  await assert.rejects(validateIdentity({...m.identity,fingerprint:'0'.repeat(64)}));
});
Deno.test("webpush audience ES256 JWT 12h expiry for FCM Mozilla Apple Microsoft fixtures",async()=>{
  const m=await material();
  for(const e of ['https://fcm.googleapis.com/fcm/send/synthetic','https://updates.push.services.mozilla.com/wpush/v2/synthetic',
    'https://web.push.apple.com/synthetic','https://wns2-par02p.notify.windows.com/w/?token=synthetic']){
    const {authorization:h}=await authorization({...m.sub,endpoint:e},m.identity);
    await verifyAuthorization(h,new URL(e).origin,m.identity);
    const c=JSON.parse(atob(h.split('t=')[1].split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    assert.ok(c.aud===new URL(e).origin);assert.ok(c.exp> Date.now()/1000 && c.exp<=Date.now()/1000+86400);assert.ok(c.exp<=Date.now()/1000+43201);
    await assert.rejects(verifyAuthorization(h,'https://wrong.example.invalid',m.identity));
  }
});

async function decrypt(body: Uint8Array<ArrayBuffer>, m: Awaited<ReturnType<typeof material>>) {
  assert.equal(body[20],65);assert.equal(new DataView(body.buffer,body.byteOffset+16,4).getUint32(0),4096);
  const asPub=body.slice(21,86), uaPub=decode(m.sub.keys.p256dh,65);
  const key=await crypto.subtle.importKey('raw',asPub,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=await crypto.subtle.deriveBits({name:'ECDH',public:key},m.receiver.privateKey,256);
  const derive=async(ikm:ArrayBuffer,salt:Uint8Array<ArrayBuffer>,info:Uint8Array<ArrayBuffer>,bits:number)=>{
    const k=await crypto.subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']);return crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},k,bits);
  };
  const info=new Uint8Array([...new TextEncoder().encode('WebPush: info\0'),...uaPub,...asPub]);
  const ikm=await derive(shared,decode(m.sub.keys.auth,16),info,256);
  const cek=await derive(ikm,body.slice(0,16),new TextEncoder().encode('Content-Encoding: aes128gcm\0'),128);
  const iv=await derive(ikm,body.slice(0,16),new TextEncoder().encode('Content-Encoding: nonce\0'),96);
  const aes=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['decrypt']);
  const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv},aes,body.slice(86)));
  assert.equal(plain.at(-1),2);return new TextDecoder().decode(plain.slice(0,-1));
}
Deno.test("webpush aes128gcm interoperability fresh ECDH salt and VAPID separation; encrypted IDs absent",async()=>{
  const m=await material(),p=example(),h=(await authorization(m.sub,m.identity)).authorization;
  const one=await request(m.sub,p,h,60),two=await request(m.sub,p,h,60);
  const b1=one.body as Uint8Array<ArrayBuffer>,b2=two.body as Uint8Array<ArrayBuffer>;
  assert.equal((one.headers as Record<string,string>)['content-encoding'],'aes128gcm');assert.equal(one.redirect,'error');
  assert.ok(encode(b1.slice(0,16))!==encode(b2.slice(0,16)));assert.ok(encode(b1.slice(21,86))!==encode(b2.slice(21,86)));
  assert.ok(encode(b1.slice(21,86))!==m.identity.publicKey);assert.ok(await decrypt(b1,m)===JSON.stringify(p));
  assert.ok(!new TextDecoder().decode(b1).includes(p.binding_id));assert.ok(!new TextDecoder().decode(b1).includes(p.installation_id));
  await assert.rejects(request({...m.sub,keys:{...m.sub.keys,auth:'invalid'}},p,h,60));
  await assert.rejects(request(m.sub,p,h,0));
});
Deno.test("webpush endpoint allowlist rejects normalization bypasses and SSRF targets",()=>{
  for(const e of ['https://fcm.googleapis.com/fcm/send/synthetic','https://updates.push.services.mozilla.com/wpush/v2/synthetic',
    'https://web.push.apple.com/synthetic','https://wns2-par02p.notify.windows.com/w/?token=synthetic'])assert.ok(endpoint(e).provider);
  for(const e of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://[::1]/x','https://localhost/x','https://internal/x',
    'https://fcm.googleapis.com:443/x','https://u@fcm.googleapis.com/x','https://fcm.googleapis.com/x#fragment',
    'https://fcm.googleapis.com.evil.invalid/x','https://badpush.apple.com/x','https://notify.windows.com/x',
    'https://a.notify.windows.com.evil.invalid/x','https://a..push.apple.com/x','https://fcm.googleapis.com/%bad%'])assert.throws(()=>endpoint(e));
});

Deno.test("sender HTTP classifier conservative results and bounded provider reasons",async()=>{
  const c=async(status:number,provider:'fcm'|'mozilla'|'apple'|'microsoft'='fcm',body:unknown={},headers={})=>classify(new Response(JSON.stringify(body),{status,headers}),provider);
  assert.equal((await c(201)).result,'accepted');assert.equal((await c(202)).result,'accepted');assert.equal((await c(202)).stop,true);
  for(const n of [404,410])assert.equal((await c(n)).result,'invalid_subscription');
  for(const n of [400,401,403,405,413,415])assert.equal((await c(n)).result,'configuration');
  for(const n of [301,302,500,502,504])assert.equal((await c(n)).result,'ambiguous');
  assert.equal((await c(429,'fcm',{}, {'retry-after':'120'})).retryAfter,120);assert.equal((await c(429)).result,'ambiguous');
  assert.equal((await c(503,'mozilla',{errno:201})).result,'temporary_rejection');
  assert.equal((await c(503,'apple',{reason:'Shutdown'})).result,'temporary_rejection');
  assert.equal((await c(503,'microsoft',{reason:'Shutdown'})).result,'ambiguous');
  assert.equal((await c(503,'apple',{reason:'Shutdown',padding:'x'.repeat(3000)})).result,'ambiguous');
  assert.equal(retryAfter('-1',Date.now()),null);assert.equal(retryAfter('999999999999999999',Date.now()),null);
});

async function mockRun(mode='accepted') {
  const m=await material(),p=example(),calls:Operation[]=[];let sent=0,first=true,header:string|undefined;
  const runtime:Runtime={call:async(name,args)=>{calls.push(name);
    if(name==='begin_run_v1')return {ok:true,run_token:id()};
    if(name==='claim_v1'){if(!first)return {ok:false};first=false;return {ok:true,claim_token:id()};}
    if(name==='start_dispatch_v1'){
      if(mode==='commit-lost')throw Error('CANARY_SECRET_NEVER_LOG');if(mode==='denied')return {ok:false};
      return {ok:true,...p,ttl_seconds:300,vapid_key_version:'v1',endpoint:m.sub.endpoint,...m.sub.keys};
    }
    if(name==='vapid_token_get_v1')return header?{authorization:header}:{generation_token:id()};
    if(name==='vapid_token_put_v1'){header=args[1] as string;if(mode==='put-lost')throw Error('CANARY_SECRET_NEVER_LOG');return {ok:true};}
    if(name==='finalize_v1')return {state:args[1]==='accepted'?'accepted':args[1]==='ambiguous'?'unknown':'retired'};
    return {ok:true};}};
  const d={runtime,identities:[m.identity],now:Date.now,log:()=>{throw Error('UNEXPECTED_LOG')},fetch:(async(_url:unknown,init:RequestInit)=>{
    sent++;assert.ok(calls.includes('start_dispatch_v1'));assert.equal(init.redirect,'error');if(mode==='timeout')throw Error('CANARY_SECRET_NEVER_LOG');return new Response('',{status:201});}) as typeof fetch};
  return {d,p,calls,sent:()=>sent};
}
Deno.test("sender constructs fencing fields only from committed permit; no send without positive commit",async()=>{
  const m=await mockRun();const r=await processDue(m.d,id());assert.equal(r.counts.accepted,1);assert.equal(m.sent(),1);
  for(const mode of ['denied','commit-lost']){const x=await mockRun(mode);await processDue(x.d,id()).catch(()=>{});assert.equal(x.sent(),0);}
  const timeout=await mockRun('timeout');const result=await processDue(timeout.d,id());assert.equal(result.counts.unknown,1);assert.equal(timeout.sent(),1);
  const p=constructPayload({...example(),generation:'9007199254740991'});assert.equal(p.generation,Number.MAX_SAFE_INTEGER);
  assert.throws(()=>constructPayload({...example(),generation:'9007199254740992'}));
  assert.ok(!JSON.stringify(result).includes(timeout.p.binding_id));assert.ok(!JSON.stringify(result).includes(timeout.p.installation_id));
});
Deno.test("sender refuses startup with a mismatched identity before claim or network",async()=>{
  const m=await mockRun(),other=await material();
  await assert.rejects(processDue({...m.d,identities:[{...m.d.identities[0],privateKey:other.identity.privateKey}]},id()));
  assert.equal(m.calls.length,0);assert.equal(m.sent(),0);
});
Deno.test("sender re-reads after a lost VAPID put and never sends without the cached header",async()=>{
  const lost=await mockRun('put-lost');const r=await processDue(lost.d,id());
  assert.equal(r.counts.accepted,1);assert.equal(lost.sent(),1);
  assert.equal(lost.calls.filter(c=>c==='vapid_token_get_v1').length,2);
  assert.equal(lost.calls.filter(c=>c==='vapid_token_put_v1').length,1);
});
Deno.test("sender request rejects caller fencing overrides and any non-exact body",async()=>{
  const make=(body:unknown,headers:Record<string,string>={},method='POST',url='https://isolated.invalid/functions/v1/cap-notification-sender')=>
    new Request(url,{method,headers:{'content-type':'application/json',...headers},...(method==='GET'?{}:{body:JSON.stringify(body)})});
  assert.equal(await validateRequest(make({operation:'process-due-v1'})),0);
  for(const extra of ['installation_id','binding_id','generation','expires_at','endpoint','subscription','owner','payload','title','body','limit','vapid_key_version','dry_run'])
    assert.equal(await validateRequest(make({operation:'process-due-v1',[extra]:'injection'})),400);
  for(const value of [[],{},null,{operation:{}},{operation:['process-due-v1']}])assert.equal(await validateRequest(make(value)),400);
  for(const method of ['GET','PUT','PATCH','DELETE','OPTIONS'])assert.equal(await validateRequest(make({}, {},method)),405);
  assert.equal(await validateRequest(make({operation:'process-due-v1'},{origin:'https://browser.invalid'})),400);
  assert.equal(await validateRequest(make({}, {},'POST','https://isolated.invalid/?limit=1')),400);
  assert.equal(await validateRequest(make({padding:'x'.repeat(300)},{'content-length':'1'})),413);
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(257));c.close()}});
  assert.equal(await validateRequest(new Request('https://isolated.invalid/',{method:'POST',headers:{'content-type':'application/json'},body:stream})),413);
});
Deno.test("sender driver configuration is execution-only max1 no prepare/pipelining and pinned transaction host",()=>{
  assert.equal(DATABASE_OPTIONS.max,1);assert.equal(DATABASE_OPTIONS.prepare,false);assert.equal(DATABASE_OPTIONS.max_pipeline,1);
  const dsn=(user:string,pass:string,host:string,port:number,path='/postgres')=>['postgresql:','//',user,':',pass,'@',host,':',port,path].join('');
  databaseUrl(dsn('cap_notification_sender_login.synthetic','test','aws-0-synthetic.pooler.supabase.com',6543));
  for(const value of [dsn('postgres','test','db.example.invalid',5432),dsn('cap_notification_sender_login.synthetic','test','localhost',6543),
    dsn('cap_notification_sender_login.synthetic','test','aws-0-synthetic.pooler.supabase.com',5432)])assert.throws(()=>databaseUrl(value));
  assert.equal(Object.keys(PUBLIC_IDENTITIES).length,0);
});

Deno.test("sender remains dark: current shell v376 has no push handlers and public VAPID current is empty",async()=>{
  const root=new URL('../../',import.meta.url);
  const sw=await Deno.readTextFile(new URL('service-worker.js',root));
  assert.match(sw,/const VERSION = "cap-shell-v376"/);
  assert.ok(!/addEventListener\(\s*["']push["']/.test(sw));
  assert.ok(!/pushsubscriptionchange/.test(sw));
  const w={} as {CapVapidPublic:{current:()=>Record<string,unknown>}};
  new Function('window','crypto',await Deno.readTextFile(new URL('js/vapid-public.js',root)))(w,crypto);
  assert.deepEqual(w.CapVapidPublic.current(),{});
  assert.equal(Object.keys(PUBLIC_IDENTITIES).length,0);
  for(const file of ['index.ts','runtime.ts','results.ts','webpush.ts']){
    const source=(await Deno.readTextFile(new URL('supabase/functions/cap-notification-sender/'+file,root))).replace(/^\s*\/\/.*$/gm,'');
    assert.ok(!/from\s+["']node:|\brequire\s*\(|process\.env|SUPABASE_SERVICE_ROLE|SUPABASE_DB_URL|SUPABASE_ANON_KEY/.test(source),file);
  }
});

Deno.test("edge named secret authentication and redaction; dark config fails before Cap/database/network",async()=>{
  const invoke='sb_secret_'+id(),other='sb_secret_'+id(),pub='sb_publishable_'+id();
  Deno.env.set('SUPABASE_URL','https://isolated.example.invalid');Deno.env.set('SUPABASE_SECRET_KEYS',JSON.stringify({'cap-push-invoke':invoke,default:other}));
  Deno.env.set('SUPABASE_PUBLISHABLE_KEYS',JSON.stringify({default:pub}));
  const request=(key?:string)=>new Request('https://isolated.example.invalid/functions/v1/cap-notification-sender',{method:'POST',headers:{'content-type':'application/json',...(key?{apikey:key}:{})},body:'{"operation":"process-due-v1"}'});
  const captured:unknown[]=[];const logs=[console.log,console.error,console.warn];console.log=(...a)=>{captured.push(a)};console.error=(...a)=>{captured.push(a)};console.warn=(...a)=>{captured.push(a)};
  try{
    for(const key of [undefined,other,pub,'invalid']){const r=await handler(request(key));assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');const text=await r.text();assert.ok(!text.includes(String(key)));}
    const dark=await handler(request(invoke));assert.equal(dark.status,503);const text=await dark.text();assert.ok(!text.includes(invoke));assert.ok(!text.includes('endpoint'));assert.ok(!text.includes('binding_id'));assert.ok(!text.includes('installation_id'));
    assert.ok(captured.length===0);
  }finally{[console.log,console.error,console.warn]=logs;for(const n of ['SUPABASE_URL','SUPABASE_SECRET_KEYS','SUPABASE_PUBLISHABLE_KEYS'])Deno.env.delete(n);}
});
