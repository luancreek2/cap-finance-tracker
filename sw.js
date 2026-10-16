/* Cap service worker — offline app shell.
   Bump VERSION whenever Cap.html or other shell files change. */
const VERSION = "cap-shell-v2";
const SHELL = [
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
];
const APP = "./index.html";

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(VERSION);
      // The HTML must cache or install fails; icons are best-effort.
      await c.add(new Request(APP, { cache: "reload" }));
      await Promise.allSettled(SHELL.slice(1).map((u) => c.add(new Request(u, { cache: "reload" }))));
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
