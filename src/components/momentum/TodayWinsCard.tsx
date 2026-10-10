/* ============================================================
   KANBO — Today's wins card, with the kudos it reads (0048 · u10).
   TodayWins (./TodayMomentum) mounts this only when there's a week to
   show (Friday afternoons, Monday mornings, the demo), so the card,
   the kudos and their code never come down with the rest of Today.
   ============================================================ */
import { useMemo } from "react";
import { addDaysISO } from "../../lib/momentum";
import { WinsRecap, type WinsRecapProps } from "./WinsRecap";
import { useWorkspaceKudos } from "./useKudos";

export function TodayWinsCard({ from, workspaceId, ...rest }: Omit<WinsRecapProps, "kudos"> & {
  /** the window's first day (the kudos are read from the day before, to be safe across timezones) */
  from: string;
}) {
  const since = useMemo(() => new Date(`${addDaysISO(from, -1)}T00:00:00Z`).toISOString(), [from]);
  const { kudos } = useWorkspaceKudos(workspaceId, { since });
  return <WinsRecap {...rest} workspaceId={workspaceId} kudos={kudos} />;
}
