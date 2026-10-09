// ============================================================
// KANBO — public API v1: the OpenAPI 3.1 document (0046).        [architect → a1]
//
// One document, two readers: GET /v1/openapi.json (the api function) and
// Settings › Developers › API reference (src/components/settings/ApiDocs.tsx,
// which imports buildOpenApi directly — no fetch, no key needed).
//
// Every endpoint, parameter, request body, response and error is here,
// with examples (the API's real JSON shapes: serialise.ts). Error
// responses are written out inline rather than as $refs so a reader needs
// no resolver. Package a2's webhook paths are merged in (webhooks.ts).
//
// Pure module (no Deno globals, no imports the app can't resolve).
// ============================================================
import { webhookOpenApiPaths } from "./webhooks.ts";

/** The parts of OpenAPI 3.1 Kanbo uses (loose on purpose: ApiDocs reads it defensively). */
export interface OpenApiDoc {
  openapi: "3.1.0";
  info: { title: string; version: string; description?: string; contact?: { email?: string; url?: string } };
  servers: { url: string; description?: string }[];
  security?: Record<string, string[]>[];
  tags?: { name: string; description?: string }[];
  paths: Record<string, Partial<Record<"get" | "post" | "patch" | "delete", OpenApiOperation>>>;
  components?: {
    securitySchemes?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    responses?: Record<string, unknown>;
  };
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{ name: string; in: "path" | "query" | "header"; required?: boolean; description?: string; schema?: unknown; example?: unknown }>;
  requestBody?: { required?: boolean; content: Record<string, { schema?: unknown; example?: unknown }> };
  responses: Record<string, { description: string; headers?: Record<string, unknown>; content?: Record<string, { schema?: unknown; example?: unknown }> }>;
  /** "write" when a read-only key can't call it */
  "x-kanbo-access"?: "read" | "write";
  /** public: no key needed */
  security?: Record<string, string[]>[];
}

export const OPENAPI_TITLE = "Kanbo API";
export const OPENAPI_VERSION = "1.0.0";

/* ------------------------------------------------------------ examples */

const WS = "8f1c2a4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b";
const PROJECT = "2b7e9c1d-3f4a-4b5c-8d6e-7f8091a2b3c4";
const SECTION = "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b";
const TASK = "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9";
const SUBTASK = "6f7a8b9c-0d1e-4f2a-b3c4-d5e6f7a8b9c0";
const BLOCKER = "7a8b9c0d-1e2f-4a3b-c4d5-e6f7a8b9c0d1";
const ME = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const PRIYA = "1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";
const COMMENT = "9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const KEY_ID = "3d4e5f6a-7b8c-4d9e-af0b-1c2d3e4f5a6b";
const TAG = "4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8";
const APP = "https://www.kanbo.co.uk";

const EX_TASK = {
  object: "task", id: TASK, title: "Write the launch blog post", description: "Draft for Thursday's review.",
  status: "progress", priority: "high", workspaceId: WS, projectId: PROJECT, sectionId: SECTION, parentId: null,
  assigneeId: PRIYA, createdBy: ME, dueDate: "2026-10-16", dueTime: "17:00", startDate: "2026-10-12", completedAt: null,
  tags: [{ id: "writing", label: "Writing", color: "oklch(0.78 0.15 70)" }, { id: TAG, label: "Launch", color: "oklch(0.74 0.14 230)" }],
  effortHours: 3, loggedHours: 1.5, isMilestone: false, recurrence: "none", archived: false, archivedAt: null,
  createdAt: "2026-10-05T09:12:44.120Z", updatedAt: "2026-10-06T14:03:10.552Z", url: `${APP}/?task=${TASK}`,
};
const EX_TASK_FULL = { ...EX_TASK, subtaskIds: [SUBTASK], dependencyIds: [BLOCKER] };
const EX_PROJECT = {
  object: "project", id: PROJECT, workspaceId: WS, name: "Q4 launch", emoji: "🚀", color: "oklch(0.74 0.14 230)",
  description: "Everything for the 12 November launch.", status: "on_track", ownerId: ME, contributorIds: [PRIYA],
  createdBy: ME, archived: false, archivedAt: null, createdAt: "2026-09-01T08:30:00.000Z", url: `${APP}/p/${PROJECT}`,
};
const EX_SECTION = { object: "section", id: SECTION, projectId: PROJECT, workspaceId: WS, name: "In progress", position: 1759653000000, createdAt: "2026-09-01T08:31:12.000Z" };
const EX_COMMENT = {
  object: "comment", id: COMMENT, taskId: TASK, parentId: null, authorId: PRIYA, authorName: "Priya Shah",
  body: "First draft is in the doc — over to you for the intro.", mentions: [], createdAt: "2026-10-06T10:41:05.300Z",
};
const EX_MEMBER = {
  object: "member", id: "e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b", workspaceId: WS, userId: PRIYA, name: "Priya Shah",
  email: "priya@foundrise.co", role: "member", status: "active", title: "Content lead", createdAt: "2026-06-14T12:00:00.000Z",
};
const EX_WORKSPACE = { object: "workspace", id: WS, name: "Foundrise", logoUrl: null, ownerId: ME, role: "owner", createdAt: "2026-05-02T09:00:00.000Z" };
const EX_ME = { object: "user", id: ME, email: "sam@foundrise.co", name: "Sam Taylor", key: { id: KEY_ID, access: "write", workspaceId: null } };
const listEx = (item: unknown, more = false) => ({
  object: "list", data: [item], nextCursor: more ? "eyJ2IjoxLCJtIjoiYyIsImsiOiIyMDI2LTEwLTA1VDA5OjEyOjQ0LjEyMDAwMCIsImkiOiI1ZTZmN2E4Yi05YzBkLTRlMWYtYTJiMy1jNGQ1ZTZmN2E4YjkiLCJmIjoiOWYzYzFhMmI0ZDVlNmY3MCJ9" : null, hasMore: more,
});

/* ------------------------------------------------------------ building blocks */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, "null"], ...extra });
const uuid = (description?: string) => ({ type: "string", format: "uuid", ...(description ? { description } : {}) });
const date = (description?: string) => ({ type: ["string", "null"], format: "date", ...(description ? { description } : {}) });
const listSchema = (item: string) => ({
  type: "object", required: ["object", "data", "nextCursor", "hasMore"],
  properties: {
    object: { const: "list" },
    data: { type: "array", items: ref(item) },
    nextCursor: { type: ["string", "null"], description: "Pass as ?cursor= for the next page; null on the last page." },
    hasMore: { type: "boolean" },
  },
});
const json = (schema: unknown, example: unknown) => ({ "application/json": { schema, example } });

const RATE_HEADERS = {
  "X-RateLimit-Limit": { description: "Requests allowed per minute for this key (120).", schema: { type: "integer" } },
  "X-RateLimit-Remaining": { description: "Requests left in the current minute.", schema: { type: "integer" } },
  "X-Request-Id": { description: "Quote it if you contact support.", schema: { type: "string" } },
};
const GET_HEADERS = { ...RATE_HEADERS, ETag: { description: "Send it back as If-None-Match to get a 304 when nothing changed, or as If-Match on a write so it only goes ahead if nothing changed.", schema: { type: "string" } } };
/** a write's answer: the new state's ETag, for the next If-Match */
const WRITE_HEADERS = { ...RATE_HEADERS, ETag: { description: "The ETag of the new state (the same as GET's): send it as If-Match on your next write.", schema: { type: "string" } } };

type ErrStatus = 400 | 401 | 403 | 404 | 409 | 412 | 413 | 415 | 422 | 429 | 500;
const ERRORS: Record<ErrStatus, { code: string; description: string; message: string; details?: unknown }> = {
  400: { code: "bad_request", description: "A query parameter or the body isn't usable.", message: "Some query parameters need attention.", details: { fields: { due_before: "Use a date like 2026-10-31." } } },
  401: { code: "unauthorized", description: "No key, or the key isn't valid (revoked, expired, or its owner can't use Kanbo).", message: "This API key isn't valid. It may have been revoked or have expired." },
  403: { code: "forbidden", description: "The key can't do this: a read-only key writing, a team key outside its workspace, or the person isn't allowed.", message: "This key is read-only. Make a read & write key (kanbo_sk_…) in Settings › Developers to change data." },
  404: { code: "not_found", description: "It doesn't exist, or the key's owner can't see it.", message: "Task not found." },
  409: { code: "idempotency_in_progress", description: "A request with the same Idempotency-Key is still running (`idempotency_in_progress`: retry after Retry-After). `conflict` with `details.idempotency: \"applied\"`: it was carried out but its answer was lost, so look the result up instead of sending it again.", message: "A request with this Idempotency-Key is still running. Try again in a moment." },
  412: { code: "precondition_failed", description: "If-Match: it has changed since you read it. GET it again, merge your change and retry with the new ETag.", message: "This task has changed since you read it (If-Match doesn't match its ETag). GET it again, merge your change and retry with the new ETag." },
  413: { code: "payload_too_large", description: "The body is over 64 KB.", message: "The body is over 64 KB." },
  415: { code: "unsupported_media_type", description: "The body isn't sent as application/json.", message: "Send JSON with the header Content-Type: application/json." },
  422: { code: "validation_failed", description: "A field isn't valid; `details.fields` says which and why.", message: "Some fields need attention.", details: { fields: { dueDate: "Use a date like 2026-10-31, or null." } } },
  429: { code: "rate_limited", description: "Over 120 requests in a minute for this key. Wait for Retry-After seconds.", message: "Too many requests: a key can make 120 a minute. Try again in 12 seconds." },
  500: { code: "internal", description: "Something went wrong on Kanbo's side (503 when the database is briefly unreachable, or for team keys while Kanbo's database is being updated; wait for Retry-After).", message: "Something went wrong on Kanbo's side. Try again; if it keeps happening, send the request id to Kanbo support." },
};
const err = (status: ErrStatus) => {
  const e = ERRORS[status];
  return {
    description: e.description,
    ...(status === 429 ? { headers: { ...RATE_HEADERS, "Retry-After": { description: "Seconds to wait.", schema: { type: "integer" } } } } : {}),
    content: json(ref("Error"), { error: { code: e.code, message: e.message, status, requestId: "req_4f9a1c2b7d3e8a60", ...(e.details ? { details: e.details } : {}) } }),
  };
};
const errs = (...codes: ErrStatus[]) => Object.fromEntries(codes.map((c) => [String(c), err(c)]));
const READ_ERRORS: ErrStatus[] = [401, 429, 500];
const WRITE_ERRORS: ErrStatus[] = [400, 401, 403, 413, 415, 422, 429, 500];

const P = {
  id: (what: string) => ({ name: "id", in: "path" as const, required: true, description: `The ${what}'s id.`, schema: uuid(), example: what === "project" ? PROJECT : TASK }),
  limit: { name: "limit", in: "query" as const, description: "Page size, 1–100 (default 50).", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 }, example: 50 },
  cursor: { name: "cursor", in: "query" as const, description: "The nextCursor from the previous page (opaque; only valid with the same filters).", schema: { type: "string" } },
  ifMatch: (what: string) => ({ name: "If-Match", in: "header" as const, description: `Optional. The ETag from GET /${what}s/{id} (or from your last write's answer): the write only goes ahead if the ${what} hasn't changed since, else 412. Use it when syncing so you never overwrite a change made in Kanbo.`, schema: { type: "string" }, example: 'W/"3f9a1c2b7d3e8a60"' }),
  idempotency: { name: "Idempotency-Key", in: "header" as const, description: "Any unique string (a UUID is ideal). Retrying with the same key within 24 hours returns the first answer instead of doing it twice.", schema: { type: "string", maxLength: 255 }, example: "0d6f3f2e-9b8a-4c1d-8e7f-6a5b4c3d2e1f" },
  workspace: (desc: string) => ({ name: "workspace", in: "query" as const, description: desc, schema: { type: "string" }, example: WS }),
  includeArchived: { name: "include_archived", in: "query" as const, description: "Include archived items (default false).", schema: { type: "boolean", default: false } },
};

const ok = (description: string, schema: unknown, example: unknown, headers: Record<string, unknown> = GET_HEADERS) =>
  ({ description, headers, content: json(schema, example) });

/* ------------------------------------------------------------ schemas */

const SCHEMAS: Record<string, unknown> = {
  Error: {
    type: "object", required: ["error"],
    properties: {
      error: {
        type: "object", required: ["code", "message", "status"],
        properties: {
          code: { type: "string", enum: ["bad_request", "invalid_body", "validation_failed", "unauthorized", "forbidden", "not_found", "method_not_allowed", "conflict", "idempotency_mismatch", "idempotency_in_progress", "payload_too_large", "unsupported_media_type", "rate_limited", "internal"] },
          message: { type: "string", description: "A sentence you can show to people." },
          status: { type: "integer", description: "The HTTP status, repeated." },
          requestId: { type: "string", description: "Matches the X-Request-Id header." },
          details: { type: "object", description: "For validation errors: `fields` maps each field (or query parameter) to what's wrong with it.", additionalProperties: true },
        },
      },
    },
  },
  Tag: { type: "object", required: ["id", "label", "color"], properties: { id: { type: "string", description: "A tag's id, or a built-in tag (design, eng, research, writing, ops, bug)." }, label: nullable("string"), color: nullable("string") } },
  Task: {
    type: "object",
    required: ["object", "id", "title", "description", "status", "priority", "workspaceId", "projectId", "sectionId", "parentId", "assigneeId", "createdBy", "dueDate", "dueTime", "startDate", "completedAt", "tags", "effortHours", "loggedHours", "isMilestone", "recurrence", "archived", "archivedAt", "createdAt", "updatedAt", "url"],
    properties: {
      object: { const: "task" },
      id: uuid(),
      title: { type: "string", maxLength: 500 },
      description: { type: "string", description: "As written in Kanbo (may contain simple formatting); \"\" when empty." },
      status: { type: "string", enum: ["todo", "progress", "review", "blocked", "done"] },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      workspaceId: nullable("string", { format: "uuid", description: "null for a task in someone's Personal list." }),
      projectId: nullable("string", { description: "A project id, or \"p-personal\" for the Personal list." }),
      sectionId: nullable("string", { format: "uuid" }),
      parentId: nullable("string", { format: "uuid", description: "Set on a sub-task." }),
      assigneeId: nullable("string", { format: "uuid", description: "A user id; null when unassigned." }),
      createdBy: nullable("string", { format: "uuid" }),
      dueDate: date("YYYY-MM-DD"),
      dueTime: nullable("string", { pattern: "^\\d{2}:\\d{2}$", description: "HH:MM, 24-hour, the team's local time." }),
      startDate: date(),
      completedAt: date("The day it was completed."),
      tags: { type: "array", items: ref("Tag") },
      effortHours: nullable("number"),
      loggedHours: nullable("number"),
      isMilestone: { type: "boolean" },
      recurrence: { type: "string", enum: ["none", "daily", "weekdays", "weekly", "biweekly", "monthly"] },
      archived: { type: "boolean" },
      archivedAt: nullable("string", { format: "date-time" }),
      createdAt: nullable("string", { format: "date-time" }),
      updatedAt: nullable("string", { format: "date-time", description: "Moves on every real change; use updated_since to sync." }),
      url: nullable("string", { format: "uri", description: "Opens the task in Kanbo." }),
      subtaskIds: { type: "array", items: uuid(), description: "One task's answers only (GET /tasks/{id} and writes to it), not lists." },
      dependencyIds: { type: "array", items: uuid(), description: "One task's answers only: tasks this one waits for." },
    },
  },
  TaskCreate: {
    type: "object", required: ["title"], additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 500 },
      description: { type: ["string", "null"], maxLength: 20000 },
      status: { type: "string", enum: ["todo", "progress", "review", "blocked", "done"], default: "todo" },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"], default: "medium" },
      projectId: { type: ["string", "null"], description: "The project it goes in (its workspace comes with it). Leave out, or null, for your Personal list (personal keys only). Team keys must give one." },
      workspaceId: { type: ["string", "null"], description: "Optional check: must match the project's workspace." },
      sectionId: { type: ["string", "null"], format: "uuid", description: "A section of the same project." },
      parentId: { type: ["string", "null"], format: "uuid", description: "Makes it a sub-task; it goes in the parent's project." },
      assigneeId: { type: ["string", "null"], description: "A member's user id, or \"me\". Unassigned when left out." },
      dueDate: date(), dueTime: { type: ["string", "null"], pattern: "^\\d{2}:\\d{2}$" }, startDate: date(),
      tags: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 }, description: "Tag ids, built-in tags (\"design\") or labels. A label that doesn't exist yet is made in the task's workspace." },
      effortHours: { type: ["number", "null"], minimum: 0, maximum: 10000 },
    },
  },
  TaskUpdate: {
    type: "object", minProperties: 1, additionalProperties: false,
    description: "Only the fields you send change. Moving to a project in another workspace takes the sub-tasks along, clears the section, and hands the task to you if its assignee isn't in the new workspace.",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 500 },
      description: { type: ["string", "null"], maxLength: 20000 },
      status: { type: "string", enum: ["todo", "progress", "review", "blocked", "done"], description: "done stamps completedAt with today; reopening clears it." },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      projectId: { type: ["string", "null"], description: "null moves it to your Personal list (only tasks you made)." },
      sectionId: { type: ["string", "null"], format: "uuid" },
      assigneeId: { type: ["string", "null"], description: "A member's user id, \"me\", or null to unassign." },
      dueDate: date("null clears the due time too."), dueTime: { type: ["string", "null"], pattern: "^\\d{2}:\\d{2}$" }, startDate: date(),
      tags: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 }, description: "Replaces the task's tags." },
      effortHours: { type: ["number", "null"], minimum: 0, maximum: 10000 },
      archived: { type: "boolean", description: "true archives it (and its sub-tasks); false restores it." },
    },
  },
  Project: {
    type: "object",
    required: ["object", "id", "workspaceId", "name", "emoji", "color", "description", "status", "ownerId", "contributorIds", "createdBy", "archived", "archivedAt", "createdAt", "url"],
    properties: {
      object: { const: "project" }, id: uuid(),
      workspaceId: nullable("string", { format: "uuid", description: "null for a personal project." }),
      name: { type: "string" }, emoji: nullable("string"), color: nullable("string"), description: nullable("string"),
      status: { type: ["string", "null"], enum: ["on_track", "at_risk", "off_track", "on_hold", null] },
      ownerId: nullable("string", { format: "uuid" }), contributorIds: { type: "array", items: uuid() },
      createdBy: nullable("string", { format: "uuid" }), archived: { type: "boolean" },
      archivedAt: nullable("string", { format: "date-time" }), createdAt: nullable("string", { format: "date-time" }),
      url: nullable("string", { format: "uri" }),
    },
  },
  ProjectCreate: {
    type: "object", required: ["name"], additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120 },
      workspaceId: { type: ["string", "null"], description: "A workspace you can edit in. Leave out: your Personal list (personal keys) or the key's workspace (team keys)." },
      emoji: { type: ["string", "null"] }, color: { type: ["string", "null"], description: "A CSS colour: oklch(), rgb(), hsl() or #hex." },
      description: { type: ["string", "null"], maxLength: 5000 },
      status: { type: ["string", "null"], enum: ["on_track", "at_risk", "off_track", "on_hold", null] },
    },
  },
  ProjectUpdate: {
    type: "object", minProperties: 1, additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120 }, emoji: { type: ["string", "null"] }, color: { type: ["string", "null"] },
      description: { type: ["string", "null"], maxLength: 5000 },
      status: { type: ["string", "null"], enum: ["on_track", "at_risk", "off_track", "on_hold", null] },
      archived: { type: "boolean" },
    },
  },
  Section: {
    type: "object", required: ["object", "id", "projectId", "workspaceId", "name", "position", "createdAt"],
    properties: { object: { const: "section" }, id: uuid(), projectId: { type: "string" }, workspaceId: nullable("string", { format: "uuid" }), name: { type: "string" }, position: nullable("number"), createdAt: nullable("string", { format: "date-time" }) },
  },
  SectionCreate: { type: "object", required: ["projectId", "name"], additionalProperties: false, properties: { projectId: uuid(), name: { type: "string", minLength: 1, maxLength: 120 } } },
  Comment: {
    type: "object", required: ["object", "id", "taskId", "parentId", "authorId", "authorName", "body", "mentions", "createdAt"],
    properties: {
      object: { const: "comment" }, id: uuid(), taskId: uuid(), parentId: nullable("string", { format: "uuid", description: "Set on a reply." }),
      authorId: nullable("string", { format: "uuid" }), authorName: { type: "string" }, body: { type: "string" },
      mentions: { type: "array", items: uuid() }, createdAt: nullable("string", { format: "date-time" }),
    },
  },
  CommentCreate: { type: "object", required: ["body"], additionalProperties: false, properties: { body: { type: "string", minLength: 1, maxLength: 10000 }, parentId: { type: ["string", "null"], format: "uuid", description: "Reply to a comment on the same task." } } },
  Member: {
    type: "object", required: ["object", "id", "workspaceId", "userId", "name", "email", "role", "status", "title", "createdAt"],
    properties: {
      object: { const: "member" }, id: uuid("The membership's id."), workspaceId: uuid(), userId: nullable("string", { format: "uuid", description: "null for an invite not yet accepted." }),
      name: { type: "string" }, email: { type: "string" }, role: { type: "string", enum: ["owner", "admin", "member", "guest"] },
      status: { type: "string", enum: ["active", "invited"] }, title: nullable("string"), createdAt: nullable("string", { format: "date-time" }),
    },
  },
  Workspace: {
    type: "object", required: ["object", "id", "name", "logoUrl", "ownerId", "role", "createdAt"],
    properties: { object: { const: "workspace" }, id: uuid(), name: { type: "string" }, logoUrl: nullable("string"), ownerId: nullable("string", { format: "uuid" }), role: { type: ["string", "null"], enum: ["owner", "admin", "member", "guest", null] }, createdAt: nullable("string", { format: "date-time" }) },
  },
  Me: {
    type: "object", required: ["object", "id", "email", "name", "key"],
    properties: {
      object: { const: "user" }, id: uuid(), email: nullable("string"), name: nullable("string"),
      key: { type: "object", required: ["id", "access", "workspaceId"], properties: { id: uuid(), access: { type: "string", enum: ["read", "write"] }, workspaceId: nullable("string", { format: "uuid", description: "Set for a team key: the only workspace it can reach." }) } },
    },
  },
  // webhook data only (approval.requested / approval.decided): approvals have no REST endpoints yet
  ApprovalReviewer: {
    type: "object", required: ["userId", "decision", "comment", "decidedAt"],
    properties: {
      userId: uuid(), decision: { type: ["string", "null"], enum: ["approved", "changes_requested", null], description: "null until they decide." },
      comment: nullable("string", { maxLength: 2000 }), decidedAt: nullable("string", { format: "date-time" }),
    },
  },
  Approval: {
    type: "object",
    required: ["object", "id", "taskId", "workspaceId", "requestedBy", "title", "note", "attachmentId", "status", "rule", "reviewers", "createdAt", "updatedAt", "resolvedAt", "url"],
    properties: {
      object: { const: "approval" }, id: uuid(), taskId: uuid(), workspaceId: uuid("Approvals are for team tasks only."),
      requestedBy: nullable("string", { format: "uuid", description: "Who asked; null once their account is deleted." }),
      title: { type: "string", maxLength: 200, description: "The task's title when it was asked, unless they gave another." },
      note: nullable("string", { maxLength: 2000 }), attachmentId: nullable("string", { format: "uuid", description: "A file on the task the request is about." }),
      status: { type: "string", enum: ["pending", "approved", "changes_requested", "cancelled"] },
      rule: { type: "string", enum: ["any", "all"], description: "any: the first approval approves it. all: everyone must approve. Either way, one \"changes requested\" decides it as that." },
      reviewers: { type: "array", minItems: 1, maxItems: 10, items: ref("ApprovalReviewer") },
      createdAt: nullable("string", { format: "date-time" }), updatedAt: nullable("string", { format: "date-time" }),
      resolvedAt: nullable("string", { format: "date-time", description: "When it stopped being pending." }),
      url: nullable("string", { format: "uri", description: "Opens its task in Kanbo." }),
    },
  },
  ApprovalDecision: {
    type: "object", required: ["userId", "decision", "comment", "decidedAt"],
    properties: {
      userId: nullable("string", { format: "uuid", description: "The reviewer, or whoever cancelled it." }),
      decision: { type: "string", enum: ["approved", "changes_requested", "cancelled"] },
      comment: nullable("string"), decidedAt: nullable("string", { format: "date-time" }),
    },
  },
  ApprovalEvent: {
    description: "The `data` of approval.requested and approval.decided webhook events: the request, its task, and the decision that sent it (null for approval.requested).",
    allOf: [ref("Approval"), {
      type: "object", required: ["task", "decision"],
      properties: {
        task: {
          type: "object", required: ["id", "title", "projectId", "workspaceId", "status", "dueDate", "url"],
          properties: {
            id: uuid(), title: nullable("string"), projectId: nullable("string"), workspaceId: nullable("string", { format: "uuid" }),
            status: { type: ["string", "null"], enum: ["todo", "progress", "review", "blocked", "done", null] }, dueDate: date(), url: nullable("string", { format: "uri" }),
          },
        },
        decision: { oneOf: [ref("ApprovalDecision"), { type: "null" }] },
      },
    }],
  },
  TaskList: listSchema("Task"), ProjectList: listSchema("Project"), SectionList: listSchema("Section"),
  CommentList: listSchema("Comment"), MemberList: listSchema("Member"), WorkspaceList: listSchema("Workspace"),
};

/* ------------------------------------------------------------ paths */

const PATHS: OpenApiDoc["paths"] = {
  "/me": {
    get: {
      operationId: "getMe", summary: "Who am I?", tags: ["Account"], "x-kanbo-access": "read",
      description: "The person the key acts as, and the key itself. A quick way to check a key works.",
      responses: { 200: ok("The key's owner.", ref("Me"), EX_ME), ...errs(...READ_ERRORS) },
    },
  },
  "/workspaces": {
    get: {
      operationId: "listWorkspaces", summary: "List workspaces", tags: ["Account"], "x-kanbo-access": "read",
      description: "The team workspaces the key can reach, with your role in each. A team key sees only its own workspace. Your Personal list isn't a workspace: filter with workspace=personal.",
      responses: { 200: ok("Workspaces.", ref("WorkspaceList"), listEx(EX_WORKSPACE)), ...errs(...READ_ERRORS) },
    },
  },
  "/members": {
    get: {
      operationId: "listMembers", summary: "List a workspace's members", tags: ["Account"], "x-kanbo-access": "read",
      description: "Everyone in a workspace, including invites not yet accepted (userId null). Use a member's userId as a task's assigneeId.",
      parameters: [P.workspace("The workspace's id. Required for personal keys; a team key defaults to its workspace."), P.limit, P.cursor],
      responses: { 200: ok("Members, oldest first.", ref("MemberList"), listEx(EX_MEMBER)), ...errs(400, 401, 403, 404, 429, 500) },
    },
  },
  "/projects": {
    get: {
      operationId: "listProjects", summary: "List projects", tags: ["Projects"], "x-kanbo-access": "read",
      description: "Projects you can see, oldest first. Archived projects are left out unless you ask for them.",
      parameters: [P.workspace("A workspace's id, or \"personal\" for your personal projects."), P.includeArchived, P.limit, P.cursor],
      responses: { 200: ok("Projects.", ref("ProjectList"), listEx(EX_PROJECT)), ...errs(400, 401, 403, 429, 500) },
    },
    post: {
      operationId: "createProject", summary: "Create a project", tags: ["Projects"], "x-kanbo-access": "write",
      description: "You become its owner. In a team workspace you need to be an owner, admin or member (guests can't).",
      parameters: [P.idempotency],
      requestBody: { required: true, content: json(ref("ProjectCreate"), { name: "Q4 launch", workspaceId: WS, emoji: "🚀", status: "on_track" }) },
      responses: { 201: ok("The new project (Location points at it).", ref("Project"), EX_PROJECT, { ...WRITE_HEADERS, Location: { schema: { type: "string" } } }), ...errs(...WRITE_ERRORS, 404, 409) },
    },
  },
  "/projects/{id}": {
    get: {
      operationId: "getProject", summary: "Get a project", tags: ["Projects"], "x-kanbo-access": "read",
      parameters: [P.id("project")],
      responses: { 200: ok("The project.", ref("Project"), EX_PROJECT), ...errs(401, 404, 429, 500) },
    },
    patch: {
      operationId: "updateProject", summary: "Update a project", tags: ["Projects"], "x-kanbo-access": "write",
      description: "Rename it, change its look, description or status, or archive / restore it. Send If-Match with its ETag to make sure nobody changed it since you read it.",
      parameters: [P.id("project"), P.ifMatch("project")],
      requestBody: { required: true, content: json(ref("ProjectUpdate"), { status: "at_risk" }) },
      responses: { 200: ok("The updated project.", ref("Project"), { ...EX_PROJECT, status: "at_risk" }, WRITE_HEADERS), ...errs(...WRITE_ERRORS, 404, 412) },
    },
  },
  "/sections": {
    get: {
      operationId: "listSections", summary: "List a project's sections", tags: ["Sections"], "x-kanbo-access": "read",
      description: "All of a project's sections (board columns / list headings), in board order.",
      parameters: [{ name: "project", in: "query", required: true, description: "The project's id.", schema: uuid(), example: PROJECT }],
      responses: { 200: ok("Sections.", ref("SectionList"), listEx(EX_SECTION)), ...errs(400, 401, 404, 429, 500) },
    },
    post: {
      operationId: "createSection", summary: "Add a section", tags: ["Sections"], "x-kanbo-access": "write",
      description: "Adds a section at the end of the project's board.",
      parameters: [P.idempotency],
      requestBody: { required: true, content: json(ref("SectionCreate"), { projectId: PROJECT, name: "In progress" }) },
      responses: { 201: ok("The new section.", ref("Section"), EX_SECTION, RATE_HEADERS), ...errs(...WRITE_ERRORS) },
    },
  },
  "/tasks": {
    get: {
      operationId: "listTasks", summary: "List and filter tasks", tags: ["Tasks"], "x-kanbo-access": "read",
      description: "Tasks you can see, newest first. With updated_since the order is oldest change first, so you can sync: keep the last updatedAt you saw and ask again from a little before it (changes in one transaction share a time). Archived tasks are left out unless you ask for them.",
      parameters: [
        P.workspace("A workspace's id, or \"personal\" for your Personal list."),
        { name: "project", in: "query", description: "A project's id (or \"personal\").", schema: { type: "string" }, example: PROJECT },
        { name: "section", in: "query", description: "A section's id.", schema: uuid() },
        { name: "assignee", in: "query", description: "A user id, \"me\", or \"none\" for unassigned tasks.", schema: { type: "string" }, example: "me" },
        { name: "parent", in: "query", description: "A task's id (its sub-tasks), or \"none\" for top-level tasks only.", schema: { type: "string" } },
        { name: "status", in: "query", description: "One or more of todo, progress, review, blocked, done (comma-separated).", schema: { type: "string" }, example: "todo,progress" },
        { name: "due_before", in: "query", description: "Due on or before this date.", schema: { type: "string", format: "date" }, example: "2026-10-31" },
        { name: "due_after", in: "query", description: "Due on or after this date.", schema: { type: "string", format: "date" } },
        { name: "updated_since", in: "query", description: "Changed at or after this time (ISO 8601 with a zone). Switches the order to oldest change first.", schema: { type: "string", format: "date-time" }, example: "2026-10-05T09:00:00Z" },
        P.includeArchived,
        { name: "q", in: "query", description: "Words in the title or description (up to 200 characters).", schema: { type: "string", maxLength: 200 }, example: "launch" },
        P.limit, P.cursor,
      ],
      responses: { 200: ok("A page of tasks.", ref("TaskList"), listEx(EX_TASK, true)), ...errs(400, 401, 403, 429, 500) },
    },
    post: {
      operationId: "createTask", summary: "Create a task", tags: ["Tasks"], "x-kanbo-access": "write",
      description: "A task lives in its project's workspace. Without a project it goes in your Personal list (personal keys). The assignee must be a member of that workspace. The project's \"When a task is created\" automations run, as in the app (they can set the priority, assignee or section and add tags). Send an Idempotency-Key so a retry never makes it twice.",
      parameters: [P.idempotency],
      requestBody: { required: true, content: json(ref("TaskCreate"), { title: "Write the launch blog post", projectId: PROJECT, assigneeId: PRIYA, dueDate: "2026-10-16", priority: "high", tags: ["writing", "Launch"] }) },
      responses: { 201: ok("The new task, as GET shows it (Location points at it).", ref("Task"), { ...EX_TASK, status: "todo", loggedHours: null, subtaskIds: [], dependencyIds: [] }, { ...WRITE_HEADERS, Location: { schema: { type: "string" } } }), ...errs(...WRITE_ERRORS, 409) },
    },
  },
  "/tasks/{id}": {
    get: {
      operationId: "getTask", summary: "Get a task", tags: ["Tasks"], "x-kanbo-access": "read",
      description: "The task, with the ids of its sub-tasks and of the tasks it waits for.",
      parameters: [P.id("task")],
      responses: { 200: ok("The task.", ref("Task"), EX_TASK_FULL), ...errs(401, 404, 429, 500) },
    },
    patch: {
      operationId: "updateTask", summary: "Update a task", tags: ["Tasks"], "x-kanbo-access": "write",
      description: "Only the fields you send change. Guests can't edit tasks. A status change runs the project's \"status changed\" automations (and \"task completed\" ones when it becomes done), as in the app. Moving a task to another workspace takes its sub-tasks along; only the people who made all of them, or the workspace's owners and admins, may. Send If-Match with the task's ETag so an edit made in Kanbo since you read it is never overwritten (412 instead).",
      parameters: [P.id("task"), P.ifMatch("task")],
      requestBody: { required: true, content: json(ref("TaskUpdate"), { status: "review", assigneeId: "me", dueDate: "2026-10-17" }) },
      responses: { 200: ok("The updated task, as GET shows it.", ref("Task"), { ...EX_TASK_FULL, status: "review", assigneeId: ME, dueDate: "2026-10-17" }, WRITE_HEADERS), ...errs(...WRITE_ERRORS, 404, 412) },
    },
    delete: {
      operationId: "deleteTask", summary: "Archive or delete a task", tags: ["Tasks"], "x-kanbo-access": "write",
      description: "Archives the task and its sub-tasks (restore with PATCH {\"archived\": false}). With hard=true it's deleted for good, with its sub-tasks and comments: workspace owners and admins only (or you, for your personal tasks).",
      parameters: [P.id("task"), { name: "hard", in: "query", description: "true deletes for good.", schema: { type: "boolean", default: false } }, P.ifMatch("task")],
      responses: { 204: { description: "Done. No body.", headers: RATE_HEADERS }, ...errs(400, 401, 403, 404, 412, 429, 500) },
    },
  },
  "/tasks/{id}/complete": {
    post: {
      operationId: "completeTask", summary: "Mark a task done", tags: ["Tasks"], "x-kanbo-access": "write",
      description: "Sets status to done and completedAt to today, and runs the project's \"status changed\" and \"task completed\" automations, as in the app. Calling it again changes nothing. (Recurring tasks: the next occurrence is created when someone completes it in the Kanbo app.)",
      parameters: [P.id("task"), P.ifMatch("task")],
      responses: { 200: ok("The completed task, as GET shows it.", ref("Task"), { ...EX_TASK_FULL, status: "done", completedAt: "2026-10-06" }, WRITE_HEADERS), ...errs(401, 403, 404, 412, 429, 500) },
    },
  },
  "/tasks/{id}/comments": {
    get: {
      operationId: "listComments", summary: "List a task's comments", tags: ["Comments"], "x-kanbo-access": "read",
      description: "Oldest first; replies carry their parent's id.",
      parameters: [P.id("task"), P.limit, P.cursor],
      responses: { 200: ok("Comments.", ref("CommentList"), listEx(EX_COMMENT)), ...errs(400, 401, 404, 429, 500) },
    },
    post: {
      operationId: "createComment", summary: "Comment on a task", tags: ["Comments"], "x-kanbo-access": "write",
      description: "Posts as the key's owner (guests can comment too). The task's creator, assignee and followers see it in their Inbox, as in the app.",
      parameters: [P.id("task"), P.idempotency],
      requestBody: { required: true, content: json(ref("CommentCreate"), { body: "First draft is in the doc — over to you for the intro." }) },
      responses: { 201: ok("The new comment.", ref("Comment"), EX_COMMENT, RATE_HEADERS), ...errs(...WRITE_ERRORS, 404) },
    },
  },
  "/openapi.json": {
    get: {
      operationId: "getOpenApi", summary: "This document", tags: ["Account"], "x-kanbo-access": "read", security: [],
      description: "The OpenAPI 3.1 description of the API. No key needed.",
      responses: { 200: { description: "The document.", content: { "application/json": { schema: { type: "object" } } } } },
    },
  },
};

const INTRO = [
  "Read and change your Kanbo tasks, projects, sections and comments from your own tools and scripts.",
  "",
  "**Keys.** Make one in Settings › Developers. `kanbo_sk_…` keys can read and write; `kanbo_pk_…` keys are read-only (GET only). A personal key acts as you everywhere you can act; a team key acts as you but only inside its workspace. Send it as `Authorization: Bearer <key>`, from a server or script — never from a web page. Kanbo stores only a hash, so a lost key can't be shown again: revoke it and make another.",
  "",
  "**Permissions.** Every request runs as the key's owner with exactly their access in Kanbo: guests can read and comment but not edit, things you can't see answer 404, and a suspended account's keys stop at once.",
  "",
  "**Lists** come as `{ object: \"list\", data, nextCursor, hasMore }`. Pass `nextCursor` back as `cursor` with the same filters; `limit` is 1–100 (default 50).",
  "",
  "**Errors** come as `{ error: { code, message, status, requestId, details? } }`. `validation_failed` lists each bad field in `details.fields`.",
  "",
  "**Rate limits.** 120 requests a minute per key; every answer carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`, and a 429 carries `Retry-After`.",
  "",
  "**Retries.** Send an `Idempotency-Key` header on POST requests: the same key within 24 hours returns the first answer (with `Idempotent-Replayed: true`) instead of doing it again. A replayed answer never repeats a webhook signing secret (`secret` is null): rotate it if the first answer was lost.",
  "",
  "**Caching.** GET answers carry an `ETag`; send it back as `If-None-Match` and an unchanged answer is a bodyless 304.",
  "",
  "**Safe edits.** Writes to one task or project answer with its new `ETag`. Send the `ETag` you last saw as `If-Match` on a write and it only goes ahead if nothing changed since; otherwise you get `412 precondition_failed`, so a two-way sync never overwrites an edit made in Kanbo.",
  "",
  "**Automations.** A project's automations (\"When a task is created\", \"status changed\", \"task completed\") run for API changes too, exactly as in the app. A value a rule names that the task can't take (someone outside the workspace, another project's section) is skipped.",
  "",
  "**Webhooks.** To hear about changes as they happen instead of polling, add a webhook in Settings › Developers › Webhooks. Task, project, comment and member events carry the same JSON as this API. `approval.requested` and `approval.decided` (team workspaces) carry an `ApprovalEvent`: the request, its reviewers and task, and for a decision `decision.decision` (`approved`, `changes_requested`, or `cancelled` when it was withdrawn).",
].join("\n");

/** The document, with `serverUrl` (…/functions/v1/api/v1) as its only server. */
export function buildOpenApi(serverUrl: string): OpenApiDoc {
  return {
    openapi: "3.1.0",
    info: { title: OPENAPI_TITLE, version: OPENAPI_VERSION, description: INTRO, contact: { url: "https://www.kanbo.co.uk" } },
    servers: [{ url: serverUrl.replace(/\/+$/, "") }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Account", description: "Who the key acts as, the workspaces it reaches, and their people." },
      { name: "Tasks", description: "Create, find, update, complete and archive tasks." },
      { name: "Projects", description: "Projects group tasks; a project belongs to a workspace or to your Personal list." },
      { name: "Sections", description: "A project's board columns / list headings." },
      { name: "Comments", description: "The conversation on a task." },
      { name: "Webhooks", description: "Endpoints Kanbo calls when things change (manage them here or in Settings › Developers › Webhooks)." },
    ],
    // a1's paths, then a2's webhook management paths (webhooks.ts)
    paths: { ...PATHS, ...webhookOpenApiPaths },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "kanbo_sk_… (read & write) or kanbo_pk_… (read-only)" },
      },
      schemas: SCHEMAS,
    },
  };
}
