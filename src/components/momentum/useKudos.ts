/* ============================================================
   KANBO — a workspace's kudos, live: read once (lib/momentum
   listKudos), read again when realtime says they changed (debounced),
   and patched at once after this person gives or takes one back. [u10]
   Personal (null) reads nothing. Before 0048: an empty list, quietly.
   ============================================================ */
import { useCallback, useEffect, useState } from "react";
import type { Kudos, KudosFailure } from "../../data/types";
import { kudosFailure, listKudos, replaceTaskKudos, subscribeKudos } from "../../lib/momentum";

export interface WorkspaceKudos {
  kudos: Kudos[];
  loading: boolean;
  failure: KudosFailure | null;
  /** after a give / take back: swap that task's kudos straight away (realtime catches up) */
  replaceFor: (taskId: string, next: Kudos[]) => void;
  reload: () => void;
}

const REALTIME_DEBOUNCE_MS = 250;
const EMPTY: Kudos[] = [];

export function useWorkspaceKudos(workspaceId: string | null | undefined, opts: { since?: string; taskIds?: readonly string[] } = {}): WorkspaceKudos {
  const ids = opts.taskIds ? [...opts.taskIds].sort().join(",") : null;
  const key = workspaceId ? `${workspaceId}|${opts.since ?? ""}|${ids ?? "*"}` : "";
  const [state, setState] = useState<{ key: string; kudos: Kudos[]; loading: boolean; failure: KudosFailure | null }>(
    () => ({ key, kudos: EMPTY, loading: !!key, failure: null }),
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!workspaceId) {
      setState((s) => (s.key === "" && !s.loading && !s.kudos.length ? s : { key: "", kudos: EMPTY, loading: false, failure: null }));
      return;
    }
    let alive = true;
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const taskIds = ids === null ? undefined : ids ? ids.split(",") : [];
    const load = () => {
      const id = ++seq;
      listKudos(workspaceId, { since: opts.since, taskIds }).then(
        (kudos) => { if (alive && id === seq) setState({ key, kudos, loading: false, failure: null }); },
        (e) => { if (alive && id === seq) setState((s) => ({ key, kudos: s.key === key ? s.kudos : EMPTY, loading: false, failure: kudosFailure(e) })); },
      );
    };
    setState((s) => (s.key === key ? s : { key, kudos: EMPTY, loading: true, failure: null }));
    load();
    const off = subscribeKudos(workspaceId, () => { clearTimeout(timer); timer = setTimeout(load, REALTIME_DEBOUNCE_MS); });
    return () => { alive = false; clearTimeout(timer); off(); };
    // (key carries the workspace, since and task ids)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const replaceFor = useCallback((taskId: string, next: Kudos[]) => {
    setState((s) => ({ ...s, kudos: replaceTaskKudos(s.kudos, taskId, next) }));
  }, []);
  const reload = useCallback(() => setAttempt((a) => a + 1), []);

  const current = state.key === key;
  return { kudos: current ? state.kudos : EMPTY, loading: current ? state.loading : !!key, failure: current ? state.failure : null, replaceFor, reload };
}
