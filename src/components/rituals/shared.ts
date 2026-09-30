/* ============================================================
   KANBO — small helpers the Inbox, Shut down and Weekly review share.
   ============================================================ */
import { useToast } from "../Toast";

/** The toast stack lives in App; rendered on its own (tests, previews) a
 *  page simply doesn't toast. */
export function useOptionalToast() {
  try { return useToast(); } catch { return null; }
}

/** The person has asked for less motion. */
export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Put plain text on the clipboard. Falls back to the old copy command where
 *  the Clipboard API is missing or blocked. Resolves false when neither works. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the old way */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand?.("copy") ?? false;
    ta.remove();
    return ok;
  } catch { return false; }
}
