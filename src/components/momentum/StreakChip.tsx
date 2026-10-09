/* ============================================================
   KANBO — the streak chip by Today's header.            [0048 stub → u10]
   "4-day streak" with a small flame-free mark; its tooltip / popover
   explains it kindly (working days you planned or finished something;
   days off and bank holidays don't count against you) with "Mark a day
   off" and "Hide the streak". Nothing at 0 days or when hidden.
   Renders nothing until package u10 builds it.
   ============================================================ */
import type { MomentumPrefs, StreakInfo } from "../../data/types";

export interface StreakChipProps {
  streak: StreakInfo;
  prefs?: MomentumPrefs | null;
  /** saves onboarding.momentum (hide, days off) */
  onChangePrefs?: (next: MomentumPrefs) => void;
}

export function StreakChip(_props: StreakChipProps) {
  return null;
}
