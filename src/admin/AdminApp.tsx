/* ============================================================
   KANBO — standalone internal admin/analytics app, served at /admin.
   NOT part of the consumer product: its own layout, no sidebar, not linked
   anywhere. Open to Kanbo admins only.
   ============================================================ */
import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { LoginScreen } from "../auth/LoginScreen";
import { AdminView } from "../components/views/AdminView";
import { supabase } from "../lib/supabase";
import { KanboLogo, Icon, AppBg } from "../components/primitives";

// Who is an admin is decided on the server by is_admin() (profiles.is_admin,
// which "Make admin" sets, or the founding email), and every admin RPC checks
// it again. This list is only a fallback for when that check can't run at
// all (is_admin() not deployed yet), so the founder is never locked out.
export const ADMIN_EMAILS = ["danchappell7@gmail.com"];
export const isAdminEmail = (e?: string | null): boolean => !!e && ADMIN_EMAILS.includes(e.trim().toLowerCase());

export type AdminAccess = "checking" | "admin" | "denied" | "unverified";

/**
 * Decide access from the is_admin() RPC result. A clear answer from the
 * server wins (it already counts the founding email), so delegated admins
 * get in. Only when the check itself fails does the allowlist decide; anyone
 * else then sees "couldn't check" with a retry rather than a false "no".
 */
export function resolveAdminAccess(rpc: { data?: unknown; error?: unknown }, email?: string | null): Exclude<AdminAccess, "checking"> {
  if (!rpc.error && typeof rpc.data === "boolean") return rpc.data ? "admin" : "denied";
  return isAdminEmail(email) ? "admin" : "unverified";
}

async function checkAdmin(email?: string | null): Promise<Exclude<AdminAccess, "checking">> {
  if (!supabase) return "admin"; // demo mode: no backend to ask
  try {
    const { data, error } = await supabase.rpc("is_admin");
    return resolveAdminAccess({ data, error }, email);
  } catch (error) {
    return resolveAdminAccess({ error }, email);
  }
}

export function AdminApp() {
  const auth = useAuth();
  const uid = auth.user?.id;
  const email = auth.user?.email;
  const [access, setAccess] = useState<AdminAccess>("checking");
  const [attempt, setAttempt] = useState(0);

  // keyed on the user id (not the user object, which is replaced on every
  // token refresh) so an hourly refresh never re-gates a working admin
  useEffect(() => {
    if (!auth.configured) { setAccess("admin"); return; }
    if (!uid) { setAccess("checking"); return; }
    let on = true;
    setAccess("checking");
    checkAdmin(email).then((a) => { if (on) setAccess(a); });
    return () => { on = false; };
  }, [auth.configured, uid, email, attempt]);

  // Demo mode (no backend configured) — show the dashboard for local preview.
  if (auth.configured) {
    if (auth.loading) return <Centered>Loading…</Centered>;
    if (!auth.user) return <LoginScreen />; // must sign in first
    if (access === "checking") return <Centered>Checking your access…</Centered>;
    if (access === "unverified") return <Unverified onRetry={() => setAttempt((n) => n + 1)} onSignOut={auth.signOut} email={auth.user.email} />;
    if (access === "denied") return <NotAuthorised onSignOut={auth.signOut} email={auth.user.email} />;
  }

  return (
    <div style={{ position: "relative", height: "100vh", overflow: "hidden" }}>
      <AppBg />
      <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", height: "100%" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 11, padding: "14px 24px", borderBottom: "1px solid var(--hairline)", background: "var(--surface-raised)", backdropFilter: "blur(10px)" }}>
          <KanboLogo size={26} />
          <span style={{ fontFamily: "var(--font-head)", fontSize: 16, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>Kanbo</span>
          <span style={{ padding: "2px 8px", borderRadius: 7, background: "var(--accent-dim)", color: "var(--accent)", fontSize: 11, fontWeight: 600, fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Admin</span>
          <div style={{ flex: 1 }} />
          {auth.configured && auth.user && (
            <>
              <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>{auth.user.email}</span>
              <button className="btn btn-ghost" onClick={auth.signOut} style={{ padding: "7px 12px", fontSize: 13 }}><Icon name="logout" size={14} /> Sign out</button>
            </>
          )}
        </header>
        <AdminView currentEmail={auth.user?.email ?? undefined} />
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ position: "relative", minHeight: "100vh", display: "grid", placeItems: "center" }}><AppBg /><span style={{ position: "relative", zIndex: 1, color: "var(--ink-4)", fontSize: 14 }}>{children}</span></div>;
}

function NotAuthorised({ onSignOut, email }: { onSignOut?: () => void; email?: string }) {
  return (
    <div style={{ position: "relative", minHeight: "100vh", display: "grid", placeItems: "center", padding: 20 }}>
      <AppBg />
      <div className="glass anim-scalein" style={{ position: "relative", zIndex: 1, width: 380, maxWidth: "100%", padding: 28, borderRadius: 20, textAlign: "center", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "inline-flex", padding: 13, borderRadius: 14, background: "var(--surface-2)", marginBottom: 14 }}><Icon name="lock" size={22} style={{ color: "var(--ink-4)" }} /></div>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 7 }}>Not authorised</h2>
        <p style={{ fontSize: 13.5, color: "var(--ink-3)", lineHeight: 1.55, margin: "0 0 18px" }}>This area is for Kanbo admins. An existing admin can give you access from the Accounts list. {email ? <>You're signed in as <strong>{email}</strong>.</> : null}</p>
        {onSignOut && <button className="btn btn-ghost" onClick={onSignOut} style={{ width: "100%", justifyContent: "center" }}>Sign out</button>}
      </div>
    </div>
  );
}

function Unverified({ onRetry, onSignOut, email }: { onRetry: () => void; onSignOut?: () => void; email?: string }) {
  return (
    <div style={{ position: "relative", minHeight: "100vh", display: "grid", placeItems: "center", padding: 20 }}>
      <AppBg />
      <div role="alert" className="glass anim-scalein" style={{ position: "relative", zIndex: 1, width: 380, maxWidth: "100%", padding: 28, borderRadius: 20, textAlign: "center", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "inline-flex", padding: 13, borderRadius: 14, background: "var(--surface-2)", marginBottom: 14 }}><Icon name="refresh" size={22} style={{ color: "var(--ink-4)" }} /></div>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 7 }}>Couldn't check your access</h2>
        <p style={{ fontSize: 13.5, color: "var(--ink-3)", lineHeight: 1.55, margin: "0 0 18px" }}>We couldn't reach Kanbo to confirm you're an admin. Check your connection and try again. {email ? <>You're signed in as <strong>{email}</strong>.</> : null}</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button className="btn btn-accent" onClick={onRetry} style={{ width: "100%", justifyContent: "center" }}><Icon name="refresh" size={15} /> Try again</button>
          {onSignOut && <button className="btn btn-ghost" onClick={onSignOut} style={{ width: "100%", justifyContent: "center" }}>Sign out</button>}
        </div>
      </div>
    </div>
  );
}
