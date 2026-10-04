// ============================================================
// KANBO — iCalendar (RFC 5545) builder for the private calendar feed.   [f7-calendar]
// Pure module: no Deno globals, no remote imports, only `.ts` relative
// imports — so the ics-feed edge function imports it directly AND the web app
// re-exports it (src/lib/ics.ts) and vitest tests it
// (supabase/functions/_shared/ics.test.ts).
//
// What the feed carries (feedEvents):
//   · planned blocks: the person's own plan for today and the next `days`
//     days, as busy (OPAQUE) timed events in UTC;
//   · due dates (optional): all-day, free (TRANSPARENT) events.
// Done and archived tasks never appear. Every event links back to the app
// (<APP_URL>/?task=<id>) in URL and, because Google Calendar ignores URL, in
// the description too.
//
// Times are written in UTC (…Z), so no VTIMEZONE block is needed; planned
// slots are Europe/London wall-clock minutes, converted with the UK's
// daylight-saving rule (londonWallTimeToUtc).
// ============================================================

export interface IcsEvent {
  /** stable across refreshes, e.g. "plan-<taskId>-<yyyymmdd>@kanbo.co.uk" / "due-<taskId>@kanbo.co.uk" */
  uid: string;
  summary: string;
  description?: string;
  /** back to the app: <APP_URL>/?task=<id> */
  url?: string;
  /** all-day event on this local day (YYYY-MM-DD): DTSTART;VALUE=DATE + DTEND the next day */
  allDay?: { date: string };
  /** timed event, as UTC instants (written as …Z) */
  start?: Date;
  end?: Date;
  /** TRANSP: OPAQUE (busy, the default for timed blocks) or TRANSPARENT (free, the default for due dates) */
  busy?: boolean;
  lastModified?: Date;
}

export interface IcsCalendar {
  /** X-WR-CALNAME, e.g. "Kanbo" */
  name: string;
  description?: string;
  events: IcsEvent[];
  /** DTSTAMP for every event (default: now) */
  now?: Date;
  /** REFRESH-INTERVAL / X-PUBLISHED-TTL hint in minutes (default 15) */
  refreshMinutes?: number;
  /** X-WR-TIMEZONE hint for clients that show floating times (every time here is UTC) */
  timezone?: string;
}

/** The domain in every UID (RFC 5545 recommends a domain on the right of "@"). */
export const ICS_UID_DOMAIN = "kanbo.co.uk";
export const ICS_PRODID = "-//Kanbo//Calendar feed 1.0//EN";

const CRLF = "\r\n";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN = 60_000;
const DAY_MS = 86_400_000;

const isValidDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

/** A real calendar day "YYYY-MM-DD" (not 2026-02-30). */
export function isIcsDay(day: unknown): day is string {
  if (typeof day !== "string" || !DAY_RE.test(day)) return false;
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** "2026-10-04" + n days → "2026-10-05" (calendar arithmetic, no time zones). */
export function addIcsDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------- text */

// lone UTF-16 surrogates can't be written as UTF-8: swap them for U+FFFD
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// RFC 5545 TEXT allows no control characters except HTAB (newlines are escaped)
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, newline. Control
 *  characters (other than tab) are dropped; any newline style becomes \n. */
export function escapeIcsText(s: string): string {
  return String(s ?? "")
    .replace(LONE_SURROGATE, "�")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROLS, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** UTF-8 length of one code point. */
function utf8Len(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** Fold one content line at 75 octets (UTF-8 aware; never splits a character).
 *  Continuation lines start with a single space, which counts towards their 75. */
export function foldIcsLine(line: string): string {
  const parts: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = utf8Len(ch);
    if (bytes + n > 75) {
      parts.push(cur);
      cur = " " + ch;
      bytes = 1 + n;
    } else {
      cur += ch;
      bytes += n;
    }
  }
  parts.push(cur);
  return parts.join(CRLF);
}

/* ---------------------------------------------------------------- dates */

/** 2026-10-04T09:00:00Z → "20261004T090000Z" */
export function icsUtc(d: Date): string {
  if (!isValidDate(d)) throw new RangeError("icsUtc: invalid date");
  return d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/** "2026-10-04" → "20261004" */
export function icsDate(day: string): string {
  if (!isIcsDay(day)) throw new RangeError(`icsDate: not a day: ${String(day)}`);
  return day.replace(/-/g, "");
}

/** The last Sunday of a month (0-based), at 01:00 UTC: when UK clocks change. */
function lastSundayAt1Utc(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0)); // last day of the month
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1, 0);
}

/** Is this UTC instant in British Summer Time? (Since 1996 BST runs from the
 *  last Sunday of March to the last Sunday of October, changing at 01:00 UTC.) */
export function isBritishSummerTime(utcMs: number): boolean {
  const y = new Date(utcMs).getUTCFullYear();
  return utcMs >= lastSundayAt1Utc(y, 2) && utcMs < lastSundayAt1Utc(y, 9);
}

/** A Europe/London wall-clock time on a local day → the UTC instant (BST-aware).
 *  On the spring change day the missing hour (01:00–01:59) moves forward an
 *  hour (01:30 → 02:30 BST); on the autumn day the repeated hour takes its
 *  first, BST, occurrence — the same choice as Temporal's "compatible". */
export function londonWallTimeToUtc(day: string, minutes: number): Date {
  if (!isIcsDay(day)) throw new RangeError(`londonWallTimeToUtc: not a day: ${String(day)}`);
  if (!Number.isFinite(minutes)) throw new RangeError("londonWallTimeToUtc: minutes must be a number");
  const [y, m, d] = day.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d) + Math.round(minutes) * MIN; // the wall time read as if it were UTC
  const asBst = wall - 60 * MIN;
  return new Date(isBritishSummerTime(asBst) ? asBst : wall);
}

/* ---------------------------------------------------------------- calendar */

/** A URI for the URL property: http(s) only, normalised, never a line break. */
function safeUri(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const s = u.toString();
    // eslint-disable-next-line no-control-regex
    return /[\u0000- \u007F]/.test(s) ? null : s;
  } catch {
    return null;
  }
}

function eventLines(e: IcsEvent, stamp: string): string[] | null {
  if (!e || typeof e.uid !== "string" || !e.uid.trim()) return null;
  const lines = ["BEGIN:VEVENT", `UID:${escapeIcsText(e.uid.trim())}`, `DTSTAMP:${stamp}`];
  let busy: boolean;
  if (e.allDay) {
    if (!isIcsDay(e.allDay.date)) return null;
    lines.push(`DTSTART;VALUE=DATE:${icsDate(e.allDay.date)}`, `DTEND;VALUE=DATE:${icsDate(addIcsDays(e.allDay.date, 1))}`);
    busy = e.busy ?? false;
  } else {
    if (!isValidDate(e.start)) return null;
    const end = isValidDate(e.end) && e.end.getTime() > e.start.getTime() ? e.end : new Date(e.start.getTime() + 30 * MIN);
    lines.push(`DTSTART:${icsUtc(e.start)}`, `DTEND:${icsUtc(end)}`);
    busy = e.busy ?? true;
  }
  lines.push(`SUMMARY:${escapeIcsText(e.summary || "Untitled")}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`);
  const url = safeUri(e.url);
  if (url) lines.push(`URL:${url}`);
  lines.push(`TRANSP:${busy ? "OPAQUE" : "TRANSPARENT"}`, "STATUS:CONFIRMED");
  if (isValidDate(e.lastModified)) lines.push(`LAST-MODIFIED:${icsUtc(e.lastModified)}`);
  lines.push("END:VEVENT");
  return lines;
}

/** The whole VCALENDAR: CRLF line endings, lines folded at 75 octets, text
 *  escaped. Events with no usable date (or no UID) are left out rather than
 *  breaking the file. */
export function buildIcs(cal: IcsCalendar): string {
  const now = isValidDate(cal.now) ? cal.now : new Date();
  const stamp = icsUtc(now);
  const every = Math.max(1, Math.round(Number.isFinite(cal.refreshMinutes) ? (cal.refreshMinutes as number) : 15));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${ICS_PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(cal.name || "Kanbo")}`,
  ];
  if (cal.description) lines.push(`X-WR-CALDESC:${escapeIcsText(cal.description)}`);
  if (cal.timezone) lines.push(`X-WR-TIMEZONE:${escapeIcsText(cal.timezone)}`);
  lines.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${every}M`, `X-PUBLISHED-TTL:PT${every}M`);
  for (const e of cal.events ?? []) {
    const ev = eventLines(e, stamp);
    if (ev) lines.push(...ev);
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}

/* ---------------------------------------------------------------- feed */

/** A task row as the ics-feed function reads it (public.tasks_visible_to(user)). */
export interface FeedTaskRow {
  id: string;
  title: string | null;
  status: string;
  project_id: string | null;
  workspace_id: string | null;
  assignee_id: string | null;
  collaborators?: string[] | null;
  due_date: string | null;
  due_time?: string | null;
  archived_at?: string | null;
  scheduled?: number | null;
  plan_today?: boolean | null;
  dur?: number | null;
  focus_min?: number | null;
}
/** The person's own plan rows (public.task_user_state, user_id = them). */
export interface FeedStateRow {
  task_id: string;
  scheduled: number | null;
  plan_today: boolean | null;
  plan_day: string | null;
}
export interface FeedInput {
  userId: string;
  tasks: FeedTaskRow[];
  states: FeedStateRow[];
  /** project id → name (for "Task · Project" titles) */
  projectNames: Record<string, string>;
  /** today in Europe/London, YYYY-MM-DD */
  today: string;
  /** how many days ahead (14) */
  days: number;
  includeDue: boolean;
  /** e.g. "https://www.kanbo.co.uk" (no trailing slash) */
  appUrl: string;
}

/** How many days ahead the feed looks (today + 14). */
export const FEED_DAYS = 14;
/** The most events one feed carries (a runaway plan can't make a huge file). */
export const FEED_MAX_EVENTS = 1500;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STATUS_LABEL: Record<string, string> = { todo: "To do", progress: "In progress", review: "In review", blocked: "Blocked" };

/** "2026-10-07" → "Wed 7 Oct" (en-GB, no time zone involved). */
export function feedDayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[t.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}
/** 90 → "1h 30m", 45 → "45m", 120 → "2h". */
export function feedDuration(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}
/** "15:00" for a valid HH:MM (or HH:MM:SS), else null. */
function hhmm(t: string | null | undefined): string | null {
  const m = typeof t === "string" ? /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(t.trim()) : null;
  return m ? `${m[1]}:${m[2]}` : null;
}
/** A slot on the plan canvas: whole minutes inside the day. */
const validSlot = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 24 * 60;
/** The block's length: dur, else focus_min, else 30 minutes (as the canvas draws it), capped at a day. */
function blockMinutes(t: FeedTaskRow): number {
  const d = (t.dur && t.dur > 0 ? t.dur : 0) || (t.focus_min && t.focus_min > 0 ? t.focus_min : 0) || 30;
  return Math.min(24 * 60, Math.max(5, Math.round(d)));
}
function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 1).join("").trimEnd() + "…" : s;
}
const uidDay = (day: string) => day.replace(/-/g, "");

/** Which tasks become which events: planned blocks (the person's own plan,
 *  today … today+days) and, optionally, due dates as all-day events.
 *  Done and archived tasks never appear.
 *
 *  Whose plan counts (the same rule as the app's lib/planOverlay):
 *  · a task ASSIGNED TO THEM: the task row's plan is theirs and is today's
 *    (plan_today + scheduled); their task_user_state rows only add later days;
 *  · anyone else's task (or an unassigned one): only their own
 *    task_user_state rows, for the day each row is for.
 *  Due dates: tasks assigned to them, tasks they collaborate on, and their
 *  unassigned personal tasks, due today … today+days. */
export function feedEvents(input: FeedInput): IcsEvent[] {
  const { userId, today, appUrl } = input;
  if (!userId || !isIcsDay(today)) return [];
  const days = Math.max(0, Math.min(62, Math.floor(Number.isFinite(input.days) ? input.days : FEED_DAYS)));
  const last = addIcsDays(today, days);
  const inWindow = (day: string | null | undefined): day is string => isIcsDay(day) && day >= today && day <= last;
  const base = String(appUrl || "").replace(/\/+$/, "");
  const link = (id: string) => `${base}/?task=${encodeURIComponent(id)}`;
  const names = input.projectNames ?? {};

  const open = new Map<string, FeedTaskRow>();
  for (const t of input.tasks ?? []) {
    if (!t || typeof t.id !== "string" || !t.id) continue;
    if (t.status === "done" || t.archived_at) continue;
    open.set(t.id, t);
  }
  const isMine = (t: FeedTaskRow) => t.assignee_id === userId;
  const titleOf = (t: FeedTaskRow) => {
    const title = clip((t.title ?? "").trim() || "Untitled task", 200);
    const project = t.project_id ? (names[t.project_id] ?? "").trim() : "";
    return { title, project: project ? clip(project, 80) : "" };
  };

  const out: { e: IcsEvent; key: string }[] = [];
  const seen = new Set<string>();
  const planned = (t: FeedTaskRow, day: string, slot: number) => {
    const uid = `plan-${t.id}-${uidDay(day)}@${ICS_UID_DOMAIN}`;
    if (seen.has(uid)) return;
    seen.add(uid);
    const { title, project } = titleOf(t);
    const len = blockMinutes(t);
    const start = londonWallTimeToUtc(day, slot);
    const due = isIcsDay(t.due_date) ? feedDayLabel(t.due_date) + (hhmm(t.due_time) ? ` at ${hhmm(t.due_time)}` : "") : "";
    const desc = [
      `Planned in Kanbo · ${feedDuration(len)}`,
      project ? `Project: ${project}` : "",
      due ? `Due ${due}` : "",
      `Open in Kanbo: ${link(t.id)}`,
    ].filter(Boolean).join("\n");
    out.push({
      key: start.toISOString() + uid,
      e: { uid, summary: project ? `${title} · ${project}` : title, description: desc, url: link(t.id), start, end: new Date(start.getTime() + len * MIN), busy: true },
    });
  };

  // their own plan on tasks assigned to them: the row is today's plan
  for (const t of open.values()) {
    if (isMine(t) && t.plan_today && validSlot(t.scheduled)) planned(t, today, t.scheduled);
  }
  // their task_user_state rows (for an assigned task, only days after today)
  for (const s of input.states ?? []) {
    const t = s && open.get(s.task_id);
    if (!t || !s.plan_today || !validSlot(s.scheduled) || !inWindow(s.plan_day)) continue;
    if (isMine(t) && s.plan_day === today) continue;
    planned(t, s.plan_day, s.scheduled);
  }

  if (input.includeDue) {
    for (const t of open.values()) {
      if (!inWindow(t.due_date)) continue;
      const theirs = isMine(t)
        || (Array.isArray(t.collaborators) && t.collaborators.includes(userId))
        || (!t.assignee_id && !t.workspace_id);
      if (!theirs) continue;
      const uid = `due-${t.id}@${ICS_UID_DOMAIN}`;
      const { title, project } = titleOf(t);
      const at = hhmm(t.due_time);
      const label = project ? `${title} · ${project}` : title;
      const desc = [
        `Due ${t.due_date === today ? "today" : feedDayLabel(t.due_date)}${at ? ` at ${at}` : ""}`,
        project ? `Project: ${project}` : "",
        STATUS_LABEL[t.status] ? `Status: ${STATUS_LABEL[t.status]}` : "",
        `Open in Kanbo: ${link(t.id)}`,
      ].filter(Boolean).join("\n");
      out.push({
        key: t.due_date + "T00:00:00.000Z" + uid,
        e: { uid, summary: at ? `Due ${at}: ${label}` : `Due: ${label}`, description: desc, url: link(t.id), allDay: { date: t.due_date }, busy: false },
      });
    }
  }

  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out.slice(0, FEED_MAX_EVENTS).map((x) => x.e);
}

/** DTSTAMP for a feed built on `today`: midnight UTC that day. Fixed for the
 *  day, so an unchanged plan produces the same bytes (and the same ETag). */
export function feedStamp(today: string): Date {
  return isIcsDay(today) ? new Date(Date.parse(today + "T00:00:00Z")) : new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS);
}
