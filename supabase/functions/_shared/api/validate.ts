// ============================================================
// KANBO — public API v1: input validation + cursors (0046).      [a1]
//
// Every value a caller sends is checked here before it gets near SQL:
// types, enums, real calendar dates, length caps, unknown fields. The
// checkers never throw; they answer { ok: true, value } with the cleaned
// value, or { ok: false, fields } with one sentence per bad field (the
// pipeline turns that into a 422 "validation_failed" / 400 "bad_request").
//
// Cursors are opaque base64url JSON: the last row's sort key (a UTC
// timestamp with microseconds, straight from Postgres), its id, the sort
// mode and a fingerprint of the filters, so a cursor can't be replayed
// against a different query.
//
// Pure module: validate.test.ts.
// ============================================================
import { API_PRIORITIES, API_STATUSES, type ApiPriority, type ApiStatus } from "./serialise.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** The id the app gives the Personal list's pseudo-project (tasks.project_id is text). */
export const PERSONAL_PROJECT_ID = "p-personal";

/** Length caps and page sizes (also quoted in the docs and the OpenAPI document). */
export const API_LIMITS = {
  title: 500,
  description: 20_000,
  comment: 10_000,
  projectName: 120,
  projectDescription: 5_000,
  sectionName: 120,
  tagLabel: 40,
  tagsPerTask: 20,
  q: 200,
  effortHours: 10_000,
  pageDefault: 50,
  pageMax: 100,
  bodyBytes: 64 * 1024,
  idempotencyKey: 255,
  emoji: 16,
  color: 64,
} as const;

export const PROJECT_STATUSES = ["on_track", "at_risk", "off_track", "on_hold"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export type FieldErrors = Record<string, string>;
export type Checked<T> = { ok: true; value: T } | { ok: false; fields: FieldErrors };
type Body = Record<string, unknown>;

const has = (o: Body, k: string) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

/* ------------------------------------------------------------ text */

// C0 controls except tab / newline, DEL, and the NUL Postgres refuses
// deno-lint-ignore no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Multi-line text: CRLF → LF, control characters removed, trimmed. */
export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(CONTROLS, "").trim();
}

/** One-line text (titles, names): every run of whitespace becomes one space. */
export function oneLine(s: string): string {
  return s.replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
}

/** Escape % _ and \ for LIKE / ILIKE … ESCAPE '\'. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

/* ------------------------------------------------------------ dates */

/** "YYYY-MM-DD" that is a real calendar day between 1900 and 2200. */
export function isRealDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= days;
}

/** "HH:MM", 24-hour. */
export const isTime = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/**
 * An ISO 8601 timestamp ("2026-10-05T09:30:00Z", "…+01:00", fractions allowed,
 * or a bare "YYYY-MM-DD" meaning midnight UTC) → its UTC ISO string; else null.
 * A zone is required for date-times so "updated_since" is never ambiguous.
 */
export function parseTimestamp(s: unknown): string | null {
  if (typeof s !== "string" || s.length > 40) return null;
  const v = s.trim();
  if (isRealDate(v)) return `${v}T00:00:00.000Z`;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i.exec(v);
  if (!m || !isRealDate(m[1])) return null;
  if (Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59) return null;
  const frac = m[5] ? m[5].slice(0, 4) : "";
  const zone = m[6].toUpperCase() === "Z" ? "Z" : m[6].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? "00"}${frac}${zone}`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/* ------------------------------------------------------------ query strings */

/** ?flag=true|false|1|0 (absent → fallback); null when it's something else. */
export function parseBool(v: string | null, fallback = false): boolean | null {
  if (v === null || v === "") return fallback;
  const s = v.toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return null;
}

/** ?limit=1…100 (absent → 50); null when out of range or not a whole number. */
export function parseLimit(v: string | null): number | null {
  if (v === null || v === "") return API_LIMITS.pageDefault;
  if (!/^\d{1,4}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= API_LIMITS.pageMax ? n : null;
}

/** Query parameters that aren't in `allowed` (so a typo like due-before is caught). */
export function unknownParams(sp: URLSearchParams, allowed: readonly string[]): string[] {
  const out = new Set<string>();
  for (const k of sp.keys()) if (!allowed.includes(k)) out.add(k);
  return [...out];
}

/** Every value of a repeatable, comma-separated parameter (?status=todo,done&status=review). */
function listParam(sp: URLSearchParams, name: string): string[] {
  return sp.getAll(name).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
}

const single = (sp: URLSearchParams, name: string, fields: FieldErrors): string | null => {
  const all = sp.getAll(name);
  if (all.length > 1) { fields[name] = "Give this parameter once."; return null; }
  return all.length ? all[0].trim() : null;
};

/** A workspace filter: a workspace id, or "personal" for your Personal list. */
function workspaceParam(v: string | null, name: string, fields: FieldErrors): string | undefined {
  if (v === null || v === "") return undefined;
  if (v.toLowerCase() === "personal") return "personal";
  if (isUuid(v)) return v.toLowerCase();
  fields[name] = "Use a workspace id, or \"personal\".";
  return undefined;
}

/** A project id (uuid) or the Personal list ("personal" / "p-personal"). */
function projectRef(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s.toLowerCase() === "personal" || s === PERSONAL_PROJECT_ID) return PERSONAL_PROJECT_ID;
  return isUuid(s) ? s.toLowerCase() : undefined;
}

export interface TaskQuery {
  /** a workspace id, or "personal" */
  workspace?: string;
  /** a project id, or "p-personal" */
  project?: string;
  section?: string;
  /** a user id, "me" or "none" (unassigned) */
  assignee?: string;
  /** a task id, or "none" (top-level tasks only) */
  parent?: string;
  status?: ApiStatus[];
  dueBefore?: string;
  dueAfter?: string;
  updatedSince?: string;
  includeArchived: boolean;
  q?: string;
  limit: number;
  cursor?: string;
}

export const TASK_QUERY_PARAMS = [
  "workspace", "project", "section", "assignee", "parent", "status", "due_before", "due_after",
  "updated_since", "include_archived", "q", "limit", "cursor",
] as const;

export function parseTaskQuery(sp: URLSearchParams): Checked<TaskQuery> {
  const fields: FieldErrors = {};
  for (const k of unknownParams(sp, TASK_QUERY_PARAMS)) fields[k] = "Unknown query parameter.";
  const out: TaskQuery = { includeArchived: false, limit: API_LIMITS.pageDefault };

  const ws = workspaceParam(single(sp, "workspace", fields), "workspace", fields);
  if (ws) out.workspace = ws;

  const project = single(sp, "project", fields);
  if (project) {
    const p = projectRef(project);
    if (p) out.project = p; else fields.project = "Use a project id, or \"personal\".";
  }
  const section = single(sp, "section", fields);
  if (section) { if (isUuid(section)) out.section = section.toLowerCase(); else fields.section = "Use a section id."; }

  const assignee = single(sp, "assignee", fields);
  if (assignee) {
    const a = assignee.toLowerCase();
    if (a === "me" || a === "none" || isUuid(a)) out.assignee = a; else fields.assignee = "Use a user id, \"me\" or \"none\".";
  }
  const parent = single(sp, "parent", fields);
  if (parent) {
    const p = parent.toLowerCase();
    if (p === "none" || isUuid(p)) out.parent = p; else fields.parent = "Use a task id, or \"none\" for top-level tasks.";
  }

  const statuses = listParam(sp, "status");
  if (statuses.length) {
    const bad = statuses.filter((s) => !(API_STATUSES as readonly string[]).includes(s));
    if (bad.length || statuses.length > 5) fields.status = `Use one or more of ${API_STATUSES.join(", ")}.`;
    else out.status = [...new Set(statuses)] as ApiStatus[];
  }

  for (const [param, key] of [["due_before", "dueBefore"], ["due_after", "dueAfter"]] as const) {
    const v = single(sp, param, fields);
    if (v) { if (isRealDate(v)) out[key] = v; else fields[param] = "Use a date like 2026-10-31."; }
  }
  if (out.dueBefore && out.dueAfter && out.dueAfter > out.dueBefore) fields.due_after = "due_after is later than due_before.";

  const since = single(sp, "updated_since", fields);
  if (since) {
    const t = parseTimestamp(since);
    if (t) out.updatedSince = t; else fields.updated_since = "Use an ISO 8601 time with a zone, like 2026-10-05T09:30:00Z.";
  }

  const arch = parseBool(single(sp, "include_archived", fields));
  if (arch === null) fields.include_archived = "Use true or false."; else out.includeArchived = arch;

  const q = single(sp, "q", fields);
  if (q) {
    const c = oneLine(q);
    if (c.length > API_LIMITS.q) fields.q = `Search for at most ${API_LIMITS.q} characters.`;
    else if (c) out.q = c;
  }

  const limit = parseLimit(single(sp, "limit", fields));
  if (limit === null) fields.limit = `Use a whole number from 1 to ${API_LIMITS.pageMax}.`; else out.limit = limit;

  const cursor = single(sp, "cursor", fields);
  if (cursor) out.cursor = cursor;

  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value: out };
}

/** ?workspace=&include_archived=&limit=&cursor= for GET /projects. */
export interface ProjectQuery { workspace?: string; includeArchived: boolean; limit: number; cursor?: string }
export function parseProjectQuery(sp: URLSearchParams): Checked<ProjectQuery> {
  const fields: FieldErrors = {};
  for (const k of unknownParams(sp, ["workspace", "include_archived", "limit", "cursor"])) fields[k] = "Unknown query parameter.";
  const out: ProjectQuery = { includeArchived: false, limit: API_LIMITS.pageDefault };
  const ws = workspaceParam(single(sp, "workspace", fields), "workspace", fields);
  if (ws) out.workspace = ws;
  const arch = parseBool(single(sp, "include_archived", fields));
  if (arch === null) fields.include_archived = "Use true or false."; else out.includeArchived = arch;
  const limit = parseLimit(single(sp, "limit", fields));
  if (limit === null) fields.limit = `Use a whole number from 1 to ${API_LIMITS.pageMax}.`; else out.limit = limit;
  const cursor = single(sp, "cursor", fields);
  if (cursor) out.cursor = cursor;
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value: out };
}

/** ?limit=&cursor= (+ named extras) for the other lists. */
export interface PageQuery { limit: number; cursor?: string; extra: Record<string, string> }
export function parsePageQuery(sp: URLSearchParams, extras: readonly string[] = []): Checked<PageQuery> {
  const fields: FieldErrors = {};
  for (const k of unknownParams(sp, ["limit", "cursor", ...extras])) fields[k] = "Unknown query parameter.";
  const out: PageQuery = { limit: API_LIMITS.pageDefault, extra: {} };
  const limit = parseLimit(single(sp, "limit", fields));
  if (limit === null) fields.limit = `Use a whole number from 1 to ${API_LIMITS.pageMax}.`; else out.limit = limit;
  const cursor = single(sp, "cursor", fields);
  if (cursor) out.cursor = cursor;
  for (const e of extras) { const v = single(sp, e, fields); if (v) out.extra[e] = v; }
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value: out };
}

/* ------------------------------------------------------------ bodies */

function unknownFields(body: Body, allowed: readonly string[], fields: FieldErrors) {
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) {
      const camel = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      fields[k] = camel !== k && allowed.includes(camel) ? `Unknown field. Did you mean "${camel}"?` : "Unknown field.";
    }
  }
}

function text(body: Body, k: string, fields: FieldErrors, opts: { max: number; min?: number; multiline?: boolean; nullable?: boolean }): string | null | undefined {
  if (!has(body, k)) return undefined;
  const v = body[k];
  if (v === null) {
    if (opts.nullable) return null;
    fields[k] = "Can't be null.";
    return undefined;
  }
  if (typeof v !== "string") { fields[k] = "Must be a string."; return undefined; }
  const s = opts.multiline ? cleanText(v) : oneLine(v);
  if (s.length < (opts.min ?? 0)) { fields[k] = opts.min ? "Can't be empty." : "Too short."; return undefined; }
  if (s.length > opts.max) { fields[k] = `Use at most ${opts.max} characters.`; return undefined; }
  return s;
}

function oneOf<T extends string>(body: Body, k: string, allowed: readonly T[], fields: FieldErrors, nullable = false): T | null | undefined {
  if (!has(body, k)) return undefined;
  const v = body[k];
  if (v === null && nullable) return null;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  fields[k] = `Use one of ${allowed.join(", ")}${nullable ? " (or null)" : ""}.`;
  return undefined;
}

function idField(body: Body, k: string, fields: FieldErrors, nullable = true): string | null | undefined {
  if (!has(body, k)) return undefined;
  const v = body[k];
  if (v === null && nullable) return null;
  if (isUuid(v)) return v.toLowerCase();
  fields[k] = nullable ? "Use an id, or null." : "Use an id.";
  return undefined;
}

function dateField(body: Body, k: string, fields: FieldErrors): string | null | undefined {
  if (!has(body, k)) return undefined;
  const v = body[k];
  if (v === null) return null;
  if (isRealDate(v)) return v;
  fields[k] = "Use a date like 2026-10-31, or null.";
  return undefined;
}

function timeField(body: Body, k: string, fields: FieldErrors): string | null | undefined {
  if (!has(body, k)) return undefined;
  const v = body[k];
  if (v === null) return null;
  if (isTime(v)) return v;
  fields[k] = "Use a 24-hour time like 09:30, or null.";
  return undefined;
}

function effortField(body: Body, k: string, fields: FieldErrors): number | null | undefined {
  if (!has(body, k)) return undefined;
  const v = body[k];
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= API_LIMITS.effortHours) return Math.round(v * 100) / 100;
  fields[k] = `Use a number of hours from 0 to ${API_LIMITS.effortHours}, or null.`;
  return undefined;
}

function boolField(body: Body, k: string, fields: FieldErrors): boolean | undefined {
  if (!has(body, k)) return undefined;
  const v = body[k];
  if (typeof v === "boolean") return v;
  fields[k] = "Use true or false.";
  return undefined;
}

/** A person: a user id, "me", or null (unassigned). */
function assigneeField(body: Body, k: string, fields: FieldErrors): string | null | undefined {
  if (!has(body, k)) return undefined;
  const v = body[k];
  if (v === null || v === "") return null;
  if (typeof v === "string" && v.toLowerCase() === "me") return "me";
  if (isUuid(v)) return v.toLowerCase();
  fields[k] = "Use a user id, \"me\", or null to unassign.";
  return undefined;
}

/** Tags: ids (a tag's id or a built-in like "design") or labels (found or made in the task's workspace). */
function tagsField(body: Body, k: string, fields: FieldErrors): string[] | undefined {
  if (!has(body, k)) return undefined;
  const v = body[k];
  if (v === null) return [];
  if (!Array.isArray(v)) { fields[k] = "Use an array of tag ids or labels."; return undefined; }
  if (v.length > API_LIMITS.tagsPerTask) { fields[k] = `Use at most ${API_LIMITS.tagsPerTask} tags.`; return undefined; }
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== "string") { fields[k] = "Each tag is a string: a tag id or a label."; return undefined; }
    const s = oneLine(t);
    if (!s || s.length > API_LIMITS.tagLabel) { fields[k] = `Each tag is 1 to ${API_LIMITS.tagLabel} characters.`; return undefined; }
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

const COLOR_RE = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|(oklch|rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]{1,48}\))$/i;
function colorField(body: Body, k: string, fields: FieldErrors): string | null | undefined {
  if (!has(body, k)) return undefined;
  const v = body[k];
  if (v === null) return null;
  if (typeof v === "string" && v.length <= API_LIMITS.color && COLOR_RE.test(v.trim())) return v.trim();
  fields[k] = "Use a CSS colour such as oklch(0.74 0.14 230) or #3b82f6.";
  return undefined;
}

function emojiField(body: Body, k: string, fields: FieldErrors): string | null | undefined {
  if (!has(body, k)) return undefined;
  const v = body[k];
  if (v === null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    // deno-lint-ignore no-control-regex
    if (s && s.length <= API_LIMITS.emoji && !/[\s\u0000-\u001F<>]/.test(s)) return s;
  }
  fields[k] = "Use one emoji.";
  return undefined;
}

/* ---- tasks ---- */

export interface TaskInput {
  title?: string;
  description?: string;
  status?: ApiStatus;
  priority?: ApiPriority;
  /** a project id; "p-personal" / null = the Personal list */
  projectId?: string | null;
  /** only checked against the project's workspace; null / "personal" = Personal */
  workspaceId?: string | null;
  sectionId?: string | null;
  parentId?: string | null;
  /** a user id, "me", or null (unassigned) */
  assigneeId?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  startDate?: string | null;
  tags?: string[];
  effortHours?: number | null;
  archived?: boolean;
}

export const TASK_CREATE_FIELDS = [
  "title", "description", "status", "priority", "projectId", "workspaceId", "sectionId", "parentId",
  "assigneeId", "dueDate", "dueTime", "startDate", "tags", "effortHours",
] as const;
export const TASK_PATCH_FIELDS = [
  "title", "description", "status", "priority", "projectId", "sectionId", "assigneeId",
  "dueDate", "dueTime", "startDate", "tags", "effortHours", "archived",
] as const;

function taskFields(body: Body, fields: FieldErrors, create: boolean): TaskInput {
  const out: TaskInput = {};
  const title = text(body, "title", fields, { max: API_LIMITS.title, min: 1 });
  if (title !== undefined && title !== null) out.title = title;
  else if (create && !has(body, "title") && !fields.title) fields.title = "Give the task a title.";
  const description = text(body, "description", fields, { max: API_LIMITS.description, multiline: true, nullable: true });
  if (description !== undefined) out.description = description ?? "";
  const status = oneOf(body, "status", API_STATUSES, fields);
  if (status) out.status = status;
  const priority = oneOf(body, "priority", API_PRIORITIES, fields);
  if (priority) out.priority = priority;
  if (has(body, "projectId")) {
    const p = projectRef(body.projectId);
    if (p === undefined) fields.projectId = "Use a project id, or null for your Personal list.";
    else out.projectId = p === PERSONAL_PROJECT_ID ? null : p;
  }
  if (create && has(body, "workspaceId")) {
    const v = body.workspaceId;
    if (v === null || (typeof v === "string" && v.toLowerCase() === "personal")) out.workspaceId = null;
    else if (isUuid(v)) out.workspaceId = v.toLowerCase();
    else fields.workspaceId = "Use a workspace id, or null for your Personal list.";
  }
  const sectionId = idField(body, "sectionId", fields);
  if (sectionId !== undefined) out.sectionId = sectionId;
  if (create) {
    const parentId = idField(body, "parentId", fields);
    if (parentId !== undefined) out.parentId = parentId;
  }
  const assigneeId = assigneeField(body, "assigneeId", fields);
  if (assigneeId !== undefined) out.assigneeId = assigneeId;
  const dueDate = dateField(body, "dueDate", fields);
  if (dueDate !== undefined) out.dueDate = dueDate;
  const dueTime = timeField(body, "dueTime", fields);
  if (dueTime !== undefined) out.dueTime = dueTime;
  const startDate = dateField(body, "startDate", fields);
  if (startDate !== undefined) out.startDate = startDate;
  const tags = tagsField(body, "tags", fields);
  if (tags !== undefined) out.tags = tags;
  const effort = effortField(body, "effortHours", fields);
  if (effort !== undefined) out.effortHours = effort;
  if (!create) {
    const archived = boolField(body, "archived", fields);
    if (archived !== undefined) out.archived = archived;
  }
  return out;
}

export function checkTaskCreate(body: Body): Checked<TaskInput> {
  const fields: FieldErrors = {};
  unknownFields(body, TASK_CREATE_FIELDS, fields);
  const v = taskFields(body, fields, true);
  if (v.dueTime && !v.dueDate && !fields.dueDate) fields.dueTime = "Give a dueDate with a dueTime.";
  if (v.startDate && v.dueDate && v.startDate > v.dueDate) fields.startDate = "startDate is after dueDate.";
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value: v };
}

export function checkTaskPatch(body: Body): Checked<TaskInput> {
  const fields: FieldErrors = {};
  unknownFields(body, TASK_PATCH_FIELDS, fields);
  const v = taskFields(body, fields, false);
  if (has(body, "title") && body.title === null) fields.title = "A task needs a title.";
  if (!Object.keys(body).length) fields._ = `Send at least one of ${TASK_PATCH_FIELDS.join(", ")}.`;
  if (v.startDate && v.dueDate && v.startDate > v.dueDate) fields.startDate = "startDate is after dueDate.";
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value: v };
}

/* ---- projects ---- */

export interface ProjectInput {
  name?: string;
  /** create only: null = personal */
  workspaceId?: string | null;
  emoji?: string | null;
  color?: string | null;
  description?: string | null;
  status?: ProjectStatus | null;
  archived?: boolean;
}

export const PROJECT_CREATE_FIELDS = ["name", "workspaceId", "emoji", "color", "description", "status"] as const;
export const PROJECT_PATCH_FIELDS = ["name", "emoji", "color", "description", "status", "archived"] as const;

function projectFields(body: Body, fields: FieldErrors, create: boolean): ProjectInput {
  const out: ProjectInput = {};
  const name = text(body, "name", fields, { max: API_LIMITS.projectName, min: 1 });
  if (name) out.name = name;
  else if (create && !has(body, "name") && !fields.name) fields.name = "Give the project a name.";
  if (has(body, "name") && body.name === null) fields.name = "A project needs a name.";
  if (create && has(body, "workspaceId")) {
    const v = body.workspaceId;
    if (v === null || (typeof v === "string" && v.toLowerCase() === "personal")) out.workspaceId = null;
    else if (isUuid(v)) out.workspaceId = v.toLowerCase();
    else fields.workspaceId = "Use a workspace id, or null for a personal project.";
  }
  const emoji = emojiField(body, "emoji", fields);
  if (emoji !== undefined) out.emoji = emoji;
  const color = colorField(body, "color", fields);
  if (color !== undefined) out.color = color;
  const description = text(body, "description", fields, { max: API_LIMITS.projectDescription, multiline: true, nullable: true });
  if (description !== undefined) out.description = description || null;
  const status = oneOf(body, "status", PROJECT_STATUSES, fields, true);
  if (status !== undefined) out.status = status;
  if (!create) {
    const archived = boolField(body, "archived", fields);
    if (archived !== undefined) out.archived = archived;
  }
  return out;
}

export function checkProjectCreate(body: Body): Checked<ProjectInput> {
  const fields: FieldErrors = {};
  unknownFields(body, PROJECT_CREATE_FIELDS, fields);
  const v = projectFields(body, fields, true);
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value: v };
}

export function checkProjectPatch(body: Body): Checked<ProjectInput> {
  const fields: FieldErrors = {};
  unknownFields(body, PROJECT_PATCH_FIELDS, fields);
  const v = projectFields(body, fields, false);
  if (!Object.keys(body).length) fields._ = `Send at least one of ${PROJECT_PATCH_FIELDS.join(", ")}.`;
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value: v };
}

/* ---- sections, comments ---- */

export interface SectionInput { projectId: string; name: string }
export function checkSectionCreate(body: Body): Checked<SectionInput> {
  const fields: FieldErrors = {};
  unknownFields(body, ["projectId", "name"], fields);
  const projectId = idField(body, "projectId", fields, false);
  if (!has(body, "projectId")) fields.projectId = "Say which project the section is in.";
  const name = text(body, "name", fields, { max: API_LIMITS.sectionName, min: 1 });
  if (!has(body, "name")) fields.name = "Give the section a name.";
  return Object.keys(fields).length || !projectId || !name ? { ok: false, fields } : { ok: true, value: { projectId, name } };
}

export interface CommentInput { body: string; parentId: string | null }
export function checkCommentCreate(body: Body): Checked<CommentInput> {
  const fields: FieldErrors = {};
  unknownFields(body, ["body", "parentId"], fields);
  const b = text(body, "body", fields, { max: API_LIMITS.comment, min: 1, multiline: true });
  if (!has(body, "body")) fields.body = "Write the comment in \"body\".";
  const parentId = idField(body, "parentId", fields);
  return Object.keys(fields).length || !b ? { ok: false, fields } : { ok: true, value: { body: b, parentId: parentId ?? null } };
}

/* ------------------------------------------------------------ cursors */

/** The sort key is the row's time in UTC with microseconds: "2026-10-05T09:30:00.123456". */
const KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
export interface Cursor {
  /** sort mode, e.g. "c" (created, newest first), "u" (updated, oldest first) */
  m: string;
  /** the last row's sort key */
  k: string;
  /** the last row's id */
  i: string;
  /** fingerprint of the filters it was made for */
  f: string;
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : s.length % 4 === 1 ? null : "";
    if (pad === null) return null;
    return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  } catch { return null; }
}

export function encodeCursor(c: Cursor): string {
  return b64urlEncode(JSON.stringify({ v: 1, m: c.m, k: c.k, i: c.i, f: c.f }));
}

/** The cursor, or null when it's malformed. */
export function decodeCursor(s: string): Cursor | null {
  if (typeof s !== "string" || s.length > 400) return null;
  const raw = b64urlDecode(s);
  if (!raw) return null;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 1 || typeof r.m !== "string" || !/^[a-z]{1,2}$/.test(r.m)) return null;
  if (typeof r.k !== "string" || !KEY_RE.test(r.k) || !isUuid(r.i) || typeof r.f !== "string" || !/^[0-9a-f]{1,32}$/.test(r.f)) return null;
  return { m: r.m, k: r.k, i: (r.i as string).toLowerCase(), f: r.f };
}

/** A short fingerprint of a query's filters (everything but the cursor and page size). */
export async function queryFingerprint(parts: Record<string, unknown>): Promise<string> {
  const keys = Object.keys(parts).filter((k) => k !== "cursor" && k !== "limit" && parts[k] !== undefined).sort();
  const canon = JSON.stringify(keys.map((k) => [k, parts[k]]));
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  return Array.from(new Uint8Array(d).slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SQL that formats a timestamptz column as a cursor key (UTC, microseconds). */
export const cursorKeySql = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
