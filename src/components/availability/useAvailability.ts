/* ============================================================
   KANBO — the shared weeks, time off and rates on screen (0055).
   useAvailability: the store (lib/availability), re-rendering when
   it changes. useAvailabilitySync (App, once): tells the store who's
   signed in, which business is on screen and who's in each, loads
   it (and again when a teammate changes something, or the tab comes
   back), hands this device's saved capacities over once, and sets
   Today's working day from your week.
   ============================================================ */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { Role, WorkspaceMember } from "../../data/types";
import { getAvailability, myWorkingDay, subscribeAvailability, updateAvailability, type AvailabilityState } from "../../lib/availability";
import { refreshAvailability, subscribeAvailabilityChanges, uploadLocalCapacities } from "../../lib/availabilitySync";
import { setWorkingDay } from "../../lib/brief";

/** The shared availability, live. */
export function useAvailability(): AvailabilityState {
  return useSyncExternalStore(subscribeAvailability, getAvailability, getAvailability);
}

/** Each team workspace's active people and their roles (pending invites aside). */
export function rolesFrom(members: readonly WorkspaceMember[]): Record<string, Record<string, Role>> {
  const out: Record<string, Record<string, Role>> = {};
  for (const m of members) {
    if (m.status !== "active" || !m.userId || !m.workspaceId) continue;
    (out[m.workspaceId] ??= {})[m.userId] = m.role;
  }
  return out;
}

const RELOAD_MS = 400;

export function useAvailabilitySync({ me, workspace, members, today, enabled, onShared }: {
  me: string;
  /** the workspace on screen (null: Personal) */
  workspace: string | null;
  members: readonly WorkspaceMember[];
  /** YYYY-MM-DD (a new day reloads) */
  today: string;
  /** off until the account (and its workspaces) are loaded */
  enabled: boolean;
  /** told how many capacities from this device were shared, when there were some */
  onShared?: (n: number) => void;
}): void {
  const roles = useMemo(() => rolesFrom(members), [members]);
  // (what RLS lets you read follows your roles: a change of role reloads)
  const rolesKey = useMemo(() => JSON.stringify(roles), [roles]);
  // who, where and who's in each, before anything reads them
  useEffect(() => { updateAvailability({ me, activeWs: workspace, roles }); }, [me, workspace, roles]);

  const shared = useRef(onShared);
  shared.current = onShared;
  const todayRef = useRef(today);
  todayRef.current = today;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const status = await refreshAvailability(todayRef.current);
      if (!alive || status !== "on") return;
      const n = await uploadLocalCapacities();
      if (alive && n > 0) shared.current?.(n);
    };
    void load();
    const later = () => { clearTimeout(timer); timer = setTimeout(() => { if (alive) void refreshAvailability(todayRef.current); }, RELOAD_MS); };
    const stop = subscribeAvailabilityChanges(later);
    const onVisible = () => { if (document.visibilityState === "visible") later(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; clearTimeout(timer); stop(); document.removeEventListener("visibilitychange", onVisible); };
    // (a new account, a new day or a change of who's in which workspace reloads; roles are in the store)
  }, [enabled, me, today, rolesKey]);

  // Today's working day follows your week at the business on screen
  const s = useAvailability();
  const day = myWorkingDay(s);
  useEffect(() => { setWorkingDay(day.start, day.end); }, [day.start, day.end]);
}
