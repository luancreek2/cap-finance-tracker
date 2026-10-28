/* Phase 5B.1: isolated synthetic PostgreSQL contracts. NEVER a Supabase client.
   Default: disposable PGlite. Optional real PG is loopback, explicitly gated,
   disposable database named cap_notifications_synthetic_*. No production data. */
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const raw=fs.readFileSync(__dirname+'/../supabase_notifications_foundation.sql','utf8');
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const owner=uuid(1),other=uuid(2),install=uuid(10),second=uuid(11);
const dh=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,17)]).toString('base64url'),secret=Buffer.alloc(16,19).toString('base64url');
const endpoint=n=>'https://fcm.googleapis.com/fcm/send/synthetic-'+n;
const digest=n=>crypto.createHmac('sha256',Buffer.alloc(32,23)).update('cap-push-digest-v1\0'+owner+'\0'+install+'\0cap-reminder-v1:bill:'+n+':2026-11-01:2026-11-01:due-today').digest('hex');
const tables=['profiles','user_preferences','categories','accounts','goals','debts','bills','account_statements','transactions','transfers','bill_payments','budgets','notes'];
const rpcNames=['cap_notifications_register_v1','cap_notifications_publish_v1','cap_notifications_invalidate_v1','cap_notifications_summary_v1','cap_notifications_readiness_v1'];
let db,pgModule,connectionString,passed=0;
const test=async(label,fn)=>{await fn();passed++;console.log('PASS '+label)};
const admin=()=>db.exec('reset role');
const as=async(user=owner,role='authenticated')=>{await admin();await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,role})]);};
const call=(name,args=[])=>db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as v`,args).then(r=>r.rows[0].v);
const register=(id=install,generation=0,url=endpoint(id),protocol='CAP_PUSH_V1')=>call('cap_notifications_register_v1',[id,generation,protocol,url,dh,secret,'unconfigured',null]);
const fail=async(fn,message)=>{await assert.rejects(fn,message);};
const capture=async()=>{await admin();const result=(await db.query(`select jsonb_build_object(
 'tables',(select jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity) order by c.oid)
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
 'policies',(select jsonb_agg(to_jsonb(p) order by p.schemaname,p.tablename,p.policyname) from pg_policies p where p.schemaname='public'),
 'functions',(select jsonb_agg(jsonb_build_array(p.oid,p.proname,p.proowner,p.proacl::text,p.prosrc,p.proconfig) order by p.oid)
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname not like 'cap_notifications_%'),
 'roles',(select jsonb_agg(to_jsonb(r) order by r.rolname) from pg_roles r where r.rolname in ('cap_sync_reader','cap_transaction_writer','cap_notes_sidecar_writer')),
 'profile',(select jsonb_agg(to_jsonb(p)) from public.profiles p),
 'accounts',(select jsonb_agg(to_jsonb(a)) from public.accounts a),
 'column_acls',(select jsonb_agg(jsonb_build_array(a.attrelid,a.attname,a.attacl::text) order by a.attrelid,a.attnum)
   from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped)) as v`)).rows[0].v;
 result.financial_rows={};for(const table of tables)result.financial_rows[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as rows from public.${table} t`)).rows[0].rows;
 return result;};
const rows=async()=>{await admin();return (await db.query(`select jsonb_build_object('bindings',(select jsonb_agg(to_jsonb(b) order by id) from cap_notifications_private.bindings b),
 'schedules',(select jsonb_agg(to_jsonb(s) order by candidate_digest) from cap_notifications_private.schedules s),
 'ledger',(select jsonb_agg(to_jsonb(l) order by candidate_digest) from cap_notifications_private.delivery_ledger l)) as v`)).rows[0].v;};
const window=async(zone='UTC')=>{await admin();return (await db.query(`select ((current_timestamp at time zone $1)::date+1)::text as day,
 (((current_timestamp at time zone $1)::date+1)+time '18:00') at time zone $1 as expires,
 current_timestamp+interval '6 days' as valid`,[zone])).rows[0];};
const publish=async(b,patch={})=>{const w=await window();await as(patch.user||owner);return call('cap_notifications_publish_v1',[
 b.binding_id,patch.generation??b.generation,patch.revision??b.schedule_revision,patch.preference??0,
 patch.protocol||'CAP_PUSH_V1',patch.engine||'cap-reminder-v1',patch.digestVersion||'hmac-sha256-v1',patch.zone||'UTC',
 patch.valid||w.valid,JSON.stringify(patch.entries||[{candidate_digest:digest(1),eligible_local_date:w.day,expires_at:new Date(w.expires).toISOString()}])]);};

(async()=>{
 if(process.env.CAP_NOTIFICATION_TEST_DATABASE_URL){
   const u=new URL(process.env.CAP_NOTIFICATION_TEST_DATABASE_URL);
   assert.equal(process.env.CAP_NOTIFICATION_REAL_PG,'synthetic-only');
   assert.ok(['127.0.0.1','localhost','[::1]'].includes(u.hostname));
   assert.match(u.pathname,/^\/cap_notifications_synthetic_[a-z0-9_]+$/);
   connectionString=u.href;pgModule=require(process.env.CAP_PG_PATH||'pg');
   const client=new pgModule.Client({connectionString});await client.connect();
   db={query:(...a)=>client.query(...a),exec:s=>client.query(s),close:()=>client.end()};
 }else{const {PGlite}=require(process.env.CAP_PGLITE_PATH||'@electric-sql/pglite');db=new PGlite();}
 try{
  await test('migration has no financial DDL/DML, role membership, extension, sender or cron changes',async()=>{
   assert.match(raw,/begin;[\s\S]*commit;/);assert.match(raw,/NOTIFICATION_INSTALL_NOT_APPROVED/);
   assert.doesNotMatch(raw,/create\s+extension|cron\.schedule|net\.http|vault\.|fetch\(|VAPID_PRIVATE/i);
   for(const t of tables)assert.doesNotMatch(raw,new RegExp('(?:alter table|insert into|update|delete from|grant [^;]+ on) public\\.'+t+'\\b','i'));
   assert.doesNotMatch(raw,/grant cap_(?:transaction_writer|notes_sidecar_writer|sync_reader)\b/i);
  });
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    revoke create on schema public from public;grant usage on schema public to anon,authenticated;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    insert into auth.users values('${owner}'),('${other}');
    create role cap_sync_reader nologin noinherit;create role cap_transaction_writer nologin noinherit;create role cap_notes_sidecar_writer nologin noinherit;`);
  await db.exec(fs.readFileSync(__dirname+'/../supabase_schema.sql','utf8').replace('create extension if not exists pgcrypto;',''));
  await db.exec(`revoke all on all tables in schema public from public,anon,authenticated;
    insert into public.profiles(id,display_name) values('${owner}','Synthetic owner');
    insert into public.accounts(id,user_id,name,account_type,balance) values('${uuid(101)}','${owner}','Synthetic account','debit',100);
    set cap.request_identity_install='reviewed-draft-only';`);
  await db.exec(fs.readFileSync(__dirname+'/../supabase_production_identity.sql','utf8'));
  // Real PG additionally exercises migration ownership transfer as a restricted
  // CREATEROLE/BYPASSRLS installer, not as the fixture bootstrap superuser.
  if(pgModule){await db.exec('create role postgres nologin createrole bypassrls; grant usage,create on schema public to postgres; grant usage on schema auth to postgres; grant references on auth.users to postgres;');
    await db.exec('alter database '+new URL(connectionString).pathname.slice(1)+' owner to postgres');
    await db.exec('alter function public.cap_request_uid() owner to postgres; alter function public.cap_request_identity_ok() owner to postgres');
    for(const t of tables)await db.exec('alter table public.'+t+' owner to postgres');}
  const before=await capture();
  await test('unguarded install rolls back without roles or schema',async()=>{
   await fail(()=>db.exec(raw),/NOTIFICATION_INSTALL_NOT_APPROVED/);await db.exec('rollback');
   assert.equal((await db.query("select to_regnamespace('cap_notifications_private') as n")).rows[0].n,null);
  });
  await test('preflight table privilege drift blocks DDL instead of weakening financial security',async()=>{
   await admin();await db.exec("set cap.notifications_install='reviewed-5b1-v1'; grant select on public.accounts to authenticated");
   await fail(()=>db.exec(raw),/NOTIFICATION_EXISTING_TABLE_DRIFT/);await db.exec('rollback');
   assert.equal((await db.query("select to_regnamespace('cap_notifications_private') as n")).rows[0].n,null);
   await db.exec('revoke select on public.accounts from authenticated');assert.deepEqual(await capture(),before);
  });
  await test('late installation failure rolls back schema, roles, grants and temporary memberships',async()=>{
   if(pgModule)await db.exec('set role postgres');
   await db.exec("set cap.notifications_install='reviewed-5b1-v1'");
   const injected=raw.replace("if not cap_notifications_private.contract_ok() then raise exception 'NOTIFICATION_POSTFLIGHT_FAILED'; end if;","raise exception 'SYNTHETIC_LATE_ROLLBACK';");
   assert.notEqual(injected,raw);await fail(()=>db.exec(injected),/SYNTHETIC_LATE_ROLLBACK/);await db.exec('rollback');await admin();
   assert.equal((await db.query("select to_regnamespace('cap_notifications_private') as n")).rows[0].n,null);
   assert.equal((await db.query("select count(*)::int as n from pg_roles where rolname in ('cap_notification_manager','cap_notification_runtime')")).rows[0].n,0);
   assert.deepEqual(await capture(),before);
  });
  await test('guarded installation succeeds with five forced-RLS private tables and five management RPCs',async()=>{
   if(pgModule)await db.exec('set role postgres');
   await db.exec("set cap.notifications_install='reviewed-5b1-v1'");await db.exec(raw);await admin();
   assert.equal((await db.query("select count(*)::int as n from pg_tables where schemaname='cap_notifications_private'")).rows[0].n,5);
   assert.equal((await db.query("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'cap_notifications_%'")).rows[0].n,5);
  });
  await test('catalog-only audit lists the exact proposed objects without reading sensitive rows',async()=>{
   await admin();const sql=fs.readFileSync(__dirname+'/sql/notifications-foundation-audit.sql','utf8');
   assert.match(sql,/begin transaction read only;/);assert.doesNotMatch(sql,/from (?:public\.(?:accounts|bills|transactions)|cap_notifications_private\.bindings)\b/i);
   const output=await db.exec(sql);const row=(Array.isArray(output)?output.flatMap(r=>r.rows||[]):output.rows).find(r=>r.notification_foundation_catalog);
   const r=row.notification_foundation_catalog;assert.equal(r.tables.length,5);assert.equal(r.indexes.length,10);assert.equal(r.policies.length,5);
   assert.equal(r.functions.length,10);assert.deepEqual(r.functions.filter(f=>f.schema==='public').map(f=>f.name).sort(),rpcNames.slice().sort());
   assert.deepEqual(r.financial_privilege_violations,[]);assert.ok(r.tables.every(t=>t.rls&&t.force_rls));
   console.log(`INFO catalog: ${r.constraints.length} constraints; 10 indexes; 5 policies; 10 functions; 2 restricted roles`);
  });
  await test('first-install replay rejects rather than modifying existing state',async()=>{await fail(()=>db.exec(raw),/TARGET_NOT_EMPTY/);await db.exec('rollback');assert.deepEqual(await capture(),before)});
  await test('authenticated readiness distinguishes foundation from disabled background delivery',async()=>{await as();const r=await call('cap_notifications_readiness_v1');assert.equal(r.foundation_ready,true);assert.equal(r.background_enabled,false);assert.equal(r.background_ready,false);assert.equal(r.runtime_parked,true);assert.equal(r.max_publication_hours,168);assert.equal(r.delivery_local_time,'09:00');assert.equal(r.title,'Cap reminder');assert.equal(r.body,'Open Cap to review your reminders.')});
  await test('kill switch cannot be turned on even administratively in this foundation',async()=>{await admin();await fail(()=>db.exec('update cap_notifications_private.control set background_enabled=true'),/check constraint/)});
  await test('anon and PUBLIC have no RPC execution and no browser can enumerate private secrets',async()=>{
   await admin();const grants=(await db.query(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
     lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where (n.nspname='cap_notifications_private' or p.proname like 'cap_notifications_%') and a.grantee=0`)).rows[0].n;assert.equal(grants,0);
   for(const role of ['anon','authenticated','service_role','cap_notification_runtime']){await as(owner,role);await fail(()=>db.query('select endpoint,auth,p256dh from cap_notifications_private.bindings'),/permission denied/)}
   await as(owner,'anon');for(const name of ['cap_notifications_summary_v1','cap_notifications_readiness_v1'])await fail(()=>call(name),/permission denied/);
  });
  await test('cached/submitted identity cannot replace gateway role claims',async()=>{await as();await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,role:'anon'})]);await fail(()=>register(),/AUTH_REQUIRED/);await db.query("select set_config('request.jwt.claims','{}',false)");await fail(()=>register(),/AUTH_REQUIRED/)});
  let binding;
  await test('owner registers a pending binding and safe responses omit endpoint and keys',async()=>{await as();binding=await register();assert.equal(binding.generation,1);assert.equal(binding.state,'pending');const r=await call('cap_notifications_summary_v1');assert.equal(r.bindings.length,1);assert.doesNotMatch(JSON.stringify(r),/endpoint|p256dh|fingerprint|fcm\.googleapis|"auth"/)});
  await test('unknown protocol, unsafe endpoint and malformed keys are rejected',async()=>{await as();await fail(()=>register(second,0,endpoint(2),'unknown'),/PROTOCOL_UNSUPPORTED/);for(const url of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil/x','https://u@fcm.googleapis.com/x','https://fcm.googleapis.com:443/x'])await fail(()=>register(second,0,url),/BINDING_INVALID/);await fail(()=>call('cap_notifications_register_v1',[second,0,'CAP_PUSH_V1',endpoint(2),'bad',secret,'unconfigured',null]),/BINDING_INVALID/)});
  await test('single endpoint helper is invoker-only, fixed-path and manager-only',async()=>{
   assert.equal((raw.match(/\^https:\/\//g)||[]).length,1);
   assert.match(raw,/endpoint text not null check\(cap_notifications_private\.valid_endpoint\(endpoint\)\)/);
   assert.match(raw,/or not cap_notifications_private\.valid_endpoint\(p_endpoint\)/);
   await admin();const f=(await db.query("select p.prosecdef,p.provolatile,p.proconfig from pg_proc p where p.oid='cap_notifications_private.valid_endpoint(text)'::regprocedure")).rows[0];
   assert.equal(f.prosecdef,false);assert.equal(f.provolatile,'i');assert.deepEqual(f.proconfig,['search_path=pg_catalog']);
   for(const role of ['anon','authenticated','service_role','cap_notification_runtime']){
    const allowed=(await db.query("select has_function_privilege($1,'cap_notifications_private.valid_endpoint(text)','EXECUTE') as v",[role])).rows[0].v;assert.equal(allowed,false);
   }
   await as(owner,'cap_notification_manager');assert.equal((await db.query('select cap_notifications_private.valid_endpoint($1) as v',[endpoint('helper')])).rows[0].v,true);
   assert.equal((await db.query('select cap_notifications_private.valid_endpoint(null) as v')).rows[0].v,false);await admin();
  });
  const endpointCases=[
   ['FCM',true,'https://fcm.googleapis.com/fcm/send/synthetic'],
   ['Mozilla',true,'https://updates.push.services.mozilla.com/wpush/v2/synthetic'],
   ['Apple',true,'https://web.push.apple.com/QSynthetic_1'],
   ['nested Apple subdomain',true,'https://a.b.push.apple.com/synthetic'],
   ['Edge WNS regional',true,'https://wns2-sg2p.notify.windows.com/w/?token=synthetic%2Btoken%3D'],
   ['Edge WNS db5',true,'https://db5.notify.windows.com/w/?token=synthetic'],
   ['Edge WNS dm3p root query',true,'https://dm3p.notify.windows.com/?token=synthetic'],
   ['nested WNS subdomain',true,'https://a.b.notify.windows.com/w/?token=synthetic'],
   ['HTTP',false,'http://db5.notify.windows.com/w/?token=synthetic'],
   ['localhost',false,'https://localhost/w/?token=synthetic'],
   ['IPv4',false,'https://127.0.0.1/w/?token=synthetic'],
   ['IPv6',false,'https://[::1]/w/?token=synthetic'],
   ['similar suffix',false,'https://foo.attacker-notify.windows.com/w/?token=synthetic'],
   ['Apple suffix attack',false,'https://push.apple.com.attacker.example/synthetic'],
   ['WNS suffix attack',false,'https://notify.windows.com.attacker.example/w/?token=synthetic'],
   ['arbitrary Windows',false,'https://push.windows.com/w/?token=synthetic'],
   ['arbitrary Apple',false,'https://push.apple.com/synthetic'],
   ['arbitrary Google APIs',false,'https://other.googleapis.com/synthetic'],
   ['arbitrary Mozilla',false,'https://push.mozilla.com/synthetic'],
   ['credentials',false,'https://user:password@db5.notify.windows.com/w/?token=synthetic'],
   ['fragment',false,'https://db5.notify.windows.com/w/?token=synthetic#fragment'],
   ['port 443',false,'https://db5.notify.windows.com:443/w/?token=synthetic'],
   ['arbitrary port',false,'https://web.push.apple.com:8443/synthetic'],
   ['bare WNS parent',false,'https://notify.windows.com/w/?token=synthetic'],
   ['FCM subdomain',false,'https://other.fcm.googleapis.com/synthetic'],
   ['Mozilla subdomain',false,'https://other.updates.push.services.mozilla.com/synthetic'],
   ['malformed scheme',false,'https:/db5.notify.windows.com/synthetic'],
   ['malformed escape',false,'https://db5.notify.windows.com/w/?token=%ZZ'],
   ['malformed DNS label',false,'https://-db5.notify.windows.com/w/?token=synthetic'],
   ['whitespace',false,'https://db5.notify.windows.com/w/?token=bad token'],
   ['newline',false,'https://db5.notify.windows.com/w/?token=synthetic\n'],
   ['empty',false,''],
   ['4096-character limit',true,'https://db5.notify.windows.com/w/?token='+ 'x'.repeat(4096-'https://db5.notify.windows.com/w/?token='.length)],
   ['4097-character over limit',false,'https://db5.notify.windows.com/w/?token='+ 'x'.repeat(4097-'https://db5.notify.windows.com/w/?token='.length)]
  ];
  for(const [index,[label,accepted,url]] of endpointCases.entries())await test(`${label}: helper, table CHECK and registration agree (${accepted?'accept':'reject'})`,async()=>{
   await as(owner,'cap_notification_manager');assert.equal((await db.query('select cap_notifications_private.valid_endpoint($1) as v',[url])).rows[0].v,accepted);
   await admin();await db.exec('begin');
   try{
    await db.query("insert into cap_notifications_private.endpoint_owners(fingerprint,user_id) values(sha256(convert_to($1,'UTF8')),$2)",[url,owner]);
    const insert=()=>db.query("insert into cap_notifications_private.bindings(user_id,installation_id,endpoint,endpoint_fingerprint,p256dh,auth,vapid_key_version) values($1,$2,$3,sha256(convert_to($3,'UTF8')),$4,$5,'unconfigured')",[owner,uuid(8000+index),url,dh,secret]);
    if(accepted)await insert();else await fail(insert,/check constraint/);
   }finally{await db.exec('rollback')}
   await as();await db.exec('begin');
   try{if(accepted){const r=await register(uuid(8000+index),0,url);assert.equal(r.state,'pending')}else await fail(()=>register(uuid(8000+index),0,url),/BINDING_INVALID/)}
   finally{await db.exec('rollback');await admin()}
  });
  await test('endpoint helper execute/security drift makes readiness fail closed',async()=>{
   await admin();await db.exec('grant execute on function cap_notifications_private.valid_endpoint(text) to authenticated');await as();assert.equal((await call('cap_notifications_readiness_v1')).foundation_ready,false);
   await fail(()=>register(uuid(9000)),/CONTRACT_NOT_READY/);
   await admin();await db.exec('revoke execute on function cap_notifications_private.valid_endpoint(text) from authenticated; alter function cap_notifications_private.valid_endpoint(text) security definer');await as();assert.equal((await call('cap_notifications_readiness_v1')).foundation_ready,false);
   await admin();await db.exec('alter function cap_notifications_private.valid_endpoint(text) security invoker; revoke execute on function cap_notifications_private.valid_endpoint(text) from cap_notification_manager');await as();assert.equal((await call('cap_notifications_readiness_v1')).foundation_ready,false);
   await admin();await db.exec('grant execute on function cap_notifications_private.valid_endpoint(text) to cap_notification_manager');await as();assert.equal((await call('cap_notifications_readiness_v1')).foundation_ready,true);
  });
  await test('cross-user summaries/publication/invalidation do not disclose or mutate another binding',async()=>{const s=await rows();await as(other);assert.deepEqual((await call('cap_notifications_summary_v1')).bindings,[]);await fail(()=>publish(binding,{user:other}),/STALE_BINDING/);await as(other);await fail(()=>call('cap_notifications_invalidate_v1',[binding.binding_id,1,0,true]),/STALE_BINDING/);assert.deepEqual(await rows(),s)});
  await test('endpoint ownership is reserved and cannot be silently reassigned across users',async()=>{await as(other);await fail(()=>register(second,0,endpoint(install)),/BINDING_CONFLICT/);await as();assert.equal((await call('cap_notifications_summary_v1')).bindings.length,1)});
  await test('exact seven-day boundary is accepted; one microsecond beyond is rejected',async()=>{
   const w=await window();const entries=JSON.stringify([{candidate_digest:digest(1),eligible_local_date:w.day,expires_at:new Date(w.expires).toISOString()}]);await as();
   const sql="select public.cap_notifications_publish_v1($1,$2,$3,0,'CAP_PUSH_V1','cap-reminder-v1','hmac-sha256-v1','UTC',statement_timestamp()+interval '168 hours', $4::jsonb) as v";
   const r=(await db.query(sql,[binding.binding_id,binding.generation,binding.schedule_revision,entries])).rows[0].v;binding.schedule_revision=r.schedule_revision;
   await fail(()=>db.query(sql.replace("interval '168 hours'","interval '168 hours 0.000001 seconds'"),[binding.binding_id,binding.generation,binding.schedule_revision,entries]),/EXPIRED_OR_TOO_LONG/);
  });
  await test('valid bounded publication derives 09:00 UTC and queues metadata only',async()=>{const r=await publish(binding);binding.schedule_revision=r.schedule_revision;assert.equal(r.dispatch_ready,false);const s=await rows();assert.equal(s.schedules.length,1);assert.equal(s.ledger.length,1);assert.equal(new Date(s.schedules[0].send_after).getUTCHours(),9);assert.doesNotMatch(JSON.stringify(s.schedules),/amount|merchant|account|body|title|source_id/)});
  await test('publication over seven days, expired and infinite leases fail closed',async()=>{const s=await rows();for(const valid of [new Date(Date.now()+8*864e5).toISOString(),new Date(Date.now()-10000).toISOString(),'infinity'])await fail(()=>publish(binding,{valid}),/EXPIRED_OR_TOO_LONG/);assert.deepEqual(await rows(),s)});
  await test('invalid timezone, unknown versions, injected financial fields and duplicate digest fail closed',async()=>{
   const s=await rows();await fail(()=>publish(binding,{zone:'Mars/Olympus'}),/TIMEZONE_INVALID/);await fail(()=>publish(binding,{zone:'+08:00'}),/TIMEZONE_INVALID/);
   await fail(()=>publish(binding,{engine:'cap-reminder-v2'}),/PROTOCOL_UNSUPPORTED/);await fail(()=>publish(binding,{digestVersion:'sha256-v0'}),/PROTOCOL_UNSUPPORTED/);
   const w=await window();const e={candidate_digest:digest(1),eligible_local_date:w.day,expires_at:new Date(w.expires).toISOString()};
   await fail(()=>publish(binding,{entries:[{...e,amount:100}]}),/ENTRY_INVALID/);await fail(()=>publish(binding,{entries:[e,e]}),/DUPLICATE_CANDIDATE/);assert.deepEqual(await rows(),s);
  });
  await test('malformed, null, oversized and invalid-date entries cannot replace a publication',async()=>{
   const s=await rows();const w=await window();
   for(const entries of [[null],[{}],[{candidate_digest:null,eligible_local_date:w.day,expires_at:new Date(w.expires).toISOString()}],
     [{candidate_digest:digest(1),eligible_local_date:'2027-02-30',expires_at:new Date(w.expires).toISOString()}],Array(1001).fill({})])
     await fail(()=>publish(binding,{entries}),/NOTIFICATION_ENTR(Y|IES)_INVALID/);
   assert.deepEqual(await rows(),s);
  });
  await test('stale generation/revision/preference requests leave current schedules intact',async()=>{const s=await rows();await fail(()=>publish(binding,{generation:99}),/STALE_BINDING/);await fail(()=>publish(binding,{revision:0}),/STALE_REVISION/);await fail(()=>publish(binding,{preference:-1}),/STALE_REVISION/);assert.deepEqual(await rows(),s)});
  await test('timezone instants follow IANA DST rather than a hardcoded offset',async()=>{
   await admin();const r=(await db.query(`select (date '2027-01-15'+time '09:00') at time zone 'America/New_York' as winter,
     (date '2027-07-15'+time '09:00') at time zone 'America/New_York' as summer`)).rows[0];
   assert.equal(new Date(r.winter).getUTCHours(),14);assert.equal(new Date(r.summer).getUTCHours(),13);
   const w=await window('America/New_York');const response=await publish(binding,{zone:'America/New_York',entries:[{candidate_digest:digest(5),eligible_local_date:w.day,expires_at:new Date(w.expires).toISOString()}]});binding.schedule_revision=response.schedule_revision;
   const s=await rows();assert.equal(s.schedules[0].timezone,'America/New_York');
  });
  await test('explicit invalidation advances revision without erasing deduplication receipts',async()=>{
   const before=await rows();await as();const r=await call('cap_notifications_invalidate_v1',[binding.binding_id,binding.generation,binding.schedule_revision,false]);binding.schedule_revision=r.schedule_revision;
   assert.equal(r.state,'pending');const s=await rows();assert.equal(s.schedules,null);assert.deepEqual(s.ledger,before.ledger);
   const restored=await publish(binding);binding.schedule_revision=restored.schedule_revision;
  });
  await test('replacement is atomic and preserves delivered receipts across republication',async()=>{
   await admin();await db.exec("update cap_notifications_private.delivery_ledger set state='accepted',attempt_count=1,claim_token='"+uuid(701)+"',claimed_at=statement_timestamp(),dispatch_started_at=statement_timestamp(),accepted_at=statement_timestamp() where candidate_digest='"+digest(1)+"'");
   const old=await rows();const r=await publish(binding);binding.schedule_revision=r.schedule_revision;
   const next=await rows();assert.equal(next.schedules.length,1);assert.equal(next.ledger.length,old.ledger.length);assert.deepEqual(next.ledger,old.ledger);
   const w=await window();await fail(()=>publish(binding,{entries:[{candidate_digest:digest(3),eligible_local_date:w.day,expires_at:new Date(w.expires).toISOString()},{candidate_digest:'bad',eligible_local_date:w.day,expires_at:new Date(w.expires).toISOString()}]}),/ENTRY_INVALID/);assert.deepEqual(await rows(),next);
  });
  await test('ledger duplicate uniqueness remains across binding generations',async()=>{const prior=await rows();await admin();await fail(()=>db.query('insert into cap_notifications_private.delivery_ledger(user_id,binding_id,candidate_digest) values($1,$2,$3)',[owner,binding.binding_id,digest(1)]),/duplicate key/);await as();const r=await register(install,binding.generation,endpoint('replacement'));assert.equal(r.generation,2);binding=r;const s=await rows();assert.equal(s.schedules,null);assert.deepEqual(s.ledger,prior.ledger);await as(other);await fail(()=>register(second,0,endpoint(install)),/BINDING_CONFLICT/)});
  await test('disable advances binding generation, clears schedules and rejects old-account responses',async()=>{let r=await publish(binding);binding.schedule_revision=r.schedule_revision;await as();r=await call('cap_notifications_invalidate_v1',[binding.binding_id,binding.generation,binding.schedule_revision,true]);assert.equal(r.state,'disabled');assert.equal(r.generation,3);await fail(()=>publish(binding),/STALE_BINDING/);const s=await rows();assert.equal(s.schedules,null);assert.ok(s.ledger.length>0)});
  await test('notification roles have zero financial table/column writes, ownership or writer-role membership',async()=>{
   await admin();const r=(await db.query(`select count(*)::int as n from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
     where r.rolname in ('cap_notification_manager','cap_notification_runtime') and n.nspname='public' and c.relkind in ('r','p') and
     (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES') or c.relowner=r.oid)`)).rows[0];assert.equal(r.n,0);
   assert.equal((await db.query("select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname in ('cap_notification_manager','cap_notification_runtime')")).rows[0].n,0);
   for(const role of ['cap_notification_runtime','cap_notification_manager']){await as(owner,role);for(const t of tables){await fail(()=>db.exec(`delete from public.${t} where false`),/permission denied/);await fail(()=>db.exec(`update public.${t} set ${t==='profiles'?'id':'user_id'}=${t==='profiles'?'id':'user_id'} where false`),/permission denied/)}}
  });
  await test('ledger state constraints reject ambiguous outcomes without dispatch evidence',async()=>{
   await admin();await fail(()=>db.query("update cap_notifications_private.delivery_ledger set state='unknown' where candidate_digest=$1",[digest(5)]),/check constraint/);
   await fail(()=>db.query("update cap_notifications_private.delivery_ledger set state='retry_wait' where candidate_digest=$1",[digest(5)]),/check constraint/);
  });
  await test('full ledger rejects new work without pruning prior claims or replacing schedules',async()=>{
   await as();const b=await register(uuid(150),0,endpoint(150));await admin();
   await db.query("insert into cap_notifications_private.delivery_ledger(user_id,binding_id,candidate_digest) select $1,$2,encode(sha256(convert_to('synthetic-capacity-'||i::text,'UTF8')),'hex') from generate_series(1,1000) i",[owner,b.binding_id]);
   const prior=await rows();await fail(()=>publish(b),/LEDGER_FULL/);assert.deepEqual(await rows(),prior);
  });
  await test('per-owner binding admission is bounded without affecting another owner',async()=>{
   await as(other);for(let i=0;i<20;i++)await register(uuid(200+i),0,endpoint('other-'+i));
   await fail(()=>register(uuid(230),0,endpoint(230)),/BINDING_CAPACITY/);assert.equal((await call('cap_notifications_summary_v1')).bindings.length,20);
   await as();assert.ok((await call('cap_notifications_summary_v1')).bindings.length<20);
  });
  await test('readiness detects injected financial column privilege and RLS drift',async()=>{
   await admin();await db.exec('grant update(balance) on public.accounts to cap_notification_runtime');await as();assert.equal((await call('cap_notifications_readiness_v1')).foundation_ready,false);
   await admin();await db.exec('revoke update(balance) on public.accounts from cap_notification_runtime');await db.exec('alter table cap_notifications_private.bindings no force row level security');await as();assert.equal((await call('cap_notifications_readiness_v1')).foundation_ready,false);
   await admin();await db.exec('alter table cap_notifications_private.bindings force row level security');await as();assert.equal((await call('cap_notifications_readiness_v1')).foundation_ready,true);
  });
  await test('owner-policy drift blocks management calls until the original policy is restored',async()=>{
   await admin();await db.exec('alter policy binding_owner on cap_notifications_private.bindings using(true) with check(true)');await as();
   assert.equal((await call('cap_notifications_readiness_v1')).foundation_ready,false);await fail(()=>call('cap_notifications_summary_v1'),/CONTRACT_NOT_READY/);
   await admin();await db.exec('alter policy binding_owner on cap_notifications_private.bindings using(user_id=cap_notifications_private.request_owner()) with check(user_id=cap_notifications_private.request_owner())');
   await as();assert.equal((await call('cap_notifications_readiness_v1')).foundation_ready,true);
  });
  await test('existing financial records, ACLs, RLS, RPCs and role definitions are unchanged',async()=>{assert.deepEqual(await capture(),before)});
  if(pgModule)await test('real two-session competing CAS publication allows one winner only',async()=>{
   await as();const fresh=await register(uuid(90),0,endpoint(90));const w=await window();
   const a=new pgModule.Client({connectionString}),b=new pgModule.Client({connectionString});await a.connect();await b.connect();
   try{for(const c of [a,b]){await c.query('set role authenticated');await c.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,role:'authenticated'})])}
    const args=[fresh.binding_id,1,0,0,'CAP_PUSH_V1','cap-reminder-v1','hmac-sha256-v1','UTC',w.valid,JSON.stringify([{candidate_digest:digest(91),eligible_local_date:w.day,expires_at:new Date(w.expires).toISOString()}])];
    const sql='select public.cap_notifications_publish_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)';
    const results=await Promise.allSettled([a.query(sql,args),b.query(sql,args)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/STALE_REVISION/);
   }finally{await a.end();await b.end()}
  });
  console.log(`PASS: ${passed} notification foundation SQL checks (${pgModule?'isolated real PostgreSQL':'disposable PGlite; no real concurrency certification'})`);
 }finally{await db.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
