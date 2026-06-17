/* ============================================================
   KANBO — mock data (mirrors the real Supabase schema + a few
   forward-looking fields: tags, aiScore, aiReason, focusMin)
   ============================================================ */

import type {
  Member, Workspace, Project, TagDef, Task, CalEvent,
  Status, Priority, EnergyKind, StatusMeta, PriorityMeta, EnergyMeta,
} from "./types";

// Real "today" (midnight, local) — drives all relative due-date math.
export const KANBO_TODAY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

/* Local "YYYY-MM-DD" — avoids the UTC off-by-one that toISOString() causes in
   timezones ahead of UTC. All due-date math below parses dates as local. */
export function toLocalISO(d: Date): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type DuePreset = "today" | "tomorrow" | "weekend" | "nextweek";
export const DUE_PRESETS: { kind: DuePreset; label: string }[] = [
  { kind: "today", label: "Today" }, { kind: "tomorrow", label: "Tomorrow" },
  { kind: "weekend", label: "Weekend" }, { kind: "nextweek", label: "Next week" },
];
export function presetDate(kind: DuePreset): string {
  const d = new Date(KANBO_TODAY);
  if (kind === "tomorrow") d.setDate(d.getDate() + 1);
  else if (kind === "weekend") d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7)); // upcoming Saturday
  else if (kind === "nextweek") d.setDate(d.getDate() + 7);
  return toLocalISO(d);
}

export function dayOffset(n: number): string {
  const d = new Date(KANBO_TODAY);
  d.setDate(d.getDate() + n);
  return toLocalISO(d);
}

/* advance a due date by one recurrence step (from the due date, or today) */
export function nextDueDate(iso: string | undefined, recurrence: import("./types").Recurrence): string {
  const base = iso ? new Date(iso + "T00:00:00") : new Date(KANBO_TODAY);
  const d = new Date(base);
  if (recurrence === "daily") d.setDate(d.getDate() + 1);
  else if (recurrence === "weekly") d.setDate(d.getDate() + 7);
  else if (recurrence === "monthly") d.setMonth(d.getMonth() + 1);
  // if the computed next date is in the past, roll forward to the future
  const todayMid = new Date(KANBO_TODAY);
  while (d < todayMid && recurrence !== "none") {
    if (recurrence === "daily") d.setDate(d.getDate() + 1);
    else if (recurrence === "weekly") d.setDate(d.getDate() + 7);
    else { d.setMonth(d.getMonth() + 1); }
  }
  return toLocalISO(d);
}

/* `let` (not `const`) so the authenticated user can replace the demo "self"
   member at runtime via setSelfMember — ES-module live bindings mean every
   importer sees the update. Teammates stay as seeded reference data. */
export let MEMBERS: Member[] = [
  { id: "m-self", name: "Daniel Okai", email: "daniel@kanbo.app", type: "self", color: "oklch(0.585 0.196 264)" },
  { id: "m-1", name: "Maya Lin", email: "maya@kanbo.app", type: "team", color: "oklch(0.74 0.14 230)" },
  { id: "m-2", name: "Theo Vance", email: "theo@kanbo.app", type: "team", color: "oklch(0.78 0.15 70)" },
  { id: "m-3", name: "Sana Rao", email: "sana@kanbo.app", type: "team", color: "oklch(0.74 0.16 305)" },
  { id: "m-4", name: "Idris Bell", email: "idris@partner.io", type: "external", color: "oklch(0.7 0.13 20)" },
];

export let WORKSPACES: Workspace[] = [
  { id: null, name: "Personal", kind: "personal" },
  { id: "ws-foundrise", name: "Foundrise", kind: "team" },
  { id: "ws-reco", name: "Reco HQ", kind: "team" },
];

export let PROJECTS: Project[] = [
  { id: "p-personal", name: "Personal", emoji: "📌", color: "oklch(0.78 0.1 45)", workspaceId: null },
  { id: "p-launch", name: "Q3 Product Launch", emoji: "🚀", color: "oklch(0.74 0.14 230)", workspaceId: "ws-foundrise" },
  { id: "p-brand", name: "Brand Refresh", emoji: "🎨", color: "oklch(0.74 0.16 305)", workspaceId: "ws-foundrise" },
  { id: "p-infra", name: "Platform Infra", emoji: "⚙️", color: "oklch(0.75 0.13 155)", workspaceId: "ws-foundrise" },
  { id: "p-growth", name: "Growth Experiments", emoji: "📈", color: "oklch(0.78 0.15 70)", workspaceId: "ws-reco" },
];

/* Minimal reference data a brand-new (real) account starts with — one personal
   workspace + project, no teammates, no demo projects. */
export const PERSONAL_WORKSPACE: Workspace = { id: null, name: "Personal", kind: "personal" };
export const PERSONAL_PROJECT: Project = { id: "p-personal", name: "Personal", emoji: "📥", color: "oklch(0.78 0.1 45)", workspaceId: null };

/* Reference data is `let` so the active mode can replace it at runtime
   (demo mode keeps the rich seed; Supabase mode swaps in the minimal set).
   ES-module live bindings mean every importer sees the update. */
export function setReferenceData(ref: { members?: Member[]; projects?: Project[]; workspaces?: Workspace[]; events?: CalEvent[]; tags?: Record<string, TagDef> }): void {
  if (ref.members) MEMBERS = ref.members;
  if (ref.projects) PROJECTS = ref.projects;
  if (ref.workspaces) WORKSPACES = ref.workspaces;
  if (ref.events) EVENTS = ref.events;
  if (ref.tags) TAGS = ref.tags;
}

/* Built-in starter tags. Users can add their own (persisted) on top — see
   setReferenceData / store.createTag. `let` so the active mode can extend it. */
export const BUILTIN_TAGS: Record<string, TagDef> = {
  design: { label: "Design", color: "oklch(0.74 0.16 305)" },
  eng: { label: "Engineering", color: "oklch(0.74 0.14 230)" },
  research: { label: "Research", color: "oklch(0.75 0.13 155)" },
  writing: { label: "Writing", color: "oklch(0.78 0.15 70)" },
  ops: { label: "Ops", color: "oklch(0.7 0.02 240)" },
  bug: { label: "Bug", color: "oklch(0.66 0.2 20)" },
};
export let TAGS: Record<string, TagDef> = { ...BUILTIN_TAGS };

/* Tasks. status: todo|progress|review|blocked|done.  priority: low|medium|high|urgent
   aiScore 0-100 = model's recommended priority. focusMin = estimated deep-work minutes. */
let _id = 0;
const t = (o: Partial<Task> & { title: string; status: Status; priority: Priority; projectId: string }): Task => ({
  id: "t-" + (++_id),
  description: "",
  tags: [],
  dependencies: [],
  subtasks: [],
  assigneeId: "m-self",
  focusMin: 30,
  comments: 0,
  aiScore: 0,
  ...o,
});

export const TASKS: Task[] = [
  t({ title: "Finalize Q3 launch narrative deck", status: "progress", priority: "urgent", projectId: "p-launch",
      assigneeId: "m-self", dueDate: dayOffset(0), originalDueDate: dayOffset(2), tags: ["writing"], aiScore: 96,
      aiReason: "Blocks 3 downstream tasks and is due today.", focusMin: 90, comments: 4,
      description: "Tighten the story arc, land the 'why now', and cut to 14 slides.",
      subtasks: [
        { id: "s1", title: "Rewrite opening hook", done: true },
        { id: "s2", title: "Add traction chart", done: true },
        { id: "s3", title: "Trim to 14 slides", done: false },
      ] }),
  t({ title: "Ship onboarding redesign to staging", status: "blocked", priority: "high", projectId: "p-launch",
      assigneeId: "m-1", dueDate: dayOffset(1), tags: ["eng", "design"], dependencies: ["t-4"], aiScore: 88,
      aiReason: "Waiting on design tokens — nudge Sana to unblock.", focusMin: 120, comments: 2 }),
  t({ title: "Run pricing-page A/B test", status: "todo", priority: "high", projectId: "p-growth",
      assigneeId: "m-2", dueDate: dayOffset(3), tags: ["research", "eng"], aiScore: 74,
      aiReason: "High expected lift; start once deck is out.", focusMin: 60, comments: 1 }),
  t({ title: "Define design tokens v2", status: "review", priority: "high", projectId: "p-brand",
      assigneeId: "m-3", dueDate: dayOffset(0), tags: ["design"], aiScore: 81,
      aiReason: "In review — unblocks onboarding redesign.", focusMin: 45, comments: 6,
      description: "Color, type scale, spacing, and motion primitives." }),
  t({ title: "Draft investor update — May", status: "todo", priority: "medium", projectId: "p-personal",
      assigneeId: "m-self", dueDate: dayOffset(2), tags: ["writing"], aiScore: 58,
      aiReason: "Recurring; batch with deck writing.", focusMin: 40, comments: 0 }),
  t({ title: "Migrate auth to edge sessions", status: "progress", priority: "urgent", projectId: "p-infra",
      assigneeId: "m-1", dueDate: dayOffset(1), tags: ["eng"], aiScore: 91,
      aiReason: "Security-sensitive and time-boxed this sprint.", focusMin: 150, comments: 3,
      subtasks: [
        { id: "s4", title: "Spike: token rotation", done: true },
        { id: "s5", title: "Rollout behind flag", done: false },
      ] }),
  t({ title: "Interview 5 churned users", status: "todo", priority: "medium", projectId: "p-growth",
      assigneeId: "m-4", dueDate: dayOffset(4), tags: ["research"], aiScore: 49,
      aiReason: "Schedule mornings — your focus peaks then.", focusMin: 60, comments: 0 }),
  t({ title: "Fix flaky CI on macOS runners", status: "todo", priority: "low", projectId: "p-infra",
      assigneeId: "m-2", dueDate: dayOffset(6), tags: ["bug", "eng"], aiScore: 33,
      aiReason: "Low urgency; good filler for fragmented time.", focusMin: 30, comments: 1 }),
  t({ title: "New homepage hero illustration", status: "progress", priority: "medium", projectId: "p-brand",
      assigneeId: "m-3", dueDate: dayOffset(5), tags: ["design"], aiScore: 52,
      aiReason: "Creative work — protect an afternoon block.", focusMin: 90, comments: 2 }),
  t({ title: "Set up usage analytics events", status: "review", priority: "medium", projectId: "p-launch",
      assigneeId: "m-1", dueDate: dayOffset(2), tags: ["eng"], dependencies: ["t-6"], aiScore: 61,
      aiReason: "Needs edge sessions merged first.", focusMin: 45, comments: 0 }),
  t({ title: "Weekly review & plan", status: "todo", priority: "low", projectId: "p-personal",
      assigneeId: "m-self", dueDate: dayOffset(0), tags: ["ops"], aiScore: 40,
      aiReason: "Anchor habit — keep the Friday slot.", focusMin: 25, comments: 0 }),
  t({ title: "Approve Q3 launch budget", status: "done", priority: "high", projectId: "p-launch",
      assigneeId: "m-self", dueDate: dayOffset(-1), completedAt: dayOffset(-1), tags: ["ops"], aiScore: 70, focusMin: 20 }),
  t({ title: "Pick launch date with leadership", status: "done", priority: "high", projectId: "p-launch",
      assigneeId: "m-self", dueDate: dayOffset(-2), completedAt: dayOffset(-2), tags: ["ops"], aiScore: 65, focusMin: 30 }),
  t({ title: "Audit landing-page performance", status: "done", priority: "medium", projectId: "p-growth",
      assigneeId: "m-2", dueDate: dayOffset(-3), completedAt: dayOffset(-3), tags: ["eng"], aiScore: 44, focusMin: 40 }),
  t({ title: "Competitor teardown — 3 tools", status: "done", priority: "low", projectId: "p-growth",
      assigneeId: "m-4", dueDate: dayOffset(-2), completedAt: dayOffset(-2), tags: ["research"], aiScore: 38, focusMin: 60 }),
  t({ title: "Refresh brand color palette", status: "done", priority: "medium", projectId: "p-brand",
      assigneeId: "m-3", dueDate: dayOffset(-4), completedAt: dayOffset(-1), tags: ["design"], aiScore: 50, focusMin: 50 }),
];

/* ---- meta ---- */
export const STATUS_META: Record<Status, StatusMeta> = {
  todo:     { label: "To do",       color: "var(--st-todo)" },
  progress: { label: "In progress", color: "var(--st-progress)" },
  review:   { label: "In review",   color: "var(--st-review)" },
  blocked:  { label: "Blocked",     color: "var(--st-blocked)" },
  done:     { label: "Done",        color: "var(--st-done)" },
};
export const STATUS_ORDER: Status[] = ["todo", "progress", "review", "blocked", "done"];
export const PRIORITY_META: Record<Priority, PriorityMeta> = {
  low:    { label: "Low",    color: "var(--prio-low)",    rank: 0 },
  medium: { label: "Medium", color: "var(--prio-medium)", rank: 1 },
  high:   { label: "High",   color: "var(--prio-high)",   rank: 2 },
  urgent: { label: "Urgent", color: "var(--prio-urgent)", rank: 3 },
};

/* ---- helpers ---- */
export function memberInitials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((n) => n[0]?.toUpperCase()).join("") || "?";
}
export function getMember(id: string): Member | undefined { return MEMBERS.find((m) => m.id === id); }
export function getProject(id: string): Project | undefined { return PROJECTS.find((p) => p.id === id); }

export function fmtDue(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  const today = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate());
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  if (diff < 0) return `${Math.abs(diff)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
/* friendly relative timestamp for activity/comments */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function dueState(iso: string | undefined, status: Status): "none" | "overdue" | "today" | "soon" | "future" {
  if (!iso || status === "done") return "none";
  const d = new Date(iso + "T00:00:00");
  const today = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate());
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff === 1) return "soon";
  return "future";
}
export function projectProgress(tasks: Task[], projectId: string): number {
  const list = tasks.filter((t) => t.projectId === projectId);
  if (!list.length) return 0;
  return Math.round((list.filter((t) => t.status === "done").length / list.length) * 100);
}
export function blockingTasks(task: Task, all: Task[]): Task[] {
  if (!task.dependencies?.length) return [];
  return task.dependencies
    .map((id) => all.find((x) => x.id === id))
    .filter((x): x is Task => !!x && x.status !== "done");
}

/* ============================================================
   PLAN MY DAY — time-native scheduling layer
   ============================================================ */
export const DAY_START = 8 * 60;
export const DAY_END = 19 * 60;
export const NOW_MIN = 10 * 60 + 12;

export const ENERGY: Record<EnergyKind, EnergyMeta> = {
  deep:   { label: "Deep work",     color: "var(--accent)",      icon: "zap" },
  create: { label: "Creative",      color: "var(--st-review)",   icon: "sparkles" },
  collab: { label: "Collaborative", color: "var(--st-progress)", icon: "users" },
  admin:  { label: "Admin",         color: "var(--ink-3)",       icon: "layers" },
};
export function energyOf(task: Task): EnergyKind {
  const tg = task.tags || [];
  if (tg.includes("design")) return "create";
  if (tg.includes("research")) return "collab";
  if (tg.includes("ops")) return "admin";
  if (tg.includes("writing") || tg.includes("eng") || tg.includes("bug")) return "deep";
  return "admin";
}

/* the curated set competing for *today* */
export const PLAN_TODAY_IDS = ["t-1", "t-6", "t-3", "t-9", "t-5", "t-10"];

/* fixed calendar events the plan works around (demo data until calendars
   are connected — empty for real accounts). */
export let EVENTS: CalEvent[] = [
  { id: "e1", title: "Team standup", start: 9 * 60, end: 9 * 60 + 30, kind: "meeting", with: ["Maya", "Theo", "Sana"] },
  { id: "e2", title: "Lunch", start: 12 * 60, end: 13 * 60, kind: "break" },
  { id: "e3", title: "Design review", start: 13 * 60, end: 14 * 60, kind: "meeting", with: ["Sana", "Theo"] },
  { id: "e4", title: "1:1 with Maya", start: 16 * 60 + 30, end: 17 * 60, kind: "meeting", with: ["Maya"] },
];

export const fmtClock = (m: number): string => {
  const h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? "pm" : "am", hh = h % 12 || 12;
  return mm === 0 ? `${hh}${ap}` : `${hh}:${String(mm).padStart(2, "0")}${ap}`;
};
export const fmtClockRange = (s: number, e: number): string => `${fmtClock(s)} – ${fmtClock(e)}`;
export const fmtDurMin = (m: number): string =>
  m >= 60 ? (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`) : `${m}m`;

export function dueOffset(iso?: string): number {
  if (!iso) return 99;
  const d = new Date(iso + "T00:00:00");
  const today = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate());
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

/* AUTO-PLAN: place tasks into open gaps. deep/create → morning; admin → afternoon. */
export function planDay(tasks: Task[], events: CalEvent[]): Record<string, number> {
  const busy = events.map((e) => ({ start: e.start, end: e.end })).sort((a, b) => a.start - b.start);
  const place = (dur: number, morning: boolean): number | null => {
    const step = 5;
    const ranges = morning
      ? [[Math.max(DAY_START, NOW_MIN), 12 * 60], [13 * 60, DAY_END]]
      : [[13 * 60, DAY_END], [Math.max(DAY_START, NOW_MIN), 12 * 60]];
    for (const [lo, hi] of ranges) {
      for (let s = lo; s + dur <= hi; s += step) {
        if (!busy.some((b) => s < b.end && s + dur > b.start)) {
          busy.push({ start: s, end: s + dur });
          busy.sort((a, b) => a.start - b.start);
          return s;
        }
      }
    }
    return null;
  };
  const rank: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  const order = [...tasks].sort(
    (a, b) => (dueOffset(a.dueDate) - dueOffset(b.dueDate)) || (rank[a.priority] - rank[b.priority]),
  );
  const out: Record<string, number> = {};
  for (const task of order) {
    if (task.scheduled != null) {
      busy.push({ start: task.scheduled, end: task.scheduled + (task.dur || task.focusMin) });
      continue;
    }
    const s = place(task.dur || task.focusMin, task.energy === "deep" || task.energy === "create");
    if (s != null) out[task.id] = s;
  }
  return out;
}

/* natural-language capture → a task compatible with the schema */
let _capId = 1000;
export function parseCapture(text: string): Task | null {
  let s = text.trim();
  if (!s) return null;
  let dur = 30;
  let energy: EnergyKind = "admin";
  let tags: string[] = [];
  let due = 1;
  let priority: Priority = "medium";
  const dm = s.match(/(\d+(?:\.\d+)?)\s*(h|hr|hours?|m|min|mins?)\b/i);
  if (dm) {
    const n = parseFloat(dm[1]);
    dur = /h/i.test(dm[2]) ? Math.round(n * 60) : Math.round(n);
    s = s.replace(dm[0], "").trim();
  }
  if (/\bdeep\b|\bfocus\b/i.test(s)) { energy = "deep"; tags = ["writing"]; s = s.replace(/\bdeep( work)?\b|\bfocus\b/i, "").trim(); }
  else if (/\bdesign|creativ/i.test(s)) { energy = "create"; tags = ["design"]; }
  else if (/\bcall\b|\bmeet|\binterview/i.test(s)) { energy = "collab"; tags = ["research"]; }
  if (/\btoday\b/i.test(s)) { due = 0; s = s.replace(/\btoday\b/i, "").trim(); }
  else if (/\btomorrow\b/i.test(s)) { due = 1; s = s.replace(/\btomorrow\b/i, "").trim(); }
  if (/\b(urgent|asap|!!)\b/i.test(s)) { priority = "high"; s = s.replace(/\b(urgent|asap|!!)\b/i, "").trim(); }
  s = s.replace(/\bby\b\s*$/i, "").replace(/\s{2,}/g, " ").trim();
  if (!s) s = "New task";
  return {
    id: "t-cap" + (++_capId), title: s.charAt(0).toUpperCase() + s.slice(1), description: "",
    status: "todo", priority, projectId: "p-personal", assigneeId: "m-self",
    dueDate: dayOffset(due), tags, dependencies: [], subtasks: [], comments: 0,
    focusMin: dur, dur, energy, scheduled: null, aiScore: 60,
    aiReason: "Captured just now — drag it onto your day or hit Auto-plan.", planToday: true,
  };
}
