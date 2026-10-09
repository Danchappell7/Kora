/* ============================================================
   KANBO — TaskDetail › Approvals.                      [0047 stub → w4]
   Request approval (pick reviewers from the workspace's people — guests
   included — a note, any/all, optionally one of the task's files);
   the open request's status chip, each reviewer's decision with avatar
   and comment, Approve / Request changes for reviewers, Cancel for the
   requester (and owners/admins); earlier requests folded below.
   Data: lib/approvals. Renders nothing until package w4 builds it.
   ============================================================ */
import type { Approval, Attachment, Member, Task } from "../../data/types";

export interface ApprovalPanelProps {
  task: Task;
  /** the task's workspace's active people (the reviewer picker) */
  members: Member[];
  /** which of `members` are guests (they can review; they can't request) */
  guestIds?: string[];
  currentUserId: string;
  /** a guest here: can't request or cancel, can still decide their own review */
  readOnly?: boolean;
  /** the task's files ("approve this file") */
  attachments?: Attachment[];
  /** bump when realtime reports a change to this task's approvals or reviews */
  refreshKey?: number;
  /** after any change (the host refreshes badges / the Inbox group) */
  onChange?: (approval: Approval) => void;
}

export function ApprovalPanel(_props: ApprovalPanelProps) {
  return null;
}
