/* ============================================================
   KANBO — public marketing landing page (shown to signed-out visitors).
   On-brand with the design system: brand gradient, Sora/Manrope, glass.
   Self-contained; CTAs hand off to the auth screen via props.
   ============================================================ */
import { Icon, KanboLogo } from "./primitives";
import type { IconName } from "../data/types";

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  { icon: "sparkles", title: "Capture in plain English", body: "Type “Draft deck 90m deep work today” and Kanbo files it with the right duration, energy, and due date — no forms." },
  { icon: "calendarPlus", title: "Auto-plan your day", body: "Kanbo lays your tasks around the meetings already on your calendar, putting deep work where you’re sharpest." },
  { icon: "zap", title: "AI prioritization", body: "It ranks what to do next and tells you why — so you open the app and just start, instead of deciding." },
  { icon: "layers", title: "A board that flows", body: "Drag work from To-do to Done, group by status or project, and see what’s moving at a glance." },
  { icon: "clock", title: "Focus mode", body: "Start a timed deep-work block on a single task and let the rest of the noise fall away." },
  { icon: "user", title: "Built for teams", body: "Shared workspaces, assignments, comments, and live workload — everyone sees who’s on what, in real time." },
];

const STEPS: { n: string; title: string; body: string }[] = [
  { n: "01", title: "Capture", body: "Brain-dump everything on your plate in seconds, in your own words." },
  { n: "02", title: "Plan", body: "Auto-plan builds a realistic, time-blocked day around your real schedule." },
  { n: "03", title: "Focus", body: "Work the queue one block at a time and watch it get done." },
];

const sectionPad: React.CSSProperties = { maxWidth: 1080, margin: "0 auto", padding: "0 24px" };

export function Landing({ onGetStarted, onSignIn, signupDisabled }: {
  onGetStarted: () => void;
  onSignIn: () => void;
  signupDisabled?: boolean;
}) {
  const primaryLabel = signupDisabled ? "Sign in" : "Get started — free";
  const onPrimary = signupDisabled ? onSignIn : onGetStarted;

  return (
    <div style={{ position: "relative", minHeight: "100vh", overflowX: "hidden" }}>
      <div className="app-bg" /><div className="app-grid" />

      <div style={{ position: "relative", zIndex: 1 }}>
        {/* ---- nav ---- */}
        <nav style={{ ...sectionPad, display: "flex", alignItems: "center", gap: 12, padding: "20px 24px" }}>
          <KanboLogo size={30} />
          <span style={{ fontFamily: "var(--font-head)", fontSize: 19, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase" }}>Kanbo</span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            <button className="btn btn-ghost hide-sm" onClick={onSignIn} style={{ padding: "9px 16px" }}>Sign in</button>
            <button className="btn btn-accent" onClick={onPrimary} style={{ padding: "9px 16px", whiteSpace: "nowrap" }}>{signupDisabled ? "Sign in" : "Get started"}</button>
          </div>
        </nav>

        {/* ---- hero ---- */}
        <header style={{ ...sectionPad, textAlign: "center", padding: "64px 24px 40px" }}>
          <div className="anim-fadeup" style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 13px", borderRadius: 99, background: "var(--accent-dim)", color: "var(--accent)", fontSize: 12.5, fontWeight: 600, marginBottom: 26, border: "1px solid color-mix(in oklch, var(--accent) 22%, transparent)" }}>
            <Icon name="sparkles" size={14} /> Your AI-planned workday
          </div>
          <h1 className="anim-fadeup" style={{ fontSize: "clamp(34px, 6vw, 60px)", fontWeight: 700, lineHeight: 1.05, letterSpacing: "-0.03em", margin: "0 auto 20px", maxWidth: 760 }}>
            The to-do list that{" "}
            <span style={{ background: "var(--brand-grad)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>plans your day</span>{" "}
            for you.
          </h1>
          <p className="anim-fadeup" style={{ fontSize: "clamp(16px, 2vw, 19px)", lineHeight: 1.6, color: "var(--ink-3)", margin: "0 auto 30px", maxWidth: 600 }}>
            Kanbo turns scattered tasks into a realistic, time-blocked day. Capture in plain English, let AI prioritize, and focus on what actually matters.
          </p>
          <div className="anim-fadeup" style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <button className="btn btn-accent" onClick={onPrimary} style={{ padding: "13px 24px", fontSize: 15 }}>{primaryLabel} <Icon name="arrowRight" size={16} /></button>
            <button className="btn btn-ghost" onClick={onSignIn} style={{ padding: "13px 24px", fontSize: 15 }}>Sign in</button>
          </div>
          {!signupDisabled && <p style={{ fontSize: 12.5, color: "var(--ink-4)", marginTop: 16 }}>No credit card needed · Free during early access</p>}

          {/* ---- product preview mock ---- */}
          <div className="glass anim-fadeup" style={{ marginTop: 52, padding: 16, borderRadius: 22, maxWidth: 880, marginInline: "auto", boxShadow: "var(--shadow-lg)", textAlign: "left" }}>
            <div style={{ borderRadius: 14, overflow: "hidden", border: "1px solid var(--hairline)", background: "var(--surface-2)" }}>
              {/* faux daily brief */}
              <div style={{ padding: "18px 20px", position: "relative", overflow: "hidden", borderBottom: "1px solid var(--hairline)" }}>
                <div style={{ position: "absolute", top: -40, right: -20, width: 200, height: 200, background: "radial-gradient(circle, var(--accent-glow), transparent 70%)", opacity: 0.5 }} />
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ display: "grid", placeItems: "center", width: 24, height: 24, borderRadius: 8, background: "var(--accent-dim)", color: "var(--accent)" }}><Icon name="sparkles" size={13} /></span>
                  <span className="kicker" style={{ color: "var(--accent)" }}>Kanbo · Daily brief</span>
                </div>
                <p style={{ margin: 0, fontSize: 17, lineHeight: 1.5, letterSpacing: "-0.01em", maxWidth: 560 }}>
                  Good morning, Daniel. You have <strong>3 tasks</strong> due today and <strong>2</strong> in progress. Start with the highest-priority items below.
                </p>
              </div>
              {/* faux task rows */}
              <div>
                {[
                  { dot: "var(--accent)", title: "Draft Q3 launch deck", meta: "90m · Deep work · Due today", score: "98" },
                  { dot: "var(--st-review, #e0a64b)", title: "Review design handoff", meta: "30m · Today", score: "82" },
                  { dot: "var(--st-blocked, #d96b6b)", title: "Send investor update", meta: "45m · Today", score: "76" },
                ].map((r, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 20px", borderTop: i ? "1px solid var(--hairline)" : "none" }}>
                    <span className="mono" style={{ fontSize: 12, color: "var(--ink-4)", width: 14 }}>{i + 1}</span>
                    <span style={{ width: 8, height: 8, borderRadius: 99, background: r.dot, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 14, color: "var(--ink)" }}>{r.title}</span>
                    <span style={{ fontSize: 12, color: "var(--ink-4)" }} className="hide-sm">{r.meta}</span>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)", padding: "2px 7px", borderRadius: 7, background: "var(--accent-dim)" }}>{r.score}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </header>

        {/* ---- features ---- */}
        <section style={{ ...sectionPad, padding: "60px 24px" }}>
          <h2 style={{ textAlign: "center", fontSize: "clamp(26px, 4vw, 38px)", fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 12 }}>Everything you need to actually finish</h2>
          <p style={{ textAlign: "center", fontSize: 16, color: "var(--ink-3)", margin: "0 auto 44px", maxWidth: 540, lineHeight: 1.55 }}>
            Capture, plan, prioritize, and focus — in one calm, fast workspace.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18 }}>
            {FEATURES.map((f) => (
              <div key={f.title} className="glass lift" style={{ padding: 22, borderRadius: 18 }}>
                <span style={{ display: "inline-grid", placeItems: "center", width: 42, height: 42, borderRadius: 12, background: "var(--accent-dim)", color: "var(--accent)", marginBottom: 14 }}><Icon name={f.icon} size={20} /></span>
                <h3 style={{ fontSize: 17, fontWeight: 600, marginBottom: 7 }}>{f.title}</h3>
                <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ink-3)", margin: 0 }}>{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- how it works ---- */}
        <section style={{ ...sectionPad, padding: "40px 24px 60px" }}>
          <div className="glass" style={{ padding: "clamp(28px, 5vw, 52px)", borderRadius: 24 }}>
            <h2 style={{ textAlign: "center", fontSize: "clamp(24px, 3.5vw, 32px)", fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 40 }}>How it works</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 28 }}>
              {STEPS.map((s) => (
                <div key={s.n}>
                  <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: "var(--accent)", marginBottom: 10 }}>{s.n}</div>
                  <h3 style={{ fontSize: 19, fontWeight: 600, marginBottom: 8 }}>{s.title}</h3>
                  <p style={{ fontSize: 14.5, lineHeight: 1.6, color: "var(--ink-3)", margin: 0 }}>{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---- closing CTA ---- */}
        <section style={{ ...sectionPad, padding: "30px 24px 70px" }}>
          <div className="anim-fadeup" style={{ position: "relative", overflow: "hidden", borderRadius: 26, padding: "clamp(36px, 6vw, 64px) 24px", textAlign: "center", background: "var(--brand-grad)", boxShadow: "var(--shadow-lg)" }}>
            <h2 style={{ fontSize: "clamp(26px, 4vw, 40px)", fontWeight: 700, letterSpacing: "-0.02em", color: "#fff", margin: "0 0 14px" }}>Start running your day with Kanbo</h2>
            <p style={{ fontSize: 16.5, lineHeight: 1.55, color: "rgba(255,255,255,0.92)", margin: "0 auto 28px", maxWidth: 480 }}>
              Set up your workspace in under a minute. Plan today, finish today.
            </p>
            <button onClick={onPrimary} style={{ border: "none", cursor: "pointer", background: "#fff", color: "var(--accent-strong)", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15.5, padding: "14px 28px", borderRadius: 13, display: "inline-flex", alignItems: "center", gap: 8, boxShadow: "0 10px 30px -8px rgba(0,0,0,0.3)" }}>
              {primaryLabel} <Icon name="arrowRight" size={17} />
            </button>
          </div>
        </section>

        {/* ---- footer ---- */}
        <footer style={{ borderTop: "1px solid var(--hairline)" }}>
          <div style={{ ...sectionPad, display: "flex", alignItems: "center", gap: 12, padding: "24px", flexWrap: "wrap" }}>
            <KanboLogo size={22} />
            <span style={{ fontSize: 13, color: "var(--ink-4)" }}>© 2026 Kanbo. Plan today, finish today.</span>
            <button onClick={onSignIn} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--ink-3)", cursor: "pointer", fontSize: 13.5, fontWeight: 600, fontFamily: "var(--font-display)" }}>Sign in →</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
