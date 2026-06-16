/* ============================================================
   KANBO — first-run welcome (shown once to brand-new, empty accounts)
   ============================================================ */
import { Icon, KanboLogo } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { IconName } from "./../data/types";

const STEPS: { icon: IconName; title: string; body: string }[] = [
  { icon: "plus", title: "Capture anything", body: "Type a task in the bar at the top — Kanbo understands “Draft deck 90m deep work today”." },
  { icon: "calendarPlus", title: "Plan your day", body: "Auto-plan lays your tasks around your meetings, deep work up front." },
  { icon: "clock", title: "Focus & finish", body: "Start a focus block and watch the work get done." },
];

export function WelcomeModal({ open, onClose, onCreateTask, name }: {
  open: boolean;
  onClose: () => void;
  onCreateTask: () => void;
  name?: string;
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  if (!open) return null;
  const first = name?.trim().split(/\s+/)[0];
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 130, background: "color-mix(in oklch, var(--bg-deep) 62%, transparent)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18, overflowY: "auto" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Welcome to Kanbo" className="glass anim-scalein" style={{ width: 460, maxWidth: "94vw", borderRadius: 22, padding: 28, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", textAlign: "center" }}>
        <div style={{ display: "inline-grid", placeItems: "center", marginBottom: 16 }}><KanboLogo size={40} /></div>
        <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 6 }}>
          Welcome to Kanbo{first ? `, ${first}` : ""} 👋
        </h2>
        <p style={{ fontSize: 14, color: "var(--ink-3)", margin: "0 auto 22px", maxWidth: 360, lineHeight: 1.55 }}>
          Your clean slate is ready. Here's the rhythm Kanbo is built around:
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

        <button className="btn btn-accent" onClick={() => { onClose(); onCreateTask(); }} style={{ width: "100%", justifyContent: "center", padding: "12px 15px" }}>
          <Icon name="plus" size={16} /> Create your first task
        </button>
        <button onClick={onClose} style={{ marginTop: 12, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 13, fontFamily: "var(--font-display)" }}>
          I'll explore on my own
        </button>
      </div>
    </div>
  );
}
