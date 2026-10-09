import { afterEach, describe, expect, it, vi } from "vitest";
import { findTourAnchor, isShown, placeCoachCard, sameBox, spotlightBox } from "./tourPlacement";

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const CARD = { width: 360, height: 220 };

describe("where the coach card goes", () => {
  it("to the right of the sidebar's places", () => {
    const p = placeCoachCard({ top: 120, left: 10, width: 212, height: 180 }, CARD, DESK);
    expect(p).toMatchObject({ mode: "beside", side: "right", left: 10 + 212 + 14 });
    expect(p.top).toBe(Math.round(120 + 90 - 110));
  });
  it("below a header control, lined up with it — or with its right edge near the window's", () => {
    expect(placeCoachCard({ top: 12, left: 600, width: 280, height: 32 }, CARD, DESK)).toMatchObject({ mode: "beside", side: "bottom", top: 58, left: 600 });
    const right = placeCoachCard({ top: 12, left: 1300, width: 110, height: 32 }, CARD, DESK);
    expect(right).toMatchObject({ side: "bottom", left: 1300 + 110 - 360 });
  });
  it("above an anchor near the bottom", () => {
    expect(placeCoachCard({ top: 800, left: 400, width: 200, height: 40 }, CARD, DESK)).toMatchObject({ side: "top", top: 800 - 14 - 220 });
  });
  it("to the left of a panel docked on the right, level with its title", () => {
    const p = placeCoachCard({ top: 0, left: 960, width: 480, height: 900 }, CARD, DESK);
    expect(p).toMatchObject({ mode: "beside", side: "left", left: 960 - 14 - 360, top: 56 });
  });
  it("a huge anchor (a list filling the page): the bottom corner away from it", () => {
    const p = placeCoachCard({ top: 60, left: 240, width: 900, height: 820 }, CARD, DESK);
    expect(p).toMatchObject({ mode: "corner", side: "bottom", top: 900 - 12 - 220 });
    expect(p.left).toBe(DESK.width - 12 - 360);
  });
  it("never off-screen", () => {
    const p = placeCoachCard({ top: -50, left: -40, width: 30, height: 30 }, CARD, DESK);
    expect(p.top).toBeGreaterThanOrEqual(12);
    expect(p.left).toBeGreaterThanOrEqual(12);
    expect(p.left + CARD.width).toBeLessThanOrEqual(DESK.width - 12);
  });
  it("no anchor: centred", () => {
    expect(placeCoachCard(null, CARD, DESK)).toEqual({ mode: "centre", top: 340, left: 540 });
  });
  it("phones: docked to the bottom, or the top when the anchor is low on the screen", () => {
    expect(placeCoachCard({ top: 60, left: 16, width: 200, height: 40 }, CARD, PHONE)).toMatchObject({ mode: "dock", side: "bottom" });
    expect(placeCoachCard({ top: 700, left: 16, width: 200, height: 40 }, CARD, PHONE)).toMatchObject({ mode: "dock", side: "top", top: 12 });
    expect(placeCoachCard(null, CARD, PHONE)).toMatchObject({ mode: "dock", side: "bottom" });
  });
});

describe("the spotlight", () => {
  it("rings the anchor with a little room, inside the window", () => {
    expect(spotlightBox({ top: 100, left: 100, width: 50, height: 20 }, DESK)).toEqual({ top: 94, left: 94, width: 62, height: 32 });
    expect(spotlightBox({ top: 0, left: 1000, width: 440, height: 900 }, DESK)).toEqual({ top: 2, left: 994, width: 444, height: 896 });
  });
  it("same box", () => {
    expect(sameBox({ top: 1, left: 2, width: 3, height: 4 }, { top: 1, left: 2, width: 3, height: 4 })).toBe(true);
    expect(sameBox(null, { top: 1, left: 2, width: 3, height: 4 })).toBe(false);
    expect(sameBox(null, null)).toBe(true);
  });
});

describe("finding the anchor", () => {
  afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });
  const rect = (el: Element, r: Partial<DOMRect>) => vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}), ...r } as DOMRect);

  it("the first copy that's on screen (a phone and a desktop copy of the same control)", () => {
    document.body.innerHTML = `<button id="a" data-tour="search"></button><button id="b" data-tour="search"></button>`;
    const [a, b] = Array.from(document.querySelectorAll("button"));
    rect(a, { width: 0, height: 0 });
    rect(b, { top: 10, left: 10, width: 32, height: 32, right: 42, bottom: 42 });
    expect(findTourAnchor('[data-tour="search"]')?.id).toBe("b");
  });
  it("not when it's inside a closed drawer (inert), hidden, or scrolled out of the window", () => {
    document.body.innerHTML = `<div inert><nav id="n" data-tour="places"></nav></div><div hidden><p id="h"></p></div><p id="o"></p>`;
    const r = { top: 10, left: 10, width: 100, height: 100, right: 110, bottom: 110 };
    for (const id of ["n", "h", "o"]) rect(document.getElementById(id)!, id === "o" ? { ...r, top: 2000, bottom: 2100 } : r);
    expect(findTourAnchor('[data-tour="places"]')).toBeNull();
    expect(isShown(document.getElementById("h")!)).toBe(false);
    expect(isShown(document.getElementById("o")!)).toBe(false);
  });
});
