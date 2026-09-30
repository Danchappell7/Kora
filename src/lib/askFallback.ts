/* ============================================================
   KANBO — Ask Kanbo on-device: a small rule engine that answers
   and proposes changes without the model. Used in demo mode, when
   Kanbo AI is off or unavailable, and at the daily limit.

   It understands:
   · questions — what's overdue / due today|tomorrow|this week /
     blocked / in review; what is {name} working on; what next;
   · move {selector} to {day} (or back / on a week, by 2 days …);
   · assign {selector} to {name}; mark {selector} done|in progress|…;
     make {selector} urgent|high|medium|low;
   · plan my day|morning|afternoon (opens Today).
   A selector is a title (quoted or fuzzy) or a set: "my unstarted
   tasks this week", "everything due today", "my overdue tasks" …
   It only proposes; nothing changes until the person presses Apply.
   ============================================================ */
import type { Priority, Status, Task } from "../data/types";
import type { AskAction, AskContext, AskPatch, AskResult } from "./askTypes";
import { parseDateText } from "./nlp";
import { fmtDay, isIsoDay } from "./askActions";

export const LOCAL_HELP = "I can find, move, assign and mark tasks on-device. Try “what's overdue?” or “move my unstarted tasks this week to Monday”.";

/* ---------------- dates ---------------- */

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = (s: string): Date => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s: string, n: number): string => { const d = dayOf(s); d.setDate(d.getDate() + n); return iso(d); };
/** Monday and Sunday of the week `today` is in (weeks start on Monday). */
const weekOf = (today: string): { start: string; end: string } => {
  const start = addDays(today, -((dayOf(today).getDay() + 6) % 7));
  return { start, end: addDays(start, 6) };
};

const WEEKDAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const NUMBER: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fortnight: 14 };

/** A time written at the end of a date: "3pm", "at 15:30", "9.30am". */
function takeTime(text: string): { rest: string; time?: string } {
  // "3pm", "9.30am", "15:00", "at 9.30" — a bare "5.10" is a date (dd.mm), not a time
  const m = /(?:^|\s)(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)$/.exec(text)
    ?? /(?:^|\s)(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)$/.exec(text)
    ?? /(?:^|\s)at\s+([01]?\d|2[0-3])\.([0-5]\d)$/.exec(text);
  if (!m) return { rest: text };
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3];
  if (ap) { if (h < 1 || h > 12) return { rest: text }; h = (h % 12) + (ap === "pm" ? 12 : 0); }
  if (h > 23 || min > 59) return { rest: text };
  return { rest: text.slice(0, m.index).trim(), time: `${pad(h)}:${pad(min)}` };
}

const tidy = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[,!?]+$/, "").replace(/\.$/, "").replace(/^(on|by|until|till|for|the)\s+/, "");

/** A day (and maybe a time) written the way people say it. The shared
 *  grammar (nlp.ts parseDateText) decides first; the rules below cover what
 *  it doesn't. Null when it isn't a day. */
export function parseWhen(text: string, today: string): { date: string; time?: string } | null {
  const raw = tidy(text);
  if (!raw) return null;
  try {
    const shared = parseDateText(raw, dayOf(today));
    if (shared?.date && isIsoDay(shared.date)) {
      const time = shared.time ?? takeTime(raw).time;
      return time ? { date: shared.date, time } : { date: shared.date };
    }
  } catch { /* fall through to the rules below */ }
  return parseWhenLocal(raw, today);
}

/** The on-device rules on their own: today / tomorrow, weekdays (the next
 *  one after today; "next fri" is next week's), the weekend, end of the
 *  week or month, "in 3 days", dd/mm(/yy), "5 Oct" / "Oct 5" (next year once
 *  it's passed), ISO, and a trailing time ("3pm", "at 15:30"). */
export function parseWhenLocal(text: string, today: string): { date: string; time?: string } | null {
  const raw = tidy(text);
  if (!raw) return null;
  const { rest, time } = takeTime(raw);
  const w = rest.replace(/^(on|by|until|till|for|the)\s+/, "").trim();
  const out = (date: string | null) => (date ? (time ? { date, time } : { date }) : null);
  if (!w) return time ? out(today) : null;
  if (w === "today" || w === "tonight" || w === "this evening") return out(today);
  if (/^(tomorrow|tmrw|tmr)$/.test(w)) return out(addDays(today, 1));
  if (/^(the )?day after tomorrow$/.test(w)) return out(addDays(today, 2));
  if (/^(this |the )?weekend$/.test(w)) return out(addDays(today, (6 - dayOf(today).getDay() + 7) % 7));
  if (/^next week$/.test(w)) return out(addDays(weekOf(today).start, 7));
  if (/^(the )?end of (the |this )?week$|^eow$/.test(w)) {
    const fri = addDays(weekOf(today).start, 4);
    return out(fri < today ? addDays(fri, 7) : fri);
  }
  if (/^(the )?end of (the |this )?month$|^eom$/.test(w)) {
    const d = dayOf(today);
    return out(iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)));
  }
  let m = /^in (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d{1,3}) (day|days|week|weeks)$/.exec(w) ?? /^in a (fortnight)$/.exec(w);
  if (m) {
    const n = NUMBER[m[1]] ?? Number(m[1]);
    return out(addDays(today, m[2]?.startsWith("week") ? n * 7 : n));
  }
  m = /^(this |next |coming )?(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/.exec(w);
  if (m) {
    const target = WEEKDAY[m[2]];
    const ahead = ((target - dayOf(today).getDay() + 7) % 7) || 7;   // the coming one, never today
    let date = addDays(today, ahead);
    // "next friday" on a Wednesday is the Friday of next week, not this one
    if (m[1]?.trim() === "next" && date <= weekOf(today).end) date = addDays(date, 7);
    return out(date);
  }
  const fromParts = (y: number, mo: number, d: number, explicitYear: boolean): string | null => {
    const date = new Date(y, mo, d);
    if (date.getMonth() !== mo || date.getDate() !== d) return null;
    const s = iso(date);
    return !explicitYear && s < today ? iso(new Date(y + 1, mo, d)) : s;
  };
  const year = dayOf(today).getFullYear();
  m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(w);          // UK: day first
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : year;
    return out(fromParts(y, Number(m[2]) - 1, Number(m[1]), !!m[3]));
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]{3})[a-z]*(?: (\d{4}))?$/.exec(w) ?? null;
  if (m && m[2] in MONTH) return out(fromParts(m[3] ? Number(m[3]) : year, MONTH[m[2]], Number(m[1]), !!m[3]));
  m = /^([a-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(w);
  if (m && m[1] in MONTH) return out(fromParts(m[3] ? Number(m[3]) : year, MONTH[m[1]], Number(m[2]), !!m[3]));
  if (isIsoDay(w)) return out(w);
  return null;
}

/* ---------------- words ---------------- */

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** Small counts in words ("Four of your tasks"), larger ones in figures. */
const num = (n: number, capital = false): string => {
  const s = n <= 10 ? WORDS[n] : String(n);
  return capital ? s[0].toUpperCase() + s.slice(1) : s;
};
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const quote = (t: Task) => `“${t.title}”`;
/** “A”, “B” and 3 more */
function titles(list: Task[], max = 3, suffix?: (t: Task) => string): string {
  const shown = list.slice(0, max).map((t) => quote(t) + (suffix?.(t) ?? ""));
  const more = list.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length <= 1 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const STOP = new Set(["the", "a", "an", "task", "tasks", "to", "of", "for", "on", "in", "and", "my", "with"]);
const tokens = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

/* ---------------- people, projects, tasks ---------------- */

type Person = { id: string; name: string };
/** The context, plus whether this person can only read (a guest). */
type Ctx = AskContext & { readOnly?: boolean };

/** A member by a name as typed: "me", "Maya", "maya lin", "sana r". */
function findMember(text: string, ctx: AskContext): Person | null | "ambiguous" {
  const w = text.toLowerCase().replace(/['’]s$/, "").replace(/^@/, "").trim();
  if (!w) return null;
  if (/^(me|myself|i)$/.test(w)) return ctx.members.find((m) => m.id === ctx.me) ?? { id: ctx.me, name: "you" };
  const exact = ctx.members.filter((m) => m.name.toLowerCase() === w);
  if (exact.length === 1) return exact[0];
  const parts = w.split(/\s+/);
  const hits = ctx.members.filter((m) => {
    const names = m.name.toLowerCase().split(/\s+/);
    return parts.every((p, i) => (i === 0 ? names.some((n) => n.startsWith(p)) : names.slice(1).some((n) => n.startsWith(p))));
  });
  if (hits.length === 1) return hits[0];
  return hits.length > 1 ? "ambiguous" : null;
}

/** A project named (or clearly hinted at) in the text: "on the launch" → Q3 Product Launch. */
function findProject(text: string, ctx: AskContext): Person | null {
  const w = ` ${text.toLowerCase()} `;
  const whole = ctx.projects.filter((p) => w.includes(` ${p.name.toLowerCase()} `));
  if (whole.length === 1) return whole[0];
  const common = new Set(["project", "projects", "team", "work", "the", "and", "personal"]);
  const hits = ctx.projects.filter((p) => p.name.toLowerCase().split(/\s+/).some((word) => word.length >= 4 && !common.has(word) && w.includes(` ${word} `)));
  return hits.length === 1 ? hits[0] : null;
}

/** The task a title (quoted or roughly typed) refers to. */
function findTasks(text: string, tasks: Task[]): Task[] {
  const quoted = /["“”'‘’](.+?)["“”'‘’]/.exec(text)?.[1];
  const want = (quoted ?? text).toLowerCase().replace(/^(the|my|a)\s+/, "").replace(/\s+task$/, "").trim();
  if (!want) return [];
  const exact = tasks.filter((t) => t.title.toLowerCase() === want);
  if (exact.length) return exact;
  const inside = tasks.filter((t) => t.title.toLowerCase().includes(want));
  if (inside.length) return inside;
  const words = tokens(want);
  if (!words.length || !words.some((w) => w.length >= 3)) return [];
  const scored = tasks
    .map((t) => {
      const tw = tokens(t.title);
      const hit = words.filter((w) => tw.some((x) => x.startsWith(w) || (w.length >= 5 && x.startsWith(w.slice(0, -1))))).length;
      return { t, s: hit / words.length };
    })
    .filter((x) => x.s >= 0.6)
    .sort((a, b) => b.s - a.s);
  if (!scored.length) return [];
  return scored.filter((x) => x.s === scored[0].s).map((x) => x.t);
}

const byWork = (a: Task, b: Task) => (b.aiScore ?? 0) - (a.aiScore ?? 0) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");
const openFirst = (list: Task[]) => [...list].sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || byWork(a, b));

/* ---------------- selectors ---------------- */

type Scope = "overdue" | "today" | "tomorrow" | "week" | "nextweek" | null;
const SCOPE_TEXT = { overdue: "overdue", today: "due today", tomorrow: "due tomorrow", week: "due this week", nextweek: "due next week" } as const;

interface Selection {
  tasks: Task[];
  /** matched the set but left alone: already under way ("unstarted" selectors) */
  underway: Task[];
  mine: boolean;
  scope: Scope;
  unstarted: boolean;
  project: Person | null;
  /** a single task picked by its title */
  single: boolean;
}
type Selected = Selection | { error: string; cites?: string[] };

const SET_WORDS = /\b(everything|all|every|anything|unstarted|not started|haven't started|overdue|late|due|today|today's|tomorrow|tomorrow's|this week|this week's|next week|my tasks|my work|my stuff|mine)\b/;
// the words a set selector is made of; anything else narrows it by title or tag
const FILLER = new Set([
  "everything", "all", "every", "anything", "unstarted", "not", "started", "haven", "havent", "untouched", "todo", "overdue", "late",
  "behind", "past", "due", "today", "tomorrow", "this", "next", "week", "mine", "work", "stuff", "that", "which", "are", "is", "have",
  "been", "still", "open", "remaining", "left", "ones", "things", "items", "yet", "ve", "me", "i'm", "im", "i've",
]);

function inScope(t: Task, scope: Scope, today: string): boolean {
  const due = t.dueDate;
  if (!scope) return true;
  if (!due) return false;
  const wk = weekOf(today);
  switch (scope) {
    case "overdue": return due < today;
    case "today": return due === today;
    case "tomorrow": return due === addDays(today, 1);
    case "week": return due >= wk.start && due <= wk.end;
    case "nextweek": return due >= addDays(wk.start, 7) && due <= addDays(wk.end, 7);
  }
}
const scopeOf = (s: string): Scope =>
  /\b(overdue|late|behind|past due)\b/.test(s) ? "overdue"
    : /\btoday('s)?\b/.test(s) ? "today"
      : /\btomorrow('s)?\b/.test(s) ? "tomorrow"
        : /\bnext week('s)?\b/.test(s) ? "nextweek"
          : /\bthis week('s)?\b|\bweek's\b/.test(s) ? "week" : null;

const unquote = (s: string) => s.replace(/["“”]/g, "").trim();

/** Which tasks "{selector}" means: a set ("my unstarted tasks this week",
 *  "everything due today in Brand Refresh") or one task by its title. */
function select(sel: string, tasks: Task[], ctx: AskContext): Selected {
  const s = sel.toLowerCase().trim();
  const live = tasks.filter((t) => !t.archivedAt);
  if (!/["“”]/.test(sel) && SET_WORDS.test(s)) {
    const mine = /\b(my|mine|i|i've|i'm)\b/.test(s);
    const unstarted = /\b(unstarted|not started|haven't started|untouched|to-?do)\b/.test(s);
    const scope = scopeOf(s);
    const project = findProject(s, ctx);
    const projectWords = new Set(project ? tokens(project.name) : []);
    const narrow = tokens(s).filter((w) => !FILLER.has(w) && !projectWords.has(w));
    const base = live.filter((t) => t.status !== "done"
      && (!mine || t.assigneeId === ctx.me)
      && (!project || t.projectId === project.id)
      && inScope(t, scope, ctx.today)
      && (!narrow.length || narrow.every((w) => tokens(t.title).some((x) => x.startsWith(w)) || (t.tags ?? []).some((tag) => tag.toLowerCase().startsWith(w)))));
    return {
      tasks: unstarted ? base.filter((t) => t.status === "todo") : base,
      underway: unstarted ? base.filter((t) => t.status === "progress" || t.status === "review") : [],
      mine, scope, unstarted, project, single: false,
    };
  }
  const found = openFirst(findTasks(sel, live));
  if (!found.length) return { error: `I couldn't find a task called “${unquote(sel)}”.` };
  const open = found.filter((t) => t.status !== "done");
  const pool = open.length ? open : found;
  if (pool.length > 1) {
    return { error: `${num(pool.length, true)} tasks match “${unquote(sel)}”: ${titles(pool, 3)}. Which one did you mean?`, cites: pool.slice(0, 8).map((t) => t.id) };
  }
  return { tasks: [pool[0]], underway: [], mine: false, scope: null, unstarted: false, project: null, single: true };
}

/** "Four of your tasks due this week haven't been started." */
function describe(sel: Selection, n: number): string {
  const who = sel.mine ? (n === 1 ? "One of your tasks" : `${num(n, true)} of your tasks`) : (n === 1 ? "One task" : `${num(n, true)} tasks`);
  const where = sel.project ? ` in ${sel.project.name}` : "";
  if (sel.unstarted) return `${who}${where}${sel.scope ? ` ${SCOPE_TEXT[sel.scope]}` : ""} ${plural(n, "hasn't", "haven't")} been started.`;
  if (sel.scope) return `${who}${where} ${plural(n, "is", "are")} ${SCOPE_TEXT[sel.scope]}.`;
  return `${who}${where} ${plural(n, "is", "are")} still open.`;
}
function nothingFound(sel: Selection): string {
  const whose = sel.mine ? "your tasks" : "the tasks";
  const where = sel.project ? ` in ${sel.project.name}` : "";
  if (sel.unstarted) return `None of ${whose}${where}${sel.scope ? ` ${SCOPE_TEXT[sel.scope]}` : ""} are waiting to be started.`;
  if (sel.scope) return `None of ${whose}${where} are ${SCOPE_TEXT[sel.scope]}.`;
  return `There's nothing open${where} to change.`;
}
const underwayNote = (sel: Selection): string =>
  sel.underway.length ? ` ${cap(titles(sel.underway, 2))} ${plural(sel.underway.length, "is", "are")} already under way, so I've left ${plural(sel.underway.length, "it", "them")} alone.` : "";

/* ---------------- intents ---------------- */

const STATUS_WORDS: [RegExp, Status, string][] = [
  [/^(done|complete|completed|finished|closed)$/, "done", "done"],
  [/^(in progress|started|under way|underway|doing|in-progress|wip)$/, "progress", "in progress"],
  [/^(blocked|stuck)$/, "blocked", "blocked"],
  [/^(in review|review|ready for review)$/, "review", "in review"],
  [/^(to do|todo|to-do|not started|unstarted)$/, "todo", "to do"],
];
const statusWord = (w: string): [Status, string] | null => {
  const hit = STATUS_WORDS.find(([re]) => re.test(w.trim()));
  return hit ? [hit[1], hit[2]] : null;
};

function result(answer: string, actions: AskAction[] = [], cites: string[] = []): AskResult {
  return { answer, actions, cites: [...new Set(cites)], source: "local" };
}
/** An answer that isn't drawn from the tasks (help, a name or day it didn't
 *  follow): no `cites`, so the card makes no "How I got here" claim. */
const aside = (answer: string): AskResult => ({ answer, actions: [], source: "local" });

interface Proposal {
  /** the change for one task, or null when it's already that way */
  patch: (t: Task) => AskPatch | null;
  /** "move", "assign", "mark", "make", "unassign" */
  verb: string;
  /** what follows the task: "to Monday 5 Oct", "as done", "urgent" ("" for none) */
  target: string;
  /** the state when nothing needs doing: "due Monday 5 Oct", "done", "Sana's" */
  already: string;
}

const VERBING: Record<string, string> = { move: "Moving", assign: "Assigning", unassign: "Unassigning", mark: "Marking", make: "Making" };

/** Propose the change for every selected task (skipping the ones already that
 *  way). Read-only (a guest): the answer says what the change would take; the
 *  changes still come back, and validateActions turns them away, so the card
 *  can tell the guest why (and the only gate stays in one place). */
function propose(ctx: Ctx, sel: Selection, p: Proposal): AskResult {
  const target = p.target ? ` ${p.target}` : "";
  const will = (what: string) => (ctx.readOnly ? ` ${VERBING[p.verb] ?? "Changing"} ${what}${target} needs edit access.` : ` I'll ${p.verb} ${what}${target}.`);
  if (!sel.tasks.length) return result(nothingFound(sel) + underwayNote(sel), [], sel.underway.map((t) => t.id));
  const changes = sel.tasks.flatMap((t) => { const patch = p.patch(t); return patch ? [{ t, patch }] : []; });
  const cites = [...sel.tasks, ...sel.underway].map((t) => t.id);
  if (sel.single) {
    const [t] = sel.tasks;
    if (!changes.length) return result(`${quote(t)} is already ${p.already}.`, [], [t.id]);
    return result(will(quote(t)).trim(), [{ op: "update", id: t.id, patch: changes[0].patch }], [t.id]);
  }
  const lead = describe(sel, sel.tasks.length);
  if (!changes.length) return result(`${lead} ${plural(sel.tasks.length, "It's", "They're")} already ${p.already}.${underwayNote(sel)}`, [], cites);
  const skipped = sel.tasks.length - changes.length;
  const them = skipped ? `the other ${num(changes.length)}` : plural(changes.length, "it", "them");
  const skipNote = skipped ? ` ${num(skipped, true)} ${plural(skipped, "is", "are")} already ${p.already}.` : "";
  return result(`${lead}${skipNote}${will(them)}${underwayNote(sel)}`,
    changes.map(({ t, patch }) => ({ op: "update", id: t.id, patch })), cites);
}

function moveIntent(rest: string, tasks: Task[], ctx: Ctx): AskResult | null {
  // relative: "push the deck back a week", "move X by 2 days", "bring X forward a day"
  const rel = /^(.+?)\s+(?:(back|out|forward|later|earlier)\s+)?(?:by\s+)?(a|an|one|two|three|four|five|six|seven|\d{1,2})\s+(day|days|week|weeks)(?:\s+(later|earlier|back|forward))?$/.exec(rest);
  if (rel && !/\s(to|in|until|till|on|for|into)$/.test(rel[1])) {
    const sel = select(rel[1], tasks, ctx);
    if ("error" in sel) return result(sel.error, [], sel.cites);
    const count = NUMBER[rel[3]] ?? Number(rel[3]);
    const weeks = rel[4].startsWith("week");
    const days = count * (weeks ? 7 : 1);
    const sign = /forward|earlier/.test(`${rel[2] ?? ""} ${rel[5] ?? ""}`) ? -1 : 1;
    const span = `${num(count)} ${weeks ? plural(count, "week", "weeks") : plural(count, "day", "days")}`;
    return propose(ctx, sel, {
      patch: (t) => ({ dueDate: addDays(t.dueDate ?? ctx.today, sign * days) }),
      verb: "move", target: `${sign > 0 ? "back" : "forward"} ${span}`, already: "there",
    });
  }
  // absolute: "move {selector} to {day}" — split at the last "to / until / on …" whose right-hand side is a day
  const splits = [...rest.matchAll(/\s(to|until|till|on|for|into)\s/g)].reverse();
  for (const m of splits) {
    const left = rest.slice(0, m.index).trim();
    const right = rest.slice(m.index! + m[0].length).trim();
    if (!left || !right) continue;
    const status = m[1] === "to" ? statusWord(right) : null;
    if (status) return markIntent(left, status, tasks, ctx);
    const when = parseWhen(right, ctx.today);
    if (when) {
      const sel = select(left, tasks, ctx);
      if ("error" in sel) return result(sel.error, [], sel.cites);
      const day = fmtDay(when.date, ctx.today, true) + (when.time ? ` at ${when.time}` : "");
      return propose(ctx, sel, {
        patch: (t) => {
          const patch: AskPatch = {};
          if (t.dueDate !== when.date) patch.dueDate = when.date;
          if (when.time && t.dueTime !== when.time) patch.dueTime = when.time;
          return Object.keys(patch).length ? patch : null;
        },
        verb: "move", target: `to ${day}`, already: `due ${day}`,
      });
    }
    // "move the hero illustration to Brand Refresh"
    const project = (m[1] === "to" || m[1] === "into") ? (ctx.projects.find((p) => p.name.toLowerCase() === right.replace(/^the\s+/, "").replace(/\s+project$/, "")) ?? findProject(right, ctx)) : null;
    if (project) {
      const sel = select(left, tasks, ctx);
      if ("error" in sel) return result(sel.error, [], sel.cites);
      return propose(ctx, sel, { patch: (t) => (t.projectId === project.id ? null : { projectId: project.id }), verb: "move", target: `to ${project.name}`, already: `in ${project.name}` });
    }
  }
  if (splits.length) return aside("I couldn't tell which day you meant. Try “Monday”, “tomorrow”, “next week” or “5/10”.");
  return null;
}

function assignIntent(what: string, who: string, tasks: Task[], ctx: Ctx): AskResult {
  if (/^(no ?one|nobody|none)$/.test(who.trim())) {
    const sel = select(what, tasks, ctx);
    if ("error" in sel) return result(sel.error, [], sel.cites);
    return propose(ctx, sel, { patch: (t) => (t.assigneeId ? { assigneeId: "" } : null), verb: "unassign", target: "", already: "unassigned" });
  }
  const person = findMember(who, ctx);
  if (person === "ambiguous") return aside(`More than one person here is called “${who}”. Try their full name.`);
  if (!person) return aside(`I don't know anyone called “${who}” in this workspace.`);
  const sel = select(what, tasks, ctx);
  if ("error" in sel) return result(sel.error, [], sel.cites);
  const you = person.id === ctx.me;
  return propose(ctx, sel, {
    patch: (t) => (t.assigneeId === person.id ? null : { assigneeId: person.id }),
    verb: "assign", target: `to ${you ? "you" : person.name}`, already: you ? "yours" : `${person.name.split(" ")[0]}'s`,
  });
}

function markIntent(what: string, [status, word]: [Status, string], tasks: Task[], ctx: Ctx): AskResult {
  const sel = select(what, tasks, ctx);
  if ("error" in sel) return result(sel.error, [], sel.cites);
  return propose(ctx, sel, { patch: (t) => (t.status === status ? null : { status }), verb: "mark", target: `as ${word}`, already: word });
}

function priorityIntent(what: string, priority: Priority, tasks: Task[], ctx: Ctx): AskResult {
  const sel = select(what, tasks, ctx);
  if ("error" in sel) return result(sel.error, [], sel.cites);
  const label = priority === "urgent" ? "urgent" : `${priority} priority`;
  return propose(ctx, sel, { patch: (t) => (t.priority === priority ? null : { priority }), verb: "make", target: label, already: label });
}

const reason = (t: Task) => (t.aiReason ? `: ${t.aiReason.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}` : "");

function planIntent(part: string, tasks: Task[], ctx: Ctx): AskResult {
  const mine = tasks.filter((t) => !t.archivedAt && t.status !== "done" && t.assigneeId === ctx.me);
  const due = mine.filter((t) => t.dueDate === ctx.today || (t.planToday && !(t.dueDate && t.dueDate < ctx.today)));
  const late = mine.filter((t) => t.dueDate && t.dueDate < ctx.today);
  const first = [...late, ...due].filter((t) => t.status !== "blocked").sort(byWork)[0];
  const load = due.length && late.length ? `You have ${num(due.length)} ${plural(due.length, "thing", "things")} on today and ${num(late.length)} overdue.`
    : due.length ? `You have ${num(due.length)} ${plural(due.length, "thing", "things")} on today.`
      : late.length ? `You have ${num(late.length)} overdue ${plural(late.length, "task", "tasks")}.`
        : "Nothing is due today.";
  const lead = part === "day" ? load : `For this ${part}: ${load.charAt(0).toLowerCase()}${load.slice(1)}`;
  const start = first ? ` Start with ${quote(first)}${reason(first)}.` : "";
  // a guest can look at Today but can't firm up a plan there
  const next = ctx.readOnly ? " Your day is laid out on Today." : " Your suggested plan is waiting on Today — press Plan my day to make it solid.";
  return result(`${lead}${start}${next}`,
    [{ op: "open", route: { view: "plan" } }], [...late, ...due].map((t) => t.id));
}

const firstNameOf = (id: string, ctx: AskContext): string => ctx.members.find((m) => m.id === id)?.name.split(" ")[0] ?? "a teammate";

/** "What is Maya working on?" */
function personIntent(who: Person, tasks: Task[], ctx: AskContext): AskResult {
  const you = who.id === ctx.me;
  const name = you ? "You" : who.name.split(" ")[0];
  const has = you ? "have" : "has";
  const theirs = tasks.filter((t) => !t.archivedAt && t.status !== "done" && t.assigneeId === who.id);
  const doing = theirs.filter((t) => t.status === "progress" || t.status === "review").sort(byWork);
  const blocked = theirs.filter((t) => t.status === "blocked");
  const soon = theirs.filter((t) => t.status === "todo" && t.dueDate && t.dueDate <= addDays(ctx.today, 7))
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
  const parts: string[] = [];
  parts.push(doing.length
    ? `${name} ${has} ${num(doing.length)} ${plural(doing.length, "thing", "things")} under way: ${titles(doing, 3, (t) => (t.status === "review" ? " (in review)" : ""))}.`
    : `${name} ${has} nothing in progress right now.`);
  if (blocked.length) parts.push(`${cap(titles(blocked, 2))} ${plural(blocked.length, "is", "are")} blocked.`);
  if (soon.length) parts.push(`Next up: ${quote(soon[0])}, due ${fmtDay(soon[0].dueDate!, ctx.today)}${soon.length > 1 ? `, then ${num(soon.length - 1)} more in the next week` : ""}.`);
  else if (!doing.length && !blocked.length) parts.push(`Nothing of ${you ? "yours" : `${name}'s`} is due in the next week either.`);
  return result(parts.join(" "), [], [...doing, ...blocked, ...soon].slice(0, 12).map((t) => t.id));
}

/** Questions about a set: overdue, due today / tomorrow / this week, blocked, in review, in progress. */
function listIntent(q: string, tasks: Task[], ctx: AskContext): AskResult | null {
  const project = findProject(q, ctx);
  const named = /\bfor ([a-z][\w'-]*(?: [a-z][\w'-]*)?)$/.exec(q)?.[1] ?? /\b([a-z]+)'s\b/.exec(q)?.[1];
  const found = named ? findMember(named, ctx) : null;
  const person = found && found !== "ambiguous" ? found : null;
  const personId = person?.id ?? (/\b(my|mine|me|i)\b/.test(q) ? ctx.me : null);
  const pool = tasks.filter((t) => !t.archivedAt && t.status !== "done" && (!personId || t.assigneeId === personId) && (!project || t.projectId === project.id));
  const where = project ? ` in ${project.name}` : "";
  const possessive = (id: string) => (id === ctx.me ? "your" : `${firstNameOf(id, ctx)}'s`);
  const none = (label: string) => `Nothing${personId ? ` of ${personId === ctx.me ? "yours" : `${firstNameOf(personId, ctx)}'s`}` : ""} is ${label}${where}.`;
  /** "Two of Maya's tasks are overdue: “A” and “B”." — when one person owns them all, say so once instead of on every title */
  const say = (list: Task[], label: string, note?: (t: Task) => string) => {
    const owners = new Set(list.map((t) => t.assigneeId || ""));
    const one = personId ?? (owners.size === 1 && [...owners][0] ? [...owners][0] : null);
    const n = list.length;
    const lead = one
      ? `${n === 1 ? "One" : num(n, true)} of ${possessive(one)} tasks ${plural(n, "is", "are")} ${label}${where}`
      : `${num(n, true)} ${plural(n, "task is", "tasks are")} ${label}${where}`;
    const whose = (t: Task) => note?.(t) || (one ? "" : t.assigneeId === ctx.me ? " (yours)" : t.assigneeId ? ` (${firstNameOf(t.assigneeId, ctx)})` : "");
    return result(`${lead}: ${titles(list, 3, whose)}.`, [], list.map((t) => t.id));
  };

  if (/\b(blocked|stuck|waiting on)\b/.test(q)) {
    const openIds = new Set(tasks.filter((x) => x.status !== "done").map((x) => x.id));
    const list = pool.filter((t) => t.status === "blocked" || (t.dependencies ?? []).some((d) => openIds.has(d))).sort(byWork);
    if (!list.length) return result(none("blocked"));
    return say(list, "blocked", (t) => {
      const on = (t.dependencies ?? []).map((d) => tasks.find((x) => x.id === d)).find((x) => x && x.status !== "done");
      return on ? ` (waiting on ${quote(on)})` : "";
    });
  }
  let label: string;
  let list: Task[];
  if (/\b(in review|awaiting review|needs? review|to review)\b/.test(q)) { label = "in review"; list = pool.filter((t) => t.status === "review"); }
  else if (/\b(in progress|under way|underway|being worked on)\b/.test(q)) { label = "in progress"; list = pool.filter((t) => t.status === "progress"); }
  else {
    const scope = scopeOf(q);
    if (!scope) return null;
    label = SCOPE_TEXT[scope];
    list = pool.filter((t) => inScope(t, scope, ctx.today));
  }
  list.sort(byWork);
  return list.length ? say(list, label) : result(none(label));
}

/* ---------------- entry ---------------- */

const normalise = (s: string) => s
  .toLowerCase()
  .replace(/[’‘]/g, "'")
  .replace(/\s+/g, " ")
  .trim()
  .replace(/[?!.]+$/, "")
  .replace(/^(hey |hi |ok |okay )?(kanbo[,:]?\s+)?/, "")
  .replace(/^(please|pls|can you|could you|would you|will you)\s+/, "")
  .replace(/\s+please$/, "")
  .trim();

/** Answer (and propose changes for) a question on-device. Nothing is applied
 *  here. `canAct: false` (a guest, or a host that can't apply changes): the
 *  answer says what a change would take instead of promising it. */
export function localAsk(question: string, tasks: Task[], context: AskContext, opts: { canAct?: boolean } = {}): AskResult {
  const ctx: Ctx = { ...context, readOnly: opts.canAct === false };
  const q = normalise(question);
  if (!q) return aside(LOCAL_HELP);
  let m: RegExpExecArray | null;

  if ((m = /^(?:help me )?plan (?:my |the |this )?(day|morning|afternoon|evening|today)\b/.exec(q))) return planIntent(m[1] === "today" ? "day" : m[1], tasks, ctx);

  if ((m = /^(?:move|reschedule|push|shift|postpone|bump|defer|delay|bring|set the due date (?:of|for)|change the due date (?:of|for))\s+(.+)$/.exec(q))) {
    const moved = moveIntent(m[1], tasks, ctx);
    if (moved) return moved;
  }

  if ((m = /^un-?assign\s+(.+?)(?:\s+from\s+.+)?$/.exec(q))) return assignIntent(m[1], "nobody", tasks, ctx);
  if ((m = /^(?:assign|reassign|give|hand(?: over)?)\s+(.+?)\s+to\s+(.+)$/.exec(q))) return assignIntent(m[1], m[2], tasks, ctx);

  if ((m = /^(?:mark|set|make|change|move|put)\s+(.+?)\s+(?:as\s+|to\s+)?(done|complete|completed|finished|closed|in progress|started|under way|underway|blocked|stuck|in review|review|ready for review|to do|todo|to-do|not started|unstarted)$/.exec(q))) {
    return markIntent(m[1], statusWord(m[2])!, tasks, ctx);
  }
  if ((m = /^(?:complete|finish|close|tick off)\s+(.+)$/.exec(q))) return markIntent(m[1], ["done", "done"], tasks, ctx);
  if ((m = /^start\s+(?:on\s+|working on\s+)?(.+)$/.exec(q))) return markIntent(m[1], ["progress", "in progress"], tasks, ctx);
  if ((m = /^reopen\s+(.+)$/.exec(q))) return markIntent(m[1], ["todo", "to do"], tasks, ctx);
  if ((m = /^(?:make|set|mark|change)\s+(.+?)\s+(?:as\s+|to\s+)?(urgent|high|medium|low)(?: priority)?$/.exec(q))) return priorityIntent(m[1], m[2] as Priority, tasks, ctx);

  // "what is maya working on", "what's sana doing", "maya's tasks", "show me theo's work"
  let unknown: string | null = null;
  if ((m = /^(?:what|which tasks?|what tasks?)(?: is| are| am|'s|'re| does| do)?\s+(.+?)\s+(?:working on|doing|up to|busy with)$/.exec(q))
    || (m = /^(?:show|list|what are|what's on)?\s*(?:me\s+)?([a-z][\w-]*(?: [a-z][\w-]*)?)'s (?:tasks|work|plate|list)$/.exec(q))) {
    const who = m[1].replace(/^(is|are)\s+/, "");
    const person = findMember(/^(i|me|you)$/.test(who) ? "me" : who, ctx);
    if (person === "ambiguous") return aside(`More than one person here is called “${who}”. Try their full name.`);
    if (person) return personIntent(person, tasks, ctx);
    unknown = who;
  }

  if (/^what (should|do|can) i (work on|do|start|pick up|tackle)\b/.test(q) || /^what(?:'s| is) next\b/.test(q)) {
    const mine = tasks.filter((t) => !t.archivedAt && t.status !== "done" && t.status !== "blocked" && t.assigneeId === ctx.me).sort(byWork);
    if (!mine.length) return result("You're all clear — nothing open is assigned to you.");
    const [top] = mine;
    return result(`Start with ${quote(top)}${reason(top)}.`, [{ op: "open", taskId: top.id }], [top.id]);
  }

  const listed = listIntent(q, tasks, ctx);
  if (listed) return listed;
  if (unknown && !/^(everyone|everybody|the team|team|we|you)$/.test(unknown)) return aside(`I don't know anyone called “${unknown}” in this workspace.`);
  return aside(LOCAL_HELP);
}
