/* ============================================================
   KANBO — login / sign-up / forgot-password (Supabase mode only)
   ============================================================ */
import { useState } from "react";
import { Icon, KanboLogo } from "../components/primitives";
import { Landing } from "../components/Landing";
import { useAuth } from "./AuthProvider";
import { store } from "../data/store";

type Mode = "signin" | "signup" | "reset";

/* Public site: marketing landing first, auth on demand. This is what a
   signed-out visitor sees at the root. */
export function PublicSite() {
  const [view, setView] = useState<"landing" | "auth" | "request">("landing");
  const [startMode, setStartMode] = useState<Mode>("signin");
  if (view === "landing") {
    return (
      <Landing
        signupDisabled={SIGNUP_DISABLED}
        onGetStarted={() => setView("request")}
        onSignIn={() => { setStartMode("signin"); setView("auth"); }}
      />
    );
  }
  if (view === "request") return <RequestAccessForm onBack={() => setView("landing")} onSignIn={() => { setStartMode("signin"); setView("auth"); }} />;
  return <LoginScreen initialMode={startMode} onBack={() => setView("landing")} />;
}

/* Early-access request — name + email; the admin approves before the account works. */
function RequestAccessForm({ onBack, onSignIn }: { onBack: () => void; onSignIn: () => void }) {
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await store.createAccessRequest(`${first} ${last}`.trim() || first, email.trim()); setDone(true); }
    catch { setError("Couldn't send your request — please try again."); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ position: "relative", minHeight: "100vh", display: "grid", placeItems: "center", overflow: "hidden", padding: 16 }}>
      <div className="app-bg" /><div className="app-grid" />
      <div className="glass anim-scalein" style={{ position: "relative", zIndex: 1, width: 420, maxWidth: "100%", padding: 28, borderRadius: 22, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <button onClick={onBack} style={{ ...linkStyle, color: "var(--ink-4)", display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 14, fontWeight: 500 }}>
          <Icon name="arrowLeft" size={14} /> Back to home
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 18 }}>
          <KanboLogo size={34} />
          <div>
            <div style={{ fontFamily: "var(--font-head)", fontSize: 19, fontWeight: 600, letterSpacing: "0.15em", textTransform: "uppercase" }}>Kanbo</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-4)" }}>Request early access</div>
          </div>
        </div>
        {done ? (
          <div style={{ textAlign: "center", padding: "12px 0 6px" }}>
            <span style={{ display: "inline-grid", placeItems: "center", width: 46, height: 46, borderRadius: 14, background: "var(--accent-dim)", color: "var(--accent)", marginBottom: 14 }}><Icon name="check" size={22} /></span>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>Request received</h2>
            <p style={{ fontSize: 13.5, color: "var(--ink-3)", lineHeight: 1.55, margin: "0 0 18px" }}>Thanks — we’re in early access and approving people in batches. We’ll be in touch at <strong style={{ color: "var(--ink-2)" }}>{email}</strong> when your spot is ready.</p>
            <button onClick={onSignIn} className="btn btn-ghost" style={{ width: "100%", justifyContent: "center", padding: "11px 15px" }}>Already approved? Sign in</button>
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13.5, color: "var(--ink-3)", lineHeight: 1.55, margin: "0 0 16px" }}>Kanbo is free while we’re in early access. Tell us who you are and we’ll let you in.</p>
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", gap: 10 }}>
                <input required value={first} onChange={(e) => setFirst(e.target.value)} placeholder="First name" aria-label="First name" style={{ ...inputStyle, flex: 1 }} />
                <input value={last} onChange={(e) => setLast(e.target.value)} placeholder="Surname" aria-label="Surname" style={{ ...inputStyle, flex: 1 }} />
              </div>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" aria-label="Email" style={inputStyle} />
              {error && <div role="alert" style={{ fontSize: 12.5, color: "var(--prio-urgent)" }}>{error}</div>}
              <button type="submit" disabled={busy || !first.trim() || !email.trim()} className="btn btn-accent" style={{ width: "100%", justifyContent: "center", padding: "11px 15px", marginTop: 4, opacity: busy || !first.trim() || !email.trim() ? 0.6 : 1 }}>
                {busy ? "Sending…" : "Request access"}
              </button>
            </form>
            <div style={{ marginTop: 14, textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>
              Already have an account? <button onClick={onSignIn} style={linkStyle}>Sign in</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Invite-only mode: hides self-signup + Google. Real enforcement is the
// "Disable signup" toggle in Supabase; this just matches the UI to it.
const SIGNUP_DISABLED = import.meta.env.VITE_DISABLE_SIGNUP === "true";
// Google sign-in is hidden until the Google provider is configured in Supabase.
// Set VITE_ENABLE_GOOGLE=true once OAuth credentials are in place.
const GOOGLE_ENABLED = import.meta.env.VITE_ENABLE_GOOGLE === "true";

export function LoginScreen({ initialMode = "signin", onBack }: { initialMode?: Mode; onBack?: () => void } = {}) {
  const { signIn, signUp, signInWithGoogle, resetPassword } = useAuth();
  const [mode, setMode] = useState<Mode>(SIGNUP_DISABLED ? "signin" : initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reset = () => { setError(null); setNotice(null); };
  const go = (m: Mode) => { setMode(m); reset(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); reset();
    let res: { error?: string } = {};
    if (mode === "signin") res = await signIn(email, password);
    else if (mode === "signup") res = await signUp(email, password);
    else res = await resetPassword(email);
    setBusy(false);
    if (res.error) setError(res.error);
    else if (mode === "signup") setNotice("Account created — signing you in…");
    else if (mode === "reset") setNotice("If that email has an account, a reset link is on its way.");
  };

  const subtitle = mode === "signin" ? "Welcome back" : mode === "signup" ? "Create your account" : "Reset your password";
  const cta = mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link";

  return (
    <div style={{ position: "relative", height: "100vh", display: "grid", placeItems: "center", overflow: "hidden", padding: 16 }}>
      <div className="app-bg" /><div className="app-grid" />
      <div className="glass anim-scalein" style={{ position: "relative", zIndex: 1, width: 400, maxWidth: "100%", padding: 28, borderRadius: 22, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        {onBack && (
          <button onClick={onBack} style={{ ...linkStyle, color: "var(--ink-4)", display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 14, fontWeight: 500 }}>
            <Icon name="arrowLeft" size={14} /> Back to home
          </button>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 22 }}>
          <KanboLogo size={34} />
          <div>
            <div style={{ fontFamily: "var(--font-head)", fontSize: 19, fontWeight: 600, letterSpacing: "0.15em", textTransform: "uppercase" }}>Kanbo</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-4)" }}>{subtitle}</div>
          </div>
        </div>

        {mode !== "reset" && GOOGLE_ENABLED && !SIGNUP_DISABLED && (
          <>
            <button onClick={signInWithGoogle} className="btn btn-ghost" style={{ width: "100%", justifyContent: "center", marginBottom: 16, padding: "10px 15px" }}>
              <Icon name="sparkles" size={16} /> Continue with Google
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 16px", color: "var(--ink-4)", fontSize: 12 }}>
              <div className="divider" style={{ flex: 1 }} /> or <div className="divider" style={{ flex: 1 }} />
            </div>
          </>
        )}

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" aria-label="Email" style={inputStyle} />
          {mode !== "reset" && (
            <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" aria-label="Password" style={inputStyle} />
          )}
          {mode === "signin" && (
            <button type="button" onClick={() => go("reset")} style={{ alignSelf: "flex-end", border: "none", background: "transparent", color: "var(--ink-3)", cursor: "pointer", fontSize: 12.5, fontFamily: "var(--font-display)", padding: 0 }}>
              Forgot password?
            </button>
          )}
          {error && <div role="alert" style={{ fontSize: 12.5, color: "var(--prio-urgent)" }}>{error}</div>}
          {notice && <div role="status" style={{ fontSize: 12.5, color: "var(--accent)" }}>{notice}</div>}
          <button type="submit" disabled={busy} className="btn btn-accent" style={{ width: "100%", justifyContent: "center", padding: "11px 15px", marginTop: 4, opacity: busy ? 0.6 : 1 }}>
            {busy ? "…" : cta}
          </button>
        </form>

        <div style={{ marginTop: 16, textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>
          {mode === "reset" ? (
            <button onClick={() => go("signin")} style={linkStyle}>← Back to sign in</button>
          ) : SIGNUP_DISABLED ? (
            <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>Accounts are invite-only.</span>
          ) : mode === "signin" ? (
            <>New to Kanbo? <button onClick={() => go("signup")} style={linkStyle}>Create an account</button></>
          ) : (
            <>Already have an account? <button onClick={() => go("signin")} style={linkStyle}>Sign in</button></>
          )}
        </div>
      </div>
    </div>
  );
}

/* shown when the user follows the password-recovery email link */
export function UpdatePasswordScreen() {
  const { updatePassword } = useAuth();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const { error } = await updatePassword(password);
    setBusy(false);
    if (error) setError(error);
  };

  return (
    <div style={{ position: "relative", height: "100vh", display: "grid", placeItems: "center", overflow: "hidden", padding: 16 }}>
      <div className="app-bg" /><div className="app-grid" />
      <div className="glass anim-scalein" style={{ position: "relative", zIndex: 1, width: 400, maxWidth: "100%", padding: 28, borderRadius: 22, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <h2 style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 6 }}>Set a new password</h2>
        <p style={{ fontSize: 13, color: "var(--ink-4)", margin: "0 0 18px" }}>Choose a new password for your account.</p>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" aria-label="New password" style={inputStyle} />
          {error && <div role="alert" style={{ fontSize: 12.5, color: "var(--prio-urgent)" }}>{error}</div>}
          <button type="submit" disabled={busy} className="btn btn-accent" style={{ width: "100%", justifyContent: "center", padding: "11px 15px", marginTop: 4, opacity: busy ? 0.6 : 1 }}>
            {busy ? "…" : "Update password"}
          </button>
        </form>
      </div>
    </div>
  );
}

/* shown to a signed-in but not-yet-approved early-access account */
export function PendingApproval({ email, onSignOut }: { email?: string | null; onSignOut: () => void }) {
  return (
    <div style={{ position: "relative", minHeight: "100vh", display: "grid", placeItems: "center", overflow: "hidden", padding: 16 }}>
      <div className="app-bg" /><div className="app-grid" />
      <div className="glass anim-scalein" style={{ position: "relative", zIndex: 1, width: 420, maxWidth: "100%", padding: 30, borderRadius: 22, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", textAlign: "center" }}>
        <span style={{ display: "inline-grid", placeItems: "center", width: 50, height: 50, borderRadius: 15, background: "var(--accent-dim)", color: "var(--accent)", marginBottom: 16 }}><Icon name="clock" size={24} /></span>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 10px" }}>You’re on the early-access list</h2>
        <p style={{ fontSize: 14, color: "var(--ink-3)", lineHeight: 1.6, margin: "0 0 22px" }}>Your account{email ? ` (${email})` : ""} is waiting for approval. Kanbo is free while we’re in early access and we let people in a batch at a time — you’ll hear from us the moment your spot is ready.</p>
        <button onClick={onSignOut} className="btn btn-ghost" style={{ width: "100%", justifyContent: "center", padding: "11px 15px" }}>Sign out</button>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  height: 42, padding: "0 14px", borderRadius: 11, border: "1px solid var(--hairline)",
  background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 14, outline: "none",
};
const linkStyle: React.CSSProperties = {
  border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", fontWeight: 600, fontFamily: "var(--font-display)", fontSize: 13,
};
