/* ============================================================
   KANBO — auth context
   In demo mode (no Supabase env) there's a synthetic always-on
   user so the app runs without a backend. With Supabase
   configured, this tracks the real session.
   ============================================================ */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import { setUserContext } from "../lib/monitoring";

interface AuthValue {
  configured: boolean;
  loading: boolean;
  recovery: boolean;
  user: { id: string; email?: string; name?: string } | null;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (email: string, password: string) => Promise<{ error?: string }>;
  signInWithGoogle: () => Promise<{ error?: string }>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
  updatePassword: (password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
}

const DEMO_USER = { id: "m-self", email: "daniel@kanbo.app", name: "Daniel Okai" };

const AuthContext = createContext<AuthValue | null>(null);

function mapUser(u: User | null): AuthValue["user"] {
  if (!u) return null;
  return { id: u.id, email: u.email ?? undefined, name: (u.user_metadata?.name as string) ?? u.email ?? undefined };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthValue["user"]>(isSupabaseConfigured ? null : DEMO_USER);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setUser(mapUser(data.session?.user ?? null));
      setLoading(false);
    });
    // fires on sign-in, sign-out, and token refresh/expiry → keeps the UI gated
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      setUser(mapUser(session?.user ?? null));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => { setUserContext(user ? { id: user.id, email: user.email } : null); }, [user]);

  const value: AuthValue = {
    configured: isSupabaseConfigured,
    loading,
    recovery,
    user,
    async signIn(email, password) {
      if (!supabase) return {};
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error: error?.message };
    },
    async signUp(email, password) {
      if (!supabase) return {};
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) return { error: error.message };
      // With email confirmation OFF, signing up an already-registered address
      // returns a user with an empty identities array and no error — surface it
      // instead of showing a false "signing you in…" that never completes.
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        return { error: "An account with that email already exists. Try signing in instead." };
      }
      return {};
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
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      return { error: error?.message };
    },
    async updatePassword(password) {
      if (!supabase) return {};
      const { error } = await supabase.auth.updateUser({ password });
      if (!error) setRecovery(false);
      return { error: error?.message };
    },
    async signOut() {
      if (!supabase) return;
      // never strand the user (e.g. mid account-deletion) if the network call
      // fails — force local signed-out state regardless.
      try { await supabase.auth.signOut(); } catch { /* ignore */ }
      setUser(null);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
