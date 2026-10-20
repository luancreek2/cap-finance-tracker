/* Cap service worker — offline app shell.
   Bump VERSION whenever index.html or other shell files change. */
const VERSION = "cap-shell-v290";
const CORE = [
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./css/animations.css",
  "./css/brand.css",
  "./css/spending.css",
  "./css/activity-scope.css",
  "./css/calendar-popup.css",
  "./js/brand.js",
  "./supabase-config.js",
  "./js/supabase.js",
  "./js/sync.js",
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
      await Promise.all(keys.filter((k) => k.startsWith("cap-shell-") && k !== VERSION).map((k) => caches.delete(k)));
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

// Reminder taps: focus an open Cap window instead of opening a duplicate tab.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then((cs) => {
      const open = cs.find((c) => c.url.indexOf(self.location.origin) === 0);
      if (open) return open.focus();
      return self.clients.openWindow(url);
    }),
  );
});
