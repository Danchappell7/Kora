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
/** expired: a password link (invite/recovery) → "send yourself a new one";
 *  confirm-expired: an email-confirmation / sign-in link → just sign in */
export interface LinkError { kind: "expired" | "confirm-expired" | "failed"; message: string }
export interface AuthUrlState {
  pendingLink: PendingLink | null;
  linkError: LinkError | null;
  /** the raw error params, for monitoring only — never shown on screen */
  errorDetail: { error: string | null; code: string | null; description: string | null } | null;
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
export const CONFIRM_EXPIRED_MESSAGE = "That confirmation link has expired or was already used. Sign in below — if your email still needs confirming, we’ll offer to send a new link.";
const INVITE_ONLY = "Kanbo accounts are invite-only. Ask your workspace admin to invite you.";

/** invite and recovery links exist to set a password; the others just sign you in */
export const linkNeedsPassword = (t: string | null | undefined): boolean => t === "invite" || t === "recovery";

/** Is this Supabase error an expired / already-used email link?
 *  (Supabase says "Email link is invalid or has expired" / "Token has expired
 *  or is invalid" — a bare "invalid", e.g. an OAuth "invalid state", is not.) */
export function isExpiredLinkError(e: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!e) return false;
  if (e.code === "otp_expired") return true;
  return /\bhas expired\b|already been used/i.test(e.message ?? "");
}

/** The right "that link is dead" explanation for this kind of link. A
 *  password link offers a new one; a confirmation link just needs a sign-in
 *  (which offers to resend the confirmation if it's still needed). */
export function expiredLinkError(type: string | null | undefined): LinkError {
  return type && !linkNeedsPassword(type) && (LINK_TYPES as string[]).includes(type)
    ? { kind: "confirm-expired", message: CONFIRM_EXPIRED_MESSAGE }
    : { kind: "expired", message: EXPIRED_MESSAGE };
}

function hashParams(hash: string): URLSearchParams | null {
  const raw = hash.replace(/^#/, "");
  if (!raw || !raw.includes("=")) return null; // a plain #anchor, not auth params
  try { return new URLSearchParams(raw); } catch { return null; }
}

/** Supabase error codes that arrive on a redirect (email link or Google). */
const REDIRECT_ERROR_COPY: Record<string, string> = {
  signup_disabled: "That account isn’t on Kanbo yet — accounts are invite-only. Ask your workspace admin to invite you, then sign in with the invited address.",
  user_banned: "This account has been suspended. Contact your workspace admin.",
  email_not_confirmed: "Please confirm your email first — check your inbox for the link.",
  provider_email_needs_verification: "Verify your email address with Google first, then try again.",
  bad_oauth_state: "That sign-in didn’t complete. Please try again.",
  bad_oauth_callback: "That sign-in didn’t complete. Please try again.",
  flow_state_expired: "That sign-in took too long to complete. Please try again.",
  flow_state_not_found: "That sign-in didn’t complete. Please try again.",
};

/** The URL is attacker-controllable: anyone can send a kanbo.co.uk link with
 *  their own error_description. Only ever show fixed copy — never that text. */
function toLinkError(code: string | null, description: string | null, error: string | null, type: string | null): LinkError {
  if (isExpiredLinkError({ code, message: description })) return expiredLinkError(type);
  const known = (code && REDIRECT_ERROR_COPY[code]) || knownAuthError(description);
  if (known) return { kind: "failed", message: known };
  if (error === "access_denied") return { kind: "failed", message: "Sign-in was cancelled or didn’t complete. You can try again below." };
  return { kind: "failed", message: "That sign-in didn’t work. Please try again, or ask your workspace admin for help." };
}

export function readAuthUrl(href: string): AuthUrlState {
  const empty: AuthUrlState = { pendingLink: null, linkError: null, errorDetail: null, implicitType: null, cleanUrl: null };
  let url: URL;
  try { url = new URL(href); } catch { return empty; }
  const hp = hashParams(url.hash);
  const sp = url.searchParams;
  const get = (k: string) => sp.get(k) ?? hp?.get(k) ?? null;

  // ---- failed link ----
  let linkError: LinkError | null = null;
  let errorDetail: AuthUrlState["errorDetail"] = null;
  let cleanUrl: string | null = null;
  const hashHasError = !!hp && ERROR_KEYS.some((k) => hp.has(k));
  const searchHasError = ERROR_KEYS.some((k) => sp.has(k));
  if (hashHasError || searchHasError) {
    errorDetail = { error: get("error"), code: get("error_code"), description: get("error_description") };
    linkError = toLinkError(errorDetail.code, errorDetail.description, errorDetail.error, get("type"));
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

  return { pendingLink, linkError, errorDetail, implicitType, cleanUrl };
}

/** `href` without the given query params (and without a trailing lone "?") */
export function withoutParams(href: string, keys: string[]): string {
  const url = new URL(href);
  keys.forEach((k) => url.searchParams.delete(k));
  return url.pathname + url.search + url.hash;
}

/** Plain, British-English copy for the Supabase auth errors we recognise; null otherwise. */
function knownAuthError(message: string | undefined | null): string | null {
  const m = (message ?? "").trim();
  if (/invalid login credentials/i.test(m)) return "That email and password don’t match. Try again, or reset your password.";
  if (/email not confirmed/i.test(m)) return "Please confirm your email first — check your inbox for the link.";
  if (/user already registered|already been registered/i.test(m)) return "An account with that email already exists. Try signing in instead.";
  if (/signups? not allowed|signup is disabled/i.test(m)) return INVITE_ONLY;
  if (/failed to fetch|network/i.test(m)) return "Can’t reach Kanbo right now. Check your connection and try again.";
  return null;
}

/** Turn raw Supabase auth errors (from an API response) into plain guidance. */
export function friendlyAuthError(message: string | undefined | null): string {
  const m = (message ?? "").trim();
  if (!m) return "Something went wrong. Please try again.";
  const known = knownAuthError(m);
  if (known) return known;
  if (/password should be at least/i.test(m)) return m.replace(/\.?$/, ".");
  return m;
}
