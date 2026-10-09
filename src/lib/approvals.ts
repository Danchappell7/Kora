/* ============================================================
   KANBO — approvals (TaskDetail panel, row/card badges, Inbox
   "Approvals for you", My tasks › Waiting on).  [0047 contract → w4]

   Contract (database 0047):
     tables approvals, approval_reviewers — select only (RLS: anyone who
       can see the task); realtime streams both.
       Badges: approvals?workspace_id=eq.<ws>&select=id,task_id,status,rule,
               created_at,approval_reviewers(decision)  (latest per task wins)
     rpc request_approval(p_task, p_reviewers uuid[], p_note?, p_rule 'any'|'all',
                          p_title?, p_attachment?) → approval JSON
         people who can edit the task (never guests); team tasks only;
         1–10 reviewers, active in the task's workspace (guests may review), not you;
         one open request per task
     rpc decide_approval(p_approval, p_decision 'approved'|'changes_requested', p_comment?)
         → approval JSON (your own review only; open requests only; you can change
           your mind until it resolves)
     rpc cancel_approval(p_approval) → approval JSON (the requester, or an owner/admin)
     rpc task_approvals(p_task) → approval JSON[] (newest first, ≤ 20)
     rpc list_my_approvals() → { to_review: [...], requested: [...] }  (each with `task`)
     errors: 'not authorized' · 'task not found' · 'approvals need a team task' ·
             'invalid rule' · 'invalid reviewers' · 'invalid note' · 'invalid comment' ·
             'invalid decision' · 'invalid attachment' · 'already pending' ·
             'approval not found' · 'approval closed'
   Side effects (server): Inbox activity kind 'approval' with meta
     { approval_id, event, status } — a request → each reviewer (pref
     'approval'); a decision → the requester. task_events field 'approval':
     new_value = the event, old_value = the request's status after it.
     Webhooks approval.requested / approval.decided (cancel = decided with
     decision 'cancelled'). Email/push: notify kind 'approval' (w4).

   Package w4 implements the async functions (real + demo fakes) and the
   components; parsers, resolveApprovalStatus and summaries are final.
   ============================================================ */
import type {
  ActivityMeta, Approval, ApprovalDecision, ApprovalFailure, ApprovalReviewer, ApprovalRule, ApprovalStatus, ApprovalSummary,
  ApprovalWithTask, MyApprovals, NewApprovalInput, Status,
} from "../data/types";

export const APPROVAL_LIMITS = { reviewers: 10, title: 200, note: 2000, comment: 2000 } as const;

const STATUSES = new Set<ApprovalStatus>(["pending", "approved", "changes_requested", "cancelled"]);
const DECISIONS = new Set<ApprovalDecision>(["approved", "changes_requested"]);
const TASK_STATUSES = new Set<Status>(["todo", "progress", "review", "blocked", "done"]);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const pick = (r: Record<string, unknown>, snake: string, camel: string) => (r[snake] !== undefined ? r[snake] : r[camel]);

function parseReviewer(raw: unknown): ApprovalReviewer | null {
  const r = obj(raw);
  const userId = r && str(pick(r, "user_id", "userId"));
  if (!r || !userId) return null;
  const d = r.decision;
  return {
    userId,
    name: str(r.name) ?? "Someone",
    decision: typeof d === "string" && DECISIONS.has(d as ApprovalDecision) ? (d as ApprovalDecision) : null,
    comment: str(r.comment),
    decidedAt: str(pick(r, "decided_at", "decidedAt")),
  };
}

/** An approval JSON object (snake_case; camelCase also read) → Approval; null if malformed. */
export function parseApproval(raw: unknown): Approval | null {
  const r = obj(raw);
  if (!r) return null;
  const id = str(r.id), taskId = str(pick(r, "task_id", "taskId")), workspaceId = str(pick(r, "workspace_id", "workspaceId"));
  const status = r.status, rule = r.rule;
  if (!id || !taskId || !workspaceId) return null;
  if (typeof status !== "string" || !STATUSES.has(status as ApprovalStatus) || (rule !== "any" && rule !== "all")) return null;
  return {
    id, taskId, workspaceId,
    requestedBy: str(pick(r, "requested_by", "requestedBy")),
    requestedByName: str(pick(r, "requested_by_name", "requestedByName")),
    title: typeof r.title === "string" ? r.title : "",
    note: str(r.note),
    attachmentId: str(pick(r, "attachment_id", "attachmentId")),
    status: status as ApprovalStatus,
    rule,
    createdAt: str(pick(r, "created_at", "createdAt")) ?? "",
    updatedAt: str(pick(r, "updated_at", "updatedAt")) ?? "",
    resolvedAt: str(pick(r, "resolved_at", "resolvedAt")),
    reviewers: (Array.isArray(r.reviewers) ? r.reviewers : []).map(parseReviewer).filter((x): x is ApprovalReviewer => !!x),
    canDecide: pick(r, "can_decide", "canDecide") === true,
    canCancel: pick(r, "can_cancel", "canCancel") === true,
  };
}

/** list_my_approvals() items: an approval plus its `task`. */
export function parseApprovalWithTask(raw: unknown): ApprovalWithTask | null {
  const a = parseApproval(raw);
  if (!a) return null;
  const t = obj((raw as Record<string, unknown>).task);
  const tid = t && str(t.id);
  const st = t?.status;
  return {
    ...a,
    task: t && tid ? {
      id: tid,
      title: typeof t.title === "string" ? t.title : "",
      projectId: str(pick(t, "project_id", "projectId")) ?? "",
      workspaceId: str(pick(t, "workspace_id", "workspaceId")),
      status: typeof st === "string" && TASK_STATUSES.has(st as Status) ? (st as Status) : "todo",
      dueDate: str(pick(t, "due_date", "dueDate")),
    } : null,
  };
}

export function parseMyApprovals(raw: unknown): MyApprovals {
  const r = obj(raw) ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v : []).map(parseApprovalWithTask).filter((x): x is ApprovalWithTask => !!x);
  return { toReview: list(pick(r, "to_review", "toReview")), requested: list(r.requested) };
}

/** The status the server resolves to from these reviews (mirrors approval_resolve()). */
export function resolveApprovalStatus(rule: ApprovalRule, decisions: (ApprovalDecision | null)[]): ApprovalStatus {
  if (decisions.some((d) => d === "changes_requested")) return "changes_requested";
  if (rule === "any" && decisions.some((d) => d === "approved")) return "approved";
  if (rule === "all" && decisions.length > 0 && decisions.every((d) => d === "approved")) return "approved";
  return "pending";
}

/** An approval → its badge numbers. */
export function approvalSummary(a: Pick<Approval, "id" | "taskId" | "status" | "rule" | "reviewers">): ApprovalSummary {
  return {
    approvalId: a.id, taskId: a.taskId, status: a.status, rule: a.rule,
    approved: a.reviewers.filter((r) => r.decision === "approved").length,
    total: a.reviewers.length,
  };
}

/** The badge's words: "Pending 1/2" (everyone must approve) · "Pending" (anyone may) ·
 *  "Approved" · "Changes requested" · "Cancelled". */
export function approvalBadgeLabel(s: Pick<ApprovalSummary, "status" | "approved" | "total" | "rule">): string {
  switch (s.status) {
    case "approved": return "Approved";
    case "changes_requested": return "Changes requested";
    case "cancelled": return "Cancelled";
    default: return s.rule === "all" ? `Pending ${s.approved}/${s.total}` : "Pending";
  }
}

/** An Inbox approval item's verb, after the actor's name (activity.detail) and before the task's title:
 *  "Sana asked for your approval on Homepage copy" · "Olive approved Homepage copy". */
export function approvalActivityVerb(meta: ActivityMeta | undefined): string {
  switch (meta?.event) {
    case "approved": return meta.status === "approved" ? "approved" : "approved their part of";
    case "changes_requested": return "asked for changes on";
    case "cancelled": return "cancelled the approval request on";
    default: return "asked for your approval on";
  }
}

/** A database / network error → why (the messages the 0047 functions raise). */
export function approvalFailure(e: unknown): ApprovalFailure {
  const msg = String((e as { message?: unknown })?.message ?? e ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  if (code === "42883" || code === "PGRST202" || /could not find the function|does not exist/i.test(msg)) return "unavailable";
  if (/failed to fetch|network|load failed/i.test(msg)) return "network";
  if (/already pending/i.test(msg)) return "already_pending";
  if (/approval closed/i.test(msg)) return "closed";
  if (/^invalid |invalid (rule|reviewers|note|comment|decision|attachment)|need a team task/i.test(msg)) return "invalid";
  if (/not authorized|not allowed|permission denied/i.test(msg)) return "not_allowed";
  if (/not found/i.test(msg)) return "not_found";
  return "error";
}

const notBuilt = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package w4)`));

/** A task's requests, newest first. */
export function listTaskApprovals(_taskId: string): Promise<Approval[]> { return notBuilt("listTaskApprovals"); }
/** Waiting on you, and waiting on others for you. Demo mode: realistic fakes. */
export function listMyApprovals(): Promise<MyApprovals> { return notBuilt("listMyApprovals"); }
/** Badges for a workspace: task id → its latest request's summary. */
export function listApprovalSummaries(_workspaceId: string): Promise<Record<string, ApprovalSummary>> { return notBuilt("listApprovalSummaries"); }
export function requestApproval(_input: NewApprovalInput): Promise<Approval> { return notBuilt("requestApproval"); }
export function decideApproval(_approvalId: string, _decision: ApprovalDecision, _comment?: string | null): Promise<Approval> { return notBuilt("decideApproval"); }
export function cancelApproval(_approvalId: string): Promise<Approval> { return notBuilt("cancelApproval"); }
/** Live changes to approvals / reviews the person can see (realtime, RLS-scoped). Returns unsubscribe; a no-op in demo mode. */
export function subscribeApprovals(_onChange: (change: { table: "approvals" | "approval_reviewers"; approvalId: string; taskId: string | null }) => void): () => void {
  return () => {};
}
