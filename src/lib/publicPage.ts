/* ============================================================
   KANBO — what main.tsx needs to know about a public request form
   before anything else loads: is this address one (/f/<token>), and
   the page's own theme. Nothing else, so the first download stays
   small (the rest of the public-forms code is lib/publicForms, which
   re-exports these two).
   ============================================================ */

/** "/f/<token>" (optionally with a trailing slash) → the token; null for any other path. */
export function publicFormTokenFromPath(pathname: string): string | null {
  const m = /^\/f\/([A-Za-z0-9_-]{1,128})\/?$/.exec(pathname || "");
  return m ? m[1] : null;
}

/* ---------------- the public page's theme ---------------- */

/**
 * The public page is Paper unless the visitor's system is dark. It ignores
 * the app's saved theme (a requester isn't a Kanbo user). Sets data-theme on
 * <html> now and follows system changes; returns the clean-up.
 */
export function applyPublicTheme(): () => void {
  if (typeof document === "undefined") return () => {};
  const root = document.documentElement;
  let mq: MediaQueryList | null = null;
  try { mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null; } catch { mq = null; }
  const set = () => root.setAttribute("data-theme", mq?.matches ? "dark" : "light");
  set();
  if (!mq) return () => {};
  const on = () => set();
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", on);
  else mq.addListener?.(on);
  return () => {
    if (typeof mq!.removeEventListener === "function") mq!.removeEventListener("change", on);
    else mq!.removeListener?.(on);
  };
}
