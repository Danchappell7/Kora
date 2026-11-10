/* ============================================================
   KANBO — Settings › Workspace › Project access (0058), for the
   workspace's owner only. The switch (off by default: everyone sees
   every project, as before), what new projects start as, and whether
   members may make projects private. While it's off it says what
   turning it on would do: each guest and the projects they'd still
   see (and their open tasks they wouldn't), and who'd lose sight of
   any project that's already Members only or Private. Turning it on
   or off asks first; off again is the rollback,
   instant, with everyone's projects and settings kept for next time.
   Before 0058 it isn't shown at all.
   ============================================================ */
import { useState } from "react";
import type { ProjectAccessSettings, ProjectVisibility, Task, Workspace } from "../../data/types";
import { Button } from "../primitives";
import { SetGroup, SetNote, SetRow } from "../integrations/settingsBits";
import { accessSchema, roleOf, turnOnPreview, VISIBILITY_LABEL, VISIBILITIES, type AccessCtx } from "../../lib/projectAccess";
import "./projectAccess.css";

const OFF: ProjectAccessSettings = { on: false, defaultVisibility: "workspace", membersMayMakePrivate: false };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the preview says about one guest: "Ana Ruiz · Brand Refresh", or "Leah Price · none yet (add her to a project first)". */
function guestLine(g: { name: string; projects: string[] }): string {
  return g.projects.length ? `${g.name} · ${g.projects.join(", ")}` : `${g.name} · none yet (add them to a project first)`;
}
/** "a, b and c" */
const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
/** "Ana Ruiz has 3 open tasks in Website rebuild. Add them to it first, or they won't see those tasks." */
function lostLine(g: { name: string; lost: { project: string; openTasks: number }[] }): string {
  const n = g.lost.reduce((a, x) => a + x.openTasks, 0);
  const where = listOf(g.lost.map((x) => (x.project === "no project" ? "tasks with no project" : x.project)));
  return `${g.name} has ${plural(n, "open task")} in ${where}. Add them to ${g.lost.length === 1 ? "it" : "those"} first, or they won't see ${n === 1 ? "it" : "them"}.`;
}
/** "Payroll & contracts is Private: Theo Vance (2 open tasks) and Sana Rao won't see it." */
function closedLine(c: { name: string; visibility: ProjectVisibility; losing: { name: string; openTasks: number }[] }): string {
  const who = listOf(c.losing.map((x) => (x.openTasks ? `${x.name} (${plural(x.openTasks, "open task")})` : x.name)));
  return `${c.name} is ${VISIBILITY_LABEL[c.visibility]}: ${who} won't see it.`;
}

export function ProjectAccessPanel({ workspace, ctx, nameOf, tasks = [], onChange }: {
  workspace: Workspace | undefined;
  ctx: AccessCtx;
  nameOf?: (userId: string) => string | undefined;
  /** the tasks loaded here: whose open work turning it on would hide */
  tasks?: Pick<Task, "workspaceId" | "projectId" | "assigneeId" | "status" | "archivedAt" | "collaborators">[];
  /** save the switch or a setting; resolves false when it was refused (the caller has said why) */
  onChange: (workspaceId: string, patch: Partial<Pick<ProjectAccessSettings, "on" | "defaultVisibility" | "membersMayMakePrivate">>) => Promise<boolean>;
}): JSX.Element | null {
  const [asking, setAsking] = useState<null | "on" | "off">(null);
  const [busy, setBusy] = useState(false);
  if (!workspace?.id || !accessSchema()) return null;
  if (roleOf(ctx, workspace.id, ctx.me) !== "owner") return null;
  const wsId = workspace.id;
  const s = workspace.projectAccess ?? OFF;
  const preview = turnOnPreview(wsId, ctx, nameOf, tasks);
  const save = async (patch: Parameters<typeof onChange>[1]) => {
    setBusy(true);
    try { await onChange(wsId, patch); } finally { setBusy(false); setAsking(null); }
  };
  const c = preview.counts;
  // already set (by an earlier turn, or the default for new projects while it's off): who'd lose what
  const closing = preview.closed.filter((x) => x.losing.length > 0);
  const losers = new Set(closing.flatMap((x) => x.losing.map((l) => l.userId)));
  const strandedGuests = preview.guests.filter((g) => g.lost.length > 0);
  const askOn = [
    `Turn on project access for ${workspace.name}? Guests will only see the projects they're on.`,
    losers.size ? `${plural(losers.size, "member")} won't see the Members only or Private projects they're not on.` : "",
    strandedGuests.length ? `${plural(strandedGuests.length, "guest")} won't see some of their own open tasks.` : "",
    "You can turn it off again at any time.",
  ].filter(Boolean).join(" ");

  return (
    <div className="kpas">
      <SetGroup title="Project access">
        <SetRow label="Turn on project access" desc="Choose who sees each project. With this on, guests see only the projects you add them to.">
          <label className="kpas-switch">
            <input type="checkbox" role="switch" aria-checked={s.on} checked={s.on} disabled={busy} aria-label="Turn on project access"
              onChange={() => setAsking(s.on ? "off" : "on")} />
            <span>{s.on ? "On" : "Off"}</span>
          </label>
        </SetRow>
        {asking && (
          <div className="kpas-ask" role="alertdialog" aria-label={asking === "on" ? "Turn on project access?" : "Turn off project access?"}>
            <p className="kpas-ask-text">{asking === "on"
              ? askOn
              : `Turn off project access? Everyone at ${workspace.name}, guests included, will see every project again. Project people and settings are kept for next time.`}</p>
            <span className="kpas-ask-actions">
              <Button size="sm" variant="primary" loading={busy} onClick={() => void save({ on: asking === "on" })}>{asking === "on" ? "Turn it on" : "Turn it off"}</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(null)}>Cancel</Button>
            </span>
          </div>
        )}
        {s.on ? (
          <SetRow label="Projects here" desc={`${c.private} private · ${c.members} members only · ${c.workspace} whole workspace`} />
        ) : (
          <div className="kpas-preview" aria-label="What turning it on does">
            <p className="kpas-preview-head">When you turn it on:</p>
            <ul className="kpas-preview-list">
              <li>{preview.guests.length
                ? <>Guests will only see the projects they've been added to:{" "}
                    {preview.guests.map((g, i) => <span key={g.userId} className="kpas-guest">{i > 0 && "; "}{guestLine(g)}</span>)}.</>
                : "No guests here yet. Any you invite will see only the projects you add them to."}</li>
              {strandedGuests.map((g) => <li key={`lost-${g.userId}`} className="kpas-warn">{lostLine(g)}</li>)}
              {c.members + c.private === 0
                ? <li>Members and admins: nothing changes until a project is Members only or Private.</li>
                : <li>Already set: {c.private} private · {c.members} members only.{closing.length === 0 && " Everyone on them keeps them."}</li>}
              {closing.map((x) => <li key={`closed-${x.projectId}`} className="kpas-warn">{closedLine(x)}</li>)}
              <li>You can turn it off any time. Nothing is lost.</li>
            </ul>
          </div>
        )}
        <SetRow label="New projects start as" desc="Anyone making a project can change it in its About tab.">
          <select className="kset-input" aria-label="New projects start as" value={s.defaultVisibility} disabled={busy}
            onChange={(e) => void save({ defaultVisibility: e.target.value as ProjectVisibility })}>
            {VISIBILITIES.map((v) => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}
          </select>
        </SetRow>
        <SetRow label="Members can make projects private" desc="Owners and admins always can.">
          <input type="checkbox" className="kpas-check" checked={s.membersMayMakePrivate} disabled={busy} aria-label="Members can make projects private"
            onChange={(e) => void save({ membersMayMakePrivate: e.target.checked })} />
        </SetRow>
      </SetGroup>
      <SetNote>{s.on
        ? `Owners always see every project. ${plural(preview.guests.length, "guest")} here ${preview.guests.length === 1 ? "sees" : "see"} only the projects they're on.`
        : "Until it's on, everyone here sees every project, guests included."}</SetNote>
    </div>
  );
}
