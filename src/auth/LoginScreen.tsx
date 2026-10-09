/* ============================================================
   KANBO — login / sign-up / forgot-password / email links /
   waiting room (Supabase mode only)
   ============================================================ */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, KanboLogo, AppBg } from "../components/primitives";
import { Landing } from "../components/Landing";
import { useAuth } from "./AuthProvider";
import { store } from "../data/store";
import { FULL_HEIGHT } from "../lib/viewport";
import { TextField, PasswordField } from "./AuthFields";
import { friendlyAuthError, type LinkError, type LinkType } from "./authLinks";
import { GoogleButton, useGoogleSignIn } from "./GoogleButton";
import { friendlyGoogleError, googleSignInEnabled, usesGoogle } from "./googleSignIn";

type Mode = "signin" | "signup" | "reset";

// Invite-only mode: hides self-signup. Real enforcement is the "Disable
// signup" toggle in Supabase; this just matches the UI to it.
const SIGNUP_DISABLED = import.meta.env.VITE_DISABLE_SIGNUP === "true";
// Google sign-in is hidden until the Google provider is configured in Supabase.
// Set VITE_ENABLE_GOOGLE=true once OAuth credentials are in place. It stays
// hidden while Supabase says the provider is off, or that "Confirm email" is off
// (Supabase links Google to the same-email account, which is only safe once
// every address has been proven: googleSignIn.ts › readiness), and a press
// never opens Google before Supabase has said both are on. It stays
// available in invite-only mode: existing accounts can always use it, and
// Supabase's "Disable signup" still blocks unknown Google accounts (the
// signup_disabled redirect is explained on this screen: authLinks.ts).
// Where people waiting for approval (or suspended) can get help. Point it at
// the company IT/helpdesk address for a rollout with VITE_SUPPORT_EMAIL.
const SUPPORT_EMAIL = (import.meta.env.VITE_SUPPORT_EMAIL as string | undefined)?.trim() || "hello@kanbo.co.uk";
/** minimum for NEW passwords (sign-up / set / reset); sign-in accepts whatever the account has */
const MIN_PASSWORD = 8;
const APPROVAL_POLL_MS = 30000;

/* ---------- shared page + card ---------- */
function AuthPage({ children, width = 400, center, label }: { children: ReactNode; width?: number; center?: boolean; label?: string }) {
  return (
    // body is overflow:hidden (the app scrolls inside its panes), so every
    // standalone screen is its own scroll container — short and landscape
    // phones, and an open keyboard, never clip the card. The single
    // minmax(0,1fr) column lets the card's maxWidth:100% resolve against the
    // screen, so it shrinks to fit a phone instead of overflowing it.
    <div style={{ position: "relative", height: FULL_HEIGHT, overflowY: "auto", overflowX: "hidden", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", placeItems: "center", padding: 16 }}>
      <AppBg grid />
      <main aria-label={label} className="glass anim-scalein" style={{ position: "relative", zIndex: 1, width, maxWidth: "100%", padding: "clamp(22px, 5vw, 28px)", borderRadius: 22, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", textAlign: center ? "center" : undefined }}>
        {children}
      </main>
    </div>
  );
}

function Brand({ subtitle, marginBottom = 22 }: { subtitle: string; marginBottom?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom }}>
      <KanboLogo size={34} />
      <div>
        <div style={{ fontFamily: "var(--font-head)", fontSize: 19, fontWeight: 600, letterSpacing: "0.15em", textTransform: "uppercase" }}>Kanbo</div>
        <div style={{ fontSize: 12.5, color: "var(--ink-4)" }}>{subtitle}</div>
      </div>
    </div>
  );
}

function BackHome({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" onClick={onBack} style={{ ...linkStyle, color: "var(--ink-4)", display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 14, fontWeight: 500 }}>
      <Icon name="arrowLeft" size={14} /> Back to home
    </button>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  return <div role="alert" style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--prio-urgent)" }}>{children}</div>;
}

/** Explains a failed or expired email link above the form. */
function LinkBanner({ error }: { error: LinkError }) {
  const expired = error.kind !== "failed";
  const tone = expired ? "var(--prio-high)" : "var(--prio-urgent)";
  return (
    <div role="status" style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "11px 13px", marginBottom: 16, borderRadius: 12, fontSize: 13, lineHeight: 1.5, color: "var(--ink-2)", background: `color-mix(in oklch, ${tone} 12%, transparent)`, border: `1px solid color-mix(in oklch, ${tone} 32%, transparent)` }}>
      <span style={{ color: tone, flexShrink: 0, marginTop: 1 }}><Icon name={expired ? "clock" : "lock"} size={16} /></span>
      <span>{error.message}</span>
    </div>
  );
}

/* Public site: marketing landing first, auth on demand. This is what a
   signed-out visitor sees at the root. */
export function PublicSite() {
  const { loading, linkError } = useAuth();
  // arriving from an expired or failed email link goes straight to the explanation
  const [view, setView] = useState<"landing" | "auth" | "request">(() => (linkError ? "auth" : "landing"));
  const [startMode, setStartMode] = useState<Mode>("signin");
  // while the stored session is read, show the backdrop only — a signed-in
  // user shouldn't see the marketing page flash before their workspace
  if (loading) return <div style={{ position: "relative", height: FULL_HEIGHT }}><AppBg /></div>;
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
    catch { setError("Couldn’t send your request — please try again."); }
    finally { setBusy(false); }
  };
  const blocked = busy || !first.trim() || !email.trim();
  return (
    <AuthPage width={420} label="Request early access">
      <BackHome onBack={onBack} />
      <Brand subtitle="Request early access" marginBottom={18} />
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
              <TextField required value={first} onChange={(e) => setFirst(e.target.value)} placeholder="First name" aria-label="First name" name="given-name" autoComplete="given-name" style={{ flex: 1, minWidth: 0 }} />
              <TextField value={last} onChange={(e) => setLast(e.target.value)} placeholder="Surname" aria-label="Surname" name="family-name" autoComplete="family-name" style={{ flex: 1, minWidth: 0 }} />
            </div>
            <TextField type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" aria-label="Work email" name="email" autoComplete="email" inputMode="email" />
            {error && <ErrorText>{error}</ErrorText>}
            <button type="submit" disabled={blocked} className="btn btn-accent" style={{ width: "100%", justifyContent: "center", padding: "11px 15px", marginTop: 4, opacity: blocked ? 0.6 : 1 }}>
              {busy ? "Sending…" : "Request access"}
            </button>
          </form>
          <div style={{ marginTop: 14, textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>
            Already have an account? <button type="button" onClick={onSignIn} style={linkStyle}>Sign in</button>
          </div>
        </>
      )}
    </AuthPage>
  );
}

export function LoginScreen({ initialMode = "signin", onBack }: { initialMode?: Mode; onBack?: () => void } = {}) {
  const { signIn, signUp, signInWithGoogle, resetPassword, resendConfirmation, linkError, clearLinkError } = useAuth();
  // a failed/expired email link is explained once, here; an expired password
  // link opens "send yourself a new link" directly, an expired confirmation
  // link opens sign-in (which offers to resend the confirmation if needed)
  const [banner, setBanner] = useState<LinkError | null>(linkError);
  const [mode, setMode] = useState<Mode>(() =>
    linkError?.kind === "expired" ? "reset"
      : linkError?.kind === "confirm-expired" || (SIGNUP_DISABLED && initialMode === "signup") ? "signin"
      : initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // the address that still has to confirm its email (offer to resend the link)
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const googleOn = googleSignInEnabled();
  const { hd, readiness, whenReady } = useGoogleSignIn(googleOn);
  // shown while Supabase's settings are on their way (no jump in the layout), gone if they say no
  const showGoogle = googleOn && (readiness === "pending" || readiness === "ready");
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  useEffect(() => { if (linkError) clearLinkError(); /* consumed into `banner` */ }, [linkError, clearLinkError]);
  // back from Google with the browser's Back button (a page restored from the
  // back/forward cache): the button is usable again
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) setGoogleBusy(false); };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const reset = () => { setError(null); setNotice(null); setUnconfirmed(null); setResent(false); setGoogleError(null); };
  const go = (m: Mode) => { setMode(m); reset(); setBanner(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    reset();
    if (mode === "signup" && password.length < MIN_PASSWORD) { setError(`Use at least ${MIN_PASSWORD} characters for your password.`); return; }
    setBusy(true);
    const addr = email.trim();
    if (mode === "signin") {
      const res = await signIn(addr, password);
      setBusy(false);
      if (res.error) {
        setError(friendlyAuthError(res.error));
        if (/email not confirmed/i.test(res.error)) setUnconfirmed(addr);
      }
    } else if (mode === "signup") {
      const res = await signUp(addr, password);
      setBusy(false);
      if (res.error) setError(friendlyAuthError(res.error));
      else if (res.needsConfirmation) {
        // "Confirm email" is ON: there's no session until they click the link
        setMode("signin"); setPassword(""); setBanner(null);
        setNotice("Check your inbox to confirm your email, then sign in.");
        setUnconfirmed(addr);
      } else setNotice("Account created — signing you in…");
    } else {
      const res = await resetPassword(addr);
      setBusy(false);
      if (res.error) setError(friendlyAuthError(res.error));
      else { setBanner(null); setNotice("If that email has an account, a reset link is on its way. It works once, so use the newest email."); }
    }
  };

  const resend = async () => {
    if (!unconfirmed) return;
    setError(null);
    const res = await resendConfirmation(unconfirmed);
    if (res.error) setError(friendlyAuthError(res.error));
    else { setResent(true); setNotice(`We’ve sent a new confirmation link to ${unconfirmed}.`); }
  };

  // the page leaves for Google on success, so "Opening Google…" stays until it does
  const google = async (withHint: boolean) => {
    if (googleBusy) return;
    reset();
    setGoogleBusy(true);
    // a press before Supabase's settings arrive waits for them: never Google while
    // the provider or "Confirm email" is off (then the button goes and this explains)
    if ((await whenReady()) !== "ready") {
      setGoogleBusy(false);
      setError("Google sign-in isn’t available right now. Sign in with your email and password.");
      return;
    }
    const res = await signInWithGoogle({ hd: withHint ? hd : null });
    if (res.error) { setGoogleBusy(false); setGoogleError(friendlyGoogleError(res.error, friendlyAuthError)); }
  };

  const subtitle = mode === "signin" ? "Welcome back" : mode === "signup" ? "Create your account" : "Reset your password";
  const cta = mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link";
  const busyLabel = mode === "signin" ? "Signing in…" : mode === "signup" ? "Creating account…" : "Sending…";

  return (
    <AuthPage label={subtitle}>
      {onBack && <BackHome onBack={onBack} />}
      <Brand subtitle={subtitle} />
      {banner && <LinkBanner error={banner} />}
      {mode === "reset" && (
        <p style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5, margin: "-6px 0 14px" }}>Enter your email and we’ll send you a link to choose a new password.</p>
      )}

      {mode !== "reset" && showGoogle && (
        <>
          <GoogleButton onClick={() => google(true)} busy={googleBusy} describedBy={hd ? "kanbo-google-hd" : undefined} />
          {hd && (
            <p id="kanbo-google-hd" className="kgsi-hint">
              Shows your <strong>@{hd}</strong> Google accounts first.{" "}
              <button type="button" className="kgsi-link" onClick={() => google(false)} disabled={googleBusy}>Use another Google account</button>
            </p>
          )}
          {googleError && <div style={{ marginTop: 10 }}><ErrorText>{googleError}</ErrorText></div>}
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0", color: "var(--ink-4)", fontSize: 12 }}>
            <div className="divider" style={{ flex: 1 }} /> or <div className="divider" style={{ flex: 1 }} />
          </div>
        </>
      )}

      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <TextField type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" aria-label="Email" name="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} />
        {mode !== "reset" && (
          <PasswordField required minLength={mode === "signup" ? MIN_PASSWORD : undefined} value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "signup" ? `Password (at least ${MIN_PASSWORD} characters)` : "Password"} aria-label="Password" name="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"} />
        )}
        {mode === "signin" && (
          <button type="button" onClick={() => go("reset")} style={{ alignSelf: "flex-end", border: "none", background: "transparent", color: "var(--ink-3)", cursor: "pointer", fontSize: 12.5, fontFamily: "var(--font-display)", padding: "2px 0" }}>
            Forgot password?
          </button>
        )}
        {error && <ErrorText>{error}</ErrorText>}
        {notice && <div role="status" style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--accent)" }}>{notice}</div>}
        {unconfirmed && !resent && (
          <button type="button" onClick={resend} style={{ ...linkStyle, alignSelf: "flex-start", fontSize: 12.5, padding: 0 }}>Didn’t get the email? Send it again</button>
        )}
        <button type="submit" disabled={busy} className="btn btn-accent" style={{ width: "100%", justifyContent: "center", padding: "11px 15px", marginTop: 4, opacity: busy ? 0.6 : 1 }}>
          {busy ? busyLabel : cta}
        </button>
      </form>

      <div style={{ marginTop: 16, textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>
        {mode === "reset" ? (
          <button type="button" onClick={() => go("signin")} style={linkStyle}>← Back to sign in</button>
        ) : SIGNUP_DISABLED ? (
          <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>Accounts are invite-only. Ask your workspace admin for an invite.</span>
        ) : mode === "signin" ? (
          <>New to Kanbo? <button type="button" onClick={() => go("signup")} style={linkStyle}>Create an account</button></>
        ) : (
          <>Already have an account? <button type="button" onClick={() => go("signin")} style={linkStyle}>Sign in</button></>
        )}
      </div>

      {mode !== "reset" && showGoogle && (
        <details className="kgsi-about">
          <summary><Icon name="chevronRight" size={14} /> Signing in with Google</summary>
          <ul>
            <li><strong>Same email, same account.</strong> If you already sign in with a password, Google opens that same Kanbo account — your work is all there.</li>
            <li><strong>Invited to a team?</strong> Choose the Google account for the address your invite went to.</li>
            <li><strong>A different email is a different account.</strong> If you land somewhere unexpected, sign out and choose the other address.</li>
          </ul>
        </details>
      )}
    </AuthPage>
  );
}

/* ---------- email links: invite / reset / confirm ---------- */
const LINK_COPY: Record<LinkType, { kicker: string; title: string; body: string; cta: string }> = {
  invite: { kicker: "You’re invited", title: "Set your password", body: "You’ve been invited to Kanbo. Continue to choose a password for your account.", cta: "Continue" },
  recovery: { kicker: "Password reset", title: "Reset your password", body: "Continue to choose a new password for your Kanbo account.", cta: "Continue" },
  signup: { kicker: "Almost there", title: "Confirm your email", body: "Continue to confirm your email address and open Kanbo.", cta: "Confirm and continue" },
  email: { kicker: "Almost there", title: "Confirm your email", body: "Continue to confirm your email address and open Kanbo.", cta: "Confirm and continue" },
  magiclink: { kicker: "Sign in", title: "Sign in to Kanbo", body: "Continue to sign in on this device.", cta: "Continue" },
  email_change: { kicker: "Account email", title: "Confirm your new email", body: "Continue to confirm the new email address for your Kanbo account.", cta: "Confirm" },
};

/* Shown while an email-link flow owns the screen (App renders it when
   auth.recovery): first the "Continue" step for a scanner-safe link, then
   choosing a password for invite and reset links. */
export function UpdatePasswordScreen() {
  const { pendingLink } = useAuth();
  return pendingLink ? <ConfirmLinkStep type={pendingLink.type} /> : <SetPasswordForm />;
}

function ConfirmLinkStep({ type }: { type: LinkType }) {
  const { verifyLink } = useAuth();
  const copy = LINK_COPY[type];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setError(null);
    // the token is only spent here, on a real click — link scanners that
    // pre-open emails can't use it up
    const res = await verifyLink();
    // on success (or a dead link) this screen is replaced; only a retryable error lands here
    setBusy(false);
    if (res.error) setError(res.error);
  };
  return (
    <AuthPage label={copy.title}>
      <Brand subtitle={copy.kicker} />
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>{copy.title}</h1>
      <p style={{ fontSize: 14, color: "var(--ink-3)", lineHeight: 1.55, margin: "0 0 20px" }}>{copy.body}</p>
      {error && <div style={{ marginBottom: 12 }}><ErrorText>{error}</ErrorText></div>}
      <button type="button" onClick={go} disabled={busy} className="btn btn-accent" style={{ width: "100%", justifyContent: "center", padding: "12px 15px", opacity: busy ? 0.6 : 1 }}>
        {busy ? "Checking your link…" : <>{copy.cta} <Icon name="arrowRight" size={16} /></>}
      </button>
      <p style={{ fontSize: 12, color: "var(--ink-4)", lineHeight: 1.5, margin: "14px 0 0", textAlign: "center" }}>For your security, this link works once.</p>
    </AuthPage>
  );
}

function SetPasswordForm() {
  const { user, passwordReason, updatePassword, signOut } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== password;
  const invite = passwordReason === "invite";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true); setError(null);
    if (password.length < MIN_PASSWORD) { setError(`Use at least ${MIN_PASSWORD} characters.`); return; }
    if (confirm !== password) { setError("Those passwords don’t match."); return; }
    setBusy(true);
    const { error } = await updatePassword(password);
    setBusy(false);
    if (error) setError(/should be different/i.test(error) ? "Choose a password you haven’t used for Kanbo before." : friendlyAuthError(error));
  };

  return (
    <AuthPage label={invite ? "Set your password" : "Choose a new password"}>
      <Brand subtitle={invite ? "Welcome to Kanbo" : "Password reset"} />
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>{invite ? "Set your password" : "Choose a new password"}</h1>
      <p style={{ fontSize: 13.5, color: "var(--ink-3)", lineHeight: 1.55, margin: "0 0 18px" }}>
        {invite ? "Pick a password to finish setting up your account" : "Choose a new password for your account"}
        {user?.email ? <> (<strong style={{ color: "var(--ink-2)", fontWeight: 600 }}>{user.email}</strong>)</> : null}.
      </p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }} noValidate>
        {/* lets password managers save the new password against the right account */}
        <input type="email" name="username" autoComplete="username" value={user?.email ?? ""} readOnly hidden />
        <PasswordField required minLength={MIN_PASSWORD} value={password} onChange={(e) => setPassword(e.target.value)} onBlur={() => setTouched(true)}
          placeholder="New password" aria-label="New password" name="new-password" autoComplete="new-password" aria-describedby="kanbo-pw-hint"
          revealed={shown} onToggleReveal={() => setShown((v) => !v)} invalid={touched && tooShort}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus />
        <PasswordField required value={confirm} onChange={(e) => setConfirm(e.target.value)}
          placeholder="Confirm new password" aria-label="Confirm new password" name="confirm-password" autoComplete="new-password"
          revealed={shown} hideToggle invalid={mismatch} />
        <div id="kanbo-pw-hint" style={{ fontSize: 12, color: touched && tooShort ? "var(--prio-urgent)" : "var(--ink-4)" }}>
          {mismatch ? "Passwords don’t match yet." : `At least ${MIN_PASSWORD} characters.`}
        </div>
        {error && <ErrorText>{error}</ErrorText>}
        <button type="submit" disabled={busy} className="btn btn-accent" style={{ width: "100%", justifyContent: "center", padding: "11px 15px", marginTop: 4, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Saving…" : invite ? "Set password and continue" : "Update password"}
        </button>
      </form>
      {user?.email && (
        <div style={{ marginTop: 14, textAlign: "center", fontSize: 12.5, color: "var(--ink-4)" }}>
          Not you? <button type="button" onClick={() => signOut()} style={{ ...linkStyle, fontSize: 12.5 }}>Sign out</button>
        </div>
      )}
    </AuthPage>
  );
}

/* shown to a signed-in but not-yet-approved early-access account (or a
   suspended one). Re-checks in the background, lets them in the moment an
   admin approves them, and always gives them someone to contact. */
export function PendingApproval({ email, onSignOut, suspended }: { email?: string | null; onSignOut: () => void; suspended?: boolean }) {
  const { user } = useAuth();
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [released, setReleased] = useState(false);
  const inFlight = useRef(false);

  const check = useCallback(async (manual: boolean) => {
    if (!user || inFlight.current) return;
    inFlight.current = true;
    if (manual) { setChecking(true); setStatus(null); }
    try {
      const p = await store.getProfile(user.id);
      if (p && p.suspended !== true && p.approved !== false) {
        setReleased(true);
        setStatus("You’re in — opening Kanbo…");
        window.setTimeout(() => window.location.reload(), 600);
        return;
      }
      if (manual) setStatus(suspended ? "Your account is still paused." : "Not yet — we’ll keep checking every 30 seconds and let you in automatically.");
    } catch {
      if (manual) setStatus("Couldn’t check just now. Please try again in a moment.");
    } finally {
      inFlight.current = false;
      if (manual) setChecking(false);
    }
  }, [user, suspended]);

  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") check(false); };
    const iv = window.setInterval(tick, APPROVAL_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", tick); window.removeEventListener("focus", tick); };
  }, [check]);

  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(suspended ? "Kanbo account suspended" : "Kanbo access request")}`;
  // arrived through Google (a linked Google identity): say which account it used
  const viaGoogle = usesGoogle(user?.providers);
  const shownEmail = email ?? user?.email ?? null;

  return (
    <AuthPage width={420} center label={suspended ? "Account suspended" : "Waiting for approval"}>
      <span style={{ display: "inline-grid", placeItems: "center", width: 50, height: 50, borderRadius: 15, background: released ? "color-mix(in oklch, var(--st-done) 16%, transparent)" : suspended ? "color-mix(in oklch, var(--prio-urgent) 16%, transparent)" : "var(--accent-dim)", color: released ? "var(--st-done)" : suspended ? "var(--prio-urgent)" : "var(--accent)", marginBottom: 16 }}>
        <Icon name={released ? "check" : suspended ? "lock" : "clock"} size={24} />
      </span>
      {suspended ? (
        <>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 10px" }}>Your account is suspended</h1>
          <p style={{ fontSize: 14, color: "var(--ink-3)", lineHeight: 1.6, margin: "0 0 20px" }}>Access to this account{email ? ` (${email})` : ""} has been paused. If you think this is a mistake, get in touch and we’ll take a look.</p>
        </>
      ) : (
        <>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 10px" }}>You’re on the early-access list</h1>
          {viaGoogle && shownEmail ? (
            <p style={{ fontSize: 14, color: "var(--ink-3)", lineHeight: 1.6, margin: "0 0 20px", overflowWrap: "anywhere" }}>
              You’re signed in with Google as <strong style={{ color: "var(--ink-2)", fontWeight: 600 }}>{shownEmail}</strong>. An admin needs to approve this account first. Keep this page open — it checks automatically and lets you in the moment you’re approved.
            </p>
          ) : (
            <p style={{ fontSize: 14, color: "var(--ink-3)", lineHeight: 1.6, margin: "0 0 20px" }}>Your account{email ? ` (${email})` : ""} is waiting for approval. Keep this page open — it checks automatically and lets you in the moment you’re approved.</p>
          )}
        </>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {suspended ? (
          // nothing to wait for — the way forward is talking to someone
          <a href={mailto} className="btn btn-accent" style={{ width: "100%", justifyContent: "center", padding: "11px 15px", textDecoration: "none" }}>
            <Icon name="message" size={15} /> Get in touch
          </a>
        ) : (
          <button type="button" onClick={() => check(true)} disabled={checking || released} className="btn btn-accent" style={{ width: "100%", justifyContent: "center", padding: "11px 15px", opacity: checking || released ? 0.7 : 1 }}>
            <Icon name="refresh" size={15} /> {checking ? "Checking…" : "Check again"}
          </button>
        )}
        <button type="button" onClick={() => onSignOut()} className="btn btn-ghost" style={{ width: "100%", justifyContent: "center", padding: "11px 15px" }}>Sign out</button>
      </div>
      {/* live region stays mounted so screen readers announce each result */}
      <p role="status" aria-live="polite" style={{ fontSize: 12.5, lineHeight: 1.5, color: released ? "var(--st-done)" : "var(--ink-3)", margin: status ? "12px 0 0" : 0 }}>{status}</p>
      {!suspended && (
        // the usual reason someone invited is stuck here: they came in with another address
        <p style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.5, margin: "16px 0 0" }}>
          {viaGoogle
            ? "Invited with a different email? Sign out, then continue with Google and choose that account — each email is its own Kanbo account."
            : "Invited with a different email? Sign out, then sign in with that address — each email is its own Kanbo account."}
        </p>
      )}
      <p style={{ fontSize: 12.5, color: "var(--ink-4)", lineHeight: 1.5, margin: "16px 0 0", overflowWrap: "anywhere" }}>
        Questions? Email <a href={mailto} style={{ color: "var(--accent)", fontWeight: 600 }}>{SUPPORT_EMAIL}</a>
      </p>
    </AuthPage>
  );
}

const linkStyle: React.CSSProperties = {
  border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", fontWeight: 600, fontFamily: "var(--font-display)", fontSize: 13,
};
