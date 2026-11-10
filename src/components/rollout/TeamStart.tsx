/* ============================================================
   KANBO — the first run's team path (0057), the steps the first-run
   sheet (OnboardingModal) shows after the name:
   • TeamFork: "Just me", "My team" or "A whole business". Just me goes
     on exactly as before (your first project, in Personal).
   • TeamNameStep: what the team (or business) is called; making it
     creates the workspace.
   • TeamStartStep: one sheet with the three things that get a team
     going: a business pack, bringing your work in, and a pilot group.
     The pack and the import open their own sheets (the first-run
     sheet steps aside meanwhile); the pilot group is invited here.
   They use the first-run sheet's own look (konb-* in OnboardingModal's
   FIRST_RUN_CSS) and add a little of their own (kfork-*).
   ============================================================ */
import { useState } from "react";
import { Button, Icon } from "../primitives";
import type { IconName } from "../../data/types";
import { pilotEmails, type TeamKind } from "../../lib/rollout";

/** What the first-run sheet needs from the app to set a team up. */
export interface TeamStartHost {
  /** make the team's workspace (it becomes the active one): its id, or null when it couldn't be made */
  create: (name: string, kind: Exclude<TeamKind, "solo">) => Promise<string | null>;
  /** open the business packs for it (the first-run sheet steps aside until it closes) */
  pickPack: (workspaceId: string) => void;
  /** open "Bring your work in" (the import) for it */
  importWork: (workspaceId: string) => void;
  /** invite the pilot group as members: how many went, and the addresses that didn't */
  invite: (workspaceId: string, emails: string[]) => Promise<{ invited: number; failed: string[] }>;
  /** what's been done so far: the pack set up, how many tasks came in, how many people were invited */
  progress?: { pack?: string | null; imported?: number; invited?: number };
}

const KINDS: { kind: TeamKind; icon: IconName; title: string; line: string }[] = [
  { kind: "solo", icon: "user", title: "Just me", line: "My own work, planned around my day." },
  { kind: "team", icon: "users", title: "My team", line: "A team that shares projects and a weekly rhythm." },
  { kind: "business", icon: "briefcase", title: "A whole business", line: "Every team, its goals and its routines, ready in one step." },
];

export function TeamFork({ onPick }: { onPick: (kind: TeamKind) => void }) {
  return (
    <div className="konb-step">
      <div className="konb-head">
        <h2 className="konb-title">Who's Kanbo for?</h2>
        <p className="konb-lede">We'll set it up to suit. You can always add a team later.</p>
      </div>
      <style>{FORK_CSS}</style>
      <div className="kfork-choices" role="group" aria-label="Who's Kanbo for?">
        {KINDS.map((k, i) => (
          // eslint-disable-next-line jsx-a11y/no-autofocus
          <button key={k.kind} type="button" className="kfork-choice" onClick={() => onPick(k.kind)} autoFocus={i === 0} data-autofocus={i === 0 ? "" : undefined}>
            <span className="kfork-choice-icon" aria-hidden="true"><Icon name={k.icon} size={18} sw={1.75} /></span>
            <span className="kfork-choice-text">
              <span className="kfork-choice-title">{k.title}</span>
              <span className="kfork-choice-line">{k.line}</span>
            </span>
            <Icon name="chevronRight" size={16} sw={1.75} />
          </button>
        ))}
      </div>
    </div>
  );
}

export function TeamNameStep({ kind, onBack, onCreate }: { kind: Exclude<TeamKind, "solo">; onBack: () => void; onCreate: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const business = kind === "business";
  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true); setErr("");
    const ok = await onCreate(n).catch(() => false);
    if (!ok) { setBusy(false); setErr("Couldn't set it up just now. Check your connection and try again."); }
  };
  return (
    <form className="konb-step" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="konb-head">
        <h2 className="konb-title">{business ? "What's the business called?" : "What's your team called?"}</h2>
        <p className="konb-lede">{business ? "This is the workspace everyone joins. Next, you can set the whole business up in one step." : "This is the workspace your team joins. Next, you can bring your work in and invite a few people."}</p>
      </div>
      <div className="konb-field">
        <label htmlFor="kanbo-onb2-team">{business ? "Business name" : "Team name"}</label>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input id="kanbo-onb2-team" className="konb-input" autoFocus data-autofocus value={name} onChange={(e) => { setName(e.target.value); setErr(""); }}
          placeholder={business ? "e.g. Harbour Fitness" : "e.g. Studio Ops"} autoComplete="organization" maxLength={80} aria-invalid={!!err || undefined} />
      </div>
      {err && <p className="konb-err" role="alert">{err}</p>}
      <div className="konb-acts">
        <Button variant="ghost" size="lg" onClick={onBack}>Back</Button>
        <Button type="submit" variant="primary" size="lg" iconRight="arrowRight" disabled={!name.trim()} loading={busy} className="konb-grow">
          {busy ? "Setting it up…" : "Create workspace"}
        </Button>
      </div>
    </form>
  );
}

export function TeamStartStep({ kind, name, workspaceId, host, onContinue }: {
  kind: Exclude<TeamKind, "solo">; name: string; workspaceId: string; host: TeamStartHost; onContinue: () => void;
}) {
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const pack = host.progress?.pack ?? null;
  const imported = host.progress?.imported ?? 0;
  // (kept by the host: the step is shown again after the pack's or the import's sheet)
  const invited = host.progress?.invited ?? 0;
  const { valid, invalid } = pilotEmails(emails);
  const business = kind === "business";
  const invite = async () => {
    if (!valid.length || busy) { if (!valid.length && emails.trim()) setErr("Enter full email addresses, like sam@company.com."); return; }
    setBusy(true); setErr("");
    try {
      const r = await host.invite(workspaceId, valid);
      // what didn't go stays in the box, with what to do about it: an address it couldn't read, and one the invite refused
      const left = [...invalid, ...r.failed];
      setEmails(left.join(", "));
      if (invalid.length || r.failed.length) setErr([
        invalid.length ? `Couldn't read ${invalid.map((x) => `“${x}”`).join(", ")}: add the full address.` : "",
        r.failed.length ? `Couldn't invite ${r.failed.join(", ")}. Check the addresses and try again.` : "",
      ].filter(Boolean).join(" "));
    } catch { setErr("Couldn't send the invites just now. Try again in a moment."); }
    finally { setBusy(false); }
  };
  return (
    <div className="konb-step">
      <div className="konb-head">
        <h2 className="konb-title">Set up {name}</h2>
        <p className="konb-lede">Three things that get a team going. Do any of them now, or later from Get set up on Today.</p>
      </div>
      <ul className="kfork-list">
        <li className="kfork-row" data-done={pack ? "" : undefined} data-lead={business || undefined}>
          <span className="kfork-row-icon" aria-hidden="true"><Icon name={pack ? "check" : "layers"} size={16} sw={pack ? 2.25 : 1.75} /></span>
          <span className="kfork-row-text">
            <span className="kfork-row-title">{pack ? `${pack} is set up` : "Start from a business pack"}</span>
            <span className="kfork-row-line">{pack ? "Projects, goals and routines are in. Open Projects to see them." : "Projects, goals and routines for a fitness studio, a padel venue, an agency and more, ready in one step."}</span>
          </span>
          {!pack && <Button size="sm" variant={business ? "primary" : "secondary"} onClick={() => host.pickPack(workspaceId)}>Pick a pack</Button>}
        </li>
        <li className="kfork-row" data-done={imported ? "" : undefined}>
          <span className="kfork-row-icon" aria-hidden="true"><Icon name={imported ? "check" : "list"} size={16} sw={imported ? 2.25 : 1.75} /></span>
          <span className="kfork-row-text">
            <span className="kfork-row-title">{imported ? `${imported} ${imported === 1 ? "task" : "tasks"} brought in` : "Bring your work in"}</span>
            <span className="kfork-row-line">{imported ? "Bring in more any time from My tasks." : "Paste a list or a spreadsheet, or upload a CSV from the tool you use now."}</span>
          </span>
          <Button size="sm" variant="secondary" onClick={() => host.importWork(workspaceId)}>{imported ? "Import more" : "Import"}</Button>
        </li>
        <li className="kfork-row" data-done={invited ? "" : undefined}>
          <span className="kfork-row-icon" aria-hidden="true"><Icon name={invited ? "check" : "users"} size={16} sw={invited ? 2.25 : 1.75} /></span>
          <span className="kfork-row-text">
            <span className="kfork-row-title">{invited ? `Invited ${invited} ${invited === 1 ? "person" : "people"} to your pilot group` : "Invite your pilot group"}</span>
            <span className="kfork-row-line">{invited ? "Add anyone else who should try it first." : "Three to five people who'll try it first and tell you what works. They join as members."}</span>
            <form className="kfork-invite" onSubmit={(e) => { e.preventDefault(); void invite(); }}>
              <label className="sr-only" htmlFor="kanbo-onb2-pilot">Pilot group emails</label>
              <textarea id="kanbo-onb2-pilot" className="konb-input kfork-emails" rows={2} value={emails} spellCheck={false}
                placeholder="sam@company.com, alex@company.com" aria-invalid={!!err || undefined} aria-describedby="kanbo-onb2-pilot-help"
                onChange={(e) => { setEmails(e.target.value); setErr(""); }}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void invite(); } }} />
              <span id="kanbo-onb2-pilot-help" className="kfork-help">
                {err || (invalid.length ? `“${invalid[0]}” doesn't look like an email address.` : valid.length ? `${valid.length} ${valid.length === 1 ? "person" : "people"}` : "Separate addresses with commas or new lines.")}
              </span>
              <Button type="submit" size="sm" variant="secondary" icon="send" loading={busy} disabled={!valid.length}>
                {valid.length > 1 ? `Invite ${valid.length}` : "Invite"}
              </Button>
            </form>
          </span>
        </li>
      </ul>
      <div className="konb-acts" data-stack="">
        <Button variant="hero" size="lg" full iconRight="arrowRight" onClick={onContinue}>Continue</Button>
      </div>
      <style>{FORK_CSS}</style>
    </div>
  );
}

export const FORK_CSS = `
.kfork-choices { display: grid; gap: 8px; }
.kfork-choice {
  display: flex; align-items: center; gap: 14px; width: 100%; min-height: 64px; padding: 10px 14px; text-align: left; cursor: pointer;
  border: 1px solid var(--field-border, var(--hairline-strong)); border-radius: var(--r-lg, 12px); background: var(--field-bg, var(--surface)); color: var(--ink);
  transition: border-color var(--d-1, 90ms) var(--ease), background var(--d-1, 90ms) var(--ease);
}
.kfork-choice:hover { border-color: var(--accent-fill, var(--accent)); background: linear-gradient(var(--fill-1), var(--fill-1)), var(--field-bg, var(--surface)); }
.kfork-choice > svg { margin-left: auto; color: var(--ink-4); flex-shrink: 0; }
.kfork-choice-icon, .kfork-row-icon {
  display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; border-radius: 10px;
  background: var(--fill-1); color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--hairline);
}
.kfork-choice-text, .kfork-row-text { display: grid; gap: 1px; flex: 1; min-width: 0; }
.kfork-choice-title, .kfork-row-title { font: 600 15px/22px var(--font-ui, var(--font-display)); color: var(--ink); }
.kfork-choice-line, .kfork-row-line { font: 400 13px/18px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.kfork-list { display: grid; margin: 0; padding: 0; list-style: none; text-align: left; }
.kfork-row { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; box-shadow: inset 0 1px 0 var(--hairline); }
.kfork-row:first-child { box-shadow: none; padding-top: 0; }
.kfork-row > .kbtn { flex-shrink: 0; margin-top: 4px; }
.kfork-row[data-lead] .kfork-row-icon { color: var(--accent-text, var(--accent)); }
.kfork-row[data-done] .kfork-row-icon { color: var(--ok, var(--st-done)); background: color-mix(in oklch, var(--ok, var(--st-done)) 10%, transparent); box-shadow: none; }
.kfork-row-title { font-size: 14px; line-height: 20px; }
.kfork-invite { display: grid; grid-template-columns: 1fr auto; gap: 6px 8px; align-items: start; margin-top: 8px; }
.kfork-emails { grid-column: 1 / -1; height: auto; min-height: 56px; padding: 8px 12px; resize: vertical; font-size: 13px; line-height: 20px; }
.kfork-help { align-self: center; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kfork-emails[aria-invalid="true"] + .kfork-help { color: var(--signal, var(--prio-urgent)); }
@media (max-width: 859px) {
  /* the row's button goes under its words, so the words keep the width */
  .kfork-row { flex-wrap: wrap; row-gap: 8px; }
  .kfork-row-text { flex: 1 1 calc(100% - 48px); }
  .kfork-row > .kbtn { margin: 0 0 0 48px; }
  .kfork-emails { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) { .kfork-choice { transition: none; } }
`;
