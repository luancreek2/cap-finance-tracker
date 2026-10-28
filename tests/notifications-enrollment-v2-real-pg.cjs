/* Phase 5B.2A1 V2: installer membership amendment against REAL PostgreSQL 17.
   NEVER a Supabase client and NEVER production. The database must be a
   disposable loopback database named cap_notifications_synthetic_*.

   This suite exists because PGlite did not reproduce the production role and
   function-ownership shape that made the reviewed V1 installer fail with
   SQLSTATE 42501. It builds the production shape explicitly:

     bootstrap superuser : supabase_admin (oid 10, the platform grantor)
     installer           : postgres (non-superuser, CREATEROLE, BYPASSRLS)
     function owner      : cap_notification_manager
     platform membership : postgres <- cap_notification_manager
                           grantor supabase_admin, ADMIN true,
                           INHERIT false, SET false

   PostgreSQL 17 grants a newly created role to its creator with exactly that
   admin-only shape, attributed to the cluster bootstrap superuser. That is the
   production parked membership and it must survive V2 byte-for-byte. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

const root = __dirname + '/..';
const v2sql = fs.readFileSync(root + '/supabase_notifications_enrollment_5b2a1_v2.sql', 'utf8');
const v1sql = fs.readFileSync(root + '/supabase_notifications_enrollment_5b2a1.sql', 'utf8');
const foundation = fs.readFileSync(root + '/supabase_notifications_foundation.sql', 'utf8');
const schemaSql = fs.readFileSync(root + '/supabase_schema.sql', 'utf8').replace('create extension if not exists pgcrypto;', '');
const identitySql = fs.readFileSync(root + '/supabase_production_identity.sql', 'utf8');

const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const owner = uuid(1), other = uuid(2), install = uuid(10), second = uuid(11);
const dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 17)]).toString('base64url');
const secret = Buffer.alloc(16, 19).toString('base64url');
const endpoint = n => 'https://fcm.googleapis.com/fcm/send/synthetic-' + n;
const tables = ['profiles', 'user_preferences', 'categories', 'accounts', 'goals', 'debts', 'bills',
  'account_statements', 'transactions', 'transfers', 'bill_payments', 'budgets', 'notes'];
const fnSignature = 'public.cap_notifications_register_v1(uuid,bigint,text,text,text,text,text,timestamp with time zone)';
const fnHeader = 'public.cap_notifications_register_v1(p_installation_id uuid,p_expected_generation bigint,' +
  'p_protocol text,p_endpoint text,p_p256dh text,p_auth text,p_vapid_key_version text,p_browser_expiration timestamptz default null)';

let bootstrap, installer, gateway;
let passed = 0;
const test = async (label, fn) => { await fn(); passed++; console.log('PASS ' + label); };
const sha = path => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex').toUpperCase();
const digest = text => crypto.createHash('md5').update(text).digest('hex');
const shapeOf = row => ({ roleid: row.roleid, member: row.member, grantor: row.grantor,
  admin: row.admin_option, inherit: row.inherit_option, set: row.set_option });

const membership = async () => (await installer.query(
  `select m.roleid::regrole::text as roleid, m.member::regrole::text as member,
          m.grantor::regrole::text as grantor, m.admin_option, m.inherit_option, m.set_option
     from pg_auth_members m
    where m.roleid = to_regrole('cap_notification_manager')
      and m.member = to_regrole('postgres')
    order by m.grantor::regrole::text`)).rows.map(shapeOf);

const functionState = async () => (await installer.query(
  `select p.pronargs, p.prosecdef, p.proowner::regrole::text as owner,
          p.proconfig, p.proacl::text as acl, md5(pg_get_functiondef(p.oid)) as def_md5,
          md5(p.prosrc) as body_md5,
          (select pg_get_constraintdef(c.oid) from pg_constraint c
            where c.conrelid = 'cap_notifications_private.bindings'::regclass
              and c.conname = 'bindings_vapid_key_version_check') as check_def
     from pg_proc p where p.oid = $1::regprocedure`, [fnSignature])).rows[0];

const parkedSnapshot = async () => {
  const f = await functionState();
  const counts = (await installer.query(
    `select (select count(*)::int from cap_notifications_private.control) as control,
            (select count(*)::int from cap_notifications_private.bindings) as bindings,
            (select count(*)::int from cap_notifications_private.endpoint_owners) as owners,
            (select count(*)::int from cap_notifications_private.schedules) as schedules,
            (select count(*)::int from cap_notifications_private.delivery_ledger) as ledger,
            (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname like 'cap_notifications_%') as rpc_count,
            (select count(*)::int from pg_roles where rolname in
              ('cap_notification_manager','cap_notification_runtime')) as role_count`)).rows[0];
  return { check_def: f.check_def, owner: f.owner, pronargs: f.pronargs, secdef: f.prosecdef,
    config: f.proconfig, acl: f.acl, def_md5: f.def_md5, body_md5: f.body_md5,
    membership: await membership(), counts,
    contract_ok: (await installer.query('select cap_notifications_private.contract_ok() as v')).rows[0].v };
};

const capture = async () => {
  const result = (await installer.query(`select jsonb_build_object(
    'tables',(select jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relowner::regrole::text,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity) order by c.oid)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
    'policies',(select jsonb_agg(to_jsonb(p) order by p.schemaname,p.tablename,p.policyname) from pg_policies p where p.schemaname='public'),
    'functions',(select jsonb_agg(jsonb_build_array(p.oid,p.proname,p.proowner::regrole::text,p.proacl::text,p.prosrc,p.proconfig) order by p.oid)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname not like 'cap_notifications_%'),
    'roles',(select jsonb_agg(to_jsonb(r) order by r.rolname) from pg_roles r
      where r.rolname in ('cap_sync_reader','cap_transaction_writer','cap_notes_sidecar_writer')),
    'extensions',(select jsonb_agg(e.extname order by e.extname) from pg_extension e),
    'profile',(select jsonb_agg(to_jsonb(p)) from public.profiles p),
    'accounts',(select jsonb_agg(to_jsonb(a)) from public.accounts a),
    'column_acls',(select jsonb_agg(jsonb_build_array(a.attrelid,a.attname,a.attacl::text) order by a.attrelid,a.attnum)
      from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped)) as v`)).rows[0].v;
  result.financial_rows = {};
  for (const table of tables) {
    result.financial_rows[table] = (await installer.query(
      `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as rows from public.${table} t`)).rows[0].rows;
  }
  return result;
};

const negativePrivilegeViolations = async () => (await installer.query(`
  select count(*)::int as n from (
    select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p')
        and (has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or has_any_column_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
    union all
    select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'cap\_%' escape '\\'
        and (has_function_privilege('anon',p.oid,'EXECUTE')
          or has_function_privilege('service_role',p.oid,'EXECUTE'))
  ) v`)).rows[0].n;

const setGuard = async value => installer.query(
  "select set_config('cap.notifications_enrollment_5b2a1',$1,false)", [value]);

const runExpectError = async (sql, regex, label) => {
  let failed = false;
  try { await installer.query(sql); }
  catch (e) { failed = true; assert.match(e.message, regex, label + ': ' + e.message); }
  finally { await installer.query('rollback').catch(() => {}); }
  assert.equal(failed, true, label + ': expected SQL failure');
};

const inRollback = async (fn) => {
  await installer.query('begin');
  try { return await fn(); } finally { await installer.query('rollback'); }
};

const inAuthRollback = async (sub, fn) => {
  await gateway.query('begin');
  try {
    await gateway.query('set local role authenticated');
    await gateway.query("select set_config('request.jwt.claims',$1,true)",
      [JSON.stringify({ sub, role: 'authenticated' })]);
    return await fn(gateway);
  } finally { await gateway.query('rollback'); }
};

const expectRejectAtSavepoint = async (client, fn, re) => {
  await client.query('savepoint expected_failure');
  await assert.rejects(fn, re);
  await client.query('rollback to savepoint expected_failure');
};

const register = (client, version, opts = {}) => client.query(
  'select public.cap_notifications_register_v1($1,$2,$3,$4,$5,$6,$7,$8) as v',
  [opts.installation || install, opts.generation ?? 0, opts.protocol || 'CAP_PUSH_V1',
    opts.endpoint || endpoint('rpc'), opts.dh || dh, opts.secret || secret, version, null]);

const rpcAttempt = async (version, opts = {}) => {
  try {
    return { ok: true, value: (await inAuthRollback(opts.sub || owner, c => register(c, version, opts))).rows[0].v };
  } catch (e) { return { ok: false, error: e.message }; }
};

const readiness = async () => (await inAuthRollback(owner,
  c => c.query('select public.cap_notifications_readiness_v1() as v'))).rows[0].v;

(async () => {
  const url = process.env.CAP_NOTIFICATION_TEST_DATABASE_URL;
  if (!url) throw new Error('CAP_NOTIFICATION_TEST_DATABASE_URL is required; this suite never defaults to a server');
  assert.equal(process.env.CAP_NOTIFICATION_REAL_PG, 'synthetic-only');
  const parsed = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'loopback only');
  assert.match(parsed.pathname, /^\/cap_notifications_synthetic_[a-z0-9_]+$/, 'disposable synthetic database only');

  const pg = require(process.env.CAP_PG_PATH || 'pg');
  bootstrap = new pg.Client({ connectionString: url });
  await bootstrap.connect();
  try {
    const boot = (await bootstrap.query(
      `select current_user, session_user, (select oid from pg_roles where rolname=current_user) as oid,
              (select rolsuper from pg_roles where rolname=current_user) as super,
              current_setting('server_version_num')::int as version`)).rows[0];
    assert.equal(boot.version >= 170000, true, 'PostgreSQL 17+ required');
    assert.equal(boot.oid, 10, 'bootstrap role must be oid 10 (platform grantor)');
    assert.equal(boot.super, true);
    assert.equal(boot.current_user, 'supabase_admin');

    const existing = (await bootstrap.query(
      `select rolname from pg_roles where rolname in
        ('anon','authenticated','service_role','postgres','cap_notification_manager','cap_notification_runtime')`)).rows;
    assert.deepEqual(existing, [], 'fixture requires a fresh disposable database');

    const installerUrl = new URL(url);
    installerUrl.username = 'postgres';
    installerUrl.password = 'synthetic-installer';
    const gatewayUrl = new URL(url);
    gatewayUrl.username = 'cap_test_gateway';
    gatewayUrl.password = 'synthetic-gateway';

    await bootstrap.query(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create role postgres login password 'synthetic-installer' createrole bypassrls nosuperuser nocreatedb noreplication;
      create role cap_test_gateway login password 'synthetic-gateway' nosuperuser nocreatedb nocreaterole;
      grant authenticated to cap_test_gateway with admin false, inherit false, set true;
      create role cap_sync_reader nologin noinherit;
      create role cap_transaction_writer nologin noinherit;
      create role cap_notes_sidecar_writer nologin noinherit;
      create schema auth authorization postgres;
      create table auth.users(id uuid primary key);
      alter database ${parsed.pathname.slice(1)} owner to postgres;
      alter schema public owner to postgres;
      grant usage on schema auth to postgres;
      grant select,insert on auth.users to postgres;
      grant references on auth.users to postgres;
      grant usage,create on schema public to postgres;
      revoke create on schema public from public;`);

    installer = new pg.Client({ connectionString: installerUrl.href });
    await installer.connect();
    gateway = new pg.Client({ connectionString: gatewayUrl.href });
    await gateway.connect();

    const me = (await installer.query(
      `select current_user, session_user, rolsuper, rolcreaterole, rolbypassrls from pg_roles where rolname=current_user`)).rows[0];
    assert.equal(me.current_user, 'postgres');
    assert.equal(me.session_user, 'postgres');
    assert.equal(me.rolsuper, false);

    await installer.query(`
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      insert into auth.users values('${owner}'),('${other}');`);

    await installer.query(schemaSql);
    await installer.query(`
      revoke all on all tables in schema public from public,anon,authenticated;
      insert into public.profiles(id,display_name) values('${owner}','Synthetic owner');
      insert into public.accounts(id,user_id,name,account_type,balance)
        values('${uuid(101)}','${owner}','Synthetic account','debit',100);
      select set_config('cap.request_identity_install','reviewed-draft-only',false);`);
    await installer.query(identitySql);
    assert.equal((await installer.query('select public.cap_request_identity_ok() as v')).rows[0].v, true);

    const before = await capture();
    const beforeNegative = await negativePrivilegeViolations();

    await installer.query("select set_config('cap.notifications_install','reviewed-5b1-v1',false)");
    await installer.query(foundation);

    await test('V2 artifact is a new identity and the V1/5B.1 audit hashes are untouched', async () => {
      assert.equal(sha(root + '/supabase_notifications_foundation.sql'),
        '7126F10B3699F2A54B216A3045E92E5EF7CB3405C89BB25E80BCDB913BD9443B');
      assert.equal(sha(root + '/supabase_notifications_enrollment_5b2a1.sql'),
        'CB597A5D1D47A90EEFF8B5E336C68540CC0A98B86DFBFB7693B79BADFF2A3364');
      assert.match(v2sql, /Identity:\s+CAP_NOTIFICATIONS_ENROLLMENT_5B2A1_V2/);
      assert.match(v2sql, /cap\.notifications_enrollment_5b2a1/);
      assert.match(v2sql, /'reviewed-5b2a1-v2'/);
      assert.doesNotMatch(v2sql, /Identity:\s+CAP_NOTIFICATIONS_ENROLLMENT_5B2A1_V1/);
      assert.match(v2sql, /grant cap_notification_manager to current_user\s+with admin false, inherit true, set true\s+granted by current_user;/i);
      assert.match(v2sql, /revoke cap_notification_manager from current_user granted by current_user;/i);
      assert.doesNotMatch(v2sql, /create\s+extension|cron\.|net\.http|vault\.|VAPID_PRIVATE|fetch\(/i);
      const fnBlock = s => s.match(/create or replace function public\.cap_notifications_register_v1[\s\S]*?end \$\$;/)[0];
      assert.equal(fnBlock(v2sql), fnBlock(v1sql), 'VAPID function contract must be byte-identical to V1');
      assert.notEqual(v1sql, v2sql);
    });

    await test('real PG17 parks the exact Supabase/platform installer membership after foundation', async () => {
      assert.deepEqual(await membership(), [{ roleid: 'cap_notification_manager', member: 'postgres',
        grantor: 'supabase_admin', admin: true, inherit: false, set: false }]);
      const g = (await installer.query(
        `select r.oid, r.rolsuper from pg_roles r where r.rolname='supabase_admin'`)).rows[0];
      assert.equal(g.oid, 10);
      assert.equal(g.rolsuper, true);
      assert.equal((await installer.query(
        `select pg_has_role('postgres','cap_notification_manager','USAGE') as usable`)).rows[0].usable, false);
      assert.equal(await negativePrivilegeViolations(), 0);
    });

    await test('foundation postflight: contract true, VAPID parked, data zero and surface exact', async () => {
      const s = await parkedSnapshot();
      assert.equal(s.contract_ok, true);
      assert.match(s.check_def, /vapid_key_version = 'unconfigured'::text/);
      assert.equal(s.owner, 'cap_notification_manager');
      assert.equal(s.pronargs, 8);
      assert.equal(s.secdef, true);
      assert.deepEqual(s.config.sort(), ['TimeZone=UTC', 'search_path=pg_catalog']);
      assert.match(s.body_md5, /^[0-9a-f]{32}$/);
      assert.deepEqual(s.counts, { control: 1, bindings: 0, owners: 0, schedules: 0, ledger: 0, rpc_count: 5, role_count: 2 });
      assert.equal(await negativePrivilegeViolations(), 0);
    });

    await test('CREATE OR REPLACE is denied before any usable installer membership (production V1 failure)', async () => {
      const beforeProbe = await parkedSnapshot();
      await runExpectError(
        `create or replace function ${fnHeader} returns jsonb language sql as 'select null::jsonb'`,
        /must be owner of function|42501/, 'ownership probe');
      assert.deepEqual(await parkedSnapshot(), beforeProbe);
    });

    await test('temporary CURRENT_USER membership is usable for CREATE OR REPLACE without touching the platform grant', async () => {
      const beforeProbe = await parkedSnapshot();
      await inRollback(async () => {
        await installer.query('grant cap_notification_manager to current_user with admin false, inherit true, set true granted by current_user');
        assert.equal((await installer.query(
          `select pg_has_role('postgres','cap_notification_manager','USAGE') as usable`)).rows[0].usable, true);
        assert.deepEqual(await membership(), [
          { roleid: 'cap_notification_manager', member: 'postgres', grantor: 'postgres', admin: false, inherit: true, set: true },
          { roleid: 'cap_notification_manager', member: 'postgres', grantor: 'supabase_admin', admin: true, inherit: false, set: false }]);
        await installer.query(`create or replace function ${fnHeader} returns jsonb language sql as 'select null::jsonb'`);
      });
      assert.deepEqual(await parkedSnapshot(), beforeProbe);
      assert.deepEqual(await membership(), [{ roleid: 'cap_notification_manager', member: 'postgres',
        grantor: 'supabase_admin', admin: true, inherit: false, set: false }]);
    });

    await test('contract_ok rejects the temporary installer membership and stays unrelaxed', async () => {
      const contractBefore = digest((await installer.query(
        `select pg_get_functiondef('cap_notifications_private.contract_ok()'::regprocedure) as d`)).rows[0].d);
      const value = await inRollback(async () => {
        await installer.query('grant cap_notification_manager to current_user with admin false, inherit true, set true granted by current_user');
        return (await installer.query('select cap_notifications_private.contract_ok() as v')).rows[0].v;
      });
      assert.equal(value, false);
      assert.deepEqual(await membership(), [{ roleid: 'cap_notification_manager', member: 'postgres',
        grantor: 'supabase_admin', admin: true, inherit: false, set: false }]);
      const contractAfter = digest((await installer.query(
        `select pg_get_functiondef('cap_notifications_private.contract_ok()'::regprocedure) as d`)).rows[0].d);
      assert.equal(contractAfter, contractBefore);
    });

    await test('a pre-existing CURRENT_USER grant fails closed and is removed without touching the platform grant', async () => {
      await installer.query('grant cap_notification_manager to current_user with admin false, inherit true, set true granted by current_user');
      try {
        await setGuard('reviewed-5b2a1-v2');
        await runExpectError(v2sql, /TEMP_MEMBERSHIP_PRESENT/, 'pre-existing temp grant');
      } finally {
        await installer.query('revoke cap_notification_manager from current_user granted by current_user');
      }
      assert.deepEqual(await membership(), [{ roleid: 'cap_notification_manager', member: 'postgres',
        grantor: 'supabase_admin', admin: true, inherit: false, set: false }]);
    });

    await test('V2 refuses the V1 guard and leaves the foundation intact', async () => {
      const beforeGuard = await parkedSnapshot();
      await setGuard('reviewed-5b2a1-v1');
      await runExpectError(v2sql, /NOTIFICATION_ENROLLMENT_INSTALL_NOT_APPROVED/, 'V1 guard');
      assert.deepEqual(await parkedSnapshot(), beforeGuard);
    });

    await test('forced failure before cleanup rolls back the temporary grant and replacement', async () => {
      const beforeFailure = await parkedSnapshot();
      await setGuard('reviewed-5b2a1-v2');
      const injected = v2sql.replace(
        'revoke cap_notification_manager from current_user granted by current_user;',
        () => "do $$ begin raise exception 'SYNTHETIC_FAILURE_BEFORE_CLEANUP'; end $$;");
      assert.notEqual(injected, v2sql);
      await runExpectError(injected, /SYNTHETIC_FAILURE_BEFORE_CLEANUP/, 'before cleanup');
      assert.deepEqual(await parkedSnapshot(), beforeFailure);
    });

    await test('forced failure after replacement, before commit, rolls back the CHECK and function too', async () => {
      const beforeFailure = await parkedSnapshot();
      await setGuard('reviewed-5b2a1-v2');
      const cut = v2sql.lastIndexOf('commit;');
      const injected = v2sql.slice(0, cut) + "do $$ begin raise exception 'SYNTHETIC_FAILURE_BEFORE_COMMIT'; end $$;";
      assert.notEqual(injected, v2sql);
      await runExpectError(injected, /SYNTHETIC_FAILURE_BEFORE_COMMIT/, 'before commit');
      assert.deepEqual(await parkedSnapshot(), beforeFailure);
    });

    let applied;
    await test('V2 applies transactionally and restores the platform membership exactly', async () => {
      const aclBefore = (await functionState()).acl;
      const contractBefore = (await installer.query(
        `select pg_get_functiondef('cap_notifications_private.contract_ok()'::regprocedure) as d`)).rows[0].d;
      await setGuard('reviewed-5b2a1-v2');
      await installer.query(v2sql);
      applied = await parkedSnapshot();
      assert.equal(applied.contract_ok, true);
      assert.match(applied.check_def, /\^v\[1-9\]\[0-9\]\{0,2\}\$/);
      assert.doesNotMatch(applied.check_def, /unconfigured/);
      assert.equal(applied.owner, 'cap_notification_manager');
      assert.equal(applied.pronargs, 8);
      assert.equal(applied.secdef, true);
      assert.deepEqual(applied.config.sort(), ['TimeZone=UTC', 'search_path=pg_catalog']);
      assert.equal(applied.acl, aclBefore);
      assert.deepEqual(await membership(), [{ roleid: 'cap_notification_manager', member: 'postgres',
        grantor: 'supabase_admin', admin: true, inherit: false, set: false }]);
      assert.equal((await membership()).filter(m => m.grantor === 'postgres').length, 0);
      const contractAfter = (await installer.query(
        `select pg_get_functiondef('cap_notifications_private.contract_ok()'::regprocedure) as d`)).rows[0].d;
      assert.equal(contractAfter, contractBefore);
      assert.deepEqual(applied.counts, { control: 1, bindings: 0, owners: 0, schedules: 0, ledger: 0, rpc_count: 5, role_count: 2 });
      const body = (await installer.query('select prosrc from pg_proc where oid=$1::regprocedure', [fnSignature])).rows[0].prosrc;
      assert.match(body, /p_vapid_key_version is null or p_vapid_key_version !~ '\^v\[1-9\]\[0-9\]\{0,2\}\$'/);
      assert.doesNotMatch(body, /is distinct from 'unconfigured'/);
    });

    await test('readiness/control/roles remain parked and the notification roles stay restricted', async () => {
      const r = await readiness();
      assert.equal(r.foundation_ready, true);
      assert.equal(r.background_enabled, false);
      assert.equal(r.background_ready, false);
      assert.equal(r.runtime_parked, true);
      assert.equal(r.max_publication_hours, 168);
      assert.equal(r.delivery_local_time, '09:00');
      assert.equal(r.title, 'Cap reminder');
      assert.equal(r.body, 'Open Cap to review your reminders.');
      const roles = (await installer.query(
        `select rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
           from pg_roles where rolname in ('cap_notification_manager','cap_notification_runtime') order by rolname`)).rows;
      assert.equal(roles.length, 2);
      for (const role of roles) {
        assert.equal(role.rolcanlogin, false);
        assert.equal(role.rolinherit, false);
        assert.equal(role.rolsuper, false);
        assert.equal(role.rolbypassrls, false);
        assert.equal(role.rolcreatedb, false);
        assert.equal(role.rolcreaterole, false);
        assert.equal(role.rolreplication, false);
      }
      const control = (await installer.query(
        `select migration_id,protocol,engine_identity,digest_version,delivery_time::text,max_publication::text,background_enabled
           from cap_notifications_private.control`)).rows;
      assert.deepEqual(control, [{ migration_id: 'CAP_NOTIFICATIONS_FOUNDATION_5B1_V1', protocol: 'CAP_PUSH_V1',
        engine_identity: 'cap-reminder-v1', digest_version: 'hmac-sha256-v1', delivery_time: '09:00:00',
        max_publication: '168:00:00', background_enabled: false }]);
    });

    await test('function ACL is authenticated-only and unchanged by CREATE OR REPLACE', async () => {
      const f = await functionState();
      assert.equal((await installer.query(
        "select has_function_privilege('authenticated',$1,'EXECUTE') as v", [fnSignature])).rows[0].v, true);
      for (const role of ['anon', 'service_role', 'cap_notification_runtime']) {
        assert.equal((await installer.query(
          'select has_function_privilege($1,$2,\'EXECUTE\') as v', [role, fnSignature])).rows[0].v, false);
      }
      const acl = (await installer.query(`
        select count(*)::int as public_grants from pg_proc p,
          lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where p.oid=$1::regprocedure and a.grantee=0`, [fnSignature])).rows[0].public_grants;
      assert.equal(acl, 0);
      const grantees = (await installer.query(`
        select count(*)::int as n from pg_proc p,
          lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where p.oid=$1::regprocedure and a.grantee<>0`, [fnSignature])).rows[0].n;
      assert.equal(grantees, 2);
    });

    await test('CHECK constraint accepts v1..v999 and rejects parked or malformed values', async () => {
      const insert = (version, n) => inRollback(async () => {
        const url = endpoint('check-' + n);
        const fp = (await installer.query('select sha256(convert_to($1,\'UTF8\')) as v', [url])).rows[0].v;
        await installer.query('insert into cap_notifications_private.endpoint_owners(fingerprint,user_id) values($1,$2)', [fp, owner]);
        await installer.query(`
          insert into cap_notifications_private.bindings
            (user_id,installation_id,endpoint,endpoint_fingerprint,p256dh,auth,vapid_key_version)
          values($1,$2,$3,$4,$5,$6,$7)`, [owner, uuid(900 + n), url, fp, dh, secret, version]);
      });
      for (const [n, version] of ['v1', 'v2', 'v10', 'v999'].entries()) await insert(version, n);
      for (const [n, version] of ['unconfigured', 'v0', 'v01', 'V1', 'v1000', '', '  ', 'v1 ', 'v-1', 'v001', 'v 1', 'v1.0'].entries()) {
        await assert.rejects(() => insert(version, 100 + n), /check constraint|bindings_vapid_key_version_check/);
      }
      assert.equal((await installer.query('select count(*)::int as n from cap_notifications_private.bindings')).rows[0].n, 0);
      assert.equal((await installer.query('select count(*)::int as n from cap_notifications_private.endpoint_owners')).rows[0].n, 0);
    });

    await test('registration RPC accepts versioned identities and rejects parked/null/malformed values', async () => {
      for (const version of ['v1', 'v2', 'v10', 'v999']) {
        const result = await rpcAttempt(version, { installation: uuid(200 + version.length), endpoint: endpoint('rpc-' + version) });
        assert.equal(result.ok, true, version + ': ' + result.error);
        assert.equal(result.value.generation, 1);
        assert.equal(result.value.state, 'pending');
        assert.equal(result.value.installation_id, uuid(200 + version.length));
      }
      for (const version of ['unconfigured', 'v0', 'v01', 'V1', 'v1000', '', '  ', 'v1 ', 'v-1', 'v001', 'v 1', 'v1.0', 'v1\n', 'v1\t']) {
        const result = await rpcAttempt(version, { installation: uuid(300), endpoint: endpoint('bad-' + Buffer.from(version).toString('hex')) });
        assert.equal(result.ok, false, 'accepted invalid version ' + JSON.stringify(version));
        assert.match(result.error, /NOTIFICATION_BINDING_INVALID/);
      }
      const nullVersion = await rpcAttempt(null, { installation: uuid(301), endpoint: endpoint('null-version') });
      assert.equal(nullVersion.ok, false);
      assert.match(nullVersion.error, /NOTIFICATION_BINDING_INVALID/);
      assert.equal((await installer.query('select count(*)::int as n from cap_notifications_private.bindings')).rows[0].n, 0);
    });

    await test('ownership derivation, CAS, protocol and key validation are unchanged', async () => {
      await inAuthRollback(owner, async c => {
        const first = (await register(c, 'v1', { installation: install, endpoint: endpoint('cas') })).rows[0].v;
        assert.equal(first.generation, 1);
        await expectRejectAtSavepoint(c, () => register(c, 'v1', { installation: install, endpoint: endpoint('cas') }), /NOTIFICATION_STALE_BINDING/);
        const second = (await register(c, 'v2', { installation: install, endpoint: endpoint('cas-2'), generation: 1 })).rows[0].v;
        assert.equal(second.generation, 2);
        assert.equal(second.schedule_revision, 1);
      });
      const scoped = await inAuthRollback(other, async c =>
        (await register(c, 'v1', { installation: install, endpoint: endpoint('scoped') })).rows[0].v);
      assert.equal(scoped.generation, 1);
      await inAuthRollback(owner, async c => {
        await expectRejectAtSavepoint(c, () => register(c, 'v1', { installation: second, endpoint: endpoint('p'), protocol: 'UNKNOWN' }), /PROTOCOL_UNSUPPORTED/);
        await expectRejectAtSavepoint(c, () => register(c, 'v1', { installation: second, endpoint: 'http://fcm.googleapis.com/x' }), /NOTIFICATION_BINDING_INVALID/);
        await expectRejectAtSavepoint(c, () => register(c, 'v1', { installation: second, endpoint: endpoint('k'), dh: 'bad' }), /NOTIFICATION_BINDING_INVALID/);
      });
      assert.equal((await installer.query('select count(*)::int as n from cap_notifications_private.bindings')).rows[0].n, 0);
      assert.equal((await installer.query('select count(*)::int as n from cap_notifications_private.endpoint_owners')).rows[0].n, 0);
      assert.equal((await installer.query('select count(*)::int as n from cap_notifications_private.schedules')).rows[0].n, 0);
      assert.equal((await installer.query('select count(*)::int as n from cap_notifications_private.delivery_ledger')).rows[0].n, 0);
    });

    await test('financial schema, ACLs, roles and rows are byte-for-byte unchanged', async () => {
      assert.deepEqual(await capture(), before);
      assert.equal(await negativePrivilegeViolations(), beforeNegative);
      assert.equal(beforeNegative, 0);
    });

    await test('final parked state has zero notification data and true contract', async () => {
      const final = await parkedSnapshot();
      assert.deepEqual(final.counts, { control: 1, bindings: 0, owners: 0, schedules: 0, ledger: 0, rpc_count: 5, role_count: 2 });
      assert.equal(final.contract_ok, true);
      assert.deepEqual(final.membership, [{ roleid: 'cap_notification_manager', member: 'postgres',
        grantor: 'supabase_admin', admin: true, inherit: false, set: false }]);
      const schemas = (await installer.query(
        `select nspname from pg_namespace where nspname in ('cap_notifications_private','cron','net') order by 1`)).rows.map(r => r.nspname);
      assert.deepEqual(schemas, ['cap_notifications_private']);
    });

    console.log('PASS ' + passed + ' checks against PostgreSQL 17.6 (real, disposable, loopback)');
    console.log('INFO V2 SHA-256: ' + sha(root + '/supabase_notifications_enrollment_5b2a1_v2.sql'));
  } finally {
    for (const client of [gateway, installer, bootstrap]) {
      if (client) await client.end().catch(() => {});
    }
  }
})().catch(e => { console.error('FAIL ' + (e && e.stack || e)); process.exit(1); });
