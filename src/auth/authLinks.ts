/* ============================================================
   KANBO — auth email links (pure helpers, unit-tested)
   Three shapes of URL can land a visitor on the app from an email:
   - scanner-safe links:  ?token_hash=…&type=invite|recovery|signup|email|…
     Nothing is consumed on load (mail scanners pre-fetch links); the
     token is only verified when the person clicks Continue.
   - legacy implicit links: #access_token=…&type=invite|recovery
     supabase-js consumes these itself; we only note the type so an
     invitee still gets the set-password screen.
   - failed links: #error=access_denied&error_code=otp_expired&…
     (or the same keys in the query string). We turn these into a
     friendly message and strip them from the address bar.
   ============================================================ */

export type LinkType = "invite" | "recovery" | "signup" | "email" | "magiclink" | "email_change";
export interface PendingLink { tokenHash: string; type: LinkType }
export interface LinkError { kind: "expired" | "failed"; message: string }
export interface AuthUrlState {
  pendingLink: PendingLink | null;
  linkError: LinkError | null;
  /** `type` of a legacy #access_token link (supabase-js signs the user in from it) */
  implicitType: string | null;
  /** the address to show once error params are removed; null when there's nothing to strip */
  cleanUrl: string | null;
}

/** sessionStorage flag: this tab owes the user a set-password screen (survives reloads) */
export const NEEDS_PASSWORD_KEY = "kanbo-needs-password";

const LINK_TYPES: LinkType[] = ["invite", "recovery", "signup", "email", "magiclink", "email_change"];
const ERROR_KEYS = ["error", "error_code", "error_description"];

export const EXPIRED_MESSAGE = "That link has expired — send yourself a new one.";

/** invite and recovery links exist to set a password; the others just sign you in */
export const linkNeedsPassword = (t: string | null | undefined): boolean => t === "invite" || t === "recovery";

/** Is this Supabase error an expired / already-used email link? */
export function isExpiredLinkError(e: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!e) return false;
  if (e.code === "otp_expired") return true;
  return /expired|invalid|already been used/i.test(e.message ?? "");
}

function hashParams(hash: string): URLSearchParams | null {
  const raw = hash.replace(/^#/, "");
  if (!raw || !raw.includes("=")) return null; // a plain #anchor, not auth params
  try { return new URLSearchParams(raw); } catch { return null; }
}

function toLinkError(code: string | null, description: string | null, error: string | null): LinkError {
  if (isExpiredLinkError({ code, message: description })) return { kind: "expired", message: EXPIRED_MESSAGE };
  const detail = (description ?? "").trim();
  if (error === "access_denied" && !detail) return { kind: "failed", message: "Sign-in was cancelled. You can try again below." };
  return { kind: "failed", message: detail ? `That sign-in link didn’t work: ${detail.replace(/\.$/, "")}.` : "That sign-in link didn’t work. Please try again." };
}

export function readAuthUrl(href: string): AuthUrlState {
  const empty: AuthUrlState = { pendingLink: null, linkError: null, implicitType: null, cleanUrl: null };
  let url: URL;
  try { url = new URL(href); } catch { return empty; }
  const hp = hashParams(url.hash);
  const sp = url.searchParams;
  const get = (k: string) => sp.get(k) ?? hp?.get(k) ?? null;

  // ---- failed link ----
  let linkError: LinkError | null = null;
  let cleanUrl: string | null = null;
  const hashHasError = !!hp && ERROR_KEYS.some((k) => hp.has(k));
  const searchHasError = ERROR_KEYS.some((k) => sp.has(k));
  if (hashHasError || searchHasError) {
    linkError = toLinkError(get("error_code"), get("error_description"), get("error"));
    const clean = new URL(url.href);
    ERROR_KEYS.forEach((k) => clean.searchParams.delete(k));
    if (hashHasError) clean.hash = "";
    cleanUrl = clean.pathname + clean.search + clean.hash;
  }

  // ---- scanner-safe token link (verified only on click) ----
  const tokenHash = sp.get("token_hash");
  const type = sp.get("type") as LinkType | null;
  const pendingLink = !linkError && tokenHash && type && LINK_TYPES.includes(type) ? { tokenHash, type } : null;

  // ---- legacy implicit link (supabase-js handles the session) ----
  const implicitType = hp?.get("access_token") ? hp.get("type") : null;

  return { pendingLink, linkError, implicitType, cleanUrl };
}

/** `href` without the given query params (and without a trailing lone "?") */
export function withoutParams(href: string, keys: string[]): string {
  const url = new URL(href);
  keys.forEach((k) => url.searchParams.delete(k));
  return url.pathname + url.search + url.hash;
}

/** Turn raw Supabase auth errors into plain, British-English guidance. */
export function friendlyAuthError(message: string | undefined | null): string {
  const m = (message ?? "").trim();
  if (!m) return "Something went wrong. Please try again.";
  if (/invalid login credentials/i.test(m)) return "That email and password don’t match. Try again, or reset your password.";
  if (/email not confirmed/i.test(m)) return "Please confirm your email first — check your inbox for the link.";
  if (/user already registered|already been registered/i.test(m)) return "An account with that email already exists. Try signing in instead.";
  if (/signups? not allowed|signup is disabled/i.test(m)) return "Kanbo accounts are invite-only. Ask your workspace admin to invite you.";
  if (/password should be at least/i.test(m)) return m.replace(/\.?$/, ".");
  if (/failed to fetch|network/i.test(m)) return "Can’t reach Kanbo right now. Check your connection and try again.";
  return m;
}
