/* ============================================================
   KANBO — QR codes, pure (no dependencies).                     [f9-public-forms]
   Byte-mode QR (ISO/IEC 18004), versions 1–40, Reed–Solomon error
   correction, the eight masks scored by the standard penalty rules.
   Renders as one SVG <path> so it scales crisply and themes by colour.
   CONTRACT STUB — f9 replaces the bodies, keeps every exported name/signature.
   ============================================================ */

export type QrEcc = "L" | "M" | "Q" | "H";

export interface QrMatrix {
  /** modules per side (21 for version 1 … 177 for version 40) */
  size: number;
  /** modules[y][x]: true = dark */
  modules: boolean[][];
}

/** Encode text (UTF-8, byte mode) at the smallest version that fits. Throws if it can't fit version 40. */
export function encodeQr(text: string, ecc: QrEcc = "M"): QrMatrix {
  void text; void ecc;
  return { size: 0, modules: [] };
}

/** One path covering every dark module, with a quiet-zone margin (default 4 modules). */
export function qrPath(m: QrMatrix, margin = 4): { d: string; viewBox: string; size: number } {
  void m;
  return { d: "", viewBox: `0 0 ${margin * 2} ${margin * 2}`, size: margin * 2 };
}

/** A standalone SVG string (role="img", <title>) for downloads and tests. */
export function qrSvg(text: string, opts: { ecc?: QrEcc; margin?: number; title?: string; dark?: string; light?: string } = {}): string {
  void text; void opts;
  return "";
}
