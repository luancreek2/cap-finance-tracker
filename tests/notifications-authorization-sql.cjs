/* DARK authorization foundation. Fresh loopback PG17 only; never Supabase. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const artifact=read('supabase_notifications_authorization_v1.sql');
let count=0; const clients=[];
const test=async(name,fn)=>{try{await fn();count++;console.log('PASS '+name)}catch(e){console.error('FAIL '+name);throw e}};
const id=()=>crypto.randomUUID(),owner=id(),other=id(),session=id();
const dh=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,17)]).toString('base64url'),secret=Buffer.alloc(16,19).toString('base64url');
async function sourceChecks(){
  await test('historical SQL, app, sender and existing tests unchanged',()=>{
    const files=['supabase_notifications_foundation.sql','supabase_notifications_enrollment_5b2a1_v2.sql',
      'supabase_notifications_sender_5b3.sql','supabase_notifications_scheduling_v2.sql','service-worker.js','manifest.json','index.html',
      ...fs.readdirSync(path.join(root,'js')).filter(f=>f.endsWith('.js')).map(f=>'js/'+f),
      ...fs.readdirSync(path.join(root,'supabase/functions/cap-notification-sender')).map(f=>'supabase/functions/cap-notification-sender/'+f)];
    for(const f of files) assert.equal(cp.execFileSync('git',['hash-object',f],{cwd:root,encoding:'utf8'}).trim(),cp.execFileSync('git',['rev-parse','HEAD:'+f],{cwd:root,encoding:'utf8'}).trim(),f);
  });
  await test('guarded transactional DARK migration; no financial/auth DML, LOGIN, device or receipt RPC',()=>{
    assert.match(artifact,/^begin;$/m); assert.match(artifact,/commit;\s*$/);
    assert.doesNotMatch(artifact,/\b(?:insert into|update|delete from)\s+(?:public|auth)\.|create\s+(?:extension|role)|alter\s+role|\bdelivery_eligible\b|cron\.|net\.http/i);
    assert.match(artifact,/authorization_dispatch_blocked boolean not null default true check\(authorization_dispatch_blocked\)/);
    assert.doesNotMatch(artifact,/create function public\.cap_notifications_(device_revoke|authorize_receipt)/);
  });
}
if(!process.argv.includes('--static')&&!process.env.CAP_SENDER_TEST_DATABASE_URL){
  require('./helpers/sender-pg.cjs').run(__filename).catch(e=>{console.error(e);process.exitCode=1});
}else (async()=>{
  await sourceChecks(); if(process.argv.includes('--static'))return;
  const u=new URL(process.env.CAP_SENDER_TEST_DATABASE_URL);
  assert.equal(u.hostname,'127.0.0.1');assert.match(u.pathname,/^\/cap_notifications_synthetic_[a-z0-9_]+$/);
  const {Client}=require(process.env.CAP_PG_PATH||'pg');
  async function connect(user){const v=new URL(u);if(user)v.username=user;const c=new Client({connectionString:v.href});await c.connect();clients.push(c);return c}
  const admin=await connect();assert.equal((await admin.query('select current_user u')).rows[0].u,'supabase_admin');
  assert.equal(Math.floor(Number((await admin.query('show server_version_num')).rows[0].server_version_num)/10000),17);
  assert.equal((await admin.query("select count(*)::int n from pg_roles where rolname in ('postgres','anon','cap_notification_manager')")).rows[0].n,0,'fresh cluster only');
  await admin.query(`create role postgres login createrole bypassrls;create role anon;create role authenticated;create role service_role bypassrls;
    create role cap_sync_reader nologin noinherit;create role cap_transaction_writer nologin noinherit;create role cap_notes_sidecar_writer nologin noinherit;
    create schema auth authorization postgres;create schema storage authorization postgres;revoke all on schema auth,storage from public;
    create table auth.users(id uuid primary key);grant select,insert,references on auth.users to postgres;
    alter schema public owner to postgres;revoke create on schema public from public;`);
  await admin.query(`alter database ${u.pathname.slice(1)} owner to postgres`);
  const installer=await connect('postgres'),browser=await connect(),browser2=await connect();
  await installer.query("create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;revoke all on function auth.uid() from public;grant execute on function auth.uid() to authenticated");
  await installer.query(read('supabase_schema.sql').replace('create extension if not exists pgcrypto;',''));
  await installer.query("revoke all on all tables in schema public from public,anon,authenticated;select set_config('cap.request_identity_install','reviewed-draft-only',false)");
  await installer.query(read('supabase_production_identity.sql'));
  for(const [file,setting,value]of[
    ['supabase_notifications_foundation.sql','cap.notifications_install','reviewed-5b1-v1'],
    ['supabase_notifications_enrollment_5b2a1_v2.sql','cap.notifications_enrollment_5b2a1','reviewed-5b2a1-v2'],
    ['supabase_notifications_sender_5b3.sql','cap.notifications_sender_install','reviewed-5b3b-v1'],
    ['supabase_notifications_scheduling_v2.sql','cap.notifications_scheduling_install','reviewed-scheduling-v2']]){
    await installer.query('select set_config($1,$2,false)',[setting,value]);await installer.query(read(file));
  }
  await admin.query('insert into auth.users values($1),($2)',[owner,other]);
  async function auth(sql,args=[],uid=owner,c=browser){
    await c.query('begin;set local role authenticated');
    await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:uid,role:'authenticated',session_id:session})]);
    try{const r=await c.query(sql,args);await c.query('commit');return r.rows[0]?.v}catch(e){await c.query('rollback');throw e}
  }
  const beforeMembers=(await admin.query("select to_jsonb(m) v from pg_auth_members m where roleid in ('cap_notification_manager'::regrole,'cap_notification_runtime'::regrole) order by roleid,member,grantor")).rows;
  const outside=async()=>JSON.stringify((await admin.query(`select jsonb_build_object(
    'tables',(select jsonb_agg(jsonb_build_array(c.oid,c.relacl::text,c.relowner,c.relrowsecurity,c.relforcerowsecurity) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth','storage','cap_sync_private','cap_notes_private') and c.relkind='r'),
    'functions',(select jsonb_agg(jsonb_build_array(p.oid,p.prosrc,p.proacl::text,p.proowner) order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','auth','storage','cap_sync_private','cap_notes_private') and p.proname not like 'cap_notifications_%')) v`)).rows[0].v);
  const beforeOutside=await outside(),legacyInstall=id();
  const legacy=await auth("select public.cap_notifications_register_v1($1,0,'CAP_PUSH_V1',$2,$3,$4,'v1',null) v",[legacyInstall,'https://fcm.googleapis.com/fcm/send/synthetic-backfill',dh,secret]);
  const day=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
  await auth("select public.cap_notifications_publish_v2($1,1,0,1,'CAP_PUSH_V1','cap-reminder-v1','hmac-sha256-v1','UTC',$2) v",[legacy.binding_id,JSON.stringify([{
    candidate_digest:'f'.repeat(64),obligation_digest:'e'.repeat(64),time_basis:'absolute',eligible_local_date:day,local_time:'12:00',timezone:'UTC',
    send_after:day+'T12:00:00Z',expires_at:day+'T15:00:00Z'}])]);
  const oldSchedule=(await admin.query('select to_jsonb(s) v from cap_notifications_private.schedules s')).rows[0].v;
  await test('unapproved installer rolls back all new schema',async()=>{
    await assert.rejects(installer.query(artifact),/INSTALL_NOT_APPROVED/);await installer.query('rollback');
    assert.equal((await admin.query("select to_regclass('cap_notifications_private.installation_authority') v")).rows[0].v,null);
  });
  await installer.query("select set_config('cap.notifications_authorization_install','reviewed-authorization-v1',false)");
  await test('late migration failure rolls back DDL, backfill, legacy wrappers and privileges',async()=>{
    await assert.rejects(installer.query(artifact.replace(/^commit;\s*$/m,'select 1/0;\ncommit;')),/division by zero/);
    await installer.query('rollback');
    assert.equal((await admin.query("select to_regclass('cap_notifications_private.installation_authority') v")).rows[0].v,null);
    assert.equal((await admin.query('select to_jsonb(s) v from cap_notifications_private.schedules s')).rows[0].v.authorization_id,undefined);
    assert.equal(await verifyBeforeInstall(),true);
  });
  async function verifyBeforeInstall(){return (await installer.query('select cap_notifications_runtime.contract_ok_v1() v')).rows[0].v}
  await test('non-superuser sealed successor install succeeds',async()=>{await installer.query(artifact)});
  const verify=async()=>(await installer.query('select cap_notifications_runtime.contract_ok_v1() v')).rows[0].v;
  await test('seal and all structural dispatch gates remain DARK',async()=>{
    assert.equal(await verify(),true);
    for(const set of ['background_enabled=true','sender_dispatch_enabled=true','sender_runtime_parked=false','authorization_dispatch_blocked=false']){
      await assert.rejects(admin.query('update cap_notifications_private.control set '+set),/check constraint/);
    }
    const c=(await admin.query('select * from cap_notifications_private.control')).rows[0];assert.equal(c.sender_runtime_parked,true);assert.deepEqual(c.sender_allowed_vapid_versions,[]);
    assert.equal((await admin.query("select rolcanlogin from pg_roles where rolname='cap_notification_sender_login'")).rows[0].rolcanlogin,false);
  });
  await test('backfill is unauthorized and grants no keys/consent',async()=>{
    const row=(await admin.query('select * from cap_notifications_private.installation_authority where installation_id=$1',[legacyInstall])).rows[0];
    assert.equal(row.revocation_epoch,'1');assert.equal(row.active_authorization_id,null);assert.equal(row.device_key_sha256,null);
    assert.equal((await admin.query('select count(*)::int n from cap_notifications_private.delivery_authorizations')).rows[0].n,0);
    const s=(await admin.query('select to_jsonb(s) v from cap_notifications_private.schedules s')).rows[0].v;
    for(const key of Object.keys(oldSchedule))assert.deepEqual(s[key],oldSchedule[key]);
    assert.equal(s.authorization_id,null);assert.equal(s.authorization_epoch,null);
    assert.equal((await admin.query('select state from cap_notifications_private.delivery_ledger where binding_id=$1',[legacy.binding_id])).rows[0].state,'suppressed');
  });
  const revoke=(installation,request=id(),reason='disable',uid=owner,c=browser)=>auth('select public.cap_notifications_revoke_authorization_v1($1,$2,$3) v',[installation,request,reason],uid,c);
  const status=(installation,uid=owner)=>auth('select public.cap_notifications_authorization_status_v1($1) v',[installation],uid);
  async function transport(installation=id()){
    const a=await revoke(installation);
    const b=await auth("select public.cap_notifications_register_v3($1,0,$2,'CAP_NOTIFICATION_AUTH_V1',$3,$4,$5,'v1',null) v",
      [installation,a.revocation_epoch,'https://fcm.googleapis.com/fcm/send/synthetic-'+installation,dh,secret]);
    return {installation,epoch:a.revocation_epoch,binding:b};
  }
  const prepare=(x,intent=id(),fn='public.cap_notifications_prepare_authorization_v1',key='a'.repeat(64))=>auth(`select ${fn}($1,$2,$3,$4,$5,$6,'CAP_NOTIFICATION_AUTH_V1') v`,[x.installation,x.binding.binding_id,x.binding.generation,x.epoch,intent,key]);
  const commit=(x,p,fn='public.cap_notifications_commit_authorization_v1')=>auth(`select ${fn}($1,$2,$3) v`,[p.intent_id,x.epoch,p.request_digest]);
  await test('legacy-created installation starts unauthorized; old registration never enrolls',async()=>{
    const installation=id();const r=await auth("select public.cap_notifications_register_v1($1,0,'CAP_PUSH_V1','invalid','invalid','invalid','invalid',null) v",[installation]);
    assert.equal(r.ok,false);assert.equal(r.reason,'AUTHORIZATION_UPGRADE_REQUIRED');assert.equal((await status(installation)).authorization_id,null);
    assert.equal((await admin.query('select count(*)::int n from cap_notifications_private.bindings where installation_id=$1',[installation])).rows[0].n,0);
  });
  await test('signed JWT/session claim and custom settings never bypass DENY session adapter',async()=>{
    const x=await transport();const r=await prepare(x);assert.equal(r.reason,'SESSION_AUTHORITY_UNVERIFIED');
    await browser.query("select set_config('cap.test_session_live','true',false)");assert.equal((await prepare(x)).ok,false);
    assert.equal((await admin.query('select count(*)::int n from cap_notifications_private.enrollment_intents')).rows[0].n,0);
  });
  // Isolated, unexposed whitebox clones exercise unreachable positive branches.
  // The production adapter/body/seal are NEVER changed, and no sender gate opens.
  await admin.query('create schema authorization_whitebox;grant usage on schema authorization_whitebox to cap_notification_manager,authenticated');
  for(const [signature,name]of[
    ['public.cap_notifications_prepare_authorization_v1(uuid,uuid,bigint,bigint,uuid,text,text)','prepare'],
    ['public.cap_notifications_commit_authorization_v1(uuid,bigint,text)','commit']]){
    let def=(await admin.query('select pg_get_functiondef($1::regprocedure) d',[signature])).rows[0].d;
    def=def.replace(/public\.cap_notifications_(?:prepare|commit)_authorization_v1/,'authorization_whitebox.'+name)
      .replace(/cap_notifications_private\.authorization_session_live_v1\([^)]*\)/g,'true');
    await admin.query(def);
    const sig=name==='prepare'?'uuid,uuid,bigint,bigint,uuid,text,text':'uuid,bigint,text';
    await admin.query(`alter function authorization_whitebox.${name}(${sig}) owner to cap_notification_manager;revoke all on function authorization_whitebox.${name}(${sig}) from public;grant execute on function authorization_whitebox.${name}(${sig}) to authenticated`);
  }
  const prep=x=>prepare(x,id(),'authorization_whitebox.prepare'),arm=(x,p)=>commit(x,p,'authorization_whitebox.commit');
  await test('transport pending/disabled/retired do not create any production authorization',async()=>{
    const x=await transport();
    for(const state of ['pending','disabled','retired']){
      await admin.query('update cap_notifications_private.bindings set state=$1 where id=$2',[state,x.binding.binding_id]);
      assert.equal((await prepare(x)).ok,false);assert.equal((await status(x.installation)).authorization_id,null);
      if(state!=='pending')assert.equal((await prep(x)).ok,false);
    }
  });
  await test('whitebox atomic grant, idempotent commit, and default production commit DENY',async()=>{
    const x=await transport(),p=await prep(x);assert.equal(p.ok,true);
    assert.equal((await commit(x,p)).reason,'SESSION_AUTHORITY_UNVERIFIED');
    const g=await arm(x,p);assert.equal(g.ok,true);assert.equal(g.dispatch_ready,false);
    assert.equal((await arm(x,p)).authorization_id,g.authorization_id);assert.equal((await status(x.installation)).authorization_id,g.authorization_id);
    assert.equal(await verify(),true);
  });
  await test('stale prepare/commit and old acknowledgments cannot cross revocation',async()=>{
    const x=await transport(),p=await prep(x);await revoke(x.installation);
    assert.equal((await prep(x)).ok,false);assert.equal((await arm(x,p)).ok,false);
    const y=await transport(),q=await prep(y),g=await arm(y,q);await revoke(y.installation);
    assert.equal((await arm(y,q)).ok,false);
    assert.equal((await admin.query('select state from cap_notifications_private.delivery_authorizations where authorization_id=$1',[g.authorization_id])).rows[0].state,'revoked');
  });
  await test('idempotent revoke has no second increment; conflict cannot erase tombstone',async()=>{
    const x=await transport(),request=id(),a=await revoke(x.installation,request),b=await revoke(x.installation,request);
    assert.equal(a.revocation_epoch,b.revocation_epoch);assert.equal(b.replayed,true);
    await assert.rejects(revoke(x.installation,request,'sign_out'),/IDEMPOTENCY_CONFLICT/);
    assert.equal((await status(x.installation)).revocation_epoch,a.revocation_epoch);
  });
  await test('revocation beats unrelated revision changes and suppresses claims without retrying started dispatch',async()=>{
    const x=await transport(),p=await prep(x);await arm(x,p);
    await admin.query('update cap_notifications_private.bindings set schedule_revision=999 where id=$1',[x.binding.binding_id]);
    await admin.query(`insert into cap_notifications_private.delivery_ledger(user_id,binding_id,candidate_digest,state,attempt_count,claim_token,claimed_at,
      dispatch_started_at,claimed_generation,claimed_schedule_revision,claimed_preference_revision,claimed_vapid_key_version)
      values($1,$2,$3,'claimed',1,$4,now(),null,1,999,0,'v1'),($1,$2,$5,'dispatch_started',1,$6,now(),now(),1,999,0,'v1')`,[owner,x.binding.binding_id,'b'.repeat(64),id(),'c'.repeat(64),id()]);
    assert.equal((await revoke(x.installation)).ok,true);
    const rows=(await admin.query('select state,failure_class from cap_notifications_private.delivery_ledger where binding_id=$1 order by candidate_digest',[x.binding.binding_id])).rows;
    assert.deepEqual(rows,[{state:'suppressed',failure_class:'disabled'},{state:'unknown',failure_class:'ambiguous'}]);
  });
  for(const operation of ['register','publish_v1','publish_v2','invalidate'])await test('legacy '+operation+' commits revocation and cannot restore authorization',async()=>{
    const x=await transport(),p=await prep(x);await arm(x,p);let r;
    if(operation==='register')r=await auth("select public.cap_notifications_register_v1($1,0,'CAP_PUSH_V1','invalid','invalid','invalid','invalid',null) v",[x.installation]);
    if(operation==='publish_v1')r=await auth("select public.cap_notifications_publish_v1($1,0,0,0,'invalid','invalid','invalid','invalid',null,'[]') v",[x.binding.binding_id]);
    if(operation==='publish_v2')r=await auth("select public.cap_notifications_publish_v2($1,0,0,0,'invalid','invalid','invalid','invalid','[]') v",[x.binding.binding_id]);
    if(operation==='invalidate')r=await auth('select public.cap_notifications_invalidate_v1($1,0,0,true) v',[x.binding.binding_id]);
    assert.equal(r.state,operation==='invalidate'?'disabled':'revoked');assert.equal((await status(x.installation)).authorization_id,null);
    assert.equal((await arm(x,p)).ok,false);
  });
  await test('owner isolation: foreign intent/binding reads and mutations never cross owners',async()=>{
    const x=await transport(),p=await prep(x);await arm(x,p);
    assert.equal((await status(x.installation,other)).state,'unauthorized');
    assert.equal((await auth('select public.cap_notifications_commit_authorization_v1($1,$2,$3) v',[p.intent_id,x.epoch,p.request_digest],other)).ok,false);
    await revoke(x.installation,id(),'disable',other);assert.notEqual((await status(x.installation)).authorization_id,null);
    assert.equal((await auth('select public.cap_notifications_invalidate_v1($1,0,0,true) v',[x.binding.binding_id],other)).reason,'BINDING_UNAVAILABLE');
  });
  await test('forced RLS/direct-table and helper access denied for browser/service roles',async()=>{
    for(const role of ['anon','authenticated','service_role']){
      for(const table of ['installation_authority','delivery_authorizations','enrollment_intents','revocation_requests']){
        await browser.query('begin;set local role '+role);
        await assert.rejects(browser.query('select * from cap_notifications_private.'+table),/permission denied/);await browser.query('rollback');
        assert.equal((await admin.query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') v",[role,'cap_notifications_private.'+table])).rows[0].v,false);
      }
      await browser.query('begin;set local role '+role);
      await assert.rejects(browser.query('select cap_notifications_private.authorization_session_live_v1(null,null)'),/permission denied/);await browser.query('rollback');
    }
    assert.equal((await admin.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='cap_notifications_private' and c.relname in ('installation_authority','delivery_authorizations','enrollment_intents','revocation_requests') and c.relrowsecurity and c.relforcerowsecurity")).rows[0].n,4);
    for(const role of ['anon','service_role','cap_notification_runtime','cap_notification_sender_login']){
      assert.equal((await admin.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('cap_notifications_revoke_authorization_v1','cap_notifications_register_v3','cap_notifications_prepare_authorization_v1','cap_notifications_commit_authorization_v1','cap_notifications_authorization_status_v1','cap_notifications_reset_device_key_v1') and has_function_privilege($1,p.oid,'EXECUTE')",[role])).rows[0].n,0);
    }
  });
  await test('rollback cannot leave a partial grant/pointer/consumed intent',async()=>{
    const x=await transport(),p=await prep(x);
    await browser.query('begin;set local role authenticated');await browser.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,role:'authenticated',session_id:session})]);
    const r=(await browser.query('select authorization_whitebox.commit($1,$2,$3) v',[p.intent_id,x.epoch,p.request_digest])).rows[0].v;
    assert.equal(r.ok,true);await browser.query('rollback');assert.equal((await status(x.installation)).authorization_id,null);
    assert.equal((await admin.query('select state from cap_notifications_private.enrollment_intents where intent_id=$1',[p.intent_id])).rows[0].state,'prepared');
  });
  await test('injected failure between grant insertion and pointer update leaves no partial grant',async()=>{
    const x=await transport(),p=await prep(x);
    let def=(await admin.query("select pg_get_functiondef('authorization_whitebox.commit(uuid,bigint,text)'::regprocedure) d")).rows[0].d;
    def=def.replace('authorization_whitebox.commit','authorization_whitebox.failing_commit').replace(
      'update cap_notifications_private.installation_authority set active_authorization_id=g.authorization_id',
      "raise exception 'SYNTHETIC_AFTER_GRANT_INSERT';\n    update cap_notifications_private.installation_authority set active_authorization_id=g.authorization_id");
    assert.match(def,/SYNTHETIC_AFTER_GRANT_INSERT/);await admin.query(def);
    await admin.query('alter function authorization_whitebox.failing_commit(uuid,bigint,text) owner to cap_notification_manager;revoke all on function authorization_whitebox.failing_commit(uuid,bigint,text) from public;grant execute on function authorization_whitebox.failing_commit(uuid,bigint,text) to authenticated');
    const before=(await admin.query('select count(*)::int n from cap_notifications_private.delivery_authorizations')).rows[0].n;
    await assert.rejects(commit(x,p,'authorization_whitebox.failing_commit'),/SYNTHETIC_AFTER_GRANT_INSERT/);
    assert.equal((await admin.query('select count(*)::int n from cap_notifications_private.delivery_authorizations')).rows[0].n,before);
    assert.equal((await status(x.installation)).authorization_id,null);
    assert.equal((await admin.query('select state from cap_notifications_private.enrollment_intents where intent_id=$1',[p.intent_id])).rows[0].state,'prepared');
  });
  await test('epoch exhaustion revokes, locks out, never wraps or reenrolls',async()=>{
    const x=await transport();await admin.query('update cap_notifications_private.installation_authority set revocation_epoch=9007199254740991 where installation_id=$1',[x.installation]);
    const r=await revoke(x.installation);assert.equal(r.locked_out,true);assert.equal(r.revocation_epoch,9007199254740991);
    x.epoch=r.revocation_epoch;assert.equal((await prep(x)).ok,false);
    const y=await transport();await admin.query('update cap_notifications_private.installation_authority set revocation_epoch=9007199254740990 where installation_id=$1',[y.installation]);
    const ceiling=await revoke(y.installation);assert.equal(ceiling.revocation_epoch,9007199254740991);assert.equal(ceiling.locked_out,true);
    y.epoch=ceiling.revocation_epoch;assert.equal((await prep(y)).ok,false);
  });
  await test('device key reset is revocation-first, idempotent and exposes no digest',async()=>{
    const x=await transport(),p=await prep(x);await arm(x,p);const request=id();
    const reset=()=>auth('select public.cap_notifications_reset_device_key_v1($1,$2,$3) v',[x.installation,request,'d'.repeat(64)]);
    const a=await reset(),b=await reset();assert.equal(a.revocation_epoch,b.revocation_epoch);assert.equal(b.replayed,true);
    await assert.rejects(auth('select public.cap_notifications_reset_device_key_v1($1,$2,$3) v',[x.installation,request,'e'.repeat(64)]),/IDEMPOTENCY_CONFLICT/);
    const s=await status(x.installation);assert.equal(s.authorization_id,null);
    for(const output of [a,b,s])assert.doesNotMatch(JSON.stringify(output),/device_key|endpoint|p256dh|auth_session|d{64}/);
    // Re-enroll, then replay the old reset: it must not revoke or reset the new grant.
    const rr=await revoke(x.installation),current=(await admin.query('select generation from cap_notifications_private.bindings where id=$1',[x.binding.binding_id])).rows[0];
    x.epoch=rr.revocation_epoch;
    x.binding=await auth("select public.cap_notifications_register_v3($1,$2,$3,'CAP_NOTIFICATION_AUTH_V1',$4,$5,$6,'v1',null) v",[x.installation,current.generation,x.epoch,'https://fcm.googleapis.com/fcm/send/synthetic-'+x.installation,dh,secret]);
    const q=await prepare(x,id(),'authorization_whitebox.prepare','d'.repeat(64)),g=await arm(x,q);assert.equal(g.ok,true);
    await reset();assert.equal((await status(x.installation)).authorization_id,g.authorization_id);
  });
  await test('concurrent revocations serialize and commit distinct monotonic epochs',async()=>{
    const x=await transport();const results=await Promise.all([revoke(x.installation,id(),'disable',owner,browser),revoke(x.installation,id(),'sign_out',owner,browser2)]);
    assert.deepEqual(results.map(r=>r.revocation_epoch).sort((a,b)=>a-b),[x.epoch+1,x.epoch+2]);
  });
  await test('concurrent blocked commit rechecks epoch after authoritative revocation commits',async()=>{
    const x=await transport(),p=await prep(x);
    await browser.query('begin;set local role authenticated');
    await browser.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,role:'authenticated',session_id:session})]);
    await browser.query("select pg_advisory_xact_lock(hashtextextended('cap-notifications:'||$1,0))",[owner]);
    await browser2.query("set application_name='cap-authorization-blocked-commit'");
    const pending=auth('select authorization_whitebox.commit($1,$2,$3) v',[p.intent_id,x.epoch,p.request_digest],owner,browser2);
    try{
      const start=performance.now();let blocked=false;
      while(performance.now()-start<5000){
        blocked=(await admin.query("select exists(select 1 from pg_stat_activity where application_name='cap-authorization-blocked-commit' and wait_event='advisory') v")).rows[0].v;
        if(blocked)break;await new Promise(r=>setTimeout(r,10));
      }
      assert.equal(blocked,true,'real second connection waits on owner admission lock');
      await browser.query("select public.cap_notifications_revoke_authorization_v1($1,$2,'disable') v",[x.installation,id()]);
      await browser.query('commit');assert.equal((await pending).ok,false);
      assert.equal((await status(x.installation)).authorization_id,null);
    }catch(e){await browser.query('rollback');await pending.catch(()=>{});throw e}
  });
  await test('sender claim/start return hard DENY without releasing endpoint material',async()=>{
    await admin.query('set session authorization cap_notification_sender_login');
    try{
      for(const [sql,args]of[['select cap_notifications_runtime.claim_v1($1) v',[id()]],['select cap_notifications_runtime.start_dispatch_v1($1,$2) v',[id(),id()]]]){
        const r=(await admin.query(sql,args)).rows[0].v;assert.equal(r.ok,false);assert.equal(r.status,'authorization_foundation_dark');
        assert.doesNotMatch(JSON.stringify(r),/endpoint|p256dh|authorization_id/);
      }
    }finally{await admin.query('reset session authorization')}
  });
  await test('catalog privilege drift is detected, never blessed by runtime checks',async()=>{
    await admin.query('begin;grant select on cap_notifications_private.installation_authority to authenticated');
    assert.equal((await admin.query('select cap_notifications_runtime.contract_ok_v1() v')).rows[0].v,false);
    await admin.query('rollback');assert.equal(await verify(),true);
  });
  await test('outside catalogs/platform memberships unchanged; installer rerun refuses',async()=>{
    assert.equal(await outside(),beforeOutside);
    assert.deepEqual((await admin.query("select to_jsonb(m) v from pg_auth_members m where roleid in ('cap_notification_manager'::regrole,'cap_notification_runtime'::regrole) order by roleid,member,grantor")).rows,beforeMembers);
    await assert.rejects(installer.query(artifact),/PREFLIGHT_FAILED/);await installer.query('rollback');assert.equal(await verify(),true);
  });
  console.log('PASS: '+count+' authorization foundation checks. Local PostgreSQL only; production session authority remains DENY.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{for(const c of clients)await c.end().catch(()=>{})});
