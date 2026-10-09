/* ============================================================
   KANBO — the guided tour's coach marks.               [0048 → u1]
   Mount once at the app root (the integrator does, lazily: it's only
   needed while a tour runs). Starts by itself for a new person (lib/
   onboarding shouldAutoStartTour), or when startTour() is called (Help
   menu). One step at a time: a spotlight ring on the anchor element and a
   card beside it (Next / Back / Skip tour, "2 of 6"); Escape skips; focus
   moves into the card and returns afterwards; the card is a labelled
   dialog with a live step count. Resumes at the saved step. With
   prefers-reduced-motion nothing glides. On phones the card docks to the
   bottom. Saves progress through onChange (the host persists it with
   lib/onboarding saveOnboarding).

   How it behaves
   • A new person is first ASKED ("Take a three-minute tour?" · Show me
     around / Not now); a tour asked for (Help, the first-run dialog's
     hand-over) starts straight at step 1. A part-way tour resumes.
   • It never opens over a dialog: it waits until none is open (the
     first-run dialogs, a task panel on a phone…).
   • The card is a NON-modal dialog: the real UI stays usable, so "press
     Q" or "press P" can be tried for real while it's up. Escape (focus in
     the card) skips; ← / → move; focus stays on the button you pressed and
     each move is read out ("Step 3 of 7: Capture in a second. …").
   • A step in another place (Plan my day on Today, triage in the Inbox)
     asks the app to go there (onNavigate); the task-panel step opens the
     sample project's first task (onOpenTask) when there is one. A step
     whose anchor isn't on screen shows as a centred card (docked on
     phones). At the end it takes you back to where you started.
   ============================================================ */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, IconButton, Kbd, KanboLogo } from "../primitives";
import type { OnboardingState, OnboardingTourState, TourRole } from "../../data/types";
import type { Route } from "../../app-types";
import {
  TOUR_ANCHORS, TOUR_MINUTES, onTourDecline, onTourRequest, resumeIndex, shouldAutoStartTour, tourState, tourSteps, type TourStep,
} from "../../lib/onboarding";
import { routeOf } from "../../lib/nav";
import { DOCK_BELOW, boxOf, findTourAnchor, placeCoachCard, sameBox, spotlightBox, type Box, type Size } from "./tourPlacement";
import { CompassGlyph } from "./glyphs";

export interface TourHostProps {
  role: TourRole;
  onboarding: OnboardingState;
  /** after any change (step moved, finished, skipped): the new state — the host saves it */
  onChange: (next: OnboardingState) => void;
  /** a brand-new account (first sign-in): the tour may start by itself */
  isNewAccount?: boolean;
  /** a step that needs another place (e.g. the Inbox) asks the app to go there first */
  onNavigate?: (route: Route) => void;
  /** a step that shows the task panel asks the app to open a task (the sample project's first, if any) */
  onOpenTask?: (taskId: string) => void;
}

type Phase = "idle" | "offer" | "running";
interface Queued { phase: "offer" | "running"; index: number; explicit: boolean }

/** how often the card looks for its anchor (it may arrive late: a lazy place, a panel opening) */
const TRACK_MS = 200;
/** a tour waits for open dialogs to close; an asked-for one gives up waiting after this long */
const WAIT_POLL_MS = 300;
const WAIT_EXPLICIT_MAX_MS = 4000;
/** step moves are saved after a pause (Next, Next, Next is one write); finish and skip at once */
const SAVE_DEBOUNCE_MS = 500;

const IS_APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
/** "⌘K" as this keyboard shows it, and as it's said */
export function keyCap(kbd: string, apple = IS_APPLE): { shown: string; spoken: string } {
  if (kbd === "⌘K") return apple ? { shown: "⌘K", spoken: "Command K" } : { shown: "Ctrl K", spoken: "Control K" };
  return { shown: kbd, spoken: kbd };
}
const media = (q: string) => typeof window !== "undefined" && !!window.matchMedia?.(q)?.matches;
const reducedMotion = () => media("(prefers-reduced-motion: reduce)");
const touchFirst = (vw: number) => vw < DOCK_BELOW || media("(pointer: coarse)");
const viewportNow = (): Size => ({ width: window.innerWidth, height: window.innerHeight });
const MINUTES_WORD = ["zero", "one", "two", "three", "four", "five"][TOUR_MINUTES] ?? String(TOUR_MINUTES);

export function TourHost({ role, onboarding, onChange, isNewAccount, onNavigate, onOpenTask }: TourHostProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [index, setIndex] = useState(0);
  const [announce, setAnnounce] = useState("");
  const [anchor, setAnchor] = useState<Box | null>(null);
  const [cardSize, setCardSize] = useState<Size>({ width: 360, height: 230 });
  const [viewport, setViewport] = useState<Size>(() => (typeof window === "undefined" ? { width: 1280, height: 800 } : viewportNow()));
  const steps = useMemo(() => tourSteps(role), [role]);
  const at = Math.min(index, steps.length - 1);
  const step: TourStep | null = phase === "running" ? steps[at] ?? null : null;

  // the latest props for the callbacks (they're inline arrows in the host)
  const latest = useRef({ role, onboarding, onChange, onNavigate, onOpenTask });
  latest.current = { role, onboarding, onChange, onNavigate, onOpenTask };
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const cardRef = useRef<HTMLElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const startPath = useRef<{ path: string; search: string } | null>(null);
  const navigated = useRef(false);
  const openedTaskAt = useRef(0);
  const handled = useRef(false);   // started, offered or declined in this visit: never auto-start again
  const queued = useRef<Queued | null>(null);
  const [waiting, setWaiting] = useState(0);

  /* ---------- saving ---------- */
  const saveTimer = useRef(0);
  const pendingSave = useRef<(() => void) | null>(null);
  const commit = useCallback((tour: OnboardingTourState, debounce: boolean) => {
    window.clearTimeout(saveTimer.current);
    const run = () => { pendingSave.current = null; latest.current.onChange({ ...latest.current.onboarding, v: 1, tour }); };
    if (!debounce) { run(); return; }
    pendingSave.current = run;
    saveTimer.current = window.setTimeout(run, SAVE_DEBOUNCE_MS);
  }, []);
  useEffect(() => () => { window.clearTimeout(saveTimer.current); pendingSave.current?.(); }, []);

  /* ---------- starting: never over an open dialog ---------- */
  const otherModalOpen = () => Array.from(document.querySelectorAll('[aria-modal="true"]')).some((el) => !cardRef.current?.contains(el));
  const begin = useCallback((q: Queued) => {
    queued.current = q;
    setWaiting((n) => n + 1);
  }, []);
  useEffect(() => {
    const q = queued.current;
    if (!q) return;
    const since = Date.now();
    const go = () => {
      if (queued.current !== q) return true;
      if (otherModalOpen() && !(q.explicit && Date.now() - since > WAIT_EXPLICIT_MAX_MS)) return false;
      queued.current = null;
      const ae = document.activeElement;
      returnTo.current = ae instanceof HTMLElement && ae !== document.body && !cardRef.current?.contains(ae) ? ae : null;
      startPath.current = { path: window.location.pathname, search: window.location.search };
      navigated.current = false;
      setAnnounce("");
      setIndex(q.index);
      setPhase(q.phase);
      return true;
    };
    if (go()) return;
    const iv = window.setInterval(() => { if (go()) window.clearInterval(iv); }, WAIT_POLL_MS);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  // by itself: a new person (asked first), or one part-way through (carries on)
  const tourKey = JSON.stringify(onboarding.tour ?? null);
  useEffect(() => {
    if (handled.current || phaseRef.current !== "idle") return;
    if (!shouldAutoStartTour(onboarding, { isNewAccount: !!isNewAccount })) return;
    handled.current = true;
    const saved = onboarding.tour?.step;
    begin(saved ? { phase: "running", index: resumeIndex(role, saved), explicit: false } : { phase: "offer", index: 0, explicit: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourKey, isNewAccount, role, begin]);

  // asked for (Help › Take the tour; the first-run dialog's "Show me around")
  useEffect(() => onTourRequest(() => {
    handled.current = true;
    begin({ phase: "running", index: 0, explicit: true });
  }), [begin]);
  // "Not now" from the first-run dialog: recorded as skipped (unless a tour is already running)
  useEffect(() => onTourDecline(() => {
    handled.current = true;
    if (phaseRef.current === "running") return;
    queued.current = null;
    setPhase("idle");
    commit(tourState(latest.current.role, "skipped"), false);
  }), [commit]);

  /* ---------- ending ---------- */
  const end = useCallback((how: "done" | "skipped") => {
    commit(tourState(latest.current.role, how), false);
    queued.current = null;
    setPhase("idle");
    setAnchor(null);
    // back to where it started, if the tour took you elsewhere
    const from = startPath.current;
    if (navigated.current && from && latest.current.onNavigate) {
      const r = routeOf(from.path, from.search);
      if (r) latest.current.onNavigate(r);
    }
    navigated.current = false;
    const back = returnTo.current;
    returnTo.current = null;
    const target = back && back.isConnected ? back : document.getElementById("main");
    target?.focus({ preventScroll: true });
  }, [commit]);

  const move = useCallback((to: number) => {
    const n = steps.length;
    if (to >= n) { end("done"); return; }
    const i = Math.max(0, to);
    const s = steps[i];
    const body = touchFirst(window.innerWidth) && s.touchBody ? s.touchBody : s.body;
    setAnnounce(`Step ${i + 1} of ${n}: ${s.title}. ${body}`);
    setIndex(i);
  }, [steps, end]);

  /* ---------- entering a step: save, go to its place, open its task ---------- */
  useEffect(() => {
    if (phase !== "running" || !step) return;
    commit(tourState(latest.current.role, { step: step.id }), true);
    const { onNavigate: nav, onOpenTask: open, onboarding: ob } = latest.current;
    const sel = step.anchor ? TOUR_ANCHORS[step.anchor] : null;
    const shown = sel ? findTourAnchor(sel) : null;
    const panelOpen = !step.opensTask && !!findTourAnchor(TOUR_ANCHORS.taskPanel);
    if (step.route && nav && (!shown || panelOpen)) { nav(step.route); navigated.current = true; }
    if (step.opensTask && !shown) {
      const first = ob.sample?.taskIds?.[0];
      // (and at the end, going back where it started closes the panel it opened)
      if (first && open) { open(first); openedTaskAt.current = Date.now(); navigated.current = true; }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, step?.id]);

  /* ---------- following the anchor ---------- */
  useEffect(() => {
    if (phase !== "running" || !step) { setAnchor(null); return; }
    const sel = step.anchor ? TOUR_ANCHORS[step.anchor] : null;
    let scrolled = false, raf = 0;
    const tick = () => {
      const vp = viewportNow();
      setViewport((v) => (v.width === vp.width && v.height === vp.height ? v : vp));
      const el = sel ? findTourAnchor(sel) : null;
      if (el && !scrolled) {
        scrolled = true;
        const r = el.getBoundingClientRect();
        if (r.top < 0 || r.bottom > vp.height) el.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
      }
      const b = el ? boxOf(el) : null;
      setAnchor((cur) => (sameBox(cur, b) ? cur : b));
      // the task panel takes focus as it opens: hand it back to the card, once, just after we opened it
      if (el && step.opensTask && openedTaskAt.current && Date.now() - openedTaskAt.current < 2500 && !cardRef.current?.contains(document.activeElement)) {
        openedTaskAt.current = 0;
        primaryRef.current?.focus({ preventScroll: true });
      }
    };
    const soon = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); };
    tick();
    const iv = window.setInterval(tick, TRACK_MS);
    window.addEventListener("resize", soon);
    window.addEventListener("scroll", soon, true);
    return () => { cancelAnimationFrame(raf); window.clearInterval(iv); window.removeEventListener("resize", soon); window.removeEventListener("scroll", soon, true); };
  }, [phase, step]);

  /* ---------- measuring the card; focus in on start ---------- */
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el || phase === "idle") return;
    const next = { width: el.offsetWidth || 360, height: el.offsetHeight || 230 };
    setCardSize((cur) => (cur.width === next.width && cur.height === next.height ? cur : next));
  });
  useEffect(() => {
    if (phase === "idle") return;
    primaryRef.current?.focus({ preventScroll: true });
  }, [phase]);
  // a move by keyboard leaves focus on a button that went away (Back on step 1): put it on Next
  useEffect(() => {
    if (phase !== "running") return;
    const ae = document.activeElement;
    if (!ae || ae === document.body) primaryRef.current?.focus({ preventScroll: true });
  }, [phase, at]);

  const titleId = "ktour-title" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const bodyId = titleId + "-body";

  if (phase === "idle" || typeof document === "undefined") return null;

  /* ---------- the card ---------- */
  const touch = touchFirst(viewport.width);
  const skip = () => end("skipped");
  const notNow = () => end("skipped");
  const showMeAround = () => { setAnnounce(""); setIndex(0); setPhase("running"); };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      // the tour's own Escape: App's handler and any dialog's trap below leave it alone
      e.preventDefault(); e.stopPropagation();
      if (phase === "offer") notNow(); else skip();
      return;
    }
    if (phase !== "running" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); move(at + 1); }
    else if (e.key === "ArrowLeft" && at > 0) { e.preventDefault(); e.stopPropagation(); move(at - 1); }
  };

  const spot = phase === "running" && anchor ? spotlightBox(anchor, viewport) : null;
  const place = placeCoachCard(phase === "running" ? anchor : null, cardSize, viewport);
  const cardStyle: CSSProperties = place.mode === "dock"
    ? { left: 8, right: 8, ...(place.side === "top" ? { top: 8 } : { bottom: "calc(8px + env(safe-area-inset-bottom, 0px))" }) }
    : { top: place.top, left: place.left };

  const n = steps.length;
  const last = at === n - 1;
  const cap = step?.kbd && !touch ? keyCap(step.kbd) : null;
  const body = step ? (touch && step.touchBody ? step.touchBody : step.body) : "";
  const offerBody = role === "guest"
    ? "Kanbo will point out what you'll use most, right where it lives: your places, search, a task's panel and your Inbox. Stop whenever you like."
    : "Kanbo will point out what you'll use every day, right where it lives: your places, search, capture, planning your day and your Inbox. Stop whenever you like.";

  return createPortal(
    <div className="ktour-layer" data-phase={phase}>
      <style>{TOUR_CSS}</style>
      {spot
        ? <div className="ktour-spot" aria-hidden="true" style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} />
        : <div className="ktour-dim" aria-hidden="true" />}
      <section ref={cardRef} role="dialog" aria-modal="false" aria-labelledby={titleId} aria-describedby={bodyId}
        className="ktour-card" data-mode={place.mode} data-side={place.side} style={cardStyle} onKeyDown={onKeyDown}
        // a dialog's focus trap underneath (a task panel on a narrower screen) lets focus be here
        data-focus-trap-ignore="">
        {phase === "offer" ? (
          <>
            <div className="ktour-offer-mark" aria-hidden="true"><KanboLogo size={36} /></div>
            <h2 id={titleId} className="ktour-title">Take a {MINUTES_WORD}-minute tour?</h2>
            <p id={bodyId} className="ktour-body">{offerBody}</p>
            <div className="ktour-foot" data-offer="">
              <Button variant="ghost" size="md" onClick={notNow}>Not now</Button>
              <Button ref={primaryRef} variant="primary" size="md" iconRight="arrowRight" onClick={showMeAround}>Show me around</Button>
            </div>
            <p className="ktour-hint">You can take it any time from Help (?).</p>
          </>
        ) : step && (
          <>
            <div className="ktour-meta">
              <span className="ktour-eyebrow"><CompassGlyph size={14} />Tour</span>
              <span className="ktour-count" aria-hidden="true">{at + 1} of {n}</span>
              <IconButton icon="x" label="Skip tour" size="sm" onClick={skip} />
            </div>
            <h2 id={titleId} className="ktour-title"><span className="sr-only">Step {at + 1} of {n}: </span>{step.title}</h2>
            <p id={bodyId} className="ktour-body">{body}</p>
            {cap && (
              <p className="ktour-try">
                <span aria-hidden="true">Try it now</span>
                <span aria-hidden="true" className="ktour-try-keys"><Kbd>{cap.shown}</Kbd></span>
                <span className="sr-only">Shortcut: {cap.spoken}</span>
              </p>
            )}
            <div className="ktour-foot">
              <span className="ktour-dots" aria-hidden="true">
                {steps.map((s, i) => <span key={s.id} className="ktour-dot" data-on={i === at || undefined} data-done={i < at || undefined} />)}
              </span>
              {at > 0 && <Button variant="ghost" size="sm" icon="arrowLeft" onClick={() => move(at - 1)}>Back</Button>}
              <Button ref={primaryRef} variant="primary" size="sm" iconRight={last ? "check" : "arrowRight"} onClick={() => move(at + 1)}>
                {last ? "Finish" : "Next"}
              </Button>
            </div>
          </>
        )}
        <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      </section>
    </div>,
    document.body,
  );
}

/* Above the task panel (60), the page header and Popovers' own layer for the
   page (80); below dialogs (100), ⌘K (120) and toasts (140), so "press Q" opens
   capture over the tour. Nothing in the layer but the card takes the pointer. */
export const TOUR_CSS = `
.ktour-layer { position: fixed; inset: 0; z-index: 90; pointer-events: none; }
.ktour-dim { position: absolute; inset: 0; background: var(--scrim-soft); animation: ktourFade var(--d-3, 240ms) var(--ease); }
.ktour-spot {
  position: absolute; border-radius: var(--r-lg, 12px);
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 6px var(--accent-glow, transparent), 0 0 0 200vmax var(--scrim-soft);
  transition: top var(--d-3, 240ms) var(--ease), left var(--d-3, 240ms) var(--ease), width var(--d-3, 240ms) var(--ease), height var(--d-3, 240ms) var(--ease);
  animation: ktourFade var(--d-3, 240ms) var(--ease);
}
.ktour-card {
  position: absolute; isolation: isolate; pointer-events: auto; box-sizing: border-box;
  width: min(360px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow-y: auto; overscroll-behavior: contain;
  padding: 14px 16px 16px 20px; border-radius: var(--r-xl, 16px);
  background: var(--surface-raised); color: var(--ink); box-shadow: var(--e3, var(--shadow-lg));
  transition: top var(--d-3, 240ms) var(--ease), left var(--d-3, 240ms) var(--ease);
  animation: ktourIn var(--d-3, 240ms) var(--ease);
}
/* the brief card's gradient hairline: Kanbo is speaking */
.ktour-card::before {
  content: ""; position: absolute; top: 0; left: 20px; right: 20px; height: 1px; border-radius: 1px; pointer-events: none;
  background: var(--grad); opacity: 0.55;
}
.ktour-card[data-mode="dock"] { width: auto; max-height: min(60dvh, calc(100dvh - 16px)); }
.ktour-meta { display: flex; align-items: center; gap: 8px; min-height: 28px; margin: 0 -8px 6px 0; }
.ktour-eyebrow { display: inline-flex; align-items: center; gap: 6px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--accent-text, var(--accent)); }
.ktour-count { font: 500 12px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.ktour-meta > .kibtn { margin-left: auto; }
.ktour-title { margin: 0; padding-right: 4px; font: 600 17px/24px var(--font-head); letter-spacing: -0.01em; color: var(--ink); text-wrap: balance; }
.ktour-body { margin: 6px 0 0; font: 400 14px/21px var(--font-ui, var(--font-display)); color: var(--ink-2); text-wrap: pretty; }
.ktour-try { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.ktour-try-keys { display: inline-flex; }
.ktour-try .kkbd { height: 22px; min-width: 22px; padding: 0 7px; font-size: 12px; color: var(--ink-2); }
.ktour-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.ktour-dots { display: inline-flex; align-items: center; gap: 5px; margin-right: auto; }
.ktour-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--hairline-strong); transition: width var(--d-2, 160ms) var(--ease), background var(--d-2, 160ms) var(--ease); }
.ktour-dot[data-done] { background: var(--ink-4); }
.ktour-dot[data-on] { width: 16px; background: var(--accent-fill, var(--accent)); }
.ktour-offer-mark { display: grid; place-items: center; width: 52px; height: 52px; margin: 6px 0 14px; border-radius: 14px; background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--hairline); }
.ktour-layer[data-phase="offer"] .ktour-card { padding: 20px 24px; }
.ktour-layer[data-phase="offer"] .ktour-card::before { left: 24px; right: 24px; }
.ktour-hint { margin: 12px 0 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
@keyframes ktourIn { from { opacity: 0.35; translate: 0 6px; } }
@keyframes ktourFade { from { opacity: 0; } }
@media (max-width: 859px) {
  .ktour-card { padding: 12px 14px 14px 16px; }
  .ktour-card::before { left: 16px; right: 16px; }
  .ktour-foot .kbtn { height: var(--h-touch, 44px); }
  .ktour-layer[data-phase="offer"] .ktour-card { padding: 18px 16px 16px; }
  .ktour-foot[data-offer] { flex-direction: column-reverse; align-items: stretch; }
}
@media (prefers-reduced-motion: reduce) {
  .ktour-card, .ktour-spot, .ktour-dim, .ktour-dot { transition: none !important; animation: none !important; }
}
`;
