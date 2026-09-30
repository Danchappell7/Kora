/* ============================================================
   KANBO — mock data (mirrors the real Supabase schema + a few
   forward-looking fields: tags, aiScore, aiReason, focusMin)
   ============================================================ */

import type {
  Member, Workspace, Project, TagDef, Task, CalEvent,
  Status, Priority, EnergyKind, StatusMeta, PriorityMeta, EnergyMeta, Recurrence,
  Activity, Goal, Portfolio, StatusUpdate, WorkspaceEvent, AutomationRule, FormDef,
} from "./types";
import { isSupabaseConfigured } from "../lib/supabase";
import { parseTask, tidyTitle, type NlpKind } from "../lib/nlp";

/* Real "today" (midnight, local) — drives all relative due-date math.
   It is ONE Date object that refreshClock() (below, next to NOW_MIN) moves
   forward IN PLACE, so every importer holding this reference sees the new day
   in a tab left open overnight. Never mutate it anywhere else — copy it
   (`new Date(KANBO_TODAY)`) before doing date arithmetic. */
export const KANBO_TODAY: Date = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

/* Local "YYYY-MM-DD" — avoids the UTC off-by-one that toISOString() causes in
   timezones ahead of UTC. All due-date math below parses dates as local. */
export function toLocalISO(d: Date): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
/* today's local "YYYY-MM-DD" — handy as a memo dependency so derived date
   buckets recompute when the day rolls over */
export function todayISO(): string { return toLocalISO(KANBO_TODAY); }

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

const DAY_MS = 86400000;
const daysInMonth = (y: number, m: number): number => new Date(y, m + 1, 0).getDate();
/* local midnight of a "YYYY-MM-DD" (tolerates a trailing time part); null if unparseable */
function parseLocalDay(iso: string): Date | null {
  const d = new Date(iso.slice(0, 10) + "T00:00:00");
  return Number.isNaN(d.getTime()) ? null : d;
}
/* whole days from one local date to another (DST-safe: rounds the 23/25h days) */
function daysBetweenISO(from: string, to: string): number {
  const a = parseLocalDay(from), b = parseLocalDay(to);
  return a && b ? Math.round((b.getTime() - a.getTime()) / DAY_MS) : 0;
}
function shiftISO(iso: string, days: number): string {
  const d = parseLocalDay(iso);
  if (!d || !days) return iso;
  d.setDate(d.getDate() + days);
  return toLocalISO(d);
}

/* Advance a due date by one recurrence step (from the due date, or today).
   Monthly keeps to its day of the month and clamps to the last day of shorter
   months (31 Jan → 28/29 Feb, 31 Aug → 30 Sep) instead of overflowing into the
   next month. Pass `anchorDay` — the day the series was set up on — so a series
   that was clamped finds its way back (28 Feb → 31 Mar); without it (or if it
   isn't a number, e.g. derived from a bad date) the anchor is the base date's
   own day. */
export function nextDueDate(iso: string | undefined, recurrence: Recurrence, anchorDay?: number): string {
  const base = (iso && parseLocalDay(iso)) || new Date(KANBO_TODAY);
  const d = new Date(base);
  const a = anchorDay != null && Number.isFinite(anchorDay) ? anchorDay : base.getDate();
  const anchor = Math.min(31, Math.max(1, Math.round(a)));
  const step = () => {
    if (recurrence === "daily") d.setDate(d.getDate() + 1);
    else if (recurrence === "weekdays") { do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); }
    else if (recurrence === "weekly") d.setDate(d.getDate() + 7);
    else if (recurrence === "biweekly") d.setDate(d.getDate() + 14);
    else if (recurrence === "monthly") {
      // go via the 1st so setMonth can't overflow (31 Jan + 1 month = 3 Mar)
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      d.setDate(Math.min(anchor, daysInMonth(d.getFullYear(), d.getMonth())));
    }
  };
  if (recurrence === "none") return toLocalISO(d);
  step();
  // if the computed next date is in the past, roll forward to the future
  // (bounded, so a decades-old daily date can't spin the tab)
  const todayMid = new Date(KANBO_TODAY);
  for (let i = 0; d < todayMid && i < 20000; i++) step();
  return toLocalISO(d);
}

/* The day of the month a monthly series belongs on, for nextDueDate's
   `anchorDay`. It's the due date's own day, unless that date sits on the last
   day of a short month (so it may have been clamped: 31 Jan → 28 Feb) and
   `originalDueDate` remembers a later day, which then wins (→ 31 Mar). A due
   date the user moved to mid-month is never clamped, so the series follows it.
   nextOccurrence keeps originalDueDate pointing at the series' day. */
export function seriesAnchorDay(t: { dueDate?: string; originalDueDate?: string }): number | undefined {
  const due = t.dueDate ? parseLocalDay(t.dueDate) : null;
  if (!due) return undefined;
  const day = due.getDate();
  const orig = t.originalDueDate ? parseLocalDay(t.originalDueDate) : null;
  const atMonthEnd = day === daysInMonth(due.getFullYear(), due.getMonth());
  return orig && atMonthEnd && orig.getDate() > day ? orig.getDate() : day;
}

/* The next instance of a recurring task: same work and people, fresh state.
   Everything that belonged to the finished occurrence is reset — time logged
   (so timesheets and billable totals don't double count), reactions, comment
   count, the plan slot, completion/archive stamps and dependencies (they point
   at this occurrence's blockers and aren't persisted on insert). startDate
   moves by the same number of days as the due date, so a Timeline bar keeps
   its length instead of stretching back to the first occurrence. A monthly
   series carries its day in originalDueDate (see seriesAnchorDay), so one due
   on the 31st goes 31 Jan → 28 Feb → 31 Mar, not 28 Feb → 28 Mar for good. */
export function nextOccurrence(t: Task, id: string, anchorDay?: number): Task {
  const recurrence = t.recurrence ?? "none";
  const anchor = anchorDay != null && Number.isFinite(anchorDay) ? anchorDay : seriesAnchorDay(t);
  const dueDate = nextDueDate(t.dueDate, recurrence, anchor);
  const shift = daysBetweenISO(t.dueDate ?? toLocalISO(KANBO_TODAY), dueDate);
  // the date that holds the series' day: the remembered one if it's the anchor, else this due date
  const dayOf = (iso?: string): number | undefined => (iso ? parseLocalDay(iso)?.getDate() : undefined);
  const seriesDate = t.originalDueDate && dayOf(t.originalDueDate) === anchor ? t.originalDueDate : t.dueDate;
  return {
    ...t,
    id,
    status: "todo",
    dueDate,
    startDate: t.startDate ? shiftISO(t.startDate, shift) : undefined,
    originalDueDate: recurrence === "monthly" ? seriesDate : undefined,
    completedAt: undefined,
    archivedAt: undefined,
    createdAt: undefined,
    scheduled: null,
    planToday: false,
    comments: 0,
    reactions: undefined,
    loggedHours: undefined,
    dependencies: [],
    subtasks: t.subtasks.map((s) => ({ ...s, done: false })),
  };
}

/* Carry a recurring task's sub-tasks (child tasks) to its next occurrence:
   fresh ids, back to to-do, re-parented onto `next`, and their dates moved by
   the same number of days as the parent's due date. Archived children stay
   behind, and so do children that repeat on their own: they already spawn
   their own next occurrence under the old parent, so cloning them here would
   duplicate them. `next.id` must be the new parent's SAVED id. */
export function nextOccurrenceChildren(children: Task[], prev: Task, next: Task, makeId: () => string): Task[] {
  const shift = daysBetweenISO(prev.dueDate ?? toLocalISO(KANBO_TODAY), next.dueDate ?? toLocalISO(KANBO_TODAY));
  return children
    .filter((c) => c.parentId === prev.id && !c.archivedAt && (c.recurrence ?? "none") === "none")
    .map((c) => ({
      ...c,
      id: makeId(),
      parentId: next.id,
      projectId: next.projectId,
      workspaceId: next.workspaceId,
      status: "todo" as Status,
      dueDate: c.dueDate ? shiftISO(c.dueDate, shift) : undefined,
      startDate: c.startDate ? shiftISO(c.startDate, shift) : undefined,
      originalDueDate: undefined,
      completedAt: undefined,
      createdAt: undefined,
      scheduled: null,
      planToday: false,
      comments: 0,
      reactions: undefined,
      loggedHours: undefined,
      dependencies: [],
      subtasks: c.subtasks.map((s) => ({ ...s, done: false })),
    }));
}

/** The signed-in person's avatar colour: light enough for dark initials to
 *  pass contrast (the old violet, oklch(0.585 0.196 264), managed 3.98:1). */
export const SELF_COLOR = "oklch(0.72 0.14 264)";

/* `let` (not `const`) so the authenticated user can replace the demo "self"
   member at runtime via setSelfMember — ES-module live bindings mean every
   importer sees the update. Teammates stay as seeded reference data. */
export let MEMBERS: Member[] = [
  { id: "m-self", name: "Daniel Okai", email: "daniel@kanbo.app", type: "self", color: SELF_COLOR },
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
   aiScore 0-100 = model's recommended priority. focusMin = estimated deep-work minutes.
   The demo seed is a living week at Foundrise: a launch deck holding up three
   tasks, a blocked hand-off, a date that slipped twice, stale work, one person
   over capacity, an unassigned task due soon, and history for Pulse and Radar.
   Ids t-1…t-16 keep their statuses, projects and assignees (tests lean on them). */
let _id = 0;
const t = (o: Partial<Task> & { title: string; status: Status; priority: Priority; projectId: string }): Task => ({
  id: "t-" + (++_id),
  description: "",
  tags: [],
  dependencies: [],
  subtasks: [],
  assigneeId: "m-self",
  createdBy: "m-self",
  focusMin: 30,
  comments: 0,
  aiScore: 0,
  ...o,
});
/* an ISO timestamp `days` ago at hh:mm local time (seed history) */
function daysAgoAt(days: number, hh: number, mm = 0): string {
  const d = new Date(KANBO_TODAY);
  d.setDate(d.getDate() - days);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}
/* an ISO timestamp `minutes` before the page loaded (today's history, always in the past) */
const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60000).toISOString();

export const TASKS: Task[] = [
  t({ title: "Finalise Q3 launch narrative deck", status: "progress", priority: "urgent", projectId: "p-launch",
      assigneeId: "m-self", dueDate: dayOffset(0), originalDueDate: dayOffset(2), tags: ["writing"], aiScore: 96,
      aiReason: "Blocks 3 downstream tasks and is due today.", focusMin: 90, comments: 4, effortHours: 6,
      createdAt: daysAgoAt(12, 9, 40),
      description: "Tighten the story arc, land the ‘why now’, and cut to 14 slides.",
      subtasks: [
        { id: "s1", title: "Rewrite opening hook", done: true },
        { id: "s2", title: "Add traction chart", done: true },
        { id: "s3", title: "Trim to 14 slides", done: false },
      ] }),
  t({ title: "Ship onboarding redesign to staging", status: "blocked", priority: "high", projectId: "p-launch",
      assigneeId: "m-1", dueDate: dayOffset(1), tags: ["eng", "design"], dependencies: ["t-4"], aiScore: 88,
      aiReason: "Waiting on design tokens — nudge Sana to unblock.", focusMin: 120, comments: 2, effortHours: 12,
      createdAt: daysAgoAt(10, 11, 5) }),
  t({ title: "Run pricing-page A/B test", status: "todo", priority: "high", projectId: "p-growth",
      assigneeId: "m-2", createdBy: "m-2", dueDate: dayOffset(3), originalDueDate: dayOffset(-4), tags: ["research", "eng"], aiScore: 74,
      aiReason: "High expected lift; start once the deck is out.", focusMin: 60, comments: 1, createdAt: daysAgoAt(14, 10, 0) }),
  t({ title: "Define design tokens v2", status: "review", priority: "high", projectId: "p-brand",
      assigneeId: "m-3", collaborators: ["m-self"], dueDate: dayOffset(0), tags: ["design"], aiScore: 81,
      aiReason: "In review — unblocks the onboarding redesign.", focusMin: 45, comments: 6, effortHours: 8,
      createdAt: daysAgoAt(15, 14, 20),
      description: "Colour, type scale, spacing and motion primitives." }),
  t({ title: "Draft investor update — Q3", status: "todo", priority: "medium", projectId: "p-personal",
      assigneeId: "m-self", dueDate: dayOffset(2), tags: ["writing"], aiScore: 58,
      aiReason: "Recurring; batch it with the deck writing.", focusMin: 40, comments: 0, createdAt: daysAgoAt(6, 8, 15) }),
  t({ title: "Migrate auth to edge sessions", status: "progress", priority: "urgent", projectId: "p-infra",
      assigneeId: "m-1", dueDate: dayOffset(1), tags: ["eng"], aiScore: 91,
      aiReason: "Security-sensitive and time-boxed this sprint.", focusMin: 150, comments: 3, effortHours: 16,
      createdAt: daysAgoAt(9, 9, 0),
      subtasks: [
        { id: "s4", title: "Spike: token rotation", done: true },
        { id: "s5", title: "Roll out behind a flag", done: false },
      ] }),
  t({ title: "Interview 5 churned users", status: "todo", priority: "medium", projectId: "p-growth",
      assigneeId: "m-4", dueDate: dayOffset(4), tags: ["research"], aiScore: 49,
      aiReason: "Schedule mornings — your focus peaks then.", focusMin: 60, comments: 0, createdAt: daysAgoAt(8, 16, 30) }),
  t({ title: "Fix flaky CI on macOS runners", status: "todo", priority: "low", projectId: "p-infra",
      assigneeId: "m-2", createdBy: "m-2", dueDate: dayOffset(6), tags: ["bug", "eng"], aiScore: 33,
      aiReason: "Low urgency; good filler for fragmented time.", focusMin: 30, comments: 1, effortHours: 3,
      createdAt: daysAgoAt(5, 13, 10) }),
  t({ title: "New homepage hero illustration", status: "progress", priority: "medium", projectId: "p-brand",
      assigneeId: "m-3", createdBy: "m-3", dueDate: dayOffset(5), tags: ["design"], aiScore: 52,
      aiReason: "Creative work — protect an afternoon block.", focusMin: 90, comments: 2, effortHours: 10,
      createdAt: daysAgoAt(20, 10, 30) }),
  t({ title: "Set up usage analytics events", status: "review", priority: "medium", projectId: "p-launch",
      assigneeId: "m-1", dueDate: dayOffset(2), tags: ["eng"], dependencies: ["t-6"], aiScore: 61,
      aiReason: "Needs edge sessions merged first.", focusMin: 45, comments: 0, effortHours: 6, createdAt: daysAgoAt(7, 15, 0) }),
  t({ title: "Weekly review & plan", status: "todo", priority: "low", projectId: "p-personal",
      assigneeId: "m-self", dueDate: dayOffset(0), recurrence: "weekly", tags: ["ops"], aiScore: 40,
      aiReason: "Anchor habit — keep the Friday slot.", focusMin: 25, comments: 0, createdAt: daysAgoAt(30, 17, 0) }),
  t({ title: "Approve Q3 launch budget", status: "done", priority: "high", projectId: "p-launch",
      assigneeId: "m-self", dueDate: dayOffset(-1), completedAt: dayOffset(-1), tags: ["ops"], aiScore: 70, focusMin: 20,
      effortHours: 2, createdAt: daysAgoAt(9, 11, 0) }),
  t({ title: "Pick launch date with leadership", status: "done", priority: "high", projectId: "p-launch",
      assigneeId: "m-self", dueDate: dayOffset(-2), completedAt: dayOffset(-2), tags: ["ops"], aiScore: 65, focusMin: 30,
      effortHours: 1, createdAt: daysAgoAt(11, 9, 30) }),
  t({ title: "Audit landing-page performance", status: "done", priority: "medium", projectId: "p-growth",
      assigneeId: "m-2", createdBy: "m-2", dueDate: dayOffset(-3), completedAt: dayOffset(-3), tags: ["eng"], aiScore: 44, focusMin: 40,
      createdAt: daysAgoAt(10, 12, 0) }),
  t({ title: "Competitor teardown — 3 tools", status: "done", priority: "low", projectId: "p-growth",
      assigneeId: "m-4", createdBy: "m-4", dueDate: dayOffset(-2), completedAt: dayOffset(-2), tags: ["research"], aiScore: 38, focusMin: 60,
      createdAt: daysAgoAt(13, 10, 45) }),
  t({ title: "Refresh brand colour palette", status: "done", priority: "medium", projectId: "p-brand",
      assigneeId: "m-3", createdBy: "m-3", dueDate: dayOffset(-4), completedAt: dayOffset(-1), tags: ["design"], aiScore: 50, focusMin: 50,
      effortHours: 4, createdAt: daysAgoAt(16, 9, 15) }),
  // ---- the launch week (t-17 onwards)
  t({ title: "Write press release for launch", status: "todo", priority: "high", projectId: "p-launch",
      assigneeId: "", dueDate: dayOffset(2), tags: ["writing"], dependencies: ["t-1"], aiScore: 72,
      aiReason: "Due in two days and nobody owns it yet.", focusMin: 60, effortHours: 3, createdAt: daysAgoAt(3, 10, 20) }),
  t({ title: "Load-test edge sessions", status: "todo", priority: "high", projectId: "p-infra",
      assigneeId: "m-1", dueDate: dayOffset(3), tags: ["eng"], dependencies: ["t-6"], aiScore: 67,
      aiReason: "Starts once the migration lands.", focusMin: 120, effortHours: 10, createdAt: daysAgoAt(2, 9, 50) }),
  t({ title: "Review launch FAQ copy", status: "todo", priority: "medium", projectId: "p-launch",
      assigneeId: "m-3", dueDate: dayOffset(1), tags: ["writing"], aiScore: 55, focusMin: 30, effortHours: 2,
      createdAt: daysAgoAt(2, 14, 5) }),
  t({ title: "Prep launch-day comms plan", status: "progress", priority: "high", projectId: "p-launch",
      assigneeId: "m-self", dueDate: dayOffset(1), tags: ["writing"], dependencies: ["t-1"], aiScore: 77,
      aiReason: "Due tomorrow; draft the timeline while the deck settles.", focusMin: 60, effortHours: 3,
      createdAt: daysAgoAt(4, 11, 30) }),
  t({ title: "Send the interview brief", status: "todo", priority: "medium", projectId: "p-launch",
      assigneeId: "m-self", createdBy: "m-1", dueDate: dayOffset(0), tags: ["research"], aiScore: 63,
      aiReason: "Maya handed it to you this morning; it's due today.", focusMin: 30, effortHours: 0.5, createdAt: minutesAgo(250) }),
  t({ title: "Approve token naming", status: "todo", priority: "high", projectId: "p-brand",
      assigneeId: "m-self", dueDate: dayOffset(0), tags: ["design"], aiScore: 79,
      aiReason: "Twenty minutes that unblock the onboarding redesign.", focusMin: 20, effortHours: 0.5,
      createdAt: daysAgoAt(1, 16, 40) }),
  t({ title: "Launch day", status: "todo", priority: "high", projectId: "p-launch", isMilestone: true,
      assigneeId: "m-self", dueDate: dayOffset(8), dependencies: ["t-1", "t-2"], aiScore: 60, focusMin: 15,
      createdAt: daysAgoAt(11, 9, 45) }),
  t({ title: "Record product demo video", status: "done", priority: "medium", projectId: "p-launch",
      assigneeId: "m-2", dueDate: dayOffset(0), completedAt: dayOffset(0), tags: ["design"], aiScore: 58, focusMin: 60,
      effortHours: 4, createdAt: daysAgoAt(6, 10, 0) }),
  t({ title: "Update pricing FAQ", status: "todo", priority: "medium", projectId: "p-launch",
      assigneeId: "m-self", createdBy: "m-2", dueDate: dayOffset(4), tags: ["writing"], aiScore: 46, focusMin: 45, effortHours: 2,
      createdAt: daysAgoAt(1, 12, 0),
      description: "From the Launch requests form.\n\nThe pricing FAQ still lists the beta tiers — update it for launch." }),
  t({ title: "Book venue for launch party", status: "todo", priority: "low", projectId: "p-launch",
      assigneeId: "m-2", createdBy: "m-2", dueDate: dayOffset(6), tags: ["ops"], aiScore: 35, focusMin: 30, effortHours: 2,
      createdAt: daysAgoAt(3, 15, 15) }),
  t({ title: "Renew passport", status: "todo", priority: "medium", projectId: "p-personal",
      assigneeId: "m-self", dueDate: dayOffset(12), tags: ["ops"], aiScore: 30, focusMin: 30, createdAt: daysAgoAt(5, 20, 10) }),
  t({ title: "Plan Q4 roadmap offsite", status: "todo", priority: "medium", projectId: "p-launch",
      assigneeId: "m-self", tags: ["ops"], aiScore: 42, focusMin: 60, effortHours: 4, createdAt: daysAgoAt(12, 16, 0) }),
  t({ title: "Accessibility pass on onboarding", status: "todo", priority: "medium", projectId: "p-launch",
      assigneeId: "m-3", dueDate: dayOffset(5), tags: ["design"], aiScore: 57, focusMin: 90, effortHours: 6,
      createdAt: daysAgoAt(4, 9, 20) }),
  t({ title: "Security review sign-off", status: "review", priority: "high", projectId: "p-infra",
      assigneeId: "m-1", createdBy: "m-1", dueDate: dayOffset(2), tags: ["eng"], aiScore: 70, focusMin: 30,
      createdAt: daysAgoAt(3, 11, 50) }),
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
export const DAY_START = 7 * 60;
export const DAY_END = 22 * 60;
const minutesOf = (d: Date): number => d.getHours() * 60 + d.getMinutes();
/* real current time (minutes from local midnight). `let` so refreshClock() can
   move it — ES-module live bindings mean every importer reads the new value. */
export let NOW_MIN = minutesOf(new Date());

/* Bring KANBO_TODAY and NOW_MIN up to date with the wall clock. KANBO_TODAY is
   moved in place (importers hold the same Date), so after a call every date
   helper here — dayOffset, presetDate, dueState, fmtDue, nextDueDate… —
   answers for the real today. Returns true when the day changed. main.tsx runs
   this every minute and when the tab wakes, then re-renders the app. */
export function refreshClock(now: Date = new Date()): boolean {
  NOW_MIN = minutesOf(now);
  const mid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (mid.getTime() === KANBO_TODAY.getTime()) return false;
  KANBO_TODAY.setTime(mid.getTime());
  return true;
}

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
  { id: "e5", title: "Launch sync", start: 11 * 60, end: 11 * 60 + 30, kind: "meeting", with: ["Maya", "Theo"] },
  { id: "e2", title: "Lunch", start: 12 * 60, end: 13 * 60, kind: "break" },
  { id: "e3", title: "Design review", start: 13 * 60, end: 14 * 60, kind: "meeting", with: ["Sana", "Theo"] },
  { id: "e4", title: "1:1 with Maya", start: 16 * 60 + 30, end: 17 * 60, kind: "meeting", with: ["Maya"] },
];

/* ============================================================
   Demo seed for the redesign's surfaces: Inbox, Pulse and Radar,
   Goals, Portfolios, status updates, Rules and Requests.
   Demo mode only (store.ts hands these out when there's no Supabase).
   ============================================================ */

/* The Inbox: six items, two of them new. `detail` is the actor's full name
   (InboxView's actorOf reads it), except a request, which names its form. */
export const DEMO_ACTIVITY: Activity[] = ([
  { id: "a-demo-1", taskId: "t-4", taskTitle: "Define design tokens v2", kind: "mention", detail: "Sana Rao", createdAt: minutesAgo(40) },
  { id: "a-demo-2", taskId: "t-21", taskTitle: "Send the interview brief", kind: "assigned", detail: "Maya Lin", createdAt: minutesAgo(250) },
  { id: "a-demo-3", taskId: "t-24", taskTitle: "Record product demo video", kind: "completed", detail: "Theo Vance", createdAt: minutesAgo(130), readAt: minutesAgo(100) },
  { id: "a-demo-4", taskId: "t-1", taskTitle: "Finalise Q3 launch narrative deck", kind: "comment", detail: "Theo Vance", createdAt: minutesAgo(310), readAt: minutesAgo(290) },
  { id: "a-demo-5", taskId: "t-2", taskTitle: "Ship onboarding redesign to staging", kind: "status", detail: "Maya Lin", createdAt: daysAgoAt(1, 15, 10), readAt: daysAgoAt(1, 15, 40) },
  { id: "a-demo-6", taskId: "t-25", taskTitle: "Update pricing FAQ", kind: "assigned", detail: "Request via Launch requests", createdAt: daysAgoAt(1, 12, 0), readAt: daysAgoAt(1, 12, 30) },
] satisfies Activity[]).sort((x, y) => y.createdAt.localeCompare(x.createdAt));

/* Task history (task_events), newest first: status and due moves across the
   last two days by Maya, Theo and Sana (Pulse's "done since yesterday"), the
   pricing test's date slipping twice, and the hero illustration going quiet. */
const ev = (id: string, taskId: string, actorId: string, field: WorkspaceEvent["field"], oldValue: string | null, newValue: string | null, createdAt: string): WorkspaceEvent => ({
  id, taskId, actorId, actorName: MEMBERS.find((m) => m.id === actorId)?.name ?? "Someone", field, oldValue, newValue, createdAt,
});
export const DEMO_TASK_EVENTS: WorkspaceEvent[] = [
  ev("ev-1", "t-24", "m-2", "status", "progress", "done", minutesAgo(130)),
  ev("ev-2", "t-10", "m-1", "status", "progress", "review", minutesAgo(190)),
  ev("ev-3", "t-21", "m-1", "assignee", "m-1", "m-self", minutesAgo(250)),
  ev("ev-4", "t-12", "m-self", "status", "review", "done", daysAgoAt(1, 17, 45)),
  ev("ev-5", "t-26", "m-2", "due", dayOffset(4), dayOffset(6), daysAgoAt(1, 16, 30)),
  ev("ev-6", "t-2", "m-1", "status", "progress", "blocked", daysAgoAt(1, 15, 10)),
  ev("ev-7", "t-4", "m-3", "status", "progress", "review", daysAgoAt(1, 11, 5)),
  ev("ev-8", "t-16", "m-3", "status", "review", "done", daysAgoAt(1, 10, 20)),
  ev("ev-9", "t-3", "m-2", "due", dayOffset(-1), dayOffset(3), daysAgoAt(2, 14, 20)),
  ev("ev-10", "t-13", "m-self", "status", "progress", "done", daysAgoAt(2, 12, 15)),
  ev("ev-11", "t-6", "m-1", "status", "todo", "progress", daysAgoAt(2, 9, 30)),
  ev("ev-12", "t-3", "m-2", "due", dayOffset(-4), dayOffset(-1), daysAgoAt(6, 10, 0)),
  ev("ev-13", "t-9", "m-3", "status", "todo", "progress", daysAgoAt(9, 11, 0)),
].sort((x, y) => y.createdAt.localeCompare(x.createdAt));

/* the launch goal lands with the Launch day milestone (t-23) */
const LAUNCH_DAY = dayOffset(8);
const launchDayLabel = (() => {
  const d = new Date(LAUNCH_DAY + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
})();
export const DEMO_GOALS: Goal[] = [
  { id: "g-launch", name: `Launch Q3 on ${launchDayLabel}`, description: "Ship the Q3 launch on the date we told customers.",
    status: "on_track", projectId: "p-launch", due: LAUNCH_DAY, workspaceId: "ws-foundrise", position: 0 },
  { id: "g-actives", name: "Grow weekly actives to 5,000", description: "Weekly active users across web and mobile.",
    target: 5000, current: 3900, unit: "users", status: "at_risk", due: `${KANBO_TODAY.getFullYear()}-12-31`, workspaceId: "ws-foundrise", position: 1 },
];

export const DEMO_PORTFOLIOS: Portfolio[] = [
  { id: "pf-q3", name: "Q3 launch", projectIds: ["p-launch", "p-brand", "p-infra"], workspaceId: "ws-foundrise" },
];

/* Platform Infra has no update at all, so it reads as stale. */
export const DEMO_STATUS_UPDATES: StatusUpdate[] = [
  { id: "su-brand", projectId: "p-brand", status: "on_track", createdAt: daysAgoAt(2, 16, 5), workspaceId: "ws-foundrise",
    summary: "Tokens v2 are in review and the new colour palette has shipped; the homepage hero is under way." },
  { id: "su-launch", projectId: "p-launch", status: "at_risk", createdAt: daysAgoAt(9, 17, 20), workspaceId: "ws-foundrise",
    summary: "Deck is the critical path; onboarding is blocked on tokens." },
];

/* Rules have no conditions yet, so "tag bugs" would tag every new launch task:
   it ships switched off, ready to show (and to switch on). */
export const DEMO_RULES: AutomationRule[] = [
  { id: "rule-bugs", projectId: "p-launch", workspaceId: "ws-foundrise", name: "Tag bugs for engineering",
    trigger: "task_created", actions: [{ type: "add_tag", value: "eng" }], enabled: false },
];

export const DEMO_FORMS: FormDef[] = [
  { id: "form-launch", projectId: "p-launch", workspaceId: "ws-foundrise", name: "Launch requests",
    description: "Ask the launch team for copy, assets or a fix before launch day.", fields: ["description", "priority", "dueDate"] },
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

/* AUTO-PLAN: place tasks into open gaps. deep/create → morning; admin → afternoon.
   Never places anything before "now" (rounded up to the next 5 minutes), never
   on top of a calendar event or a block that's already on the day, and never
   past DAY_END — tasks that don't fit come back in `unplaced`. Tasks already
   marked done are never placed (their existing blocks still count as busy). */
export interface DayPlan { placed: Record<string, number>; unplaced: Task[] }
const SLOT_MIN = 5;
const ceilSlot = (m: number): number => Math.ceil(m / SLOT_MIN) * SLOT_MIN;
export function planDayDetailed(tasks: Task[], events: CalEvent[], opts: { nowMin?: number } = {}): DayPlan {
  // the live time at the moment of planning, not the page-load time
  const earliest = Math.max(DAY_START, ceilSlot(opts.nowMin ?? minutesOf(new Date())));
  const lenOf = (t: Task): number => t.dur || t.focusMin || SLOT_MIN;
  // everything already on the day is busy BEFORE anything is placed — whatever
  // order the tasks arrive in — so a new block can't land on an existing one
  const busy = [
    ...events.map((e) => ({ start: e.start, end: e.end })),
    ...tasks.filter((t) => t.scheduled != null).map((t) => ({ start: t.scheduled!, end: t.scheduled! + lenOf(t) })),
  ].sort((a, b) => a.start - b.start);
  const place = (dur: number, morning: boolean): number | null => {
    const am: [number, number] = [earliest, 12 * 60];
    const pm: [number, number] = [Math.max(earliest, 13 * 60), DAY_END];
    for (const [lo, hi] of morning ? [am, pm] : [pm, am]) {
      // lo is always on the 5-minute grid, so every placement is too
      for (let s = ceilSlot(lo); s + dur <= hi; s += SLOT_MIN) {
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
  const order = tasks
    .filter((t) => t.scheduled == null && t.status !== "done")
    .sort((a, b) => (dueOffset(a.dueDate) - dueOffset(b.dueDate)) || (rank[a.priority] - rank[b.priority]));
  // The brain can't hold deep focus much past ~90 minutes. Rather than packing
  // the day wall-to-wall, we reserve a short comfort break whenever a continuous
  // run of work reaches the cap — so focus stays sustainable. A single task that
  // legitimately runs longer than the cap is allowed through (we just add the
  // break afterwards).
  const FOCUS_CAP = 90; // minutes of continuous work before a break is due
  const BREAK = 12;     // comfort/reset break, minutes
  const runStartOf = (end: number): number => {
    let start = end;
    for (;;) {
      const prev = busy.find((b) => Math.abs(b.end - start) < 1 && b.start < start);
      if (!prev) return start;
      start = prev.start;
    }
  };
  const placed: Record<string, number> = {};
  const unplaced: Task[] = [];
  for (const task of order) {
    const dur = lenOf(task);
    const s = place(dur, task.energy === "deep" || task.energy === "create");
    if (s == null) { unplaced.push(task); continue; }
    placed[task.id] = s;
    const end = s + dur;
    // if this placement caps off a continuous work run of 90m+, hold the next
    // slot open with a break so the day isn't a relentless block of work
    if (end - runStartOf(s) >= FOCUS_CAP && end + BREAK <= DAY_END) {
      busy.push({ start: end, end: end + BREAK });
      busy.sort((a, b) => a.start - b.start);
    }
  }
  return { placed, unplaced };
}
/* start minute per placed task id (see planDayDetailed for the rules and the
   tasks that didn't fit) */
export function planDay(tasks: Task[], events: CalEvent[], opts: { nowMin?: number } = {}): Record<string, number> {
  return planDayDetailed(tasks, events, opts).placed;
}

/* ---- natural-language capture ----
   Both parsers below are thin wrappers over lib/nlp's parseTask (the one
   grammar), kept with their original signatures and return shapes. They read
   only the tokens they have always read — everything else stays in the title
   exactly as typed — and "next week" is a week today, as it always was. */
const CAPTURE_KINDS: NlpKind[] = ["duration", "date", "priority", "energy"];
const TOKEN_KINDS: NlpKind[] = ["duration", "priority", "date", "project", "person"];
/* capture trims a stranded "-", "–" or ":" too; quick-add keeps them */
const EDGE_SEPARATORS = /^[\s,;:–—-]+|[\s,;:–—-]+$/g;
/* the signed-in user (demo: "m-self") — the store maps it on insert anyway,
   but using the real id keeps the task in My Week before the next reload */
const selfMemberId = (): string => MEMBERS.find((m) => m.type === "self")?.id ?? "m-self";

/* natural-language capture → a task compatible with the schema.
   opts.projectId / opts.assigneeId let the caller file it where the user is
   working (e.g. the active team workspace) instead of Personal / "me". */
export interface CaptureOptions { projectId?: string; assigneeId?: string }
let _capId = 1000;
export function parseCapture(text: string, opts: CaptureOptions = {}): Task | null {
  if (!text.trim()) return null;
  const p = parseTask(text, { today: KANBO_TODAY, kinds: CAPTURE_KINDS, nextWeek: "+7", priorityWords: true });
  let s = tidyTitle(p.title, EDGE_SEPARATORS);
  const dur = p.focusMin != null ? Math.max(SLOT_MIN, p.focusMin) : 30;
  let energy: EnergyKind = "admin";
  let tag: string | null = null;
  if (p.energy === "deep") { energy = "deep"; tag = "writing"; }
  else if (/\bdesign|creativ/i.test(s)) { energy = "create"; tag = "design"; }
  else if (/\bcall\b|\bmeet|\binterview/i.test(s)) { energy = "collab"; tag = "research"; }
  if (!s) s = "New task";
  // built-in tag ids only exist in demo mode — real accounts have their own tags
  const tags = tag && !isSupabaseConfigured && TAGS[tag] ? [tag] : [];
  return {
    id: "t-cap" + (++_capId), title: s.charAt(0).toUpperCase() + s.slice(1), description: "",
    status: "todo", priority: p.priority ?? "medium", projectId: opts.projectId || "p-personal", assigneeId: opts.assigneeId || selfMemberId(),
    dueDate: p.dueDate, tags, dependencies: [], subtasks: [], comments: 0,
    focusMin: dur, dur, energy, scheduled: null, aiScore: 60,
    aiReason: "Captured just now — drag it onto your day or hit Auto-plan.", planToday: true,
  };
}

/* Natural-language tokens for the New-task quick add:
   "Email Sara tomorrow 90m #Foundrise !high @dan" → fields + cleaned title. */
export interface ParsedTokens { title: string; dueDate?: string; priority?: Priority; projectId?: string; assigneeId?: string; focusMin?: number }
export function parseTaskTokens(text: string, projects: { id: string; name: string }[] = [], members: { id: string; name: string }[] = []): ParsedTokens {
  const p = parseTask(text, { today: KANBO_TODAY, projects, members, kinds: TOKEN_KINDS, nextWeek: "+7" });
  const out: ParsedTokens = { title: p.title };
  if (p.focusMin != null) out.focusMin = p.focusMin;
  if (p.priority) out.priority = p.priority;
  if (p.dueDate) out.dueDate = p.dueDate;
  if (p.projectId) out.projectId = p.projectId;
  if (p.assigneeId) out.assigneeId = p.assigneeId;
  return out;
}
