/* ============================================================
   KANBO — Goals 2.0's writes from the app: post or take back a
   check-in, link work to a goal or unlink it. Each shows at once and
   is put back if the server says no (the database decides who may:
   0052). A check-in moves the goal's current value and confidence, as
   the server does; taking back the newest puts the one before back.
   ============================================================ */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Goal, GoalCheckin, GoalExtras, GoalLink, GoalLinkKind } from "../../data/types";

export interface GoalWriteStore {
  addGoalCheckin(input: { goalId: string; workspaceId: string | null; value: number; confidence?: number | null; note?: string }, userId: string): Promise<GoalCheckin>;
  deleteGoalCheckin(id: string): Promise<void>;
  addGoalLink(input: { goalId: string; workspaceId: string | null; kind: GoalLinkKind; targetId: string }): Promise<GoalLink>;
  removeGoalLink(id: string): Promise<void>;
}

export interface GoalWriteDeps {
  store: GoalWriteStore;
  setGoals: Dispatch<SetStateAction<Goal[]>>;
  setExtras: Dispatch<SetStateAction<GoalExtras | null>>;
  userIdRef: MutableRefObject<string>;
  /** true (and says so) when the person is a guest in that workspace */
  denyGuest: (wsIds: (string | null | undefined)[]) => boolean;
  /** an error handler that reports and tells the person, once in a while */
  saveFailed: (op: string, msg?: string) => (e: unknown) => void;
}

const tmpId = (kind: string) => `tmp-${kind}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
const newestFirst = (a: GoalCheckin, b: GoalCheckin) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

export function useGoalWrites({ store, setGoals, setExtras, userIdRef, denyGuest, saveFailed }: GoalWriteDeps) {
  const setGoal = useCallback((id: string, patch: Partial<Goal>) => setGoals((gs) => gs.map((g) => (g.id === id ? { ...g, ...patch } : g))), [setGoals]);
  const editExtras = useCallback((fn: (x: GoalExtras) => GoalExtras) => setExtras((x) => (x ? fn(x) : x)), [setExtras]);

  const checkin = useCallback((goal: Goal, value: number, confidence: number | null, note: string) => {
    if (denyGuest([goal.workspaceId]) || goal.id.startsWith("tmp-")) return;
    const before = { current: goal.current, confidence: goal.confidence };
    const tmp: GoalCheckin = { id: tmpId("checkin"), goalId: goal.id, workspaceId: goal.workspaceId ?? null, authorId: userIdRef.current, value, confidence, ...(note ? { note } : {}), createdAt: new Date().toISOString() };
    editExtras((x) => ({ ...x, checkins: [tmp, ...x.checkins] }));
    setGoal(goal.id, { current: value, ...(confidence ? { confidence } : {}) });
    store.addGoalCheckin({ goalId: goal.id, workspaceId: goal.workspaceId ?? null, value, confidence, note }, userIdRef.current)
      .then((saved) => editExtras((x) => ({ ...x, checkins: x.checkins.map((c) => (c.id === tmp.id ? saved : c)) })))
      .catch((e) => {
        editExtras((x) => ({ ...x, checkins: x.checkins.filter((c) => c.id !== tmp.id) }));
        setGoal(goal.id, before);
        saveFailed("goalCheckin", "Couldn't post the check-in. Only the goal's owner, the people helping, and owners and admins can check in.")(e);
      });
  }, [denyGuest, editExtras, saveFailed, setGoal, store, userIdRef]);

  const removeCheckin = useCallback((id: string, goal: Goal, checkins: GoalCheckin[]) => {
    if (denyGuest([goal.workspaceId]) || id.startsWith("tmp-")) return;
    const mine = checkins.filter((c) => c.goalId === goal.id).sort(newestFirst);
    const gone = mine.find((c) => c.id === id);
    if (!gone) return;
    const before = { current: goal.current, confidence: goal.confidence };
    editExtras((x) => ({ ...x, checkins: x.checkins.filter((c) => c.id !== id) }));
    // the newest taken back: the one before it is the value again
    const next = mine[0]?.id === id ? mine[1] : undefined;
    if (next) setGoal(goal.id, { current: next.value, ...(next.confidence ? { confidence: next.confidence } : {}) });
    store.deleteGoalCheckin(id).catch((e) => {
      editExtras((x) => ({ ...x, checkins: [...x.checkins, gone].sort(newestFirst) }));
      setGoal(goal.id, before);
      saveFailed("goalCheckinDelete", "Couldn't take back the check-in.")(e);
    });
  }, [denyGuest, editExtras, saveFailed, setGoal, store]);

  const link = useCallback((goal: Goal, kind: GoalLinkKind, targetId: string) => {
    if (denyGuest([goal.workspaceId]) || goal.id.startsWith("tmp-")) return;
    const tmp: GoalLink = { id: tmpId("link"), goalId: goal.id, workspaceId: goal.workspaceId ?? null, kind, targetId, createdAt: new Date().toISOString() };
    editExtras((x) => ({ ...x, links: [...x.links, tmp] }));
    store.addGoalLink({ goalId: goal.id, workspaceId: goal.workspaceId ?? null, kind, targetId })
      .then((saved) => editExtras((x) => ({ ...x, links: x.links.map((l) => (l.id === tmp.id ? saved : l)) })))
      .catch((e) => {
        editExtras((x) => ({ ...x, links: x.links.filter((l) => l.id !== tmp.id) }));
        saveFailed("goalLink", "Couldn't link that. A goal links work in its own workspace, by the people who can edit it.")(e);
      });
  }, [denyGuest, editExtras, saveFailed, store]);

  const unlink = useCallback((l: GoalLink) => {
    if (denyGuest([l.workspaceId]) || l.id.startsWith("tmp-")) return;
    editExtras((x) => ({ ...x, links: x.links.filter((y) => y.id !== l.id) }));
    store.removeGoalLink(l.id).catch((e) => {
      editExtras((x) => ({ ...x, links: [...x.links, l] }));
      saveFailed("goalUnlink", "Couldn't unlink that.")(e);
    });
  }, [denyGuest, editExtras, saveFailed, store]);

  return { checkin, removeCheckin, link, unlink };
}
