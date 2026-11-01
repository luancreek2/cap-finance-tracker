/* Cap service worker — offline app shell.
   Bump VERSION whenever index.html or other shell files change. */
const VERSION = "cap-shell-v377";
const LOCAL_PREVIEW = ['localhost','127.0.0.1','[::1]'].includes(new URL(self.location.origin).hostname);
const CORE = [
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./css/animations.css",
  "./css/brand.css",
  "./css/spending.css",
  "./css/activity-scope.css",
  "./css/calendar-popup.css",
  "./css/offline-auth.css",
  "./css/cloud-sync.css",
  "./css/settings-shell.css",
  "./css/command-bar.css",
  "./css/smart-log.css",
  "./css/financial-search.css",
  "./css/financial-health.css",
  "./css/notifications.css",
  "./js/brand.js",
  "./js/runtime-config.js",
  "./js/vapid-public.js",
  "./supabase-config.js",
  "./js/production-rpc.js",
  "./js/supabase.js",
  "./js/sync.js",
  "./js/cloud-to-local.js",
  "./js/sync-production.js",
  "./js/cloud-bootstrap.js",
  "./js/notes-manual.js",
  "./js/account-carousel.js",
  "./js/account-options.js",
  "./css/account-options.css",
  "./css/account-carousel.css",
  "./js/cards.js",
  "./js/app.js",
  "./js/transactions.js",
  "./js/activity-scope.js",
  "./js/calendar-popup.js",
  "./js/credit.js",
  "./js/animations.js",
  "./js/cap-motion.js",
  "./assets/vendor/animejs/anime.esm.min.js",
  "./js/settings-shell.js",
  "./js/command-bar.js",
  "./js/smart-log-merchants.js",
  "./js/smart-log-parser.js",
  "./js/smart-log.js",
  "./js/financial-search-parser.js",
  "./js/financial-search-engine.js",
  "./js/financial-search.js",
  "./js/financial-health-engine.js",
  "./js/financial-health.js",
  "./js/notification-engine.js",
  "./js/notifications.js",
  "./js/notification-enrollment.js",
  "./js/notification-schedule.js",
  "./js/notification-publisher.js",
  "./js/notification-reminders.js",
  "./js/notification-reminder-ui.js",
];
const MEDIA = [
  "./assets/icons/cap-16.png",
  "./assets/icons/cap-32.png",
  "./assets/icons/cap-48.png",
  "./assets/icons/cap-180.png",
  "./assets/icons/cap-192.png",
  "./assets/icons/cap-512.png",
  "./assets/icons/cap-512-maskable.png",
  "./assets/branding/cap-default.png",
  "./assets/branding/cap-dark.png",
  "./assets/branding/chatgpt.svg",
  "./assets/branding/minecraft.svg",
  "./assets/media/cash-wallet-transparent.png",
  "./assets/media/payment-confirm.mp3",
  "./assets/media/media-01bcd366ea16.webp",
  "./assets/media/media-068255fe1779.png",
  "./assets/media/media-08b3cc0df3e1.webp",
  "./assets/media/media-0fbff12eb8bb.png",
  "./assets/media/media-1a18fbe8f565.webp",
  "./assets/media/media-215edc69b160.png",
  "./assets/media/media-2a6401e1171c.webp",
  "./assets/media/media-3c75ecbaa728.png",
  "./assets/media/media-45199bcfde38.webp",
  "./assets/media/media-50c013ade32c.webp",
  "./assets/media/media-7825d6f52373.webp",
  "./assets/media/media-784db5476c1a.webp",
  "./assets/media/media-7bfe4c0e22b7.png",
  "./assets/media/media-8209b1c7d4fc.webp",
  "./assets/media/media-8f7192d31f1f.png",
  "./assets/media/media-912569743662.webp",
  "./assets/media/media-99bbbeeab150.webp",
  "./assets/media/media-a4e60c549be5.png",
  "./assets/media/media-a76f10d262db.webp",
  "./assets/media/media-b8b19cb7338b.webp",
  "./assets/media/media-bc32baa2d8d0.webp",
  "./assets/media/media-c2a841854f13.webp",
  "./assets/media/media-c556353f406c.png",
  "./assets/media/media-c72d8b39a5da.webp",
  "./assets/media/media-d42b1d2c752f.webp",
  "./assets/media/media-db2cc84b3a80.webp",
  "./assets/media/media-ec2a6f2b4283.png",
  "./assets/media/media-f094ad645fc2.webp",
  "./assets/media/media-fb3475fba90a.webp",
];
const APP = "./index.html";
// The payment chime is fetched by code (not an <audio> element), so match it by path
// to serve it from cache when the app is offline.
const SOUND = ["./assets/media/payment-confirm.mp3"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      if (LOCAL_PREVIEW) { await self.skipWaiting(); return; }
      const c = await caches.open(VERSION);
      // Core files must cache or the separated app cannot boot offline; media is best-effort.
      await Promise.all(CORE.map((u) => c.add(new Request(u, { cache: "reload" }))));
      await Promise.allSettled(MEDIA.map((u) => c.add(new Request(u, { cache: "reload" }))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("cap-shell-") && (LOCAL_PREVIEW || k !== VERSION)).map((k) => caches.delete(k)));
      if (LOCAL_PREVIEW) { await self.registration.unregister(); return; }
      await self.clients.claim();
    })(),
  );
});

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));

async function navigate(req) {
  const c = await caches.open(VERSION);
  try {
    // Network first (so updates arrive), but never wait long: offline must be instant-ish.
    const res = await Promise.race([fetch(req), timeout(3000)]);
    if (res && res.ok) {
      c.put(APP, res.clone());
      return res;
    }
    throw new Error("bad response");
  } catch (_) {
    return (await c.match(APP, { ignoreSearch: true })) || (await c.match(req, { ignoreSearch: true })) || Response.error();
  }
}

async function swr(req) {
  const c = await caches.open(VERSION);
  const hit = await c.match(req, { ignoreSearch: true });
  const net = fetch(req)
    .then((res) => {
      if (res && res.ok && res.type === "basic") c.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return hit || (await net) || Response.error();
}

self.addEventListener("fetch", (e) => {
  if (LOCAL_PREVIEW) return;
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin / API traffic
  if (req.mode === "navigate") e.respondWith(navigate(req));
  else if (["style", "script", "image", "font", "manifest"].includes(req.destination)) e.respondWith(swr(req));
  else if (["audio", "video"].includes(req.destination)) e.respondWith(swr(req));
  else if (SOUND.some((u) => new URL(u, self.location.origin).pathname === url.pathname)) e.respondWith(swr(req));
  // everything else (fetch/XHR data calls) goes straight to the network
});

// Background Sync (Chromium): wake the page(s) so they can push pending changes.
self.addEventListener("sync", (e) => {
  if (e.tag !== "cap-sync") return;
  e.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then((cs) => {
      cs.forEach((c) => c.postMessage({ type: "cap-sync" }));
      if (!cs.length) throw new Error("no client open; retry later"); // makes the browser retry the sync
    }),
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

// Phase 5B.3C: financially blind, default-deny receiver. No enrollment, network,
// scheduling, or storage migration. This does NOT authorize remote activation:
// old open clients do not participate in the delivery-fence contract.
const PUSH_FIELDS = ['protocol', 'type', 'version', 'installation_id', 'binding_id', 'generation', 'expires_at'];
const PUSH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUSH_TAG = 'cap-background-reminder-v1';
const pushExact = (v, fields) => !!v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === fields.length && fields.every(k => Object.prototype.hasOwnProperty.call(v, k));
const pushDate = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
function pushPayload(event) {
  if (!event.data) return null;
  const bytes = event.data.arrayBuffer();
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 512) return null;
  const p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return pushExact(p, PUSH_FIELDS) && p.protocol === 'CAP_PUSH_V1' && p.type === 'reminder' && p.version === 1 &&
    typeof p.installation_id === 'string' && PUSH_UUID.test(p.installation_id) &&
    typeof p.binding_id === 'string' && PUSH_UUID.test(p.binding_id) &&
    Number.isSafeInteger(p.generation) && p.generation > 0 &&
    Number.isSafeInteger(p.expires_at) && p.expires_at > 0 && p.expires_at <= 8640000000000 ? p : null;
}
function pushState() {
  return new Promise((resolve, reject) => {
    let db, tx, finished = false;
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (db) db.close(); error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { if (tx) { try { tx.abort(); } catch (_) {} } finish(Error('NOTIFICATION_STATE_UNAVAILABLE')); }, 3000);
    let request;
    try { request = indexedDB.open('cap-notifications', 1); } catch (e) { finish(e); return; }
    // A fresh/missing store never constitutes enrollment. Abort creation rather
    // than manufacturing notification identities in response to remote input.
    request.onupgradeneeded = () => { request.transaction.abort(); };
    request.onerror = request.onblocked = () => finish(Error('NOTIFICATION_STATE_UNAVAILABLE'));
    request.onsuccess = () => {
      db = request.result;
      if (finished) { db.close(); return; }
      db.onversionchange = () => finish(Error('NOTIFICATION_STATE_CHANGED'));
      try {
        tx = db.transaction('state', 'readonly');
        const result = {}, store = tx.objectStore('state');
        for (const key of ['installation', 'binding', 'delivery-fence:v1']) {
          const q = store.get(key); q.onsuccess = () => { result[key] = q.result; };
        }
        tx.oncomplete = () => finish(null, result);
        tx.onerror = tx.onabort = () => finish(Error('NOTIFICATION_STATE_UNAVAILABLE'));
      } catch (e) { finish(e); }
    };
  });
}
function pushAuthorized(p, state) {
  const i = state.installation, b = state.binding, f = state['delivery-fence:v1'];
  return pushExact(i, ['id', 'created_at', 'protocol']) && i.protocol === 'CAP_PUSH_V1' &&
    typeof i.id === 'string' && PUSH_UUID.test(i.id) && pushDate(i.created_at) &&
    pushExact(b, ['installation_id', 'binding_id', 'generation', 'schedule_revision', 'state', 'vapid_key_version', 'endpoint_sha256', 'updated_at']) &&
    b.state === 'delivery_eligible' && Number.isSafeInteger(b.generation) && b.generation > 0 &&
    Number.isSafeInteger(b.schedule_revision) && b.schedule_revision >= 0 &&
    typeof b.vapid_key_version === 'string' && /^v[1-9][0-9]{0,2}$/.test(b.vapid_key_version) &&
    typeof b.endpoint_sha256 === 'string' && /^[0-9a-f]{64}$/.test(b.endpoint_sha256) && pushDate(b.updated_at) &&
    pushExact(f, ['version', 'enabled', 'installation_id', 'binding_id', 'generation']) && f.version === 1 && f.enabled === true &&
    i.id === p.installation_id && b.installation_id === i.id && f.installation_id === i.id &&
    b.binding_id === p.binding_id && f.binding_id === p.binding_id && b.generation === p.generation && f.generation === p.generation;
}
async function receivePush(event) {
  try {
    const p = pushPayload(event);
    if (!p || Date.now() / 1000 >= p.expires_at || !self.navigator?.locks?.request) return;
    await self.navigator.locks.request('cap-notifications-enrollment', { mode: 'exclusive' }, async () => {
      if (!pushAuthorized(p, await pushState())) return;
      // Coalesce only while an already-visible generic notification exists.
      // No receipt ledger or exactly-once claim: the payload has no occurrence ID.
      if (typeof self.registration.getNotifications === 'function' &&
          (await self.registration.getNotifications({ tag: PUSH_TAG })).length) return;
      if (Date.now() / 1000 >= p.expires_at) return;
      await self.registration.showNotification('Cap reminder', {
        body: 'Open Cap to review your reminders.', tag: PUSH_TAG, renotify: false,
        icon: new URL('assets/icons/cap-192.png', self.registration.scope).href,
        badge: new URL('assets/icons/cap-48.png', self.registration.scope).href,
        data: { type: 'cap-reminder', version: 1 }
      });
    });
  } catch (_) { /* Uncertain input/storage/coordination/presentation: drop. */ }
}
self.addEventListener('push', event => { event.waitUntil(receivePush(event)); });

// Notification taps never execute financial actions or trust a supplied URL.
// Phase 5A safely opens the in-app center, not a payment/deep accounting route.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const scope = new URL(self.registration.scope);
  const target = new URL(scope.href);
  target.searchParams.set("cap-notifications", "1");
  e.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then(async (cs) => {
      const open = cs.find((c) => {try {const u = new URL(c.url);return u.origin === scope.origin && u.pathname.startsWith(scope.pathname);} catch (_) {return false;}});
      if (open) {await open.focus();open.postMessage({type:"cap-notification-open",version:1});return;}
      return self.clients.openWindow(target.href);
    }),
  );
});
