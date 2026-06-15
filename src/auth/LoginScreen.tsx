/* ============================================================
   KORA — login / sign-up / forgot-password (Supabase mode only)
   ============================================================ */
import { useState } from "react";
import { Icon } from "../components/primitives";
import { useAuth } from "./AuthProvider";

type Mode = "signin" | "signup" | "reset";

// Invite-only mode: hides self-signup + Google. Real enforcement is the
// "Disable signup" toggle in Supabase; this just matches the UI to it.
const SIGNUP_DISABLED = import.meta.env.VITE_DISABLE_SIGNUP === "true";
// Google sign-in is hidden until the Google provider is configured in Supabase.
// Set VITE_ENABLE_GOOGLE=true once OAuth credentials are in place.
const GOOGLE_ENABLED = import.meta.env.VITE_ENABLE_GOOGLE === "true";

export function LoginScreen() {
  const { signIn, signUp, signInWithGoogle, resetPassword } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
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
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 22 }}>
          <span style={{ width: 38, height: 38, borderRadius: 11, display: "grid", placeItems: "center", background: "var(--accent)", color: "var(--on-accent)", fontWeight: 700, fontSize: 21, boxShadow: "0 0 18px var(--accent-glow)" }}>K</span>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em" }}>Kora</div>
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
            <>New to Kora? <button onClick={() => go("signup")} style={linkStyle}>Create an account</button></>
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

const inputStyle: React.CSSProperties = {
  height: 42, padding: "0 14px", borderRadius: 11, border: "1px solid var(--hairline)",
  background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 14, outline: "none",
};
const linkStyle: React.CSSProperties = {
  border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", fontWeight: 600, fontFamily: "var(--font-display)", fontSize: 13,
};
