/* ============================================================
   KANBO — a business pack's steps inside a sheet: the gallery, the
   preview (what you've ticked, its dates, the goals' quarter), then
   the summary (with Undo). The host renders the step it's on (see
   NewWorkspaceModal, NewProjectModal); this keeps the choices and the
   work in flight.
   ============================================================ */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceTemplate } from "../../data/types";
import { buildPackPlan, defaultPick, packCounts, packHasParts, type PackPick } from "../../lib/packPlan";
import type { PackOutcome, PackUiContext, PackUndone } from "./packTypes";

export function usePackFlow({ context, apply, undo }: {
  context: PackUiContext | null;
  apply: (pack: WorkspaceTemplate, pick: PackPick) => Promise<PackOutcome | null | void>;
  undo?: (outcome: PackOutcome) => Promise<PackUndone>;
}) {
  const [pack, setPack] = useState<WorkspaceTemplate | null>(null);
  const [pick, setPick] = useState<PackPick | null>(null);
  const [outcome, setOutcome] = useState<PackOutcome | null>(null);
  const [busy, setBusy] = useState<"apply" | "undo" | null>(null);
  const [undone, setUndone] = useState<PackUndone | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const plan = useMemo(() => (pack && pick && context ? buildPackPlan(pack, pick, context) : null), [pack, pick, context]);
  const counts = useMemo(() => (plan ? packCounts(plan) : null), [plan]);
  const ready = !!counts && packHasParts(counts);

  const start = useCallback((p: WorkspaceTemplate) => {
    if (!context) return;
    setPack(p); setPick(defaultPick(p, context)); setOutcome(null); setUndone(null);
  }, [context]);
  const back = useCallback(() => { if (busy) return; setPack(null); setPick(null); }, [busy]);
  const reset = useCallback(() => { setPack(null); setPick(null); setOutcome(null); setUndone(null); setBusy(null); }, []);
  const edit = useCallback((fn: (p: PackPick) => PackPick) => setPick((p) => (p ? fn(p) : p)), []);
  /** tick or untick one part */
  const toggle = useCallback((part: string, on: boolean) => edit((p) => ({ ...p, off: on ? p.off.filter((x) => x !== part) : [...new Set([...p.off, part])] })), [edit]);

  const submit = useCallback(async () => {
    if (!pack || !pick || busy || !ready) return;
    setBusy("apply");
    try {
      const o = await apply(pack, pick);
      if (alive.current && o) setOutcome(o);
    } finally { if (alive.current) setBusy(null); }
  }, [pack, pick, busy, ready, apply]);

  const takeBack = useCallback(async () => {
    if (!outcome || !undo || busy || undone) return;
    setBusy("undo");
    try {
      const r = await undo(outcome);
      if (alive.current) setUndone(r);
    } finally { if (alive.current) setBusy(null); }
  }, [outcome, undo, busy, undone]);

  return { pack, pick, plan, counts, ready, outcome, busy, undone, start, back, reset, edit, toggle, submit, takeBack };
}

export type PackFlow = ReturnType<typeof usePackFlow>;

/** A step's root (give it tabIndex -1): when it mounts, the sheet it's in scrolls back to the top
 *  (the sheet's body is the same element from step to step, so it would otherwise open where the
 *  last step was left), and focus moves to it (the button that led here is gone). */
export function useTopOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    for (let el = ref.current?.parentElement; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") { el.scrollTop = 0; break; }
    }
    ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}
