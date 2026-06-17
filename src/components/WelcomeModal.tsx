/* ============================================================
   KANBO — first-run onboarding (shown once to brand-new accounts).
   Two guided steps: (1) build your profile — name is required so the
   account is more than an email and teammates/assignment notifications
   show a real person; (2) the rhythm tour.
   ============================================================ */
import { useState, useEffect } from "react";
import { Icon, KanboLogo } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { IconName } from "./../data/types";

const STEPS: { icon: IconName; title: string; body: string }[] = [
  { icon: "plus", title: "Capture anything", body: "Type a task in the bar at the top — Kanbo understands “Draft deck 90m deep work today”." },
  { icon: "calendarPlus", title: "Plan your day", body: "Auto-plan lays your tasks around your meetings, deep work up front." },
  { icon: "clock", title: "Focus & finish", body: "Start a focus block and watch the work get done." },
];

const inputStyle: React.CSSProperties = {
  width: "100%", height: 44, padding: "0 13px", borderRadius: 11, border: "1px solid var(--hairline)",
  background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 14, outline: "none",
};
const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-3)", marginBottom: 6, letterSpacing: ".01em", textAlign: "left" };

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
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  const [phase, setPhase] = useState<"profile" | "tour">("profile");
  const [firstName, setFirstName] = useState(initialFirst ?? "");
  const [lastName, setLastName] = useState(initialLast ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // a returning, name-less account jumps straight in; a prefilled one is welcome to confirm
      setPhase("profile");
      setFirstName(initialFirst ?? "");
      setLastName(initialLast ?? "");
      setError(null);
      setSaving(false);
    }
  }, [open, initialFirst, initialLast]);

  if (!open) return null;

  const greet = name?.trim() && !name.includes("@") ? `, ${name.trim().split(/\s+/)[0]}` : "";

  const continueToTour = async () => {
    const f = firstName.trim(), l = lastName.trim();
    if (!f) { setError("Add your first name so we can continue."); return; }
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
    <div style={{ position: "fixed", inset: 0, zIndex: 130, background: "color-mix(in oklch, var(--bg-deep) 62%, transparent)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18, overflowY: "auto" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Welcome to Kanbo" className="glass anim-scalein" style={{ width: 460, maxWidth: "94vw", borderRadius: 22, padding: 28, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", textAlign: "center" }}>
        <div style={{ display: "inline-grid", placeItems: "center", marginBottom: 16 }}><KanboLogo size={40} /></div>

        {phase === "profile" ? (
          <>
            <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 6 }}>
              Welcome to Kanbo{greet} 👋
            </h2>
            <p style={{ fontSize: 14, color: "var(--ink-3)", margin: "0 auto 22px", maxWidth: 360, lineHeight: 1.55 }}>
              Let's set up your profile. Add your name so teammates — and anyone you work with on shared tasks — see a person, not an email address.
            </p>

            <form onSubmit={(e) => { e.preventDefault(); continueToTour(); }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 8 }}>
                <div>
                  <label htmlFor="kanbo-onb-first" style={labelStyle}>First name</label>
                  {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                  <input id="kanbo-onb-first" autoFocus value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Daniel" style={inputStyle} />
                </div>
                <div>
                  <label htmlFor="kanbo-onb-last" style={labelStyle}>Surname</label>
                  <input id="kanbo-onb-last" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Chappell" style={inputStyle} />
                </div>
              </div>

              {error && <div role="alert" style={{ fontSize: 12.5, color: "var(--prio-urgent)", textAlign: "left", margin: "4px 2px 0" }}>{error}</div>}

              <button type="submit" className="btn btn-accent" disabled={saving || !firstName.trim()} style={{ width: "100%", justifyContent: "center", padding: "12px 15px", marginTop: 18, opacity: saving || !firstName.trim() ? 0.6 : 1 }}>
                {saving ? "Saving…" : <>Continue <Icon name="arrowRight" size={16} /></>}
              </button>
            </form>
            {canSkip && (
              <button onClick={onClose} style={{ marginTop: 12, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 13, fontFamily: "var(--font-display)" }}>
                Skip for now
              </button>
            )}
          </>
        ) : (
          <>
            <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 6 }}>
              You're all set{firstName.trim() ? `, ${firstName.trim()}` : ""} 🎉
            </h2>
            <p style={{ fontSize: 14, color: "var(--ink-3)", margin: "0 auto 22px", maxWidth: 360, lineHeight: 1.55 }}>
              Here's the rhythm Kanbo runs on:
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 12, textAlign: "left", marginBottom: 24 }}>
              {STEPS.map((s) => (
                <div key={s.title} style={{ display: "flex", alignItems: "flex-start", gap: 13, padding: "12px 14px", borderRadius: 14, background: "var(--surface)", border: "1px solid var(--hairline)" }}>
                  <span style={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 10, flexShrink: 0, background: "var(--accent-dim)", color: "var(--accent)" }}><Icon name={s.icon} size={17} /></span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{s.title}</div>
                    <div style={{ fontSize: 12.5, color: "var(--ink-4)", lineHeight: 1.5 }}>{s.body}</div>
                  </div>
                </div>
              ))}
            </div>

            <button className="btn btn-accent" onClick={onClose} style={{ width: "100%", justifyContent: "center", padding: "12px 15px" }}>
              <Icon name="check" size={16} /> Start using Kanbo
            </button>
          </>
        )}
      </div>
    </div>
  );
}
