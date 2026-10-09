/* lib/lazyLoad: chunks load once (and again after a failure, under a fresh address
   the browser will really fetch), a loaded chunk's component renders without its
   fallback, a failed screen reloads the page once in production, and idle
   prefetching stays out of the way (and stops when the network struggles). */
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import {
  canPrefetchAhead, chunk, chunkImport, chunkReload, chunkRetryable, chunkUrlOf, isChunkLoadError, lazyComponent, loadAllChunks, prefetch,
  prefetchWhenIdle, recoverFromChunkError, RETRY_AFTER_MS,
} from "./lazyLoad";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  try { sessionStorage.clear(); } catch { /* ignore */ }
});

const deferred = <T,>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe("chunk", () => {
  it("loads its module once and remembers it", async () => {
    const load = vi.fn(async () => ({ n: 1 }));
    const c = chunk(load);
    expect(c.loaded).toBeNull();
    const [a, b] = await Promise.all([c(), c()]);
    expect(a).toBe(b);
    expect(c.loaded).toEqual({ n: 1 });
    await c();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("tries again after a failed load", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true });
    const c = chunk(load);
    await expect(c()).rejects.toThrow("offline");
    expect(c.loaded).toBeNull();
    await expect(c()).resolves.toEqual({ ok: true });
    expect(load).toHaveBeenCalledTimes(2);
  });

  // what Chrome / Edge and Firefox say when a module file doesn't arrive (Safari names no file)
  const here = (path: string) => `${window.location.origin}${path}`;
  const chromeFail = (path: string) => new TypeError(`Failed to fetch dynamically imported module: ${here(path)}`);
  const firefoxFail = (path: string) => new TypeError(`error loading dynamically imported module: ${here(path)}`);
  const safariFail = () => new TypeError("Importing a module script failed.");

  it("after a fetch failure, asks for the same file under a fresh address (the browser keeps the failure under the old one)", async () => {
    const load = vi.fn().mockRejectedValue(chromeFail("/assets/RecycleBin-abc.js"));
    const fresh = vi.spyOn(chunkImport, "fresh")
      .mockRejectedValueOnce(chromeFail("/assets/RecycleBin-abc.js?kanbo-retry=1"))
      .mockResolvedValueOnce({ RecycleBin: "bin" });
    const c = chunk(load);
    await expect(c()).rejects.toThrow(/Failed to fetch/);
    await expect(c()).rejects.toThrow(/Failed to fetch/);      // still offline: a new address each time
    await expect(c()).resolves.toEqual({ RecycleBin: "bin" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(fresh.mock.calls).toEqual([[here("/assets/RecycleBin-abc.js"), 1], [here("/assets/RecycleBin-abc.js"), 2]]);
    expect(c.loaded).toEqual({ RecycleBin: "bin" });
    await c();
    expect(fresh).toHaveBeenCalledTimes(2);                     // loaded once, kept
  });

  it("a failed idle warm-up doesn't break the screen: its real load fetches the file again", async () => {
    const load = vi.fn().mockRejectedValue(firefoxFail("/src/components/bin/RecycleBin.tsx"));
    const fresh = vi.spyOn(chunkImport, "fresh").mockResolvedValue({ ok: true });
    const c = chunk(load);
    prefetch(c);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await expect(c()).resolves.toEqual({ ok: true });
    expect(fresh).toHaveBeenCalledWith(here("/src/components/bin/RecycleBin.tsx"), 1);
  });

  it("only ever re-imports this site's files; with no file named (Safari) it loads as before", async () => {
    const fresh = vi.spyOn(chunkImport, "fresh").mockResolvedValue({});
    const foreign = chunk(vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module: https://evil.example/x.js")).mockResolvedValueOnce({ a: 1 }));
    await expect(foreign()).rejects.toThrow();
    await expect(foreign()).resolves.toEqual({ a: 1 });
    const safari = chunk(vi.fn().mockRejectedValueOnce(safariFail()).mockResolvedValueOnce({ b: 2 }));
    await expect(safari()).rejects.toThrow();
    await expect(safari()).resolves.toEqual({ b: 2 });
    expect(fresh).not.toHaveBeenCalled();
  });

  it("tells a chunk that didn't arrive from a bug, and whether it can be asked for again in place", () => {
    expect(isChunkLoadError(chromeFail("/assets/a.js"))).toBe(true);
    expect(isChunkLoadError(firefoxFail("/assets/a.js"))).toBe(true);
    expect(isChunkLoadError(safariFail())).toBe(true);
    expect(isChunkLoadError(new Error(`Unable to preload CSS for ${here("/assets/a.css")}`))).toBe(true);
    expect(isChunkLoadError(new TypeError("x is not a function"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(chunkUrlOf(chromeFail("/assets/a.js?kanbo-retry=3"))).toBe(here("/assets/a.js"));
    expect(chunkUrlOf(chromeFail("/src/a.tsx?t=123"))).toBe(here("/src/a.tsx?t=123"));
    expect(chunkRetryable(chromeFail("/assets/a.js"))).toBe(true);
    expect(chunkRetryable(safariFail())).toBe(false);                                         // no file named
    expect(chunkRetryable(new Error(`Unable to preload CSS for ${here("/assets/a.css")}`))).toBe(false); // a stylesheet
    expect(chunkRetryable(new TypeError("Failed to fetch dynamically imported module: https://evil.example/a.js"))).toBe(false);
    expect(chunkRetryable(new TypeError("x is not a function"))).toBe(false);
  });

  it("prefetch never throws, and skips what's already in", async () => {
    const bad = chunk(() => Promise.reject(new Error("nope")));
    const good = vi.fn(async () => ({}));
    const c = chunk(good);
    expect(() => prefetch(bad, c)).not.toThrow();
    await c();
    prefetch(c);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("lazyComponent", () => {
  it("shows the Suspense fallback while its chunk arrives, then the component", async () => {
    const d = deferred<{ Hello: (p: { name: string }) => JSX.Element }>();
    const Hello = lazyComponent(chunk(() => d.promise), (m) => m.Hello, "Hello");
    render(<Suspense fallback={<p>Loading…</p>}><Hello name="Sana" /></Suspense>);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await act(async () => { d.resolve({ Hello: ({ name }) => <p>Hello {name}</p> }); });
    expect(await screen.findByText("Hello Sana")).toBeInTheDocument();
  });

  it("renders straight away (no fallback) once its chunk is in", async () => {
    const c = chunk(async () => ({ Hi: () => <p>Hi</p> }));
    const Hi = lazyComponent(c, (m) => m.Hi);
    await c();
    render(<Suspense fallback={<p>Loading…</p>}><Hi /></Suspense>);
    expect(screen.getByText("Hi")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("a screen whose file failed (even in an idle warm-up) loads on a later mount once the file arrives", async () => {
    const path = "/assets/Bin-xyz.js";
    const load = vi.fn().mockRejectedValue(new TypeError(`Failed to fetch dynamically imported module: ${window.location.origin}${path}`));
    const fresh = vi.spyOn(chunkImport, "fresh")
      .mockRejectedValueOnce(new TypeError(`Failed to fetch dynamically imported module: ${window.location.origin}${path}?kanbo-retry=1`))
      .mockResolvedValueOnce({ Bin: () => <p>Recycle bin</p> });
    const c = chunk<{ Bin: () => JSX.Element }>(load);
    const Bin = lazyComponent(c, (m) => m.Bin, "Bin");
    prefetch(c);                                                   // the warm-up fails (blocked)
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { Component } = await import("react");
    class Boundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      render() { return this.state.failed ? <p>Couldn't load</p> : this.props.children; }
    }
    const first = render(<Boundary><Suspense fallback={null}><Bin /></Suspense></Boundary>);   // still blocked
    expect(await screen.findByText("Couldn't load")).toBeInTheDocument();
    first.unmount();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + RETRY_AFTER_MS);
    render(<Boundary><Suspense fallback={null}><Bin /></Suspense></Boundary>);                  // unblocked: fetched afresh
    expect(await screen.findByText("Recycle bin")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    expect(fresh).toHaveBeenCalledTimes(2);
  });

  it("after a failed load, the next mount tries again", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("chunk gone"))
      .mockResolvedValueOnce({ Ok: () => <p>Back</p> });
    const Ok = lazyComponent(chunk(load), (m: { Ok: () => JSX.Element }) => m.Ok);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { Component } = await import("react");
    class Boundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      render() { return this.state.failed ? <p>Couldn't load</p> : this.props.children; }
    }
    const first = render(<Boundary><Suspense fallback={null}><Ok /></Suspense></Boundary>);
    // React retries a suspended mount as soon as its load fails: that retry reaches the
    // boundary, and doesn't fetch again (no loop of requests)
    expect(await screen.findByText("Couldn't load")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    first.unmount();
    // a mount a moment later (the boundary's Reload) tries afresh
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + RETRY_AFTER_MS);
    render(<Boundary><Suspense fallback={null}><Ok /></Suspense></Boundary>);
    expect(await screen.findByText("Back")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("recoverFromChunkError", () => {
  it("outside production it just reports the failure (no reload)", async () => {
    const reload = vi.spyOn(chunkReload, "reload").mockImplementation(() => {});
    await expect(recoverFromChunkError(new Error("x"))).rejects.toThrow("x");
    expect(reload).not.toHaveBeenCalled();
  });

  it("in production it reloads once — not again within the minute, and never offline", async () => {
    vi.stubEnv("PROD", true);
    const reload = vi.spyOn(chunkReload, "reload").mockImplementation(() => {});
    let settled = false;
    void recoverFromChunkError(new Error("gone")).then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false); // the page is going: no error flashes first
    await expect(recoverFromChunkError(new Error("still gone"))).rejects.toThrow("still gone");
    expect(reload).toHaveBeenCalledTimes(1);

    sessionStorage.clear();
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await expect(recoverFromChunkError(new Error("offline"))).rejects.toThrow("offline");
    expect(reload).toHaveBeenCalledTimes(1);
    online.mockRestore();
  });
});

describe("idle prefetching", () => {
  it("is off on Data Saver and 2G", () => {
    const nav = (connection?: object) => ({ connection } as unknown as Navigator);
    expect(canPrefetchAhead(nav())).toBe(true);
    expect(canPrefetchAhead(nav({ effectiveType: "4g" }))).toBe(true);
    expect(canPrefetchAhead(nav({ saveData: true }))).toBe(false);
    expect(canPrefetchAhead(nav({ effectiveType: "2g" }))).toBe(false);
    expect(canPrefetchAhead(nav({ effectiveType: "slow-2g" }))).toBe(false);
  });

  it("loads one chunk per idle slot, in order, skips repeats and stops when cancelled", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const mk = (name: string) => chunk(async () => { order.push(name); return name; });
    const a = mk("a"), b = mk("b"), c = mk("c");
    const cancel = prefetchWhenIdle([a, b, a, c]);
    expect(order).toEqual([]); // nothing until the browser is idle
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(order).toEqual(["a"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(order).toEqual(["a", "b"]);
    cancel();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(order).toEqual(["a", "b"]);
  });
});

describe("idle prefetching after a failure", () => {
  it("stops at the first failure (the rest load when they're needed)", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const ok = (name: string) => chunk(async () => { order.push(name); return name; });
    const a = ok("a");
    const bad = chunk(async () => { order.push("bad"); throw new TypeError("Importing a module script failed."); });
    const c = ok("c");
    prefetchWhenIdle([a, bad, c]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(order).toEqual(["a", "bad"]);
    expect(c.loaded).toBeNull();
    await expect(c()).resolves.toBe("c");                        // on demand, as normal
  });
});

describe("loadAllChunks", () => {
  it("loads every chunk declared, including ones a loaded chunk declares", async () => {
    let inner: ReturnType<typeof chunk> | null = null;
    const outer = chunk(async () => { inner = chunk(async () => "inner"); return "outer"; });
    await loadAllChunks();
    expect(outer.loaded).toBe("outer");
    expect(inner!.loaded).toBe("inner");
  });
});
