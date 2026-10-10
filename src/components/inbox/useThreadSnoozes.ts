/* ============================================================
   KANBO — the Inbox's thread snoozes (0048 notification_snoozes).   [u4]
   Reads every row you have (running ones, and ended ones until the Inbox
   has shown their thread "Back from snooze"), follows other devices through
   realtime, and writes optimistically (put back, with the reason, when the
   server says no).
     • mode "server": notification_snoozes (or the demo's, in memory)
     • mode "local": the server doesn't have them yet (0048 not run) — the
       Inbox keeps snoozing on this device, as it did before
   Controlled: when the integrator passes `snoozes` (+ onSnooze /
   onUnsnooze), those are used and nothing is loaded here.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationSnooze } from "../../data/types";
import {
  demoSnoozesNow, listSnoozes, snoozeFailure, snoozeThread, subscribeSnoozes, unsnoozeThread, type SnoozeFailure,
} from "../../lib/notifyPrefs";

export type SnoozeWrite = { ok: true } | { ok: false; failure: SnoozeFailure };

export interface ThreadSnoozes {
  snoozes: NotificationSnooze[];
  mode: "server" | "local";
  /** the first read has answered */
  ready: boolean;
  /** snooze (or move) a thread; a time now or earlier ends it and brings the thread back */
  snooze(taskId: string, until: Date): Promise<SnoozeWrite>;
  /** forget a thread's snooze (it's been dealt with) */
  settle(taskId: string): Promise<SnoozeWrite>;
}

export interface ThreadSnoozeControl {
  snoozes: NotificationSnooze[];
  onSnooze?: (taskId: string, until: Date) => Promise<unknown> | void;
  onUnsnooze?: (taskId: string) => Promise<unknown> | void;
}

// the last answer this session: reopening the Inbox doesn't flash snoozed threads
let cache: { userId: string; rows: NotificationSnooze[]; mode: "server" | "local" } | null = null;
/** Tests and sign-out. */
export function forgetSnoozeCache(): void { cache = null; }

const same = (a: NotificationSnooze[], b: NotificationSnooze[]) =>
  a.length === b.length && a.every((x, i) => x.taskId === b[i].taskId && Date.parse(x.until) === Date.parse(b[i].until));
const upsert = (rows: NotificationSnooze[], row: NotificationSnooze) => [...rows.filter((r) => r.taskId !== row.taskId), row];

export function useThreadSnoozes(userId: string | undefined, control?: ThreadSnoozeControl): ThreadSnoozes {
  const uid = userId ?? "";
  const cached = cache && cache.userId === uid ? cache : null;
  // the demo answers at once; a real backend from this session's copy until it answers again
  const [rows, setRows] = useState<NotificationSnooze[]>(() => (control ? [] : demoSnoozesNow() ?? cached?.rows ?? []));
  const [mode, setMode] = useState<"server" | "local">(() => cached?.mode ?? "server");
  const [ready, setReady] = useState(() => !!cached || demoSnoozesNow() !== null);
  const alive = useRef(true);
  const controlled = !!control;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    alive.current = true;
    if (controlled) return () => { alive.current = false; };
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      listSnoozes({ all: true }).then((xs) => {
        if (!alive.current || mine !== seq) return;
        cache = { userId: uid, rows: xs, mode: "server" };
        // nothing changed (the usual answer): no re-render
        setRows((cur) => (same(cur, xs) ? cur : xs)); setMode("server"); setReady(true);
      }, (e) => {
        if (!alive.current || mine !== seq) return;
        if (snoozeFailure(e) === "unavailable") { setMode("local"); cache = { userId: uid, rows: [], mode: "local" }; }
        setReady(true);
      });
    };
    load();
    const off = subscribeSnoozes(uid, load);
    return () => { alive.current = false; off(); };
  }, [uid, controlled]);

  // keep the session's copy current (optimistic writes included)
  useEffect(() => { if (!controlled && ready) cache = { userId: uid, rows, mode }; }, [controlled, ready, uid, rows, mode]);

  // per thread, only the latest write's answer counts (a slow reply never undoes a newer choice)
  const writes = useRef(new Map<string, number>());
  const nextWrite = (taskId: string) => { const n = (writes.current.get(taskId) ?? 0) + 1; writes.current.set(taskId, n); return n; };
  const latest = (taskId: string, n: number) => alive.current && writes.current.get(taskId) === n;

  const snooze = useCallback(async (taskId: string, until: Date): Promise<SnoozeWrite> => {
    if (control) {
      try { await control.onSnooze?.(taskId, until); return { ok: true }; } catch (e) { return { ok: false, failure: snoozeFailure(e) }; }
    }
    const n = nextWrite(taskId);
    const before = rowsRef.current.find((r) => r.taskId === taskId);
    const mine: NotificationSnooze = { taskId, until: until.toISOString(), createdAt: before?.createdAt ?? new Date().toISOString() };
    rowsRef.current = upsert(rowsRef.current, mine);
    setRows((xs) => upsert(xs, mine));
    try {
      const saved = await snoozeThread(taskId, until);
      if (latest(taskId, n)) setRows((xs) => upsert(xs, saved));
      return { ok: true };
    } catch (e) {
      if (latest(taskId, n)) setRows((xs) => (before ? upsert(xs, before) : xs.filter((r) => r.taskId !== taskId)));
      return { ok: false, failure: snoozeFailure(e) };
    }
  }, [control]);

  const settle = useCallback(async (taskId: string): Promise<SnoozeWrite> => {
    if (control) {
      try { await control.onUnsnooze?.(taskId); return { ok: true }; } catch (e) { return { ok: false, failure: snoozeFailure(e) }; }
    }
    const before = rowsRef.current.find((r) => r.taskId === taskId);
    if (!before) return { ok: true };
    const n = nextWrite(taskId);
    rowsRef.current = rowsRef.current.filter((r) => r.taskId !== taskId);
    setRows((xs) => xs.filter((r) => r.taskId !== taskId));
    try {
      await unsnoozeThread(taskId);
      return { ok: true };
    } catch (e) {
      if (latest(taskId, n)) setRows((xs) => upsert(xs, before));
      return { ok: false, failure: snoozeFailure(e) };
    }
  }, [control]);

  if (control) return { snoozes: control.snoozes, mode: "server", ready: true, snooze, settle };
  return { snoozes: rows, mode, ready, snooze, settle };
}
