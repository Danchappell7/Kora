/* ============================================================
   KANBO — Today › "Get set up" card.                   [0048 → u1]
   For owners/admins: invite your team, connect a calendar, add your
   company domain, connect Slack. For members: plan your day, complete a
   task, install the app, set notifications (guests: the two of those
   they can do: install, notifications). A progress ring ("2 of 4"),
   each item a button that takes you there (onAction), ticked items
   struck through with a check, "Dismiss" (and it leaves by itself once
   complete, after a moment of celebration — none with reduced motion).
   Shown only while lib/onboarding showSetupChecklist is true (mount it
   with useShowSetupChecklist, which keeps it for the celebration).

   • Each item's tick is a real checkbox (the status glyph, as on every
     task row): tick it by hand, or it ticks itself when the app can see
     it's done (signals) — those are saved, so progress sticks (an app
     installed on this computer isn't visible from a browser tab), and
     can't be unticked.
   • The card fits the brief's column (two columns of items) and the
     Today rail or a phone (one column): a container query decides.
   • Folded (`fold`, Today beside the rail): one row — the ring, how far
     you are and the next step with its button; "Set-up steps" opens the
     whole list (a disclosure: aria-expanded / aria-controls).
   • Leaving with focus inside it (Dismiss, or after the celebration),
     focus goes to the main content (#main), never dropped on <body>.
   ============================================================ */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button, IconButton, StatusGlyph } from "../primitives";
import type { OnboardingState, SetupItemId, TourRole } from "../../data/types";
import {
  checklistView, dismissSetupChecklist, tickSetupItem, withSignalTicks, type SetupSignals,
} from "../../lib/onboarding";

export interface SetupChecklistProps {
  role: TourRole;
  onboarding: OnboardingState;
  /** what the app can see (team invited, calendar connected…) */
  signals: SetupSignals;
  /** ticks / dismissal: the new state — the host saves it */
  onChange: (next: OnboardingState) => void;
  /** go and do it: open Settings › Team, the calendar panel, Plan my day… (the host routes) */
  onAction: (id: SetupItemId) => void;
  /** optional: items this person can't do here, left out (e.g. ["add_domain"] for an owner who isn't a site admin) */
  hidden?: readonly SetupItemId[];
  /** optional: Today's fold (TodayCardFold): folded, the card is one row until it's opened. Without it, the card is whole. */
  fold?: { folded: boolean; onFold: (folded: boolean) => void } | null;
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six"];
/** Where focus goes when the card leaves with it inside: the main content (as the skip link and the tour do). */
function focusMain() {
  const m = (document.getElementById("main") ?? document.querySelector("main")) as HTMLElement | null;
  if (!m) return;
  if (!m.hasAttribute("tabindex")) m.setAttribute("tabindex", "-1");
  m.focus({ preventScroll: true });
}
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

/** The card's ring: done of total in the brand gradient, the count (or a tick, when complete) inside. */
function SetupRing({ done, total }: { done: number; total: number }) {
  const gid = "ksetupg" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const complete = total > 0 && done >= total;
  const r = 17, c = 2 * Math.PI * r;
  const dash = total > 0 ? +(c * Math.min(1, done / total)).toFixed(2) : 0;
  return (
    <span className="ksetup-ring" role="progressbar" aria-label="Set-up progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}
      aria-valuetext={`${done} of ${total} done`} data-complete={complete || undefined}>
      <svg width={44} height={44} viewBox="0 0 44 44" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#5B7CFA" /><stop offset="0.52" stopColor="#8B5CF6" /><stop offset="1" stopColor="#C24BE0" />
          </linearGradient>
        </defs>
        <circle cx={22} cy={22} r={r} fill="none" stroke="var(--track)" strokeWidth={4} />
        {dash > 0 && (
          <circle cx={22} cy={22} r={r} fill="none" stroke={`url(#${gid})`} strokeWidth={4} strokeLinecap={complete ? "butt" : "round"}
            strokeDasharray={`${dash} ${+c.toFixed(2)}`} transform="rotate(-90 22 22)" className="ksetup-ring-arc" />
        )}
        {complete && <path d="M15.5 22.5l4.4 4.4 8.6-9.2" pathLength={1} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" className="ksetup-ring-tick" />}
      </svg>
      {!complete && <span className="ksetup-ring-n" aria-hidden="true">{done}<span>/{total}</span></span>}
    </span>
  );
}

export function SetupChecklist({ role, onboarding, signals, onChange, onAction, hidden, fold }: SetupChecklistProps) {
  const opts = { hidden };
  const view = checklistView(role, onboarding, signals, opts);
  const headId = "ksetup" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const listId = headId + "-list";
  const folded = !!fold?.folded;
  // folded, the row offers the next step (the list's order is the order to do them in)
  const next = view.items.find((it) => !it.done);
  const [announce, setAnnounce] = useState("");
  const [celebrate, setCelebrate] = useState(false);
  const wasComplete = useRef(view.complete);
  const cardRef = useRef<HTMLElement>(null);

  // leaving (Dismiss, or after the celebration) while focus is inside: hand it on deliberately. A layout
  // effect's clean-up runs before React takes the card out of the page, so focus is still in it here.
  useLayoutEffect(() => {
    const card = cardRef.current;
    return () => {
      const active = document.activeElement;
      if (card && active && active !== document.body && card.contains(active)) focusMain();
    };
  }, []);

  // ticks the app can see are saved once, so they stick
  const reported = useRef(new Set<string>());
  const signalKey = view.items.filter((i) => i.auto).map((i) => i.id).join(",");
  useEffect(() => {
    const next = withSignalTicks(role, onboarding, signals, new Date(), opts);
    if (!next) return;
    const fresh = Object.keys(next.checklist?.done ?? {}).filter((id) => !onboarding.checklist?.done?.[id as SetupItemId] && !reported.current.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => reported.current.add(id));
    onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signalKey, role]);

  // finished in front of you: say so (and, with motion, celebrate) before the host lets it go
  useEffect(() => {
    if (view.complete && !wasComplete.current) {
      setAnnounce("All set. Everything on your set-up list is done.");
      setCelebrate(!reducedMotion());
    }
    wasComplete.current = view.complete;
  }, [view.complete]);

  const toggle = (id: SetupItemId, label: string, done: boolean) => {
    const next = tickSetupItem(onboarding, id, !done);
    const after = checklistView(role, next, signals, opts);
    if (!after.complete) setAnnounce(`${label} ${done ? "not done" : "done"}. ${after.done} of ${after.total} done.`);
    onChange(next);
  };
  const dismiss = () => onChange(dismissSetupChecklist(onboarding, true));

  const sub = view.complete
    ? "Everything's in place. This card will tuck itself away."
    : folded
    ? `${view.done} of ${view.total} done${next ? ` · Next: ${next.label}` : ""}`
    : `${view.done} of ${view.total} done · ${WORDS[view.total] ?? view.total} quick things ${role === "owner" ? "to get your team going" : "to make Kanbo yours"}.`;

  return (
    <section ref={cardRef} className="ksetup" aria-labelledby={headId} data-complete={view.complete || undefined} data-celebrate={celebrate || undefined}
      data-folded={folded || undefined}>
      <style>{SETUP_CSS}</style>
      <header className="ksetup-head">
        <SetupRing done={view.done} total={view.total} />
        <div className="ksetup-heading">
          <h2 id={headId} className="ksetup-title">{view.complete ? "You're all set" : "Get set up"}</h2>
          <p className="ksetup-sub">{sub}</p>
        </div>
        {folded && next && !view.complete && (
          <Button size="sm" variant="secondary" className="ksetup-next" onClick={() => onAction(next.id)} aria-label={`${next.action}: ${next.label}`}>{next.action}</Button>
        )}
        <span className="ksetup-acts">
          {fold && (
            <IconButton icon="chevronDown" label="Set-up steps" size="sm" className="ksetup-fold" aria-expanded={!folded} aria-controls={listId}
              onClick={() => fold.onFold(!folded)} />
          )}
          {!view.complete && <IconButton icon="x" label="Dismiss “Get set up”" size="sm" onClick={dismiss} />}
        </span>
      </header>
      <ul id={listId} className="ksetup-list" hidden={folded}>
        {view.items.map((it) => (
          <li key={it.id} className="ksetup-item" data-done={it.done || undefined}>
            <StatusGlyph status={it.done ? "done" : "todo"} size={20} label={it.label} celebrateKey={`setup:${it.id}`}
              readOnly={it.auto} onToggle={() => toggle(it.id, it.label, it.done)} />
            <span className="ksetup-text">
              <span className="ksetup-label">{it.label}</span>
              <span className="ksetup-hint">{it.done ? (it.auto ? "Done: Kanbo can see it's set up." : "Ticked off.") : it.hint}</span>
            </span>
            {!it.done && (
              <Button size="sm" variant="secondary" onClick={() => onAction(it.id)} aria-label={`${it.action}: ${it.label}`}>{it.action}</Button>
            )}
          </li>
        ))}
      </ul>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    </section>
  );
}

export const SETUP_CSS = `
.ksetup {
  container-type: inline-size; position: relative; max-width: 920px; margin-top: 16px; padding: 16px 16px 8px 20px;
  border-radius: var(--r-lg, 12px); background: var(--surface, var(--surface-raised)); box-shadow: var(--e1, 0 0 0 1px var(--hairline));
}
.ksetup-head { display: flex; align-items: center; gap: 14px; min-height: 44px; }
.ksetup-heading { flex: 1; min-width: 0; }
.ksetup-title { margin: 0; font: 600 17px/24px var(--font-head); letter-spacing: -0.01em; color: var(--ink); }
.ksetup-sub { margin: 2px 0 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.ksetup-acts { display: inline-flex; align-items: center; gap: 2px; align-self: flex-start; flex-shrink: 0; }
.ksetup-fold > svg { transition: rotate var(--d-2, 160ms) var(--ease); }
.ksetup-fold[aria-expanded="true"] > svg { rotate: 180deg; }
.ksetup-list[hidden] { display: none; }
/* folded (Today beside the rail): one row, the height of a list row */
.ksetup[data-folded] { padding: 10px 10px 10px 12px; }
.ksetup[data-folded] .ksetup-head { gap: 12px; min-height: 36px; }
.ksetup[data-folded] .ksetup-ring, .ksetup[data-folded] .ksetup-ring > svg { width: 36px; height: 36px; }
.ksetup[data-folded] .ksetup-ring-n { font-size: 12px; }
.ksetup[data-folded] .ksetup-title { font-size: 14px; line-height: 20px; letter-spacing: 0; }
.ksetup[data-folded] .ksetup-sub { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ksetup[data-folded] .ksetup-acts { align-self: center; }
.ksetup-next { flex-shrink: 0; }
/* too narrow for the next step's button as well: "Set-up steps" still opens it */
@container (max-width: 340px) { .ksetup-next { display: none; } }
.ksetup-ring { position: relative; display: grid; place-items: center; width: 44px; height: 44px; flex-shrink: 0; color: var(--ok, var(--st-done)); }
.ksetup-ring > svg { position: absolute; inset: 0; }
.ksetup-ring-arc { transition: stroke-dasharray var(--d-3, 240ms) var(--ease); }
.ksetup-ring-n { position: relative; font: 600 13px/1 var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.ksetup-ring-n > span { font-weight: 500; color: var(--ink-3); }
.ksetup-list { display: grid; grid-template-columns: minmax(0, 1fr); column-gap: 24px; margin: 12px 0 0; padding: 0; list-style: none; }
@container (min-width: 560px) { .ksetup-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.ksetup-item { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px 0; box-shadow: inset 0 1px 0 var(--hairline); }
.ksetup-text { flex: 1; min-width: 0; display: grid; }
.ksetup-label { font: 600 14px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.ksetup-hint { font: 400 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.ksetup-item[data-done] .ksetup-label { color: var(--ink-3); font-weight: 500; text-decoration: line-through; text-decoration-color: var(--ink-4); }
.ksetup-item > .kbtn { flex-shrink: 0; }
/* all done: the ring fills, the tick draws, a little lift — then the host lets the card go */
.ksetup[data-celebrate] .ksetup-ring { animation: ksetupPop var(--d-4, 480ms) var(--ease-spring) both; }
.ksetup[data-celebrate] .ksetup-ring-tick { stroke-dasharray: 1; stroke-dashoffset: 1; animation: ksetupDraw var(--d-3, 240ms) 160ms var(--ease) forwards; }
.ksetup[data-celebrate] { animation: ksetupLeave var(--d-3, 240ms) 2100ms var(--ease-exit, ease-in) forwards; }
@keyframes ksetupPop { 0% { scale: 0.9; } 60% { scale: 1.08; } 100% { scale: 1; } }
@keyframes ksetupDraw { to { stroke-dashoffset: 0; } }
@keyframes ksetupLeave { to { opacity: 0.35; translate: 0 -4px; } }
@media (max-width: 859px) {
  .ksetup { padding: 14px 12px 6px 16px; }
  .ksetup-item { min-height: 60px; }
  .ksetup-item > .kbtn { height: var(--h-touch, 44px); }
}
@media (prefers-reduced-motion: reduce) {
  .ksetup, .ksetup *, .ksetup-ring-arc { animation: none !important; transition: none !important; }
}
`;
