/* ============================================================
   KANBO — a project's Docs tab (/p/:id/docs).          [0047 stub → w5]
   The project's docs with their icons (drag to reorder, archive), New
   doc from templates (Blank, Project brief, Meeting notes, Decision log,
   Retro); opening one shows DocPage (/p/:id/docs/:docId). Read-only for
   guests. Data: lib/docs. Renders nothing until package w5 builds it.
   ============================================================ */
import type { Member, Project, Task } from "../../data/types";
import type { DocMakeTask } from "./DocEditor";

export interface DocsTabProps {
  project: Project;
  members: Member[];
  tasks: Task[];
  currentUserId: string;
  readOnly: boolean;
  /** the open doc (from the address), or null for the list */
  docId: string | null;
  /** open a doc (null: back to the list) — the host updates the address */
  onOpenDoc: (docId: string | null) => void;
  onMakeTask: DocMakeTask;
  onOpenTask: (taskId: string) => void;
}

export function DocsTab(_props: DocsTabProps) {
  return null;
}
