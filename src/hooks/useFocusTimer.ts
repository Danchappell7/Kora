import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAuth } from "../auth/AuthProvider";

export type FocusEvent = "goal" | "break" | "breakOver";

export interface FocusTimer {
  running: boolean;
  setRunning: React.Dispatch<React.SetStateAction<boolean>>;
  seconds: number;
  reset: () => void;
  targetMin: number;
  setTargetMin: (m: number) => void;
  taskId: string;
  setTaskId: (id: string) => void;
  weekMin: number;
  /** bank the current elapsed time into today's focus total, then reset. returns minutes banked. */
  endSession: () => number;
  /* pomodoro */
  pomodoro: boolean;
  setPomodoro: (v: boolean) => void;
  phase: "work" | "break";
  cyclesToday: number;
  focusMinToday: number;
  /** the last interval that finished on its own (cleared when the timer is started, reset or ended) */
  notice: { kind: FocusEvent; min: number; at: number } | null;
  /** browser notification permission — "unsupported" where the API doesn't exist */
  notifyPermission: NotificationPermission | "unsupported";
  /** ask for notification permission (call from a click handler) */
  requestNotify: () => void;
}

export const WORK_DEFAULT = 25;
export const BREAK_MIN = 5;
const FLOW_DEFAULT = 90;
const STALE_ALERT_MS = 15 * 60_000;

/** Storage keys, one set per signed-in person — on a shared computer the next
 *  person never inherits someone else's running block or banked total. */
export function focusKeys(scope?: string | null) {
  const s = scope || "local";
  return { session: `kanbo-focus-session:${s}`, stat: `kanbo-focus-stat:${s}` };
}
type FocusKeys = ReturnType<typeof focusKeys>;

export const todayKey = (d: Date = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
function loadStat(key: string): { date: string; cycles: number; min: number } {
  try { const v = JSON.parse(localStorage.getItem(key) || "{}"); if (v && v.date === todayKey()) return v; } catch { /* private mode */ }
  return { date: todayKey(), cycles: 0, min: 0 };
}

/* ---- the session: wall-clock based, so a hidden (throttled) tab or a reload
   never loses time. `seconds` is always derived from timestamps. ---- */
export interface FocusSession {
  v: 1;
  running: boolean;
  /** wall-clock ms when the current run started; null while paused */
  startedAt: number | null;
  /** ms already elapsed in this interval before `startedAt` (earlier runs, before a pause) */
  accMs: number;
  targetMin: number;
  phase: "work" | "break";
  pomodoro: boolean;
  taskId: string;
}

export const freshSession = (): FocusSession => ({ v: 1, running: false, startedAt: null, accMs: 0, targetMin: FLOW_DEFAULT, phase: "work", pomodoro: false, taskId: "" });

export function elapsedMs(s: FocusSession, now: number): number {
  const live = s.running && s.startedAt != null ? Math.max(0, now - s.startedAt) : 0;
  return Math.max(0, s.accMs + live);
}

export interface Advance {
  session: FocusSession;
  /** focus minutes completed by this transition (only ever from a work interval) */
  bankedMin: number;
  bankedCycles: number;
  /** wall-clock ms when the banked interval actually ended — decides which day it counts for */
  bankedAt: number | null;
  /** wall-clock ms of the last boundary crossed — an alert for one long past is just noise */
  lastAt: number | null;
  events: FocusEvent[];
}

/**
 * Moves a running session past any boundary its wall-clock time has crossed.
 *  - Flow mode (no Pomodoro): at the goal the block completes — its minutes are
 *    banked and the timer rests at zero, so a laptop left asleep can never bank
 *    more than the goal.
 *  - Pomodoro: when a focus interval ends it is banked and the break starts from
 *    the moment it ended (not when a throttled tab noticed). When the break ends
 *    the next focus interval waits for the user to press play.
 */
export function advanceSession(s: FocusSession, now: number): Advance {
  const out: Advance = { session: s, bankedMin: 0, bankedCycles: 0, bankedAt: null, lastAt: null, events: [] };
  if (!s.running) return out;
  let cur = s;
  for (let guard = 0; guard < 3; guard++) {
    const target = Math.max(1, cur.targetMin) * 60_000;
    if (elapsedMs(cur, now) < target) break;
    // never before the run began, even if time already spent was past the goal
    const endedAt = cur.running && cur.startedAt != null ? cur.startedAt + Math.max(0, target - cur.accMs) : now;
    // the goal, or the focus time really spent before this run if that was more
    const doneMin = Math.max(cur.targetMin, Math.round(cur.accMs / 60_000));
    out.lastAt = endedAt;
    if (!cur.pomodoro) {
      if (cur.phase === "work") { out.bankedMin += doneMin; out.bankedAt = endedAt; }
      cur = { ...cur, running: false, startedAt: null, accMs: 0, phase: "work" };
      out.events.push("goal");
      break;
    }
    if (cur.phase === "work") {
      out.bankedMin += doneMin; out.bankedCycles += 1; out.bankedAt = endedAt;
      cur = { ...cur, phase: "break", targetMin: BREAK_MIN, accMs: 0, startedAt: endedAt };
      out.events.push("break");
      continue;
    }
    cur = { ...cur, phase: "work", targetMin: WORK_DEFAULT, accMs: 0, startedAt: null, running: false };
    out.events.push("breakOver");
    break;
  }
  out.session = cur;
  return out;
}

/**
 * Picking a new length. If the time already spent in this interval has reached
 * it, the interval is over now: the focus time really spent is banked (never
 * just the shorter goal), and a Pomodoro moves on to its break.
 */
export function retarget(s: FocusSession, targetMin: number, now: number): Advance {
  const next: FocusSession = { ...s, targetMin };
  const out: Advance = { session: next, bankedMin: 0, bankedCycles: 0, bankedAt: null, lastAt: null, events: [] };
  const spent = elapsedMs(s, now);
  if (spent <= 0 || spent < Math.max(1, targetMin) * 60_000) return out;
  out.lastAt = now;
  if (s.phase === "work") {
    out.bankedMin = Math.round(spent / 60_000); out.bankedAt = now;
    if (s.pomodoro) {
      out.bankedCycles = 1;
      out.session = { ...next, phase: "break", targetMin: BREAK_MIN, accMs: 0, startedAt: s.running ? now : null };
      out.events.push("break");
    } else {
      out.session = { ...next, running: false, startedAt: null, accMs: 0 };
      out.events.push("goal");
    }
  } else {
    out.session = { ...next, phase: "work", targetMin: WORK_DEFAULT, running: false, startedAt: null, accMs: 0 };
    out.events.push("breakOver");
  }
  return out;
}

/** The stored session, or null when there isn't a readable one (none yet, corrupt, or storage blocked). */
function readStoredSession(key: string): FocusSession | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    if (v && v.v === 1 && typeof v.accMs === "number" && typeof v.targetMin === "number") return { ...freshSession(), ...v };
  } catch { /* private mode / corrupt */ }
  return null;
}
const loadSession = (key: string): FocusSession => readStoredSession(key) ?? freshSession();
/** returns whether the write landed — when storage is blocked the timer carries on in memory */
function saveSession(key: string, s: FocusSession): boolean {
  try { localStorage.setItem(key, JSON.stringify(s)); return true; } catch { return false; /* private mode / blocked */ }
}
const sameRun = (a: FocusSession, b: FocusSession) =>
  a.running === b.running && a.startedAt === b.startedAt && a.accMs === b.accMs && a.phase === b.phase && a.targetMin === b.targetMin;

/* ---- alerts: title badge, notification and a soft chime ---- */
const DONE_TITLE = "(Done) Kanbo";
let savedTitle: string | null = null;
function badgeTitle() {
  if (typeof document === "undefined") return;
  if (document.title !== DONE_TITLE) savedTitle = document.title;
  document.title = DONE_TITLE;
}
function restoreTitle() {
  if (typeof document === "undefined") return;
  if (document.title === DONE_TITLE && savedTitle != null) document.title = savedTitle;
  savedTitle = null;
}
const notifySupported = () => typeof window !== "undefined" && "Notification" in window;
function currentPermission(): NotificationPermission | "unsupported" {
  try { return notifySupported() ? Notification.permission : "unsupported"; } catch { return "unsupported"; }
}
function notify(title: string, body: string) {
  try {
    if (!notifySupported() || Notification.permission !== "granted") return;
    const n = new Notification(title, { body, tag: "kanbo-focus" });
    n.onclick = () => { try { window.focus(); n.close(); } catch { /* ignore */ } };
  } catch { /* e.g. Android Chrome needs a service worker for notifications */ }
}
let audioCtx: AudioContext | null = null;
// created on a user gesture (starting the timer) so the chime is allowed to play later
function primeAudio() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") void audioCtx.resume();
  } catch { /* no audio */ }
}
function chime() {
  try {
    const ctx = audioCtx;
    if (!ctx || ctx.state !== "running") return;
    const t0 = ctx.currentTime;
    [659.25, 987.77].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), at = t0 + i * 0.16;
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.07, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
      o.connect(g); g.connect(ctx.destination);
      o.start(at); o.stop(at + 1);
    });
  } catch { /* no audio */ }
}
function alertFor(kind: FocusEvent, min: number) {
  badgeTitle();
  // someone watching the tab has seen it — the badge only needs to outlast a glance
  if (typeof document !== "undefined" && document.visibilityState === "visible") window.setTimeout(restoreTitle, 8000);
  chime();
  if (kind === "goal") notify("Focus block complete", min > 0 ? `Nice work — ${min}m of deep work banked.` : "Nice work — that's a full focus block.");
  else if (kind === "break") notify("Time for a break", `${min > 0 ? `${min}m banked. ` : ""}Step away for ${BREAK_MIN} minutes — Kanbo will tell you when it's over.`);
  else notify("Break's over", "Press play when you're ready for the next focus block.");
}

// leaving a break (reset/end) goes back to a full focus interval — never a 5-minute "focus"
export const restState = (cur: FocusSession): FocusSession => ({
  ...cur, running: false, startedAt: null, accMs: 0,
  ...(cur.phase === "break" ? { phase: "work" as const, targetMin: WORK_DEFAULT } : {}),
});

// the timer works outside the auth provider too (tests, isolated renders)
function useAuthUserId(): string | undefined { try { return useAuth().user?.id; } catch { return undefined; } }

/* ---- deep-work timer hook (with optional Pomodoro cycles) ---- */
export function useFocusTimer(userId?: string): FocusTimer {
  const authUserId = useAuthUserId();
  const scope = userId ?? authUserId;
  const keys = useMemo(() => focusKeys(scope), [scope]);
  const keysRef = useRef<FocusKeys>(keys);
  const [session, setSessionState] = useState<FocusSession>(() => loadSession(keys.session));
  const sessionRef = useRef(session);
  const [now, setNow] = useState(() => Date.now());
  const [stat, setStat] = useState(() => loadStat(keys.stat));
  const statRef = useRef(stat); statRef.current = stat;
  const [notice, setNotice] = useState<FocusTimer["notice"]>(null);
  const [notifyPermission, setPerm] = useState(currentPermission);
  // whether our last write reached storage — if it didn't, what's stored can't be
  // another tab's newer state, so the cross-tab check must not adopt it
  const storedOkRef = useRef(true);
  const weekMin = 0;

  const commit = useCallback((next: FocusSession) => {
    sessionRef.current = next; setSessionState(next);
    storedOkRef.current = saveSession(keysRef.current.session, next);
  }, []);

  // someone else signed in on this device: load their session and total, not the last person's
  useEffect(() => {
    if (keysRef.current.session === keys.session) return;
    keysRef.current = keys;
    const s = loadSession(keys.session); sessionRef.current = s; setSessionState(s);
    const st = loadStat(keys.stat); statRef.current = st; setStat(st);
    storedOkRef.current = true;
    setNotice(null); restoreTitle(); setNow(Date.now());
  }, [keys]);

  const persistStat = (s: { date: string; cycles: number; min: number }) => {
    statRef.current = s; setStat(s);
    try { localStorage.setItem(keysRef.current.stat, JSON.stringify(s)); } catch { /* private mode */ }
  };
  // re-read the stored total first, so banking in one tab never overwrites another
  // tab's (in memory when storage is blocked, so a failed read can't zero the total)
  const bank = useCallback((min: number, cycles: number) => {
    const stored = loadStat(keysRef.current.stat);
    const mem = statRef.current.date === todayKey() ? statRef.current : stored;
    const base = stored.cycles + stored.min >= mem.cycles + mem.min ? stored : mem;
    persistStat({ date: todayKey(), cycles: base.cycles + cycles, min: base.min + min });
  }, []);

  // Advance the session to "now": catches up on anything that finished while
  // the tab was hidden, asleep or throttled.
  const process = useCallback(() => {
    const t = Date.now();
    if (statRef.current.date !== todayKey()) { const s = loadStat(keysRef.current.stat); statRef.current = s; setStat(s); }
    const cur = sessionRef.current;
    if (!cur.running) return;
    setNow(t);
    const adv = advanceSession(cur, t);
    if (!adv.events.length) return;
    // another tab sharing this session may already have applied this boundary
    // (only when storage is working — an unreadable or unwritable store is not another tab)
    const stored = storedOkRef.current ? readStoredSession(keysRef.current.session) : null;
    if (stored && !sameRun(stored, cur)) { sessionRef.current = stored; setSessionState(stored); return; }
    commit(adv.session);
    // the date check: minutes count for the day the interval ended (a block that
    // finished before midnight doesn't land on today's total)
    const counts = adv.bankedMin > 0 && adv.bankedAt != null && todayKey(new Date(adv.bankedAt)) === todayKey(new Date(t));
    if (counts) bank(adv.bankedMin, adv.bankedCycles);
    // a boundary that passed long ago (the laptop was asleep, the tab was closed)
    // resets quietly — no stale "complete" alert hours later
    if (adv.lastAt == null || t - adv.lastAt > STALE_ALERT_MS) { setNotice(null); return; }
    const kind = adv.events[adv.events.length - 1];
    const min = counts ? adv.bankedMin : 0;
    setNotice({ kind, min, at: t });
    alertFor(kind, min);
  }, [bank, commit]);

  // tick while running; also wake exactly at the boundary (a throttled background
  // tab still gets this one timer, and visibilitychange catches up the rest)
  useEffect(() => {
    if (!session.running) return;
    process();
    const id = window.setInterval(process, 1000);
    const remaining = session.targetMin * 60_000 - elapsedMs(session, Date.now());
    const to = remaining > 0 ? window.setTimeout(process, remaining + 30) : 0;
    return () => { window.clearInterval(id); window.clearTimeout(to); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.running, session.startedAt, session.accMs, session.targetMin, session.phase, process]);

  useEffect(() => {
    const onVisible = () => {
      process();
      if (document.visibilityState === "visible") window.setTimeout(restoreTitle, 4000);
    };
    // keep tabs in step: one shared session, one shared total
    const onStorage = (e: StorageEvent) => {
      if (e.key === keysRef.current.session) {
        const s = readStoredSession(keysRef.current.session);
        if (s) { sessionRef.current = s; setSessionState(s); setNow(Date.now()); }
      } else if (e.key === keysRef.current.stat) { const s = loadStat(keysRef.current.stat); statRef.current = s; setStat(s); }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("storage", onStorage);
    };
  }, [process]);

  const setRunning = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((v) => {
    const cur = sessionRef.current;
    const next = typeof v === "function" ? v(cur.running) : v;
    if (next === cur.running) return;
    const t = Date.now();
    if (next) {
      primeAudio(); restoreTitle(); setNotice(null);
      commit({ ...cur, running: true, startedAt: t });
    } else {
      commit({ ...cur, running: false, startedAt: null, accMs: elapsedMs(cur, t) });
    }
    setNow(t);
  }, [commit]);

  const reset = useCallback(() => {
    commit(restState(sessionRef.current));
    setNotice(null); restoreTitle(); setNow(Date.now());
  }, [commit]);

  // Stop & bank: add the elapsed focus minutes to today's total, then reset.
  // (Completed Pomodoro work phases are already banked, and break time is never
  // deep work, so there's no double-counting.)
  const endSession = useCallback((): number => {
    const cur = sessionRef.current;
    const mins = cur.phase === "work" ? Math.round(elapsedMs(cur, Date.now()) / 60_000) : 0;
    if (mins > 0) bank(mins, 0);
    commit(restState(cur));
    setNotice(null); restoreTitle(); setNow(Date.now());
    return mins;
  }, [bank, commit]);

  const setPomodoro = useCallback((v: boolean) => {
    const cur = sessionRef.current, t = Date.now();
    // switching modes starts a fresh interval — keep the focus time already spent
    const mins = cur.phase === "work" ? Math.round(elapsedMs(cur, t) / 60_000) : 0;
    if (mins > 0) bank(mins, 0);
    commit({ ...cur, pomodoro: v, phase: "work", targetMin: v ? WORK_DEFAULT : FLOW_DEFAULT, accMs: 0, startedAt: cur.running ? t : null });
    setNotice(null); setNow(t);
  }, [bank, commit]);

  // a length shorter than the time already spent finishes the interval now and
  // banks the real time (it never throws focus minutes away)
  const setTargetMin = useCallback((m: number) => {
    const t = Date.now();
    const adv = retarget(sessionRef.current, m, t);
    commit(adv.session);
    setNow(t);
    if (!adv.events.length) return;
    if (adv.bankedMin > 0) bank(adv.bankedMin, adv.bankedCycles);
    restoreTitle();
    setNotice({ kind: adv.events[0], min: adv.bankedMin, at: t });
  }, [bank, commit]);

  const setTaskId = useCallback((id: string) => { commit({ ...sessionRef.current, taskId: id }); }, [commit]);

  const requestNotify = useCallback(() => {
    try {
      if (!notifySupported() || Notification.permission !== "default") return;
      const p = Notification.requestPermission((r) => setPerm(r)); // callback form for older Safari
      if (p && typeof p.then === "function") void p.then((r) => setPerm(r));
    } catch { /* unsupported */ }
  }, []);

  const seconds = Math.floor(elapsedMs(session, session.running ? now : 0) / 1000);
  return {
    running: session.running, setRunning, seconds, reset, targetMin: session.targetMin, setTargetMin,
    taskId: session.taskId, setTaskId, weekMin, endSession,
    pomodoro: session.pomodoro, setPomodoro, phase: session.phase, cyclesToday: stat.cycles, focusMinToday: stat.min,
    notice, notifyPermission, requestNotify,
  };
}
