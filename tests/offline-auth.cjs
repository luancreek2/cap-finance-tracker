/* Offline auth/session regression checks. Mocked Auth/REST only; no real
   credentials, browser profile, financial state mutation, or network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../js/supabase.js`, 'utf8');
const rpcSource = fs.readFileSync(`${__dirname}/../js/production-rpc.js`, 'utf8');
const KEY = 'cap_supabase_session';
const saved = { access_token: 'token-secret', refresh_token: 'refresh-secret', expires_at: 1, user: { id: 'owner-secret' } };
const clone = x => JSON.parse(JSON.stringify(x));
function response(status, body) { return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }; }
function fixture(options = {}) {
  const f = { calls: [], writes: [], reloads: 0, timers: [], listeners: {}, online: options.online !== false };
  const storage = new Map([['pera', '{"financial":"do-not-touch"}'], ['baseline-fixture', 'do-not-touch'], ['outbox-fixture', 'do-not-touch']]);
  if (options.session !== null) storage.set(KEY, JSON.stringify(options.session || saved));
  const nodes = new Map();
  function node(id) { const n = { id, classes: [], textContent: '', value: '', disabled: false,
    classList: { add: x => n.classes.push(x) }, remove: () => nodes.delete(id) }; nodes.set(id, n); return n; }
  const context = {
    CAP_SUPABASE_CONFIG: options.unconfigured ? {} : { url: 'https://fixture.invalid', publishableKey: 'fixture-key' },
    navigator: { get onLine() { return f.online; } },
    location: { reload: () => { f.reloads++; } },
    addEventListener: (name, fn) => { f.listeners[name] = fn; },
    localStorage: { getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => { f.writes.push({ op: 'set', k }); storage.set(k, v); }, removeItem: k => { f.writes.push({ op: 'remove', k }); storage.delete(k); } },
    document: { getElementById: id => nodes.get(id) || null, body: { insertAdjacentHTML: (where, html) => {
      if (html.includes('id="cap-auth"')) {
        node('cap-auth'); node('cap-auth-error'); node('cap-auth-submit');
        node('cap-auth-email').value = 'fixture@example.invalid'; node('cap-auth-password').value = 'password-secret';
      }
      if (html.includes('id="cap-local-auth-notice"')) node('cap-local-auth-notice').textContent = html;
    } } },
    setTimeout: fn => { f.timers.push(fn); return f.timers.length; },
    fetch: async (url, args) => {
      f.calls.push({ url, args });
      if (f.handler) return f.handler(url, args);
      if (options.handler) return options.handler(url, args);
      if (url.endsWith('/auth/v1/user')) return response(200, { id: 'owner-secret' });
      if (url.includes('grant_type=refresh_token')) return response(200, { ...clone(saved), access_token: 'new-token', refresh_token: 'new-refresh' });
      return response(200, []);
    },
  };
  context.window = context; vm.createContext(context);
  vm.runInContext(rpcSource, context); vm.runInContext(source, context);
  f.api = context.CapSupabase; f.context = context; f.storage = storage; f.nodes = nodes;
  f.finish = async () => { await f.api.boot(); while (f.timers.length) f.timers.shift()(); };
  f.session = () => storage.get(KEY);
  f.localVisible = () => !nodes.has('cap-auth');
  f.untouched = () => {
    assert.equal(storage.get('pera'), '{"financial":"do-not-touch"}');
    assert.equal(storage.get('baseline-fixture'), 'do-not-touch'); assert.equal(storage.get('outbox-fixture'), 'do-not-touch');
    assert.ok(f.writes.every(w => w.k === KEY), 'Only auth storage may change');
    assert.ok(f.calls.every(c => !c.url.includes('/rest/v1/') || !c.args.method || c.args.method === 'GET' ||
      c.url.includes('cap_verify_') || c.url.includes('cap_sync_snapshot_v1')), 'No application data mutations');
  };
  return f;
}
let passed = 0;
async function test(name, body) { await body(); passed++; }
(async () => {
  await test('offline saved session allows local only without requests or writes', async () => {
    const f = fixture({ online: false }); await f.finish();
    assert.equal(f.localVisible(), true); assert.equal(f.session(), JSON.stringify(saved)); assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
    assert.equal(f.api.status().authenticated, false); assert.equal(f.api.status().userId, null); assert.equal(f.api.status().localAccess, true);
    assert.equal(f.api.status().verification, 'offline'); assert.equal(f.nodes.has('cap-local-auth-notice'), false); f.untouched();
  });
  await test('local-only access stays silent online, offline and after reconnect without changing auth state', async () => {
    const f = fixture({ handler: () => { throw TypeError('network'); } }); await f.finish();
    assert.equal(f.nodes.has('cap-local-auth-notice'), false, 'online unverified access is silent');
    assert.equal(f.api.status().authenticated, false);
    f.online = false; f.listeners.offline();
    assert.equal(f.nodes.has('cap-local-auth-notice'), false, 'offline remains silent');
    f.online = true; f.listeners.online();
    assert.equal(f.nodes.has('cap-local-auth-notice'), false, 'reconnecting remains silent');
    assert.equal(f.api.status().authenticated, false);
    f.untouched();
  });
  await test('Cloud Sync OFF and repeated unverified reloads never create an automatic notice', async () => {
    for(let i=0;i<2;i++){
      const f=fixture({handler:()=>response(503,{message:'unavailable'})});f.context.S={cloudSync:false};await f.finish();
      assert.equal(f.context.S.cloudSync,false);assert.equal(f.nodes.has('cap-local-auth-notice'),false);
      assert.equal(f.api.status().authenticated,false);assert.equal(f.session(),JSON.stringify(saved));f.untouched();
    }
  });
  await test('unrelated Cap toasts still use the real toast presenter', async () => {
    const f=fixture({online:false});await f.finish();const shown=[];
    f.context.document.querySelectorAll=()=>[];
    f.context.document.createElement=()=>({className:'',setAttribute(){},insertAdjacentHTML(){},appendChild(n){this.text=n.textContent;},classList:{add(){}},remove(){}});
    f.context.document.createTextNode=text=>({textContent:text});
    f.context.document.body.appendChild=n=>shown.push(n);
    vm.runInContext(fs.readFileSync(`${__dirname}/../js/animations.js`,'utf8').split(/\r?\n/)[0],f.context);
    f.context.toast('Reminder saved',true);assert.equal(shown.length,1);assert.equal(shown[0].text,'Reminder saved');assert.equal(shown[0].className,'toast');f.untouched();
  });
  await test('cached identity is never returned as currentUser', async () => {
    const f = fixture({ online: false }); await f.finish(); await assert.rejects(f.api.currentUser()); assert.equal(f.calls.length, 0); assert.equal(f.session(), JSON.stringify(saved)); f.untouched();
  });
  await test('offline REST writes and reads are blocked before fetch', async () => {
    const f = fixture({ online: false }); await f.finish();
    await assert.rejects(f.api.syncRequest('/rest/v1/rpc/cap_sync_snapshot_v1', { method: 'POST', body: '{}' }));
    await assert.rejects(f.api.syncRequest('/rest/v1/notes?select=*'), /DIRECT_TABLE_ACCESS_DISABLED/);
    await assert.rejects(f.api.syncRequest('/rest/v1/rpc/cap_sync_note_put', { method: 'POST', body: '{}' }), /DIRECT_TABLE_ACCESS_DISABLED/);
    assert.equal(f.calls.length, 0); assert.equal(await f.api.refreshNotesRpcReadiness(), false); assert.equal(f.api.notesRpcReady(), false); f.untouched();
  });
  await test('offline reload retains original credentials repeatedly', async () => {
    const first = fixture({ online: false }); await first.finish();
    const second = fixture({ online: false, session: JSON.parse(first.session()) }); await second.finish();
    assert.equal(second.session(), JSON.stringify(saved)); assert.equal(second.localVisible(), true); assert.equal(second.writes.length, 0); second.untouched();
  });
  await test('network failure with navigator online preserves saved session', async () => {
    const f = fixture({ handler: () => { throw TypeError('Failed to fetch token-secret'); } }); await f.finish();
    assert.equal(f.session(), JSON.stringify(saved)); assert.equal(f.localVisible(), true); assert.equal(f.api.status().authenticated, false); assert.equal(f.calls.length, 1); assert.equal(f.writes.length, 0); f.untouched();
    assert.equal(f.nodes.has('cap-local-auth-notice'),false);
  });
  for (const status of [429, 500, 502, 503]) await test(`transient user HTTP ${status} does not refresh or discard`, async () => {
    const f = fixture({ handler: () => response(status, { message: 'service unavailable' }) }); await f.finish();
    assert.equal(f.session(), JSON.stringify(saved)); assert.equal(f.localVisible(), true); assert.equal(f.calls.length, 1); assert.equal(f.writes.length, 0); f.untouched();
  });
  await test('online verified user establishes cloud identity', async () => {
    const f = fixture(); await f.finish(); assert.equal(f.api.status().authenticated, true); assert.equal(f.api.status().userId, 'owner-secret');
    assert.equal(f.api.status().verification, 'verified'); assert.equal(f.nodes.has('cap-local-auth-notice'), false); assert.equal(f.localVisible(), true);
    await f.api.syncRequest('/rest/v1/rpc/cap_sync_snapshot_v1', { method: 'POST', body: '{}' }); assert.equal(f.calls.length, 2);
    await assert.rejects(f.api.syncRequest('/rest/v1/notes?select=*'), /DIRECT_TABLE_ACCESS_DISABLED/);
    await assert.rejects(f.api.syncRequest('/rest/v1/rpc/cap_sync_note_put', { method: 'POST', body: '{}' }), /DIRECT_TABLE_ACCESS_DISABLED/);
    assert.equal(f.calls.length, 2, 'A refused path never reaches the network'); f.untouched();
  });
  await test('expired token refreshes only after explicit rejection', async () => {
    let users = 0;
    const f = fixture({ handler: url => url.endsWith('/user') ? (++users === 1 ? response(401, { message: 'expired' }) : response(200, { id: 'owner-secret' })) : response(200, { ...saved, access_token: 'renewed' }) });
    await f.finish(); assert.equal(f.api.status().authenticated, true); assert.equal(JSON.parse(f.session()).access_token, 'renewed'); assert.equal(f.calls.length, 3); f.untouched();
  });
  for (const status of [429, 500, 503]) await test(`refresh transient HTTP ${status} retains credentials`, async () => {
    const f = fixture({ handler: url => url.endsWith('/user') ? response(401, {}) : response(status, {}) }); await f.finish();
    assert.equal(f.localVisible(), true); assert.equal(f.session(), JSON.stringify(saved)); assert.equal(f.api.status().authenticated, false); f.untouched();
  });
  await test('refresh network failure retains credentials', async () => {
    const f = fixture({ handler: url => { if (url.endsWith('/user')) return response(401, {}); throw TypeError('network'); } }); await f.finish();
    assert.equal(f.session(), JSON.stringify(saved)); assert.equal(f.localVisible(), true); assert.equal(f.api.status().authenticated, false); f.untouched();
  });
  for (const body of [{ error_code: 'refresh_token_not_found' }, { code: 'refresh_token_already_used' }, { code: 'invalid_grant' }]) await test('definitive revoked refresh requires sign-in', async () => {
    const f = fixture({ handler: url => url.endsWith('/user') ? response(401, {}) : response(400, body) }); await f.finish();
    assert.equal(f.session(), undefined); assert.equal(f.localVisible(), false); assert.equal(f.api.status().authenticated, false); assert.equal(f.api.status().localAccess, false); assert.equal(f.nodes.has('cap-local-auth-notice'), false); f.untouched();
  });
  await test('ambiguous refresh HTTP 400 does not prove revocation', async () => {
    const f = fixture({ handler: url => url.endsWith('/user') ? response(401, {}) : response(400, { message: 'unknown error' }) }); await f.finish();
    assert.equal(f.session(), JSON.stringify(saved)); assert.equal(f.localVisible(), true); assert.equal(f.api.status().authenticated, false); f.untouched();
  });
  await test('renewed token survives failed subsequent verification', async () => {
    let users = 0;
    const f = fixture({ handler: url => {
      if (url.endsWith('/user')) { if (++users === 1) return response(401, {}); throw TypeError('network'); }
      return response(200, { ...saved, access_token: 'renewed', refresh_token: 'rotated' });
    } }); await f.finish();
    assert.equal(JSON.parse(f.session()).refresh_token, 'rotated'); assert.equal(f.localVisible(), true); assert.equal(f.api.status().authenticated, false); f.untouched();
  });
  await test('malformed refresh response cannot replace saved session', async () => {
    const f = fixture({ handler: url => url.endsWith('/user') ? response(401, {}) : response(200, { access_token: '' }) }); await f.finish();
    assert.equal(f.session(), JSON.stringify(saved)); assert.equal(f.api.status().authenticated, false); f.untouched();
  });
  await test('mismatched user cannot establish cloud identity', async () => {
    const f = fixture({ handler: () => response(200, { id: 'different-owner' }) }); await f.finish();
    assert.equal(f.api.status().userId, null); assert.equal(f.api.status().authenticated, false); assert.equal(f.session(), JSON.stringify(saved)); f.untouched();
  });
  await test('offline without saved session still requires online sign-in', async () => {
    const f = fixture({ online: false, session: null }); await f.finish(); assert.equal(f.localVisible(), false); assert.equal(f.api.status().localAccess, false); assert.equal(f.calls.length, 0); f.untouched();
  });
  for (const bad of [{}, { access_token: 'x' }, { access_token: 123, user: { id: 'owner' } }, []]) await test('malformed cached session never establishes cloud identity', async () => {
    const f = fixture({ online: false, session: bad }); await f.finish(); assert.equal(f.localVisible(), false); assert.equal(f.api.status().authenticated, false); assert.equal(f.api.status().userId, null); f.untouched();
  });
  await test('reconnect alone does not authorize cloud requests or push', async () => {
    const f = fixture({ online: false }); await f.finish(); f.online = true;
    await assert.rejects(f.api.syncRequest('/rest/v1/rpc/cap_sync_snapshot_v1', { method: 'POST', body: '{}' })); assert.equal(f.calls.length, 0);
    await f.api.currentUser(); assert.equal(f.api.status().authenticated, true); assert.equal(f.nodes.has('cap-local-auth-notice'), false); assert.equal(f.calls.length, 1); f.untouched();
  });
  await test('losing network invalidates verified cloud identity', async () => {
    const f = fixture(); await f.finish(); f.online = false;
    assert.equal(f.api.status().authenticated, false); assert.equal(f.api.status().userId, null);
    await assert.rejects(f.api.syncRequest('/rest/v1/rpc/cap_sync_snapshot_v1', { method: 'POST', body: '{}' })); assert.equal(f.calls.length, 1); assert.equal(f.session(), JSON.stringify(saved)); f.untouched();
  });
  await test('failed data read invalidates verification but preserves local session', async () => {
    const f = fixture(); await f.finish(); f.handler = () => { throw TypeError('network'); };
    await assert.rejects(f.api.syncRequest('/rest/v1/rpc/cap_sync_snapshot_v1', { method: 'POST', body: '{}' })); assert.equal(f.api.status().authenticated, false); assert.equal(f.session(), JSON.stringify(saved)); f.untouched();
  });
  await test('explicit offline sign-out clears auth only', async () => {
    const f = fixture({ online: false }); await f.finish(); await f.api.signOut(); assert.equal(f.session(), undefined);
    assert.equal(f.api.status().localAccess, false); assert.equal(f.reloads, 1); assert.equal(f.calls.length, 0); f.untouched();
  });
  await test('late verification cannot restore a signed-out session', async () => {
    let release;
    const f = fixture({ handler: () => new Promise(resolve => { release = resolve; }) });
    f.online = false; await f.api.signOut(); release(response(200, { id: 'owner-secret' })); await f.finish();
    assert.equal(f.session(), undefined); assert.equal(f.api.status().authenticated, false); f.untouched();
  });
  await test('offline sign-in does not delete saved credentials', async () => {
    const f = fixture({ online: false }); await f.finish();
    // Recreate only the login form for the explicit sign-in handler fixture.
    f.context.document.body.insertAdjacentHTML('afterbegin', '<div id="cap-auth"></div>');
    await f.api.signIn(); assert.equal(f.session(), JSON.stringify(saved)); assert.equal(f.calls.length, 0); f.untouched();
  });
  await test('rejected access without refresh token requires sign-in', async () => {
    const s = clone(saved); delete s.refresh_token;
    const f = fixture({ session: s, handler: () => response(401, {}) }); await f.finish();
    assert.equal(f.session(), undefined); assert.equal(f.localVisible(), false); assert.equal(f.calls.length, 1); f.untouched();
  });
  await test('refresh forbidden response requires sign-in', async () => {
    const f = fixture({ handler: url => response(url.endsWith('/user') ? 401 : 403, {}) }); await f.finish();
    assert.equal(f.session(), undefined); assert.equal(f.localVisible(), false); f.untouched();
  });
  await test('rejected user after refresh cannot grant local fallback', async () => {
    const f = fixture({ handler: url => url.endsWith('/user') ? response(401, {}) : response(200, clone(saved)) }); await f.finish();
    assert.equal(f.session(), undefined); assert.equal(f.localVisible(), false); f.untouched();
  });
  await test('interrupted response body preserves auth', async () => {
    const f = fixture({ handler: () => ({ ok: true, text: async () => { throw TypeError('response interrupted'); } }) }); await f.finish();
    assert.equal(f.session(), JSON.stringify(saved)); assert.equal(f.localVisible(), true); assert.equal(f.api.status().authenticated, false); f.untouched();
  });
  await test('online explicit sign-in verifies the new session', async () => {
    const f = fixture({ session: null }); await f.finish();
    f.handler = url => url.includes('grant_type=password') ? response(200, clone(saved)) : response(200, { id: 'owner-secret' });
    await f.api.signIn(); while (f.timers.length) f.timers.shift()();
    assert.equal(f.localVisible(), true); assert.equal(f.api.status().authenticated, true); assert.equal(f.session(), JSON.stringify(saved)); f.untouched();
  });
  await test('failed explicit sign-in does not erase an existing saved session', async () => {
    const f = fixture(); await f.finish(); f.context.document.body.insertAdjacentHTML('afterbegin', '<div id="cap-auth"></div>');
    f.handler = () => response(400, { code: 'invalid_credentials' });
    await f.api.signIn(); assert.equal(f.session(), JSON.stringify(saved)); assert.equal(f.api.status().authenticated, false); f.untouched();
  });
  await test('offline transition invalidates prior notes RPC readiness', async () => {
    const f = fixture(); await f.finish();
    f.handler = () => response(200, { version: 'CAP_NOTES_SIDECAR_V1', contract_ready: true, roles_ok: true, tables_ok: true,
      rls_ok: true, policies_ok: true, grants_ok: true, functions_ok: true, legacy_lockout_ok: true, coverage_ok: true, ready: false, production_ready: false });
    assert.equal(await f.api.refreshNotesRpcReadiness(), true); f.online = false; f.api.status();
    assert.equal(f.api.notesRpcReady(), false); assert.equal(f.api.status().authenticated, false); f.untouched();
  });
  await test('late refresh cannot reinstate explicit sign-out', async () => {
    let release;
    const f = fixture({ handler: url => url.endsWith('/user') ? response(401, {}) : new Promise(resolve => { release = resolve; }) });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof release, 'function');
    f.online = false; await f.api.signOut(); release(response(200, clone(saved))); await f.finish();
    assert.equal(f.session(), undefined); assert.equal(f.api.status().authenticated, false); f.untouched();
  });
  console.log(`PASS: ${passed} offline auth checks; mocked network and auth storage only`);
})().catch(e => { console.error(e); process.exitCode = 1; });
