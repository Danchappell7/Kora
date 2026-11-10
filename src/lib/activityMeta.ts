/* ============================================================
   KANBO — activity.meta (0047): what an Inbox item points at beyond
   its task. Written only by the 0047 definer functions:
     approval      { approval_id, event, status, rule?, comment? }
     doc_mention   { doc_id, project_id }
     kudos         { kudos_id, emoji, note }          (0048)
     update        { status_update_id, project_id, update_event, update_status, ask, comment_id? }
                   or { portfolio_id, portfolio_update_id, update_event: "portfolio", … }   (0054)
     meeting       { meeting_id, workspace_id, preset, decisions, actions, doc_id, project_id }   (0056)
   Older rows (and rows a client logs for itself) have none.  [architect]
   ============================================================ */
import type { ActivityMeta, ApprovalEvent, ApprovalRule, ApprovalStatus, StatusKind } from "../data/types";

const EVENTS = new Set<ApprovalEvent>(["requested", "approved", "changes_requested", "cancelled"]);
const STATUSES = new Set<ApprovalStatus>(["pending", "approved", "changes_requested", "cancelled"]);
const RULES = new Set<ApprovalRule>(["any", "all"]);
const UPDATE_EVENTS = new Set<NonNullable<ActivityMeta["updateEvent"]>>(["posted", "asked", "comment", "portfolio"]);
const UPDATE_STATUSES = new Set<StatusKind>(["on_track", "at_risk", "off_track", "on_hold"]);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** activity.meta (snake_case; camelCase also read) → ActivityMeta, or undefined when there's nothing. */
export function parseActivityMeta(raw: unknown): ActivityMeta | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const g = (snake: string, camel: string) => (r[snake] !== undefined ? r[snake] : r[camel]);
  const out: ActivityMeta = {};
  const approvalId = str(g("approval_id", "approvalId"));
  if (approvalId) out.approvalId = approvalId;
  if (typeof r.event === "string" && EVENTS.has(r.event as ApprovalEvent)) out.event = r.event as ApprovalEvent;
  if (typeof r.status === "string" && STATUSES.has(r.status as ApprovalStatus)) out.status = r.status as ApprovalStatus;
  if (typeof r.rule === "string" && RULES.has(r.rule as ApprovalRule)) out.rule = r.rule as ApprovalRule;
  if (typeof r.comment === "string") out.comment = r.comment;
  const docId = str(g("doc_id", "docId"));
  if (docId) out.docId = docId;
  const projectId = str(g("project_id", "projectId"));
  if (projectId) out.projectId = projectId;
  const kudosId = str(g("kudos_id", "kudosId"));
  if (kudosId) out.kudosId = kudosId;
  if (typeof r.emoji === "string" && r.emoji) out.emoji = r.emoji;
  if (typeof r.note === "string") out.note = r.note;
  else if (r.note === null && kudosId) out.note = null;
  // 0054 project and portfolio updates
  const statusUpdateId = str(g("status_update_id", "statusUpdateId"));
  if (statusUpdateId) out.statusUpdateId = statusUpdateId;
  const updateEvent = g("update_event", "updateEvent");
  if (typeof updateEvent === "string" && UPDATE_EVENTS.has(updateEvent as NonNullable<ActivityMeta["updateEvent"]>)) out.updateEvent = updateEvent as ActivityMeta["updateEvent"];
  const updateStatus = g("update_status", "updateStatus");
  if (typeof updateStatus === "string" && UPDATE_STATUSES.has(updateStatus as StatusKind)) out.updateStatus = updateStatus as StatusKind;
  if (typeof r.ask === "boolean") out.ask = r.ask;
  const commentId = str(g("comment_id", "commentId"));
  if (commentId) out.commentId = commentId;
  const portfolioId = str(g("portfolio_id", "portfolioId"));
  if (portfolioId) out.portfolioId = portfolioId;
  const portfolioUpdateId = str(g("portfolio_update_id", "portfolioUpdateId"));
  if (portfolioUpdateId) out.portfolioUpdateId = portfolioUpdateId;
  // 0056 meeting recaps
  const meetingId = str(g("meeting_id", "meetingId"));
  if (meetingId) out.meetingId = meetingId;
  const workspaceId = str(g("workspace_id", "workspaceId"));
  if (workspaceId) out.workspaceId = workspaceId;
  const preset = g("preset", "meetingPreset");
  if (preset === "team" || preset === "leadership") out.meetingPreset = preset;
  for (const k of ["decisions", "actions"] as const) {
    const n = r[k];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[k] = Math.floor(n);
  }
  return Object.keys(out).length ? out : undefined;
}
