/* ============================================================
   KANBO — search highlights, done on the device: where a search's
   words sit in a title or a body (accents, case and curly apostrophes
   folded the way lib/searchQuery matches them), as text runs for
   <mark>, and a short excerpt round the first match with the matches
   wrapped in search_all's own markers (U+E000 … U+E001), so a local
   hit and a server hit render the same way (splitHighlights).
   Text is only ever rendered as text, never as HTML.
   ============================================================ */
import { foldText, searchTerms } from "../searchQuery";
import { SEARCH_MARK_END, SEARCH_MARK_START } from "../searchRows";

const ASCII = /^[\x00-\x7f]*$/;

/** The text folded, with each folded character's index in the original. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  if (ASCII.test(text)) {
    const map = new Array<number>(text.length);
    for (let i = 0; i < text.length; i++) map[i] = i;
    return { folded: text.toLowerCase(), map };
  }
  let folded = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = foldText(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  return { folded, map };
}

/** Where the terms are in the text: merged [start, end) ranges in the original string. */
export function matchRanges(text: string, terms: readonly string[]): [number, number][] {
  if (!text || !terms.length) return [];
  const { folded, map } = foldWithMap(text);
  const out: [number, number][] = [];
  for (const term of terms) {
    if (!term) continue;
    let at = folded.indexOf(term);
    let guard = 0;
    while (at !== -1 && guard++ < 200) {
      const s = map[at];
      const lastFolded = at + term.length - 1;
      const e = lastFolded + 1 < map.length ? map[lastFolded + 1] : text.length;
      // the end is the start of the next original character (or the end of the text)
      out.push([s, Math.max(e, s + 1)]);
      at = folded.indexOf(term, at + term.length);
    }
  }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Text runs for rendering (hit = a match); the same shape as splitHighlights. */
export function highlightRuns(text: string, termsOrText: readonly string[] | string): { text: string; hit: boolean }[] {
  if (!text) return [];
  const terms = typeof termsOrText === "string" ? searchTerms(termsOrText) : termsOrText;
  const ranges = matchRanges(text, terms);
  if (!ranges.length) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) out.push({ text: text.slice(at, a), hit: false });
    out.push({ text: text.slice(a, b), hit: true });
    at = b;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** One line of a body: whitespace (and the line breaks between doc blocks) collapsed. */
const oneLine = (s: string) => s.replace(/\s*\n+\s*/g, " · ").replace(/[ \t\f\v\r]+/g, " ").trim();

/** An excerpt round the first match (about `max` characters), matches between the markers;
 *  null when none of the words are in the body. Starts and ends on word boundaries, with "…". */
export function makeSnippet(body: string | null | undefined, termsOrText: readonly string[] | string, max = 160): string | null {
  if (!body) return null;
  const terms = typeof termsOrText === "string" ? searchTerms(termsOrText) : termsOrText;
  if (!terms.length) return null;
  const text = oneLine(body).replace(new RegExp(`[${SEARCH_MARK_START}${SEARCH_MARK_END}]`, "g"), "");
  const ranges = matchRanges(text, terms);
  if (!ranges.length) return null;
  const first = ranges[0][0];
  let start = Math.max(0, first - Math.floor(max / 3));
  if (start > 0) { const sp = text.lastIndexOf(" ", start); start = sp > 0 && first - sp < max / 2 ? sp + 1 : start; }
  let end = Math.min(text.length, start + max);
  if (end < text.length) { const sp = text.indexOf(" ", end); end = sp > 0 && sp - start < max + 24 ? sp : end; }
  let out = start > 0 ? "…" : "";
  let at = start;
  for (const [a, b] of ranges) {
    if (b <= start || a >= end) continue;
    const s = Math.max(a, start), e = Math.min(b, end);
    out += text.slice(at, s) + SEARCH_MARK_START + text.slice(s, e) + SEARCH_MARK_END;
    at = e;
  }
  out += text.slice(at, end) + (end < text.length ? "…" : "");
  return out;
}

/** Does every term appear in at least one of the fields? (the local matching rule) */
export function allTermsIn(terms: readonly string[], fields: readonly (string | null | undefined)[]): boolean {
  if (!terms.length) return false;
  const folded = fields.filter((f): f is string => !!f).map(foldText);
  return terms.every((t) => folded.some((f) => f.includes(t)));
}
