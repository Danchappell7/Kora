/* ============================================================
   KANBO — the block editor for project docs.           [0047 stub → w5]
   Blocks: heading 1/2/3, paragraph, bulleted/numbered list, checklist,
   quote, divider, callout. "/" slash menu; Markdown shortcuts (#, -,
   [], >, ---); ⌘B / ⌘I / ⌘E / ⌘K for bold, italic, code, link; @mention
   members; "Make task" on any line (a backlink chip with the task's live
   status); paste of plain text / Markdown; arrow keys between blocks;
   autosave after 2 s idle and on blur (Saving… / Saved); the conflict
   banner ("Sana edited this — Reload / Keep mine"); version history
   drawer with restore. Read-only for guests. No new dependencies.
   Data: lib/docs. Renders nothing until package w5 builds it.
   ============================================================ */
import type { DocSaveState, Member, ProjectDoc, Task } from "../../data/types";

/** "Make task" on a line: the host creates the task in the doc's project; resolves to its id (null: not made). */
export type DocMakeTask = (input: { title: string; projectId: string; docId: string; blockId: string }) => Promise<string | null>;

export interface DocEditorProps {
  /** the doc as loaded (its updatedAt is the first save's base) */
  doc: ProjectDoc;
  /** the project's people (@mentions) */
  members: Member[];
  /** tasks in view (a Make-task line shows its task's live status) */
  tasks: Task[];
  currentUserId: string;
  /** guests, or you can't edit the project */
  readOnly: boolean;
  onSaved?: (doc: ProjectDoc) => void;
  onSaveState?: (state: DocSaveState) => void;
  onMakeTask: DocMakeTask;
  onOpenTask: (taskId: string) => void;
}

export function DocEditor(_props: DocEditorProps) {
  return null;
}
