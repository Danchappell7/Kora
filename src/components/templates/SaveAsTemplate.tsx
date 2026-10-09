/* ============================================================
   KANBO — "Save as template" (TaskDetail ⋯ menu).       [0048 stub → u9]
   A small sheet prefilled from the task (lib/templates templateFromTask):
   name, emoji, what it keeps (title, description, priority, estimate,
   tags, sub-tasks with relative days and roles, checklist), "Share with
   <workspace>" for writers; Save → the library.
   Renders nothing until package u9 builds it.
   ============================================================ */
import type { LibraryTemplate, Task } from "../../data/types";

export interface SaveAsTemplateProps {
  open: boolean;
  task: Task;
  /** the task's sub-tasks (tasks whose parentId is it) */
  subtasks: Task[];
  workspaceId: string | null;
  workspaceName?: string;
  canShare: boolean;
  onClose: () => void;
  onSaved?: (template: LibraryTemplate) => void;
}

export function SaveAsTemplate(_props: SaveAsTemplateProps) {
  return null;
}
