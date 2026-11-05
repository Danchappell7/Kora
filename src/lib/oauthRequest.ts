/* ============================================================
   KANBO — an AI app's sign-in request (/oauth/authorize?…), kept through
   signing in.                                                    [0050]
   Claude, ChatGPT or Cursor sends people here to press Allow. Signed out, a
   Google sign-in comes back to the home page, not to this address, so Root
   keeps the request's query string in this tab's sessionStorage and takes it
   out of the address bar at once: the address (with the app's state and PKCE
   challenge) never reaches history, logs or a Referer. Then the consent page
   opens from here straight after signing in. The same pattern as /link/slack.
   No imports: Root loads it before the app.
   ============================================================ */

export const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";
const PENDING_KEY = "kanbo:oauth-request";
const PENDING_MS = 15 * 60_000;
/** more than any real request needs */
const MAX_QUERY = 8 * 1024;

export function isOAuthAuthorizePath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === OAUTH_AUTHORIZE_PATH;
}

/** The query string on /oauth/authorize (no "?"), null anywhere else or when there's none. */
export function oauthQueryFromUrl(href: string): string | null {
  try {
    const u = new URL(href, "https://www.kanbo.co.uk");
    if (!isOAuthAuthorizePath(u.pathname)) return null;
    const q = u.search.replace(/^\?/, "");
    return q && q.length <= MAX_QUERY ? q : null;
  } catch { return null; }
}

function store(): Storage | null {
  try { return typeof window !== "undefined" ? window.sessionStorage : null; } catch { return null; }
}

/** Keep a request through signing in (this tab only, 15 minutes). False when storage is blocked: the address then has to keep it. */
export function rememberOAuthRequest(query: string, now = Date.now()): boolean {
  if (!query || query.length > MAX_QUERY) return false;
  try {
    const s = store();
    if (!s) return false;
    s.setItem(PENDING_KEY, JSON.stringify({ q: query, at: now }));
    return true;
  } catch { return false; }
}

/** A remembered request that's still fresh, or null. */
export function pendingOAuthRequest(now = Date.now()): string | null {
  try {
    const raw = store()?.getItem(PENDING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { q?: unknown; at?: unknown };
    const q = typeof v.q === "string" ? v.q : "";
    const at = Number(v.at);
    if (!q || q.length > MAX_QUERY || !Number.isFinite(at) || now - at > PENDING_MS || at > now + 60_000) { forgetOAuthRequest(); return null; }
    return q;
  } catch { return null; }
}

export function forgetOAuthRequest(): void {
  try { store()?.removeItem(PENDING_KEY); } catch { /* ignore */ }
}

/**
 * What the consent page should open with, called once as Root starts: the address's own request
 * (kept, then taken out of the address bar), else one remembered from before signing in.
 * On /oauth/authorize with nothing usable: "" (the page says the link isn't complete).
 * Null: there's no request, carry on as normal.
 */
export function takeOAuthRequest(now = Date.now()): string | null {
  if (typeof window === "undefined") return null;
  const here = oauthQueryFromUrl(window.location.href);
  if (here !== null) {
    if (rememberOAuthRequest(here, now)) {
      try { window.history.replaceState(window.history.state, "", OAUTH_AUTHORIZE_PATH); } catch { /* not a browser */ }
    }
    return here;
  }
  const pending = pendingOAuthRequest(now);
  if (pending !== null) return pending;
  return isOAuthAuthorizePath(window.location.pathname) ? "" : null;
}
