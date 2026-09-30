/* ============================================================
   KANBO — Shut down my day: what you finished ("Your day in
   colour"), what's left and where it goes, anything blocking you.
   W0 stub: renders nothing; P10 builds the sheet.
   ============================================================ */
import type { Task } from "../../data/types";

export function ShutdownSheet(_props: {
  open: boolean;
  onClose: () => void;
  tasks: Task[];
  allTasks: Task[];
  currentUserId: string;
  userName?: string;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onComment: (taskId: string, body: string) => Promise<unknown>;
  focusMinutesToday?: number;
}): JSX.Element | null {
  return null;
}
