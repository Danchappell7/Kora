/* ============================================================
   KANBO — a request form's printable QR poster.
   One A4 page: a big headline ("Something broken?"), a line under
   it, the QR code that opens the form's public page, how to use it,
   the link written out for anyone without a camera, and whose form it
   is. Dark on white whatever the theme (inverted codes don't scan
   everywhere), with the project's colour as a thin band. Opened in
   its own window and handed to the browser's print dialog, as the
   task list's PDF export is (lib/exportTasks printTasks).
   Pure except the window helpers at the end.
   ============================================================ */
import { qrSvg } from "./qr";
import { openPosterWindow } from "./posterWindow";

export { openPosterWindow };

export interface PosterInput {
  /** the big line ("Something broken?"); the form's name when it has no poster words */
  headline: string;
  line?: string;
  formName: string;
  projectName?: string;
  workspaceName?: string;
  /** the form's public link */
  url: string;
  /** the project's colour, for the band (a CSS colour) */
  color?: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** A colour safe in a style attribute (hex, rgb/hsl/oklch(), names); else Kanbo's navy. */
const safeColour = (c: string | undefined) =>
  c && /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|rgba|hsl|hsla|oklch|oklab)\([0-9a-z.,%\s/+-]*\))$/i.test(c.trim()) ? c.trim() : "#1F2A44";

/** The poster as a whole HTML document. */
export function posterHtml(p: PosterInput): string {
  const qr = qrSvg(p.url, { ecc: "M", margin: 4, title: `QR code that opens the ${p.formName} form`, dark: "#0B1020", light: "#FFFFFF" });
  const whose = [p.formName, p.projectName, p.workspaceName].filter((x): x is string => !!x && !!x.trim()).map(esc).join(" · ");
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${esc(p.headline)}</title><style>
@page{size:A4 portrait;margin:0}
*{box-sizing:border-box}
html,body{margin:0;background:#fff;color:#0B1020;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{width:210mm;min-height:297mm;margin:0 auto;padding:18mm 20mm 16mm;display:flex;flex-direction:column;align-items:center;text-align:center;background:#fff}
.band{width:100%;height:6mm;border-radius:3mm;background:${safeColour(p.color)}}
h1{margin:20mm 0 0;font-size:46pt;line-height:1.08;letter-spacing:-0.02em;font-weight:700;text-wrap:balance}
.line{margin:6mm 0 0;font-size:19pt;line-height:1.35;color:#3A4152;text-wrap:balance;max-width:150mm}
.qr{margin:16mm 0 0;width:112mm;height:112mm}
.qr svg{width:100%;height:100%;display:block}
.how{margin:8mm 0 0;font-size:15pt;font-weight:600}
.url{margin:3mm 0 0;font:11pt/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#5B6275;word-break:break-all;max-width:160mm}
.foot{margin-top:auto;padding-top:10mm;font-size:11pt;color:#7A8193}
.hint{font:13px/1.5 -apple-system,"Segoe UI",sans-serif;color:#5B6275;text-align:center;margin:16px}
@media screen{html,body{background:#E9EBF0}.sheet{margin:0 auto 32px;box-shadow:0 1px 3px rgba(11,16,32,.12),0 12px 40px -12px rgba(11,16,32,.25)}}
@media print{.hint{display:none}}
</style></head><body>
<p class="hint">Use your browser's Print dialog to print this poster or save it as a PDF.</p>
<main class="sheet">
<div class="band" aria-hidden="true"></div>
<h1>${esc(p.headline)}</h1>
${p.line ? `<p class="line">${esc(p.line)}</p>` : ""}
<div class="qr">${qr}</div>
<p class="how">Point your phone's camera at the code</p>
<p class="url">${esc(p.url)}</p>
<p class="foot">${whose}</p>
</main>
</body></html>`;
}

/** Put the poster in its window and open the print dialog. */
export function showPoster(w: Window, p: PosterInput, print = true): void {
  w.document.open();
  w.document.write(posterHtml(p));
  w.document.close();
  w.focus();
  if (print) window.setTimeout(() => { try { w.print(); } catch { /* closed meanwhile */ } }, 300);
}

/** Open and print a poster in one go (the link is already known). False when the window was blocked. */
export function printPoster(p: PosterInput): boolean {
  const w = openPosterWindow();
  if (!w) return false;
  showPoster(w, p);
  return true;
}
