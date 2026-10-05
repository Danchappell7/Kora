/* ============================================================
   KANBO — Notion pages linked to a task (TaskDetail).  [0046 stub → a3]
   One chip per linked page (icon, title, "edited 2h ago", opens Notion
   in a new tab; a synced page says so), plus "Link a Notion page"
   (paste a URL) for people who can edit the task when the workspace has
   Notion connected. Personal tasks and workspaces without Notion: renders
   nothing. Data: lib/notion (links stream over realtime).
   Renders nothing until package a3 builds it.
   ============================================================ */

export interface NotionLinkChipProps {
  taskId: string;
  /** the task's workspace (null = personal task → nothing) */
  workspaceId: string | null;
  /** may this person change the task (not a guest) */
  canEdit: boolean;
}

export function NotionLinkChip(_props: NotionLinkChipProps) {
  return null;
}
