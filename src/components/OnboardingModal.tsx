/* ============================================================
   KANBO — first-run onboarding: welcome → your name → first project.
   Shown once to brand-new accounts (no real projects yet). The name
   step is skipped when the profile already has a first name (e.g. it
   was just entered in the welcome modal).
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { Icon, KanboLogo, EmojiPicker } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { TextField } from "../auth/AuthFields";
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
  const [color, setColor] = useState(COLORS[0].value);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // once the person types, the profile no longer overwrites their edits
  const nameEdited = useRef(false);

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
  const escRef = useRef(onEscape);
  escRef.current = onEscape;
  const trapRef = useFocusTrap<HTMLDivElement>(open, onEscape);

  // For a brand-new account the welcome modal can open on top of this one.
  // When it closes, its focus trap hands focus back to an element that no
  // longer exists and focus drops to <body> — outside this dialog, where Tab
  // and Escape do nothing. While this is the only modal, pull focus back in.
  const orphaned = () => {
    const el = trapRef.current, a = document.activeElement;
    if (!el || (a && a !== document.body && a.isConnected)) return null;
    return Array.from(document.querySelectorAll('[aria-modal="true"]')).every((d) => d === el) ? el : null;
  };
  useEffect(() => {
    if (!open) return;
    orphaned()?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" && e.key !== "Escape") return;
      const el = orphaned();
      if (!el) return;
      e.preventDefault();
      if (e.key === "Escape") escRef.current();
      else el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
  const editName = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => { nameEdited.current = true; set(e.target.value); };
  const greetName = firstName.trim();

  const dots = (
    <div aria-hidden="true" style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 4 }}>
      {steps.map((i) => <span key={i} style={{ width: i === step ? 18 : 6, height: 6, borderRadius: 99, background: i === step ? "var(--accent)" : "var(--hairline-strong)", transition: "all .2s var(--ease)" }} />)}
    </div>
  );

  return (
    <div className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 95, background: "color-mix(in oklch, var(--bg-deep) 65%, transparent)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18, overflowY: "auto" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Welcome to Kanbo" className="glass anim-scalein" style={{ position: "relative", zIndex: 96, width: 460, maxWidth: "94vw", margin: "auto", padding: 28, borderRadius: 22, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", gap: 18 }}>

        {step === 0 && (
          <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 14 }}>
            <span style={{ alignSelf: "center" }}><KanboLogo size={48} /></span>
            <div>
              <h2 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 6px" }}>{hasName ? `Welcome, ${profFirst.trim()}` : "Welcome to Kanbo"}</h2>
              <p style={{ fontSize: 14, color: "var(--ink-3)", lineHeight: 1.6, margin: 0 }}>
                {hasName ? "One quick thing before you dive in: set up your first project." : "The to-do list that plans your day. Let’s get you set up in under a minute."}
              </p>
            </div>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <button autoFocus data-autofocus className="btn btn-accent" onClick={() => setStep(hasName ? 2 : 1)} style={{ justifyContent: "center", marginTop: 4 }}>Get started <Icon name="arrowRight" size={15} /></button>
            <button className="btn btn-ghost" onClick={onFinish} style={{ justifyContent: "center", color: "var(--ink-4)" }}>Skip for now</button>
          </div>
        )}

        {step === 1 && (
          <form onSubmit={(e) => { e.preventDefault(); if (firstName.trim() && !busy) saveName(); }} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <h2 style={{ fontSize: 19, fontWeight: 700, margin: "0 0 6px" }}>What should we call you?</h2>
              <p style={{ fontSize: 13.5, color: "var(--ink-4)", margin: 0 }}>This is how teammates will see you.</p>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <TextField autoFocus data-autofocus value={firstName} onChange={editName(setFirstName)} placeholder="First name" aria-label="First name" autoComplete="given-name" style={{ flex: 1, minWidth: 0, fontSize: 15 }} />
              <TextField value={lastName} onChange={editName(setLastName)} placeholder="Surname" aria-label="Surname" autoComplete="family-name" style={{ flex: 1, minWidth: 0, fontSize: 15 }} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setStep(2)} style={{ justifyContent: "center" }}>Skip</button>
              <button type="submit" className="btn btn-accent" disabled={busy || !firstName.trim()} style={{ flex: 1, justifyContent: "center", opacity: firstName.trim() ? 1 : 0.5 }}>{busy ? "Saving…" : "Continue"} <Icon name="arrowRight" size={15} /></button>
            </div>
          </form>
        )}

        {step === 2 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <h2 style={{ fontSize: 19, fontWeight: 700, margin: "0 0 6px" }}>Create your first project</h2>
              <p style={{ fontSize: 13.5, color: "var(--ink-4)", margin: 0 }}>Projects keep related tasks together. You can add more later.</p>
            </div>
            <div style={{ display: "flex", gap: 10, position: "relative" }}>
              <button type="button" onClick={() => setPickerOpen((v) => !v)} aria-label={`Project icon: ${emoji}. Choose another`} aria-expanded={pickerOpen} title="Choose icon" style={{ width: 48, height: 44, flexShrink: 0, borderRadius: 11, fontSize: 20, border: pickerOpen ? "1px solid var(--accent)" : "1px solid var(--field-border, var(--hairline))", background: "var(--field-bg, var(--surface))", cursor: "pointer" }}>{emoji}</button>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <TextField autoFocus data-autofocus value={projName} onChange={(e) => setProjName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createProject(); }} placeholder="e.g. Website redesign" aria-label="Project name" style={{ flex: 1, minWidth: 0, fontSize: 15 }} />
              {pickerOpen && <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 5 }}><EmojiPicker height={180} onPick={(e) => { setEmoji(e); setPickerOpen(false); }} /></div>}
            </div>
            <div role="radiogroup" aria-label="Project colour" style={{ display: "flex", gap: 8 }}>
              {COLORS.map((c) => (
                <button key={c.value} type="button" role="radio" aria-checked={color === c.value} aria-label={c.name} title={c.name} onClick={() => setColor(c.value)}
                  style={{ width: 28, height: 28, borderRadius: 99, background: c.value, border: "none", cursor: "pointer", boxShadow: color === c.value ? "0 0 0 2px var(--bg), 0 0 0 4px var(--accent)" : "none" }} />
              ))}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setStep(3)} style={{ justifyContent: "center" }}>Skip</button>
              <button type="button" className="btn btn-accent" onClick={createProject} disabled={!projName.trim()} style={{ flex: 1, justifyContent: "center", opacity: projName.trim() ? 1 : 0.5 }}>Create project <Icon name="arrowRight" size={15} /></button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 14 }}>
            <span style={{ alignSelf: "center", display: "grid", placeItems: "center", width: 54, height: 54, borderRadius: 16, background: "var(--accent-dim)", color: "var(--accent)" }}><Icon name="check" size={28} sw={2.4} /></span>
            <div>
              <h2 style={{ fontSize: 21, fontWeight: 700, margin: "0 0 6px" }}>You’re all set{greetName ? `, ${greetName}` : ""} 🎉</h2>
              <p style={{ fontSize: 14, color: "var(--ink-3)", lineHeight: 1.6, margin: 0 }}>Capture a task, plan your day, or invite your team — your dashboard has a quick checklist to guide you.</p>
            </div>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <button autoFocus data-autofocus className="btn btn-accent" onClick={onFinish} style={{ justifyContent: "center", marginTop: 4 }}>Go to my dashboard</button>
          </div>
        )}

        {dots}
      </div>
    </div>
  );
}
