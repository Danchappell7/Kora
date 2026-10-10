import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import type { OnboardingState, TourRole } from "../../data/types";
import { CHECKLIST_CELEBRATE_MS, useShowSetupChecklist, type SetupSignals } from "../../lib/onboarding";
import { SetupChecklist, type SetupChecklistProps } from "./SetupChecklist";

const NOW = new Date("2026-10-09T10:00:00+01:00");
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

const next = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1]?.[0] as OnboardingState;

describe("Get set up", () => {
  it("owners: four items, a progress ring, each with its button", () => {
    const onAction = vi.fn();
    render(<SetupChecklist role="owner" onboarding={{ checklist: { done: { invite_team: "t" } } }} signals={{}} onChange={vi.fn()} onAction={onAction} />);
    const card = screen.getByRole("region", { name: "Get set up" });
    expect(within(card).getByRole("progressbar", { name: "Set-up progress" })).toHaveAttribute("aria-valuetext", "1 of 4 done");
    expect(within(card).getByText(/1 of 4 done · Four quick things to get your team going/)).toBeInTheDocument();
    expect(within(card).getAllByRole("listitem").map((li) => li.querySelector(".ksetup-label")?.textContent))
      .toEqual(["Invite your team", "Connect a calendar", "Add your company domain", "Connect Slack"]);
    expect(within(card).getByRole("checkbox", { name: "Done: Invite your team" })).toBeChecked();
    // done items have no button; the rest take you there
    expect(within(card).queryByRole("button", { name: "Invite: Invite your team" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Connect: Connect a calendar" }));
    expect(onAction).toHaveBeenCalledWith("connect_calendar");
  });
  it("folded (Today beside the rail): one row — how far you are, the next step and its button; Set-up steps opens the list", () => {
    const onAction = vi.fn(), onFold = vi.fn();
    const props = { role: "owner" as TourRole, onboarding: { checklist: { done: { invite_team: "t" } } }, signals: {}, onChange: vi.fn(), onAction };
    const { rerender } = render(<SetupChecklist {...props} fold={{ folded: true, onFold }} />);
    const card = screen.getByRole("region", { name: "Get set up" });
    expect(card).toHaveAttribute("data-folded");
    expect(within(card).getByText("1 of 4 done · Next: Connect a calendar")).toBeInTheDocument();
    // the list is there for the disclosure to open, but hidden (so neither seen nor tabbed to)
    const steps = within(card).getByRole("button", { name: "Set-up steps" });
    expect(steps).toHaveAttribute("aria-expanded", "false");
    const list = document.getElementById(steps.getAttribute("aria-controls")!)!;
    expect(list).not.toBeVisible();
    expect(within(card).queryAllByRole("checkbox")).toHaveLength(0);
    // the next step's button is right there
    fireEvent.click(within(card).getByRole("button", { name: "Connect: Connect a calendar" }));
    expect(onAction).toHaveBeenCalledWith("connect_calendar");
    fireEvent.click(steps);
    expect(onFold).toHaveBeenCalledWith(false);
    rerender(<SetupChecklist {...props} fold={{ folded: false, onFold }} />);
    expect(card).not.toHaveAttribute("data-folded");
    expect(within(card).getByRole("button", { name: "Set-up steps" })).toHaveAttribute("aria-expanded", "true");
    expect(within(card).getAllByRole("checkbox")).toHaveLength(4);
    expect(within(card).getByText(/1 of 4 done · Four quick things/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Set-up steps" }));
    expect(onFold).toHaveBeenLastCalledWith(true);
    // no fold (a phone, or anywhere else): the whole card, no disclosure
    rerender(<SetupChecklist {...props} />);
    expect(within(card).queryByRole("button", { name: "Set-up steps" })).toBeNull();
    expect(within(card).getAllByRole("checkbox")).toHaveLength(4);
  });
  it("members: plan your day, complete a task, install the app, set notifications", () => {
    render(<SetupChecklist role="member" onboarding={{}} signals={{}} onChange={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label")))
      .toEqual(["Done: Plan your day", "Done: Complete a task", "Done: Install the app", "Done: Set your notifications"]);
    expect(screen.getByText(/Four quick things to make Kanbo yours/)).toBeInTheDocument();
  });
  it("an owner who isn't a site admin: no company-domain item", () => {
    render(<SetupChecklist role="owner" hidden={["add_domain"]} onboarding={{}} signals={{}} onChange={vi.fn()} onAction={vi.fn()} />);
    expect(screen.queryByRole("checkbox", { name: "Done: Add your company domain" })).toBeNull();
    expect(screen.getByText(/0 of 3 done · Three quick things/)).toBeInTheDocument();
  });
  it("guests: only what they can do", () => {
    render(<SetupChecklist role="guest" onboarding={{}} signals={{}} onChange={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual(["Done: Install the app", "Done: Set your notifications"]);
    expect(screen.getByText(/0 of 2 done · Two quick things/)).toBeInTheDocument();
  });
  it("tick by hand, untick by hand — and it's read out", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SetupChecklist role="member" onboarding={{}} signals={{}} onChange={onChange} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Done: Complete a task" }));
    expect(next(onChange).checklist).toEqual({ done: { complete_task: NOW.toISOString() } });
    expect(screen.getByRole("status")).toHaveTextContent("Complete a task done. 1 of 4 done.");
    rerender(<SetupChecklist role="member" onboarding={next(onChange)} signals={{}} onChange={onChange} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Done: Complete a task" }));
    expect(next(onChange).checklist).toEqual({ done: {} });
  });
  it("what the app can see ticks itself (saved once, so it sticks) and can't be unticked", () => {
    const onChange = vi.fn();
    const state: OnboardingState = { tour: { step: null, done: true } };
    const { rerender } = render(<SetupChecklist role="member" onboarding={state} signals={{ install_app: true }} onChange={onChange} onAction={vi.fn()} />);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(next(onChange)).toEqual({ tour: { step: null, done: true }, checklist: { done: { install_app: NOW.toISOString() } } });
    const img = screen.getByRole("img", { name: "Done: Install the app" });
    expect(img).toBeInTheDocument();
    expect(screen.getByText("Done: Kanbo can see it's set up.")).toBeInTheDocument();
    rerender(<SetupChecklist role="member" onboarding={state} signals={{ install_app: true }} onChange={onChange} onAction={vi.fn()} />);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  it("Dismiss hides it (the host saves dismissedAt)", () => {
    const onChange = vi.fn();
    render(<SetupChecklist role="owner" onboarding={{}} signals={{}} onChange={onChange} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss “Get set up”" }));
    expect(next(onChange).checklist).toEqual({ dismissedAt: NOW.toISOString() });
  });
  it("the last tick: “You're all set”, said out loud, no Dismiss", () => {
    const onChange = vi.fn();
    const state: OnboardingState = { checklist: { done: { install_app: "a" } } };
    const { rerender } = render(<SetupChecklist role="guest" onboarding={state} signals={{}} onChange={onChange} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Done: Set your notifications" }));
    act(() => { rerender(<SetupChecklist role="guest" onboarding={next(onChange)} signals={{}} onChange={onChange} onAction={vi.fn()} />); });
    expect(screen.getByRole("region", { name: "You're all set" })).toHaveAttribute("data-celebrate", "true");
    expect(screen.getByRole("status")).toHaveTextContent("All set. Everything on your set-up list is done.");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "2 of 2 done");
    expect(screen.queryByRole("button", { name: /Dismiss/ })).toBeNull();
  });
  it("with reduced motion, the same words and no celebration", () => {
    const orig = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia;
    const { rerender } = render(<SetupChecklist role="guest" onboarding={{}} signals={{}} onChange={vi.fn()} onAction={vi.fn()} />);
    rerender(<SetupChecklist role="guest" onboarding={{}} signals={{ install_app: true, set_notifications: true }} onChange={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByRole("region", { name: "You're all set" })).not.toHaveAttribute("data-celebrate");
    expect(screen.getByRole("status")).toHaveTextContent("All set.");
    window.matchMedia = orig;
  });
});

describe("Get set up, mounted the documented way (useShowSetupChecklist)", () => {
  let mounts = 0;
  let shown: boolean[] = [];
  function Probe(props: SetupChecklistProps) {
    useEffect(() => { mounts++; }, []);
    return <SetupChecklist {...props} />;
  }
  /** the host: {useShowSetupChecklist(...) && <SetupChecklist/>}, saving changes into its own state */
  function Host({ initial, role = "guest", signals = {} }: { initial: OnboardingState; role?: TourRole; signals?: SetupSignals }) {
    const [state, setState] = useState(initial);
    const show = useShowSetupChecklist(role, state, signals);
    shown.push(show);
    return (
      <main id="main" tabIndex={-1}>
        <button type="button">Elsewhere</button>
        {show && <Probe role={role} onboarding={state} signals={signals} onChange={setState} onAction={() => {}} />}
      </main>
    );
  }
  // the card's hold is a real timer: fake every clock here (a second useFakeTimers is a no-op, so start over)
  beforeEach(() => { vi.useRealTimers(); vi.useFakeTimers(); vi.setSystemTime(NOW); mounts = 0; shown = []; });

  it("the last tick: the same card stays (no remount), celebrates and says so, then leaves with focus on the main content", () => {
    render(<Host initial={{ checklist: { done: { install_app: "a" } } }} />);
    expect(mounts).toBe(1);
    const box = screen.getByRole("checkbox", { name: "Done: Set your notifications" });
    box.focus();
    act(() => { fireEvent.click(box); });
    // the hook never answered false in between, so the card was never unmounted and remounted
    expect(shown).not.toContain(false);
    expect(mounts).toBe(1);
    expect(screen.getByRole("region", { name: "You're all set" })).toHaveAttribute("data-celebrate", "true");
    expect(screen.getByRole("status")).toHaveTextContent("All set. Everything on your set-up list is done.");
    expect(box).toHaveFocus();
    act(() => { vi.advanceTimersByTime(CHECKLIST_CELEBRATE_MS - 10); });
    expect(screen.getByRole("region", { name: "You're all set" })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(20); });
    expect(screen.queryByRole("region", { name: "You're all set" })).toBeNull();
    // never dropped on <body>
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it("completed by what the app sees (a signal) in front of you: celebrates too", () => {
    const { rerender } = render(<Host initial={{}} role="guest" signals={{ install_app: true }} />);
    expect(mounts).toBe(1);
    rerender(<Host initial={{}} role="guest" signals={{ install_app: true, set_notifications: true }} />);
    expect(mounts).toBe(1);
    expect(screen.getByRole("region", { name: "You're all set" })).toHaveAttribute("data-celebrate", "true");
    act(() => { vi.advanceTimersByTime(CHECKLIST_CELEBRATE_MS + 10); });
    expect(screen.queryByRole("region", { name: "You're all set" })).toBeNull();
  });

  it("Dismiss: the card goes at once, and focus goes to the main content, not <body>", () => {
    render(<Host initial={{}} role="owner" />);
    const dismiss = screen.getByRole("button", { name: "Dismiss “Get set up”" });
    dismiss.focus();
    act(() => { fireEvent.click(dismiss); });
    expect(screen.queryByRole("region", { name: "Get set up" })).toBeNull();
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it("leaving while focus is somewhere else leaves it there", () => {
    render(<Host initial={{ checklist: { done: { install_app: "a" } } }} />);
    act(() => { fireEvent.click(screen.getByRole("checkbox", { name: "Done: Set your notifications" })); });
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    act(() => { vi.advanceTimersByTime(CHECKLIST_CELEBRATE_MS + 10); });
    expect(screen.queryByRole("region", { name: "You're all set" })).toBeNull();
    expect(elsewhere).toHaveFocus();
  });

  it("a list that was already complete never shows (nothing to celebrate)", () => {
    render(<Host initial={{ checklist: { done: { install_app: "a", set_notifications: "b" } } }} />);
    expect(mounts).toBe(0);
    expect(shown.every((v) => v === false)).toBe(true);
  });
});
