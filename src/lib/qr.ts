/* ============================================================
   KANBO — QR codes, pure (no dependencies).                     [f9-public-forms]
   Byte-mode QR (ISO/IEC 18004), versions 1–40, Reed–Solomon error
   correction, the eight masks scored by the standard penalty rules.
   Renders as one SVG <path> so it scales crisply and themes by colour.

   The steps, in the order the standard describes them:
     1. UTF-8 bytes in one byte-mode segment, at the smallest version that
        holds them (mode 0100, an 8- or 16-bit count, the bytes, a short
        terminator, then 0xEC 0x11 padding);
     2. split into blocks, a Reed–Solomon remainder per block over GF(256)
        (x⁸ + x⁴ + x³ + x² + 1), and the blocks interleaved;
     3. the function patterns (finders, separators, timing, alignment,
        format and version information, the dark module), then the
        codewords in the two-column zigzag from the bottom right;
     4. each of the eight masks tried and scored (N1 runs, N2 blocks, N3
        finder look-alikes, N4 balance); the lowest score wins.
   Pure: no DOM, no React. Tested in qr.test.ts with an independent
   reader that decodes the matrices back to text.
   ============================================================ */

export type QrEcc = "L" | "M" | "Q" | "H";

export interface QrMatrix {
  /** modules per side (21 for version 1 … 177 for version 40) */
  size: number;
  /** modules[y][x]: true = dark */
  modules: boolean[][];
}

/** A matrix plus how it was made (for tests and diagnostics). */
export interface QrCode extends QrMatrix {
  version: number;
  ecc: QrEcc;
  mask: number;
}

const ECC_ORDER: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** The two format-information bits for each level (L 01, M 00, Q 11, H 10). */
export const QR_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

/* Error-correction codewords per block, and the number of blocks, for each
   level (rows L, M, Q, H) and version (index 1…40; index 0 unused). */
const ECC_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

/* ---------------- capacities ---------------- */

/** Modules left for data and error correction once every function pattern is placed. */
export function qrRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** 8-bit data codewords a version holds at a level (after error correction). */
export function qrDataCodewords(version: number, ecc: QrEcc): number {
  const e = ECC_ORDER[ecc];
  return Math.floor(qrRawDataModules(version) / 8) - ECC_PER_BLOCK[e][version] * NUM_BLOCKS[e][version];
}

/** Bits in the byte-mode character count: 8 up to version 9, 16 from version 10. */
const countBits = (version: number) => (version <= 9 ? 8 : 16);

/** The most bytes a byte-mode code of this version and level can carry. */
export function qrByteCapacity(version: number, ecc: QrEcc): number {
  const bits = qrDataCodewords(version, ecc) * 8 - 4 - countBits(version);
  return Math.min(Math.floor(bits / 8), (1 << countBits(version)) - 1);
}

/** Centre coordinates of the alignment patterns (rows and columns alike). */
export function qrAlignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/* ---------------- Reed–Solomon over GF(256) ---------------- */

/** Product in GF(2⁸) modulo x⁸ + x⁴ + x³ + x² + 1 (0x11D). */
export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The generator polynomial (x − α⁰)(x − α¹)…(x − α^(degree−1)), highest term dropped. */
function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The `degree` error-correction codewords for one block of data codewords. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  const divisor = rsDivisor(degree);
  const result: number[] = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

/* ---------------- format and version information ---------------- */

/** The 15 format bits (5 data bits + 10 BCH bits, XOR 101010000010010) for a level and mask. */
export function qrFormatBits(ecc: QrEcc, mask: number): number {
  const data = (QR_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/** The 18 version bits (6 data bits + 12 BCH bits) for versions 7–40. */
export function qrVersionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

/* ---------------- masks and penalty ---------------- */

/** Does mask `mask` flip the module at column x, row y? */
export function qrMaskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new RangeError("mask must be 0–7");
  }
}

/** The standard penalty score of a finished matrix (lower is easier to scan). */
export function qrPenalty(m: QrMatrix): number {
  const { size, modules } = m;
  let result = 0;
  const addHistory = (run: number, history: number[]) => {
    if (history[0] === 0) run += size; // the light quiet zone before the first run
    history.pop();
    history.unshift(run);
  };
  const countPatterns = (h: number[]) => {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  };
  const terminate = (color: boolean, run: number, history: number[]) => {
    if (color) { addHistory(run, history); run = 0; }
    run += size; // the light quiet zone after the last run
    addHistory(run, history);
    return countPatterns(history);
  };
  const scanLine = (get: (i: number) => boolean) => {
    let color = false, run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < size; i++) {
      const c = get(i);
      if (c === color) {
        run++;
        if (run === 5) result += PENALTY_N1;
        else if (run > 5) result++;
      } else {
        addHistory(run, history);
        if (!color) result += countPatterns(history) * PENALTY_N3;
        color = c;
        run = 1;
      }
    }
    result += terminate(color, run, history) * PENALTY_N3;
  };
  for (let y = 0; y < size; y++) scanLine((x) => modules[y][x]);
  for (let x = 0; x < size; x++) scanLine((y) => modules[y][x]);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += PENALTY_N2;
    }
  }
  let dark = 0;
  for (const row of modules) for (const c of row) if (c) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

/* ---------------- encoding ---------------- */

/** UTF-8 bytes of a string (lone surrogates become U+FFFD, as TextEncoder does). */
export function utf8Bytes(text: string): number[] {
  if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(text));
  const out: number[] = [];
  for (const ch of text) {
    let cp = ch.codePointAt(0) as number;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

/** The smallest version (1–40) whose byte mode holds `byteLength` bytes at `ecc`; 0 if none. */
export function qrVersionFor(byteLength: number, ecc: QrEcc): number {
  for (let v = 1; v <= 40; v++) if (byteLength <= qrByteCapacity(v, ecc)) return v;
  return 0;
}

/** The data codewords: mode, count, bytes, terminator and padding. */
function dataCodewords(bytes: readonly number[], version: number, ecc: QrEcc): number[] {
  const capacityBits = qrDataCodewords(version, ecc) * 8;
  const bits: number[] = [];
  const push = (value: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  for (let pad = 0xec; out.length < capacityBits / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Split into blocks, add each block's error correction, interleave. */
function withErrorCorrection(data: readonly number[], version: number, ecc: QrEcc): number[] {
  const e = ECC_ORDER[ecc];
  const numBlocks = NUM_BLOCKS[e][version];
  const eccLen = ECC_PER_BLOCK[e][version];
  const rawCodewords = Math.floor(qrRawDataModules(version) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const block = [...dat];
    if (i < numShort) block.push(0); // placeholder so every block has the same length
    blocks.push(block.concat(reedSolomon(dat, eccLen)));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortLen - eccLen || j >= numShort) out.push(blocks[j][i]);
    }
  }
  return out;
}

class Grid {
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  setFunction(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function drawFormatBits(g: Grid, ecc: QrEcc, mask: number) {
  const bits = qrFormatBits(ecc, mask);
  const n = g.size;
  // around the top-left finder: down column 8, then along row 8 to the left
  for (let i = 0; i <= 5; i++) g.setFunction(8, i, bit(bits, i));
  g.setFunction(8, 7, bit(bits, 6));
  g.setFunction(8, 8, bit(bits, 7));
  g.setFunction(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) g.setFunction(14 - i, 8, bit(bits, i));
  // the copy split between the top-right and bottom-left finders
  for (let i = 0; i < 8; i++) g.setFunction(n - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) g.setFunction(8, n - 15 + i, bit(bits, i));
  g.setFunction(8, n - 8, true); // the dark module
}

function drawVersionBits(g: Grid, version: number) {
  if (version < 7) return;
  const bits = qrVersionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = bit(bits, i);
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    g.setFunction(a, b, dark); // above the bottom-left finder… (6 × 3, column-major)
    g.setFunction(b, a, dark); // …and left of the top-right finder (3 × 6)
  }
}

function drawFunctionPatterns(g: Grid, version: number, ecc: QrEcc) {
  const n = g.size;
  for (let i = 0; i < n; i++) {
    g.setFunction(6, i, i % 2 === 0);
    g.setFunction(i, 6, i % 2 === 0);
  }
  // three finders with their light separators (the 9 × 9 square, clipped to the grid)
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || x >= n || y < 0 || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        g.setFunction(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const pos = qrAlignmentPositions(version);
  const last = pos.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue; // the finder corners
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) g.setFunction(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormatBits(g, ecc, 0); // reserved now, rewritten once the mask is chosen
  drawVersionBits(g, version);
}

function drawCodewords(g: Grid, codewords: readonly number[]) {
  const n = g.size;
  const totalBits = codewords.length * 8;
  let i = 0;
  // two-module columns from the right edge, upwards then downwards, skipping the vertical timing column
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (!g.isFunction[y][x] && i < totalBits) {
          g.modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
        // remainder bits (0–7 of them) stay light
      }
    }
  }
}

function applyMask(g: Grid, mask: number) {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.isFunction[y][x] && qrMaskApplies(mask, x, y)) g.modules[y][x] = !g.modules[y][x];
    }
  }
}

/**
 * Encode with full control (and full detail back): `version` is the minimum
 * to use (default 1), `mask` forces one of the eight masks (default: the
 * lowest penalty). Throws a RangeError when the text can't fit version 40.
 */
export function encodeQrCode(text: string, ecc: QrEcc = "M", opts: { minVersion?: number; mask?: number } = {}): QrCode {
  if (!(ecc in ECC_ORDER)) throw new RangeError(`unknown error-correction level ${String(ecc)}`);
  const bytes = utf8Bytes(text);
  let version = qrVersionFor(bytes.length, ecc);
  if (!version) throw new RangeError("Text is too long for a QR code");
  version = Math.max(version, Math.min(40, Math.max(1, Math.floor(opts.minVersion ?? 1))));
  const codewords = withErrorCorrection(dataCodewords(bytes, version, ecc), version, ecc);
  const g = new Grid(version * 4 + 17);
  drawFunctionPatterns(g, version, ecc);
  drawCodewords(g, codewords);

  let mask = opts.mask ?? -1;
  if (mask !== -1 && !(Number.isInteger(mask) && mask >= 0 && mask <= 7)) throw new RangeError("mask must be 0–7");
  if (mask === -1) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(g, m);
      drawFormatBits(g, ecc, m);
      const score = qrPenalty(g);
      if (score < best) { best = score; mask = m; }
      applyMask(g, m); // XOR again: undo
    }
  }
  applyMask(g, mask);
  drawFormatBits(g, ecc, mask);
  return { size: g.size, modules: g.modules, version, ecc, mask };
}

/** Encode text (UTF-8, byte mode) at the smallest version that fits. Throws if it can't fit version 40. */
export function encodeQr(text: string, ecc: QrEcc = "M"): QrMatrix {
  const { size, modules } = encodeQrCode(text, ecc);
  return { size, modules };
}

/* ---------------- rendering ---------------- */

/** One path covering every dark module, with a quiet-zone margin (default 4 modules). */
export function qrPath(m: QrMatrix, margin = 4): { d: string; viewBox: string; size: number } {
  const q = Math.max(0, Math.floor(margin));
  const total = m.size + q * 2;
  const parts: string[] = [];
  for (let y = 0; y < m.size; y++) {
    const row = m.modules[y];
    for (let x = 0; x < m.size; ) {
      if (!row[x]) { x++; continue; }
      let len = 1;
      while (x + len < m.size && row[x + len]) len++;
      parts.push(`M${x + q} ${y + q}h${len}v1h-${len}z`); // one rectangle per horizontal run
      x += len;
    }
  }
  return { d: parts.join(""), viewBox: `0 0 ${total} ${total}`, size: total };
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A colour safe to put in an attribute: hex, rgb()/hsl()/oklch() and plain names only. */
const safeColour = (c: string | undefined, fallback: string) =>
  c && /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|rgba|hsl|hsla|oklch|oklab)\([0-9a-z.,%\s/+-]*\))$/i.test(c.trim()) ? c.trim() : fallback;

/** A standalone SVG string (role="img", <title>) for downloads and tests. */
export function qrSvg(text: string, opts: { ecc?: QrEcc; margin?: number; title?: string; dark?: string; light?: string; scale?: number } = {}): string {
  const p = qrPath(encodeQr(text, opts.ecc ?? "M"), opts.margin ?? 4);
  const px = p.size * Math.max(1, Math.floor(opts.scale ?? 8));
  const title = xmlEscape(opts.title ?? "QR code");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${p.viewBox}" width="${px}" height="${px}" role="img" shape-rendering="crispEdges">`
    + `<title>${title}</title>`
    + `<rect width="${p.size}" height="${p.size}" fill="${safeColour(opts.light, "#ffffff")}"/>`
    + `<path d="${p.d}" fill="${safeColour(opts.dark, "#000000")}"/>`
    + `</svg>`;
}
