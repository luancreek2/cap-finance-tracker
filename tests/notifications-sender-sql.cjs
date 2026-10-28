/* Disposable LOCAL PostgreSQL 17 only. No default server, Supabase or network push.
   CAP_SENDER_TEST_DATABASE_URL must name a fresh cap_notifications_synthetic_* DB.
   CAP_PG_PATH supplies an external pg installation; no repo dependency install. */
'use strict';
if(!process.env.CAP_SENDER_TEST_DATABASE_URL){
 require('./helpers/sender-pg.cjs').run(__filename).catch(()=>{console.error('Sender local PG fixture failed');process.exitCode=1});
 return;
}
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const artifact=read('supabase_notifications_sender_5b3.sql');
const hashes={
 'supabase_notifications_foundation.sql':'7126F10B3699F2A54B216A3045E92E5EF7CB3405C89BB25E80BCDB913BD9443B',
 'supabase_notifications_enrollment_5b2a1.sql':'CB597A5D1D47A90EEFF8B5E336C68540CC0A98B86DFBFB7693B79BADFF2A3364',
 'supabase_notifications_enrollment_5b2a1_v2.sql':'291AA08EBF3D867233235150DCCC5B038060E3DFC32D42C0B2DBB90FA6D444CA'};
let passed=0;const test=async(n,f)=>{try{await f()}catch(e){console.error('FAIL '+n);throw e}passed++;console.log('PASS '+n)};
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
let admin,installer,a,b;const clients=[];
const OPS=['begin_run_v1','claim_v1','start_dispatch_v1','finalize_v1','recover_v1','vapid_token_get_v1','vapid_token_put_v1'];
(async()=>{
 await test('frozen hashes; artifact is guarded, transactional, no password/extension/scheduler/financial DML',async()=>{
  for(const [f,h]of Object.entries(hashes))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex').toUpperCase(),h);
  assert.match(artifact,/reviewed-5b3b-v1/);assert.match(artifact,/^begin;$/m);assert.match(artifact,/commit;\s*$/);
  assert.doesNotMatch(artifact,/create\s+extension|password\s+'|cron\.|net\.http|vault\.|\b(?:insert into|update|delete from)\s+public\./i);
 });
 const value=process.env.CAP_SENDER_TEST_DATABASE_URL;
 if(!value)throw Error('CAP_SENDER_TEST_DATABASE_URL required (fresh local disposable PostgreSQL 17)');
 const u=new URL(value);assert.equal(u.hostname,'127.0.0.1');assert.match(u.pathname,/^\/cap_notifications_synthetic_[a-z0-9_]+$/);
 const {Client}=require(process.env.CAP_PG_PATH||'pg');
 async function connect(user){const v=new URL(value);if(user)v.username=user;const c=new Client({connectionString:v.href});await c.connect();clients.push(c);return c}
 admin=await connect();assert.equal((await admin.query('select current_user as u')).rows[0].u,'supabase_admin');
 assert.ok(Number((await admin.query('show server_version_num')).rows[0].server_version_num)>=170000);
 assert.equal((await admin.query("select count(*)::int n from pg_roles where rolname in ('postgres','anon','cap_notification_runtime')")).rows[0].n,0,'fresh cluster only');
 await admin.query(`create role postgres login createrole bypassrls; create role anon;create role authenticated;create role service_role bypassrls;
 create role cap_sync_reader nologin noinherit;create role cap_transaction_writer nologin noinherit;create role cap_notes_sidecar_writer nologin noinherit;
 create schema auth authorization postgres;create schema storage authorization postgres;
 revoke all on schema auth,storage from public;create table auth.users(id uuid primary key);
 grant select,insert,references on auth.users to postgres;alter schema public owner to postgres;revoke create on schema public from public;`);
 await admin.query(`alter database ${u.pathname.slice(1)} owner to postgres`);
 installer=await connect('postgres');
 await installer.query("create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;revoke all on function auth.uid() from public;grant execute on function auth.uid() to authenticated;");
 await installer.query(read('supabase_schema.sql').replace('create extension if not exists pgcrypto;',''));
 await installer.query("revoke all on all tables in schema public from public,anon,authenticated;select set_config('cap.request_identity_install','reviewed-draft-only',false)");
 await installer.query(read('supabase_production_identity.sql'));
 await installer.query("select set_config('cap.notifications_install','reviewed-5b1-v1',false)");await installer.query(read('supabase_notifications_foundation.sql'));
 await installer.query("select set_config('cap.notifications_enrollment_5b2a1','reviewed-5b2a1-v2',false)");await installer.query(read('supabase_notifications_enrollment_5b2a1_v2.sql'));
 const financial=async()=>JSON.stringify((await installer.query(`select jsonb_agg(to_jsonb(x) order by oid) v from
 (select c.oid,c.relname,c.relacl::text,c.relowner,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r') x`)).rows[0].v);
 const before=await financial();
 await test('unguarded amendment fails and rolls back',async()=>{await assert.rejects(installer.query(artifact),/INSTALL_NOT_APPROVED/);await installer.query('rollback');assert.equal((await installer.query("select to_regnamespace('cap_notifications_runtime') v")).rows[0].v,null)});
 await installer.query("select set_config('cap.notifications_sender_install','reviewed-5b3b-v1',false)");
 await test('dark artifact applies under non-superuser Supabase-shaped installer',async()=>{await installer.query(artifact)});
 const v=async()=> (await installer.query('select cap_notifications_runtime.contract_ok_v1() v')).rows[0].v;
 await test('successor verifier passes; public readiness remains background OFF and parked',async()=>{
  assert.equal(await v(),true);await admin.query("begin;set local role authenticated;select set_config('request.jwt.claims','{\"sub\":\"00000000-0000-4000-8000-000000000001\",\"role\":\"authenticated\"}',true)");
  const r=(await admin.query('select public.cap_notifications_readiness_v1() v')).rows[0].v;
  assert.equal(r.foundation_ready,true);assert.equal(r.background_enabled,false);assert.equal(r.background_ready,false);assert.equal(r.runtime_parked,true);await admin.query('rollback');
 });
 await test('sender login is NOLOGIN; roles have no privilege-bearing memberships',async()=>{
  const rows=(await installer.query("select rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit from pg_roles where rolname in ('cap_notification_runtime','cap_notification_sender_login')")).rows;
  for(const r of rows)for(const[k,x]of Object.entries(r))if(k!=='rolname')assert.equal(x,false,k);
  assert.equal((await installer.query("select count(*)::int n from pg_auth_members where member in (select oid from pg_roles where rolname in ('cap_notification_runtime','cap_notification_sender_login'))")).rows[0].n,0);
 });
 await test('dark flags have structural constraints, not a flippable activation boolean',async()=>{
  for(const q of ["background_enabled=true","sender_dispatch_enabled=true","sender_runtime_parked=false","sender_allowed_vapid_versions=array['v1']"]){
   await installer.query('begin');await assert.rejects(installer.query('update cap_notifications_private.control set '+q),/check constraint/);await installer.query('rollback');}
 });
 await test('financial catalogs unchanged; runtime and sender effective table/function/schema access denied',async()=>{
  assert.equal(await financial(),before);
  for(const role of ['cap_notification_runtime','cap_notification_sender_login']){
   const bad=(await installer.query(`select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth','storage','cap_sync_private','cap_notes_private') and c.relkind='r' and
    (has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege($1,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))`,[role])).rows;assert.equal(bad.length,0);
   const functions=(await installer.query("select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'cap_%' and has_function_privilege($1,p.oid,'EXECUTE')",[role])).rows;assert.equal(functions.length,0);
  }
 });
 await test('PUBLIC/browser/service_role cannot execute runtime operations; sender exactly seven operations',async()=>{
  for(const role of ['anon','authenticated','service_role'])assert.equal((await installer.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='cap_notifications_runtime' and has_function_privilege($1,p.oid,'EXECUTE')",[role])).rows[0].n,0);
  assert.deepEqual((await installer.query("select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='cap_notifications_runtime' and has_function_privilege('cap_notification_sender_login',p.oid,'EXECUTE') order by proname")).rows.map(x=>x.proname),OPS.slice().sort());
 });
 await test('verifier fails closed on function, ACL, policy, column and index drift',async()=>{
  for(const drift of ["grant select on cap_notifications_private.bindings to cap_notification_sender_login",
   "grant execute on function cap_notifications_runtime.claim_v1(uuid) to public",
   "create policy injected on cap_notifications_private.schedules using(true)",
   "create policy injected_update on cap_notifications_private.schedules for update to cap_notification_runtime using(true) with check(true)",
   "grant update on cap_notifications_private.schedules to cap_notification_runtime",
   "grant select on cap_notifications_private.schedules to cap_notification_sender_login",
   "grant update(endpoint) on cap_notifications_private.bindings to cap_notification_runtime",
   "grant update(candidate_digest) on cap_notifications_private.delivery_ledger to cap_notification_runtime",
   "revoke update(state,generation,schedule_revision,updated_at) on cap_notifications_private.bindings from cap_notification_runtime",
   "alter table cap_notifications_private.schedules add column injected text",
   "drop index cap_notifications_private.sender_ledger_retry_idx"]){await admin.query('begin');await admin.query(drift);assert.equal((await admin.query('select cap_notifications_runtime.contract_ok_v1() v')).rows[0].v,false,drift);await admin.query('rollback')}
 });
 await test('replay refuses without modifying catalogs',async()=>{await assert.rejects(installer.query(artifact),/PREFLIGHT_FAILED/);await installer.query('rollback');assert.equal(await v(),true)});
 // Exercise future transition algorithms in an UNEXPOSED, TEST-ONLY clone.
 // Production functions/constraints remain dark, roles stay NOLOGIN, no flag
 // is enabled. The clone changes only the parked gate/version predicate so
 // real PG transactions can test otherwise unreachable state transitions.
 // Nothing in this fixture is part of the installation artifact or deployed.
 await admin.query('create schema sender_whitebox;grant usage on schema sender_whitebox to cap_notification_runtime,cap_notification_sender_login');
 for(const op of OPS){
  let def=(await admin.query("select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='cap_notifications_runtime' and p.proname=$1",[op])).rows[0].d;
  def=def.replaceAll('cap_notifications_runtime.','sender_whitebox.');
  def=def.replace('if not c.background_enabled or c.sender_runtime_parked or not c.sender_dispatch_enabled then','if false then');
  def=def.replaceAll('exists(select 1 from cap_notifications_private.control where b.vapid_key_version=any(sender_allowed_vapid_versions))',"(b.vapid_key_version='v1')");
  def=def.replaceAll('exists(select 1 from cap_notifications_private.control where p_version=any(sender_allowed_vapid_versions))',"(p_version='v1')");
  await admin.query(def);
 }
 await admin.query(`create function sender_whitebox.check_caller_v1() returns void language plpgsql security invoker set search_path=pg_catalog as $$begin if session_user<>'cap_notification_sender_login' then raise exception 'SYNTHETIC_AUTH';end if;end$$;
 create function sender_whitebox.run_ok_v1(p uuid) returns boolean language sql security invoker set search_path=pg_catalog as $$select exists(select 1 from cap_notifications_private.control where sender_run_token=p and sender_run_until>clock_timestamp())$$;`);
 const fsigs=(await admin.query("select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sender_whitebox'")).rows;
 for(const {f}of fsigs)await admin.query(`alter function ${f} owner to cap_notification_runtime;revoke all on function ${f} from public;grant execute on function ${f} to cap_notification_sender_login`);
 a=await connect();b=await connect();const manager=await connect();
 await a.query('set session authorization cap_notification_sender_login');await b.query('set session authorization cap_notification_sender_login');
 for(const c of [admin,a,b,manager])await c.query("set statement_timeout='4s';set lock_timeout='1500ms'");
 const rpc=async(c,op,args=[])=>{assert.ok(OPS.includes(op));return(await c.query(`select sender_whitebox.${op}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args)).rows[0].v};
 const account=uuid(1),binding=uuid(2),installation=uuid(3),digest='a'.repeat(64);
 const dh=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,17)]).toString('base64url'),secret=Buffer.alloc(16,19).toString('base64url');
 let zone,day;
 const seed=async()=>{
  await admin.query(`delete from cap_notifications_private.bindings;delete from cap_notifications_private.endpoint_owners;delete from cap_notifications_private.vapid_tokens;
    update cap_notifications_private.control set sender_run_token=null,sender_run_until=null,sender_last_started_at=null`);
  await admin.query('insert into auth.users values($1) on conflict do nothing',[account]);
  const z=(await admin.query("select name, (clock_timestamp() at time zone name)::date::text as zday from pg_timezone_names where name in ('UTC','Pacific/Honolulu','Pacific/Kiritimati','Europe/Paris') and (clock_timestamp() at time zone name)::time between time '11:00' and time '21:00' limit 1")).rows[0];assert.ok(z);zone=z.name;day=z.zday;
  await admin.query("insert into cap_notifications_private.endpoint_owners(fingerprint,user_id) values(sha256(convert_to('https://fcm.googleapis.com/fcm/send/synthetic-sender','UTF8')),$1)",[account]);
  await admin.query(`insert into cap_notifications_private.bindings(id,user_id,installation_id,endpoint,endpoint_fingerprint,p256dh,auth,vapid_key_version,schedule_revision)
    values($1,$2,$3,'https://fcm.googleapis.com/fcm/send/synthetic-sender',sha256(convert_to('https://fcm.googleapis.com/fcm/send/synthetic-sender','UTF8')),$4,$5,'v1',1)`,[binding,account,installation,dh,secret]);
  await admin.query('begin');await admin.query('select id from cap_notifications_private.bindings where id=$1 for update',[binding]);
  await admin.query(`insert into cap_notifications_private.schedules(user_id,binding_id,generation,candidate_digest,protocol,engine_identity,digest_version,schedule_revision,preference_revision,eligible_local_date,timezone,send_after,expires_at,published_at,publication_valid_until)
    values($1,$2,1,$3,'CAP_PUSH_V1','cap-reminder-v1','hmac-sha256-v1',1,0,$4,$5,($4::date+time '09:00') at time zone $5,clock_timestamp()+interval '30 minutes',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`,[account,binding,digest,day,zone]);
  await admin.query('insert into cap_notifications_private.delivery_ledger(user_id,binding_id,candidate_digest) values($1,$2,$3)',[account,binding,digest]);await admin.query('commit');
  return(await rpc(a,'begin_run_v1',[crypto.randomUUID()])).run_token;
 };
 const ledger=async()=> (await admin.query('select state,attempt_count from cap_notifications_private.delivery_ledger')).rows[0];
 async function roleQuery(role,sql,params=[]){await admin.query('begin');try{await admin.query('set local role '+role);return await admin.query(sql,params)}finally{await admin.query('rollback')}}
 await test('J/K/L/M/N runtime binding/ledger locks work; schedules SELECT only; sender has no direct access',async()=>{
  await seed();await roleQuery('cap_notification_runtime','select * from cap_notifications_private.bindings for update');
  await roleQuery('cap_notification_runtime','select * from cap_notifications_private.delivery_ledger for update');
  await roleQuery('cap_notification_runtime','select * from cap_notifications_private.schedules');
  for(const q of ['select * from cap_notifications_private.schedules for update','update cap_notifications_private.schedules set state=state'])
   await assert.rejects(roleQuery('cap_notification_runtime',q),e=>e.code==='42501');
  for(const q of ['select * from cap_notifications_private.schedules','update cap_notifications_private.schedules set state=state'])
   await assert.rejects(roleQuery('cap_notification_sender_login',q),e=>e.code==='42501');
  for(const col of ['endpoint','endpoint_fingerprint','p256dh','auth','user_id','installation_id','browser_expiration','vapid_key_version'])
   await assert.rejects(roleQuery('cap_notification_runtime',`update cap_notifications_private.bindings set ${col}=${col}`),e=>e.code==='42501');
 });
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 for(const operation of ['publish','invalidate','register'])await test('A/B/C/P binding fence blocks '+operation+' schedule mutation, then releases without deadlock',async()=>{
  await seed();await roleQuery('cap_notification_runtime','select * from cap_notifications_private.schedules');
  const locker=await connect();await locker.query('begin;set local role cap_notification_runtime');await locker.query('select id from cap_notifications_private.bindings where id=$1 for update',[binding]);
  // No schedule row lock and no privilege error.
  await locker.query('select * from cap_notifications_private.schedules where binding_id=$1',[binding]);
  await manager.query('begin;set local role authenticated');await manager.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:account,role:'authenticated'})]);
  let done=false;
  const expiry=new Date(Date.now()+20*60000).toISOString(),until=new Date(Date.now()+40*60000).toISOString();
  const q=operation==='publish'?manager.query('select public.cap_notifications_publish_v1($1,1,1,0,\'CAP_PUSH_V1\',\'cap-reminder-v1\',\'hmac-sha256-v1\',$2,$3,$4)',[binding,zone,until,JSON.stringify([{candidate_digest:digest,eligible_local_date:day,expires_at:expiry}])]):
   operation==='invalidate'?manager.query('select public.cap_notifications_invalidate_v1($1,1,1,true)',[binding]):manager.query("select public.cap_notifications_register_v1($1,1,'CAP_PUSH_V1','https://fcm.googleapis.com/fcm/send/synthetic-replacement',$2,$3,'v1',null)",[installation,dh,secret]);
  const pending=q.then(()=>{done=true});await wait(100);assert.equal(done,false);
  await locker.query('rollback');await pending;await manager.query('rollback');
 });
 await test('D management binding lock makes SKIP LOCKED claim skip; O concurrent claims single winner',async()=>{
  let run=await seed();await manager.query('begin');await manager.query('select id from cap_notifications_private.bindings for update');
  assert.equal((await rpc(a,'claim_v1',[run])).ok,false);await manager.query('rollback');
  await a.query('begin');const one=await rpc(a,'claim_v1',[run]);assert.equal(one.ok,true);
  assert.equal((await rpc(b,'claim_v1',[run])).ok,false);await a.query('commit');assert.equal((await ledger()).attempt_count,1);
  const [p1,p2]=await Promise.all([rpc(a,'start_dispatch_v1',[run,one.claim_token]),rpc(b,'start_dispatch_v1',[run,one.claim_token])]);
  assert.equal([p1,p2].filter(p=>p.ok).length,1);
  const permit=p1.ok?p1:p2;assert.equal(permit.binding_id,binding);assert.equal(permit.installation_id,installation);assert.equal(permit.generation,'1');assert.ok(Number.isSafeInteger(permit.expires_at));
 });
 await test('single run lease and 60-second spacing are global; unknown tokens cannot start',async()=>{
  const run=await seed();assert.equal((await rpc(b,'begin_run_v1',[crypto.randomUUID()])).status,'busy');
  await admin.query("update cap_notifications_private.control set sender_run_until=clock_timestamp()-interval '1 second'");
  assert.equal((await rpc(b,'begin_run_v1',[crypto.randomUUID()])).status,'rate_limited');assert.equal((await rpc(a,'start_dispatch_v1',[run,crypto.randomUUID()])).ok,false);
 });
 // TEST-ONLY PgSleep injection at the discovery->fence boundary makes stale
 // candidate interleavings deterministic. No advisory/lock helper is shipped.
 const normalClaim=(await admin.query("select pg_get_functiondef('sender_whitebox.claim_v1(uuid)'::regprocedure) d")).rows[0].d;
 const slowed=normalClaim.replace('loop\n    select * into b','loop\n    perform pg_sleep(0.3);\n    select * into b');assert.notEqual(slowed,normalClaim);
 for(const [label,change]of [
  ['E schedule changed',"update cap_notifications_private.schedules set expires_at=expires_at-interval '1 minute'"],
  ['F schedule removed','delete from cap_notifications_private.schedules'],
  ['G generation changed','update cap_notifications_private.bindings set generation=2'],
  ['H schedule revision changed','update cap_notifications_private.bindings set schedule_revision=2'],
  ['I preference revision changed','update cap_notifications_private.bindings set preference_revision=1']])await test(label+' after discovery and before fence rejects stale candidate',async()=>{
  const run=await seed();await admin.query(slowed);const pid=(await a.query('select pg_backend_pid() p')).rows[0].p;
  const pending=rpc(a,'claim_v1',[run]);let sleeping=false;
  for(let i=0;i<50;i++){const r=(await admin.query('select wait_event from pg_stat_activity where pid=$1',[pid])).rows[0];if(r.wait_event==='PgSleep'){sleeping=true;break}await wait(10)}assert.equal(sleeping,true);
  await admin.query('begin');await admin.query('select id from cap_notifications_private.bindings for update');await admin.query(change);await admin.query('commit');
  assert.equal((await pending).ok,false);assert.equal((await ledger()).attempt_count,0);await admin.query(normalClaim);
 });
 for(const change of ["update cap_notifications_private.bindings set generation=2","update cap_notifications_private.bindings set state='disabled'","update cap_notifications_private.bindings set schedule_revision=2","update cap_notifications_private.bindings set preference_revision=1","delete from cap_notifications_private.schedules"])
  await test('stale/disabled/replaced schedule refuses start permit: '+change.split(' set ')[1]?.split('=')[0],async()=>{
   const run=await seed(),claim=await rpc(a,'claim_v1',[run]);await admin.query('begin');await admin.query('select id from cap_notifications_private.bindings for update');await admin.query(change);await admin.query('commit');assert.equal((await rpc(a,'start_dispatch_v1',[run,claim.claim_token])).ok,false);
  });
 await test('crash before start safely recovers; after start becomes terminal unknown and never requeues',async()=>{
  const run=await seed();let c=await rpc(a,'claim_v1',[run]);await admin.query("update cap_notifications_private.delivery_ledger set claimed_at=clock_timestamp()-interval '61 seconds'");
  assert.equal((await rpc(a,'recover_v1',[run])).recovered,1);assert.equal((await ledger()).state,'queued');
  c=await rpc(a,'claim_v1',[run]);assert.equal((await rpc(a,'start_dispatch_v1',[run,c.claim_token])).ok,true);
  await admin.query("update cap_notifications_private.delivery_ledger set claimed_at=clock_timestamp()-interval '61 seconds'");await rpc(a,'recover_v1',[run]);assert.equal((await ledger()).state,'unknown');assert.equal((await rpc(a,'claim_v1',[run])).ok,false);
 });
 await test('accepted finalization is terminal/idempotent and stale 410 cannot retire replacement generation',async()=>{
  let run=await seed(),c=await rpc(a,'claim_v1',[run]);await rpc(a,'start_dispatch_v1',[run,c.claim_token]);assert.equal((await rpc(a,'finalize_v1',[c.claim_token,'accepted',null])).state,'accepted');assert.equal((await rpc(a,'claim_v1',[run])).ok,false);
  assert.equal((await rpc(a,'finalize_v1',[c.claim_token,'ambiguous',null])).state,'accepted');
  run=await seed();c=await rpc(a,'claim_v1',[run]);await rpc(a,'start_dispatch_v1',[run,c.claim_token]);await admin.query('update cap_notifications_private.bindings set generation=2');await rpc(a,'finalize_v1',[c.claim_token,'invalid_subscription',null]);
  assert.equal((await admin.query('select state from cap_notifications_private.bindings')).rows[0].state,'pending');
 });
 await test('retry_wait backoff/3-attempt cap; NULL browser expiration is valid',async()=>{
  const run=await seed();for(let i=1;i<=3;i++){const c=await rpc(a,'claim_v1',[run]);assert.equal(c.ok,true);assert.equal((await rpc(a,'start_dispatch_v1',[run,c.claim_token])).ok,true);const f=await rpc(a,'finalize_v1',[c.claim_token,'temporary_rejection',60]);assert.equal(f.state,i===3?'retired':'retry_wait');await admin.query("update cap_notifications_private.delivery_ledger set next_retry_at=clock_timestamp()-interval '1 second' where state='retry_wait'")}
  assert.equal((await rpc(a,'claim_v1',[run])).ok,false);assert.equal((await ledger()).attempt_count,3);
 });
 await test('token-generation lease is single winner; put CAS caches header; no second refresh within an hour',async()=>{
  const run=await seed();const origin='https://fcm.googleapis.com';
  const [x,y]=await Promise.all([rpc(a,'vapid_token_get_v1',[run,origin,'v1']),rpc(b,'vapid_token_get_v1',[run,origin,'v1'])]);
  assert.equal([x,y].filter(z=>z.generation_token).length,1);
  const lease=x.generation_token||y.generation_token;
  assert.equal((await rpc(a,'vapid_token_get_v1',[run,origin,'v1'])).ok,false);
  assert.equal((await rpc(a,'vapid_token_get_v1',[run,'https://evil.invalid','v1'])).ok,false);
  const exp=Math.floor(Date.now()/1000)+1200, b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  const header='vapid t='+b64({alg:'ES256'})+'.'+b64({aud:origin,exp,sub:'https://contact.example.invalid/cap'})+'.'+'A'.repeat(86)+', k='+'B'.repeat(87);
  assert.equal((await rpc(a,'vapid_token_put_v1',[lease,header,new Date(exp*1000).toISOString()])).ok,true);
  assert.equal((await rpc(a,'vapid_token_get_v1',[run,origin,'v1'])).authorization,header);
  assert.equal((await rpc(a,'vapid_token_put_v1',[lease,header,new Date(exp*1000).toISOString()])).ok,false);
  await admin.query("update cap_notifications_private.vapid_tokens set expires_at=clock_timestamp()+interval '4 minutes' where origin=$1 and version='v1'",[origin]);
  assert.equal((await rpc(a,'vapid_token_get_v1',[run,origin,'v1'])).ok,false);
  assert.equal((await rpc(a,'vapid_token_get_v1',[run,origin,'v2'])).ok,false);
 });
 await test('all real artifact gates remain dark and parked after whitebox tests',async()=>{
  assert.equal(await v(),true);const parked=(await a.query('select cap_notifications_runtime.begin_run_v1($1) v',[crypto.randomUUID()])).rows[0].v;assert.equal(parked.status,'parked');
  assert.equal((await admin.query("select rolcanlogin from pg_roles where rolname='cap_notification_sender_login'")).rows[0].rolcanlogin,false);
 });
 console.log(`PASS: ${passed} sender PostgreSQL dark-install checks; no activation or network delivery`);
})().catch(e=>{console.error('Sender SQL validation failed: '+e.message,e.stack);process.exitCode=1}).finally(async()=>{for(const c of clients)await c.end().catch(()=>{})});
