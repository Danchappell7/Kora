/* ============================================================
   KANBO — workspace history (Settings › Workspace › History).
                                                  [0047 contract → w1]
   Contract (database 0047):
     table audit_events (select only; RLS: owners/admins read the whole
       workspace's, everyone else only their own actions — the server
       enforces it, the UI just says so). Written by triggers and definer
       functions only; kept 365 days.
       Page: .eq("workspace_id", ws) [.eq("actor_id", id)] [.in("action", …)]
             [.gte("created_at", from 00:00 Europe/London) .lt("created_at", day after `to`)]
             keyset: created_at < cursor.createdAt (ties: id < cursor.id)
             .order("created_at", desc).order("id", desc).limit(n)
       Index: (workspace_id, created_at desc, id), (workspace_id, actor_id, created_at desc).

   Package w1 implements listAuditEvents (real + demo fakes), the CSV
   export and the timeline; the catalogue and parser are final.
   ============================================================ */
import type { AuditAction, AuditEvent, AuditFailure, AuditPage, AuditQuery, AuditTargetKind } from "../data/types";

export type AuditGroup = "Tasks and projects" | "People" | "Workspace" | "Integrations";

/** Every action the database writes today, with its filter label and group. */
export const AUDIT_ACTION_INFO: Readonly<Record<AuditAction, { label: string; group: AuditGroup }>> = {
  "task.deleted":             { label: "Task deleted",              group: "Tasks and projects" },
  "task.restored":            { label: "Task restored",             group: "Tasks and projects" },
  "task.purged":              { label: "Task deleted for good",     group: "Tasks and projects" },
  "project.deleted":          { label: "Project deleted",           group: "Tasks and projects" },
  "project.restored":         { label: "Project restored",          group: "Tasks and projects" },
  "project.purged":           { label: "Project deleted for good",  group: "Tasks and projects" },
  "project.archived":         { label: "Project archived",          group: "Tasks and projects" },
  "project.unarchived":       { label: "Project unarchived",        group: "Tasks and projects" },
  "member.invited":           { label: "Invited",                   group: "People" },
  "member.joined":            { label: "Joined",                    group: "People" },
  "member.removed":           { label: "Removed or left",           group: "People" },
  "role.changed":             { label: "Role changed",              group: "People" },
  "workspace.renamed":        { label: "Workspace renamed",         group: "Workspace" },
  "integration.connected":    { label: "Integration connected",     group: "Integrations" },
  "integration.disconnected": { label: "Integration disconnected",  group: "Integrations" },
  "api_key.created":          { label: "API key created",           group: "Integrations" },
  "api_key.revoked":          { label: "API key revoked",           group: "Integrations" },
  "webhook.created":          { label: "Webhook added",             group: "Integrations" },
  "webhook.deleted":          { label: "Webhook deleted",           group: "Integrations" },
};
export const AUDIT_ACTIONS = Object.keys(AUDIT_ACTION_INFO) as AuditAction[];
/** The page size the UI asks for, and the most one query may return. */
export const AUDIT_PAGE = 100;
export const AUDIT_PAGE_MAX = 500;
/** How long history is kept (trash_housekeeping prunes older rows). */
export const AUDIT_RETENTION_DAYS = 365;

const TARGET_KINDS = new Set<string>(["task", "project", "member", "workspace", "integration", "api_key", "webhook"]);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const pick = (r: Record<string, unknown>, snake: string, camel: string) => (r[snake] !== undefined ? r[snake] : r[camel]);

/** An audit_events row (snake_case; camelCase also read) → AuditEvent; null if malformed. */
export function parseAuditEvent(raw: unknown): AuditEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id), workspaceId = str(pick(r, "workspace_id", "workspaceId")), action = str(r.action);
  const createdAt = str(pick(r, "created_at", "createdAt"));
  if (!id || !workspaceId || !action || !/^[a-z_]+\.[a-z_]+$/.test(action) || !createdAt) return null;
  const tk = str(pick(r, "target_kind", "targetKind"));
  const detail = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? (r.detail as Record<string, unknown>) : {};
  return {
    id, workspaceId,
    actorId: str(pick(r, "actor_id", "actorId")),
    actorName: str(pick(r, "actor_name", "actorName")) ?? "Someone",
    action: action as AuditAction,
    targetKind: tk ? (TARGET_KINDS.has(tk) ? (tk as AuditTargetKind) : tk) : null,
    targetId: str(pick(r, "target_id", "targetId")),
    targetTitle: str(pick(r, "target_title", "targetTitle")),
    detail,
    createdAt,
  };
}

/** A known action's label; an action from a later migration shows as its raw name. */
export function auditActionLabel(action: string): string {
  return (AUDIT_ACTION_INFO as Record<string, { label: string }>)[action]?.label ?? action;
}

export function auditFailure(e: unknown): AuditFailure {
  const msg = String((e as { message?: unknown })?.message ?? e ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  if (code === "42P01" || code === "PGRST205" || /does not exist|could not find the table/i.test(msg)) return "unavailable";
  if (/failed to fetch|network|load failed/i.test(msg)) return "network";
  return "error";
}

const notBuilt = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package w1)`));

/** One page of a workspace's history, newest first. Demo mode: realistic fakes. */
export function listAuditEvents(_query: AuditQuery): Promise<AuditPage> { return notBuilt("listAuditEvents"); }

/** One line for the timeline ("Olive changed Sana's role from member to admin"). [stub → w1] */
export function describeAuditEvent(e: AuditEvent): string {
  return `${e.actorName} · ${auditActionLabel(e.action)}${e.targetTitle ? ` · ${e.targetTitle}` : ""}`;
}

/** CSV of these events (Export CSV): when, who, action, what, details — UTF-8 with a header row. [stub → w1] */
export function auditEventsToCsv(_events: AuditEvent[]): string {
  throw new Error("auditEventsToCsv: not built yet (package w1)");
}
