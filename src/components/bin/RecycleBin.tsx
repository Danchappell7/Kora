/* ============================================================
   KANBO — Projects › Recycle bin (/projects/bin).     [0047 stub → w1]
   The workspace's deleted tasks and projects for 30 days: kind icon,
   title, project identity (ProjectChip), deleted by / when, days left;
   search; Restore (with the server's note in the toast), bulk restore,
   Delete forever (owners/admins for team items, the creator for
   personal ones) with a confirm; an empty state. Guests see it read-only.
   Data: lib/trash. Renders nothing until package w1 builds it.
   ============================================================ */
import type { Member, Project, Role, TrashRestoreResult } from "../../data/types";

export interface RecycleBinProps {
  /** the workspace open in the app; null = your Personal bin */
  workspaceId: string | null;
  workspaceName: string;
  /** your role here; null in Personal (you own everything there) */
  role: Role | null;
  currentUserId: string;
  /** for "deleted by" avatars */
  members: Member[];
  /** the workspace's live projects (a restored task's destination, chips) */
  projects: Project[];
  /** after a restore succeeds: the host merges the rows back (realtime also brings them) and may toast */
  onRestored?: (results: TrashRestoreResult[]) => void;
  onOpenProject?: (projectId: string) => void;
  onOpenTask?: (taskId: string) => void;
}

export function RecycleBin(_props: RecycleBinProps) {
  return null;
}
