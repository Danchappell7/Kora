/* ============================================================
   KANBO — goals in the day's work. What the Goals page, the goal
   chips ("Serves: Q4 · Grow weekly actives"), the Today brief,
   Kanbo noticed, the Team place and Ask Kanbo read about goals,
   from one set of rules:
   · a goal's read: its % (lib/goalProgress), where it should be by
     now (lib/goalPace) and whether that's on pace;
   · the work behind a goal: what it links (0052's goal_links, and the
     project its % comes from), and its key results' work; a task
     serves the goals it's linked to and its project's;
   · the quarter a goal belongs to (its period, else made → due);
   · the page's groups: Company (the business's top-level goals),
     Team (key results the team owns) and Mine (the ones you own or
     help on);
   · the one-line summary ("4 of 6 goals on pace; X is behind"), the
     brief's one goal line a day, the key results behind pace that
     Kanbo noticed, and which goals are slipping.
   Pure: no React, no I/O, no clock of its own.
   ============================================================ */
import type { Goal, GoalCheckin, GoalLink, Project, Role, StatusUpdate, Task } from "../data/types";
import { goalNumbersGap, goalProgressMap, type GoalProgress } from "./goalProgress";
import { goalPace, type PaceRead } from "./goalPace";
import { periodLabel, periodRange, quarterOf } from "./goalPeriods";
import { canSeeGoal, goalLookup, isGoalPerson } from "./goalRules";
import { progressOf, projectPct } from "./countRules";

/** A goal as every screen reads it. */
export interface GoalRead {
  goal: Goal;
  progress: GoalProgress;
  pct: number;
  pace: PaceRead | null;
  /** "on" (on, ahead, reached, or no pace line and not marked behind), "behind" (behind or past due),
   *  "early" (not started, or its own number isn't set up yet) */
  standing: "on" | "behind" | "early";
  /** a goal that tracks its own number but can't be measured yet: it needs a target, or where it started */
  needs?: "target" | "start";
}

/** What a goal that isn't set up yet says in place of its pace. */
export const NEEDS_LINE: Record<NonNullable<GoalRead["needs"]>, string> = { target: "Set a target", start: "Set where it started" };

const pad = (n: number) => String(n).padStart(2, "0");
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAY = 86_400_000;
const dayNo = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d) / DAY; };

/** Every goal's %, pace and standing. `tasks`: the goals' workspaces' tasks (archived projects' too). */
export function readGoals(goals: Goal[], tasks: Task[], today: Date): Map<string, GoalRead> {
  const progress = goalProgressMap(goals, (pid) => projectPct(tasks, pid));
  const out = new Map<string, GoalRead>();
  for (const g of goals) {
    const p = progress.get(g.id) ?? { pct: 0, source: "manual" as const, children: 0 };
    // its own number with nothing to measure against yet: no pace, no suggestion, not counted
    const needs = p.source === "manual" && g.status !== "done" ? goalNumbersGap(g) ?? undefined : undefined;
    const pace = needs ? null : goalPace(g, p.pct, today);
    const standing: GoalRead["standing"] = pace
      ? pace.state === "behind" || pace.state === "late" ? "behind" : pace.state === "early" ? "early" : "on"
      : g.status === "at_risk" || g.status === "off_track" ? "behind" : needs ? "early" : "on";
    out.set(g.id, { goal: g, progress: p, pct: p.pct, pace, standing, ...(needs ? { needs } : {}) });
  }
  return out;
}

/* ---------------- what a goal is linked to ---------------- */

/** The projects a goal is linked to: its links, and the project its % comes from. */
export function goalProjectIds(goal: Goal, links: GoalLink[]): string[] {
  const ids = links.filter((l) => l.goalId === goal.id && l.kind === "project").map((l) => l.targetId);
  if (goal.projectId && !ids.includes(goal.projectId)) ids.unshift(goal.projectId);
  return ids;
}

/** Does anything move this goal: linked work of its own, or of any key result under it? */
export function hasWorkBehind(goal: Goal, goals: Goal[], links: GoalLink[]): boolean {
  const seen = new Set<string>();
  const walk = (g: Goal): boolean => {
    if (seen.has(g.id)) return false;
    seen.add(g.id);
    if (g.projectId || links.some((l) => l.goalId === g.id)) return true;
    return goals.some((c) => c.parentId === g.id && !c.archivedAt && walk(c));
  };
  return walk(goal);
}

/** The goals a project serves (linked to it directly, or reading their % from it), open ones only. */
export function goalsForProject(projectId: string, goals: Goal[], links: GoalLink[]): Goal[] {
  const linked = new Set(links.filter((l) => l.kind === "project" && l.targetId === projectId).map((l) => l.goalId));
  return goals.filter((g) => !g.archivedAt && g.status !== "done" && (g.projectId === projectId || linked.has(g.id)));
}

/** The goals a task serves: linked to the task itself (or its parent task), then its project's. */
export function goalsForTask(task: Pick<Task, "id" | "projectId" | "parentId">, goals: Goal[], links: GoalLink[]): Goal[] {
  const direct = new Set(links.filter((l) => l.kind === "task" && (l.targetId === task.id || (!!task.parentId && l.targetId === task.parentId))).map((l) => l.goalId));
  const own = goals.filter((g) => !g.archivedAt && g.status !== "done" && direct.has(g.id));
  const viaProject = goalsForProject(task.projectId, goals, links).filter((g) => !direct.has(g.id));
  return [...own, ...viaProject];
}

/** The goals a person may see (team goals by their role there; personal ones are theirs). */
export function seeableGoals(goals: Goal[], me: string, roleIn: (wsId: string | null) => Role | null | undefined): Goal[] {
  const byId = goalLookup(goals);
  return goals.filter((g) => canSeeGoal(g, { me, role: roleIn(g.workspaceId ?? null) }, byId));
}

/* ---------------- words ---------------- */

/** A goal's period, short: "Q4" (this year's), "Q1 2027", "H2", "2026", "1 Feb – 15 May"; "" with none. */
export function periodShort(goal: Pick<Goal, "period" | "periodStart" | "periodEnd">, today: Date): string {
  const label = periodLabel(goal.period, goal.periodStart, goal.periodEnd);
  if (!label) return "";
  const year = String(today.getFullYear());
  return /^(Q[1-4]|H[12]) \d{4}$/.test(label) && label.endsWith(year) ? label.slice(0, 2) : label;
}

/** The chip's words: "Q4 · Grow weekly actives to 5,000" (just the name with no period). */
export function servesLabel(goal: Goal, today: Date): string {
  const p = periodShort(goal, today);
  return p ? `${p} · ${goal.name}` : goal.name;
}

/** "Behind pace by 12%", "On pace", "Set a target", … for a row; "" when there's no pace line. */
export const paceWords = (r: GoalRead): string => (r.pace ? r.pace.line : r.needs ? NEEDS_LINE[r.needs] : "");

/* ---------------- the quarter a goal belongs to ---------------- */

/** A goal's span: its period, else from when it was made to its due date (either end may be open). */
export function goalSpan(g: Pick<Goal, "period" | "periodStart" | "periodEnd" | "due" | "createdAt">): { start: string | null; end: string | null } {
  const named = periodRange(g.period, g.periodStart, g.periodEnd);
  if (named) return named;
  const made = g.createdAt ? localIso(new Date(g.createdAt)) : null;
  return { start: g.periodStart ?? made, end: g.periodEnd ?? g.due ?? null };
}

/** Does the goal run at some point in this range? */
export function goalInRange(g: Goal, range: { start: string; end: string }): boolean {
  const s = goalSpan(g);
  return (!s.start || s.start <= range.end) && (!s.end || s.end >= range.start);
}

/** Is it still open from before this range (its time ran out first, and it's neither achieved
 *  nor archived)? The quarter you're in carries these over, so a goal past its date never
 *  drops out of sight. */
export function goalCarriedOver(r: Pick<GoalRead, "goal" | "pct">, range: { start: string; end: string }): boolean {
  const g = r.goal, end = goalSpan(g).end;
  return !g.archivedAt && g.status !== "done" && r.pct < 100 && !!end && end < range.start;
}

/** The goals a quarter shows: the ones that run in it, and, in the quarter you're in, the open
 *  ones carried over from before it. */
export function goalsInQuarter(goals: Goal[], reads: Map<string, GoalRead>, range: { start: string; end: string } | null, today: Date): Goal[] {
  if (!range) return goals;
  const now = localIso(today);
  const current = range.start <= now && now <= range.end;
  return goals.filter((g) => goalInRange(g, range) || (current && !!reads.get(g.id) && goalCarriedOver(reads.get(g.id)!, range)));
}

export interface QuarterOption { value: string; label: string; range: { start: string; end: string } | null }

/** The quarter switcher's choices: last quarter, this one, the next, and every goal ("All"). */
export function quarterOptions(today: Date): QuarterOption[] {
  const here = quarterOf(today);
  const step = (q: string, by: number) => {
    const y = Number(q.slice(0, 4)), n = Number(q.slice(6)) - 1 + by;
    return `${y + Math.floor(n / 4)}-Q${((n % 4) + 4) % 4 + 1}`;
  };
  const year = String(today.getFullYear());
  const opt = (q: string): QuarterOption => {
    const label = periodLabel(q);
    return { value: q, label: label.endsWith(year) ? label.slice(0, 2) : label, range: periodRange(q) };
  };
  return [opt(step(here, -1)), opt(here), opt(step(here, 1)), { value: "all", label: "All", range: null }];
}

/* ---------------- the page's groups ---------------- */

export type GoalGroup = "company" | "team" | "mine";
export const GROUP_LABEL: Record<GoalGroup, string> = { company: "Company", team: "Team", mine: "Mine" };

/** Which group a goal sits in: a top-level goal is the company's; a key result is yours when
 *  you own it or help on it, else the team's (under a goal you can't see, too: it's never a
 *  company goal). (Personal goals are all yours.) */
export function goalGroup(g: Goal, all: Goal[], me: string): GoalGroup {
  if ((g.workspaceId ?? null) === null) return "mine";
  if (!g.parentId || g.parentId === g.id) return "company";
  return isGoalPerson(g, me) ? "mine" : "team";
}

/* ---------------- the summary sentence ---------------- */

export type SummaryPart = string | { goalId: string; text: string };

/** "4 of 6 goals on pace; Grow weekly actives is behind." as parts (each named goal can open). */
export function goalsSummary(reads: GoalRead[]): { parts: SummaryPart[]; plain: string } {
  const live = reads.filter((r) => !r.goal.archivedAt);
  const parts: SummaryPart[] = [];
  if (!live.length) parts.push("No goals here yet.");
  else {
    const counted = live.filter((r) => r.standing !== "early");
    const behind = counted.filter((r) => r.standing === "behind")
      .sort((a, b) => (a.pace?.gap ?? 0) - (b.pace?.gap ?? 0) || a.goal.name.localeCompare(b.goal.name));
    const on = counted.length - behind.length;
    const total = counted.length;
    const n = (k: number) => (k === 1 ? "goal" : "goals");
    if (!total) parts.push(`${live.length} ${n(live.length)}, none started yet.`);
    else if (!behind.length) parts.push(total === 1 ? "The one goal here is on pace." : `All ${total} goals are on pace.`);
    else {
      parts.push(`${on} of ${total} ${n(total)} on pace; `);
      parts.push({ goalId: behind[0].goal.id, text: behind[0].goal.name });
      if (behind.length === 1) parts.push(" is behind.");
      else if (behind.length === 2) parts.push(" and ", { goalId: behind[1].goal.id, text: behind[1].goal.name }, " are behind.");
      else parts.push(` and ${behind.length - 1} more are behind.`);
    }
  }
  const plain = parts.map((p) => (typeof p === "string" ? p : p.text)).join("");
  return { parts, plain };
}

/* ---------------- project health, for the dots ---------------- */

export type DotTone = "ok" | "warn" | "signal" | "neutral";

/** A linked project's health as a dot: its latest update's status, else what its tasks say. */
export function projectDot(project: Project, tasks: Task[], updates: StatusUpdate[], today: Date): { tone: DotTone; label: string } {
  const latest = updates.filter((u) => u.projectId === project.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const toneOf = (k: string): DotTone => (k === "off_track" ? "signal" : k === "at_risk" ? "warn" : "ok");
  if (latest) return { tone: toneOf(latest.status), label: `${project.name}: ${latest.status === "off_track" ? "off track" : latest.status === "at_risk" ? "at risk" : "on track"}` };
  const own = tasks.filter((t) => t.projectId === project.id && !t.archivedAt);
  if (!own.length) return { tone: "neutral", label: `${project.name}: no tasks yet` };
  const todayIso = localIso(today);
  const overdue = own.some((t) => t.status !== "done" && !!t.dueDate && t.dueDate.slice(0, 10) < todayIso);
  const blocked = own.some((t) => t.status === "blocked");
  const pct = progressOf(own).pct;
  const tone: DotTone = overdue && blocked ? "signal" : overdue || blocked ? "warn" : "ok";
  return { tone, label: `${project.name}: ${pct}% done${overdue ? ", work overdue" : ""}${blocked ? ", something blocked" : ""}` };
}

/* ---------------- check-ins ---------------- */

/** A goal's check-ins, newest first. */
export function checkinsOf(goalId: string, checkins: GoalCheckin[]): GoalCheckin[] {
  return checkins.filter((c) => c.goalId === goalId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** "today", "2d", "3w": how long since the newest check-in; null with none. */
export function checkinAge(latest: GoalCheckin | undefined, today: Date): string | null {
  if (!latest) return null;
  const n = Math.max(0, Math.round(dayNo(localIso(today)) - dayNo(localIso(new Date(latest.createdAt)))));
  return n === 0 ? "today" : n < 14 ? `${n}d` : `${Math.floor(n / 7)}w`;
}

/** Does a goal take check-ins (it tracks its own number, not a project's or its key results')? */
export const takesCheckins = (r: GoalRead | undefined): boolean => !!r && r.progress.source === "manual";

/* ---------------- the Today brief's goal line ---------------- */

export interface BriefGoal { goalId: string; name: string; behind: boolean; icon?: string | null; color?: string | null }

/** For the brief: the goal a task moves, among the goals you own or help on (the one furthest
 *  behind first); null when it moves none of yours. */
export function briefGoalLookup(me: string, goals: Goal[], links: GoalLink[], reads: Map<string, GoalRead>): (task: Task) => BriefGoal | null {
  const mine = goals.filter((g) => !g.archivedAt && g.status !== "done" && isGoalPerson(g, me));
  if (!mine.length) return () => null;
  return (task) => {
    const served = goalsForTask(task, mine, links);
    if (!served.length) return null;
    const best = [...served].sort((a, b) => (reads.get(a.id)?.pace?.gap ?? 0) - (reads.get(b.id)?.pace?.gap ?? 0))[0];
    return { goalId: best.id, name: best.name, behind: reads.get(best.id)?.standing === "behind", icon: best.icon ?? null, color: best.color ?? null };
  };
}

/* ---------------- Kanbo noticed ---------------- */

export interface GoalBehind {
  goalId: string;
  name: string;
  /** "key result" or "goal" */
  noun: string;
  /** how far behind, in points of the goal */
  gap: number;
  line: string;
  /** days since the last check-in; null with none */
  sinceCheckin: number | null;
  /** it takes a check-in (it tracks its own number) */
  checkin: boolean;
}

/** The goals you own that are behind pace (key results first, the furthest behind first): the
 *  one-tap check-in Kanbo noticed offers. Only ones that take a check-in. */
export function goalsBehindForMe(me: string, goals: Goal[], reads: Map<string, GoalRead>, checkins: GoalCheckin[], today: Date): GoalBehind[] {
  const todayNo = dayNo(localIso(today));
  return goals
    .filter((g) => !g.archivedAt && g.status !== "done" && g.ownerId === me)
    .map((g) => ({ g, r: reads.get(g.id) }))
    .filter((x): x is { g: Goal; r: GoalRead } => !!x.r && x.r.standing === "behind" && takesCheckins(x.r))
    .sort((a, b) => Number(b.g.kind === "key_result") - Number(a.g.kind === "key_result") || (a.r.pace?.gap ?? 0) - (b.r.pace?.gap ?? 0))
    .map(({ g, r }) => {
      const last = checkinsOf(g.id, checkins)[0];
      return {
        goalId: g.id, name: g.name, noun: g.kind === "key_result" ? "key result" : "goal", gap: -(r.pace?.gap ?? 0),
        line: r.pace?.line ?? "Behind", sinceCheckin: last ? Math.max(0, Math.round(todayNo - dayNo(localIso(new Date(last.createdAt))))) : null,
        checkin: true,
      };
    });
}

/* ---------------- Ask Kanbo ---------------- */

/** What Ask is told about a goal (on the device and in ai-assist's prompt). */
export interface AskGoal {
  id: string;
  name: string;
  period: string;
  status: Goal["status"];
  /** % done */
  pct: number;
  /** % expected by today (null: no pace line) */
  expected: number | null;
  /** "Behind pace by 12%", "On pace", "Past due at 40%", "" */
  pace: string;
  slipping: boolean;
  owner: string;
  kind: string;
  /** nothing is linked to it or its key results */
  noWork: boolean;
}

/** The goals for Ask: the ones you can see, slipping first. */
export function askGoals(goals: Goal[], links: GoalLink[], reads: Map<string, GoalRead>, today: Date, nameOf: (id: string | null | undefined) => string): AskGoal[] {
  return goals
    .filter((g) => !g.archivedAt)
    .map((g): AskGoal => {
      const r = reads.get(g.id);
      return {
        id: g.id, name: g.name, period: periodShort(g, today), status: g.status, pct: r?.pct ?? 0,
        expected: r?.pace && r.pace.state !== "early" ? r.pace.expected : null, pace: r?.pace?.line ?? "",
        slipping: g.status !== "done" && (r?.standing === "behind" || g.status === "at_risk" || g.status === "off_track"),
        owner: g.ownerId ? nameOf(g.ownerId) : "", kind: g.kind === "key_result" ? "key result" : g.kind === "metric" ? "metric" : "goal",
        noWork: (g.workspaceId ?? null) !== null && !hasWorkBehind(g, goals, links),
      };
    })
    .sort((a, b) => Number(b.slipping) - Number(a.slipping) || (a.expected == null ? 0 : a.pct - a.expected) - (b.expected == null ? 0 : b.pct - b.expected));
}
