/* ============================================================
   KANBO — the approval chip on task rows and cards.           [0047 · w4]
   "Pending 1/2" (everyone must approve) · "Pending" (anyone may) ·
   "Approved" · "Changes requested" (lib/approvals approvalBadgeLabel);
   cancelled requests show nothing. A kit Pill in the status's tone
   (accent · ok · warn) with its icon; a screen reader hears the whole
   thing ("Approval pending, 1 of 2 approved").
   Mount (integrator): beside a row's / card's other chips —
     <ApprovalBadge summary={summaries[task.id]} />   (summaries from
     lib/approvals listApprovalSummaries(workspaceId), refreshed on
     subscribeApprovals). Renders nothing without a summary.
   ============================================================ */
import type { ApprovalSummary } from "../../data/types";
import { Icon } from "../primitives";
import { APPROVAL_STATUS_INFO, approvalBadgeAria, approvalBadgeLabel } from "../../lib/approvals";
import "./approvals.css";

export interface ApprovalBadgeProps {
  /** the task's latest request (lib/approvals listApprovalSummaries); nothing → renders nothing */
  summary: ApprovalSummary | null | undefined;
  size?: "sm" | "md";
}

export function ApprovalBadge({ summary, size = "sm" }: ApprovalBadgeProps) {
  if (!summary || summary.status === "cancelled" || !APPROVAL_STATUS_INFO[summary.status]) return null;
  const info = APPROVAL_STATUS_INFO[summary.status];
  const aria = approvalBadgeAria(summary);
  return (
    <span className="kpill kapv-badge" data-tone={info.tone} data-size={size} data-status={summary.status} title={aria}>
      <Icon name={info.icon} size={12} sw={2} />
      <span className="kapv-badge-text" aria-hidden="true">{approvalBadgeLabel(summary)}</span>
      <span className="sr-only">{aria}</span>
    </span>
  );
}
