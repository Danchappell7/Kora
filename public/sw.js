/* ============================================================
   KANBO — service worker. Conservative by design:
   - navigations (HTML): network-first, so a new deploy is always picked
     up immediately; the cached shell is only used offline (or while the
     server is erroring). Only a healthy app shell is ever cached — a
     transient error page must never become the offline shell.
   - static same-origin assets (Vite hashes them, so they're immutable):
     stale-while-revalidate for instant loads. Each fresh shell prunes
     hashed /assets/* files that neither it nor the previous deploy uses,
     so the cache holds at most two deploys instead of growing forever.
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

/** A response worth keeping as the offline shell: a real 200 HTML page of the app. */
function isAppShell(res) {
  return !!res && res.ok && res.status === 200 && res.type === "basic" &&
    (res.headers.get("content-type") || "").indexOf("text/html") !== -1;
}

function offlineShell(req) {
  return caches.match("/").then((r) => r || caches.match(req));
}

/** Hashed asset file names still in use: referenced by one of the shells,
 *  or (transitively) by a JS/CSS asset that is — Vite's lazy chunks are
 *  only named inside the entry script, not in index.html. */
async function liveAssetPaths(cache, assetRequests, shells) {
  const texts = shells.filter(Boolean);
  const live = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const req of assetRequests) {
      const path = new URL(req.url).pathname;
      if (live.has(path)) continue;
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (!name || !texts.some((t) => t.indexOf(name) !== -1)) continue;
      live.add(path);
      grew = true;
      if (/\.(m?js|css)$/.test(name)) {
        const r = await cache.match(req);
        if (r) texts.push(await r.text());
      }
    }
  }
  return live;
}

async function pruneAssets(cache, shells) {
  const keys = await cache.keys();
  const assets = keys.filter((r) => new URL(r.url).pathname.indexOf("/assets/") === 0);
  if (!assets.length) return 0;
  const live = await liveAssetPaths(cache, assets, shells);
  const dead = assets.filter((r) => !live.has(new URL(r.url).pathname));
  await Promise.all(dead.map((r) => cache.delete(r)));
  return dead.length;
}

/** Store a fresh app shell as the offline fallback, then drop assets that
 *  neither it nor the shell it replaces reference (one deploy of grace for
 *  tabs still running the previous bundle). */
async function refreshShell(res) {
  const html = await res.clone().text();
  if (html.indexOf('id="root"') === -1) return; // not the app shell
  const cache = await caches.open(CACHE);
  const prev = await cache.match("/");
  const prevHtml = prev ? await prev.text() : "";
  await cache.put("/", res);
  await pruneAssets(cache, [html, prevHtml]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // leave API / cross-origin alone

  if (req.mode === "navigate") {
    // network-first: always try fresh HTML, fall back to cached shell offline
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (isAppShell(res)) {
            const copy = res.clone();
            try { e.waitUntil(refreshShell(copy).catch(() => {})); } catch (err) { refreshShell(copy).catch(() => {}); }
            return res;
          }
          // the server is having a moment (5xx): the last good shell beats an error page
          if (res.status >= 500) return offlineShell(req).then((r) => r || res);
          return res;
        })
        .catch(() => offlineShell(req).then((r) => r || Response.error())),
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
