/* ============================================================
   KANBO — kudos rows / give_kudos() → Kudos; the emoji; errors.
   lib/rows0048 re-exports these.                   [architect: final]
   ============================================================ */
import type { Kudos, KudosEmoji, KudosFailure } from "../data/types";
import { errText, isMissing, isNetwork, isObj, str, strOr } from "./rowUtils";

export const KUDOS_EMOJI: readonly KudosEmoji[] = ["🎉", "👏", "🙌", "💪", "⭐", "🚀", "❤️", "🔥", "💯", "🏆"];
export const KUDOS_NOTE_MAX = 140;
export const KUDOS_PER_DAY = 100;

/** A kudos row, or give_kudos()'s answer (the row + from_name / to_name) → Kudos, or null. */
export function parseKudos(raw: unknown): Kudos | null {
  if (!isObj(raw)) return null;
  const g = (snake: string, camel: string) => (raw[snake] !== undefined ? raw[snake] : raw[camel]);
  const id = str(raw.id), taskId = str(g("task_id", "taskId")), workspaceId = str(g("workspace_id", "workspaceId"));
  const fromUser = str(g("from_user", "fromUser")), toUser = str(g("to_user", "toUser"));
  if (!id || !taskId || !workspaceId || !fromUser || !toUser) return null;
  const emoji = (KUDOS_EMOJI as readonly string[]).includes(raw.emoji as string) ? (raw.emoji as KudosEmoji) : "🎉";
  const out: Kudos = { id, taskId, workspaceId, fromUser, toUser, emoji, note: str(raw.note), createdAt: strOr(g("created_at", "createdAt"), "") };
  const fromName = str(g("from_name", "fromName")), toName = str(g("to_name", "toName"));
  if (fromName) out.fromName = fromName;
  if (toName) out.toName = toName;
  return out;
}

export function kudosFailure(e: unknown): KudosFailure {
  const m = errText(e);
  if (isMissing(m)) return "unavailable";
  if (/not authorized|permission denied/i.test(m)) return "not_allowed";
  if (/task not found/i.test(m)) return "not_found";
  if (/task not done/i.test(m)) return "not_done";
  if (/need a team task/i.test(m)) return "team_only";
  if (/not for yourself/i.test(m)) return "self";
  if (/too many kudos/i.test(m)) return "too_many";
  if (/invalid (emoji|note|recipient)|kudos_shape/i.test(m)) return "invalid";
  if (isNetwork(m)) return "network";
  return "error";
}
