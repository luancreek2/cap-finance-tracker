/* Phase 5B.2B isolated browser checks (B1-B26). Real Chrome, real IndexedDB,
   real Web Locks and the shipped enrollment module. Notification, PushManager,
   ServiceWorkerRegistration, session identity and the reviewed RPC wrappers are
   explicit fakes: no live Supabase, no real push service, no financial IO. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { webcrypto } = require('node:crypto');
if (!process.env.CAP_PLAYWRIGHT_PATH) {
  console.log('SKIP Notification enrollment browser: set CAP_PLAYWRIGHT_PATH');
  process.exit(0);
}
const { chromium } = require(process.env.CAP_PLAYWRIGHT_PATH);
const root = path.resolve(__dirname, '..');
let server, browser, passed = 0;
const base = () => 'http://127.0.0.1:' + server.address().port;

const HARNESS = '<!doctype html><html><head><meta charset="utf-8"><title>enrollment fixture</title></head>' +
  '<body><div id="app"></div><script src="/js/vapid-public.js"></script>' +
  '<script src="/js/notification-enrollment.js"></script></body></html>';
const TRANSPORT = '<!doctype html><html><head><meta charset="utf-8"><title>transport fixture</title></head>' +
  '<body><div id="app"></div><script src="/js/production-rpc.js"></script>' +
  '<script src="/js/supabase.js"></script></body></html>';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function startServer() {
  return new Promise(resolve => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      if (url.pathname === '/harness') { res.setHeader('Content-Type', TYPES['.html']); return res.end(HARNESS); }
      if (url.pathname === '/transport') { res.setHeader('Content-Type', TYPES['.html']); return res.end(TRANSPORT); }
      const file = path.join(root, decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', resolve);
  });
}

const hex = buffer => buffer.toString('hex');
async function makeP256() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return Buffer.from(await webcrypto.subtle.exportKey('raw', keys.publicKey));
}
async function sha256(text) {
  return Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(text))).toString('hex');
}

let VAPID, VAPID_2, KEYS;
async function material() {
  const vapidRaw = await makeP256(), secondRaw = await makeP256(), auth = require('node:crypto').randomBytes(16);
  const fingerprint = Buffer.from(await webcrypto.subtle.digest('SHA-256', vapidRaw)).toString('hex');
  const fingerprint2 = Buffer.from(await webcrypto.subtle.digest('SHA-256', secondRaw)).toString('hex');
  VAPID = { version: 'v1', publicKey: vapidRaw.toString('base64url'), fingerprint, createdAt: '2026-10-28T00:00:00Z' };
  VAPID_2 = { version: 'v2', publicKey: secondRaw.toString('base64url'), fingerprint: fingerprint2, createdAt: '2026-10-29T00:00:00Z' };
  KEYS = {
    vapidHex: hex(vapidRaw), vapid2Hex: hex(secondRaw), p256dhHex: hex(vapidRaw), authHex: hex(auth),
    endpoint: 'https://fcm.googleapis.com/fcm/send/cap-fixture',
    bindingId: '22222222-2222-4222-8222-222222222222',
    installationId: '33333333-3333-4333-8333-333333333333'
  };
}

/* Runs before every fixture script. Installs the explicit browser fakes. */
function installMocks(args) {
  const { vapid, keys, mock, serverBinding } = args;
  const bytes = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
  const m = mock || {};
  window.__calls = { permission: 0, subscribe: 0, unsubscribe: 0, register: 0, invalidate: 0, readiness: 0, summary: 0 };
  window.__toasts = [];
  window.__changes = [];
  window.__mock = {
    identity: { authenticated: true, userId: 'owner-a', localOwner: 'owner-a', sessionGeneration: 1, ...(m.identity || {}) },
    prefs: { on: true, ...(m.prefs || {}) },
    permission: m.permission || 'default',
    endpoint: m.endpoint || keys.endpoint,
    subscription: null,
    subscribeError: null,
    unsubscribeFails: false,
    registerError: null,
    registerResult: null,
    registerDelay: 0,
    switchSessionOnRegister: false,
    invalidateError: null,
    readinessResult: null,
    summaryResult: null,
    requestPermissionDelay: 0,
    subscribeDelay: 0
  };
  for (const key of Object.keys(m)) {
    if (key === 'identity' || key === 'prefs') continue;
    window.__mock[key] = m[key];
  }
  if (vapid) window.CAP_VAPID_PUBLIC = vapid;
  window.addEventListener('cap-notifications-enrollment-changed', event => window.__changes.push(event.detail));
  if (serverBinding) localStorage.setItem('__serverBinding', JSON.stringify(serverBinding));
  localStorage.setItem('__registerCount', '0');

  const b64urlHex = value => {
    const binary = atob(String(value).replace(/-/g, '+').replace(/_/g, '/'));
    return Array.from(binary, ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  };
  const activeKeyHex = vapid ? b64urlHex(vapid.publicKey) : keys.vapidHex;
  class FakeSubscription {
    constructor(endpoint, keyHex, expiration) {
      this.endpoint = endpoint;
      this.expirationTime = expiration ?? null;
      this.options = { applicationServerKey: bytes(keyHex) };
      this._p256dh = bytes(keys.p256dhHex);
      this._auth = bytes(keys.authHex);
    }
    getKey(name) { return name === 'p256dh' ? this._p256dh : name === 'auth' ? this._auth : null; }
    async unsubscribe() {
      window.__calls.unsubscribe++;
      if (window.__mock.unsubscribeFails) throw Error('unsubscribe failed');
      window.__mock.subscription = null;
      return true;
    }
  }
  class FakePushManager {
    async getSubscription() { return window.__mock.subscription || null; }
    async subscribe(options) {
      window.__calls.subscribe++;
      window.__lastSubscribe = { userVisibleOnly: options && options.userVisibleOnly,
        keyLength: options && options.applicationServerKey && options.applicationServerKey.byteLength };
      if (window.__mock.subscribeDelay) await new Promise(r => setTimeout(r, window.__mock.subscribeDelay));
      if (window.__mock.subscribeError) throw Error(window.__mock.subscribeError);
      if (!window.__mock.subscription) {
        window.__mock.subscription = new FakeSubscription(window.__mock.endpoint, activeKeyHex, null);
      }
      return window.__mock.subscription;
    }
  }
  if (m.subscription) window.__mock.subscription = new FakeSubscription(m.subscription.endpoint || window.__mock.endpoint,
    m.subscription.keyHex || activeKeyHex, m.subscription.expiration);
  const registration = { active: { state: 'activated' }, pushManager: new FakePushManager() };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    getRegistration: async () => registration,
    ready: Promise.resolve(registration),
    addEventListener() {}
  } });
  class FakeNotification {}
  FakeNotification.permission = window.__mock.permission;
  FakeNotification.requestPermission = async () => {
    window.__calls.permission++;
    if (window.__mock.requestPermissionDelay) await new Promise(r => setTimeout(r, window.__mock.requestPermissionDelay));
    if (window.__mock.permissionResult) FakeNotification.permission = window.__mock.permissionResult;
    else if (FakeNotification.permission === 'default') FakeNotification.permission = 'granted';
    return FakeNotification.permission;
  };
  Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification });
  window.__setPermission = value => { FakeNotification.permission = value; };
  if (m.disablePush) Object.defineProperty(window, 'PushManager', { configurable: true, value: undefined });
  if (m.userAgent) Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => m.userAgent });

  const readServer = () => { try { return JSON.parse(localStorage.getItem('__serverBinding') || 'null'); } catch (_) { return null; } };
  window.CapSupabase = { authEvidence: () => ({ ...window.__mock.identity }) };
  window.CapNotifications = { preferences: () => ({ ...window.__mock.prefs }), settings: () => {} };
  window.toast = (...values) => { window.__toasts.push(values); };
  window.CapProductionRpc = {
    notificationReadiness: async () => {
      window.__calls.readiness++;
      return window.__mock.readinessResult || { ok: true, raw: {} };
    },
    notificationSummary: async () => {
      window.__calls.summary++;
      if (window.__mock.summaryResult) return window.__mock.summaryResult;
      const binding = readServer();
      return { ok: true, raw: { protocol: 'CAP_PUSH_V1', background_enabled: false, bindings: binding ? [binding] : [] } };
    },
    notificationRegister: async options => {
      window.__calls.register++;
      window.__registerPayload = options;
      if (window.__mock.registerDelay) await new Promise(r => setTimeout(r, window.__mock.registerDelay));
      if (window.__mock.registerError) {
        const error = Error(window.__mock.registerError);
        error.code = window.__mock.registerError;
        throw error;
      }
      const binding = window.__mock.registerResult ? { ...window.__mock.registerResult } : {
        binding_id: keys.bindingId, installation_id: options.installationId,
        generation: options.expectedGeneration > 0 ? options.expectedGeneration + 1 : 1,
        schedule_revision: 0, state: 'pending'
      };
      localStorage.setItem('__registerCount', String(Number(localStorage.getItem('__registerCount') || '0') + 1));
      localStorage.setItem('__serverBinding', JSON.stringify(binding));
      if (window.__mock.switchSessionOnRegister) {
        window.__mock.identity.userId = 'owner-b';
        window.__mock.identity.sessionGeneration = Number(window.__mock.identity.sessionGeneration) + 1;
      }
      return binding;
    },
    notificationInvalidate: async options => {
      window.__calls.invalidate++;
      window.__invalidatePayload = options;
      if (window.__mock.invalidateError) {
        const error = Error(window.__mock.invalidateError);
        error.code = window.__mock.invalidateError;
        throw error;
      }
      const prior = readServer() || {};
      const binding = { binding_id: options.bindingId, installation_id: prior.installation_id || null,
        generation: options.generation + 1, schedule_revision: options.scheduleRevision + 1, state: 'disabled' };
      localStorage.setItem('__serverBinding', JSON.stringify(binding));
      return binding;
    }
  };
}

async function openFixture(options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(installMocks, {
    vapid: options.vapid === undefined ? VAPID : options.vapid,
    keys: KEYS,
    mock: options.mock || {},
    serverBinding: options.serverBinding || null
  });
  const page = await context.newPage();
  page.on('pageerror', error => console.log('PAGEERROR ' + error.message));
  await page.goto(base() + '/harness');
  await page.waitForFunction(() => window.CapNotificationEnrollment && window.__changes.length > 0,
    null, { timeout: 10000 });
  return { context, page };
}

async function seedLocal(page, data) {
  await page.evaluate(async values => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('cap-notifications', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('state', 'readwrite');
        const store = tx.objectStore('state');
        for (const [key, value] of Object.entries(values)) {
          if (value === null) store.delete(key); else store.put(value, key);
        }
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, data);
}

async function localState(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('cap-notifications', 1);
      request.onupgradeneeded = () => {
        const created = request.result;
        if (!created.objectStoreNames.contains('state')) created.createObjectStore('state');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const get = key => new Promise((resolve, reject) => {
      const request = db.transaction('state', 'readonly').objectStore('state').get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise((resolve, reject) => {
      const request = db.transaction('state', 'readonly').objectStore('state').getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = { installation: await get('installation'), binding: await get('binding'),
      sync: await get('sync'), keys, stores: Array.from(db.objectStoreNames) };
    db.close();
    return result;
  });
}

async function reconcile(page) {
  return page.evaluate(() => CapNotificationEnrollment.reconcile());
}

const bindingFor = (overrides = {}) => ({
  installation_id: KEYS.installationId, binding_id: KEYS.bindingId, generation: 1,
  schedule_revision: 0, state: 'pending', vapid_key_version: 'v1',
  endpoint_sha256: 'a'.repeat(64), updated_at: '2026-10-28T00:00:00Z', ...overrides
});
const serverBindingFor = (overrides = {}) => ({
  binding_id: KEYS.bindingId, installation_id: KEYS.installationId, generation: 1,
  schedule_revision: 0, preference_revision: 0, state: 'pending',
  created_at: '2026-10-28T00:00:00Z', updated_at: '2026-10-28T00:00:00Z', last_confirmed_at: null, ...overrides
});

async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS ' + label);
}

(async () => {
  await material();
  await startServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  await test('B1 dark VAPID startup is inert: no prompt, no subscribe, no UI', async () => {
    const { context, page } = await openFixture({ vapid: null });
    const state = await page.evaluate(() => CapNotificationEnrollment.status());
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(state.available, false);
    assert.equal(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()), '');
    assert.equal(calls.permission, 0);
    assert.equal(calls.subscribe, 0);
    assert.equal(calls.register, 0);
    assert.equal(calls.invalidate, 0);
    await context.close();
  });

  await test('B2 dark VAPID explicit action still cannot prompt or subscribe', async () => {
    const { context, page } = await openFixture({ vapid: null });
    const result = await page.evaluate(() => CapNotificationEnrollment.uiAction('enable'));
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'VAPID_CONFIG_UNAVAILABLE');
    assert.equal(calls.permission, 0);
    assert.equal(calls.subscribe, 0);
    assert.equal(calls.register, 0);
    assert.ok((await page.evaluate(() => window.__toasts.length)) > 0);
    await context.close();
  });

  await test('B3 missing PushManager capability blocks enrollment before identity or prompts', async () => {
    const { context, page } = await openFixture({ mock: { disablePush: true } });
    const state = await reconcile(page);
    assert.equal(state.state, 'unsupported-browser');
    const calls = await page.evaluate(() => ({ permission: window.__calls.permission, subscribe: window.__calls.subscribe }));
    assert.deepEqual(calls, { permission: 0, subscribe: 0 });
    assert.equal(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()), '');
    await context.close();
  });

  await test('B4 Apple mobile requires Home Screen install, while standalone satisfies it', async () => {
    const { context, page } = await openFixture({ mock: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
    } });
    assert.equal((await reconcile(page)).state, 'ios-install-required');
    assert.equal(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()), '');
    await page.evaluate(() => {
      window.matchMedia = query => ({ matches: String(query).includes('standalone'), media: query,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    });
    assert.equal((await reconcile(page)).state, 'permission-prompt-available');
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.permission, 0);
    assert.equal(calls.subscribe, 0);
    await context.close();
  });

  await test('B5 signed-out startup is read-only and renders no background UI', async () => {
    const { context, page } = await openFixture({ mock: {
      identity: { authenticated: false, userId: null, localOwner: null }
    } });
    assert.equal((await reconcile(page)).state, 'signed-out');
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.readiness, 0);
    assert.equal(calls.summary, 0);
    assert.equal(calls.permission, 0);
    assert.equal(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()), '');
    await context.close();
  });

  await test('B6 an unverified session performs no enrollment RPC and no prompt', async () => {
    const { context, page } = await openFixture({ mock: {
      identity: { authenticated: false, userId: null, localOwner: 'owner-a' }
    } });
    assert.equal((await reconcile(page)).state, 'unverified-session');
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.readiness, 0);
    assert.equal(calls.summary, 0);
    assert.equal(calls.permission, 0);
    assert.equal(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()), '');
    await context.close();
  });

  await test('B7 unavailable notification storage fails closed without a prompt', async () => {
    const { context, page } = await openFixture();
    await page.evaluate(() => { indexedDB.open = () => { throw new Error('storage blocked'); }; });
    assert.equal((await reconcile(page)).state, 'storage-unavailable');
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.permission, 0);
    assert.equal(calls.subscribe, 0);
    assert.equal(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()), '');
    await context.close();
  });

  await test('B8 a diverged local/verified owner is refused before any RPC', async () => {
    const { context, page } = await openFixture({ mock: {
      identity: { authenticated: true, userId: 'owner-b', localOwner: 'owner-a' }
    } });
    assert.equal((await reconcile(page)).state, 'session-diverged');
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.readiness, 0);
    assert.equal(calls.summary, 0);
    assert.equal(calls.permission, 0);
    await context.close();
  });

  await test('B9 an unready foundation hides enrollment and never registers', async () => {
    const { context, page } = await openFixture({ mock: { readinessResult: { ok: false, raw: null } } });
    assert.equal((await reconcile(page)).state, 'foundation-unavailable');
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.summary, 0);
    assert.equal(calls.register, 0);
    assert.equal(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()), '');
    await context.close();
  });

  await test('B10 the master reminder switch off shows disabled without prompting', async () => {
    const { context, page } = await openFixture({ mock: { prefs: { on: false } } });
    assert.equal((await reconcile(page)).state, 'disabled');
    assert.match(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()),
      /Turn on background reminders on this device/);
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.permission, 0);
    assert.equal(calls.subscribe, 0);
    await context.close();
  });

  await test('B11 a denied permission is never re-prompted and offers no action', async () => {
    const { context, page } = await openFixture({ mock: { permission: 'denied' } });
    assert.equal((await reconcile(page)).state, 'permission-denied');
    const typeofAction = await page.evaluate(() => {
      const markup = CapNotificationEnrollment.settingsMarkup();
      return { hasAction: markup.includes('data-bg-action'), blocked: /blocked notifications/.test(markup) };
    });
    assert.equal(typeofAction.hasAction, false);
    assert.equal(typeofAction.blocked, true);
    assert.equal((await page.evaluate(() => window.__calls.permission)), 0);
    await context.close();
  });

  await test('B12 permission default stays prompt-available until the explicit action', async () => {
    const { context, page } = await openFixture();
    assert.equal((await reconcile(page)).state, 'permission-prompt-available');
    assert.match(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()),
      /Turn on background reminders on this device/);
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.permission, 0);
    assert.equal(calls.subscribe, 0);
    assert.equal(calls.register, 0);
    await context.close();
  });

  await test('B13 granted without a subscription is not registered and never auto-subscribes', async () => {
    const { context, page } = await openFixture({ mock: { permission: 'granted' } });
    assert.equal((await reconcile(page)).state, 'permission-granted-no-subscription');
    assert.match(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()),
      /Turn on background reminders on this device/);
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.permission, 0);
    assert.equal(calls.subscribe, 0);
    assert.equal(calls.register, 0);
    await context.close();
  });

  await test('B14 explicit enable prompts once, subscribes once and persists a bounded binding', async () => {
    const { context, page } = await openFixture();
    await page.evaluate(() => localStorage.setItem('pera', '{"sentinel":true}'));
    const result = await page.evaluate(() => CapNotificationEnrollment.enable());
    assert.equal(result.ok, true);
    assert.equal(result.state, 'registered-pending');
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.permission, 1);
    assert.equal(calls.subscribe, 1);
    assert.equal(calls.register, 1);
    const payload = await page.evaluate(() => window.__registerPayload);
    assert.equal(payload.endpoint, KEYS.endpoint);
    assert.equal(payload.expectedGeneration, 0);
    assert.equal(payload.vapidKeyVersion, 'v1');
    assert.equal(payload.browserExpiration, null);
    assert.match(payload.p256dh, /^[A-Za-z0-9_-]+$/);
    assert.match(payload.auth, /^[A-Za-z0-9_-]+$/);
    assert.equal(payload.p256dh.includes('='), false);
    assert.equal(Buffer.from(payload.p256dh, 'base64url').length, 65);
    assert.equal(Buffer.from(payload.auth, 'base64url').length, 16);
    const local = await localState(page);
    assert.deepEqual(local.stores, ['state']);
    assert.equal(local.installation.id, payload.installationId);
    assert.equal(local.binding.binding_id, KEYS.bindingId);
    assert.equal(local.binding.endpoint_sha256, await sha256(KEYS.endpoint));
    assert.equal(JSON.stringify(local).includes(KEYS.endpoint), false, 'raw endpoint never persisted');
    assert.equal(JSON.stringify(local).includes(payload.p256dh), false, 'raw p256dh never persisted');
    assert.equal((await reconcile(page)).state, 'registered-pending');
    const markup = await page.evaluate(() => CapNotificationEnrollment.settingsMarkup());
    assert.match(markup, /Turn off background reminders/);
    assert.equal(markup.includes(payload.p256dh), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('pera')), '{"sentinel":true}');
    await context.close();
  });

  await test('B15 an existing unbound subscription requires Finish setup and reuses it', async () => {
    const { context, page } = await openFixture({ mock: {
      permission: 'granted', subscription: { endpoint: KEYS.endpoint, keyHex: KEYS.vapidHex }
    } });
    assert.equal((await reconcile(page)).state, 'local-subscription-unregistered');
    assert.match(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()), /Finish setup/);
    assert.equal((await page.evaluate(() => window.__calls.subscribe)), 0);
    const result = await page.evaluate(() => CapNotificationEnrollment.finishSetup());
    assert.equal(result.ok, true);
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.subscribe, 0);
    assert.equal(calls.register, 1);
    assert.equal((await localState(page)).binding.binding_id, KEYS.bindingId);
    await context.close();
  });

  await test('B16 duplicate taps collapse into one prompt, subscription and registration', async () => {
    const { context, page } = await openFixture();
    const results = await page.evaluate(() => Promise.all([
      CapNotificationEnrollment.enable(), CapNotificationEnrollment.enable()
    ]));
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal(results.filter(r => r.reason === 'BUSY').length, 1);
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.permission, 1);
    assert.equal(calls.subscribe, 1);
    assert.equal(calls.register, 1);
    await context.close();
  });

  await test('B17 concurrent tabs use Web Locks and register the shared subscription once', async () => {
    const context = await browser.newContext();
    const init = { vapid: VAPID, keys: KEYS, mock: { permission: 'granted' }, serverBinding: null };
    await context.addInitScript(installMocks, init);
    const one = await context.newPage();
    await one.goto(base() + '/harness');
    await one.waitForFunction(() => window.__changes.length > 0);
    const two = await context.newPage();
    await two.goto(base() + '/harness');
    await two.waitForFunction(() => window.__changes.length > 0);
    await one.evaluate(() => localStorage.setItem('__registerCount', '0'));
    const results = await Promise.all([
      one.evaluate(() => CapNotificationEnrollment.enable()),
      two.evaluate(() => CapNotificationEnrollment.enable())
    ]);
    assert.equal(results.filter(r => r.ok).length, 2);
    assert.equal(await one.evaluate(() => Number(localStorage.getItem('__registerCount'))), 1);
    assert.equal(await one.evaluate(() => Number(localStorage.getItem('__registerCount'))), 1);
    await context.close();
  });

  await test('B18 an older VAPID identity is visible and rotates only on explicit update', async () => {
    const { context, page } = await openFixture({ vapid: VAPID_2, serverBinding: serverBindingFor(),
      mock: { permission: 'granted', subscription: { endpoint: KEYS.endpoint, keyHex: KEYS.vapid2Hex } } });
    await seedLocal(page, { installation: { id: KEYS.installationId, created_at: '2026-10-28T00:00:00Z', protocol: 'CAP_PUSH_V1' },
      binding: bindingFor({ vapid_key_version: 'v1' }), sync: null });
    assert.equal((await reconcile(page)).state, 'stale-vapid-key');
    assert.match(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()), /Update this device/);
    assert.equal((await page.evaluate(() => window.__calls.register)), 0, 'no automatic rotation');
    await page.evaluate(() => { window.__calls = { permission: 0, subscribe: 0, unsubscribe: 0, register: 0, invalidate: 0, readiness: 0, summary: 0 }; });
    const result = await page.evaluate(() => CapNotificationEnrollment.updateVapid());
    assert.equal(result.ok, true);
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.unsubscribe, 1);
    assert.equal(calls.subscribe, 1);
    assert.equal(calls.register, 1);
    const payload = await page.evaluate(() => window.__registerPayload);
    assert.equal(payload.vapidKeyVersion, 'v2');
    assert.equal((await localState(page)).binding.vapid_key_version, 'v2');
    await context.close();
  });

  await test('B19 a mismatched browser subscription is reported and never auto-repaired', async () => {
    const { context, page } = await openFixture({ serverBinding: serverBindingFor(),
      mock: { permission: 'granted', subscription: { endpoint: KEYS.endpoint, keyHex: KEYS.vapidHex } } });
    await seedLocal(page, { installation: { id: KEYS.installationId, created_at: '2026-10-28T00:00:00Z', protocol: 'CAP_PUSH_V1' },
      binding: bindingFor({ endpoint_sha256: 'b'.repeat(64) }), sync: null });
    assert.equal((await reconcile(page)).state, 'subscription-mismatch');
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.subscribe, 0);
    assert.equal(calls.register, 0);
    await context.close();
  });

  await test('B20 a missing server binding keeps the local record and offers Finish setup', async () => {
    const { context, page } = await openFixture({ mock: { permission: 'granted' } });
    await seedLocal(page, { installation: { id: KEYS.installationId, created_at: '2026-10-28T00:00:00Z', protocol: 'CAP_PUSH_V1' },
      binding: bindingFor(), sync: null });
    assert.equal((await reconcile(page)).state, 'server-binding-missing');
    assert.match(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()), /Finish setup/);
    const result = await page.evaluate(() => CapNotificationEnrollment.finishSetup());
    assert.equal(result.ok, true);
    const payload = await page.evaluate(() => window.__registerPayload);
    assert.equal(payload.expectedGeneration, 1);
    assert.equal((await localState(page)).binding.generation, 2);
    await context.close();
  });

  await test('B21 a lost browser subscription is reported without auto-resubscribing', async () => {
    const { context, page } = await openFixture({ serverBinding: serverBindingFor() });
    await seedLocal(page, { installation: { id: KEYS.installationId, created_at: '2026-10-28T00:00:00Z', protocol: 'CAP_PUSH_V1' },
      binding: bindingFor(), sync: null });
    assert.equal((await reconcile(page)).state, 'subscription-lost');
    assert.equal((await page.evaluate(() => window.__calls.subscribe)), 0);
    assert.equal((await page.evaluate(() => window.__calls.register)), 0);
    await context.close();
  });

  await test('B22 a foreign account reservation is surfaced and no binding is kept', async () => {
    const { context, page } = await openFixture({ mock: { permission: 'granted',
      subscription: { endpoint: KEYS.endpoint, keyHex: KEYS.vapidHex },
      registerError: 'NOTIFICATION_BINDING_CONFLICT' } });
    assert.equal((await reconcile(page)).state, 'local-subscription-unregistered');
    const result = await page.evaluate(() => CapNotificationEnrollment.finishSetup());
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'FOREIGN_ACCOUNT_RESERVATION');
    assert.equal((await reconcile(page)).state, 'foreign-account-reservation');
    assert.equal((await localState(page)).binding, null);
    assert.match(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()),
      /belongs to another account/);
    await context.close();
  });

  await test('B23 offline explicit enrollment is refused before permission or subscribe', async () => {
    const { context, page } = await openFixture();
    await context.setOffline(true);
    assert.equal(await page.evaluate(() => navigator.onLine), false);
    const result = await page.evaluate(() => CapNotificationEnrollment.enable());
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'OFFLINE');
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.permission, 0);
    assert.equal(calls.subscribe, 0);
    assert.equal(calls.register, 0);
    await context.close();
  });

  await test('B24 an account switch during registration never transfers the subscription', async () => {
    const { context, page } = await openFixture({ mock: { permission: 'granted', switchSessionOnRegister: true } });
    const result = await page.evaluate(() => CapNotificationEnrollment.enable());
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'SESSION_DIVERGED');
    assert.equal((await localState(page)).binding, null);
    assert.equal((await reconcile(page)).state, 'session-diverged');
    await context.close();
  });

  await test('B25 sign-out invalidates server-first, unsubscribes locally and stays bounded', async () => {
    const { context, page } = await openFixture({ serverBinding: serverBindingFor(),
      mock: { permission: 'granted', subscription: { endpoint: KEYS.endpoint, keyHex: KEYS.vapidHex } } });
    await seedLocal(page, { installation: { id: KEYS.installationId, created_at: '2026-10-28T00:00:00Z', protocol: 'CAP_PUSH_V1' },
      binding: bindingFor(), sync: null });
    const started = Date.now();
    const result = await page.evaluate(() => CapNotificationEnrollment.beforeSignOut());
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true);
    assert.ok(elapsed < 8000, 'sign-out hook exceeded its budget: ' + elapsed);
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.invalidate, 1);
    assert.equal(calls.unsubscribe, 1);
    const local = await localState(page);
    assert.equal(local.binding, null);
    assert.notEqual(local.sync && local.sync.last_error_code, 'DISABLE_PENDING');
    await context.close();
  });

  await test('B25b failed sign-out invalidation still unsubscribes and persists pending-disable', async () => {
    const { context, page } = await openFixture({ serverBinding: serverBindingFor(),
      mock: { permission: 'granted', subscription: { endpoint: KEYS.endpoint, keyHex: KEYS.vapidHex },
        invalidateError: 'INVALIDATE_FAILED' } });
    await seedLocal(page, { installation: { id: KEYS.installationId, created_at: '2026-10-28T00:00:00Z', protocol: 'CAP_PUSH_V1' },
      binding: bindingFor(), sync: null });
    const started = Date.now();
    const result = await page.evaluate(() => CapNotificationEnrollment.beforeSignOut());
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.state, 'pending-disable');
    assert.ok(elapsed < 8000, 'sign-out hook exceeded its budget: ' + elapsed);
    const calls = await page.evaluate(() => ({ ...window.__calls }));
    assert.equal(calls.unsubscribe, 1);
    const local = await localState(page);
    assert.equal(local.binding.state, 'disable_pending');
    assert.equal(local.sync.last_error_code, 'DISABLE_PENDING');
    assert.equal(local.sync.in_flight, false);
    assert.equal((await reconcile(page)).state, 'pending-disable');
    assert.match(await page.evaluate(() => CapNotificationEnrollment.settingsMarkup()), /Finish removal/);
    await context.close();
  });

  await test('B26 notification 4xx never invalidates a verified session; auth 4xx does', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.CAP_SUPABASE_CONFIG = { url: 'https://fixture.invalid', publishableKey: 'fixture' };
      localStorage.setItem('cap_supabase_session', JSON.stringify({ access_token: 'x', refresh_token: 'y', user: { id: 'owner-a' } }));
      localStorage.setItem('pera', '{"sentinel":true}');
      window.__transport = { userStatus: 200, mode: 'ok' };
      window.fetch = async url => {
        const target = String(url);
        const json = (status, body) => ({ ok: status >= 200 && status < 300, status,
          text: async () => JSON.stringify(body) });
        if (target.endsWith('/auth/v1/user')) {
          return window.__transport.userStatus === 200 ? json(200, { id: 'owner-a' }) : json(window.__transport.userStatus, { message: 'invalid jwt' });
        }
        if (window.__transport.mode === 'notification4xx') return json(400, { message: 'NOTIFICATION_BINDING_CONFLICT' });
        if (window.__transport.mode === 'data401') return json(401, { message: 'unauthorized' });
        return json(200, {});
      };
    });
    const page = await context.newPage();
    await page.goto(base() + '/transport');
    await page.waitForFunction(() => window.CapSupabase && CapSupabase.status().authenticated === true);
    assert.equal(await page.evaluate(async () => {
      window.__transport.mode = 'notification4xx';
      try { await CapSupabase.syncRequest('/rest/v1/rpc/cap_notifications_register_v1', { method: 'POST', body: '{}' }); }
      catch (error) { return error.status; }
      return 'resolved';
    }), 400);
    assert.equal(await page.evaluate(() => CapSupabase.status().authenticated), true);
    assert.equal(await page.evaluate(async () => {
      window.__transport.mode = 'data401';
      try { await CapSupabase.syncRequest('/rest/v1/rpc/cap_sync_snapshot_v1', { method: 'POST', body: '{}' }); }
      catch (error) { return error.status; }
      return 'resolved';
    }), 401);
    assert.equal(await page.evaluate(() => CapSupabase.status().authenticated), true, 'data 401 alone is not auth evidence');
    assert.equal(await page.evaluate(async () => {
      window.__transport.userStatus = 401;
      try { await CapSupabase.currentUser(); } catch (_) { return 'rejected'; }
      return 'resolved';
    }), 'rejected');
    assert.equal(await page.evaluate(() => CapSupabase.status().authenticated), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('pera')), '{"sentinel":true}');
    await context.close();
  });

  console.log(`PASS: ${passed} Phase 5B.2B browser checks (B1-B26)`);
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  });
