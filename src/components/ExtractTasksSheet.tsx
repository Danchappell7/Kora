/* ============================================================
   KANBO — Paste notes → tasks: reads tasks out of meeting notes
   (AI when it's on, on-device rules otherwise) for review before
   they're created.
   W0 stub: renders nothing; P14 builds the sheet.
   ============================================================ */
import type { Task, Project } from "../data/types";
import type { AiOutcome, ExtractedTask } from "../lib/askTypes";

export function ExtractTasksSheet(_props: {
  open: boolean;
  onClose: () => void;
  initialText?: string;
  /** what the notes are from, e.g. a meeting's title */
  context?: string;
  projects: Project[];
  members: { id: string; name: string }[];
  defaultProjectId?: string;
  currentUserId: string;
  onExtractAI?: (text: string, context?: string) => Promise<AiOutcome<ExtractedTask[]>>;
  onCreate: (tasks: Array<Partial<Task> & { title: string }>) => void;
}): JSX.Element | null {
  return null;
}
