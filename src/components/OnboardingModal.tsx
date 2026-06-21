/* ============================================================
   KANBO — first-run onboarding: welcome → your name → first project.
   Shown once to brand-new accounts (no real projects yet).
   ============================================================ */
import { useState } from "react";
import { Icon, KanboLogo, EmojiPicker } from "./primitives";
import type { Profile } from "../data/types";
import type { NewProject } from "../data/store";

const COLORS = ["oklch(0.74 0.14 230)", "oklch(0.74 0.16 305)", "oklch(0.75 0.13 155)", "oklch(0.78 0.15 70)", "oklch(0.66 0.2 20)", "oklch(0.78 0.1 45)"];

export function OnboardingModal({ open, profile, workspaceId, onSaveProfile, onCreateProject, onFinish }: {
  open: boolean;
  profile: Profile | null;
  workspaceId: string | null;
  onSaveProfile: (d: { firstName: string; lastName: string; pronouns: string; avatarUrl: string | null }) => Promise<void>;
  onCreateProject: (p: NewProject) => void;
  onFinish: () => void;
}) {
  const [step, setStep] = useState(0);
  const [firstName, setFirstName] = useState(profile?.firstName || "");
  const [lastName, setLastName] = useState(profile?.lastName || "");
  const [projName, setProjName] = useState("");
  const [emoji, setEmoji] = useState("🚀");
  const [color, setColor] = useState(COLORS[0]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const saveName = async () => {
    setBusy(true);
    try { await onSaveProfile({ firstName: firstName.trim(), lastName: lastName.trim(), pronouns: profile?.pronouns || "", avatarUrl: profile?.avatarUrl ?? null }); } catch { /* non-blocking */ }
    setBusy(false); setStep(2);
  };
  const createProject = () => {
    const n = projName.trim();
    if (n) onCreateProject({ name: n, emoji, color, workspaceId });
    setStep(3);
  };

  const dots = (
    <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 4 }}>
      {[0, 1, 2, 3].map((i) => <span key={i} style={{ width: i === step ? 18 : 6, height: 6, borderRadius: 99, background: i === step ? "var(--accent)" : "var(--hairline-strong)", transition: "all .2s var(--ease)" }} />)}
    </div>
  );

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 95, background: "color-mix(in oklch, var(--bg-deep) 65%, transparent)", backdropFilter: "blur(4px)" }} />
      <div role="dialog" aria-modal="true" aria-label="Welcome to Kanbo" className="glass anim-scalein" style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 96, width: 460, maxWidth: "94vw", padding: 28, borderRadius: 22, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", gap: 18 }}>

        {step === 0 && (
          <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 14 }}>
            <span style={{ alignSelf: "center" }}><KanboLogo size={48} /></span>
            <div>
              <h2 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 6px" }}>Welcome to Kanbo</h2>
              <p style={{ fontSize: 14, color: "var(--ink-3)", lineHeight: 1.6, margin: 0 }}>The to-do list that plans your day. Let's get you set up in under a minute.</p>
            </div>
            <button className="btn btn-accent" onClick={() => setStep(1)} style={{ justifyContent: "center", marginTop: 4 }}>Get started <Icon name="arrowRight" size={15} /></button>
            <button className="btn btn-ghost" onClick={onFinish} style={{ justifyContent: "center", color: "var(--ink-4)" }}>Skip for now</button>
          </div>
        )}

        {step === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <h2 style={{ fontSize: 19, fontWeight: 700, margin: "0 0 6px" }}>What should we call you?</h2>
              <p style={{ fontSize: 13.5, color: "var(--ink-4)", margin: 0 }}>This is how teammates will see you.</p>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input autoFocus value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" aria-label="First name"
                style={{ flex: 1, height: 44, padding: "0 14px", borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 15, outline: "none" }} />
              <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" aria-label="Last name"
                style={{ flex: 1, height: 44, padding: "0 14px", borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 15, outline: "none" }} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-ghost" onClick={() => setStep(2)} style={{ justifyContent: "center" }}>Skip</button>
              <button className="btn btn-accent" onClick={saveName} disabled={busy || !firstName.trim()} style={{ flex: 1, justifyContent: "center", opacity: firstName.trim() ? 1 : 0.5 }}>{busy ? "Saving…" : "Continue"} <Icon name="arrowRight" size={15} /></button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <h2 style={{ fontSize: 19, fontWeight: 700, margin: "0 0 6px" }}>Create your first project</h2>
              <p style={{ fontSize: 13.5, color: "var(--ink-4)", margin: 0 }}>Projects keep related tasks together. You can add more later.</p>
            </div>
            <div style={{ display: "flex", gap: 10, position: "relative" }}>
              <button onClick={() => setPickerOpen((v) => !v)} title="Choose icon" style={{ width: 48, height: 44, borderRadius: 11, fontSize: 20, border: pickerOpen ? "1px solid var(--accent)" : "1px solid var(--hairline)", background: "var(--surface)", cursor: "pointer" }}>{emoji}</button>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input autoFocus value={projName} onChange={(e) => setProjName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createProject(); }} placeholder="e.g. Website redesign" aria-label="Project name"
                style={{ flex: 1, height: 44, padding: "0 14px", borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 15, outline: "none" }} />
              {pickerOpen && <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 5 }}><EmojiPicker height={180} onPick={(e) => { setEmoji(e); setPickerOpen(false); }} /></div>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {COLORS.map((c) => <button key={c} onClick={() => setColor(c)} aria-label="Colour" style={{ width: 28, height: 28, borderRadius: 99, background: c, border: "none", cursor: "pointer", boxShadow: color === c ? "0 0 0 2px var(--bg), 0 0 0 4px var(--accent)" : "none" }} />)}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-ghost" onClick={() => setStep(3)} style={{ justifyContent: "center" }}>Skip</button>
              <button className="btn btn-accent" onClick={createProject} disabled={!projName.trim()} style={{ flex: 1, justifyContent: "center", opacity: projName.trim() ? 1 : 0.5 }}>Create project <Icon name="arrowRight" size={15} /></button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 14 }}>
            <span style={{ alignSelf: "center", display: "grid", placeItems: "center", width: 54, height: 54, borderRadius: 16, background: "var(--accent-dim)", color: "var(--accent)" }}><Icon name="check" size={28} sw={2.4} /></span>
            <div>
              <h2 style={{ fontSize: 21, fontWeight: 700, margin: "0 0 6px" }}>You're all set{firstName ? `, ${firstName}` : ""} 🎉</h2>
              <p style={{ fontSize: 14, color: "var(--ink-3)", lineHeight: 1.6, margin: 0 }}>Capture a task, plan your day, or invite your team — your dashboard has a quick checklist to guide you.</p>
            </div>
            <button className="btn btn-accent" onClick={onFinish} style={{ justifyContent: "center", marginTop: 4 }}>Go to my dashboard</button>
          </div>
        )}

        {dots}
      </div>
    </>
  );
}
