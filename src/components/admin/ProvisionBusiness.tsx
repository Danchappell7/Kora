/* ============================================================
   KANBO — /admin › Provision a business (0058). Platform admins only
   (the console's gate, and admin_provision_business checks is_admin()
   again on the server). One form: the business's name, a pack, the
   owner's email and the company domain. It
     1. creates the workspace (you own it while it's set up),
     2. sets the pack up in it (lib/provisionPack, as you),
     3. invites the owner (as an admin until they join) and emails it
        through the invite-member function,
     4. pre-approves the domain (never a public mail domain), letting
        in anyone from it who's already waiting,
     5. hands it over: when the owner joins, they're the owner, what
        was set up becomes theirs, and you stay on as an admin.
   Each step says how it went. Before 0058: "isn't switched on yet".
   ============================================================ */
import { useId, useState } from "react";
import { Button, Icon } from "../primitives";
import { BUSINESS_PACKS } from "../../packs";
import { KANBO_TODAY } from "../../data/data";
import { store } from "../../data/store";
import { reportError } from "../../lib/monitoring";
import { provisionBusiness, ProvisionError, publicMailDomain, type Provisioned } from "../../lib/rolloutApi";
import type { ProvisionedPack } from "../../lib/provisionPack";
import "./provision.css";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const normDomain = (raw: string) => raw.trim().toLowerCase().replace(/^.*@/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
/** the owner's own domain, when it's a company's (not a public mail provider's): offered, never filled in */
export const companyDomainOf = (email: string): string => {
  const d = normDomain(email.includes("@") ? email.split("@")[1] ?? "" : "");
  return DOMAIN_RE.test(d) && !publicMailDomain(d) ? d : "";
};

type Step = { label: string; state: "done" | "doing" | "skipped" | "failed" | "waiting"; detail?: string };
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

export function ProvisionBusiness({ me, onProvisioned }: { me: { id: string; email: string; name: string }; onProvisioned?: () => void }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [name, setName] = useState("");
  const [packId, setPackId] = useState("");
  const [email, setEmail] = useState("");
  // (the domain is the admin's to choose: the owner's own is offered, never filled in, as approving it lets everyone at it in)
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [steps, setSteps] = useState<Step[] | null>(null);

  const e = email.trim().toLowerCase();
  const d = normDomain(domain);
  const offer = !d ? companyDomainOf(e) : "";
  const emailBad = !!e && !EMAIL_RE.test(e);
  const domainBad = !!d && (!DOMAIN_RE.test(d) || publicMailDomain(d));
  const ready = !!name.trim() && EMAIL_RE.test(e) && !domainBad && !busy;
  const pack = BUSINESS_PACKS.find((p) => p.id === packId);

  const run = async () => {
    if (!ready) return;
    setBusy(true); setError("");
    const list: Step[] = [
      { label: `Make ${name.trim()}`, state: "doing" },
      { label: pack ? `Set up the ${pack.name} pack` : "No pack", state: pack ? "waiting" : "skipped" },
      { label: `Invite ${e}, the owner-to-be`, state: "waiting" },
      { label: d ? `Approve @${d} sign-ups` : "No company domain", state: d ? "waiting" : "skipped" },
      { label: `Hand it over to ${e}`, state: "waiting" },
    ];
    const show = () => setSteps(list.map((s) => ({ ...s })));
    show();
    let made: Provisioned;
    try {
      made = await provisionBusiness({ name: name.trim(), ownerEmail: e, domain: d || null, pack: pack?.id ?? null }, me);
    } catch (err) {
      setSteps(null);
      setBusy(false);
      if (!(err instanceof ProvisionError)) reportError(err, { op: "provisionBusiness" });
      setError(err instanceof ProvisionError ? err.message : "Couldn't provision it just now. Try again in a moment.");
      return;
    }
    list[0] = { ...list[0], state: "done", detail: "You own it while it's set up." };
    if (d) list[3] = { ...list[3], state: "done", detail: made.approved ? `Approved, and let in ${made.approved} waiting ${made.approved === 1 ? "person" : "people"}.` : made.domainAdded ? "Approved." : "Already approved." };
    if (pack) list[1] = { ...list[1], state: "doing" };
    show();
    // the pack, as you (you own it for now; the owner gets it all when they join)
    if (pack) {
      let r: ProvisionedPack | null = null;
      try { r = await (await import("../../lib/provisionPack")).provisionPack(pack.id, made.workspaceId, me.id, new Date(KANBO_TODAY)); }
      catch (err) { reportError(err, { op: "provisionPack" }); }
      list[1] = r
        ? { ...list[1], state: r.failed.length ? "failed" : "done", detail: `${[plural(r.projects, "project"), plural(r.tasks, "task"), r.goals ? plural(r.goals, "goal") : "", r.keyResults ? plural(r.keyResults, "key result") : ""].filter(Boolean).join(", ")}${r.failed.length ? `. Couldn't make: ${r.failed.slice(0, 3).join(", ")}` : ""}${r.notYet.length ? ". Some parts aren't switched on yet." : ""}` }
        : { ...list[1], state: "failed", detail: "Couldn't set the pack up. Add it from New project › From a pack once you're in the workspace." };
    }
    list[2] = { ...list[2], state: "doing" };
    show();
    const sent = await store.sendInviteEmail(made.memberId);
    list[2] = { ...list[2], state: sent.sent || sent.reason === "throttled" || !store.configured ? "done" : "failed",
      detail: !store.configured ? "Invited as an admin (the demo sends no email). They become the owner when they join."
        : sent.sent ? "Invite emailed. It invites them as an admin: they become the owner the moment they join."
        : `The invite's saved, but the email didn't go${sent.message ? `: ${sent.message}` : ""}. Resend it from the workspace's People.` };
    list[4] = { ...list[4], state: "waiting", detail: "When they join, they're the owner and what was set up is theirs. You stay on as an admin until you leave." };
    show();
    // (the database writes the audit trail's entry itself)
    setBusy(false);
    onProvisioned?.();
  };
  const reset = () => { setName(""); setPackId(""); setEmail(""); setDomain(""); setSteps(null); setError(""); };

  return (
    <section className="kprv" aria-labelledby={`kprv-${uid}`}>
      <div className="kprv-head">
        <Icon name="briefcase" size={16} />
        <h2 id={`kprv-${uid}`} className="kprv-title">Provision a business</h2>
      </div>
      <p className="kprv-lede">Set a business up for its owner in one go: the workspace, its pack, their invite and the company domain. When they join, it's theirs.</p>
      {!steps ? (
        <form className="kprv-form" onSubmit={(ev) => { ev.preventDefault(); void run(); }} noValidate>
          <label className="kprv-field">
            <span className="kprv-label">Business name</span>
            <input className="kprv-input" value={name} onChange={(ev) => setName(ev.target.value)} placeholder="e.g. Harbour Fitness" maxLength={80} />
          </label>
          <label className="kprv-field">
            <span className="kprv-label">Business pack</span>
            <select className="kprv-input" value={packId} onChange={(ev) => setPackId(ev.target.value)}>
              <option value="">No pack: start empty</option>
              {BUSINESS_PACKS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="kprv-field">
            <span className="kprv-label">Owner's email</span>
            <input className="kprv-input" type="email" value={email} onChange={(ev) => setEmail(ev.target.value)} placeholder="owner@business.co.uk" aria-invalid={emailBad || undefined} autoComplete="off" />
          </label>
          <label className="kprv-field">
            <span className="kprv-label">Company domain <span className="kprv-optional">optional</span></span>
            <input className="kprv-input" value={domain} placeholder="business.co.uk" aria-invalid={domainBad || undefined}
              onChange={(ev) => setDomain(ev.target.value)} />
          </label>
          <p className="kprv-hint" role="status">
            {emailBad ? "That doesn't look like an email address."
              : domainBad ? (publicMailDomain(d) ? `@${d} is a public email provider: approving it would let anyone in.` : "That doesn't look like a domain, like harbourfit.co.uk.")
              : d ? `Anyone signing up with an @${d} address gets in without waiting. They still need an invite to join the workspace.`
              : offer ? <>Without a domain, everyone else needs an invite or your approval. Only add @{offer} if everyone with an address there works for the business. <button type="button" className="kprv-offer" onClick={() => setDomain(offer)}>Use @{offer}</button></>
              : "Without a domain, everyone else needs an invite or your approval."}
          </p>
          {error && <p className="kprv-error" role="alert">{error}</p>}
          <div className="kprv-acts">
            <Button type="submit" variant="primary" icon="send" disabled={!ready} loading={busy}>Provision</Button>
          </div>
        </form>
      ) : (
        <div className="kprv-done">
          <ol className="kprv-steps" aria-live="polite">
            {steps.map((s, i) => (
              <li key={i} className="kprv-step" data-state={s.state}>
                <span className="kprv-step-mark" aria-hidden="true">{s.state === "done" ? <Icon name="check" size={14} sw={2.25} /> : s.state === "failed" ? <Icon name="alert" size={14} /> : s.state === "doing" ? <span className="kspin" /> : s.state === "waiting" ? <Icon name="clock" size={14} /> : <Icon name="dot" size={14} />}</span>
                <span className="kprv-step-text">
                  <span className="kprv-step-label">{s.label}</span>
                  {s.detail && <span className="kprv-step-detail">{s.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
          {!busy && <div className="kprv-acts"><Button variant="secondary" icon="plus" onClick={reset}>Provision another</Button></div>}
        </div>
      )}
    </section>
  );
}
