/* ============================================================
   KANBO — Today › "Your week's wins".                   [0048 stub → u10]
   Friday afternoons and Monday mornings (lib/momentum recapWindow): what
   you finished, grouped by project (ProjectChip identity), focus time,
   your streak, two or three collaboration moments; "Share to Slack"
   (SlackPostButton, kind "standup", the recap as text) when connected;
   "Hide" (onboarding.momentum.recapHidden). Warm, never boastful; a
   modest entrance (none with reduced motion).
   Renders nothing until package u10 builds it.
   ============================================================ */
import type { Kudos, Member, MomentumPrefs, Project, Task } from "../../data/types";

export interface WinsRecapProps {
  now?: Date;
  currentUserId: string;
  tasks: Task[];
  projects: Project[];
  members: Member[];
  kudos: Kudos[];
  /** local dates you planned your day */
  plannedDays: string[];
  prefs?: MomentumPrefs | null;
  /** for "Share to Slack" (null = Personal: no Slack) */
  workspaceId: string | null;
  onOpenTask?: (taskId: string) => void;
  /** "Hide" — the host saves onboarding.momentum.recapHidden */
  onHide?: () => void;
}

export function WinsRecap(_props: WinsRecapProps) {
  return null;
}
