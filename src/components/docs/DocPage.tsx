/* ============================================================
   KANBO — one project doc (/p/:id/docs/:docId).        [0047 stub → w5]
   Loads the doc, shows its title, icon, who edited it last and when,
   the editor (DocEditor), Export as Markdown, Version history, Archive
   and Delete. A doc that's gone (deleted, or its project in the bin)
   says so and offers the way back. Data: lib/docs.
   Renders nothing until package w5 builds it.
   ============================================================ */
import type { Member, Project, Task } from "../../data/types";
import type { DocMakeTask } from "./DocEditor";

export interface DocPageProps {
  project: Project;
  docId: string;
  members: Member[];
  tasks: Task[];
  currentUserId: string;
  readOnly: boolean;
  /** back to the Docs list */
  onBack: () => void;
  onMakeTask: DocMakeTask;
  onOpenTask: (taskId: string) => void;
}

export function DocPage(_props: DocPageProps) {
  return null;
}
