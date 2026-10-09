/* ============================================================
   KANBO — the "Continue with Google" button, drawn to Google's
   sign-in branding guidelines (developers.google.com/identity/
   branding-guidelines): the standard four-colour "G" on its own,
   Roboto Medium 14/20 (the UI face where Roboto isn't installed),
   40px tall, pill shape, 12px side padding and 10px between mark
   and text; light theme #FFFFFF fill · #747775 edge · #1F1F1F text,
   dark theme #131314 · #8E918F · #E3E3E3; hover and press as an 8% /
   12% layer of the text colour. Kanbo's own focus ring for keyboards.
   Plus useGoogleSignIn(): the `hd` hint and whether the button may be
   used (Google on AND "Confirm email" on: googleSignIn.ts › readiness).
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { hdSetting, loadGoogleHint, loadGoogleReadiness, type GoogleReadiness } from "./googleSignIn";
import "./googleButton.css";

export function GoogleButton({ onClick, busy, label = "Continue with Google", describedBy }: {
  onClick: () => void;
  busy?: boolean;
  label?: string;
  describedBy?: string;
}) {
  return (
    <button type="button" className="kgsi" onClick={onClick} disabled={busy} aria-busy={busy || undefined} aria-describedby={describedBy}>
      <span className="kgsi-state" aria-hidden="true" />
      <span className="kgsi-content">
        <GoogleG />
        <span className="kgsi-text">{busy ? "Opening Google…" : label}</span>
      </span>
    </button>
  );
}

/** Google's standard "G" (unaltered colours and proportions). */
export function GoogleG({ size = 20 }: { size?: number }) {
  return (
    <svg className="kgsi-icon" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      <path fill="none" d="M0 0h48v48H0z" />
    </svg>
  );
}

/** For the sign-in page: the `hd` hint (null = none), whether "Continue with Google" may be used
 *  ("pending" until Supabase's public settings answer), and `whenReady()`, which waits for that
 *  answer — a press before it arrives waits too, so Google is never opened while Supabase says
 *  the provider or "Confirm email" is off. Does nothing while `enabled` is false. */
export function useGoogleSignIn(enabled: boolean): {
  hd: string | null;
  readiness: GoogleReadiness | "pending";
  whenReady: () => Promise<GoogleReadiness>;
} {
  const [hd, setHd] = useState<string | null>(() => {
    const s = hdSetting(import.meta.env.VITE_GOOGLE_HD);
    return enabled && s.mode === "fixed" ? s.domain : null;
  });
  const [readiness, setReadiness] = useState<GoogleReadiness | "pending">(enabled ? "pending" : "unknown");
  const ready = useRef<Promise<GoogleReadiness> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* blocked */ }
    const client = supabase;
    const setting = hdSetting(import.meta.env.VITE_GOOGLE_HD);
    // a fixed or switched-off hint is known already (the initial state); only "auto" asks
    if (setting.mode === "auto" && client) {
      loadGoogleHint({ setting, rpc: () => client.rpc("sign_in_hints"), storage })
        .then((v) => { if (alive) setHd(v); });
    }
    // the public settings, straight from the project's address (no session needed)
    const p = loadGoogleReadiness({
      supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
      anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
    });
    ready.current = p;
    void p.then((v) => { if (alive) setReadiness(v); });
    return () => { alive = false; };
  }, [enabled]);
  const whenReady = useCallback(async (): Promise<GoogleReadiness> => (ready.current ? ready.current : "unknown"), []);
  return { hd, readiness, whenReady };
}
