/* ============================================================
   KANBO — personal plan state on shared tasks.
   A task row holds one plan (scheduled slot, "on today", My-tasks
   section, AI score), which belongs to its assignee. When anyone
   else plans a task they collaborate on, that personal state is kept
   for them instead of overwriting the assignee's plan:
   - once migration 0043 is live, in their own task_user_state rows
     (data/planState, saved and replayed by the store), so the plan
     follows them to every device;
   - before that (and in demo mode, or signed out), on this device, per
     person, as it always was.
   A thin adapter: the exported API is the same either way, and the
   first time the table is there, plans kept on this device move into it.
   ============================================================ */
import { todayISO, toLocalISO } from "../data/data";
import type { Task } from "../data/types";
import { planMode, planEntry, planEntries, writePlan, withPlanDay, theirPlanFields } from "../data/planState";

/** The task fields that are one person's plan, not the task's. */
export const PERSONAL_KEYS = ["scheduled", "planToday", "mySectionId", "aiScore", "aiReason"] as const;
export type PersonalKey = (typeof PERSONAL_KEYS)[number];

export type PlanEntry = { scheduled?: number | null; planToday?: boolean };
export type ScoreEntry = { aiScore?: number; aiReason?: string };

const planKey = (userId: string) => `kanbo-plan-overlay:${userId}`;
const sectionKey = (userId: string) => `kanbo-section-overlay:${userId}`;
const scoreKey = (userId: string) => `kanbo-score-overlay:${userId}`;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** This person's plans live in task_user_state right now (else: on this device). */
const onServer = (userId: string) => !!userId && planMode(userId) === "server";

/* ---------- this device's storage (before 0043, demo mode, signed out) ---------- */

function read(key: string): Record<string, unknown> {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "{}") as unknown;
    return isRecord(v) ? v : {};
  } catch { return {}; }
}
function write(key: string, value: Record<string, unknown>): void {
  try {
    if (Object.keys(value).length) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch { /* private mode, or storage full: the plan just isn't remembered */ }
}

function planEntryOf(v: unknown): PlanEntry | null {
  if (!isRecord(v)) return null;
  const out: PlanEntry = {};
  if (typeof v.scheduled === "number" && Number.isFinite(v.scheduled)) out.scheduled = v.scheduled;
  else if (v.scheduled === null) out.scheduled = null;
  if (typeof v.planToday === "boolean") out.planToday = v.planToday;
  return Object.keys(out).length ? out : null;
}

function readDevicePlan(userId: string, day: string): Record<string, PlanEntry> {
  const days = read(planKey(userId));
  const forDay = isRecord(days[day]) ? days[day] : {};
  const out: Record<string, PlanEntry> = {};
  for (const [id, v] of Object.entries(forDay)) { const e = planEntryOf(v); if (e) out[id] = e; }
  return out;
}
function readDeviceSections(userId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(read(sectionKey(userId)))) if (typeof v === "string" && v) out[id] = v;
  return out;
}
function readDeviceScores(userId: string): Record<string, ScoreEntry> {
  const out: Record<string, ScoreEntry> = {};
  for (const [id, v] of Object.entries(read(scoreKey(userId)))) {
    if (!isRecord(v)) continue;
    const e: ScoreEntry = {};
    if (typeof v.aiScore === "number" && Number.isFinite(v.aiScore)) e.aiScore = v.aiScore;
    if (typeof v.aiReason === "string") e.aiReason = v.aiReason;
    if (Object.keys(e).length) out[id] = e;
  }
  return out;
}

/* ---------- moving this device's plans into task_user_state, once ---------- */

const adopted = new Set<string>();
/** The first time this person's plans are on the server (this session), the
 *  ones kept on this device for tasks that still aren't theirs move there —
 *  only where the server has nothing for that field yet (another device may
 *  already have planned it) — and the device copies are cleared. Needs the
 *  task list: a plan for a task they can no longer see, or that has become
 *  theirs (its row holds their plan now), is simply dropped. */
function adoptDevicePlans(tasks: Task[], userId: string, day: string): void {
  if (adopted.has(userId) || !tasks.length || !onServer(userId)) return;
  adopted.add(userId);
  const theirs = new Set(tasks.filter((t) => t.assigneeId !== userId).map((t) => t.id));
  const plan = readDevicePlan(userId, day), sections = readDeviceSections(userId), scores = readDeviceScores(userId);
  for (const [id, p] of Object.entries(plan)) {
    const e = planEntry(id);
    if (!theirs.has(id) || e?.planDay === day) continue;
    const patch: { scheduled?: number | null; planToday?: boolean } = {};
    if ("scheduled" in p) patch.scheduled = p.scheduled ?? null;
    if ("planToday" in p) patch.planToday = !!p.planToday;
    writePlan(id, withPlanDay(e, day, patch));
  }
  for (const [id, s] of Object.entries(sections)) if (theirs.has(id) && !planEntry(id)?.mySectionId) writePlan(id, { mySectionId: s });
  for (const [id, sc] of Object.entries(scores)) {
    if (!theirs.has(id) || typeof planEntry(id)?.aiScore === "number" || typeof sc.aiScore !== "number") continue;
    writePlan(id, { aiScore: sc.aiScore, ...(typeof sc.aiReason === "string" ? { aiReason: sc.aiReason } : {}) });
  }
  write(planKey(userId), {}); write(sectionKey(userId), {}); write(scoreKey(userId), {});
}
/** Test seam: let adoption run again. */
export function __resetPlanAdoptionForTests(): void { adopted.clear(); }

/* ---------- the API ---------- */

/** This person's plan for a day: task id → their scheduled slot / "on today". */
export function readPlanOverlay(userId: string, day: string): Record<string, PlanEntry> {
  if (!onServer(userId)) return readDevicePlan(userId, day);
  const out: Record<string, PlanEntry> = {};
  for (const [id, e] of planEntries()) {
    if (e.planDay !== day) continue;
    const p: PlanEntry = {};
    if (e.scheduled !== undefined) p.scheduled = e.scheduled ?? null;
    if (typeof e.planToday === "boolean") p.planToday = e.planToday;
    if (Object.keys(p).length) out[id] = p;
  }
  return out;
}

/** Merge a change into this person's plan for a day. */
export function writePlanOverlay(userId: string, day: string, id: string, patch: PlanEntry): void {
  if (onServer(userId)) {
    const p: { scheduled?: number | null; planToday?: boolean } = {};
    if ("scheduled" in patch) p.scheduled = patch.scheduled ?? null;
    if ("planToday" in patch) p.planToday = !!patch.planToday;
    if (Object.keys(p).length) writePlan(id, withPlanDay(planEntry(id), day, p));
    return;
  }
  const days = read(planKey(userId));
  const forDay = isRecord(days[day]) ? { ...days[day] } : {};
  const next = planEntryOf({ ...(isRecord(forDay[id]) ? forDay[id] : {}), ...patch });
  if (next) forDay[id] = next; else delete forDay[id];
  if (Object.keys(forDay).length) days[day] = forDay; else delete days[day];
  write(planKey(userId), days);
}

/** Drop days more than `keepDays` before today (and anything unreadable) from
 *  this device's copy. (A plan in task_user_state carries its day, so an old
 *  one is simply not shown.) */
export function prunePlanOverlay(userId: string, keepDays = 3, today: string = todayISO()): void {
  const days = read(planKey(userId));
  const cut = new Date(today + "T00:00:00");
  cut.setDate(cut.getDate() - keepDays);
  const cutoff = toLocalISO(cut);
  let changed = false;
  for (const d of Object.keys(days)) {
    if (!DAY_RE.test(d) || !isRecord(days[d]) || d < cutoff) { delete days[d]; changed = true; }
  }
  if (changed) write(planKey(userId), days);
}

/** This person's My-tasks section for each task they've filed on a shared task. */
export function readSectionOverlay(userId: string): Record<string, string> {
  if (!onServer(userId)) return readDeviceSections(userId);
  const out: Record<string, string> = {};
  for (const [id, e] of planEntries()) if (e.mySectionId) out[id] = e.mySectionId;
  return out;
}

/** File a task in one of this person's sections; an empty section id un-files it. */
export function writeSectionOverlay(userId: string, id: string, sectionId: string | null | undefined): void {
  if (onServer(userId)) { writePlan(id, { mySectionId: sectionId || null }); return; }
  const all = read(sectionKey(userId));
  if (sectionId) all[id] = sectionId; else delete all[id];
  write(sectionKey(userId), all);
}

/** This person's AI ranking of tasks that aren't theirs. */
export function readScoreOverlay(userId: string): Record<string, ScoreEntry> {
  if (!onServer(userId)) return readDeviceScores(userId);
  const out: Record<string, ScoreEntry> = {};
  for (const [id, e] of planEntries()) {
    if (typeof e.aiScore !== "number") continue;
    out[id] = { aiScore: e.aiScore, ...(typeof e.aiReason === "string" ? { aiReason: e.aiReason } : {}) };
  }
  return out;
}

export function writeScoreOverlay(userId: string, id: string, patch: ScoreEntry): void {
  if (onServer(userId)) {
    const p: { aiScore?: number; aiReason?: string } = {};
    if (typeof patch.aiScore === "number") p.aiScore = patch.aiScore;
    if (typeof patch.aiReason === "string") p.aiReason = patch.aiReason;
    if (Object.keys(p).length) writePlan(id, p);
    return;
  }
  const all = read(scoreKey(userId));
  const cur = isRecord(all[id]) ? all[id] : {};
  all[id] = { ...cur, ...patch };
  write(scoreKey(userId), all);
}

/** Split a patch into the personal-plan fields and the rest. */
export function splitPersonal(patch: Partial<Task>): { personal: Partial<Pick<Task, PersonalKey>>; shared: Partial<Task> } {
  const personal: Partial<Pick<Task, PersonalKey>> = {};
  const shared: Partial<Task> = { ...patch };
  for (const k of PERSONAL_KEYS) {
    if (k in shared) { (personal as Record<string, unknown>)[k] = shared[k]; delete shared[k]; }
  }
  return { personal, shared };
}

/** Tasks as this person sees them. A task's plan fields (its slot, "on today"
 *  and My-tasks section) are its assignee's: on a task assigned to anyone else
 *  they come from this person's own plan instead (their plan there, or none),
 *  so nobody's day shows a teammate's plan. Their own plan is their
 *  task_user_state row once 0043 is live (the slot and "on today" only when
 *  made for `day`), else this device's copy. A score of their own replaces the
 *  row's; without one the row's stays (a ranking hint, not a plan). Tasks
 *  assigned to them are their row as it is (the store's load already filled
 *  in their plan where the row had none). Tasks that don't change keep their
 *  identity, and so does the list when none do. */
export function withOverlay(tasks: Task[], userId: string, day: string = todayISO()): Task[] {
  const server = onServer(userId);
  if (server) adoptDevicePlans(tasks, userId, day);
  const entries = server ? planEntries() : null;
  const plan = server ? null : readDevicePlan(userId, day);
  const sections = server ? null : readDeviceSections(userId);
  const scores = server ? null : readDeviceScores(userId);
  let changed = false;
  const out = tasks.map((t) => {
    if (t.assigneeId === userId) return t;
    let scheduled: number | null, planToday: boolean, mySectionId: string | undefined, sc: ScoreEntry | undefined;
    if (entries) {
      const f = theirPlanFields(entries.get(t.id), day);
      scheduled = f.scheduled; planToday = f.planToday; mySectionId = f.mySectionId;
      sc = Object.keys(f.score).length ? f.score : undefined;
    } else {
      const p = plan![t.id];
      scheduled = p?.scheduled ?? null;
      planToday = p?.planToday ?? false;
      mySectionId = sections![t.id];
      sc = scores![t.id];
    }
    if ((t.scheduled ?? null) === scheduled && !!t.planToday === planToday && t.mySectionId === mySectionId
      && (!sc || ((sc.aiScore === undefined || sc.aiScore === t.aiScore) && (sc.aiReason === undefined || sc.aiReason === t.aiReason)))) return t;
    changed = true;
    return { ...t, scheduled, planToday, mySectionId, ...sc };
  });
  return changed ? out : tasks;
}
