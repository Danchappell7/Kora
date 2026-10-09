/* ============================================================
   KANBO — activity.meta (0047): what an Inbox item points at beyond
   its task. Written only by the 0047 definer functions:
     approval      { approval_id, event, status, rule?, comment? }
     doc_mention   { doc_id, project_id }
     kudos         { kudos_id, emoji, note }          (0048)
   Older rows (and rows a client logs for itself) have none.  [architect]
   ============================================================ */
import type { ActivityMeta, ApprovalEvent, ApprovalRule, ApprovalStatus } from "../data/types";

const EVENTS = new Set<ApprovalEvent>(["requested", "approved", "changes_requested", "cancelled"]);
const STATUSES = new Set<ApprovalStatus>(["pending", "approved", "changes_requested", "cancelled"]);
const RULES = new Set<ApprovalRule>(["any", "all"]);
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
  return Object.keys(out).length ? out : undefined;
}
