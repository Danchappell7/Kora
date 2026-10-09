/* Test helpers for touch gestures (jsdom has no PointerEvent). Imported by tests only. */
import { fireEvent, act } from "@testing-library/react";
import { vi } from "vitest";

/** jsdom has no PointerEvent: without one, pointerId / pointerType / isPrimary never reach React. */
export function installPointerEvent(): void {
  if (typeof window.PointerEvent !== "undefined") return;
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number; pointerType: string; isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}

type Opts = { pointerType?: string; pointerId?: number };
const ev = (x: number, y: number, o: Opts = {}) => ({ clientX: x, clientY: y, pointerId: o.pointerId ?? 1, pointerType: o.pointerType ?? "touch", isPrimary: true, button: 0, bubbles: true, cancelable: true });

export const down = (el: Element, x: number, y: number, o?: Opts) => fireEvent.pointerDown(el, ev(x, y, o));
export const moveTo = (el: Element, x: number, y: number, o?: Opts) => fireEvent.pointerMove(el, ev(x, y, o));
export const up = (el: Element, x: number, y: number, o?: Opts) => fireEvent.pointerUp(el, ev(x, y, o));
export const cancel = (el: Element, x: number, y: number, o?: Opts) => fireEvent.pointerCancel(el, ev(x, y, o));

/**
 * A finger sliding `dx` across `el` in `steps` moves `msPerStep` apart (fake timers: the clock moves with
 * it, so the release speed is real), then letting go. Default: 4 steps of 40ms (a deliberate drag, not a fling).
 */
export function swipeBy(el: Element, dx: number, opts: { dy?: number; steps?: number; msPerStep?: number; release?: boolean; x0?: number; y0?: number; pointerType?: string } = {}) {
  const { dy = 2, steps = 4, msPerStep = 40, release = true, x0 = 200, y0 = 20, pointerType } = opts;
  down(el, x0, y0, { pointerType });
  for (let i = 1; i <= steps; i++) {
    act(() => { vi.advanceTimersByTime(msPerStep); });
    moveTo(el, x0 + (dx * i) / steps, y0 + (dy * i) / steps, { pointerType });
  }
  if (release) {
    act(() => { vi.advanceTimersByTime(16); });
    up(el, x0 + dx, y0 + dy, { pointerType });
  }
}
