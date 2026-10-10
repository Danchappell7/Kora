import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { OnboardingState } from "../../data/types";
import { TourHost, keyCap } from "./TourHost";
import { __resetTourBus, declineTour, startTour } from "../../lib/onboarding";

const NOW = new Date("2026-10-09T10:00:00+01:00");
const card = () => screen.queryByRole("dialog");
const flush = () => act(async () => { await Promise.resolve(); });
const lastTour = (fn: ReturnType<typeof vi.fn>) => (fn.mock.calls[fn.mock.calls.length - 1]?.[0] as OnboardingState | undefined)?.tour;

let width = 1440;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __resetTourBus();
  width = 1440;
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => width });
  Object.defineProperty(window, "innerHeight", { configurable: true, get: () => 900 });
  window.history.replaceState({}, "", "/p/launch/board");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function anchor(tour: string, r: { top: number; left: number; width: number; height: number }) {
  const el = document.createElement("div");
  el.setAttribute("data-tour", tour);
  el.scrollIntoView = vi.fn();
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}) } as DOMRect);
  document.body.appendChild(el);
  return el;
}

describe("starting by itself", () => {
  it("asks a new person first; focus lands on “Show me around”", () => {
    render(<TourHost role="owner" onboarding={{}} onChange={vi.fn()} isNewAccount />);
    const d = card()!;
    expect(d).toHaveAccessibleName("Take a three-minute tour?");
    expect(d).toHaveAttribute("aria-modal", "false");
    expect(screen.getByRole("button", { name: /Show me around/ })).toHaveFocus();
    expect(screen.getByText(/any time from Help/)).toBeInTheDocument();
  });
  it("“Not now” is remembered as skipped, and focus goes back", () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    const onChange = vi.fn();
    render(<TourHost role="owner" onboarding={{ momentum: { streakHidden: true } }} onChange={onChange} isNewAccount />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(card()).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ v: 1, momentum: { streakHidden: true }, tour: { step: null, done: false, skipped: true, role: "owner", updatedAt: NOW.toISOString() } });
    expect(before).toHaveFocus();
  });
  it("Escape on the offer is “Not now”", () => {
    const onChange = vi.fn();
    render(<TourHost role="member" onboarding={{}} onChange={onChange} isNewAccount />);
    fireEvent.keyDown(screen.getByRole("button", { name: /Show me around/ }), { key: "Escape" });
    expect(card()).toBeNull();
    expect(lastTour(onChange)).toMatchObject({ skipped: true });
  });
  it("not for an existing account, nor once it's done or skipped", () => {
    const { rerender } = render(<TourHost role="owner" onboarding={{}} onChange={vi.fn()} />);
    expect(card()).toBeNull();
    rerender(<TourHost role="owner" onboarding={{ tour: { step: null, done: true } }} onChange={vi.fn()} isNewAccount />);
    expect(card()).toBeNull();
  });
  it("never over an open dialog: it waits for the first-run sheet to close", () => {
    const sheet = document.createElement("div");
    sheet.setAttribute("aria-modal", "true");
    document.body.appendChild(sheet);
    render(<TourHost role="owner" onboarding={{}} onChange={vi.fn()} isNewAccount />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(card()).toBeNull();
    sheet.remove();
    act(() => { vi.advanceTimersByTime(300); });
    expect(card()).toHaveAccessibleName("Take a three-minute tour?");
  });
  it("carries on where it was left (a part-way tour), in its place", () => {
    const onNavigate = vi.fn();
    render(<TourHost role="owner" onboarding={{ tour: { step: "plan-day", done: false } }} onChange={vi.fn()} onNavigate={onNavigate} />);
    expect(card()).toHaveAccessibleName("Step 4 of 7: Plan my day");
    expect(onNavigate).toHaveBeenCalledWith({ view: "plan" });
  });
  it("a “Not now” from the first-run dialog is recorded as skipped, nothing shown", async () => {
    declineTour({ from: "onboarding" });
    const onChange = vi.fn();
    render(<TourHost role="owner" onboarding={{}} onChange={onChange} isNewAccount />);
    await flush();
    expect(card()).toBeNull();
    expect(lastTour(onChange)).toMatchObject({ skipped: true, done: false });
  });
});

describe("taking the tour", () => {
  it("asked for (Help): straight to step 1, Next / Back, each move read out, progress saved after a pause", async () => {
    const onChange = vi.fn();
    render(<TourHost role="owner" onboarding={{}} onChange={onChange} />);
    expect(card()).toBeNull();
    act(() => startTour({ from: "help" }));
    expect(card()).toHaveAccessibleName("Step 1 of 7: Your five places");
    expect(screen.getByText("1 of 7")).toBeInTheDocument();
    const next = screen.getByRole("button", { name: /Next/ });
    expect(next).toHaveFocus();
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
    fireEvent.click(next);
    expect(card()).toHaveAccessibleName("Step 2 of 7: Search or ask Kanbo");
    expect(screen.getByRole("status")).toHaveTextContent(/^Step 2 of 7: Search or ask Kanbo\. Find any task/);
    expect(screen.getByText("Shortcut: " + keyCap("⌘K").spoken)).toBeInTheDocument();
    expect(next).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(card()).toHaveAccessibleName("Step 1 of 7: Your five places");
    expect(onChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(600); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastTour(onChange)).toEqual({ step: "places", done: false, skipped: false, role: "owner", updatedAt: NOW.toISOString() });
  });
  it("arrow keys move; Escape skips — and it's the tour's own Escape (App's handler and dialogs below leave it)", () => {
    const onChange = vi.fn();
    const seen: boolean[] = [];
    const spy = (e: KeyboardEvent) => { if (e.key === "Escape") seen.push(e.defaultPrevented); };
    window.addEventListener("keydown", spy);
    render(<TourHost role="member" onboarding={{ tour: { step: "search", done: false } }} onChange={onChange} />);
    const d = card()!;
    fireEvent.keyDown(d, { key: "ArrowRight" });
    expect(d).toHaveAccessibleName("Step 3 of 6: Capture in a second");
    fireEvent.keyDown(d, { key: "ArrowLeft" });
    expect(d).toHaveAccessibleName("Step 2 of 6: Search or ask Kanbo");
    fireEvent.keyDown(screen.getByRole("button", { name: /Next/ }), { key: "Escape" });
    window.removeEventListener("keydown", spy);
    expect(card()).toBeNull();
    expect(seen).toEqual([]); // it never reached the window
    expect(lastTour(onChange)).toMatchObject({ step: null, skipped: true, role: "member" });
  });
  it("Skip tour (×) ends it and takes you back where you started", () => {
    const onNavigate = vi.fn();
    const onChange = vi.fn();
    render(<TourHost role="owner" onboarding={{ tour: { step: "capture", done: false } }} onChange={onChange} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: /Next/ })); // → Plan my day: goes to Today
    expect(onNavigate).toHaveBeenLastCalledWith({ view: "plan" });
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ view: "project", projectId: "launch", tab: "board" });
    expect(lastTour(onChange)).toMatchObject({ skipped: true });
  });
  it("the task-panel step opens the sample project's first task; the Inbox step goes to the Inbox; Finish saves it done", () => {
    const onOpenTask = vi.fn(), onNavigate = vi.fn(), onChange = vi.fn();
    render(<TourHost role="member" onChange={onChange} onOpenTask={onOpenTask} onNavigate={onNavigate}
      onboarding={{ tour: { step: "task-panel", done: false }, sample: { projectId: "p", taskIds: ["t-start", "t-2"], createdAt: "c" } }} />);
    expect(card()).toHaveAccessibleName("Step 5 of 6: Everything about a task");
    expect(onOpenTask).toHaveBeenCalledWith("t-start");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ view: "inbox" });
    const finish = screen.getByRole("button", { name: /Finish/ });
    fireEvent.click(finish);
    expect(card()).toBeNull();
    expect(lastTour(onChange)).toEqual({ step: null, done: true, skipped: false, role: "member", updatedAt: NOW.toISOString() });
    expect(onNavigate).toHaveBeenLastCalledWith({ view: "project", projectId: "launch", tab: "board" });
  });
  it("no sample project: the task panel step explains instead (a centred card)", () => {
    const onOpenTask = vi.fn();
    render(<TourHost role="owner" onboarding={{ tour: { step: "task-panel", done: false } }} onChange={vi.fn()} onOpenTask={onOpenTask} />);
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(card()).toHaveAttribute("data-mode", "centre");
    expect(document.querySelector(".ktour-dim")).not.toBeNull();
  });
  it("guests: four reading steps", () => {
    render(<TourHost role="guest" onboarding={{ tour: { step: "places", done: false } }} onChange={vi.fn()} />);
    expect(card()).toHaveAccessibleName("Step 1 of 4: Your five places");
    for (const title of ["Search or ask Kanbo", "Everything about a task", "Triage your Inbox"]) {
      fireEvent.click(screen.getByRole("button", { name: /Next/ }));
      expect(card()).toHaveAccessibleName(new RegExp(title));
    }
    expect(screen.getByRole("button", { name: /Finish/ })).toBeInTheDocument();
  });
});

describe("pointing at the real UI", () => {
  it("rings the anchor and sits beside it (the sidebar's places → to its right)", () => {
    anchor("places", { top: 120, left: 10, width: 212, height: 180 });
    render(<TourHost role="owner" onboarding={{ tour: { step: "places", done: false } }} onChange={vi.fn()} />);
    const spot = document.querySelector<HTMLElement>(".ktour-spot")!;
    expect(spot).not.toBeNull();
    expect(spot.style.top).toBe("114px");
    expect(spot.style.width).toBe("224px");
    expect(card()).toHaveAttribute("data-side", "right");
    expect(card()!.style.left).toBe("236px");
  });
  it("follows an anchor that turns up late (a place still loading)", () => {
    render(<TourHost role="owner" onboarding={{ tour: { step: "search", done: false } }} onChange={vi.fn()} />);
    expect(document.querySelector(".ktour-spot")).toBeNull();
    anchor("search", { top: 12, left: 600, width: 280, height: 32 });
    act(() => { vi.advanceTimersByTime(250); });
    expect(document.querySelector(".ktour-spot")).not.toBeNull();
    expect(card()).toHaveAttribute("data-side", "bottom");
  });
  it("scrolls an anchor into view — without gliding when motion is reduced", () => {
    const orig = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia;
    const el = anchor("plan-day", { top: -20, left: 300, width: 200, height: 40 });
    render(<TourHost role="owner" onboarding={{ tour: { step: "plan-day", done: false } }} onChange={vi.fn()} />);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" });
    window.matchMedia = orig;
  });
  it("phones: docked to the bottom, in a phone's words, no key caps", () => {
    width = 390;
    render(<TourHost role="owner" onboarding={{ tour: { step: "capture", done: false } }} onChange={vi.fn()} />);
    expect(card()).toHaveAttribute("data-mode", "dock");
    expect(card()).toHaveAttribute("data-side", "bottom");
    expect(screen.getByText(/Tap \+ in the bar at the bottom/)).toBeInTheDocument();
    expect(screen.queryByText(/Shortcut:/)).toBeNull();
  });
  it("on a Mac ⌘K; elsewhere Ctrl K", () => {
    expect(keyCap("⌘K", true)).toEqual({ shown: "⌘K", spoken: "Command K" });
    expect(keyCap("⌘K", false)).toEqual({ shown: "Ctrl K", spoken: "Control K" });
    expect(keyCap("Q", false)).toEqual({ shown: "Q", spoken: "Q" });
  });
});
