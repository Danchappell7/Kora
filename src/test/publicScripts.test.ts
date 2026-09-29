/* The two hand-written scripts in public/ (served as-is, not bundled). */
import { describe, it, expect, beforeEach } from "vitest";
import themeInitSrc from "../../public/theme-init.js?raw";
import swSrc from "../../public/sw.js?raw";
import indexHtml from "../../index.html?raw";

describe("public/theme-init.js", () => {
  const src = themeInitSrc;
  beforeEach(() => {
    localStorage.clear();
    document.head.innerHTML = '<meta name="theme-color" content="#8B5CF6">';
    document.documentElement.removeAttribute("data-theme");
  });
  const meta = () => document.querySelector('meta[name="theme-color"]')!.getAttribute("content");

  it("applies a saved light theme and light browser chrome before paint", () => {
    localStorage.setItem("kanbo-theme", "light");
    new Function(src)();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(meta()).toBe("#f5f6f9");
  });

  it("defaults to dark", () => {
    new Function(src)();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(meta()).toBe("#1b1d24");
  });

  it("keeps the browser chrome in step when the app toggles the theme", async () => {
    localStorage.setItem("kanbo-theme", "light");
    new Function(src)();
    document.documentElement.setAttribute("data-theme", "dark");
    await new Promise((r) => setTimeout(r, 0)); // MutationObserver callbacks are async
    expect(meta()).toBe("#1b1d24");
  });

  it("has no inline-script dependency in index.html (CSP script-src 'self')", () => {
    const html = indexHtml;
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
    expect(inline).toHaveLength(0);
    expect(html).toContain('<script src="/theme-init.js"></script>');
    // the meta must precede the script so the script can find it
    expect(html.indexOf('<meta name="theme-color"')).toBeLessThan(html.indexOf('<script src="/theme-init.js"'));
  });
});

describe("public/sw.js asset pruning", () => {
  type Req = { url: string };
  const O = "https://www.kanbo.co.uk";
  function load() {
    const fakeSelf = { addEventListener: () => {}, location: { origin: O }, skipWaiting: () => {}, clients: { claim: () => {} } };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function("self", "caches", swSrc + "\nreturn { pruneAssets, isAppShell };")(fakeSelf, {}) as {
      pruneAssets: (cache: unknown, shells: string[]) => Promise<number>;
      isAppShell: (res: unknown) => boolean;
    };
  }
  function fakeCache(files: Record<string, string>) {
    const store = new Map(Object.entries(files).map(([p, body]) => [`${O}${p}`, body]));
    return {
      store,
      keys: async (): Promise<Req[]> => [...store.keys()].map((url) => ({ url })),
      match: async (r: Req) => (store.has(r.url) ? { text: async () => store.get(r.url)! } : undefined),
      delete: async (r: Req) => store.delete(r.url),
    };
  }

  it("keeps assets the current or previous shell uses (incl. lazy chunks), drops older deploys", async () => {
    const { pruneAssets } = load();
    const cache = fakeCache({
      "/": "shell",
      "/favicon.svg": "<svg/>",
      "/assets/index-NEW11111.js": 'import("./lazy-LAZY2222.js")',
      "/assets/lazy-LAZY2222.js": "lazy",
      "/assets/index-NEW11111.css": "url(/assets/font-FONT3333.woff2)",
      "/assets/font-FONT3333.woff2": "font",
      "/assets/index-PREV4444.js": "prev",
      "/assets/index-OLD55555.js": "two deploys ago",
      "/assets/lazy-OLD66666.js": "old lazy",
    });
    const current = '<div id="root"></div><script src="/assets/index-NEW11111.js"></script><link href="/assets/index-NEW11111.css">';
    const previous = '<div id="root"></div><script src="/assets/index-PREV4444.js"></script>';
    const dropped = await pruneAssets(cache, [current, previous]);
    expect(dropped).toBe(2);
    expect([...cache.store.keys()].map((k) => k.replace(O, "")).sort()).toEqual([
      "/", "/assets/font-FONT3333.woff2", "/assets/index-NEW11111.css", "/assets/index-NEW11111.js",
      "/assets/index-PREV4444.js", "/assets/lazy-LAZY2222.js", "/favicon.svg",
    ]);
  });

  it("only treats a healthy same-origin HTML response as the offline shell", () => {
    const { isAppShell } = load();
    const res = (status: number, type = "basic", ct = "text/html; charset=utf-8") => ({ ok: status >= 200 && status < 300, status, type, headers: { get: () => ct } });
    expect(isAppShell(res(200))).toBe(true);
    expect(isAppShell(res(502))).toBe(false);
    expect(isAppShell(res(404))).toBe(false);
    expect(isAppShell(res(200, "opaqueredirect"))).toBe(false);
    expect(isAppShell(res(200, "basic", "image/jpeg"))).toBe(false);
  });
});
