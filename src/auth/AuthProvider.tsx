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
import { setUserContext, reportError } from "../lib/monitoring";
import { offlineQueue } from "../lib/offlineQueue";
import { store } from "../data/store";
import {
  readAuthUrl, withoutParams, linkNeedsPassword, isExpiredLinkError, expiredLinkError, friendlyAuthError,
  NEEDS_PASSWORD_KEY, type LinkError, type LinkType, type PendingLink,
} from "./authLinks";
import { claimLocalData, parkLocalData, clearLocalUserData, forgetStoredSession, isAuthStorageKey, pageNav } from "./localData";
import { UnsyncedSignOutDialog } from "./UnsyncedSignOutDialog";
import { clearTaskDrafts } from "../components/taskDetailHelpers";
import { disablePush, watchPushSession } from "../lib/push";

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
   *  (e.g. straight after deleting the account) or the account no longer
   *  exists on the server. */
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
/** the client's persisted-session key (GoTrueClient keeps it on a protected field) */
const authStorageKey = () => (supabase?.auth as unknown as { storageKey?: string } | undefined)?.storageKey ?? null;

/** Has the server stopped recognising this session (account deleted, session
 *  revoked)? Queued edits can then never sync, so there's nothing to protect. */
async function sessionIsGone(): Promise<boolean> {
  if (!supabase || (typeof navigator !== "undefined" && navigator.onLine === false)) return false;
  try {
    // don't leave the Sign out click hanging on a slow network — ask instead
    const res = await Promise.race([
      supabase.auth.getUser(),
      new Promise<null>((r) => setTimeout(() => r(null), 2500)),
    ]);
    const error = res?.error;
    if (!error) return false;
    if (error.name === "AuthSessionMissingError") return true;
    return !isNetworkFailure(error) && [401, 403, 404].includes(error.status ?? 0);
  } catch { return false; }
}

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
  /** the account this page has shown (its in-memory state belongs to them) */
  const pageUid = useRef<string | null>(null);
  /** a reload is under way — don't expose anything else to the app */
  const reloading = useRef(false);

  const setUser = useCallback((next: AuthValue["user"]) => setUserRaw((prev) => (sameUser(prev, next) ? prev : next)), []);
  const setPasswordReason = useCallback((r: PasswordReason | null) => { writePasswordReason(r); setPasswordReasonRaw(r); }, []);

  // a failed/expired link's params are explained on screen — tidy the address bar
  useEffect(() => {
    if (BOOT?.cleanUrl) { try { window.history.replaceState(window.history.state, "", BOOT.cleanUrl); } catch { /* ignore */ } }
    // its raw text is never shown (anyone can craft one) — keep it for debugging
    if (BOOT?.linkError?.kind === "failed" && BOOT.errorDetail) {
      const { error, code, description } = BOOT.errorDetail;
      reportError(new Error("Auth redirect error"), { error, code, description: description?.slice(0, 200) ?? null });
    }
  }, []);

  // Every session change goes through here before the app sees it.
  const adopt = useCallback((u: User | null) => {
    if (reloading.current) return;
    if (!u) {
      // The session ended without this tab signing out (another tab signed
      // out, or it expired): park this tab's unsynced edits under that
      // account, so they can't replay as whoever signs in next.
      if (pageUid.current && !signingOut.current) parkLocalData(pageUid.current);
      setUser(null);
      return;
    }
    // make sure this device's offline cache belongs to this account first;
    // if another account's state is in this page, start from a fresh page
    if (claimLocalData(u.id)) { reloading.current = true; pageNav.reload(); return; }
    pageUid.current = u.id;
    setLinkError(null); // signed in: an old link error no longer applies
    setUser(mapUser(u));
  }, [setUser]);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    supabase.auth.getSession()
      .then(({ data }) => { if (alive) adopt(data.session?.user ?? null); })
      .catch(() => { /* treat as signed out */ })
      .finally(() => { if (alive && !reloading.current) setLoading(false); });
    // fires on sign-in, sign-out, and token refresh/expiry → keeps the UI gated
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setPasswordReason("recovery");
      adopt(session?.user ?? null);
    });
    // Another tab dropped the stored session without a sign-out broadcast
    // (see finishSignOut when offline): this tab is signed out too.
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.newValue === null && pageUid.current && isAuthStorageKey(e.key, authStorageKey())) adopt(null);
    };
    window.addEventListener("storage", onStorage);
    return () => { alive = false; sub.subscription.unsubscribe(); window.removeEventListener("storage", onStorage); };
  }, [adopt, setPasswordReason]);

  // The push sign-out guard, for the life of the page: when nobody is signed in (or
  // someone else signs in) this browser's push subscription is dropped, so the next
  // person at a shared desk never sees the last person's notifications. Push is only
  // offered while it runs. A no-op in demo mode.
  useEffect(() => watchPushSession(), []);

  useEffect(() => { setUserContext(user ? { id: user.id, email: user.email } : null); }, [user]);

  const finishSignOut = useCallback(async () => {
    if (supabase) {
      // this device's push row goes while the session can still delete it (never
      // throws; ~6 s at worst, usually milliseconds). Every sign-out comes through here.
      await disablePush();
      let failed = false;
      try {
        // this device only: supabase-js defaults to "global", which would also
        // sign you out on your phone when you leave a shared office PC ("Sign
        // out of all devices" in Settings is the global one)
        const res = await Promise.race([supabase.auth.signOut({ scope: "local" }), new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
        failed = !res || !!res.error;
      } catch { failed = true; }
      // Offline, on an Auth 5xx or a hung request, supabase-js keeps the
      // session in storage, and the reload below would sign this person
      // straight back in — on a shared desk, for the next person. Drop the
      // stored session ourselves.
      if (failed) {
        try { await supabase.auth.stopAutoRefresh?.(); } catch { /* ignore */ }
        forgetStoredSession(authStorageKey());
      }
    }
    clearLocalUserData();
    // unsent comments and unsaved task text live in sessionStorage, which the
    // reload below keeps — don't leave them for the next person at this desk
    clearTaskDrafts();
    setPasswordReason(null);
    setPendingLink(null);
    reloading.current = true;
    setUserRaw(null);
    // start the next person on this device from a clean slate: reloading drops
    // every in-memory cache (tasks, filters, onboarding checks) of this account.
    pageNav.restart();
  }, [setPasswordReason]);

  // the sign-out guard's "sync now": replay the queue straight away. The page
  // reloads after sign-out, so App's optimistic-id swap isn't needed; if they
  // stay signed in, App's realtime refresh picks up the saved tasks.
  const syncNow = useCallback(() => store.flushQueue(), []);

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
        // a dead confirmation link just needs a sign-in; a dead password link, a
        // new link. (Already signed in? They simply carry on — nothing to explain.)
        if (!user) setLinkError(isExpiredLinkError(error) ? expiredLinkError(type) : { kind: "failed", message: friendlyAuthError(error.message) });
        return { error: error.message };
      }
      if (linkNeedsPassword(type)) setPasswordReason(type as PasswordReason);
      // set the user now (SIGNED_IN follows) so the screen goes straight on
      // to the password step instead of flashing the landing page
      const u = data.session?.user ?? null;
      if (u) adopt(u);
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
        const res = data as { fallback?: boolean; retryAfter?: number } | null;
        // (a throttled request is fine: the link sent under a minute ago still works)
        if (!error && !res?.fallback) return {};
        // Resend refused just after the function generated a link, so Supabase's
        // own reset would refuse for about a minute too — say so, don't fail twice
        if (!error && res?.retryAfter) return { error: "We couldn't send that just now. Try again in a minute." };
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
        // (a deleted account's edits can never sync — no point asking)
        if (!discard && offlineQueue.size() > 0 && !(await sessionIsGone())) {
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
      {guard && <UnsyncedSignOutDialog onSync={syncNow} onStay={() => guard.resolve(false)} onSignOut={() => guard.resolve(true)} />}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
