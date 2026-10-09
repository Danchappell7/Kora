/* ============================================================
   KANBO — service worker. Conservative by design:
   - navigations (HTML): network-first, so a new deploy is always picked
     up immediately; the cached shell is only used offline (or while the
     server is erroring). Only a healthy app shell is ever cached — a
     transient error page must never become the offline shell. Installing
     also keeps the shell's own files (its script, styles and preloads),
     which the first visit fetched before this worker was there.
   - Vite's build output (/assets/*, every name hashed, so immutable):
     cache-first — a file once fetched is never fetched again, which is
     what makes the app's code-split screens instant (and work offline).
     Each fresh shell prunes hashed /assets/* files that neither it nor
     the previous deploy uses, so the cache holds at most two deploys
     instead of growing forever.
   - other static same-origin files (icons, the manifest, theme-init.js):
     stale-while-revalidate for instant loads.
   - a file is only kept when it's a whole 200 that isn't an HTML page:
     the host answers an unknown path (a chunk an old tab asks for after
     a deploy) with the app's index.html, which must never be stored as
     that file.
   - cross-origin (Supabase API, fonts CDN, etc.): never intercepted.
   - web push (0043): shows each push as a notification; a click focuses an
     open Kanbo window and takes it to the push's link (same origin only),
     or opens one. Registered as /sw.js?push-only=1 by lib/push in a dev
     build: then it does push and nothing else (no caching under Vite).
   Bump CACHE to invalidate.
   ============================================================ */
// (not bumped for push: install adds the new SHELL entries to this same
// cache, and keeping it keeps the previous deploy's chunks for open tabs)
const CACHE = "kanbo-v1";
const SHELL = ["/", "/favicon.svg", "/manifest.webmanifest", "/icon-192.png", "/badge-96.png"];
/** dev registration: push and notification clicks only, never the fetch cache */
const PUSH_ONLY = /[?&]push-only=1(?:&|$)/.test((self.location && self.location.search) || "");

self.addEventListener("install", (e) => {
  self.skipWaiting();
  if (PUSH_ONLY) return;
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}).then(() => warmShell(c)).catch(() => {})));
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

/** A response fit to keep for a file: a whole 200 from this origin, and not an HTML
 *  page standing in for a file that isn't there (see the header). */
function isCacheableAsset(res) {
  return !!res && res.status === 200 && res.type === "basic" &&
    (res.headers.get("content-type") || "").indexOf("text/html") === -1;
}

/** Vite's hashed build output: never changes under the same name. */
function isHashedAsset(url) {
  return url.pathname.indexOf("/assets/") === 0;
}

/** /assets/… paths a shell or a script names (the shell's are absolute; Vite's
 *  lazy-chunk lists inside a script are "assets/…", without the slash). */
function assetPathsIn(text) {
  const out = [];
  const re = /\/?assets\/[\w.-]+\.(?:m?js|css|woff2?|png|svg|jpe?g|webp)/g;
  let m;
  while ((m = re.exec(text))) {
    const path = m[0].charAt(0) === "/" ? m[0] : "/" + m[0];
    if (out.indexOf(path) === -1) out.push(path);
  }
  return out;
}

/** Keep the cached shell's own files: the first visit fetched them before this
 *  worker was installed, and without them the offline shell can't start. */
async function warmShell(cache) {
  const shell = await cache.match("/");
  if (!shell) return 0;
  const paths = assetPathsIn(await shell.text());
  let added = 0;
  await Promise.all(paths.map(async (path) => {
    if (await cache.match(path)) return;
    try {
      const res = await fetch(path);
      if (isCacheableAsset(res)) { await cache.put(path, res); added++; }
    } catch (err) { /* offline: the page fetches it through us next time */ }
  }));
  return added;
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
  if (PUSH_ONLY) return;
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

  // the build's hashed files: cache-first (they never change under the same name)
  if (isHashedAsset(url)) {
    e.respondWith(
      // (a copy kept before this check existed could be the app's HTML: never serve that as a file)
      caches.match(req).catch(() => undefined).then((cached) => (isCacheableAsset(cached) ? cached : fetch(req).then((res) => {
        if (isCacheableAsset(res)) {
          const copy = res.clone();
          const put = caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          try { e.waitUntil(put); } catch (err) { /* the put still runs */ }
        }
        return res;
      }))).catch(() => Response.error()), // offline and not kept: a network error, as without us
    );
    return;
  }

  // other static files: stale-while-revalidate
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => { if (isCacheableAsset(res)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

/* ============================ web push ============================
   Payload (JSON, from supabase/functions/_shared/webpush.ts):
     { title, body, url: "/?task=<id>" (same-origin path), tag?: "task-<id>", kind? }
   Every push shows a notification (the subscription is userVisibleOnly). */

/** A same-origin path to open, from whatever the payload says ("/" when it's anything else). */
function safePath(raw) {
  try {
    if (typeof raw !== "string" || raw.charAt(0) !== "/" || raw.charAt(1) === "/" || raw.charAt(1) === "\\") return "/";
    const u = new URL(raw, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : "/";
  } catch (err) { return "/"; }
}

/** title + options for showNotification, from a push's data (never throws). */
function notificationFor(data) {
  let d = {};
  try { d = data ? data.json() : {}; } catch (err) {
    try { d = { body: data ? data.text() : "" }; } catch (err2) { d = {}; }
  }
  if (!d || typeof d !== "object") d = {};
  const str = (v, max) => (typeof v === "string" ? v : "").replace(/\s+/g, " ").trim().slice(0, max);
  const title = str(d.title, 120) || "Kanbo";
  const tag = str(d.tag, 120);
  const options = {
    body: str(d.body, 300),
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    lang: "en-GB",
    data: { url: safePath(d.url), kind: str(d.kind, 20) },
  };
  // one notification per task: a newer one replaces it, and still alerts
  if (tag) { options.tag = tag; options.renotify = true; }
  return { title, options };
}

self.addEventListener("push", (e) => {
  const n = notificationFor(e.data);
  e.waitUntil(self.registration.showNotification(n.title, n.options));
});

/** Ask an open Kanbo window to route in place (lib/push listenForPushMessages,
 *  mounted by the app, answers on the port). Resolves false when nothing
 *  answers in time (a tab from an older build). */
function askToRoute(client, path, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = (ev) => finish(!!(ev.data && ev.data.ok));
      client.postMessage({ type: "kanbo:navigate", url: path }, [ch.port2]);
    } catch (err) { finish(false); return; }
    setTimeout(() => finish(false), ms);
  });
}

/** Same path and query (the hash doesn't matter). */
function samePage(a, b) {
  try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search; } catch (err) { return false; }
}

async function openFromNotification(path) {
  const origin = self.location.origin;
  const href = new URL(path, origin).href;
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const ours = wins.filter((c) => { try { return new URL(c.url).origin === origin; } catch (err) { return false; } });
  // the window the person was last in, else any Kanbo window
  const target = ours.find((c) => c.focused) || ours.find((c) => c.visibilityState === "visible") || ours[0];
  if (target) {
    try { await target.focus(); } catch (err) { /* focus can be refused; carry on */ }
    if (await askToRoute(target, path, 800)) return;
    // nothing answered: it's already showing that address, so don't reload it
    // (and lose what's on screen); otherwise go there
    if (samePage(target.url, href)) return;
    try { if (target.navigate) { await target.navigate(href); return; } } catch (err) { /* uncontrolled window: open a new one */ }
  }
  if (self.clients.openWindow) await self.clients.openWindow(href);
}

self.addEventListener("notificationclick", (e) => {
  const data = (e.notification && e.notification.data) || {};
  e.notification.close();
  e.waitUntil(openFromNotification(safePath(data.url)));
});

// The browser replaced this device's subscription (keys rotated or expired):
// subscribe again with the same server key. The app saves the new one the
// next time it starts (lib/push refreshPushSubscription); the old endpoint
// answers 404/410 and the server drops it.
self.addEventListener("pushsubscriptionchange", (e) => {
  const old = e.oldSubscription;
  const key = old && old.options && old.options.applicationServerKey;
  if (!key) return;
  e.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .then((wins) => { for (const c of wins) { try { c.postMessage({ type: "kanbo:push-resubscribed" }); } catch (err) { /* ignore */ } } })
      .catch(() => {}),
  );
});
