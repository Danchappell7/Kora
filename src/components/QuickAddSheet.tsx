/* ============================================================
   KANBO — the phone's quick add.                        [0048 stub → u7]
   A bottom sheet opened from the phone bar's centre + button: a big
   input with live highlighting of what the natural-language parser
   understood (lib/nlp parseTask + segments: dates, times, people,
   projects, priority, estimate — tap a token to undo it), chips for your
   recent projects, a voice-friendly layout (works with the keyboard's
   dictation: no time-outs, punctuation tolerated), Add / Add and keep
   going. Keyboard: Enter adds, Escape closes; labelled dialog; focus
   returns. Reduced motion: no slide. Read-only people never see it.
   Renders nothing until package u7 builds it.
   ============================================================ */
import type { Member, Project, Task } from "../data/types";

export interface QuickAddSheetProps {
  open: boolean;
  onClose: () => void;
  projects: Pick<Project, "id" | "name" | "color" | "emoji" | "workspaceId">[];
  members: Pick<Member, "id" | "name">[];
  /** newest first, at most 5 shown */
  recentProjectIds?: string[];
  defaultProjectId?: string;
  currentUserId: string;
  /** the same contract as QuickCapture's onCreate */
  onCreate: (partial: Partial<Task> & { title: string }) => void;
}

export function QuickAddSheet(_props: QuickAddSheetProps) {
  return null;
}
