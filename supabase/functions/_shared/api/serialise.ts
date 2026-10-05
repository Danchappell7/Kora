// ============================================================
// KANBO — public API v1: database rows → the API's JSON (0046).  [architect]
//
// ONE shape for the REST API and for webhook payloads: a webhook's `data`
// is exactly what GET /v1/<resource>/:id returns. camelCase, ISO 8601
// (dates "YYYY-MM-DD", timestamps "2026-10-05T09:30:00.000Z"), explicit
// nulls (never missing keys), an `object` discriminator on every resource.
//
// Rows may come from postgres.js (timestamps as Date, numeric as string) or
// from to_jsonb() in the webhook outbox (all strings): every field accepts
// both. Unknown columns are ignored, so the API never leaks a column added
// later (ranking, plans, followers, reactions… are deliberately absent).
//
// The column → field maps below are also the list of task / project
// columns whose change counts as task.updated / project.updated: the 0046
// capture triggers use the same lists (serialise.test.ts checks they match).
//
// Pure module: vitest covers it (serialise.test.ts).
// ============================================================

export type ApiStatus = "todo" | "progress" | "review" | "blocked" | "done";
export type ApiPriority = "low" | "medium" | "high" | "urgent";
export type ApiRecurrence = "none" | "daily" | "weekdays" | "weekly" | "biweekly" | "monthly";
export type ApiRole = "owner" | "admin" | "member" | "guest";

export const API_STATUSES: readonly ApiStatus[] = ["todo", "progress", "review", "blocked", "done"];
export const API_PRIORITIES: readonly ApiPriority[] = ["low", "medium", "high", "urgent"];
export const API_RECURRENCES: readonly ApiRecurrence[] = ["none", "daily", "weekdays", "weekly", "biweekly", "monthly"];

export interface ApiTag { id: string; label: string | null; color: string | null }

export interface ApiTask {
  object: "task";
  id: string;
  title: string;
  /** rich text as stored by the app (may contain simple markup); "" when empty */
  description: string;
  status: ApiStatus;
  priority: ApiPriority;
  /** null = a personal task */
  workspaceId: string | null;
  projectId: string | null;
  sectionId: string | null;
  /** set on a sub-task */
  parentId: string | null;
  /** a user id; null = unassigned */
  assigneeId: string | null;
  /** the creator's user id */
  createdBy: string | null;
  /** YYYY-MM-DD */
  dueDate: string | null;
  /** HH:MM (24h, the app's local time) */
  dueTime: string | null;
  startDate: string | null;
  /** YYYY-MM-DD, the day it was completed */
  completedAt: string | null;
  tags: ApiTag[];
  effortHours: number | null;
  loggedHours: number | null;
  isMilestone: boolean;
  recurrence: ApiRecurrence;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** opens the task in Kanbo */
  url: string | null;
  /** GET /tasks/:id only: its sub-tasks */
  subtaskIds?: string[];
  /** GET /tasks/:id only: tasks this one waits for */
  dependencyIds?: string[];
}

export interface ApiProject {
  object: "project";
  id: string;
  workspaceId: string | null;
  name: string;
  emoji: string | null;
  color: string | null;
  description: string | null;
  status: string | null;
  ownerId: string | null;
  contributorIds: string[];
  createdBy: string | null;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string | null;
  url: string | null;
}

export interface ApiSection {
  object: "section";
  id: string;
  projectId: string;
  workspaceId: string | null;
  name: string;
  position: number | null;
  createdAt: string | null;
}

export interface ApiComment {
  object: "comment";
  id: string;
  taskId: string;
  /** a reply's parent comment */
  parentId: string | null;
  /** null once the author's account is deleted */
  authorId: string | null;
  authorName: string;
  body: string;
  /** user ids @mentioned */
  mentions: string[];
  createdAt: string | null;
}

export interface ApiMember {
  object: "member";
  /** the membership's id */
  id: string;
  workspaceId: string;
  /** null for an invite not yet accepted */
  userId: string | null;
  name: string;
  email: string;
  role: ApiRole;
  status: "active" | "invited";
  title: string | null;
  createdAt: string | null;
}

export interface ApiWorkspace {
  object: "workspace";
  id: string;
  name: string;
  logoUrl: string | null;
  ownerId: string | null;
  /** the key owner's role here */
  role: ApiRole | null;
  createdAt: string | null;
}

export interface ApiMe {
  object: "user";
  id: string;
  email: string | null;
  name: string | null;
  key: { id: string; access: "read" | "write"; workspaceId: string | null };
}

export type WebhookEventType =
  | "task.created" | "task.updated" | "task.completed" | "task.deleted"
  | "comment.created" | "project.created" | "project.updated" | "member.joined";
export type WebhookDeliveryType = WebhookEventType | "ping";

/** What a webhook endpoint receives (the POST body). */
export interface WebhookEnvelope<T = unknown> {
  /** "evt_<n>": the same on every retry of this event, so receivers can de-duplicate */
  id: string;
  type: WebhookDeliveryType;
  /** when it happened */
  createdAt: string;
  workspaceId: string | null;
  data: T;
  /** task.updated / project.updated: the API fields that changed */
  changes?: string[];
  /** task.deleted: archived (restorable), deleted (gone) or moved (to another workspace) */
  deletion?: "archived" | "deleted" | "moved";
}

/** comment.created's data: the comment plus the task it's on. */
export type ApiCommentEvent = ApiComment & { task: { id: string; title: string | null; projectId: string | null; url: string | null } };
/** ping's data. */
export interface ApiPing { webhookId: string; url: string | null; events: string[]; message: string }

export interface SerialiseCtx {
  /** the app's address (APP_URL), for `url` fields; omit → url null */
  appUrl?: string | null;
  /** tag id → label / colour (tags table), for task tags; unknown ids get null label */
  tags?: ReadonlyMap<string, { label: string | null; color: string | null }> | null;
}

/** tasks column → API field (also: the columns whose change is a task.updated). */
export const TASK_COLUMN_FIELDS: Readonly<Record<string, keyof ApiTask>> = {
  title: "title", description: "description", status: "status", priority: "priority",
  project_id: "projectId", section_id: "sectionId", assignee_id: "assigneeId",
  due_date: "dueDate", due_time: "dueTime", start_date: "startDate", completed_at: "completedAt",
  tags: "tags", effort_hours: "effortHours", logged_hours: "loggedHours", parent_id: "parentId",
  is_milestone: "isMilestone", recurrence: "recurrence", workspace_id: "workspaceId", archived_at: "archivedAt",
};
/** projects column → API field (also: the columns whose change is a project.updated). */
export const PROJECT_COLUMN_FIELDS: Readonly<Record<string, keyof ApiProject>> = {
  name: "name", emoji: "emoji", color: "color", description: "description", status: "status",
  owner_id: "ownerId", contributor_ids: "contributorIds", archived_at: "archivedAt", workspace_id: "workspaceId",
};

/* ------------------------------------------------------------ value helpers */

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" ? v : v == null ? null : String(v));
const nonEmpty = (v: unknown): string | null => { const s = str(v); return s && s.trim() ? s : null; };
const bool = (v: unknown): boolean => v === true || v === "t" || v === "true";

/** A finite number from number / numeric string; else null. */
export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY-MM-DD" from a date string, timestamp string or Date; else null. */
export function isoDate(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? m[1] : null;
}

/** ISO 8601 UTC timestamp ("…T…Z") from a Date or anything Date.parse reads; else null. */
export function isoTime(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v !== "string" || !v.trim()) return null;
  // Postgres gives microseconds and "+00:00"; trim to milliseconds for every engine
  const t = Date.parse(v.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1").replace(/(T[\d:.]+[+-]\d{2})$/, "$1:00"));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => x != null).map((x) => String(x)) : [];

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  (typeof v === "string" && (allowed as readonly string[]).includes(v) ? v : fallback) as T;

const appBase = (ctx?: SerialiseCtx) => {
  const u = (ctx?.appUrl ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/\S+$/i.test(u) ? u : null;
};

/** Kanbo's address for a task (the app opens ?task=<id>). */
export function taskUrl(id: string, ctx?: SerialiseCtx): string | null {
  const b = appBase(ctx);
  return b ? `${b}/?task=${encodeURIComponent(id)}` : null;
}
/** Kanbo's address for a project. */
export function projectUrl(id: string, ctx?: SerialiseCtx): string | null {
  const b = appBase(ctx);
  return b ? `${b}/p/${encodeURIComponent(id)}` : null;
}

/* ------------------------------------------------------------ resources */

export function serialiseTask(row: Row, ctx?: SerialiseCtx): ApiTask {
  const id = String(row.id);
  const archivedAt = isoTime(row.archived_at);
  const tags = strArray(row.tags).map((tid): ApiTag => {
    const t = ctx?.tags?.get(tid);
    return { id: tid, label: t?.label ?? null, color: t?.color ?? null };
  });
  const out: ApiTask = {
    object: "task",
    id,
    title: str(row.title) ?? "",
    description: str(row.description) ?? "",
    status: pick(row.status, API_STATUSES, "todo"),
    priority: pick(row.priority, API_PRIORITIES, "medium"),
    workspaceId: nonEmpty(row.workspace_id),
    projectId: nonEmpty(row.project_id),
    sectionId: nonEmpty(row.section_id),
    parentId: nonEmpty(row.parent_id),
    assigneeId: nonEmpty(row.assignee_id),
    createdBy: nonEmpty(row.user_id),
    dueDate: isoDate(row.due_date),
    dueTime: typeof row.due_time === "string" && /^\d{2}:\d{2}/.test(row.due_time) ? row.due_time.slice(0, 5) : null,
    startDate: isoDate(row.start_date),
    completedAt: isoDate(row.completed_at),
    tags,
    effortHours: num(row.effort_hours),
    loggedHours: num(row.logged_hours),
    isMilestone: bool(row.is_milestone),
    recurrence: pick(row.recurrence, API_RECURRENCES, "none"),
    archived: archivedAt !== null,
    archivedAt,
    createdAt: isoTime(row.created_at),
    updatedAt: isoTime(row.updated_at),
    url: taskUrl(id, ctx),
  };
  if (row.subtask_ids !== undefined) out.subtaskIds = strArray(row.subtask_ids);
  if (row.dependency_ids !== undefined) out.dependencyIds = strArray(row.dependency_ids);
  return out;
}

export function serialiseProject(row: Row, ctx?: SerialiseCtx): ApiProject {
  const id = String(row.id);
  const archivedAt = isoTime(row.archived_at);
  return {
    object: "project",
    id,
    workspaceId: nonEmpty(row.workspace_id),
    name: str(row.name) ?? "",
    emoji: nonEmpty(row.emoji),
    color: nonEmpty(row.color),
    description: nonEmpty(row.description),
    status: nonEmpty(row.status),
    ownerId: nonEmpty(row.owner_id),
    contributorIds: strArray(row.contributor_ids),
    createdBy: nonEmpty(row.user_id),
    archived: archivedAt !== null,
    archivedAt,
    createdAt: isoTime(row.created_at),
    url: projectUrl(id, ctx),
  };
}

export function serialiseSection(row: Row): ApiSection {
  return {
    object: "section",
    id: String(row.id),
    projectId: str(row.project_id) ?? "",
    workspaceId: nonEmpty(row.workspace_id),
    name: str(row.name) ?? "",
    position: num(row.position),
    createdAt: isoTime(row.created_at),
  };
}

export function serialiseComment(row: Row): ApiComment {
  return {
    object: "comment",
    id: String(row.id),
    taskId: String(row.task_id),
    parentId: nonEmpty(row.parent_id),
    authorId: nonEmpty(row.user_id),
    authorName: nonEmpty(row.author_name) ?? "Someone",
    body: str(row.body) ?? "",
    mentions: strArray(row.mentions),
    createdAt: isoTime(row.created_at),
  };
}

export function serialiseMember(row: Row): ApiMember {
  return {
    object: "member",
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    userId: nonEmpty(row.user_id),
    name: str(row.name) ?? "",
    email: str(row.email) ?? "",
    role: pick(row.role, ["owner", "admin", "member", "guest"] as const, "member"),
    status: row.status === "active" ? "active" : "invited",
    title: nonEmpty(row.title),
    createdAt: isoTime(row.created_at),
  };
}

/** `row.role` (optional): the key owner's role there, e.g. from ws_role(id). */
export function serialiseWorkspace(row: Row): ApiWorkspace {
  const role = row.role;
  return {
    object: "workspace",
    id: String(row.id),
    name: str(row.name) ?? "",
    logoUrl: nonEmpty(row.logo_url),
    ownerId: nonEmpty(row.owner_id),
    role: role === "owner" || role === "admin" || role === "member" || role === "guest" ? role : null,
    createdAt: isoTime(row.created_at),
  };
}

/* ------------------------------------------------------------ webhook events */

/** A row of public.webhook_claim_deliveries() (or webhook_outbox) — what serialiseEvent needs. */
export interface OutboxEvent {
  outbox_id: number | string;
  event: string;
  occurred_at?: unknown;   // webhook_claim_deliveries
  created_at?: unknown;    // webhook_outbox
  workspace_id: string | null;
  payload: Record<string, unknown> | null;
}

/** Column names → API field names (unknown columns dropped), sorted, de-duplicated. */
export function changedFields(columns: unknown, map: Readonly<Record<string, string>>): string[] {
  const out = new Set<string>();
  for (const c of strArray(columns)) if (map[c]) out.add(map[c]);
  return [...out].sort();
}

/** The POST body for one outbox event. Throws for an event it doesn't know. */
export function serialiseEvent(o: OutboxEvent, ctx?: SerialiseCtx): WebhookEnvelope {
  const p = (o.payload ?? {}) as Record<string, unknown>;
  const asRow = (v: unknown): Row => (v && typeof v === "object" ? (v as Row) : {});
  const base = {
    id: `evt_${String(o.outbox_id)}`,
    type: o.event as WebhookDeliveryType,
    createdAt: isoTime(o.occurred_at ?? o.created_at) ?? new Date(0).toISOString(),
    workspaceId: o.workspace_id ?? null,
  };
  switch (o.event) {
    case "task.created":
    case "task.completed":
      return { ...base, data: serialiseTask(asRow(p.task), ctx) };
    case "task.updated":
      return { ...base, data: serialiseTask(asRow(p.task), ctx), changes: changedFields(p.changes, TASK_COLUMN_FIELDS) };
    case "task.deleted": {
      const d = p.deletion === "archived" || p.deletion === "moved" ? p.deletion : "deleted";
      return { ...base, data: serialiseTask(asRow(p.task), ctx), deletion: d };
    }
    case "comment.created": {
      const t = asRow(p.task);
      const tid = nonEmpty(t.id);
      const data: ApiCommentEvent = {
        ...serialiseComment(asRow(p.comment)),
        task: { id: tid ?? "", title: nonEmpty(t.title), projectId: nonEmpty(t.project_id), url: tid ? taskUrl(tid, ctx) : null },
      };
      return { ...base, data };
    }
    case "project.created":
      return { ...base, data: serialiseProject(asRow(p.project), ctx) };
    case "project.updated":
      return { ...base, data: serialiseProject(asRow(p.project), ctx), changes: changedFields(p.changes, PROJECT_COLUMN_FIELDS) };
    case "member.joined":
      return { ...base, data: serialiseMember(asRow(p.member)) };
    case "ping": {
      const w = asRow(p.webhook);
      const data: ApiPing = {
        webhookId: str(w.id) ?? "",
        url: nonEmpty(w.url),
        events: strArray(w.events),
        message: "This is a test event from Kanbo. If you can read this, your endpoint works.",
      };
      return { ...base, data };
    }
    default:
      throw new Error(`unknown webhook event: ${o.event}`);
  }
}
