/* ============================================================
   KANBO — personal plan state on shared tasks.
   A task row holds one plan (scheduled slot, "on today", My-tasks
   section, AI score), which belongs to its assignee. When anyone
   else plans a task they collaborate on, that personal state is
   kept here, per person and per device, instead of overwriting
   the assignee's plan. (Replaced by a task_user_state table
   once that migration ships.)
   ============================================================ */
import { todayISO, toLocalISO } from "../data/data";
import type { Task } from "../data/types";

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

function planEntry(v: unknown): PlanEntry | null {
  if (!isRecord(v)) return null;
  const out: PlanEntry = {};
  if (typeof v.scheduled === "number" && Number.isFinite(v.scheduled)) out.scheduled = v.scheduled;
  else if (v.scheduled === null) out.scheduled = null;
  if (typeof v.planToday === "boolean") out.planToday = v.planToday;
  return Object.keys(out).length ? out : null;
}

/** This person's plan for a day: task id → their scheduled slot / "on today". */
export function readPlanOverlay(userId: string, day: string): Record<string, PlanEntry> {
  const days = read(planKey(userId));
  const forDay = isRecord(days[day]) ? days[day] : {};
  const out: Record<string, PlanEntry> = {};
  for (const [id, v] of Object.entries(forDay)) { const e = planEntry(v); if (e) out[id] = e; }
  return out;
}

/** Merge a change into this person's plan for a day. */
export function writePlanOverlay(userId: string, day: string, id: string, patch: PlanEntry): void {
  const days = read(planKey(userId));
  const forDay = isRecord(days[day]) ? { ...days[day] } : {};
  const next = planEntry({ ...(isRecord(forDay[id]) ? forDay[id] : {}), ...patch });
  if (next) forDay[id] = next; else delete forDay[id];
  if (Object.keys(forDay).length) days[day] = forDay; else delete days[day];
  write(planKey(userId), days);
}

/** Drop days more than `keepDays` before today (and anything unreadable). */
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
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(read(sectionKey(userId)))) if (typeof v === "string" && v) out[id] = v;
  return out;
}

/** File a task in one of this person's sections; an empty section id un-files it. */
export function writeSectionOverlay(userId: string, id: string, sectionId: string | null | undefined): void {
  const all = read(sectionKey(userId));
  if (sectionId) all[id] = sectionId; else delete all[id];
  write(sectionKey(userId), all);
}

/** This person's AI ranking of tasks that aren't theirs. */
export function readScoreOverlay(userId: string): Record<string, ScoreEntry> {
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

export function writeScoreOverlay(userId: string, id: string, patch: ScoreEntry): void {
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
 *  they come from this person's own overlay instead (their plan there, or none),
 *  so nobody's day shows a teammate's plan. A score of their own replaces the
 *  row's; without one the row's stays (a ranking hint, not a plan). Tasks that
 *  don't change keep their identity, and so does the list when none do. */
export function withOverlay(tasks: Task[], userId: string, day: string = todayISO()): Task[] {
  const plan = readPlanOverlay(userId, day);
  const sections = readSectionOverlay(userId);
  const scores = readScoreOverlay(userId);
  let changed = false;
  const out = tasks.map((t) => {
    if (t.assigneeId === userId) return t;
    const p = plan[t.id], sc = scores[t.id];
    const scheduled = p?.scheduled ?? null;
    const planToday = p?.planToday ?? false;
    const mySectionId = sections[t.id];
    if ((t.scheduled ?? null) === scheduled && !!t.planToday === planToday && t.mySectionId === mySectionId && !sc) return t;
    changed = true;
    return { ...t, scheduled, planToday, mySectionId, ...sc };
  });
  return changed ? out : tasks;
}
