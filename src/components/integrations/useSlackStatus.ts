/* ============================================================
   KANBO — useSlackStatus: a workspace's Slack connection, live.  [f6-slack]
   Reads lib/slack (cached per workspace), follows every change made here
   (connect, disconnect, auto-post) through onSlackStatusChange, and checks
   again when the browser comes back online.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SlackStatus } from "../../data/types";
import { loadSlackStatus, onSlackStatusChange, peekSlackStatus, type SlackProblem } from "../../lib/slack";

export interface SlackStatusState {
  status: SlackStatus | null;
  problem?: SlackProblem;
  /** the first read hasn't answered yet */
  loading: boolean;
  /** read again, skipping the cache */
  reload: () => void;
}

export function useSlackStatus(workspaceId: string | null): SlackStatusState {
  const peek = peekSlackStatus(workspaceId);
  const [state, setState] = useState<{ ws: string | null; status: SlackStatus | null; problem?: SlackProblem; loading: boolean }>(
    () => ({ ws: workspaceId, status: peek ?? null, loading: peek === undefined }),
  );
  const seq = useRef(0);

  const load = useCallback((fresh: boolean) => {
    const id = ++seq.current;
    void loadSlackStatus(workspaceId, { fresh }).then((r) => {
      if (id !== seq.current) return;
      setState((cur) => cur.ws === workspaceId && !cur.loading && cur.problem === r.problem && JSON.stringify(cur.status) === JSON.stringify(r.status)
        ? cur   // nothing new: no re-render
        : { ws: workspaceId, status: r.status, problem: r.problem, loading: false });
    });
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {   // Personal: no Slack, nothing to ask
      setState((cur) => (cur.ws === null && !cur.loading && cur.status === null ? cur : { ws: null, status: null, loading: false }));
      return;
    }
    const cached = peekSlackStatus(workspaceId);
    setState((cur) => (cur.ws === workspaceId ? cur : { ws: workspaceId, status: cached ?? null, loading: cached === undefined }));
    load(false);
    const off = onSlackStatusChange((ws, status) => {
      if (ws !== workspaceId) return;
      seq.current++;   // a change here beats a read still in flight
      setState({ ws, status, loading: false });
    });
    const online = () => load(true);
    window.addEventListener("online", online);
    return () => { off(); window.removeEventListener("online", online); seq.current++; };
  }, [workspaceId, load]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true, problem: undefined }));
    load(true);
  }, [load]);

  // a render between a workspace switch and its effect never shows the old workspace's status
  if (state.ws !== workspaceId) return { status: peek ?? null, loading: peek === undefined, reload };
  return { status: state.status, problem: state.problem, loading: state.loading, reload };
}
