import { describe, it, expect } from "vitest";
import { trialDaysLeft, hasAccess } from "./Billing";
import type { Subscription } from "../data/types";

const sub = (o: Partial<Subscription>): Subscription => ({ plan: null, status: "trialing", trialEndsAt: new Date().toISOString(), seats: 1, ...o });

describe("billing access logic", () => {
  it("grants access during an active trial", () => {
    const future = new Date(Date.now() + 3 * 86400000).toISOString();
    const s = sub({ status: "trialing", trialEndsAt: future });
    expect(hasAccess(s)).toBe(true);
    expect(trialDaysLeft(s)).toBe(3);
  });

  it("blocks access when the trial has expired", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(hasAccess(sub({ status: "trialing", trialEndsAt: past }))).toBe(false);
    expect(trialDaysLeft(sub({ status: "trialing", trialEndsAt: past }))).toBe(0);
  });

  it("grants access to active subscribers and blocks canceled/past_due", () => {
    expect(hasAccess(sub({ status: "active", plan: "team" }))).toBe(true);
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(hasAccess(sub({ status: "canceled", trialEndsAt: past }))).toBe(false);
    expect(hasAccess(sub({ status: "past_due", trialEndsAt: past }))).toBe(false);
  });

  it("does not lock out when subscription state is unknown", () => {
    expect(hasAccess(null)).toBe(true);
  });
});
