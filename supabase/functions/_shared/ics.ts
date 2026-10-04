// ============================================================
// KANBO — iCalendar (RFC 5545) builder for the private calendar feed.   [f7-calendar]
// Pure module: no Deno globals, no remote imports, only `.ts` relative
// imports — so the ics-feed edge function imports it directly AND the web app
// re-exports it (src/lib/ics.ts) and vitest tests it (src/lib/ics.test.ts or
// supabase/functions/_shared/ics.test.ts).
// CONTRACT STUB — f7 replaces the bodies, keeps every exported name/signature.
// ============================================================

export interface IcsEvent {
  /** stable across refreshes, e.g. "plan-<taskId>@kanbo.co.uk" / "due-<taskId>@kanbo.co.uk" */
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
}

/** The whole VCALENDAR: CRLF line endings, lines folded at 75 octets, text escaped. */
export function buildIcs(cal: IcsCalendar): string {
  void cal;
  return "";
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, newline. */
export function escapeIcsText(s: string): string {
  return s;
}

/** Fold one content line at 75 octets (UTF-8 aware; never splits a character). */
export function foldIcsLine(line: string): string {
  return line;
}

/** 2026-10-04T09:00:00Z → "20261004T090000Z" */
export function icsUtc(d: Date): string {
  void d;
  return "";
}

/** "2026-10-04" → "20261004" */
export function icsDate(day: string): string {
  return day.replace(/-/g, "");
}

/** A Europe/London wall-clock time on a local day → the UTC instant (BST-aware). */
export function londonWallTimeToUtc(day: string, minutes: number): Date {
  void minutes;
  return new Date(day + "T00:00:00Z");
}

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

/** Which tasks become which events: planned blocks (the person's own plan,
 *  today … today+days) and, optionally, due dates as all-day events.
 *  Done and archived tasks never appear. */
export function feedEvents(input: FeedInput): IcsEvent[] {
  void input;
  return [];
}
