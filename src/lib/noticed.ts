/* ============================================================
   KANBO — "Kanbo noticed": the few things Kanbo would want to know
   if it were you, for Today's rail. At most three, most pressing
   first, each a bold one-liner, one sentence and at most two
   actions:
   · someone's work is waiting on yours (they're blocked on it);
   · a risk from Radar that touches your work (owners and admins);
   · one of your dates has slipped;
   · a free stretch today before a deadline tomorrow.
   "Not now" waves one away for the day (the view keeps that per
   person). Pure: no React, no storage, no clock of its own.
   ============================================================ */
import type { CalEvent, IconName, Task } from "../data/types";
import type { Risk } from "./radar";
import { clearestStretch, slippingTasks, waitingOnYou } from "./brief";
import { dayMonth, daysBetween, durOf, fmtDuration, fmtTime, fmtTimeRange, isMine, isPlaced, parseDay } from "../components/views/planCanvas";

export type NoticedAction =
  | { kind: "open"; label: string; taskId: string }
  | { kind: "today"; label: string; taskId: string }
  | { kind: "place"; label: string; taskId: string; start: number }
  | { kind: "risks"; label: string };

export interface Noticed {
  /** stable for the thing noticed, so "Not now" keeps it away for the day */
  id: string;
  kind: "waiting" | "risk" | "slipped" | "slot";
  tone: "signal" | "warn" | "accent";
  icon: IconName;
  title: string;
  body: string;
  /** at most two */
  actions: NoticedAction[];
}

export interface NoticedInput {
  /** your tasks (Today's scope) */
  tasks: Task[];
  /** the workspace's tasks: who waits on whom */
  allTasks: Task[];
  /** today's meetings and breaks */
  events: CalEvent[];
  nowMin: number;
  /** YYYY-MM-DD */
  today: string;
  me?: string | null;
  members?: { id: string; name: string }[];
  /** Radar's risks (owners and admins); only those touching your work are shown */
  risks?: Risk[];
  /** ids waved away today */
  dismissed?: Iterable<string>;
  /** default 3 */
  max?: number;
}

const MAX_TITLE = 48;
const short = (s: string) => (s.length > MAX_TITLE ? s.slice(0, MAX_TITLE - 1).trimEnd() + "…" : s);
const day10 = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");
const isOpen = (t: Task) => t.status !== "done" && !t.archivedAt;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** "30 Sep", or "tomorrow" / "today" / "yesterday" near today. */
function when(iso: string, today: string): string {
  const n = daysBetween(today, iso);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  const d = parseDay(iso);
  return d ? dayMonth(d) : iso;
}

/** What Kanbo noticed today, most pressing first (see the file note). */
export function noticedToday({ tasks, allTasks, events, nowMin, today, me, members = [], risks = [], dismissed, max = 3 }: NoticedInput): Noticed[] {
  const skip = new Set(dismissed ?? []);
  const first = (id?: string) => (members.find((m) => m.id === id)?.name ?? "").trim().split(/\s+/)[0] || "A teammate";
  const mine = new Set(allTasks.filter((t) => isMine(t, me)).map((t) => t.id));
  const out: Array<Noticed & { rank: number }> = [];
  const push = (n: Noticed, rank: number) => { if (!skip.has(n.id)) out.push({ ...n, rank }); };
  const onToday = (t: Task) => !!t.planToday || isPlaced(t);

  // 1. someone's waiting on you
  for (const w of waitingOnYou(allTasks, me).slice(0, 2)) {
    const people = [...new Set(w.waiting.map((d) => d.assigneeId))];
    const d = w.waiting[0];
    const blocked = w.waiting.some((x) => x.status === "blocked");
    const who = people.length === 1 ? first(people[0]) : `${people.length} people`;
    push({
      id: `waiting:${w.task.id}`, kind: "waiting", tone: blocked ? "signal" : "accent", icon: blocked ? "lock" : "users",
      title: people.length === 1 ? (blocked ? `${who} is blocked on you` : `${who}'s waiting on you`) : `${who} are waiting on you`,
      body: `${short(d.title)}${w.waiting.length > 1 ? ` and ${plural(w.waiting.length - 1, "more task")}` : ""} can't move until ${short(w.task.title)} is done. It's about ${fmtDuration(durOf(w.task))}.`,
      actions: [
        { kind: "open", label: w.task.status === "review" ? "Review it now" : "Open it", taskId: w.task.id },
        ...(!onToday(w.task) ? [{ kind: "today" as const, label: "Add to today", taskId: w.task.id }] : []),
      ],
    }, blocked ? 0 : 2);
  }

  // 2. a risk touching your work (Radar, for owners and admins)
  for (const r of risks) {
    if (r.severity === "neutral") continue;
    if (!(r.memberId === me || r.taskIds.some((id) => mine.has(id)))) continue;
    if (out.some((n) => n.kind === "waiting" && r.taskIds.includes(n.id.slice("waiting:".length)))) continue; // said already
    push({
      id: `risk:${r.id}`, kind: "risk", tone: r.severity === "signal" ? "signal" : "warn", icon: "radar",
      title: short(r.title), body: r.reason.endsWith(".") ? r.reason : r.reason + ".",
      actions: [...(r.taskIds[0] ? [{ kind: "open" as const, label: "Open it", taskId: r.taskIds[0] }] : []), { kind: "risks", label: "See the risks" }],
    }, r.severity === "signal" ? 1 : 5);
  }

  // 3. a date that's slipped (the most moved first)
  const slipped = slippingTasks(tasks, me)
    .map((t) => ({ t, by: daysBetween(day10(t.originalDueDate), day10(t.dueDate)) }))
    .filter((x) => x.by >= 2)
    .sort((a, b) => b.by - a.by);
  if (slipped[0]) {
    const { t, by } = slipped[0];
    const s = !isPlaced(t) && nowMin < 18 * 60 ? clearestStretch(tasks, events, nowMin, durOf(t)) : null;
    push({
      id: `slipped:${t.id}:${day10(t.dueDate)}`, kind: "slipped", tone: "warn", icon: "hourglass",
      title: `${short(t.title)} has slipped ${plural(by, "day")}`,
      body: `It was due ${when(day10(t.originalDueDate), today)}; now it's ${when(day10(t.dueDate), today)}. It's only ${fmtDuration(durOf(t))}${s ? `, and ${fmtTimeRange(s.start, s.end)} is free today.` : "."}`,
      actions: s ? [{ kind: "place", label: `Put it at ${fmtTime(s.start)}`, taskId: t.id, start: s.start }, { kind: "open", label: "Open it", taskId: t.id }]
        : [{ kind: "open", label: "Open it", taskId: t.id }],
    }, 3);
  }

  // 4. a free stretch today before tomorrow's (or the next day's) deadline
  if (nowMin < 18 * 60) {
    const soon = tasks.filter((t) => isOpen(t) && !t.parentId && isMine(t, me) && !onToday(t) && !!t.dueDate
      && daysBetween(today, day10(t.dueDate)) >= 1 && daysBetween(today, day10(t.dueDate)) <= 2)
      .sort((a, b) => day10(a.dueDate).localeCompare(day10(b.dueDate)) || (b.aiScore ?? 0) - (a.aiScore ?? 0));
    for (const t of soon) {
      const s = clearestStretch(tasks, events, nowMin, durOf(t));
      if (!s) continue;
      push({
        id: `slot:${t.id}`, kind: "slot", tone: "accent", icon: "clock",
        title: `Room today for ${short(t.title)}`,
        body: `It's due ${when(day10(t.dueDate), today)}, and ${fmtTimeRange(s.start, s.end)} is free today.`,
        actions: [{ kind: "place", label: `Put it at ${fmtTime(s.start)}`, taskId: t.id, start: s.start }, { kind: "open", label: "Open it", taskId: t.id }],
      }, 4);
      break;
    }
  }

  return out.sort((a, b) => a.rank - b.rank).slice(0, max).map(({ rank: _r, ...n }) => n);
}
