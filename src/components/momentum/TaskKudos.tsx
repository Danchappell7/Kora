/* ============================================================
   KANBO — kudos in the task panel (0048 · u10).
   KudosButton on a teammate's finished team task, or the kudos you got
   on your own (KudosTally). Its own module, so the kudos button (and
   its emoji grid) loads with the task panel, never with Today.
   ============================================================ */
import { useMemo } from "react";
import type { Task } from "../../data/types";
import { KudosButton, KudosTally } from "./KudosButton";
import { useWorkspaceKudos } from "./useKudos";

export function TaskKudos({ task, currentUserId, recipientName, disabled, size = "md", people }: {
  task: Pick<Task, "id" | "title" | "status" | "assigneeId" | "workspaceId">;
  currentUserId: string;
  recipientName: string;
  disabled?: boolean;
  size?: "sm" | "md";
  people?: readonly { id?: string; userId?: string | null; name?: string; email?: string }[];
}) {
  const show = task.status === "done" && !!task.workspaceId && !!task.assigneeId;
  const taskIds = useMemo(() => [task.id], [task.id]);
  const { kudos, replaceFor } = useWorkspaceKudos(show ? task.workspaceId : null, { taskIds });
  if (!show) return null;
  if (task.assigneeId === currentUserId) return <KudosTally kudos={kudos} taskId={task.id} people={people} />;
  return <KudosButton task={task} currentUserId={currentUserId} recipientName={recipientName} kudos={kudos} size={size} disabled={disabled}
    people={people} onChange={(next) => replaceFor(task.id, next)} />;
}
