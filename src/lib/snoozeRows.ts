/* ============================================================
   KANBO — notification_snoozes rows → NotificationSnooze; limits.
   lib/rows0048 re-exports these.                   [architect: final]
   ============================================================ */
import type { NotificationSnooze } from "../data/types";
import { isObj, str, strOr } from "./rowUtils";

export const SNOOZE_MAX_DAYS = 366;
export const SNOOZES_PER_PERSON = 1000;

export function parseSnooze(raw: unknown): NotificationSnooze | null {
  if (!isObj(raw)) return null;
  const taskId = str(raw.task_id ?? raw.taskId), until = str(raw.until);
  if (!taskId || !until) return null;
  return { taskId, until, createdAt: strOr(raw.created_at ?? raw.createdAt, "") };
}
