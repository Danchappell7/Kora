/* ============================================================
   KANBO — pure task operations used by the app shell (App.tsx):
   stable ids, sub-task trees, status transitions, recurrence
   clones, per-route filters and workspace restore. Kept free of
   React so they can be unit-tested (taskOps.test.ts).
   ============================================================ */
import type { Task, Status, Workspace, WorkspaceMember, Project } from "../data/types";
import { nextDueDate, toLocalISO, KANBO_TODAY } from "../data/data";
import { reportError } from "./monitoring";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a real UUID (a server-compatible task id). */
export const isTaskId = (id: string | null | undefined): id is string => !!id && UUID_RE.test(id);

/** Stable client-generated task id (a real UUID), so a task keeps the same id
 *  from the moment it appears on screen — edits, sub-tasks and dependencies can
 *  reference it straight away and a replayed insert is idempotent. */
export function newTaskId(): string {
  const c: Crypto | undefined = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 version 4
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Every descendant (sub-task, sub-sub-task…) of the given task ids, parents before children. */
export function descendantsOf(rootIds: string[], all: Task[]): Task[] {
  const byParent = new Map<string, Task[]>();
  for (const t of all) if (t.parentId) { const l = byParent.get(t.parentId); if (l) l.push(t); else byParent.set(t.parentId, [t]); }
  const seen = new Set(rootIds), out: Task[] = [], queue = [...rootIds];
  while (queue.length) {
    for (const c of byParent.get(queue.shift()!) ?? []) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); queue.push(c.id); }
  }
  return out;
}

/** Group rows into levels so every parent is written before its children
 *  (tasks.parent_id is a real foreign key). */
export function parentsFirst(rows: Task[]): Task[][] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const depth = new Map<string, number>();
  const d = (r: Task, guard = 0): number => {
    const known = depth.get(r.id); if (known !== undefined) return known;
    const p = r.parentId && guard < 64 ? byId.get(r.parentId) : undefined;
    const v = p ? d(p, guard + 1) + 1 : 0;
    depth.set(r.id, v); return v;
  };
  const levels: Task[][] = [];
  for (const r of rows) { const v = d(r); (levels[v] ??= []).push(r); }
  return levels.filter(Boolean);
}

/** Run `fn` over items with at most `limit` in flight. Resolves to per-item success. */
export function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<boolean[]> {
  const out: boolean[] = new Array(items.length).fill(false);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { await fn(items[i]); out[i] = true; } catch (e) { reportError(e, { op: "runLimited" }); }
    }
  };
  return Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker)).then(() => out);
}

/** A shared "at most n at once" gate. Unlike runLimited, every caller starts
 *  straight away (so it can be tracked and waited on) and only queues for its
 *  turn — used to keep an import or a duplicated project to a few inserts at a time. */
export interface Limiter { acquire: () => Promise<void>; release: () => void }
export function createLimiter(n: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    acquire: () => new Promise<void>((resolve) => {
      if (active < Math.max(1, n)) { active++; resolve(); } else queue.push(() => { active++; resolve(); });
    }),
    release: () => { active = Math.max(0, active - 1); queue.shift()?.(); },
  };
}

/** Replace an optimistic tmp-* item with the saved row (or drop it when a reload already brought the row in). */
export function swapTmp<T extends { id: string }>(list: T[], tmpId: string, real: T): T[] {
  if (list.some((x) => x.id === real.id)) return list.filter((x) => x.id !== tmpId);
  return list.map((x) => (x.id === tmpId ? real : x));
}

/** Merge a refetched collection with optimistic tmp-* items that are still saving. */
export function keepTmp<T extends { id: string }>(next: T[], cur: T[]): T[] {
  const ids = new Set(next.map((x) => x.id));
  const tmp = cur.filter((x) => x.id.startsWith("tmp-") && !ids.has(x.id));
  return tmp.length ? [...next, ...tmp] : next;
}

/* ---------- reload snapshots that can't be taken at their word ----------
   A reload's project/workspace lists are best-effort on the server (a failed
   query quietly comes back as just Personal), and a reload that started before
   something was created here can't include it. These keep what the rest of the
   snapshot — or our own recent create — still vouches for. */

/** Ids created here that this reload (number `seq`) started too early to see;
 *  forgets entries a newer reload has had a chance to confirm, or that expired. */
export function unseenCreates(recent: Map<string, { seq: number; until: number }>, seq: number, now: number = Date.now()): Set<string> {
  const out = new Set<string>();
  recent.forEach((c, id) => {
    if (c.until < now || seq > c.seq) recent.delete(id);
    else out.add(id);
  });
  return out;
}

/** The project list to show after a reload (optimistic tmp-* rows still saving are kept too). */
export function reloadProjects<P extends Pick<Project, "id">>(snapshot: P[], prev: P[], snapshotTasks: Pick<Task, "projectId">[], justMade: Set<string>): P[] {
  const base = keepTmp(snapshot, prev);
  const have = new Set(base.map((p) => p.id));
  // only Personal came back, yet tasks still point at projects we had: the projects query failed
  const short = snapshot.every((p) => p.id === "p-personal")
    && snapshotTasks.some((t) => t.projectId !== "p-personal" && !have.has(t.projectId) && prev.some((p) => p.id === t.projectId));
  const carry = prev.filter((p) => !have.has(p.id) && (justMade.has(p.id) || short));
  return carry.length ? [...base, ...carry] : base;
}

/** The workspace list (and members) to show after a reload. */
export function reloadWorkspaces(snapshot: Workspace[], prev: Workspace[], members: WorkspaceMember[], prevMembers: WorkspaceMember[], me: string, justMade: Set<string>): { workspaces: Workspace[]; members: WorkspaceMember[] } {
  const have = new Set(snapshot.map((w) => w.id));
  // I'm an active member of a workspace the list left out: the workspaces query failed
  const vouched = new Set(members.filter((m) => m.userId === me && m.status === "active").map((m) => m.workspaceId ?? null));
  const carry = prev.filter((w) => w.id !== null && !have.has(w.id) && (justMade.has(w.id) || vouched.has(w.id)));
  if (!carry.length) return { workspaces: snapshot, members };
  // a workspace made here keeps the owner row we added for it
  const carried = new Set(carry.map((w) => w.id));
  const haveM = new Set(members.map((m) => m.id));
  const carryM = prevMembers.filter((m) => carried.has(m.workspaceId ?? null) && !haveM.has(m.id));
  return { workspaces: [...snapshot, ...carry], members: carryM.length ? [...members, ...carryM] : members };
}

/** Copy just the named fields of a task (used to undo or roll back exactly what a write changed). */
export function pickFields(t: Task, keys: string[]): Partial<Task> {
  const out: Record<string, unknown> = {};
  const src = t as unknown as Record<string, unknown>;
  for (const k of keys) out[k] = src[k];
  return out as Partial<Task>;
}

/** What a status change does to completedAt: stamp it only on a real transition
 *  into done, clear it on reopen, and leave history alone otherwise. */
export function statusTransition(prev: Pick<Task, "status">, next: Status, today: string = toLocalISO(new Date())):
  { completing: boolean; reopening: boolean; patch: Partial<Task> } {
  const completing = prev.status !== "done" && next === "done";
  const reopening = prev.status === "done" && next !== "done";
  const patch: Partial<Task> = {};
  if (completing) patch.completedAt = today;
  else if (reopening) patch.completedAt = undefined;
  return { completing, reopening, patch };
}

const DAY = 86400000;
const midnight = (iso?: string) => (iso ? new Date(iso + "T00:00:00") : new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate()));

/** Clone a task and its (non-archived) sub-task tree with fresh ids. `over`
 *  customises each clone; the root is always first, parents before children. */
export function cloneTaskTree(src: Task, all: Task[], over: (t: Task, isRoot: boolean) => Partial<Task>, makeId: () => string = newTaskId): Task[] {
  const kids = descendantsOf([src.id], all).filter((k) => !k.archivedAt);
  const idMap = new Map<string, string>([[src.id, makeId()], ...kids.map((k) => [k.id, makeId()] as [string, string])]);
  return [src, ...kids].map((t, i) => ({
    ...t,
    ...over(t, i === 0),
    id: idMap.get(t.id)!,
    parentId: i === 0 ? src.parentId : (t.parentId ? idMap.get(t.parentId) : undefined),
  }));
}

/** The next occurrence of a completed recurring task (with its sub-tasks reset
 *  to to-do), or null when it doesn't recur or an open occurrence of the same
 *  series is already due on or after the next date (idempotent re-completes). */
export function buildRecurrence(t: Task, all: Task[], makeId: () => string = newTaskId): Task[] | null {
  if (!t.recurrence || t.recurrence === "none") return null;
  const nextDue = nextDueDate(t.dueDate, t.recurrence);
  const exists = all.some((x) => x.id !== t.id && x.status !== "done" && !x.archivedAt && (x.parentId ?? null) === (t.parentId ?? null)
    && x.title === t.title && x.projectId === t.projectId && (x.recurrence ?? "none") === t.recurrence
    && !!x.dueDate && x.dueDate >= nextDue);
  if (exists) return null;
  const delta = Math.round((midnight(nextDue).getTime() - midnight(t.dueDate).getTime()) / DAY);
  const shift = (iso?: string) => { if (!iso) return undefined; const d = midnight(iso); d.setDate(d.getDate() + delta); return toLocalISO(d); };
  return cloneTaskTree(t, all, (x, isRoot) => ({
    status: "todo", completedAt: undefined, archivedAt: undefined, loggedHours: undefined, reactions: {},
    comments: 0, scheduled: null, planToday: false, dependencies: [], createdAt: undefined, originalDueDate: undefined,
    dueDate: isRoot ? nextDue : shift(x.dueDate), startDate: shift(x.startDate), position: Date.now(),
  }), makeId);
}

/** Share of top-level tasks done (sub-tasks nest under their parent, so they don't skew it). */
export function topLevelProgress(tasks: Task[]): { count: number; done: number; pct: number } {
  const top = tasks.filter((t) => !t.parentId);
  const done = top.filter((t) => t.status === "done").length;
  return { count: top.length, done, pct: top.length ? Math.round((done / top.length) * 100) : 0 };
}

/* ---------- last-used workspace (per user) ---------- */
export const lastWorkspaceKey = (uid: string) => `kanbo-last-ws:${uid}`;
/** Where to open: the workspace this user last used (if they're still in it),
 *  else the store's default, else their first team workspace, else Personal.
 *  `stored` is the raw localStorage value ("personal" means the Personal space). */
export function pickStartWorkspace(workspaces: Workspace[], defaultWs: string | null, stored: string | null): string | null {
  const has = (id: string | null) => workspaces.some((w) => w.id === id);
  if (stored === "personal") return null;
  if (stored && has(stored)) return stored;
  if (defaultWs !== null && has(defaultWs)) return defaultWs;
  return workspaces.find((w) => w.id !== null)?.id ?? null;
}

/* ---------- task-list filters (saved per route) ---------- */
export interface TaskFilters { priority: string; assignee: string; tag: string; due: string; hideDone: boolean; showArchived: boolean; custom: Record<string, string> }
export const EMPTY_FILTERS: TaskFilters = { priority: "all", assignee: "all", tag: "all", due: "all", hideDone: false, showArchived: false, custom: {} };
export const filtersKey = (scope: string) => `kanbo-filters:${scope}`;
export function readFilters(scope: string): TaskFilters {
  try {
    const s = localStorage.getItem(filtersKey(scope));
    if (s) { const v = JSON.parse(s) as Partial<TaskFilters>; return { ...EMPTY_FILTERS, ...v, custom: { ...(v.custom ?? {}) }, showArchived: false }; }
  } catch { /* private mode / bad JSON */ }
  return { ...EMPTY_FILTERS, custom: {} };
}
/** Drop saved filters that can't apply here (a custom field from another
 *  project, a person who isn't in this workspace, a deleted tag) so they can
 *  never silently hide every task. */
export function validFilters(f: TaskFilters, ctx: { memberIds: Set<string>; fieldIds: Set<string>; tagIds: Set<string> }): TaskFilters {
  const custom: Record<string, string> = {};
  for (const [fid, v] of Object.entries(f.custom ?? {})) if (v && v !== "all" && ctx.fieldIds.has(fid)) custom[fid] = v;
  return {
    ...f,
    assignee: f.assignee !== "all" && !ctx.memberIds.has(f.assignee) ? "all" : f.assignee,
    tag: f.tag !== "all" && !ctx.tagIds.has(f.tag) ? "all" : f.tag,
    custom,
  };
}

