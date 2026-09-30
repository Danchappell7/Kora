import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Paywall, BillingPanel, shortDate } from "./Billing";
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
    // plan cards must not sit under a heading that implies they fix the payment
    expect(screen.getByRole("heading", { name: /subscription is inactive/i })).toBeInTheDocument();
    expect(screen.queryByText(/last payment didn't go through/i)).not.toBeInTheDocument();
  });
});

describe("Settings › Billing panel", () => {
  const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

  it("shows the trial's days left and offers the plans", () => {
    const onUpgrade = vi.fn();
    render(<BillingPanel enabled subscription={sub({ status: "trialing", plan: null, trialEndsAt: inDays(5) })} onUpgrade={onUpgrade} onManageBilling={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Free trial" })).toBeInTheDocument();
    expect(screen.getByText("5 days left")).toBeInTheDocument();
    expect(screen.getByText(/Personal is £8 per month; Team is £12 per person per month/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose a plan" }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it("shows an active plan with its seats and renewal, and opens billing", () => {
    const onManageBilling = vi.fn();
    render(<BillingPanel enabled subscription={sub({ status: "active", plan: "team", seats: 4, currentPeriodEnd: "2026-10-30T12:00:00Z" })} onManageBilling={onManageBilling} />);
    expect(screen.getByRole("heading", { name: "Team plan" })).toBeInTheDocument();
    expect(screen.getByText(/£12 per person per month · 4 seats · Renews on Fri 30 Oct/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Manage billing/ }));
    expect(onManageBilling).toHaveBeenCalledTimes(1);
  });

  it("sends a failed payment to update the card", () => {
    const onManageBilling = vi.fn();
    render(<BillingPanel enabled subscription={sub({})} onUpgrade={vi.fn()} onManageBilling={onManageBilling} />);
    expect(screen.getByText("Payment failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Update payment method/ }));
    expect(onManageBilling).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Choose a plan" })).toBeNull();
  });

  it("is free while billing is off, and guests are sent to their admin", () => {
    const { unmount } = render(<BillingPanel enabled={false} subscription={null} />);
    expect(screen.getByText("Kanbo is free during early access.")).toBeInTheDocument();
    unmount();
    render(<BillingPanel enabled guest subscription={sub({ status: "active" })} onManageBilling={vi.fn()} />);
    expect(screen.getByText("Your workspace admin manages billing.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("writes dates the en-GB way on every engine", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    expect(shortDate("2026-10-07T12:00:00Z", now)).toBe("Wed 7 Oct");
    expect(shortDate("2027-01-04T12:00:00Z", now)).toBe("Mon 4 Jan 2027");
    expect(shortDate("not a date", now)).toBeNull();
    expect(shortDate(null, now)).toBeNull();
  });
});
