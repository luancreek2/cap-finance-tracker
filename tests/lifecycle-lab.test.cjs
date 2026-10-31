'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { Attempt, response, CAPABILITIES } = require('./lifecycle-lab/core.js');
const { createLab } = require('./lifecycle-lab/server.cjs');
const isolation = require('./lifecycle-lab/isolation.js'), { randomUUID } = require('node:crypto');
const root = path.join(__dirname, 'lifecycle-lab');
const challenge = { worker_instance_id: 'worker', activation_id: 'activation', barrier_id: 'barrier', challenge_nonce: 'nonce', epoch: '1', intent_id: null };
const clients = [{ id: 'a', url: 'https://lab.invalid/lab/' }];
const attempt = () => new Attempt(challenge, clients, 100);
test('successful diagnostic protocol NEVER authorizes delivery', () => {
  const a = attempt(); a.receive('a', response(challenge), 150);
  const result = a.finish(clients, 2100);
  assert.equal(result.diagnosticCompatibility, true);
  assert.equal(result.promotionAllowed, false); assert.equal(result.lifecycleInvariantEstablished, false);
});
for (const [name, mutate, expected] of [
  ['malformed', () => ({}), 'malformed'],
  ['extra field', r => ({ ...r, extra: true }), 'malformed'],
  ['missing capability', r => ({ ...r, capabilities: r.capabilities.slice(1) }), 'missing-capability'],
  ['duplicate capability', r => ({ ...r, capabilities: r.capabilities.map(() => CAPABILITIES[0]) }), 'missing-capability'],
  ['wrong barrier', r => ({ ...r, barrier_id: 'old' }), 'identity-mismatch'],
  ['wrong activation', r => ({ ...r, activation_id: 'old' }), 'identity-mismatch'],
  ['wrong epoch', r => ({ ...r, epoch: '0' }), 'identity-mismatch'],
  ['wrong nonce', r => ({ ...r, challenge_nonce: 'old' }), 'identity-mismatch'],
  ['wrong worker instance', r => ({ ...r, worker_instance_id: 'old' }), 'identity-mismatch'],
  ['wrong intent', r => ({ ...r, intent_id: 'old' }), 'identity-mismatch'],
  ['legacy contract', r => ({ ...r, client_contract: 'legacy' }), 'incompatible'],
  ['reload required', r => ({ ...r, status: 'reload-required' }), 'incompatible']
]) test(name + ' fails closed', () => {
  const a = attempt(); a.receive('a', mutate(response(challenge)), 150);
  const result = a.finish(clients, 2100); assert.equal(result.diagnosticCompatibility, false);
  assert.ok(result.failures.some(f => f.startsWith(expected))); assert.equal(result.promotionAllowed, false);
});
test('duplicates, unknown clients, timeout and monotonic deadlines fail', () => {
  const a = attempt(); a.receive('a', response(challenge), 120); a.receive('a', response(challenge), 121);
  assert.ok(a.finish(clients, 2100).failures.includes('duplicate:a'));
  const b = attempt(); b.receive('x', response(challenge), 120);
  assert.ok(b.finish(clients, 2100).failures.includes('unknown-client'));
  assert.ok(attempt().finish(clients, 2100).failures.includes('timeout:a'));
  const c = attempt(); c.receive('a', response(challenge), 2101);
  assert.ok(c.finish(clients, 2102).failures.includes('late:a'));
  assert.ok(attempt().finish(clients, 5101).failures.includes('attempt-deadline'));
  assert.ok(attempt().finish(clients, 99).failures.includes('attempt-deadline'));
});
test('disappearance, navigation, replacement, new client and empty census fail', () => {
  for (const final of [[], [{ id: 'a', url: 'https://lab.invalid/lab/new' }], [{ id: 'b', url: clients[0].url }], [...clients, { id: 'b', url: clients[0].url }]]) {
    const a = attempt(); a.receive('a', response(challenge), 150); assert.equal(a.finish(final, 2100).diagnosticCompatibility, false);
  }
  assert.equal(new Attempt(challenge, [], 0).finish([], 2000).diagnosticCompatibility, false);
});
test('multiple compatible clients succeed diagnostically only', () => {
  const all = [...clients, { id: 'b', url: 'https://lab.invalid/lab/?hidden' }], a = new Attempt(challenge, all, 0);
  for (const c of all) a.receive(c.id, response(challenge), 100);
  assert.equal(a.finish(all, 2000).diagnosticCompatibility, true); assert.equal(a.finish(all, 2000).promotionAllowed, false);
});
test('clock timestamps do not participate in protocol decisions', () => {
  const old = Date.now; Date.now = () => { throw Error('wall-clock-used'); };
  try { const a = attempt(); a.receive('a', response(challenge), 110); assert.equal(a.finish(clients, 2100).diagnosticCompatibility, true); }
  finally { Date.now = old; }
});
test('guards deny all subscription, presentation and persistent writes', () => {
  const context = vm.createContext({});
  vm.runInContext(`(() => { class PushManager { subscribe() {} }
    class ServiceWorkerRegistration { showNotification() {} }
    class Notification { static requestPermission() {} }
    class IDBFactory { open() {} deleteDatabase() {} }
    class Storage { setItem() {} removeItem() {} clear() {} }
    class CacheStorage { open() {} delete() {} }
    Object.assign(globalThis, {PushManager, ServiceWorkerRegistration, Notification, IDBFactory, Storage, CacheStorage}); })();`, context);
  vm.runInContext(fs.readFileSync(path.join(root, 'guards.js'), 'utf8'), context);
  for (const code of ['new PushManager().subscribe()', 'new ServiceWorkerRegistration().showNotification()',
    'Notification.requestPermission()', 'new Notification("test")', 'new IDBFactory().open()',
    'new IDBFactory().deleteDatabase()', 'new Storage().setItem()', 'new Storage().removeItem()',
    'new Storage().clear()', 'new CacheStorage().open()', 'new CacheStorage().delete()']) {
    assert.throws(() => vm.runInContext(code, context), /LAB_FORBIDDEN/);
  }
  assert.equal(vm.runInContext('LifecycleSafety.report().length', context), 11);
  assert.equal(vm.runInContext('LifecycleSafety.promotionAllowed', context), false);
  assert.throws(() => vm.runInContext(`'use strict'; PushManager.prototype.subscribe=()=>true`, context), /read only/);
});
test('runtime has no production imports, DB writes, push receiver, permission or presentation calls', () => {
  for (const name of ['core.js', 'isolation.js', 'page.js', 'worker.js', 'index.html']) {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    assert.doesNotMatch(text, /delivery_eligible|delivery-fence|cap-notifications|CapProductionRpc|supabase|\.subscribe\s*\(|\.showNotification\s*\(|requestPermission\s*\(|indexedDB\.open|localStorage\.setItem|sessionStorage\.setItem|caches\.open|addEventListener\(['"]push['"]/);
    assert.doesNotMatch(text, /https?:\/\//);
  }
  assert.match(fs.readFileSync(path.join(root, 'worker.js'), 'utf8'), /importScripts\('\/lab\/guards.js'/);
  assert.match(fs.readFileSync(path.join(root, 'page.js'), 'utf8'), /FOREIGN_WORKER_STOP/);
});
function policyFixture() {
  const origin = 'https://lab.invalid', run = randomUUID();
  return { protocol: isolation.PROTOCOL, origin, run, workers: [], markers: Object.fromEntries(['local', 'session'].map(area => [area, {
    key: isolation.KEYS[area], value: JSON.stringify({ protocol: isolation.PROTOCOL, run, origin, area, token: randomUUID() })
  }])) };
}
const emptyInventory = () => ({ local: [], session: [], caches: [], databases: [], databaseInventoryAvailable: true });
test('A fresh inventory and C only exact server-issued lab markers are admitted', () => {
  const policy = policyFixture(), inventory = emptyInventory();
  assert.equal(isolation.validateInventory(inventory, policy, policy.origin).promotionAllowed, false);
  inventory.local.push(policy.markers.local); inventory.session.push(policy.markers.session);
  assert.equal(isolation.validateInventory(inventory, policy, policy.origin).expectedMarkers, 2);
});
test('B current lab worker provenance is accepted across reload; D same-path unrelated worker is rejected', () => {
  const policy = policyFixture(), url = policy.origin + '/lab/service-worker.js?cap_worker_instance=' + randomUUID();
  const proof = { type: 'LAB_ISOLATION_RESPONSE', protocol: policy.protocol, run: policy.run, url, revision: 1,
    proof: randomUUID(), nonce: randomUUID(), promotionAllowed: false };
  policy.workers.push({ url, revision: 1, proof: proof.proof });
  isolation.validateWorker(url, proof, proof.nonce, policy, policy.origin);
  assert.throws(() => isolation.validateWorker(url, { ...proof, proof: randomUUID() }, proof.nonce, policy, policy.origin), /WORKER_PROVENANCE_STOP/);
  assert.throws(() => isolation.validateWorker(policy.origin + '/service-worker.js', proof, proof.nonce, policy, policy.origin), /WORKER_PROVENANCE_STOP/);
});
for (const [name, mutate] of [
  ['E unknown localStorage', i => i.local.push({ key: 'unknown', value: '1' })],
  ['E unknown sessionStorage', i => i.session.push({ key: 'unknown', value: '1' })],
  ['E unknown cache including lab-looking name', i => i.caches.push('cap-lifecycle-lab-fake')],
  ['E unknown IndexedDB including lab-looking name', i => i.databases.push({ name: 'cap-lifecycle-lab-fake' })],
  ['F production localStorage', i => i.local.push({ key: 'pera', value: '{}' })],
  ['F production notification DB', i => i.databases.push({ name: 'cap-notifications', version: 1 })],
  ['F production shell cache', i => i.caches.push('cap-shell-v376')],
  ['database inventory unavailable', i => { i.databaseInventoryAvailable = false; }]
]) test(name + ' stops', () => {
  const policy = policyFixture(), inventory = emptyInventory(); mutate(inventory);
  assert.throws(() => isolation.validateInventory(inventory, policy, policy.origin), /STOP/);
});
test('G stale/tampered marker or wrong origin/protocol is rejected', () => {
  const policy = policyFixture();
  for (const field of ['token', 'run', 'protocol', 'origin', 'area']) {
    const changed = JSON.parse(policy.markers.local.value); changed[field] = 'tampered';
    const inventory = emptyInventory(); inventory.local.push({ key: isolation.KEYS.local, value: JSON.stringify(changed) });
    assert.throws(() => isolation.validateInventory(inventory, policy, policy.origin), /PROVENANCE_STOP/);
  }
  assert.throws(() => isolation.validatePolicy({ ...policy, protocol: 'old' }, policy.origin), /PROVENANCE_STOP/);
  assert.throws(() => isolation.validatePolicy(policy, 'https://other.invalid'), /PROVENANCE_STOP/);
});
test('G worker nonce, run, protocol and authority flag mismatches stop', () => {
  const policy = policyFixture(), url = policy.origin + '/lab/service-worker.js';
  const proof = { type: 'LAB_ISOLATION_RESPONSE', protocol: policy.protocol, run: policy.run, url,
    revision: 1, proof: randomUUID(), nonce: randomUUID(), promotionAllowed: false };
  policy.workers.push({ url, revision: 1, proof: proof.proof });
  for (const changed of [{ nonce: randomUUID() }, { run: randomUUID() }, { protocol: 'old' }, { promotionAllowed: true }, { revision: 2 }]) {
    assert.throws(() => isolation.validateWorker(url, { ...proof, ...changed }, proof.nonce, policy, policy.origin), /WORKER_PROVENANCE_STOP/);
  }
});
test('C/H retained write capability creates only expected markers; generic mutations still throw', () => {
  const policy = policyFixture(), context = vm.createContext({ URL });
  vm.runInContext(`(() => {
    class Storage {
      constructor() { this.entries = new Map(); }
      get length() { return this.entries.size; }
      key(i) { return [...this.entries.keys()][i] ?? null; }
      getItem(k) { return this.entries.get(k) ?? null; }
      setItem(k,v) { this.entries.set(k,v); } removeItem(k) { this.entries.delete(k); } clear() { this.entries.clear(); }
    }
    Object.assign(globalThis, { Storage, localStorage: new Storage(), sessionStorage: new Storage(),
      document: {}, location: { origin: 'https://lab.invalid' } });
  })();`, context);
  vm.runInContext(fs.readFileSync(path.join(root, 'guards.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'isolation.js'), 'utf8'), context);
  context.policy = policy;
  vm.runInContext('LifecycleSafety.initializeMarkers(policy); LifecycleSafety.initializeMarkers(policy)', context);
  assert.equal(vm.runInContext('localStorage.length + sessionStorage.length', context), 2);
  assert.throws(() => vm.runInContext(`localStorage.setItem('pera', '{}')`, context), /LAB_FORBIDDEN/);
  assert.throws(() => vm.runInContext(`LifecycleSafety.initializeMarkers({...policy, markers:{...policy.markers,local:{key:'pera',value:'{}'}}})`, context), /PROVENANCE_STOP/);
  // No partial marker writes if another storage area is contaminated.
  vm.runInContext('localStorage.entries.clear(); sessionStorage.entries.set("unknown", "1")', context);
  assert.throws(() => vm.runInContext('LifecycleSafety.initializeMarkers(policy)', context), /UNKNOWN_STORAGE_STOP/);
  assert.equal(vm.runInContext('localStorage.length', context), 0);
});
test('dedicated server has only lab routes, no generic files/RPC/CORS or production state', async () => {
  const { server } = createLab(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const route of ['/index.html', '/service-worker.js', '/js/app.js', '/supabase-config.js', '/rest/v1/rpc/test', '/functions/v1/test', '/lab/worker.js', '/lab/../server.cjs']) {
      assert.equal((await fetch(origin + route)).status, 404, route);
    }
    const settingRes = await fetch(origin + '/__lab/settings'), settings = await settingRes.json();
    assert.equal(settings.promotionAllowed, false);
    assert.match(settingRes.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal(settingRes.headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(origin + '/__lab/settings', { method: 'POST', body: JSON.stringify({ run: 'wrong', skip: true, claim: true }) })).status, 403);
    assert.equal((await fetch(origin + '/__lab/settings', { method: 'POST', headers: { origin: 'https://foreign.invalid' }, body: JSON.stringify({ run: settings.run, skip: true, claim: true }) })).status, 403);
    const instance = '12345678-1234-4123-8123-123456789abc';
    const route = '/lab/service-worker.js?cap_worker_instance=' + instance;
    const first = await (await fetch(origin + route)).text(); assert.match(first, new RegExp(instance));
    const issued = (await (await fetch(origin + '/__lab/settings')).json()).isolation;
    assert.equal(issued.workers.length, 1); assert.equal(issued.workers[0].url, origin + route);
    assert.match(first, new RegExp(issued.workers[0].proof));
    assert.equal(await (await fetch(origin + route)).text(), first, 'proof does not mutate worker bytes on each fetch');
    await fetch(origin + '/__lab/settings', { method: 'POST', body: JSON.stringify({ run: settings.run, skip: false, claim: false }) });
    const second = await (await fetch(origin + route)).text(); assert.notEqual(first, second);
    assert.match(second, /"revision":2/); assert.match(second, /"promotionAllowed":false/);
    assert.equal((await fetch(origin + '/lab/service-worker.js?cap_worker_instance=invalid')).status, 400);
    assert.equal((await fetch(origin + route + '&extra=1')).status, 400);
    assert.match(await (await fetch(origin + '/lab/service-worker.js')).text(), /bare-legacy/);
    const report = await (await fetch(origin + '/__lab/report')).json();
    assert.equal(report.safety.certification, 'UNVERIFIED'); assert.equal(report.safety.promotionAllowed, false);
  } finally { await new Promise(r => server.close(r)); }
});
