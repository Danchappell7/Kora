/* ============================================================
   KANBO — the window a printable poster opens in (lib/packPoster).
   Opened inside the click, before anything is awaited (a window
   opened after a wait is often blocked), saying the poster is on its
   way; the poster replaces it. Kept on its own so the click handler
   carries none of the QR code.
   ============================================================ */

/** The poster's window, or null when the browser blocked it. */
export function openPosterWindow(): Window | null {
  let w: Window | null = null;
  try { w = window.open("", "_blank"); } catch { w = null; }
  if (!w) return null;
  try {
    w.document.write(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Preparing your poster…</title></head><body style="font:15px/1.5 -apple-system,'Segoe UI',sans-serif;color:#3A4152;padding:40px;text-align:center">Preparing your poster…</body></html>`);
    w.document.close();
  } catch { /* the window is there; the poster replaces this */ }
  return w;
}
