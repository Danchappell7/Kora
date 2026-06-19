/* ============================================================
   KANBO — public marketing landing page (shown to signed-out visitors).
   On-brand with the design system: brand gradient, Sora/Manrope, glass.
   Self-contained; CTAs hand off to the auth screen via props.
   ============================================================ */
import { Icon, KanboLogo } from "./primitives";
import type { IconName } from "../data/types";

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  { icon: "sparkles", title: "Type like you think", body: "Write “Draft the deck, 90 mins, today” the way you’d say it out loud. Kanbo reads the time, the energy, and the deadline, and files it for you. No forms. No fiddly fields." },
  { icon: "calendarPlus", title: "A day that builds itself", body: "Kanbo drops your tasks around the meetings already on your calendar. Deep work when you’re sharp, the small stuff when you’re not. A real plan, ready in seconds." },
  { icon: "zap", title: "It already knows what’s next", body: "Kanbo ranks your queue and tells you why this one, right now. Open the app and go, instead of losing ten minutes deciding where to start." },
  { icon: "layers", title: "Projects that actually move", body: "Drag work from to-do to done, group by project or status, and see what’s live at a glance. Your whole team reads the same board the same way." },
  { icon: "clock", title: "Deep focus on tap", body: "Pick one task, hit start, and everything else goes quiet. Timed focus blocks that turn a loud list into finished work." },
  { icon: "user", title: "Made for teams", body: "Shared spaces, assignments, comments, and mentions. Live workload across every project shows who’s slammed, who’s free, and what to move — all in real time." },
];

const STEPS: { n: string; title: string; body: string }[] = [
  { n: "01", title: "Capture", body: "Empty your head in seconds. Your words, not a form." },
  { n: "02", title: "Plan", body: "Kanbo builds a real, time-blocked day around your calendar and your priorities." },
  { n: "03", title: "Focus", body: "Work one block at a time and watch the list clear itself." },
];

const FAQS: { q: string; a: string }[] = [
  { q: "Is Kanbo really free?", a: "Totally, while we’re in early access. No card, no trial counting down. When paid plans land, you’ll know well before they do." },
  { q: "Does it work for my whole team?", a: "That’s the whole idea. Spin up a shared space, invite people by email, assign work, drop comments, and watch everyone’s workload update live." },
  { q: "Can it run my projects, not just my day?", a: "Yes. Kanbo handles the projects, boards, and workloads you’d expect from a serious work tool, then adds the part most of them skip: an AI that plans your actual day around them." },
  { q: "Does it work on my phone?", a: "Capture, plan, and check things off from your phone, tablet, or laptop. Kanbo goes where you go." },
  { q: "Is my data private?", a: "Your data is yours. Every space is isolated and access controlled, and you can export it all, or delete it, whenever you want." },
  { q: "Do I need to set anything up?", a: "Nope. Sign up, add your name, start typing. Kanbo plans around you automatically." },
];

const sectionPad: React.CSSProperties = { maxWidth: 1080, margin: "0 auto", padding: "0 24px" };

export function Landing({ onGetStarted, onSignIn, signupDisabled }: {
  onGetStarted: () => void;
  onSignIn: () => void;
  signupDisabled?: boolean;
}) {
  const primaryLabel = signupDisabled ? "Sign in" : "Request early access";
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
            <button className="btn btn-accent" onClick={onPrimary} style={{ padding: "9px 16px", whiteSpace: "nowrap" }}>{signupDisabled ? "Sign in" : "Request access"}</button>
          </div>
        </nav>

        {/* ---- hero ---- */}
        <header style={{ ...sectionPad, textAlign: "center", padding: "64px 24px 40px" }}>
          <div className="anim-fadeup" style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 13px", borderRadius: 99, background: "var(--accent-dim)", color: "var(--accent)", fontSize: 12.5, fontWeight: 600, marginBottom: 26, border: "1px solid color-mix(in oklch, var(--accent) 22%, transparent)" }}>
            <Icon name="sparkles" size={14} /> Meet your AI day planner
          </div>
          <h1 className="anim-fadeup" style={{ fontSize: "clamp(34px, 6vw, 60px)", fontWeight: 700, lineHeight: 1.05, letterSpacing: "-0.03em", margin: "0 auto 20px", maxWidth: 760 }}>
            Plan less.{" "}
            <span style={{ background: "var(--brand-grad)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>Finish more.</span>
          </h1>
          <p className="anim-fadeup" style={{ fontSize: "clamp(16px, 2vw, 19px)", lineHeight: 1.6, color: "var(--ink-3)", margin: "0 auto 30px", maxWidth: 620 }}>
            Kanbo is where your tasks, projects, and team live together. Tell it what’s on your plate and the AI builds a real, time-blocked day around the meetings you already have. You just show up and do the work.
          </p>
          <div className="anim-fadeup" style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <button className="btn btn-accent" onClick={onPrimary} style={{ padding: "13px 24px", fontSize: 15 }}>{primaryLabel} <Icon name="arrowRight" size={16} /></button>
            <button className="btn btn-ghost" onClick={onSignIn} style={{ padding: "13px 24px", fontSize: 15 }}>Sign in</button>
          </div>
          {!signupDisabled && <p style={{ fontSize: 12.5, color: "var(--ink-4)", marginTop: 16 }}>Free while we’re in early access. You’ll be planning in under a minute.</p>}

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
          <h2 style={{ textAlign: "center", fontSize: "clamp(26px, 4vw, 38px)", fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 12 }}>Everything in one place. Nothing in your way.</h2>
          <p style={{ textAlign: "center", fontSize: 16, color: "var(--ink-3)", margin: "0 auto 44px", maxWidth: 540, lineHeight: 1.55 }}>
            Capture, plan, prioritize, and focus. For you, and for the whole team.
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
            <h2 style={{ textAlign: "center", fontSize: "clamp(24px, 3.5vw, 32px)", fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 40 }}>Three steps to a finished day.</h2>
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

        {/* ---- pricing ---- */}
        <section style={{ ...sectionPad, padding: "40px 24px 20px" }}>
          <h2 style={{ textAlign: "center", fontSize: "clamp(26px, 4vw, 38px)", fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 12 }}>Pricing? Not yet.</h2>
          <p style={{ textAlign: "center", fontSize: 16, color: "var(--ink-3)", margin: "0 auto 36px", maxWidth: 460, lineHeight: 1.55 }}>
            Free while we’re in early access. No card. No countdown. No catch.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 18, maxWidth: 720, margin: "0 auto" }}>
            <div className="glass" style={{ padding: 26, borderRadius: 20, border: "1px solid color-mix(in oklch, var(--accent) 45%, transparent)", boxShadow: "0 0 0 1px color-mix(in oklch, var(--accent) 30%, transparent), 0 14px 36px -16px var(--accent-glow)" }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 11px", borderRadius: 99, background: "var(--accent-dim)", color: "var(--accent)", fontSize: 12, fontWeight: 600, marginBottom: 14 }}>
                <Icon name="sparkles" size={13} /> Early access
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 38, fontWeight: 700, letterSpacing: "-0.02em" }}>Free</span>
              </div>
              <p style={{ fontSize: 13.5, color: "var(--ink-3)", margin: "0 0 16px", lineHeight: 1.5 }}>The full Kanbo. Every feature, solo or with your team, while we’re in early access.</p>
              {["Unlimited tasks and projects", "Shared team spaces", "AI planning and prioritization", "Workload and calendar view", "Export your data anytime"].map((f) => (
                <div key={f} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13.5, color: "var(--ink-2)", padding: "5px 0" }}>
                  <Icon name="check" size={15} style={{ color: "var(--accent)" }} /> {f}
                </div>
              ))}
              <button className="btn btn-accent" onClick={onPrimary} style={{ width: "100%", justifyContent: "center", padding: "12px 15px", marginTop: 18 }}>{primaryLabel}</button>
            </div>
            <div className="glass" style={{ padding: 26, borderRadius: 20 }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 11px", borderRadius: 99, background: "var(--surface-2)", color: "var(--ink-4)", fontSize: 12, fontWeight: 600, marginBottom: 14 }}>
                Later
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 38, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--ink-3)" }}>Paid plans</span>
              </div>
              <p style={{ fontSize: 13.5, color: "var(--ink-3)", margin: "0 0 16px", lineHeight: 1.5 }}>One day we’ll add fair Personal and per-seat Team plans. Early users get a heads up well in advance, plus a thank you for showing up first.</p>
              {["Everything in early access", "Priority support", "Advanced team controls"].map((f) => (
                <div key={f} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13.5, color: "var(--ink-4)", padding: "5px 0" }}>
                  <Icon name="check" size={15} style={{ color: "var(--ink-4)" }} /> {f}
                </div>
              ))}
              <button className="btn btn-ghost" onClick={onPrimary} style={{ width: "100%", justifyContent: "center", padding: "12px 15px", marginTop: 18 }}>You’re early. It’s on us.</button>
            </div>
          </div>
        </section>

        {/* ---- FAQ ---- */}
        <section style={{ ...sectionPad, padding: "40px 24px 60px", maxWidth: 760 }}>
          <h2 style={{ textAlign: "center", fontSize: "clamp(24px, 3.5vw, 32px)", fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 28 }}>Questions</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {FAQS.map((f) => (
              <details key={f.q} className="glass" style={{ borderRadius: 14, padding: "14px 18px" }}>
                <summary style={{ cursor: "pointer", fontSize: 15, fontWeight: 600, listStyle: "none", display: "flex", alignItems: "center", gap: 10 }}>
                  <Icon name="arrowRight" size={15} style={{ color: "var(--accent)", flexShrink: 0 }} /> {f.q}
                </summary>
                <p style={{ margin: "10px 0 0 25px", fontSize: 14, lineHeight: 1.6, color: "var(--ink-3)" }}>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ---- closing CTA ---- */}
        <section style={{ ...sectionPad, padding: "30px 24px 70px" }}>
          <div className="anim-fadeup" style={{ position: "relative", overflow: "hidden", borderRadius: 26, padding: "clamp(36px, 6vw, 64px) 24px", textAlign: "center", background: "var(--brand-grad)", boxShadow: "var(--shadow-lg)" }}>
            <h2 style={{ fontSize: "clamp(26px, 4vw, 40px)", fontWeight: 700, letterSpacing: "-0.02em", color: "#fff", margin: "0 0 14px" }}>Plan today. Finish today.</h2>
            <p style={{ fontSize: 16.5, lineHeight: 1.55, color: "rgba(255,255,255,0.92)", margin: "0 auto 28px", maxWidth: 480 }}>
              Set up your space in under a minute and let Kanbo run the rest of your day.
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
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 18 }}>
              <a href="/privacy" style={{ color: "var(--ink-3)", fontSize: 13.5, fontWeight: 600, fontFamily: "var(--font-display)", textDecoration: "none" }}>Privacy</a>
              <a href="/terms" style={{ color: "var(--ink-3)", fontSize: 13.5, fontWeight: 600, fontFamily: "var(--font-display)", textDecoration: "none" }}>Terms</a>
              <button onClick={onSignIn} style={{ border: "none", background: "transparent", color: "var(--ink-3)", cursor: "pointer", fontSize: 13.5, fontWeight: 600, fontFamily: "var(--font-display)" }}>Sign in →</button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
