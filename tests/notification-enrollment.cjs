/* Phase 5B.2B static/unit checks (A1-A8). No browser, no network, no Supabase,
   no IndexedDB writes: node tests/notification-enrollment.cjs */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const readJson = file => JSON.parse(read(file));
let passed = 0;
const test = async (label, fn) => {
  try { await fn(); passed++; console.log('PASS ' + label); }
  catch (e) { e.message = label + ': ' + e.message; throw e; }
};

const B64URL = /^[A-Za-z0-9_-]+$/;
const UUID = '11111111-1111-4111-8111-111111111111';

function loadModules(extra) {
  const context = {
    crypto: webcrypto, TextEncoder, URL, URLSearchParams, Uint8Array, ArrayBuffer,
    setTimeout: () => 0, clearTimeout: () => {},
    navigator: { onLine: true, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' },
    ...extra
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(read('js/vapid-public.js'), context);
  vm.runInContext(read('js/notification-enrollment.js'), context);
  return context;
}

function baseEvidence() {
  return {
    secureContext: true, serviceWorker: true, notificationApi: true, pushApi: true,
    standalone: false, appleMobile: false, permission: 'default', online: true,
    identity: { verified: true, owner: 'owner-a', localOwner: 'owner-a', sessionGeneration: 1, diverged: false },
    storageOk: true, foundationOk: true, vapidOk: true, vapidVersion: 'v1',
    serverAttempted: true, serverOk: true, serverBinding: null, localBinding: null,
    sync: { in_flight: false, started_at: null, tab_id: null, last_error_code: null,
      last_attempt_at: null, retry_after: null },
    subscription: null, subscriptionKeyMatch: false, endpointSha256: null,
    masterEnabled: true, serverConflict: false, retry: false, fatal: false
  };
}
function evidence(patch) {
  const base = baseEvidence();
  const out = { ...base, ...patch };
  if (patch && patch.identity) out.identity = { ...base.identity, ...patch.identity };
  if (patch && patch.sync) out.sync = { ...base.sync, ...patch.sync };
  return out;
}

(async () => {
  const api = loadModules();
  const vapidApi = api.CapVapidPublic;

  await test('A1 the first-match-wins machine reaches all 25 declared states deterministically', async () => {
    assert.equal(api.CapNotificationEnrollment.STATES.length, 25);
    assert.equal(new Set(api.CapNotificationEnrollment.STATES).size, 25);
    const pendingLocal = { installation_id: UUID, binding_id: UUID, generation: 1, schedule_revision: 0,
      state: 'pending', vapid_key_version: 'v1', endpoint_sha256: 'a'.repeat(64), updated_at: '2026-10-28T00:00:00Z' };
    const pendingServer = { binding_id: UUID, installation_id: UUID, generation: 1, schedule_revision: 0, state: 'pending' };
    const cases = [
      ['unsupported-insecure', { secureContext: false }],
      ['unsupported-browser', { pushApi: false }],
      ['ios-install-required', { appleMobile: true, standalone: false }],
      ['signed-out', { identity: { localOwner: null } }],
      ['unverified-session', { identity: { verified: false } }],
      ['foundation-unavailable', { foundationOk: false }],
      ['storage-unavailable', { storageOk: false }],
      ['session-diverged', { identity: { diverged: true } }],
      ['disabled', { masterEnabled: false }],
      ['pending-disable', { sync: { last_error_code: 'DISABLE_PENDING' } }],
      ['supported-not-enrolled', { permission: 'prompt' }],
      ['permission-prompt-available', { permission: 'default' }],
      ['permission-denied', { permission: 'denied' }],
      ['permission-granted-no-subscription', { permission: 'granted' }],
      ['local-subscription-unregistered', { subscription: {} }],
      ['registered-pending', { localBinding: pendingLocal, serverBinding: pendingServer, subscription: {},
        subscriptionKeyMatch: true, endpointSha256: 'a'.repeat(64) }],
      ['stale-local-generation', { localBinding: { ...pendingLocal, generation: 1 },
        serverBinding: { ...pendingServer, generation: 2 } }],
      ['stale-vapid-key', { localBinding: pendingLocal, serverBinding: pendingServer, vapidVersion: 'v2' }],
      ['subscription-mismatch', { localBinding: pendingLocal, serverBinding: pendingServer, subscription: {},
        subscriptionKeyMatch: true, endpointSha256: 'b'.repeat(64) }],
      ['server-binding-missing', { localBinding: pendingLocal, serverBinding: null, serverOk: true }],
      ['subscription-lost', { localBinding: pendingLocal, serverBinding: pendingServer }],
      ['foreign-account-reservation', { serverConflict: true }],
      ['disabled-server-subscription-live', { serverBinding: { ...pendingServer, state: 'disabled' }, subscription: {} }],
      ['error-retry', { online: false, serverAttempted: true, serverOk: false }],
      ['error-fatal', { fatal: true }]
    ];
    assert.equal(cases.length, 25);
    for (const [expected, patch] of cases) {
      const input = evidence(patch);
      const first = api.CapNotificationEnrollment._deriveState(input);
      const second = api.CapNotificationEnrollment._deriveState(JSON.parse(JSON.stringify(input)));
      assert.equal(first, expected, JSON.stringify(patch));
      assert.equal(second, expected, 'deterministic for ' + expected);
    }
  });

  await test('A1 precedence: fatal, insecure, Apple install, capability, identity, storage, divergence, foundation, pending', async () => {
    const d = api.CapNotificationEnrollment._deriveState;
    assert.equal(d(evidence({ fatal: true, secureContext: false })), 'error-fatal');
    assert.equal(d(evidence({ secureContext: false, appleMobile: true })), 'unsupported-insecure');
    assert.equal(d(evidence({ appleMobile: true, pushApi: false })), 'ios-install-required');
    assert.equal(d(evidence({ pushApi: false, identity: { localOwner: null } })), 'unsupported-browser');
    assert.equal(d(evidence({ identity: { localOwner: null }, foundationOk: false })), 'signed-out');
    assert.equal(d(evidence({ identity: { verified: false }, storageOk: false })), 'unverified-session');
    assert.equal(d(evidence({ storageOk: false, identity: { diverged: true } })), 'storage-unavailable');
    assert.equal(d(evidence({ identity: { diverged: true }, foundationOk: false })), 'session-diverged');
    assert.equal(d(evidence({ foundationOk: false, sync: { last_error_code: 'DISABLE_PENDING' } })), 'foundation-unavailable');
    assert.equal(d(evidence({ sync: { last_error_code: 'DISABLE_PENDING' }, serverConflict: true })), 'pending-disable');
    assert.equal(d(evidence({ permission: 'granted', masterEnabled: false })), 'disabled');
  });

  await test('A2 C4 uses only prototype presence and never reads the pushManager value', async () => {
    class WithPush {}
    Object.defineProperty(WithPush.prototype, 'pushManager', {
      configurable: true, get() { throw new Error('C4 must not read the prototype value'); }
    });
    const model = api.CapNotificationEnrollment._envModel({
      isSecureContext: true, serviceWorker: true, Notification: function () {},
      PushManager: function () {}, ServiceWorkerRegistration: WithPush, standalone: false, navigator: {}
    });
    assert.equal(model.pushApi, true);
    class WithoutPush {}
    const absent = api.CapNotificationEnrollment._envModel({
      isSecureContext: true, serviceWorker: true, Notification: function () {},
      PushManager: function () {}, ServiceWorkerRegistration: WithoutPush, standalone: false, navigator: {}
    });
    assert.equal(absent.pushApi, false);
    const noPushManager = api.CapNotificationEnrollment._envModel({
      isSecureContext: true, serviceWorker: true, Notification: function () {},
      PushManager: undefined, ServiceWorkerRegistration: WithPush, standalone: false, navigator: {}
    });
    assert.equal(noPushManager.pushApi, false);
  });

  await test('A2 C5 standalone/fullscreen display-mode or navigator.standalone satisfies install', async () => {
    const standalone = api.CapNotificationEnrollment._displayStandalone;
    const withMatch = matches => ({ matchMedia: q => ({ matches: matches.includes(q) }) });
    const context = loadModules(withMatch(['(display-mode: standalone)']));
    assert.equal(context.CapNotificationEnrollment._displayStandalone(), true);
    const fullscreen = loadModules(withMatch(['(display-mode: fullscreen)']));
    assert.equal(fullscreen.CapNotificationEnrollment._displayStandalone(), true);
    const browser = loadModules(withMatch([]));
    assert.equal(browser.CapNotificationEnrollment._displayStandalone(), false);
    const legacy = loadModules({ matchMedia: undefined, navigator: { standalone: true } });
    assert.equal(legacy.CapNotificationEnrollment._displayStandalone(), true);
    assert.equal(typeof standalone, 'function');
  });

  await test('A3 the dark VAPID boundary is absent, inert and carries no private material', async () => {
    const inspect = vapidApi.inspect(vapidApi.current());
    assert.equal(inspect.ok, false);
    assert.equal(inspect.reason, 'VAPID_CONFIG_ABSENT');
    assert.equal(inspect.dark, true);
    assert.deepEqual(Object.keys(vapidApi.DARK), []);
    assert.equal(Object.isFrozen(vapidApi.DARK), true);
    const source = read('js/vapid-public.js');
    assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(source), false);
    assert.equal(/\bCAP_VAPID_PRIVATE\b|capVapidPrivate|privateKey/.test(source), false);
    for (const bad of [null, [], 'v1', 3, true]) {
      assert.equal(vapidApi.inspect(bad).ok, false);
    }
  });

  await test('A3 VAPID public shape requires an unpadded 65-byte P-256 point and matching SHA-256', async () => {
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const raw = Buffer.from(await webcrypto.subtle.exportKey('raw', keys.publicKey));
    const fingerprint = Buffer.from(await webcrypto.subtle.digest('SHA-256', raw)).toString('hex');
    const publicKey = raw.toString('base64url');
    assert.equal(raw.length, 65);
    assert.equal(raw[0], 4);
    const valid = { version: 'v1', publicKey, fingerprint, createdAt: '2026-10-28T00:00:00Z' };
    const structural = vapidApi.inspect(valid);
    assert.equal(structural.ok, true);
    assert.equal(structural.version, 'v1');
    assert.equal(structural.keyBytes.length, 65);
    const checked = await vapidApi.validate(valid);
    assert.equal(checked.ok, true);
    assert.equal(checked.fingerprint, fingerprint);
    assert.equal(vapidApi.encodeBase64url(raw), publicKey);
    assert.deepEqual(Buffer.from(vapidApi.decodeBase64url(publicKey)), raw);
    // Structurally 65 bytes with the 0x04 prefix but (0,0) is not on P-256.
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 0)]);
    const offCurveFingerprint = Buffer.from(await webcrypto.subtle.digest('SHA-256', offCurve)).toString('hex');
    const offConfig = { ...valid, publicKey: offCurve.toString('base64url'), fingerprint: offCurveFingerprint };
    assert.equal(vapidApi.inspect(offConfig).ok, true);
    assert.equal((await vapidApi.validate(offConfig)).ok, false);
    assert.equal((await vapidApi.validate(offConfig)).reason, 'VAPID_PUBLIC_KEY_INVALID');
    const bad = [
      [{ ...valid, version: '1' }, /VAPID_VERSION_INVALID/],
      [{ ...valid, version: 'v1000' }, /VAPID_VERSION_INVALID/],
      [{ ...valid, publicKey: publicKey + '=' }, /VAPID_PUBLIC_KEY_INVALID/],
      [{ ...valid, publicKey: raw.subarray(0, 64).toString('base64url') }, /VAPID_PUBLIC_KEY_INVALID/],
      [{ ...valid, publicKey: Buffer.concat([Buffer.from([3]), raw.subarray(1)]).toString('base64url') }, /VAPID_PUBLIC_KEY_INVALID/],
      [{ ...valid, fingerprint: fingerprint.toUpperCase() }, /VAPID_FINGERPRINT_INVALID/],
      [{ ...valid, fingerprint: '0'.repeat(64) }, /VAPID_FINGERPRINT_MISMATCH/],
      [{ ...valid, createdAt: 'not-a-date' }, /VAPID_CREATED_AT_INVALID/],
      [{ ...valid, extra: true }, /VAPID_CONFIG_UNKNOWN_FIELD/]
    ];
    for (const [config, pattern] of bad) {
      if (/FINGERPRINT_MISMATCH/.test(pattern)) {
        assert.equal((await vapidApi.validate(config)).ok, false);
        assert.equal((await vapidApi.validate(config)).reason, 'VAPID_FINGERPRINT_MISMATCH');
      } else {
        assert.equal(vapidApi.inspect(config).ok, false);
        assert.match(vapidApi.inspect(config).reason, pattern);
      }
    }
  });

  await test('A4 endpoint, p256dh, auth and subscription matching stay inside the reviewed boundary', async () => {
    const valid = api.CapNotificationEnrollment._validEndpoint;
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QGx9', 'https://wns2-par02p.notify.windows.com/w/?token=abc'
    ]) assert.equal(valid(endpoint), true, endpoint);
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc', 'https://evil.example/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc', 'https://user:pass@fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com/fcm/send/abc#frag', 'not a url', '', null, 'https://' + 'a'.repeat(5000) + '.com'
    ]) assert.equal(valid(endpoint), false, String(endpoint));
    const p256dh = Buffer.alloc(65, 4), auth = Buffer.alloc(16, 9);
    assert.equal(api.CapNotificationEnrollment._validP256dh(p256dh), true);
    assert.equal(api.CapNotificationEnrollment._validP256dh(p256dh.subarray(0, 64)), false);
    assert.equal(api.CapNotificationEnrollment._validP256dh(Buffer.concat([Buffer.from([2]), p256dh.subarray(1)])), false);
    assert.equal(api.CapNotificationEnrollment._validAuth(auth), true);
    assert.equal(api.CapNotificationEnrollment._validAuth(auth.subarray(0, 15)), false);
  });

  await test('A5 IndexedDB schema is separate, exact and stores no raw endpoint or key material', async () => {
    const module = api.CapNotificationEnrollment;
    const records = module._records;
    assert.equal(module.DB_NAME, 'cap-notifications');
    assert.equal(module.DB_VERSION, 1);
    assert.equal(module.STORE, 'state');
    assert.deepEqual(Array.from(module.INSTALLATION_FIELDS), ['id', 'created_at', 'protocol']);
    assert.deepEqual(Array.from(module.BINDING_FIELDS), ['installation_id', 'binding_id', 'generation', 'schedule_revision',
      'state', 'vapid_key_version', 'endpoint_sha256', 'updated_at']);
    assert.deepEqual(Array.from(module.SYNC_FIELDS), ['in_flight', 'started_at', 'tab_id', 'last_error_code', 'last_attempt_at', 'retry_after']);
    for (const fields of [module.BINDING_FIELDS, module.SYNC_FIELDS, module.INSTALLATION_FIELDS]) {
      for (const forbidden of ['endpoint', 'p256dh', 'auth', 'keys', 'user_id', 'owner']) {
        assert.equal(fields.includes(forbidden), false, forbidden + ' must never be persisted');
      }
    }
    const plain = value => JSON.parse(JSON.stringify(value));
    const installation = { id: UUID, created_at: '2026-10-28T00:00:00Z', protocol: 'CAP_PUSH_V1' };
    assert.deepEqual(plain(records.installationRecord(installation)), installation);
    assert.equal(records.installationRecord({ ...installation, endpoint: 'https://x' }), null);
    assert.equal(records.installationRecord({ ...installation, protocol: 'CAP_PUSH_V2' }), null);
    assert.equal(records.installationRecord({ ...installation, id: 'not-a-uuid' }), null);
    assert.equal(records.installationRecord({ ...installation, created_at: 'bad' }), null);
    const binding = { installation_id: UUID, binding_id: UUID, generation: 1, schedule_revision: 0,
      state: 'pending', vapid_key_version: 'v1', endpoint_sha256: 'a'.repeat(64), updated_at: '2026-10-28T00:00:00Z' };
    assert.deepEqual(plain(records.bindingRecord(binding)), binding);
    for (const state of ['pending', 'disabled', 'retired', 'disable_pending']) {
      assert.notEqual(records.bindingRecord({ ...binding, state }), null, state);
    }
    for (const field of module.BINDING_FIELDS) {
      const missing = { ...binding }; delete missing[field];
      assert.equal(records.bindingRecord(missing), null, 'missing ' + field);
    }
    assert.equal(records.bindingRecord({ ...binding, endpoint: 'https://x' }), null);
    assert.equal(records.bindingRecord({ ...binding, p256dh: 'x' }), null);
    assert.equal(records.bindingRecord({ ...binding, auth: 'x' }), null);
    assert.equal(records.bindingRecord({ ...binding, generation: 0 }), null);
    assert.equal(records.bindingRecord({ ...binding, schedule_revision: -1 }), null);
    const sync = { in_flight: false, started_at: null, tab_id: null, last_error_code: null, last_attempt_at: null, retry_after: null };
    assert.deepEqual(plain(records.syncRecord(sync)), sync);
    assert.equal(records.syncRecord({ ...sync, in_flight: 'false' }), null);
    assert.equal(records.syncRecord({ ...sync, retry_after: -1 }), null);
    assert.equal(records.syncRecord({ ...sync, tab_id: 'not-a-uuid' }), null);
    assert.equal(records.syncRecord({ ...sync, endpoint: 'x' }), null);
    const source = read('js/notification-enrollment.js');
    assert.equal(/keyPath|autoIncrement/.test(source), false, 'out-of-line string keys only');
    assert.match(source, /createObjectStore\(STORE\)/);
    assert.match(source, /objectStore\(STORE\)\.put\(value, key\)/);
    assert.match(source, /objectStore\(STORE\)\.get\(key\)/);
    assert.match(source, /objectStore\(STORE\)\.delete\(key\)/);
    assert.match(source, /crypto\.randomUUID/);
    assert.match(source, /onversionchange/, 'a version change must release the connection');
    assert.equal(/Math\.random/.test(source), false);
    assert.equal(/localStorage|sessionStorage/.test(source), false, 'notification state never uses web storage');
    assert.equal(/\bfetch\(/.test(source), false, 'enrollment goes through the reviewed RPC wrapper only');
    assert.equal(/\/rest\/v1\//.test(source), false, 'no direct transport path in the enrollment module');
  });

  await test('A6 privacy: no raw subscription material is persisted, logged or rendered', async () => {
    const module = api.CapNotificationEnrollment;
    assert.equal(module.STATES.length, 25);
    const source = read('js/notification-enrollment.js');
    assert.equal(/console\.(log|info|debug|warn|error)/.test(source), false);
    assert.match(source, /endpoint_sha256: endpointSha256/);
    assert.match(source, /sha256Hex\(/);
    const hash = await module._sha256Hex('https://fcm.googleapis.com/fcm/send/abc');
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash.includes('fcm'), false);
    const bindings = source.slice(source.indexOf('const BINDING_FIELDS'), source.indexOf('const SERVER_STATES'));
    for (const raw of ['"endpoint"', "'endpoint'", 'p256dh', 'auth']) {
      assert.equal(bindings.includes(raw), false, 'record schema must not include ' + raw);
    }
    const markup = module.settingsMarkup();
    assert.equal(markup, '', 'dark VAPID renders no background-reminder UI');
    assert.equal(JSON.stringify(module.state()).includes('fcm.googleapis'), false);
    assert.equal(JSON.stringify(module.evidence()).includes('fcm.googleapis'), false);
  });

  await test('A7 the production RPC allowlist is exactly sixteen and excludes legacy publish', async () => {
    const context = { window: null, console };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(read('js/production-rpc.js'), context);
    const allowed = Array.from(context.CapProductionRpc.ALLOWED).sort();
    const expected = ['cap_verify_production_sync_v1', 'cap_sync_snapshot_v1', 'cap_sync_transaction_create',
      'cap_sync_transaction_update', 'cap_sync_transaction_delete', 'cap_verify_transaction_update_delete_v1',
      'cap_notes_change', 'cap_notes_read', 'cap_verify_notes_lifecycle', 'cap_notifications_register_v1',
      'cap_notifications_invalidate_v1', 'cap_notifications_summary_v1', 'cap_notifications_readiness_v1',
      'cap_notifications_readiness_v2', 'cap_notifications_publish_v2', 'cap_notifications_schedule_readback_v2'];
    assert.deepEqual(allowed, expected.slice().sort());
    assert.equal(allowed.includes('cap_notifications_publish_v1'), false);
    assert.equal(allowed.includes('cap_notifications_publish_v2'), true);
    const source = read('js/production-rpc.js');
    assert.equal(/notificationPublish:\s*'cap_notifications_publish_v1'/.test(source), false);
    assert.equal(/publishSchedule/.test(source), false);
    await assert.rejects(context.CapProductionRpc.call('cap_notifications_publish_v1', {}), /UNSUPPORTED_PRODUCTION_RPC/);
    const supabase = read('js/supabase.js');
    const paths = [...supabase.matchAll(/'(?:\.\/)?\/rest\/v1\/rpc\/(cap_[a-z0-9_]+)'/g)].map(m => m[1])
      .filter(name => name !== 'cap_notifications_');
    assert.equal(new Set(paths).size, 16);
    assert.equal(paths.includes('cap_notifications_publish_v1'), false);
    assert.equal(paths.includes('cap_notifications_publish_v2'), true);
  });

  await test('A8 current shell wiring: v376 precaches both modules, keeps no push listener, and never ships a private key', async () => {
    const worker = read('service-worker.js');
    assert.match(worker, /const VERSION = "cap-shell-v376"/);
    assert.ok(worker.includes('"./js/vapid-public.js"'));
    assert.ok(worker.includes('"./js/notification-enrollment.js"'));
    assert.equal(/addEventListener\(\s*['"]push['"]/.test(worker), false, 'no push listener in this phase');
    assert.equal(/pushsubscriptionchange/.test(worker), false);
    const html = read('index.html');
    assert.ok(html.indexOf('js/vapid-public.js') > 0);
    assert.ok(html.indexOf('js/vapid-public.js') < html.indexOf('js/production-rpc.js'));
    assert.ok(html.indexOf('js/notification-enrollment.js') > html.indexOf('js/notifications.js'));
    assert.ok(html.indexOf('js/notification-enrollment.js') < html.indexOf('</body>'));
    const notifications = read('js/notifications.js');
    assert.ok(notifications.includes('CapNotificationEnrollment?.settingsMarkup'));
    const manifest = readJson('manifest.json'), vercel = readJson('vercel.json');
    assert.ok(manifest && vercel);
    const sources = ['js/vapid-public.js', 'js/notification-enrollment.js', 'js/notifications.js', 'js/supabase.js',
      'js/production-rpc.js', 'index.html', 'service-worker.js'];
    for (const file of sources) {
      const text = read(file);
      assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), false, file + ' private key literal');
      assert.equal(/CAP_VAPID_PRIVATE|cap_vapid_private|vapidPrivate/.test(text), false, file + ' private key name');
    }
    assert.equal(/["']privateKey["']/.test(read('js/vapid-public.js')), false);
  });

  console.log(`PASS: ${passed} Phase 5B.2B static/unit checks (A1-A8)`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
