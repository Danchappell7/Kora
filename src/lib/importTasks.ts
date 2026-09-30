/* ============================================================
   KANBO — task import parser (pure, no React).
   Turns pasted text or an uploaded file into task rows:
   - a plain list (one task per line, bullets/checkboxes stripped),
   - rows copied from Excel / Google Sheets (tab separated), or
   - a CSV exported from Asana, Trello, Jira, Planner, Todoist,
     Monday (via Excel) or Kanbo itself.
   Delimited mode is only used when a recognised header row exists
   or the lines are consistently columnar, so a pasted list like
   "Book venue, catering" is never chopped at the comma.
   ============================================================ */
import type { Priority, Status, Task, TagDef } from "../data/types";
import { TAGS, getMember, parseTaskTokens, toLocalISO } from "../data/data";

/* ---------- public types ---------- */

export type ImportRow = Partial<Task> & {
  title: string;
  /** Section named in the file that doesn't exist in the row's project yet. */
  sectionName?: string;
  /** Tag labels from the file that don't exist in Kanbo yet. */
  newTags?: string[];
  /** Parent task named in the file (Asana "Parent task", Jira "Parent summary", Kanbo export). */
  parentTitle?: string;
  /** Index into the returned rows of this row's parent, when the parent is in the same import. */
  parentIndex?: number;
};

export interface ImportMember { id: string; name: string; email?: string }
export interface ImportProject { id: string; name: string }
export interface ImportSection { id: string; projectId: string; name: string }
export type DateOrder = "dmy" | "mdy";

export type ImportField =
  | "title" | "description" | "status" | "section" | "priority" | "due" | "start" | "completed"
  | "assignee" | "assigneeEmail" | "tags" | "project" | "parent" | "estimate" | "archived"
  | "sourceId" | "rowType" | "ignore";

export interface ImportColumn { index: number; header: string; field: ImportField | null }

export interface ImportOptions {
  projects?: ImportProject[];
  members?: ImportMember[];
  /** Sections of the workspace's projects — lets a "Section" column land in the right section. */
  sections?: ImportSection[];
  /** Tag dictionary (key → def). Defaults to the live TAGS reference data. */
  tags?: Record<string, TagDef>;
  /** Project for rows that don't name one (or name one that doesn't exist). */
  defaultProjectId?: string;
  /** How to read ambiguous numeric dates like 03/04/2026. Default: detected, else day-first (UK). */
  dateOrder?: DateOrder;
  /** Read !priority, #project, @person, dates and durations from free text (lists only). Default true. */
  smartText?: boolean;
  /** "lines" forces one task per line, whatever the text looks like. */
  mode?: "auto" | "lines";
  /** The text came from a .csv file — trust it to be delimited. */
  csv?: boolean;
  /** Append unmapped columns ("Created At: …") to each task's description. */
  extrasToDescription?: boolean;
  /** Maximum rows returned (the rest are counted in totalRows). */
  maxRows?: number;
  /** Reference "today" (tests). */
  today?: Date;
}

export interface ImportWarnings {
  unreadableDates: { count: number; examples: string[] };
  unknownAssignees: { count: number; names: string[] };
  unknownProjects: { count: number; names: string[] };
  unknownStatuses: { count: number; names: string[] };
  newTags: string[];
  missingSections: string[];
  subtasks: number;
  orphanSubtasks: number;
  skippedNoTitle: number;
  skippedArchived: number;
  skippedLeading: number;
  /** "Actions from Monday:" above a bulleted list. */
  skippedHeadings: number;
}

export interface ImportAnalysis {
  rows: ImportRow[];
  mode: "empty" | "lines" | "columns";
  hasHeader: boolean;
  delimiter: "\t" | "," | ";" | null;
  columns: ImportColumn[];
  /** Headers of columns that aren't imported (listed so nothing disappears silently). */
  ignoredColumns: string[];
  /** Order applied to numeric dates like 03/04/2026. */
  dateOrder: DateOrder;
  /** The file has numeric dates that read differently day-first and month-first. */
  ambiguousDates: boolean;
  /** Rows found before the cap was applied. */
  totalRows: number;
  truncated: boolean;
  warnings: ImportWarnings;
}

export const IMPORT_LIMIT = 1000;
const MAX_TITLE = 500;

export const FIELD_LABELS: Record<ImportField, string> = {
  title: "Title", description: "Description", status: "Status", section: "Section", priority: "Priority",
  due: "Due date", start: "Start date", completed: "Completed", assignee: "Assignee", assigneeEmail: "Assignee",
  tags: "Tags", project: "Project", parent: "Parent task", estimate: "Estimate", archived: "Skip if archived",
  sourceId: "Links sub-tasks", rowType: "Row type", ignore: "Not imported",
};

/* ---------- CSV / TSV parsing (RFC 4180, lenient) ---------- */

/**
 * Parses delimited text into records. Handles quoted fields containing the
 * delimiter, newlines and doubled quotes ("") and CRLF/LF/CR line endings.
 * A field that starts with a quote but never closes properly (a stray quote
 * in a title, e.g. `"Quick" wins`) is read literally up to the next
 * delimiter, so one odd cell can never swallow the rest of the file.
 */
export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  const n = text.length;
  let row: string[] = [];
  let i = 0;
  if (!n) return rows;
  for (;;) {
    let field = "";
    let quoted = false;
    if (text[i] === '"') {
      let j = i + 1, buf = "", ok = false;
      while (j < n) {
        const ch = text[j];
        if (ch === '"') {
          if (text[j + 1] === '"') { buf += '"'; j += 2; continue; }
          const nx = text[j + 1];
          if (j + 1 >= n || nx === delim || nx === "\n" || nx === "\r") { ok = true; j += 1; }
          break; // closed properly, or a stray quote → treat the field as unquoted
        }
        buf += ch; j++;
      }
      if (ok) { field = buf; i = j; quoted = true; }
    }
    if (!quoted) {
      let j = i;
      while (j < n && text[j] !== delim && text[j] !== "\n" && text[j] !== "\r") j++;
      field = text.slice(i, j);
      i = j;
    }
    row.push(field);
    if (i >= n) { rows.push(row); break; }
    if (text[i] === delim) { i++; if (i >= n) { row.push(""); rows.push(row); break; } continue; }
    i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1; // line break
    rows.push(row); row = [];
    if (i >= n) break;
  }
  return rows;
}

/* ---------- header recognition ---------- */

export const normHeader = (s: string) =>
  s.replace(/^\uFEFF/, "").toLowerCase().replace(/[_\-/().:#*]+/g, " ").replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim();

const HEADER_ALIASES: Record<Exclude<ImportField, "ignore">, string[]> = {
  title: ["title", "task", "name", "task name", "task title", "card name", "card title", "summary", "item", "item name", "subject", "content", "action item", "to do", "todo"],
  description: ["notes", "note", "description", "card description", "details", "detail", "task description", "body"],
  status: ["status", "task status", "state", "stage", "progress"],
  section: ["section", "section column", "column", "list", "list name", "board column", "group", "bucket", "bucket name"],
  priority: ["priority", "prio", "importance", "urgency", "priority level"],
  due: ["due", "due date", "due on", "due by", "due at", "deadline", "date", "end date", "finish date", "target date"],
  start: ["start", "start date", "start on", "starts", "starts on", "begin date"],
  completed: ["completed", "completed at", "completed on", "completed date", "completion date", "date completed", "done", "done date", "resolved", "resolved at", "resolution date", "closed at", "due complete", "is completed", "complete"],
  assignee: ["assignee", "assignee name", "assigned to", "assigned", "owner", "person", "people", "members", "member", "responsible", "who"],
  assigneeEmail: ["assignee email", "assigned to email", "owner email", "email"],
  tags: ["tags", "tag", "labels", "label"],
  project: ["project", "projects", "project name", "board", "board name"],
  parent: ["parent", "parent task", "parent task name", "parent name", "parent summary", "parent title"],
  estimate: ["estimate", "estimated time", "time estimate", "estimate min", "estimate mins", "estimate minutes", "duration", "focus min", "focus time"],
  archived: ["archived", "is archived"],
  sourceId: ["task id", "id", "card id", "issue key", "issue id", "key", "item id"],
  rowType: ["type"],
};
// Well-known columns from other tools that we deliberately don't import —
// they still count as "recognised" when deciding whether a row is a header.
const KNOWN_IGNORED = new Set([
  "created at", "created", "created on", "created date", "created by", "creator", "reporter", "last modified", "updated",
  "updated at", "modified", "card url", "url", "list id", "board id", "blocked by dependencies", "blocking dependencies",
  "issue type", "attachment count", "attachment links", "checklist item total count", "checklist item completed count",
  "last activity date", "completed by", "late", "resolution", "sprint", "author", "indent", "date lang", "timezone",
  "duration unit", "subtasks", "followers", "collaborators",
]);
const ALIAS_TO_FIELD = new Map<string, ImportField>();
(Object.keys(HEADER_ALIASES) as (keyof typeof HEADER_ALIASES)[]).forEach((f) => HEADER_ALIASES[f].forEach((a) => ALIAS_TO_FIELD.set(a, f)));

function fieldOfHeader(h: string): ImportField | null {
  const k = normHeader(h);
  if (!k) return null;
  const f = ALIAS_TO_FIELD.get(k);
  if (f) return f;
  if (KNOWN_IGNORED.has(k)) return "ignore";
  return null;
}

// Single-line list headings that shouldn't become a task ("To do", "Tasks").
const LIST_HEADINGS = new Set(["title", "task", "tasks", "name", "task name", "to do", "todo", "to do list", "todo list", "todos", "to dos", "action items"]);

/* ---------- value mapping ---------- */

const STATUS_ALIASES: Record<Status, string[]> = {
  todo: ["todo", "to do", "not started", "open", "backlog", "new", "planned", "ready", "up next", "next", "pending", "to start", "selected for development", "queued", "inbox"],
  progress: ["progress", "in progress", "doing", "working on it", "started", "in development", "active", "wip", "ongoing", "underway", "in flight"],
  review: ["review", "in review", "reviewing", "awaiting review", "waiting for review", "ready for review", "qa", "in qa", "testing", "in testing", "approval", "awaiting approval"],
  blocked: ["blocked", "stuck", "on hold", "waiting", "paused", "impeded", "waiting on"],
  done: ["done", "complete", "completed", "finished", "closed", "resolved", "shipped", "delivered"],
};
const STATUS_MAP = new Map<string, Status>();
(Object.keys(STATUS_ALIASES) as Status[]).forEach((s) => STATUS_ALIASES[s].forEach((a) => STATUS_MAP.set(a, s)));

export function mapStatus(v: string): Status | null {
  const k = normHeader(v);
  return k ? STATUS_MAP.get(k) ?? null : null;
}

const PRIORITY_ALIASES: [Priority, string[]][] = [
  ["urgent", ["urgent", "critical", "highest", "blocker", "asap", "p0", "very high", "emergency", "top"]],
  ["high", ["high", "p1", "important", "major"]],
  ["medium", ["medium", "med", "normal", "p2", "moderate", "default"]],
  ["low", ["low", "lowest", "p3", "p4", "minor", "trivial", "someday", "very low"]],
];
export function mapPriority(v: string): Priority | null {
  const k = normHeader(v);
  if (!k) return null;
  for (const [p, list] of PRIORITY_ALIASES) if (list.includes(k)) return p;
  // "1 - High", "⚠️ Critical", "High priority"
  const words = k.split(" ");
  for (const [p, list] of PRIORITY_ALIASES) if (list.some((a) => !a.includes(" ") && words.includes(a))) return p;
  return null;
}

const TRUTHY = new Set(["true", "yes", "y", "x", "1", "done", "complete", "completed", "checked", "✓", "✔", "✔️", "☑", "☑️"]);
const FALSY = new Set(["false", "no", "n", "0", "-", "—", "not completed", "incomplete", "not done", "open", "unresolved"]);

/** Minutes from "90", "90m", "1h 30m", "1.5 hours", "1:30". */
export function parseMinutes(v: string): number | null {
  const t = v.trim().toLowerCase();
  if (!t) return null;
  const clamp = (n: number) => (n > 0 ? Math.min(24 * 60, Math.round(n)) : null);
  const hm = t.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) return clamp(+hm[1] * 60 + +hm[2]);
  if (/^\d+(?:\.\d+)?$/.test(t)) return clamp(parseFloat(t));
  let total = 0, found = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|days?|d)\b/g)) {
    const n = parseFloat(m[1]); const u = m[2];
    total += u.startsWith("h") ? n * 60 : u.startsWith("d") ? n * 8 * 60 : n;
    found = true;
  }
  return found ? clamp(total) : null;
}

/* ---------- dates ---------- */

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function monthIndex(tok: string): number {
  const t = tok.toLowerCase().replace(/\.$/, "");
  if (t.length < 3) return -1;
  if (t === "sept") return 8;
  return MONTH_NAMES.findIndex((m) => m.startsWith(t));
}
function ymd(y: number, m: number, d: number): string | null {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2200)) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null; // 31/02 etc.
  return toLocalISO(dt);
}
const fullYear = (y: string) => (y.length === 2 ? 2000 + +y : +y);
/** Year for a day/month with no year: whichever of last/this/next year lands closest to today. */
function nearestYear(m: number, d: number, today: Date): number {
  const base = today.getFullYear();
  let best = base, bestDiff = Infinity;
  for (const y of [base - 1, base, base + 1]) {
    const diff = Math.abs(new Date(y, m - 1, d).getTime() - today.getTime());
    if (diff < bestDiff) { bestDiff = diff; best = y; }
  }
  return best;
}

type NumericDate = { a: number; b: number; y: number | null };
function numericParts(t: string): NumericDate | null {
  const m = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?(?:[T\s,].*)?$/);
  if (!m) return null;
  return { a: +m[1], b: +m[2], y: m[3] ? fullYear(m[3]) : null };
}

/**
 * Reads a date cell into YYYY-MM-DD, or null. Accepts ISO dates/timestamps,
 * dd/mm/yyyy and d/m/yy (or mm/dd when `order` is "mdy" — an impossible
 * day-first reading such as 12/31 is swapped automatically), month names
 * ("31 Oct 2026", "Oct 31", Jira's "30/Sep/26 10:15 AM"), compact 20261031,
 * Excel serial numbers and today/tomorrow/yesterday.
 */
export function parseImportDate(raw: string, order: DateOrder = "dmy", today: Date = new Date()): string | null {
  let t = raw.trim().replace(/^'/, "");
  if (!t) return null;
  const lower = t.toLowerCase();
  const offset = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return toLocalISO(d); };
  if (lower === "today") return offset(0);
  if (lower === "tomorrow") return offset(1);
  if (lower === "yesterday") return offset(-1);

  // ISO: 2026-10-31, 2026/10/31, 2026-10-31T09:00:00Z
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(.*)$/);
  if (m) {
    const rest = m[4].trim();
    // a timestamp with a zone (Trello's 2026-10-31T23:00:00.000Z) → local calendar day
    if (/^[T\s]\d{1,2}:\d{2}/.test(m[4]) && /(z|[+-]\d{2}:?\d{2})$/i.test(rest)) {
      const d = new Date(t);
      if (!isNaN(d.getTime())) return toLocalISO(d);
    }
    if (rest === "" || /^[T\s]/.test(m[4])) return ymd(+m[1], +m[2], +m[3]);
    return null;
  }
  // compact 20261031
  m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  // Excel serial day number (1954–2119); the fraction is the time of day
  m = t.match(/^(\d{5})(?:\.\d+)?$/);
  if (m) {
    const serial = +m[1];
    if (serial < 20000 || serial > 80000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  // numeric day/month[/year]
  const np = numericParts(t);
  if (np) {
    let day = order === "dmy" ? np.a : np.b, mon = order === "dmy" ? np.b : np.a;
    if (mon > 12 && day <= 12) [day, mon] = [mon, day]; // only one reading is possible
    return ymd(np.y ?? nearestYear(mon, day, today), mon, day);
  }
  // month names — drop a weekday and ordinals first ("Tue 31st Oct 2026")
  t = t.replace(/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i, "").replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  m = t.match(/^(\d{1,2})[\s/.-]+([a-z]{3,9})\.?(?:[\s/.,-]+(\d{4}|\d{2}))?(?:[\s,T].*)?$/i);
  if (m) {
    const mi = monthIndex(m[2]);
    if (mi < 0) return null;
    return ymd(m[3] ? fullYear(m[3]) : nearestYear(mi + 1, +m[1], today), mi + 1, +m[1]);
  }
  m = t.match(/^([a-z]{3,9})\.?[\s/.-]+(\d{1,2})(?:[\s,/.-]+(\d{4}))?(?:[\s,T].*)?$/i);
  if (m) {
    const mi = monthIndex(m[1]);
    if (mi < 0) return null;
    return ymd(m[3] ? +m[3] : nearestYear(mi + 1, +m[2], today), mi + 1, +m[2]);
  }
  return null;
}

/** Evidence for day-first vs month-first from numeric dates like 31/10 or 10/31. */
function dateOrderEvidence(cells: string[]): { dmy: number; mdy: number; ambiguous: number } {
  let dmy = 0, mdy = 0, ambiguous = 0;
  for (const c of cells) {
    const np = numericParts(c.trim());
    if (!np) continue;
    if (np.a > 12 && np.b <= 12) dmy++;
    else if (np.b > 12 && np.a <= 12) mdy++;
    else if (np.a !== np.b) ambiguous++;
  }
  return { dmy, mdy, ambiguous };
}

/* ---------- matching helpers ---------- */

const normName = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}@.+ ]+/gu, " ").replace(/\s+/g, " ").trim();
const EMAIL_RE = /[^\s<>"',;()]+@[^\s<>"',;()]+\.[^\s<>"',;()]+/;
const UNASSIGNED = new Set(["", "unassigned", "none", "nobody", "no one", "-", "—", "n a", "na"]);

function memberEmail(m: ImportMember): string {
  return (m.email || getMember(m.id)?.email || "").toLowerCase();
}

/** Finds a member by email, full name, or an unambiguous first name. */
export function matchMember(raw: string, members: ImportMember[]): ImportMember | null {
  const email = raw.match(EMAIL_RE)?.[0].toLowerCase();
  if (email) {
    const byEmail = members.find((m) => memberEmail(m) === email);
    if (byEmail) return byEmail;
  }
  const name = normName(raw.replace(/<[^>]*>/g, "").replace(EMAIL_RE, ""));
  if (!name) return null;
  const exact = members.filter((m) => normName(m.name) === name);
  if (exact.length === 1) return exact[0];
  if (!name.includes(" ")) {
    const first = members.filter((m) => normName(m.name).split(" ")[0] === name);
    if (first.length === 1) return first[0];
    // "sarah" ↔ sarah.jones@…
    const local = members.filter((m) => memberEmail(m).split("@")[0].split(/[._-]/)[0] === name);
    if (local.length === 1) return local[0];
  }
  return null;
}

const normProject = (s: string) => normName(s).replace(/[^\p{L}\p{N} ]+/gu, "").trim();

function splitList(v: string): string[] {
  return v.split(/[,;|\n]+/).map((s) => s.trim()).filter(Boolean);
}

/** Makes a string safe to show as a warning example. */
const clip = (s: string, n = 32) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// an apostrophe that a spreadsheet export put in front of = + - @ to stop formulas
const unguard = (s: string) => s.replace(/^'(?=[=+\-@\t\r])/, "");

/** Protects "tomorrow's" / "today's" from the natural-language date parser. */
function protectPossessives(s: string): { text: string; restore: (t: string) => string } {
  const saved: string[] = [];
  const text = s.replace(/\b(today|tomorrow|tonight|next week)(['’]s)\b/gi, (m) => {
    saved.push(m);
    return String.fromCharCode(0xe000 + saved.length - 1);
  });
  return { text, restore: (t) => t.replace(/[\ue000-\ue0ff]/g, (c) => saved[c.charCodeAt(0) - 0xe000] ?? "") };
}

function capTitle(row: ImportRow) {
  if (row.title.length <= MAX_TITLE) return;
  const full = row.title;
  row.title = full.slice(0, MAX_TITLE - 1).trimEnd() + "…";
  row.description = row.description ? `${full}\n\n${row.description}` : full;
}

/* ---------- mode detection ---------- */

type Detected =
  | { mode: "lines"; lines: string[]; skippedLeading: number }
  | { mode: "columns"; delim: "\t" | "," | ";"; records: string[][]; headerIdx: number };

function modalCount(records: string[][]): { count: number; share: number } {
  const freq = new Map<number, number>();
  records.forEach((r) => freq.set(r.length, (freq.get(r.length) || 0) + 1));
  let count = 0, best = 0;
  freq.forEach((v, k) => { if (v > best || (v === best && k > count)) { best = v; count = k; } });
  return { count, share: records.length ? best / records.length : 0 };
}

function findHeader(records: string[][], relaxed: boolean): { idx: number; known: number } | null {
  const scan = Math.min(records.length, 10);
  const { count, share } = modalCount(records);
  const consistent = records.length >= 2 && count >= 2 && share >= 0.8;
  for (let k = 0; k < scan; k++) {
    const cells = records[k].map((c) => c.trim());
    const fields = cells.map(fieldOfHeader);
    if (!fields.includes("title")) continue;
    const known = fields.filter((f) => f && f !== "title").length;
    const shortCells = cells.every((c) => c.length <= 60);
    if (!shortCells) continue;
    // a header lower down the file (Monday exports put a board name first) must look unmistakably like one
    if (k > 0 && known < 2) continue;
    if (known >= 1 || (relaxed && (cells.length >= 2 || records.length > 1))) return { idx: k, known };
    // "Title,Budget,Team" pasted with commas: a title header over consistent columns,
    // where every header cell reads like a column name rather than a sentence
    const headerLike = cells.every((c) => /^\p{L}/u.test(c) && c.length <= 40 && c.split(/\s+/).length <= 4 && !/[.!?:]$/.test(c));
    if (k === 0 && consistent && headerLike && records[0].length === count) return { idx: k, known };
  }
  return null;
}

const isBlankRecord = (r: string[]) => r.every((c) => c.trim() === "");

function detect(clean: string, opts: ImportOptions, members: ImportMember[]): Detected {
  const lines = () => {
    const ls = clean.split(/\r\n|\n|\r/).map((l) => l.trim()).filter(Boolean);
    const skip = ls.length > 1 && LIST_HEADINGS.has(normHeader(ls[0])) ? 1 : 0;
    return { mode: "lines" as const, lines: ls.slice(skip), skippedLeading: skip };
  };
  if (opts.mode === "lines") return lines();
  const cands = (["\t", ",", ";"] as const).filter((d) => clean.includes(d));
  if (opts.csv && !cands.length) cands.push(",");
  const parsed = cands.map((d) => ({ d, recs: parseDelimited(clean, d).filter((r) => !isBlankRecord(r)) }));

  // 1) a recognised header row wins — pick the delimiter that recognises the most columns
  let best: { d: "\t" | "," | ";"; recs: string[][]; idx: number; score: number } | null = null;
  for (const { d, recs } of parsed) {
    if (!recs.length) continue;
    const h = findHeader(recs, d === "\t" || !!opts.csv);
    if (!h) continue;
    const score = h.known * 10 + (d === "\t" ? 2 : d === "," ? 1 : 0);
    if (!best || score > best.score) best = { d, recs, idx: h.idx, score };
  }
  if (best) return { mode: "columns", delim: best.d, records: best.recs, headerIdx: best.idx };

  // 2) no header — only treat as columns when the rows are consistently columnar
  for (const { d, recs } of parsed) {
    if (recs.length < 2 && !opts.csv) continue;
    const { count, share } = modalCount(recs);
    if (count < 2 || share < 0.8) continue;
    if (d === "\t" || opts.csv) return { mode: "columns", delim: d, records: recs, headerIdx: -1 };
    // commas/semicolons also appear in ordinary sentences — require at least one
    // column that clearly holds dates, priorities, statuses or people
    const typed = classifyColumns(recs, count, members).some((c, i) => i > 0 && c !== "text" && c !== "empty" && c !== "number");
    if (typed) return { mode: "columns", delim: d, records: recs, headerIdx: -1 };
  }
  return lines();
}

type ColKind = "date" | "priority" | "status" | "person" | "number" | "text" | "empty";
function classifyColumns(records: string[][], width: number, members: ImportMember[]): ColKind[] {
  const kinds: ColKind[] = [];
  for (let c = 0; c < width; c++) {
    const vals = records.map((r) => (r[c] ?? "").trim()).filter(Boolean);
    if (!vals.length) { kinds.push("empty"); continue; }
    const share = (fn: (v: string) => boolean) => vals.filter(fn).length / vals.length;
    if (share((v) => /^\d+(?:\.\d+)?$/.test(v) && !/^\d{5}$/.test(v)) >= 0.8) kinds.push("number");
    else if (share((v) => !!parseImportDate(v, "dmy")) >= 0.8) kinds.push("date");
    else if (share((v) => !!mapPriority(v)) >= 0.8) kinds.push("priority");
    else if (share((v) => !!mapStatus(v)) >= 0.8) kinds.push("status");
    else if (share((v) => EMAIL_RE.test(v) || !!matchMember(v, members)) >= 0.8) kinds.push("person");
    else kinds.push("text");
  }
  return kinds;
}

/* ---------- main entry ---------- */

const emptyWarnings = (): ImportWarnings => ({
  unreadableDates: { count: 0, examples: [] }, unknownAssignees: { count: 0, names: [] },
  unknownProjects: { count: 0, names: [] }, unknownStatuses: { count: 0, names: [] },
  newTags: [], missingSections: [], subtasks: 0, orphanSubtasks: 0,
  skippedNoTitle: 0, skippedArchived: 0, skippedLeading: 0, skippedHeadings: 0,
});

const pushName = (bucket: { count: number; names: string[] }, name: string) => {
  bucket.count++;
  const n = clip(name.trim());
  if (n && !bucket.names.some((x) => x.toLowerCase() === n.toLowerCase())) bucket.names.push(n);
};

export function analyseImport(raw: string, opts: ImportOptions = {}): ImportAnalysis {
  const projects = opts.projects ?? [];
  const members = opts.members ?? [];
  const tagDict = opts.tags ?? TAGS;
  const today = opts.today ?? new Date();
  const smart = opts.smartText !== false;
  const limit = opts.maxRows ?? IMPORT_LIMIT;
  const warnings = emptyWarnings();
  const clean = raw.replace(/^\uFEFF/, "");
  const base: ImportAnalysis = {
    rows: [], mode: "empty", hasHeader: false, delimiter: null, columns: [], ignoredColumns: [],
    dateOrder: opts.dateOrder ?? "dmy", ambiguousDates: false, totalRows: 0, truncated: false, warnings,
  };
  if (!clean.trim()) return base;

  const det = detect(clean, opts, members);
  const out: ImportRow[] = [];
  const rowParents: { parents: string[]; ids: string[] }[] = [];
  // rows whose section also mapped to a status: keep the section only if it exists
  const softSection = new WeakSet<ImportRow>();

  const applyTokens = (text: string, row: ImportRow) => {
    const p = protectPossessives(text);
    const parsed = parseTaskTokens(p.text, projects, members);
    row.title = p.restore(parsed.title) || text;
    if (parsed.priority) row.priority = parsed.priority;
    if (parsed.dueDate) row.dueDate = parsed.dueDate;
    if (parsed.projectId) row.projectId = parsed.projectId;
    if (parsed.assigneeId) row.assigneeId = parsed.assigneeId;
    if (parsed.focusMin) { row.focusMin = parsed.focusMin; row.dur = parsed.focusMin; }
  };

  if (det.mode === "lines") {
    warnings.skippedLeading = det.skippedLeading;
    const BULLET = /^(?:[-*+•◦▪‣–—]|\d{1,3}[.)]|\[[ xX]\])\s+/;
    const bulleted = det.lines.some((l) => BULLET.test(l));
    for (const line of det.lines) {
      let s = line;
      // "Actions from Monday:" above a bulleted list is a heading, not a task
      if (bulleted && !BULLET.test(s) && /:$/.test(s)) { warnings.skippedHeadings++; continue; }
      const wrapped = s.match(/^"((?:[^"]|"")*)"$/);
      if (wrapped) s = wrapped[1].replace(/""/g, '"').trim();
      const row: ImportRow = { title: "" };
      const box = s.match(/^(?:[-*+•◦▪‣–—]\s+)?\[( |x|X)\]\s+/);
      if (box) { if (box[1] !== " ") row.status = "done"; s = s.slice(box[0].length); }
      else s = s.replace(/^(?:[-*+•◦▪‣–—]|\d{1,3}[.)])\s+/, "");
      s = s.trim();
      if (!s) continue;
      if (smart) applyTokens(s, row); else row.title = s;
      if (!row.title.trim()) row.title = s;
      capTitle(row);
      out.push(row); rowParents.push({ parents: [], ids: [] });
    }
    base.mode = "lines";
  } else {
    const { records, headerIdx, delim } = det;
    const hasHeader = headerIdx >= 0;
    const header = hasHeader ? records[headerIdx] : [];
    const body = records.slice(hasHeader ? headerIdx + 1 : 0);
    warnings.skippedLeading = hasHeader ? headerIdx : 0;
    const width = body.reduce((w, r) => Math.max(w, r.length), header.length);

    // map columns → fields
    const fields: (ImportField | null)[] = [];
    const textCols: number[] = [];
    if (hasHeader) {
      const seen = new Set<ImportField>();
      const multi = new Set<ImportField>(["description", "tags", "parent", "sourceId", "ignore"]);
      for (let c = 0; c < width; c++) {
        const f = fieldOfHeader(header[c] ?? "");
        if (f && !multi.has(f) && seen.has(f)) { fields.push(null); continue; } // first one wins
        if (f) seen.add(f);
        fields.push(f);
      }
    } else {
      const kinds = classifyColumns(body, width, members);
      let titleCol = kinds.findIndex((k) => k === "text");
      if (titleCol < 0) titleCol = 0;
      const dateCols = kinds.map((k, i) => (k === "date" && i !== titleCol ? i : -1)).filter((i) => i >= 0);
      for (let c = 0; c < width; c++) {
        const k = kinds[c];
        if (c === titleCol) fields.push("title");
        else if (k === "date") fields.push(dateCols.length > 1 && c === dateCols[0] ? "start" : c === dateCols[dateCols.length - 1] ? "due" : null);
        else if (k === "priority") fields.push(fields.includes("priority") ? null : "priority");
        else if (k === "status") fields.push(fields.includes("status") ? null : "status");
        else if (k === "person") fields.push(fields.includes("assignee") ? null : "assignee");
        else if (k === "text") { fields.push("description"); textCols.push(c); }
        else fields.push(null);
      }
    }
    // an ID column only matters for linking sub-tasks; a "Type" column only for
    // Todoist-style section/note rows — otherwise list them as not imported
    if (!fields.includes("parent")) fields.forEach((f, c) => { if (f === "sourceId") fields[c] = "ignore"; });
    fields.forEach((f, c) => {
      if (f === "rowType" && !body.some((r) => ["section", "note", "task"].includes(normHeader(r[c] ?? "")))) fields[c] = "ignore";
    });
    const colName = (c: number) => (hasHeader ? (header[c] ?? "").trim() || `Column ${c + 1}` : `Column ${c + 1}`);
    base.columns = fields.map((f, c) => ({ index: c, header: colName(c), field: f === "ignore" ? null : f }));
    const extraCols = fields.map((f, c) => (f === null || f === "ignore" ? c : -1)).filter((c) => c >= 0)
      .filter((c) => body.some((r) => (r[c] ?? "").trim() !== ""));
    base.ignoredColumns = extraCols.map(colName);
    const colsOf = (f: ImportField) => fields.map((x, i) => (x === f ? i : -1)).filter((i) => i >= 0);
    const col = (f: ImportField) => fields.indexOf(f);
    const titleC = col("title"), statusC = col("status"), sectionC = col("section"), priorityC = col("priority");
    const dueC = col("due"), startC = col("start"), completedC = col("completed"), assigneeC = col("assignee");
    const emailC = col("assigneeEmail"), projectC = col("project"), estimateC = col("estimate");
    const archivedC = col("archived"), typeC = col("rowType");
    const descCs = colsOf("description"), tagCs = colsOf("tags"), parentCs = colsOf("parent"), idCs = colsOf("sourceId");

    // date order: explicit choice, else evidence in the file, else day-first (UK)
    const dateCells: string[] = [];
    [dueC, startC, completedC].filter((c) => c >= 0).forEach((c) => body.forEach((r) => { const v = (r[c] ?? "").trim(); if (v) dateCells.push(v); }));
    const ev = dateOrderEvidence(dateCells);
    base.ambiguousDates = ev.ambiguous > 0;
    const order: DateOrder = opts.dateOrder ?? (ev.mdy > 0 && ev.dmy === 0 ? "mdy" : "dmy");
    base.dateOrder = order;

    const readDate = (v: string): string | null | undefined => {
      const s = v.trim();
      if (!s) return undefined;
      const d = parseImportDate(s, order, today);
      if (!d) { warnings.unreadableDates.count++; if (warnings.unreadableDates.examples.length < 3) warnings.unreadableDates.examples.push(clip(s, 24)); }
      return d;
    };

    const header0 = header.map((h) => normHeader(h)).join("\u0001");
    let currentSection: string | undefined; // Todoist "section" rows
    for (const r0 of body) {
      const r = r0.map(unguard);
      if (hasHeader && r.map(normHeader).join("\u0001") === header0) continue; // repeated header (Monday groups)
      const cell = (c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");
      if (typeC >= 0) {
        const t = normHeader(cell(typeC));
        if (t === "section") { currentSection = cell(titleC) || undefined; continue; }
        if (t === "note" || t === "comment") continue;
      }
      if (archivedC >= 0 && TRUTHY.has(normHeader(cell(archivedC)) || cell(archivedC))) { warnings.skippedArchived++; continue; }
      const rawTitle = titleC >= 0 ? (r[titleC] ?? "").replace(/\s+/g, " ").trim() : "";
      if (!rawTitle) {
        if (r.some((c) => c.trim() !== "")) warnings.skippedNoTitle++;
        continue;
      }
      const row: ImportRow = { title: rawTitle };
      // free-text tokens only when there's no real header (a Title column is taken literally)
      if (!hasHeader && smart) applyTokens(rawTitle, row);

      // description: notes columns (+ untyped columns when headerless) (+ extras when asked)
      const descParts = (hasHeader ? descCs : textCols).map((c) => (r[c] ?? "").replace(/\r\n?/g, "\n").trim()).filter(Boolean);
      if (opts.extrasToDescription) {
        const extras = extraCols.map((c) => [colName(c), cell(c)] as const).filter(([, v]) => v);
        if (extras.length) descParts.push(extras.map(([h, v]) => `${h}: ${v}`).join("\n"));
      }
      if (descParts.length) row.description = descParts.join("\n\n");

      // status (explicit column) — the section column also carries status in Asana/Trello boards
      const statusVal = cell(statusC);
      if (statusVal) {
        const s = mapStatus(statusVal);
        if (s) row.status = s; else pushName(warnings.unknownStatuses, statusVal);
      }
      const sectionVal = cell(sectionC) || currentSection || "";
      if (sectionVal) {
        const s = statusC < 0 ? mapStatus(sectionVal) : null;
        if (s) { row.status = s; row.sectionName = sectionVal; softSection.add(row); }
        else row.sectionName = sectionVal;
      }
      const prio = cell(priorityC);
      if (prio) { const p = mapPriority(prio); if (p) row.priority = p; }

      const due = readDate(cell(dueC)); if (due) row.dueDate = due;
      const start = readDate(cell(startC)); if (start) row.startDate = start;
      const comp = cell(completedC);
      if (comp) {
        const k = normHeader(comp) || comp;
        if (TRUTHY.has(k) || TRUTHY.has(comp)) row.status = "done";
        else if (!FALSY.has(k)) {
          row.status = "done";
          const d = /\d/.test(comp) ? readDate(comp) : null;
          if (d) row.completedAt = d;
        }
      }

      const est = cell(estimateC);
      if (est) { const m = parseMinutes(est); if (m) { row.focusMin = m; row.dur = m; } }

      // people: email column first, then the name column; extra people become collaborators
      const peopleRaw = [cell(emailC), cell(assigneeC)].filter(Boolean);
      if (peopleRaw.length) {
        const found: string[] = [];
        peopleRaw.forEach((v) => {
          const parts = EMAIL_RE.test(v) && !/[,;]/.test(v) ? [v] : splitList(v);
          parts.forEach((p) => {
            if (UNASSIGNED.has(normName(p))) return;
            const m = matchMember(p, members);
            if (m && !found.includes(m.id)) found.push(m.id);
          });
        });
        if (found.length) {
          row.assigneeId = found[0];
          if (found.length > 1) row.collaborators = found.slice(1);
        } else if (peopleRaw.some((v) => !UNASSIGNED.has(normName(v)))) {
          // name the person the way people know them: their name, else their email
          const shown = splitList(cell(assigneeC))[0] || splitList(cell(emailC))[0] || peopleRaw[0];
          pushName(warnings.unknownAssignees, shown);
        }
      }

      // project: first listed project that exists
      const projVal = cell(projectC);
      if (projVal) {
        const names = splitList(projVal);
        const hit = names.map((n) => projects.find((p) => normProject(p.name) === normProject(n))).find(Boolean);
        if (hit) row.projectId = hit.id; else pushName(warnings.unknownProjects, names[0] || projVal);
      }

      // tags: match existing tags by label (or key); keep unknown labels aside
      const tagKeys: string[] = [], fresh: string[] = [];
      tagCs.forEach((c) => {
        const labelsCol = normHeader(header[c] ?? "") === "labels";
        splitList(r[c] ?? "").forEach((t0) => {
          let t = t0.replace(/^#/, "").trim();
          if (labelsCol) t = t.replace(/\s*\([a-z_ ]+\)$/i, "").trim(); // Trello "Urgent (red)"
          if (!t) return;
          const k = t.toLowerCase();
          const key = Object.keys(tagDict).find((id) => id.toLowerCase() === k || tagDict[id].label.trim().toLowerCase() === k);
          if (key) { if (!tagKeys.includes(key)) tagKeys.push(key); }
          else if (!fresh.some((x) => x.toLowerCase() === k)) fresh.push(t);
        });
      });
      if (tagKeys.length) row.tags = tagKeys;
      if (fresh.length) row.newTags = fresh;

      if (!row.projectId && opts.defaultProjectId) row.projectId = opts.defaultProjectId;
      capTitle(row);
      out.push(row);
      rowParents.push({ parents: parentCs.map(cell).filter(Boolean), ids: idCs.map(cell).filter(Boolean) });
    }
    base.mode = "columns";
    base.hasHeader = hasHeader;
    base.delimiter = delim;
  }

  // default project + sections resolved against the row's final project
  const sections = opts.sections;
  const missingSections = new Map<string, string>();
  out.forEach((row) => {
    if (!row.projectId && opts.defaultProjectId) row.projectId = opts.defaultProjectId;
    if (row.sectionName && sections && row.projectId) {
      const want = normName(row.sectionName);
      const hit = sections.find((s) => s.projectId === row.projectId && normName(s.name) === want);
      if (hit) { row.sectionId = hit.id; delete row.sectionName; }
      else if (softSection.has(row)) delete row.sectionName;
      else if (!missingSections.has(want)) missingSections.set(want, row.sectionName);
    } else if (row.sectionName && softSection.has(row)) delete row.sectionName;
  });
  warnings.missingSections = [...missingSections.values()];

  // sub-tasks: link to a parent in the same import by id column or by title
  const byId = new Map<string, number>(), byTitle = new Map<string, number>();
  rowParents.forEach((p, i) => p.ids.forEach((id) => { if (!byId.has(id)) byId.set(id, i); }));
  out.forEach((row, i) => { const k = row.title.toLowerCase(); if (!byTitle.has(k)) byTitle.set(k, i); });
  out.forEach((row, i) => {
    const pvs = rowParents[i]?.parents ?? [];
    if (!pvs.length) return;
    warnings.subtasks++;
    let pi: number | undefined;
    for (const pv of pvs) {
      pi = byId.get(pv) ?? byTitle.get(pv.replace(/\s+/g, " ").toLowerCase());
      if (pi !== undefined && pi !== i) break;
      pi = undefined;
    }
    // prefer a readable name (Jira has both "Parent" = id and "Parent summary")
    row.parentTitle = pi !== undefined ? out[pi].title : pvs.reduce((a, b) => (b.length > a.length ? b : a));
    if (pi === undefined) { warnings.orphanSubtasks++; return; }
    // refuse cycles (A under B under A)
    for (let cur: number | undefined = pi, hops = 0; cur !== undefined && hops < out.length; hops++) {
      if (cur === i) { warnings.orphanSubtasks++; return; }
      cur = out[cur].parentIndex;
    }
    row.parentIndex = pi;
  });

  const fresh = new Map<string, string>();
  out.forEach((r) => (r.newTags || []).forEach((t) => { if (!fresh.has(t.toLowerCase())) fresh.set(t.toLowerCase(), t); }));
  warnings.newTags = [...fresh.values()];

  base.totalRows = out.length;
  base.truncated = out.length > limit;
  base.rows = base.truncated ? out.slice(0, limit) : out;
  if (base.truncated) base.rows.forEach((r) => { if (r.parentIndex !== undefined && r.parentIndex >= limit) delete r.parentIndex; });
  return base;
}

/** Backwards-compatible entry point: just the rows. */
export function parseImportText(
  raw: string,
  projects: ImportProject[] = [],
  members: ImportMember[] = [],
  defaultProjectId?: string,
): ImportRow[] {
  return analyseImport(raw, { projects, members, defaultProjectId }).rows;
}

/* ---------- file decoding ---------- */

/**
 * Decodes an uploaded file's bytes. Honours UTF-8/UTF-16 byte-order marks
 * (Excel's "Unicode text" export is UTF-16), and falls back to Windows-1252
 * for legacy Excel "CSV" files so "£" and accents survive.
 */
export function decodeImportBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("windows-1252").decode(bytes); }
}
