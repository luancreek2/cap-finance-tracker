/* Scheduling V2: disposable loopback PostgreSQL only. No production contact,
   push, activation, client publisher, or changes to historical specifications.
   Reuses the approved fresh-cluster helper. --static runs source checks only. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const artifact=read('supabase_notifications_scheduling_v2.sql');
let passed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name)}catch(e){console.error('FAIL '+name);throw e}}
const frozen=['supabase_notifications_foundation.sql','supabase_notifications_enrollment_5b2a1.sql',
 'supabase_notifications_enrollment_5b2a1_v2.sql','supabase_notifications_sender_5b3.sql',
 'tests/notifications-foundation-sql.cjs','tests/notifications-sender-sql.cjs','service-worker.js',
 ...fs.readdirSync(path.join(root,'supabase/functions/cap-notification-sender')).map(f=>'supabase/functions/cap-notification-sender/'+f)];
async function staticChecks(){
 await test('historical SQL/tests and Edge sender unchanged; worker retains raw baseline hash',()=>{
  // This checkout contains both LF and CRLF historical files. Compare clean
  // Git objects without rewriting either, and retain the raw worker baseline.
  for(const f of frozen)assert.equal(cp.execFileSync('git',['hash-object',f],{cwd:root,encoding:'utf8'}).trim(),cp.execFileSync('git',['rev-parse','HEAD:'+f],{cwd:root,encoding:'utf8'}).trim(),f);
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,'service-worker.js'))).digest('hex'),'e4a5b68b08cd5b48a04b9c9b2f1b030f023557b16bf3656121467b396a377e1d');
 });
 await test('transactional guarded successor; no activation, secrets, financial DML or extensions',()=>{
  assert.match(artifact,/^begin;$/m);assert.match(artifact,/commit;\s*$/);assert.match(artifact,/reviewed-scheduling-v2/);
  assert.doesNotMatch(artifact,/create\s+(extension|role)|password\s+'|cron\.|net\.http|vault\.|\b(?:insert into|update|delete from)\s+public\./i);
  assert.doesNotMatch(artifact,/grant\s+update.*on\s+cap_notifications_private\.schedules/i);
 });
 await test('release allowlist adds exactly three paths and preserves every security assertion',()=>{
  const f='tests/cloud-pull-security.cjs',old=cp.execFileSync('git',['show','HEAD:'+f],{cwd:root,encoding:'utf8'}),now=read(f);
  const extra="'supabase_notifications_scheduling_v2.sql','docs/notification-scheduling-amendment.md','tests/notifications-scheduling-sql.cjs'";
  assert.equal(now,old.replace("'tests/notifications-sender-sql.cjs'];","'tests/notifications-sender-sql.cjs',\n  "+extra+'];'));
 });
}
if(!process.argv.includes('--static')&&!process.env.CAP_SENDER_TEST_DATABASE_URL){
 require('./helpers/sender-pg.cjs').run(__filename).catch(e=>{console.error(e.message);process.exitCode=1});
}else{
 const clients=[];
 (async()=>{
  await staticChecks();if(process.argv.includes('--static'))return;
  const value=process.env.CAP_SENDER_TEST_DATABASE_URL,u=new URL(value);
  assert.equal(u.hostname,'127.0.0.1');assert.match(u.pathname,/^\/cap_notifications_synthetic_[a-z0-9_]+$/);
  const {Client}=require(process.env.CAP_PG_PATH||'pg');
  async function connect(user){const v=new URL(value);if(user)v.username=user;const c=new Client({connectionString:v.href});await c.connect();clients.push(c);return c}
  const admin=await connect();assert.equal((await admin.query('select current_user u')).rows[0].u,'supabase_admin');
  const version=(await admin.query('select version() v')).rows[0].v;console.log('LOCAL POSTGRES CERTIFICATION: '+version);
  console.log('PRODUCTION-MINOR COMPATIBILITY NOT YET CERTIFIED');
  assert.equal(Math.floor(Number((await admin.query('show server_version_num')).rows[0].server_version_num)/10000),17);
  assert.equal((await admin.query("select count(*)::int n from pg_roles where rolname in ('postgres','anon','cap_notification_runtime')")).rows[0].n,0);
  await admin.query(`create role postgres login createrole bypassrls;create role anon;create role authenticated;create role service_role bypassrls;
    create role cap_sync_reader nologin noinherit;create role cap_transaction_writer nologin noinherit;create role cap_notes_sidecar_writer nologin noinherit;
    create schema auth authorization postgres;create schema storage authorization postgres;revoke all on schema auth,storage from public;
    create table auth.users(id uuid primary key);grant select,insert,references on auth.users to postgres;
    alter schema public owner to postgres;revoke create on schema public from public;`);
  await admin.query(`alter database ${u.pathname.slice(1)} owner to postgres`);
  const installer=await connect('postgres'),browser=await connect();
  await installer.query("create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;revoke all on function auth.uid() from public;grant execute on function auth.uid() to authenticated;");
  await installer.query(read('supabase_schema.sql').replace('create extension if not exists pgcrypto;',''));
  await installer.query("revoke all on all tables in schema public from public,anon,authenticated;select set_config('cap.request_identity_install','reviewed-draft-only',false)");
  await installer.query(read('supabase_production_identity.sql'));
  await installer.query("select set_config('cap.notifications_install','reviewed-5b1-v1',false)");await installer.query(read('supabase_notifications_foundation.sql'));
  await installer.query("select set_config('cap.notifications_enrollment_5b2a1','reviewed-5b2a1-v2',false)");await installer.query(read('supabase_notifications_enrollment_5b2a1_v2.sql'));
  await installer.query("select set_config('cap.notifications_sender_install','reviewed-5b3b-v1',false)");await installer.query(read('supabase_notifications_sender_5b3.sql'));
  const owner='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',installation='00000000-0000-4000-8000-000000000003';
  await admin.query('insert into auth.users values($1),($2)',[owner,other]);
  async function auth(sql,args=[],uid=owner,c=browser){
   await c.query('begin;set local role authenticated');
   await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:uid,role:'authenticated'})]);
   try{const r=await c.query(sql,args);await c.query('commit');return r.rows[0]?.v}catch(e){await c.query('rollback');throw e}
  }
  const dh=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,17)]).toString('base64url'),secret=Buffer.alloc(16,19).toString('base64url');
  let binding,revision=0,preference=0;
  async function seed(){
   await admin.query('delete from cap_notifications_private.bindings;delete from cap_notifications_private.endpoint_owners');
   const b=await auth("select public.cap_notifications_register_v1($1,0,'CAP_PUSH_V1','https://fcm.googleapis.com/fcm/send/synthetic-scheduling',$2,$3,'v1',null) v",[installation,dh,secret]);
   binding=b.binding_id;revision=Number(b.schedule_revision);preference=0;
  }
  const catalog=async()=>JSON.stringify((await admin.query(`select jsonb_agg(to_jsonb(x) order by oid) v from
    (select c.oid,c.relname,c.relacl::text,c.relowner,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','auth','storage','cap_sync_private','cap_notes_private') and c.relkind in ('r','p')) x`)).rows[0].v);
  const beforeCatalog=await catalog();
  const snapshot=async()=>JSON.stringify((await admin.query(`select jsonb_build_object(
    'bindings',(select jsonb_agg(to_jsonb(b) order by id) from cap_notifications_private.bindings b),
    'schedules',(select jsonb_agg(to_jsonb(s) order by candidate_digest) from cap_notifications_private.schedules s),
    'ledger',(select jsonb_agg(to_jsonb(l) order by candidate_digest) from cap_notifications_private.delivery_ledger l)) v`)).rows[0].v);
  await seed();
  // Seed a legitimate legacy snapshot BEFORE successor application, preserving
  // receipt and expiry. No historical table predicates are relaxed.
  const legacyZone=(await admin.query("select name,(clock_timestamp() at time zone name)::date::text d from pg_timezone_names where name in ('UTC','Pacific/Honolulu','Pacific/Kiritimati','Europe/Paris') and (clock_timestamp() at time zone name)::time between time '11:00' and time '21:00' limit 1")).rows[0];
  const legacyExpiry=new Date(Date.now()+600000).toISOString(),legacyUntil=new Date(Date.now()+1200000).toISOString();
  await auth("select public.cap_notifications_publish_v1($1,1,0,0,'CAP_PUSH_V1','cap-reminder-v1','hmac-sha256-v1',$2,$3,$4) v",[binding,legacyZone.name,legacyUntil,JSON.stringify([{candidate_digest:'a'.repeat(64),eligible_local_date:legacyZone.d,expires_at:legacyExpiry}])]);
  const legacyRows=(await admin.query('select to_jsonb(s) v from cap_notifications_private.schedules s')).rows;
  await test('unguarded install rolls back without successor surface',async()=>{
   await assert.rejects(installer.query(artifact),/INSTALL_NOT_APPROVED/);await installer.query('rollback');
   assert.equal((await admin.query("select to_regprocedure('public.cap_notifications_readiness_v2()') v")).rows[0].v,null);
  });
  await installer.query("select set_config('cap.notifications_scheduling_install','reviewed-scheduling-v2',false)");
  await test('non-superuser guarded install succeeds with existing v1 schedules and receipts',async()=>{
   await installer.query(artifact);
   const rows=(await admin.query('select to_jsonb(s) v from cap_notifications_private.schedules s')).rows;
   for(const k of Object.keys(legacyRows[0].v))assert.deepEqual(rows[0].v[k],legacyRows[0].v[k],k);
   assert.equal(rows[0].v.scheduling_contract,1);assert.equal((await admin.query('select count(*)::int n from cap_notifications_private.delivery_ledger')).rows[0].n,1);
  });
  const verify=async()=> (await installer.query('select cap_notifications_runtime.contract_ok_v1() v')).rows[0].v;
  await test('successor seal passes; readiness is owner-authenticated, dark and explicitly versioned',async()=>{
   assert.equal(await verify(),true);const r=await auth('select public.cap_notifications_readiness_v2() v');
   assert.equal(r.scheduling_ready,true);assert.equal(r.max_future_hours,8760);assert.equal(r.fold_policy,'later');assert.equal(r.gap_policy,'reject');
   assert.equal(r.background_enabled,false);assert.equal(r.runtime_parked,true);assert.equal(r.dispatch_ready,false);assert.equal(await catalog(),beforeCatalog);
  });
  await test('rerun refuses; no incidental catalog changes',async()=>{
   await assert.rejects(installer.query(artifact),/PREFLIGHT_FAILED/);await installer.query('rollback');assert.equal(await verify(),true);
  });
  await test('v1 binding still publishes legacy 09:00 snapshot under its seven-day contract',async()=>{
   const r=await auth("select public.cap_notifications_publish_v1($1,1,1,0,'CAP_PUSH_V1','cap-reminder-v1','hmac-sha256-v1',$2,$3,$4) v",[binding,legacyZone.name,legacyUntil,JSON.stringify([{candidate_digest:'a'.repeat(64),eligible_local_date:legacyZone.d,expires_at:legacyExpiry}])]);
   assert.equal(Number(r.schedule_revision),2);assert.equal(r.dispatch_ready,false);
  });
  // Fixed acceptance time ONLY in an unexposed test clone. Real RPCs and all
  // production constraints remain untouched/dark; no fake-clock production API.
  await admin.query('create schema scheduling_whitebox;grant usage on schema scheduling_whitebox to authenticated,cap_notification_manager');
  let def=(await admin.query("select pg_get_functiondef('public.cap_notifications_publish_v2(uuid,bigint,bigint,bigint,text,text,text,text,jsonb)'::regprocedure) d")).rows[0].d;
  assert.ok(def.includes('pub timestamptz:=statement_timestamp()'));
  def=def.replace('public.cap_notifications_publish_v2','scheduling_whitebox.publish_v2').replace('pub timestamptz:=statement_timestamp()',"pub timestamptz:='2026-10-01T00:00:00Z'::timestamptz");
  await admin.query(def);await admin.query('alter function scheduling_whitebox.publish_v2(uuid,bigint,bigint,bigint,text,text,text,text,jsonb) owner to cap_notification_manager;revoke all on function scheduling_whitebox.publish_v2(uuid,bigint,bigint,bigint,text,text,text,text,jsonb) from public;grant execute on function scheduling_whitebox.publish_v2(uuid,bigint,bigint,bigint,text,text,text,text,jsonb) to authenticated');
  function entry(overrides={}){return{candidate_digest:'a'.repeat(64),obligation_digest:'b'.repeat(64),time_basis:'wall',eligible_local_date:'2026-11-15',local_time:'19:30',timezone:'Asia/Manila',send_after:'2026-11-15T11:30:00Z',expires_at:'2026-11-15T16:00:00Z',...overrides}}
  async function publish(entries,opts={}){
   const f=opts.live?'public.cap_notifications_publish_v2':'scheduling_whitebox.publish_v2';
   const zone=opts.timezone??entries.find(e=>e?.time_basis==='wall')?.timezone??'Asia/Manila';
   const r=await auth(`select ${f}($1,$2,$3,$4,'CAP_PUSH_V1','cap-reminder-v1','hmac-sha256-v1',$5,$6) v`,
    [binding,opts.generation??1,opts.revision??revision,opts.preference??preference,zone,JSON.stringify(entries)],opts.uid??owner,opts.client??browser);
   revision=Number(r.schedule_revision);preference=Number(r.preference_revision);return r;
  }
  async function rejectUnchanged(entries,re,opts={}){const before=await snapshot();await assert.rejects(publish(entries,opts),re);assert.equal(await snapshot(),before)}
  await seed();
  await test('absolute October 1 -> November 15 19:30 stored immediately through expiry',async()=>{
   const r=await publish([entry({time_basis:'absolute'})]);assert.equal(r.scheduling_contract,2);assert.equal(r.entry_count,1);assert.equal(r.dispatch_ready,false);
   const s=(await admin.query('select * from cap_notifications_private.schedules')).rows[0];
   assert.equal(s.send_after.toISOString(),'2026-11-15T11:30:00.000Z');assert.equal(s.publication_valid_until.toISOString(),s.expires_at.toISOString());
   assert.ok(s.publication_valid_until-s.published_at>7*86400000);
  });
  await test('relative November 30 minus 14 days persists November 16 without renewal',async()=>{
   const r=await publish([entry({eligible_local_date:'2026-11-16',local_time:'09:00',send_after:'2026-11-16T01:00:00Z',expires_at:'2026-11-16T16:00:00Z'})]);assert.equal(r.entry_count,1);
  });
  await test('multiple times allowed; exact obligation/UTC duplicates rejected atomically',async()=>{
   await publish([entry(),entry({candidate_digest:'c'.repeat(64),local_time:'20:00',send_after:'2026-11-15T12:00:00Z'})]);
   await rejectUnchanged([entry(),entry({candidate_digest:'d'.repeat(64)})],/DUPLICATE_OBLIGATION_TIME/);
   await rejectUnchanged([entry(),entry({obligation_digest:'e'.repeat(64)})],/DUPLICATE_CANDIDATE/);
  });
  await test('DST gap round-trip rejects PostgreSQL automatic normalization, full snapshot unchanged',async()=>{
   const normalized=(await admin.query("select ('2027-03-14 02:30'::timestamp at time zone 'America/New_York') at time zone 'America/New_York' v")).rows[0].v;
   assert.notEqual(normalized.toISOString(),'2027-03-14T02:30:00.000Z');
   await rejectUnchanged([entry({timezone:'America/New_York',eligible_local_date:'2027-03-14',local_time:'00:00',send_after:'2027-03-14T05:00:00Z',expires_at:'2027-03-15T04:00:00Z'}),entry({candidate_digest:'c'.repeat(64),timezone:'America/New_York',eligible_local_date:'2027-03-14',local_time:'02:30',send_after:'2027-03-14T07:30:00Z',expires_at:'2027-03-15T04:00:00Z'})],/LOCAL_TIME_GAP/);
   await rejectUnchanged([entry({time_basis:'absolute',timezone:'America/New_York',eligible_local_date:'2027-03-14',local_time:'02:30',send_after:'2027-03-14T07:30:00Z',expires_at:'2027-03-15T04:00:00Z'})],/LOCAL_TIME_GAP/);
  });
  const fold=()=>entry({timezone:'America/New_York',eligible_local_date:'2026-11-01',local_time:'01:30',send_after:'2026-11-01T06:30:00Z',expires_at:'2026-11-02T05:00:00Z'});
  await test('DST fold later UTC accepted, earlier UTC rejected, independent of session timezone',async()=>{
   for(const zone of ['UTC','Pacific/Honolulu','Asia/Tokyo']){
    await browser.query("select set_config('TimeZone',$1,false)",[zone]);await publish([fold()]);
    await rejectUnchanged([{...fold(),send_after:'2026-11-01T05:30:00Z'}],/EXPECTED_UTC_MISMATCH/);
   }
  });
  await test('non-hour Lord Howe fold and negative-DST Dublin fold choose later UTC',async()=>{
   for(const [wall,zone,expected]of [['2027-04-04 01:45','Australia/Lord_Howe','2027-04-03T15:15:00.000Z'],['2026-10-25 01:30','Europe/Dublin','2026-10-25T01:30:00.000Z']]){
    const r=await admin.query('select cap_notifications_private.resolve_wall_v2($1::timestamp::date,$1::timestamp::time,$2) v',[wall,zone]);assert.equal(r.rows[0].v.toISOString(),expected);
   }
  });
  await test('absolute original fold uses later occurrence; republishing does not adopt device timezone',async()=>{
   await publish([{...fold(),time_basis:'absolute'}]);await browser.query("set timezone='Pacific/Kiritimati'");
   const r=await publish([{...fold(),time_basis:'absolute'}]);assert.equal(new Date(r.occurrences[0].send_after).toISOString(),'2026-11-01T06:30:00.000Z');
   await rejectUnchanged([{...fold(),time_basis:'absolute',send_after:'2026-11-01T05:30:00Z'}],/EXPECTED_UTC_MISMATCH/);
  });
  await test('unchanged acknowledged absolute bypasses later wall resolution; wall entries never bypass it',async()=>{
   await admin.query("create function scheduling_whitebox.reject_resolution(d date,t time,z text) returns timestamptz language plpgsql set search_path=pg_catalog as $$begin raise exception 'SYNTHETIC_RESOLUTION_DISALLOWED';end$$;revoke all on function scheduling_whitebox.reject_resolution(date,time,text) from public;grant execute on function scheduling_whitebox.reject_resolution(date,time,text) to cap_notification_manager");
   const clone=def.replace('scheduling_whitebox.publish_v2','scheduling_whitebox.no_resolve_v2').replace('cap_notifications_private.resolve_wall_v2(d,lt,z)','scheduling_whitebox.reject_resolution(d,lt,z)');
   assert.notEqual(clone,def);await admin.query(clone);
   await admin.query('alter function scheduling_whitebox.no_resolve_v2(uuid,bigint,bigint,bigint,text,text,text,text,jsonb) owner to cap_notification_manager;revoke all on function scheduling_whitebox.no_resolve_v2(uuid,bigint,bigint,bigint,text,text,text,text,jsonb) from public;grant execute on function scheduling_whitebox.no_resolve_v2(uuid,bigint,bigint,bigint,text,text,text,text,jsonb) to authenticated');
   const call=entries=>auth("select scheduling_whitebox.no_resolve_v2($1,1,$2,0,'CAP_PUSH_V1','cap-reminder-v1','hmac-sha256-v1','America/New_York',$3) v",[binding,revision,JSON.stringify(entries)]);
   const r=await call([{...fold(),time_basis:'absolute'}]);revision=Number(r.schedule_revision);
   assert.equal(new Date(r.occurrences[0].send_after).toISOString(),'2026-11-01T06:30:00.000Z');
   const before=await snapshot();await assert.rejects(call([fold()]),/SYNTHETIC_RESOLUTION_DISALLOWED/);assert.equal(await snapshot(),before);
  });
  await test('normal local-midnight ceiling and zero delivery window enforced',async()=>{
   await publish([entry()]);
   await rejectUnchanged([entry({expires_at:'2026-11-15T16:00:00.000001Z'})],/WINDOW_INVALID/);
   await rejectUnchanged([entry({expires_at:'2026-11-15T11:30:00Z'})],/WINDOW_INVALID/);
  });
  await test('DST-short day expires at next midnight, less than 24 elapsed hours',async()=>{
   const e=entry({timezone:'America/New_York',eligible_local_date:'2027-03-14',local_time:'00:00',send_after:'2027-03-14T05:00:00Z',expires_at:'2027-03-15T04:00:00Z'});
   await publish([e]);assert.equal(new Date(e.expires_at)-new Date(e.send_after),23*3600000);
   await rejectUnchanged([{...e,expires_at:'2027-03-15T04:00:01Z'}],/WINDOW_INVALID/);
  });
  await test('DST-long day capped at 24 elapsed hours BEFORE next local midnight',async()=>{
   const e=entry({timezone:'America/New_York',eligible_local_date:'2026-11-01',local_time:'00:00',send_after:'2026-11-01T04:00:00Z',expires_at:'2026-11-02T04:00:00Z'});
   await publish([e]);await rejectUnchanged([{...e,expires_at:'2026-11-02T04:00:00.000001Z'}],/WINDOW_INVALID/);
   await rejectUnchanged([{...e,expires_at:'2026-11-02T05:00:00Z'}],/WINDOW_INVALID/);
  });
  await test('absolute expiry uses accepted creation timezone, not session/default timezone',async()=>{
   await browser.query("set timezone='America/New_York'");await publish([entry({time_basis:'absolute'})]);
   await rejectUnchanged([entry({time_basis:'absolute',expires_at:'2026-11-16T00:00:00Z'})],/WINDOW_INVALID/);
  });
  await test('wall timezone changes acknowledge atomically; absolute context stays independent',async()=>{
   const absolute=entry({time_basis:'absolute'});
   await publish([absolute],{timezone:'UTC'});
   let r=await auth('select public.cap_notifications_schedule_readback_v2($1,1) v',[binding]);
   assert.equal(r.notification_timezone,'UTC');assert.equal(r.occurrences[0].timezone,'Asia/Manila');
   await rejectUnchanged([entry()],/TIMEZONE_MISMATCH/,{timezone:'UTC'});
   await publish([absolute],{timezone:'America/New_York'});
   r=await auth('select public.cap_notifications_schedule_readback_v2($1,1) v',[binding]);
   assert.equal(r.notification_timezone,'America/New_York');assert.equal(new Date(r.occurrences[0].send_after).toISOString(),'2026-11-15T11:30:00.000Z');
  });
  await test('exact 365-day future boundary accepted; beyond rejected; auth ends at per-row expiry',async()=>{
   const e=entry({timezone:'UTC',eligible_local_date:'2027-10-01',local_time:'00:00',send_after:'2027-10-01T00:00:00Z',expires_at:'2027-10-02T00:00:00Z'});
   await publish([e]);await rejectUnchanged([{...e,local_time:'00:01',send_after:'2027-10-01T00:01:00Z'}],/WINDOW_INVALID/);
   await rejectUnchanged([{...e,eligible_local_date:'2027-10-02',send_after:'2027-10-02T00:00:00Z',expires_at:'2027-10-03T00:00:00Z'}],/WINDOW_INVALID/);
  });
  await test('malformed/unknown/financial fields and noncanonical times fail atomically',async()=>{
   for(const e of [entry({merchant:'Synthetic'}),entry({local_time:'9:00'}),entry({local_time:'24:00'}),entry({timezone:'Invalid/Zone'}),entry({obligation_digest:null}),entry({send_after:'infinity'}),entry({send_after:'2026-11-15T11:30:00+00:00'}),entry({time_basis:'relative'}),null])await rejectUnchanged([e],/ENTRY_INVALID|TIMEZONE_INVALID/);
  });
  await test('ownership, generation, revision and preference fences reject without replacement',async()=>{
   await rejectUnchanged([entry()],/STALE_BINDING/,{uid:other});await rejectUnchanged([entry()],/STALE_BINDING/,{generation:2});
   await rejectUnchanged([entry()],/STALE_REVISION/,{revision:revision-1});
   await publish([entry()],{preference:2});await rejectUnchanged([entry()],/STALE_REVISION/,{preference:1});
  });
  await test('known subscription expiry prevents false long-range acknowledgment',async()=>{
   await admin.query("update cap_notifications_private.bindings set browser_expiration='2026-11-15T12:00:00Z'");
   await rejectUnchanged([entry()],/SUBSCRIPTION_TOO_SHORT/);await admin.query('update cap_notifications_private.bindings set browser_expiration=null');
  });
  await test('v1 cannot replace negotiated v2; readback is exact, owner scoped and reconciles lost responses',async()=>{
   await assert.rejects(auth("select public.cap_notifications_publish_v1($1,1,$2,2,'CAP_PUSH_V1','cap-reminder-v1','hmac-sha256-v1',$3,$4,'[]') v",[binding,revision,legacyZone.name,new Date(Date.now()+600000).toISOString()]),/SCHEDULING_VERSION_REQUIRED/);
   const r=await auth('select public.cap_notifications_schedule_readback_v2($1,1) v',[binding]);assert.equal(Number(r.schedule_revision),revision);assert.equal(r.scheduling_contract,2);assert.equal(r.occurrences.length,1);
   await assert.rejects(auth('select public.cap_notifications_schedule_readback_v2($1,1) v',[binding],other),/STALE_BINDING/);
  });
  await seed();
  await test('publication and ledger caps reject atomically, without protected-receipt pruning',async()=>{
   await publish([entry()]);await rejectUnchanged(Array(1001).fill(entry()),/ENTRIES_INVALID/);
   await rejectUnchanged([entry({extra:'x'.repeat(262144)})],/ENTRIES_INVALID/);
   await admin.query(`insert into cap_notifications_private.delivery_ledger(user_id,binding_id,candidate_digest)
     select $1,$2,lpad(to_hex(i),64,'0') from generate_series(1,999) i`,[owner,binding]);
   await rejectUnchanged([entry({candidate_digest:'c'.repeat(64)})],/LEDGER_FULL/);
   await publish([entry()]);
  });
  await seed();await publish([entry()]);
  await test('terminal receipt remains terminal after edit and remove/readd',async()=>{
   await admin.query("update cap_notifications_private.delivery_ledger set state='unknown',attempt_count=1,dispatch_started_at=clock_timestamp(),failure_class='ambiguous'");
   await publish([entry({local_time:'20:00',send_after:'2026-11-15T12:00:00Z'})]);await publish([]);await publish([entry()]);
   assert.equal((await admin.query('select state from cap_notifications_private.delivery_ledger')).rows[0].state,'unknown');
  });
  await test('claimed/dispatch_started publication busy; no replacement or receipt mutation',async()=>{
   for(const state of ['claimed','dispatch_started']){
    await admin.query(`update cap_notifications_private.delivery_ledger set state=$1,claim_token=gen_random_uuid(),claimed_at=clock_timestamp(),
      claimed_generation=1,claimed_schedule_revision=$2,claimed_preference_revision=$3,claimed_vapid_key_version='v1'`,[state,revision,preference]);
    await rejectUnchanged([entry()],/PUBLICATION_BUSY/);
   }
   await admin.query("update cap_notifications_private.delivery_ledger set state='unknown'");
  });
  await test('binding-first publication waits for runtime fence; schedules remain SELECT-only',async()=>{
   const lock=await connect();await lock.query('begin;set local role cap_notification_runtime');
   await lock.query('select id from cap_notifications_private.bindings where id=$1 for update',[binding]);
   await lock.query('select * from cap_notifications_private.schedules');
   let done=false;const pending=publish([entry()]).then(r=>{done=true;return r});
   await new Promise(r=>setTimeout(r,150));assert.equal(done,false);await lock.query('rollback');await pending;
   await lock.query('begin;set local role cap_notification_runtime');await assert.rejects(lock.query('select * from cap_notifications_private.schedules for update'),e=>e.code==='42501');await lock.query('rollback');
  });
  await test('two concurrent expected-revision publications have exactly one winner',async()=>{
   const c=await connect(),expected=revision;const r=await Promise.allSettled([publish([entry()],{revision:expected}),publish([entry()],{revision:expected,client:c})]);
   assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.match(r.find(x=>x.status==='rejected').reason.message,/STALE_REVISION/);
  });
  await test('generation invalidation removes long-range schedules, preserves receipts and prevents replay',async()=>{
   await auth('select public.cap_notifications_invalidate_v1($1,1,$2,true) v',[binding,revision]);
   assert.equal((await admin.query('select count(*)::int n from cap_notifications_private.schedules')).rows[0].n,0);
   assert.equal((await admin.query('select state from cap_notifications_private.delivery_ledger')).rows[0].state,'unknown');await rejectUnchanged([entry()],/STALE_BINDING/);
  });
  await test('new RPC ACLs; sender/runtime cannot call management or access financial records',async()=>{
   for(const role of ['anon','service_role','cap_notification_runtime','cap_notification_sender_login'])assert.equal((await admin.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('cap_notifications_publish_v2','cap_notifications_schedule_readback_v2','cap_notifications_readiness_v2') and has_function_privilege($1,p.oid,'EXECUTE')`,[role])).rows[0].n,0);
   for(const role of ['cap_notification_runtime','cap_notification_sender_login','cap_notification_manager']){
    assert.equal((await admin.query(`select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth','storage','cap_sync_private','cap_notes_private') and c.relkind in ('r','p') and
     (has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege($1,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))`,[role])).rows[0].n,0);
   }
   assert.equal((await admin.query("select has_any_column_privilege('cap_notification_manager','cap_notifications_private.delivery_ledger','UPDATE') v")).rows[0].v,false);
  });
  // Real live-clock v2 publication, followed by unchanged runtime algorithms in
  // an UNEXPOSED synthetic-clock clone. No production function or dark flag is
  // changed, no sender login is enabled and no network operation exists here.
  await admin.query('create schema scheduling_runtime_whitebox;grant usage on schema scheduling_runtime_whitebox to cap_notification_runtime,cap_notification_sender_login');
  for(const op of ['claim_v1','start_dispatch_v1','finalize_v1','recover_v1']){
   let source=(await admin.query("select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='cap_notifications_runtime' and p.proname=$1",[op])).rows[0].d;
   source=source.replaceAll('cap_notifications_runtime.','scheduling_runtime_whitebox.')
    .replaceAll('clock_timestamp()',"current_setting('cap.test_now')::timestamptz")
    .replaceAll('exists(select 1 from cap_notifications_private.control where b.vapid_key_version=any(sender_allowed_vapid_versions))',"(b.vapid_key_version='v1')");
   await admin.query(source);
  }
  const run='00000000-0000-4000-8000-000000000099';
  await admin.query(`create function scheduling_runtime_whitebox.check_caller_v1() returns void language plpgsql security invoker set search_path=pg_catalog as $$begin if session_user<>'cap_notification_sender_login' then raise exception 'SYNTHETIC_AUTH';end if;end$$;
    create function scheduling_runtime_whitebox.run_ok_v1(p uuid) returns boolean language sql security invoker set search_path=pg_catalog as $$select p='${run}'::uuid$$;`);
  for(const {f}of (await admin.query("select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='scheduling_runtime_whitebox'")).rows)
   await admin.query(`alter function ${f} owner to cap_notification_runtime;revoke all on function ${f} from public;grant execute on function ${f} to cap_notification_sender_login`);
  const sender=await connect();await sender.query('set session authorization cap_notification_sender_login');
  const runtime=async(op,args)=>(await sender.query(`select scheduling_runtime_whitebox.${op}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args)).rows[0].v;
  const clock=async iso=>sender.query("select set_config('cap.test_now',$1,false)",[iso]);
  const liveDay=(await admin.query("select ((clock_timestamp() at time zone 'UTC')::date+45)::text d")).rows[0].d;
  const liveEntry=()=>entry({time_basis:'absolute',timezone:'UTC',eligible_local_date:liveDay,local_time:'09:00',send_after:liveDay+'T09:00:00Z',expires_at:liveDay+'T23:00:00Z'});
  await seed();
  await test('real live-clock v2 RPC acknowledges a 45-day instruction; no early runtime claim',async()=>{
   await publish([liveEntry()],{live:true});
   const readback=await auth('select public.cap_notifications_schedule_readback_v2($1,1) v',[binding]);
   assert.equal(new Date(readback.occurrences[0].send_after).toISOString(),liveDay+'T09:00:00.000Z');
   await clock(liveDay+'T08:59:59Z');assert.equal((await runtime('claim_v1',[run])).ok,false);
  });
  await test('45-day-old acknowledgment claims/starts at due time WITHOUT renewal; short permit TTL',async()=>{
   const before=(await admin.query('select published_at from cap_notifications_private.schedules')).rows[0].published_at.toISOString();
   await clock(liveDay+'T09:00:10Z');const claim=await runtime('claim_v1',[run]);assert.equal(claim.ok,true);
   const permit=await runtime('start_dispatch_v1',[run,claim.claim_token]);assert.equal(permit.ok,true);assert.equal(permit.ttl_seconds,300);
   assert.equal(permit.binding_id,binding);assert.equal(permit.installation_id,installation);assert.equal(permit.generation,'1');
   assert.equal((await admin.query('select published_at from cap_notifications_private.schedules')).rows[0].published_at.toISOString(),before);
   // The permit commit has crossed the at-most-once boundary. Invalidation is
   // allowed but does not claim recall; finalization preserves its receipt.
   await auth('select public.cap_notifications_invalidate_v1($1,1,$2,true) v',[binding,revision]);
   assert.equal((await runtime('finalize_v1',[claim.claim_token,'accepted',null])).state,'accepted');
  });
  await test('v2 expiry, generation and revision fences still reject runtime claims/start',async()=>{
   await seed();await publish([liveEntry()],{live:true});await clock(liveDay+'T23:00:00Z');assert.equal((await runtime('claim_v1',[run])).ok,false);
   await clock(liveDay+'T09:00:10Z');const claim=await runtime('claim_v1',[run]);assert.equal(claim.ok,true);
   await auth('select public.cap_notifications_invalidate_v1($1,1,$2,true) v',[binding,revision]);
   assert.equal((await runtime('start_dispatch_v1',[run,claim.claim_token])).ok,false);
   await seed();await publish([liveEntry()],{live:true});await admin.query('update cap_notifications_private.bindings set schedule_revision=schedule_revision+1');
   assert.equal((await runtime('claim_v1',[run])).ok,false);
  });
  await test('successor verifier rejects new function/constraint/index/ACL drift',async()=>{
   for(const drift of ["alter table cap_notifications_private.schedules drop constraint schedules_legacy_or_v2",'drop index cap_notifications_private.schedules_v2_obligation_instant_idx',
    'grant execute on function public.cap_notifications_publish_v2(uuid,bigint,bigint,bigint,text,text,text,text,jsonb) to public',
    'grant update on cap_notifications_private.schedules to cap_notification_runtime',
    'grant select on public.accounts to cap_notification_manager',
    "create or replace function cap_notifications_private.resolve_wall_v2(d date,t time,z text) returns timestamptz language sql set search_path=pg_catalog as $$select now()$$"]){
    await admin.query('begin');await admin.query(drift);assert.equal((await admin.query('select cap_notifications_runtime.contract_ok_v1() v')).rows[0].v,false);await admin.query('rollback');
   }
  });
  await test('dark constraints, sender NOLOGIN, seal and installer membership cleanup remain intact',async()=>{
   assert.equal(await verify(),true);assert.equal(await catalog(),beforeCatalog);
   assert.equal((await admin.query("select rolcanlogin from pg_roles where rolname='cap_notification_sender_login'")).rows[0].rolcanlogin,false);
   assert.equal((await admin.query("select count(*)::int n from pg_auth_members where grantor='postgres'::regrole and roleid in ('cap_notification_manager'::regrole,'cap_notification_runtime'::regrole)")).rows[0].n,0);
   assert.equal((await sender.query('select cap_notifications_runtime.begin_run_v1($1) v',[run])).rows[0].v.status,'parked');
   for(const q of ['background_enabled=true','sender_dispatch_enabled=true','sender_runtime_parked=false',"sender_allowed_vapid_versions=array['v1']"]){
    await admin.query('begin');await assert.rejects(admin.query('update cap_notifications_private.control set '+q),/check constraint/);await admin.query('rollback');
   }
  });
 })().then(()=>console.log(`PASS: ${passed} Scheduling V2 checks; local only; no activation or network delivery`))
 .catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{for(const c of clients)await c.end().catch(()=>{})});
}
