/* ============================================================
   KANBO — Pulse: the standup that writes itself. What each person
   finished since the last workday, what's on today, what's blocked,
   and how full their week is — built from the tasks and the change
   history (task_events) Kanbo already stores.
   Pure (no React). The sentence and the Slack text are British English.
   ============================================================ */
import type { Task, WorkspaceEvent } from "../data/types";
import { KANBO_TODAY, toLocalISO } from "../data/data";
import { addDays, localDay, round1, startOfWeekMon } from "../components/views/reportingUtils";
import { capacityOf, loadForWeek, type Risk } from "./radar";

export interface PulsePerson {
  id: string;
  name: string;
  role?: string;
  /** guests don't carry team capacity: the load column reads "Guest" */
  guest?: boolean;
  done: Task[];
  onToday: Task[];
  blocked: Task[];
  loadHours: number;
  capacity: number;
}

export interface PulseFacts {
  /** YYYY-MM-DD: the start of the period the facts cover */
  since: string;
  people: PulsePerson[];
  totals: { done: number; inFlight: number; blocked: number; overCapacity: string[] };
  /** YYYY-MM-DD the facts were built for */
  today?: string;
  /** "day" = since the last workday · "week" = since Monday */
  period?: "day" | "week";
  /** how many task changes (task_events) fed the facts; undefined when the history wasn't loaded */
  changes?: number;
}

export type PulsePeriod = "day" | "week";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A local calendar day from an ISO date or a Date (a bad string falls back to today). */
const dayOf = (d: Date | string): Date => {
  if (typeof d === "string") return localDay(d) ?? new Date(KANBO_TODAY);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/** The workday before `today`: Monday (and the weekend) look back to Friday. */
export function lastWorkday(today: Date | string = KANBO_TODAY): string {
  const d = dayOf(today);
  const back = d.getDay() === 1 ? 3 : d.getDay() === 0 ? 2 : 1;   // Mon → Fri · Sun → Fri · Sat → Fri
  return toLocalISO(addDays(d, -back));
}

/** The first day a period covers: the last workday, or this week's Monday. */
export function periodStart(period: PulsePeriod, today: Date | string = KANBO_TODAY): string {
  return period === "week" ? toLocalISO(startOfWeekMon(dayOf(today))) : lastWorkday(today);
}

/** "yesterday" when the period starts yesterday, else the weekday ("Friday"). */
export function sinceWords(since: string, today: Date | string = KANBO_TODAY): string {
  const s = localDay(since), t = dayOf(today);
  if (!s) return "yesterday";
  return toLocalISO(addDays(t, -1)) === toLocalISO(s) ? "yesterday" : WEEKDAYS[s.getDay()];
}

/** "Wed 30 Sep" */
export function fmtPulseDate(iso: string): string {
  const d = localDay(iso);
  return d ? `${WEEKDAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()]}` : iso;
}

const onOrAfter = (iso: string | undefined, since: Date) => { const d = localDay(iso); return !!d && d >= since; };
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const ORDER: Record<string, number> = { progress: 0, review: 1, todo: 2, blocked: 3, done: 4 };

/**
 * Who did what: per person, the tasks finished since `since` (completedAt, or
 * a status change to done in `events`), what's on today (in progress or in
 * review, due today or earlier, or planned for today) and what's blocked,
 * with this week's load against their capacity. Totals cover the whole team.
 */
export function buildPulse(input: {
  tasks: Task[];
  members: { id: string; name: string; role?: string; guest?: boolean }[];
  events?: WorkspaceEvent[];
  today?: string;
  capacities?: Record<string, number>;
  since?: string;
  period?: PulsePeriod;
}): PulseFacts {
  const todayISO = input.today ?? toLocalISO(KANBO_TODAY);
  const today = dayOf(todayISO);
  const period = input.period ?? "day";
  const since = input.since ?? periodStart(period, today);
  const sinceDay = dayOf(since);
  const events = (input.events ?? []).filter((e) => onOrAfter(e.createdAt, sinceDay));
  const doneByEvent = new Set(events.filter((e) => e.field === "status" && e.newValue === "done").map((e) => e.taskId));
  const tasks = input.tasks.filter((t) => !t.archivedAt);

  const done = tasks.filter((t) => t.status === "done" && (onOrAfter(t.completedAt, sinceDay) || doneByEvent.has(t.id)));
  const open = tasks.filter((t) => t.status !== "done");
  const onToday = open.filter((t) => t.status !== "blocked"
    && (t.status === "progress" || t.status === "review" || (!!t.dueDate && t.dueDate <= todayISO) || !!t.planToday));
  const week = loadForWeek(tasks, startOfWeekMon(today), today);

  const byDone = (a: Task, b: Task) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "") || a.title.localeCompare(b.title);
  const byToday = (a: Task, b: Task) => (ORDER[a.status] - ORDER[b.status]) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.title.localeCompare(b.title);

  const people: PulsePerson[] = input.members.map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    guest: m.guest || undefined,
    done: done.filter((t) => t.assigneeId === m.id).sort(byDone),
    onToday: onToday.filter((t) => t.assigneeId === m.id).sort(byToday),
    blocked: open.filter((t) => t.status === "blocked" && t.assigneeId === m.id).sort(byToday),
    loadHours: round1(week.rows.get(m.id)?.hours ?? 0),
    capacity: capacityOf(input.capacities, m.id),
  }));

  // guests last, then the fullest weeks first
  people.sort((a, b) => Number(!!a.guest) - Number(!!b.guest)
    || (b.loadHours / b.capacity) - (a.loadHours / a.capacity)
    || a.name.localeCompare(b.name));

  const over = people.filter((p) => !p.guest && p.loadHours > p.capacity);
  const firsts = new Map<string, number>();
  people.forEach((p) => { const f = firstName(p.name); firsts.set(f, (firsts.get(f) ?? 0) + 1); });
  const shortName = (n: string) => ((firsts.get(firstName(n)) ?? 0) > 1 ? n : firstName(n));

  return {
    since,
    today: todayISO,
    period,
    changes: input.events ? events.length : undefined,
    people,
    totals: {
      done: done.length,
      inFlight: open.filter((t) => t.status === "progress" || t.status === "review").length,
      blocked: open.filter((t) => t.status === "blocked").length,
      overCapacity: over.map((p) => shortName(p.name)),
    },
  };
}

/** A run of the lede: `strong` runs are the figures and names. */
export interface SentencePart { text: string; strong?: boolean }

const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The lede, in runs: "Since yesterday the team finished **6 tasks**. **8** are
 *  in flight, **1** is blocked and **Maya** is over capacity." */
export function pulseSentenceParts(facts: PulseFacts): SentencePart[] {
  const today = facts.today ?? toLocalISO(KANBO_TODAY);
  const { done, inFlight, blocked, overCapacity } = facts.totals;
  const parts: SentencePart[] = [];
  const t = (text: string, strong?: boolean) => parts.push(strong ? { text, strong } : { text });
  const week = facts.period === "week";
  const since = sinceWords(facts.since, today);

  if (done > 0) {
    t(week ? "This week the team has finished " : `Since ${since} the team finished `);
    t(`${done} ${done === 1 ? "task" : "tasks"}`, true);
    t(". ");
  } else {
    t(week ? "Nothing has been finished this week yet. " : `Nothing has been finished since ${since}. `);
  }

  // the second sentence: "8 are in flight, 1 is blocked and Maya is over capacity."
  const clauses: SentencePart[][] = [];
  clauses.push(inFlight === 0 ? [{ text: "nothing is in flight" }] : [{ text: String(inFlight), strong: true }, { text: inFlight === 1 ? " is in flight" : " are in flight" }]);
  if (blocked > 0) clauses.push([{ text: String(blocked), strong: true }, { text: blocked === 1 ? " is blocked" : " are blocked" }]);
  else if (!overCapacity.length) clauses.push([{ text: "nothing is blocked" }]);
  if (overCapacity.length) {
    clauses.push(overCapacity.length > 2
      ? [{ text: `${overCapacity.length} people`, strong: true }, { text: " are over capacity" }]
      : [...overCapacity.flatMap((n, i) => [...(i ? [{ text: " and " }] : []), { text: n, strong: true }]), { text: overCapacity.length === 1 ? " is over capacity" : " are over capacity" }]);
  }
  clauses.forEach((c, i) => {
    if (i > 0) t(i === clauses.length - 1 ? " and " : ", ");
    c.forEach((p) => parts.push({ ...p }));
  });
  // capitalise the second sentence's first letter
  const first = parts.findIndex((p, i) => i > 0 && parts[i - 1].text.endsWith(". "));
  if (first >= 0) parts[first] = { ...parts[first], text: parts[first].text.charAt(0).toUpperCase() + parts[first].text.slice(1) };
  t(".");
  return parts;
}

/** The lede as plain text. */
export function pulseSentence(facts: PulseFacts): string {
  return pulseSentenceParts(facts).map((p) => p.text).join("");
}

const MAX_LISTED = 5;
const titles = (ts: Task[]) => {
  const shown = ts.slice(0, MAX_LISTED).map((t) => t.title.replace(/\s+/g, " ").trim());
  return ts.length > MAX_LISTED ? `${shown.join(", ")} +${ts.length - MAX_LISTED} more` : shown.join(", ");
};

/** Slack-ready text: a bold heading, the lede, then a line per person —
 *  "• *Maya* — done: …; today: …; blocked: …". */
export function pulseMarkdown(facts: PulseFacts): string {
  const today = facts.today ?? toLocalISO(KANBO_TODAY);
  const firsts = new Map<string, number>();
  facts.people.forEach((p) => { const f = firstName(p.name); firsts.set(f, (firsts.get(f) ?? 0) + 1); });
  const lines = facts.people.map((p) => {
    const who = (firsts.get(firstName(p.name)) ?? 0) > 1 ? p.name.trim() : firstName(p.name);
    const bits = [
      p.done.length ? `done: ${titles(p.done)}` : null,
      p.onToday.length ? `today: ${titles(p.onToday)}` : null,
      p.blocked.length ? `blocked: ${titles(p.blocked)}` : null,
    ].filter(Boolean);
    return `• *${who}* — ${bits.length ? bits.join("; ") : "nothing to report"}`;
  });
  return [`*Pulse — ${fmtPulseDate(today)}*`, pulseSentence(facts), "", ...lines].join("\n");
}

/** Slack's *bold* markers stripped, for pasting anywhere else. */
export function plainText(markdown: string): string {
  return markdown.replace(/\*([^*\n]+)\*/g, "$1");
}

/** How many distinct tasks the facts mention (for the provenance line). */
export function pulseTaskCount(facts: PulseFacts): number {
  const ids = new Set<string>();
  facts.people.forEach((p) => [...p.done, ...p.onToday, ...p.blocked].forEach((t) => ids.add(t.id)));
  return ids.size;
}

/** The facts trimmed for Kanbo's "Write it up": names and titles only (no ids,
 *  descriptions or other task fields), bounded so the request stays small. */
export function pulseFactsForAi(facts: PulseFacts, risks: Risk[] = []): unknown {
  const titlesOf = (ts: Task[], n = 8) => ts.slice(0, n).map((t) => t.title.slice(0, 140));
  const byId = new Map<string, Task>();
  facts.people.forEach((p) => [...p.done, ...p.onToday, ...p.blocked].forEach((t) => byId.set(t.id, t)));
  return {
    period: facts.period === "week" ? "this week" : `since ${sinceWords(facts.since, facts.today ?? KANBO_TODAY)}`,
    since: facts.since,
    summary: pulseSentence(facts),
    totals: facts.totals,
    people: facts.people.slice(0, 40).map((p) => ({
      name: p.name,
      role: p.role,
      guest: p.guest || undefined,
      done: titlesOf(p.done),
      today: p.onToday.slice(0, 8).map((t) => ({ title: t.title.slice(0, 140), status: t.status, due: t.dueDate })),
      blocked: titlesOf(p.blocked),
      hoursThisWeek: p.guest ? undefined : p.loadHours,
      capacity: p.guest ? undefined : p.capacity,
    })),
    risks: risks.slice(0, 8).map((r) => ({ title: r.title.slice(0, 200), reason: r.reason.slice(0, 200), severity: r.severity })),
    tasksMentioned: byId.size,
  };
}
