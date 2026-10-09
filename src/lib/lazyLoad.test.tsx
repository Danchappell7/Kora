/* lib/lazyLoad: chunks load once (and again after a failure), a loaded chunk's
   component renders without its fallback, a failed screen reloads the page once
   in production, and idle prefetching stays out of the way. */
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import {
  canPrefetchAhead, chunk, chunkReload, lazyComponent, loadAllChunks, prefetch, prefetchWhenIdle, recoverFromChunkError, RETRY_AFTER_MS,
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

describe("loadAllChunks", () => {
  it("loads every chunk declared, including ones a loaded chunk declares", async () => {
    let inner: ReturnType<typeof chunk> | null = null;
    const outer = chunk(async () => { inner = chunk(async () => "inner"); return "outer"; });
    await loadAllChunks();
    expect(outer.loaded).toBe("outer");
    expect(inner!.loaded).toBe("inner");
  });
});
