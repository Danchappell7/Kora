/* ============================================================
   KANBO — billing UI: trial banner, plan picker, paywall
   ============================================================ */
import { Icon, KanboLogo } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { Plan, Subscription } from "../data/types";

const PLANS: { id: Plan; name: string; price: string; unit: string; blurb: string; features: string[] }[] = [
  { id: "personal", name: "Personal", price: "£8", unit: "/month", blurb: "For focused individual work.", features: ["Unlimited tasks & projects", "Plan-my-day & AI prioritize", "All views, files & reminders"] },
  { id: "team", name: "Team", price: "£12", unit: "/user / month", blurb: "For teams that ship together.", features: ["Everything in Personal", "Shared workspaces & invites", "Assign work & track workload"] },
];

// Billing is OFF by default (free testing/feedback phase): nobody is asked to
// pay and no trial countdown shows. Flip VITE_BILLING_ENABLED=true to turn the
// 7-day trial + paywall back on.
export const BILLING_ENABLED = import.meta.env.VITE_BILLING_ENABLED === "true";

export function trialDaysLeft(sub: Subscription | null): number {
  if (!sub) return 0;
  return Math.max(0, Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / 86400000));
}
export function hasAccess(sub: Subscription | null): boolean {
  if (!BILLING_ENABLED) return true; // free mode → never lock anyone out
  if (!sub) return true; // unknown → don't lock out
  if (sub.status === "active") return true;
  return sub.status === "trialing" && new Date(sub.trialEndsAt).getTime() > Date.now();
}

function PlanCards({ seats, busyPlan, onChoose }: { seats: number; busyPlan: Plan | null; onChoose: (p: Plan) => void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 16 }}>
      {PLANS.map((p) => (
        <div key={p.id} className="glass" style={{ padding: 22, borderRadius: 18, display: "flex", flexDirection: "column", gap: 14, border: p.id === "team" ? "1px solid var(--accent)" : undefined }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>{p.name}</span>
              {p.id === "team" && <span className="kicker" style={{ color: "var(--accent)" }}>Popular</span>}
            </div>
            <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ink-4)" }}>{p.blurb}</p>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
            <span className="mono" style={{ fontSize: 30, fontWeight: 600 }}>{p.price}</span>
            <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>{p.unit}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {p.features.map((f) => (
              <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink-2)" }}>
                <Icon name="check" size={14} style={{ color: "var(--st-done)", flexShrink: 0 }} /> {f}
              </div>
            ))}
          </div>
          <button className="btn btn-accent" onClick={() => onChoose(p.id)} disabled={busyPlan != null}
            style={{ justifyContent: "center", marginTop: "auto", opacity: busyPlan != null ? 0.6 : 1 }}>
            {busyPlan === p.id ? "Starting…" : p.id === "team" ? `Choose Team · ${seats} seat${seats === 1 ? "" : "s"}` : "Choose Personal"}
          </button>
        </div>
      ))}
    </div>
  );
}

export function TrialBanner({ sub, onUpgrade }: { sub: Subscription; onUpgrade: () => void }) {
  const days = trialDaysLeft(sub);
  const urgent = days <= 2;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 24px", flexShrink: 0,
      background: urgent ? "color-mix(in oklch, var(--st-review) 14%, transparent)" : "var(--accent-dim)",
      borderBottom: "1px solid var(--hairline)", fontSize: 13 }}>
      <Icon name="sparkles" size={15} style={{ color: urgent ? "var(--st-review)" : "var(--accent)" }} />
      <span style={{ color: "var(--ink-2)" }}>
        {days === 0 ? <strong>Your free trial ends today.</strong> : <><strong>{days} day{days === 1 ? "" : "s"}</strong> left in your free trial.</>}
        {" "}Upgrade to keep everything running.
      </span>
      <button onClick={onUpgrade} className="btn btn-accent" style={{ marginLeft: "auto", padding: "5px 13px", fontSize: 12.5 }}>Upgrade</button>
    </div>
  );
}

export function UpgradeModal({ open, onClose, seats, busyPlan, onChoose }: {
  open: boolean; onClose: () => void; seats: number; busyPlan: Plan | null; onChoose: (p: Plan) => void;
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 120, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "10vh", overflowY: "auto" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Choose a plan" onClick={(e) => e.stopPropagation()} className="anim-scalein" style={{ width: 620, maxWidth: "94vw" }}>
        <div className="glass" style={{ borderRadius: 22, padding: 26, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
            <h2 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>Choose your plan</h2>
            <button className="btn-icon" onClick={onClose} aria-label="Close" style={{ marginLeft: "auto", border: "none", width: 30, height: 30 }}><Icon name="x" size={17} /></button>
          </div>
          <p style={{ margin: "0 0 20px", fontSize: 13.5, color: "var(--ink-4)" }}>Cancel anytime from billing settings.</p>
          <PlanCards seats={seats} busyPlan={busyPlan} onChoose={onChoose} />
        </div>
      </div>
    </div>
  );
}

export function Paywall({ sub, seats, busyPlan, onChoose, onSignOut }: {
  sub: Subscription; seats: number; busyPlan: Plan | null; onChoose: (p: Plan) => void; onSignOut?: () => void;
}) {
  const ended = sub.status !== "trialing";
  return (
    <div style={{ position: "relative", minHeight: "100vh", overflowY: "auto", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="app-bg" />
      <div style={{ position: "relative", zIndex: 1, width: 680, maxWidth: "100%", textAlign: "center" }}>
        <span style={{ display: "inline-grid", placeItems: "center", marginBottom: 16 }}><KanboLogo size={42} /></span>
        <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 8 }}>
          {ended ? "Your subscription is inactive" : "Your free trial has ended"}
        </h1>
        <p style={{ fontSize: 14.5, color: "var(--ink-3)", margin: "0 auto 26px", maxWidth: 460, lineHeight: 1.55 }}>
          Pick a plan to keep your tasks, projects, and team in Kanbo. Your data is safe and waiting.
        </p>
        <PlanCards seats={seats} busyPlan={busyPlan} onChoose={onChoose} />
        {onSignOut && <button onClick={onSignOut} style={{ marginTop: 22, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 13, fontFamily: "var(--font-display)" }}>Sign out</button>}
      </div>
    </div>
  );
}
