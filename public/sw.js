/* ============================================================
   KANBO — service worker. Conservative by design:
   - navigations (HTML): network-first, so a new deploy is always picked
     up immediately; the cached shell is only used as an offline fallback.
   - static same-origin assets (Vite hashes them, so they're immutable):
     stale-while-revalidate for instant loads.
   - cross-origin (Supabase API, fonts CDN, etc.): never intercepted.
   Bump CACHE to invalidate.
   ============================================================ */
const CACHE = "kanbo-v1";
const SHELL = ["/", "/favicon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // leave API / cross-origin alone

  if (req.mode === "navigate") {
    // network-first: always try fresh HTML, fall back to cached shell offline
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/", copy)); return res; })
        .catch(() => caches.match("/").then((r) => r || caches.match(req))),
    );
    return;
  }

  // static assets: stale-while-revalidate
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => { if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
