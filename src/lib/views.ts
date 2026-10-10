/* ============================================================
   KANBO — saved views (public.saved_views, 0048).
   Any filtered list — My tasks, a project's list or board, a search —
   saved with a name and an emoji, personal or shared with the workspace.
   • Rules (the database enforces them): you read your own and the shared
     ones of your workspaces (guests too, read-only); writers share; you
     edit your own; owners/admins also rename, unpin or delete shared
     ones (they stay their maker's, and only the maker may stop sharing
     one: canShareView). A pinned shared view is pinned for
     everyone; each person may hide one for themselves and order the
     sidebar their own way (per-viewer, localStorage "kanbo-views-order:<userId>"
     and "kanbo-views-hidden:<userId>").
   • Old saved searches move across transparently: listSavedViews calls
     adopt_saved_searches() once per session (same ids; pinned; kind
     "search"), so the sidebar's old "Saved" entries become Views. Until
     0048 is live (or if the adoption fails) both tables are read: the old
     rows show as views that can be renamed, reordered and deleted.
   • Your personal search views follow you into every workspace (a search
     looks everywhere, as the old saved searches did); everything else
     belongs to the workspace it was saved in.
   • One in-memory store behind every reader: useSavedViews (App, the
     Sidebar) re-renders whenever anything changes it — a save from a
     toolbar, an edit in the sidebar, a teammate's change over realtime.
   • Live counts are computed from the tasks the app holds (viewCount,
     in ./savedViews/counts: fetched while the browser is idle), with
     the lists' own predicates (lib/searchQuery for searches; My tasks'
     and a project's own filters for the rest).
   • Demo mode: realistic fake views (DEMO_SAVED_VIEWS), kept in memory.
   For hosts: useSavedViews(workspace, me) → { views, pinned, … } (App,
   once); viewCounts(views, ctx) for the badges (./savedViews/counts,
   loaded when idle); getSavedView(id) to
   apply ?view= / /search/list/:id; viewRoute(view) to open one. The
   mutations (create / update / stageDelete / reorder / setViewHidden)
   are what the Sidebar and the editor call; every reader updates.
   Kept lean (the Sidebar imports it: first download): the network layer
   is lib/savedViews/remote, loaded the first time views are listed or
   changed; after that every call reaches it synchronously.
   ============================================================ */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Role, SavedView, SavedViewFailure, SavedViewInput, SavedViewPatch, SearchFilters, Task } from "../data/types";
import type { Route } from "../app-types";
import { supabase } from "./supabase";
import { chunk } from "./lazyLoad";

export { parseSavedView, parseSavedViewQuery, savedViewFailure, SAVED_VIEW_LIMITS } from "./viewRows";

/** select= for saved_views (every column) */
export const SAVED_VIEW_COLUMNS = "id,workspace_id,user_id,name,emoji,kind,query,pinned,position,shared,created_at,updated_at";

export interface ViewContext {
  tasks: Task[];
  currentUserId: string;
  /** "today" for due-date filters (pin it in tests) */
  today?: Date;
  /** A search view's words read as filters (u2's natural-language parser: "Maya's overdue in Launch").
   *  Without it the words are matched literally, as the old saved searches always were. */
  parseSearchText?: (text: string) => { text: string; filters: SearchFilters };
}

/** "Assigned to whoever is looking": a shared "My work in Launch" view means each viewer's own. */
export const VIEW_ME = "@me";
/** Custom-field filters live in the flat filters record as "cf:<field id>". */
export const VIEW_CUSTOM_PREFIX = "cf:";

/* ============================================================
   the store
   ============================================================ */

interface ScopeState { status: "loading" | "ready" | "error"; error: SavedViewFailure | null; promise: Promise<void> | null; again?: boolean }
interface ViewerPrefs { order: string[]; hidden: string[] }

const S = {
  /** whose views these are: a sign-in as someone else starts afresh */
  owner: null as string | null,
  byId: new Map<string, SavedView>(),
  /** read from the old saved_searches table (0048 not live, or not adopted yet) */
  legacy: new Set<string>(),
  /** hidden while their Undo toast is up */
  pendingDelete: new Set<string>(),
  scopes: new Map<string, ScopeState>(),
  /** writes in flight per id: a refetch never puts back a value that's being changed */
  writes: new Map<string, number>(),
  /** a counter that moves on every create / delete made here; `touched` holds each id's stamp, so a
   *  fetch that began earlier neither drops a view just made nor brings back one just deleted */
  seq: 0,
  touched: new Map<string, number>(),
  prefs: null as ViewerPrefs | null,
  /** adopt_saved_searches, once a session per person (lib/savedViews/remote) */
  adoption: null as { uid: string; done: Promise<boolean> } | null,
  demoSeeded: false,
  demoSeq: 0,
  version: 0,
};
const listeners = new Set<() => void>();
const emit = () => { S.version += 1; listeners.forEach((l) => l()); };
const subscribeStore = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getVersion = () => S.version;

const scopeKey = (ws: string | null) => ws ?? "personal";
/** Does this view show in that workspace's sidebar? (its own, or a personal search that follows you) */
export function viewInScope(v: Pick<SavedView, "workspaceId" | "kind">, ws: string | null): boolean {
  return (v.workspaceId ?? null) === ws || (ws !== null && v.workspaceId === null && v.kind === "search");
}

function clear(): void {
  S.byId.clear(); S.legacy.clear(); S.pendingDelete.clear(); S.scopes.clear(); S.writes.clear(); S.touched.clear();
  S.prefs = null; S.adoption = null; S.demoSeeded = false;
}
/** Start afresh for another person (sign-out / sign-in as someone else). */
function setOwner(uid: string | null): void {
  if (S.owner === uid) return;
  S.owner = uid;
  clear();
}
/** Forget everything (tests; sign-out). */
export function resetSavedViewsForTests(): void {
  S.owner = null; S.demoSeq = 0;
  clear();
  emit();
}

function seedDemo(): void {
  if (S.demoSeeded) return;
  S.demoSeeded = true;
  for (const v of DEMO_SAVED_VIEWS) if (!S.byId.has(v.id)) S.byId.set(v.id, JSON.parse(JSON.stringify(v)) as SavedView);
}
/** In demo mode, only what the server would show: yours, and the shared ones. */
const demoVisible = (v: SavedView) => v.userId === (S.owner ?? "m-self") || v.shared;

/** For lib/savedViews/remote only. */
export const __viewsStore = { S, emit, seedDemo, demoVisible, prefs: () => prefs() };

/* ---------- the network layer, on demand ---------- */

const remote = chunk(() => import("./savedViews/remote"));
type Remote = Awaited<ReturnType<typeof remote>>;
/** Run it now when it's in (so an edit shows in the same tick), else once it arrives. */
function viaRemote<T>(run: (m: Remote) => T | Promise<T>): Promise<T> {
  const m = remote.loaded;
  if (m) { try { return Promise.resolve(run(m)); } catch (e) { return Promise.reject(e); } }
  return remote().then(run);
}

/** Fetch the network layer ahead of need (an idle warm-up; tests). */
export function warmSavedViews(): Promise<void> {
  return remote().then(() => undefined);
}

/** Your views + the workspace's shared ones (workspaceId null: Personal's). Adopts old saved searches once. */
export function listSavedViews(workspaceId: string | null): Promise<SavedView[]> { return viaRemote((m) => m.listSavedViews(workspaceId)); }
export function createSavedView(input: SavedViewInput): Promise<SavedView> { return viaRemote((m) => m.createSavedView(input)); }
export function updateSavedView(id: string, patch: SavedViewPatch): Promise<SavedView> { return viaRemote((m) => m.updateSavedView(id, patch)); }
export function deleteSavedView(id: string): Promise<void> { return viaRemote((m) => m.deleteSavedView(id)); }
/** rpc adopt_saved_searches (old saved searches → views); how many moved. */
export function adoptLegacySavedSearches(): Promise<number> { return viaRemote((m) => m.adoptLegacySavedSearches()); }
/** Realtime: a view in this scope changed. Returns unsubscribe. */
export function subscribeSavedViews(workspaceId: string | null, onChange: () => void): () => void {
  if (!supabase) return () => undefined;
  if (remote.loaded) return remote.loaded.subscribeSavedViews(workspaceId, onChange);
  let off: (() => void) | null = null;
  let gone = false;
  remote().then((m) => { if (!gone) off = m.subscribeSavedViews(workspaceId, onChange); }, () => undefined);
  return () => { gone = true; off?.(); };
}

/** Hide a view now and delete it when `commit` runs (an Undo toast's expiry); `undo` brings it back. */
export function stageDeleteSavedView(id: string): { undo: () => void; commit: () => Promise<void> } {
  if (remote.loaded) return remote.loaded.stageDeleteSavedView(id);
  const staged = remote().then((m) => m.stageDeleteSavedView(id));
  return { undo: () => { staged.then((x) => x.undo(), () => undefined); }, commit: () => staged.then((x) => x.commit()) };
}
/** Hide a pinned view from your own sidebar (or show it again). Only you see the difference. */
export function setViewHidden(id: string, hidden: boolean): void {
  viaRemote((m) => m.setViewHidden(id, hidden)).catch(() => undefined);
}
/** Your own views' positions in this order (shared ones you don't own: per-viewer order, local). */
export function reorderSavedViews(ids: string[]): Promise<void> { return viaRemote((m) => m.reorderSavedViews(ids)); }

/* ---------- per-viewer order and hiding (this device) ---------- */

const readList = (k: string): string[] => {
  try { const v = JSON.parse(localStorage.getItem(k) || "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }
  catch { return []; }
};
function prefs(): ViewerPrefs {
  const uid = S.owner ?? "anon";
  return (S.prefs ??= { order: readList(`kanbo-views-order:${uid}`), hidden: readList(`kanbo-views-hidden:${uid}`) });
}
/** Your order: the ids you arranged first (in that order), then by position, then by age. */
export function orderViews<T extends Pick<SavedView, "id" | "position" | "createdAt" | "name">>(list: readonly T[], order: readonly string[] = prefs().order): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...list].sort((a, b) =>
    (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)
    || (a.position ?? Infinity) - (b.position ?? Infinity)
    || (a.createdAt || "").localeCompare(b.createdAt || "")
    || a.name.localeCompare(b.name));
}

/* ---------- loading a scope ---------- */

/** Load a scope (once; again on reload / a realtime change — one that lands mid-load runs once more after it).
 *  A reload of a scope that's already on screen is quiet: readers hear about it only if something changed. */
function ensureScope(ws: string | null, force = false): Promise<void> {
  const key = scopeKey(ws);
  const cur = S.scopes.get(key);
  if (cur?.promise) { if (force) cur.again = true; return cur.promise; }
  if (cur && !force && cur.status === "ready") return Promise.resolve();
  const was = { status: cur?.status, error: cur?.error ?? null };
  const state: ScopeState = { status: cur?.status === "ready" ? "ready" : "loading", error: null, promise: null };
  S.scopes.set(key, state);
  const owner = S.owner;
  const since = S.seq;
  const settle = () => {
    state.promise = null;
    if (state.again && S.owner === owner) { state.again = false; void ensureScope(ws, true); }
  };
  state.promise = viaRemote(async (m) => {
    const { views, legacyIds } = await m.fetchScope(ws);
    if (S.owner !== owner) return;
    state.status = "ready"; state.error = null;
    settle();
    const changed = m.mergeScope(ws, views, legacyIds, since);
    if (!changed && (was.status !== "ready" || was.error !== null)) emit();
  }).catch((e: unknown) => {
    if (S.owner !== owner) return;
    // (mapped by the network layer; a failure to load that layer itself reads as offline)
    state.status = cur?.status === "ready" ? "ready" : "error"; state.error = remote.loaded ? remote.loaded.failureOf(e) : "network";
    settle();
    emit();
  });
  if (state.status !== was.status || was.error !== null) emit();
  return state.promise;
}

/** Arriving in a scope: load it — or, when it was loaded on an earlier visit, show that at once and
 *  look again in the background (the realtime channel only listens to the scope on screen, so
 *  teammates' changes made while you were elsewhere arrive this way). Several readers arriving
 *  together share one load. */
function enterScope(ws: string | null): Promise<void> {
  const cur = S.scopes.get(scopeKey(ws));
  if (cur?.promise) return cur.promise;
  return ensureScope(ws, cur?.status === "ready");
}

/* ============================================================
   the hooks
   ============================================================ */

export interface SavedViewsState {
  /** every view you can see here, in your order (a view waiting on its Undo is left out) */
  views: SavedView[];
  /** the Sidebar's Views group: the pinned ones you haven't hidden */
  pinned: SavedView[];
  hiddenIds: ReadonlySet<string>;
  /** old saved searches (0048 not live): rename, reorder and delete only */
  legacyIds: ReadonlySet<string>;
  status: "loading" | "ready" | "error";
  error: SavedViewFailure | null;
  reload: () => void;
}

/** The views of a workspace (null: Personal) for this person, kept live. Every caller shares one store. */
export function useSavedViews(workspaceId: string | null, currentUserId: string, opts: { enabled?: boolean } = {}): SavedViewsState {
  const enabled = opts.enabled !== false && !!currentUserId;
  if (enabled && S.owner !== currentUserId) setOwner(currentUserId);
  const version = useSyncExternalStore(subscribeStore, getVersion, getVersion);
  useEffect(() => {
    if (!enabled) return;
    void enterScope(workspaceId);
    let t = 0;
    const off = subscribeSavedViews(workspaceId, () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => { void ensureScope(workspaceId, true); }, 250);
    });
    // a load that failed offline tries again when the connection is back
    const online = () => { if (S.scopes.get(scopeKey(workspaceId))?.status === "error") void ensureScope(workspaceId, true); };
    window.addEventListener("online", online);
    return () => { window.clearTimeout(t); off(); window.removeEventListener("online", online); };
  }, [enabled, workspaceId, currentUserId]);
  return useMemo(() => {
    const scope = S.scopes.get(scopeKey(workspaceId));
    const p = prefs();
    const hidden = new Set(p.hidden);
    const views = enabled
      ? orderViews([...S.byId.values()].filter((v) => viewInScope(v, workspaceId) && !S.pendingDelete.has(v.id) && (supabase || demoVisible(v))), p.order)
      : [];
    return {
      views,
      pinned: views.filter((v) => v.pinned && !hidden.has(v.id)),
      hiddenIds: hidden,
      legacyIds: new Set(S.legacy),
      status: !enabled ? "ready" : scope?.status ?? "loading",
      error: scope?.error ?? null,
      reload: () => { void ensureScope(workspaceId, true); },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, workspaceId, enabled, currentUserId]);
}

/** The marks as one string: a reader re-renders only when they change, not on every store update. */
const marksKey = () => `${prefs().hidden.join(",")}|${[...S.legacy].join(",")}`;
/** This viewer's hidden views and the old saved searches, kept live (the Sidebar's marks). */
export function useViewerMarks(): { hiddenIds: ReadonlySet<string>; legacyIds: ReadonlySet<string> } {
  const key = useSyncExternalStore(subscribeStore, marksKey, marksKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ hiddenIds: new Set(prefs().hidden), legacyIds: new Set(S.legacy) }), [key]);
}

/** One view by id, from the store (App resolving ?view= / /search/list/:id). */
export function getSavedView(id: string | null | undefined): SavedView | undefined {
  return id ? S.byId.get(id) : undefined;
}
/** Is this an old saved search (0048 not live yet)? */
export function isLegacyView(id: string): boolean {
  return S.legacy.has(id);
}

/* (what a view shows, and its live count, are in ./savedViews/counts: loaded while the browser is idle,
   so the sidebar's badges never hold up the first download) */

/** Where the view opens. My tasks: its tab (Waiting on / Done), or its due focus (a view saved from Due today,
 *  Overdue or Due this week opens there, ?due=, as those lists do). */
export function viewRoute(view: SavedView): Route {
  const q = view.query ?? { v: 1 };
  if (view.kind === "search") return { view: "search", list: view.id };
  if (view.kind === "project") return q.projectId ? { view: "project", projectId: q.projectId, tab: q.viewType ?? "list", savedViewId: view.id } : { view: "projects" };
  if (q.list === "waiting" || q.list === "done") return { view: "tasks", tab: q.list, savedViewId: view.id };
  if (q.list === "today" || q.list === "overdue" || q.list === "week") return { view: "tasks", list: q.list, savedViewId: view.id };
  return { view: "tasks", savedViewId: view.id };
}

/** Is this view the page on screen? */
export function isViewActive(view: Pick<SavedView, "id" | "kind">, route: Route): boolean {
  return view.kind === "search" ? route.view === "search" && route.list === view.id : route.savedViewId === view.id;
}

/** May this person rename / unpin / delete it?  [final] */
export function canEditView(view: Pick<SavedView, "userId" | "shared" | "workspaceId">, me: { userId: string; role: Role | null }): boolean {
  if (view.userId === me.userId) return true;
  return view.shared && view.workspaceId !== null && (me.role === "owner" || me.role === "admin");
}
/** May this person share views here? (writers in a team workspace; never Personal, never guests)  [final] */
export function canShareViews(role: Role | null, workspaceId: string | null): boolean {
  return workspaceId !== null && (role === "owner" || role === "admin" || role === "member");
}
/** May this person share this view, or stop sharing it? Only its maker, where they may share. An owner/admin
 *  may rename, unpin or delete a teammate's shared view, but the database never lets them make it private
 *  (it would then be a row they can't read). */
export function canShareView(view: Pick<SavedView, "userId" | "workspaceId">, me: { userId: string; role: Role | null }): boolean {
  return !!me.userId && view.userId === me.userId && canShareViews(me.role, view.workspaceId);
}

/* ============================================================
   demo mode
   ============================================================ */

const DEMO_AT = "2026-09-21T09:00:00.000Z";
const DEMO_LIST: SavedView[] = [
  { id: "sv-demo-urgent", workspaceId: "ws-foundrise", userId: "m-self", name: "Urgent and mine", emoji: "🔥", kind: "my_tasks",
    query: { v: 1, list: "open", filters: { priority: "urgent" }, groupBy: "due", sort: "due", sortDir: "asc" },
    pinned: true, position: 1024, shared: false, createdAt: DEMO_AT, updatedAt: DEMO_AT },
  { id: "sv-demo-blocked", workspaceId: "ws-foundrise", userId: "m-3", name: "Blocked in the launch", emoji: "🚧", kind: "project",
    query: { v: 1, projectId: "p-launch", viewType: "board", filters: { status: "blocked" }, groupBy: "assignee" },
    pinned: true, position: 2048, shared: true, createdAt: "2026-09-22T14:30:00.000Z", updatedAt: "2026-10-02T10:12:00.000Z" },
  { id: "sv-demo-design", workspaceId: null, userId: "m-self", name: "Design in review", emoji: "🎨", kind: "search",
    query: { v: 1, search: { text: "", filters: {} }, filters: { tag: "design", status: "review" } },
    pinned: true, position: 3072, shared: false, createdAt: "2026-09-24T08:05:00.000Z", updatedAt: "2026-09-24T08:05:00.000Z" },
  { id: "sv-demo-week", workspaceId: "ws-foundrise", userId: "m-self", name: "Due this week", emoji: "📅", kind: "my_tasks",
    query: { v: 1, list: "open", filters: { due: "week" }, groupBy: "due" },
    pinned: false, position: 4096, shared: false, createdAt: "2026-09-25T16:40:00.000Z", updatedAt: "2026-09-25T16:40:00.000Z" },
  { id: "sv-demo-eng", workspaceId: "ws-foundrise", userId: "m-1", name: "Engineering in infra", emoji: "⚙️", kind: "project",
    query: { v: 1, projectId: "p-infra", viewType: "list", filters: { tag: "eng", hideDone: true }, groupBy: "section" },
    pinned: false, position: 5120, shared: true, createdAt: "2026-09-29T11:00:00.000Z", updatedAt: "2026-09-29T11:00:00.000Z" },
];
/** Demo mode's views (Personal + the demo team), built from the demo world in data.ts. */
export const DEMO_SAVED_VIEWS: readonly SavedView[] = Object.freeze(DEMO_LIST);
