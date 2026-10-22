/* Shared PGlite/real PG17 scenarios. Database/roles are synthetic and fresh.
   Bootstrap is renamed so postgres can genuinely be a NON-superuser creator. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const f = require('./production-cutover-fixture.cjs');
const repair = fs.readFileSync(`${__dirname}/../../supabase_production_notes_identity_repair.sql`, 'utf8');
const roles = ['cap_notes_sidecar_writer','cap_transaction_writer','cap_sync_reader'];
async function run(db) {
  let checks=0;
  const test=async(label,fn)=>{try{await fn();checks++;}catch(e){e.message=label+': '+e.message;throw e;}};
  const scalar=async sql=>(await db.query(sql)).rows[0].v;
  const admin=()=>db.exec('reset role');
  const user=owner=>db.exec(`reset role;set role authenticated;set request.jwt.claim.sub='${owner}';`);
  await db.exec(`create role cap_lab_super superuser;
    set session authorization cap_lab_super;
    alter role postgres rename to cap_lab_bootstrap;
    create role postgres login createrole createdb bypassrls password 'cap-role-boundary-test';
    alter schema public owner to postgres;`);
  await db.exec(`do $$begin execute format('alter database %I owner to postgres',current_database());end$$;`);
  await db.exec('set session authorization postgres');
  // A normal CREATEROLE cannot create BYPASSRLS roles. The service credential
  // stand-in needs no bypass to test private ACL denial; the owner does.
  await db.exec(f.setupSql().replace('create role service_role bypassrls;', 'create role service_role;'));
  await db.exec('grant authenticated,anon to postgres with inherit false,set true');
  await test('non-superuser postgres retains automatic creator ADMIN membership',async()=>{
    assert.equal(await scalar("select rolsuper v from pg_roles where rolname='postgres'"),false);
    const grants=(await db.query(`select g.oid grantor_oid,m.admin_option,m.inherit_option,m.set_option
      from pg_auth_members m join pg_roles g on g.oid=m.grantor
      where roleid='cap_notes_sidecar_writer'::regrole and member='postgres'::regrole`)).rows;
    assert.equal(grants.length,1);
    assert.equal(grants[0].grantor_oid,10);assert.equal(grants[0].admin_option,true);
    assert.equal(grants[0].inherit_option,false);assert.equal(grants[0].set_option,false);
  });
  await test('ordinary REVOKE leaves the bootstrap grant unchanged',async()=>{
    await db.exec('revoke cap_notes_sidecar_writer from postgres');
    assert.equal(await scalar("select count(*)::int v from pg_auth_members where roleid='cap_notes_sidecar_writer'::regrole"),1);
  });
  // Simulate the original production verifier's zero-membership assumption.
  await db.exec(`do $$ declare d text; begin
    d:=pg_get_functiondef('public.cap_verify_notes_lifecycle()'::regprocedure);
    d:=replace(d,'public.cap_role_boundary_ok(writer_oid)',
      'not exists(select 1 from pg_auth_members where roleid=writer_oid or member=writer_oid)');
    execute 'grant cap_notes_sidecar_writer to postgres';execute d;
    execute 'revoke cap_notes_sidecar_writer from postgres';end $$;`);
  const preserved=await scalar(`select jsonb_build_object(
    'notes',(select jsonb_agg(to_jsonb(x) order by id) from public.notes x),
    'lifecycle',(select jsonb_agg(to_jsonb(x) order by note_id) from cap_notes_private.note_lifecycle x)) v`);
  await test('revised repair preserves data and administrative baseline',async()=>{
    await db.exec(`set cap.notes_identity_repair='reviewed-draft-only';${repair}`);
    assert.equal(await scalar("select public.cap_role_boundary_ok('cap_notes_sidecar_writer'::regrole) v"),true);
    assert.equal(await scalar("select count(*)::int v from pg_auth_members where roleid='cap_notes_sidecar_writer'::regrole"),1);
    assert.deepEqual(await scalar(`select jsonb_build_object(
      'notes',(select jsonb_agg(to_jsonb(x) order by id) from public.notes x),
      'lifecycle',(select jsonb_agg(to_jsonb(x) order by note_id) from cap_notes_private.note_lifecycle x)) v`),preserved);
  });
  await test('repair failure rolls back operational grants but keeps baseline',async()=>{
    const failing=repair.replace(/commit;\s*$/,()=>"do $$begin raise exception 'TEST_REPAIR_ABORT';end$$;");
    await assert.rejects(db.exec(failing),/TEST_REPAIR_ABORT/);await db.exec('rollback');
    assert.equal(await scalar("select public.cap_role_boundary_ok('cap_notes_sidecar_writer'::regrole) v"),true);
    assert.equal(await scalar("select count(*)::int v from pg_auth_members where roleid='cap_notes_sidecar_writer'::regrole"),1);
  });
  await db.exec(f.transactionInstallSql);await db.exec(f.snapshotInstallSql);await db.exec(f.cutoverSql);
  for(const role of roles) await test(role+' permits only expected administrator grant',async()=>{
    assert.equal(await scalar(`select public.cap_role_boundary_ok('${role}'::regrole) v`),true);
    assert.equal(await scalar(`select count(*)::int v from pg_auth_members where roleid='${role}'::regrole`),1);
    assert.equal(await scalar(`select has_schema_privilege('${role}','auth','USAGE') v`),false);
  });
  await test('all contracts remain ready with three retained administrative grants',async()=>{
    await user(f.ids.owner);
    const r=await scalar('select public.cap_verify_production_sync_v1() v');
    assert.equal(r.ready,true,JSON.stringify(r));
    assert.equal((await scalar('select public.cap_verify_notes_lifecycle() v')).contract_ready,true);
    await admin();
  });
  for(const role of roles) {
    for(const client of ['authenticated','anon']) await test(client+' cannot SET ROLE '+role,async()=>{
      assert.equal(await scalar(`select pg_has_role('${client}','${role}','MEMBER') v`),false);
      await db.exec(`set session authorization ${client}`);
      await assert.rejects(db.exec(`set role ${role}`),/permission denied/);
      await db.exec('set session authorization postgres');
    });
    for(const option of ['INHERIT','SET']) await test(role+' rejects temporary operational '+option,async()=>{
      await db.exec(`begin;grant ${role} to postgres with ${option} true`);
      assert.equal(await scalar(`select public.cap_role_boundary_ok('${role}'::regrole) v`),false);
      await user(f.ids.owner);
      assert.equal((await scalar('select public.cap_verify_production_sync_v1() v')).ready,false);
      await db.exec('reset role;rollback');
    });
  }
  await test('outgoing writer membership is always rejected',async()=>{
    await db.exec('create role cap_other');
    await db.exec('begin;grant cap_other to cap_notes_sidecar_writer with admin true,inherit false,set false');
    assert.equal(await scalar("select public.cap_role_boundary_ok('cap_notes_sidecar_writer'::regrole) v"),false);
    await db.exec('rollback');
  });
  await test('even ADMIN-only membership granted to a browser is rejected',async()=>{
    await db.exec('begin;grant cap_notes_sidecar_writer to authenticated with admin true,inherit false,set false');
    assert.equal(await scalar("select public.cap_role_boundary_ok('cap_notes_sidecar_writer'::regrole) v"),false);
    await db.exec('rollback');
  });
  await test('superuser-issued grants are attributed to the bootstrap grantor',async()=>{
    // PG16+ records a superuser's grant against the bootstrap superuser. Such
    // a re-grant is therefore the same allowed ADMIN-only baseline, not a
    // second, untrusted grantor. A non-bootstrap grantor row stays rejected.
    await db.exec('set session authorization cap_lab_super');
    await db.exec('revoke cap_notes_sidecar_writer from postgres');
    assert.equal(await scalar("select count(*)::int v from pg_auth_members where roleid='cap_notes_sidecar_writer'::regrole"),0);
    await db.exec('grant cap_notes_sidecar_writer to postgres with admin true,inherit false,set false');
    assert.equal(await scalar("select count(*)::int v from pg_auth_members where roleid='cap_notes_sidecar_writer'::regrole and grantor<>10"),0);
    assert.equal(await scalar("select public.cap_role_boundary_ok('cap_notes_sidecar_writer'::regrole) v"),true);
    await db.exec('set session authorization postgres');
  });
  await test('a missing trusted administrator fails closed',async()=>{
    // If postgres cannot be resolved, an inbound ADMIN row must not silently
    // pass the allowed-grant predicate. Rename is transactional and rolled back.
    await db.exec('set session authorization cap_lab_super;begin');
    await db.exec('alter role postgres rename to cap_lab_admin');
    assert.equal(await scalar("select public.cap_role_boundary_ok('cap_notes_sidecar_writer'::regrole) v"),false);
    await db.exec('rollback;set session authorization postgres');
  });
  await test('unexpected inbound role is rejected',async()=>{
    await db.exec('begin;grant cap_sync_reader to cap_other with inherit false,set false');
    assert.equal(await scalar("select public.cap_role_boundary_ok('cap_sync_reader'::regrole) v"),false);
    await db.exec('rollback');
  });
  await test('indirect browser path to the writer is rejected',async()=>{
    await db.exec('set session authorization cap_lab_super;begin;create role cap_indirect;grant cap_notes_sidecar_writer to cap_indirect;grant cap_indirect to authenticated');
    assert.equal(await scalar("select public.cap_role_boundary_ok('cap_notes_sidecar_writer'::regrole) v"),false);
    await db.exec('rollback;set session authorization postgres');
  });
  await test('Notes edit replay and cross-user denial with retained membership',async()=>{
    await user(f.ids.owner);
    const expected=await scalar(`select public.cap_notes_read('${f.ids.note}') v`);
    const call=()=>db.query('select public.cap_notes_change($1,$2,$3,$4,$5) v',
      [f.ids.note,expected,'edit',{...expected.content,body:'synthetic role-boundary edit'},f.uuid(90001)]);
    assert.equal((await call()).rows[0].v.status,'APPLIED');
    assert.equal((await call()).rows[0].v.status,'ALREADY_APPLIED');
    await user(f.ids.foreign);assert.equal(await scalar(`select public.cap_notes_read('${f.ids.note}') v`),null);
    await user('');await assert.rejects(db.query('select public.cap_verify_production_sync_v1()'),/AUTH_REQUIRED/);
    await admin();
  });
  return checks;
}
module.exports={run};
