// @vitest-environment node
/* public/sw.js caching: the build's hashed files are cache-first (and never
   stored when the host answers with the app's HTML instead), other static files
   stale-while-revalidate, navigations fall back to the cached shell offline, and
   installing keeps the shell's own files so the offline shell can start. */
import { describe, expect, it, vi } from "vitest";
import swSrc from "../../public/sw.js?raw";

const O = "https://www.kanbo.co.uk";
type Res = { status: number; ok: boolean; type: string; headers: { get: (k: string) => string | null }; body: string; clone: () => Res; text: () => Promise<string> };
const res = (body: string, o: { status?: number; type?: string; ct?: string } = {}): Res => {
  const status = o.status ?? 200;
  const r: Res = {
    status, ok: status >= 200 && status < 300, type: o.type ?? "basic", body,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? o.ct ?? "application/javascript" : null) },
    clone: () => res(body, o), text: async () => body,
  };
  return r;
};
const html = (body: string) => res(body, { ct: "text/html; charset=utf-8" });
const urlOf = (r: string | { url: string }) => new URL(typeof r === "string" ? r : r.url, O).href;

function boot(opts: { cached?: Record<string, Res>; network?: (url: string) => Res | Promise<Res> } = {}) {
  const store = new Map<string, Res>(Object.entries(opts.cached ?? {}).map(([p, r]) => [O + p, r]));
  const cache = {
    store,
    match: async (r: string | { url: string }) => store.get(urlOf(r))?.clone(),
    put: async (r: string | { url: string }, v: Res) => { store.set(urlOf(r), v); },
    addAll: async (paths: string[]) => { for (const p of paths) { const v = await network(O + p); if (v.ok) store.set(O + p, v); } },
    keys: async () => [...store.keys()].map((url) => ({ url })),
    delete: async (r: { url: string }) => store.delete(r.url),
  };
  const caches = { open: async () => cache, match: cache.match, keys: async () => ["kanbo-v1"], delete: async () => true };
  const fetched: string[] = [];
  const network = vi.fn(async (r: string | { url: string }) => {
    const url = urlOf(r);
    fetched.push(url.replace(O, ""));
    if (!opts.network) throw new TypeError("offline");
    return opts.network(url.replace(O, ""));
  });
  const listeners: Record<string, (e: unknown) => void> = {};
  const self = { addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; }, location: { origin: O, search: "" }, skipWaiting: () => {}, clients: { claim: () => {} } };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("self", "caches", "fetch", swSrc)(self, caches, network);
  /** a GET for `path` through the worker: what it answered (or undefined when it left it alone) */
  const get = async (path: string, mode = "no-cors") => {
    let answer: Promise<Res> | undefined;
    const waits: Promise<unknown>[] = [];
    listeners.fetch({ request: { url: /^https?:/.test(path) ? path : O + path, method: "GET", mode }, respondWith: (p: Promise<Res>) => { answer = p; }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    const out = answer ? await answer.catch((e) => e) : undefined;
    await Promise.all(waits);
    await new Promise((r) => setTimeout(r, 0)); // a stale-while-revalidate refresh settles
    return out as Res | Error | undefined;
  };
  const install = async () => {
    const waits: Promise<unknown>[] = [];
    listeners.install({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  return { get, install, store, fetched, network };
}

describe("sw.js: the build's hashed files (/assets/*)", () => {
  it("are served from the cache without asking the network", async () => {
    const sw = boot({ cached: { "/assets/App-abc12345.js": res("app code") }, network: () => res("NEW") });
    expect(((await sw.get("/assets/App-abc12345.js")) as Res).body).toBe("app code");
    expect(sw.fetched).toEqual([]);
  });

  it("are fetched once, then kept", async () => {
    const sw = boot({ network: () => res("inbox code") });
    expect(((await sw.get("/assets/InboxView-Q1w2E3r4.js")) as Res).body).toBe("inbox code");
    expect(sw.store.has(`${O}/assets/InboxView-Q1w2E3r4.js`)).toBe(true);
    await sw.get("/assets/InboxView-Q1w2E3r4.js");
    expect(sw.fetched).toEqual(["/assets/InboxView-Q1w2E3r4.js"]);
  });

  it("never keep the app's HTML that the host sends for a file that's gone (an old tab after a deploy)", async () => {
    const sw = boot({ network: () => html('<div id="root"></div>') });
    const out = (await sw.get("/assets/Old-zzzzzzzz.js")) as Res;
    expect(out.headers.get("content-type")).toContain("text/html"); // passed on: the page's own recovery takes it from there
    expect(sw.store.has(`${O}/assets/Old-zzzzzzzz.js`)).toBe(false);
  });

  it("never serve an HTML page kept in a file's place (by an older worker): fetch the file instead", async () => {
    const sw = boot({ cached: { "/assets/App-abc12345.js": html("<html>") }, network: () => res("app code") });
    expect(((await sw.get("/assets/App-abc12345.js")) as Res).body).toBe("app code");
    expect(sw.store.get(`${O}/assets/App-abc12345.js`)!.body).toBe("app code");
  });

  it("never keep an error, and a miss while offline is a network error", async () => {
    const sw = boot({ network: () => res("nope", { status: 404 }) });
    await sw.get("/assets/Gone-zzzzzzzz.js");
    expect(sw.store.size).toBe(0);
    const offline = boot();
    expect(((await offline.get("/assets/X-12345678.js")) as unknown as Response).type).toBe("error");
  });
});

describe("sw.js: other static files", () => {
  it("are stale-while-revalidate: the cached copy now, a fresh one for next time", async () => {
    const sw = boot({ cached: { "/manifest.webmanifest": res("old", { ct: "application/manifest+json" }) }, network: () => res("new", { ct: "application/manifest+json" }) });
    expect(((await sw.get("/manifest.webmanifest")) as Res).body).toBe("old");
    expect(sw.store.get(`${O}/manifest.webmanifest`)!.body).toBe("new");
  });

  it("never keep an HTML page in a file's place", async () => {
    const sw = boot({ network: () => html("<html>") });
    await sw.get("/missing-icon.png");
    expect(sw.store.size).toBe(0);
  });

  it("leave other origins (the API, fonts) alone", async () => {
    const sw = boot({ network: () => res("x") });
    expect(await sw.get("https://htnchiljplrnjkwimgla.supabase.co/rest/v1/tasks")).toBeUndefined();
    expect(await sw.get("https://fonts.gstatic.com/s/sora/v12/a.woff2")).toBeUndefined();
    expect(sw.fetched).toEqual([]);
  });
});

describe("sw.js: the offline shell", () => {
  it("an offline navigation gets the cached app shell", async () => {
    const sw = boot({ cached: { "/": html('<div id="root"></div>') } });
    const out = (await sw.get("/inbox", "navigate")) as Res;
    expect(out.body).toBe('<div id="root"></div>');
  });

  it("installing keeps the shell's own script, styles and preloads (not an HTML stand-in)", async () => {
    const shell = '<div id="root"></div><script type="module" crossorigin src="/assets/index-AAAA1111.js"></script>'
      + '<link rel="modulepreload" crossorigin href="/assets/react-BBBB2222.js"><link rel="stylesheet" crossorigin href="/assets/index-CCCC3333.css">'
      + '<link rel="icon" href="/favicon.svg">';
    const sw = boot({
      network: (p) => (p === "/" ? html(shell)
        : p === "/assets/react-BBBB2222.js" ? html("<html>") // (a deploy raced the install)
        : p.endsWith(".css") ? res("css", { ct: "text/css" }) : res("js")),
    });
    await sw.install();
    expect(sw.store.has(`${O}/assets/index-AAAA1111.js`)).toBe(true);
    expect(sw.store.has(`${O}/assets/index-CCCC3333.css`)).toBe(true);
    expect(sw.store.has(`${O}/assets/react-BBBB2222.js`)).toBe(false);
  });
});
