/* ============================================================
   KANBO — Weekly review: the week's wins, what carried over, and
   next week's Big 3.
   W0 stub: renders nothing; P10 builds the sheet.
   ============================================================ */
import type { Task } from "../../data/types";

export function WeeklyReview(_props: {
  open: boolean;
  onClose: () => void;
  tasks: Task[];
  allTasks: Task[];
  currentUserId: string;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onSummarise?: () => Promise<string | null>;
}): JSX.Element | null {
  return null;
}
