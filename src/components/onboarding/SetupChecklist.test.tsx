import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { OnboardingState } from "../../data/types";
import { SetupChecklist } from "./SetupChecklist";

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
