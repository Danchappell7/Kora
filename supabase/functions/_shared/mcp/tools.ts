// ============================================================
// KANBO — MCP: the tools.
//
// Every tool calls the REST API's own pipeline (env.api → handleApiRequest with
// the resolved person), so validation, RLS through db.withUser, one-workspace
// pinning, rate limits, idempotency and audit are the API's, not copies of them.
// A tool only chooses what to call and shapes the answer for a model: smaller
// tasks, long text cut with a flag (and always a way to read the rest), and a cap
// on the whole answer. What people wrote stays apart from Kanbo's own words.
//
// Schemas have no top-level oneOf / anyOf / allOf (some model APIs refuse them):
// add_task's fields are all optional and the server says what's missing.
// Annotations are hints for the client; what's enforced is enforced in the
// pipeline and in Postgres.
//
// Pure module (env is injected): tools.test.ts, and the PGlite suite against the
// real migrations.
// ============================================================
import { parseTask, type NlpKind } from "../nlp.ts";
import type { ApiComment, ApiMember, ApiProject, ApiTask, ApiWorkspace } from "../api/serialise.ts";
import { API_PRIORITIES, API_STATUSES } from "../api/serialise.ts";
import type { Method } from "../api/router.ts";
import type { ApiPrincipal } from "../api/types.ts";
import { API_LIMITS, PERSONAL_PROJECT_ID, PROJECT_STATUSES } from "../api/validate.ts";
import { schemaErrors, type JsonSchema } from "./jsonSchema.ts";
import { MCP_ISSUER } from "./metadata.ts";
import { DEFAULT_TIMEZONE, dateInZone, isTimeZone, localMidnight, type MyDayCounts } from "./myDay.ts";
import { readPerson, readProject, type Named } from "./names.ts";
import { cut, DETAIL_TEXT_MAX, LIST_TEXT_MAX } from "./text.ts";

export { cut };

/* ------------------------------------------------------------ what a tool runs against */

// deno-lint-ignore no-explicit-any
export interface ApiAnswer { status: number; body: any }
export type ApiCall = (method: Method, path: string, opts?: {
  query?: Record<string, string | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}) => Promise<ApiAnswer>;

export interface ToolEnv {
  /** the REST pipeline, as this person */
  api: ApiCall;
  principal: ApiPrincipal;
  via: "api_key" | "oauth";
  /** the OAuth client's name (self-supplied), or null for an API key */
  clientName: string | null;
  now: () => Date;
  /** counts a write against this connection's budget for that kind; throws a ToolFault when it's spent (handler.ts) */
  spend?: (kind: WriteKind) => Promise<void>;
}

/** Writes with their own, tighter budget: "delete" empties things, "reach" lands in someone else's Inbox. */
export type WriteKind = "delete" | "reach";

/** A refusal in plain words: becomes an isError result, never a protocol error. */
export class ToolFault extends Error {}

export interface ToolOutput {
  structured: Record<string, unknown>;
  /** a line for people, put above the JSON; left out for search and fetch, whose text is exactly the JSON */
  summary?: string;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
  /** hidden from, and refused for, read-only credentials */
  write: boolean;
  /** the pipeline routes it calls (a contract test keeps these real) */
  routes: ReadonlyArray<readonly [Method, string]>;
  // deno-lint-ignore no-explicit-any
  run(args: Record<string, any>, env: ToolEnv): Promise<ToolOutput>;
}

/* ------------------------------------------------------------ limits */

/**
 * The JSON of one answer, in characters. The text fallback carries the same JSON,
 * so the whole result stays near 40,000 characters: about where Claude Code warns.
 */
export const MAX_JSON_CHARS = 19_000;
export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 50;
const COMMENT_TEXT_MAX = 1_000;
const DETAIL_COMMENTS = 20;
const DETAIL_SUBTASKS = 20;
/** What someone else wrote, as a label: a task's title, a person's name. */
const LABEL_MAX = 120;

const size = (v: unknown) => JSON.stringify(v).length;

/** Someone's name or a title on one line, so it can't pretend to be more than a label. */
// deno-lint-ignore no-control-regex
const label = (v: unknown) => cut(String(v ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim(), LABEL_MAX).text;

/* ------------------------------------------------------------ answers from the pipeline */

/** The API's error words, made to fit a connection as well as a key. */
function plainMessage(m: string): string {
  return m
    .replace("This key is limited to one workspace. Use a personal key to reach other workspaces or your Personal list.", "This connection is limited to one workspace, so it can't reach other workspaces or your Personal list.")
    .replace("A team key adds tasks to its workspace's projects: give a projectId.", "This connection is limited to one workspace: give a projectId in it.");
}

/** A failed API answer as a sentence: the reason, and which fields. Never SQL (the pipeline maps those). */
export function faultOf(a: ApiAnswer): ToolFault {
  const e = a.body?.error;
  if (a.status === 429) return new ToolFault(`${e?.message ?? "Too many requests."} Nothing was changed.`);
  if (a.status >= 500) return new ToolFault("Kanbo couldn't do that just now. Try again in a moment.");
  let m = plainMessage(String(e?.message ?? "Kanbo couldn't do that."));
  const fields = e?.details?.fields;
  if (fields && typeof fields === "object") {
    const bits = Object.entries(fields).map(([k, v]) => (k === "_" ? String(v) : `${k}: ${plainMessage(String(v))}`));
    if (bits.length) m = a.status === 422 || a.status === 400 ? bits.join(" ") : `${m} ${bits.join(" ")}`;
  }
  return new ToolFault(m);
}

// deno-lint-ignore no-explicit-any
async function need(p: Promise<ApiAnswer>): Promise<any> {
  const a = await p;
  if (a.status >= 400) throw faultOf(a);
  return a.body;
}

const pathId = (id: unknown) => encodeURIComponent(String(id));

/* ------------------------------------------------------------ shapes */

export interface McpTaskView {
  id: string; title: string; status: string; priority: string; dueDate: string | null; dueTime: string | null;
  startDate: string | null; completedAt: string | null; projectId: string | null; workspaceId: string | null;
  sectionId: string | null; parentId: string | null; assigneeId: string | null; tags: string[];
  effortHours: number | null; archived: boolean; url: string | null; updatedAt: string | null;
  recurrence: string; description: string; descriptionTruncated: boolean;
}

export function taskView(t: ApiTask, textMax = LIST_TEXT_MAX, from = 0): McpTaskView {
  const d = cut((t.description ?? "").slice(from), textMax);
  return {
    id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate, dueTime: t.dueTime,
    startDate: t.startDate, completedAt: t.completedAt, projectId: t.projectId, workspaceId: t.workspaceId,
    sectionId: t.sectionId, parentId: t.parentId, assigneeId: t.assigneeId,
    tags: (t.tags ?? []).map((g) => g.label ?? g.id),
    effortHours: t.effortHours, archived: t.archived, url: t.url, updatedAt: t.updatedAt,
    recurrence: t.recurrence ?? "none",
    description: d.text, descriptionTruncated: d.truncated,
  };
}

function projectView(p: ApiProject) {
  const d = cut(p.description ?? "", LIST_TEXT_MAX);
  return {
    id: p.id, name: p.name, workspaceId: p.workspaceId, status: p.status, emoji: p.emoji, ownerId: p.ownerId,
    archived: p.archived, url: p.url, description: d.text, descriptionTruncated: d.truncated,
  };
}

function commentView(c: ApiComment, textMax = COMMENT_TEXT_MAX) {
  const b = cut(c.body ?? "", textMax);
  return { id: c.id, taskId: c.taskId, parentId: c.parentId, authorName: c.authorName, createdAt: c.createdAt, body: b.text, bodyTruncated: b.truncated };
}

/* ------------------------------------------------------------ schema pieces */

const s = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: "string", description, ...extra });
const nstr = (description: string): JsonSchema => ({ type: ["string", "null"], description });
const obj = (properties: Record<string, JsonSchema>, required: string[] = [], description?: string): JsonSchema =>
  ({ type: "object", properties, ...(required.length ? { required } : {}), ...(description ? { description } : {}) });
const input = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
  ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const arr = (items: JsonSchema, description?: string): JsonSchema => ({ type: "array", items, ...(description ? { description } : {}) });

const STATUS_ENUM: JsonSchema = { type: "string", enum: API_STATUSES, description: "todo, progress (in progress), review, blocked or done." };
const PRIORITY_ENUM: JsonSchema = { type: "string", enum: API_PRIORITIES };
const CURSOR = s("nextCursor from the previous page. Leave it out for the first page.", { maxLength: 400 });
const LIMIT: JsonSchema = { type: "integer", minimum: 1, maximum: PAGE_MAX, description: `How many to return, 1 to ${PAGE_MAX}. Default ${PAGE_DEFAULT}.` };
const TASK_ID = s("The task's id.", { maxLength: 64 });
const IDEMPOTENCY = s("Optional. Send the same value when retrying, so the work isn't done twice. A UUID is ideal.", { maxLength: API_LIMITS.idempotencyKey });
const TIMEZONE = s("An IANA time zone such as Europe/London. Defaults to the person's saved zone, then Europe/London.", { maxLength: 64 });

const TASK_VIEW: JsonSchema = obj({
  id: { type: "string" }, title: { type: "string" }, status: { type: "string" }, priority: { type: "string" },
  dueDate: nstr("YYYY-MM-DD"), dueTime: nstr("HH:MM, 24-hour"), startDate: nstr("YYYY-MM-DD"), completedAt: nstr("YYYY-MM-DD"),
  projectId: nstr("null or p-personal: the Personal list"), workspaceId: nstr("null: the Personal list"),
  sectionId: nstr("The project section."), parentId: nstr("Set on a sub-task."), assigneeId: nstr("A user id; null is unassigned."),
  tags: arr({ type: "string" }), effortHours: { type: ["number", "null"] }, archived: { type: "boolean" },
  url: nstr("Opens the task in Kanbo."), updatedAt: nstr("ISO 8601"),
  recurrence: { type: "string", description: "none, daily, weekdays, weekly, biweekly or monthly. A repeating task makes its next occurrence when it's completed." },
  description: { type: "string" }, descriptionTruncated: { type: "boolean", description: "True when the description was cut short. get_task's descriptionOffset reads the rest." },
}, ["id", "title", "status", "priority", "url", "description", "descriptionTruncated"]);

const PROJECT_VIEW: JsonSchema = obj({
  id: { type: "string" }, name: { type: "string" }, workspaceId: nstr("null: a personal project"), status: nstr("on_track, at_risk, off_track or on_hold"),
  emoji: nstr("The project's emoji."), ownerId: nstr("A user id."), archived: { type: "boolean" }, url: nstr("Opens the project in Kanbo."),
  description: { type: "string" }, descriptionTruncated: { type: "boolean" },
}, ["id", "name", "url", "description", "descriptionTruncated"]);

const COMMENT_VIEW: JsonSchema = obj({
  id: { type: "string" }, taskId: { type: "string" }, parentId: nstr("The comment this replies to."), authorName: { type: "string" },
  createdAt: nstr("ISO 8601"), body: { type: "string" }, bodyTruncated: { type: "boolean" },
}, ["id", "taskId", "authorName", "body", "bodyTruncated"]);

const PAGE_FIELDS: Record<string, JsonSchema> = {
  nextCursor: nstr("Pass as cursor for the next page. null on the last page."),
  hasMore: { type: "boolean" },
};

/* ------------------------------------------------------------ pages that fit */

interface Page<T> { data: T[]; nextCursor: string | null; hasMore: boolean }

/** A page of views under the size cap. Over it, the page is fetched again smaller, so its cursor stays true. */
async function fittedPage<R, V>(limit: number, fetchPage: (limit: number) => Promise<Page<R>>, view: (r: R) => V,
  wrap: (views: V[], nextCursor: string | null, hasMore: boolean) => Record<string, unknown>): Promise<Record<string, unknown>> {
  let page = await fetchPage(limit);
  let out = wrap(page.data.map(view), page.nextCursor, page.hasMore);
  if (size(out) <= MAX_JSON_CHARS || page.data.length <= 1) return out;
  const views = page.data.map(view);
  let keep = views.length - 1;
  while (keep > 1 && size(wrap(views.slice(0, keep), "x".repeat(400), true)) > MAX_JSON_CHARS) keep--;
  page = await fetchPage(keep);
  out = wrap(page.data.map(view), page.nextCursor, page.hasMore);
  return out;
}

const pageLimit = (a: Record<string, unknown>) => String(Math.min(Number(a.limit ?? PAGE_DEFAULT), PAGE_MAX));

/* ------------------------------------------------------------ reading a sentence */

const NL_KINDS: NlpKind[] = ["date", "time", "start", "priority", "project", "person", "estimate"];

interface Sentence {
  fields: Record<string, unknown>;
  /** what was taken out of the sentence and how it was read, for the model to check */
  read: string[];
  notes: string[];
}

const READ_AS: Partial<Record<NlpKind, (label: string) => string>> = {
  date: (l) => `due ${l}`,
  time: (l) => `at ${l}`,
  start: (l) => `starting ${l}`,
  priority: (l) => `priority ${l}`,
  project: (l) => `project ${l}`,
  person: (l) => l,
  estimate: (l) => `estimate ${l}`,
};

/** The saved zone, so "today" here is the day my_day says it is. If it can't be read, London. */
async function zoneOf(env: ToolEnv): Promise<string> {
  const a = await env.api("GET", "/me/timezone");
  const tz = a.status < 400 ? a.body?.timezone : null;
  return isTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

/**
 * "Send the brief fri 3pm #launch @sana !high ~30m", read by the one grammar the app's Quick capture
 * and the Slack app use: #project against the projects this person can see, @person against the
 * members of that project's workspace. Nobody is watching the highlight here, so names have to match
 * properly (names.ts): an exact name, a first name or the start of a word, and only one of them.
 * Whatever can't be matched stays in the title and is mentioned, and what was read is listed.
 */
async function readSentence(text: string, tz: string, projectHint: string | undefined, env: ToolEnv): Promise<Sentence> {
  const today = localMidnight(dateInZone(env.now(), tz));
  const projectsBody = await need(env.api("GET", "/projects", { query: { limit: "100" } }));
  const projects: ApiProject[] = projectsBody.data ?? [];
  const named = projects.map((p) => ({ id: p.id, name: p.name }));
  const notes: string[] = [];
  const several = new Set<string>();
  const say = (mark: string, q: string, hits: Named[], what: string) => {
    const key = `${mark}${q.toLowerCase()}`;
    if (several.has(key)) return;
    several.add(key);
    notes.push(`“${mark}${q}” could be ${hits.map((h) => label(h.name)).join(" or ")}, so it stayed in the title. Give ${what} to choose.`);
  };
  const nameMatch = {
    project: (q: string, list: Named[]) => {
      const r = readProject(q, list);
      if (r.kind === "several") say("#", q, r.hits, "projectId");
      return r.kind === "one" ? r.hit : undefined;
    },
    member: (q: string, list: Named[]) => {
      const r = readPerson(q, list);
      if (r.kind === "several") say("@", q, r.hits, "assigneeId");
      return r.kind === "one" ? r.hit : undefined;
    },
  };
  const first = parseTask(text, { today, kinds: NL_KINDS, projects: named, members: [], nameMatch: { project: (q, list) => { const r = readProject(q, list); return r.kind === "one" ? r.hit : undefined; } } });
  // which workspace's people does @someone mean?
  const projectId = projectHint ?? first.projectId;
  const ws = projects.find((p) => p.id === projectId)?.workspaceId ?? env.principal.workspaceId;
  let members: { id: string; name: string }[] = [];
  if (ws) {
    // if the people can't be read, @someone just stays in the title and is mentioned: the task still gets added
    const a = await env.api("GET", "/members", { query: { workspace: ws, limit: "100" } });
    if (a.status < 400) members = (a.body?.data as ApiMember[] ?? []).filter((m) => m.status === "active" && m.userId).map((m) => ({ id: m.userId!, name: m.name }));
  }
  const p = parseTask(text, { today, kinds: NL_KINDS, projects: named, members: [{ id: env.principal.userId, name: "me" }, ...members], nameMatch });
  const fields: Record<string, unknown> = { title: p.title };
  if (p.dueDate) fields.dueDate = p.dueDate;
  if (p.dueTime) fields.dueTime = p.dueTime;
  if (p.startDate && (!p.dueDate || p.startDate <= p.dueDate)) fields.startDate = p.startDate;
  if (p.priority) fields.priority = p.priority;
  if (p.projectId) fields.projectId = p.projectId;
  if (p.assigneeId) fields.assigneeId = p.assigneeId === env.principal.userId ? "me" : p.assigneeId;
  if (p.effortHours !== undefined) fields.effortHours = p.effortHours;
  const read = p.spans.map((sp) => `“${text.slice(sp.start, sp.end).trim()}” read as ${(READ_AS[sp.kind] ?? ((l: string) => l))(label(sp.label))}`);
  for (const m of p.title.matchAll(/(?:^|[\s(\[,;])#(\p{L}[\p{L}\p{N}_-]*)/gu)) if (!several.has(`#${m[1].toLowerCase()}`)) notes.push(`No project called “${m[1]}”, so #${m[1]} stayed in the title.`);
  for (const m of p.title.matchAll(/(?:^|[\s(\[,;])@(\p{L}[\p{L}\p{N}._-]*)/gu)) if (!several.has(`@${m[1].toLowerCase()}`)) notes.push(`No one called “${m[1]}” here, so @${m[1]} stayed in the title.`);
  return { fields, read, notes };
}

/* ------------------------------------------------------------ what a task waits for */

interface Blocker { id: string; title: string }

async function blockersOf(env: ToolEnv, id: string): Promise<{ status: string; blockers: Blocker[]; more: boolean }> {
  const b = await need(env.api("GET", `/tasks/${id}/blockers`));
  return { status: String(b.status ?? ""), blockers: ((b.data ?? []) as Blocker[]).map((x) => ({ id: x.id, title: label(x.title) })), more: !!b.hasMore };
}

/** Marking a task done while it waits for something is a question for the person, as it is in the app. */
async function refuseIfBlocked(env: ToolEnv, id: string): Promise<void> {
  const { status, blockers, more } = await blockersOf(env, id);
  if (status === "done" || !blockers.length) return;
  const list = blockers.slice(0, 3).map((b) => `“${b.title}” (${b.id})`).join(", ");
  throw new ToolFault(`This task is waiting on ${blockers.length}${more ? " or more" : ""} unfinished task${blockers.length === 1 ? "" : "s"}, so it wasn't marked done: ${list}. Check with the person, and send confirmedBlocked: true if they want it done anyway.`);
}

const CONFIRMED_BLOCKED: JsonSchema = { type: "boolean", description: "Send true to finish a task that's still waiting on unfinished tasks, once the person has said so." };

/** A task's answer to being finished: the next occurrence, if it made one. */
const NEXT_OCCURRENCE: JsonSchema = obj({ id: { type: "string" }, dueDate: { type: "string", description: "YYYY-MM-DD" } }, ["id", "dueDate"], "The next occurrence, made because this task repeats.");

function nextWords(next: { id: string; dueDate: string } | undefined): string {
  return next ? ` It repeats, so the next one (${next.id}) is due ${next.dueDate}.` : "";
}

/* ------------------------------------------------------------ the tools */

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** adds something new; nothing already there changes */
const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
/** changes or removes something already there: Claude asks each time for these */
const CHANGE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

const TASK_FIELDS: Record<string, JsonSchema> = {
  description: s("Longer notes.", { maxLength: API_LIMITS.description }),
  status: STATUS_ENUM,
  priority: PRIORITY_ENUM,
  projectId: { type: ["string", "null"], description: "A project's id from list_projects. null is the Personal list." },
  sectionId: { type: ["string", "null"], description: "A section of that project." },
  assigneeId: { type: ["string", "null"], description: "A user id from list_members, or \"me\". null leaves it unassigned." },
  dueDate: { type: ["string", "null"], description: "YYYY-MM-DD." },
  dueTime: { type: ["string", "null"], description: "HH:MM, 24-hour. Needs a dueDate." },
  startDate: { type: ["string", "null"], description: "YYYY-MM-DD." },
  tags: { type: "array", items: { type: "string" }, maxItems: API_LIMITS.tagsPerTask, description: "Tag names or ids. Unknown names become new tags." },
  effortHours: { type: ["number", "null"], minimum: 0, maximum: API_LIMITS.effortHours, description: "Estimated hours." },
};

const TASK_RESULT: JsonSchema = obj({ task: TASK_VIEW, nextOccurrence: NEXT_OCCURRENCE }, ["task"]);

const COUNTS = (description: string): JsonSchema => obj(
  { overdue: { type: "integer" }, dueToday: { type: "integer" }, approvals: { type: "integer" }, planned: { type: "integer" }, blocked: { type: "integer" } },
  ["overdue", "dueToday", "approvals", "planned", "blocked"], description);
const COUNT_OF_KIND = { overdue: "overdue", due_today: "dueToday", approval: "approvals", planned: "planned", blocked: "blocked" } as const;

/** Every line of what someone wrote marked as theirs, so a line of it can't pass for one of Kanbo's. */
const quoted = (text: string) => text.split(/\r\n|\r|\n|\u2028|\u2029/).map((l) => `> ${l}`).join("\n");

/** All the ways the tools spell the Personal list. */
const isPersonalList = (v: unknown) => v == null || (typeof v === "string" && (v.toLowerCase() === "personal" || v === PERSONAL_PROJECT_ID));

const reachesSomeoneElse = (assignee: unknown, env: ToolEnv) => typeof assignee === "string" && assignee !== "me" && assignee !== env.principal.userId;

export const TOOLS: readonly McpTool[] = [
  {
    name: "whoami",
    title: "Who am I",
    description: "Says who this connection acts as: the person's id, name and email, whether it can change things or only read, and whether it's limited to one workspace. Changes nothing.",
    inputSchema: input({}),
    outputSchema: obj({
      id: { type: "string" }, name: nstr("Their name."), email: nstr("Their email."),
      access: { type: "string", enum: ["read", "write"] }, workspaceId: nstr("The one workspace this connection is limited to; null means every workspace they're in."),
      connection: { type: "string", enum: ["oauth", "api_key"] }, app: nstr("The name the connected app gave itself."),
    }, ["id", "access", "connection"]),
    annotations: { title: "Who am I", ...READ },
    write: false,
    routes: [["GET", "/me"]],
    async run(_a, env) {
      const me = await need(env.api("GET", "/me"));
      const out = { id: me.id, name: me.name, email: me.email, access: env.principal.access, workspaceId: env.principal.workspaceId, connection: env.via, app: env.clientName };
      return { structured: out, summary: `Connected as ${me.name ?? me.email ?? me.id}, ${env.principal.access === "write" ? "able to read and change things" : "read only"}.` };
    },
  },
  {
    name: "list_workspaces",
    title: "List workspaces",
    description: "Lists the team workspaces this connection can reach, with the person's role in each. Personal tasks live in the Personal list, which isn't a workspace. Changes nothing.",
    inputSchema: input({}),
    outputSchema: obj({
      workspaces: arr(obj({ id: { type: "string" }, name: { type: "string" }, role: nstr("owner, admin, member or guest") }, ["id", "name"])),
      personalList: { type: "boolean", description: "True when this connection can also reach the person's Personal list." },
    }, ["workspaces", "personalList"]),
    annotations: { title: "List workspaces", ...READ },
    write: false,
    routes: [["GET", "/workspaces"]],
    async run(_a, env) {
      const body = await need(env.api("GET", "/workspaces"));
      const workspaces = (body.data as ApiWorkspace[]).slice(0, 200).map((w) => ({ id: w.id, name: w.name, role: w.role }));
      return { structured: { workspaces, personalList: env.principal.workspaceId === null }, summary: `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}.` };
    },
  },
  {
    name: "list_projects",
    title: "List projects",
    description: "Lists projects this connection can see, oldest first. Filter by workspace, or pass \"personal\" for personal projects. Archived projects are left out unless asked for. Changes nothing.",
    inputSchema: input({
      workspaceId: s("A workspace id, or \"personal\".", { maxLength: 64 }),
      includeArchived: { type: "boolean" },
      limit: LIMIT, cursor: CURSOR,
    }),
    outputSchema: obj({ projects: arr(PROJECT_VIEW), ...PAGE_FIELDS }, ["projects", "nextCursor", "hasMore"]),
    annotations: { title: "List projects", ...READ },
    write: false,
    routes: [["GET", "/projects"]],
    async run(a, env) {
      const out = await fittedPage<ApiProject, ReturnType<typeof projectView>>(Number(pageLimit(a)),
        (limit) => need(env.api("GET", "/projects", { query: { workspace: a.workspaceId, include_archived: a.includeArchived ? "true" : undefined, limit: String(limit), cursor: a.cursor } })),
        projectView, (projects, nextCursor, hasMore) => ({ projects, nextCursor, hasMore }));
      return { structured: out, summary: `${(out.projects as unknown[]).length} project(s)${out.hasMore ? ", and more on the next page" : ""}.` };
    },
  },
  {
    name: "list_members",
    title: "List members",
    description: "Lists the people in a workspace, with their user ids (use these to assign tasks), roles and emails. A connection limited to one workspace may leave workspaceId out. Changes nothing.",
    inputSchema: input({ workspaceId: s("A workspace id from list_workspaces.", { maxLength: 64 }), limit: LIMIT, cursor: CURSOR }),
    outputSchema: obj({
      members: arr(obj({ userId: nstr("null for an invite not yet accepted."), name: { type: "string" }, email: { type: "string" }, role: { type: "string" }, status: { type: "string" }, title: nstr("Their job title.") }, ["name", "role", "status"])),
      ...PAGE_FIELDS,
    }, ["members", "nextCursor", "hasMore"]),
    annotations: { title: "List members", ...READ },
    write: false,
    routes: [["GET", "/members"]],
    async run(a, env) {
      const out = await fittedPage<ApiMember, Record<string, unknown>>(Number(pageLimit(a)),
        (limit) => need(env.api("GET", "/members", { query: { workspace: a.workspaceId, limit: String(limit), cursor: a.cursor } })),
        (m) => ({ userId: m.userId, name: m.name, email: m.email, role: m.role, status: m.status, title: m.title }),
        (members, nextCursor, hasMore) => ({ members, nextCursor, hasMore }));
      return { structured: out, summary: `${(out.members as unknown[]).length} member(s)${out.hasMore ? ", and more on the next page" : ""}.` };
    },
  },
  {
    name: "list_tasks",
    title: "List tasks",
    description: "Lists and filters tasks this connection can see, newest first: by assignee (\"me\"), status, project, workspace, due date range or words in the title and description. Archived tasks are left out. Long descriptions are cut short and flagged; get_task has the rest. parentId lists a task's sub-tasks. Changes nothing.",
    inputSchema: input({
      assignee: s("\"me\", \"none\" (unassigned) or a user id.", { maxLength: 64 }),
      status: { type: "array", items: STATUS_ENUM, maxItems: 5, description: "One or more statuses." },
      projectId: s("A project id, or \"personal\" for the Personal list.", { maxLength: 64 }),
      workspaceId: s("A workspace id, or \"personal\".", { maxLength: 64 }),
      dueBefore: s("Due on or before this day, YYYY-MM-DD.", { maxLength: 10 }),
      dueAfter: s("Due on or after this day, YYYY-MM-DD.", { maxLength: 10 }),
      query: s("Words to look for.", { maxLength: API_LIMITS.q }),
      parentId: s("Only the sub-tasks of this task.", { maxLength: 64 }),
      limit: LIMIT, cursor: CURSOR,
    }),
    outputSchema: obj({ tasks: arr(TASK_VIEW), ...PAGE_FIELDS }, ["tasks", "nextCursor", "hasMore"]),
    annotations: { title: "List tasks", ...READ },
    write: false,
    routes: [["GET", "/tasks"]],
    async run(a, env) {
      const out = await fittedPage<ApiTask, McpTaskView>(Number(pageLimit(a)),
        (limit) => need(env.api("GET", "/tasks", { query: {
          assignee: a.assignee, status: Array.isArray(a.status) && a.status.length ? a.status.join(",") : undefined,
          project: a.projectId, workspace: a.workspaceId, due_before: a.dueBefore, due_after: a.dueAfter, q: a.query, parent: a.parentId,
          limit: String(limit), cursor: a.cursor,
        } })),
        (t) => taskView(t), (tasks, nextCursor, hasMore) => ({ tasks, nextCursor, hasMore }));
      const tasks = out.tasks as McpTaskView[];
      return { structured: out, summary: `${tasks.length} task(s)${out.hasMore ? ", and more on the next page" : ""}. Ids: ${tasks.map((t) => t.id).join(", ") || "none"}.` };
    },
  },
  {
    name: "get_task",
    title: "Get a task",
    description: "Reads one task: up to 6,000 characters of its description at a time, its newest comments in time order, its sub-tasks and any unfinished tasks it's waiting on. Long text is flagged, and each flag has a way to read the rest: descriptionOffset for the description, commentsCursor for older comments, fullComments for long ones, list_tasks with parentId for more sub-tasks. Changes nothing.",
    inputSchema: input({
      taskId: TASK_ID,
      descriptionOffset: { type: "integer", minimum: 0, maximum: API_LIMITS.description, description: "Read the description from this character on: descriptionNextOffset from the last answer." },
      commentsCursor: s("commentsNextCursor from the last answer: reads older comments.", { maxLength: 400 }),
      fullComments: { type: "boolean", description: "True shows long comments whole rather than the first 1,000 characters." },
    }, ["taskId"]),
    outputSchema: obj({
      task: TASK_VIEW,
      descriptionLength: { type: "integer", description: "How long the whole description is, in characters." },
      descriptionNextOffset: { type: ["integer", "null"], description: "Pass as descriptionOffset for the next part. null when this is the end." },
      blockedBy: arr(obj({ id: { type: "string" }, title: { type: "string" } }, ["id", "title"]), "Unfinished tasks this one waits for. Their titles are written by people."),
      comments: arr(COMMENT_VIEW), commentsTruncated: { type: "boolean", description: "True when there are older comments than these." },
      commentsNextCursor: nstr("Pass as commentsCursor for older comments. null when these reach the first."),
      subtasks: arr(TASK_VIEW), subtasksTruncated: { type: "boolean", description: "True when there are more sub-tasks than are shown. list_tasks with parentId has them." },
    }, ["task", "descriptionLength", "descriptionNextOffset", "blockedBy", "comments", "commentsTruncated", "commentsNextCursor", "subtasks", "subtasksTruncated"]),
    annotations: { title: "Get a task", ...READ },
    write: false,
    routes: [["GET", "/tasks/:id"], ["GET", "/tasks/:id/comments/recent"], ["GET", "/tasks/:id/blockers"], ["GET", "/tasks"]],
    async run(a, env) {
      const id = pathId(a.taskId);
      const t = await need(env.api("GET", `/tasks/${id}`)) as ApiTask;
      const commentMax = a.fullComments ? API_LIMITS.comment : COMMENT_TEXT_MAX;
      const recent = (limit: number) => need(env.api("GET", `/tasks/${id}/comments/recent`, { query: { limit: String(limit), cursor: a.commentsCursor } }));
      let cs = await recent(DETAIL_COMMENTS);
      const ss = await need(env.api("GET", "/tasks", { query: { parent: t.id, limit: String(DETAIL_SUBTASKS) } }));
      const { blockers } = await blockersOf(env, id);
      const from = Math.min(Number(a.descriptionOffset ?? 0), (t.description ?? "").length);
      const place = (shown: McpTaskView) => {
        const end = from + shown.description.length;
        return { descriptionLength: (t.description ?? "").length, descriptionNextOffset: shown.descriptionTruncated ? end : null };
      };
      const task = taskView(t, DETAIL_TEXT_MAX, from);
      const out = {
        task,
        ...place(task),
        blockedBy: blockers,
        // they come newest first, and read in time order
        comments: (cs.data as ApiComment[]).map((c) => commentView(c, commentMax)).reverse(),
        commentsTruncated: !!cs.hasMore,
        commentsNextCursor: (cs.nextCursor ?? null) as string | null,
        subtasks: (ss.data as ApiTask[]).map((x) => taskView(x)),
        subtasksTruncated: !!ss.hasMore,
      };
      // over the cap: the sub-tasks go first, then the oldest comments (asked for again, so the cursor stays true), then the description shortens
      while (size(out) > MAX_JSON_CHARS && out.subtasks.length) { out.subtasks.pop(); out.subtasksTruncated = true; }
      if (size(out) > MAX_JSON_CHARS && out.comments.length > 1) {
        const views = out.comments.slice();
        while (size({ ...out, comments: views }) > MAX_JSON_CHARS && views.length > 1) views.shift();
        cs = await recent(views.length);
        out.comments = (cs.data as ApiComment[]).map((c) => commentView(c, commentMax)).reverse();
        out.commentsTruncated = !!cs.hasMore;
        out.commentsNextCursor = (cs.nextCursor ?? null) as string | null;
      }
      if (size(out) > MAX_JSON_CHARS) {
        out.task = taskView(t, DETAIL_TEXT_MAX / 2, from);
        Object.assign(out, place(out.task));
      }
      if (size(out) > MAX_JSON_CHARS) out.comments = (cs.data as ApiComment[]).map((c) => commentView(c)).reverse();
      return { structured: out, summary: `“${t.title}” (${t.id}): ${t.status}${t.dueDate ? `, due ${t.dueDate}` : ""}${t.recurrence && t.recurrence !== "none" ? `, repeats ${t.recurrence}` : ""}${blockers.length ? `, waiting on ${blockers.length} unfinished task${blockers.length === 1 ? "" : "s"}` : ""}.` };
    },
  },
  {
    name: "search",
    title: "Search Kanbo",
    description: "Finds tasks and projects by words in their titles, descriptions and comments. Returns ids to pass to fetch. Changes nothing.",
    inputSchema: input({ query: s("What to look for.", { minLength: 1, maxLength: 200 }) }, ["query"]),
    outputSchema: obj({
      results: arr(obj({ id: { type: "string" }, title: { type: "string" }, url: { type: "string" } }, ["id", "title", "url"])),
    }, ["results"]),
    annotations: { title: "Search Kanbo", ...READ },
    write: false,
    routes: [["GET", "/search"]],
    async run(a, env) {
      const body = await need(env.api("GET", "/search", { query: { q: String(a.query) } }));
      const results = (body.data as { kind: string; id: string; title: string; url: string | null }[])
        .map((h) => ({ id: `${h.kind}:${h.id}`, title: h.title || "Untitled", url: h.url || MCP_ISSUER }));
      while (size({ results }) > MAX_JSON_CHARS) results.pop();
      return { structured: { results } };
    },
  },
  {
    name: "fetch",
    title: "Read a search result",
    description: "Reads one result from search: a task with its description and its newest comments, or a project with its description. What people wrote is quoted, each line starting with \"> \", under a line from Kanbo saying who wrote it and when, and the comments are in metadata as well. Takes the id search gave. To change a description, read it with get_task. Changes nothing.",
    inputSchema: input({ id: s("An id from search, such as task:… or project:…. A bare id is read as a task.", { minLength: 1, maxLength: 80 }) }, ["id"]),
    outputSchema: obj({
      id: { type: "string" }, title: { type: "string" }, text: { type: "string" }, url: { type: "string" },
      metadata: obj({ truncated: { type: "boolean" }, kind: { type: "string" } }, [], "Details about the item."),
    }, ["id", "title", "text", "url"]),
    annotations: { title: "Read a search result", ...READ },
    write: false,
    routes: [["GET", "/tasks/:id"], ["GET", "/tasks/:id/comments/recent"], ["GET", "/projects/:id"]],
    async run(a, env) {
      const raw = String(a.id);
      const m = /^(task|project):(.+)$/.exec(raw);
      const kind = m ? m[1] : "task";
      const id = pathId(m ? m[2] : raw);
      if (kind === "project") {
        const p = await need(env.api("GET", `/projects/${id}`)) as ApiProject;
        const d = cut(p.description ?? "", DETAIL_TEXT_MAX);
        return { structured: { id: `project:${p.id}`, title: p.name, text: d.text ? `Description:\n${quoted(d.text)}` : "This project has no description.", url: p.url || MCP_ISSUER, metadata: { kind: "project", status: p.status, workspaceId: p.workspaceId, truncated: d.truncated } } };
      }
      const t = await need(env.api("GET", `/tasks/${id}`)) as ApiTask;
      const cs = await need(env.api("GET", `/tasks/${id}/comments/recent`, { query: { limit: String(DETAIL_COMMENTS) } }));
      const d = cut(t.description ?? "", DETAIL_TEXT_MAX);
      // newest first from the route; over the cap the oldest go, because the newest is usually the one that matters
      const comments = (cs.data as ApiComment[]).map((c) => {
        const b = cut(c.body ?? "", COMMENT_TEXT_MAX);
        return { id: c.id, authorName: label(c.authorName), createdAt: c.createdAt, body: b.text, bodyTruncated: b.truncated };
      }).reverse();
      const answer = (shown: typeof comments, description: string) => {
        const lines = [description ? `Description:\n${quoted(description)}` : "This task has no description."];
        shown.forEach((c, i) => lines.push(`Comment ${i + 1} of ${shown.length} by ${c.authorName}${c.createdAt ? ` on ${c.createdAt.slice(0, 10)}` : ""}:\n${quoted(c.body)}`));
        return {
          id: `task:${t.id}`, title: t.title, text: lines.join("\n\n"), url: t.url || MCP_ISSUER,
          metadata: { kind: "task", status: t.status, priority: t.priority, dueDate: t.dueDate, assigneeId: t.assigneeId, projectId: t.projectId, workspaceId: t.workspaceId, recurrence: t.recurrence ?? "none", comments: shown, truncated: d.truncated || shown.length < comments.length || !!cs.hasMore },
        };
      };
      let shown = comments;
      let out = answer(shown, d.text);
      while (size(out) > MAX_JSON_CHARS && shown.length) { shown = shown.slice(1); out = answer(shown, d.text); }
      if (size(out) > MAX_JSON_CHARS) {
        out = answer(shown, cut(d.text, DETAIL_TEXT_MAX / 2).text);
        out.metadata.truncated = true;
      }
      return { structured: out };
    },
  },
  {
    name: "my_day",
    title: "My day",
    description: "Answers \"what do I need to get done today?\" for the person: overdue, due today, approvals waiting on them, on their plan for today, then blocked, in that order, with a one-line reason for each. Everything due today is listed; overdue and blocked are limited to the most urgent ten, and the counts and summary cover everything. Worked out directly from their tasks in their time zone, with no AI involved. Changes nothing.",
    inputSchema: input({ timezone: TIMEZONE }),
    outputSchema: obj({
      date: { type: "string", description: "Today in the person's time zone, YYYY-MM-DD." },
      timezone: { type: "string" },
      summary: { type: "string" },
      counts: COUNTS("How many of each there are in all."),
      items: arr(obj({
        kind: { type: "string", enum: ["overdue", "due_today", "approval", "planned", "blocked"] },
        taskId: { type: "string" }, title: { type: "string", description: "Written by a person." }, reason: { type: "string", description: "Kanbo's own words." }, status: { type: "string" }, priority: { type: "string" },
        dueDate: nstr("YYYY-MM-DD"), dueTime: nstr("HH:MM"), projectId: nstr("The task's project."), workspaceId: nstr("The task's workspace."), url: nstr("Opens the task in Kanbo."),
        approvalId: nstr("Set on an approval."),
        blockedByTitle: nstr("The title of an unfinished task this one waits for. Written by a person."),
        requesterName: nstr("Who asked for this approval. Written by a person."),
      }, ["kind", "taskId", "title", "reason"])),
      notShown: COUNTS("How many of each aren't in items. list_tasks has the rest of the overdue and blocked ones."),
      truncated: { type: "boolean", description: "True when something isn't in items. The counts and summary cover everything." },
    }, ["date", "timezone", "summary", "counts", "items", "notShown", "truncated"]),
    annotations: { title: "My day", ...READ },
    write: false,
    routes: [["GET", "/my-day"]],
    async run(a, env) {
      const day = await need(env.api("GET", "/my-day", { query: { timezone: a.timezone } }));
      const items = day.items as Record<string, unknown>[];
      const notShown: MyDayCounts = { overdue: 0, dueToday: 0, approvals: 0, planned: 0, blocked: 0, ...day.notShown };
      const out = { date: day.date, timezone: day.timezone, summary: day.summary, counts: day.counts, items, notShown, truncated: !!day.truncated };
      // over the size cap, what's waiting on them today is the last to go
      const lastOf = (kind: string) => items.map((i) => i.kind).lastIndexOf(kind);
      while (size(out) > MAX_JSON_CHARS && items.length) {
        const kind = (["blocked", "overdue", "planned", "due_today", "approval"] as const).find((k) => lastOf(k) >= 0)!;
        items.splice(lastOf(kind), 1);
        notShown[COUNT_OF_KIND[kind]]++;
        out.truncated = true;
      }
      const more = notShown.overdue ? ` ${notShown.overdue} more overdue aren't listed: list_tasks with assignee "me" and dueBefore has them.` : "";
      return { structured: out, summary: `${day.date}: ${day.summary}${more}` };
    },
  },
  {
    name: "add_task",
    title: "Add a task",
    description: "Adds one task. Give a title and fields, or a sentence in text, read the way Kanbo's Quick capture reads it: \"Send the brief fri 3pm #launch @sana !high ~30m\" (#project, @person, !priority, ~estimate, a day and a time). Names have to match properly: an exact name, a first name or the start of a word, and only one person or project. Anything else stays in the title and is listed in notes, and read says how the sentence was understood. Fields you give win over what the sentence says. Without a project it goes on the person's Personal list, assigned to them. Assigning reaches that person in their Kanbo Inbox, with no email or push. Adds one task only; it doesn't change or remove others.",
    inputSchema: input({
      text: s("A task sentence. Use this or title.", { maxLength: 2000 }),
      title: s("The task's title. Use this or text.", { maxLength: API_LIMITS.title }),
      ...TASK_FIELDS,
      parentId: s("Makes it a sub-task of this task.", { maxLength: 64 }),
      timezone: TIMEZONE,
      idempotencyKey: IDEMPOTENCY,
    }),
    outputSchema: obj({
      task: TASK_VIEW,
      read: arr({ type: "string" }, "What was taken out of the sentence and how it was read. Check these: an ordinary word can read as a date."),
      notes: arr({ type: "string" }, "Anything in the sentence that couldn't be matched."),
    }, ["task", "read", "notes"]),
    annotations: { title: "Add a task", ...ADD },
    write: true,
    routes: [["POST", "/tasks"], ["GET", "/projects"], ["GET", "/members"], ["GET", "/me/timezone"]],
    async run(a, env) {
      if (a.timezone !== undefined && !isTimeZone(a.timezone)) throw new ToolFault("timezone: Use a time zone name like Europe/London.");
      const { text, timezone, idempotencyKey, ...given } = a;
      if (!text && !given.title) throw new ToolFault("Give the task a title, or a sentence in text.");
      const hint = typeof given.projectId === "string" ? given.projectId : undefined;
      const read = text ? await readSentence(String(text), timezone ?? await zoneOf(env), hint, env) : { fields: {}, read: [], notes: [] };
      const body: Record<string, unknown> = { ...read.fields, ...given };
      if (!body.title) throw new ToolFault("That sentence has no words left for a title. Add what the task is.");
      // the Personal list is yours: a task there with no one on it would never show in My tasks
      if (isPersonalList(body.projectId) && !body.parentId && body.assigneeId === undefined && !env.principal.workspaceId) body.assigneeId = "me";
      if (reachesSomeoneElse(body.assigneeId, env)) await env.spend?.("reach");
      const made = await need(env.api("POST", "/tasks", { body, idempotencyKey })) as ApiTask;
      const said = [...(read.read.length ? [`Read: ${read.read.join("; ")}.`] : []), ...read.notes];
      return { structured: { task: taskView(made), read: read.read, notes: read.notes }, summary: `Added “${made.title}” (${made.id}).${said.length ? ` ${said.join(" ")}` : ""}` };
    },
  },
  {
    name: "update_task",
    title: "Update a task",
    description: "Changes the fields you give on one task: title, description, status, priority, project, section, assignee, dates, tags or estimate. Fields left out stay as they are. A new description replaces all of the old one and the old text can't be got back, so appendToDescription is the way to add to it; a shortened copy of a long description is refused. Assigning reaches that person in their Kanbo Inbox, with no email or push, and takes the task off the old assignee's plan. Status done works as complete_task does. Changes one task only.",
    inputSchema: input({
      taskId: TASK_ID,
      title: s("The new title.", { maxLength: API_LIMITS.title, minLength: 1 }),
      ...TASK_FIELDS,
      description: s("A new description, replacing all of the old one. To add to it, use appendToDescription.", { maxLength: API_LIMITS.description }),
      appendToDescription: s("Text to add to the end of the description, after a blank line. Nothing has to be read first, and nothing already there changes.", { minLength: 1, maxLength: API_LIMITS.description }),
      confirmReplaceDescription: { type: "boolean", description: "Send true to replace a long description with one that starts the same way, once the person has said the rest should go." },
      confirmedBlocked: CONFIRMED_BLOCKED,
    }, ["taskId"]),
    outputSchema: TASK_RESULT,
    annotations: { title: "Update a task", ...CHANGE },
    write: true,
    routes: [["PATCH", "/tasks/:id/tool"], ["GET", "/tasks/:id/blockers"]],
    async run(a, env) {
      const { taskId, confirmedBlocked, ...fields } = a;
      const id = pathId(taskId);
      if (!Object.keys(fields).filter((k) => k !== "confirmReplaceDescription").length) throw new ToolFault("Say what to change: give at least one field as well as taskId.");
      if (fields.description !== undefined && fields.appendToDescription !== undefined) throw new ToolFault("Send description or appendToDescription, not both. Nothing was changed.");
      if (fields.status === "done" && !confirmedBlocked) await refuseIfBlocked(env, id);
      if (reachesSomeoneElse(fields.assigneeId, env)) await env.spend?.("reach");
      const t = await need(env.api("PATCH", `/tasks/${id}/tool`, { body: fields })) as ApiTask & { nextOccurrence?: { id: string; dueDate: string } };
      return { structured: { task: taskView(t), ...(t.nextOccurrence ? { nextOccurrence: t.nextOccurrence } : {}) }, summary: `Updated “${t.title}” (${t.id}).${nextWords(t.nextOccurrence)}` };
    },
  },
  {
    name: "complete_task",
    title: "Complete a task",
    description: "Marks one task as done. The project's own \"task completed\" automations run, as they do in the app. A repeating task makes its next occurrence, and the answer says when it's due. A task still waiting on unfinished tasks is refused until the person has said to go ahead (confirmedBlocked), as the app asks. Doing it to a task that's already done changes nothing.",
    inputSchema: input({ taskId: TASK_ID, confirmedBlocked: CONFIRMED_BLOCKED }, ["taskId"]),
    outputSchema: TASK_RESULT,
    annotations: { title: "Complete a task", ...CHANGE },
    write: true,
    routes: [["POST", "/tasks/:id/complete"], ["GET", "/tasks/:id/blockers"]],
    async run(a, env) {
      const id = pathId(a.taskId);
      if (!a.confirmedBlocked) await refuseIfBlocked(env, id);
      const t = await need(env.api("POST", `/tasks/${id}/complete`)) as ApiTask & { nextOccurrence?: { id: string; dueDate: string } };
      return { structured: { task: taskView(t), ...(t.nextOccurrence ? { nextOccurrence: t.nextOccurrence } : {}) }, summary: `Marked “${t.title}” (${t.id}) as done.${nextWords(t.nextOccurrence)}` };
    },
  },
  {
    name: "delete_task",
    title: "Move a task to the recycle bin",
    description: "Moves one task, with its sub-tasks and comments, to Kanbo's recycle bin. It can be restored from the bin in the app for 30 days. This tool can't delete anything permanently and works on one task at a time.",
    inputSchema: input({ taskId: TASK_ID }, ["taskId"]),
    outputSchema: obj({
      id: { type: "string" }, title: { type: "string" }, inRecycleBin: { type: "boolean" }, keptForDays: { type: "integer" },
    }, ["id", "title", "inRecycleBin", "keptForDays"]),
    annotations: { title: "Move a task to the recycle bin", ...CHANGE },
    write: true,
    routes: [["DELETE", "/tasks/:id/bin"]],
    async run(a, env) {
      await env.spend?.("delete");
      const r = await need(env.api("DELETE", `/tasks/${pathId(a.taskId)}/bin`));
      return { structured: { id: r.id, title: r.title, inRecycleBin: r.inRecycleBin, keptForDays: r.keptForDays }, summary: `Moved “${r.title}” (${r.id}) to the recycle bin. It can be restored for ${r.keptForDays} days.` };
    },
  },
  {
    name: "add_comment",
    title: "Add a comment",
    description: "Adds a comment to one task, as the person, or a reply to a comment on it. Guests can comment too. It reaches the task's creator, assignee and followers in their Kanbo Inbox. Writing @Name also reaches that person, when it's their full name or a first name only one person in the workspace has; the answer says who was mentioned and which @names reached nobody. No email or push is sent. Doesn't change the task itself.",
    inputSchema: input({
      taskId: TASK_ID,
      body: s("The comment.", { minLength: 1, maxLength: API_LIMITS.comment }),
      parentId: s("Replies to this comment on the task.", { maxLength: 64 }),
      idempotencyKey: IDEMPOTENCY,
    }, ["taskId", "body"]),
    outputSchema: obj({
      comment: COMMENT_VIEW,
      mentioned: arr({ type: "string" }, "The people an @name in it reached."),
      notes: arr({ type: "string" }, "Any @name that reached nobody, and why."),
    }, ["comment", "mentioned", "notes"]),
    annotations: { title: "Add a comment", ...ADD },
    write: true,
    routes: [["POST", "/tasks/:id/comments/tool"]],
    async run(a, env) {
      await env.spend?.("reach");
      const c = await need(env.api("POST", `/tasks/${pathId(a.taskId)}/comments/tool`, {
        body: { body: a.body, ...(a.parentId ? { parentId: a.parentId } : {}) }, idempotencyKey: a.idempotencyKey,
      })) as ApiComment & { mentioned?: string[]; notes?: string[] };
      const mentioned = (c.mentioned ?? []).map(label), notes = c.notes ?? [];
      return { structured: { comment: commentView(c), mentioned, notes }, summary: `Commented on task ${c.taskId} (comment ${c.id}).${mentioned.length ? ` Mentioned ${mentioned.join(", ")}.` : ""}${notes.length ? ` ${notes.join(" ")}` : ""}` };
    },
  },
  {
    name: "create_project",
    title: "Create a project",
    description: "Creates one project in a workspace, or a personal one if no workspace is given. Doesn't move any tasks into it. A connection limited to one workspace creates it there.",
    inputSchema: input({
      name: s("The project's name.", { minLength: 1, maxLength: API_LIMITS.projectName }),
      workspaceId: { type: ["string", "null"], description: "A workspace id from list_workspaces. null makes a personal project." },
      description: s("What the project is for.", { maxLength: API_LIMITS.projectDescription }),
      emoji: s("One emoji.", { maxLength: API_LIMITS.emoji }),
      status: { type: "string", enum: PROJECT_STATUSES },
      idempotencyKey: IDEMPOTENCY,
    }, ["name"]),
    outputSchema: obj({ project: PROJECT_VIEW }, ["project"]),
    annotations: { title: "Create a project", ...ADD },
    write: true,
    routes: [["POST", "/projects"]],
    async run(a, env) {
      const { idempotencyKey, ...body } = a;
      const p = await need(env.api("POST", "/projects", { body, idempotencyKey })) as ApiProject;
      return { structured: { project: projectView(p) }, summary: `Created project “${p.name}” (${p.id}).` };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
export const toolNamed = (name: string) => BY_NAME.get(name);

/** What tools/list says about a tool. */
export function describeTool(t: McpTool) {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations };
}

/** The tools this credential sees: read-only ones don't see write tools. Always in the same order. */
export function toolsFor(access: "read" | "write"): McpTool[] {
  return TOOLS.filter((t) => access === "write" || !t.write);
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const toolError = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const READ_ONLY_REFUSAL = {
  oauth: "This connection is read-only, so nothing was changed. To let it make changes, connect the app again and choose Read and change.",
  api_key: "This key is read-only, so nothing was changed. Use a read & write key (kanbo_sk_…) to make changes.",
};

/** Runs a known tool. Every failure comes back as an isError result in plain words. */
export async function runTool(tool: McpTool, args: unknown, env: ToolEnv, log: (message: string, extra?: Record<string, unknown>) => void = () => undefined): Promise<ToolResult> {
  // a deliberate isError, not 403 insufficient_scope: the person chose read-only, and a 403 would keep asking them to sign in again
  if (tool.write && env.principal.access !== "write") return toolError(READ_ONLY_REFUSAL[env.via]);
  const a = args ?? {};
  const problems = schemaErrors(tool.inputSchema, a);
  if (problems.length) return toolError(problems.join(" "));
  try {
    const out = await tool.run(a as Record<string, unknown>, env);
    const json = JSON.stringify(out.structured);
    return { content: [{ type: "text", text: out.summary ? `${out.summary}\n\n${json}` : json }], structuredContent: out.structured };
  } catch (e) {
    if (e instanceof ToolFault) return toolError(e.message);
    log(`[mcp] tool ${tool.name} failed`, { message: String((e as Error)?.message ?? e).slice(0, 300) });
    return toolError("Kanbo couldn't do that just now. Try again in a moment.");
  }
}
