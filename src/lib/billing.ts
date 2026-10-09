/* ============================================================
   KANBO — billing state: is billing on, how long the trial has left,
   and whether this subscription may use the app. Its own module so the
   shell can answer without loading the billing screens (components/
   Billing, which re-exports these).
   ============================================================ */
import type { Subscription } from "../data/types";

// Billing is OFF by default (free testing/feedback phase): nobody is asked to
// pay and no trial countdown shows. Flip VITE_BILLING_ENABLED=true to turn the
// 7-day trial + paywall back on.
export const BILLING_ENABLED = import.meta.env.VITE_BILLING_ENABLED === "true";

export function trialDaysLeft(sub: Subscription | null): number {
  if (!sub) return 0;
  return Math.max(0, Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / 86400000));
}
export function hasAccess(sub: Subscription | null): boolean {
  if (!BILLING_ENABLED) return true; // free mode → never lock anyone out
  if (!sub) return true; // unknown → don't lock out
  if (sub.status === "active") return true;
  return sub.status === "trialing" && new Date(sub.trialEndsAt).getTime() > Date.now();
}
