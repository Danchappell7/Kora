/* ============================================================
   KANBO — code-split loading

   chunk()          a module fetched the first time it's needed (or
                    ahead of time: on hover, on idle). One request per
                    module. A browser never fetches a module again once
                    it has failed in this page (it keeps the failure,
                    under that address, until the page reloads), so a
                    failed load is tried again under a fresh address
                    (the same file, ?kanbo-retry=n) when the browser
                    says which file it was (Chrome, Edge, Firefox).
                    Where it doesn't (Safari), or for a stylesheet,
                    only a page reload can fetch it again.
   lazyComponent()  a component from a chunk. Rendered straight away
                    when the chunk is already in (a prefetched place
                    never flashes its skeleton); otherwise through
                    React.lazy, so the nearest <Suspense> shows one.
   prefetch()       warm chunks without waiting (errors are left for
                    the real load to report).
   prefetchWhenIdle()  warm chunks one per idle moment, in order;
                    never on Data Saver or a 2G connection, and it
                    stops at the first failure (the network is
                    struggling: what's left loads when it's needed).

   A screen whose chunk can't be fetched is nearly always a deploy
   that replaced it (the old hashed file is gone): the page reloads
   once, at the address it was going to (never twice in a minute,
   never offline, never in development) and otherwise the nearest
   error boundary says so. Its Reload tries in place once when the
   file can be asked for again (chunkRetryable), and otherwise
   reloads the page.
   ============================================================ */
import { createElement, lazy, useState, type ComponentType, type LazyExoticComponent } from "react";
import { reportError } from "./monitoring";

export interface Chunk<M = unknown> {
  (): Promise<M>;
  /** the module, once it has loaded */
  readonly loaded: M | null;
}

const registry: Chunk[] = [];

/** The browser's words for a module (script) it couldn't fetch: Chrome and Edge, Firefox, Safari. */
const MODULE_FETCH_FAILED = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;
const RETRY_PARAM = "kanbo-retry";

const errorMessage = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e ?? "");

/** Is this a screen's code (or its stylesheet) that didn't arrive, rather than a bug in it? */
export function isChunkLoadError(e: unknown): boolean {
  return MODULE_FETCH_FAILED.test(errorMessage(e));
}

/** The module file a failed import names (this site's only; our retry mark removed), or null:
 *  Safari doesn't say, and a stylesheet can't be imported again. */
export function chunkUrlOf(e: unknown): string | null {
  const msg = errorMessage(e);
  if (!MODULE_FETCH_FAILED.test(msg) || /Unable to preload CSS/i.test(msg)) return null;
  const raw = /(https?:\/\/[^\s'"<>]+)/.exec(msg)?.[1];
  if (!raw || typeof location === "undefined") return null;
  try {
    const u = new URL(raw.replace(/[.,;)]+$/, ""));
    if (u.origin !== location.origin) return null;
    u.searchParams.delete(RETRY_PARAM);
    return u.href;
  } catch {
    return null;
  }
}

/** Whether a failed screen can be asked for again without reloading the page. */
export const chunkRetryable = (e: unknown): boolean => chunkUrlOf(e) !== null;

/** Import a module file under a fresh address (behind an object so tests can stub it: jsdom can't
 *  import a URL). The same file, so its own imports (React, the shared chunks) are the ones
 *  already loaded. */
export const chunkImport = {
  fresh<M>(url: string, attempt: number): Promise<M> {
    const u = new URL(url);
    u.searchParams.set(RETRY_PARAM, String(attempt));
    return import(/* @vite-ignore */ u.href) as Promise<M>;
  },
};

/** A module loaded on first use. A failed load is tried again on the next call (see the header). */
export function chunk<M>(load: () => Promise<M>): Chunk<M> {
  let pending: Promise<M> | null = null;
  let loaded: M | null = null;
  let failedUrl: string | null = null;   // the file this page now refuses to fetch again
  let attempt = 0;
  const get = (() => {
    pending ??= (failedUrl ? chunkImport.fresh<M>(failedUrl, ++attempt) : load()).then(
      (m) => { loaded = m; failedUrl = null; return m; },
      (e: unknown) => { pending = null; failedUrl = chunkUrlOf(e) ?? failedUrl; throw e; },
    );
    return pending;
  }) as Chunk<M>;
  Object.defineProperty(get, "loaded", { get: () => loaded });
  registry.push(get as Chunk);
  return get;
}

/** Fetch chunks ahead of need. Never throws; a failure is retried by the real load. */
export function prefetch(...chunks: Chunk[]): void {
  for (const c of chunks) if (!c.loaded) c().catch(() => { /* the real load reports it */ });
}

/** Page reload, behind an object so tests can stub it (jsdom can't navigate). */
export const chunkReload = {
  reload(): void { try { window.location.reload(); } catch { /* non-browser */ } },
};
const RELOAD_KEY = "kanbo-chunk-reload";
const RELOAD_GAP_MS = 60_000;

/** A screen's chunk didn't arrive. In production, online, and not already tried in
 *  the last minute: reload (the address already names where they were going) and
 *  never settle, so no error flashes first. Otherwise the error goes to the boundary. */
export function recoverFromChunkError(error: unknown): Promise<never> {
  reportError(error, { op: "chunk-load" });
  if (!import.meta.env.PROD) return Promise.reject(error);
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return Promise.reject(error);
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < RELOAD_GAP_MS) return Promise.reject(error);
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return Promise.reject(error); // storage blocked: no loop guard, so no reload
  }
  chunkReload.reload();
  return new Promise<never>(() => { /* the page is going */ });
}

export type LazyComponent<P> = ComponentType<P> & { chunk: Chunk };

/** How long after a failed load a new mount may try again. React re-renders a suspended
 *  mount the moment its load fails, and that render has to reach the error boundary
 *  (not start another request); a Reload pressed after this tries afresh (chunk() asks
 *  for the file under a fresh address, so the browser really fetches it). */
export const RETRY_AFTER_MS = 500;

/** A component from a chunk (see the header). `pick` names it in the module. */
export function lazyComponent<M, P extends object>(c: Chunk<M>, pick: (m: M) => ComponentType<P>, name = "Lazy"): LazyComponent<P> {
  let failedAt = 0;
  const fresh = (): LazyExoticComponent<ComponentType<P>> => lazy(() => c().then(
    (m) => ({ default: pick(m) }),
    (e: unknown) => { failedAt = Date.now(); return recoverFromChunkError(e); },
  ));
  let Lazy = fresh();
  // React.lazy keeps its failure for good: a mount well after one starts a fresh load
  const current = (): ComponentType<P> => {
    if (failedAt && Date.now() - failedAt >= RETRY_AFTER_MS) { failedAt = 0; Lazy = fresh(); }
    return Lazy as unknown as ComponentType<P>;
  };
  function Loaded(props: P) {
    // decided once per mount, so a chunk landing mid-life never swaps the component (and its state) out
    const [Comp] = useState<ComponentType<P>>(() => (c.loaded !== null ? pick(c.loaded) : current()));
    return createElement(Comp, props);
  }
  Loaded.displayName = `Lazy(${name})`;
  return Object.assign(Loaded, { chunk: c as Chunk });
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};
type Connection = { saveData?: boolean; effectiveType?: string };

/** Whether to fetch anything nobody has asked for yet: not on Data Saver or a 2G connection. */
export function canPrefetchAhead(nav: Navigator | undefined = typeof navigator !== "undefined" ? navigator : undefined): boolean {
  const c = (nav as (Navigator & { connection?: Connection }) | undefined)?.connection;
  if (!c) return true;
  return !c.saveData && !/(^|-)2g$/.test(c.effectiveType ?? "");
}

/** Run `fn` once the browser is idle (a timer where requestIdleCallback is missing: Safari).
 *  Returns a cancel. */
export function whenIdle(fn: () => void, timeout = 2000): () => void {
  if (typeof window === "undefined") return () => {};
  const w = window as IdleWindow;
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(fn, { timeout });
    return () => w.cancelIdleCallback?.(id);
  }
  const t = window.setTimeout(fn, Math.min(timeout, 1200));
  return () => window.clearTimeout(t);
}

/** Warm chunks one after another, each in its own idle slot, so prefetching never
 *  competes with what the person is doing. Stops at the first failure: the network is
 *  struggling, and each failed warm-up is one more file the page has to ask for again.
 *  Returns a cancel. */
export function prefetchWhenIdle(chunks: Chunk[]): () => void {
  if (!canPrefetchAhead()) return () => {};
  const queue = chunks.filter((c, i) => !c.loaded && chunks.indexOf(c) === i);
  let cancel = () => {};
  let stopped = false;
  const next = () => {
    if (stopped) return;
    const c = queue.shift();
    if (!c) return;
    cancel = whenIdle(() => {
      if (stopped) return;
      if (c.loaded) { next(); return; }
      c().then(next, () => { stopped = true; /* the real load reports it, and tries again */ });
    });
  };
  next();
  return () => { stopped = true; cancel(); };
}

/** Tests: load every chunk declared so far (and any those declare), so lazily
 *  loaded screens render as synchronously as they did before code-splitting. */
export async function loadAllChunks(): Promise<void> {
  let seen = -1;
  while (seen !== registry.length) {
    seen = registry.length;
    await Promise.allSettled(registry.map((c) => { try { return c(); } catch (e) { return Promise.reject(e); } }));
  }
}
