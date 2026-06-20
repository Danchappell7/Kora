/* ============================================================
   KANBO — standalone internal admin/analytics app, served at /admin.
   NOT part of the consumer product: its own layout, no sidebar, not linked
   anywhere. Locked to admin-allowlisted logins.
   ============================================================ */
import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { LoginScreen } from "../auth/LoginScreen";
import { AdminView } from "../components/views/AdminView";
import { store } from "../data/store";
import { KanboLogo, Icon } from "../components/primitives";

// The founding admin is always allowed; other admins are recognised via the
// server-side is_admin() flag (so "grant admin" actually opens this dashboard).
export const ADMIN_EMAILS = ["danchappell7@gmail.com"];
export const isAdminEmail = (e?: string | null): boolean => !!e && ADMIN_EMAILS.includes(e.trim().toLowerCase());

export function AdminApp() {
  const auth = useAuth();
  // null = still checking the is_admin() flag; true/false = resolved.
  const [flagAdmin, setFlagAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (!auth.configured) { setFlagAdmin(true); return; }
    if (!auth.user) { setFlagAdmin(null); return; }
    if (isAdminEmail(auth.user.email)) { setFlagAdmin(true); return; }
    let on = true;
    store.amIAdmin().then((ok) => on && setFlagAdmin(ok)).catch(() => on && setFlagAdmin(false));
    return () => { on = false; };
  }, [auth.configured, auth.user]);

  // Demo mode (no backend configured) — show the dashboard for local preview.
  if (auth.configured) {
    if (auth.loading) return <Centered>Loading…</Centered>;
    if (!auth.user) return <LoginScreen />; // must sign in first
    if (flagAdmin === null) return <Centered>Loading…</Centered>;
    if (!flagAdmin) return <NotAuthorised onSignOut={auth.signOut} email={auth.user.email} />;
  }

  return (
    <div style={{ position: "relative", height: "100vh", overflow: "hidden" }}>
      <div className="app-bg" />
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
  return <div style={{ position: "relative", minHeight: "100vh", display: "grid", placeItems: "center" }}><div className="app-bg" /><span style={{ position: "relative", zIndex: 1, color: "var(--ink-4)", fontSize: 14 }}>{children}</span></div>;
}

function NotAuthorised({ onSignOut, email }: { onSignOut?: () => void; email?: string }) {
  return (
    <div style={{ position: "relative", minHeight: "100vh", display: "grid", placeItems: "center", padding: 20 }}>
      <div className="app-bg" />
      <div className="glass anim-scalein" style={{ position: "relative", zIndex: 1, width: 380, maxWidth: "100%", padding: 28, borderRadius: 20, textAlign: "center", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "inline-flex", padding: 13, borderRadius: 14, background: "var(--surface-2)", marginBottom: 14 }}><Icon name="lock" size={22} style={{ color: "var(--ink-4)" }} /></div>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 7 }}>Not authorised</h2>
        <p style={{ fontSize: 13.5, color: "var(--ink-3)", lineHeight: 1.55, margin: "0 0 18px" }}>This area is for the Kanbo team only. {email ? <>You're signed in as <strong>{email}</strong>.</> : null}</p>
        {onSignOut && <button className="btn btn-ghost" onClick={onSignOut} style={{ width: "100%", justifyContent: "center" }}>Sign out</button>}
      </div>
    </div>
  );
}
