/* ============================================================
   KANBO — one-tap kudos.                                [0048 stub → u10]
   For a teammate's finished team task (Pulse's "Done since yesterday"
   rows, the task panel): tap → 🎉 sent ("Kudos sent to Sana", Undo);
   long-press / the caret → another emoji (KUDOS_EMOJI) and an optional
   note (≤ 140). Tap again to take it back. Shows the count others gave.
   A toggle button (aria-pressed) with a clear name. Hidden for your own
   tasks, unfinished ones, Personal ones, and suspended people.
   Renders nothing until package u10 builds it.
   ============================================================ */
import type { Kudos, Task } from "../../data/types";

export interface KudosButtonProps {
  task: Pick<Task, "id" | "title" | "status" | "assigneeId" | "workspaceId">;
  currentUserId: string;
  /** "Sana" — who it's for */
  recipientName: string;
  /** every kudos on this task (yours among them, if given) */
  kudos: Kudos[];
  size?: "sm" | "md";
  disabled?: boolean;
  onChange?: (next: Kudos[]) => void;
}

export function KudosButton(_props: KudosButtonProps) {
  return null;
}
