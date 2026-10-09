/* ============================================================
   KANBO — project docs: a block's spans in the page, and back.  [0047, w5]
   Each text block is its own contenteditable element. The editor paints
   a block's spans into it (strong / em / code / a, and an atomic mention
   chip), reads what the browser typed back out as spans, and keeps the
   caret by plain-text offset (a mention counts as its "@Name"). Never
   innerHTML: text only goes in as text nodes.
   ============================================================ */
import type { DocMark, DocSpan } from "../../data/types";
import { cleanLinkInput, normaliseSpans } from "../../lib/docBlocks";

export const MENTION_CLASS = "kdoc-mention";

/** Paint spans into a block's element (replacing what's there). `nameOf` refreshes a mention's shown name. */
export function renderSpans(el: HTMLElement, spans: readonly DocSpan[] | undefined, nameOf?: (id: string) => string | undefined): void {
  const doc = el.ownerDocument;
  el.textContent = "";
  let text = "";
  for (const s of spans ?? []) {
    if (s.mention) {
      const m = doc.createElement("span");
      m.className = MENTION_CLASS;
      m.setAttribute("contenteditable", "false");
      m.dataset.mention = s.mention;
      const name = nameOf?.(s.mention);
      m.textContent = name ? `@${name}` : s.text;
      el.appendChild(m);
      text += m.textContent;
      continue;
    }
    let node: Node = doc.createTextNode(s.text);
    const wrap = (tag: string) => { const w = doc.createElement(tag); w.appendChild(node); node = w; };
    if (s.marks?.includes("code")) wrap("code");
    if (s.marks?.includes("i")) wrap("em");
    if (s.marks?.includes("b")) wrap("strong");
    if (s.href) {
      wrap("a");
      const a = node as HTMLAnchorElement;
      a.setAttribute("href", s.href);
      a.setAttribute("rel", "noopener noreferrer nofollow");
      a.setAttribute("target", "_blank");
    }
    el.appendChild(node);
    text += s.text;
  }
  // a block ending in a line break needs a placeholder for the empty last line to show
  if (text.endsWith("\n")) {
    const br = doc.createElement("br");
    br.setAttribute("data-trail", "");
    el.appendChild(br);
  }
}

const MARK_TAGS: Record<string, DocMark> = { STRONG: "b", B: "b", EM: "i", I: "i", CODE: "code" };
const BLOCK_TAGS = new Set(["DIV", "P", "LI", "H1", "H2", "H3", "H4", "BLOCKQUOTE"]);

/** What's in a block's element now, as spans (unknown wrappers are read through; <br>s are ignored —
 *  the editor puts line breaks in as "\n" itself; a stray block element a browser added is a line break). */
export function readSpans(el: HTMLElement): DocSpan[] {
  const out: DocSpan[] = [];
  const push = (text: string, marks: DocMark[], href?: string) => {
    if (!text) return;
    const s: DocSpan = { text };
    if (marks.length) s.marks = [...marks];
    if (href) s.href = href;
    out.push(s);
  };
  const walk = (node: Node, marks: DocMark[], href?: string) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) { push((child.nodeValue ?? "").replace(/​/g, ""), marks, href); return; }
      if (child.nodeType !== 1) return;
      const e = child as HTMLElement;
      if (e.dataset?.mention) { out.push({ text: e.textContent ?? "", mention: e.dataset.mention }); return; }
      if (e.tagName === "BR") return;
      if (BLOCK_TAGS.has(e.tagName) && out.length && !out[out.length - 1].text.endsWith("\n")) push("\n", []);
      const m = MARK_TAGS[e.tagName];
      const nextMarks = m && !marks.includes(m) ? [...marks, m] : marks;
      const nextHref = e.tagName === "A" ? cleanLinkInput(e.getAttribute("href") ?? "") ?? href : href;
      walk(e, nextMarks, nextHref ?? undefined);
    });
  };
  walk(el, []);
  return normaliseSpans(out);
}

/** The mention chip a node sits in, if any. */
function mentionOf(node: Node | null, root: HTMLElement): HTMLElement | null {
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) {
    if (n.nodeType === 1 && (n as HTMLElement).dataset?.mention) return n as HTMLElement;
  }
  return null;
}

/** A DOM position → plain-text offset in the block (a position inside a mention snaps to after it). */
export function pointOffset(el: HTMLElement, node: Node, offset: number): number {
  const m = mentionOf(node, el);
  const doc = el.ownerDocument;
  const r = doc.createRange();
  r.selectNodeContents(el);
  try {
    if (m) r.setEndAfter(m);
    else r.setEnd(node, offset);
  } catch {
    return 0;
  }
  return r.toString().length;
}

/** The selection inside this block as plain-text offsets, or null when it isn't (all) in here. */
export function getSelectionOffsets(el: HTMLElement): { start: number; end: number; collapsed: boolean } | null {
  const sel = el.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const a = pointOffset(el, r.startContainer, r.startOffset);
  const b = pointOffset(el, r.endContainer, r.endOffset);
  return { start: Math.min(a, b), end: Math.max(a, b), collapsed: r.collapsed };
}

/** Plain-text offset → a DOM position in the block. */
export function locateOffset(el: HTMLElement, offset: number): { node: Node; offset: number } {
  let remaining = Math.max(0, offset);
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, 0x1 | 0x4 /* elements, text */, {
    acceptNode(n) {
      if (n.nodeType === 1) return (n as HTMLElement).dataset?.mention ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      return mentionOf(n.parentNode, el) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 3) {
      const len = (n.nodeValue ?? "").length;
      if (remaining <= len) return { node: n, offset: remaining };
      remaining -= len;
    } else {
      const len = (n.textContent ?? "").length;
      const parent = n.parentNode!;
      const index = Array.prototype.indexOf.call(parent.childNodes, n) as number;
      if (remaining === 0) return { node: parent, offset: index };
      if (remaining <= len) return { node: parent, offset: index + 1 };
      remaining -= len;
    }
  }
  // the end (before a trailing <br>, so the caret stays on the last line)
  const last = el.lastChild;
  const end = last && last.nodeName === "BR" && (last as HTMLElement).hasAttribute?.("data-trail") ? el.childNodes.length - 1 : el.childNodes.length;
  return { node: el, offset: end };
}

/** Put the caret (or a selection) at plain-text offsets in the block. */
export function setSelectionOffsets(el: HTMLElement, start: number, end: number = start): void {
  const doc = el.ownerDocument;
  const sel = doc.getSelection();
  if (!sel) return;
  const a = locateOffset(el, start);
  const b = end === start ? a : locateOffset(el, end);
  const r = doc.createRange();
  try {
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
  } catch {
    r.selectNodeContents(el);
    r.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(r);
}

/** The caret's box (for placing the slash / mention menus); null when the browser can't say.
 *  Measured on the character beside the caret (a collapsed range at an element boundary has no box). */
export function caretRect(el: HTMLElement): DOMRect | null {
  const s = getSelectionOffsets(el);
  if (!s) return null;
  const doc = el.ownerDocument;
  const mk = (left: number, top: number, height: number) =>
    ({ left, top, right: left, bottom: top + height, width: 0, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  const r = doc.createRange();
  if (typeof r.getBoundingClientRect === "function") {
    const pos = locateOffset(el, s.start);
    if (pos.node.nodeType === 3) {
      const text = pos.node.nodeValue ?? "";
      if (pos.offset > 0 && text[pos.offset - 1] !== "\n") {
        r.setStart(pos.node, pos.offset - 1); r.setEnd(pos.node, pos.offset);
        const b = r.getBoundingClientRect();
        if (b.width || b.height) return mk(b.right, b.top, b.height);
      }
      if (pos.offset < text.length && text[pos.offset] !== "\n") {
        r.setStart(pos.node, pos.offset); r.setEnd(pos.node, pos.offset + 1);
        const b = r.getBoundingClientRect();
        if (b.width || b.height) return mk(b.left, b.top, b.height);
      }
    }
    const sel = doc.getSelection();
    if (sel && sel.rangeCount) {
      const c = sel.getRangeAt(0).cloneRange();
      c.collapse(true);
      const b = c.getBoundingClientRect();
      if (b.top || b.left || b.height) return mk(b.left, b.top, b.height);
    }
  }
  // an empty line has no box: use the block's own start
  const box = el.getBoundingClientRect();
  if (!box.height && !box.width) return null;
  return mk(box.left, box.top, Math.min(box.height, 24));
}

/** Is the caret on the block's first (or last) visual line? Falls back to the offset when there's no layout. */
export function caretOnEdgeLine(el: HTMLElement, edge: "first" | "last", offset: number, length: number): boolean {
  const rect = caretRect(el);
  const box = el.getBoundingClientRect();
  if (!rect || !box.height) return edge === "first" ? offset === 0 || !box.height : offset >= length || !box.height;
  const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
  return edge === "first" ? rect.top - box.top < line * 0.75 : box.bottom - rect.bottom < line * 0.75;
}
