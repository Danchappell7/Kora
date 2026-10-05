/* ============================================================
   KANBO — Settings › Calendar & integrations › Notion. [0046 stub → a3]
   Connect (paste an internal integration token, with the steps to make
   one at notion.so/profile/integrations and share pages with it), test,
   disconnect; the workspace's syncs (database → project, direction,
   last run, last error, on/off, run now, remove); and the "Import a
   Notion database" wizard: pick a database → preview 5 rows → map
   fields → choose a project (or a new one with its identity) → import,
   optionally keeping it in sync. Owners/admins manage; members see the
   status. Personal: explains Notion is per team workspace.
   Data: lib/notion. Renders nothing until package a3 builds it.
   ============================================================ */
import type { Project, Role } from "../../data/types";

export interface NotionPanelProps {
  /** the active workspace (null = Personal) */
  workspaceId: string | null;
  workspaceName?: string;
  /** your role there (null in Personal) */
  role: Role | null;
  /** the workspace's projects, for "Import into…" */
  projects: Array<Pick<Project, "id" | "name" | "emoji" | "color" | "archivedAt">>;
  /** after an import: open the project it filled */
  onOpenProject?: (projectId: string) => void;
}

export function NotionPanel(_props: NotionPanelProps) {
  return null;
}
