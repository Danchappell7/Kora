/* ============================================================
   KANBO — first-run welcome (shown once to brand-new accounts).
   Two guided steps: (1) build your profile — name is required so the
   account is more than an email and teammates/assignment notifications
   show a real person; (2) the rhythm Kanbo runs on.
   Shares its sheet and styles with OnboardingModal.
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { KanboLogo, Button } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { FIRST_RUN_CSS, PlaceList } from "./OnboardingModal";
import type { IconName } from "./../data/types";

const STEPS: { id: string; icon: IconName; title: string; body: string; key: string }[] = [
  { id: "capture", icon: "plus", title: "Capture anything", body: "Press Q and type it the way you'd say it: “Draft deck 90m deep work today”.", key: "Q" },
  { id: "plan", icon: "sun", title: "Plan your day", body: "Today sketches a plan around your meetings. Plan my day makes it yours.", key: "P" },
  { id: "focus", icon: "play", title: "Focus and finish", body: "Start a focus block and let the timer keep you on one thing.", key: "F" },
];

export function WelcomeModal({ open, onClose, onSaveProfile, name, initialFirst, initialLast, canSkip = false }: {
  open: boolean;
  onClose: () => void;
  onSaveProfile: (firstName: string, lastName: string) => Promise<void>;
  name?: string;
  initialFirst?: string;
  initialLast?: string;
  /** allow dismissing the profile step without entering a name (only when one already exists) */
  canSkip?: boolean;
}) {
  const [phase, setPhase] = useState<"profile" | "tour">("profile");
  const [firstName, setFirstName] = useState(initialFirst ?? "");
  const [lastName, setLastName] = useState(initialLast ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  // The name step is required: Escape (or any close) with no name must not
  // dismiss it — App persists a close as "welcomed" and would never ask again.
  // Once a name exists (canSkip) or has been saved (tour), Escape closes.
  const onEscape = () => {
    if (phase === "tour" || canSkip) { onClose(); return; }
    setError("Add your first name so we can continue.");
    firstRef.current?.focus();
  };
  const trapRef = useFocusTrap<HTMLDivElement>(open, onEscape);

  const edited = useRef(false);
  const wasOpen = useRef(false);

  // reset only when the modal (re)opens — NOT when the profile changes, or
  // saving the name (which updates the profile) would bounce the person from
  // the tour back to the name step
  useEffect(() => {
    if (open && !wasOpen.current) {
      // a returning, name-less account jumps straight in; a prefilled one is welcome to confirm
      setPhase("profile");
      setFirstName(initialFirst ?? "");
      setLastName(initialLast ?? "");
      setError(null);
      setSaving(false);
      edited.current = false;
    }
    wasOpen.current = open;
  }, [open, initialFirst, initialLast]);
  // the profile often loads after the modal opens: fill the name in until they type
  useEffect(() => {
    if (!open || phase !== "profile" || edited.current) return;
    setFirstName(initialFirst ?? "");
    setLastName(initialLast ?? "");
  }, [open, phase, initialFirst, initialLast]);

  if (!open) return null;

  const greet = name?.trim() && !name.includes("@") ? `, ${name.trim().split(/\s+/)[0]}` : "";
  const missing = !!error && !firstName.trim();

  const continueToTour = async () => {
    const f = firstName.trim(), l = lastName.trim();
    if (!f) { setError("Add your first name so we can continue."); firstRef.current?.focus(); return; }
    setSaving(true); setError(null);
    try {
      await onSaveProfile(f, l);
      setPhase("tour");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your name. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    // above the onboarding sheet it can open over (see OnboardingModal)
    <div className="kbackdrop ksheet-layer konb-layer" data-side="center" style={{ zIndex: 130 }}>
      <style>{FIRST_RUN_CSS}</style>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Welcome to Kanbo" className="ksheet konb">
        <span className="ksheet-handle" aria-hidden="true" />
        <div className="konb-body">
          {phase === "profile" ? (
            <form key="profile" className="konb-step" noValidate onSubmit={(e) => { e.preventDefault(); void continueToTour(); }}>
              <div className="konb-intro">
                <span className="konb-mark" aria-hidden="true"><KanboLogo size={40} /></span>
                <div className="konb-head">
                  <h2 className="konb-title">Welcome to Kanbo{greet}</h2>
                  <p className="konb-lede">Let's set up your profile. Add your name so the people you work with see a person, not an email address.</p>
                </div>
              </div>

              <div className="konb-fields">
                <div className="konb-field">
                  <label htmlFor="kanbo-onb-first">First name</label>
                  {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                  <input ref={firstRef} id="kanbo-onb-first" className="konb-input" autoFocus data-autofocus value={firstName}
                    onChange={(e) => { edited.current = true; setFirstName(e.target.value); if (error) setError(null); }}
                    placeholder="First name" autoComplete="given-name" aria-invalid={missing || undefined} aria-describedby={error ? "kanbo-onb-error" : undefined} />
                </div>
                <div className="konb-field">
                  <label htmlFor="kanbo-onb-last">Last name</label>
                  <input id="kanbo-onb-last" className="konb-input" value={lastName}
                    onChange={(e) => { edited.current = true; setLastName(e.target.value); }} placeholder="Last name" autoComplete="family-name" />
                </div>
              </div>
              {error && <p id="kanbo-onb-error" role="alert" className="konb-err">{error}</p>}

              <div className="konb-acts" data-stack="">
                <Button type="submit" variant="primary" size="lg" full iconRight="arrowRight" disabled={!firstName.trim()} loading={saving}>
                  {saving ? "Saving…" : "Continue"}
                </Button>
                {canSkip && <Button variant="ghost" onClick={onClose}>Skip for now</Button>}
              </div>
            </form>
          ) : (
            <div key="tour" className="konb-step">
              <div className="konb-head">
                <h2 className="konb-title">You're all set{firstName.trim() ? `, ${firstName.trim()}` : ""}</h2>
                <p className="konb-lede">Here's the rhythm Kanbo runs on.</p>
              </div>
              <PlaceList rows={STEPS.map((s) => ({ id: s.id, icon: s.icon, name: s.title, line: s.body, keys: [s.key] }))} />
              <div className="konb-acts" data-stack="">
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <Button autoFocus data-autofocus variant="primary" size="lg" full icon="check" onClick={onClose}>Start using Kanbo</Button>
              </div>
            </div>
          )}
        </div>
        <div className="konb-dots" aria-hidden="true">
          <span className="konb-dot" data-on={phase === "profile" || undefined} />
          <span className="konb-dot" data-on={phase === "tour" || undefined} />
        </div>
        <p className="sr-only" role="status">{phase === "tour" ? "Step 2 of 2: the rhythm Kanbo runs on" : ""}</p>
      </div>
    </div>
  );
}
