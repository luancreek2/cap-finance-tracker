/* Phase 5B.2B: dark client enrollment machinery.
   Notification-only. This module never reads or writes financial state, never
   touches `pera`, the cloud baseline, the outbox, notes or account records, and
   never stores a raw push endpoint, p256dh or auth value. The VAPID private key
   is never present here. Startup reconciliation is read-only with respect to
   server enrollment: it may read capability evidence, the separate
   `cap-notifications` database, an existing PushSubscription and the owner-
   scoped summary/readiness RPCs, but it never prompts, subscribes, registers,
   invalidates or retries automatically. Only the explicit Settings action can
   enroll this device. */
(function () {
  'use strict';
  const DB_NAME = 'cap-notifications';
  const DB_VERSION = 1;
  const STORE = 'state';
  const PROTOCOL = 'CAP_PUSH_V1';
  const LOCK_NAME = 'cap-notifications-enrollment';
  const SIGN_OUT_BUDGET_MS = 8000;
  const REGISTER_TIMEOUT_MS = 15000;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const HEX_RE = /^[0-9a-f]{64}$/;
  const VAPID_VERSION_RE = /^v[1-9][0-9]{0,2}$/;
  const INSTALLATION_FIELDS = ['id', 'created_at', 'protocol'];
  const BINDING_FIELDS = ['installation_id', 'binding_id', 'generation', 'schedule_revision',
    'state', 'vapid_key_version', 'endpoint_sha256', 'updated_at'];
  const SYNC_FIELDS = ['in_flight', 'started_at', 'tab_id', 'last_error_code', 'last_attempt_at', 'retry_after'];
  const SERVER_STATES = ['pending', 'disabled', 'retired'];
  const LOCAL_STATES = SERVER_STATES.concat(['disable_pending']);
  const STATES = Object.freeze([
    'unsupported-insecure', 'unsupported-browser', 'ios-install-required', 'signed-out',
    'unverified-session', 'foundation-unavailable', 'storage-unavailable', 'session-diverged',
    'disabled', 'pending-disable', 'supported-not-enrolled', 'permission-prompt-available',
    'permission-denied', 'permission-granted-no-subscription', 'local-subscription-unregistered',
    'registered-pending', 'stale-local-generation', 'stale-vapid-key', 'subscription-mismatch',
    'server-binding-missing', 'subscription-lost', 'foreign-account-reservation',
    'disabled-server-subscription-live', 'error-retry', 'error-fatal'
  ]);
  const TAB_ID = freshUuid();
  let busy = false;
  let lastState = Object.freeze({ state: 'signed-out', available: false, reason: null });
  let lastEvidence = null;
  let lastConflict = false;
  let localTail = Promise.resolve();

  const code = reason => Object.assign(Error(reason), { code: reason });
  const iso = () => new Date().toISOString();
  const now = () => Date.now();
  const wait = ms => new Promise(r => setTimeout(r, ms));
  function freshUuid() {
    try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID(); }
    catch (_) {}
    // Installation identity must be cryptographically random; there is no
    // insecure fallback. Callers fail closed when this is unavailable.
    return null;
  }
  function exactFields(value, fields) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === fields.length && fields.every(k => Object.prototype.hasOwnProperty.call(value, k));
  }
  function installationRecord(v) {
    if (!exactFields(v, INSTALLATION_FIELDS)) return null;
    if (typeof v.id !== 'string' || !UUID_RE.test(v.id)) return null;
    if (typeof v.created_at !== 'string' || Number.isNaN(Date.parse(v.created_at))) return null;
    if (v.protocol !== PROTOCOL) return null;
    return { id: v.id, created_at: v.created_at, protocol: v.protocol };
  }
  function bindingRecord(v) {
    if (!exactFields(v, BINDING_FIELDS)) return null;
    if (typeof v.installation_id !== 'string' || !UUID_RE.test(v.installation_id)) return null;
    if (typeof v.binding_id !== 'string' || !UUID_RE.test(v.binding_id)) return null;
    if (!Number.isSafeInteger(v.generation) || v.generation < 1) return null;
    if (!Number.isSafeInteger(v.schedule_revision) || v.schedule_revision < 0) return null;
    if (!LOCAL_STATES.includes(v.state)) return null;
    if (typeof v.vapid_key_version !== 'string' || !VAPID_VERSION_RE.test(v.vapid_key_version)) return null;
    if (typeof v.endpoint_sha256 !== 'string' || !HEX_RE.test(v.endpoint_sha256)) return null;
    if (typeof v.updated_at !== 'string' || Number.isNaN(Date.parse(v.updated_at))) return null;
    return { installation_id: v.installation_id, binding_id: v.binding_id, generation: v.generation,
      schedule_revision: v.schedule_revision, state: v.state, vapid_key_version: v.vapid_key_version,
      endpoint_sha256: v.endpoint_sha256, updated_at: v.updated_at };
  }
  function syncRecord(v) {
    if (!exactFields(v, SYNC_FIELDS)) return null;
    if (typeof v.in_flight !== 'boolean') return null;
    for (const k of ['started_at', 'last_attempt_at', 'retry_after']) {
      if (v[k] !== null && (!Number.isFinite(v[k]) || v[k] < 0)) return null;
    }
    if (v.tab_id !== null && (typeof v.tab_id !== 'string' || !UUID_RE.test(v.tab_id))) return null;
    if (v.last_error_code !== null && typeof v.last_error_code !== 'string') return null;
    return { in_flight: v.in_flight, started_at: v.started_at, tab_id: v.tab_id,
      last_error_code: v.last_error_code, last_attempt_at: v.last_attempt_at, retry_after: v.retry_after };
  }
  const EMPTY_SYNC = Object.freeze({ in_flight: false, started_at: null, tab_id: null,
    last_error_code: null, last_attempt_at: null, retry_after: null });

  // ---- notification-only IndexedDB (separate database, out-of-line keys) ----
  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(code('STORAGE_UNAVAILABLE'));
      let request;
      try { request = indexedDB.open(DB_NAME, DB_VERSION); } catch (_) { return reject(code('STORAGE_UNAVAILABLE')); }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Never block a future schema upgrade: this module keeps no long-lived
        // connection and releases the handle if another context needs it.
        db.onversionchange = () => { try { db.close(); } catch (_) {} };
        resolve(db);
      };
      request.onerror = () => reject(request.error || code('STORAGE_UNAVAILABLE'));
      request.onblocked = () => reject(code('STORAGE_BLOCKED'));
    });
  }
  function readKey(key) {
    return openDb().then(db => new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(STORE, 'readonly'); } catch (_) { db.close(); return reject(code('STORAGE_READ_FAILED')); }
      const q = tx.objectStore(STORE).get(key);
      q.onsuccess = () => resolve(q.result == null ? null : q.result);
      q.onerror = () => reject(q.error || code('STORAGE_READ_FAILED'));
      tx.oncomplete = () => db.close();
      tx.onerror = () => { db.close(); reject(tx.error || code('STORAGE_READ_FAILED')); };
      tx.onabort = () => { db.close(); reject(tx.error || code('STORAGE_READ_FAILED')); };
    }));
  }
  function writeKey(key, value) {
    return openDb().then(db => new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(STORE, 'readwrite'); } catch (_) { db.close(); return reject(code('STORAGE_WRITE_FAILED')); }
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error || code('STORAGE_WRITE_FAILED')); };
      tx.onabort = () => { db.close(); reject(tx.error || code('STORAGE_WRITE_FAILED')); };
    }));
  }
  function deleteKey(key) {
    return openDb().then(db => new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(STORE, 'readwrite'); } catch (_) { db.close(); return reject(code('STORAGE_WRITE_FAILED')); }
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error || code('STORAGE_WRITE_FAILED')); };
      tx.onabort = () => { db.close(); reject(tx.error || code('STORAGE_WRITE_FAILED')); };
    }));
  }
  async function ensureInstallation() {
    let record = null;
    try { record = installationRecord(await readKey('installation')); } catch (_) { throw code('STORAGE_UNAVAILABLE'); }
    if (record) return record;
    const id = freshUuid();
    if (!id) throw code('INSTALLATION_ID_UNAVAILABLE');
    record = { id, created_at: iso(), protocol: PROTOCOL };
    await writeKey('installation', record);
    return record;
  }
  async function readLocal() {
    let installation = null, binding = null, sync = null;
    installation = installationRecord(await readKey('installation'));
    binding = bindingRecord(await readKey('binding'));
    sync = syncRecord(await readKey('sync'));
    return { installation, binding, sync: sync || { ...EMPTY_SYNC, tab_id: TAB_ID } };
  }
  async function writeSync(patch) {
    const base = syncRecord(await readKey('sync')) || { ...EMPTY_SYNC, tab_id: TAB_ID };
    const next = syncRecord({ ...base, ...patch });
    if (!next) throw code('STORAGE_WRITE_FAILED');
    await writeKey('sync', next);
    return next;
  }
  async function setDisablePending(binding) {
    if (binding) {
      const next = bindingRecord({ ...binding, state: 'disable_pending', updated_at: iso() });
      if (next) await writeKey('binding', next);
    }
    await writeSync({ in_flight: false, started_at: null, last_error_code: 'DISABLE_PENDING',
      last_attempt_at: now(), retry_after: null });
  }
  async function clearDisablePending() {
    await writeSync({ in_flight: false, started_at: null, last_error_code: null });
  }

  // ---- shared crypto/encoding helpers -------------------------------------
  function bytesOf(value) {
    if (!value) return null;
    if (value instanceof Uint8Array) return Uint8Array.from(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    if (typeof value === 'string') {
      try { return window.CapVapidPublic?.decodeBase64url?.(value) || null; } catch (_) { return null; }
    }
    return null;
  }
  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  async function sha256Hex(text) {
    const subtle = typeof crypto !== 'undefined' && crypto && crypto.subtle;
    if (!subtle || typeof text !== 'string') throw code('CRYPTO_UNAVAILABLE');
    const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
    let out = '';
    for (const b of digest) out += b.toString(16).padStart(2, '0');
    return out;
  }

  // ---- capability evidence C1-C14 -----------------------------------------
  function appleMobileContext(nav) {
    // Device-class detection only: it decides whether the Home Screen remedy is
    // the actionable one. It is never the primary capability test and never
    // blocks macOS Safari merely because the site is not in the Dock.
    const ua = String(nav?.userAgent || '');
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    return nav?.platform === 'MacIntel' && Number(nav?.maxTouchPoints) > 1;
  }
  function envModel(env) {
    const nav = env?.navigator || {};
    const secureContext = !!env?.isSecureContext;
    const serviceWorker = !!env?.serviceWorker;
    const notificationApi = typeof env?.Notification === 'function';
    const pushApi = typeof env?.PushManager !== 'undefined' &&
      typeof env?.ServiceWorkerRegistration !== 'undefined' &&
      'pushManager' in env.ServiceWorkerRegistration.prototype;
    const standalone = !!env?.standalone;
    const permission = notificationApi ? (env.Notification.permission || 'default') : 'unsupported';
    return { secureContext, serviceWorker, notificationApi, pushApi, standalone, permission,
      appleMobile: appleMobileContext(nav) };
  }
  function displayStandalone() {
    if (typeof matchMedia !== 'function') return navigator?.standalone === true;
    for (const mode of ['standalone', 'fullscreen']) {
      try { if (matchMedia('(display-mode: ' + mode + ')').matches) return true; } catch (_) {}
    }
    return navigator?.standalone === true;
  }
  function environment() {
    return {
      isSecureContext: typeof isSecureContext !== 'undefined' && isSecureContext === true,
      serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
      Notification: typeof Notification !== 'undefined' ? Notification : undefined,
      PushManager: typeof PushManager !== 'undefined' ? PushManager : undefined,
      ServiceWorkerRegistration: typeof ServiceWorkerRegistration !== 'undefined' ? ServiceWorkerRegistration : undefined,
      standalone: displayStandalone(),
      navigator: typeof navigator !== 'undefined' ? navigator : {}
    };
  }
  async function registrationAndSubscription() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
      return { registration: null, active: false, subscription: null };
    }
    let registration = null;
    try { registration = await navigator.serviceWorker.getRegistration(); } catch (_) {}
    const active = !!registration?.active && registration.active.state === 'activated';
    let subscription = null;
    if (active) {
      try { subscription = await registration.pushManager.getSubscription(); } catch (_) {}
    }
    return { registration, active, subscription };
  }
  async function capabilities() {
    const model = envModel(environment());
    const rs = await registrationAndSubscription();
    return { ...model, registration: rs.registration, registrationActive: rs.active,
      subscription: rs.subscription };
  }
  function subscriptionKeyBytes(subscription) {
    if (!subscription) return null;
    return bytesOf(subscription.options?.applicationServerKey ?? subscription.applicationServerKey);
  }
  function subscriptionKeys(subscription) {
    try {
      return {
        p256dh: bytesOf(subscription?.getKey?.('p256dh')),
        auth: bytesOf(subscription?.getKey?.('auth'))
      };
    } catch (_) { return { p256dh: null, auth: null }; }
  }
  function validP256dh(bytes) { return !!bytes && bytes.length === 65 && bytes[0] === 4; }
  function validAuth(bytes) { return !!bytes && bytes.length === 16; }
  // Conservative client-side mirror of the server endpoint boundary. The server
  // remains authoritative; this only prevents sending obvious junk.
  function validEndpoint(value) {
    if (typeof value !== 'string' || !value || value.length > 4096) return false;
    let url;
    try { url = new URL(value); } catch (_) { return false; }
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password || url.port || url.hash) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com') return true;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:push\.apple\.com|notify\.windows\.com)$/.test(host)) return false;
    return true;
  }
  function validateSubscription(subscription, vapid) {
    if (!subscription) return { ok: false, reason: 'SUBSCRIPTION_MISSING' };
    const endpoint = subscription.endpoint;
    if (!validEndpoint(endpoint)) return { ok: false, reason: 'ENDPOINT_INVALID' };
    const keys = subscriptionKeys(subscription);
    if (!validP256dh(keys.p256dh)) return { ok: false, reason: 'P256DH_INVALID' };
    if (!validAuth(keys.auth)) return { ok: false, reason: 'AUTH_INVALID' };
    const keyBytes = subscriptionKeyBytes(subscription);
    if (!keyBytes || !sameBytes(keyBytes, vapid.keyBytes)) return { ok: false, reason: 'VAPID_KEY_MISMATCH' };
    return { ok: true, endpoint, p256dh: keys.p256dh, auth: keys.auth, keyBytes };
  }

  // ---- identity/session evidence (C11) ------------------------------------
  function identityEvidence() {
    let raw = null;
    try { raw = window.CapSupabase?.authEvidence?.() || null; } catch (_) { raw = null; }
    let owner = raw?.userId || null, localOwner = raw?.localOwner || null;
    let generation = Number(raw?.sessionGeneration);
    if (!Number.isFinite(generation)) generation = 0;
    if (!raw) {
      try { localOwner = window.CapSupabase?.localIdentity?.() || null; } catch (_) {}
      try { const g = Number(window.CapSupabase?.sessionGeneration?.()); if (Number.isFinite(g)) generation = g; } catch (_) {}
    }
    return {
      verified: raw?.authenticated === true && !!owner,
      owner, localOwner, sessionGeneration: generation,
      diverged: !!(owner && localOwner && owner !== localOwner)
    };
  }
  function sessionChanged(captured) {
    const current = identityEvidence();
    return !current.verified || current.owner !== captured.owner ||
      current.sessionGeneration !== captured.sessionGeneration;
  }

  // ---- deterministic first-match-wins state machine -----------------------
  // Evidence shape is intentionally flat so every combination can be tested:
  // { secureContext, serviceWorker, notificationApi, pushApi, standalone,
  //   appleMobile, permission, online, identity:{verified,owner,localOwner,
  //   sessionGeneration,diverged}, storageOk, foundationOk, vapidOk,
  //   vapidVersion, serverAttempted, serverOk, serverBinding, localBinding,
  //   sync, subscription, subscriptionKeyMatch, endpointSha256, masterEnabled,
  //   serverConflict, retry, fatal }
  function deriveState(e) {
    if (!e || typeof e !== 'object' || e.fatal) return 'error-fatal';
    if (!e.secureContext) return 'unsupported-insecure';
    if (e.appleMobile && !e.standalone) return 'ios-install-required';
    if (!e.serviceWorker || !e.notificationApi || !e.pushApi) return 'unsupported-browser';
    const id = e.identity;
    if (!id || !id.localOwner) return 'signed-out';
    if (!id.verified) return 'unverified-session';
    if (!e.storageOk) return 'storage-unavailable';
    if (id.diverged) return 'session-diverged';
    if (!e.foundationOk) return 'foundation-unavailable';
    const local = e.localBinding || null, server = e.serverBinding || null;
    const sub = e.subscription || null, sync = e.sync || {};
    if (sync.disable_pending === true || sync.last_error_code === 'DISABLE_PENDING' ||
        local?.state === 'disable_pending') return 'pending-disable';
    if (e.serverConflict) return 'foreign-account-reservation';
    if (server && server.state === 'disabled') return sub ? 'disabled-server-subscription-live' : 'disabled';
    if (local && server && Number(local.generation) !== Number(server.generation)) return 'stale-local-generation';
    if (local && !server) return e.serverOk === false ? 'error-retry' : 'server-binding-missing';
    if (local && server) {
      if (!e.vapidOk || local.vapid_key_version !== e.vapidVersion) return 'stale-vapid-key';
      if (sub) {
        if (e.subscriptionKeyMatch !== true) return 'stale-vapid-key';
        if (e.endpointSha256 && local.endpoint_sha256 !== e.endpointSha256) return 'subscription-mismatch';
        if (server.state === 'pending') return 'registered-pending';
        if (server.state === 'disabled') return 'disabled-server-subscription-live';
      }
      if (!sub) return 'subscription-lost';
    }
    if (sub && !local) return 'local-subscription-unregistered';
    if (sub) return 'supported-not-enrolled';
    if (e.online === false && e.serverAttempted && e.serverOk === false) return 'error-retry';
    if (e.masterEnabled === false) return 'disabled';
    if (e.permission === 'denied') return 'permission-denied';
    if (e.permission === 'granted') return 'permission-granted-no-subscription';
    if (e.permission === 'default') return 'permission-prompt-available';
    if (e.retry) return 'error-retry';
    return 'supported-not-enrolled';
  }

  // ---- read-only reconciliation -------------------------------------------
  async function currentVapid() {
    try {
      const api = window.CapVapidPublic;
      return await api.validate(api.current());
    } catch (_) { return { ok: false, reason: 'VAPID_CONFIG_INVALID' }; }
  }
  function bindingFromSummary(summary, localInstallationId) {
    const rows = Array.isArray(summary?.bindings) ? summary.bindings : [];
    return rows.find(b => localInstallationId && b?.installation_id === localInstallationId) || null;
  }
  async function reconcile() {
    let evidence;
    try {
      const caps = await capabilities();
      const identity = identityEvidence();
      let storageOk = true, local = { installation: null, binding: null, sync: { ...EMPTY_SYNC, tab_id: TAB_ID } };
      try {
        await ensureInstallation();
        local = await readLocal();
      } catch (_) { storageOk = false; }
      const vapid = await currentVapid();
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      let foundationOk = true, serverAttempted = false, serverOk = true, serverBinding = null;
      if (identity.verified && !identity.diverged && online && storageOk) {
        serverAttempted = true;
        try {
          const readiness = await window.CapProductionRpc.notificationReadiness();
          foundationOk = readiness?.ok === true;
        } catch (_) { foundationOk = false; }
        if (foundationOk) {
          try {
            const summary = await window.CapProductionRpc.notificationSummary();
            serverOk = summary?.ok === true;
            serverBinding = summary?.ok ? bindingFromSummary(summary.raw, local.installation?.id) : null;
          } catch (_) { serverOk = false; }
        }
      }
      const sub = caps.subscription || null;
      const keys = sub ? subscriptionKeys(sub) : { p256dh: null, auth: null };
      const endpointSha256 = sub && validEndpoint(sub.endpoint) ? await sha256Hex(sub.endpoint) : null;
      let masterEnabled = true;
      try {
        const prefs = window.CapNotifications?.preferences?.();
        if (prefs && typeof prefs.on === 'boolean') masterEnabled = prefs.on;
      } catch (_) {}
      evidence = {
        secureContext: caps.secureContext, serviceWorker: caps.serviceWorker,
        notificationApi: caps.notificationApi, pushApi: caps.pushApi, standalone: caps.standalone,
        appleMobile: caps.appleMobile, permission: caps.permission, online,
        identity, storageOk, foundationOk, vapidOk: vapid.ok === true,
        vapidVersion: vapid.ok ? vapid.version : null,
        serverAttempted, serverOk, serverBinding,
        localBinding: local.binding, sync: local.sync, subscription: sub,
        subscriptionKeyMatch: !!(sub && vapid.ok && sameBytes(subscriptionKeyBytes(sub), vapid.keyBytes)),
        endpointSha256, subscriptionKeysValid: validP256dh(keys.p256dh) && validAuth(keys.auth),
        masterEnabled, serverConflict: lastConflict,
        retry: false, fatal: false
      };
      const state = deriveState(evidence);
      const available = vapid.ok === true && foundationOk === true && identity.verified === true &&
        identity.diverged === false && storageOk === true;
      lastEvidence = evidence;
      lastState = Object.freeze({ state, available, reason: state === 'foundation-unavailable' ? 'FOUNDATION_NOT_READY' : null,
        online, permission: caps.permission, vapidVersion: evidence.vapidVersion });
    } catch (error) {
      lastEvidence = null;
      lastState = Object.freeze({ state: 'error-fatal', available: false, reason: String(error?.code || error?.message || 'ERROR_FATAL') });
    }
    dispatchChanged();
    return lastState;
  }
  function dispatchChanged() {
    try { window.dispatchEvent(new CustomEvent('cap-notifications-enrollment-changed', { detail: { ...lastState } })); } catch (_) {}
  }

  // ---- lock + timeouts -----------------------------------------------------
  function withLock(fn) {
    if (navigator?.locks?.request) return navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, () => fn());
    const run = localTail.then(() => fn());
    localTail = run.catch(() => {});
    return run;
  }
  function withDeadline(promise, deadline) {
    const remaining = Math.max(0, deadline - now());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(code('TIMEOUT')), remaining);
      Promise.resolve(promise).then(v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e); });
    });
  }
  async function activeRegistration() {
    if (!navigator?.serviceWorker) throw code('SERVICE_WORKER_UNAVAILABLE');
    let registration = null;
    try { registration = await navigator.serviceWorker.getRegistration(); } catch (_) {}
    if (!registration?.active || registration.active.state !== 'activated') {
      try { registration = await withDeadline(navigator.serviceWorker.ready, now() + 5000); } catch (_) {}
    }
    if (!registration?.active || registration.active.state !== 'activated') throw code('SERVICE_WORKER_UNAVAILABLE');
    return registration;
  }
  function fail(reason, error) {
    return { ok: false, reason, error: error ? String(error?.message || error) : null, state: lastState.state };
  }
  function responseBinding(raw, installationId) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw code('REGISTER_RESPONSE_INVALID');
    if (typeof raw.binding_id !== 'string' || !UUID_RE.test(raw.binding_id)) throw code('REGISTER_RESPONSE_INVALID');
    if (raw.installation_id !== installationId) throw code('REGISTER_RESPONSE_INVALID');
    if (!Number.isSafeInteger(raw.generation) || raw.generation < 1) throw code('REGISTER_RESPONSE_INVALID');
    if (!Number.isSafeInteger(raw.schedule_revision) || raw.schedule_revision < 0) throw code('REGISTER_RESPONSE_INVALID');
    if (!SERVER_STATES.includes(raw.state)) throw code('REGISTER_RESPONSE_INVALID');
    return raw;
  }
  async function safeUnsubscribe(subscription) {
    if (!subscription || typeof subscription.unsubscribe !== 'function') return false;
    try { return await subscription.unsubscribe(); } catch (_) { return false; }
  }

  // ---- explicit enrollment -------------------------------------------------
  async function enroll(mode) {
    if (busy) return fail('BUSY');
    busy = true;
    try {
      const vapid = await currentVapid();
      if (!vapid.ok) return fail('VAPID_CONFIG_UNAVAILABLE');
      let prefs = null;
      try { prefs = window.CapNotifications?.preferences?.(); } catch (_) {}
      if (prefs && prefs.on !== true) return fail('NOTIFICATIONS_DISABLED');
      const caps = await capabilities();
      if (!caps.secureContext) return fail('INSECURE_CONTEXT');
      if (!caps.serviceWorker || !caps.notificationApi || !caps.pushApi) return fail('UNSUPPORTED_BROWSER');
      if (caps.appleMobile && !caps.standalone) return fail('IOS_INSTALL_REQUIRED');
      if (navigator.onLine === false) return fail('OFFLINE');
      const identity = identityEvidence();
      if (!identity.verified) return fail('SESSION_UNVERIFIED');
      if (identity.diverged) return fail('SESSION_DIVERGED');
      let installation;
      try { installation = await ensureInstallation(); } catch (error) { return fail('STORAGE_UNAVAILABLE', error); }
      const captured = { owner: identity.owner, sessionGeneration: identity.sessionGeneration };
      const result = await withLock(async () => {
        if (sessionChanged(captured)) return fail('SESSION_DIVERGED');
        let registration;
        try { registration = await activeRegistration(); } catch (error) { return fail('SERVICE_WORKER_UNAVAILABLE', error); }
        let permission = Notification.permission;
        if (permission === 'default') {
          try { permission = await Notification.requestPermission(); } catch (_) { permission = 'denied'; }
        }
        if (permission !== 'granted') {
          return fail(permission === 'denied' ? 'PERMISSION_DENIED' : 'PERMISSION_DISMISSED');
        }
        if (sessionChanged(captured)) return fail('SESSION_DIVERGED');
        let subscription = null;
        try { subscription = await registration.pushManager.getSubscription(); } catch (_) {}
        let created = false;
        if (!subscription) {
          try {
            subscription = await registration.pushManager.subscribe({
              userVisibleOnly: true, applicationServerKey: vapid.keyBytes.slice().buffer
            });
            created = true;
          } catch (error) { return fail('SUBSCRIBE_FAILED', error); }
        }
        const valid = validateSubscription(subscription, vapid);
        if (!valid.ok) {
          if (created) await safeUnsubscribe(subscription);
          return fail(valid.reason);
        }
        const endpointSha256 = await sha256Hex(valid.endpoint);
        if (sessionChanged(captured)) {
          if (created) await safeUnsubscribe(subscription);
          return fail('SESSION_DIVERGED');
        }
        // A concurrent tab may already have completed this exact installation.
        // This is a read-only check; it never turns a bare subscription into a
        // registered binding without matching server evidence.
        let local = null;
        try { local = await readLocal(); } catch (_) { return fail('STORAGE_UNAVAILABLE'); }
        if (!mode?.repair && local.binding && local.installation?.id === installation.id &&
            local.binding.endpoint_sha256 === endpointSha256 &&
            local.binding.vapid_key_version === vapid.version && local.binding.state === 'pending') {
          try {
            const summary = await window.CapProductionRpc.notificationSummary();
            const server = summary?.ok ? bindingFromSummary(summary.raw, installation.id) : null;
            if (server && server.binding_id === local.binding.binding_id &&
                Number(server.generation) === Number(local.binding.generation)) {
              return { ok: true, already: true, state: 'registered-pending', binding_id: local.binding.binding_id };
            }
          } catch (_) {}
        }
        const expectedGeneration = local.binding && local.installation?.id === installation.id
          ? Number(local.binding.generation) : 0;
        if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) return fail('LOCAL_GENERATION_INVALID');
        const expiration = Number.isFinite(subscription.expirationTime)
          ? new Date(subscription.expirationTime).toISOString() : null;
        let raw;
        try {
          raw = await withDeadline(window.CapProductionRpc.notificationRegister({
            installationId: installation.id,
            expectedGeneration,
            endpoint: valid.endpoint,
            p256dh: window.CapVapidPublic.encodeBase64url(valid.p256dh),
            auth: window.CapVapidPublic.encodeBase64url(valid.auth),
            vapidKeyVersion: vapid.version,
            browserExpiration: expiration
          }), now() + REGISTER_TIMEOUT_MS);
        } catch (error) {
          const reason = String(error?.code || error?.message || '');
          if (reason.includes('NOTIFICATION_BINDING_CONFLICT')) {
            lastConflict = true;
            return fail('FOREIGN_ACCOUNT_RESERVATION', error);
          }
          if (reason.includes('NOTIFICATION_STALE_BINDING')) return fail('STALE_LOCAL_GENERATION', error);
          return fail('REGISTER_FAILED', error);
        }
        let response;
        try { response = responseBinding(raw, installation.id); }
        catch (error) { return fail('REGISTER_RESPONSE_INVALID', error); }
        if (sessionChanged(captured)) {
          // The server accepted this registration for the captured owner. Never
          // transfer it to another account or persist it under the new session.
          return fail('SESSION_DIVERGED');
        }
        lastConflict = false;
        const binding = bindingRecord({
          installation_id: installation.id,
          binding_id: response.binding_id,
          generation: response.generation,
          schedule_revision: response.schedule_revision,
          state: response.state,
          vapid_key_version: vapid.version,
          endpoint_sha256: endpointSha256,
          updated_at: iso()
        });
        if (!binding) return fail('STORAGE_WRITE_FAILED');
        try {
          await writeKey('binding', binding);
          await writeSync({ in_flight: false, started_at: null, last_error_code: null,
            last_attempt_at: now(), retry_after: null });
        } catch (error) { return fail('STORAGE_WRITE_FAILED', error); }
        return { ok: true, state: 'registered-pending', binding_id: binding.binding_id };
      });
      await reconcile();
      return result;
    } catch (error) {
      await reconcile();
      return fail('ERROR_FATAL', error);
    } finally {
      busy = false;
    }
  }
  function finishSetup() { return enroll({ repair: true }); }

  // Explicit VAPID rotation: unsubscribe first, subscribe with the new public
  // key, then register against the reviewed generation contract. No automatic
  // rotation is ever attempted from startup or reconciliation.
  async function updateVapid() {
    if (busy) return fail('BUSY');
    busy = true;
    try {
      const vapid = await currentVapid();
      if (!vapid.ok) return fail('VAPID_CONFIG_UNAVAILABLE');
      const identity = identityEvidence();
      if (!identity.verified) return fail('SESSION_UNVERIFIED');
      if (identity.diverged) return fail('SESSION_DIVERGED');
      if (navigator.onLine === false) return fail('OFFLINE');
      const captured = { owner: identity.owner, sessionGeneration: identity.sessionGeneration };
      const result = await withLock(async () => {
        if (sessionChanged(captured)) return fail('SESSION_DIVERGED');
        let registration;
        try { registration = await activeRegistration(); } catch (error) { return fail('SERVICE_WORKER_UNAVAILABLE', error); }
        let existing = null;
        try { existing = await registration.pushManager.getSubscription(); } catch (_) {}
        if (existing) await safeUnsubscribe(existing);
        if (sessionChanged(captured)) return fail('SESSION_DIVERGED');
        return enrollLockedSubscribe(registration, vapid, captured);
      });
      await reconcile();
      return result;
    } catch (error) {
      await reconcile();
      return fail('ERROR_FATAL', error);
    } finally { busy = false; }
  }
  // Shared subscribe/register body used after an explicit rotation unsubscribe.
  async function enrollLockedSubscribe(registration, vapid, captured) {
    let permission = Notification.permission;
    if (permission === 'default') {
      try { permission = await Notification.requestPermission(); } catch (_) { permission = 'denied'; }
    }
    if (permission !== 'granted') return fail(permission === 'denied' ? 'PERMISSION_DENIED' : 'PERMISSION_DISMISSED');
    let subscription;
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: vapid.keyBytes.slice().buffer
      });
    } catch (error) { return fail('SUBSCRIBE_FAILED', error); }
    const valid = validateSubscription(subscription, vapid);
    if (!valid.ok) { await safeUnsubscribe(subscription); return fail(valid.reason); }
    const installation = await ensureInstallation();
    const local = await readLocal();
    const expected = local.binding && local.installation?.id === installation.id ? local.binding.generation : 0;
    const endpointSha256 = await sha256Hex(valid.endpoint);
    if (sessionChanged(captured)) { await safeUnsubscribe(subscription); return fail('SESSION_DIVERGED'); }
    let raw;
    try {
      raw = await window.CapProductionRpc.notificationRegister({
        installationId: installation.id, expectedGeneration: expected,
        endpoint: valid.endpoint, p256dh: window.CapVapidPublic.encodeBase64url(valid.p256dh),
        auth: window.CapVapidPublic.encodeBase64url(valid.auth), vapidKeyVersion: vapid.version,
        browserExpiration: Number.isFinite(subscription.expirationTime) ? new Date(subscription.expirationTime).toISOString() : null
      });
    } catch (error) { return fail('REGISTER_FAILED', error); }
    if (sessionChanged(captured)) return fail('SESSION_DIVERGED');
    const response = responseBinding(raw, installation.id);
    const binding = bindingRecord({ installation_id: installation.id, binding_id: response.binding_id,
      generation: response.generation, schedule_revision: response.schedule_revision, state: response.state,
      vapid_key_version: vapid.version, endpoint_sha256: endpointSha256, updated_at: iso() });
    if (!binding) return fail('STORAGE_WRITE_FAILED');
    await writeKey('binding', binding);
    await writeSync({ in_flight: false, started_at: null, last_error_code: null, last_attempt_at: now(), retry_after: null });
    return { ok: true, state: 'registered-pending', binding_id: binding.binding_id };
  }

  // ---- explicit removal / bounded sign-out --------------------------------
  async function invalidate(binding, deadline) {
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (now() >= deadline) break;
      try {
        const raw = await withDeadline(window.CapProductionRpc.notificationInvalidate({
          bindingId: binding.binding_id, generation: binding.generation,
          scheduleRevision: binding.schedule_revision, disable: true
        }), deadline);
        if (!raw || raw.binding_id !== binding.binding_id ||
            !Number.isSafeInteger(raw.generation) || !Number.isSafeInteger(raw.schedule_revision) ||
            !SERVER_STATES.includes(raw.state)) throw code('INVALIDATE_RESPONSE_INVALID');
        return { ok: true, generation: raw.generation, schedule_revision: raw.schedule_revision, state: raw.state };
      } catch (error) {
        last = error;
        if (attempt === 0 && now() + 250 < deadline) await wait(250);
      }
    }
    return { ok: false, reason: String(last?.code || last?.message || 'INVALIDATE_FAILED') };
  }
  async function removeEnrollment(options) {
    const deadline = now() + (options?.budget ?? 15000);
    let local;
    try { local = await readLocal(); } catch (_) { return fail('STORAGE_UNAVAILABLE'); }
    const registration = await registrationAndSubscription();
    const subscription = registration.subscription;
    let binding = local.binding;
    if (!binding && local.installation) {
      // The server summary is owner-scoped and exposes only identifiers. It is
      // used to finish removal of a server binding whose local copy is missing.
      try {
        const summary = await withDeadline(window.CapProductionRpc.notificationSummary(), deadline);
        const server = summary?.ok ? bindingFromSummary(summary.raw, local.installation.id) : null;
        if (server) binding = { binding_id: server.binding_id, generation: server.generation,
          schedule_revision: server.schedule_revision };
      } catch (_) {}
    }
    if (!binding && !subscription) return { ok: true, state: 'disabled', removed: true };
    let invalidated = { ok: true };
    if (binding) invalidated = await invalidate(binding, deadline);
    // Local unsubscribe happens regardless of server outcome.
    if (subscription) await safeUnsubscribe(subscription);
    if (invalidated.ok) {
      try { await deleteKey('binding'); await clearDisablePending(); }
      catch (_) { return fail('STORAGE_WRITE_FAILED'); }
      lastConflict = false;
      return { ok: true, state: 'disabled', removed: true };
    }
    try { await setDisablePending(binding); } catch (_) {}
    return { ok: false, reason: invalidated.reason || 'INVALIDATE_FAILED', state: 'pending-disable', pending: true };
  }
  async function disable() {
    if (busy) return fail('BUSY');
    busy = true;
    try {
      const identity = identityEvidence();
      if (!identity.verified) return fail('SESSION_UNVERIFIED');
      if (identity.diverged) return fail('SESSION_DIVERGED');
      const captured = { owner: identity.owner, sessionGeneration: identity.sessionGeneration };
      const result = await withLock(async () => {
        if (sessionChanged(captured)) return fail('SESSION_DIVERGED');
        return removeEnrollment({ budget: 15000 });
      });
      await reconcile();
      return result;
    } catch (error) {
      await reconcile();
      return fail('ERROR_FATAL', error);
    } finally { busy = false; }
  }
  // Called at the very start of signOut(), before the session is cleared. The
  // whole hook is bounded to eight seconds; notification cleanup can never
  // block sign-out permanently.
  async function beforeSignOut() {
    const started = now();
    const work = (async () => {
      try {
        const local = await readLocal();
        const rs = await registrationAndSubscription();
        if (!local.binding && !rs.subscription) return { ok: true, state: 'signed-out' };
        let invalidated = { ok: true };
        if (local.binding) invalidated = await invalidate(local.binding, started + SIGN_OUT_BUDGET_MS - 500);
        if (rs.subscription) await safeUnsubscribe(rs.subscription);
        if (local.binding && invalidated.ok) {
          try { await deleteKey('binding'); await clearDisablePending(); } catch (_) {}
        } else if (local.binding) {
          try { await setDisablePending(local.binding); } catch (_) {}
        }
        return { ok: invalidated.ok, state: invalidated.ok ? 'signed-out' : 'pending-disable' };
      } catch (_) { return { ok: false, state: 'pending-disable' }; }
    })();
    const bounded = new Promise(resolve => setTimeout(() => resolve({ ok: false, reason: 'SIGN_OUT_TIMEOUT', state: 'pending-disable' }), SIGN_OUT_BUDGET_MS));
    return Promise.race([work, bounded]);
  }
  // After a newly verified session this may reconcile read-only. It never
  // prompts, subscribes or registers.
  async function onSessionVerified() {
    return reconcile();
  }
  async function retry() { return reconcile(); }

  // ---- settings presentation ----------------------------------------------
  const esc = value => String(value ?? '').replace(/[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function actionFor(state) {
    switch (state) {
      case 'supported-not-enrolled':
      case 'permission-prompt-available':
      case 'permission-granted-no-subscription':
      case 'disabled': return ['Turn on background reminders on this device', 'enable'];
      case 'local-subscription-unregistered':
      case 'stale-local-generation':
      case 'subscription-mismatch':
      case 'server-binding-missing': return ['Finish setup', 'finish-setup'];
      case 'stale-vapid-key': return ['Update this device', 'update'];
      case 'registered-pending': return ['Turn off background reminders', 'disable'];
      case 'pending-disable':
      case 'disabled-server-subscription-live': return ['Finish removal', 'finish-removal'];
      case 'error-retry': return ['Retry', 'retry'];
      default: return null;
    }
  }
  const EXPLAIN = {
    'supported-not-enrolled': 'Background reminders are not set up on this device. This is optional and separate from in-app reminders.',
    'permission-prompt-available': 'Your browser will ask for notification permission only after you choose to turn this on.',
    'permission-granted-no-subscription': 'Browser permission is already allowed, but this device has no background subscription yet.',
    'permission-denied': 'Your browser has blocked notifications. Cap will not ask again; change the site permission yourself if you want background reminders.',
    'local-subscription-unregistered': 'This device already has a browser subscription that is not registered to your account. Finish setup to confirm it.',
    'registered-pending': 'Background reminders are registered for this device. Delivery remains parked until a later sender phase.',
    'stale-local-generation': 'The local registration is out of date. Finish setup will reconcile it with the server.',
    'stale-vapid-key': 'This device uses an older public notification key. Update it explicitly; Cap never rotates it automatically.',
    'subscription-mismatch': 'The browser subscription does not match the saved registration for this device.',
    'server-binding-missing': 'The server has no current registration for this device. Finish setup will re-register it.',
    'subscription-lost': 'The browser subscription is gone. Background reminders will need to be turned on again.',
    'disabled': 'Background reminders are off for this device.',
    'pending-disable': 'Removal did not finish. The browser subscription is already gone; finish removal when you are online.',
    'disabled-server-subscription-live': 'The server registration is disabled but a browser subscription is still live. Finish removal to clear it.',
    'foreign-account-reservation': 'This browser subscription belongs to another account. Cap will not transfer it.',
    'error-retry': 'Background reminder status could not be checked. Retry is read-only and does not enroll automatically.',
    'error-fatal': 'Background reminder status is unavailable on this device.'
  };
  function settingsMarkup() {
    try {
      const vapid = window.CapVapidPublic?.inspect?.(window.CapVapidPublic.current());
      if (!vapid?.ok) return '';
    } catch (_) { return ''; }
    const state = lastState.state;
    if (!lastState.available) return '';
    if (['signed-out', 'unverified-session', 'unsupported-insecure', 'unsupported-browser',
      'ios-install-required', 'storage-unavailable', 'foundation-unavailable', 'session-diverged',
      'error-fatal'].includes(state)) return '';
    const action = actionFor(state);
    return `<div class="st-grp eyebrow">Background reminders</div><div class="st-box cn-bg" data-bg-state="${esc(state)}" role="group" aria-label="Background reminders"><b>${esc(state === 'registered-pending' ? 'Background reminders are on' : 'Background reminders')}</b><p>${esc(EXPLAIN[state] || 'Background reminder status is available on this device.')}</p>${action ? `<button type="button" class="pill cn-bg-action" data-bg-action="${esc(action[1])}" aria-label="${esc(action[0])}" onclick="CapNotificationEnrollment.uiAction('${esc(action[1])}',this)">${esc(action[0])}</button>` : ''}<p class="st-note cn-bg-status" role="status" aria-live="polite"></p></div>`;
  }
  async function uiAction(name, button) {
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    let result;
    try {
      if (name === 'enable') result = await enroll();
      else if (name === 'finish-setup') result = await finishSetup();
      else if (name === 'update') result = await updateVapid();
      else if (name === 'disable' || name === 'finish-removal') result = await disable();
      else if (name === 'retry') result = await retry();
      else result = fail('UNKNOWN_ACTION');
    } catch (error) { result = fail('ERROR_FATAL', error); }
    const message = result?.ok === false
      ? (result.reason === 'PERMISSION_DENIED' ? 'Notifications are blocked in your browser.'
        : result.reason === 'PERMISSION_DISMISSED' ? 'Notification permission was not granted.'
        : result.reason === 'OFFLINE' ? 'Reconnect before changing background reminders.'
        : result.reason === 'SESSION_DIVERGED' ? 'Your account changed. No background reminder change was kept.'
        : result.reason === 'FOREIGN_ACCOUNT_RESERVATION' ? 'This browser subscription belongs to another account.'
        : 'Background reminder change did not complete. Nothing financial was changed.')
      : 'Background reminder status was updated.';
    try { window.toast?.(message, result?.ok !== false); } catch (_) {}
    if (document.querySelector('#sheet.open')) { try { window.CapNotifications?.settings?.(); } catch (_) {} }
    return result;
  }

  // Startup status is read-only. It must never prompt, subscribe, register or
  // invalidate. Reconciliation is repeated after a fresh session verification
  // and after explicit actions only.
  window.CapNotificationEnrollment = Object.freeze({
    STATES, DB_NAME, DB_VERSION, STORE, PROTOCOL, LOCK_NAME,
    INSTALLATION_FIELDS, BINDING_FIELDS, SYNC_FIELDS,
    capabilities, reconcile, onSessionVerified, beforeSignOut,
    enable: enroll, finishSetup, updateVapid, disable, retry, uiAction,
    settingsMarkup, state: () => lastState, evidence: () => lastEvidence,
    status: () => ({ ...lastState }),
    _deriveState: deriveState, _envModel: envModel, _identity: identityEvidence,
    _displayStandalone: displayStandalone,
    _validEndpoint: validEndpoint, _validP256dh: validP256dh, _validAuth: validAuth,
    _validateSubscription: validateSubscription, _sha256Hex: sha256Hex,
    _records: { installationRecord, bindingRecord, syncRecord, EMPTY_SYNC }
  });
  setTimeout(() => { reconcile().catch(() => {}); }, 0);
})();
