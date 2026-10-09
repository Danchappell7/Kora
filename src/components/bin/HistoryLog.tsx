/* ============================================================
   KANBO — Settings › Workspace › History.              [0047 stub → w1]
   A filterable timeline of the workspace's history (person, action
   type, date range), paged as you scroll, with Export CSV. Owners and
   admins see everyone's actions; others see only their own (the server
   enforces it — say so in the page). Data: lib/audit.
   Renders nothing until package w1 builds it.
   ============================================================ */
import type { Member } from "../../data/types";

export interface HistoryLogProps {
  workspaceId: string;
  workspaceName: string;
  /** names and avatars for the person filter */
  members: Member[];
  currentUserId: string;
  /** owner/admin: everyone's actions; otherwise only your own */
  canSeeAll: boolean;
}

export function HistoryLog(_props: HistoryLogProps) {
  return null;
}
