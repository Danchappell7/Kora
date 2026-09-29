/* ============================================================
   KANBO — auth context
   In demo mode (no Supabase env) there's a synthetic always-on
   user so the app runs without a backend. With Supabase
   configured, this tracks the real session, the email-link flows
   (invite / reset / confirm — see authLinks.ts) and keeps one
   account's offline cache from leaking into the next (localData.ts).
   ============================================================ */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import { setUserContext } from "../lib/monitoring";
import { offlineQueue } from "../lib/offlineQueue";
import {
  readAuthUrl, withoutParams, linkNeedsPassword, isExpiredLinkError, friendlyAuthError,
  EXPIRED_MESSAGE, NEEDS_PASSWORD_KEY, type LinkError, type LinkType, type PendingLink,
} from "./authLinks";
import { claimLocalData, clearLocalUserData } from "./localData";
import { UnsyncedSignOutDialog } from "./UnsyncedSignOutDialog";

type PasswordReason = "invite" | "recovery";
/** (a click event is accepted too, so `onClick={auth.signOut}` keeps working) */
type SignOutOptions = { discardUnsynced?: boolean };

interface AuthValue {
  configured: boolean;
  loading: boolean;
  /** an email-link flow owns the screen — confirming a link or choosing a
   *  password. App renders <UpdatePasswordScreen /> while this is true. */
  recovery: boolean;
  /** a scanner-safe ?token_hash link waiting for the person to click Continue */
  pendingLink: { type: LinkType } | null;
  /** why the signed-in user still has to choose a password, if they do */
  passwordReason: PasswordReason | null;
  /** an email link that expired or failed; the sign-in screen explains it */
  linkError: LinkError | null;
  clearLinkError: () => void;
  /** verify the pending link (only ever on an explicit click) */
  verifyLink: () => Promise<{ error?: string }>;
  user: { id: string; email?: string; name?: string } | null;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  /** needsConfirmation: the account exists but the email must be confirmed before signing in */
  signUp: (email: string, password: string) => Promise<{ error?: string; needsConfirmation?: boolean }>;
  resendConfirmation: (email: string) => Promise<{ error?: string }>;
  signInWithGoogle: () => Promise<{ error?: string }>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
  updatePassword: (password: string) => Promise<{ error?: string }>;
  /** Signs out, wipes this device's cached workspace + offline queue, and
   *  reloads so nothing from this account stays in memory. If edits are
   *  still unsynced the person is asked first, unless `discardUnsynced`
   *  (e.g. straight after deleting the account). */
  signOut: (opts?: SignOutOptions | SyntheticEvent) => Promise<void>;
}

const DEMO_USER = { id: "m-self", email: "daniel@kanbo.app", name: "Daniel Okai" };

const AuthContext = createContext<AuthValue | null>(null);

function mapUser(u: User | null): AuthValue["user"] {
  if (!u) return null;
  return { id: u.id, email: u.email ?? undefined, name: (u.user_metadata?.name as string) ?? u.email ?? undefined };
}
const sameUser = (a: AuthValue["user"], b: AuthValue["user"]) =>
  a === b || (!!a && !!b && a.id === b.id && a.email === b.email && a.name === b.name);

// Read the landing URL once, synchronously at load — before supabase-js
// consumes (and clears) an #access_token hash.
const BOOT = typeof window !== "undefined" && isSupabaseConfigured ? readAuthUrl(window.location.href) : null;

function readPasswordReason(): PasswordReason | null {
  try {
    const v = sessionStorage.getItem(NEEDS_PASSWORD_KEY);
    return v === "invite" || v === "recovery" ? v : v ? "recovery" : null;
  } catch { return null; }
}
function writePasswordReason(r: PasswordReason | null) {
  try { if (r) sessionStorage.setItem(NEEDS_PASSWORD_KEY, r); else sessionStorage.removeItem(NEEDS_PASSWORD_KEY); } catch { /* private mode */ }
}
const isNetworkFailure = (e: { name?: string; status?: number; message?: string }) =>
  e.name === "AuthRetryableFetchError" || e.status === 0 || /failed to fetch|network|load failed/i.test(e.message ?? "");

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserRaw] = useState<AuthValue["user"]>(isSupabaseConfigured ? null : DEMO_USER);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(BOOT?.pendingLink ?? null);
  const [linkError, setLinkError] = useState<LinkError | null>(BOOT?.linkError ?? null);
  const [passwordReason, setPasswordReasonRaw] = useState<PasswordReason | null>(() => {
    if (!isSupabaseConfigured) return null;
    const implicit = BOOT?.implicitType;
    if (linkNeedsPassword(implicit)) { writePasswordReason(implicit as PasswordReason); return implicit as PasswordReason; }
    return readPasswordReason();
  });
  const [guard, setGuard] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const signingOut = useRef(false);

  const setUser = useCallback((next: AuthValue["user"]) => setUserRaw((prev) => (sameUser(prev, next) ? prev : next)), []);
  const setPasswordReason = useCallback((r: PasswordReason | null) => { writePasswordReason(r); setPasswordReasonRaw(r); }, []);

  // a failed/expired link's params are explained on screen — tidy the address bar
  useEffect(() => {
    if (BOOT?.cleanUrl) { try { window.history.replaceState(window.history.state, "", BOOT.cleanUrl); } catch { /* ignore */ } }
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    // a session is about to become visible to the app: make sure this device's
    // offline cache belongs to that account first (never replay someone else's edits)
    const adopt = (u: User | null) => { if (u) claimLocalData(u.id); setUser(mapUser(u)); };
    supabase.auth.getSession()
      .then(({ data }) => { if (alive) adopt(data.session?.user ?? null); })
      .catch(() => { /* treat as signed out */ })
      .finally(() => { if (alive) setLoading(false); });
    // fires on sign-in, sign-out, and token refresh/expiry → keeps the UI gated
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setPasswordReason("recovery");
      adopt(session?.user ?? null);
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [setUser, setPasswordReason]);

  useEffect(() => { setUserContext(user ? { id: user.id, email: user.email } : null); }, [user]);

  const finishSignOut = useCallback(async () => {
    if (supabase) {
      // never strand the user (e.g. mid account-deletion) if the network call
      // fails — force local signed-out state regardless.
      try { await supabase.auth.signOut(); } catch { /* ignore */ }
    }
    clearLocalUserData();
    setPasswordReason(null);
    setPendingLink(null);
    setUserRaw(null);
    // start the next person on this device from a clean slate: reloading drops
    // every in-memory cache (tasks, filters, onboarding checks) of this account.
    try { window.location.replace(window.location.pathname); } catch { /* non-browser */ }
  }, [setPasswordReason]);

  const value: AuthValue = {
    configured: isSupabaseConfigured,
    loading,
    recovery: !!pendingLink || (!!passwordReason && !!user),
    pendingLink: pendingLink ? { type: pendingLink.type } : null,
    passwordReason: user ? passwordReason : null,
    linkError,
    clearLinkError: () => setLinkError(null),
    async verifyLink() {
      if (!supabase || !pendingLink) return {};
      const { tokenHash, type } = pendingLink;
      let res: Awaited<ReturnType<NonNullable<typeof supabase>["auth"]["verifyOtp"]>>;
      try { res = await supabase.auth.verifyOtp({ token_hash: tokenHash, type }); }
      catch (e) { return { error: friendlyAuthError(e instanceof Error ? e.message : String(e)) }; }
      const { data, error } = res;
      if (error && isNetworkFailure(error)) return { error: friendlyAuthError("network") }; // keep the link; let them retry
      // the token is spent (or dead) either way — don't leave it in the address bar
      try { window.history.replaceState(window.history.state, "", withoutParams(window.location.href, ["token_hash", "type", "next", "redirect_to"])); } catch { /* ignore */ }
      if (error) {
        setPendingLink(null);
        setLinkError(isExpiredLinkError(error) ? { kind: "expired", message: EXPIRED_MESSAGE } : { kind: "failed", message: friendlyAuthError(error.message) });
        return { error: error.message };
      }
      if (linkNeedsPassword(type)) setPasswordReason(type as PasswordReason);
      // set the user now (SIGNED_IN follows) so the screen goes straight on
      // to the password step instead of flashing the landing page
      const u = data.session?.user ?? null;
      if (u) { claimLocalData(u.id); setUser(mapUser(u)); }
      setPendingLink(null);
      return {};
    },
    user,
    async signIn(email, password) {
      if (!supabase) return {};
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error: error?.message };
    },
    async signUp(email, password) {
      if (!supabase) return {};
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
      if (error) return { error: error.message };
      // Signing up an already-registered address returns a user with an empty
      // identities array and no error — surface it instead of a false
      // "signing you in…" / "check your inbox" that never completes.
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        return { error: "An account with that email already exists. Try signing in instead." };
      }
      // With "Confirm email" ON there's no session until they click the link.
      return { needsConfirmation: !data.session };
    },
    async resendConfirmation(email) {
      if (!supabase) return {};
      const { error } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: window.location.origin } });
      return { error: error?.message };
    },
    async signInWithGoogle() {
      if (!supabase) return {};
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      return { error: error?.message };
    },
    async resetPassword(email) {
      if (!supabase) return {};
      // Prefer the edge function (generates the link and sends it via Resend,
      // so delivery doesn't depend on project SMTP). Fall back to Supabase's
      // built-in reset if it isn't deployed.
      try {
        const { data, error } = await supabase.functions.invoke("reset-password", { body: { email } });
        if (!error && !(data as { fallback?: boolean } | null)?.fallback) return {};
      } catch { /* not deployed — fall back below */ }
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      return { error: error?.message };
    },
    async updatePassword(password) {
      if (!supabase) return {};
      const { error } = await supabase.auth.updateUser({ password });
      if (!error) setPasswordReason(null);
      return { error: error?.message };
    },
    async signOut(opts) {
      if (!supabase || signingOut.current) return;
      // onClick={auth.signOut} passes a click event — only an explicit option counts
      const discard = !!opts && typeof opts === "object" && (opts as SignOutOptions).discardUnsynced === true;
      signingOut.current = true;
      try {
        if (!discard && offlineQueue.size() > 0) {
          const ok = await new Promise<boolean>((resolve) => setGuard({ resolve }));
          setGuard(null);
          if (!ok) return;
        }
        await finishSignOut();
      } finally {
        signingOut.current = false;
      }
    },
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
      {guard && <UnsyncedSignOutDialog onStay={() => guard.resolve(false)} onSignOut={() => guard.resolve(true)} />}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
