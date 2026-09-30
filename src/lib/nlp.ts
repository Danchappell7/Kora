/* ============================================================
   KANBO — the one natural-language grammar.
   Quick capture, New task, the Today capture, pasted notes and Ask
   all read a task sentence the same way:
     "call Sana fri 3pm ~30m #launch"  →  Fri · 15:00 · 30m estimate ·
                                          Q3 Product Launch · title "call Sana"
   UK first (03/10 is 3 October), case-insensitive. Every token that
   is read comes out of the title and is recorded as a span (offsets
   into the original text), so inputs can highlight it live.

   How it works: one pass per rule, in a fixed order, over a copy of
   the text in which every token already read is blanked out with
   spaces. Offsets never move, a later rule can't read inside an
   earlier token, and what's left is the title.

   data.ts's parseCapture and parseTaskTokens are thin wrappers over
   parseTask (see `kinds`, `nextWeek` and `priorityWords` below).
   ============================================================ */
// (a cycle with data.ts, which wraps parseTask: both sides only use the
// other's exports inside functions, so either may load first)
import { KANBO_TODAY, toLocalISO } from "../data/data";
import type { Priority, Recurrence, EnergyKind } from "../data/types";

export type NlpKind = "date" | "time" | "repeat" | "start" | "priority" | "project" | "person" | "tag" | "duration" | "estimate" | "energy";

export interface NlpContext {
  /** the day relative dates count from (default: the live KANBO_TODAY) */
  today?: Date;
  projects?: { id: string; name: string }[];
  members?: { id: string; name: string }[];
  /** tag dictionary, id → label ("+design" matches either) */
  tags?: Record<string, { label: string }>;
  /** Only these kinds are read; the rest stay in the title (and are still
   *  recognised, so "every mon" never loses its "mon" to a due date). Default: all. */
  kinds?: NlpKind[];
  /** "next week" means next Monday (default), or a week today ("+7") as
   *  data.ts's presetDate and the legacy parsers have always read it. */
  nextWeek?: "monday" | "+7";
  /** Also read the bare words "urgent" and "asap" as high priority, as the
   *  Today capture always has. Off by default: "Urgent care booking" is a title. */
  priorityWords?: boolean;
}

/** Where a recognised token sits in the original text (for live highlighting). */
export interface NlpSpan {
  start: number;
  end: number;
  kind: NlpKind;
  /** what it was read as, in words: "Fri 2 Oct", "15:00", "Every Monday", "Sana Rao" */
  label: string;
}

export interface ParsedTask {
  title: string;
  dueDate?: string;
  dueTime?: string;
  startDate?: string;
  recurrence?: Recurrence;
  priority?: Priority;
  projectId?: string;
  assigneeId?: string;
  tags?: string[];
  focusMin?: number;
  effortHours?: number;
  energy?: EnergyKind;
  planToday?: boolean;
  spans: NlpSpan[];
}

/* ---------------------------------------------------------------------------
   Dates
   --------------------------------------------------------------------------- */

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY_WORDS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTH_WORDS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
// longest spellings first isn't needed (every alternative is followed by a
// "not a letter" check), but it keeps the patterns easy to read
const WD = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat|sun";
const MO = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const ORD = "(?:st|nd|rd|th)?";
/** Every way of writing a day. Resolved by resolveDay. */
const DAY = [
  "day\\s+after\\s+tomorrow",
  "today|tonight|tod|eod|tomorrow|tmrw|tmr",
  "(?:this\\s+|next\\s+)?weekend",
  "next\\s+(?:week|month)",
  "end\\s+of\\s+(?:the\\s+)?(?:week|month)|eow|eom",
  "in\\s+(?:a|an|one|\\d{1,3})\\s*(?:days?|weeks?|wks?|fortnights?|months?|mos?)",
  `(?:this\\s+|next\\s+)?(?:${WD})`,
  `\\d{1,2}${ORD}\\s+(?:of\\s+)?(?:${MO})\\.?(?:\\s+\\d{4})?`,
  `(?:${MO})\\.?\\s+\\d{1,2}${ORD}(?:,?\\s+\\d{4})?`,
  "\\d{1,2}/\\d{1,2}(?:/(?:\\d{4}|\\d{2}))?",
  "\\d{4}-\\d{2}-\\d{2}",
].join("|");
/** words that lead into a date and go with it: "by fri", "due on 3 Oct" */
const LEAD = "(?:(?:due\\s+)?(?:by|on|for|before|until|till)\\s+|due\\s+)?";
// A token stands on its own: after the start, a space, an opening bracket or a
// separator, and not followed by a letter, digit or apostrophe — so "Q3",
// "today's numbers" and "sat-nav" are left alone.
const BEFORE = "(^|[\\s(\\[,;])";
const AFTER = "(?![\\p{L}\\p{N}_'’/-])";
const DATE_RE = new RegExp(`${BEFORE}(${LEAD})(${DAY})${AFTER}`, "giu");
const START_RE = new RegExp(`${BEFORE}((?:from|starting|starts?)\\s+(?:on\\s+)?)(${DAY})${AFTER}`, "giu");

const DAY_MS = 86400000;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
/** same day-of-month n months on, clamped to the month's end (31 Jan + 1 → 28/29 Feb) */
const addMonths = (d: Date, n: number) => {
  const x = new Date(d.getFullYear(), d.getMonth() + n, 1);
  x.setDate(Math.min(d.getDate(), new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate()));
  return x;
};
const validDay = (y: number, m: number, d: number): Date | null => {
  const x = new Date(y, m, d);
  return x.getFullYear() === y && x.getMonth() === m && x.getDate() === d ? x : null;
};
const daysBetween = (a: Date, b: Date) => Math.round((midnight(b).getTime() - midnight(a).getTime()) / DAY_MS);
/** Monday = 0 … Sunday = 6 */
const dowMon = (d: Date) => (d.getDay() + 6) % 7;
/** the Monday that starts next week (weeks run Monday to Sunday) */
const nextMonday = (today: Date) => addDays(today, 7 - dowMon(today));
/** the next `dow` (0 = Sunday) after today, or from today when `orToday` */
const nextWeekday = (today: Date, dow: number, orToday: boolean) => {
  const ahead = (dow - today.getDay() + 7) % 7;
  return addDays(today, ahead === 0 && !orToday ? 7 : ahead);
};
const fullYear = (y?: string) => (!y ? undefined : y.length === 2 ? 2000 + Number(y) : Number(y));

/** "Fri 2 Oct" (with the year when it isn't this year's) */
export function dayLabel(iso: string, today: Date = KANBO_TODAY): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const s = `${WEEKDAY_NAMES[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
  return d.getFullYear() === today.getFullYear() ? s : `${s} ${d.getFullYear()}`;
}

/** A day written in words → the date. Null when it isn't a real day (31/02). */
function resolveDay(raw: string, today: Date, nextWeek: "monday" | "+7"): Date | null {
  const s = raw.toLowerCase().replace(/\s+/g, " ").replace(/,/g, "").trim();
  if (s === "day after tomorrow") return addDays(today, 2);
  if (/^(today|tonight|tod|eod)$/.test(s)) return today;
  if (/^(tomorrow|tmrw|tmr)$/.test(s)) return addDays(today, 1);
  let m = s.match(/^(this |next )?weekend$/);
  if (m) return m[1] === "next " ? addDays(nextMonday(today), 5) : nextWeekday(today, 6, true);
  if (s === "next week") return nextWeek === "+7" ? addDays(today, 7) : nextMonday(today);
  if (s === "next month") return addMonths(today, 1);
  if (/^(end of (the )?week|eow)$/.test(s)) return dowMon(today) <= 4 ? addDays(today, 4 - dowMon(today)) : addDays(nextMonday(today), 4);
  if (/^(end of (the )?month|eom)$/.test(s)) return new Date(today.getFullYear(), today.getMonth() + 1, 0);
  m = s.match(/^in (a|an|one|\d{1,3}) ?(day|week|wk|fortnight|month|mo)s?$/);
  if (m) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : 1;
    const unit = m[2];
    return unit === "day" ? addDays(today, n) : unit === "fortnight" ? addDays(today, 14 * n)
      : unit === "month" || unit === "mo" ? addMonths(today, n) : addDays(today, 7 * n);
  }
  m = s.match(/^(this |next )?([a-z]+)$/);
  if (m && m[2] in WEEKDAY_WORDS) {
    const dow = WEEKDAY_WORDS[m[2]];
    // "next tue" is next week's Tuesday; "this fri" can be today; "fri" is the next one after today
    if (m[1] === "next ") return addDays(nextMonday(today), (dow + 6) % 7);
    return nextWeekday(today, dow, m[1] === "this ");
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validDay(+m[1], +m[2] - 1, +m[3]);
  // a year-less date more than a month back means next year's (as DateChip reads it)
  const build = (y: number | undefined, mo: number, d: number) => {
    if (y !== undefined) return validDay(y, mo, d);
    const x = validDay(today.getFullYear(), mo, d);
    return x && daysBetween(x, today) > 31 ? validDay(x.getFullYear() + 1, mo, d) : x;
  };
  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (m) return build(fullYear(m[3]), +m[2] - 1, +m[1]);                        // dd/mm — UK order
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)\.?(?: (\d{4}))?$/);
  if (m && m[2] in MONTH_WORDS) return build(fullYear(m[3]), MONTH_WORDS[m[2]], +m[1]);
  m = s.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/);
  if (m && m[1] in MONTH_WORDS) return build(fullYear(m[3]), MONTH_WORDS[m[1]], +m[2]);
  return null;
}

/* ---------------------------------------------------------------------------
   Times, repeats, durations, priorities, energy
   --------------------------------------------------------------------------- */

const TIME_RE = new RegExp(
  `${BEFORE}((?:at\\s+)?(?:noon|midday)|(?:at\\s+)?\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)|(?:at\\s+)?(?:[01]?\\d|2[0-3]):[0-5]\\d|at\\s+(?:[01]?\\d|2[0-3])(?:\\.[0-5]\\d)?)(?![\\p{L}\\p{N}_'’:])`,
  "giu",
);
const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
/** "3pm", "at 9.30", "15:00", "noon" → "HH:MM". "at 3" is the afternoon; "at 9" the morning. */
function resolveTime(raw: string): string | null {
  const s = raw.toLowerCase().replace(/^at\s+/, "").replace(/\s+/g, "");
  if (s === "noon" || s === "midday") return "12:00";
  let m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?(am|pm|a\.m\.|p\.m\.)$/);
  if (m) {
    let h = +m[1];
    const min = m[2] ? +m[2] : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    const pm = m[3].startsWith("p");
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    return hhmm(h, min);
  }
  m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  if (h > 23 || min > 59) return null;
  // a bare "at 3" (no minutes, no am/pm) is 15:00 — nobody books 3am by accident
  if (!m[2] && !/:/.test(raw) && h >= 1 && h <= 6) h += 12;
  return hhmm(h, min);
}

const REPEAT_RE = new RegExp(
  `${BEFORE}((?:on\\s+)?weekdays|every\\s+(?:other\\s+)?(?:${WD})|every\\s+(?:day|weekdays?|week|fortnight|month|other\\s+week|(?:2|two)\\s+weeks)|daily|weekly|fortnightly|biweekly|monthly)${AFTER}`,
  "giu",
);
type RepeatSpec = { recurrence: Recurrence; dow?: number; label: string; adjective: boolean };
function resolveRepeat(raw: string): RepeatSpec | null {
  const s = raw.toLowerCase().replace(/\s+/g, " ").replace(/^on /, "");
  let m = s.match(/^every (other )?([a-z]+)$/);
  if (m && m[2] in WEEKDAY_WORDS) {
    const dow = WEEKDAY_WORDS[m[2]];
    return { recurrence: m[1] ? "biweekly" : "weekly", dow, label: `Every ${m[1] ? "other " : ""}${WEEKDAY_NAMES[dow]}`, adjective: false };
  }
  if (s === "every day" || s === "daily") return { recurrence: "daily", label: "Every day", adjective: s === "daily" };
  if (s === "weekdays" || s === "every weekday" || s === "every weekdays") return { recurrence: "weekdays", label: "Every weekday", adjective: false };
  if (s === "every week" || s === "weekly") return { recurrence: "weekly", label: "Every week", adjective: s === "weekly" };
  if (/^(every (fortnight|other week|2 weeks|two weeks)|fortnightly|biweekly)$/.test(s)) {
    return { recurrence: "biweekly", label: "Every 2 weeks", adjective: s === "fortnightly" || s === "biweekly" };
  }
  if (s === "every month" || s === "monthly") return { recurrence: "monthly", label: "Every month", adjective: s === "monthly" };
  return null;
}
/** the first due date of a repeat that didn't say one */
function firstOccurrence(r: RepeatSpec, from: Date): Date {
  if (r.dow !== undefined) return nextWeekday(from, r.dow, true);
  if (r.recurrence === "weekdays") { const d = from.getDay(); return d === 6 ? addDays(from, 2) : d === 0 ? addDays(from, 1) : from; }
  return from;
}

/* Durations: "90m", "45 mins", "1.5h", "3 hrs", "2 hours", "1h30", "1h 30m".
   Not after a comma, or "10,000 hours" would read as 0. */
export const HOURS_RE = /(^|[\s(\[])(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)(?:(\d{1,2})(?:m|mins?|minutes?)?|\s+(\d{1,2})\s*(?:m|mins?|minutes?))?(?![\w'’])/i;
export const MINS_RE = /(^|[\s(\[])(\d+)\s*(?:m|mins?|minutes?)(?![\w'’])/i;
/* Estimates: "~2h", "~30m", "est 3h", "estimate: 1h30" */
const EST_RE = /(^|[\s(\[,;])((?:~\s?|est(?:imate)?\.?:?\s*)(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?)(?:(\d{1,2})(?:m|mins?|minutes?)?|\s+(\d{1,2})\s*(?:m|mins?|minutes?))?)(?![\w'’])/gi;
/* Energy: "deep work" / "focus time" / "focus block" anywhere, or a bare
   "deep" / "focus" as the last word. "Focus group prep" or "Deep dive into
   churn" are titles, not energy. */
export const DEEP_RE = /(^|[\s(\[,;])(deep|focus)(?:[\s-]+(?:work|time|block)(?![\w'’])|(?=[\s.,;:!?)\]]*$))/i;

const PRIO_WORD_RE = /(^|[\s(\[,;])!(urgent|high|medium|med|low)(?![\w'’])/gi;
const PRIO_BANG_RE = /(^|\s)(!{1,3})(?=\s|$)/g;
const PRIO_LEVEL_RE = /(^|[\s(\[,;])p([1-4])(?![\w'’])/gi;
const PRIO_BARE_RE = /(^|[\s(\[,;])(urgent|asap)(?![\w'’])/gi;
const PRIORITY_LABEL: Record<Priority, string> = { urgent: "Urgent priority", high: "High priority", medium: "Medium priority", low: "Low priority" };

const PROJECT_RE = /(^|[\s(\[,;])#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;
const PERSON_RE = /(^|[\s(\[,;])@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu;
const TAG_RE = /(^|[\s(\[,;])\+(\p{L}[\p{L}\p{N}_-]*)/gu;

export const fmtMinutes = (m: number): string => {
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`;
};

/* ---------------------------------------------------------------------------
   Fuzzy names
   --------------------------------------------------------------------------- */

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(norm);

/** "#launch" → "Q3 Product Launch": the whole name, then its start, then any
 *  word's start, then (3+ letters) anywhere in it. */
export function matchProject<P extends { id: string; name: string }>(q: string, projects: P[]): P | undefined {
  const n = norm(q);
  if (!n) return undefined;
  const c = projects.map((p) => ({ p, full: norm(p.name), ws: words(p.name) }));
  return c.find((x) => x.full === n)?.p
    ?? c.find((x) => x.full.startsWith(n))?.p
    ?? (n.length >= 2 ? c.find((x) => x.ws.some((w) => w.startsWith(n)))?.p : undefined)
    ?? (n.length >= 3 && /^\p{L}/u.test(n) ? c.find((x) => x.full.includes(n))?.p : undefined);
}

/** "@sana" → "Sana Rao": first name or full name, then their starts, then (3+ letters) anywhere. */
export function matchMember<M extends { id: string; name: string }>(q: string, members: M[]): M | undefined {
  const n = norm(q);
  if (!n) return undefined;
  const c = members.map((m) => ({ m, full: norm(m.name), ws: words(m.name) }));
  return c.find((x) => x.full === n || x.ws[0] === n)?.m
    ?? c.find((x) => x.full.startsWith(n))?.m
    ?? (n.length >= 2 ? c.find((x) => x.ws.some((w) => w.startsWith(n)))?.m : undefined)
    ?? (n.length >= 3 ? c.find((x) => x.full.includes(n))?.m : undefined);
}

function matchTag(q: string, tags: Record<string, { label: string }>): { id: string; label: string } | undefined {
  const n = norm(q);
  if (!n) return undefined;
  const c = Object.entries(tags).map(([id, t]) => ({ id, label: t.label, full: norm(t.label), key: norm(id) }));
  const hit = c.find((x) => x.key === n || x.full === n) ?? c.find((x) => x.full.startsWith(n) || x.key.startsWith(n));
  return hit ? { id: hit.id, label: hit.label } : undefined;
}

/* ---------------------------------------------------------------------------
   The scanner
   --------------------------------------------------------------------------- */

class Scan {
  readonly src: string;
  private buf: string[];
  private used: Uint8Array;
  readonly spans: NlpSpan[] = [];
  constructor(text: string) {
    this.src = text;
    this.buf = Array.from({ length: text.length }, (_, i) => text[i]);
    this.used = new Uint8Array(text.length);
  }
  /** the text with every token read so far blanked out */
  get text(): string { return this.buf.join(""); }
  isFree(a: number, b: number): boolean {
    for (let i = a; i < b; i++) if (this.used[i]) return false;
    return true;
  }
  usedAfter(i: number): boolean {
    for (let j = i; j < this.used.length; j++) if (this.used[j]) return true;
    return false;
  }
  usedBefore(i: number): boolean {
    for (let j = 0; j < i; j++) if (this.used[j]) return true;
    return false;
  }
  /** mark a token read: blank it out of the title (unless `keep`) and record its span */
  take(a: number, b: number, kind: NlpKind, label: string, keep = false) {
    for (let i = a; i < b; i++) { this.used[i] = 1; if (!keep) this.buf[i] = " "; }
    this.spans.push({ start: a, end: b, kind, label });
  }
  /** recognised but not wanted: left in the title, but no other rule may read inside it */
  shield(a: number, b: number) { for (let i = a; i < b; i++) this.used[i] = 1; }
  /**
   * Walk the matches of `re` (group 1 = the character that led into the token,
   * which isn't part of it) over the current text, and hand each one whose
   * token is still unread to `accept`. The first non-null answer wins.
   */
  find<T>(re: RegExp, accept: (m: RegExpExecArray, at: number, end: number) => T | null): T | null {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const s = this.text;
    let m: RegExpExecArray | null;
    while ((m = g.exec(s))) {
      const at = m.index + (m[1]?.length ?? 0), end = m.index + m[0].length;
      const hit = end > at && this.isFree(at, end) ? accept(m, at, end) : null;
      if (hit !== null) return hit;
      g.lastIndex = m.index + 1; // try again from the next character, not past this match
    }
    return null;
  }
  /** the unread text after `end`, for rules that look ahead */
  after(end: number): string { return this.text.slice(end); }
}

const EDGE_GENTLE = /^[\s,;]+|[\s,;]+$/g;
/** What's left once tokens are cut out: a "()" / "[]" a token sat in (only a
 *  free-standing one — "parseDate()" keeps its brackets), doubled spaces, and
 *  separators stranded at either end (`edge`; the default keeps a leading "-"
 *  or a trailing ":" a title may need). */
export function tidyTitle(s: string, edge: RegExp = EDGE_GENTLE): string {
  return s.replace(/(^|\s)(?:\(\s*\)|\[\s*\])(?=[\s.,;:!?]|$)/g, "$1")
    .replace(/\s+([.,;:!?])(?=\s|$)/g, "$1")   // "Send brief @theo." → "Send brief."
    .replace(/\s{2,}/g, " ").replace(edge, "").trim();
}

// "Review the deck with @sana" shouldn't leave "Review the deck with"
const DANGLING_END = /\s+(?:with|for|to|by|on|at|from|in|and|&|of|due)\s*$/i;
const DANGLING_START = /^\s*(?:to|will|should|and|&)\s+/i;

// sat/sun are also words ("sat nav", "sun cream"): read them as days only when
// something says so — a lead-in ("on sun"), "this"/"next", or nothing after
// them but punctuation, a time, another token or the end
const AMBIGUOUS_DAYS = new Set(["sat", "sun", "tod"]);
const DAY_FOLLOWERS = /^[\s]*(?:$|[,.;:!?)\]]|[#@+!~\d]|(?:at|from|every|by|due|am|pm)(?![\p{L}]))/iu;

const ALL_KINDS: NlpKind[] = ["date", "time", "repeat", "start", "priority", "project", "person", "tag", "duration", "estimate", "energy"];

/**
 * Read a task sentence. Words that are read come out of the title and are
 * listed in `spans` (offsets into `text`). A time with no day means today, and
 * a repeat with no day starts on its first occurrence.
 */
export function parseTask(text: string, ctx: NlpContext = {}): ParsedTask {
  const today = midnight(ctx.today ?? KANBO_TODAY);
  const wanted = new Set(ctx.kinds ?? ALL_KINDS);
  const nextWeek = ctx.nextWeek ?? "monday";
  const scan = new Scan(text);
  const out: ParsedTask = { title: "", spans: scan.spans };
  const iso = (d: Date) => toLocalISO(d);
  /** read it (when this kind is wanted) or just shield it */
  const claim = (kind: NlpKind, a: number, b: number, label: string, keep = false): boolean => {
    if (wanted.has(kind)) { scan.take(a, b, kind, label, keep); return true; }
    scan.shield(a, b);
    return false;
  };

  // 1) repeats — before dates, so "every mon" keeps its "mon"
  let repeat = null as RepeatSpec | null;
  scan.find(REPEAT_RE, (m, at, end) => {
    const r = resolveRepeat(m[2]);
    if (!r) return null;
    // a leading "Weekly review" keeps its adjective in the title (it still repeats)
    const lead = r.adjective && !scan.src.slice(0, at).trim() && !!scan.src.slice(end).trim();
    if (claim("repeat", at, end, r.label, lead)) repeat = r;
    return true;
  });

  // 2) start dates — "from mon", "starting 3 Oct"
  let start = null as Date | null;
  scan.find(START_RE, (m, at, end) => {
    const d = resolveDay(m[3], today, nextWeek);
    if (!d) return null;
    if (claim("start", at, end, `Starts ${dayLabel(iso(d), today)}`)) start = d;
    return true;
  });

  // 3) due dates
  let due = null as Date | null;
  scan.find(DATE_RE, (m, at, end) => {
    const lead = m[2], core = m[3];
    const bare = core.toLowerCase();
    if (!lead && AMBIGUOUS_DAYS.has(bare) && !DAY_FOLLOWERS.test(scan.after(end))) return null;
    // "1/2" is a fraction far more often than 1 February: a day/month needs 4 characters or a year
    if (/^\d{1,2}\/\d{1,2}$/.test(core) && core.length < 4) return null;
    // numbers straight after a comma are data ("A,2026-10-01", "10,000"), not a day
    if (!lead && /^\d/.test(core) && /[,;]/.test(m[1])) return null;
    const d = resolveDay(core, today, nextWeek);
    if (!d) return null;
    if (claim("date", at, end, dayLabel(iso(d), today))) due = d;
    return true;
  });

  // 4) times
  scan.find(TIME_RE, (m, at, end) => {
    const t = resolveTime(m[2]);
    if (!t) return null;
    if (claim("time", at, end, t)) out.dueTime = t;
    return true;
  });

  // 5) estimates, before durations ("est 3h" is not a 3h focus block)
  scan.find(EST_RE, (m, at, end) => {
    const n = parseFloat(m[3]);
    const unit = m[4].toLowerCase();
    const extra = parseInt(m[5] ?? m[6] ?? "0", 10);
    const minutes = unit.startsWith("h") ? Math.round(n * 60) + extra : Math.round(n);
    if (!(minutes > 0)) return null;
    if (claim("estimate", at, end, `${fmtMinutes(minutes)} estimate`)) out.effortHours = Math.round((minutes / 60) * 100) / 100;
    return true;
  });

  // 6) durations (focus minutes)
  const hours = scan.find(HOURS_RE, (m, at, end) => {
    const min = Math.round(parseFloat(m[2]) * 60) + parseInt(m[3] ?? m[4] ?? "0", 10);
    return min > 0 ? { min, at, end } : null;
  });
  const dur = hours ?? scan.find(MINS_RE, (m, at, end) => {
    const min = parseInt(m[2], 10);
    return min > 0 ? { min, at, end } : null;
  });
  if (dur && claim("duration", dur.at, dur.end, fmtMinutes(dur.min))) out.focusMin = dur.min;

  // 7) priority: "!high", then "!!", then "p1", then (optionally) "urgent"/"asap"
  const prio = scan.find(PRIO_WORD_RE, (m, at, end) => {
    const w = m[2].toLowerCase();
    return { p: (w === "med" ? "medium" : w) as Priority, at, end };
  }) ?? scan.find(PRIO_BANG_RE, (m, at, end) => ({ p: (m[2].length >= 3 ? "urgent" : m[2].length === 2 ? "high" : "medium") as Priority, at, end }))
    ?? scan.find(PRIO_LEVEL_RE, (m, at, end) => ({ p: (["urgent", "high", "medium", "low"] as Priority[])[+m[2] - 1], at, end }))
    ?? (ctx.priorityWords ? scan.find(PRIO_BARE_RE, (_m, at, end) => ({ p: "high" as Priority, at, end })) : null);
  if (prio && claim("priority", prio.at, prio.end, PRIORITY_LABEL[prio.p])) out.priority = prio.p;

  // 8) #project, @person, +tags — only a name that matches is read
  scan.find(PROJECT_RE, (m, at, end) => {
    const p = matchProject(m[2], ctx.projects ?? []);
    if (!p) return null;
    if (claim("project", at, end, p.name)) out.projectId = p.id;
    return true;
  });
  scan.find(PERSON_RE, (m, at) => {
    const handle = m[2].replace(/[._-]+$/, "");
    const who = matchMember(handle, ctx.members ?? []);
    if (!who) return null;
    if (claim("person", at, at + 1 + handle.length, who.name)) out.assigneeId = who.id;
    return true;
  });
  const tags: string[] = [];
  if (ctx.tags) {
    for (;;) {
      const hit = scan.find(TAG_RE, (m, at, end) => {
        const t = matchTag(m[2], ctx.tags!);
        return t ? { t, at, end } : null;
      });
      if (!hit) break;
      if (claim("tag", hit.at, hit.end, hit.t.label) && !tags.includes(hit.t.id)) tags.push(hit.t.id);
    }
  }
  if (tags.length) out.tags = tags;

  // 9) energy, last: a bare "focus" only counts as the last word left
  scan.find(new RegExp(DEEP_RE.source, "gi"), (m, at, end) => {
    // a leading "Deep work on the pricing model" IS the title — keep it
    const lead = !scan.text.slice(0, at).trim();
    if (claim("energy", at, end, "Deep work", lead)) out.energy = "deep";
    return true;
  });

  // assemble
  const todayIso = iso(today);
  if (start) out.startDate = iso(start);
  if (due) out.dueDate = iso(due);
  if (repeat) {
    out.recurrence = repeat.recurrence;
    if (!out.dueDate) out.dueDate = iso(firstOccurrence(repeat, start ?? today));
  }
  if (out.dueTime && !out.dueDate) out.dueDate = todayIso;
  if (out.dueTime && out.dueDate === todayIso) out.planToday = true;

  let title = scan.text;
  // a connecting word left hanging where a token was cut out ("Review the
  // deck with @sana", "@sana to send the brief")
  const trimmed = title.replace(/\s+$/, "");
  const endHang = trimmed.match(DANGLING_END);
  if (endHang && scan.usedAfter(trimmed.length)) title = trimmed.slice(0, endHang.index);
  const startHang = title.match(DANGLING_START);
  if (startHang && scan.usedBefore(startHang[0].search(/\S/))) title = title.slice(startHang[0].length);
  out.title = tidyTitle(title);
  out.spans.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * A day and/or time typed on its own ("fri", "3 Oct 15:00", "tomorrow at
 * 9.30"), for date fields: null when the text is anything more than that.
 * A time alone leaves `date` unset (the field keeps its day).
 */
export function parseDateText(text: string, today: Date = KANBO_TODAY): { date?: string; time?: string } | null {
  if (!text.trim()) return null;
  const p = parseTask(text, { today, kinds: ["date", "time"] });
  const hasDate = p.spans.some((s) => s.kind === "date");
  if (!hasDate && !p.dueTime) return null;
  if (p.title.replace(/[\s,.;:–—-]+/g, "")) return null; // other words: not a date
  return { ...(hasDate ? { date: p.dueDate } : {}), ...(p.dueTime ? { time: p.dueTime } : {}) };
}

/** Pasted lines → task titles with their nesting depth. Bullets and
 *  checkboxes are trimmed ("- ", "* ", "• ", "[ ] ", "- [ ] ", "1. "); a tab
 *  or two spaces of indent is one level; blank lines are dropped. */
export function splitLines(text: string): { title: string; depth: number }[] {
  const out: { title: string; depth: number }[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^[\t ]*/)?.[0] ?? "";
    const depth = [...indent].reduce((n, c) => n + (c === "\t" ? 2 : 1), 0) >> 1;
    const title = raw.trim().replace(/^(?:[-*•◦▪‣·–—+]\s+)?(?:\[[ xX]?\]\s+)?(?:\d{1,3}[.)]\s+)?/, "").trim();
    if (title) out.push({ title, depth });
  }
  return out;
}

/** The text cut into plain runs and recognised tokens, for highlighting. */
export function segments(text: string, spans: NlpSpan[]): { text: string; span?: NlpSpan }[] {
  const out: { text: string; span?: NlpSpan }[] = [];
  let i = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < i || s.end > text.length) continue;
    if (s.start > i) out.push({ text: text.slice(i, s.start) });
    out.push({ text: text.slice(s.start, s.end), span: s });
    i = s.end;
  }
  if (i < text.length) out.push({ text: text.slice(i) });
  return out;
}

/** `text` without the tokens of these kinds — for when a field overrides what
 *  was typed (picking a date in the chip drops the "fri" from the title). */
export function stripTokens(text: string, spans: NlpSpan[], kinds: NlpKind[]): string {
  let s = text;
  for (const sp of [...spans].filter((x) => kinds.includes(x.kind)).sort((a, b) => b.start - a.start)) {
    s = s.slice(0, sp.start) + s.slice(sp.end);
  }
  return s.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/g, "");
}
