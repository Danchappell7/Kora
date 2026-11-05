// ============================================================
// KANBO — MCP: the tools.
//
// Every tool calls the REST API's own pipeline (env.api → handleApiRequest with
// the resolved person), so validation, RLS through db.withUser, one-workspace
// pinning, rate limits, idempotency and audit are the API's, not copies of them.
// A tool only chooses what to call and shapes the answer for a model: smaller
// tasks, long text cut with a flag, and a cap on the whole answer.
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
import { API_LIMITS, PROJECT_STATUSES } from "../api/validate.ts";
import { schemaErrors, type JsonSchema } from "./jsonSchema.ts";
import { MCP_ISSUER } from "./metadata.ts";
import { DEFAULT_TIMEZONE, dateInZone, isTimeZone, localMidnight } from "./myDay.ts";

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
}

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
const LIST_TEXT_MAX = 200;
const DETAIL_TEXT_MAX = 6_000;
const COMMENT_TEXT_MAX = 1_000;
const DETAIL_COMMENTS = 20;
const DETAIL_SUBTASKS = 20;

const size = (v: unknown) => JSON.stringify(v).length;

/** At most `max` characters, never splitting a surrogate pair. */
export function cut(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xD800 && c <= 0xDBFF) end--;
  return { text: s.slice(0, end), truncated: true };
}

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
  description: string; descriptionTruncated: boolean;
}

export function taskView(t: ApiTask, textMax = LIST_TEXT_MAX): McpTaskView {
  const d = cut(t.description ?? "", textMax);
  return {
    id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate, dueTime: t.dueTime,
    startDate: t.startDate, completedAt: t.completedAt, projectId: t.projectId, workspaceId: t.workspaceId,
    sectionId: t.sectionId, parentId: t.parentId, assigneeId: t.assigneeId,
    tags: (t.tags ?? []).map((g) => g.label ?? g.id),
    effortHours: t.effortHours, archived: t.archived, url: t.url, updatedAt: t.updatedAt,
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

function commentView(c: ApiComment) {
  const b = cut(c.body ?? "", COMMENT_TEXT_MAX);
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
  description: { type: "string" }, descriptionTruncated: { type: "boolean", description: "True when the description was cut short." },
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

interface Sentence { fields: Record<string, unknown>; notes: string[] }

/**
 * "Send the brief fri 3pm #launch @sana !high ~30m", read by the one grammar the app's Quick capture
 * and the Slack app use: #project against the projects this person can see, @person against the
 * members of that project's workspace. Whatever can't be matched stays in the title, and is mentioned.
 */
async function readSentence(text: string, tz: string, projectHint: string | undefined, env: ToolEnv): Promise<Sentence> {
  const today = localMidnight(dateInZone(env.now(), tz));
  const projectsBody = await need(env.api("GET", "/projects", { query: { limit: "100" } }));
  const projects: ApiProject[] = projectsBody.data ?? [];
  const named = projects.map((p) => ({ id: p.id, name: p.name }));
  const first = parseTask(text, { today, kinds: NL_KINDS, projects: named, members: [] });
  // which workspace's people does @someone mean?
  const projectId = projectHint ?? first.projectId;
  const ws = projects.find((p) => p.id === projectId)?.workspaceId ?? env.principal.workspaceId;
  let members: { id: string; name: string }[] = [];
  if (ws) {
    // if the people can't be read, @someone just stays in the title and is mentioned: the task still gets added
    const a = await env.api("GET", "/members", { query: { workspace: ws, limit: "100" } });
    if (a.status < 400) members = (a.body?.data as ApiMember[] ?? []).filter((m) => m.status === "active" && m.userId).map((m) => ({ id: m.userId!, name: m.name }));
  }
  const p = parseTask(text, { today, kinds: NL_KINDS, projects: named, members: [{ id: env.principal.userId, name: "me" }, ...members] });
  const fields: Record<string, unknown> = { title: p.title };
  if (p.dueDate) fields.dueDate = p.dueDate;
  if (p.dueTime) fields.dueTime = p.dueTime;
  if (p.startDate && (!p.dueDate || p.startDate <= p.dueDate)) fields.startDate = p.startDate;
  if (p.priority) fields.priority = p.priority;
  if (p.projectId) fields.projectId = p.projectId;
  if (p.assigneeId) fields.assigneeId = p.assigneeId === env.principal.userId ? "me" : p.assigneeId;
  if (p.effortHours !== undefined) fields.effortHours = p.effortHours;
  const notes: string[] = [];
  for (const m of p.title.matchAll(/(?:^|[\s(\[,;])#(\p{L}[\p{L}\p{N}_-]*)/gu)) notes.push(`No project called “${m[1]}”, so #${m[1]} stayed in the title.`);
  for (const m of p.title.matchAll(/(?:^|[\s(\[,;])@(\p{L}[\p{L}\p{N}._-]*)/gu)) notes.push(`No one called “${m[1]}” here, so @${m[1]} stayed in the title.`);
  return { fields, notes };
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

const TASK_RESULT: JsonSchema = obj({ task: TASK_VIEW }, ["task"]);

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
    description: "Lists and filters tasks this connection can see, newest first: by assignee (\"me\"), status, project, workspace, due date range or words in the title and description. Archived tasks are left out. Long descriptions are cut short and flagged; get_task has the rest. Changes nothing.",
    inputSchema: input({
      assignee: s("\"me\", \"none\" (unassigned) or a user id.", { maxLength: 64 }),
      status: { type: "array", items: STATUS_ENUM, maxItems: 5, description: "One or more statuses." },
      projectId: s("A project id, or \"personal\" for the Personal list.", { maxLength: 64 }),
      workspaceId: s("A workspace id, or \"personal\".", { maxLength: 64 }),
      dueBefore: s("Due on or before this day, YYYY-MM-DD.", { maxLength: 10 }),
      dueAfter: s("Due on or after this day, YYYY-MM-DD.", { maxLength: 10 }),
      query: s("Words to look for.", { maxLength: API_LIMITS.q }),
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
          project: a.projectId, workspace: a.workspaceId, due_before: a.dueBefore, due_after: a.dueAfter, q: a.query,
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
    description: "Reads one task with its full description, its comments and its sub-tasks. Very long text is cut short and flagged. Changes nothing.",
    inputSchema: input({ taskId: TASK_ID }, ["taskId"]),
    outputSchema: obj({
      task: TASK_VIEW,
      comments: arr(COMMENT_VIEW), commentsTruncated: { type: "boolean", description: "True when there are more comments than are shown." },
      subtasks: arr(TASK_VIEW), subtasksTruncated: { type: "boolean", description: "True when there are more sub-tasks than are shown." },
    }, ["task", "comments", "commentsTruncated", "subtasks", "subtasksTruncated"]),
    annotations: { title: "Get a task", ...READ },
    write: false,
    routes: [["GET", "/tasks/:id"], ["GET", "/tasks/:id/comments"], ["GET", "/tasks"]],
    async run(a, env) {
      const id = pathId(a.taskId);
      const t = await need(env.api("GET", `/tasks/${id}`)) as ApiTask;
      const cs = await need(env.api("GET", `/tasks/${id}/comments`, { query: { limit: String(DETAIL_COMMENTS) } }));
      const ss = await need(env.api("GET", "/tasks", { query: { parent: t.id, limit: String(DETAIL_SUBTASKS) } }));
      const out = {
        task: taskView(t, DETAIL_TEXT_MAX),
        comments: (cs.data as ApiComment[]).map(commentView),
        commentsTruncated: !!cs.hasMore,
        subtasks: (ss.data as ApiTask[]).map((x) => taskView(x)),
        subtasksTruncated: !!ss.hasMore,
      };
      // over the cap: the newest comments and sub-tasks go first, then the description shortens
      while (size(out) > MAX_JSON_CHARS && out.subtasks.length) { out.subtasks.pop(); out.subtasksTruncated = true; }
      while (size(out) > MAX_JSON_CHARS && out.comments.length) { out.comments.pop(); out.commentsTruncated = true; }
      if (size(out) > MAX_JSON_CHARS) out.task = taskView(t, DETAIL_TEXT_MAX / 2);
      return { structured: out, summary: `“${t.title}” (${t.id}): ${t.status}${t.dueDate ? `, due ${t.dueDate}` : ""}.` };
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
    description: "Reads one result from search in full: a task with its description and comments, or a project with its description. Takes the id search gave. Changes nothing.",
    inputSchema: input({ id: s("An id from search, such as task:… or project:…. A bare id is read as a task.", { minLength: 1, maxLength: 80 }) }, ["id"]),
    outputSchema: obj({
      id: { type: "string" }, title: { type: "string" }, text: { type: "string" }, url: { type: "string" },
      metadata: obj({ truncated: { type: "boolean" }, kind: { type: "string" } }, [], "Details about the item."),
    }, ["id", "title", "text", "url"]),
    annotations: { title: "Read a search result", ...READ },
    write: false,
    routes: [["GET", "/tasks/:id"], ["GET", "/tasks/:id/comments"], ["GET", "/projects/:id"]],
    async run(a, env) {
      const raw = String(a.id);
      const m = /^(task|project):(.+)$/.exec(raw);
      const kind = m ? m[1] : "task";
      const id = pathId(m ? m[2] : raw);
      if (kind === "project") {
        const p = await need(env.api("GET", `/projects/${id}`)) as ApiProject;
        const d = cut(p.description ?? "", DETAIL_TEXT_MAX);
        return { structured: { id: `project:${p.id}`, title: p.name, text: d.text || "This project has no description.", url: p.url || MCP_ISSUER, metadata: { kind: "project", status: p.status, workspaceId: p.workspaceId, truncated: d.truncated } } };
      }
      const t = await need(env.api("GET", `/tasks/${id}`)) as ApiTask;
      const cs = await need(env.api("GET", `/tasks/${id}/comments`, { query: { limit: String(DETAIL_COMMENTS) } }));
      const d = cut(t.description ?? "", DETAIL_TEXT_MAX);
      const lines = [d.text || "This task has no description."];
      for (const c of cs.data as ApiComment[]) lines.push(`\n${c.authorName}${c.createdAt ? ` (${c.createdAt.slice(0, 10)})` : ""}: ${cut(c.body ?? "", COMMENT_TEXT_MAX).text}`);
      const whole = cut(lines.join("\n"), Math.floor(MAX_JSON_CHARS * 0.8));
      return { structured: {
        id: `task:${t.id}`, title: t.title, text: whole.text, url: t.url || MCP_ISSUER,
        metadata: { kind: "task", status: t.status, priority: t.priority, dueDate: t.dueDate, assigneeId: t.assigneeId, projectId: t.projectId, workspaceId: t.workspaceId, truncated: d.truncated || whole.truncated || !!cs.hasMore },
      } };
    },
  },
  {
    name: "my_day",
    title: "My day",
    description: "Answers \"what do I need to get done today?\" for the person: overdue, due today, approvals waiting on them, on their plan for today, then blocked, in that order, with a one-line reason for each. Worked out directly from their tasks in their time zone, with no AI involved. Changes nothing.",
    inputSchema: input({ timezone: TIMEZONE }),
    outputSchema: obj({
      date: { type: "string", description: "Today in the person's time zone, YYYY-MM-DD." },
      timezone: { type: "string" },
      summary: { type: "string" },
      counts: obj({ overdue: { type: "integer" }, dueToday: { type: "integer" }, approvals: { type: "integer" }, planned: { type: "integer" }, blocked: { type: "integer" } }, ["overdue", "dueToday", "approvals", "planned", "blocked"]),
      items: arr(obj({
        kind: { type: "string", enum: ["overdue", "due_today", "approval", "planned", "blocked"] },
        taskId: { type: "string" }, title: { type: "string" }, reason: { type: "string" }, status: { type: "string" }, priority: { type: "string" },
        dueDate: nstr("YYYY-MM-DD"), dueTime: nstr("HH:MM"), projectId: nstr("The task's project."), workspaceId: nstr("The task's workspace."), url: nstr("Opens the task in Kanbo."),
        approvalId: nstr("Set on an approval."),
      }, ["kind", "taskId", "title", "reason"])),
      truncated: { type: "boolean", description: "True when there's more than is listed. The counts cover everything." },
    }, ["date", "timezone", "summary", "counts", "items", "truncated"]),
    annotations: { title: "My day", ...READ },
    write: false,
    routes: [["GET", "/my-day"]],
    async run(a, env) {
      const day = await need(env.api("GET", "/my-day", { query: { timezone: a.timezone } }));
      const items = day.items as Record<string, unknown>[];
      const out = { date: day.date, timezone: day.timezone, summary: day.summary, counts: day.counts, items, truncated: !!day.truncated };
      while (size(out) > MAX_JSON_CHARS && items.length) { items.pop(); out.truncated = true; }
      return { structured: out, summary: `${day.date}: ${day.summary}` };
    },
  },
  {
    name: "add_task",
    title: "Add a task",
    description: "Adds one task. Give a title and fields, or a sentence in text, read the way Kanbo's Quick capture reads it: \"Send the brief fri 3pm #launch @sana !high ~30m\" (#project, @person, !priority, ~estimate, a day and a time). Fields you give win over what the sentence says. Without a project it goes on the person's Personal list, assigned to them. Adds one task only; it doesn't change or remove others.",
    inputSchema: input({
      text: s("A task sentence. Use this or title.", { maxLength: 2000 }),
      title: s("The task's title. Use this or text.", { maxLength: API_LIMITS.title }),
      ...TASK_FIELDS,
      parentId: s("Makes it a sub-task of this task.", { maxLength: 64 }),
      timezone: TIMEZONE,
      idempotencyKey: IDEMPOTENCY,
    }),
    outputSchema: obj({ task: TASK_VIEW, notes: arr({ type: "string" }, "Anything in the sentence that couldn't be matched.") }, ["task", "notes"]),
    annotations: { title: "Add a task", ...ADD },
    write: true,
    routes: [["POST", "/tasks"], ["GET", "/projects"], ["GET", "/members"]],
    async run(a, env) {
      if (a.timezone !== undefined && !isTimeZone(a.timezone)) throw new ToolFault("timezone: Use a time zone name like Europe/London.");
      const { text, timezone, idempotencyKey, ...given } = a;
      if (!text && !given.title) throw new ToolFault("Give the task a title, or a sentence in text.");
      const hint = typeof given.projectId === "string" ? given.projectId : undefined;
      const read = text ? await readSentence(String(text), timezone ?? DEFAULT_TIMEZONE, hint, env) : { fields: {}, notes: [] };
      const body: Record<string, unknown> = { ...read.fields, ...given };
      if (!body.title) throw new ToolFault("That sentence has no words left for a title. Add what the task is.");
      // the Personal list is yours: a task there with no one on it would never show in My tasks
      if (body.projectId == null && !body.parentId && body.assigneeId === undefined && !env.principal.workspaceId) body.assigneeId = "me";
      const made = await need(env.api("POST", "/tasks", { body, idempotencyKey })) as ApiTask;
      return { structured: { task: taskView(made), notes: read.notes }, summary: `Added “${made.title}” (${made.id})${read.notes.length ? `. ${read.notes.join(" ")}` : "."}` };
    },
  },
  {
    name: "update_task",
    title: "Update a task",
    description: "Changes the fields you give on one task: title, description, status, priority, project, section, assignee, dates, tags or estimate. Fields left out stay as they are; a value replaces what was there. Doesn't delete anything. To finish a task use complete_task.",
    inputSchema: input({ taskId: TASK_ID, title: s("The new title.", { maxLength: API_LIMITS.title, minLength: 1 }), ...TASK_FIELDS }, ["taskId"]),
    outputSchema: TASK_RESULT,
    annotations: { title: "Update a task", ...CHANGE },
    write: true,
    routes: [["PATCH", "/tasks/:id"]],
    async run(a, env) {
      const { taskId, ...fields } = a;
      if (!Object.keys(fields).length) throw new ToolFault("Say what to change: give at least one field as well as taskId.");
      const t = await need(env.api("PATCH", `/tasks/${pathId(taskId)}`, { body: fields })) as ApiTask;
      return { structured: { task: taskView(t) }, summary: `Updated “${t.title}” (${t.id}).` };
    },
  },
  {
    name: "complete_task",
    title: "Complete a task",
    description: "Marks one task as done. The project's own \"task completed\" automations run, as they do in the app. Doing it to a task that's already done changes nothing.",
    inputSchema: input({ taskId: TASK_ID }, ["taskId"]),
    outputSchema: TASK_RESULT,
    annotations: { title: "Complete a task", ...CHANGE },
    write: true,
    routes: [["POST", "/tasks/:id/complete"]],
    async run(a, env) {
      const t = await need(env.api("POST", `/tasks/${pathId(a.taskId)}/complete`)) as ApiTask;
      return { structured: { task: taskView(t) }, summary: `Marked “${t.title}” (${t.id}) as done.` };
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
      const r = await need(env.api("DELETE", `/tasks/${pathId(a.taskId)}/bin`));
      return { structured: { id: r.id, title: r.title, inRecycleBin: r.inRecycleBin, keptForDays: r.keptForDays }, summary: `Moved “${r.title}” (${r.id}) to the recycle bin. It can be restored for ${r.keptForDays} days.` };
    },
  },
  {
    name: "add_comment",
    title: "Add a comment",
    description: "Adds a comment to one task, as the person, or a reply to a comment on it. Guests can comment too. Doesn't change the task itself.",
    inputSchema: input({
      taskId: TASK_ID,
      body: s("The comment.", { minLength: 1, maxLength: API_LIMITS.comment }),
      parentId: s("Replies to this comment on the task.", { maxLength: 64 }),
      idempotencyKey: IDEMPOTENCY,
    }, ["taskId", "body"]),
    outputSchema: obj({ comment: COMMENT_VIEW }, ["comment"]),
    annotations: { title: "Add a comment", ...ADD },
    write: true,
    routes: [["POST", "/tasks/:id/comments"]],
    async run(a, env) {
      const c = await need(env.api("POST", `/tasks/${pathId(a.taskId)}/comments`, {
        body: { body: a.body, ...(a.parentId ? { parentId: a.parentId } : {}) }, idempotencyKey: a.idempotencyKey,
      })) as ApiComment;
      return { structured: { comment: commentView(c) }, summary: `Commented on task ${c.taskId} (comment ${c.id}).` };
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
