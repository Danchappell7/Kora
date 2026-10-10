import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  swipeDecision, swipeResist, swipeVelocity, haptic, useSwipeRow,
  SWIPE_LOCK_PX, SWIPE_COMMIT_RATIO, SWIPE_FLING_VELOCITY, SWIPE_FLING_MIN_PX, LONG_PRESS_MS, SWIPE_GLIDE_MS,
  type SwipeRowOptions,
} from "./gestures";
import { installPointerEvent, down, moveTo, up, cancel, swipeBy } from "../components/phone/testPointer";

installPointerEvent();

const media = (matches: (q: string) => boolean) => {
  const orig = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: matches(q), media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  return () => { window.matchMedia = orig; };
};

describe("the contract's constants", () => {
  it("are the ones lib/gestures promised", () => {
    expect([SWIPE_LOCK_PX, SWIPE_COMMIT_RATIO, SWIPE_FLING_VELOCITY, LONG_PRESS_MS]).toEqual([10, 0.35, 0.6, 450]);
  });
});

describe("swipeDecision", () => {
  it("a short drag is no swipe at all", () => {
    expect(swipeDecision(0, 360, 0)).toEqual({ commit: false, direction: null });
    expect(swipeDecision(SWIPE_LOCK_PX - 1, 360, 5)).toEqual({ commit: false, direction: null });
    expect(swipeDecision(-(SWIPE_LOCK_PX - 1), 360, -5)).toEqual({ commit: false, direction: null });
  });
  it("commits past the ratio of the row's width, either way", () => {
    const at = 360 * SWIPE_COMMIT_RATIO;
    expect(swipeDecision(at - 1, 360, 0)).toEqual({ commit: false, direction: "right" });
    expect(swipeDecision(at, 360, 0)).toEqual({ commit: true, direction: "right" });
    expect(swipeDecision(-at, 360, 0)).toEqual({ commit: true, direction: "left" });
    expect(swipeDecision(-(at - 1), 360, 0)).toEqual({ commit: false, direction: "left" });
    // a wider row needs further
    expect(swipeDecision(at, 800, 0).commit).toBe(false);
  });
  it("a fling commits early, but still has to travel a little", () => {
    expect(swipeDecision(40, 360, SWIPE_FLING_VELOCITY)).toEqual({ commit: true, direction: "right" });
    expect(swipeDecision(-40, 360, -SWIPE_FLING_VELOCITY)).toEqual({ commit: true, direction: "left" });
    expect(swipeDecision(40, 360, SWIPE_FLING_VELOCITY - 0.01).commit).toBe(false);
    expect(swipeDecision(SWIPE_FLING_MIN_PX - 1, 360, 3).commit).toBe(false);
  });
  it("flicking back the way it came changes its mind, however far it went", () => {
    expect(swipeDecision(300, 360, -SWIPE_FLING_VELOCITY)).toEqual({ commit: false, direction: "right" });
    expect(swipeDecision(-300, 360, SWIPE_FLING_VELOCITY)).toEqual({ commit: false, direction: "left" });
    // a slow drift back still commits
    expect(swipeDecision(300, 360, -0.2).commit).toBe(true);
  });
  it("copes with an unmeasured row and junk numbers", () => {
    expect(swipeDecision(130, 0, 0).commit).toBe(true);          // 360 assumed: 126 commits
    expect(swipeDecision(130, Number.NaN, Number.NaN).commit).toBe(true);
    expect(swipeDecision(Number.NaN, 360, 1)).toEqual({ commit: false, direction: null });
  });
});

describe("swipeResist and swipeVelocity", () => {
  it("rubber-bands past the limit, both ways", () => {
    expect(swipeResist(100, 120)).toBe(100);
    expect(swipeResist(200, 120)).toBe(140);
    expect(swipeResist(-200, 120)).toBe(-140);
    expect(swipeResist(200, 120, 0.5)).toBe(160);
    expect(swipeResist(50, 0)).toBe(50);
  });
  it("measures the last ~100ms", () => {
    expect(swipeVelocity([])).toBe(0);
    expect(swipeVelocity([{ x: 0, t: 0 }])).toBe(0);
    expect(swipeVelocity([{ x: 0, t: 0 }, { x: 100, t: 100 }])).toBe(1);
    // a slow start doesn't water down a fast finish
    expect(swipeVelocity([{ x: 0, t: 0 }, { x: 10, t: 400 }, { x: 60, t: 450 }, { x: 110, t: 500 }])).toBe(1);
    expect(swipeVelocity([{ x: 5, t: 10 }, { x: 5, t: 10 }])).toBe(0);
  });
});

describe("haptic", () => {
  let vibrate: ReturnType<typeof vi.fn>;
  beforeEach(() => { vibrate = vi.fn(() => true); Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true }); });
  afterEach(() => { delete (navigator as { vibrate?: unknown }).vibrate; });
  it("buzzes on a phone", () => {
    const restore = media((q) => /pointer: coarse|hover: none/.test(q));
    try { haptic(12); expect(vibrate).toHaveBeenCalledWith(12); } finally { restore(); }
  });
  it("stays still on a desktop, and with reduced motion", () => {
    let restore = media(() => false);
    try { haptic(); expect(vibrate).not.toHaveBeenCalled(); } finally { restore(); }
    restore = media((q) => /pointer: coarse|reduce/.test(q));
    try { haptic(); expect(vibrate).not.toHaveBeenCalled(); } finally { restore(); }
  });
  it("never throws, whatever the browser does", () => {
    const restore = media((q) => /pointer: coarse/.test(q));
    try {
      vibrate.mockImplementation(() => { throw new Error("blocked by permissions policy"); });
      expect(() => haptic([10, 20])).not.toThrow();
      delete (navigator as { vibrate?: unknown }).vibrate;
      expect(() => haptic()).not.toThrow();
    } finally { restore(); }
  });
});

/* ---------- the hook ---------- */

function Row(props: SwipeRowOptions & { onClick?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const sw = useSwipeRow({ ...props, hostRef: host, revealWidth: 192 });
  return (
    <div ref={host}>
      <div data-testid="row" {...sw.bind} onClick={props.onClick} data-phase={sw.phase} data-dir={sw.direction ?? ""} data-offset={sw.offset}
        data-open={sw.open || undefined} data-still={sw.still || undefined} data-glide={sw.gliding || undefined}>
        <button type="button">Title</button>
      </div>
      {sw.open && <button type="button" onClick={sw.reset}>Tomorrow</button>}
    </div>
  );
}

describe("useSwipeRow", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00")); });
  afterEach(() => { vi.useRealTimers(); });

  it("a long swipe right commits once, and the click it leaves behind is swallowed", () => {
    const onSwipeRight = vi.fn(), onClick = vi.fn();
    render(<Row onSwipeRight={onSwipeRight} onClick={onClick} />);
    const row = screen.getByTestId("row");
    swipeBy(row, 200);
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
    expect(row.dataset.phase).toBe("committed");
    fireEvent.click(row);
    expect(onClick).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(SWIPE_GLIDE_MS + 10); });
    expect(row.dataset.phase).toBe("idle");
    expect(row.dataset.offset).toBe("0");
    // a later tap is a tap
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("arms (with a buzz) as the finger crosses the line, and disarms coming back", () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    const restore = media((q) => /pointer: coarse/.test(q));
    try {
      const onSwipeRight = vi.fn();
      render(<Row onSwipeRight={onSwipeRight} />);
      const row = screen.getByTestId("row");
      down(row, 100, 20);
      act(() => { vi.advanceTimersByTime(40); });
      moveTo(row, 150, 20);
      expect(row.dataset.phase).toBe("tracking");
      act(() => { vi.advanceTimersByTime(40); });
      moveTo(row, 240, 20);
      expect(row.dataset.phase).toBe("armed");
      expect(vibrate).toHaveBeenCalledTimes(1);
      act(() => { vi.advanceTimersByTime(200); });
      moveTo(row, 130, 20);
      expect(row.dataset.phase).toBe("tracking");
      act(() => { vi.advanceTimersByTime(200); });
      up(row, 130, 20);
      expect(onSwipeRight).not.toHaveBeenCalled();
    } finally { restore(); delete (navigator as { vibrate?: unknown }).vibrate; }
  });

  it("a short, slow swipe springs back; a short flick commits", () => {
    const onSwipeRight = vi.fn();
    render(<Row onSwipeRight={onSwipeRight} />);
    const row = screen.getByTestId("row");
    swipeBy(row, 60, { msPerStep: 80 });
    expect(onSwipeRight).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(600); });
    swipeBy(row, 60, { msPerStep: 10 });
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
  });

  it("a swipe left opens the reveal, which stays open; a tap on the row or anywhere else closes it", () => {
    const onSwipeLeft = vi.fn(), onClick = vi.fn();
    render(<><Row onSwipeLeft={onSwipeLeft} onClick={onClick} /><p>elsewhere</p></>);
    const row = screen.getByTestId("row");
    swipeBy(row, -200);
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(row.dataset.open).toBe("true");
    expect(row.dataset.offset).toBe("-192");
    act(() => { vi.advanceTimersByTime(600); });
    // a tap on the row closes it and doesn't open anything
    fireEvent.click(row);
    expect(onClick).not.toHaveBeenCalled();
    expect(row.dataset.open).toBeUndefined();
    // open again; a touch elsewhere closes it
    act(() => { vi.advanceTimersByTime(600); });
    swipeBy(row, -200);
    expect(row.dataset.open).toBe("true");
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(row.dataset.open).toBeUndefined();
  });

  it("a reveal button used straight after the swipe ends its aftermath: the app's next click is a real one", () => {
    const onClick = vi.fn();
    render(<Row onSwipeLeft={() => {}} onClick={onClick} />);
    const row = screen.getByTestId("row");
    swipeBy(row, -200);
    // (well inside the swallow window) the tray's Pick: it closes the reveal, then clicks into the row
    fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    expect(row.dataset.open).toBeUndefined();
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("an open reveal can be pushed shut, but a nudge leaves it open", () => {
    render(<Row onSwipeLeft={() => {}} />);
    const row = screen.getByTestId("row");
    swipeBy(row, -200);
    act(() => { vi.advanceTimersByTime(600); });
    swipeBy(row, 30, { msPerStep: 80 });
    expect(row.dataset.open).toBe("true");
    act(() => { vi.advanceTimersByTime(600); });
    swipeBy(row, 120);
    expect(row.dataset.open).toBeUndefined();
  });

  it("a way the row doesn't go is a scroll (no left reveal without onSwipeLeft)", () => {
    const onSwipeRight = vi.fn();
    render(<Row onSwipeRight={onSwipeRight} />);
    const row = screen.getByTestId("row");
    swipeBy(row, -200);
    expect(row.dataset.offset).toBe("0");
    expect(row.dataset.open).toBeUndefined();
  });

  it("vertical movement is a scroll: the row stays put and nothing fires", () => {
    const onSwipeRight = vi.fn(), onSwipeLeft = vi.fn(), onLongPress = vi.fn();
    render(<Row onSwipeRight={onSwipeRight} onSwipeLeft={onSwipeLeft} onLongPress={onLongPress} />);
    const row = screen.getByTestId("row");
    down(row, 100, 100);
    act(() => { vi.advanceTimersByTime(30); });
    moveTo(row, 106, 140);   // mostly down: it's a scroll
    act(() => { vi.advanceTimersByTime(30); });
    moveTo(row, 300, 150);   // too late to become a swipe
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    up(row, 300, 150);
    expect(row.dataset.offset).toBe("0");
    expect(onSwipeRight).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("a mouse never swipes", () => {
    const onSwipeRight = vi.fn();
    render(<Row onSwipeRight={onSwipeRight} />);
    const row = screen.getByTestId("row");
    swipeBy(row, 250, { pointerType: "mouse" });
    expect(onSwipeRight).not.toHaveBeenCalled();
    expect(row.dataset.offset).toBe("0");
  });

  it("a long press fires once, swallows its click, and a move first cancels it", () => {
    const onLongPress = vi.fn(), onClick = vi.fn();
    render(<Row onLongPress={onLongPress} onClick={onClick} />);
    const row = screen.getByTestId("row");
    const title = screen.getByRole("button", { name: "Title" });
    down(title, 100, 20);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 10); });
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(20); });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    up(title, 100, 20);
    // the click (and the mouse events) the phone sends after it are spent
    const end = new Event("touchend", { bubbles: true, cancelable: true });
    title.dispatchEvent(end);
    expect(end.defaultPrevented).toBe(true);
    fireEvent.click(title);
    expect(onClick).not.toHaveBeenCalled();
    // a finger that wanders before the time is up isn't a long press
    act(() => { vi.advanceTimersByTime(600); });
    down(row, 100, 20);
    act(() => { vi.advanceTimersByTime(100); });
    moveTo(row, 100 + SWIPE_LOCK_PX + 2, 20);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    up(row, 100 + SWIPE_LOCK_PX + 2, 20);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(row.dataset.offset).toBe("0");
  });

  it("the long press skips its ignore zone", () => {
    const onLongPress = vi.fn();
    function Z() {
      const sw = useSwipeRow({ onLongPress, longPressIgnore: ".lead" });
      return <div data-testid="z" {...sw.bind}><span className="lead">glyph</span><span>title</span></div>;
    }
    render(<Z />);
    down(screen.getByText("glyph"), 10, 10);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 50); });
    up(screen.getByText("glyph"), 10, 10);
    expect(onLongPress).not.toHaveBeenCalled();
    down(screen.getByText("title"), 10, 10);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 50); });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("ignores presses from a portal the row renders (a menu or picker on document.body)", () => {
    const onSwipeRight = vi.fn(), onLongPress = vi.fn();
    function P() {
      const sw = useSwipeRow({ onSwipeRight, onLongPress });
      return (
        <div data-testid="p" {...sw.bind} data-offset={sw.offset}>
          <span>title</span>
          {createPortal(<button type="button">In a menu</button>, document.body)}
        </div>
      );
    }
    render(<P />);
    const row = screen.getByTestId("p");
    const item = screen.getByRole("button", { name: "In a menu" });
    expect(row.contains(item)).toBe(false);
    swipeBy(item, 200);
    expect(onSwipeRight).not.toHaveBeenCalled();
    expect(row.dataset.offset).toBe("0");
    down(item, 10, 10);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 50); });
    up(item, 10, 10);
    expect(onLongPress).not.toHaveBeenCalled();
    // the row's own content still works
    act(() => { vi.advanceTimersByTime(600); });
    swipeBy(screen.getByText("title"), 200);
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
  });

  it("a cancelled pointer (the browser took it for a scroll) puts the row back", () => {
    const onSwipeRight = vi.fn();
    render(<Row onSwipeRight={onSwipeRight} />);
    const row = screen.getByTestId("row");
    swipeBy(row, 200, { release: false });
    expect(Number(row.dataset.offset)).toBeGreaterThan(0);
    cancel(row, 400, 22);
    expect(onSwipeRight).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(SWIPE_GLIDE_MS + 10); });
    expect(row.dataset.offset).toBe("0");
  });

  it("disabled binds nothing (guests)", () => {
    const onSwipeRight = vi.fn(), onLongPress = vi.fn();
    render(<Row disabled onSwipeRight={onSwipeRight} onLongPress={onLongPress} />);
    const row = screen.getByTestId("row");
    expect(row.style.touchAction || "").toBe("");
    swipeBy(row, 250);
    down(row, 10, 10);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 50); });
    expect(onSwipeRight).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("becoming disabled while open closes the reveal", () => {
    const { rerender } = render(<Row onSwipeLeft={() => {}} />);
    const row = screen.getByTestId("row");
    swipeBy(row, -200);
    expect(row.dataset.open).toBe("true");
    rerender(<Row onSwipeLeft={() => {}} disabled />);
    expect(screen.getByTestId("row").dataset.open).toBeUndefined();
  });

  it("reduced motion: the row doesn't slide, the action still happens", () => {
    const restore = media((q) => /reduce/.test(q));
    try {
      const onSwipeRight = vi.fn();
      render(<Row onSwipeRight={onSwipeRight} onSwipeLeft={() => {}} />);
      const row = screen.getByTestId("row");
      swipeBy(row, 120, { release: false });
      expect(row.dataset.still).toBe("true");
      expect(row.style.transform).toBe("");
      expect(Number(row.dataset.offset)).toBeGreaterThan(0);
      up(row, 320, 22);
      expect(onSwipeRight).toHaveBeenCalledTimes(1);
      expect(row.dataset.glide).toBeUndefined();
    } finally { restore(); }
  });

  it("slides the row while tracking (touch-action keeps vertical scrolling)", () => {
    render(<Row onSwipeRight={() => {}} />);
    const row = screen.getByTestId("row");
    expect(row.style.touchAction).toBe("pan-y pinch-zoom");
    swipeBy(row, 80, { release: false });
    expect(row.style.transform).toBe("translate3d(80px, 0, 0)");
  });
});
