/* ============================================================
   KANBO — password rules + friendly auth errors for Settings →
   "Password & sign-in". Pure functions so they're unit-tested.
   ============================================================ */

export const PASSWORD_MIN = 8;
/** bcrypt ignores everything past 72 bytes, so Supabase Auth refuses longer passwords. */
export const PASSWORD_MAX = 72;

/** The first thing wrong with a new password + its confirmation, or null when it's good to go. */
export function passwordIssue(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (new TextEncoder().encode(password).length > PASSWORD_MAX) return `Use ${PASSWORD_MAX} characters or fewer.`;
  if (!password.trim()) return "A password can't be only spaces.";
  if (confirm !== password) return "The two passwords don't match.";
  return null;
}

/** Turns a Supabase Auth error message into something a teammate can act on. */
export function friendlyPasswordError(message: string | null | undefined): string {
  const raw = (message || "").trim();
  const m = raw.toLowerCase();
  if (!m) return "Couldn't update your password. Please try again.";
  if (m.includes("different from the old")) return "That's your current password. Choose a new one.";
  if (m.includes("reauthenticat")) return "For your security, sign out and back in, then change your password.";
  if (m.includes("session") && /(missing|expired|not found|invalid)/.test(m)) return "Your session has expired. Sign out and back in, then try again.";
  if (m.includes("known to be weak") || m.includes("pwned") || m.includes("breach") || m.includes("leaked")) {
    return "That password has appeared in a data breach, so it's easy to guess. Choose a different one.";
  }
  if (m.includes("rate limit") || m.includes("too many")) return "Too many attempts. Wait a minute, then try again.";
  if (m.includes("failed to fetch") || m.includes("network") || m.includes("load failed")) return "Couldn't reach Kanbo. Check your connection and try again.";
  return raw;
}

/** Same idea for "Sign out of all devices". */
export function friendlySignOutError(message: string | null | undefined): string {
  const m = (message || "").toLowerCase();
  if (m.includes("failed to fetch") || m.includes("network") || m.includes("load failed")) {
    return "Couldn't reach Kanbo, so nothing was signed out. Check your connection and try again.";
  }
  return "Couldn't sign out everywhere. You're still signed in. Please try again.";
}
