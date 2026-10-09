/* ============================================================
   KANBO — momentum: wins, a gentle streak, kudos (0048).  [0048 contract → u10]
   • Wins recap: Friday afternoons (from 14:00) on Today, and Monday
     mornings (until 12:00) looking back at last week — what you finished,
     by project (with its identity), focus time, your streak, and the best
     collaboration moments (kudos given and received, people you unblocked,
     approvals you turned round). Shareable as text to Slack through the
     existing SlackPostButton when connected. Hideable (onboarding.momentum).
   • Streak: consecutive working days (Mon–Fri; England & Wales bank
     holidays and your own days off don't count against you) on which you
     planned your day or finished something. A small chip by Today's
     header; no guilt copy, no badges; hideable in Settings
     (profiles.onboarding.momentum.streakHidden; days off in .daysOff).
   • Kudos: one tap (🎉 or another of KUDOS_EMOJI, optional note ≤ 140) on
     a teammate's finished task, from Pulse's "Done since yesterday" and the
     task panel. One per giver per task (tap again to take it back). Guests
     may give kudos too (a reaction, not content — the database allows it);
     suspended people can't. The recipient gets an Inbox item (kind
     "kudos", pref "kudos"); Pulse shows counts. Team tasks only; never to
     yourself. Kudos don't come back with a task restored from the bin.
   Everything date-based is pure and takes `now` (pin it in tests); the
   person's timezone defaults to Europe/London.
   Demo mode: fake kudos and a believable streak from the demo world.
   ============================================================ */
import type { Kudos, KudosEmoji, MomentumPrefs, Project, StreakInfo, Task, WinsRecap } from "../data/types";

export { parseKudos, kudosFailure, KUDOS_EMOJI, KUDOS_NOTE_MAX, KUDOS_PER_DAY } from "./kudosRows";

export const KUDOS_COLUMNS = "id,task_id,workspace_id,from_user,to_user,emoji,note,created_at";

/** England & Wales bank holidays (YYYY-MM-DD), 2026–2027 (u10 fills it in). */
export const UK_BANK_HOLIDAYS: readonly string[] = [];

/** Is this local date a working day for streaks? */
export function isWorkingDay(_date: string, _prefs?: MomentumPrefs | null): boolean { return true; }

export interface StreakInput {
  now: Date;
  timezone?: string;
  /** local dates (YYYY-MM-DD) on which you planned your day (Plan my day / a planned task) */
  plannedDays: readonly string[];
  /** your finished tasks (completedAt) */
  completed: readonly Pick<Task, "completedAt">[];
  prefs?: MomentumPrefs | null;
}
export function computeStreak(_input: StreakInput): StreakInfo { return { days: 0, today: "pending", since: null }; }

/** Which recap (if any) Today shows now: Friday from 14:00 → this week; Monday until 12:00 → last week. */
export function recapWindow(_now: Date, _timezone?: string): { kind: WinsRecap["kind"]; from: string; to: string } | null { return null; }

export interface WinsInput {
  now: Date;
  timezone?: string;
  currentUserId: string;
  tasks: readonly Task[];
  projects: readonly Pick<Project, "id" | "name" | "emoji" | "color">[];
  kudos: readonly Kudos[];
  plannedDays: readonly string[];
  prefs?: MomentumPrefs | null;
  /** people's names for the moments' text */
  nameOf: (userId: string) => string;
}
export function buildWinsRecap(_input: WinsInput): WinsRecap | null { return null; }

/** The recap as plain text for Slack ("This week: 12 done across Launch and Brand…"). */
export function winsRecapText(_recap: WinsRecap): string { return ""; }

/** Kudos per person since a moment (Pulse's counts): received and given. */
export function kudosCounts(kudos: readonly Kudos[], sinceIso: string): Record<string, { received: number; given: number }> {
  const out: Record<string, { received: number; given: number }> = {};
  const since = Date.parse(sinceIso);
  for (const k of kudos) {
    if (Number.isFinite(since) && Date.parse(k.createdAt) < since) continue;
    (out[k.toUser] ??= { received: 0, given: 0 }).received++;
    (out[k.fromUser] ??= { received: 0, given: 0 }).given++;
  }
  return out;
}

const notBuilt = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package u10)`));

/** Kudos in a workspace (optionally since a moment, or for some tasks). Demo: fakes. */
export function listKudos(_workspaceId: string, _opts?: { since?: string; taskIds?: string[] }): Promise<Kudos[]> { return notBuilt("listKudos"); }
/** rpc give_kudos (idempotent: a second call answers the first). */
export function giveKudos(_taskId: string, _emoji?: KudosEmoji, _note?: string | null, _to?: string | null): Promise<Kudos> { return notBuilt("giveKudos"); }
/** rpc take_back_kudos: true when there was one. */
export function takeBackKudos(_taskId: string): Promise<boolean> { return notBuilt("takeBackKudos"); }
/** Realtime: kudos in this workspace changed. Returns unsubscribe. */
export function subscribeKudos(_workspaceId: string, _onChange: () => void): () => void { return () => undefined; }
