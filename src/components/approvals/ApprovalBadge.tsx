/* ============================================================
   KANBO — the approval chip on task rows and cards.    [0047 stub → w4]
   "Pending 1/2" · "Pending" · "Approved" · "Changes requested"
   (lib/approvals approvalBadgeLabel); cancelled requests show nothing.
   Renders nothing until package w4 builds it.
   ============================================================ */
import type { ApprovalSummary } from "../../data/types";

export interface ApprovalBadgeProps {
  /** the task's latest request (lib/approvals listApprovalSummaries); nothing → renders nothing */
  summary: ApprovalSummary | null | undefined;
  size?: "sm" | "md";
}

export function ApprovalBadge(_props: ApprovalBadgeProps) {
  return null;
}
