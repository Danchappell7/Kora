/* ============================================================
   KANBO — Inbox › "Approvals for you".                 [0047 stub → w4]
   Open requests waiting on your decision, newest first: task, project
   chip, who asked, their note, the file; Approve / Request changes
   (with an optional comment). Keys while a row has focus: A approve,
   C request changes, Enter open the task. Data: lib/approvals.
   Renders nothing until package w4 builds it.
   ============================================================ */
import type { Approval, ApprovalWithTask, Member, Project } from "../../data/types";

export interface ApprovalsInboxGroupProps {
  /** lib/approvals listMyApprovals().toReview */
  approvals: ApprovalWithTask[];
  projects: Project[];
  members: Member[];
  currentUserId: string;
  onOpenTask: (taskId: string) => void;
  /** after a decision (the host drops it from the group and refreshes badges) */
  onDecided?: (approval: Approval) => void;
}

export function ApprovalsInboxGroup(_props: ApprovalsInboxGroupProps) {
  return null;
}
