/* ============================================================
   KANBO — the Slack app's one-time link (/link/slack?t=…), kept through
   signing in.                                                    [0049]
   /kanbo shows an unlinked Slack person a link to /link/slack?t=<token>
   (15 minutes, single use). Signed out, Root remembers the token in this
   tab's sessionStorage before the sign-in screen (a Google sign-in comes
   back to the home page, not to the link), and App opens the link page from
   the address or from here once someone's signed in. No imports: Root
   loads it before the app.
   ============================================================ */

export const SLACK_LINK_PATH = "/link/slack";
export const SLACK_LINK_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const PENDING_KEY = "kanbo:slack-link";
const PENDING_MS = 15 * 60_000;

/** The token in /link/slack?t=… (null anywhere else, or for a malformed one). */
export function slackLinkTokenFromUrl(href: string): string | null {
  try {
    const u = new URL(href, "https://www.kanbo.co.uk");
    if (u.pathname.replace(/\/+$/, "") !== SLACK_LINK_PATH) return null;
    const t = u.searchParams.get("t") ?? "";
    return SLACK_LINK_TOKEN_RE.test(t) ? t : null;
  } catch { return null; }
}

function store(): Storage | null {
  try { return typeof window !== "undefined" ? window.sessionStorage : null; } catch { return null; }
}

/** Keep a link's token through signing in (this tab only, 15 minutes). */
export function rememberSlackLink(token: string, now = Date.now()): void {
  if (!SLACK_LINK_TOKEN_RE.test(token)) return;
  try { store()?.setItem(PENDING_KEY, JSON.stringify({ t: token, at: now })); } catch { /* storage blocked: the URL still carries it */ }
}

/** A remembered token that's still fresh, or null. */
export function pendingSlackLink(now = Date.now()): string | null {
  try {
    const raw = store()?.getItem(PENDING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { t?: unknown; at?: unknown };
    const t = typeof v.t === "string" ? v.t : "";
    const at = Number(v.at);
    if (!SLACK_LINK_TOKEN_RE.test(t) || !Number.isFinite(at) || now - at > PENDING_MS || at > now + 60_000) { forgetSlackLink(); return null; }
    return t;
  } catch { return null; }
}

export function forgetSlackLink(): void {
  try { store()?.removeItem(PENDING_KEY); } catch { /* ignore */ }
}

/** The link to open now: the address's own, else one remembered from before signing in. */
export function slackLinkToOpen(href: string, now = Date.now()): string | null {
  return slackLinkTokenFromUrl(href) ?? pendingSlackLink(now);
}


/** Is this address the link page (with or without a usable token)? */
export function isSlackLinkPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === SLACK_LINK_PATH;
}
