/* Phase 5B.2A1: isolated synthetic PostgreSQL contracts for the versioned VAPID
   enrollment amendment. NEVER a Supabase client. Default: disposable PGlite.
   Optional real PG is loopback, explicitly gated, disposable database named
   cap_notifications_synthetic_*. No production data, endpoint or key values. */
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const root=__dirname+'/..';
const foundationPath=root+'/supabase_notifications_foundation.sql';
const amendmentPath=root+'/supabase_notifications_enrollment_5b2a1.sql';
const raw=fs.readFileSync(foundationPath,'utf8'),amend=fs.readFileSync(amendmentPath,'utf8');
const APPROVED_SHA='7126F10B3699F2A54B216A3045E92E5EF7CB3405C89BB25E80BCDB913BD9443B';
const VERSION_RE="^v[1-9][0-9]{0,2}$";
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const owner=uuid(1),other=uuid(2);
const dh=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,17)]).toString('base64url'),secret=Buffer.alloc(16,19).toString('base64url');
const endpoint=n=>'https://fcm.googleapis.com/fcm/send/synthetic-'+n;
const tables=['profiles','user_preferences','categories','accounts','goals','debts','bills','account_statements','transactions','transfers','bill_payments','budgets','notes'];
const signature='public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamp with time zone)';
const untouched=['cap_notifications_publish_v1','cap_notifications_invalidate_v1','cap_notifications_summary_v1','cap_notifications_readiness_v1'];
let db,pgModule,connectionString,passed=0;
const test=async(label,fn)=>{await fn();passed++;console.log('PASS '+label)};
const admin=()=>db.exec('reset role');
const as=async(user=owner,role='authenticated')=>{await admin();await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,role})]);};
const call=(name,args=[])=>db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as v`,args).then(r=>r.rows[0].v);
const register=(id,generation=0,n=id,protocol='CAP_PUSH_V1',version='v1')=>
  call('cap_notifications_register_v1',[id,generation,protocol,endpoint(n),dh,secret,version,null]);
const fail=(fn,message)=>assert.rejects(fn,message);
const countBindings=async()=>{await admin();return (await db.query('select count(*)::int n from cap_notifications_private.bindings')).rows[0].n;};

const financialWorld=async()=>{await admin();const r=(await db.query(`select jsonb_build_object(
 'tables',(select jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity) order by c.oid)
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
 'policies',(select jsonb_agg(to_jsonb(p) order by p.schemaname,p.tablename,p.policyname) from pg_policies p where p.schemaname='public'),
 'functions',(select jsonb_agg(jsonb_build_array(p.oid,p.proname,p.proowner,p.proacl::text,p.prosrc,p.proconfig) order by p.oid)
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname not like 'cap_notifications_%'),
 'roles',(select jsonb_agg(to_jsonb(r) order by r.rolname) from pg_roles r where r.rolname in ('cap_sync_reader','cap_transaction_writer','cap_notes_sidecar_writer')),
 'column_acls',(select jsonb_agg(jsonb_build_array(a.attrelid,a.attname,a.attacl::text) order by a.attrelid,a.attnum)
   from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped)) as v`)).rows[0].v;
 r.rows={};for(const t of tables)r.rows[t]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) rows from public.${t} x`)).rows[0].rows;
 return r;};

const notificationWorld=async()=>{await admin();return (await db.query(`select jsonb_build_object(
 'control',(select to_jsonb(c) from cap_notifications_private.control c),
 'tables',(select jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity) order by c.oid)
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='cap_notifications_private' and c.relkind='r'),
 'policies',(select jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname) from pg_policies p where p.schemaname='cap_notifications_private'),
 'roles',(select jsonb_agg(jsonb_build_array(r.rolname,r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication) order by r.rolname)
   from pg_roles r where r.rolname in ('cap_notification_manager','cap_notification_runtime')),
 'untouched',(select jsonb_object_agg(p.proname,jsonb_build_array(p.proacl::text,pg_get_userbyid(p.proowner),p.proconfig,p.prosecdef,p.prosrc))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
   and p.proname in ('cap_notifications_publish_v1','cap_notifications_invalidate_v1','cap_notifications_summary_v1','cap_notifications_readiness_v1')),
 'register_acl',(select jsonb_build_array(p.proacl::text,pg_get_userbyid(p.proowner),p.proconfig,p.prosecdef,p.pronargs)
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='cap_notifications_register_v1')
) as v`)).rows[0].v;};

const registerSource=async()=>{await admin();return (await db.query(`select prosrc s from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='cap_notifications_register_v1'`)).rows[0].s;};

const constraintDef=async()=>{await admin();const r=await db.query(`select pg_get_constraintdef(oid) d from pg_constraint
  where conrelid='cap_notifications_private.bindings'::regclass and conname='bindings_vapid_key_version_check'`);return r.rows[0]?.d||null;};

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
  await test('approved Phase 5B.1 artifact is byte-identical and this amendment is additive only',async()=>{
   assert.equal(crypto.createHash('sha256').update(fs.readFileSync(foundationPath)).digest('hex').toUpperCase(),APPROVED_SHA);
   assert.match(amend,/\nbegin;[\s\S]*\ncommit;\s*$/);
   assert.match(amend,/NOTIFICATION_ENROLLMENT_INSTALL_NOT_APPROVED/);
   assert.match(amend,/reviewed-5b2a1-v1/);
   assert.doesNotMatch(amend,/reviewed-5b1-v1/);
   assert.doesNotMatch(amend,/create\s+extension|cron\.schedule|net\.http|vault\.|fetch\(|VAPID_PRIVATE|BEGIN [A-Z ]*PRIVATE KEY/i);
   for(const t of tables)assert.doesNotMatch(amend,new RegExp('(?:alter table|insert into|update|delete from|grant [^;]+ on) public\\.'+t+'\\b','i'));
   assert.doesNotMatch(amend,/grant cap_(?:transaction_writer|notes_sidecar_writer|sync_reader)\b/i);
   assert.doesNotMatch(amend,/create\s+(?:policy|role|schema)|drop\s+role|create\s+table/i);
   const alters=[...amend.matchAll(/alter\s+table\s+cap_notifications_private\.([a-z_]+)/gi)].map(m=>m[1]);
   assert.deepEqual([...new Set(alters)],['bindings']);
   assert.equal((amend.match(/create\s+or\s+replace\s+function\s+public\./gi)||[]).length,1);
   const body=amend.slice(amend.indexOf('create or replace function public.cap_notifications_register_v1'),amend.indexOf('-- Postflight'));
   assert.doesNotMatch(body,/unconfigured/);
   assert.ok(body.includes("p_vapid_key_version is null or p_vapid_key_version !~ '"+VERSION_RE+"'"));
   assert.match(body,/owner to cap_notification_manager|returns jsonb language plpgsql volatile security definer set search_path=pg_catalog set timezone='UTC'/);
   ['p_installation_id','p_expected_generation','p_protocol','p_endpoint','p_p256dh','p_auth','p_vapid_key_version','p_browser_expiration'].forEach(a=>assert.match(amend,new RegExp(a)));
  });

  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    revoke create on schema public from public;grant usage on schema public to anon,authenticated;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    insert into auth.users values('${owner}'),('${other}');
    create role cap_sync_reader nologin noinherit;create role cap_transaction_writer nologin noinherit;create role cap_notes_sidecar_writer nologin noinherit;`);
  await db.exec(fs.readFileSync(root+'/supabase_schema.sql','utf8').replace('create extension if not exists pgcrypto;',''));
  await db.exec(`revoke all on all tables in schema public from public,anon,authenticated;
    insert into public.profiles(id,display_name) values('${owner}','Synthetic owner');
    insert into public.accounts(id,user_id,name,account_type,balance) values('${uuid(101)}','${owner}','Synthetic account','debit',100);
    set cap.request_identity_install='reviewed-draft-only';`);
  await db.exec(fs.readFileSync(root+'/supabase_production_identity.sql','utf8'));
  if(pgModule){await db.exec('create role postgres nologin createrole bypassrls; grant usage,create on schema public to postgres; grant usage on schema auth to postgres; grant references on auth.users to postgres;');
    await db.exec('alter database '+new URL(connectionString).pathname.slice(1)+' owner to postgres');
    await db.exec('alter function public.cap_request_uid() owner to postgres; alter function public.cap_request_identity_ok() owner to postgres');
    for(const t of tables)await db.exec('alter table public.'+t+' owner to postgres');}

  await test('reviewed foundation installs before the amendment is exercised',async()=>{
   if(pgModule)await db.exec('set role postgres');
   await db.exec("set cap.notifications_install='reviewed-5b1-v1'");await db.exec(raw);await admin();
   assert.equal((await db.query("select count(*)::int n from pg_tables where schemaname='cap_notifications_private'")).rows[0].n,5);
  });

  const beforeFinancial=await financialWorld(),beforeNotification=await notificationWorld(),beforeSource=await registerSource();

  await test('unguarded amendment rolls back without changing the contract',async()=>{
   const snap=await notificationWorld();
   await fail(()=>db.exec(amend),/NOTIFICATION_ENROLLMENT_INSTALL_NOT_APPROVED/);await db.exec('rollback');
   assert.deepEqual(await notificationWorld(),snap);
   await db.exec("set cap.notifications_enrollment_5b2a1='reviewed-5b1-v1'");
   await fail(()=>db.exec(amend),/NOTIFICATION_ENROLLMENT_INSTALL_NOT_APPROVED/);await db.exec('rollback');
   assert.deepEqual(await notificationWorld(),snap);
  });

  await test('zero-binding precondition fails closed instead of rewriting existing rows',async()=>{
   await as();await register(uuid(900),0,'precondition','CAP_PUSH_V1','unconfigured');
   assert.equal(await countBindings(),1);
   await db.exec("set cap.notifications_enrollment_5b2a1='reviewed-5b2a1-v1'");
   await fail(()=>db.exec(amend),/NOTIFICATION_ENROLLMENT_BINDINGS_PRESENT/);await db.exec('rollback');
   await admin();
   await db.exec('delete from cap_notifications_private.bindings;delete from cap_notifications_private.endpoint_owners;');
   assert.equal(await countBindings(),0);
  });

  await test('guarded amendment installs transactionally and replaces only the placeholder contract',async()=>{
   await db.exec("set cap.notifications_enrollment_5b2a1='reviewed-5b2a1-v1'");await db.exec(amend);await admin();
   const def=await constraintDef();
   assert.match(def,/\^v\[1-9\]\[0-9\]\{0,2\}\$/);
   assert.doesNotMatch(def,/unconfigured/);
   assert.ok((await registerSource()).includes("p_vapid_key_version is null or p_vapid_key_version !~ '"+VERSION_RE+"'"));
  });

  await test('replaying the amendment is detected before any modification',async()=>{
   const snap=await notificationWorld();
   await fail(()=>db.exec(amend),/NOTIFICATION_ENROLLMENT_ALREADY_APPLIED/);await db.exec('rollback');
   assert.deepEqual(await notificationWorld(),snap);
  });

  await test('the table constraint rejects the retired placeholder and NULL independent of the RPC',async()=>{
   await admin();
   await db.query("insert into cap_notifications_private.endpoint_owners(fingerprint,user_id) values(sha256(convert_to($1,'UTF8')),$2)",[endpoint('constraint'),other]);
   const insert=(version)=>db.query(`insert into cap_notifications_private.bindings(user_id,installation_id,endpoint,endpoint_fingerprint,p256dh,auth,vapid_key_version)
     values($1,$2,$3,sha256(convert_to($3,'UTF8')),$4,$5,$6)`,[other,uuid(901),endpoint('constraint'),dh,secret,version]);
   await fail(()=>insert('unconfigured'),/check constraint|bindings_vapid_key_version_check/);
   await fail(()=>insert(null),/null value|not-null/i);
   await db.query('delete from cap_notifications_private.endpoint_owners where user_id=$1',[other]);
  });

  await test('accepted version matrix stores the exact identity',async()=>{
   const accepted=['v1','v2','v10','v999'];
   for(const [i,version] of accepted.entries()){
     await as();const r=await register(uuid(100+i),0,'accepted-'+version,'CAP_PUSH_V1',version);
     assert.equal(r.generation,1);assert.equal(r.state,'pending');
     await admin();
     const stored=(await db.query('select vapid_key_version v,protocol p from cap_notifications_private.bindings where id=$1',[r.binding_id])).rows[0];
     assert.equal(stored.v,version);assert.equal(stored.p,'CAP_PUSH_V1');
   }
  });

  await test('rejected version matrix fails as BINDING_INVALID without inserting a row',async()=>{
   const rejected=['unconfigured','v0','v01','V1','v1000','',' v1','v1 ','v1\n','v1;drop table cap_notifications_private.bindings','v1.0','v-1','v001','v 1'];
   for(const [i,version] of rejected.entries()){
     const n=await countBindings();await as();
     await fail(()=>register(uuid(300+i),0,'rejected-'+i,'CAP_PUSH_V1',version),/NOTIFICATION_BINDING_INVALID/);
     assert.equal(await countBindings(),n);
   }
   const n=await countBindings();await as();
   await fail(()=>register(uuid(399),0,'rejected-null','CAP_PUSH_V1',null),/NOTIFICATION_BINDING_INVALID/);
   assert.equal(await countBindings(),n);
  });

  await test('generation, CAS and endpoint replacement semantics are unchanged',async()=>{
   await as();const first=await register(uuid(500),0,'cas-1','CAP_PUSH_V1','v1');
   const second=await register(uuid(500),first.generation,'cas-2','CAP_PUSH_V1','v2');
   assert.equal(second.generation,2);assert.equal(second.state,'pending');
   await admin();const row=(await db.query('select endpoint,vapid_key_version v,generation g from cap_notifications_private.bindings where id=$1',[second.binding_id])).rows[0];
   assert.equal(row.v,'v2');assert.equal(row.g,2);assert.match(row.endpoint,/cas-2$/);
   await as();await fail(()=>register(uuid(500),1,'cas-3','CAP_PUSH_V1','v1'),/NOTIFICATION_STALE_BINDING/);
   await fail(()=>register(uuid(500),0,'cas-4','CAP_PUSH_V1','v1'),/NOTIFICATION_STALE_BINDING/);
   await fail(()=>call('cap_notifications_register_v1',[uuid(500),second.generation,'CAP_PUSH_V1',null,dh,secret,'v1',null]),/NOTIFICATION_BINDING_INVALID/);
  });

  await test('endpoint ownership reservations survive disable and still block another account',async()=>{
   await as(owner);const own=await register(uuid(600),0,'owned','CAP_PUSH_V1','v1');
   await as(other);await fail(()=>register(uuid(601),0,'owned','CAP_PUSH_V1','v1'),/NOTIFICATION_BINDING_CONFLICT/);
   await as(owner);const off=await call('cap_notifications_invalidate_v1',[own.binding_id,own.generation,own.schedule_revision,true]);
   assert.equal(off.state,'disabled');
   await as(other);await fail(()=>register(uuid(601),0,'owned','CAP_PUSH_V1','v1'),/NOTIFICATION_BINDING_CONFLICT/);
   await admin();const held=(await db.query("select user_id from cap_notifications_private.endpoint_owners where fingerprint=sha256(convert_to($1,'UTF8'))",[endpoint('owned')])).rows[0];
   assert.equal(held.user_id,owner);
  });

  await test('authenticated readiness remains foundation-ready, disabled and parked',async()=>{
   await as();const r=await call('cap_notifications_readiness_v1');
   assert.equal(r.foundation_ready,true);assert.equal(r.background_enabled,false);assert.equal(r.background_ready,false);
   assert.equal(r.runtime_parked,true);assert.equal(r.max_publication_hours,168);assert.equal(r.delivery_local_time,'09:00');
   assert.equal(r.migration_id,'CAP_NOTIFICATIONS_FOUNDATION_5B1_V1');assert.equal(r.protocol,'CAP_PUSH_V1');
  });

  await test('register carries authenticated-only execution and unchanged security attributes',async()=>{
   await admin();
   const h=async(role)=> (await db.query('select has_function_privilege($1,$2,$3) v',[role,signature,'EXECUTE'])).rows[0].v;
   assert.equal(await h('authenticated'),true);
   for(const role of ['anon','service_role','cap_notification_runtime'])assert.equal(await h(role),false);
   const pub=(await db.query(`select count(*)::int n from pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     where p.oid=$1::regprocedure and a.grantee=0`,[signature])).rows[0].n;
   assert.equal(pub,0);
   const fn=(await db.query(`select prosecdef,pg_get_userbyid(proowner) owner,proconfig,pronargs,
     (select count(*)::int from aclexplode(proacl) a where a.grantee<>0) grantees
     from pg_proc where oid=$1::regprocedure`,[signature])).rows[0];
   assert.equal(fn.prosecdef,true);assert.equal(fn.owner,'cap_notification_manager');assert.equal(fn.pronargs,8);
   assert.deepEqual(fn.proconfig,['search_path=pg_catalog','TimeZone=UTC']);assert.equal(fn.grantees,2);
  });

  await test('contract_ok remains true and anon still cannot execute registration',async()=>{
   await admin();assert.equal((await db.query('select cap_notifications_private.contract_ok() v')).rows[0].v,true);
   await as(owner,'anon');await fail(()=>register(uuid(700),0,'anon-denied'),/permission denied|AUTH_REQUIRED/);
   await admin();
  });

  await test('cached or submitted identity claims cannot replace the gateway role after amendment',async()=>{
   await admin();await db.exec('set role authenticated');
   await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,role:'anon'})]);
   await fail(()=>register(uuid(701),0,'claim-drift'),/AUTH_REQUIRED/);
   await db.query("select set_config('request.jwt.claims','{}',false)");
   await fail(()=>register(uuid(701),0,'claim-empty'),/AUTH_REQUIRED/);
   await admin();
  });

  await test('browser roles retain no notification table privilege',async()=>{
   await admin();
   for(const role of ['anon','authenticated','service_role','cap_notification_runtime'])
     for(const table of ['control','endpoint_owners','bindings','schedules','delivery_ledger']){
       const v=(await db.query('select has_table_privilege($1,$2,$3) v',[role,'cap_notifications_private.'+table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'])).rows[0].v;
       assert.equal(v,false,role+' must not touch '+table);
     }
  });

  await test('notification roles retain zero financial table/column/ownership and membership privileges',async()=>{
   await admin();
   const violations=(await db.query(`select count(*)::int n from pg_roles r cross join pg_class c
     join pg_namespace ns on ns.oid=c.relnamespace
     where r.rolname in ('cap_notification_manager','cap_notification_runtime')
       and ns.nspname='public' and c.relkind in ('r','p')
       and (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') or c.relowner=r.oid)`)).rows[0].n;
   assert.equal(violations,0);
   assert.equal((await db.query(`select count(*)::int n from pg_auth_members m join pg_roles r on r.oid=m.member
     where r.rolname in ('cap_notification_manager','cap_notification_runtime')`)).rows[0].n,0);
   for(const schema of ['cap_sync_private','cap_notes_private']){
     const exists=(await db.query('select to_regnamespace($1) is not null v',[schema])).rows[0].v;
     if(!exists)continue;
     for(const role of ['cap_notification_manager','cap_notification_runtime']){
       const v=(await db.query('select has_schema_privilege($1,$2,$3) v',[role,schema,'USAGE'])).rows[0].v;
       assert.equal(v,false,role+' must not use '+schema);
     }
   }
  });

  await test('control, policies, roles, private tables and untouched RPCs are byte-identical',async()=>{
   const after=await notificationWorld();
   assert.deepEqual(after.control,beforeNotification.control);
   assert.deepEqual(after.tables,beforeNotification.tables);
   assert.deepEqual(after.policies,beforeNotification.policies);
   assert.deepEqual(after.roles,beforeNotification.roles);
   assert.deepEqual(after.untouched,beforeNotification.untouched);
   assert.deepEqual(after.register_acl,beforeNotification.register_acl);
   assert.deepEqual(Object.keys(after.untouched).sort(),untouched.slice().sort());
  });

  await test('register differs from the reviewed 5B.1 body by exactly the VAPID predicate',async()=>{
   const after=await registerSource();
   const oldPredicate="p_vapid_key_version is distinct from 'unconfigured'";
   const newPredicate="p_vapid_key_version is null or p_vapid_key_version !~ '"+VERSION_RE+"'";
   assert.equal(beforeSource.includes(oldPredicate),true);
   assert.equal(beforeSource.replace(oldPredicate,()=>newPredicate),after);
  });

  await test('financial schema, rows, ACLs, RPCs and role definitions are unchanged',async()=>{
   assert.deepEqual(await financialWorld(),beforeFinancial);
  });

  await test('catalog-only audit reports the amendment without reading binding content',async()=>{
   const sql=fs.readFileSync(__dirname+'/sql/notifications-enrollment-audit.sql','utf8');
   assert.match(sql,/begin transaction read only;/);
   assert.doesNotMatch(sql,/from cap_notifications_private\.bindings\b(?!\))/i);
   assert.doesNotMatch(sql,/select\s+(?:endpoint|p256dh|auth|vapid_key_version)\b/i);
   const output=await db.exec(sql);
   const row=(Array.isArray(output)?output.flatMap(r=>r.rows||[]):output.rows).find(r=>r.notification_enrollment_catalog);
   assert.ok(row,'audit must return notification_enrollment_catalog');
   const r=row.notification_enrollment_catalog;
   assert.equal(r.amendment_id,'CAP_NOTIFICATIONS_ENROLLMENT_5B2A1_V1');
   assert.match(r.check_definition,/\^v\[1-9\]\[0-9\]\{0,2\}\$/);
   assert.equal(r.register_owner,'cap_notification_manager');
   assert.equal(r.register_security_definer,true);
   assert.equal(r.authenticated_execute,true);
   for(const k of ['anon_execute','service_role_execute','runtime_execute'])assert.equal(r[k],false,k);
   assert.equal(r.public_execute_grantees,0);
   assert.equal(r.bindings,await countBindings());
   assert.equal(r.control.migration_id,'CAP_NOTIFICATIONS_FOUNDATION_5B1_V1');
   assert.equal(r.control.background_enabled,false);
   assert.equal(r.control.max_publication,'168:00:00');
   assert.equal(r.control.delivery_time,'09:00:00');
   assert.equal(r.private_tables,5);assert.equal(r.public_notification_functions,5);
   assert.deepEqual(r.financial_privilege_violations,[]);
  });

  console.log(`PASS: ${passed} Phase 5B.2A1 enrollment amendment checks (${pgModule?'isolated real PostgreSQL':'disposable PGlite; no real concurrency certification'})`);
 }finally{await db.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
