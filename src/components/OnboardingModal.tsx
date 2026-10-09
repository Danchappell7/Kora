/* ============================================================
   KANBO — first-run onboarding: welcome → your name → first project →
   the hand-over to the guided tour. Shown once to brand-new accounts (no
   real projects yet). The name step is skipped when the profile already
   has a first name (e.g. it was just entered in the welcome modal).
   One centred sheet (a bottom sheet on phones), no scrim click to
   close: Escape or "Skip for now" finishes it.
   The last step doesn't describe the app (the tour shows the real thing,
   on the real screens): it offers the tour — "Show me around" starts it
   (lib/onboarding startTour; the TourHost waits for this dialog to
   close), "Skip the tour" records that (declineTour), and both take you
   to Today. Escape just closes (a new account is asked again by the tour).
   ============================================================ */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon, KanboLogo, EmojiPicker, Button, projectPaint } from "./primitives";
import { Popover } from "./primitives/Popover";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { declineTour, startTour, TOUR_MINUTES } from "../lib/onboarding";
import { CompassGlyph } from "./onboarding/glyphs";
import type { Profile } from "../data/types";
import type { NewProject } from "../data/store";

const COLORS: { value: string; name: string }[] = [
  { value: "oklch(0.74 0.14 230)", name: "Blue" },
  { value: "oklch(0.74 0.16 305)", name: "Violet" },
  { value: "oklch(0.75 0.13 155)", name: "Green" },
  { value: "oklch(0.78 0.15 70)", name: "Amber" },
  { value: "oklch(0.66 0.2 20)", name: "Red" },
  { value: "oklch(0.78 0.1 45)", name: "Peach" },
];

const STEP_TITLES = ["Welcome", "What should we call you?", "Create your first project", "You're all set"];
const MINUTES_WORD = ["zero", "one", "two", "three", "four", "five"][TOUR_MINUTES] ?? String(TOUR_MINUTES);

/** The first run's last word: offer the guided tour (shared with the welcome modal). */
export function TourHandover({ name, onShowMeAround, onSkip, lede }: { name?: string; onShowMeAround: () => void; onSkip: () => void; lede?: string }) {
  return (
    <div className="konb-step konb-intro">
      <span className="konb-mark konb-tourmark" aria-hidden="true"><CompassGlyph size={26} sw={1.6} /></span>
      <div className="konb-head">
        <h2 className="konb-title">You're all set{name ? `, ${name}` : ""}</h2>
        <p className="konb-lede">
          {lede ?? `Next, a quick look around the real thing. Kanbo points out your places, search, capture and planning your day, right where they live. It takes about ${MINUTES_WORD} minutes.`}
        </p>
      </div>
      <div className="konb-acts" data-stack="">
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <Button autoFocus data-autofocus variant="hero" size="lg" full iconRight="arrowRight" onClick={onShowMeAround}>Show me around</Button>
        <Button variant="ghost" onClick={onSkip}>Skip the tour</Button>
      </div>
      <p className="konb-foot">You can take it any time from Help (?).</p>
    </div>
  );
}

export function OnboardingModal({ open, profile, workspaceId, onSaveProfile, onCreateProject, onFinish, onGoToday, onStartTour, onSkipTour }: {
  open: boolean;
  profile: Profile | null;
  workspaceId: string | null;
  /** avatarUrl left out keeps the saved photo (this dialog never changes it) */
  onSaveProfile: (d: { firstName: string; lastName: string; pronouns: string; avatarUrl?: string | null }) => Promise<void>;
  onCreateProject: (p: NewProject) => void;
  onFinish: () => void;
  /** after the last step's choice: runs after onFinish (the app lands on Today anyway when it's left out) */
  onGoToday?: () => void;
  /** "Show me around" (default: lib/onboarding startTour — the mounted TourHost starts once this closes) */
  onStartTour?: () => void;
  /** "Skip the tour" (default: lib/onboarding declineTour — recorded as skipped) */
  onSkipTour?: () => void;
}) {
  const [step, setStep] = useState(0);
  const [firstName, setFirstName] = useState(profile?.firstName || "");
  const [lastName, setLastName] = useState(profile?.lastName || "");
  const [projName, setProjName] = useState("");
  const [emoji, setEmoji] = useState("🚀");
  const [color, setColor] = useState(COLORS[0].value);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // once the person types, the profile no longer overwrites their edits
  const nameEdited = useRef(false);
  const emojiRef = useRef<HTMLButtonElement>(null);
  // the step you moved to is read out (not the one you opened on)
  const [moved, setMoved] = useState(false);

  // The profile usually arrives (or gains a name from the welcome modal)
  // after this mounts — keep the fields in step with it until edited.
  const profFirst = profile?.firstName ?? "";
  const profLast = profile?.lastName ?? "";
  useEffect(() => {
    if (nameEdited.current) return;
    setFirstName(profFirst);
    setLastName(profLast);
  }, [profFirst, profLast]);

  // they already told us their name: no need to ask again
  const hasName = !!profFirst.trim();
  const steps = hasName ? [0, 2, 3] : [0, 1, 2, 3];

  const onEscape = () => {
    if (pickerOpen) { setPickerOpen(false); return; }
    onFinish();
  };
  // For a brand-new account the welcome modal can open on top of this one. The
  // trap stacks them, leaves focus to the welcome modal while it's open, hands
  // it back here when it closes, and still takes Escape if focus ever drops
  // onto the page behind.
  const trapRef = useFocusTrap<HTMLDivElement>(open, onEscape);

  if (!open) return null;

  const go = (n: number) => { setMoved(true); setStep(n); };
  const saveName = async () => {
    setBusy(true);
    try { await onSaveProfile({ firstName: firstName.trim(), lastName: lastName.trim(), pronouns: profile?.pronouns || "" }); } catch { /* non-blocking */ }
    setBusy(false); go(2);
  };
  const createProject = () => {
    const n = projName.trim();
    if (n) onCreateProject({ name: n, emoji, color, workspaceId });
    go(3);
  };
  const editName = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => { nameEdited.current = true; set(e.target.value); };
  const greetName = firstName.trim();
  const finishWith = (tour: "start" | "skip") => {
    onFinish();
    onGoToday?.();
    if (tour === "start") (onStartTour ?? (() => startTour({ from: "onboarding" })))();
    else (onSkipTour ?? (() => declineTour({ from: "onboarding" })))();
  };

  // colour: one radio group, arrows move and pick
  const onSwatchKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? COLORS.length - 1 : null;
    if (!dir && to === null) return;
    e.preventDefault();
    const i = COLORS.findIndex((c) => c.value === color);
    const n = to ?? (i + dir + COLORS.length) % COLORS.length;
    setColor(COLORS[n].value);
    (e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[n])?.focus();
  };

  const position = steps.indexOf(step);

  return (
    <div className="kbackdrop ksheet-layer konb-layer" data-side="center">
      <style>{FIRST_RUN_CSS}</style>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Welcome to Kanbo" className="ksheet konb">
        <span className="ksheet-handle" aria-hidden="true" />
        <div className="konb-body">
          {step === 0 && (
            <div key="welcome" className="konb-step konb-intro">
              <span className="konb-mark" aria-hidden="true"><KanboLogo size={40} /></span>
              <div className="konb-head">
                <h2 className="konb-title">{hasName ? `Welcome, ${profFirst.trim()}` : "Welcome to Kanbo"}</h2>
                <p className="konb-lede">
                  {hasName ? "One quick thing before you dive in: set up your first project." : "The to-do list that plans your day. Let's get you set up in under a minute."}
                </p>
              </div>
              <div className="konb-acts" data-stack="">
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <Button autoFocus data-autofocus variant="hero" size="lg" full iconRight="arrowRight" onClick={() => go(hasName ? 2 : 1)}>Get started</Button>
                <Button variant="ghost" onClick={onFinish}>Skip for now</Button>
              </div>
            </div>
          )}

          {step === 1 && (
            <form key="name" className="konb-step" onSubmit={(e) => { e.preventDefault(); if (firstName.trim() && !busy) void saveName(); }}>
              <div className="konb-head">
                <h2 className="konb-title">What should we call you?</h2>
                <p className="konb-lede">This is how teammates will see you on tasks, comments and assignments.</p>
              </div>
              <div className="konb-fields">
                <div className="konb-field">
                  <label htmlFor="kanbo-onb2-first">First name</label>
                  {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                  <input id="kanbo-onb2-first" className="konb-input" autoFocus data-autofocus value={firstName} onChange={editName(setFirstName)} placeholder="First name" autoComplete="given-name" />
                </div>
                <div className="konb-field">
                  <label htmlFor="kanbo-onb2-last">Last name</label>
                  <input id="kanbo-onb2-last" className="konb-input" value={lastName} onChange={editName(setLastName)} placeholder="Last name" autoComplete="family-name" />
                </div>
              </div>
              <div className="konb-acts">
                <Button variant="ghost" size="lg" onClick={() => go(2)}>Skip</Button>
                <Button type="submit" variant="primary" size="lg" iconRight="arrowRight" disabled={!firstName.trim()} loading={busy} className="konb-grow">
                  {busy ? "Saving…" : "Continue"}
                </Button>
              </div>
            </form>
          )}

          {step === 2 && (
            <form key="project" className="konb-step" onSubmit={(e) => { e.preventDefault(); if (projName.trim()) createProject(); }}>
              <div className="konb-head">
                <h2 className="konb-title">Create your first project</h2>
                <p className="konb-lede">Projects keep related tasks together. You can add more later.</p>
              </div>
              <div className="konb-field">
                <label htmlFor="kanbo-onb2-project">Project name</label>
                <div className="konb-projrow">
                  <button ref={emojiRef} type="button" className="konb-emoji" onClick={() => setPickerOpen((v) => !v)}
                    aria-label={`Project icon: ${emoji}. Choose another`} aria-haspopup="dialog" aria-expanded={pickerOpen} data-tip="Choose an icon">
                    <span aria-hidden="true">{emoji}</span>
                  </button>
                  {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                  <input id="kanbo-onb2-project" className="konb-input" autoFocus data-autofocus value={projName} onChange={(e) => setProjName(e.target.value)}
                    placeholder="e.g. Website redesign" autoComplete="off" />
                </div>
              </div>
              <Popover open={pickerOpen} anchorRef={emojiRef} onClose={() => setPickerOpen(false)} role="dialog" label="Choose a project icon" minWidth={0}
                className="konb-emoji-pop" style={{ padding: 0, borderRadius: "var(--r-lg, 12px)", background: "var(--surface-raised)", boxShadow: "var(--e2, var(--shadow-lg))" }}>
                <EmojiPicker height={188} onPick={(e) => { setEmoji(e); setPickerOpen(false); }} />
              </Popover>
              <div className="konb-field" role="group" aria-labelledby="kanbo-onb2-colour">
                <span id="kanbo-onb2-colour" className="konb-label">Colour</span>
                <div role="radiogroup" aria-label="Project colour" className="konb-swatches" onKeyDown={onSwatchKey}>
                  {COLORS.map((c) => {
                    const on = color === c.value;
                    return (
                      <button key={c.value} type="button" role="radio" aria-checked={on} aria-label={c.name} data-tip={c.name}
                        tabIndex={on ? 0 : -1} className="konb-swatch" onClick={() => setColor(c.value)}
                        style={{ "--sw": projectPaint(c.value).solid } as React.CSSProperties}>
                        {on && <Icon name="check" size={14} sw={2.5} />}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="konb-acts">
                <Button variant="ghost" size="lg" onClick={() => go(3)}>Skip</Button>
                <Button type="submit" variant="primary" size="lg" iconRight="arrowRight" disabled={!projName.trim()} className="konb-grow">Create project</Button>
              </div>
            </form>
          )}

          {step === 3 && (
            <TourHandover key="handover" name={greetName || undefined} onShowMeAround={() => finishWith("start")} onSkip={() => finishWith("skip")} />
          )}
        </div>

        <div className="konb-dots" aria-hidden="true">
          {steps.map((i) => <span key={i} className="konb-dot" data-on={i === step || undefined} />)}
        </div>
        <p className="sr-only" role="status">{moved ? `Step ${position + 1} of ${steps.length}: ${STEP_TITLES[step]}` : ""}</p>
      </div>
    </div>
  );
}

/* Shared by the welcome and onboarding sheets. New Paper & Navy tokens are
   read with a fallback to today's, so this looks right either side of P01. */
export const FIRST_RUN_CSS = `
@media (min-width: 860px) {
  .ksheet-layer.konb-layer { align-items: center; padding: 24px; }
}
.ksheet.konb { --sheet-w: 480px; overflow: hidden; }
.konb-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 32px 32px 8px; }
.konb-body[data-solo] { padding-bottom: 32px; }
.konb-step { display: flex; flex-direction: column; gap: 24px; animation: konbIn var(--d-3, 240ms) var(--ease); }
.konb-intro { display: flex; flex-direction: column; align-items: center; gap: 20px; text-align: center; }
@keyframes konbIn { from { opacity: 0.35; translate: 0 4px; } }
.konb-mark { display: grid; place-items: center; }
.konb-head { display: grid; gap: 6px; width: 100%; }
.konb-title { margin: 0; font: 600 20px/28px var(--font-head, var(--font-display)); letter-spacing: -0.012em; color: var(--ink); text-wrap: balance; }
.konb-lede { margin: 0; font: 400 15px/24px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.konb-intro .konb-lede { max-width: 360px; margin: 0 auto; }

/* fields */
.konb-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.konb-field { display: grid; gap: 6px; min-width: 0; text-align: left; }
.konb-field > label, .konb-label { font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.konb-input {
  width: 100%; min-width: 0; height: 40px; padding: 0 12px; border-radius: var(--r-md, 8px);
  border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface)); color: var(--ink);
  font: 500 14px/20px var(--font-ui, var(--font-display)); transition: border-color var(--d-1, 90ms) var(--ease);
}
.konb-input:hover:not(:focus) { border-color: var(--field-border-hover, var(--hairline-strong)); }
.konb-input::placeholder { color: var(--ink-4); opacity: 1; }
.konb-input[aria-invalid="true"] { border-color: var(--signal, var(--prio-urgent)); }
.konb-err { margin: -12px 0 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--signal, var(--prio-urgent)); text-align: left; }
.konb-projrow { display: flex; gap: 8px; }
.konb-emoji {
  display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; padding: 0; border-radius: var(--r-md, 8px);
  border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface)); cursor: pointer;
  font-size: 20px; line-height: 1; transition: border-color var(--d-1, 90ms) var(--ease), background var(--d-1, 90ms) var(--ease);
}
.konb-emoji:hover, .konb-emoji[aria-expanded="true"] { border-color: var(--field-border-hover, var(--hairline-strong)); background: linear-gradient(var(--fill-1), var(--fill-1)), var(--field-bg, var(--surface)); }
/* the picker keeps the popover's frame, not a second one of its own */
.konb-emoji-pop > div { border: 0 !important; border-radius: 0 !important; box-shadow: none !important; background: transparent !important; }
.konb-swatches { display: flex; flex-wrap: wrap; gap: 10px; padding: 4px; }
.konb-swatch {
  position: relative; display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%;
  cursor: pointer; background: var(--sw); color: oklch(1 0 0); box-shadow: 0 0 0 1px oklch(0 0 0 / 0.08) inset;
  transition: box-shadow var(--d-1, 90ms) var(--ease);
}
.konb-swatch svg { filter: drop-shadow(0 1px 1px oklch(0 0 0 / 0.35)); }
.konb-swatch:hover:not([aria-checked="true"]) { box-shadow: 0 0 0 2px var(--surface-raised), 0 0 0 4px color-mix(in oklch, var(--sw) 45%, transparent); }
.konb-swatch[aria-checked="true"] { box-shadow: 0 0 0 2px var(--surface-raised), 0 0 0 4px var(--sw); }
.konb-swatch:focus-visible { outline-offset: 5px; }

/* actions */
.konb-acts { display: flex; gap: 8px; width: 100%; }
.konb-acts[data-stack] { flex-direction: column; align-items: center; gap: 4px; }
.konb-acts .konb-grow { flex: 1; }
.konb-acts[data-stack] .kbtn[data-variant="ghost"] { color: var(--ink-3); }

/* the hand-over to the tour */
.konb-tourmark { width: 52px; height: 52px; border-radius: 14px; background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--hairline); color: var(--accent-text, var(--accent)); }
.konb-foot { margin: -8px 0 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }

/* progress */
.konb-dots { display: flex; justify-content: center; gap: 6px; flex-shrink: 0; padding: 16px 0 20px; }
.konb-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--hairline-strong); transition: width var(--d-2, 160ms) var(--ease), background var(--d-2, 160ms) var(--ease); }
.konb-dot[data-on] { width: 18px; background: var(--accent-fill, var(--accent)); }

@media (max-width: 859px) {
  .konb-body { padding: 28px 16px 4px; }
  .konb-body[data-solo] { padding-bottom: max(20px, env(safe-area-inset-bottom, 0px)); }
  .konb-dots { padding: 12px 0 16px; }
  /* 16px stops iOS zooming into a field on focus */
  .konb-input { font-size: 16px; }
}
@media (max-width: 359px) { .konb-fields { grid-template-columns: 1fr; } }
@media (pointer: coarse) {
  .konb-swatch::before { content: ""; position: absolute; left: 50%; top: 50%; width: 40px; height: 40px; translate: -50% -50%; }
}
@media (prefers-reduced-motion: reduce) {
  .konb-step { animation: none !important; }
  .konb-dot, .konb-swatch, .konb-emoji { transition: none; }
}
`;
