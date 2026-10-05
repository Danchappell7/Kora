/* ============================================================
   KANBO — plans that follow you: the signed-in person's own plan
   rows (public.task_user_state, migration 0043).
   The store owns the wiring (bootstrap loads the rows, writes are
   upserted and replayed, realtime keeps them fresh); this module is
   the state it keeps, with no client in it, so lib/planOverlay can
   read and write it without pulling the store in.

   - The server rows are the last good copy (also cached on this device
     for an offline reload).
   - Writes not saved yet sit in a per-person pending list in this
     device's storage (re-read before every change, so two tabs never
     drop each other's), merged over the server rows on every read: a
     plan never flickers back while its save is in flight or offline.
   - Mode "server": the table is there and the rows are loaded.
     Anything else ("local": demo, signed out, the migration not run
     yet) means plans stay on the device as they always have.
   ============================================================ */
import type { Task, TaskUserState, TaskUserStatePatch } from "./types";

export type PlanMode = "local" | "server";

/** The patch keys a row can hold, in a stable order (column names in toPlanRow). */
export const PLAN_FIELDS = ["scheduled", "planToday", "planDay", "mySectionId", "aiScore", "aiReason"] as const;
type PlanField = (typeof PLAN_FIELDS)[number];

const CACHE_PREFIX = "kanbo-plan-state:";
const PENDING_PREFIX = "kanbo-plan-pending:";
/** A write for a task id the server can't take yet (a task still being created
 *  under a client id) is kept this long, then given up. */
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** The database's limits (0043's task_user_state_sizes check). */
export const PLAN_LIMITS = { mySectionId: 200, aiReason: 2000 } as const;

interface PendingEntry { patch: TaskUserStatePatch; at: number }
interface Cache { mode: PlanMode; rows: TaskUserState[]; savedAt: number }

let current: { userId: string; mode: PlanMode; rows: Map<string, TaskUserState> } | null = null;
let memPending: Record<string, PendingEntry> | null = null; // when this device's storage is unavailable
let sink: (() => void) | null = null;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/* ---------- cleaning what comes in (the server, storage, callers) ---------- */

/** A patch with only valid values (anything else is dropped, never sent). */
export function cleanPlanPatch(v: unknown): TaskUserStatePatch {
  if (!isRecord(v)) return {};
  const out: TaskUserStatePatch = {};
  if ("scheduled" in v) {
    const s = v.scheduled;
    if (s === null) out.scheduled = null;
    else if (typeof s === "number" && Number.isFinite(s)) out.scheduled = Math.max(0, Math.min(24 * 60, Math.round(s)));
  }
  if ("planToday" in v && (v.planToday === null || typeof v.planToday === "boolean")) out.planToday = v.planToday as boolean | null;
  if ("planDay" in v && (v.planDay === null || (typeof v.planDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.planDay)))) out.planDay = v.planDay as string | null;
  if ("mySectionId" in v) {
    const m = v.mySectionId;
    if (m === null || m === undefined || m === "") out.mySectionId = null;
    else if (typeof m === "string" && m.length <= PLAN_LIMITS.mySectionId) out.mySectionId = m;
  }
  if ("aiScore" in v) {
    const a = v.aiScore;
    if (a === null) out.aiScore = null;
    else if (typeof a === "number" && Number.isFinite(a)) out.aiScore = Math.round(Math.max(-1e6, Math.min(1e6, a)));
  }
  if ("aiReason" in v) {
    const r = v.aiReason;
    if (r === null) out.aiReason = null;
    else if (typeof r === "string") out.aiReason = r.slice(0, PLAN_LIMITS.aiReason);
  }
  return out;
}

/** A task_user_state row (snake_case, from the server) as a TaskUserState. */
export function planRowToState(r: Record<string, unknown>, userId: string): TaskUserState | null {
  if (typeof r.task_id !== "string" || !r.task_id) return null;
  const p = cleanPlanPatch({
    scheduled: r.scheduled ?? null, planToday: r.plan_today ?? null,
    planDay: typeof r.plan_day === "string" ? r.plan_day.slice(0, 10) : null,
    mySectionId: r.my_section_id ?? null, aiScore: r.ai_score ?? null, aiReason: r.ai_reason ?? null,
  });
  return { taskId: r.task_id, userId: typeof r.user_id === "string" ? r.user_id : userId, ...p, updatedAt: typeof r.updated_at === "string" ? r.updated_at : undefined };
}

/** A patch as task_user_state columns (only the keys it has). */
export function toPlanRow(p: TaskUserStatePatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if ("scheduled" in p) row.scheduled = p.scheduled ?? null;
  if ("planToday" in p) row.plan_today = p.planToday ?? null;
  if ("planDay" in p) row.plan_day = p.planDay ?? null;
  if ("mySectionId" in p) row.my_section_id = p.mySectionId ?? null;
  if ("aiScore" in p) row.ai_score = p.aiScore ?? null;
  if ("aiReason" in p) row.ai_reason = p.aiReason ?? null;
  return row;
}
/** The column a patch key is stored in (for a strip-and-retry). */
export const PLAN_COLUMN: Record<PlanField, string> = {
  scheduled: "scheduled", planToday: "plan_today", planDay: "plan_day", mySectionId: "my_section_id", aiScore: "ai_score", aiReason: "ai_reason",
};

/* ---------- storage ---------- */

function readPending(userId: string): Record<string, PendingEntry> {
  if (memPending) return memPending;
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_PREFIX + userId) || "{}") as unknown;
    if (!isRecord(raw)) return {};
    const out: Record<string, PendingEntry> = {};
    for (const [id, e] of Object.entries(raw)) {
      if (!isRecord(e)) continue;
      const patch = cleanPlanPatch(e.patch);
      if (Object.keys(patch).length) out[id] = { patch, at: typeof e.at === "number" ? e.at : Date.now() };
    }
    return out;
  } catch { return {}; }
}
function writePending(userId: string, all: Record<string, PendingEntry>): void {
  try {
    if (Object.keys(all).length) localStorage.setItem(PENDING_PREFIX + userId, JSON.stringify(all));
    else localStorage.removeItem(PENDING_PREFIX + userId);
    memPending = null;
  } catch { memPending = all; } // private mode: keep it for this session at least
}
function writeCache(userId: string, mode: PlanMode, rows: TaskUserState[]): void {
  try { localStorage.setItem(CACHE_PREFIX + userId, JSON.stringify({ mode, rows, savedAt: Date.now() } satisfies Cache)); } catch { /* quota / private mode */ }
}
function readCache(userId: string): Cache | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_PREFIX + userId) || "null") as unknown;
    if (!isRecord(raw) || (raw.mode !== "server" && raw.mode !== "local") || !Array.isArray(raw.rows)) return null;
    const rows = raw.rows.filter(isRecord).map((r) => {
      const taskId = typeof r.taskId === "string" ? r.taskId : "";
      return taskId ? { taskId, userId, ...cleanPlanPatch(r) } as TaskUserState : null;
    }).filter((r): r is TaskUserState => !!r);
    return { mode: raw.mode, rows, savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0 };
  } catch { return null; }
}

/* ---------- lifecycle (the store calls these) ---------- */

/** After a load: the person's rows, or "missing" when the table isn't there
 *  yet (plans stay on the device). Cached for an offline reload. */
export function loadPlanState(userId: string, rows: TaskUserState[] | "missing"): void {
  const mode: PlanMode = rows === "missing" ? "local" : "server";
  const list = rows === "missing" ? [] : rows;
  current = { userId, mode, rows: new Map(list.map((r) => [r.taskId, r])) };
  writeCache(userId, mode, list);
}
/** An offline reload (or a load that couldn't read the rows): the last good
 *  copy on this device. Returns false when there isn't one (plans stay local). */
export function restorePlanState(userId: string): boolean {
  if (current?.userId === userId) return current.mode === "server";
  const c = readCache(userId);
  current = { userId, mode: c?.mode ?? "local", rows: new Map((c?.rows ?? []).map((r) => [r.taskId, r])) };
  return current.mode === "server";
}
/** Signed out: nothing of theirs stays in memory or in this device's cache.
 *  (Unsaved plan writes stay under their own key, like the offline queue, and
 *  only ever replay for them.) */
export function resetPlanState(): void {
  current = null;
  memPending = null;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(CACHE_PREFIX)) stale.push(k); }
    stale.forEach((k) => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }
}
/** The table went away (or a write proved it isn't there): back to device plans. */
export function planTableMissing(): void {
  if (!current) return;
  current = { ...current, mode: "local", rows: new Map() };
  writeCache(current.userId, "local", []);
}
/** The store asks to be told about every write (to schedule a save). */
export function onPlanWrite(fn: (() => void) | null): void { sink = fn; }

/* ---------- reads ---------- */

/** "server" when this person's plans live in task_user_state right now. */
export function planMode(userId?: string): PlanMode {
  return current && current.mode === "server" && (userId === undefined || current.userId === userId) ? "server" : "local";
}
/** Whose plan state is loaded (null: nobody's). */
export function planUser(): string | null { return current?.userId ?? null; }

const mergeEntry = (taskId: string, userId: string, base: TaskUserState | undefined, patch: TaskUserStatePatch | undefined): TaskUserState | undefined =>
  !patch ? base : { ...(base ?? { taskId, userId }), ...patch };

/** One task's plan: the server row with any unsaved write over it. */
export function planEntry(taskId: string): TaskUserState | undefined {
  if (!current) return undefined;
  return mergeEntry(taskId, current.userId, current.rows.get(taskId), readPending(current.userId)[taskId]?.patch);
}
/** Every task's plan (server rows with unsaved writes over them). */
export function planEntries(): Map<string, TaskUserState> {
  const out = new Map<string, TaskUserState>();
  if (!current) return out;
  for (const [id, r] of current.rows) out.set(id, r);
  for (const [id, e] of Object.entries(readPending(current.userId))) out.set(id, mergeEntry(id, current.userId, out.get(id), e.patch)!);
  return out;
}

/* ---------- writes ---------- */

/** The patch to write when a day-bound field (slot / on today) changes: it
 *  carries the day, and when the stored plan is for another day, the other
 *  day-bound field is reset with it (yesterday's slot never comes back). */
export function withPlanDay(entry: TaskUserState | undefined, day: string, patch: TaskUserStatePatch): TaskUserStatePatch {
  if (!("scheduled" in patch) && !("planToday" in patch)) return patch;
  const out: TaskUserStatePatch = { ...patch, planDay: day };
  if (entry?.planDay !== day) {
    if (!("scheduled" in out)) out.scheduled = null;
    if (!("planToday" in out)) out.planToday = null;
  }
  return out;
}

/** Save part of this person's plan on a task (server mode). Shown at once;
 *  saved by the store (now, or when back online). False in local mode. */
export function writePlan(taskId: string, patchIn: TaskUserStatePatch): boolean {
  if (!current || current.mode !== "server" || !taskId) return false;
  const patch = cleanPlanPatch(patchIn);
  if (!Object.keys(patch).length) return true;
  const all = readPending(current.userId);
  all[taskId] = { patch: { ...(all[taskId]?.patch ?? {}), ...patch }, at: Date.now() };
  writePending(current.userId, all);
  sink?.();
  return true;
}

/** Writes waiting to be saved (oldest first). */
export function pendingPlans(): { taskId: string; patch: TaskUserStatePatch; at: number }[] {
  if (!current) return [];
  return Object.entries(readPending(current.userId)).map(([taskId, e]) => ({ taskId, patch: e.patch, at: e.at })).sort((a, b) => a.at - b.at);
}
export function hasPendingPlans(): boolean { return !!current && Object.keys(readPending(current.userId)).length > 0; }

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/** A write landed: the server copy takes what was sent, and the pending write
 *  keeps only what changed again meanwhile. */
export function settlePlan(taskId: string, sent: TaskUserStatePatch): void {
  if (!current) return;
  current.rows.set(taskId, { ...(current.rows.get(taskId) ?? { taskId, userId: current.userId }), ...sent });
  const all = readPending(current.userId);
  const e = all[taskId];
  if (!e) return;
  const left: TaskUserStatePatch = {};
  for (const k of Object.keys(e.patch) as PlanField[]) {
    if (!(k in sent) || !same(e.patch[k], sent[k])) (left as Record<string, unknown>)[k] = e.patch[k];
  }
  if (Object.keys(left).length) all[taskId] = { ...e, patch: left }; else delete all[taskId];
  writePending(current.userId, all);
}
/** A write the server refuses for good (the task is gone, or no longer yours to see): drop it. */
export function discardPlan(taskId: string): void {
  if (!current) return;
  const all = readPending(current.userId);
  if (!(taskId in all)) return;
  delete all[taskId];
  writePending(current.userId, all);
}
/** Drop pending writes for ids the server will never take (a client id
 *  whose task was never saved), once they're old. Returns how many. */
export function prunePendingPlans(canSend: (taskId: string) => boolean, now = Date.now()): number {
  if (!current) return 0;
  const all = readPending(current.userId);
  let n = 0;
  for (const [id, e] of Object.entries(all)) if (!canSend(id) && now - e.at > PENDING_MAX_AGE_MS) { delete all[id]; n++; }
  if (n) writePending(current.userId, all);
  return n;
}
/** A task created offline was saved under a new id: its plan follows it. */
export function remapPlanTask(from: string, to: string): void {
  if (!current || from === to) return;
  const row = current.rows.get(from);
  if (row) { current.rows.delete(from); current.rows.set(to, { ...row, taskId: to }); }
  const all = readPending(current.userId);
  if (all[from]) {
    all[to] = { patch: { ...(all[to]?.patch ?? {}), ...all[from].patch }, at: all[from].at };
    delete all[from];
    writePending(current.userId, all);
  }
}

/** A row from realtime (or null: deleted). True when it changes what's shown. */
export function applyRemotePlan(taskId: string, row: TaskUserState | null): boolean {
  if (!current || current.mode !== "server") return false;
  const before = planEntry(taskId);
  if (row) current.rows.set(taskId, row); else current.rows.delete(taskId);
  const after = planEntry(taskId);
  return PLAN_FIELDS.some((k) => !same(before?.[k], after?.[k]));
}

/* ---------- precedence (pure) ---------- */

/** A task as its assignee sees it after a load: the row's plan, and where the
 *  row has none (not on today, no slot, no section), their own plan for today
 *  from task_user_state fills in, so a task handed to them keeps the plan they
 *  had made on it. The row's ranking stays (it is the assignee's). Unchanged
 *  tasks keep their identity. */
export function fillOwnPlan(t: Task, entry: TaskUserState | undefined, day: string): Task {
  if (!entry) return t;
  const fresh = entry.planDay === day;
  const patch: Partial<Task> = {};
  if (fresh && !t.planToday && entry.planToday === true) patch.planToday = true;
  if (fresh && t.scheduled == null && entry.scheduled != null) patch.scheduled = entry.scheduled;
  if (!t.mySectionId && entry.mySectionId) patch.mySectionId = entry.mySectionId;
  return Object.keys(patch).length ? { ...t, ...patch } : t;
}

/** Bootstrap's merge: this person's plan over the tasks assigned to them (see
 *  fillOwnPlan). Everyone else's tasks keep their rows: a teammate's plan is
 *  theirs, and lib/planOverlay shows this person's own plan there. */
export function mergeOwnPlans(tasks: Task[], userId: string, day: string): Task[] {
  if (planMode(userId) !== "server") return tasks;
  const entries = planEntries();
  if (!entries.size) return tasks;
  let changed = false;
  const out = tasks.map((t) => {
    if (t.assigneeId !== userId) return t;
    const n = fillOwnPlan(t, entries.get(t.id), day);
    if (n !== t) changed = true;
    return n;
  });
  return changed ? out : tasks;
}

/** This person's plan fields on a task that isn't theirs, from their row:
 *  the slot and "on today" only when the plan is for `day`; their section;
 *  their own score (replacing the row's) when they have one. */
export function theirPlanFields(entry: TaskUserState | undefined, day: string): { scheduled: number | null; planToday: boolean; mySectionId: string | undefined; score: { aiScore?: number; aiReason?: string } } {
  const fresh = !!entry && entry.planDay === day;
  const score: { aiScore?: number; aiReason?: string } = {};
  if (typeof entry?.aiScore === "number") {
    score.aiScore = entry.aiScore;
    if (typeof entry.aiReason === "string") score.aiReason = entry.aiReason;
  }
  return {
    scheduled: fresh && entry!.scheduled != null ? entry!.scheduled : null,
    planToday: fresh && entry!.planToday === true,
    mySectionId: entry?.mySectionId || undefined,
    score,
  };
}

/** Test seam: forget everything in memory (storage is the test's to clear). */
export function __resetPlanStateForTests(): void { current = null; memPending = null; sink = null; }
