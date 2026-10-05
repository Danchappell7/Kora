/* QR encoder tests. The reader below is written separately from lib/qr.ts
   (its own GF(256) tables, its own reading order, ISO tables typed in by
   hand), so a round trip is a real check rather than the encoder agreeing
   with itself. The fixed matrix near the end was also scanned with an
   independent decoder (Chrome's BarcodeDetector) when it was written. */
import { describe, it, expect } from "vitest";
import {
  encodeQr, encodeQrCode, qrPath, qrSvg, qrPenalty, qrFormatBits, qrVersionBits, qrAlignmentPositions,
  qrByteCapacity, qrVersionFor, reedSolomon, gfMultiply, utf8Bytes, type QrEcc, type QrMatrix,
} from "./qr";

/* ---------------- ISO/IEC 18004 tables, typed in ---------------- */

/** Format information (after the 101010000010010 mask), MSB first, per level and mask 0–7. */
const FORMAT: Record<QrEcc, string[]> = {
  L: ["111011111000100", "111001011110011", "111110110101010", "111100010011101", "110011000101111", "110001100011000", "110110001000001", "110100101110110"],
  M: ["101010000010010", "101000100100101", "101111001111100", "101101101001011", "100010111111001", "100000011001110", "100111110010111", "100101010100000"],
  Q: ["011010101011111", "011000001101000", "011111100110001", "011101000000110", "010010010110100", "010000110000011", "010111011011010", "010101111101101"],
  H: ["001011010001001", "001001110111110", "001110011100111", "001100111010000", "000011101100010", "000001001010101", "000110100001100", "000100000111011"],
};
/** Version information for a few versions (18 bits). */
const VERSION_INFO: Record<number, number> = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3, 20: 0x149a6, 32: 0x209d5, 40: 0x28c69 };
/** Alignment pattern centres. */
const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 6: [6, 34], 7: [6, 22, 38], 13: [6, 34, 62], 14: [6, 26, 46, 66], 21: [6, 28, 50, 72, 94],
  32: [6, 34, 60, 86, 112, 138], 36: [6, 24, 50, 76, 102, 128, 154], 40: [6, 30, 58, 86, 114, 142, 170],
};
/** Byte-mode capacity (characters). */
const BYTES: Record<number, Record<QrEcc, number>> = {
  1: { L: 17, M: 14, Q: 11, H: 7 },
  2: { L: 32, M: 26, Q: 20, H: 14 },
  3: { L: 53, M: 42, Q: 32, H: 24 },
  4: { L: 78, M: 62, Q: 46, H: 34 },
  5: { L: 106, M: 84, Q: 60, H: 44 },
  7: { L: 154, M: 122, Q: 86, H: 64 },
  10: { L: 271, M: 213, Q: 151, H: 119 },
  40: { L: 2953, M: 2331, Q: 1663, H: 1273 },
};
/** Block structure: groups of [count, total codewords per block, data codewords per block]. */
const BLOCKS: Record<string, [number, number, number][]> = {
  "1L": [[1, 26, 19]], "1M": [[1, 26, 16]], "1Q": [[1, 26, 13]], "1H": [[1, 26, 9]],
  "2M": [[1, 44, 28]],
  "3M": [[1, 70, 44]], "3Q": [[2, 35, 17]],
  "4M": [[2, 50, 32]],
  "5Q": [[2, 33, 15], [2, 34, 16]], "5H": [[2, 33, 11], [2, 34, 12]],
  "7M": [[4, 49, 31]],
  "10M": [[4, 69, 43], [1, 70, 44]],
  "40L": [[19, 148, 118], [6, 149, 119]],
  "40H": [[20, 45, 15], [61, 46, 16]],
};

/* ---------------- an independent reader ---------------- */

const EXP: number[] = [], LOG: number[] = new Array(256).fill(0);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
const gmul = (a: number, b: number) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);

/** True when the codeword polynomial vanishes at α⁰ … α^(ec−1): no errors. */
function syndromesZero(block: number[], ec: number): boolean {
  for (let i = 0; i < ec; i++) {
    let s = 0;
    const a = EXP[i];
    for (const c of block) s = gmul(s, a) ^ c; // Horner, highest degree first
    if (s !== 0) return false;
  }
  return true;
}

function readFormat(m: QrMatrix): { ecc: QrEcc; mask: number } {
  // first copy, MSB (bit 14) first: row 8 from the left (skipping the timing column), then up column 8
  const coords: [number, number][] = [];
  for (let x = 0; x <= 8; x++) if (x !== 6) coords.push([x, 8]);
  for (let y = 7; y >= 0; y--) if (y !== 6) coords.push([8, y]);
  const read = coords.map(([x, y]) => (m.modules[y][x] ? "1" : "0")).join("");
  // the second copy: down column 8 from the bottom-left finder, then right along row 8
  const n = m.size;
  const second: string[] = [];
  for (let y = n - 1; y >= n - 7; y--) second.push(m.modules[y][8] ? "1" : "0");
  for (let x = n - 8; x < n; x++) second.push(m.modules[8][x] ? "1" : "0");
  expect(second.join("")).toBe(read);
  for (const ecc of ["L", "M", "Q", "H"] as QrEcc[]) {
    const mask = FORMAT[ecc].indexOf(read);
    if (mask >= 0) return { ecc, mask };
  }
  throw new Error("no valid format information: " + read);
}

function maskBit(mask: number, r: number, c: number): boolean {
  // the standard's own formulas, in (row i, column j) form
  const i = r, j = c;
  return [
    (i + j) % 2 === 0, i % 2 === 0, j % 3 === 0, (i + j) % 3 === 0,
    (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, ((i * j) % 2) + ((i * j) % 3) === 0,
    (((i * j) % 2) + ((i * j) % 3)) % 2 === 0, (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
  ][mask];
}

function reserved(size: number, version: number): boolean[][] {
  const r = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fill = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < size && y < size) r[y][x] = true;
  };
  fill(0, 0, 9, 9); fill(size - 8, 0, 8, 9); fill(0, size - 8, 9, 8); // finders, separators, format
  fill(6, 0, 1, size); fill(0, 6, size, 1); // timing
  const pos = ALIGN[version] ?? qrAlignmentPositions(version);
  for (const cy of pos) for (const cx of pos) {
    if ((cx < 9 && cy < 9) || (cx > size - 9 && cy < 9) || (cx < 9 && cy > size - 9)) continue;
    fill(cx - 2, cy - 2, 5, 5);
  }
  if (version >= 7) { fill(size - 11, 0, 3, 6); fill(0, size - 11, 6, 3); }
  return r;
}

/** Read a matrix back to its text (byte mode), checking every block's error correction. */
function decode(m: QrMatrix): { text: string; ecc: QrEcc; mask: number; version: number } {
  const version = (m.size - 17) / 4;
  const { ecc, mask } = readFormat(m);
  const res = reserved(m.size, version);
  const bits: number[] = [];
  let upward = true;
  for (let col = m.size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < m.size; k++) {
      const row = upward ? m.size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (res[row][c]) continue;
        bits.push((m.modules[row][c] !== maskBit(mask, row, c)) ? 1 : 0);
      }
    }
    upward = !upward;
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const layout = BLOCKS[`${version}${ecc}`];
  if (!layout) throw new Error(`no block table typed in for ${version}-${ecc}`);
  const blocks: { data: number; total: number; cw: number[] }[] = [];
  for (const [count, total, data] of layout) for (let i = 0; i < count; i++) blocks.push({ data, total, cw: [] });
  const maxData = Math.max(...blocks.map((b) => b.data));
  let p = 0;
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data) b.cw.push(bytes[p++]);
  const ec = blocks[0].total - blocks[0].data;
  for (let i = 0; i < ec; i++) for (const b of blocks) b.cw.push(bytes[p++]);
  for (const b of blocks) expect(syndromesZero(b.cw, ec)).toBe(true);
  const data = blocks.flatMap((b) => b.cw.slice(0, b.data));
  const stream = data.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1));
  const take = (n: number) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | stream.shift()!; return v; };
  expect(take(4)).toBe(0b0100);
  const len = take(version <= 9 ? 8 : 16);
  const out = Array.from({ length: len }, () => take(8));
  return { text: new TextDecoder().decode(new Uint8Array(out)), ecc, mask, version };
}

/* ---------------- tests ---------------- */

describe("Reed–Solomon", () => {
  it("matches the standard's worked example (HELLO WORLD, 1-M)", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });
  it("multiplies in GF(256) with the QR polynomial", () => {
    expect(gfMultiply(0, 77)).toBe(0);
    expect(gfMultiply(1, 77)).toBe(77);
    expect(gfMultiply(2, 0x80)).toBe(0x1d); // x · x⁷ = x⁸ ≡ x⁴ + x³ + x² + 1
    for (let a = 1; a < 256; a += 17) for (let b = 1; b < 256; b += 13) expect(gfMultiply(a, b)).toBe(gmul(a, b));
  });
});

describe("format, version and alignment information", () => {
  it("format bits match the standard's table for every level and mask", () => {
    for (const ecc of ["L", "M", "Q", "H"] as QrEcc[]) {
      for (let mask = 0; mask < 8; mask++) expect(qrFormatBits(ecc, mask).toString(2).padStart(15, "0")).toBe(FORMAT[ecc][mask]);
    }
  });
  it("version bits match the standard's table", () => {
    for (const [v, bits] of Object.entries(VERSION_INFO)) expect(qrVersionBits(+v)).toBe(bits);
  });
  it("alignment pattern centres match the standard's table", () => {
    for (const [v, pos] of Object.entries(ALIGN)) expect(qrAlignmentPositions(+v)).toEqual(pos);
  });
  it("byte capacities match the standard's table, and the smallest version is chosen", () => {
    for (const [v, caps] of Object.entries(BYTES)) {
      for (const ecc of ["L", "M", "Q", "H"] as QrEcc[]) {
        expect(qrByteCapacity(+v, ecc)).toBe(caps[ecc]);
      }
    }
    expect(qrVersionFor(14, "M")).toBe(1);
    expect(qrVersionFor(15, "M")).toBe(2);
    expect(qrVersionFor(213, "M")).toBe(10);
    expect(qrVersionFor(2331, "M")).toBe(40);
    expect(qrVersionFor(2332, "M")).toBe(0);
    expect(encodeQrCode("a".repeat(17), "L").version).toBe(1);
    expect(encodeQrCode("a".repeat(18), "L").version).toBe(2);
  });
  it("writes the version information in both corners from version 7", () => {
    for (const v of [7, 10, 32, 40]) {
      const q = encodeQrCode("x", "L", { minVersion: v });
      expect(q.version).toBe(v);
      let a = 0, b = 0;
      for (let i = 17; i >= 0; i--) {
        const x = q.size - 11 + (i % 3), y = Math.floor(i / 3);
        a = (a << 1) | (q.modules[y][x] ? 1 : 0); // top right (3 wide, 6 tall)
        b = (b << 1) | (q.modules[x][y] ? 1 : 0); // bottom left (6 wide, 3 tall)
      }
      expect(a).toBe(VERSION_INFO[v]);
      expect(b).toBe(VERSION_INFO[v]);
    }
  });
});

describe("structure", () => {
  const finderAt = (m: QrMatrix, x0: number, y0: number) => {
    for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
      const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      expect(m.modules[y0 + dy][x0 + dx]).toBe(d !== 2);
    }
  };
  it("has three finders with light separators, timing lines and the dark module", () => {
    for (const text of ["https://www.kanbo.co.uk/f/0123456789abcdef0123456789abcdef", "Kanbo"]) {
      const m = encodeQr(text);
      const n = m.size;
      expect(n).toBeGreaterThanOrEqual(21);
      expect(m.modules).toHaveLength(n);
      for (const row of m.modules) expect(row).toHaveLength(n);
      finderAt(m, 0, 0); finderAt(m, n - 7, 0); finderAt(m, 0, n - 7);
      for (let i = 0; i < 8; i++) {
        expect(m.modules[7][i]).toBe(false); expect(m.modules[i][7]).toBe(false); // top-left separator
        expect(m.modules[7][n - 1 - i]).toBe(false); expect(m.modules[i][n - 8]).toBe(false); // top right
        expect(m.modules[n - 8][i]).toBe(false); expect(m.modules[n - 1 - i][7]).toBe(false); // bottom left
      }
      for (let i = 8; i < n - 8; i++) {
        expect(m.modules[6][i]).toBe(i % 2 === 0);
        expect(m.modules[i][6]).toBe(i % 2 === 0);
      }
      expect(m.modules[n - 8][8]).toBe(true);
    }
  });
  it("draws alignment patterns where the standard puts them", () => {
    const q = encodeQrCode("x", "M", { minVersion: 7 });
    for (const [cx, cy] of [[22, 22], [38, 38], [6, 22], [22, 6], [38, 22]]) {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        expect(q.modules[cy + dy][cx + dx]).toBe(Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  });
});

describe("round trip through an independent reader", () => {
  const cases: [string, QrEcc][] = [
    ["HELLO WORLD", "M"],
    ["https://www.kanbo.co.uk/f/demo", "M"],
    ["https://www.kanbo.co.uk/f/0123456789abcdef0123456789abcdef", "M"],
    ["Café — £5 · 東京 · 👋", "Q"],
    ["a", "H"],
    ["x".repeat(17), "L"],
  ];
  it.each(cases)("reads back %j at %s", (text, ecc) => {
    const q = encodeQrCode(text, ecc);
    const r = decode(q);
    expect(r).toEqual({ text, ecc, mask: q.mask, version: q.version });
  });
  it("every mask decodes (the reader takes the mask from the format bits)", () => {
    for (let mask = 0; mask < 8; mask++) {
      const q = encodeQrCode("https://www.kanbo.co.uk/f/demo", "M", { mask });
      expect(q.mask).toBe(mask);
      expect(decode(q).text).toBe("https://www.kanbo.co.uk/f/demo");
    }
  });
  const sample = (n: number) => Array.from({ length: n }, (_, i) => "kanbo/f/"[i % 8] + String.fromCharCode(65 + (i % 26))).join("").slice(0, n);
  it.each([[5, "Q", 60], [5, "H", 44], [7, "M", 122], [10, "M", 213], [40, "L", 2953], [40, "H", 1273]] as [number, QrEcc, number][])(
    "multi-block version %i-%s interleaves correctly", (v, ecc, len) => {
      const text = sample(len);
      const q = encodeQrCode(text, ecc);
      expect(q.version).toBe(v);
      expect(decode(q).text).toBe(text);
    });
  it("throws when the text can't fit version 40", () => {
    expect(() => encodeQr("x".repeat(2332), "M")).toThrow(RangeError);
    expect(() => encodeQrCode("x", "M", { mask: 9 })).toThrow(RangeError);
  });
});

describe("mask choice", () => {
  it("scores a blank 21 × 21 grid by hand: runs 798, blocks 1200, balance 90", () => {
    const blank = { size: 21, modules: Array.from({ length: 21 }, () => new Array<boolean>(21).fill(false)) };
    // each line: a run of 21 → 3 (at five) + 16 (six to 21) = 19; 42 lines = 798
    // 20 × 20 two-by-two blocks × 3 = 1200; 0% dark → (ceil(50 / 5) − 1) × 10 = 90
    expect(qrPenalty(blank)).toBe(798 + 1200 + 90);
  });
  it("counts a finder look-alike (1:1:3:1:1 with four light either side)", () => {
    const size = 21;
    const rows = Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => (x + y) % 2 === 0));
    const base = qrPenalty({ size, modules: rows });
    const withFinder = rows.map((r) => [...r]);
    const pattern = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0].map(Boolean);
    pattern.forEach((v, i) => { withFinder[10][3 + i] = v; });
    expect(qrPenalty({ size, modules: withFinder })).toBeGreaterThanOrEqual(base + 40);
  });
  it("picks the mask with the lowest penalty", () => {
    const text = "https://www.kanbo.co.uk/f/demo";
    const chosen = encodeQrCode(text, "M");
    const scores = Array.from({ length: 8 }, (_, mask) => qrPenalty(encodeQrCode(text, "M", { mask })));
    expect(qrPenalty(chosen)).toBe(Math.min(...scores));
    expect(scores.indexOf(Math.min(...scores))).toBe(chosen.mask);
  });
});

describe("a fixed code", () => {
  it("encodes https://www.kanbo.co.uk/f/demo the same way every time", () => {
    // version 3-M, mask 2; scanned with Chrome's BarcodeDetector (macOS Vision) when this was written
    const q = encodeQrCode("https://www.kanbo.co.uk/f/demo", "M");
    expect(q.version).toBe(3);
    const rows = q.modules.map((r) => r.map((c) => (c ? "#" : ".")).join(""));
    expect(rows).toEqual([
      "#######.....####.####.#######",
      "#.....#...#..######.#.#.....#",
      "#.###.#.#.#.##.#....#.#.###.#",
      "#.###.#.#.#...##.##.#.#.###.#",
      "#.###.#.#..#...######.#.###.#",
      "#.....#.##.#.....#....#.....#",
      "#######.#.#.#.#.#.#.#.#######",
      "........#..#..#.#..##........",
      "#.#####.....#...##.#..#####..",
      "..##.#.#....####..##.####...#",
      "..##..#####..#####..###......",
      "..#.#...#.#..#.#..###.##.#.#.",
      "###.#.#..#..#.##.###.....##..",
      ".#...#.#..###..########.#...#",
      ".###.###.#..#....#..##.#.##..",
      "##.##.....###.#.#..#...##..#.",
      "#....####.##....##.....#.##..",
      "##..##...#.#####..#######.#.#",
      "#..#######.######.....##..#..",
      "#.#..#.#....##.#..#######..#.",
      "#....####.....##.#.######.###",
      "........#......##.#.#...#####",
      "#######..#.##......##.#.###..",
      "#.....#.#.#...#.#...#...#..##",
      "#.###.#.##.##....#..#####.#.#",
      "#.###.#.###...##.####..#.##..",
      "#.###.#.####.#.##..#########.",
      "#.....#......#..#...##.#.#.#.",
      "#######.#.#...#..#.#.######..",
    ]);
  });
});

describe("rendering", () => {
  it("one path of horizontal runs with a quiet zone", () => {
    const m: QrMatrix = { size: 3, modules: [[true, true, false], [false, false, false], [true, false, true]] };
    expect(qrPath(m, 4)).toEqual({ d: "M4 4h2v1h-2zM4 6h1v1h-1zM6 6h1v1h-1z", viewBox: "0 0 11 11", size: 11 });
    expect(qrPath(m, 0).viewBox).toBe("0 0 3 3");
  });
  it("every dark module is covered exactly once", () => {
    const m = encodeQr("https://www.kanbo.co.uk/f/demo");
    const { d } = qrPath(m, 4);
    let covered = 0;
    for (const [, x, y, len] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
      for (let i = 0; i < +len; i++) { expect(m.modules[+y - 4][+x - 4 + i]).toBe(true); covered++; }
    }
    expect(covered).toBe(m.modules.flat().filter(Boolean).length);
  });
  it("a standalone SVG with an escaped title and safe colours", () => {
    const svg = qrSvg("https://www.kanbo.co.uk/f/demo", { title: `Requests <"Launch"> & co`, dark: "#0B1020", light: "url(javascript:x)" });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain("<title>Requests &lt;&quot;Launch&quot;&gt; &amp; co</title>");
    expect(svg).toContain('fill="#0B1020"');
    expect(svg).toContain('fill="#ffffff"'); // the unsafe colour fell back
    expect(svg).not.toContain("javascript");
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
  });
  it("UTF-8 bytes", () => {
    expect(utf8Bytes("£")).toEqual([0xc2, 0xa3]);
    expect(utf8Bytes("👋")).toEqual([0xf0, 0x9f, 0x91, 0x8b]);
  });
});
