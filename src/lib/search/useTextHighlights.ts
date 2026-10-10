/* ============================================================
   KANBO — marking the searched words in titles without touching the
   DOM: the CSS Custom Highlight API paints ranges over the title's own
   text node, so the title stays one piece of text (screen readers read
   it whole, text search and copy still work) — <mark> is kept for
   excerpts. Elements opt in with `data-hl`; the ranges are rebuilt
   after every render. Browsers without the API simply don't paint.
   Styled by ::highlight(kanbo-search) in components/search/search.css.
   ============================================================ */
import { useEffect, useLayoutEffect, type RefObject } from "react";
import { searchTerms } from "../searchQuery";
import { matchRanges } from "./highlight";

export const TEXT_HIGHLIGHT_NAME = "kanbo-search";

type HighlightRegistry = { set: (name: string, h: unknown) => void; delete: (name: string) => void };
const registry = (): HighlightRegistry | null => {
  const reg = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
  return reg && typeof (globalThis as { Highlight?: unknown }).Highlight === "function" ? reg : null;
};

/** The [start, end) ranges of the words in every `[data-hl]` element's text under `root`. */
export function titleRanges(root: ParentNode, words: string): Range[] {
  const terms = searchTerms(words);
  if (!terms.length) return [];
  const out: Range[] = [];
  root.querySelectorAll<HTMLElement>("[data-hl]").forEach((el) => {
    const node = el.firstChild;
    if (!node || node.nodeType !== 3) return;
    for (const [a, b] of matchRanges(node.textContent ?? "", terms)) {
      const r = document.createRange();
      r.setStart(node, a);
      r.setEnd(node, b);
      out.push(r);
    }
  });
  return out;
}

export function useTextHighlights(rootRef: RefObject<HTMLElement>, words: string): void {
  useLayoutEffect(() => {
    const reg = registry();
    const root = rootRef.current;
    if (!reg || !root) return;
    const ranges = titleRanges(root, words);
    if (!ranges.length) { reg.delete(TEXT_HIGHLIGHT_NAME); return; }
    const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
    reg.set(TEXT_HIGHLIGHT_NAME, new H(...ranges));
  });
  useEffect(() => () => { registry()?.delete(TEXT_HIGHLIGHT_NAME); }, []);
}
