/* Painting a block's spans into the page and reading them back; the caret by plain-text offset. */
import { describe, expect, it } from "vitest";
import type { DocSpan } from "../../data/types";
import { getSelectionOffsets, locateOffset, pointOffset, readSpans, renderSpans, setSelectionOffsets } from "./docDom";

const host = () => {
  const el = document.createElement("div");
  el.setAttribute("contenteditable", "true");
  document.body.appendChild(el);
  return el;
};
const SPANS: DocSpan[] = [
  { text: "Ask " }, { text: "@Sana", mention: "m-3" }, { text: " about " }, { text: "tokens", marks: ["b", "i"] },
  { text: " see " }, { text: "spec", href: "https://acme.com/spec" }, { text: " " }, { text: "x()", marks: ["code"] },
];

describe("render and read", () => {
  it("round-trips every kind of span, as text nodes (never markup)", () => {
    const el = host();
    renderSpans(el, SPANS);
    expect(el.textContent).toBe("Ask @Sana about tokens see spec x()");
    expect(el.querySelector("strong > em")?.textContent).toBe("tokens");
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://acme.com/spec");
    expect(el.querySelector("a")?.getAttribute("rel")).toContain("noopener");
    const m = el.querySelector<HTMLElement>(".kdoc-mention")!;
    expect(m.getAttribute("contenteditable")).toBe("false");
    expect(m.dataset.mention).toBe("m-3");
    expect(readSpans(el)).toEqual(SPANS);
    renderSpans(el, [{ text: "<img src=x onerror=alert(1)>" }]);
    expect(el.querySelector("img")).toBeNull();
    expect(readSpans(el)).toEqual([{ text: "<img src=x onerror=alert(1)>" }]);
  });

  it("shows a mention by the member's current name", () => {
    const el = host();
    renderSpans(el, [{ text: "@Old", mention: "m-3" }], (id) => (id === "m-3" ? "Sana Rao" : undefined));
    expect(el.textContent).toBe("@Sana Rao");
  });

  it("reads what a browser may leave behind: wrappers, <b>/<i>, stray <br>s, a block element as a line break, unsafe links dropped", () => {
    const el = host();
    el.innerHTML = 'a<b>b</b><span style="color:red"><i>c</i></span><br><div>d</div><a href="javascript:alert(1)">e</a><br>';
    expect(readSpans(el)).toEqual([{ text: "a" }, { text: "b", marks: ["b"] }, { text: "c", marks: ["i"] }, { text: "\nde" }]);
  });

  it("a trailing line break gets a placeholder <br> that reading ignores", () => {
    const el = host();
    renderSpans(el, [{ text: "line\n" }]);
    expect(el.lastChild?.nodeName).toBe("BR");
    expect(readSpans(el)).toEqual([{ text: "line\n" }]);
  });
});

describe("the caret", () => {
  it("maps offsets to positions and back, a mention counting as its text", () => {
    const el = host();
    renderSpans(el, SPANS);
    for (const off of [0, 2, 4, 9, 12, 16, 22, 30, 35]) {
      const pos = locateOffset(el, off);
      expect(pointOffset(el, pos.node, pos.offset), String(off)).toBe(off);
    }
    // inside the mention there's no position: it snaps to after it
    const inner = el.querySelector(".kdoc-mention")!.firstChild!;
    expect(pointOffset(el, inner, 2)).toBe(9);
    // past the end: the end
    const end = locateOffset(el, 999);
    expect(pointOffset(el, end.node, end.offset)).toBe(35);
  });

  it("sets and reads the selection inside the block only", () => {
    const el = host();
    renderSpans(el, SPANS);
    setSelectionOffsets(el, 4, 22);
    expect(getSelectionOffsets(el)).toEqual({ start: 4, end: 22, collapsed: false });
    expect(document.getSelection()?.toString()).toBe("@Sana about tokens");
    setSelectionOffsets(el, 9);
    expect(getSelectionOffsets(el)).toMatchObject({ start: 9, end: 9, collapsed: true });
    const other = host();
    other.textContent = "elsewhere";
    expect(getSelectionOffsets(other)).toBeNull();
  });

  it("an empty block, and one ending in a line break, keep the caret inside", () => {
    const el = host();
    renderSpans(el, []);
    setSelectionOffsets(el, 0);
    expect(getSelectionOffsets(el)).toMatchObject({ start: 0, end: 0 });
    renderSpans(el, [{ text: "ab\n" }]);
    setSelectionOffsets(el, 3);
    expect(getSelectionOffsets(el)).toMatchObject({ start: 3 });
  });
});
