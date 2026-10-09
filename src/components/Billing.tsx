/* ============================================================
   KANBO — billing UI: trial banner, plan picker, paywall, and the
   Settings › Billing panel.
   ============================================================ */
import { Icon, KanboLogo, Button, Pill, Sheet } from "./primitives";
import type { Plan, Subscription } from "../data/types";
import { BILLING_ENABLED, trialDaysLeft, hasAccess } from "../lib/billing";

export { BILLING_ENABLED, trialDaysLeft, hasAccess };

const PLANS: { id: Plan; name: string; price: string; unit: string; blurb: string; features: string[] }[] = [
  { id: "personal", name: "Personal", price: "£8", unit: "per month", blurb: "For focused individual work.", features: ["Unlimited tasks and projects", "Plan my day, with Kanbo's suggestions", "Every view, files and reminders"] },
  { id: "team", name: "Team", price: "£12", unit: "per person per month", blurb: "For teams that ship together.", features: ["Everything in Personal", "Shared workspaces and invites", "Assign work and see everyone's load"] },
];


const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Wed 7 Oct" (plus the year when it isn't this one). Built by hand: en-GB
 *  formatting puts a comma after the weekday on some engines and not others. */
export function shortDate(iso: string | null | undefined, now = new Date()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function PlanCards({ seats, busyPlan, onChoose }: { seats: number; busyPlan: Plan | null; onChoose: (p: Plan) => void }) {
  return (
    <div className="kbill-plans">
      {PLANS.map((p) => {
        const featured = p.id === "team";
        return (
          <section key={p.id} className="kbill-plan" data-featured={featured || undefined} aria-labelledby={`kbill-plan-${p.id}`}>
            <div className="kbill-plan-head">
              <h3 id={`kbill-plan-${p.id}`} className="kbill-plan-name">{p.name}</h3>
              {featured && <Pill tone="accent">Popular</Pill>}
            </div>
            <p className="kbill-plan-blurb">{p.blurb}</p>
            <p className="kbill-price"><span className="kbill-price-n">{p.price}</span><span className="kbill-price-u">{p.unit}</span></p>
            <ul className="kbill-feats">
              {p.features.map((f) => (
                <li key={f}><Icon name="check" size={16} sw={2} /> {f}</li>
              ))}
            </ul>
            <Button variant={featured ? "primary" : "secondary"} size="lg" full onClick={() => onChoose(p.id)} disabled={busyPlan != null} aria-busy={busyPlan === p.id || undefined}>
              {busyPlan === p.id ? "Starting…" : featured ? `Choose Team · ${plural(seats, "seat")}` : "Choose Personal"}
            </Button>
          </section>
        );
      })}
    </div>
  );
}

export function TrialBanner({ sub, onUpgrade }: { sub: Subscription; onUpgrade: () => void }) {
  const days = trialDaysLeft(sub);
  const urgent = days <= 2;
  return (
    <div className="kbill-trial" data-urgent={urgent || undefined}>
      <style>{BILLING_CSS}</style>
      <Icon name="hourglass" size={16} sw={1.75} />
      <span className="kbill-trial-text">
        {days === 0 ? <strong>Your free trial ends today.</strong> : <><strong>{plural(days, "day")}</strong> left in your free trial.</>}
        {" "}Choose a plan to keep everything running.
      </span>
      <Button size="sm" variant="primary" onClick={onUpgrade}>Upgrade</Button>
    </div>
  );
}

export function UpgradeModal({ open, onClose, seats, busyPlan, onChoose }: {
  open: boolean; onClose: () => void; seats: number; busyPlan: Plan | null; onChoose: (p: Plan) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} label="Choose a plan" title="Choose your plan" width={640}>
      <style>{BILLING_CSS}</style>
      <p className="kbill-lede">Prices include every feature. Cancel any time from Settings › Billing.</p>
      <PlanCards seats={seats} busyPlan={busyPlan} onChoose={onChoose} />
    </Sheet>
  );
}

export function Paywall({ sub, seats, busyPlan, onChoose, onSignOut, onManageBilling }: {
  sub: Subscription; seats: number; busyPlan: Plan | null; onChoose: (p: Plan) => void; onSignOut?: () => void;
  /** Opens the Stripe billing portal. With it, a past-due customer is sent to
   *  update their card instead of being offered (and charged for) a second plan. */
  onManageBilling?: () => void | Promise<void>;
}) {
  const pastDue = sub.status === "past_due";
  // Stripe is still retrying a past-due subscription; buying a new plan would
  // leave the customer with two. Send them to fix the card instead.
  const fixCard = pastDue && !!onManageBilling;
  // Without the portal a past-due customer can only be shown plans, so don't
  // suggest that picking one fixes the failed payment.
  const heading = fixCard ? "Your last payment didn't go through"
    : sub.status === "trialing" ? "Your free trial has ended"
    : "Your subscription is inactive";
  const body = fixCard
    ? "Update your payment method and your subscription carries on as before. There's no need to choose a new plan. Your tasks, projects and team are safe."
    : "Pick a plan to keep your tasks, projects and team in Kanbo. Your data is safe and waiting.";
  return (
    <main className="kbill-wall">
      <style>{BILLING_CSS}</style>
      <div className="kbill-wall-inner">
        <KanboLogo size={40} />
        <h1 className="kbill-wall-title">{heading}</h1>
        <p className="kbill-wall-body">{body}</p>
        {fixCard ? (
          <Button variant="primary" size="lg" icon="arrowUpRight" onClick={() => { void onManageBilling?.(); }}>Update payment method</Button>
        ) : (
          <PlanCards seats={seats} busyPlan={busyPlan} onChoose={onChoose} />
        )}
        {onSignOut && <Button variant="ghost" className="kbill-wall-signout" onClick={onSignOut}>Sign out</Button>}
      </div>
    </main>
  );
}

/** Settings › Billing: your plan and what you can do about it. */
export function BillingPanel({ enabled, subscription: sub, guest, onUpgrade, onManageBilling }: {
  enabled: boolean;
  subscription: Subscription | null;
  /** guests don't manage billing: their workspace admin does */
  guest?: boolean;
  onUpgrade?: () => void;
  onManageBilling?: () => void;
}) {
  const card = (title: string, body: React.ReactNode, pill?: React.ReactNode, action?: React.ReactNode, note?: React.ReactNode) => (
    <div className="kbill-panel">
      <style>{BILLING_CSS}</style>
      <div className="kbill-card">
        <div className="kbill-card-main">
          <div className="kbill-card-head">
            <h3 className="kbill-card-title">{title}</h3>
            {pill}
          </div>
          <div className="kbill-card-body">{body}</div>
        </div>
        {action && <div className="kbill-card-act">{action}</div>}
      </div>
      {note && <p className="kbill-note">{note}</p>}
    </div>
  );
  // what choosing a plan costs, under the cards that offer one
  const prices = `Personal is ${PLANS[0].price} ${PLANS[0].unit}; Team is ${PLANS[1].price} ${PLANS[1].unit}. Every feature is in both, and you can cancel any time.`;

  if (guest) return card("Your workspace admin manages billing.", <p>Ask them if you need a change to the plan or the number of seats.</p>);
  if (!enabled) return card("Kanbo is free during early access.", <p>Every feature is included, for you and for your team.</p>, <Pill tone="ok">Early access</Pill>);

  const manage = onManageBilling && <Button size="sm" iconRight="arrowUpRight" onClick={onManageBilling}>Manage billing</Button>;
  if (!sub) return card("Your plan", <p>We couldn't load your plan just now. Try again in a moment.</p>, undefined, manage);

  const plan = PLANS.find((p) => p.id === sub.plan);
  const seats = plural(Math.max(1, sub.seats || 1), "seat");
  switch (sub.status) {
    case "trialing": {
      const days = trialDaysLeft(sub);
      const ends = shortDate(sub.trialEndsAt);
      return card("Free trial",
        <p>{ends ? `Your trial ends on ${ends}. ` : ""}Choose a plan to keep everything running.</p>,
        <Pill tone={days <= 2 ? "warn" : "accent"}>{days === 0 ? "Ends today" : `${plural(days, "day")} left`}</Pill>,
        onUpgrade && <Button size="sm" variant="primary" onClick={onUpgrade}>Choose a plan</Button>, prices);
    }
    case "active": {
      const renews = shortDate(sub.currentPeriodEnd);
      return card(plan ? `${plan.name} plan` : "Your plan",
        <p>{plan ? `${plan.price} ${plan.unit} · ` : ""}{seats}{renews ? ` · Renews on ${renews}` : ""}</p>,
        <Pill tone="ok">Active</Pill>, manage,
        onManageBilling ? "Update your card or see past invoices from Manage billing. It opens our payment provider, Stripe." : undefined);
    }
    case "past_due":
      return card(plan ? `${plan.name} plan` : "Your plan",
        <p>Your last payment didn't go through. Update your payment method to keep your subscription running.</p>,
        <Pill tone="signal">Payment failed</Pill>,
        onManageBilling && <Button size="sm" variant="primary" icon="arrowUpRight" onClick={onManageBilling}>Update payment method</Button>);
    case "canceled":
      return card("No active plan",
        <p>Choose a plan to pick up where you left off. Your tasks and projects are safe.</p>,
        <Pill tone="neutral">Cancelled</Pill>,
        onUpgrade && <Button size="sm" variant="primary" onClick={onUpgrade}>Choose a plan</Button>, prices);
  }
}

const BILLING_CSS = `
.kbill-lede { margin: 0 0 20px; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }

/* plan cards */
.kbill-plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; text-align: left; }
.kbill-plan {
  display: flex; flex-direction: column; gap: 12px; padding: 20px; border-radius: var(--r-lg, 12px);
  background: var(--surface); box-shadow: var(--e1, var(--shadow));
}
.kbill-plan[data-featured] { box-shadow: 0 0 0 1.5px var(--accent-line, var(--accent)), var(--e1, var(--shadow)); }
.kbill-plan-head { display: flex; align-items: center; gap: 8px; }
.kbill-plan-name { margin: 0; font: 600 15px/24px var(--font-ui, var(--font-display)); color: var(--ink); }
.kbill-plan-blurb { margin: -8px 0 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kbill-price { display: flex; align-items: baseline; gap: 6px; margin: 4px 0 0; }
.kbill-price-n { font: 600 28px/36px var(--font-head, var(--font-display)); letter-spacing: -0.02em; color: var(--ink); font-variant-numeric: tabular-nums; }
.kbill-price-u { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kbill-feats { display: grid; gap: 8px; margin: 0 0 8px; padding: 0; list-style: none; }
.kbill-feats li { display: flex; align-items: flex-start; gap: 8px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kbill-feats svg { flex-shrink: 0; margin-top: 2px; color: var(--ok, var(--st-done)); }
.kbill-plan .kbtn { margin-top: auto; }

/* trial banner (one line) */
.kbill-trial {
  display: flex; align-items: center; gap: 12px; flex-shrink: 0; min-height: 40px; padding: 6px 16px 6px 24px;
  background: var(--accent-dim); color: var(--ink-2); box-shadow: inset 0 -1px 0 var(--hairline);
  font: 500 13px/20px var(--font-ui, var(--font-display));
}
.kbill-trial > svg { color: var(--accent-text, var(--accent)); }
.kbill-trial[data-urgent] { background: color-mix(in oklch, var(--warn, var(--st-review)) 14%, transparent); }
.kbill-trial[data-urgent] > svg { color: var(--warn, var(--st-review)); }
.kbill-trial-text { flex: 1; min-width: 0; }
.kbill-trial strong { font-weight: 600; color: var(--ink); }
.kbill-trial .kbtn { margin-left: auto; }

/* paywall */
.kbill-wall {
  position: relative; min-height: 100%; overflow-y: auto; display: grid; place-items: center; padding: 48px 24px;
  background: var(--halo, none), var(--bg);
}
.kbill-wall-inner { display: flex; flex-direction: column; align-items: center; width: 680px; max-width: 100%; text-align: center; }
.kbill-wall-title { margin: 20px 0 8px; font: 500 28px/36px var(--font-head, var(--font-display)); letter-spacing: -0.02em; color: var(--ink); text-wrap: balance; }
.kbill-wall-body { max-width: 460px; margin: 0 0 32px; font: 400 15px/24px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.kbill-wall .kbill-plans { width: 100%; }
.kbill-wall-signout { margin-top: 24px; }

/* Settings › Billing */
.kbill-card {
  display: flex; align-items: center; flex-wrap: wrap; gap: 12px 16px; padding: 16px;
  border-radius: var(--r-lg, 12px); box-shadow: 0 0 0 1px var(--hairline-strong);
}
.kbill-card-main { flex: 1 1 260px; min-width: 0; display: grid; gap: 4px; }
.kbill-card-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.kbill-card-title { margin: 0; font: 600 14px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.kbill-card-body p { margin: 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.kbill-card-act { flex-shrink: 0; margin-left: auto; }
.kbill-note { margin: 12px 2px 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }

@media (max-width: 859px) {
  .kbill-trial { padding-left: 16px; }
  .kbill-wall { padding: 32px 16px; }
  .kbill-wall-title { font-size: 22px; line-height: 30px; }
}
`;
