/* ============================================================
   KANBO — saved views: reading and writing (lib/views loads this
   module the first time a view is listed or changed, so the network
   layer stays out of the first download; once it's in, lib/views calls
   it synchronously and every edit shows at once).
   • listSavedViews / fetchScope: adopt_saved_searches() once a session
     (per person; remembered for the browser session), then this
     workspace's views + your personal searches (they follow you); the
     old saved_searches rows too while they may not have moved across
     (0048 not live, or the adoption failed) — "read both".
   • create / update / delete: checked the way the database will check
     them, optimistic (the store changes first; a refusal puts it back),
     with the old table as the fallback for old saved searches.
   • Demo mode: the same, in memory (lib/views DEMO_SAVED_VIEWS).
   ============================================================ */
import type { SavedView, SavedViewFailure, SavedViewInput, SavedViewPatch, SavedViewQuery } from "../../data/types";
import { supabase } from "../supabase";
import { parseSavedView, savedViewFailure, SAVED_VIEW_LIMITS } from "../viewRows";
import { __viewsStore as store, SAVED_VIEW_COLUMNS, orderViews, viewInScope } from "../views";

const S = store.S;
const nowIso = () => new Date().toISOString();

/** Who is signed in (the session's user; the store's owner as a fallback). */
async function authUid(): Promise<string> {
  if (!supabase) return S.owner ?? "m-self";
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? S.owner ?? "";
  } catch { return S.owner ?? ""; }
}

/* ---------- old saved searches ---------- */

const ADOPTED_KEY = (uid: string) => `kanbo-views-adopted:${uid}`;

/** rpc adopt_saved_searches (old saved searches → views); how many moved. */
export async function adoptLegacySavedSearches(): Promise<number> {
  if (!supabase) return 0;
  const { data, error } = await supabase.rpc("adopt_saved_searches");
  if (error) throw error;
  return typeof data === "number" ? data : Number(data) || 0;
}

/** Once per session (per person): true when the old rows are known to be across. */
function adoptOnce(uid: string): Promise<boolean> {
  if (S.adoption && S.adoption.uid === uid) return S.adoption.done;
  let already = false;
  try { already = sessionStorage.getItem(ADOPTED_KEY(uid)) === "1"; } catch { /* private mode */ }
  const done = already ? Promise.resolve(true) : adoptLegacySavedSearches().then(
    () => { try { sessionStorage.setItem(ADOPTED_KEY(uid), "1"); } catch { /* private mode */ } return true; },
    () => false,
  );
  S.adoption = { uid, done };
  return done;
}

interface LegacyRow { id: string; name: string; query: unknown; created_at?: string }
/** An old saved_searches row, shown as a (personal, pinned) search view. */
function legacyView(r: LegacyRow, uid: string, i: number): SavedView | null {
  if (!r || typeof r.id !== "string" || typeof r.name !== "string" || !r.name.trim()) return null;
  return parseSavedView({
    id: r.id, user_id: uid, workspace_id: null, name: r.name.slice(0, SAVED_VIEW_LIMITS.name), emoji: null, kind: "search",
    query: { v: 1, filters: r.query && typeof r.query === "object" ? r.query : {} },
    pinned: true, position: -100000 + i, shared: false, created_at: r.created_at ?? "", updated_at: r.created_at ?? "",
  });
}

async function readLegacy(uid: string): Promise<SavedView[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("saved_searches").select("id,name,query,created_at").order("created_at", { ascending: true }).limit(200);
  if (error) throw error;
  return ((data as LegacyRow[] | null) ?? []).map((r, i) => legacyView(r, uid, i)).filter((v): v is SavedView => !!v);
}

/** Only a uuid-ish id may go into a PostgREST filter string. */
const safeId = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id);

/** What went wrong with a load or a save (lib/viewRows savedViewFailure). */
export const failureOf = (e: unknown): SavedViewFailure => savedViewFailure(e);

/* ---------- reading ---------- */

/** A scope's views from the server (or demo memory): saved_views, + the old table while it may still hold some. */
export async function fetchScope(workspaceId: string | null): Promise<{ views: SavedView[]; legacyIds: Set<string> }> {
  if (!supabase) {
    store.seedDemo();
    return { views: [...S.byId.values()].filter((v) => viewInScope(v, workspaceId) && store.demoVisible(v)), legacyIds: new Set() };
  }
  if (workspaceId !== null && !safeId(workspaceId)) return { views: [], legacyIds: new Set() };
  const uid = await authUid();
  const adopted = await adoptOnce(uid);
  let views: SavedView[] = [];
  let unavailable = false;
  try {
    let q = supabase.from("saved_views").select(SAVED_VIEW_COLUMNS);
    q = workspaceId === null ? q.is("workspace_id", null) : q.or(`workspace_id.eq.${workspaceId},and(workspace_id.is.null,kind.eq.search)`);
    const { data, error } = await q.order("position", { ascending: true, nullsFirst: false }).order("created_at", { ascending: true }).limit(400);
    if (error) throw error;
    views = ((data as unknown[] | null) ?? []).map(parseSavedView).filter((v): v is SavedView => !!v);
  } catch (e) {
    if (savedViewFailure(e) !== "unavailable") throw e;
    unavailable = true;
  }
  let legacy: SavedView[] = [];
  if (unavailable || !adopted) {
    try { legacy = await readLegacy(uid); }
    catch (e) { if (unavailable) throw e; }
  }
  const seen = new Set(views.map((v) => v.id));
  const fromLegacy = legacy.filter((v) => !seen.has(v.id) && viewInScope(v, workspaceId));
  return { views: [...views, ...fromLegacy], legacyIds: new Set(fromLegacy.map((v) => v.id)) };
}

/** Replace a scope's views with what the server returned (keeping values that are being written). */
export function mergeScope(ws: string | null, rows: SavedView[], legacyIds: Set<string>): void {
  const incoming = new Map(rows.map((v) => [v.id, v]));
  for (const [id, v] of S.byId) {
    if (viewInScope(v, ws) && !incoming.has(id) && !S.writes.get(id)) { S.byId.delete(id); S.legacy.delete(id); }
  }
  for (const v of rows) {
    if (S.writes.get(v.id)) continue;
    S.byId.set(v.id, v);
    if (legacyIds.has(v.id)) S.legacy.add(v.id); else S.legacy.delete(v.id);
  }
  store.emit();
}

/** Your views + the workspace's shared ones (workspaceId null: Personal's). Adopts old saved searches once. */
export async function listSavedViews(workspaceId: string | null): Promise<SavedView[]> {
  const { views, legacyIds } = await fetchScope(workspaceId);
  mergeScope(workspaceId, views, legacyIds);
  return orderViews(views);
}

/** Realtime: any change to saved_views you may see (RLS decides; a DELETE carries only the id, so it means "look again"). */
let channelSeq = 0;
export function subscribeSavedViews(workspaceId: string | null, onChange: () => void): () => void {
  const client = supabase;
  if (!client) return () => undefined;
  let off = false;
  const fire = () => { if (!off) onChange(); };
  const ch = client.channel(`saved-views-${workspaceId ?? "personal"}-${++channelSeq}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "saved_views" }, fire)
    .subscribe();
  return () => { off = true; void client.removeChannel(ch); };
}

/* ---------- writing ---------- */

const bytes = (v: unknown): number => {
  const s = JSON.stringify(v) ?? "";
  try { return new TextEncoder().encode(s).length; } catch { return s.length * 2; }
};

/** Tidy and check an input the way the database will (so a bad one fails here, not on the server). */
function validate(name: string | undefined, emoji: string | null | undefined, query: SavedViewQuery | undefined): void {
  if (name !== undefined) {
    const n = name.trim();
    if (!n || n.length > SAVED_VIEW_LIMITS.name) throw new Error("invalid saved_views_shape: name");
  }
  if (emoji && [...emoji].length > SAVED_VIEW_LIMITS.emoji) throw new Error("invalid saved_views_shape: emoji");
  if (query !== undefined && bytes(query) > SAVED_VIEW_LIMITS.queryBytes - 192) throw new Error("invalid saved_views_shape: query too big");
}

const touch = (id: string, d: 1 | -1) => {
  const n = (S.writes.get(id) ?? 0) + d;
  if (n > 0) S.writes.set(id, n); else S.writes.delete(id);
};

/** The next position: after every view in that scope. */
function nextPosition(ws: string | null): number {
  let max = 0;
  for (const v of S.byId.values()) if (viewInScope(v, ws) && v.position != null && v.position > max) max = v.position;
  return Math.floor(max / 1024) * 1024 + 1024;
}

export async function createSavedView(input: SavedViewInput): Promise<SavedView> {
  validate(input.name, input.emoji, input.query);
  const ws = input.workspaceId ?? null;
  const shared = !!input.shared && ws !== null;
  const base = {
    workspaceId: ws, name: input.name.trim(), emoji: input.emoji || null, kind: input.kind, query: { ...input.query, v: 1 as const },
    pinned: input.pinned ?? true, position: input.position ?? nextPosition(ws), shared,
  };
  if (!supabase) {
    store.seedDemo();
    const at = nowIso();
    const view: SavedView = { id: `sv-${Date.now().toString(36)}-${++S.demoSeq}`, userId: S.owner ?? "m-self", ...base, createdAt: at, updatedAt: at };
    S.byId.set(view.id, view);
    store.emit();
    return view;
  }
  const uid = await authUid();
  const row = { user_id: uid, workspace_id: ws, name: base.name, emoji: base.emoji, kind: base.kind, query: base.query, pinned: base.pinned, position: base.position, shared };
  const { data, error } = await supabase.from("saved_views").insert(row).select(SAVED_VIEW_COLUMNS).single();
  if (error) {
    if (savedViewFailure(error) !== "unavailable") throw error;
    // 0048 isn't live yet: keep it as an old saved search (its filters), which adopts across later
    const old = await supabase.from("saved_searches").insert({ user_id: uid, name: base.name, query: base.query.filters ?? {} }).select("id,name,query,created_at").single();
    if (old.error) throw old.error;
    const v = legacyView(old.data as LegacyRow, uid, 0);
    if (!v) throw new Error("not found");
    S.byId.set(v.id, { ...v, position: base.position }); S.legacy.add(v.id);
    store.emit();
    return v;
  }
  const view = parseSavedView(data);
  if (!view) throw new Error("not found");
  S.byId.set(view.id, view);
  store.emit();
  return view;
}

/** Only these change on an old saved search (the rest needs 0048). */
const LEGACY_FIELDS: readonly (keyof SavedViewPatch)[] = ["name", "position"];

export async function updateSavedView(id: string, patch: SavedViewPatch): Promise<SavedView> {
  validate(patch.name, patch.emoji, patch.query);
  if (!supabase) store.seedDemo();
  const prev = S.byId.get(id);
  if (!prev && !supabase) throw new Error("not found");
  const clean: SavedViewPatch = { ...patch };
  if (clean.name !== undefined) clean.name = clean.name.trim();
  if (clean.query) clean.query = { ...clean.query, v: 1 };
  if (clean.shared && prev && prev.workspaceId === null) clean.shared = false;
  const optimistic: SavedView | null = prev ? { ...prev, ...clean, updatedAt: nowIso() } : null;
  if (optimistic) { S.byId.set(id, optimistic); store.emit(); }
  if (!supabase) return optimistic!;
  touch(id, 1);
  try {
    if (S.legacy.has(id)) {
      const keys = Object.keys(clean) as (keyof SavedViewPatch)[];
      if (keys.some((k) => !LEGACY_FIELDS.includes(k))) throw new Error('relation "public.saved_views" does not exist');
      if (clean.name !== undefined) {
        const { error } = await supabase.from("saved_searches").update({ name: clean.name }).eq("id", id);
        if (error) throw error;
      }
      if (!optimistic) throw new Error("not found");
      return optimistic;
    }
    const row: Record<string, unknown> = {};
    if (clean.name !== undefined) row.name = clean.name;
    if (clean.emoji !== undefined) row.emoji = clean.emoji || null;
    if (clean.query !== undefined) row.query = clean.query;
    if (clean.pinned !== undefined) row.pinned = clean.pinned;
    if (clean.position !== undefined) row.position = clean.position;
    if (clean.shared !== undefined) row.shared = clean.shared;
    const { data, error } = await supabase.from("saved_views").update(row).eq("id", id).select(SAVED_VIEW_COLUMNS).single();
    if (error) throw error;
    const view = parseSavedView(data);
    if (!view) throw new Error("not found");
    // the last write in flight takes the server's row (an earlier one would undo a later edit)
    if ((S.writes.get(id) ?? 0) <= 1 && S.byId.has(id)) { S.byId.set(id, view); store.emit(); }
    return view;
  } catch (e) {
    if (prev && S.byId.get(id) === optimistic) { S.byId.set(id, prev); store.emit(); }
    throw e;
  } finally {
    touch(id, -1);
  }
}

export async function deleteSavedView(id: string): Promise<void> {
  if (!supabase) store.seedDemo();
  const prev = S.byId.get(id);
  const wasLegacy = S.legacy.has(id);
  S.byId.delete(id); S.pendingDelete.delete(id);
  store.emit();
  if (!supabase) return;
  try {
    const { error } = await supabase.from(wasLegacy ? "saved_searches" : "saved_views").delete().eq("id", id);
    if (error) throw error;
    S.legacy.delete(id);
  } catch (e) {
    if (prev && !S.byId.has(id)) { S.byId.set(id, prev); store.emit(); }
    throw e;
  }
}

/* ---------- staged deletes; your order and hiding ---------- */

/** Hide a view now and delete it when `commit` runs (an Undo toast's expiry); `undo` brings it back. */
export function stageDeleteSavedView(id: string): { undo: () => void; commit: () => Promise<void> } {
  S.pendingDelete.add(id);
  store.emit();
  let settled = false;
  return {
    undo: () => { if (settled) return; settled = true; S.pendingDelete.delete(id); store.emit(); },
    commit: () => {
      if (settled) return Promise.resolve();
      settled = true;
      return deleteSavedView(id).catch((e: unknown) => { S.pendingDelete.delete(id); store.emit(); throw e; });
    },
  };
}

function savePrefs(p: { order: string[]; hidden: string[] }): void {
  S.prefs = p;
  const uid = S.owner ?? "anon";
  const put = (k: string, list: string[]) => { try { localStorage.setItem(k, JSON.stringify(list.slice(0, 600))); } catch { /* private mode */ } };
  put(`kanbo-views-order:${uid}`, p.order);
  put(`kanbo-views-hidden:${uid}`, p.hidden);
  store.emit();
}

/** Hide a pinned view from your own sidebar (or show it again). Only you see the difference. */
export function setViewHidden(id: string, hidden: boolean): void {
  const p = store.prefs();
  if (p.hidden.includes(id) === hidden) return;
  savePrefs({ ...p, hidden: hidden ? [...p.hidden, id] : p.hidden.filter((x) => x !== id) });
}

/** Your own views' positions in this order (shared ones you don't own: per-viewer order, local). */
export async function reorderSavedViews(ids: string[]): Promise<void> {
  const p = store.prefs();
  savePrefs({ ...p, order: [...ids, ...p.order.filter((id) => !ids.includes(id))] });
  const writes: Promise<unknown>[] = [];
  ids.forEach((id, i) => {
    const v = S.byId.get(id);
    const pos = (i + 1) * 1024;
    if (!v || v.position === pos || (S.owner && v.userId !== S.owner)) return;
    if (S.legacy.has(id)) { S.byId.set(id, { ...v, position: pos }); return; }
    writes.push(updateSavedView(id, { position: pos }));
  });
  store.emit();
  await Promise.all(writes);
}
