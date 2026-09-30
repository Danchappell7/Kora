import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Paywall } from "./Billing";
import type { Subscription } from "../data/types";

const past = new Date(Date.now() - 86400000).toISOString();
const sub = (o: Partial<Subscription>): Subscription => ({ plan: "team", status: "past_due", trialEndsAt: past, seats: 3, ...o });

describe("Paywall", () => {
  it("sends a past-due customer to update their card instead of buying a second plan", () => {
    const onManageBilling = vi.fn();
    const onChoose = vi.fn();
    render(<Paywall sub={sub({})} seats={3} busyPlan={null} onChoose={onChoose} onManageBilling={onManageBilling} />);
    expect(screen.getByRole("heading", { name: /last payment didn't go through/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /choose team/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /update payment method/i }));
    expect(onManageBilling).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("offers plans after a trial ends or a subscription is cancelled", () => {
    const { unmount } = render(<Paywall sub={sub({ status: "trialing", plan: null })} seats={2} busyPlan={null} onChoose={vi.fn()} onManageBilling={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /free trial has ended/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose team · 2 seats/i })).toBeInTheDocument();
    unmount();
    render(<Paywall sub={sub({ status: "canceled" })} seats={1} busyPlan={null} onChoose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /subscription is inactive/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose personal/i })).toBeInTheDocument();
  });

  it("still shows plans for past-due when no billing portal is wired up", () => {
    render(<Paywall sub={sub({})} seats={1} busyPlan={null} onChoose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /choose personal/i })).toBeInTheDocument();
  });
});
